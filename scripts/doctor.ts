export {};

/**
 * npm run doctor
 *
 * A connection doctor you run from *your* machine (or Vercel) — not from CI —
 * because it talks to the real clinic site:
 *
 *   1. DNS + TCP + TLS to WEBHOOK_BASE_URL
 *   2. Is the webhook path even there?  (401 = exists but needs auth ✅ / 404 = wrong path ❌)
 *   3. Do the credentials work?          (Basic Auth)
 *   4. Which permissions does the service user actually have?
 *        → tries each feature's list endpoint and reports 200 / 403
 *   5. OpenRouter: is the key alive, is the free-model chain still available?
 *
 * Usage:
 *   npm run doctor
 *   WEBHOOK_BASE_URL=https://nafasbeautyclinic.ir WEBHOOK_USERNAME=... WEBHOOK_PASSWORD=... npm run doctor
 */

import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";

import { configWarnings, getConfig } from "@/lib/config";
import { FEATURES } from "@/lib/features/manifest";
import { listFreeModels } from "@/lib/openrouter/models";
import { callWebhook } from "@/lib/webhooks/client";

const OK = "✅";
const BAD = "❌";
const WARN = "⚠️ ";

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

async function tcpProbe(host: string, port: number, timeoutMs = 8000): Promise<{ ok: boolean; ms: number; error?: string }> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean, error?: string) => {
      socket.destroy();
      resolve({ ok, ms: Date.now() - startedAt, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false, `timed out after ${timeoutMs}ms`));
    socket.once("error", (error) => done(false, error.message));
  });
}

async function tlsProbe(host: string, timeoutMs = 8000): Promise<{ ok: boolean; error?: string; validTo?: string }> {
  return new Promise((resolve) => {
    const socket = tlsConnect({ host, port: 443, servername: host }, () => {
      const certificate = socket.getPeerCertificate();
      socket.destroy();
      resolve({ ok: true, validTo: certificate?.valid_to });
    });
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ ok: false, error: "TLS handshake timed out" });
    });
    socket.once("error", (error) => {
      socket.destroy();
      resolve({ ok: false, error: error.message });
    });
  });
}

