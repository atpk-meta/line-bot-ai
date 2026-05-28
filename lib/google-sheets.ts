import { createSign } from "crypto";
import { FAQ_DRAFT_SHEET_NAME } from "./constants";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

function base64Url(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function getSpreadsheetId(): string {
  const explicitId = process.env.GOOGLE_SHEET_ID;
  if (explicitId) {
    return explicitId;
  }

  const csvUrl = process.env.SHEET_CSV_URL || "";
  const match = csvUrl.match(/spreadsheets\/d\/([^/]+)/);
  if (match?.[1]) {
    return match[1];
  }

  throw new Error("Missing GOOGLE_SHEET_ID and could not parse SHEET_CSV_URL");
}

function getServiceAccount(): ServiceAccount {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON");
  }

  return JSON.parse(raw) as ServiceAccount;
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

export interface DraftFAQRow {
  question: string;
  answer: string;
  category: string;
  source: string;
  status: string;
  confidence: number;
  example_user_question: string;
  raw_human_reply: string;
  updated_at: string;
}

const DRAFT_HEADERS = [
  "question",
  "answer",
  "category",
  "source",
  "status",
  "confidence",
  "example_user_question",
  "raw_human_reply",
  "updated_at",
  "frequency",
  "last_seen",
];

export async function ensureFAQDraftSheet(): Promise<void> {
  const spreadsheetId = getSpreadsheetId();
  const metaRes = await sheetsFetch(`${spreadsheetId}?fields=sheets.properties`);
  if (!metaRes.ok) {
    throw new Error(`Failed to load spreadsheet metadata: ${metaRes.status}`);
  }

  const meta = (await metaRes.json()) as {
    sheets?: { properties?: { title?: string } }[];
  };
  const exists = (meta.sheets || []).some(
    (sheet) => sheet.properties?.title === FAQ_DRAFT_SHEET_NAME,
  );

  if (!exists) {
    const addRes = await sheetsFetch(`${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: FAQ_DRAFT_SHEET_NAME } } }],
      }),
    });
    if (!addRes.ok) {
      throw new Error(`Failed to create FAQ_DRAFT sheet: ${addRes.status}`);
    }
  }

  const values = await getFAQDraftValues();
  if (!values.length) {
    await appendFAQDraftValues([DRAFT_HEADERS]);
  }
}

export async function getFAQDraftValues(): Promise<string[][]> {
  const spreadsheetId = getSpreadsheetId();
  const range = encodeURIComponent(`${FAQ_DRAFT_SHEET_NAME}!A:K`);
  const res = await sheetsFetch(`${spreadsheetId}/values/${range}`);
  if (res.status === 400) {
    return [];
  }
  if (!res.ok) {
    throw new Error(`Failed to read FAQ_DRAFT: ${res.status}`);
  }

  const payload = (await res.json()) as { values?: string[][] };
  return payload.values || [];
}

async function appendFAQDraftValues(values: (string | number)[][]) {
  const spreadsheetId = getSpreadsheetId();
  const range = encodeURIComponent(`${FAQ_DRAFT_SHEET_NAME}!A:K`);
  const res = await sheetsFetch(
    `${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`,
    {
      method: "POST",
      body: JSON.stringify({ values }),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to append FAQ_DRAFT: ${res.status}`);
  }
}

export async function appendFAQDraft(row: DraftFAQRow): Promise<void> {
  await appendFAQDraftValues([
    [
      row.question,
      row.answer,
      row.category,
      row.source,
      row.status,
      row.confidence,
      row.example_user_question,
      row.raw_human_reply,
      row.updated_at,
      1,
      row.updated_at,
    ],
  ]);
}

export async function updateFAQDraftSeen(
  rowNumber: number,
  frequency: number,
  lastSeen: string,
): Promise<void> {
  const spreadsheetId = getSpreadsheetId();
  const range = encodeURIComponent(`${FAQ_DRAFT_SHEET_NAME}!J${rowNumber}:K${rowNumber}`);
  const res = await sheetsFetch(
    `${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      body: JSON.stringify({ values: [[frequency, lastSeen]] }),
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to update FAQ_DRAFT duplicate: ${res.status}`);
  }
}
