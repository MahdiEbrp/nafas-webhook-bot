/**
 * In-memory sliding-window rate limiter.
 *
 * Vercel functions are short-lived and can scale horizontally, so this protects
 * a single warm instance rather than the whole fleet. It is deliberate: free
 * OpenRouter models have a shared quota, and this stops one noisy client from
 * burning it. For hard limits, put Upstash/Redis behind the same interface.
 */

type Bucket = number[];

const buckets = new Map<string, Bucket>();
let lastCleanup = Date.now();
const CLEANUP_EVERY_MS = 60_000;

function cleanup(now: number): void {
  if (now - lastCleanup < CLEANUP_EVERY_MS) return;
  lastCleanup = now;
  for (const [key, hits] of buckets) {
    if (hits.length === 0) buckets.delete(key);
  }
}

export type RateLimitResult = { allowed: true; remaining: number; resetAt: number } | { allowed: false; remaining: 0; resetAt: number };

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  cleanup(now);

  const hits = (buckets.get(key) ?? []).filter((at) => now - at < windowMs);
  if (hits.length >= limit) {
    const oldest = hits[0] ?? now;
    buckets.set(key, hits);
    return { allowed: false, remaining: 0, resetAt: oldest + windowMs };
  }

  hits.push(now);
  buckets.set(key, hits);
  return { allowed: true, remaining: limit - hits.length, resetAt: now + windowMs };
}

export function resetRateLimitsForTesting(): void {
  buckets.clear();
  lastCleanup = Date.now();
}

export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  return ip;
}
