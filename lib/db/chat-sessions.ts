/**
 * chat_id → session_id, persisted.
 *
 * The rule the owner asked for: when a user messages, store their Telegram chat
 * id as the key and a session id as the value. A new chat gets a fresh session
 * id; an existing chat keeps the one it already has.
 *
 * Two things are worth calling out:
 *
 * 1. `newSessionId()` is the *only* place a session id is invented. The owner
 *    said the real source is coming later, so when it arrives this one function
 *    changes and nothing else does.
 * 2. The mapping is cached in process memory. A chat's session id never changes,
 *    so after the first message of a warm instance we never touch the database
 *    again for that chat — the DB is not on the hot path of every message.
 */

import { randomUUID } from "node:crypto";

import { logInfo, logWarn } from "@/lib/log";

import { getRunner, tryQuery } from "./client";
import { ensureSchema, TABLE_NAME } from "./schema";

export type ChatSession = {
  telegramChatId: number;
  sessionId: string;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date;
  /** true when this call created the row, false when it already existed */
  isNew: boolean;
  /** true when the answer came from process memory rather than from Postgres */
  fromCache: boolean;
};

type Row = {
  telegram_chat_id: number | string;
  session_id: string;
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

const cache = new Map<number, string>();

const SELECT_COLUMNS = "telegram_chat_id, session_id, created_at, updated_at, last_seen_at";

/**
 * Upsert.
 *
 * `(xmax = 0) as inserted` is the standard Postgres way to tell an inserted row
 * from an updated one out of a single `ON CONFLICT ... RETURNING`: a fresh tuple
 * has xmax 0, a row that was updated does not. Without it we would need a second
 * query just to know whether the chat was new.
 */
const UPSERT_SQL = `
  insert into ${TABLE_NAME}
    (telegram_chat_id, session_id, created_at, updated_at, last_seen_at, message_count)
  values ($1, $2, now(), now(), now())
  on conflict (telegram_chat_id) do update
    set last_seen_at = now(),
        updated_at   = now()
  returning ${SELECT_COLUMNS}, (xmax = 0) as inserted
`.trim();

const SELECT_SQL = `select ${SELECT_COLUMNS}, false as inserted from ${TABLE_NAME} where telegram_chat_id = $1`;

function toSession(row: Row): ChatSession {
  return {
    telegramChatId: Number(row.telegram_chat_id),
    sessionId: String(row.session_id),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastSeenAt: new Date(row.last_seen_at),
    isNew: row.inserted === true || row.inserted === "t",
    fromCache: false,
  };
}

/**
 * Returns the stored session for a chat, creating it on first contact.
 * Returns null when there is no database — the caller decides what to do then,
 * and the answer is always "keep working without it".
 */
export async function ensureChatSession(telegramChatId: number): Promise<ChatSession | null> {
  const run = getRunner();
  if (!run) return null;

  // A warm instance already knows this chat: answer from memory and do not
  // touch the database at all. The session id never changes, so there is
  // nothing to refresh — and nothing to slow the reply down with.
  const cached = cache.get(telegramChatId);
  if (cached) {
    return {
      telegramChatId,
      sessionId: cached,
      createdAt: new Date(0),
      updatedAt: new Date(),
      lastSeenAt: new Date(),
      isNew: false,
      fromCache: true,
    };
  }

  if (!(await ensureSchema(run))) return null;

  const sessionId = newSessionId();
  const rows = await tryQuery<Row>(UPSERT_SQL, [telegramChatId, sessionId]);
  if (!rows || rows.length === 0) return null;

  const first = rows[0];
  if (!first) return null;

  const session = toSession(first);
  cache.set(telegramChatId, session.sessionId);

  logInfo("db.chat_session", { chatId: telegramChatId, isNew: session.isNew });

  return session;
}

/** Reads the stored session without creating one. */
export async function getChatSession(telegramChatId: number): Promise<ChatSession | null> {
  const cached = cache.get(telegramChatId);
  if (cached) {
    return {
      telegramChatId,
      sessionId: cached,
      createdAt: new Date(0),
      updatedAt: new Date(),
      lastSeenAt: new Date(),
      isNew: false,
      fromCache: true,
    };
  }

  const rows = await tryQuery<Row>(SELECT_SQL, [telegramChatId]);
  const first = rows?.[0];
  if (!first) return null;

  const session = toSession(first);
  cache.set(telegramChatId, session.sessionId);
  return session;
}

/**
 * The session id to use for a chat: the stored one if there is a database,
 * otherwise the deterministic fallback the bot has always used.
 *
 * This is the single call site the Telegram bridge needs — it cannot fail.
 */
export async function resolveSessionId(telegramChatId: number): Promise<string> {
  try {
    const session = await ensureChatSession(telegramChatId);
    if (session?.sessionId) return session.sessionId;
  } catch (error) {
    logWarn("db.session_resolve_failed", {
      chatId: telegramChatId,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
  return fallbackSessionId(telegramChatId);
}

/** What the bot uses when there is no database. Stable per chat, forever. */
export function fallbackSessionId(telegramChatId: number): string {
  return `tg-${telegramChatId}`;
}

export function cachedSessionCount(): number {
  return cache.size;
}

export function resetChatSessionCacheForTesting(): void {
  cache.clear();
}
