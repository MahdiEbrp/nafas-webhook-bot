/**
 * ADVANCED CACHE & TIME TRAVEL PREFETCHING
 *
 * Provides:
 *   1. Advanced in-memory caching with TTL, tag-based invalidation, and LRU eviction.
 *   2. In-flight promise coalescing / deduplication (no duplicate parallel fetches).
 *   3. "Time Travel" predictive prefetching: anticipates user clicks and background-fetches
 *      the next page, related categories, or suggested read actions so that responses
 *      appear instantly with 0ms network latency.
 */

import { callWebhook, type WebhookRequest, type WebhookResult } from "@/lib/webhooks/client";
import { getAction } from "@/lib/features/manifest";
import { logInfo } from "@/lib/log";

export type CacheEntry = {
  data: unknown;
  status: number;
  ok: boolean;
  code?: string;
  message?: string;
  requestId: string;
  cachedAt: number;
  expiresAt: number;
  tags: string[];
  isPrefetched: boolean;
};

export type CacheStats = {
  hits: number;
  misses: number;
  prefetches: number;
  timeTravelHits: number;
  invalidations: number;
  size: number;
};

const DEFAULT_TTL_MS = 3 * 60 * 1000; // 3 minutes
const MAX_CACHE_ENTRIES = 500;

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<WebhookResult>>();

const stats: CacheStats = {
  hits: 0,
  misses: 0,
  prefetches: 0,
  timeTravelHits: 0,
  invalidations: 0,
  size: 0,
};

export function buildCacheKey(request: Pick<WebhookRequest, "method" | "path" | "query" | "pathParams">): string {
  const method = request.method.toUpperCase();
  let path = request.path;
  if (request.pathParams) {
    for (const [k, v] of Object.entries(request.pathParams)) {
      path = path.replace(`:${k}`, String(v));
    }
  }

  const queryParts: string[] = [];
  if (request.query) {
    const sortedKeys = Object.keys(request.query).sort();
    for (const k of sortedKeys) {
      const val = request.query[k];
      if (val !== undefined && val !== null && val !== "") {
        queryParts.push(`${k}=${String(val)}`);
      }
    }
  }

  return `${method}:${path}${queryParts.length > 0 ? `?${queryParts.join("&")}` : ""}`;
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now > entry.expiresAt) cache.delete(key);
  }
  stats.size = cache.size;
}

function enforceCapacity(): void {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  // Evict oldest entries
  const entries = Array.from(cache.entries()).sort((a, b) => a[1].cachedAt - b[1].cachedAt);
  const toEvict = entries.slice(0, cache.size - MAX_CACHE_ENTRIES);
  for (const [key] of toEvict) {
    cache.delete(key);
  }
  stats.size = cache.size;
}

export function getFromCache(key: string): { entry: CacheEntry; timeTravelHit: boolean } | null {
  sweepExpired();
  const entry = cache.get(key);
  if (!entry) {
    stats.misses++;
    return null;
  }

  stats.hits++;
  const timeTravelHit = entry.isPrefetched;
  if (timeTravelHit) stats.timeTravelHits++;

  return { entry, timeTravelHit };
}

export function setCache(
  key: string,
  result: WebhookResult,
  tags: string[],
  ttlMs = DEFAULT_TTL_MS,
  isPrefetched = false,
): void {
  const now = Date.now();
  if (result.ok) {
    cache.set(key, {
      data: result.data,
      status: result.status,
      ok: true,
      requestId: result.requestId,
      cachedAt: now,
      expiresAt: now + ttlMs,
      tags,
      isPrefetched,
    });
  } else {
    // Only short-cache 404s, don't cache 500s or timeouts
    if (result.status === 404) {
      cache.set(key, {
        data: null,
        status: result.status,
        ok: false,
        code: result.code,
        message: result.message,
        requestId: result.requestId,
        cachedAt: now,
        expiresAt: now + 30_000,
        tags,
        isPrefetched,
      });
    }
  }
  enforceCapacity();
  stats.size = cache.size;
}

