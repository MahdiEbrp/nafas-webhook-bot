/**
 * user_id → session_id and phone, persisted.
 *
 * The rule the owner asked for: when a user messages, store their Telegram user
 * id as the key, a session id as the value, and — once they have given it —
 * their Iranian mobile number. A user we have not seen gets a fresh session id;
 * one we have keeps the session id they already had.
 *
 * Keyed by *user*, not by chat, so the record follows the person: a new chat
 * with the bot does not start them from nothing, and in a group each member
 * keeps their own number instead of everybody sharing the group's row.
 *
 * Three things are worth calling out:
 *
 * 1. `newSessionId()` is the *only* place a session id is invented. The owner
 *    said the real source is coming later, so when it arrives this one function
 *    changes and nothing else does.
 * 2. The mapping is cached in process memory. A chat's session id never changes,
 *    so once we also hold its phone number we never touch the database again for
 *    that chat — the DB is not on the hot path of a settled conversation.
 * 3. `phone` is nullable and filled in later. A row exists the moment a chat
 *    writes in, which is before we have its number, so "row exists" and "phone
 *    known" are genuinely different states and the cache keeps them apart.
 */

import { randomUUID } from "node:crypto";

import { logInfo, logWarn } from "@/lib/log";
import { isStoredPhone } from "@/lib/phone";

import { getRunner, tryQuery } from "./client";
import { ensureSchema, TABLE_NAME } from "./schema";

export type ChatSession = {
  telegramUserId: number;
  sessionId: string;
  /** Iranian mobile in stored form (`09XXXXXXXXX`), or null until it is given. */
  phone: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date;
  /** true when this call created the row, false when it already existed */
  isNew: boolean;
  /** true when the answer came from process memory rather than from Postgres */
  fromCache: boolean;
};

type Row = {
  telegram_user_id: number | string;
  session_id: string;
  phone: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  last_seen_at: string | Date;
  inserted: boolean | string;
};

/**
 * Where a session id comes from. Today: a random UUID.
 * Swap this one function when the real source is defined.
 */
export function newSessionId(): string {
  return randomUUID();
}

type Cached = { sessionId: string; phone: string | null };

const cache = new Map<number, Cached>();

const SELECT_COLUMNS = "telegram_user_id, session_id, phone, created_at, updated_at, last_seen_at";

/**
 * Upsert.
 *
 * The column list and the value list must stay the same length — a mismatch is
 * a hard Postgres error on *every* message, which is easy to miss when the only
 * database in reach is a test double. There is an assertion for exactly that in
 * `scripts/selftest.ts`.
 *
 * `(xmax = 0) as inserted` is the standard Postgres way to tell an inserted row
 * from an updated one out of a single `ON CONFLICT ... RETURNING`: a fresh tuple
 * has xmax 0, a row that was updated does not. Without it we would need a second
 * query just to know whether the chat was new.
 *
 * Note what the conflict branch does *not* do: it leaves `session_id` and
 * `phone` alone. Re-running this upsert can therefore never overwrite a number
 * somebody already gave us, or hand a returning chat a new session.
 */
const UPSERT_SQL = `
  insert into ${TABLE_NAME}
    (telegram_user_id, session_id, created_at, updated_at, last_seen_at)
  values ($1, $2, now(), now(), now())
  on conflict (telegram_user_id) do update
    set last_seen_at = now(),
        updated_at   = now()
  returning ${SELECT_COLUMNS}, (xmax = 0) as inserted
`.trim();

const SELECT_SQL = `select ${SELECT_COLUMNS}, false as inserted from ${TABLE_NAME} where telegram_user_id = $1`;

/**
 * Stores a phone number, creating the row if it is not there yet.
 *
 * This is an upsert and not a plain `update … where`, and the reason is the
 * order things actually arrive in: the gate asks for the number *first*, so for
 * a brand-new user the shared contact is the very first thing we ever see from
 * them. An update would match no row, silently store nothing, and the user would
 * be asked again forever.
 *
 * `excluded.phone` is the value we tried to insert, which is how the conflict
 * branch overwrites an old number without a second round trip. `session_id` is
 * only used when the row is genuinely new.
 */
const SET_PHONE_SQL = `
  insert into ${TABLE_NAME}
    (telegram_user_id, session_id, phone, created_at, updated_at, last_seen_at)
  values ($1, $2, $3, now(), now(), now())
  on conflict (telegram_user_id) do update
    set phone        = excluded.phone,
        updated_at   = now(),
        last_seen_at = now()
  returning ${SELECT_COLUMNS}, (xmax = 0) as inserted
`.trim();

function toSession(row: Row): ChatSession {
  return {
    telegramUserId: Number(row.telegram_user_id),
    sessionId: String(row.session_id),
    phone: isStoredPhone(row.phone) ? String(row.phone) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastSeenAt: new Date(row.last_seen_at),
    isNew: row.inserted === true || row.inserted === "t",
    fromCache: false,
  };
}

