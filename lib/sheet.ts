import { SHEET_CACHE_TTL_MS, SHEET_FETCH_TIMEOUT_MS } from "./constants";
import { log } from "./log";

let cachedFAQ = "";
let cachedAt = 0;

export async function getFAQText(): Promise<string> {
  const now = Date.now();

  if (cachedFAQ && now - cachedAt < SHEET_CACHE_TTL_MS) {
    return cachedFAQ;
  }

  const csvUrl = process.env.SHEET_CSV_URL;
  if (!csvUrl) {
    log.error("sheet.env_missing");
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
      log.error("sheet.fetch_bad_status", { status: res.status });
      throw new Error(`Failed to fetch sheet: ${res.status}`);
    }

    const csvText = await res.text();

    if (!csvText.trim()) {
      log.error("sheet.empty");
      throw new Error("FAQ sheet is empty");
    }

    cachedFAQ = csvText;
    cachedAt = now;

    log.info("sheet.fetched", {
      bytes: csvText.length,
      ttlMs: SHEET_CACHE_TTL_MS,
    });

    return cachedFAQ;
  } catch (error) {
    if (cachedFAQ) {
      log.warn("sheet.fetch_failed_using_stale_cache", {
        err: error instanceof Error ? error.message : "unknown",
      });
      return cachedFAQ;
    }

    log.error("sheet.fetch_failed_no_cache", {
      err: error instanceof Error ? error.message : "unknown",
      timeoutMs: SHEET_FETCH_TIMEOUT_MS,
    });
    throw error;
  }
}
