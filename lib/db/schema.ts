/**
 * Schema, applied lazily and idempotently.
 *
 * Every statement is `IF NOT EXISTS`, so booting a second instance, redeploying,
 * or running `npm run db:check` twice changes nothing. There is no migration
 * tool on purpose: this project has one small table, and a migration framework
 * would be more machinery than the schema.
 */

import type { SqlRunner } from "./client";

export const TABLE_NAME = "chat_sessions";

/**
 * One row per Telegram chat.
 *
 * `telegram_chat_id` is the key the owner asked for; `session_id` is the value.
 *
 * There is deliberately no per-message counter. Updating one would mean a write
 * on every message, and on serverless that write would have to be fire-and-forget
 * — the function can be frozen the moment the reply is sent, so the counter
 * would quietly undercount and lie. A column that is sometimes wrong is worse
 * than no column.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `create table if not exists ${TABLE_NAME} (
     telegram_chat_id bigint      primary key,
     session_id       text        not null,
     created_at       timestamptz not null default now(),
     updated_at       timestamptz not null default now(),
     last_seen_at     timestamptz not null default now()
   )`,
  `create index if not exists ${TABLE_NAME}_session_id_idx on ${TABLE_NAME} (session_id)`,
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
