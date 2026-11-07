import { FEATURES, permissionMatrix } from "@/lib/features/manifest";
import { getConfig } from "@/lib/config";
import { preflight, withCors } from "@/lib/cors";
import { jsonOk, withApiHandler } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/features
 *
 * The whole capability catalog, exactly as the AI sees it — so a human can audit
 * "what is this bot allowed to do?" without reading the source.
 *
 * ?available=1  → only wired features
 * ?shape=tools  → OpenAI/OpenRouter tool-calling definitions
 */
export const GET = withApiHandler(async (request) => {
  const { searchParams } = new URL(request.url);
  const onlyAvailable = searchParams.get("available") === "1";
  const shape = searchParams.get("shape");

  const features = onlyAvailable ? FEATURES.filter((feature) => feature.available) : FEATURES;

  if (shape === "tools") {
    return withCors(jsonOk({
      tools: features
        .flatMap((feature) => feature.actions)
        .map((action) => ({
          type: "function" as const,
          function: {
            name: action.id.replace(/[.-]/g, "_"),
            description: `${action.en} — requires permission "${action.permission}" (${action.danger}).`,
            parameters: {
              type: "object",
              properties: Object.fromEntries(
                (action.fields ?? []).map((field) => [field, { type: "string", description: field }]),
              ),
              required: [],
              additionalProperties: false,
            },
          },
        })),
    }), request.headers.get("origin"));
  }

  const config = getConfig();

  return withCors(jsonOk({
    target: config.webhookBaseUrl,
    counts: {
      features: features.length,
      available: FEATURES.filter((feature) => feature.available).length,
      actions: features.reduce((sum, feature) => sum + feature.actions.length, 0),
    },
    features,
    permissions: permissionMatrix(),
    prompt: {
      persona: "Persian-speaking clinic assistant that explains everything like to a 10 year old kid.",
      planner: "lib/bot/prompt.ts",
      explainer: "lib/bot/explainer.ts",
    },
  }), request.headers.get("origin"));
});

export const OPTIONS = withApiHandler(async (request) => preflight(request));
