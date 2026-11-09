/**
 * Run the real SQL against a real Postgres.
 *
 * `npm run db:check` proves the connection to the *actual* database. This proves
 * the *statements*: it starts a throwaway Postgres on the machine, points the
 * app's runner at it, and exercises every query the bot sends — the upsert, the
 * `xmax = 0` inserted flag, the phone upsert, and the `alter table` that widens
 * a table created before the phone column existed.
 *
 * It exists because a hand-written fake once let a broken INSERT reach main: an
 * INSERT naming six columns with five values. Postgres rejects that on every
 * row; a test double that only pattern-matches does not notice.
 *
 * The Postgres binaries are ~60MB, so they are deliberately not a dependency of
 * this project. Install them once, by hand, when you want to run this:
 *
 *   npm install --no-save embedded-postgres @embedded-postgres/linux-x64
 */

/*
 * Minimal structural types rather than `import("embedded-postgres")`.
 *
 * The package is installed by hand, on purpose, so naming its types here would
 * make `npm run typecheck` fail on any clone that has not installed it. These
 * cover the handful of members this script actually touches.
 */
type PgClient = {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
};
type Embedded = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  createDatabase(name: string): Promise<void>;
  getPgClient(database?: string): PgClient;
};
type Runner = (query: string, params?: unknown[]) => Promise<unknown[]>;

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/**
 * Everything lives inside `main()`. The project is CommonJS (there is no
 * `"type": "module"` and adding one breaks the Next build), and CJS has no
 * top-level await — the same reason `scripts/selftest.ts` is shaped this way.
 */
async function main(): Promise<void> {
  let EmbeddedPostgres: new (options: Record<string, unknown>) => Embedded;
  try {
    const loaded = (await import("embedded-postgres")) as { default: typeof EmbeddedPostgres };
    EmbeddedPostgres = loaded.default;
  } catch {
    console.error(
      "\n❌ embedded-postgres is not installed.\n\n" +
        "   npm install --no-save embedded-postgres @embedded-postgres/linux-x64\n" +
        "   npm run db:real\n",
    );
    process.exitCode = 1;
    return;
  }

  const { setRunnerForTesting } = await import("@/lib/db/client");
  const { ensureSchema, resetSchemaCache, TABLE_NAME } = await import("@/lib/db/schema");
  const {
    ensureChatSession,
    setChatPhone,
    phoneFor,
    resolveSessionId,
    resetChatSessionCacheForTesting,
  } = await import("@/lib/db/chat-sessions");

  const pg = new EmbeddedPostgres({
    databaseDir: "./.pgdata",
    user: "postgres",
    password: "postgres",
    port: 5433,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase("nafas");

  const client = pg.getPgClient("nafas");
  await client.connect();
  const version = String((await client.query("select version()")).rows[0]?.version ?? "");
  console.log(`\n🐘 real Postgres: ${version}\n`);

  // Every query the app sends now goes to this server, unmodified.
  const run: Runner = async (query, params = []) => (await client.query(query, params)).rows;
  setRunnerForTesting(run);

  const columns = async (): Promise<string[]> =>
    (
      await client.query(
        "select column_name from information_schema.columns where table_name = $1 order by ordinal_position",
        [TABLE_NAME],
      )
    ).rows.map((row) => String(row.column_name));

  /* ── 1. Fresh schema ─────────────────────────────────────────────────── */
  resetSchemaCache();
  resetChatSessionCacheForTesting();
  check("the schema applies to a fresh database", await ensureSchema(run));
  const fresh = await columns();
  check("the table has a phone column", fresh.includes("phone"), fresh.join(", "));

  resetSchemaCache();
  check("applying it a second time is harmless", await ensureSchema(run));

  /* ── 2. The migration path: a table that predates phone ──────────────── */
  await client.query(`drop table if exists ${TABLE_NAME}`);
  await client.query(`create table ${TABLE_NAME} (
    telegram_chat_id bigint primary key,
    session_id text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
  )`);
  resetSchemaCache();
  await ensureSchema(run);
  const widened = await columns();
  check("an existing table is widened, not left phone-less", widened.includes("phone"), widened.join(", "));

  /* ── 3. The upsert, for real ─────────────────────────────────────────── */
  resetChatSessionCacheForTesting();
  const first = await ensureChatSession(4242);
  check("a new chat is inserted", first?.isNew === true, `session=${first?.sessionId}`);
  check("phone starts empty", first?.phone === null, `phone=${String(first?.phone)}`);
  check("the session id is a uuid", /^[0-9a-f-]{36}$/.test(first?.sessionId ?? ""));

  // A warm instance answers from memory, so clear the cache to force real SQL.
  resetChatSessionCacheForTesting();
  const second = await ensureChatSession(4242);
  check("a returning chat keeps its session id", second?.sessionId === first?.sessionId);
  check("and is not reported as new", second?.isNew === false, `isNew=${String(second?.isNew)}`);

  /* ── 4. The phone upsert, on a chat with no row yet ──────────────────── */
  // This is the case that matters: the gate asks for the number *first*, so the
  // shared contact is often the very first thing seen from a user.
  const savedForNewChat = await setChatPhone(5555, "09121234567");
  check(
    "a shared contact creates the row it needs",
    savedForNewChat?.phone === "09121234567",
    `phone=${String(savedForNewChat?.phone)}`,
  );

  const savedForExisting = await setChatPhone(4242, "09351234567");
  check("saving a phone keeps the session id", savedForExisting?.sessionId === first?.sessionId);
  check("and writes the number", savedForExisting?.phone === "09351234567");

  resetChatSessionCacheForTesting();
  check("the number survives a cold read", (await phoneFor(4242)) === "09351234567");

  const replaced = await setChatPhone(4242, "09121234567");
  check("a number can be replaced", replaced?.phone === "09121234567");
  check("without changing the session id", replaced?.sessionId === first?.sessionId);

  /* ── 5. What is actually on disk ─────────────────────────────────────── */
  const onDisk = (
    await client.query(
      `select telegram_chat_id, session_id, phone from ${TABLE_NAME} order by telegram_chat_id`,
    )
  ).rows;
  console.log("\nrows in the real table:");
  for (const row of onDisk) {
    console.log(`   ${String(row.telegram_chat_id)}  ${String(row.session_id).slice(0, 8)}…  ${String(row.phone)}`);
  }
  check("exactly the two chats are stored", onDisk.length === 2, `${onDisk.length} rows`);
  check(
    "no country code in the column",
    onDisk.every((row) => /^09\d{9}$/.test(String(row.phone))),
  );

  /* ── 6. The fallback still works ─────────────────────────────────────── */
  check("resolveSessionId returns the stored id", (await resolveSessionId(4242)) === first?.sessionId);

  await client.end();
  await pg.stop();
  setRunnerForTesting(null);

  console.log(failures === 0 ? "\n🎉 real Postgres accepted everything\n" : `\n❌ ${failures} problem(s)\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
