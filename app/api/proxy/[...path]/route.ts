import { getConfig } from "@/lib/config";
import { hasValidBotKey, isOriginBlocked, preflight, withCors } from "@/lib/cors";
import { ApiError, jsonOk, readJsonBody, withApiHandler } from "@/lib/errors";
import { allowedSummary, extractPathParams, matchAllowedCall } from "@/lib/proxy/allowlist";
import { logInfo, logWarn } from "@/lib/log";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { callWebhook } from "@/lib/webhooks/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Context = { params: Promise<{ path: string[] }> };

/**
 * PASSTHROUGH MODE — the "واسط" role, without AI.
 *
 * The Vercel project (or any trusted caller) can ask this middleware to forward
 * a webhook call it already knows it wants:
 *
 *   POST /api/proxy/api/v1/webhooks/bookings
 *   GET  /api/proxy/api/v1/webhooks/bookings?status=pending
 *   PATCH/api/proxy/api/v1/webhooks/bookings/<uuid>
 *
 * Why bother, if the caller could hit the clinic directly?
 *   • the upstream password lives only in this app's env (never in a browser),
 *   • only manifest actions are allowed through (no open proxy),
 *   • one rate limit + one audit log for everything,
 *   • the upstream host never has to expose CORS to end users.
 *
 * Use `/api/chat` when you want the AI; use this when you already know the call.
 */
async function forward(request: Request, context: Context, method: string): Promise<Response> {
  const origin = request.headers.get("origin");

  if (isOriginBlocked(origin)) {
    throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "This origin is not allowed to call the middleware.");
  }

  if (!hasValidBotKey(request)) {
    throw new ApiError(401, "UNAUTHORIZED", "Missing or invalid bot key.");
  }

  const config = getConfig();
  const limit = rateLimit(`proxy:${clientKey(request)}`, config.chatRateLimit.limit * 3, config.chatRateLimit.windowMs);
  if (!limit.allowed) throw new ApiError(429, "RATE_LIMITED", "Too many requests. Wait a minute and try again.");

  const { path } = await context.params;
  const pathname = `/${(path ?? []).join("/")}`;

  const match = matchAllowedCall(method, pathname);
  if (!match) {
    logWarn("proxy.not_allowed", { method, path: pathname });
    throw new ApiError(404, "NOT_ALLOWED", "This method/path is not part of the allowed webhook surface.", {
      hint: "GET /api/features lists every allowed action.",
      allowedCount: allowedSummary().length,
    });
  }

  const url = new URL(request.url);
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) query[key] = value;

  const body = ["POST", "PATCH", "PUT"].includes(method) ? await readJsonBody(request) : undefined;

  const result = await callWebhook({
    method: method as "GET" | "POST" | "PATCH" | "DELETE",
    path: match.action.path,
    pathParams: extractPathParams(match.action, pathname),
    query,
    body,
  });

  logInfo("proxy.forwarded", {
    method,
    path: match.action.path,
    actionId: match.action.id,
    ok: result.ok,
    status: result.status,
    ms: result.ms,
    requestId: result.requestId,
  });

  // Same envelope as the upstream, so a client can treat both identically.
  if (!result.ok) {
    return Response.json(
      {
        ok: false,
        error: { code: result.code, message: result.message },
        requestId: result.requestId,
        actionId: match.action.id,
      },
      { status: result.status >= 400 && result.status < 600 ? result.status : 502 },
    );
  }

  return jsonOk(result.data, result.status, result.requestId);
}

export const GET = withApiHandler((request, ctx: Context) => forward(request, ctx, "GET"));
export const POST = withApiHandler((request, ctx: Context) => forward(request, ctx, "POST"));
export const PATCH = withApiHandler((request, ctx: Context) => forward(request, ctx, "PATCH"));
export const DELETE = withApiHandler((request, ctx: Context) => forward(request, ctx, "DELETE"));
export const OPTIONS = withApiHandler(async (request) => preflight(request));

/** GET /api/proxy — what is reachable through here. */
export const HEAD = withApiHandler(async (request) => withCors(jsonOk({ allowed: allowedSummary() }), request.headers.get("origin")));
