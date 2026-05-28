import { createHmac, timingSafeEqual } from "crypto";
import { Client, messagingApi, type WebhookEvent } from "@line/bot-sdk";
import { NextResponse } from "next/server";
import {
  DEFAULT_REPLY,
  GEMINI_TIMEOUT_REPLY,
  LINE_REPLY_RETRY_COUNT,
  LINE_REPLY_RETRY_DELAY_MS,
  SAFE_SYSTEM_BUSY_REPLY,
  SHEET_ERROR_REPLY,
  WEBHOOK_TOTAL_TIMEOUT_MS,
} from "@/lib/constants";
import {
  appendHistory,
  formatConversationHistory,
  getMemory,
  getSystemState,
  markFallbackHandoff,
  markFallbackSent,
  markHumanActive,
  markKeywordResponse,
  setBotActive,
  shouldBotReply,
} from "@/lib/conversation-memory";
import { generateReply } from "@/lib/gemini";
import { findDirectFAQAnswer, findShortcutAnswer } from "@/lib/faq";
import {
  HANDOFF_REPLY,
  maskLineUserId,
  notifyAdmin,
  shouldHandoff,
} from "@/lib/handoff";
import { getKnowledgeText } from "@/lib/knowledge";
import { log } from "@/lib/log";
import { sanitizeBotReply } from "@/lib/sanitize";
import { getFAQText } from "@/lib/sheet";

export const runtime = "nodejs";
export const maxDuration = 10;

type ReplyMessage = Parameters<Client["replyMessage"]>[1];

