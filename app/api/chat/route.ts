import { z } from "zod";

import { handleChat } from "@/lib/bot";
import { getConfig } from "@/lib/config";
import { hasValidBotKey, isOriginBlocked, preflight, withCors } from "@/lib/cors";
import { ApiError, jsonOk, readJsonBody, withApiHandler } from "@/lib/errors";
import { logInfo } from "@/lib/log";
import { clientKey, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const chatBodySchema = z
  .object({
    message: z.string().trim().min(1, "message is required").max(4000),
    sessionId: z.string().trim().min(1).max(100).optional(),
    locale: z.enum(["fa", "en"]).optional(),
  })
  .strict();

export const POST = withApiHandler(async (request) => {
  const config = getConfig();
  const origin = request.headers.get("origin");

  if (isOriginBlocked(origin)) {
    throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "This origin is not allowed to call the bot.");
  }

  const limit = rateLimit(`chat:${clientKey(request)}`, config.chatRateLimit.limit, config.chatRateLimit.windowMs);
  if (!limit.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many messages. Wait a minute and try again.");
  }

  if (!hasValidBotKey(request)) {
    throw new ApiError(401, "UNAUTHORIZED", "Missing or invalid bot key.");
  }

  const body = chatBodySchema.safeParse(await readJsonBody(request));
  if (!body.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "Invalid request body.", body.error.issues);
  }

  const sessionId = body.data.sessionId ?? `anon-${clientKey(request)}`;
  const startedAt = Date.now();

  const result = await handleChat({
    message: body.data.message,
    sessionId,
    locale: body.data.locale ?? config.defaultLocale,
  });

  logInfo("chat.handled", {
    sessionId,
    status: result.status,
    model: result.model,
    contextMessages: result.contextMessages,
    ms: Date.now() - startedAt,
  });

  return withCors(jsonOk({ ...result, sessionId }), origin);
});

export const OPTIONS = withApiHandler(async (request) => preflight(request));

export const GET = withApiHandler(async () =>
  jsonOk({
    endpoint: "POST /api/chat",
    body: {
      message: "string (Persian or English)",
      sessionId: "string (optional, keeps the conversation together)",
      locale: "'fa' | 'en' (optional)",
    },
    example: {
      message: "سلام، حالت چطوره؟",
      sessionId: "demo-session",
    },
    statuses: ["answered", "empty", "error"],
  }),
);
