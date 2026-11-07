export {};

/**
 * npm run smoke
 *
 * Talks to a *running* bot over HTTP (default http://127.0.0.1:3000) and walks
 * the happy paths in Persian. Use it after `npm run dev` + `npm run mock-api`,
 * or against the deployed Vercel URL:
 *
 *   BOT_URL=https://your-bot.vercel.app BOT_API_KEY=... npm run smoke
 */

const BOT_URL = (process.env.BOT_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const BOT_KEY = process.env.BOT_API_KEY?.trim() || "";

type ChatResponse = {
  ok: boolean;
  data?: {
    status: string;
    reply: string;
    actionId: string | null;
    understood: string;
    confirmation?: { token: string };
    trace: { planner: string; writer: string; notice: string | null; ms: number };
  };
  error?: { code: string; message: string };
};

let pass = 0;
let fail = 0;

async function chat(payload: Record<string, unknown>): Promise<ChatResponse> {
  const response = await fetch(`${BOT_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(BOT_KEY ? { "x-bot-key": BOT_KEY } : {}),
    },
    body: JSON.stringify(payload),
  });
  return (await response.json()) as ChatResponse;
}

function report(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  console.log(`\nsmoke test → ${BOT_URL}\n`);

  const health = await fetch(`${BOT_URL}/api/health`).then((r) => r.json() as Promise<{ ok: boolean; data?: { status: string; warnings: string[] } }>);
  report("/api/health responds", health.ok === true, JSON.stringify(health).slice(0, 200));
  if (health.data?.warnings?.length) {
    console.log(`    warnings: ${health.data.warnings.join(" | ")}`);
  }
  if (health.data?.status) report("/api/health status", true, health.data.status);

  const features = await fetch(`${BOT_URL}/api/features`).then((r) => r.json() as Promise<{ ok: boolean; data?: { counts: { actions: number } } }>);
  report("/api/features lists actions", Boolean(features.data?.counts?.actions), `${features.data?.counts?.actions} actions`);

  const sessionId = `smoke-${Date.now()}`;

  const capabilities = await chat({ message: "تو چه کارهایی می‌تونی انجام بدی؟", sessionId });
  report(
    "«چه کارهایی بلدی؟» → فهرست امکانات",
    capabilities.ok && Boolean(capabilities.data?.reply.includes("نوبت")),
    capabilities.data?.reply.slice(0, 80),
  );

  const list = await chat({ message: "نوبت‌های امروز رو نشون بده", sessionId, locale: "fa" });
  report(
    "«نوبت‌های امروز» → خواندن لیست",
    list.ok && ["done", "error"].includes(list.data?.status ?? ""),
    `${list.data?.status} / ${list.data?.actionId}`,
  );
  console.log(`    bot: ${list.data?.reply.replace(/\n/g, " ⏎ ").slice(0, 220)}`);
  console.log(`    trace: planner=${list.data?.trace.planner} writer=${list.data?.trace.writer} ${list.data?.trace.ms}ms`);

  const pendingWrite = await chat({
    message: "برای مریم رضایی به شماره 09121234567 نوبت ثبت کن",
    sessionId,
    locale: "fa",
    dryRun: true,
  });
  report(
    "نوشتن → کارت تأیید (dry run)",
    pendingWrite.ok && ["needs_confirmation", "needs_info", "error"].includes(pendingWrite.data?.status ?? ""),
    pendingWrite.data?.status,
  );
  console.log(`    bot: ${pendingWrite.data?.reply.replace(/\n/g, " ⏎ ").slice(0, 220)}`);

  if (pendingWrite.data?.confirmation?.token) {
    const declined = await chat({
      message: "نه",
      sessionId,
      confirm: { token: pendingWrite.data.confirmation.token, approve: false },
    });
    report("لغو تأیید کار می‌کند", declined.ok && declined.data?.status === "answered");
  }

  // ── لایهٔ واسط ──────────────────────────────────────────────────
  const proxyOk = await fetch(`${BOT_URL}/api/proxy/api/v1/webhooks/bookings?perPage=1`, {
    headers: BOT_KEY ? { "x-bot-key": BOT_KEY } : {},
  }).then((r) => r.json() as Promise<{ ok: boolean; data?: unknown; error?: unknown }>);
  report(
    "واسط خام: GET /api/proxy/api/v1/webhooks/bookings",
    typeof proxyOk.ok === "boolean",
    proxyOk.ok ? "upstream پاسخ داد" : `upstream: ${JSON.stringify(proxyOk.error).slice(0, 120)}`,
  );

  const proxyBlocked = await fetch(`${BOT_URL}/api/proxy/api/v1/users`, {
    headers: BOT_KEY ? { "x-bot-key": BOT_KEY } : {},
  });
  report("واسط خام: مسیر غیرمجاز رد می‌شود", proxyBlocked.status === 404, `http ${proxyBlocked.status}`);

  console.log(`\n${fail === 0 ? "🎉" : "⚠️"}  ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("smoke test crashed:", error);
  process.exitCode = 1;
});
