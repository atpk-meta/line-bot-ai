import { createHmac, timingSafeEqual } from "crypto";
import { Client, messagingApi, type WebhookEvent } from "@line/bot-sdk";
import { NextResponse } from "next/server";
import { DEFAULT_REPLY, SHEET_ERROR_REPLY } from "@/lib/constants";
import { generateReply } from "@/lib/gemini";
import { getFAQText } from "@/lib/sheet";

export const runtime = "nodejs";
export const maxDuration = 10;

export function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "/api/line-webhook",
    env: {
      LINE_CHANNEL_ACCESS_TOKEN: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN),
      LINE_CHANNEL_SECRET: Boolean(process.env.LINE_CHANNEL_SECRET),
      GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY),
      SHEET_CSV_URL: Boolean(process.env.SHEET_CSV_URL),
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

async function replyText(
  client: Client,
  replyToken: string,
  text: string,
): Promise<void> {
  await client.replyMessage(replyToken, {
    type: "text",
    text,
  } satisfies messagingApi.TextMessage);
}

async function safeReplyText(
  client: Client,
  replyToken: string,
  text: string,
): Promise<void> {
  try {
    await replyText(client, replyToken, text);
  } catch (error) {
    console.error("Failed to reply LINE message", error);
  }
}

async function handleTextEvent(
  client: Client,
  event: WebhookEvent,
): Promise<void> {
  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  let faqText: string;
  try {
    faqText = await getFAQText();
  } catch (error) {
    console.error("Failed to load FAQ sheet", error);
    await safeReplyText(client, event.replyToken, SHEET_ERROR_REPLY);
    return;
  }

  let reply = DEFAULT_REPLY;
  try {
    reply = await generateReply(event.message.text, faqText);
  } catch (error) {
    console.error("Failed to generate Gemini reply", error);
  }

  await safeReplyText(client, event.replyToken, reply);
}

export async function POST(request: Request) {
  let body = "";
  try {
    body = await request.text();
  } catch (error) {
    console.error("Failed to read LINE webhook body", error);
    return new NextResponse("Bad Request", { status: 400 });
  }

  const signature = request.headers.get("x-line-signature");
  if (!verifyLineSignature(body, signature)) {
    console.error("LINE webhook signature verification failed");
    return new NextResponse("Unauthorized", { status: 401 });
  }

  let events: WebhookEvent[] = [];
  try {
    const parsedBody = JSON.parse(body) as { events?: WebhookEvent[] };
    events = Array.isArray(parsedBody.events) ? parsedBody.events : [];
    console.log("LINE webhook received", { eventCount: events.length });
  } catch (error) {
    console.error("Failed to parse LINE webhook body", error);
    return new NextResponse("Bad Request", { status: 400 });
  }

  let client: Client;
  try {
    client = getLineClient();
  } catch (error) {
    console.error("Failed to create LINE client", error);
    return NextResponse.json({ ok: false });
  }

  await Promise.all(events.map((event) => handleTextEvent(client, event)));

  return NextResponse.json({ ok: true });
}
