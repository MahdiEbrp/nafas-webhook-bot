import assert from "node:assert/strict";
import { PaymentAdminApi, paymentOperations, validatePaymentCommand, type PaymentOperation } from "../lib/payment-admin/api";
import { TelegramPaymentAdmin, isPaymentAdminRequest, paymentCard } from "../lib/telegram/payment-admin";
import type { PaymentPlan } from "../lib/payment-admin/planner";
export async function testPaymentAdmin() {
  const id = "11111111-1111-4111-8111-111111111111", txid = "22222222-2222-4222-8222-222222222222";
  const context = { actorId: "admin", sessionCookie: "session=private", csrfToken: "csrf" };
  let provider = { id, name: "Sample gateway", kind: "fake", merchantConfigured: true, isActive: true, isDefault: false, healthStatus: "unknown", lastHealthCheckedAt: null, createdAt: "2026-03-21T12:00:00Z", updatedAt: "2026-03-21T12:00:00Z", apiUrl: "https://secret.example?key=hidden", merchantLast4: "hide", lastHealthError: "never-echo-error" };
  const tx = { id: txid, bookingGroupRef: "NF-12345", amount: "1000", currency: "IRT", description: "exact description", status: "requested", providerId: id, providerName: "Sample gateway", refId: null, createdAt: "2026-03-21T12:00:00Z", updatedAt: "2026-03-21T12:00:00Z", verifiedAt: null, expiresAt: null, cardPan: "never-echo-card", errorMessage: "never-echo-error", authority: "never-to-model", paymentUrl: "javascript:alert(1)" };
  let calls = 0, writes = 0, status = 200, malformed = false, failNetwork = false, plans = 0, time = 0, urlResult = "/fake/payment?authority=example", testSuccess = false;
  let plan: PaymentPlan = { operation: "providers", input: {} };
  const requests: { url: URL; init: RequestInit }[] = [];
  const api = new PaymentAdminApi(async (url, init) => {
    calls++; requests.push({ url: new URL(String(url)), init: init! });
    assert.equal(new URL(String(url)).origin, "https://clinic.example");
    assert.equal(init!.redirect, "error"); assert.equal(init!.cache, "no-store");
    assert.equal((init!.headers as Record<string, string>).Cookie, context.sessionCookie);
    assert.equal((init!.headers as Record<string, string>).Origin, "https://clinic.example");
    assert.equal((init!.headers as Record<string, string>)["X-CSRF-Token"], "csrf");
    if (failNetwork) throw new Error("never-echo-secret");
    if (status !== 200) return new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "never-echo-secret" } }), { status });
    const path = new URL(String(url)).pathname;
    let data: unknown;
    if (malformed) data = {};
    else if (path.endsWith("/overview")) data = { activeProviderCount: 1, totalTransactions: 1, verifiedCount: 0, pendingCount: 0, totalVolume: 0, activeProviderPercentage: 100 };
    else if (init!.method === "GET") data = path.endsWith("/transactions") ? { items: [tx], total: 1, page: 1, perPage: 20, totalPages: 1 } : path.endsWith("/providers") ? { items: [provider], total: 1, page: 1, perPage: 10, totalPages: 1 } : provider;
    else {
      writes++;
      data = path.endsWith("/test") ? { isSuccessful: testSuccess, responseTimeMs: 10, error: "never-echo-secret" } : path.endsWith("/bulk") ? { requested: 2, succeeded: 1, failures: [{ id, code: "OPERATION_FAILED" }] } : path.endsWith("/transactions") ? { id: txid, authority: "hidden-authority", paymentUrl: urlResult } : path.endsWith(`/transactions/${txid}`) ? tx : init!.method === "POST" ? { id } : { success: true };
    }
    return new Response(JSON.stringify({ data }));
  }, "https://clinic.example");
  const inputs: Record<PaymentOperation, unknown> = {
    overview: {}, providers: {}, providerGet: {}, providerCreate: { name: "Test", kind: "fake", merchantId: "secret-merchant", apiUrl: "" }, providerUpdate: { isActive: false }, providerDelete: {}, providerTest: {}, providerBulk: { action: "delete", scope: "page", ids: [id] }, transactions: {}, transactionCreate: { bookingGroupRef: "NF-12345", amount: 1000 }, transactionUpdate: { status: "failed" },
  };
  assert.equal(Object.keys(paymentOperations).length, 11);
  for (const operation of Object.keys(paymentOperations) as PaymentOperation[]) {
    const result = await api.execute({ operation, id: operation === "transactionUpdate" ? txid : id, input: inputs[operation] }, context);
    assert(result.ok, operation);
    assert(!JSON.stringify(result).includes("never-echo"));
    if (operation === "transactionCreate") { assert(result.data.paymentUrl === "https://clinic.example/fake/payment?authority=example"); assert(!("authority" in result.data)); }
    if (operation === "providerGet") { assert(!("apiUrl" in result.data)); assert(!("merchantLast4" in result.data)); }
  }
  const flow = new TelegramPaymentAdmin(api, async (_text, choices) => { plans++; assert(choices.every(item => Object.keys(item).every(key => ["id", "title", "resource"].includes(key)))); return plan; }, () => time);
  assert(isPaymentAdminRequest("آمار پرداخت")); assert(isPaymentAdminRequest("درگاه جدید بساز")); assert(!isPaymentAdminRequest("کد پیامک برای ورود"));
  const before = calls;
  assert.equal((await flow.handle("anon", "آمار پرداخت", null, true))?.status, "payment-auth-required");
  assert.equal((await flow.handle("group", "آمار پرداخت", context, false))?.status, "payment-private-only");
  assert.equal(calls, before); assert.equal(plans, 0);
  await flow.handle("provider", "درگاه جدید بساز", context, true);
  for (const text of ["درگاه نمونه", "fake", "merchant-private", "پیش‌فرض", "پیش‌فرض"]) { const r = await flow.handle("provider", text, context, true); assert(r?.deleteSensitiveMessage); }
  const proposed = await flow.handle("provider", '{"sandbox":true}', context, true);
  assert.equal(proposed?.status, "payment-proposed"); assert(!proposed?.reply.includes("merchant-private")); assert.equal(plans, 0);
  const oldWrites = writes;
  await flow.handle("provider", "لغو", context, true); assert.equal(writes, oldWrites);
  await flow.handle("create", "درخواست پرداخت بساز", context, true);
  for (const text of ["NF-12345", "۱۰۰۰", "توضیح دقیق ۱۲۳", "پیش‌فرض"]) await flow.handle("create", text, context, true);
  assert.equal(plans, 0); assert.equal(writes, oldWrites);
  assert.equal((await flow.handle("create", "تأیید", context, true))?.status, "payment-completed");
  assert.equal(writes, oldWrites + 1);
  const body = JSON.parse(String(requests.at(-1)!.init.body)); assert.equal(body.amount, 1000); assert.equal(body.description, "توضیح دقیق ۱۲۳"); assert(!("idempotencyKey" in body));
  await flow.handle("test", "درگاهها را نشان بده", context, true);
  plan = { operation: "providerTest", id, input: {} };
  const testProposal = await flow.handle("test", "درگاه اول را تست کن", context, true);
  assert.equal(testProposal?.status, "payment-proposed"); assert(testProposal?.reply.includes("۱۰۰۰ ریالی"));
  const tested = await flow.handle("test", "تأیید", context, true); assert(tested?.reply.includes("ناموفق")); assert(!tested?.reply.includes("never-echo"));
  plan = { operation: "providerUpdate", id, input: {} };
  await flow.handle("edit", `درگاه ${id} را ویرایش کن`, context, true);
  await flow.handle("edit", '{"isDefault":true}', context, true);
  const beforeConflict = writes; provider = { ...provider, updatedAt: "2026-03-22T12:00:00Z" };
  assert.equal((await flow.handle("edit", "تأیید", context, true))?.status, "payment-conflict"); assert.equal(writes, beforeConflict);
  plan = { operation: "transactions", input: { search: "NF-12345" } };
  await flow.handle("tx", "تراکنشهای رزرو را نشان بده", context, true);
  plan = { operation: "transactionUpdate", id: txid, input: {} };
  await flow.handle("tx", "تراکنش اول را ویرایش کن", context, true);
  const patch = await flow.handle("tx", '{"status":"refunded"}', context, true); assert(patch?.reply.includes("پولی برنمی‌گرداند"));
  const patched = await flow.handle("tx", "تأیید", context, true); assert.equal(patched?.status, "payment-completed");
  assert(!requests.some(item => /\/transactions\/[a-f0-9-]+$/.test(item.url.pathname) && item.init.method === "GET"));
  await flow.handle("expiry", "درگاه جدید بساز", context, true); time += 300001;
  assert.equal((await flow.handle("expiry", "تأیید", context, true))?.status, "payment-expired");
  await flow.handle("session", "درگاه جدید بساز", context, true);
  assert.equal((await flow.handle("session", "name", { ...context, sessionCookie: "other" }, true))?.status, "payment-session-changed");
  plan = { operation: "providers", input: { status: "inactive", search: "sample" } };
  await flow.handle("pages", "درگاههای غیرفعال را نشان بده", context, true);
  plan = { operation: "providers", input: { page: 2 } };
  await flow.handle("pages", "صفحه بعد", context, true);
  assert.equal(requests.at(-1)!.url.searchParams.get("status"), "inactive");
  assert.equal(requests.at(-1)!.url.searchParams.get("search"), "sample");
  plan = { operation: "providerBulk", input: { action: "delete", scope: "filtered" } };
  const bulkProposal = await flow.handle("pages", "همه درگاههای مطابق فیلتر را حذف کن", context, true);
  assert.equal(bulkProposal?.status, "payment-proposed");
  const bulkResult = await flow.handle("pages", "تأیید", context, true);
  assert(bulkResult?.reply.includes("ناموفق: 1"));
  const bulkInput = JSON.parse(String(requests.at(-1)!.init.body));
  assert.equal(bulkInput.filters.status, "inactive"); assert.equal(bulkInput.filters.search, "sample");
  const replayCalls = calls;
  await flow.handle("pages", "تأیید", context, true);
  assert.equal(calls, replayCalls, "a consumed confirmation cannot repeat a payment operation");
  await flow.handle("guard", "درگاه جدید بساز", context, true);
  const guardPlans = plans;
  await flow.handle("guard", "https://example.com/users/rules", context, true);
  assert.equal(plans, guardPlans, "draft values never invoke the intent model even if they resemble another domain");
  flow.clear("guard");
  for (const command of [
    { operation: "providerCreate" as const, input: { ...inputs.providerCreate as object, apiUrl: "https://127.0.0.1" } },
    { operation: "providerUpdate" as const, id, input: {} },
    { operation: "providerUpdate" as const, id, input: { callbackUrl: "javascript:alert(1)" } },
    { operation: "transactionCreate" as const, input: { bookingGroupRef: "bad", amount: 1000 } },
    { operation: "transactionCreate" as const, input: { bookingGroupRef: "NF-12345", amount: 999 } },
    { operation: "transactionUpdate" as const, id: txid, input: { amount: 1000 } },
    { operation: "providerBulk" as const, input: { action: "delete", scope: "page", ids: [] } },
    { operation: "providers" as const, input: { perPage: 51 } },
  ]) assert.throws(() => validatePaymentCommand(command));
  urlResult = "javascript:alert(1)"; const unsafe = await api.execute({ operation: "transactionCreate", input: inputs.transactionCreate }, context); assert(!unsafe.ok && unsafe.code === "UNSAFE_PAYMENT_URL");
  malformed = true; assert.deepEqual(await api.execute({ operation: "overview", input: {} }, context), { ok: false, code: "INVALID_RESPONSE" }); malformed = false;
  status = 403; const rejected = await api.execute({ operation: "providers", input: {} }, context); assert(!rejected.ok && rejected.code === "FORBIDDEN"); status = 200;
  failNetwork = true; const initial = calls; const failed = await api.execute({ operation: "providerTest", id, input: {} }, context); assert(!failed.ok && failed.code === "REQUEST_FAILED"); assert.equal(calls, initial + 1, "no automatic retry");
  assert(paymentCard({ isSuccessful: false }).includes("ناموفق"));
  console.log("All 11 payment contracts, private guided flows, financial warnings, secrets and conflicts passed");
}
if (process.argv[1]?.endsWith("payment-admin-test.ts")) testPaymentAdmin().catch(error => { console.error(error); process.exitCode = 1; });
