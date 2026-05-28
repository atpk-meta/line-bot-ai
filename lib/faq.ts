import { DEFAULT_REPLY } from "./constants";

interface FAQRow {
  question: string;
  answer: string;
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
    .replace(/[\s"'`“”‘’.,!?()[\]{}:;|/\\\-–—_]+/g, "")
    .replace(/ครับ|ค่ะ|คะ|นะ|จ้า|จ๊ะ|หน่อย|รบกวน/g, "");
}

function findHeaderIndex(header: string[], names: string[]): number {
  const normalizedNames = names.map(normalizeThaiText);
  return header.findIndex((cell) =>
    normalizedNames.includes(normalizeThaiText(cell)),
  );
}

function parseFAQRows(csvText: string): FAQRow[] {
  const rows = parseCsv(csvText);
  if (!rows.length) {
    return [];
  }

  const header = rows[0];
  let questionIndex = findHeaderIndex(header, ["question", "คำถาม", "q"]);
  let answerIndex = findHeaderIndex(header, ["answer", "คำตอบ", "a"]);
  let dataRows = rows.slice(1);

  if (questionIndex === -1 || answerIndex === -1) {
    questionIndex = 0;
    answerIndex = 1;
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
    }))
    .filter((row) => row.question && row.answer);
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
        normalizedQuestion.includes(normalizedMessage))
    ) {
      return row.answer;
    }
  }

  return null;
}
