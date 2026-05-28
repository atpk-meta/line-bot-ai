import { HUMAN_REPLY_SYNC_LIMIT } from "./constants";
import { log } from "./log";

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
  messages?: {
    data?: FacebookMessage[];
  };
}

function getFacebookConfig() {
  const pageAccessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;

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
