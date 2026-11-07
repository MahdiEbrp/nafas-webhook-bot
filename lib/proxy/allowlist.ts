/**
 * Path allowlist for the raw passthrough endpoint (`/api/proxy/*`).
 *
 * The middleware is not an open proxy: a forwarded request must match one of the
 * manifest actions exactly (method + path shape). That keeps the upstream site
 * safe even if the bot key leaks, and it means there is exactly one place that
 * describes "what may be called" — the manifest.
 */

import { FEATURES, type Feature, type FeatureAction } from "@/lib/features/manifest";

export type AllowedCall = { feature: Feature; action: FeatureAction };

function pathToRegex(path: string): RegExp {
  // "/api/v1/webhooks/bookings/:id" → ^/api/v1/webhooks/bookings/[^/]+/?$
  const pattern = path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${pattern}/?$`, "i");
}

const COMPILED: Array<{ regex: RegExp; feature: Feature; action: FeatureAction }> = FEATURES.flatMap((feature) =>
  feature.actions.map((action) => ({ regex: pathToRegex(action.path), feature, action })),
);

export function matchAllowedCall(method: string, pathname: string): AllowedCall | null {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  for (const entry of COMPILED) {
    if (entry.action.method !== method.toUpperCase()) continue;
    if (entry.regex.test(normalizedPath)) return { feature: entry.feature, action: entry.action };
  }
  return null;
}

/** Extracts `:id` style params out of an incoming path, for the upstream call. */
export function extractPathParams(action: FeatureAction, pathname: string): Record<string, string> {
  const incoming = pathname.split("/").filter(Boolean);
  const declared = action.path.split("/").filter(Boolean);
  const params: Record<string, string> = {};

  declared.forEach((segment, index) => {
    if (segment.startsWith(":")) {
      const value = incoming[index];
      if (value) params[segment.slice(1)] = decodeURIComponent(value);
    }
  });

  return params;
}

export function allowedSummary(): { method: string; path: string; permission: string; danger: string }[] {
  return COMPILED.map((entry) => ({
    method: entry.action.method,
    path: entry.action.path,
    permission: entry.action.permission,
    danger: entry.action.danger,
  }));
}
