/**
 * Conversation state.
 *
 * Only two things need memory:
 *   • a pending write that is waiting for the user's "بله/خیر"
 *   • the previous turn, so follow-ups ("همین رو کن ۲ میلیون") make sense
 *
 * NOTE: this is process memory, on purpose — no database to set up. Vercel may
 * route the confirm-click to another instance, so if you deploy with many
 * concurrent users, back this with Upstash Redis or Vercel KV. The interface is
 * already async so swapping the store is a one-file change.
 */

import type { Plan } from "./plan";

export type PendingConfirmation = {
  token: string;
  sessionId: string;
  plan: Plan;
  createdAt: number;
  /** the sentence that produced it, echoed back in the confirmation card */
  userMessage: string;
  summaryFa: string;
};

export type Turn = {
  userMessage: string;
  actionId: string | null;
  summary: string;
  at: number;
};

const PENDING_TTL_MS = 10 * 60 * 1000;
const TURN_TTL_MS = 30 * 60 * 1000;

const pending = new Map<string, PendingConfirmation>();
const turns = new Map<string, Turn[]>();

function sweep(): void {
  const now = Date.now();
  for (const [token, entry] of pending) {
    if (now - entry.createdAt > PENDING_TTL_MS) pending.delete(token);
  }
  for (const [sessionId, list] of turns) {
    const fresh = list.filter((turn) => now - turn.at < TURN_TTL_MS);
    if (fresh.length === 0) turns.delete(sessionId);
    else turns.set(sessionId, fresh);
  }
}

export async function savePending(entry: Omit<PendingConfirmation, "createdAt">): Promise<PendingConfirmation> {
  sweep();
  const record: PendingConfirmation = { ...entry, createdAt: Date.now() };
  pending.set(record.token, record);
  return record;
}

export async function takePending(token: string, sessionId: string): Promise<PendingConfirmation | null> {
  sweep();
  const record = pending.get(token);
  if (!record) return null;
  if (record.sessionId !== sessionId) return null;
  pending.delete(token);
  return record;
}

export async function rememberTurn(sessionId: string, turn: Omit<Turn, "at">): Promise<void> {
  sweep();
  const list = turns.get(sessionId) ?? [];
  list.push({ ...turn, at: Date.now() });
  turns.set(sessionId, list.slice(-5));
}

export async function previousTurn(sessionId: string): Promise<Turn | null> {
  const list = turns.get(sessionId);
  return list && list.length > 0 ? (list[list.length - 1] as Turn) : null;
}

export function resetSessionsForTesting(): void {
  pending.clear();
  turns.clear();
}
