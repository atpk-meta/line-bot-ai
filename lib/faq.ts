import { DEFAULT_REPLY } from "./constants";

interface FAQRow {
  question: string;
  answer: string;
  status?: string;
}

function parseCsv(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index];
    const next = csvText[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell.trim());
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }

      row.push(cell.trim());
      if (row.some(Boolean)) {
        rows.push(row);
      }
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell.trim());
  if (row.some(Boolean)) {
    rows.push(row);
  }

  return rows;
}

function normalizeThaiText(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .replace(/ไหร่/g, "ไร")
    .replace(/เท่าไหร/g, "เท่าไร")
    .replace(/มั้ย/g, "ไหม")
    .replace(/ม๊ะ/g, "ไหม")
    .replace(/[\s"'`“”‘’.,!?()[\]{}:;|/\\\-–—_]+/g, "")
    .replace(/ครับ|ค่ะ|คะ|นะ|จ้า|จ๊ะ|หน่อย|รบกวน/g, "");
}

function findHeaderIndex(header: string[], names: string[]): number {
  const normalizedNames = names.map(normalizeThaiText);
  return header.findIndex((cell) =>
    normalizedNames.includes(normalizeThaiText(cell)),
  );
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

function parseFAQRows(csvText: string): FAQRow[] {
  const rows = parseCsv(csvText);
  if (!rows.length) {
    return [];
  }

  const header = rows[0];
  let questionIndex = findHeaderIndex(header, ["question", "คำถาม", "q"]);
  let answerIndex = findHeaderIndex(header, ["answer", "คำตอบ", "a"]);
  let statusIndex = findHeaderIndex(header, ["status", "สถานะ"]);
  let dataRows = rows.slice(1);

  if (questionIndex === -1 || answerIndex === -1) {
    questionIndex = 0;
    answerIndex = 1;
    statusIndex = -1;
    dataRows = rows;

    const firstQuestion = normalizeThaiText(rows[0]?.[0] || "");
    const firstAnswer = normalizeThaiText(rows[0]?.[1] || "");
    const looksLikeHeader =
      ["question", "คำถาม", "q"].includes(firstQuestion) ||
      ["answer", "คำตอบ", "a"].includes(firstAnswer);

    if (looksLikeHeader) {
      dataRows = rows.slice(1);
    }
  }

  return dataRows
    .map((cells) => ({
      question: cells[questionIndex] || "",
      answer: cells[answerIndex] || "",
      status: statusIndex === -1 ? undefined : cells[statusIndex] || "",
    }))
    .filter((row) => row.question && row.answer)
    .filter((row) => !row.status || normalizeThaiText(row.status) === "approved");
}

export function findDirectFAQAnswer(
  userMessage: string,
  csvText: string,
): string | null {
  const rows = parseFAQRows(csvText);
  const normalizedMessage = normalizeThaiText(userMessage);

  if (!normalizedMessage) {
    return DEFAULT_REPLY;
  }

  for (const row of rows) {
    const normalizedQuestion = normalizeThaiText(row.question);
    if (
      normalizedQuestion &&
      (normalizedMessage === normalizedQuestion ||
        normalizedMessage.includes(normalizedQuestion) ||
        normalizedQuestion.includes(normalizedMessage) ||
        getSimilarity(normalizedMessage, normalizedQuestion) >= 0.85)
    ) {
      return row.answer;
    }
  }

  return null;
}

function findAnswerByKeywords(rows: FAQRow[], keywords: string[]): string | null {
  const normalizedKeywords = keywords.map(normalizeThaiText);

  for (const row of rows) {
    const haystack = normalizeThaiText(`${row.question} ${row.answer}`);
    if (normalizedKeywords.some((keyword) => keyword && haystack.includes(keyword))) {
      return row.answer;
    }
  }

  return null;
}

function findKnowledgeSentence(knowledgeText: string, keywords: string[]): string | null {
  if (!knowledgeText.trim()) {
    return null;
  }

  const normalizedKeywords = keywords.map(normalizeThaiText);
  const sentences = knowledgeText
    .split(/\n|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    const normalizedSentence = normalizeThaiText(sentence);
    if (
      normalizedKeywords.some((keyword) =>
        keyword ? normalizedSentence.includes(keyword) : false,
      )
    ) {
      return sentence.slice(0, 250);
    }
  }

  return null;
}

export function findShortcutAnswer(
  userMessage: string,
  csvText: string,
  knowledgeText = "",
): string | null {
  const rows = parseFAQRows(csvText);
  const normalizedMessage = normalizeThaiText(userMessage);

  if (!normalizedMessage) {
    return null;
  }

  const shortcuts: { triggers: string[]; keywords: string[]; fallback?: string }[] = [
    {
      triggers: ["สอบถาม", "สนใจเรียน"],
      keywords: ["คอร์ส", "เรียน", "TikTok", "Shopee", "AI"],
      fallback:
        "คุณสนใจสอบถามเรื่องคอร์สเรียน การทำ TikTok หรือการสร้างรายได้ออนไลน์ด้านไหนดีคะ",
    },
    {
      triggers: ["คอร์สเรียน", "มีสอนอะไรบ้าง", "สอนอะไร", "เรียนอะไร"],
      keywords: ["คอร์ส", "สอน", "เนื้อหา", "เรียน"],
      fallback:
        "ตอนนี้มีคอร์สเกี่ยวกับ TikTok, Shopee, Lazada, Affiliate, AI และการทำ Content Creator ค่ะ",
    },
    {
      triggers: ["ราคา", "ราคาเท่าไร", "ราคาเท่าไหร่", "ค่าเรียน", "เท่าไร", "เท่าไหร่"],
      keywords: ["ราคา", "บาท", "ค่าเรียน"],
    },
    {
      triggers: ["tiktok", "ติ๊กต็อก"],
      keywords: ["TikTok", "ติ๊กต็อก"],
    },
    {
      triggers: ["shopee", "ช้อปปี้"],
      keywords: ["Shopee", "ช้อปปี้"],
    },
    {
      triggers: ["ai"],
      keywords: ["AI", "ChatGPT", "Gemini"],
    },
  ];

  for (const shortcut of shortcuts) {
    const matchedTrigger = shortcut.triggers.some((trigger) =>
      normalizedMessage.includes(normalizeThaiText(trigger)),
    );

    if (!matchedTrigger) {
      continue;
    }

    const faqAnswer = findAnswerByKeywords(rows, shortcut.keywords);
    if (faqAnswer) {
      return faqAnswer;
    }

    const knowledgeAnswer = findKnowledgeSentence(knowledgeText, shortcut.keywords);
    if (knowledgeAnswer) {
      return knowledgeAnswer;
    }

    if (shortcut.fallback) {
      return shortcut.fallback;
    }
  }

  return null;
}
