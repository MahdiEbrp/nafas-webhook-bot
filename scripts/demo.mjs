#!/usr/bin/env node
/**
 * npm run demo
 *
 * One command that tells you if the app is alive and shows a full conversation
 * in Persian: capabilities → a list → an AI-suggested button → a write that
 * needs confirmation.
 *
 * Start the app first (`npm run dev`), then run this in another terminal.
 */

const BOT = (process.env.BOT_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const KEY = process.env.BOT_API_KEY?.trim() || "";

const headers = {
  "Content-Type": "application/json",
  ...(KEY ? { "x-bot-key": KEY } : {}),
};

const line = (char = "─") => console.log(char.repeat(64));

async function post(path, body) {
  const response = await fetch(`${BOT}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const json = await response.json();
  return { status: response.status, json };
}

async function main() {
  const sessionId = `demo-${Date.now()}`;

  line("═");
  console.log("  دموی ربات کلینیک  →  " + BOT);
  line("═");

  // 0. health
  const health = await fetch(`${BOT}/api/health`).then((r) => r.json());
  console.log(`\nوضعیت سرویس: ${health?.data?.status ?? "?"}`);
  for (const warning of health?.data?.warnings ?? []) console.log(`  ⚠️  ${warning}`);

  // 1. what can you do
  console.log("\n[۱] «چه کارهایی می‌تونی بکنی؟»");
  const features = await post("/api/chat", { message: "چه کارهایی می‌تونی بکنی؟", sessionId });
  console.log(indent(features.json?.data?.reply, 6));

  // 2. a read
  console.log("\n[۲] «نوبت‌های امروز رو نشون بده»");
  const list = await post("/api/chat", { message: "نوبت‌های امروز رو نشون بده", sessionId });
  const listData = list.json?.data;
  console.log(indent(listData?.reply, 6));
  console.log(
    indent(
      `— مغز: ${listData?.trace?.planner} | نویسنده: ${listData?.trace?.writer} | ${listData?.trace?.ms}ms | اکشن: ${listData?.actionId}`,
      6,
    ),
  );

  // 3. a write → confirmation
  console.log("\n[۳] «برای مریم رضایی شماره 09121234567 نوبت ثبت کن»");
  const write = await post("/api/chat", { message: "برای مریم رضایی شماره 09121234567 نوبت ثبت کن", sessionId });
  const writeData = write.json?.data;
  console.log(indent(writeData?.reply, 6));
  console.log(indent(`— وضعیت: ${writeData?.status}`, 6));

  // 4. a destructive action → confirmation card, then cancel
  console.log("\n[۴] «نوبت 33333333-3333-4333-8333-333333333333 رو حذف کن»");
  const del = await post("/api/chat", {
    message: "نوبت 33333333-3333-4333-8333-333333333333 رو حذف کن",
    sessionId,
  });
  const delData = del.json?.data;
  console.log(indent(delData?.reply, 6));

  if (delData?.confirmation?.token) {
    console.log("\n[۵] «نه» زدم (لغو) — هیچ چیزی پاک نشد:");
    const cancel = await post("/api/chat", {
      message: "نه",
      sessionId,
      confirm: { token: delData.confirmation.token, approve: false },
    });
    console.log(indent(cancel.json?.data?.reply, 6));
  }

  // 6. raw proxy passthrough
  console.log("\n[۶] حالت واسط خام (بدون AI):");
  const proxy = await fetch(`${BOT}/api/proxy/api/v1/webhooks/services?perPage=3`, { headers }).then((r) => r.json());
  if (proxy?.ok) {
    const items = proxy.data?.items ?? [];
    console.log(indent(`✅ ${items.length} خدمت برگشت: ${items.map((row) => row.translations?.fa?.title ?? row.slug).join("، ")}`, 6));
  } else {
    console.log(indent(`⚠️  ${proxy?.error?.code}: ${proxy?.error?.message}`, 6));
  }

  const blocked = await fetch(`${BOT}/api/proxy/api/v1/users`, { headers });
  console.log(indent(`مسیر غیرمجاز → HTTP ${blocked.status} (باید 404 باشد)`, 6));

  // 7. telegram side
  console.log("\n[۷] تلگرام:");
  const tg = await fetch(`${BOT}/api/health`).then((r) => r.json());
  console.log(indent(`مسیر وب‌هوک: ${BOT}/api/telegram/webhook`, 6));
  void tg;

  line("═");
  console.log("  تمام. صفحهٔ تعاملی: " + BOT);
  line("═");
}

function indent(text, spaces) {
  if (!text) return " ".repeat(spaces) + "(بدون پاسخ)";
  return String(text)
    .split("\n")
    .map((row) => " ".repeat(spaces) + row)
    .join("\n");
}

main().catch((error) => {
  console.error(`\n❌ به ${BOT} نرسیدم. اول «npm run dev» را اجرا کن.\n   ${error.message}\n`);
  process.exitCode = 1;
});