/**
 * A settled chat — one whose phone we already hold — is answered from memory
 * with zero queries. An unsettled one is not: another instance may have
 * collected the number since we last looked, and blocking a user who has
 * already given their number is worse than one extra read.
 */
function fromCacheIfSettled(telegramUserId: number): ChatSession | null {
  const cached = cache.get(telegramUserId);
  if (!cached || !cached.phone) return null;

  return {
    telegramUserId,
    sessionId: cached.sessionId,
    phone: cached.phone,
    createdAt: new Date(0),
    updatedAt: new Date(),
    lastSeenAt: new Date(),
    isNew: false,
    fromCache: true,
  };
}

/**
 * Returns the stored session for a chat, creating it on first contact.
 * Returns null when there is no database — the caller decides what to do then,
 * and the answer is always "keep working without it".
 */
export async function ensureChatSession(telegramUserId: number): Promise<ChatSession | null> {
  const run = getRunner();
  if (!run) return null;

  const settled = fromCacheIfSettled(telegramUserId);
  if (settled) return settled;

  if (!(await ensureSchema(run))) return null;

  const sessionId = newSessionId();
  const rows = await tryQuery<Row>(UPSERT_SQL, [telegramUserId, sessionId]);
  if (!rows || rows.length === 0) return null;

  const first = rows[0];
  if (!first) return null;

  const session = toSession(first);
  cache.set(telegramUserId, { sessionId: session.sessionId, phone: session.phone });

  logInfo("db.chat_session", {
    chatId: telegramUserId,
    isNew: session.isNew,
    hasPhone: session.phone !== null,
  });

  return session;
}

/** Reads the stored session without creating one. */
export async function getChatSession(telegramUserId: number): Promise<ChatSession | null> {
  const settled = fromCacheIfSettled(telegramUserId);
  if (settled) return settled;

  const rows = await tryQuery<Row>(SELECT_SQL, [telegramUserId]);
  const first = rows?.[0];
  if (!first) return null;

  const session = toSession(first);
  cache.set(telegramUserId, { sessionId: session.sessionId, phone: session.phone });
  return session;
}

/**
 * Writes a phone number for a chat and returns the updated row.
 *
 * Refuses anything that is not already in stored form — the caller validates and
 * normalises, and this is the last line of defence so a stray foreign number can
 * never reach the column. Returns null when there is no row or no database.
 */
export async function setChatPhone(
  telegramUserId: number,
  phone: string,
): Promise<ChatSession | null> {
  if (!isStoredPhone(phone)) {
    logWarn("db.phone_rejected", { chatId: telegramUserId });
    return null;
  }

  const run = getRunner();
  if (!run) return null;
  if (!(await ensureSchema(run))) return null;

  // A session id is needed only if the row does not exist yet; the conflict
  // branch leaves the stored one alone. Generating it unconditionally is cheaper
  // than asking whether we should.
  const rows = await tryQuery<Row>(SET_PHONE_SQL, [telegramUserId, newSessionId(), phone]);
  const first = rows?.[0];
  if (!first) {
    logWarn("db.phone_save_failed", { chatId: telegramUserId });
    return null;
  }

  const session = toSession(first);
  cache.set(telegramUserId, { sessionId: session.sessionId, phone: session.phone });

  logInfo("db.phone_saved", { chatId: telegramUserId, hasPhone: session.phone !== null });
  return session;
}

/**
 * The phone number on file for a chat, or null.
 *
 * This is what the gate asks. It reads the cache first, so a settled chat costs
 * nothing, and it never throws — a database outage reads as "no number yet",
 * which is the same answer as a brand-new user and is handled the same way.
 */
export async function phoneFor(telegramUserId: number): Promise<string | null> {
  const cached = cache.get(telegramUserId);
  if (cached?.phone) return cached.phone;

  try {
    const session = await getChatSession(telegramUserId);
    return session?.phone ?? null;
  } catch (error) {
    logWarn("db.phone_lookup_failed", {
      chatId: telegramUserId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
}

/**
 * The session id to use for a chat: the stored one if there is a database,
 * otherwise the deterministic fallback the bot has always used.
 *
 * This is the single call site the Telegram bridge needs — it cannot fail.
 */
export async function resolveSessionId(telegramUserId: number): Promise<string> {
  try {
    const session = await ensureChatSession(telegramUserId);
    if (session?.sessionId) return session.sessionId;
  } catch (error) {
    logWarn("db.session_resolve_failed", {
      chatId: telegramUserId,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
  return fallbackSessionId(telegramUserId);
}

/** What the bot uses when there is no database. Stable per chat, forever. */
export function fallbackSessionId(telegramUserId: number): string {
  return `tg-${telegramUserId}`;
}

export function cachedSessionCount(): number {
  return cache.size;
}

/** How many cached chats already have a number on file. */
export function cachedPhoneCount(): number {
  let count = 0;
  for (const entry of cache.values()) if (entry.phone) count += 1;
  return count;
}

export function resetChatSessionCacheForTesting(): void {
  cache.clear();
}
