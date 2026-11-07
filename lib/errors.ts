/**
 * HTTP helpers shared by every route handler.
 *
 * The bot mirrors the error contract of the existing webhooks project:
 *   { ok: false, error: { code, message }, requestId }
 */

import { logError } from "@/lib/log";

export type ApiErrorBody = {
  ok: false;
  error: { code: string; message: string; details?: unknown };
  requestId: string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function jsonOk<T>(data: T, status = 200, requestId?: string): Response {
  return Response.json(
    { ok: true, data },
    {
      status,
      headers: requestId ? { "x-request-id": requestId } : undefined,
    },
  );
}

export function jsonError(
  code: string,
  message: string,
  status = 400,
  requestId?: string,
  details?: unknown,
): Response {
  const body: ApiErrorBody = {
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
    requestId: requestId ?? "",
  };
  return Response.json(body, {
    status,
    headers: requestId ? { "x-request-id": requestId } : undefined,
  });
}

export function handleApiError(error: unknown, requestId: string): Response {
  if (error instanceof ApiError) {
    if (error.status >= 500) logError("api.error", { requestId, code: error.code, message: error.message });
    return jsonError(error.code, error.message, error.status, requestId, error.details);
  }
  logError("api.unhandled", { requestId, error });
  return jsonError("INTERNAL_ERROR", "Something went wrong on our side.", 500, requestId);
}

/** Wraps a handler so every response carries x-request-id. */
export function withApiHandler<Args extends unknown[]>(
  handler: (request: Request, ...args: Args) => Promise<Response>,
): (request: Request, ...args: Args) => Promise<Response> {
  return async (request: Request, ...args: Args) => {
    const requestId = crypto.randomUUID();
    try {
      const response = await handler(request, ...args);
      response.headers.set("x-request-id", requestId);
      return response;
    } catch (error) {
      const response = handleApiError(error, requestId);
      response.headers.set("x-request-id", requestId);
      return response;
    }
  };
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
  }
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}
