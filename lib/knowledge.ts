import {
  KNOWLEDGE_CACHE_TTL_MS,
  KNOWLEDGE_FETCH_TIMEOUT_MS,
  KNOWLEDGE_MAX_CHARS,
} from "./constants";
import { log } from "./log";

let cachedKnowledge = "";
let cachedAt = 0;

function getFallbackKnowledge(): string {
  return (process.env.KNOWLEDGE_TEXT || "").slice(0, KNOWLEDGE_MAX_CHARS);
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

export async function getKnowledgeText(): Promise<string> {
  const now = Date.now();
  if (cachedKnowledge && now - cachedAt < KNOWLEDGE_CACHE_TTL_MS) {
    logKnowledgeDebug("url", cachedKnowledge);
    return cachedKnowledge;
  }

  const docUrl = process.env.KNOWLEDGE_DOC_URL;
  if (!docUrl) {
    const fallback = getFallbackKnowledge();
    logKnowledgeDebug(getSource(fallback), fallback);
    return fallback;
  }

  try {
    const res = await fetchWithTimeout(toExportTextUrl(docUrl));
    if (!res.ok) {
      throw new Error(`Failed to fetch knowledge doc: ${res.status}`);
    }

    const text = (await res.text()).trim().slice(0, KNOWLEDGE_MAX_CHARS);
    cachedKnowledge = text;
    cachedAt = now;
    logKnowledgeDebug("url", cachedKnowledge);
    return cachedKnowledge;
  } catch (error) {
    console.error("Knowledge fetch failed, using env fallback", error);
    const fallback = getFallbackKnowledge();
    logKnowledgeDebug(getSource(fallback), fallback);
    return fallback;
  }
}
