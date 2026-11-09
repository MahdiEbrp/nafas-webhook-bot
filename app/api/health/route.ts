import { configWarnings, getConfig } from "@/lib/config";
import { preflight, withCors } from "@/lib/cors";
import { jsonOk, withApiHandler } from "@/lib/errors";
import { cachedCatalogAge } from "@/lib/openrouter/models";
import { dbConfigured, getRunner } from "@/lib/db/client";
import { ensureSchema, TABLE_NAME } from "@/lib/db/schema";
import { cachedPhoneCount, cachedSessionCount } from "@/lib/db/chat-sessions";
import { selectChain } from "@/lib/openrouter/select";
import { statsSnapshot } from "@/lib/openrouter/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *   → config warnings, which models the bot would pick right now, and the
 *     speed it has measured for them. No secrets, no side effects, safe to
 *     poll from an uptime checker.
 *
 * The selection is computed quietly (`quiet: true`) so polling this endpoint
 * does not fill the logs with one "chain selected" line per request.
 */
export const GET = withApiHandler(async (request) => {
  const config = getConfig();
  const warnings = configWarnings(config);

  let selection;
  try {
    selection = await selectChain({ quiet: true });
  } catch (error) {
    selection = null;
    warnings.push(`Model selection failed: ${error instanceof Error ? error.message : "unknown"}`);
  }

  // The database is opt-in here (?db=1): a plain uptime poll should not spend a
  // round-trip to Neon every time.
  const checkDb = new URL(request.url).searchParams.get("db") === "1";
  let database: Record<string, unknown> = {
    configured: dbConfigured(),
    table: TABLE_NAME,
    cachedSessions: cachedSessionCount(),
    cachedPhones: cachedPhoneCount(),
    // The gate needs somewhere to put a number, so it follows the runner rather
    // than the config alone. Reporting it here is how an operator finds out why
    // the bot is or is not asking for phone numbers.
    phoneGate: config.phoneGate && getRunner() !== null,
  };

  if (checkDb) {
    const run = getRunner();
    if (!run) {
      database = { ...database, reachable: false, reason: "DATABASE_URL is not set" };
    } else {
      const startedAt = Date.now();
      try {
        const rows = (await run("select 1 as ok")) as Array<{ ok: number }>;
        const schemaOk = await ensureSchema(run);
        database = {
          ...database,
          reachable: rows.length === 1,
          schemaReady: schemaOk,
          ms: Date.now() - startedAt,
        };
      } catch (error) {
        database = {
          ...database,
          reachable: false,
          error: error instanceof Error ? error.message : "unknown",
          ms: Date.now() - startedAt,
        };
      }
    }
  }

  return withCors(
    jsonOk({
      status: warnings.length === 0 ? "ok" : "degraded",
      warnings,
      bot: {
        name: config.botName,
        defaultLocale: config.defaultLocale,
        historyMessages: config.history.maxMessages,
      },
      openrouter: {
        configured: Boolean(config.openrouterApiKey),
        selection: selection
          ? {
              source: selection.source,
              note: selection.note,
              /** the order models will be tried in, best first */
              chain: selection.chain,
              catalogSize: selection.catalogSize,
              considered: selection.considered,
              catalogAgeMs: cachedCatalogAge(),
              top: selection.top.map((model) => ({
                id: model.id,
                score: model.score,
                quality: model.quality,
                latencyMs: model.latencyMs === null ? null : Math.round(model.latencyMs),
                samples: model.samples,
                coolingDown: model.coolingDown,
                reason: model.reason,
              })),
            }
          : null,
        fallbackChain: config.modelChain,
        settings: {
          selection: config.modelSelection,
          poolSize: config.modelPoolSize,
          minContext: config.modelMinContext,
          cooldownMs: config.modelCooldownMs,
        },
        /** per-model timings measured by this instance */
        measured: statsSnapshot().map((stat) => ({
          id: stat.id,
          latencyMs: stat.latencyMs === null ? null : Math.round(stat.latencyMs),
          bestMs: stat.bestMs === null ? null : Math.round(stat.bestMs),
          samples: stat.samples,
          failures: stat.failures,
          coolingDown: stat.coolingDown,
        })),
      },
      database,
      telegram: {
        configured: Boolean(config.telegram.botToken),
        webhookUrl: config.telegram.publicUrl ? `${config.telegram.publicUrl}/api/telegram/webhook` : null,
      },
      node: process.version,
    }),
    request.headers.get("origin"),
  );
});

export const OPTIONS = withApiHandler(async (request) => preflight(request));
