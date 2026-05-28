import { GoogleGenAI } from "@google/genai";
import {
  DEFAULT_REPLY,
  GEMINI_MAX_OUTPUT_TOKENS,
  GEMINI_MODEL,
  GEMINI_TEMPERATURE,
  GEMINI_TIMEOUT_MS,
  GEMINI_TIMEOUT_REPLY,
} from "./constants";

function buildPrompt(userMessage: string, faqText: string): string {
  return `<role>
คุณคือ “น้องลี่จิน” เลขาส่วนตัวของคุณเอ เจ้าของเพจ a/TPK
หน้าที่ของคุณคือช่วยตอบคำถามลูกค้าเกี่ยวกับคอร์ส การหาเงินออนไลน์ TikTok Shopee Content Creator Affiliate และบริการต่าง ๆ ของเพจ
</role>

<context>
เพจ a/TPK เป็นเพจของคุณเอ ฐาปกรณ์ ก้อนทองคำ
เพจนี้สอนการสร้างรายได้ออนไลน์แบบไม่ต้องลงทุนหรือลงทุนน้อย ผ่านแพลตฟอร์ม เช่น Facebook, YouTube, TikTok, Shopee และ Lazada
จุดเด่นของเพจคืออธิบายเรื่องยากให้เข้าใจง่าย มีหลักฐาน ใช้เหตุผล เป็นกันเอง และช่วยให้คนเริ่มต้นลงมือทำได้จริง
</context>

<constraints>
ตอบโดยใช้ข้อมูลใน <faq> เท่านั้น
ห้ามแต่งข้อมูลเพิ่ม
ห้ามเดาราคา
ห้ามเดาเวลา
ห้ามเดาที่ตั้ง
ห้ามเดารายละเอียดคอร์ส
ห้ามสร้างโปรโมชันเอง
ห้ามอ้างว่ามีข้อมูล ถ้าไม่มีอยู่ใน FAQ

ถ้าข้อมูลไม่มีใน FAQ หรือไม่มั่นใจ ให้ตอบว่า:
${DEFAULT_REPLY}

โทนภาษา:
สุภาพแต่เป็นกันเอง
เหมือนเลขาส่วนตัวตอบแชท
เรียกลูกค้าว่า “คุณ”
ตอบสั้น 1–3 ประโยค
ใช้คำเชื่อมประโยคให้เป็นธรรมชาติ
ลงท้ายด้วย ค่ะ หรือ นะคะ
</constraints>

<output_format>
ตอบเป็นภาษาไทยเท่านั้น
ไม่ใช้ markdown
ไม่ใช้ bullet
ไม่ใส่หัวข้อ
ไม่อธิบายระบบเบื้องหลัง
ส่งเฉพาะข้อความที่จะ reply ลูกค้าเท่านั้น
</output_format>

<faq>
${faqText}
</faq>

<question>
${userMessage}
</question>`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs),
    ),
  ]);
}

function getUsageNumber(
  usageMetadata: unknown,
  key: "thoughtsTokenCount" | "candidatesTokenCount",
): number | undefined {
  if (!usageMetadata || typeof usageMetadata !== "object") {
    return undefined;
  }

  const value = (usageMetadata as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

export async function generateReply(
  userMessage: string,
  faqText: string,
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const ai = new GoogleGenAI({ apiKey });
  const prompt = buildPrompt(userMessage, faqText);

  try {
    const response = await withTimeout(
      ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          temperature: GEMINI_TEMPERATURE,
          maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
        },
      }),
      GEMINI_TIMEOUT_MS,
    );

    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const thoughtsTokenCount = getUsageNumber(
      response.usageMetadata,
      "thoughtsTokenCount",
    );
    const candidatesTokenCount = getUsageNumber(
      response.usageMetadata,
      "candidatesTokenCount",
    );

    console.log("Gemini debug", {
      finishReason,
      thoughtsTokenCount,
      candidatesTokenCount,
    });

    if (finishReason === "MAX_TOKENS") {
      return DEFAULT_REPLY;
    }

    const text = response.text?.trim();
    return text || DEFAULT_REPLY;
  } catch (error) {
    if (error instanceof Error && error.message === "TIMEOUT") {
      return GEMINI_TIMEOUT_REPLY;
    }

    throw error;
  }
}
