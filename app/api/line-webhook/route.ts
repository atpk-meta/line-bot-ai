import { createHmac, timingSafeEqual } from "crypto";
import { Client, messagingApi, type WebhookEvent } from "@line/bot-sdk";
import { NextResponse } from "next/server";
import {
  DEFAULT_REPLY,
  LINE_REPLY_RETRY_COUNT,
  LINE_REPLY_RETRY_DELAY_MS,
  SHEET_ERROR_REPLY,
} from "@/lib/constants";
import { generateReply } from "@/lib/gemini";
import { findDirectFAQAnswer } from "@/lib/faq";
import {
  HANDOFF_REPLY,
  maskLineUserId,
  notifyAdmin,
  shouldHandoff,
} from "@/lib/handoff";
import { getKnowledgeText } from "@/lib/knowledge";
import { log } from "@/lib/log";
import { getFAQText } from "@/lib/sheet";

export const runtime = "nodejs";
export const maxDuration = 10;

type ReplyMessage = Parameters<Client["replyMessage"]>[1];

export function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "/api/line-webhook",
    env: {
      LINE_CHANNEL_ACCESS_TOKEN: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN),
      LINE_CHANNEL_SECRET: Boolean(process.env.LINE_CHANNEL_SECRET),
      GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY),
      SHEET_CSV_URL: Boolean(process.env.SHEET_CSV_URL),
      KNOWLEDGE_DOC_URL: Boolean(process.env.KNOWLEDGE_DOC_URL),
      KNOWLEDGE_TEXT: Boolean(process.env.KNOWLEDGE_TEXT),
      ADMIN_GROUP_ID: Boolean(process.env.ADMIN_GROUP_ID),
    },
  });
}

function getLineClient(): Client {
  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!channelAccessToken) {
    throw new Error("Missing LINE_CHANNEL_ACCESS_TOKEN");
  }

  return new Client({ channelAccessToken });
}

function verifyLineSignature(body: string, signature: string | null): boolean {
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  if (!channelSecret || !signature) {
    return false;
  }

  const digest = createHmac("sha256", channelSecret)
    .update(body)
    .digest("base64");

  const signatureBuffer = Buffer.from(signature);
  const digestBuffer = Buffer.from(digest);

  if (signatureBuffer.length !== digestBuffer.length) {
    return false;
  }

  return timingSafeEqual(signatureBuffer, digestBuffer);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function replyWithRetry(
  client: Client,
  replyToken: string,
  message: ReplyMessage,
  retries = LINE_REPLY_RETRY_COUNT,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await client.replyMessage(replyToken, message);
      return;
    } catch (error) {
      lastError = error;
      log.warn("line.reply_failed", { attempt });

      if (attempt < retries) {
        await delay(LINE_REPLY_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  log.error("line.reply_exhausted", {
    err: lastError instanceof Error ? lastError.message : "unknown",
  });
}

async function safeReplyText(
  client: Client,
  replyToken: string,
  text: string,
): Promise<void> {
  await replyWithRetry(client, replyToken, {
    type: "text",
    text,
  } satisfies messagingApi.TextMessage);
}

async function handleTextEvent(
  client: Client,
  event: WebhookEvent,
): Promise<void> {
  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  const startTime = Date.now();
  const userHash = maskLineUserId(event.source.userId);
  const userMessage = event.message.text;

  try {
    if (shouldHandoff(userMessage)) {
      await safeReplyText(client, event.replyToken, HANDOFF_REPLY);
      try {
        await notifyAdmin(client, event.source.userId, userMessage);
      } catch (error) {
        log.error("handoff.notify_failed", {
          err: error instanceof Error ? error.message : "unknown",
          userHash,
        });
      }
      log.info("handoff.routed", {
        userHash,
        latencyMs: Date.now() - startTime,
        inputLength: userMessage.length,
      });
      return;
    }

    let faqText: string;
    try {
      faqText = await getFAQText();
    } catch (error) {
      log.error("sheet.load_failed", {
        err: error instanceof Error ? error.message : "unknown",
        userHash,
      });
      await safeReplyText(client, event.replyToken, SHEET_ERROR_REPLY);
      return;
    }

    let reply = DEFAULT_REPLY;
    try {
      reply = findDirectFAQAnswer(userMessage, faqText) ?? DEFAULT_REPLY;
      if (reply === DEFAULT_REPLY) {
        const knowledgeText = await getKnowledgeText();
        reply = await generateReply(userMessage, faqText, knowledgeText);
      } else {
        log.info("faq.direct_match", {
          userHash,
          inputLength: userMessage.length,
          replyLength: reply.length,
        });
      }
    } catch (error) {
      log.error("gemini.failed", {
        err: error instanceof Error ? error.message : "unknown",
        userHash,
      });
    }

    await safeReplyText(client, event.replyToken, reply);
    log.info("reply.sent", {
      userHash,
      latencyMs: Date.now() - startTime,
      inputLength: userMessage.length,
      replyLength: reply.length,
    });
  } catch (error) {
    log.error("webhook.event_failed", {
      err: error instanceof Error ? error.message : "unknown",
      userHash,
    });
    await safeReplyText(client, event.replyToken, DEFAULT_REPLY);
  }
}

export async function POST(request: Request) {
  let body = "";
  try {
    body = await request.text();
  } catch (error) {
    log.error("webhook.body_read_failed", {
      err: error instanceof Error ? error.message : "unknown",
    });
    return new NextResponse("Bad Request", { status: 400 });
  }

  const signature = request.headers.get("x-line-signature");
  if (!verifyLineSignature(body, signature)) {
    log.warn("webhook.invalid_signature");
    return new NextResponse("Unauthorized", { status: 401 });
  }

  let events: WebhookEvent[] = [];
  try {
    const parsedBody = JSON.parse(body) as { events?: WebhookEvent[] };
    events = Array.isArray(parsedBody.events) ? parsedBody.events : [];
    log.info("webhook.received", { eventCount: events.length });
  } catch (error) {
    log.error("webhook.json_parse_failed", {
      err: error instanceof Error ? error.message : "unknown",
    });
    return new NextResponse("Bad Request", { status: 400 });
  }

  let client: Client;
  try {
    client = getLineClient();
  } catch (error) {
    log.error("line.client_failed", {
      err: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ ok: false });
  }

  await Promise.all(events.map((event) => handleTextEvent(client, event)));

  return NextResponse.json({ ok: true });
}
