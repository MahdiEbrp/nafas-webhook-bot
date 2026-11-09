/**
 * Postgres (Neon) client.
 *
 * Driver choice: `@neondatabase/serverless`, Neon's own HTTP driver. On Vercel
 * it makes one short HTTPS request per query instead of holding a TCP socket,
 * which is what a serverless function wants — no pool to exhaust, no socket to
 * keep warm.
 *
 * Measured in the sandbox, for the record, because it shaped this file:
 *   HTTP driver  → api.<region>.neon.tech:443      blocked here
 *   `pg` on 5432 → TCP connects, then the socket is cut
 *   WebSocket    → upgrade refused ("non-101 status code")
 * So the connection itself could NOT be exercised from this environment; only
 * the logic around it could. `npm run db:check` does the real round-trip.
 *
 * The database is an optional extra, never a dependency: if `DATABASE_URL` is
 * missing or Neon is unreachable, callers get `null` and the bot carries on
 * exactly as it did before this file existed.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import { getConfig } from "@/lib/config";
import { logWarn } from "@/lib/log";

/** Parameterised query runner — the only shape the rest of the app depends on. */
export type SqlRunner = (query: string, params?: unknown[]) => Promise<unknown[]>;

/** A single query is allowed this long before we give up on it. */
const QUERY_TIMEOUT_MS = 8_000;

let runner: SqlRunner | null | undefined;

/**
 * Cleans a connection string that came from a pasted dashboard snippet.
 *
 * Two kinds of damage show up in practice, both of which produce a confusing
 * failure rather than an obvious one:
 *   • `&amp;` — HTML-escaped by whatever rendered the snippet
 *   • `channel_binding=require` — a libpq option the HTTP driver has no use for
 * Surrounding whitespace and markdown link brackets are stripped too.
 */
export function normalizeDatabaseUrl(raw: string): string {
  let url = raw.trim().replace(/^<|>$/g, "");

  url = url.replace(/&amp;/g, "&");

  const queryStart = url.indexOf("?");
  const beforeQuery = queryStart === -1 ? url : url.slice(0, queryStart);
  const query = queryStart === -1 ? "" : url.slice(queryStart + 1);
  const kept = query
    .split("&")
    .filter(Boolean)
    .filter((pair) => !/^channel_binding=/i.test(pair));
  if (!kept.some((pair) => /^sslmode=/i.test(pair))) kept.push("sslmode=require");

  return kept.length > 0 ? `${beforeQuery}?${kept.join("&")}` : beforeQuery;
}

export function dbConfigured(): boolean {
  return Boolean(getConfig().databaseUrl);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`query timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/** The shared runner, or null when there is no database to talk to. */
export function getRunner(): SqlRunner | null {
  if (runner !== undefined) return runner;

  const url = getConfig().databaseUrl;
  if (!url) {
    runner = null;
    return runner;
  }

  const sql: NeonQueryFunction<false, false> = neon(normalizeDatabaseUrl(url), {
    // Neon's HTTP driver speaks one request per query; keep bodies small.
    arrayMode: false,
    fullResults: false,
  });

  runner = (query, params) => withTimeout(sql.query(query, params as unknown[]), QUERY_TIMEOUT_MS);
  return runner;
}

/** Runs a query, turning any failure into `null` so callers can degrade. */
export async function tryQuery<T>(query: string, params?: unknown[]): Promise<T[] | null> {
  const run = getRunner();
  if (!run) return null;

  try {
    return (await run(query, params)) as T[];
  } catch (error) {
    logWarn("db.query_failed", { message: error instanceof Error ? error.message : "unknown" });
    return null;
  }
}

/** Lets the self-test swap the database for a fake. */
export function setRunnerForTesting(value: SqlRunner | null): void {
  runner = value;
}
