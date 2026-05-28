import { SHEET_CACHE_TTL_MS, SHEET_FETCH_TIMEOUT_MS } from "./constants";
import { log } from "./log";

let cachedFAQ = "";
let cachedAt = 0;

function toCsvFetchUrl(url: string): string {
  const spreadsheetMatch = url.match(/docs\.google\.com\/spreadsheets\/d\/([^/]+)/);
  if (!spreadsheetMatch?.[1]) {
    return url;
  }

  const gidMatch = url.match(/[?&#]gid=(\d+)/);
  const sheetId = spreadsheetMatch[1];
  const gid = gidMatch?.[1] || "0";

  if (url.includes("/pubhtml")) {
    return `https://docs.google.com/spreadsheets/d/${sheetId}/pub?gid=${gid}&single=true&output=csv`;
  }

  if (url.includes("/edit")) {
    return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`;
  }

  return url;
}

function stripUrlsFromSourceText(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"',)]+/gi, "")
    .replace(/docs\.google\.com[^\s"',)]*/gi, "")
    .replace(/pageUrl\s*[:=]\s*[^\s"',)]*/gi, "");
}

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
      res = await fetch(toCsvFetchUrl(csvUrl), {
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

    const csvText = stripUrlsFromSourceText(await res.text());

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
