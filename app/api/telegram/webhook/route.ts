import { getConfig } from "@/lib/config";
import { jsonOk, withApiHandler } from "@/lib/errors";
import { logInfo, logWarn } from "@/lib/log";
import { handleTelegramUpdate } from "@/lib/telegram/handler";
import type { TelegramUpdate } from "@/lib/telegram/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Telegram calls this URL. Three rules matter here:
 *
 *  1. Always answer 200 — a non-2xx makes Telegram retry the same update, which
 *     would run the action twice (imagine a booking created twice).
 *  2. Verify `X-Telegram-Bot-Api-Secret-Token`, otherwise anyone can POST fake
 *     updates and drive the clinic system.
 *  3. De-duplicate `update_id` for the same reason as (1).
 */

const seen = new Map<number, number>();
const SEEN_TTL_MS = 10 * 60 * 1000;

function alreadyHandled(updateId: number): boolean {
  const now = Date.now();
  for (const [id, at] of seen) if (now - at > SEEN_TTL_MS) seen.delete(id);
  if (seen.has(updateId)) return true;
  seen.set(updateId, now);
  return false;
}

export const POST = withApiHandler(async (request) => {
  const { telegram } = getConfig();

  if (!telegram.botToken) {
    logWarn("telegram.not_configured", {});
    return jsonOk({ skipped: true, reason: "TELEGRAM_BOT_TOKEN is not set" });
  }

  if (telegram.webhookSecret) {
    const got = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (got !== telegram.webhookSecret) {
      logWarn("telegram.bad_secret", {});
      // 401 here is safe: Telegram will keep retrying, but a real attacker stops.
      return new Response(JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "Bad secret token" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return jsonOk({ skipped: true, reason: "invalid json" });
  }

  if (typeof update.update_id === "number" && alreadyHandled(update.update_id)) {
    logInfo("telegram.duplicate", { updateId: update.update_id });
    return jsonOk({ skipped: true, reason: "duplicate" });
  }

  try {
    const outcome = await handleTelegramUpdate(update);
    return jsonOk(outcome);
  } catch (error) {
    // Never 500 back to Telegram — it would retry and possibly repeat the action.
    logWarn("telegram.update_failed", { message: error instanceof Error ? error.message : "unknown" });
    return jsonOk({ handled: false, reason: "internal error" });
  }
});

export const GET = withApiHandler(async () =>
  jsonOk({
    endpoint: "POST /api/telegram/webhook",
    note: "Telegram calls this. Use GET /api/telegram/setup to register or inspect the webhook.",
  }),
);
