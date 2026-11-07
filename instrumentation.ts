/**
 * Next.js calls `register()` once, when the server starts (dev, `next start`,
 * or a cold Vercel function boot). That is the closest thing to "after start-up"
 * on a serverless platform, which makes it the right place to log the bot into
 * Telegram automatically.
 *
 * Safety:
 *   • `NEXT_RUNTIME !== "nodejs"` → skip (no fetch/cron in edge middleware),
 *   • no token / TELEGRAM_AUTO_SETUP=false → no-op,
 *   • never throws, never awaited by the request path.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { autoSetupOnBoot } = await import("@/lib/telegram/setup");
  // Fire and forget: a slow Telegram must never delay the first request.
  void autoSetupOnBoot().catch(() => {
    /* logged inside */
  });
}
