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
import { normalize, toLatinDigits } from "@/lib/text";

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

export type StoredItem = {
  index: number;
  id: string;
  name: string;
  featureId: string;
};

export type SessionState = {
  turns: Turn[];
  items: StoredItem[];
  lastActionId?: string | null;
  lastPage?: number;
};

const PENDING_TTL_MS = 10 * 60 * 1000;
const TURN_TTL_MS = 30 * 60 * 1000;

const pending = new Map<string, PendingConfirmation>();
const sessionStates = new Map<string, SessionState>();

function sweep(): void {
  const now = Date.now();
  for (const [token, entry] of pending) {
    if (now - entry.createdAt > PENDING_TTL_MS) pending.delete(token);
  }
  for (const [sessionId, state] of sessionStates) {
    const fresh = state.turns.filter((turn) => now - turn.at < TURN_TTL_MS);
    if (fresh.length === 0 && state.items.length === 0) {
      sessionStates.delete(sessionId);
    } else {
      state.turns = fresh;
    }
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

function getOrCreateState(sessionId: string): SessionState {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = { turns: [], items: [] };
    sessionStates.set(sessionId, state);
  }
  return state;
}

export async function rememberTurn(sessionId: string, turn: Omit<Turn, "at">): Promise<void> {
  sweep();
  const state = getOrCreateState(sessionId);
  state.turns.push({ ...turn, at: Date.now() });
  state.turns = state.turns.slice(-5);
}

export async function previousTurn(sessionId: string): Promise<Turn | null> {
  const state = sessionStates.get(sessionId);
  if (!state || state.turns.length === 0) return null;
  return state.turns[state.turns.length - 1] as Turn;
}

/** Saves the items displayed to the user so they can reference them by name or number (e.g. "قیمت دی می" or "مورد ۱"). */
export function saveSessionItems(
  sessionId: string,
  featureId: string,
  items: unknown[],
  page = 1,
  perPage = 10,
): void {
  const state = getOrCreateState(sessionId);
  const stored: StoredItem[] = [];
  const baseIndex = (Math.max(1, page) - 1) * perPage;

  items.slice(0, 50).forEach((item, idx) => {
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    if (!id) return;
    const translations = record.translations as { fa?: { title?: string; name?: string } } | undefined;
    const name = String(
      record.fullName ??
      translations?.fa?.title ??
      translations?.fa?.name ??
      record.title ??
      record.name ??
      record.key ??
      "",
    ).trim();
    stored.push({ index: baseIndex + idx + 1, id, name, featureId });
  });

  state.items = stored;
  state.lastActionId = `${featureId}.list`;
  state.lastPage = page;
}

/** Matches an item from the user's recent list by ordinal, number, or title/name. */
export function findSessionItem(sessionId: string, text: string): StoredItem | undefined {
  const state = sessionStates.get(sessionId);
  if (!state || state.items.length === 0) return undefined;

  const normalized = normalize(text).toLowerCase();

  const tokens = normalized.split(/[\s،,.!?:;()]+/).filter(Boolean);

  const ordinalWords: Record<string, number> = {
    اول: 1,
    اولین: 1,
    نخست: 1,
    دوم: 2,
    دومین: 2,
    سوم: 3,
    سومین: 3,
    چهارم: 4,
    چهارمین: 4,
    پنجم: 5,
    پنجمین: 5,
    ششم: 6,
    ششمین: 6,
    هفتم: 7,
    هفتمین: 7,
    هشتم: 8,
    هشتمین: 8,
    نهم: 9,
    نهمین: 9,
    دهم: 10,
    دهمین: 10,
  };

  // Check explicit index pattern: شماره ۱ / مورد ۲ / ردیف ۳ / آیتم ۴ / 1 / 2
  const numMatch = normalized.match(/(?:شماره|مورد|ردیف|آیتم|خدمت|نوبت)?\s*(\d+)/);
  if (numMatch && numMatch[1]) {
    const idx = Number(numMatch[1]);
    const found = state.items.find((it) => it.index === idx);
    if (found) return found;
  }

  for (const token of tokens) {
    const num = ordinalWords[token];
    if (num !== undefined) {
      const found = state.items.find((it) => it.index === num);
      if (found) return found;
    }
  }

  // 2. By title or name match (longest matching name wins)
  let bestMatch: StoredItem | undefined = undefined;
  let bestLength = 0;

  for (const it of state.items) {
    if (!it.name) continue;
    const itName = it.name.toLowerCase();

    // 2a. Check title without parentheses (e.g. "دی می" from "دی می (فیلر نقاط حساس)")
    const mainTitle = itName.replace(/\([^)]*\)/g, "").trim();
    if (mainTitle.length >= 2 && normalized.includes(mainTitle)) {
      if (mainTitle.length > bestLength) {
        bestMatch = it;
        bestLength = mainTitle.length;
      }
      continue;
    }

    // 2b. Full title or cleaned title
    const cleanItName = itName.replace(/[()]/g, "").trim();
    if (cleanItName.length >= 2 && (normalized.includes(cleanItName) || cleanItName.includes(normalized))) {
      if (cleanItName.length > bestLength) {
        bestMatch = it;
        bestLength = cleanItName.length;
      }
      continue;
    }

    // 2c. Check if primary words match
    const words = (mainTitle || cleanItName).split(/\s+/).filter((w) => w.length >= 2);
    if (words.length > 0 && words[0] && normalized.includes(words[0])) {
      if (words[0].length > bestLength) {
        bestMatch = it;
        bestLength = words[0].length;
      }
    }
  }

  return bestMatch;
}

export function getLastPageInfo(sessionId: string): { actionId?: string | null; page?: number } {
  const state = sessionStates.get(sessionId);
  return { actionId: state?.lastActionId, page: state?.lastPage };
}

export function resetSessionsForTesting(): void {
  pending.clear();
  sessionStates.clear();
}

