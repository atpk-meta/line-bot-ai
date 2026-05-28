import { createHmac, timingSafeEqual } from "crypto";
import { Client, messagingApi, type WebhookEvent } from "@line/bot-sdk";
import { NextResponse } from "next/server";
import { LINE_REPLY_RETRY_COUNT, LINE_REPLY_RETRY_DELAY_MS } from "@/lib/constants";
import { handleIncomingMessage } from "@/lib/chatbot-core";
import { maskLineUserId, notifyAdmin } from "@/lib/handoff";
import { log } from "@/lib/log";
import { sanitizeBotReply } from "@/lib/sanitize";

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
      FB_PAGE_ID: Boolean(process.env.FB_PAGE_ID),
      GOOGLE_SHEET_ID: Boolean(process.env.GOOGLE_SHEET_ID),
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
    text: sanitizeBotReply(text),
  } satisfies messagingApi.TextMessage);
}

function getAdminLineUserIds(): string[] {
  return (process.env.ADMIN_LINE_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function isAdminMessage(event: WebhookEvent): boolean {
  const userId = event.source?.userId;
  return Boolean(userId && getAdminLineUserIds().includes(userId));
}

async function handleTextEvent(
  client: Client,
  event: WebhookEvent,
): Promise<void> {
  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  const userId = event.source.userId;
  const messageText = event.message.text;
  const result = await handleIncomingMessage({
    platform: "line",
    userId: userId || "unknown",
    messageText,
    rawEvent: event,
    isAdminMessage: isAdminMessage(event),
  });

  if (result.handoffRequested) {
    try {
      await notifyAdmin(client, userId, messageText);
    } catch (error) {
      log.error("handoff.notify_failed", {
        err: error instanceof Error ? error.message : "unknown",
        userHash: maskLineUserId(userId),
      });
    }
  }

  if (result.shouldReply && result.replyText) {
    await safeReplyText(client, event.replyToken, result.replyText);
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
