/**
 * Conversation memory — the only state a chat bot needs.
 *
 * A rolling window of the last N messages per session, with a TTL so an
 * abandoned chat does not sit in memory forever. It is process memory on
 * purpose: no database to provision, and Vercel keeps a warm function's memory
 * between requests. If you deploy for many concurrent users, back this with
 * Upstash Redis or Vercel KV — the interface is already small enough to swap.
 */

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
  at: number;
};

const sessions = new Map<string, ChatMessage[]>();

function sweep(now: number, ttlMs: number): void {
  for (const [sessionId, messages] of sessions) {
    const fresh = messages.filter((message) => now - message.at < ttlMs);
    if (fresh.length === 0) sessions.delete(sessionId);
    else if (fresh.length !== messages.length) sessions.set(sessionId, fresh);
  }
}

/** Appends a message and trims the window to `maxMessages` (always even pairs). */
export function pushMessage(sessionId: string, role: ChatRole, content: string, maxMessages: number): void {
  const now = Date.now();
  const messages = sessions.get(sessionId) ?? [];
  messages.push({ role, content, at: now });

  // Keep whole turns: never start the window on an assistant message.
  const trimmed = messages.slice(-maxMessages);
  if (trimmed[0]?.role === "assistant") trimmed.shift();

  sessions.set(sessionId, trimmed);
}

/** The stored window, oldest first. Never mutated by callers. */
export function getMessages(sessionId: string, ttlMs: number): ChatMessage[] {
  const now = Date.now();
  sweep(now, ttlMs);
  const messages = sessions.get(sessionId) ?? [];
  return messages.filter((message) => now - message.at < ttlMs);
}

export function countMessages(sessionId: string, ttlMs: number): number {
  return getMessages(sessionId, ttlMs).length;
}

export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/** Drops conversations that went quiet — call it on a timer or on boot. */
export function sweepSessions(ttlMs: number): void {
  sweep(Date.now(), ttlMs);
}

export function sessionCount(): number {
  return sessions.size;
}

export function resetSessionsForTesting(): void {
  sessions.clear();
}
