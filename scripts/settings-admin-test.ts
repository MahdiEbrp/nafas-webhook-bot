import assert from "node:assert/strict";
import { SettingsAdminApi, validateSettingCommand, type AdminSetting } from "../lib/settings-admin/api";
import { TelegramSettingsAdmin, isSettingsAdminRequest, settingCard } from "../lib/telegram/settings-admin";
import { inlineSuggestionsForReply, resolveInlineSuggestion } from "../lib/telegram/inline-suggestions";
import { explainSetting, settingsGuide, settingHelp } from "../lib/settings-admin/help";
import type { SettingPlan } from "../lib/settings-admin/planner";
export async function testSettingsAdmin() {
  const id = "11111111-1111-4111-8111-111111111111", secondId = "22222222-2222-4222-8222-222222222222";
  let row: AdminSetting = { id, key: "booking.reminder_hours", type: "number", value: 24, isActive: true, displayOrder: 0, translations: {}, createdAt: "2026-03-21T12:00:00Z", updatedAt: "2026-03-21T12:00:00Z" };
  let secondRow: AdminSetting = { ...row, id: secondId, key: "booking.max_appointments", value: 3 };
  let rows = [row];
  const context = { actorId: "admin", sessionCookie: "session=test", csrfToken: "csrf" };
  let calls = 0, mutations = 0, plans = 0, time = 0, status = 200, malformed = false;
  let plan: SettingPlan = { operation: "list", input: {} };
  const requests: { url: URL; init: RequestInit }[] = [];
  const api = new SettingsAdminApi(async (url, init) => {
    calls++; requests.push({ url: new URL(String(url)), init: init! });
    const path = new URL(String(url)).pathname;
    assert.equal(new URL(String(url)).origin, "https://clinic.example");
    assert.equal(init!.redirect, "error");
    assert.equal(init!.cache, "no-store");
    assert.equal((init!.headers as Record<string, string>).Cookie, context.sessionCookie);
    assert.equal((init!.headers as Record<string, string>)["X-CSRF-Token"], "csrf");
    if (status !== 200) return new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "private error" } }), { status });
    let data: unknown;
    if (malformed) data = { ok: true };
    else if (init!.method === "GET") {
      const selected = rows.find((item) => path.endsWith(item.id));
      data = selected ? { setting: selected } : { items: rows, total: rows.length, page: 1, perPage: 10, totalPages: 1 };
    } else { mutations++; data = path.endsWith("/bulk") ? { requested: 1, succeeded: 1, failures: [] } : init!.method === "PATCH" ? { updated: true } : init!.method === "DELETE" ? { deleted: true } : { id }; }
    return new Response(JSON.stringify({ data }));
  }, "https://clinic.example");
  const flow = new TelegramSettingsAdmin(api, async (request, choices) => {
    plans++;
    assert(choices.every(item => !("value" in item) && !("translations" in item)));
    if (request.includes("انتخاب: 2")) return { operation: "delete", id: secondId, input: {} };
    return plan;
  }, () => time);
  assert(isSettingsAdminRequest("راهنمای تنظیمات"));
  assert(isSettingsAdminRequest("booking.reminder_hours چیست"));
  assert(!isSettingsAdminRequest("تنظیمات سرویس پیامک"));
  assert.equal((await flow.handle("anon", "تنظیمات", null, true))?.status, "settings-auth-required");
  assert.equal((await flow.handle("group", "تنظیمات", context, false))?.status, "settings-private-only");
  assert.equal(calls, 0); assert.equal(plans, 0);
  const guide = await flow.handle("guide", "راهنمای تنظیمات", context, true);
  assert.equal(guide?.status, "settings-help"); assert(guide?.reply.includes("booking.reminder_hours"));
  assert.equal(plans, 0); assert.equal(calls, 0);
  const listed = await flow.handle("edit", "تنظیمات را نشان بده", context, true);
  assert.equal(listed?.status, "settings-listed"); assert(listed?.reply.includes("پنجرهٔ زمانی"));
  plan = { operation: "edit", id, input: {} };
  await flow.handle("edit", "تنظیم اول را ویرایش کن", context, true);
  const before = plans;
  const proposed = await flow.handle("edit", "۴۸", context, true);
  assert.equal(proposed?.status, "settings-proposed"); assert(proposed?.deleteSensitiveMessage);
  assert.equal(plans, before); assert.equal(mutations, 0);
  assert.equal((await flow.handle("edit", "تأیید", context, true))?.status, "settings-completed");
  assert.equal(mutations, 1); assert.equal(JSON.parse(String(requests.at(-1)!.init.body)).value, 48);
  // Read-before-write detects changes and consumes the confirmation.
  await flow.handle("conflict", `تنظیم ${id} را ویرایش کن`, context, true);
  await flow.handle("conflict", '{"value":12}', context, true);
  row = { ...row, value: 99 };
  rows[0] = row;
  assert.equal((await flow.handle("conflict", "تأیید", context, true))?.status, "settings-conflict"); assert.equal(mutations, 1);
  // Local creation values never reach planner and secrets never appear in preview.
  await flow.handle("create", "تنظیم جدید بساز", context, true);
  const planCount = plans;
  const secret = await flow.handle("create", '{"key":"custom.api_key","type":"string","value":"never-echo-this"}', context, true);
  assert.equal(secret?.status, "settings-proposed"); assert(secret?.deleteSensitiveMessage); assert(!secret?.reply.includes("never-echo-this")); assert.equal(plans, planCount);
  await flow.handle("create", "لغو", context, true); assert.equal(mutations, 1);
  assert(!settingCard({ ...row, key: "custom.password", value: "sensitive" }).includes('"sensitive"'));
  await flow.handle("expire", "تنظیم جدید بساز", context, true); time += 300001;
  assert.equal((await flow.handle("expire", "تأیید", context, true))?.status, "settings-expired");
  await flow.handle("session", "تنظیم جدید بساز", context, true);
  assert.equal((await flow.handle("session", "x", { ...context, sessionCookie: "other" }, true))?.status, "settings-session-changed");
  plan = { operation: "bulk", input: { action: "delete", scope: "filtered", filters: { status: "inactive" } } };
  assert.equal((await flow.handle("bulk", "همه تنظیمات غیرفعال را حذف کن", context, true))?.status, "settings-proposed");
  assert.equal(mutations, 1);
  assert.equal((await flow.handle("bulk", "تأیید", context, true))?.status, "settings-completed"); assert.equal(mutations, 2);
  const bulk = JSON.parse(String(requests.at(-1)!.init.body)); assert.equal(bulk.scope, "filtered"); assert.equal(bulk.filters.status, "inactive");

  rows = [row, secondRow];
  plan = { operation: "list", input: {} };
  assert.equal((await flow.handle("ambiguous-setting", "تنظیمات را نشان بده", context, true))?.status, "settings-listed");
  plan = { operation: "delete", target: "booking.", input: {} };
  const clarification = await flow.handle("ambiguous-setting", "تنظیمات booking را حذف کن", context, true);
  assert.equal(clarification?.status, "settings-clarify");
  const settingButtons = (inlineSuggestionsForReply(clarification!.status, clarification!.reply, "en")?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>).flat();
  assert.equal(settingButtons.length, 2, "ambiguous settings are presented as numbered buttons");
  assert.equal(settingButtons[1]?.text, secondRow.key, "setting choice labels omit internal IDs");
  const settingChoice = resolveInlineSuggestion(settingButtons[1]?.callback_data, "en");
  assert.equal(settingChoice, "2");
  const beforeSettingConfirmation = mutations;
  assert.equal((await flow.handle("ambiguous-setting", settingChoice!, context, true))?.status, "settings-proposed", "the setting choice enters the existing proposal workflow");
  assert.equal(mutations, beforeSettingConfirmation, "choosing a setting does not delete it");
  assert.equal((await flow.handle("ambiguous-setting", "تأیید", context, true))?.status, "settings-completed");
  assert.equal(mutations, beforeSettingConfirmation + 1);
  assert(requests.at(-1)?.url.pathname.endsWith(secondId));

  for (const input of [{ key: "Bad-key", value: "x" }, { key: "a", value: null }, { key: "a", type: "localized" }, { key: "a", value: "x", scope: "user" }]) assert.throws(() => validateSettingCommand({ operation: "create", input }));
  for (const input of [{}, { key: "new" }, { type: "number" }, { value: null }, { displayOrder: -1 }]) assert.throws(() => validateSettingCommand({ operation: "update", id, input }));
  assert.throws(() => validateSettingCommand({ operation: "bulk", input: { action: "delete", scope: "page", ids: [] } }));
  assert.throws(() => validateSettingCommand({ operation: "list", input: { perPage: 51 } }));
  malformed = true; assert.deepEqual(await api.execute({ operation: "get", id, input: {} }, context), { ok: false, code: "INVALID_RESPONSE" }); malformed = false;
  status = 403; const failure = await api.execute({ operation: "list", input: {} }, context); assert(!failure.ok && failure.code === "FORBIDDEN"); assert(!JSON.stringify(failure).includes("private error"));
  assert(explainSetting("unknown.custom").includes("تأیید نشده"));
  assert(Object.keys(settingHelp).length >= 45); assert(settingsGuide().includes("جایگزین"));
  console.log("Settings contracts, explanations, secure drafts, confirmations and conflict tests passed");
}
if (process.argv[1]?.endsWith("settings-admin-test.ts")) testSettingsAdmin().catch(error => { console.error(error); process.exitCode = 1; });
