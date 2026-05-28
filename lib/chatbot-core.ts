import { createHash } from "crypto";
import {
  DEFAULT_REPLY,
  GEMINI_TIMEOUT_REPLY,
  SAFE_SYSTEM_BUSY_REPLY,
  SHEET_ERROR_REPLY,
  WEBHOOK_TOTAL_TIMEOUT_MS,
} from "./constants";
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
} from "./conversation-memory";
import { findDirectFAQAnswer, findShortcutAnswer } from "./faq";
import { generateReply } from "./gemini";
import { HANDOFF_REPLY, shouldHandoff } from "./handoff";
import { getKnowledgeText } from "./knowledge";
import { log } from "./log";
import { sanitizeBotReply } from "./sanitize";
import { getFAQText } from "./sheet";

const ADMIN_BOT_ON_REPLY = "บอทกลับมาทำงานแล้วค่ะ";
const ADMIN_BOT_OFF_REPLY = "ปิดบอทชั่วคราวแล้วค่ะ";

export type ChatPlatform = "line" | "facebook";

export interface IncomingMessageInput {
  platform: ChatPlatform;
  userId: string;
  messageText: string;
  rawEvent?: unknown;
  isAdminMessage?: boolean;
}

export interface IncomingMessageResult {
  shouldReply: boolean;
  replyText?: string;
  handoffRequested?: boolean;
}

function getMemoryKey(platform: ChatPlatform, userId: string): string {
  return `${platform}:${userId}`;
}

function maskUserId(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 12);
}

