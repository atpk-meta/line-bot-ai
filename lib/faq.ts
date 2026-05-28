import { DEFAULT_REPLY } from "./constants";

interface FAQRow {
  question: string;
  answer: string;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function normalizeThaiText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s"'`“”‘’.,!?()[\]{}:;|/\\\-–—_]+/g, "")
    .replace(/ครับ|ค่ะ|คะ|นะ|จ้า|จ๊ะ|หน่อย|รบกวน/g, "");
}

function parseFAQRows(csvText: string): FAQRow[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  const header = parseCsvLine(lines[0]).map((cell) => cell.toLowerCase());
  const questionIndex = header.indexOf("question");
  const answerIndex = header.indexOf("answer");

  if (questionIndex === -1 || answerIndex === -1) {
    return [];
  }

  return lines
    .slice(1)
    .map((line) => parseCsvLine(line))
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
      (normalizedMessage.includes(normalizedQuestion) ||
        normalizedQuestion.includes(normalizedMessage))
    ) {
      return row.answer;
    }
  }

  return null;
}
