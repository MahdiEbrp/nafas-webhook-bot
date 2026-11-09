import { configWarnings, getConfig } from "@/lib/config";
import { preflight, withCors } from "@/lib/cors";
import { jsonOk, withApiHandler } from "@/lib/errors";
import { listFreeModels } from "@/lib/openrouter/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *   → config warnings + availability of the free models in the chain.
 * No secrets, no side effects, safe to poll from an uptime checker.
 */
export const GET = withApiHandler(async (request) => {
  const config = getConfig();
  const warnings = configWarnings(config);

  let freeModels: { count: number; configuredChainAlive: boolean; sample: string[] } | { error: string };
  try {
    const models = await listFreeModels();
    const ids = new Set(models.map((model) => model.id));
    freeModels = {
      count: models.length,
      configuredChainAlive: config.modelChain.every((id) => ids.has(id)),
      sample: models.slice(0, 6).map((model) => model.id),
    };
  } catch (error) {
    freeModels = { error: error instanceof Error ? error.message : "unknown" };
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
        configuredModels: config.modelChain,
        freeModels,
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
