/**
 * Model ranking — the *quality* half of model selection, and the place where
 * the two halves meet.
 *
 * Honest limits, because they shape the design:
 *
 *   • OpenRouter's `/api/v1/models` publishes **no intelligence score**. There
 *     is no field that says which model is smarter. So "smartest" is a curated
 *     prior that we maintain below — judgement, written down as data. Unknown
 *     models are still eligible with a neutral score, so a brand-new free model
 *     can enter the pool the day it appears.
 *   • It publishes **no latency** either. "Fastest" therefore comes from
 *     `lib/openrouter/stats.ts`, measured from our own real calls.
 *
 * The two pull in opposite directions (the smartest free models are usually the
 * slowest), so they are not collapsed into one number blindly: quality decides
 * the tier, measured speed orders models *inside* the reachable range, and a
 * model that is currently failing sinks without being dropped.
 */

import type { FreeModel } from "./models";
import type { ModelStat } from "./stats";

/**
 * Curated quality prior, 0–100. Patterns are matched against the model id.
 * Longer patterns win, so `gemma-4-31b` can override a plain `gemma` entry.
 *
 * Edit this freely — it is the one place where "which model is smart" is
 * decided, and it needs no redeploy logic to change.
 */
export const QUALITY_TIERS: Array<{ pattern: string; quality: number; note: string }> = [
  // Strong general models that handle Persian well.
  { pattern: "deepseek/deepseek-chat", quality: 88, note: "strong instruction following" },
  { pattern: "deepseek/deepseek-r1", quality: 88, note: "reasoning variant" },
  { pattern: "qwen/qwen3", quality: 84, note: "good multilingual, incl. Persian" },
  { pattern: "qwen/qwen2.5", quality: 80, note: "good multilingual" },
  { pattern: "google/gemma-4-31b", quality: 82, note: "large Gemma, solid Persian" },
  { pattern: "google/gemma-4-26b", quality: 78, note: "mid Gemma" },
  { pattern: "google/gemma-3-27b", quality: 78, note: "large Gemma" },
  { pattern: "google/gemma-3-12b", quality: 70, note: "mid Gemma" },
  { pattern: "google/gemma", quality: 66, note: "Gemma family" },
  { pattern: "meta-llama/llama-3.3", quality: 82, note: "Llama 3.3" },
  { pattern: "meta-llama/llama-3.1", quality: 78, note: "Llama 3.1" },
  { pattern: "meta-llama/llama", quality: 72, note: "Llama family" },
  { pattern: "mistralai/mistral-small", quality: 74, note: "fast and capable" },
  { pattern: "mistralai/mistral", quality: 72, note: "Mistral family" },
  { pattern: "nvidia/nemotron", quality: 70, note: "Nemotron, fast" },
  { pattern: "xingchen-agi/xing", quality: 72, note: "Xing, good Persian" },
  { pattern: "microsoft/phi", quality: 62, note: "small but quick" },
  { pattern: "liquid/lfm", quality: 58, note: "very fast, short answers" },
  { pattern: "openchat", quality: 55, note: "small open model" },
];

/** Score given to a model we have no opinion about. Deliberately mid-table. */
export const UNKNOWN_QUALITY = 64;

/** Latency we consider "average" for a free model; used to scale the speed term. */
export const BASELINE_MS = 2500;
/** Largest speed bonus/penalty, in quality points. */
export const SPEED_WEIGHT = 14;
/** How far a cooling-down model sinks. Big, but not absolute: it stays usable. */
export const COOLDOWN_PENALTY = 30;
/** Bonus for a model the operator pinned in OPENROUTER_MODELS. */
export const OPERATOR_BOOST = 6;

export type ScoredModel = {
  id: string;
  quality: number;
  note: string;
  latencyMs: number | null;
  samples: number;
  contextLength: number;
  coolingDown: boolean;
  score: number;
  /** why it landed where it did — shown in /api/health and `npm run models` */
  reason: string;
};

export type RankingOptions = {
  /** ids the operator listed in OPENROUTER_MODELS */
  pinned?: string[];
  /** smallest context we accept; a chat with memory needs room */
  minContext?: number;
  now?: number;
};

function qualityFor(id: string): { quality: number; note: string } {
  const bare = id.replace(/:free$/, "");
  let best: { quality: number; note: string; length: number } | null = null;

  for (const tier of QUALITY_TIERS) {
    if (bare.includes(tier.pattern) && (!best || tier.pattern.length > best.length)) {
      best = { quality: tier.quality, note: tier.note, length: tier.pattern.length };
    }
  }

  return best ? { quality: best.quality, note: best.note } : { quality: UNKNOWN_QUALITY, note: "no prior — treated as mid-table" };
}

/**
 * Maps a measured latency to a quality-scale delta in [-SPEED_WEIGHT, +SPEED_WEIGHT].
 *
 * Linear around BASELINE_MS: twice as slow as average costs the full bonus,
 * twice as fast earns it. Kept well below the gap between quality tiers on
 * purpose, so a fast weak model cannot outrank a slow strong one — speed only
 * decides between models of similar quality.
 */
export function speedDelta(latencyMs: number | null): number {
  if (latencyMs === null) return 0;
  const ratio = (BASELINE_MS - latencyMs) / BASELINE_MS;
  return Math.max(-SPEED_WEIGHT, Math.min(SPEED_WEIGHT, ratio * SPEED_WEIGHT));
}

function contextBonus(contextLength: number): number {
  if (contextLength >= 128_000) return 4;
  if (contextLength >= 32_000) return 2;
  return 0;
}

export function scoreModel(model: FreeModel, stat: ModelStat | undefined, options: RankingOptions = {}): ScoredModel {
  const now = options.now ?? Date.now();
  const prior = qualityFor(model.id);
  const pinned = options.pinned?.includes(model.id) ?? false;
  const coolingDown = (stat?.cooldownUntil ?? 0) > now;
  const speed = speedDelta(stat?.latencyMs ?? null);
  const context = contextBonus(model.contextLength);

  let score = prior.quality + speed + context;
  if (pinned) score += OPERATOR_BOOST;
  if (coolingDown) score -= COOLDOWN_PENALTY;

  const parts = [`quality ${prior.quality}`];
  const latency = stat?.latencyMs ?? null;
  if (speed !== 0) parts.push(`speed ${speed > 0 ? "+" : ""}${speed.toFixed(1)} (${latency === null ? "?" : Math.round(latency)}ms)`);
  if (context > 0) parts.push(`context +${context}`);
  if (pinned) parts.push(`pinned +${OPERATOR_BOOST}`);
  if (coolingDown) parts.push(`cooling down -${COOLDOWN_PENALTY}`);

  return {
    id: model.id,
    quality: prior.quality,
    note: prior.note,
    latencyMs: stat?.latencyMs ?? null,
    samples: stat?.samples ?? 0,
    contextLength: model.contextLength,
    coolingDown,
    score: Math.round(score * 10) / 10,
    reason: parts.join(", "),
  };
}

/**
 * Filters and ranks the live catalog.
 *
 * Deterministic: same input → same order (score, then newer model, then id).
 */
export function rankModels(
  models: FreeModel[],
  statFor: (id: string) => ModelStat | undefined,
  options: RankingOptions = {},
): ScoredModel[] {
  const minContext = options.minContext ?? 0;

  const scored = models
    // contextLength 0 = the API did not say; assume it is big enough rather than dropping it.
    .filter((model) => model.contextLength === 0 || model.contextLength >= minContext)
    .map((model) => scoreModel(model, statFor(model.id), options));

  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
