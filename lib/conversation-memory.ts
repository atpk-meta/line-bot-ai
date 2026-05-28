import {
  DEFAULT_REPLY,
  FALLBACK_HANDOFF_PAUSE_MS,
  HUMAN_ACTIVE_PAUSE_MS,
} from "./constants";

export type MessageRole = "user" | "assistant" | "admin";

export interface Message {
  role: MessageRole;
  text: string;
  at: number;
}

export interface ConversationMemory {
  history: Message[];
  collectedInfo: {
    interest?: string;
    selectedCourse?: string;
    channel?: string;
  };
  lastIntent?: string;
  lastBotAction?: string;
  sentKeywords: string[];
  handoff?: {
    status: "bot_active" | "waiting_for_human" | "human_active";
    reason?: string;
    pausedUntil?: number;
    lastHumanReplyAt?: number;
    fallbackNoticeSent?: boolean;
  };
  updatedAt: number;
}

export interface BotReplyDecision {
  shouldBotReply: boolean;
  oneTimeReply?: string;
  memory: ConversationMemory;
}

const MAX_HISTORY_MESSAGES = 20;
const MEMORY_TTL_MS = 24 * 60 * 60 * 1000;
const HANDOFF_CONFIRMATION_REPLY =
  "น้องส่งเรื่องให้คุณเอแล้วนะคะ เดี๋ยวรอคุณเอมาตอบให้นะคะ";

const memoryStore = new Map<string, ConversationMemory>();

function getMemoryKey(userId?: string): string | null {
  return userId?.trim() || null;
}

function createEmptyMemory(now = Date.now()): ConversationMemory {
  return {
    history: [],
    collectedInfo: {},
    sentKeywords: [],
    handoff: {
      status: "bot_active",
      pausedUntil: 0,
      fallbackNoticeSent: false,
    },
    updatedAt: now,
  };
}

function pruneMemory(memory: ConversationMemory, now = Date.now()): ConversationMemory {
  return {
    ...memory,
    history: memory.history
      .filter((message) => now - message.at <= MEMORY_TTL_MS)
      .slice(-MAX_HISTORY_MESSAGES),
    sentKeywords: memory.sentKeywords.slice(-20),
  };
}

function inferCollectedInfo(memory: ConversationMemory, text: string): ConversationMemory {
  const lower = text.toLowerCase();
  const collectedInfo = { ...memory.collectedInfo };

  if (!collectedInfo.interest) {
    if (lower.includes("tiktok") || lower.includes("ติ๊กต็อก")) {
      collectedInfo.interest = "TikTok";
    } else if (lower.includes("shopee") || lower.includes("ช้อปปี้")) {
      collectedInfo.interest = "Shopee";
    } else if (lower.includes("lazada") || lower.includes("ลาซาด้า")) {
      collectedInfo.interest = "Lazada";
    } else if (lower.includes("affiliate") || lower.includes("แอฟฟิลิเอต")) {
      collectedInfo.interest = "Affiliate";
    } else if (lower.includes("ai")) {
      collectedInfo.interest = "AI";
    }
  }

  if (!collectedInfo.channel) {
    if (lower.includes("facebook")) {
      collectedInfo.channel = "Facebook";
    } else if (lower.includes("youtube")) {
      collectedInfo.channel = "YouTube";
    } else if (lower.includes("line")) {
      collectedInfo.channel = "LINE";
    }
  }

  return {
    ...memory,
    collectedInfo,
  };
}

export function getMemory(userId?: string): ConversationMemory {
  const key = getMemoryKey(userId);
  if (!key) {
    return createEmptyMemory();
  }

  const now = Date.now();
  const memory = pruneMemory(memoryStore.get(key) || createEmptyMemory(now), now);
  memoryStore.set(key, memory);
  return memory;
}

export function saveMemory(userId: string | undefined, memory: ConversationMemory): void {
  const key = getMemoryKey(userId);
  if (!key) {
    return;
  }

  memoryStore.set(key, pruneMemory({ ...memory, updatedAt: Date.now() }));
}

export function appendHistory(
  userId: string | undefined,
  message: Omit<Message, "at"> & { at?: number },
): ConversationMemory {
  const memory = getMemory(userId);
  const nextMemory = inferCollectedInfo(
    {
      ...memory,
      history: [...memory.history, { ...message, at: message.at || Date.now() }],
    },
    message.text,
  );

  saveMemory(userId, nextMemory);
  return nextMemory;
}

