/**
 * Schema, applied lazily and idempotently.
 *
 * Every statement is guarded or conditional, so booting a second instance,
 * redeploying, or running `npm run db:check` twice changes nothing. There is no
 * migration tool on purpose: these small tables do not justify one.
 */

import type { SqlRunner } from "./client";

export const TABLE_NAME = "chat_sessions";
export const AUTH_SESSION_TABLE_NAME = "auth_sessions";

/**
 * Only an HMAC actor lookup key and authenticated ciphertext are persisted here.
 * The upstream cookie, CSRF token, and actor id are never plaintext columns.
 */

/**
 * One row per Telegram user.
 *
 * `telegram_user_id` is the key the owner asked for; `session_id` is the value
 * and `phone` their Iranian mobile once they have given it.
 *
 * Keyed by user rather than by chat so the record follows the person: a chat id
 * belongs to a conversation, so a new chat with the bot would start from
 * nothing, and in a group one id is shared by everybody in it.
 *
 * There is deliberately no per-message counter. Updating one would mean a write
 * on every message, and on serverless that write would have to be fire-and-forget
 * — the function can be frozen the moment the reply is sent, so the counter
 * would quietly undercount and lie. A column that is sometimes wrong is worse
 * than no column.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `create table if not exists ${TABLE_NAME} (
     telegram_user_id bigint      primary key,
     session_id       text        not null,
     phone            text,
     created_at       timestamptz not null default now(),
     updated_at       timestamptz not null default now(),
     last_seen_at     timestamptz not null default now()
   )`,
  /**
   * Renames the key column on databases created when the bot keyed by chat id.
   *
   * A plain `alter table … rename column` is not idempotent — the second run
   * fails because the old name is gone — and this list runs on every boot. So
   * the rename is guarded by a look at `information_schema`, which also makes it
   * a no-op when the table does not exist yet.
   *
   * The data survives unchanged and stays correct: in a private chat Telegram
   * uses the same number for the chat and the user, so every row written under
   * a chat id already holds a user id. What changes is the meaning in groups,
   * where a chat id is shared by everyone in it.
   */
  `do $$
   begin
     if exists (
       select 1 from information_schema.columns
        where table_name = '${TABLE_NAME}' and column_name = 'telegram_chat_id'
     ) then
       alter table ${TABLE_NAME} rename column telegram_chat_id to telegram_user_id;
     end if;
   end $$`,
  /**
   * For databases created before `phone` existed.
   *
   * `create table if not exists` does nothing when the table is already there,
   * so a deployment that ran the first version would keep its phone-less table
   * forever. This line is the migration, and `if not exists` makes it free
   * afterwards. A `phone` column that is nullable on purpose: a row exists the
   * moment a chat writes in, which is before we have its number.
   */
  `alter table ${TABLE_NAME} add column if not exists phone text`,
  `create table if not exists ${AUTH_SESSION_TABLE_NAME} (
     actor_id_hash     text        primary key,
     encrypted_payload text        not null,
     expires_at        timestamptz not null,
     created_at        timestamptz not null default now(),
     updated_at        timestamptz not null default now()
   )`,
  `create index if not exists ${AUTH_SESSION_TABLE_NAME}_expires_at_idx on ${AUTH_SESSION_TABLE_NAME} (expires_at)`,
  `create index if not exists ${TABLE_NAME}_session_id_idx on ${TABLE_NAME} (session_id)`,
  `create index if not exists ${TABLE_NAME}_phone_idx on ${TABLE_NAME} (phone)`,
];

let ensured: Promise<boolean> | null = null;

/**
 * Creates the table if it is missing. Resolves once per process; a failure is
 * remembered as `false` rather than throwing, so a message is never lost
 * because of DDL.
 */
export function ensureSchema(run: SqlRunner): Promise<boolean> {
  if (!ensured) {
    ensured = (async () => {
      try {
        for (const statement of SCHEMA_STATEMENTS) await run(statement);
        return true;
      } catch {
        // Let the next call try again — Neon may have been mid-restart.
        ensured = null;
        return false;
      }
    })();
  }
  return ensured;
}

/** Used by tests and by `npm run db:check` to force a fresh attempt. */
export function resetSchemaCache(): void {
  ensured = null;
}
