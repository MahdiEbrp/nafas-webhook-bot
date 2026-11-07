import { configWarnings, getConfig } from "@/lib/config";
import { FEATURES } from "@/lib/features/manifest";
import { preflight, withCors } from "@/lib/cors";
import { jsonOk, withApiHandler } from "@/lib/errors";
import { listFreeModels } from "@/lib/openrouter/models";
import { callWebhook } from "@/lib/webhooks/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *   → config + free-model availability (fast, no secrets)
 * GET /api/health?deep=1
 *   → additionally performs one real read against the webhook API
 */
export const GET = withApiHandler(async (request) => {
  const config = getConfig();
  const { searchParams } = new URL(request.url);
  const deep = searchParams.get("deep") === "1";

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

  const webhook = deep
    ? await callWebhook({
        method: "GET",
        path: "/api/v1/webhooks/bookings",
        query: { perPage: 1, page: 1 },
      })
    : null;

  return withCors(jsonOk({
    status: warnings.length === 0 ? "ok" : "degraded",
    warnings,
    features: {
      total: FEATURES.length,
      available: FEATURES.filter((feature) => feature.available).length,
    },
    openrouter: {
      configuredModels: config.modelChain,
      freeModels,
    },
    webhook: deep
      ? webhook?.ok
        ? { reachable: true, httpStatus: webhook.status, ms: webhook.ms }
        : {
            reachable: false,
            httpStatus: webhook?.status,
            code: webhook && !webhook.ok ? webhook.code : undefined,
          }
      : { reachable: "not checked (add ?deep=1)" },
    node: process.version,
  }), request.headers.get("origin"));
});

export const OPTIONS = withApiHandler(async (request) => preflight(request));
