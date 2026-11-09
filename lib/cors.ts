/**
 * CORS + caller authentication for the chat endpoint.
 *
 * Topology:
 *
 *   [ this bot on Vercel ]                 ← you are here
 *            ▲  x-bot-key  (+ CORS for browsers)
 *            │
 *   [ any page or app that wants to chat ]
 *
 * The browser page served at `/` is same-origin, so it needs no CORS at all;
 * these rules only matter when a *different* site wants to call the bot.
 * Server-to-server callers (no Origin header) skip CORS and use `x-bot-key`.
 */

import { getConfig } from "@/lib/config";

export function corsHeaders(origin: string | null): Record<string, string> {
  const { allowedOrigins } = getConfig();

  // No origin → server-to-server call: no CORS headers needed.
  if (!origin) return {};

  const allowed =
    allowedOrigins.includes("*") ||
    allowedOrigins.some((entry) => entry.toLowerCase() === origin.toLowerCase());

  if (!allowed) return { Vary: "Origin" };

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,x-bot-key,x-request-id",
    "Access-Control-Max-Age": "600",
    "Access-Control-Expose-Headers": "x-request-id",
    Vary: "Origin",
  };
}

export function isOriginBlocked(origin: string | null): boolean {
  const { allowedOrigins } = getConfig();
  if (!origin) return false; // server-to-server
  if (allowedOrigins.length === 0) return true; // nothing configured → browsers blocked
  if (allowedOrigins.includes("*")) return false;
  return !allowedOrigins.some((entry) => entry.toLowerCase() === origin.toLowerCase());
}

/** Applies CORS headers to any Response. */
export function withCors(response: Response, origin: string | null): Response {
  const headers = corsHeaders(origin);
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  return response;
}

/** Shared machine-to-machine credential check (x-bot-key or Bearer). */
export function hasValidBotKey(request: Request): boolean {
  const { botApiKey } = getConfig();
  if (!botApiKey) return true; // protection disabled on purpose (local/dev)

  const header = request.headers.get("x-bot-key") ?? "";
  const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return header === botApiKey || bearer === botApiKey;
}

export function preflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}
