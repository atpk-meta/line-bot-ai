import { SHEET_CACHE_TTL_MS, SHEET_FETCH_TIMEOUT_MS } from "./constants";
import { log } from "./log";

let cachedFAQ = "";
let cachedAt = 0;
let refreshPromise: Promise<string> | null = null;

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

async function fetchFAQText(): Promise<string> {
  const csvUrl = process.env.SHEET_CSV_URL;
  if (!csvUrl) {
    log.error("sheet.env_missing");
    return "";
  }

  const now = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHEET_FETCH_TIMEOUT_MS);
  const start = Date.now();

  try {
    const res = await fetch(toCsvFetchUrl(csvUrl), {
      cache: "no-store",
      signal: controller.signal,
    });

    if (!res.ok) {
      log.error("sheet.fetch_bad_status", { status: res.status });
      return "";
    }

    const csvText = stripUrlsFromSourceText(await res.text());
    if (!csvText.trim()) {
      log.error("sheet.empty");
      return "";
    }

    cachedFAQ = csvText;
    cachedAt = now;

    log.info("sheet.fetched", {
      cacheHit: false,
      length: csvText.length,
      durationMs: Date.now() - start,
      ttlMs: SHEET_CACHE_TTL_MS,
    });

    return cachedFAQ;
  } catch (error) {
    log.warn("sheet.fetch_failed", {
      err: error instanceof Error ? error.message : "unknown",
      durationMs: Date.now() - start,
      timeoutMs: SHEET_FETCH_TIMEOUT_MS,
      hasCache: Boolean(cachedFAQ),
    });
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function refreshFAQInBackground(): void {
  if (refreshPromise) {
    return;
  }

  refreshPromise = fetchFAQText()
    .catch((error) => {
      log.warn("sheet.background_refresh_failed", {
        err: error instanceof Error ? error.message : "unknown",
      });
      return "";
    })
    .finally(() => {
      refreshPromise = null;
    });
}

export async function getFAQText(): Promise<string> {
  const now = Date.now();
  const start = Date.now();

  if (cachedFAQ) {
    const isFresh = now - cachedAt < SHEET_CACHE_TTL_MS;
    log.info("sheet.cache_returned", {
      cacheHit: true,
      fresh: isFresh,
      length: cachedFAQ.length,
      durationMs: Date.now() - start,
    });
    if (!isFresh) {
      refreshFAQInBackground();
    }
    return cachedFAQ;
  }

  const fetched = await fetchFAQText();
  log.info("sheet.initial_returned", {
    cacheHit: false,
    length: fetched.length,
    durationMs: Date.now() - start,
  });
  return fetched;
}
