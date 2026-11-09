import { configWarnings, getConfig } from "@/lib/config";
import { preflight, withCors } from "@/lib/cors";
import { jsonOk, withApiHandler } from "@/lib/errors";
import { cachedCatalogAge } from "@/lib/openrouter/models";
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
