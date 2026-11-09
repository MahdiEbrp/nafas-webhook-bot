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
    /*
     * The specifier is a variable on purpose.
     *
     * `import("embedded-postgres")` written literally makes tsc resolve the
     * package, and it is not a dependency — so `npm run typecheck` fails on any
     * clone that has not installed it by hand. A variable specifier is not
     * statically resolvable, which is exactly what we want here.
     */
    const moduleName = "embedded-postgres";
    const loaded = (await import(moduleName)) as { default: typeof EmbeddedPostgres };
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

  const pg = new EmbeddedPostgres({
    databaseDir: "./.pgdata",
    user: "postgres",
    password: "postgres",
    port: 5433,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();

  try {
    await runChecks(pg);
  } finally {
    /*
     * Always stop the cluster. A crashed check otherwise leaves Postgres holding
     * the port, and every later run dies with "could not create any TCP/IP
     * sockets" — a confusing failure that has nothing to do with the SQL.
     */
    await pg.stop().catch(() => undefined);
  }
}

async function runChecks(pg: Embedded): Promise<void> {
  const { setRunnerForTesting } = await import("@/lib/db/client");
  const { ensureSchema, resetSchemaCache, TABLE_NAME } = await import("@/lib/db/schema");
  const {
    ensureChatSession,
    setChatPhone,
    phoneFor,
    resolveSessionId,
    resetChatSessionCacheForTesting,
  } = await import("@/lib/db/chat-sessions");

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

  /* ── 2. The migration path: a table from before both changes ─────────── */
  // Shaped exactly like the one #18 created: keyed by chat id, no phone column,
  // and a row already in it. This is what a real deployment looks like.
  await client.query(`drop table if exists ${TABLE_NAME}`);
  await client.query(`create table ${TABLE_NAME} (
    telegram_chat_id bigint primary key,
    session_id text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
  )`);
  await client.query(
    `insert into ${TABLE_NAME} (telegram_chat_id, session_id) values ($1, $2)`,
    [4242, "11111111-1111-4111-8111-111111111111"],
  );

  resetSchemaCache();
  check("the schema migrates an old table without throwing", await ensureSchema(run));
  const widened = await columns();
  check("the key column was renamed, not added alongside", widened.includes("telegram_user_id"), widened.join(", "));
  check("the old column name is gone", !widened.includes("telegram_chat_id"));
  check("and the phone column was added", widened.includes("phone"));

  const migrated = (await client.query(`select telegram_user_id, session_id from ${TABLE_NAME}`)).rows;
  check("the existing row survived the rename", migrated.length === 1, `${migrated.length} rows`);
  check(
    "with its data intact",
    String(migrated[0]?.telegram_user_id) === "4242" &&
      String(migrated[0]?.session_id) === "11111111-1111-4111-8111-111111111111",
  );

  // A bare RENAME COLUMN throws on the second boot, and this list runs on every
  // boot. The information_schema guard is what makes that safe.
  resetSchemaCache();
  check("running the migration a second time is harmless", await ensureSchema(run));

  /* ── 3. The upsert, for real ─────────────────────────────────────────── */
  resetChatSessionCacheForTesting();
  const first = await ensureChatSession(4242);
  check(
    "a user who was already there is not re-created",
    first?.isNew === false && first?.sessionId === "11111111-1111-4111-8111-111111111111",
    `session=${first?.sessionId}`,
  );
  check("phone starts empty", first?.phone === null, `phone=${String(first?.phone)}`);

  const brandNew = await ensureChatSession(9000);
  check("a user we have never seen is inserted", brandNew?.isNew === true, `session=${brandNew?.sessionId}`);
  check("the new session id is a uuid", /^[0-9a-f-]{36}$/.test(brandNew?.sessionId ?? ""));

  // A warm instance answers from memory, so clear the cache to force real SQL.
  resetChatSessionCacheForTesting();
  const second = await ensureChatSession(4242);
  check("a returning user keeps their session id", second?.sessionId === first?.sessionId);
  check("and is not reported as new", second?.isNew === false, `isNew=${String(second?.isNew)}`);

  /* ── 4. The phone upsert, on a user with no row yet ──────────────────── */
  // This is the case that matters: the gate asks for the number *first*, so the
  // shared contact is often the very first thing seen from a user.
  const savedForNewChat = await setChatPhone(5555, "09121234567");
  check(
    "a shared contact creates the row a new user needs",
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
      `select telegram_user_id, session_id, phone from ${TABLE_NAME} order by telegram_user_id`,
    )
  ).rows;
  console.log("\nrows in the real table (keyed by user id):");
  for (const row of onDisk) {
    console.log(
      `   ${String(row.telegram_user_id)}  ${String(row.session_id).slice(0, 8)}…  ${row.phone === null ? "(no number yet)" : String(row.phone)}`,
    );
  }
  check("exactly the three users are stored", onDisk.length === 3, `${onDisk.length} rows`);

  // One of the three never gave a number, so only the stored ones are checked —
  // and the point is that none of them carry a country code.
  const withPhone = onDisk.filter((row) => row.phone !== null);
  check("two of them have a number on file", withPhone.length === 2, `${withPhone.length} with a phone`);
  check(
    "and none of those carry a country code",
    withPhone.every((row) => /^09\d{9}$/.test(String(row.phone))),
  );

  /* ── 6. The fallback still works ─────────────────────────────────────── */
  check("resolveSessionId returns the stored id", (await resolveSessionId(4242)) === first?.sessionId);

  await client.end();
  setRunnerForTesting(null);

  console.log(failures === 0 ? "\n🎉 real Postgres accepted everything\n" : `\n❌ ${failures} problem(s)\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error("\n❌ db:real crashed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
