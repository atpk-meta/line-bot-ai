import { SAFE_SYSTEM_BUSY_REPLY } from "./constants";
import { log } from "./log";

const FORBIDDEN_REPLY_PATTERNS = [
  "docs.google.com",
  "spreadsheets",
  "document/d/",
  "pubhtml",
  "pageUrl",
  "KNOWLEDGE_DOC_URL",
  "SHEET_CSV_URL",
  "http://",
  "https://",
];

export function sanitizeBotReply(text: string): string {
  const reply = (text || "").trim();
  if (!reply) {
    return SAFE_SYSTEM_BUSY_REPLY;
  }

  const lowerReply = reply.toLowerCase();
  const matchedPattern = FORBIDDEN_REPLY_PATTERNS.find((pattern) =>
    lowerReply.includes(pattern.toLowerCase()),
  );

  if (matchedPattern) {
    log.warn("reply.sanitized_forbidden_output", {
      matchedPattern,
      replyLength: reply.length,
    });
    return SAFE_SYSTEM_BUSY_REPLY;
  }

  const looksLikeJson =
    (reply.startsWith("{") && reply.endsWith("}")) ||
    (reply.startsWith("[") && reply.endsWith("]"));

  if (looksLikeJson) {
    log.warn("reply.sanitized_json_output", {
      replyLength: reply.length,
    });
    return SAFE_SYSTEM_BUSY_REPLY;
  }

  return reply;
}
