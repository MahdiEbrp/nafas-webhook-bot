export {};

/**
 * npm run telegram:setup
 *
 * The "login" step, from your terminal:
 *
 *   npm run telegram:setup            # register (or repair) the webhook
 *   npm run telegram:setup -- --force # re-register even if unchanged
 *   npm run telegram:setup -- --drop  # also throw away queued updates
 *   npm run telegram:setup -- --logout
 *
 * Needs in the environment:
 *   TELEGRAM_BOT_TOKEN       (from @BotFather)
 *   PUBLIC_APP_URL           (https URL of this app, e.g. https://bot.example.vercel.app)
 *   TELEGRAM_WEBHOOK_SECRET  (a long random string; Telegram echoes it back)
 */

import { configWarnings, getConfig } from "@/lib/config";
import { deleteWebhook, getMe, getWebhookInfo } from "@/lib/telegram/api";
import { ensureWebhook, webhookUrlFor } from "@/lib/telegram/setup";

const OK = "✅";
const BAD = "❌";
const WARN = "⚠️ ";

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const { telegram } = getConfig();

  console.log("\n🤖 Telegram setup\n");

  if (!telegram.botToken) {
    console.log(`  ${BAD} TELEGRAM_BOT_TOKEN is not set.`);
    console.log("     1) در تلگرام به @BotFather پیام بده → /newbot → توکن را بگیر");
    console.log("     2) TELEGRAM_BOT_TOKEN=123:ABC را در .env.local (و در Vercel env) بگذار");
    process.exitCode = 1;
    return;
  }

  const me = await getMe();
  if (!me.ok) {
    console.log(`  ${BAD} توکن پذیرفته نشد: ${me.description}`);
    process.exitCode = 1;
    return;
  }

  const username = me.result.username ?? "(بدون نام کاربری)";
  console.log(`  ${OK} لاگین شد: @${username} (id ${me.result.id})`);
  console.log(`  🔗 لینک گفت‌وگو: https://t.me/${username}`);

  if (args.has("--logout")) {
    const removed = await deleteWebhook();
    console.log(`  ${removed.ok ? OK : BAD} webhook حذف شد${removed.ok ? "" : `: ${removed.description}`}`);
    return;
  }

  if (!telegram.publicUrl) {
    console.log(`  ${BAD} PUBLIC_APP_URL خالی است — آدرسی برای ثبت وب‌هوک نداریم.`);
    console.log("     بعد از اولین دیپلوی روی Vercel همین را بگذار: https://<project>.vercel.app");
    process.exitCode = 1;
    return;
  }

  const before = await getWebhookInfo();
  if (before.ok && before.result.url) console.log(`  ℹ️  webhook فعلی: ${before.result.url}`);
  if (before.ok && before.result.last_error_message) console.log(`  ${WARN} آخرین خطای تلگرام: ${before.result.last_error_message}`);

  const report = await ensureWebhook({
    force: args.has("--force"),
    dropPendingUpdates: args.has("--drop"),
  });

  const icon = report.action === "failed" ? BAD : OK;
  console.log(`  ${icon} ${report.action}: ${report.message}`);
  console.log(`     URL: ${report.webhookUrl ?? webhookUrlFor(telegram.publicUrl)}`);

  const after = await getWebhookInfo();
  if (after.ok) {
    console.log(`     صف به‌روزرسانی‌های در انتظار: ${after.result.pending_update_count}`);
    if (after.result.last_error_message) console.log(`     ${WARN} ${after.result.last_error_message}`);
  }

  console.log("\n  قدم بعد:");
  console.log(`     1. در تلگرام به @${username} پیام بده → /start`);
  console.log("     2. ربات دسترسی را چک می‌کند؛ اگر جواب نداد، /id را بفرست");
  console.log("        و آن عدد را در TELEGRAM_ALLOWED_CHAT_IDS بگذار.");
  if (!telegram.webhookSecret) {
    console.log(`     ${WARN} TELEGRAM_WEBHOOK_SECRET خالی است — حتماً یک رشتهٔ تصادفی بگذار:`);
    console.log("        openssl rand -hex 32");
  }
  if (telegram.allowedChatIds.length === 0) {
    console.log(`     ${WARN} TELEGRAM_ALLOWED_CHAT_IDS خالی است — هر کسی که ربات را پیدا کند می‌تواند کارها را اجرا کند.`);
  }

  const warnings = configWarnings().filter((warning) => warning.startsWith("TELEGRAM"));
  if (warnings.length > 0) {
    console.log("");
    for (const warning of warnings) console.log(`  ${WARN} ${warning}`);
  }
  console.log("");
}

main().catch((error) => {
  console.error("telegram setup crashed:", error);
  process.exitCode = 1;
});