async function main(): Promise<void> {
  const config = getConfig();
  let host = "";
  try {
    host = new URL(config.webhookBaseUrl).hostname;
  } catch {
    console.error(`${BAD} WEBHOOK_BASE_URL is not a valid URL: ${config.webhookBaseUrl}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n🩺 dr; testing this middleware against the real services\n`);
  line("upstream:", config.webhookBaseUrl);
  line("service user:", config.webhookUsername || "(not set)");

  console.log("\n1) شبکه و گواهی");
  let dns: { ok: boolean; address?: string; error?: string };
  try {
    const record = await lookup(host);
    dns = { ok: true, address: record.address };
    line(`DNS ${host}`, `${OK} ${record.address}`);
  } catch (error) {
    dns = { ok: false, error: error instanceof Error ? error.message : String(error) };
    line(`DNS ${host}`, `${BAD} ${dns.error}`);
  }

  if (dns.ok) {
    const tcp = await tcpProbe(host, 443);
    line("TCP :443", tcp.ok ? `${OK} ${tcp.ms}ms` : `${BAD} ${tcp.error}`);

    const tls = await tlsProbe(host);
    line("TLS", tls.ok ? `${OK} certificate valid to ${tls.validTo}` : `${BAD} ${tls.error}`);

    if (!tcp.ok) {
      console.log(
        `\n${WARN} این پیام معمولاً یعنی شبکه‌ای که از آن تست می‌کنی به سرور دسترسی ندارد (فایروال/جغرافیا).` +
          `\n   از یک شبکهٔ دیگر یا از داخل Vercel دوباره امتحان کن.`,
      );
    }
  }

  console.log("\n2) احراز هویت و مسیر وب‌هوک");
  const unauthenticated = await callWebhook({ method: "GET", path: "/api/v1/webhooks/bookings" }, { timeoutMs: 8_000 });
  if (unauthenticated.status === 401) {
    line("بدون کلید (باید 401)", `${OK} مسیر درست است و از ما کلید می‌خواهد`);
  } else if (unauthenticated.status === 404) {
    line("بدون کلید", `${BAD} 404 — آدرس یا مسیر اشتباه است`);
  } else if (unauthenticated.status === 0) {
    line("بدون کلید", `${BAD} ${unauthenticated.ok ? "" : unauthenticated.message}`);
  } else {
    line("بدون کلید", `${WARN} ${unauthenticated.status} — انتظار 401 داشتیم`);
  }

  const reachable = unauthenticated.status !== 0;
  const authenticated = reachable
    ? await callWebhook({ method: "GET", path: "/api/v1/webhooks/bookings", query: { perPage: 1 } }, { timeoutMs: 8_000 })
    : null;

  if (!reachable) {
    line("با کلید", `${BAD} تست نشد — upstream در دسترس نیست`);
    console.log(
      `\n${WARN} از این شبکه نمی‌توانیم به ${host} برسیم، پس بررسی کلید و مجوزها معنی ندارد.` +
        `\n   این تست را از شبکه/سرور دیگری اجرا کن (یا روی خود Vercel). باقی بررسی‌ها ادامه دارد.`,
    );
  } else if (authenticated?.ok) {
    line("با کلید", `${OK} ${authenticated.status} در ${authenticated.ms}ms`);
  } else if (authenticated) {
    line("با کلید", `${BAD} ${authenticated.status} ${authenticated.code} — ${authenticated.message}`);
    if (authenticated.status === 401) {
      console.log("     → WEBHOOK_USERNAME / WEBHOOK_PASSWORD اشتباه است (نام کاربری = ایمیل کاربر).");
    }
  }

  console.log("\n3) مجوزها (هر بخش با یک درخواست خواندن آزمایش می‌شود)");
  if (!reachable) {
    console.log(`  ${WARN} رد شد — upstream در دسترس نیست.`);
  }
  const readActions = FEATURES.flatMap((feature) =>
    feature.actions.filter((action) => action.method === "GET" && !action.path.includes(":id")).map((action) => ({ feature, action })),
  ).slice(0, 12);

  const matrix: Array<{ feature: string; permission: string; status: string }> = [];
  for (const { feature, action } of reachable ? readActions : []) {
    const result = await callWebhook({ method: "GET", path: action.path, query: { perPage: 1 } }, { timeoutMs: 8_000 });
    const status = result.ok ? `${OK} دارد` : result.status === 403 ? `${BAD} ندارد` : `${WARN} ${result.status}`;
    matrix.push({ feature: feature.id, permission: action.permission, status });
    line(feature.id, `${action.permission} → ${status}`);
  }

  console.log("\n4) OpenRouter");
  if (!config.openrouterApiKey) {
    line("کلید", `${BAD} OPENROUTER_API_KEY خالی است`);
  } else {
    line("کلید", `${OK} تنظیم شده`);
  }
  try {
    const models = await listFreeModels(true);
    const ids = new Set(models.map((model) => model.id));
    const dead = config.modelChain.filter((id) => !ids.has(id));
    line("مدل‌های مجانی", `${OK} ${models.length} مدل در دسترس`);
    line("زنجیرهٔ تو", dead.length === 0 ? `${OK} هر ${config.modelChain.length} مدل زنده است` : `${BAD} ناموجود: ${dead.join(", ")}`);
    if (dead.length > 0) {
      const suggestion = models.filter((model) => model.supportsTools && model.supportsJsonMode).slice(0, 5).map((model) => model.id);
      console.log(`     → پیشنهاد: OPENROUTER_MODELS=${suggestion.join(",")}`);
    }
  } catch (error) {
    line("مدل‌های مجانی", `${BAD} ${error instanceof Error ? error.message : "خطا"}`);
  }

  console.log("\n5) هشدارهای تنظیمات");
  const warnings = configWarnings(config);
  if (warnings.length === 0) console.log(`  ${OK} هیچ هشداری نیست`);
  for (const warning of warnings) console.log(`  ${WARN} ${warning}`);

  const missingPermissions = matrix.filter((row) => row.status.includes(BAD)).length;
  console.log("\n— خلاصه —");
  console.log(`  دسترسی‌های موجود: ${matrix.length - missingPermissions}/${matrix.length}`);
  if (missingPermissions > 0) {
    console.log(`  ${WARN} ربات فقط می‌تواند کارهایی را انجام دهد که این کاربر سرویس مجاز است.`);
    console.log(`     در پروژهٔ سایت، نقش این کاربر را بررسی کن (users / roles / permissions).`);
  }
  console.log("");
}

main().catch((error) => {
  console.error("doctor crashed:", error);
  process.exitCode = 1;
});
