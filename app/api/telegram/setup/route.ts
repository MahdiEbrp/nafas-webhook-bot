import { getConfig } from "@/lib/config";
import { hasValidBotKey } from "@/lib/cors";
import { ApiError, jsonOk, readJsonBody, withApiHandler } from "@/lib/errors";
import { logInfo } from "@/lib/log";
import { ensureWebhook, webhookUrlFor } from "@/lib/telegram/setup";
import { deleteWebhook, getMe, getWebhookInfo } from "@/lib/telegram/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Manual control over the Telegram "login".
 *
 *   GET  /api/telegram/setup            → status only (never changes anything)
 *   POST /api/telegram/setup            → register/repair the webhook  { force?, dropPendingUpdates? }
 *   POST /api/telegram/setup { logout: true } → unregister (delete webhook)
 *
 * Protected by BOT_API_KEY: whoever can call this decides where Telegram
 * delivers the bot's messages.
 */
function requireKey(request: Request): void {
  if (!hasValidBotKey(request)) throw new ApiError(401, "UNAUTHORIZED", "Missing or invalid bot key.");
}

export const GET = withApiHandler(async (request) => {
  requireKey(request);
  const { telegram } = getConfig();

  if (!telegram.botToken) {
    return jsonOk({
      configured: false,
      message: "TELEGRAM_BOT_TOKEN is not set.",
      expectedWebhookUrl: telegram.publicUrl ? webhookUrlFor(telegram.publicUrl) : null,
    });
  }

  const [me, info] = await Promise.all([getMe(), getWebhookInfo()]);
  const expected = telegram.publicUrl ? webhookUrlFor(telegram.publicUrl) : null;

  return jsonOk({
    configured: true,
    tokenValid: me.ok,
    bot: me.ok ? { id: me.result.id, username: me.result.username, name: me.result.first_name } : null,
    expectedWebhookUrl: expected,
    webhook: info.ok
      ? {
          url: info.result.url || null,
          pendingUpdates: info.result.pending_update_count,
          lastError: info.result.last_error_message ?? null,
          matchesConfig: Boolean(expected) && info.result.url === expected,
        }
      : { error: info.description },
    allowlist: telegram.allowedChatIds,
    autoSetup: telegram.autoSetup,
  });
});

export const POST = withApiHandler(async (request) => {
  requireKey(request);

  let body: { force?: boolean; dropPendingUpdates?: boolean; logout?: boolean } = {};
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const parsed = (await readJsonBody(request)) as Record<string, unknown>;
    body = {
      force: parsed.force === true,
      dropPendingUpdates: parsed.dropPendingUpdates === true,
      logout: parsed.logout === true,
    };
  }

  if (body.logout) {
    const removed = await deleteWebhook();
    logInfo("telegram.logout", { ok: removed.ok });
    return jsonOk({ loggedOut: removed.ok, message: removed.ok ? "Webhook removed." : removed.description });
  }

  const report = await ensureWebhook({ force: body.force, dropPendingUpdates: body.dropPendingUpdates });
  logInfo("telegram.manual_setup", { action: report.action, url: report.webhookUrl ?? null });
  return jsonOk(report);
});

export const OPTIONS = withApiHandler(async () => new Response(null, { status: 204 }));