const ADMIN_BOT_ON_REPLY = "บอทกลับมาทำงานแล้วค่ะ";
const ADMIN_BOT_OFF_REPLY = "ปิดบอทชั่วคราวแล้วค่ะ";

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
      FACEBOOK_PAGE_ID: Boolean(process.env.FACEBOOK_PAGE_ID),
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
  const safeText = sanitizeBotReply(text);
  await replyWithRetry(client, replyToken, {
    type: "text",
    text: safeText,
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

function getDebugState(
  userId: string | undefined,
  eventSource: string,
  adminMessage: boolean,
  shouldReply: boolean,
  responseLength = 0,
) {
  const memory = getMemory(userId);
  const now = Date.now();

  return {
    userId: userId ? maskLineUserId(userId) : "unknown",
    eventSource,
    isAdminMessage: adminMessage,
    handoffStatus: memory.handoff?.status || "bot_active",
    pausedUntil: memory.handoff?.pausedUntil || 0,
    now,
    shouldBotReply: shouldReply,
    handoffReason: memory.handoff?.reason,
    fallbackNoticeSent: Boolean(memory.handoff?.fallbackNoticeSent),
    lastIntent: memory.lastIntent,
    lastBotAction: memory.lastBotAction,
    sentKeywords: memory.sentKeywords.join(","),
    responseLength,
  };
}

async function handleTextEvent(
  client: Client,
  event: WebhookEvent,
): Promise<void> {
  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  const startTime = Date.now();
  const timerLabel = `webhook-total-${startTime}`;
  console.time(timerLabel);
  const userId = event.source.userId;
  const userHash = maskLineUserId(userId);
  const userMessage = event.message.text;
  const adminMessage = isAdminMessage(event);
  const eventSource = event.source.type;

  try {
    if (adminMessage) {
      appendHistory(userId, { role: "admin", text: userMessage });

      if (userMessage.trim().toLowerCase() === "/bot on") {
        setBotActive(userId);
        await safeReplyText(client, event.replyToken, ADMIN_BOT_ON_REPLY);
        log.info("handoff.admin_command_on", {
          ...getDebugState(userId, eventSource, adminMessage, true, ADMIN_BOT_ON_REPLY.length),
        });
        return;
      }

      if (userMessage.trim().toLowerCase() === "/bot off") {
        markHumanActive(userId, "admin_command_off");
        await safeReplyText(client, event.replyToken, ADMIN_BOT_OFF_REPLY);
        log.info("handoff.admin_command_off", {
          ...getDebugState(userId, eventSource, adminMessage, false, ADMIN_BOT_OFF_REPLY.length),
        });
        return;
      }

      markHumanActive(userId, "human_replied");
      log.info("handoff.human_active", {
        ...getDebugState(userId, eventSource, adminMessage, false),
      });
      return;
    }

    let memory = appendHistory(userId, { role: "user", text: userMessage });
    const decision = shouldBotReply(userId, memory);
    memory = decision.memory;

    if (decision.oneTimeReply) {
      const safeReply = sanitizeBotReply(decision.oneTimeReply);
      await safeReplyText(client, event.replyToken, safeReply);
      appendHistory(userId, { role: "assistant", text: safeReply });
      log.info("handoff.waiting_confirmation_sent", {
        ...getDebugState(userId, eventSource, adminMessage, false, decision.oneTimeReply.length),
      });
      return;
    }

    if (!decision.shouldBotReply) {
      log.info("handoff.bot_paused_no_reply", {
        ...getDebugState(userId, eventSource, adminMessage, false),
      });
      return;
    }

    log.info("handoff.bot_reply_allowed", {
      ...getDebugState(userId, eventSource, adminMessage, true),
    });

    if (shouldHandoff(userMessage)) {
      await safeReplyText(client, event.replyToken, HANDOFF_REPLY);
      appendHistory(userId, { role: "assistant", text: HANDOFF_REPLY });
      markFallbackHandoff(userId);
      try {
        await notifyAdmin(client, userId, userMessage);
      } catch (error) {
        log.error("handoff.notify_failed", {
          err: error instanceof Error ? error.message : "unknown",
          userHash,
        });
      }
      log.info("handoff.routed", {
        ...getDebugState(userId, eventSource, adminMessage, false, HANDOFF_REPLY.length),
        userHash,
        latencyMs: Date.now() - startTime,
        inputLength: userMessage.length,
      });
      return;
    }

    let faqText: string;
    const faqTimerLabel = `faq-${startTime}`;
    console.time(faqTimerLabel);
    try {
      faqText = await getFAQText();
    } catch (error) {
      log.error("sheet.load_failed", {
        ...getDebugState(userId, eventSource, adminMessage, true, SHEET_ERROR_REPLY.length),
        err: error instanceof Error ? error.message : "unknown",
        userHash,
      });
      await safeReplyText(client, event.replyToken, SHEET_ERROR_REPLY);
      appendHistory(userId, { role: "assistant", text: SHEET_ERROR_REPLY });
      markFallbackSent(userId);
      return;
    } finally {
      console.timeEnd(faqTimerLabel);
    }

    let reply = DEFAULT_REPLY;
    let knowledgeText = "";
    try {
      reply = findDirectFAQAnswer(userMessage, faqText) ?? DEFAULT_REPLY;
      if (reply === DEFAULT_REPLY) {
        reply = findShortcutAnswer(userMessage, faqText) ?? DEFAULT_REPLY;
      }

      if (reply === DEFAULT_REPLY) {
        const knowledgeTimerLabel = `knowledge-${startTime}`;
        console.time(knowledgeTimerLabel);
        try {
          knowledgeText = await getKnowledgeText();
        } finally {
          console.timeEnd(knowledgeTimerLabel);
        }
        reply = findShortcutAnswer(userMessage, faqText, knowledgeText) ?? DEFAULT_REPLY;
      }

      if (reply === DEFAULT_REPLY) {
        if (Date.now() - startTime > WEBHOOK_TOTAL_TIMEOUT_MS - 7000) {
          log.warn("webhook.skip_gemini_not_enough_time", {
            ...getDebugState(userId, eventSource, adminMessage, true, SAFE_SYSTEM_BUSY_REPLY.length),
            elapsedMs: Date.now() - startTime,
            fallbackReason: "not_enough_webhook_time",
          });
          reply = SAFE_SYSTEM_BUSY_REPLY;
        } else {
          const geminiTimerLabel = `gemini-${startTime}`;
          console.time(geminiTimerLabel);
          try {
            memory = getMemory(userId);
            const lastMessages = formatConversationHistory(memory);
            const systemState = getSystemState(memory);
            reply = await generateReply(
              userMessage,
              faqText,
              knowledgeText,
              lastMessages,
              systemState,
            );
          } finally {
            console.timeEnd(geminiTimerLabel);
          }
        }
      } else {
        markKeywordResponse(userId, userMessage);
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

    const safeReply = sanitizeBotReply(reply);
    await safeReplyText(client, event.replyToken, safeReply);
    appendHistory(userId, { role: "assistant", text: safeReply });
    if (safeReply === DEFAULT_REPLY) {
      markFallbackHandoff(userId);
    } else if (
      safeReply === SAFE_SYSTEM_BUSY_REPLY ||
      safeReply === GEMINI_TIMEOUT_REPLY ||
      safeReply === SHEET_ERROR_REPLY
    ) {
      markFallbackSent(userId);
    }
    log.info("reply.sent", {
      ...getDebugState(userId, eventSource, adminMessage, true, safeReply.length),
      userHash,
      latencyMs: Date.now() - startTime,
      inputLength: userMessage.length,
      replyLength: safeReply.length,
      totalDurationMs: Date.now() - startTime,
      fallbackReason:
        safeReply === SAFE_SYSTEM_BUSY_REPLY ? "slow_or_sanitized_reply" : undefined,
    });
  } catch (error) {
    log.error("webhook.event_failed", {
      ...getDebugState(userId, eventSource, adminMessage, true, DEFAULT_REPLY.length),
      err: error instanceof Error ? error.message : "unknown",
      userHash,
    });
    await safeReplyText(client, event.replyToken, DEFAULT_REPLY);
    appendHistory(userId, { role: "assistant", text: DEFAULT_REPLY });
    markFallbackHandoff(userId);
  } finally {
    console.timeEnd(timerLabel);
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
