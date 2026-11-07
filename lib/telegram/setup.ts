/**
 * "AUTO LOGIN" — connect this app to Telegram, once, with no manual steps.
 *
 * Telegram bots do not have a login screen. The equivalent of logging in is:
 *
 *   1. getMe()        → prove the token is real ("who am I?")
 *   2. setWebhook()   → tell Telegram where to deliver updates ("here is my URL")
 *   3. getWebhookInfo()→ read back the registration ("did it stick?")
 *
 * `ensureWebhook()` is idempotent and cheap enough to call on every boot: it
 * only calls setWebhook when the registered URL/secret differ from the config,
 * so a restart does not churn the registration.
 */

import { getConfig } from "@/lib/config";
import { logError, logInfo, logWarn } from "@/lib/log";
import { getMe, getWebhookInfo, setWebhook, type WebhookInfo } from "@/lib/telegram/api";

export type SetupReport = {
  configured: boolean;
  tokenValid: boolean;
  bot?: { id: number; username?: string; firstName: string };
  publicUrl: string;
  webhookUrl?: string;
  match: boolean;
  pendingUpdates?: number;
  lastError?: string;
  /** what we did: "registered" | "unchanged" | "skipped" | "failed" */
  action: "registered" | "unchanged" | "skipped" | "failed";
  message: string;
};

export function webhookUrlFor(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/api/telegram/webhook`;
}

export async function ensureWebhook(options: { force?: boolean; dropPendingUpdates?: boolean } = {}): Promise<SetupReport> {
  const { telegram } = getConfig();

  const base: SetupReport = {
    configured: Boolean(telegram.botToken),
    tokenValid: false,
    publicUrl: telegram.publicUrl,
    match: false,
    action: "skipped",
    message: "",
  };

  if (!telegram.botToken) {
    logInfo("telegram.setup_skipped", { reason: "no token" });
    return { ...base, message: "TELEGRAM_BOT_TOKEN is not set — Telegram bridge is off." };
  }

  // 1. Is the token real?
  const me = await getMe();
  if (!me.ok) {
    logError("telegram.login_failed", { code: me.code, description: me.description });
    return { ...base, action: "failed", message: `Telegram rejected the token: ${me.description}` };
  }

  const bot = { id: me.result.id, username: me.result.username, firstName: me.result.first_name };
  logInfo("telegram.logged_in", { bot: bot.username ?? bot.id });

  if (!telegram.publicUrl) {
    return {
      ...base,
      tokenValid: true,
      bot,
      action: "failed",
      message: "Token is valid but PUBLIC_APP_URL is empty, so there is no URL to register.",
    };
  }

  const desiredUrl = webhookUrlFor(telegram.publicUrl);

  // 2. What does Telegram currently think?
  const info = await getWebhookInfo();
  const current: WebhookInfo | null = info.ok ? info.result : null;

  const matches =
    current?.url === desiredUrl &&
    (!telegram.webhookSecret || info.ok) && // secret cannot be read back; re-register only if URL changed
    !options.force;

  if (matches && current) {
    logInfo("telegram.webhook_ok", { url: current.url, pending: current.pending_update_count });
    return {
      ...base,
      tokenValid: true,
      bot,
      webhookUrl: current.url,
      match: true,
      pendingUpdates: current.pending_update_count,
      lastError: current.last_error_message,
      action: "unchanged",
      message: "Webhook was already registered to this app.",
    };
  }

  // 3. Register.
  const registered = await setWebhook({
    url: desiredUrl,
    secretToken: telegram.webhookSecret || undefined,
    dropPendingUpdates: options.dropPendingUpdates ?? false,
    allowedUpdates: ["message", "callback_query"],
  });

  if (!registered.ok) {
    logError("telegram.setwebhook_failed", { code: registered.code, description: registered.description });
    return { ...base, tokenValid: true, bot, webhookUrl: current?.url, action: "failed", message: registered.description };
  }

  logInfo("telegram.webhook_registered", { url: desiredUrl });
  return {
    ...base,
    tokenValid: true,
    bot,
    webhookUrl: desiredUrl,
    match: true,
    action: "registered",
    message: current?.url && current.url !== desiredUrl ? `Replaced old webhook (${current.url}).` : "Webhook registered.",
  };
}

/**
 * Boot-time variant: never throws, never blocks the server, and is silently
 * skipped when nothing is configured. Called from `instrumentation.ts`.
 */
export async function autoSetupOnBoot(): Promise<void> {
  const { telegram } = getConfig();
  if (!telegram.botToken || !telegram.autoSetup) return;
  if (process.env.NEXT_PHASE === "phase-production-build") return; // not during `next build`

  try {
    const report = await ensureWebhook();
    if (report.action === "failed") logWarn("telegram.boot_setup_failed", { message: report.message });
    else logInfo("telegram.boot_setup", { action: report.action, bot: report.bot?.username ?? null });
  } catch (error) {
    logWarn("telegram.boot_setup_error", { message: error instanceof Error ? error.message : "unknown" });
  }
}