function getDebugState(
  memoryKey: string,
  platform: ChatPlatform,
  adminMessage: boolean,
  shouldReply: boolean,
  responseLength = 0,
) {
  const memory = getMemory(memoryKey);
  const now = Date.now();

  return {
    userId: maskUserId(memoryKey),
    eventSource: platform,
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

export async function handleIncomingMessage({
  platform,
  userId,
  messageText,
  isAdminMessage = false,
}: IncomingMessageInput): Promise<IncomingMessageResult> {
  const startTime = Date.now();
  const timerLabel = `chatbot-core-total-${platform}-${startTime}`;
  console.time(timerLabel);

  const memoryKey = getMemoryKey(platform, userId);
  const userHash = maskUserId(memoryKey);

  try {
    if (!messageText.trim()) {
      return { shouldReply: false };
    }

    if (isAdminMessage) {
      appendHistory(memoryKey, { role: "admin", text: messageText });

      if (messageText.trim().toLowerCase() === "/bot on") {
        setBotActive(memoryKey);
        const replyText = sanitizeBotReply(ADMIN_BOT_ON_REPLY);
        log.info("handoff.admin_command_on", {
          ...getDebugState(memoryKey, platform, isAdminMessage, true, replyText.length),
        });
        return { shouldReply: true, replyText };
      }

      if (messageText.trim().toLowerCase() === "/bot off") {
        markHumanActive(memoryKey, "admin_command_off");
        const replyText = sanitizeBotReply(ADMIN_BOT_OFF_REPLY);
        log.info("handoff.admin_command_off", {
          ...getDebugState(memoryKey, platform, isAdminMessage, false, replyText.length),
        });
        return { shouldReply: true, replyText };
      }

      markHumanActive(memoryKey, "human_replied");
      log.info("handoff.human_active", {
        ...getDebugState(memoryKey, platform, isAdminMessage, false),
      });
      return { shouldReply: false };
    }

    let memory = appendHistory(memoryKey, { role: "user", text: messageText });
    const decision = shouldBotReply(memoryKey, memory);
    memory = decision.memory;

    if (decision.oneTimeReply) {
      const replyText = sanitizeBotReply(decision.oneTimeReply);
      appendHistory(memoryKey, { role: "assistant", text: replyText });
      log.info("handoff.waiting_confirmation_sent", {
        ...getDebugState(memoryKey, platform, false, false, replyText.length),
      });
      return { shouldReply: true, replyText };
    }

    if (!decision.shouldBotReply) {
      log.info("handoff.bot_paused_no_reply", {
        ...getDebugState(memoryKey, platform, false, false),
      });
      return { shouldReply: false };
    }

    log.info("handoff.bot_reply_allowed", {
      ...getDebugState(memoryKey, platform, false, true),
    });

    if (shouldHandoff(messageText)) {
      const replyText = sanitizeBotReply(HANDOFF_REPLY);
      appendHistory(memoryKey, { role: "assistant", text: replyText });
      markFallbackHandoff(memoryKey);
      log.info("handoff.routed", {
        ...getDebugState(memoryKey, platform, false, false, replyText.length),
        userHash,
        latencyMs: Date.now() - startTime,
        inputLength: messageText.length,
      });
      return { shouldReply: true, replyText, handoffRequested: true };
    }

    let faqText = "";
    const faqTimerLabel = `faq-${platform}-${startTime}`;
    console.time(faqTimerLabel);
    try {
      faqText = await getFAQText();
    } catch (error) {
      log.error("sheet.load_failed", {
        ...getDebugState(memoryKey, platform, false, true, SHEET_ERROR_REPLY.length),
        err: error instanceof Error ? error.message : "unknown",
        userHash,
      });
      const replyText = sanitizeBotReply(SHEET_ERROR_REPLY);
      appendHistory(memoryKey, { role: "assistant", text: replyText });
      markFallbackSent(memoryKey);
      return { shouldReply: true, replyText };
    } finally {
      console.timeEnd(faqTimerLabel);
    }

    let reply = DEFAULT_REPLY;
    let knowledgeText = "";
    try {
      reply = findDirectFAQAnswer(messageText, faqText) ?? DEFAULT_REPLY;
      if (reply === DEFAULT_REPLY) {
        reply = findShortcutAnswer(messageText, faqText) ?? DEFAULT_REPLY;
      }

      if (reply === DEFAULT_REPLY) {
        const knowledgeTimerLabel = `knowledge-${platform}-${startTime}`;
        console.time(knowledgeTimerLabel);
        try {
          knowledgeText = await getKnowledgeText();
        } finally {
          console.timeEnd(knowledgeTimerLabel);
        }
        reply = findShortcutAnswer(messageText, faqText, knowledgeText) ?? DEFAULT_REPLY;
      }

      if (reply === DEFAULT_REPLY) {
        if (Date.now() - startTime > WEBHOOK_TOTAL_TIMEOUT_MS - 7000) {
          log.warn("webhook.skip_gemini_not_enough_time", {
            ...getDebugState(memoryKey, platform, false, true, SAFE_SYSTEM_BUSY_REPLY.length),
            elapsedMs: Date.now() - startTime,
            fallbackReason: "not_enough_webhook_time",
          });
          reply = SAFE_SYSTEM_BUSY_REPLY;
        } else {
          const geminiTimerLabel = `gemini-${platform}-${startTime}`;
          console.time(geminiTimerLabel);
          try {
            memory = getMemory(memoryKey);
            const lastMessages = formatConversationHistory(memory);
            const systemState = getSystemState(memory);
            reply = await generateReply(
              messageText,
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
        markKeywordResponse(memoryKey, messageText);
        log.info("faq.direct_match", {
          userHash,
          inputLength: messageText.length,
          replyLength: reply.length,
        });
      }
    } catch (error) {
      log.error("gemini.failed", {
        err: error instanceof Error ? error.message : "unknown",
        userHash,
      });
    }

    const replyText = sanitizeBotReply(reply);
    appendHistory(memoryKey, { role: "assistant", text: replyText });

    if (replyText === DEFAULT_REPLY) {
      markFallbackHandoff(memoryKey);
    } else if (
      replyText === SAFE_SYSTEM_BUSY_REPLY ||
      replyText === GEMINI_TIMEOUT_REPLY ||
      replyText === SHEET_ERROR_REPLY
    ) {
      markFallbackSent(memoryKey);
    }

    log.info("reply.sent", {
      ...getDebugState(memoryKey, platform, false, true, replyText.length),
      userHash,
      latencyMs: Date.now() - startTime,
      inputLength: messageText.length,
      replyLength: replyText.length,
      totalDurationMs: Date.now() - startTime,
      fallbackReason:
        replyText === SAFE_SYSTEM_BUSY_REPLY ? "slow_or_sanitized_reply" : undefined,
    });

    return { shouldReply: true, replyText };
  } catch (error) {
    log.error("webhook.event_failed", {
      ...getDebugState(memoryKey, platform, isAdminMessage, true, DEFAULT_REPLY.length),
      err: error instanceof Error ? error.message : "unknown",
      userHash,
    });
    const replyText = sanitizeBotReply(DEFAULT_REPLY);
    appendHistory(memoryKey, { role: "assistant", text: replyText });
    markFallbackHandoff(memoryKey);
    return { shouldReply: true, replyText };
  } finally {
    console.timeEnd(timerLabel);
  }
}
