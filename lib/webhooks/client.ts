/**
 * Typed-ish client for the existing project's `/api/v1/webhooks/*` API.
 *
 * It reproduces exactly what those routes expect:
 *   • HTTP Basic auth (username = service user's email, password)
 *   • Authorization + permission checks done by the target project
 *   • `Content-Type: application/json` on writes
 *   • `x-request-id` echoed back, so a bot conversation can be traced in logs
 *
 * Nothing here decides *what* to do — that is the AI's job. This module only
 * turns "action + params" into a correct HTTP request and a normalised result.
 */

import { getConfig } from "@/lib/config";
import { logInfo, logWarn } from "@/lib/log";
import { truncate } from "@/lib/text";

export type WebhookRequest = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** e.g. "/api/v1/webhooks/bookings/:id" */
  path: string;
  pathParams?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

export type WebhookResult =
  | {
      ok: true;
      status: number;
      data: unknown;
      requestId: string;
      ms: number;
    }
  | {
      ok: false;
      status: number;
      /** machine code from the target project, e.g. FORBIDDEN / RATE_LIMITED */
      code: string;
      message: string;
      requestId: string;
      ms: number;
    };

function authHeader(): string {
  const { webhookUsername, webhookPassword } = getConfig();
  return `Basic ${Buffer.from(`${webhookUsername}:${webhookPassword}`).toString("base64")}`;
}

function buildPath(path: string, params: Record<string, string> | undefined): string {
  if (!params) return path;
  return path.replace(/:([a-zA-Z_]+)/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : encodeURIComponent(value);
  });
}

function buildQuery(query: WebhookRequest["query"]): string {
  if (!query) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : "";
}

/**
 * Diagnostics for failed calls: what we actually *sent*.
 *
 * Without it, a `VALIDATION_ERROR` from the target project is undebuggable —
 * the log says "the query was invalid" but not which parameter was in it.
 * `search` / `phone` / `email` / `name` are masked because they hold personal
 * data (a staff phone number is not a log field).
 */
function redactQuery(query: WebhookRequest["query"]): Record<string, string | number | boolean> | undefined {
  if (!query) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = /search|phone|email|name/i.test(key) ? "[redacted]" : value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Map the target project's error payload onto our own codes. */
function errorFromPayload(status: number, payload: unknown): { code: string; message: string } {
  const asRecord = payload as { error?: { code?: string; message?: string }; message?: string } | null;
  const code = asRecord?.error?.code ?? `HTTP_${status}`;
  const message = asRecord?.error?.message ?? asRecord?.message ?? `Request failed with status ${status}`;

  switch (status) {
    case 401:
      return { code: "WEBHOOK_UNAUTHORIZED", message: "The bot's webhook credentials were rejected." };
    case 403:
      return { code: "WEBHOOK_FORBIDDEN", message: "The bot's service user lacks the required permission." };
    case 404:
      return { code: "NOT_FOUND", message: "That record does not exist." };
    case 415:
      return { code: "UNSUPPORTED_MEDIA_TYPE", message: "Payload was not JSON." };
    case 429:
      return { code: "WEBHOOK_RATE_LIMITED", message: "The webhook API is temporarily rate limited." };
    default:
      return { code, message };
  }
}

export async function callWebhook(request: WebhookRequest, options?: { timeoutMs?: number }): Promise<WebhookResult> {
  const config = getConfig();
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? 20_000;

  if (!config.webhookBaseUrl) {
    return {
      ok: false,
      status: 0,
      code: "WEBHOOK_NOT_CONFIGURED",
      message: "WEBHOOK_BASE_URL is not configured.",
      requestId,
      ms: 0,
    };
  }

  const url = `${config.webhookBaseUrl}${buildPath(request.path, request.pathParams)}${buildQuery(request.query)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: request.method,
      headers: {
        Authorization: authHeader(),
        Accept: "application/json",
        "x-request-id": requestId,
        ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: controller.signal,
      cache: "no-store",
    });

    const rawText = await response.text();
    let payload: unknown = null;
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = { message: truncate(rawText, 500) };
      }
    }

    const ms = Date.now() - startedAt;

    if (!response.ok) {
      const { code, message } = errorFromPayload(response.status, payload);
      // NOTE: for a 400 the code/message are the *target project's* — e.g.
      // VALIDATION_ERROR means its query/body schema rejected what we sent,
      // so log the query (masked) and the target's message, not just the code.
      logWarn("webhook.call_failed", {
        requestId,
        method: request.method,
        path: request.path,
        pathParams: request.pathParams,
        query: redactQuery(request.query),
        status: response.status,
        code,
        message,
        ms,
      });
      return { ok: false, status: response.status, code, message, requestId, ms };
    }

    // The target project wraps successes as { ok: true, data: ... }
    const unwrapped =
      payload && typeof payload === "object" && "data" in (payload as Record<string, unknown>)
        ? (payload as Record<string, unknown>).data
        : payload;

    logInfo("webhook.call_ok", { requestId, method: request.method, path: request.path, status: response.status, ms });
    return { ok: true, status: response.status, data: unwrapped, requestId, ms };
  } catch (error) {
    const ms = Date.now() - startedAt;
    const aborted = error instanceof Error && error.name === "AbortError";
    const code = aborted ? "WEBHOOK_TIMEOUT" : "WEBHOOK_UNREACHABLE";
    const message = aborted
      ? `The webhook API did not answer within ${timeoutMs}ms.`
      : `Could not reach the webhook API (${error instanceof Error ? error.message : "unknown error"}).`;

    logWarn("webhook.call_error", { requestId, method: request.method, path: request.path, code, ms });
    return { ok: false, status: 0, code, message, requestId, ms };
  } finally {
    clearTimeout(timeout);
  }
}

/** Convenience wrappers so callers read nicely. */
export const webhooks = {
  list: (path: string, query?: WebhookRequest["query"]) => callWebhook({ method: "GET", path, query }),
  get: (path: string, id: string) => callWebhook({ method: "GET", path, pathParams: { id } }),
  create: (path: string, body: unknown) => callWebhook({ method: "POST", path, body }),
  update: (path: string, id: string, body: unknown) =>
    callWebhook({ method: "PATCH", path, pathParams: { id }, body }),
  remove: (path: string, id: string) => callWebhook({ method: "DELETE", path, pathParams: { id } }),
};
