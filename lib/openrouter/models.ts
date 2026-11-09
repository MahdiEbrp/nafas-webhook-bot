/**
 * Live catalog of OpenRouter's free models.
 *
 * The catalog is what makes automatic model choice possible: when a free model
 * disappears (they come and go weekly) the next request simply picks another.
 *
 * Latency matters here — this is on the chat request path — so the cache is
 * stale-while-revalidate: once warm we always answer from memory and refresh in
 * the background. Only a cold instance waits for the network, and if that fails
 * it throws so the caller can fall back to the configured chain.
 */

import { logWarn } from "@/lib/log";

export type FreeModel = {
  id: string;
  name: string;
  contextLength: number;
  supportsTools: boolean;
  supportsJsonMode: boolean;
};

type RawModel = {
  id: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
};

/** How long a fresh catalog is trusted before a background refresh is kicked off. */
const TTL_MS = 15 * 60 * 1000;
/** A stale catalog is still served; this is only how long we keep it at all. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

let cache: { at: number; models: FreeModel[] } | null = null;
let refreshing = false;

async function fetchCatalog(): Promise<FreeModel[]> {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });

  if (!response.ok) throw new Error(`OpenRouter models list failed: ${response.status}`);

  const payload = (await response.json()) as { data?: RawModel[] };
  return (payload.data ?? [])
    .filter((model) => typeof model.id === "string" && model.id.endsWith(":free"))
    .map<FreeModel>((model) => {
      const params = model.supported_parameters ?? [];
      return {
        id: model.id,
        name: model.name ?? model.id,
        contextLength: model.context_length ?? 0,
        supportsTools: params.includes("tools"),
        supportsJsonMode: params.includes("response_format") || params.includes("structured_outputs"),
      };
    });
}

export async function listFreeModels(force = false): Promise<FreeModel[]> {
  const now = Date.now();

  if (!force && cache && now - cache.at < TTL_MS) return cache.models;

  // Warm but stale: serve what we have, refresh behind the request.
  if (cache && now - cache.at < MAX_AGE_MS) {
    if (!refreshing) {
      refreshing = true;
      void fetchCatalog()
        .then((models) => {
          cache = { at: Date.now(), models };
        })
        .catch((error) => {
          logWarn("openrouter.catalog_refresh_failed", { message: error instanceof Error ? error.message : "unknown" });
        })
        .finally(() => {
          refreshing = false;
        });
    }
    return cache.models;
  }

  const models = await fetchCatalog();
  cache = { at: now, models };
  return models;
}

/** True when a catalog is in memory (so selection can work without waiting). */
export function hasCachedCatalog(): boolean {
  return cache !== null;
}

export function cachedCatalogAge(): number | null {
  return cache ? Date.now() - cache.at : null;
}

export function resetModelCache(): void {
  cache = null;
  refreshing = false;
}
