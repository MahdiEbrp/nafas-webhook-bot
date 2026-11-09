/**
 * Per-model runtime stats — the *measured* half of model selection.
 *
 * OpenRouter's `/api/v1/models` has no latency or quality field, so speed is
 * something we have to measure ourselves. Every completion records how long the
 * model actually took; failures start a cooldown so a model that is currently
 * rate-limited stops being picked first.
 *
 * Process memory on purpose (same trade-off as `lib/bot/session.ts`): a warm
 * function learns its own numbers within a few messages, which is all we need.
 */

export type ModelStat = {
  /** exponentially weighted average of successful call times, ms */
  latencyMs: number | null;
  /** fastest successful call seen, ms */
  bestMs: number | null;
  samples: number;
  /** lifetime failure count, for /api/health */
  failures: number;
  /** failures since the last success — drives how long the cooldown grows */
  consecutiveFailures: number;
  lastStatus: number | null;
  lastError: string | null;
  lastUsedAt: number;
  /** until this timestamp the model is pushed to the back of the queue */
  cooldownUntil: number;
};

/** New observations matter, old ones fade: 35% weight on the newest sample. */
const EWMA_ALPHA = 0.35;

const stats = new Map<string, ModelStat>();

function emptyStat(): ModelStat {
  return {
    latencyMs: null,
    bestMs: null,
    samples: 0,
    failures: 0,
    consecutiveFailures: 0,
    lastStatus: null,
    lastError: null,
    lastUsedAt: 0,
    cooldownUntil: 0,
  };
}

function get(id: string): ModelStat {
  let stat = stats.get(id);
  if (!stat) {
    stat = emptyStat();
    stats.set(id, stat);
  }
  return stat;
}

export function recordSuccess(model: string, ms: number, now = Date.now()): ModelStat {
  const stat = get(model);
  stat.latencyMs = stat.latencyMs === null ? ms : stat.latencyMs * (1 - EWMA_ALPHA) + ms * EWMA_ALPHA;
  stat.bestMs = stat.bestMs === null ? ms : Math.min(stat.bestMs, ms);
  stat.samples += 1;
  stat.lastUsedAt = now;
  // A model that just answered is healthy again.
  stat.consecutiveFailures = 0;
  stat.cooldownUntil = 0;
  return stat;
}

/**
 * Penalises a model that failed. `cooldownMs` should grow with the number of
 * recent failures, but a success always clears it — see `recordSuccess`.
 */
export function recordFailure(model: string, input: { status: number | null; error: string; cooldownMs: number }, now = Date.now()): ModelStat {
  const stat = get(model);
  stat.failures += 1;
  stat.consecutiveFailures += 1;
  stat.lastStatus = input.status;
  stat.lastError = input.error;
  stat.lastUsedAt = now;
  stat.cooldownUntil = Math.max(stat.cooldownUntil, now + input.cooldownMs);
  return stat;
}

export function getStat(model: string): ModelStat | undefined {
  return stats.get(model);
}

/** Snapshot for /api/health and `npm run models`. Sorted by latency, measured first. */
export function statsSnapshot(now = Date.now()): Array<ModelStat & { id: string; coolingDown: boolean }> {
  return [...stats.entries()]
    .map(([id, stat]) => ({ id, ...stat, coolingDown: stat.cooldownUntil > now }))
    .sort((a, b) => {
      if (a.latencyMs === null && b.latencyMs === null) return a.id.localeCompare(b.id);
      if (a.latencyMs === null) return 1;
      if (b.latencyMs === null) return -1;
      return a.latencyMs - b.latencyMs;
    });
}

export function resetStatsForTesting(): void {
  stats.clear();
}
