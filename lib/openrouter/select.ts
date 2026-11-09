/**
 * Model selection — builds the chain `complete()` will walk.
 *
 *   live catalog → curated quality prior → measured speed → cooldowns → top N
 *
 * Three rules keep this from being clever at the wrong time:
 *
 *   1. **Never empty.** If the catalog cannot be fetched, we fall back to the
 *      configured chain. A chat bot that cannot talk is worse than one that
 *      talks on a slightly older model.
 *   2. **Never drop, only sink.** A model that just 429'd moves to the back of
 *      the queue instead of being removed; free pools recover within a minute.
 *   3. **Always explore.** One slot of the pool is reserved for a model we have
 *      not measured yet, otherwise the first model that answered would stay the
 *      "fastest" forever and we would stop learning.
 */

import { getConfig } from "@/lib/config";
import { logInfo } from "@/lib/log";

import { getStat } from "./stats";
import { listFreeModels } from "./models";
import { rankModels, type ScoredModel } from "./ranking";

export type SelectionSource = "auto" | "fixed" | "fallback";

export type Selection = {
  chain: string[];
  source: SelectionSource;
  /** how many :free models the catalog offered */
  catalogSize: number;
  /** how many survived the context filter and were scored */
  considered: number;
  /** the ranked head — what /api/health and `npm run models` show */
  top: ScoredModel[];
  generatedAt: number;
  note: string | null;
};

function fixedSelection(source: SelectionSource, note: string | null): Selection {
  const { modelChain } = getConfig();
  return { chain: modelChain, source, catalogSize: 0, considered: 0, top: [], generatedAt: Date.now(), note };
}

export async function selectChain(options: { quiet?: boolean } = {}): Promise<Selection> {
  const config = getConfig();

  if (config.modelSelection === "fixed") {
    return fixedSelection("fixed", "MODEL_SELECTION=fixed — using OPENROUTER_MODELS as given");
  }

  let catalog;
  try {
    catalog = await listFreeModels();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return fixedSelection("fallback", `catalog unavailable (${message}) — using the configured chain`);
  }

  const ranked = rankModels(catalog, (id) => getStat(id), {
    pinned: config.modelChain,
    minContext: config.modelMinContext,
  });

  if (ranked.length === 0) {
    return fixedSelection("fallback", "the catalog had no usable free models — using the configured chain");
  }

  const poolSize = Math.max(1, Math.min(config.modelPoolSize, ranked.length));
  const pool = ranked.slice(0, poolSize);

  // Exploration: keep learning the speed of models we have never timed.
  const allMeasured = pool.every((model) => model.samples > 0);
  if (allMeasured && pool.length > 1) {
    const untried = ranked
      .slice(poolSize)
      .find((model) => model.samples === 0 && !model.coolingDown);
    if (untried) {
      pool[pool.length - 1] = untried;
    }
  }

  const chain = pool.map((model) => model.id);
  if (!options.quiet) logInfo("openrouter.chain_selected", {
    chain,
    catalogSize: catalog.length,
    considered: ranked.length,
    top: pool.map((model) => `${model.id}(${model.score})`).join(" > "),
  });

  return {
    chain,
    source: "auto",
    catalogSize: catalog.length,
    considered: ranked.length,
    top: ranked.slice(0, Math.max(poolSize, 8)),
    generatedAt: Date.now(),
    note: null,
  };
}