export function formatConversationHistory(memory: ConversationMemory): string {
  return memory.history
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n");
}

export function getSystemState(memory: ConversationMemory): string {
  return [
    `lastIntent: ${memory.lastIntent || ""}`,
    `lastBotAction: ${memory.lastBotAction || ""}`,
    `sentKeywords: ${memory.sentKeywords.join(", ")}`,
    `handoffStatus: ${memory.handoff?.status || "bot_active"}`,
    `interest: ${memory.collectedInfo.interest || ""}`,
    `selectedCourse: ${memory.collectedInfo.selectedCourse || ""}`,
    `channel: ${memory.collectedInfo.channel || ""}`,
  ].join("\n");
}

export function shouldBotReply(
  userId: string | undefined,
  memory = getMemory(userId),
  now = Date.now(),
): BotReplyDecision {
  const handoff = memory.handoff;

  if (handoff?.pausedUntil && handoff.pausedUntil > now) {
    if (handoff.status === "human_active") {
      return { shouldBotReply: false, memory };
    }

    if (handoff.status === "waiting_for_human") {
      if (!handoff.fallbackNoticeSent) {
        const nextMemory: ConversationMemory = {
          ...memory,
          handoff: {
            ...handoff,
            fallbackNoticeSent: true,
          },
        };
        saveMemory(userId, nextMemory);
        return {
          shouldBotReply: false,
          oneTimeReply: HANDOFF_CONFIRMATION_REPLY,
          memory: nextMemory,
        };
      }

      return { shouldBotReply: false, memory };
    }
  }

  if (handoff?.pausedUntil && handoff.pausedUntil <= now) {
    const nextMemory: ConversationMemory = {
      ...memory,
      handoff: {
        status: "bot_active",
        reason: undefined,
        pausedUntil: 0,
        fallbackNoticeSent: false,
      },
    };
    saveMemory(userId, nextMemory);
    return { shouldBotReply: true, memory: nextMemory };
  }

  return { shouldBotReply: true, memory };
}

export function markFallbackHandoff(
  userId: string | undefined,
  memory = getMemory(userId),
): ConversationMemory {
  const nextMemory: ConversationMemory = {
    ...memory,
    lastBotAction: "fallback_handoff",
    handoff: {
      status: "waiting_for_human",
      reason: "fallback_needs_human",
      pausedUntil: Date.now() + FALLBACK_HANDOFF_PAUSE_MS,
      fallbackNoticeSent: true,
    },
  };

  saveMemory(userId, nextMemory);
  return nextMemory;
}

export function markHumanActive(
  userId: string | undefined,
  reason = "human_replied",
  memory = getMemory(userId),
  at = Date.now(),
): ConversationMemory {
  const nextMemory: ConversationMemory = {
    ...memory,
    handoff: {
      status: "human_active",
      reason,
      lastHumanReplyAt: at,
      pausedUntil: at + HUMAN_ACTIVE_PAUSE_MS,
      fallbackNoticeSent: false,
    },
  };

  saveMemory(userId, nextMemory);
  return nextMemory;
}

export function setBotActive(
  userId: string | undefined,
  reason = "admin_command_on",
  memory = getMemory(userId),
): ConversationMemory {
  const nextMemory: ConversationMemory = {
    ...memory,
    handoff: {
      status: "bot_active",
      reason,
      pausedUntil: 0,
      fallbackNoticeSent: false,
    },
  };

  saveMemory(userId, nextMemory);
  return nextMemory;
}

export function rememberConversationTurn(
  userId: string | undefined,
  customer: string,
  assistant: string,
): void {
  appendHistory(userId, { role: "user", text: customer });
  appendHistory(userId, { role: "assistant", text: assistant });

  if (assistant === DEFAULT_REPLY) {
    markFallbackHandoff(userId);
  }
}

export function markKeywordResponse(
  userId: string | undefined,
  keyword: string,
  memory = getMemory(userId),
): void {
  saveMemory(userId, {
    ...memory,
    lastBotAction: "keyword_response",
    sentKeywords: [...memory.sentKeywords, keyword].slice(-20),
  });
}
