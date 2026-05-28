interface ConversationTurn {
  customer: string;
  assistant: string;
  at: number;
}

const MAX_TURNS_PER_USER = 6;
const MEMORY_TTL_MS = 24 * 60 * 60 * 1000;

const conversations = new Map<string, ConversationTurn[]>();

function getMemoryKey(userId?: string): string | null {
  return userId?.trim() || null;
}

function pruneTurns(turns: ConversationTurn[], now: number): ConversationTurn[] {
  return turns
    .filter((turn) => now - turn.at <= MEMORY_TTL_MS)
    .slice(-MAX_TURNS_PER_USER);
}

export function getConversationHistory(userId?: string): string {
  const key = getMemoryKey(userId);
  if (!key) {
    return "";
  }

  const now = Date.now();
  const turns = pruneTurns(conversations.get(key) || [], now);
  if (!turns.length) {
    conversations.delete(key);
    return "";
  }

  conversations.set(key, turns);
  return turns
    .map(
      (turn) =>
        `customer: ${turn.customer}\nassistant: ${turn.assistant}`,
    )
    .join("\n\n");
}

export function rememberConversationTurn(
  userId: string | undefined,
  customer: string,
  assistant: string,
): void {
  const key = getMemoryKey(userId);
  if (!key) {
    return;
  }

  const now = Date.now();
  const turns = pruneTurns(conversations.get(key) || [], now);
  turns.push({ customer, assistant, at: now });
  conversations.set(key, turns.slice(-MAX_TURNS_PER_USER));
}
