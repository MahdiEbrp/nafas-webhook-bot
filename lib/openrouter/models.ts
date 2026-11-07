/**
 * Live catalog of OpenRouter's free models.
 *
 * Used to (a) prove the configured chain still points at existing free models
 * and (b) auto-pick a replacement when one disappears. Result is cached for an
 * hour per warm instance.
 */

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

let cache: { at: number; models: FreeModel[] } | null = null;
const TTL_MS = 60 * 60 * 1000;

export async function listFreeModels(force = false): Promise<FreeModel[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.models;

  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });

  if (!response.ok) throw new Error(`OpenRouter models list failed: ${response.status}`);

  const payload = (await response.json()) as { data?: RawModel[] };
  const models = (payload.data ?? [])
    .filter((model) => model.id.endsWith(":free"))
    .map<FreeModel>((model) => {
      const params = model.supported_parameters ?? [];
      return {
        id: model.id,
        name: model.name ?? model.id,
        contextLength: model.context_length ?? 0,
        supportsTools: params.includes("tools"),
        supportsJsonMode: params.includes("response_format") || params.includes("structured_outputs"),
      };
    })
    // Prefer models that can do both tools and JSON — those are the useful ones here.
    .sort((a, b) => Number(b.supportsTools) + Number(b.supportsJsonMode) - (Number(a.supportsTools) + Number(a.supportsJsonMode)));

  cache = { at: Date.now(), models };
  return models;
}

export function resetModelCache(): void {
  cache = null;
}
