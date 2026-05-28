import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { NextResponse } from "next/server";
import { fetchFacebookCustomerMessages } from "@/lib/facebook";
import { extractFAQItemsFromMessages } from "@/lib/gemini";
import {
  appendFAQDraftsToSheet,
  saveFAQBackup,
} from "@/lib/google-sheet";
import { log } from "@/lib/log";
import { type FAQItem } from "@/types/faq";

export const runtime = "nodejs";
export const maxDuration = 60;

const SYNC_STATE_PATH = join("/tmp", "facebook-faq-last-sync.json");
let inMemoryLastSync = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getLastSyncTimestamp(): Promise<number> {
  if (inMemoryLastSync) {
    return inMemoryLastSync;
  }

  try {
    const raw = await readFile(SYNC_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as { lastSync?: number };
    inMemoryLastSync = Number(parsed.lastSync || 0);
    return inMemoryLastSync;
  } catch {
    return 0;
  }
}

async function saveLastSyncTimestamp(timestamp: number): Promise<void> {
  inMemoryLastSync = timestamp;
  await writeFile(
    SYNC_STATE_PATH,
    JSON.stringify({ lastSync: timestamp, updated_at: new Date().toISOString() }),
    "utf8",
  );
}

function cleanMessageText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")
    .replace(/[!?.,]{2,}/g, (match) => match[0])
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForGrouping(text: string): string {
  return cleanMessageText(text).replace(/[\s"'`“”‘’.,!?()[\]{}:;|/\\\-–—_]+/g, "");
}

function getSimilarity(a: string, b: string): number {
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (!shorter || !longer) {
    return 0;
  }

  let matches = 0;
  for (const char of shorter) {
    if (longer.includes(char)) {
      matches += 1;
    }
  }

  return matches / longer.length;
}

function preprocessMessages(messages: string[]): string[] {
  const cleaned: string[] = [];

  for (const message of messages) {
    const text = cleanMessageText(message);
    if (text.length < 5) {
      continue;
    }
    cleaned.push(text);
  }

  return cleaned;
}

function getCategory(question: string): string {
  if (/ราคา|ค่าเรียน|บาท|เท่าไหร่|เท่าไร/.test(question)) {
    return "pricing";
  }
  if (/สมัคร|ลงทะเบียน|เรียน/.test(question)) {
    return "course";
  }
  if (/tiktok|ติ๊กต็อก/.test(question)) {
    return "tiktok";
  }
  if (/shopee|ช้อปปี้|lazada|ลาซาด้า/.test(question)) {
    return "marketplace";
  }
  if (/\bai\b|chatgpt|gemini/.test(question)) {
    return "ai";
  }
  return "general";
}

function fallbackGroupMessages(messages: string[]): FAQItem[] {
  const groups: { question: string; frequency: number }[] = [];

  for (const message of messages) {
    const normalized = normalizeForGrouping(message);
    const existing = groups.find((group) => {
      const groupNormalized = normalizeForGrouping(group.question);
      return (
        groupNormalized === normalized ||
        getSimilarity(groupNormalized, normalized) > 0.85
      );
    });

    if (existing) {
      existing.frequency += 1;
    } else {
      groups.push({ question: message, frequency: 1 });
    }
  }

  const now = new Date().toISOString();
  return groups.map((group) => ({
    question: group.question,
    answer: "ขออนุญาตเช็กข้อมูลให้ก่อนนะคะ เดี๋ยวน้องแจ้งคุณเอให้ค่ะ",
    category: getCategory(group.question),
    frequency: group.frequency,
    source: "facebook",
    status: "pending",
    updated_at: now,
  }));
}

export async function POST() {
  const startedAt = Date.now();
  console.time("sync-facebook-faq-total");

  let processedMessages: string[] = [];
  let faqItems: FAQItem[] = [];

  try {
    const lastSync = await getLastSyncTimestamp();

    console.time("facebook-fetch");
    const { messages, conversationsProcessed } =
      await fetchFacebookCustomerMessages({
        since: lastSync,
        maxPages: 10,
        pageDelayMs: 300,
      });
    console.timeEnd("facebook-fetch");

    log.info("facebook_faq.messages_fetched", {
      messagesFetched: messages.length,
      conversationsProcessed,
      lastSync,
    });

    processedMessages = preprocessMessages(messages.map((message) => message.text));

    if (!processedMessages.length) {
      await saveLastSyncTimestamp(Date.now());
      return NextResponse.json({
        success: true,
        messages_processed: 0,
        faq_created: 0,
        faq_updated: 0,
      });
    }

    await delay(250);

    console.time("gemini-faq");
    try {
      faqItems = await extractFAQItemsFromMessages(processedMessages);
    } catch (error) {
      log.error("facebook_faq.gemini_failed_using_fallback", {
        err: error instanceof Error ? error.message : "unknown",
      });
      faqItems = fallbackGroupMessages(processedMessages);
    } finally {
      console.timeEnd("gemini-faq");
    }

    console.time("google-sheet-write");
    try {
      const writeStats = await appendFAQDraftsToSheet(faqItems);
      console.timeEnd("google-sheet-write");

      const newestTimestamp = messages.reduce((max, message) => {
        const timestamp = new Date(message.timestamp).getTime();
        return Number.isFinite(timestamp) && timestamp > max ? timestamp : max;
      }, lastSync || Date.now());
      await saveLastSyncTimestamp(newestTimestamp);

      log.info("facebook_faq.sync_complete", {
        messagesProcessed: processedMessages.length,
        faqCreated: writeStats.created,
        faqUpdated: writeStats.updated,
        durationMs: Date.now() - startedAt,
      });

      return NextResponse.json({
        success: true,
        messages_processed: processedMessages.length,
        faq_created: writeStats.created,
        faq_updated: writeStats.updated,
      });
    } catch (error) {
      console.timeEnd("google-sheet-write");
      const backupPath = await saveFAQBackup(
        faqItems,
        error instanceof Error ? error.message : "google_sheet_failed",
      );
      return NextResponse.json(
        {
          success: false,
          error: "Google Sheets write failed; JSON backup saved locally",
          backup_path: backupPath,
          messages_processed: processedMessages.length,
          faq_created: 0,
          faq_updated: 0,
        },
        { status: 500 },
      );
    }
  } catch (error) {
    log.error("facebook_faq.sync_failed", {
      err: error instanceof Error ? error.message : "unknown",
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(
      {
        success: false,
        error: "Facebook FAQ sync failed",
        messages_processed: processedMessages.length,
        faq_created: 0,
        faq_updated: 0,
      },
      { status: 500 },
    );
  } finally {
    console.timeEnd("sync-facebook-faq-total");
  }
}
