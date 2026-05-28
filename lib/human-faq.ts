import { GoogleGenAI } from "@google/genai";
import {
  DEFAULT_REPLY,
  GEMINI_MAX_OUTPUT_TOKENS,
  GEMINI_MODEL,
  GEMINI_TEMPERATURE,
} from "./constants";
import { type HumanReplyPair } from "./facebook";
import { appendHistory, markHumanActive } from "./conversation-memory";
import {
  appendFAQDraft,
  ensureFAQDraftSheet,
  getFAQDraftValues,
  updateFAQDraftSeen,
  type DraftFAQRow,
} from "./google-sheets";
import { log } from "./log";

const UNSAFE_REPLY_PATTERNS = [
  "เดี๋ยวแอดมินติดต่อกลับ",
  "ส่งสลิป",
  "ขอเบอร์",
  "อินบ็อกซ์มา",
  "inbox",
  "เบอร์โทร",
  "ที่อยู่",
  "เลขบัญชี",
  "แอดมินติดต่อ",
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s"'`“”‘’.,!?()[\]{}:;|/\\\-–—_]+/g, "");
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

export function shouldSkipHumanReply(reply: string): string | null {
  const normalized = normalize(reply);
  const found = UNSAFE_REPLY_PATTERNS.find((pattern) =>
    normalized.includes(normalize(pattern)),
  );

  return found ? `unsafe_private_or_handoff:${found}` : null;
}

async function summarizePair(pair: HumanReplyPair): Promise<DraftFAQRow> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const ai = new GoogleGenAI({ apiKey });
  const now = new Date().toISOString();
  const prompt = `<task>
สรุปคู่ข้อความ customer question + human/admin reply ให้เป็น FAQ draft สำหรับเพจ a/TPK
ห้ามใส่ข้อมูลส่วนตัว เช่น ชื่อ เบอร์ ที่อยู่ เลขบัญชี ข้อมูลเฉพาะบุคคล
ถ้าเป็นราคา คอร์ส วันเรียน โปรโมชัน ต้องตั้ง status เป็น pending
ตอบเป็น JSON เท่านั้น ไม่ใช้ markdown
</task>

<customer_question>
${pair.customerQuestion}
</customer_question>

<human_reply>
${pair.humanReply}
</human_reply>

<json_schema>
{
  "question": "คำถาม FAQ แบบทั่วไป",
  "answer": "คำตอบภาษาไทยสุภาพแบบน้องลี่จิน",
  "category": "หมวดหมู่สั้นๆ",
  "confidence": 0.8
}
</json_schema>`;

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      temperature: GEMINI_TEMPERATURE,
      maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
    },
  });

  const finishReason = response.candidates?.[0]?.finishReason;
  const raw = response.text?.replace(/```json|```/g, "").trim() || "";
  log.info("human_faq.generated", {
    conversationId: pair.conversationId,
    finishReason,
    generatedFAQ: raw.slice(0, 300),
  });

  if (finishReason === "MAX_TOKENS" || !raw) {
    throw new Error("human_faq_generation_failed");
  }

  const parsed = JSON.parse(raw) as {
    question?: string;
    answer?: string;
    category?: string;
    confidence?: number;
  };

  if (!parsed.question || !parsed.answer) {
    throw new Error("human_faq_missing_question_or_answer");
  }

  return {
    question: parsed.question,
    answer: parsed.answer,
    category: parsed.category || "ทั่วไป",
    source: "human_reply",
    status: "pending",
    confidence: parsed.confidence ?? 0.8,
    example_user_question: pair.customerQuestion,
    raw_human_reply: pair.humanReply,
    updated_at: now,
  };
}

interface DuplicateMatch {
  rowNumber: number;
  frequency: number;
}

function findDuplicate(
  question: string,
  draftValues: string[][],
): DuplicateMatch | null {
  const normalizedQuestion = normalize(question);
  const rows = draftValues.slice(1);

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const existingQuestion = normalize(row[0] || "");
    const matched =
      existingQuestion === normalizedQuestion ||
      getSimilarity(existingQuestion, normalizedQuestion) >= 0.88;

    if (matched) {
      const parsedFrequency = Number(row[9] || 0);
      return {
        rowNumber: index + 2,
        frequency: Number.isFinite(parsedFrequency) ? parsedFrequency : 0,
      };
    }
  }

  return null;
}

export interface HumanFAQSyncStats {
  pairs_found: number;
  faq_drafts_created: number;
  skipped_private: number;
  duplicates_updated: number;
}

export async function createFAQDraftsFromPairs(
  pairs: HumanReplyPair[],
): Promise<HumanFAQSyncStats> {
  await ensureFAQDraftSheet();
  const draftValues = await getFAQDraftValues();
  const stats: HumanFAQSyncStats = {
    pairs_found: pairs.length,
    faq_drafts_created: 0,
    skipped_private: 0,
    duplicates_updated: 0,
  };

  for (const pair of pairs) {
    appendHistory(pair.memoryUserId, {
      role: "user",
      text: pair.customerQuestion,
    });
    appendHistory(pair.memoryUserId, {
      role: "admin",
      text: pair.humanReply,
      at: pair.humanReplyAt,
    });
    markHumanActive(pair.memoryUserId, "human_replied", undefined, pair.humanReplyAt);

    const skipReason = shouldSkipHumanReply(pair.humanReply);
    if (skipReason) {
      stats.skipped_private += 1;
      log.info("human_faq.skipped", {
        conversationId: pair.conversationId,
        skipReason,
        humanReplyPreview: pair.humanReply.slice(0, 120),
      });
      continue;
    }

    let draft: DraftFAQRow;
    try {
      draft = await summarizePair(pair);
    } catch (error) {
      log.error("human_faq.generate_failed", {
        conversationId: pair.conversationId,
        skipReason: error instanceof Error ? error.message : "unknown",
      });
      continue;
    }

    const duplicate = findDuplicate(draft.question, draftValues);
    if (draft.answer === DEFAULT_REPLY || duplicate) {
      stats.duplicates_updated += 1;
      if (duplicate) {
        await updateFAQDraftSeen(
          duplicate.rowNumber,
          duplicate.frequency + 1,
          draft.updated_at,
        );
        const draftIndex = duplicate.rowNumber - 1;
        draftValues[draftIndex][9] = String(duplicate.frequency + 1);
        draftValues[draftIndex][10] = draft.updated_at;
      }
      log.info("human_faq.duplicate", {
        conversationId: pair.conversationId,
        customerQuestion: pair.customerQuestion,
        generatedFAQ: draft.question,
      });
      continue;
    }

    await appendFAQDraft(draft);
    draftValues.push([
      draft.question,
      draft.answer,
      draft.category,
      draft.source,
      draft.status,
      String(draft.confidence),
      draft.example_user_question,
      draft.raw_human_reply,
      draft.updated_at,
      "1",
      draft.updated_at,
    ]);
    stats.faq_drafts_created += 1;
  }

  return stats;
}