/** Purges cache entries matching any of the given tags (e.g. ['services'] on services.update). */
export function invalidateTags(tags: string[]): number {
  if (tags.length === 0) return 0;
  const tagSet = new Set(tags);
  let count = 0;

  for (const [key, entry] of cache) {
    if (entry.tags.some((tag) => tagSet.has(tag))) {
      cache.delete(key);
      count++;
    }
  }

  stats.invalidations += count;
  stats.size = cache.size;
  return count;
}

/** Invalidate by resource name, e.g. "services", "bookings". */
export function invalidateResource(resource: string): number {
  return invalidateTags([resource]);
}

/**
 * Fetch with advanced caching and in-flight promise coalescing.
 */
export async function fetchWithCache(
  request: WebhookRequest,
  options?: { tags?: string[]; ttlMs?: number; isPrefetch?: boolean },
): Promise<WebhookResult & { fromCache?: boolean; timeTravel?: boolean }> {
  // Only cache GET read requests
  if (request.method !== "GET") {
    // Invalidate related tags upon write/delete
    const pathResource = request.path.replace(/^\/api\/v1\/webhooks\//, "").split("/")[0] ?? "";
    if (pathResource) invalidateResource(pathResource);
    return callWebhook(request);
  }

  const key = buildCacheKey(request);
  const cached = getFromCache(key);

  if (cached) {
    const { entry, timeTravelHit } = cached;
    if (entry.ok) {
      return {
        ok: true,
        status: entry.status,
        data: entry.data,
        requestId: entry.requestId,
        ms: 0,
        fromCache: true,
        timeTravel: timeTravelHit,
      };
    } else {
      return {
        ok: false,
        status: entry.status,
        code: entry.code ?? "UNKNOWN_ERROR",
        message: entry.message ?? "",
        requestId: entry.requestId,
        ms: 0,
        fromCache: true,
        timeTravel: timeTravelHit,
      };
    }
  }

  // Deduplicate in-flight requests for the same key
  let promise = inFlight.get(key);
  if (!promise) {
    promise = callWebhook(request);
    inFlight.set(key, promise);
  }

  try {
    const result = await promise;
    const pathResource = request.path.replace(/^\/api\/v1\/webhooks\//, "").split("/")[0] ?? "";
    const tags = options?.tags ?? (pathResource ? [pathResource] : []);
    setCache(key, result, tags, options?.ttlMs, options?.isPrefetch ?? false);
    return result;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * TIME TRAVEL PREFETCHING
 * Predicts and eagerly fetches what the user will click next.
 * Spawns promises concurrently in the background and populates the cache.
 */
export function prefetchPredictedActions(
  predictions: Array<{
    actionId: string;
    query?: Record<string, string | number | boolean | undefined>;
    pathParams?: Record<string, string>;
  }>,
): Promise<void[]> {
  const promises: Array<Promise<void>> = [];

  for (const pred of predictions) {
    const found = getAction(pred.actionId);
    if (!found || found.action.danger !== "read") continue;

    const req: WebhookRequest = {
      method: "GET",
      path: found.action.path,
      query: pred.query,
      pathParams: pred.pathParams,
    };

    const key = buildCacheKey(req);
    // Skip if already fresh in cache
    if (cache.has(key) && cache.get(key)!.expiresAt > Date.now()) continue;

    stats.prefetches++;
    const p = fetchWithCache(req, {
      tags: [found.feature.id],
      isPrefetch: true,
    })
      .then(() => {
        logInfo("time_travel.prefetched", { actionId: pred.actionId, key });
      })
      .catch(() => {
        // Prefetch errors are non-critical
      });

    promises.push(p);
  }

  return Promise.all(promises);
}

export function getCacheStats(): CacheStats {
  return { ...stats };
}

export function clearCacheForTesting(): void {
  cache.clear();
  inFlight.clear();
  stats.hits = 0;
  stats.misses = 0;
  stats.prefetches = 0;
  stats.timeTravelHits = 0;
  stats.invalidations = 0;
  stats.size = 0;
}
