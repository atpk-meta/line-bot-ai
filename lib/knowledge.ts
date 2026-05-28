import {
  KNOWLEDGE_CACHE_TTL_MS,
  KNOWLEDGE_FETCH_TIMEOUT_MS,
  KNOWLEDGE_MAX_CHARS,
} from "./constants";
import { log } from "./log";

let cachedKnowledge = "";
let cachedAt = 0;
let refreshPromise: Promise<string> | null = null;

function getFallbackKnowledge(): string {
  const fallback = process.env.KNOWLEDGE_TEXT || "";
  if (containsInternalUrl(fallback)) {
    log.warn("knowledge.env_fallback_blocked_internal_url");
    return "";
  }

  return fallback.slice(0, KNOWLEDGE_MAX_CHARS);
}

function containsInternalUrl(value: string): boolean {
  return /docs\.google\.com|spreadsheets|document\/d\/|pubhtml|https?:\/\//i.test(
    value,
  );
}

function toExportTextUrl(url: string): string {
  const match = url.match(/docs\.google\.com\/document\/d\/([^/]+)/);
  if (match?.[1]) {
    return `https://docs.google.com/document/d/${match[1]}/export?format=txt`;
  }

  return url;
}

function getSource(value: string): "url" | "env" | "empty" {
  if (process.env.KNOWLEDGE_DOC_URL) {
    return "url";
  }

  if (value) {
    return "env";
  }

  return "empty";
}

function logKnowledgeDebug(source: "url" | "env" | "empty", value: string) {
  log.info("knowledge.loaded", {
    source,
    length: value.length,
    preview: value.slice(0, 300),
  });
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KNOWLEDGE_FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchKnowledgeText(): Promise<string> {
  const docUrl = process.env.KNOWLEDGE_DOC_URL;
  if (!docUrl) {
    const fallback = getFallbackKnowledge();
    logKnowledgeDebug(getSource(fallback), fallback);
    return fallback;
  }

  const start = Date.now();
  try {
    const res = await fetchWithTimeout(toExportTextUrl(docUrl));
    if (!res.ok) {
      throw new Error(`Failed to fetch knowledge doc: ${res.status}`);
    }

    const text = (await res.text()).trim().slice(0, KNOWLEDGE_MAX_CHARS);
    if (containsInternalUrl(text)) {
      throw new Error("Knowledge doc returned internal URL-like content");
    }

    cachedKnowledge = text;
    cachedAt = Date.now();
    log.info("knowledge.fetched", {
      cacheHit: false,
      length: cachedKnowledge.length,
      durationMs: Date.now() - start,
    });
    return cachedKnowledge;
  } catch (error) {
    log.warn("knowledge.fetch_failed", {
      err: error instanceof Error ? error.message : "unknown",
      durationMs: Date.now() - start,
      timeoutMs: KNOWLEDGE_FETCH_TIMEOUT_MS,
      hasCache: Boolean(cachedKnowledge),
    });
    return "";
  }
}

function refreshKnowledgeInBackground(): void {
  if (refreshPromise) {
    return;
  }

  refreshPromise = fetchKnowledgeText()
    .catch((error) => {
      log.warn("knowledge.background_refresh_failed", {
        err: error instanceof Error ? error.message : "unknown",
      });
      return "";
    })
    .finally(() => {
      refreshPromise = null;
    });
}

export async function getKnowledgeText(): Promise<string> {
  const now = Date.now();
  const start = Date.now();

  if (cachedKnowledge) {
    const isFresh = now - cachedAt < KNOWLEDGE_CACHE_TTL_MS;
    log.info("knowledge.cache_returned", {
      cacheHit: true,
      fresh: isFresh,
      length: cachedKnowledge.length,
      durationMs: Date.now() - start,
    });
    if (!isFresh) {
      refreshKnowledgeInBackground();
    }
    return cachedKnowledge;
  }

  const fetched = await fetchKnowledgeText();
  log.info("knowledge.initial_returned", {
    cacheHit: false,
    length: fetched.length,
    durationMs: Date.now() - start,
  });
  return fetched;
}
