import { HUMAN_REPLY_SYNC_LIMIT } from "./constants";
import { log } from "./log";
import { type FacebookInboxMessage } from "@/types/faq";

export interface HumanReplyPair {
  conversationId: string;
  memoryUserId: string;
  customerQuestion: string;
  humanReply: string;
  humanReplyAt?: number;
}

interface FacebookMessage {
  id: string;
  message?: string;
  created_time?: string;
  from?: {
    id?: string;
    name?: string;
  };
}

interface FacebookConversation {
  id: string;
  updated_time?: string;
  messages?: {
    data?: FacebookMessage[];
  };
}

function getFacebookConfig() {
  const pageAccessToken =
    process.env.FB_PAGE_ACCESS_TOKEN || process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const pageId = process.env.FB_PAGE_ID || process.env.FACEBOOK_PAGE_ID;

  if (!pageAccessToken || !pageId) {
    throw new Error("Missing FACEBOOK_PAGE_ACCESS_TOKEN or FACEBOOK_PAGE_ID");
  }

  return { pageAccessToken, pageId };
}

function isPageMessage(message: FacebookMessage, pageId: string): boolean {
  return message.from?.id === pageId;
}

export async function fetchHumanReplyPairs(): Promise<HumanReplyPair[]> {
  const { pageAccessToken, pageId } = getFacebookConfig();
  const url = new URL(`https://graph.facebook.com/v20.0/${pageId}/conversations`);
  url.searchParams.set(
    "fields",
    "id,messages.limit(20){id,message,from,created_time}",
  );
  url.searchParams.set("limit", String(HUMAN_REPLY_SYNC_LIMIT));
  url.searchParams.set("access_token", pageAccessToken);

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Facebook fetch failed: ${res.status}`);
  }

  const payload = (await res.json()) as { data?: FacebookConversation[] };
  const pairs: HumanReplyPair[] = [];

  for (const conversation of payload.data || []) {
    const messages = (conversation.messages?.data || [])
      .filter((message) => message.message?.trim())
      .sort((a, b) =>
        String(a.created_time || "").localeCompare(String(b.created_time || "")),
      );

    let latestCustomerQuestion = "";

    for (const message of messages) {
      const text = message.message?.trim() || "";
      if (!text) {
        continue;
      }

      if (isPageMessage(message, pageId)) {
        if (latestCustomerQuestion) {
          pairs.push({
            conversationId: conversation.id,
            memoryUserId: `facebook:${conversation.id}`,
            customerQuestion: latestCustomerQuestion,
            humanReply: text,
            humanReplyAt: message.created_time
              ? new Date(message.created_time).getTime()
              : Date.now(),
          });
          log.info("human_reply.pair_found", {
            conversationId: conversation.id,
            customerQuestion: latestCustomerQuestion,
            humanReplyPreview: text.slice(0, 120),
          });
        }
      } else {
        latestCustomerQuestion = text;
      }
    }
  }

  return pairs;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCustomerMessage(message: FacebookMessage, pageId: string): boolean {
  return Boolean(message.message?.trim()) && !isPageMessage(message, pageId);
}

export async function fetchFacebookCustomerMessages(options?: {
  since?: number;
  maxPages?: number;
  pageDelayMs?: number;
}): Promise<{
  messages: FacebookInboxMessage[];
  conversationsProcessed: number;
}> {
  const { pageAccessToken, pageId } = getFacebookConfig();
  const maxPages = options?.maxPages ?? 8;
  const pageDelayMs = options?.pageDelayMs ?? 250;
  const since = options?.since ?? 0;
  const messages: FacebookInboxMessage[] = [];
  let conversationsProcessed = 0;
  let nextUrl: string | null = null;

  for (let page = 0; page < maxPages; page += 1) {
    const url =
      nextUrl ||
      (() => {
        const next = new URL(`https://graph.facebook.com/v20.0/${pageId}/conversations`);
        next.searchParams.set(
          "fields",
          "id,updated_time,messages.limit(50){id,message,from,created_time,attachments,sticker}",
        );
        next.searchParams.set("limit", "25");
        next.searchParams.set("access_token", pageAccessToken);
        return next.toString();
      })();

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`Facebook conversations fetch failed: ${res.status}`);
    }

    const payload = (await res.json()) as {
      data?: FacebookConversation[];
      paging?: { next?: string };
    };

    for (const conversation of payload.data || []) {
      conversationsProcessed += 1;
      const conversationMessages = conversation.messages?.data || [];

      for (const message of conversationMessages) {
        const createdAt = message.created_time
          ? new Date(message.created_time).getTime()
          : 0;

        if (since && createdAt && createdAt <= since) {
          continue;
        }

        if (!isCustomerMessage(message, pageId)) {
          continue;
        }

        messages.push({
          conversationId: conversation.id,
          messageId: message.id,
          text: message.message?.trim() || "",
          senderId: message.from?.id,
          senderName: message.from?.name,
          timestamp: message.created_time || new Date().toISOString(),
        });
      }
    }

    log.info("facebook.inbox_page_fetched", {
      page: page + 1,
      conversationsProcessed,
      messagesFetched: messages.length,
    });

    nextUrl = payload.paging?.next || null;
    if (!nextUrl) {
      break;
    }

    await delay(pageDelayMs);
  }

  return { messages, conversationsProcessed };
}
