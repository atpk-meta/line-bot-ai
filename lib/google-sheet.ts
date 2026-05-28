import { createSign } from "crypto";
import { writeFile } from "fs/promises";
import { join } from "path";
import { type FAQItem, type FAQWriteStats } from "@/types/faq";
import { log } from "./log";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const DEFAULT_GOOGLE_SHEET_ID = "1JMLNQPMQ7Br-Q5QkPNKwwJZf-lHq1y43sPpsaQxaVAs";
const FAQ_SHEET_NAME = "FAQ";
const FAQ_HEADERS = [
  "question",
  "answer",
  "category",
  "frequency",
  "source",
  "status",
  "updated_at",
];

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

interface ExistingFAQRow {
  rowNumber: number;
  question: string;
  frequency: number;
}

function base64Url(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function getSpreadsheetId(): string {
  return process.env.GOOGLE_SHEET_ID || DEFAULT_GOOGLE_SHEET_ID;
}

function normalizePrivateKey(privateKey: string): string {
  return privateKey.replace(/\\n/g, "\n");
}

function getServiceAccount(): ServiceAccount {
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (rawJson) {
    const parsed = JSON.parse(rawJson) as ServiceAccount;
    return {
      client_email: parsed.client_email,
      private_key: normalizePrivateKey(parsed.private_key),
    };
  }

  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!clientEmail || !privateKey) {
    throw new Error(
      "Missing GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_PRIVATE_KEY",
    );
  }

  return {
    client_email: clientEmail,
    private_key: normalizePrivateKey(privateKey),
  };
}

async function getAccessToken(): Promise<string> {
  const account = getServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(
    JSON.stringify({
      iss: account.client_email,
      scope: SHEETS_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer
    .sign(account.private_key)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });

  if (!res.ok) {
    throw new Error(`Google auth failed: ${res.status}`);
  }

  const payload = (await res.json()) as { access_token?: string };
  if (!payload.access_token) {
    throw new Error("Google auth response missing access_token");
  }

  return payload.access_token;
}

async function sheetsFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  return fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\s"'`“”‘’.,!?()[\]{}:;|/\\\-–—_]+/g, "");
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

async function ensureFAQSheet(): Promise<void> {
  const spreadsheetId = getSpreadsheetId();
  const metaRes = await sheetsFetch(`${spreadsheetId}?fields=sheets.properties`);
  if (!metaRes.ok) {
    throw new Error(`Failed to load spreadsheet metadata: ${metaRes.status}`);
  }

  const meta = (await metaRes.json()) as {
    sheets?: { properties?: { title?: string } }[];
  };
  const exists = (meta.sheets || []).some(
    (sheet) => sheet.properties?.title === FAQ_SHEET_NAME,
  );

  if (!exists) {
    const addRes = await sheetsFetch(`${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: FAQ_SHEET_NAME } } }],
      }),
    });
    if (!addRes.ok) {
      throw new Error(`Failed to create FAQ sheet: ${addRes.status}`);
    }
  }

  const values = await getFAQSheetValues();
  if (!values.length) {
    await appendFAQRowsRaw([FAQ_HEADERS]);
  }
}

async function getFAQSheetValues(): Promise<string[][]> {
  const spreadsheetId = getSpreadsheetId();
  const range = encodeURIComponent(`${FAQ_SHEET_NAME}!A:G`);
  const res = await sheetsFetch(`${spreadsheetId}/values/${range}`);
  if (res.status === 400) {
    return [];
  }
  if (!res.ok) {
    throw new Error(`Failed to read FAQ sheet: ${res.status}`);
  }

  const payload = (await res.json()) as { values?: string[][] };
  return payload.values || [];
}

async function appendFAQRowsRaw(values: (string | number)[][]): Promise<void> {
  const spreadsheetId = getSpreadsheetId();
  const range = encodeURIComponent(`${FAQ_SHEET_NAME}!A:G`);
  const res = await sheetsFetch(
    `${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`,
    {
      method: "POST",
      body: JSON.stringify({ values }),
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to append FAQ rows: ${res.status}`);
  }
}

async function updateFAQFrequency(
  rowNumber: number,
  frequency: number,
  updatedAt: string,
): Promise<void> {
  const spreadsheetId = getSpreadsheetId();
  const range = encodeURIComponent(`${FAQ_SHEET_NAME}!D${rowNumber}:G${rowNumber}`);
  const res = await sheetsFetch(
    `${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      body: JSON.stringify({
        values: [[frequency, "facebook", "pending", updatedAt]],
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to update FAQ frequency: ${res.status}`);
  }
}

function parseExistingRows(values: string[][]): ExistingFAQRow[] {
  return values.slice(1).map((row, index) => ({
    rowNumber: index + 2,
    question: row[0] || "",
    frequency: Number(row[3] || 0),
  }));
}

function findDuplicate(
  item: FAQItem,
  existingRows: ExistingFAQRow[],
): ExistingFAQRow | null {
  const normalized = normalizeQuestion(item.question);
  for (const row of existingRows) {
    const existing = normalizeQuestion(row.question);
    if (existing === normalized || getSimilarity(existing, normalized) > 0.85) {
      return row;
    }
  }

  return null;
}

export async function appendFAQDraftsToSheet(items: FAQItem[]): Promise<FAQWriteStats> {
  await ensureFAQSheet();
  const values = await getFAQSheetValues();
  const existingRows = parseExistingRows(values);
  const rowsToAppend: (string | number)[][] = [];
  let updated = 0;

  for (const item of items) {
    const duplicate = findDuplicate(item, existingRows);
    if (duplicate) {
      const frequency = duplicate.frequency + item.frequency;
      await updateFAQFrequency(duplicate.rowNumber, frequency, item.updated_at);
      duplicate.frequency = frequency;
      updated += 1;
      continue;
    }

    rowsToAppend.push([
      item.question,
      item.answer,
      item.category,
      item.frequency,
      item.source,
      item.status,
      item.updated_at,
    ]);
    existingRows.push({
      rowNumber: existingRows.length + 2,
      question: item.question,
      frequency: item.frequency,
    });
  }

  if (rowsToAppend.length) {
    await appendFAQRowsRaw(rowsToAppend);
  }

  log.info("google_sheet.faq_rows_written", {
    rowsCreated: rowsToAppend.length,
    rowsUpdated: updated,
  });

  return {
    created: rowsToAppend.length,
    updated,
  };
}

export async function saveFAQBackup(items: FAQItem[], reason: string): Promise<string> {
  const filePath = join("/tmp", `facebook-faq-backup-${Date.now()}.json`);
  await writeFile(
    filePath,
    JSON.stringify({ reason, items, saved_at: new Date().toISOString() }, null, 2),
    "utf8",
  );
  log.error("google_sheet.backup_saved", {
    path: filePath,
    items: items.length,
    reason,
  });
  return filePath;
}
