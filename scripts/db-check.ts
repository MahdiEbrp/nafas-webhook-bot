export {};

/**
 * npm run db:check
 *
 * The one place that proves the database really works: connect, create the
 * table, write a row, read it back, delete it, and print the timings.
 *
 * It exists because the sandbox this project is developed in cannot reach Neon
 * (HTTPS, TCP 5432 and WebSocket are all blocked there), so the self-test can
 * only exercise the logic around the database, never the connection. Run this
 * once after setting DATABASE_URL — here, or in CI, or on your laptop.
 *
 *   npm run db:check
 *   DATABASE_URL=postgresql://... npm run db:check
 */

import { dbConfigured, getRunner, normalizeDatabaseUrl } from "@/lib/db/client";
import { ensureSchema, resetSchemaCache, SCHEMA_STATEMENTS, TABLE_NAME } from "@/lib/db/schema";
import {
  ensureChatSession,
  fallbackSessionId,
  newSessionId,
  phoneFor,
  resetChatSessionCacheForTesting,
  setChatPhone,
} from "@/lib/db/chat-sessions";

/** A chat id that cannot collide with a real one. */
const TEST_CHAT_ID = -999_000_001;

const OK = "✅";
const BAD = "❌";

function masked(url: string): string {
  return url.replace(/:([^:@/]+)@/, ":****@");
}

async function main(): Promise<void> {
  console.log("\n🗄  database check\n");

  const configured = dbConfigured();
  if (!configured) {
    console.log(`  ${BAD} DATABASE_URL is not set — nothing to check.`);
    console.log("     Put the Neon connection string in .env.local and try again.");
    process.exitCode = 1;
    return;
  }

  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "";
  console.log(`  ${OK} target: ${masked(normalizeDatabaseUrl(url))}`);

  const run = getRunner();
  if (!run) {
    console.log(`  ${BAD} no runner was created.`);
    process.exitCode = 1;
    return;
  }

  let startedAt = Date.now();
  try {
    await run("select 1 as ok");
    console.log(`  ${OK} connected in ${Date.now() - startedAt}ms`);
  } catch (error) {
    console.log(`  ${BAD} could not connect: ${error instanceof Error ? error.message : error}`);
    console.log("     Check the host, the password, and that the branch is not suspended.");
    process.exitCode = 1;
    return;
  }

  resetSchemaCache();
  startedAt = Date.now();
  const schemaOk = await ensureSchema(run);
  console.log(
    `  ${schemaOk ? OK : BAD} schema ${schemaOk ? "ready" : "FAILED"} in ${Date.now() - startedAt}ms (${SCHEMA_STATEMENTS.length} statements, idempotent)`,
  );
  if (!schemaOk) {
    process.exitCode = 1;
    return;
  }

  const columns = (await run(
    `select column_name from information_schema.columns where table_name = $1 order by ordinal_position`,
    [TABLE_NAME],
  )) as Array<{ column_name: string }>;
  console.log(`  ${OK} ${TABLE_NAME}: ${columns.map((column) => column.column_name).join(", ")}`);

  // Round-trip: first contact creates, second contact only touches.
  resetChatSessionCacheForTesting();
  await run(`delete from ${TABLE_NAME} where telegram_chat_id = $1`, [TEST_CHAT_ID]);

  startedAt = Date.now();
  const first = await ensureChatSession(TEST_CHAT_ID);
  const firstMs = Date.now() - startedAt;
  if (!first) {
    console.log(`  ${BAD} the upsert returned nothing.`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ${OK} new chat stored in ${firstMs}ms → session ${first.sessionId} (isNew=${first.isNew})`);

  // A second warm process would hit the in-memory cache, so clear it to force
  // the real "existing chat" path through SQL.
  resetChatSessionCacheForTesting();
  startedAt = Date.now();
  const second = await ensureChatSession(TEST_CHAT_ID);
  const secondMs = Date.now() - startedAt;
  console.log(`  ${OK} returning chat read in ${secondMs}ms → isNew=${second?.isNew}`);

  const sameSession = second?.sessionId === first.sessionId;
  const notNew = second?.isNew === false;
  console.log(`  ${sameSession ? OK : BAD} same session id on the second message`);
  console.log(`  ${notNew ? OK : BAD} the second message is not reported as new`);

  // The phone column: it is what the gate refuses to answer without, so a
  // deployment where this silently fails is a bot that asks for a number
  // forever. Worth proving end to end.
  const hasPhoneColumn = columns.some((column) => column.column_name === "phone");
  console.log(`  ${hasPhoneColumn ? OK : BAD} the phone column exists`);

  const TEST_PHONE = "09121234567";
  startedAt = Date.now();
  const withPhone = await setChatPhone(TEST_CHAT_ID, TEST_PHONE);
  const phoneMs = Date.now() - startedAt;
  const phoneSaved = withPhone?.phone === TEST_PHONE;
  console.log(
    `  ${phoneSaved ? OK : BAD} phone stored in ${phoneMs}ms → ${withPhone?.phone ?? "nothing"}`,
  );

  // The stored form must survive the trip, and the session id must not change.
  const readBack = await phoneFor(TEST_CHAT_ID);
  const phoneRoundTrip = readBack === TEST_PHONE;
  const sessionSurvived = withPhone?.sessionId === first.sessionId;
  console.log(`  ${phoneRoundTrip ? OK : BAD} phone read back as ${readBack ?? "nothing"}`);
  console.log(`  ${sessionSurvived ? OK : BAD} saving a phone left the session id alone`);

  // A foreign number must never reach the column.
  const refused = await setChatPhone(TEST_CHAT_ID, "+14155552671");
  console.log(`  ${refused === null ? OK : BAD} a non-Iranian number is refused before it is written`);

  const leftover = await run(`delete from ${TABLE_NAME} where telegram_chat_id = $1 returning session_id`, [
    TEST_CHAT_ID,
  ]);
  console.log(`  ${OK} cleaned up the test row (${leftover.length} deleted)`);

  console.log(`\n  fallback when the database is gone: ${fallbackSessionId(TEST_CHAT_ID)}`);
  console.log(`  generated session id shape: ${newSessionId()}`);

  const failed =
    !sameSession || !notNew || !hasPhoneColumn || !phoneSaved || !phoneRoundTrip || !sessionSurvived;
  if (failed) {
    console.log(`\n  ${BAD} the round-trip did not behave as expected.\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n  🎉 database round-trip works.\n`);
}

main().catch((error) => {
  console.error("\n  ❌ db:check crashed:", error instanceof Error ? error.message : error, "\n");
  process.exitCode = 1;
});
