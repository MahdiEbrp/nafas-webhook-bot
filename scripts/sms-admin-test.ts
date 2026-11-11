import assert from "node:assert/strict";
import { SmsAdminApi, smsOperations, validateSmsCommand } from "../lib/sms-admin/api";
import { TelegramSmsAdmin, isSmsAdminRequest, renderSmsResult } from "../lib/telegram/sms-admin";
export async function testSmsAdmin() {
  const id = "11111111-1111-4111-8111-111111111111";
  const context = { actorId: "admin", sessionCookie: "session=test", csrfToken: "csrf" };
  let calls = 0, plans = 0, time = 1000;
  let data: unknown = { campaignId: id, total: 1, sent: 1, failed: 0, status: "sent", parts: 1, encoding: "unicode", message: "never echo upstream body" };
  let status = 200;
  const api = new SmsAdminApi(async (url, init) => {
    calls++;
    assert.equal(new URL(String(url)).origin, "https://clinic.example");
    assert.equal(init!.redirect, "error");
    assert.equal(init!.cache, "no-store");
    assert.equal((init!.headers as Record<string, string>).Cookie, context.sessionCookie);
    if (init!.method === "POST" && String(url).endsWith("/messages")) {
      const body = JSON.parse(String(init!.body));
      assert.equal(body.message, "متن دقیق ۱۲۳");
      assert.match(body.idempotencyKey, /^[a-f0-9-]{36}$/);
    }
    return new Response(JSON.stringify(status === 200 ? { data } : { error: { code: "FORBIDDEN", message: "secret" } }), { status });
  }, "https://clinic.example");
  const planner = async () => { plans++; return { operation: "providerCreate", input: {} }; };
  const flow = new TelegramSmsAdmin(api, planner, () => time);
  assert(isSmsAdminRequest("پیامک بفرست"));
  assert(isSmsAdminRequest("SMS failed messages show me"));
  assert(!isSmsAdminRequest("کد پیامک برای ورود"));
  const readRequests: { url: URL; init: RequestInit }[] = [];
  const readApi = new SmsAdminApi(async (url, init) => {
    const parsed = new URL(String(url)); readRequests.push({ url: parsed, init: init! });
    const path = parsed.pathname;
    const data = path.endsWith("/overview")
      ? { stats: { total: 2, sent: 1, delivered: 1, failed: 0, deliveryRate: 50 }, providerCount: 1, activeProviderCount: 1, templateCount: 1, activeTemplateCount: 1 }
      : path.endsWith("/messages")
        ? { items: [{ id, recipientMasked: "09***", providerName: "Fake", status: "failed", createdAt: "2026-01-01T00:00:00Z" }], page: 1, perPage: 20, total: 1 }
        : path.endsWith("/templates")
          ? { items: [{ id, key: "reminder", messageType: "transactional", variables: [], translations: { fa: { name: "یادآوری", content: "متن" } }, isActive: true, displayOrder: 0 }], page: 1, perPage: 10, total: 1 }
          : path.endsWith("/providers")
            ? { items: [{ id, name: "Fake", kind: "fake", isActive: false, isDefault: false }], page: 1, perPage: 10, total: 1 }
            : { items: [{ id, fullName: "Test", phone: "+989120000000" }], page: 1, perPage: 10, total: 1 };
    return new Response(JSON.stringify({ data }));
  }, "https://clinic.example");
  let readPlans = 0;
  const deterministicReads = new TelegramSmsAdmin(readApi, async () => { readPlans++; throw new Error("clear SMS reads must bypass the planner"); }, () => time);
  const explicitReadCases = [
    ["آمار پیامک را نشان بده", "sms-read", "/api/v1/admin/sms/overview", undefined],
    ["گزارش پیامک‌های ناموفق را نشان بده", "sms-read", "/api/v1/admin/sms/messages", "failed"],
    ["قالب‌های فعال پیامک را نشان بده", "sms-read", "/api/v1/admin/sms/templates", "active"],
    ["سرویس‌دهندگان پیامک غیرفعال را نشان بده", "sms-read", "/api/v1/admin/sms/providers", "inactive"],
    ["گیرندگان پیامک دارای رزرو را نشان بده", "sms-read", "/api/v1/admin/sms/recipients", undefined],
  ] as const;
  for (const [index, [request, expectedStatus, path, filter]] of explicitReadCases.entries()) {
    assert.equal((await deterministicReads.handle(`sms-read-${index}`, request, context, true))?.status, expectedStatus, request);
    const call = readRequests.at(-1)!;
    assert.equal(call.url.pathname, path, "clear SMS reads use the matching GET endpoint");
    assert.equal(call.init.method, "GET", "SMS read routing never writes");
    if (filter) assert.equal(call.url.searchParams.get("status"), filter);
    if (path.endsWith("/recipients")) assert.equal(call.url.searchParams.get("audience"), "with_bookings");
  }
  assert.equal(readPlans, 0, "clear SMS reads do not invoke a planner that throws");
  const beforeTargetedRead = readRequests.length;
  assert.equal((await deterministicReads.handle("sms-targeted-read", "وضعیت تحویل پیامک اول را بررسی کن", context, true))?.status, "sms-invalid", "ordinal delivery checks stay on the contextual planner path rather than becoming a broad list");
  assert.equal(readPlans, 1);
  assert.equal(readRequests.length, beforeTargetedRead, "a targeted detail request is not misrouted to the messages collection");
  assert(readRequests.every(call => call.init.method === "GET"));
  assert.equal((await flow.handle("anon", "آمار پیامک", null, true))?.status, "sms-auth-required");
  assert.equal((await flow.handle("group", "آمار پیامک", context, false))?.status, "sms-private-only");
  assert.equal(calls, 0);
  await flow.handle("send", "پیامک بفرست", context, true);
  await flow.handle("send", "09120000000", context, true);
  await flow.handle("send", "متن دقیق ۱۲۳", context, true);
  assert.equal((await flow.handle("send", "پیش‌فرض", context, true))?.status, "sms-proposed");
  assert.equal(plans, 0, "recipients and message never enter planner");
  assert.equal(calls, 0, "no send before approval");
  const sent = await flow.handle("send", "تأیید", context, true);
  assert.equal(sent?.status, "sms-completed");
  assert(!sent?.reply.includes("never echo"));
  assert.equal(calls, 1);
  flow.clear("send");
  await flow.handle("provider", "سرویس پیامک جدید بساز", context, true);
  for (const value of ["سرویس نمونه", "fake", "https://provider.example/path"]) await flow.handle("provider", value, context, true);
  const token = await flow.handle("provider", "very-secret-token", context, true);
  assert(token?.deleteSensitiveMessage);
  assert(!token?.reply.includes("very-secret-token"));
  const credentials = await flow.handle("provider", '{"password":"never-to-model"}', context, true);
  assert(credentials?.deleteSensitiveMessage);
  const proposal = await flow.handle("provider", "پیش‌فرض", context, true);
  assert.equal(proposal?.status, "sms-proposed");
  assert(!proposal?.reply.includes("very-secret-token"));
  assert(!proposal?.reply.includes("never-to-model"));
  assert.equal(plans, 1);
  assert.equal(calls, 1);
  await flow.handle("provider", "لغو", context, true);
  await flow.handle("expired", "پیامک بفرست", context, true);
  time += 301000;
  assert.equal((await flow.handle("expired", "تأیید", context, true))?.status, "sms-expired");
  await flow.handle("changed", "پیامک بفرست", context, true);
  assert.equal((await flow.handle("changed", "متن", { ...context, sessionCookie: "other" }, true))?.status, "sms-session-changed");
  assert.equal(Object.keys(smsOperations).length, 20);
  assert.throws(() => validateSmsCommand({ operation: "send", input: { recipients: ["bad"], message: "x" } }));
  assert.throws(() => validateSmsCommand({ operation: "providerUpdate", id, input: {} }));
  assert.throws(() => validateSmsCommand({ operation: "providerUpdate", id, input: { apiUrl: "https://127.0.0.1" } }));
  assert.throws(() => validateSmsCommand({ operation: "templateUpdate", id, input: { key: "immutable" } }));
  assert.throws(() => validateSmsCommand({ operation: "providers", input: { perPage: 51 } }));
  data = { id, name: "safe", kind: "fake", isActive: true, isDefault: false, token: "secret", apiUrl: "https://secret.example", credentials: { password: "secret" } };
  const provider = await api.execute({ operation: "providerGet", id, input: {} }, context);
  assert(provider.ok);
  assert(!JSON.stringify(provider).includes("secret"));
  status = 403;
  const rejected = await api.execute({ operation: "overview", input: {} }, context);
  assert(!rejected.ok && rejected.code === "FORBIDDEN");
  assert(!JSON.stringify(rejected).includes("secret"));
  assert(renderSmsResult("providerTest", { successful: false }).includes("ناموفق"));
  assert(renderSmsResult("send", { status: "failed" }).includes("ناموفق"));
  console.log("SMS mock contracts, guided send, secrets, expiry and authorization passed");
}
if (process.argv[1]?.endsWith("sms-admin-test.ts")) testSmsAdmin().catch(error => { console.error(error); process.exitCode = 1; });
