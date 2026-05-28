import { SHEET_CACHE_TTL_MS, SHEET_FETCH_TIMEOUT_MS } from "./constants";

let cachedFAQ = "";
let cachedAt = 0;

export async function getFAQText(): Promise<string> {
  const now = Date.now();

  if (cachedFAQ && now - cachedAt < SHEET_CACHE_TTL_MS) {
    return cachedFAQ;
  }

  const csvUrl = process.env.SHEET_CSV_URL;
  if (!csvUrl) {
    throw new Error("Missing SHEET_CSV_URL");
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SHEET_FETCH_TIMEOUT_MS);
    let res: Response;

    try {
      res = await fetch(csvUrl, {
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      throw new Error(`Failed to fetch sheet: ${res.status}`);
    }

    const csvText = await res.text();

    if (!csvText.trim()) {
      throw new Error("FAQ sheet is empty");
    }

    cachedFAQ = csvText;
    cachedAt = now;

    return cachedFAQ;
  } catch (error) {
    if (cachedFAQ) {
      console.error("Sheet fetch failed, using stale cache", error);
      return cachedFAQ;
    }

    throw error;
  }
}
