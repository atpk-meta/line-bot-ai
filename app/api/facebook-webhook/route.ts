import { NextResponse } from "next/server";
import { handleIncomingMessage } from "@/lib/chatbot-core";
import { markHumanActive } from "@/lib/conversation-memory";
import {
  isRecentFacebookBotEcho,
  sendFacebookMessage,
} from "@/lib/facebook";
import { log } from "@/lib/log";
import { sanitizeBotReply } from "@/lib/sanitize";

export const runtime = "nodejs";
export const maxDuration = 10;

interface FacebookWebhookMessage {
  mid?: string;
  text?: string;
  is_echo?: boolean;
  attachments?: unknown[];
}

interface FacebookMessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: FacebookWebhookMessage;
  delivery?: unknown;
  read?: unknown;
}

interface FacebookWebhookEntry {
  id?: string;
  time?: number;
  messaging?: FacebookMessagingEvent[];
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.FB_VERIFY_TOKEN && challenge) {
    return new NextResponse(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  log.warn("facebook.verify_failed", {
    mode: mode || undefined,
    hasToken: Boolean(token),
  });
  return new NextResponse("Forbidden", { status: 403 });
}

async function handleMessagingEvent(event: FacebookMessagingEvent): Promise<void> {
  if (event.delivery || event.read) {
    return;
  }

  const message = event.message;
  if (!message) {
    return;
  }

  if (message.is_echo) {
    const customerUserId = event.recipient?.id;
    if (customerUserId && isRecentFacebookBotEcho(customerUserId, message.text)) {
      log.info("facebook.echo_ignored_bot_send", {
        userId: customerUserId,
      });
      return;
    }

    if (customerUserId) {
      markHumanActive(`facebook:${customerUserId}`, "human_replied");
      log.info("facebook.echo_human_active", {
        userId: customerUserId,
        paused: true,
      });
    }
    return;
  }

  if (message.attachments?.length || !message.text?.trim()) {
    return;
  }

  const userId = event.sender?.id;
  if (!userId) {
    return;
  }

  const result = await handleIncomingMessage({
    platform: "facebook",
    userId,
    messageText: message.text,
    rawEvent: event,
  });

  if (result.shouldReply && result.replyText) {
    const replyText = sanitizeBotReply(result.replyText);
    try {
      await sendFacebookMessage(userId, replyText);
    } catch (error) {
      log.error("facebook.send_failed", {
        err: error instanceof Error ? error.message : "unknown",
        userId,
        replyLength: replyText.length,
      });
    }
  } else {
    log.info("facebook.no_reply", {
      userId,
      shouldReply: result.shouldReply,
      hasReplyText: Boolean(result.replyText),
    });
  }
}

export async function POST(request: Request) {
  let payload: { object?: string; entry?: FacebookWebhookEntry[] };

  try {
    payload = (await request.json()) as {
      object?: string;
      entry?: FacebookWebhookEntry[];
    };
  } catch (error) {
    log.error("facebook.webhook_json_failed", {
      err: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ success: true });
  }

  try {
    const entries = payload.entry || [];
    log.info("facebook.webhook_received", {
      object: payload.object,
      entries: entries.length,
      messagingEvents: entries.reduce(
        (total, entry) => total + (entry.messaging?.length || 0),
        0,
      ),
    });
    for (const entry of entries) {
      for (const event of entry.messaging || []) {
        await handleMessagingEvent(event);
      }
    }
  } catch (error) {
    log.error("facebook.webhook_handle_failed", {
      err: error instanceof Error ? error.message : "unknown",
    });
  }

  return NextResponse.json({ success: true });
}
