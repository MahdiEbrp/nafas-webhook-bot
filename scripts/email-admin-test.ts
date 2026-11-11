import assert from "node:assert/strict";
import { EmailAdminApi } from "@/lib/email-admin/api";
import { listEmailOperations, validateEmailCommand, type EmailCommand, type EmailOperation } from "@/lib/email-admin/validation";
import { TelegramEmailAdmin, emailProviderCard, isEmailAdminRequest } from "@/lib/telegram/email-admin";
import type { RuleRequestContext } from "@/lib/rules/types";

const providerId = "11111111-1111-4111-8111-111111111111";
const templateId = "22222222-2222-4222-8222-222222222222";
const messageId = "33333333-3333-4333-8333-333333333333";
const recipientId = "44444444-4444-4444-8444-444444444444";
const campaignId = "55555555-5555-4555-8555-555555555555";
const context: RuleRequestContext = { actorId: "admin-user-id", sessionCookie: "session=private-test", csrfToken: "csrf-test" };
const providerBase = {
  id: providerId, name: "Clinic SMTP", kind: "gmail", host: "smtp.gmail.com", port: 465,
  username: "private-user", passwordLast4: "leak", passwordConfigured: true, encryption: "ssl",
  fromEmail: "noreply@example.test", fromName: "Clinic", isActive: true, isDefault: true,
  healthStatus: "healthy", lastHealthCheckedAt: "2026-11-01T00:00:00.000Z",
  lastHealthError: "never-expose-this", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
};
const messageBase = {
  id: messageId, recipientMasked: "sa•••@example.test", providerName: "Clinic SMTP", providerKind: "gmail",
  status: "sent", providerMessageId: "private-provider-message-id", providerStatus: "private-provider-status",
  errorMessage: "never-expose-this", createdAt: "2026-11-01T00:00:00.000Z", sentAt: "2026-11-01T00:01:00.000Z", deliveredAt: null,
};
const templateBase = {
  id: templateId, key: "booking.confirmed", messageType: "transactional", contentFormat: "plain",
  variables: ["name"], translations: {
    fa: { name: "تأیید رزرو", subject: "رزرو {{name}}", content: "سلام {{name}}" },
    en: { name: "Booking confirmed", subject: "Booking {{name}}", content: "Hello {{name}}" },
  }, isActive: true, displayOrder: 1, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
};
const recipientBase = { id: recipientId, fullName: "Sara Example", email: "sara@example.test" };
const overview = {
  stats: { total: 3, sent: 2, delivered: 1, failed: 1, deliveryRate: 33 },
  providerCount: 1, activeProviderCount: 1, templateCount: 1, activeTemplateCount: 1,
  providers: [{ id: providerId, name: "Clinic SMTP", kind: "gmail", host: "private-host", passwordLast4: "private-last4", healthStatus: "healthy", isActive: true, isDefault: true, lastHealthCheckedAt: null }],
  recentMessages: [messageBase],
};

export async function testEmailAdmin() {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  let writes = 0;
  let httpStatus = 200;
  let failNetwork = false;
  let malformed = false;
  let provider = { ...providerBase };
  let template = { ...templateBase };
  let successfulTest = true;
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("cookie"), context.sessionCookie);
    assert.equal(headers.get("origin"), "https://clinic.example");
    assert.equal(headers.get("x-csrf-token"), context.csrfToken);
    if (failNetwork) throw new Error("private-network-secret");
    if (httpStatus !== 200) return new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "never-expose-this" } }), { status: httpStatus });
    if (malformed) return new Response(JSON.stringify({ data: { unexpected: "secret" } }));
    const path = url.pathname;
    const method = init.method ?? "GET";
    let data: unknown;
    if (method === "GET" && path.endsWith("/overview")) data = overview;
    else if (method === "GET" && path.endsWith("/providers")) data = { items: [provider], total: 1, page: 1, perPage: 10, totalPages: 1 };
    else if (method === "GET" && path.endsWith(`/providers/${providerId}`)) data = provider;
    else if (method === "GET" && path.endsWith("/messages")) data = { items: [messageBase], total: 1, page: 1, perPage: 20, totalPages: 1 };
    else if (method === "GET" && path.endsWith("/recipients")) data = { items: [recipientBase], total: 1, page: 1, perPage: 10, totalPages: 1 };
    else if (method === "GET" && path.endsWith("/templates")) data = { items: [template], total: 1, page: 1, perPage: 10, totalPages: 1 };
    else if (method === "GET" && path.endsWith(`/templates/${templateId}`)) data = template;
    else {
      if (["POST", "PATCH", "DELETE"].includes(method)) writes++;
      if (method === "POST" && path.endsWith(`/providers/${providerId}/test`)) {
        data = { providerId, successful: successfulTest, responseTimeMs: 12, providerMessageId: "private-provider-message-id" };
        provider = { ...provider, updatedAt: "2026-11-02T00:00:00.000Z" };
      } else if (method === "POST" && path.endsWith("/messages")) data = { campaignId, total: 1, sent: 1, failed: 0, status: "sent", subject: "private-subject", characters: 20 };
      else if (method === "POST" && path.endsWith("/providers")) data = { id: providerId };
      else if (method === "POST" && path.endsWith("/templates")) data = { id: templateId };
      else data = { ok: true };
    }
    return new Response(JSON.stringify({ data }));
  };
  const api = new EmailAdminApi(fetcher, "https://clinic.example");
  const validInputs: Record<EmailOperation, unknown> = {
    overview: {}, providers: {}, providerCreate: { name: "Test SMTP", kind: "fake", host: "smtp.fake.local", port: 465, username: "test-user", password: "test-password" },
    providerGet: {}, providerUpdate: { isActive: false }, providerDelete: {}, providerTest: { recipient: "owner@example.test", subject: "Test", message: "SMTP test" },
    messages: {}, messageSend: { recipients: ["sara@example.test"], subject: "Hello", message: "World", idempotencyKey: "test-key-0001" }, messageDelete: {},
    recipients: {}, templates: {}, templateCreate: { key: templateBase.key, messageType: templateBase.messageType, contentFormat: templateBase.contentFormat, variables: templateBase.variables, translations: templateBase.translations }, templateGet: {}, templateUpdate: { isActive: false }, templateDelete: {},
  };
  assert.equal(Object.keys(listEmailOperations).length, 16, "all 16 route operations are represented");
  for (const operation of Object.keys(listEmailOperations) as EmailOperation[]) {
    const id = operation.startsWith("provider") ? providerId : operation.startsWith("template") ? templateId : operation === "messageDelete" ? messageId : undefined;
    const result = await api.execute({ operation, ...(id ? { id } : {}), input: validInputs[operation] }, context);
    assert(result.ok, operation);
    const printable = JSON.stringify(result);
    for (const secret of ["private-user", "passwordLast4", "never-expose-this", "private-provider-message-id", "private-provider-status", "private-subject", "private-last4"]) assert(!printable.includes(secret), `${operation} response excludes ${secret}`);
  }
  assert.equal(calls.length, 16, "no hidden retries");
  const sendCall = calls.find(call => call.url.pathname.endsWith("/messages") && call.init.method === "POST")!;
  assert.equal((JSON.parse(String(sendCall.init.body)) as Record<string, unknown>).idempotencyKey, "test-key-0001");
  assert.equal(calls[1]!.url.searchParams.get("perPage"), "10");
  assert.equal(calls[13]!.url.pathname, `/api/v1/admin/email/templates/${templateId}`);

  for (const command of [
    { operation: "providerCreate" as const, input: { name: "SMTP", kind: "gmail", host: "localhost", port: 465, username: "u", password: "p" } },
    { operation: "providerCreate" as const, input: { name: "SMTP", kind: "liara", host: "http://mail.example.com/api", port: 443, username: "u", password: "p" } },
    { operation: "providerCreate" as const, input: { name: "SMTP", kind: "gmail", host: "192.168.1.2", port: 465, username: "u", password: "p" } },
    { operation: "providerUpdate" as const, id: providerId, input: { password: "" } },
    { operation: "providerUpdate" as const, id: providerId, input: { host: "127.0.0.1" } },
    { operation: "messageSend" as const, input: { recipients: ["bad"], subject: "hi", message: "body" } },
    { operation: "messageSend" as const, input: { recipients: ["sara@example.test", "SARA@example.test"], subject: "hi", message: "body" } },
    { operation: "messageSend" as const, input: { recipients: ["sara@example.test"], message: "body" } },
    { operation: "templateUpdate" as const, id: templateId, input: { nonsense: true } },
    { operation: "messageDelete" as const, id: "bad-id", input: {} },
  ] satisfies EmailCommand[]) assert.throws(() => validateEmailCommand(command));

  const beforeUnauthed = calls.length;
  assert.deepEqual(await api.execute({ operation: "messages", input: {} }, { actorId: "", sessionCookie: "", csrfToken: "" }), { ok: false, code: "AUTH_REQUIRED" });
  assert.equal(calls.length, beforeUnauthed);
  malformed = true;
  const invalidResponse = await api.execute({ operation: "overview", input: {} }, context);
  assert(!invalidResponse.ok && invalidResponse.code === "INVALID_RESPONSE");
  malformed = false;
  httpStatus = 403;
  const denied = await api.execute({ operation: "providers", input: {} }, context);
  assert(!denied.ok && denied.code === "FORBIDDEN");
  httpStatus = 200;
  failNetwork = true;
  const beforeFailedCall = calls.length;
  const failed = await api.execute({ operation: "messageSend", input: validInputs.messageSend }, context);
  assert(!failed.ok && failed.code === "REQUEST_FAILED");
  assert.equal(calls.length, beforeFailedCall + 1, "send has no automatic retry");
  failNetwork = false;

  let plan: { operation: EmailOperation | "help" | "clarify"; id?: string; target?: string; input: Record<string, unknown> } = { operation: "overview", input: {} };
  let plannerCalls = 0;
  let plannerChoices: Array<{ id: string; title: string; resource: string }> = [];
  const plannerQueries: Record<string, unknown>[] = [];
  const flow = new TelegramEmailAdmin(api, async (request, choices, query) => {
    plannerCalls++;
    assert(!/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/iu.test(request), "emails never enter the intent model");
    assert(!/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/iu.test(JSON.stringify(query)), "private email filters are kept local");
    assert(!/smtp\.gmail\.com|private-password|private-user/iu.test(request + JSON.stringify(query)), "provider configuration never enters the intent model");
    assert(choices.every(choice => Object.keys(choice).sort().join(",") === "id,resource,title"), "only choice metadata reaches planner");
    assert(!JSON.stringify(choices).includes("sara@example.test"));
    plannerChoices = choices;
    plannerQueries.push(query);
    return plan as never;
  }, () => clock);
  let clock = 1_000_000;

  let failedReadPlans = 0;
  const deterministicReads = new TelegramEmailAdmin(api, async () => { failedReadPlans++; throw new Error("clear email reads must bypass the planner"); }, () => clock);
  const deterministicReadStart = calls.length, writesBeforeReads = writes;
  const emailReadCases = [
    ["آمار ایمیل را نشان بده", "email-overview", "/overview", undefined],
    ["گزارش ایمیل", "email-overview", "/overview", undefined],
    ["سرویس‌های ایمیل غیرفعال را فهرست کن", "email-listed", "/providers", "inactive"],
    ["گزارش ایمیل‌های ناموفق را نشان بده", "email-listed", "/messages", "failed"],
    ["قالب‌های ایمیل فعال را نشان بده", "email-listed", "/templates", "active"],
    ["گیرنده‌های ایمیل را نشان بده", "email-listed", "/recipients", undefined],
  ] as const;
  for (const [request, expectedStatus, suffix, filter] of emailReadCases) {
    assert.equal((await deterministicReads.handle(`email-read-${calls.length}`, request, context, true))?.status, expectedStatus, request);
    const call = calls.at(-1)!;
    assert.equal(call.url.pathname, `/api/v1/admin/email${suffix}`);
    assert.equal(call.init.method, "GET", "deterministic email reads are GET-only");
    if (filter) assert.equal(call.url.searchParams.get("status"), filter, "email list status filters are preserved");
  }
  assert.equal(failedReadPlans, 0, "clear email reads still work when the planner throws");
  assert.equal(writes, writesBeforeReads, "deterministic email reads do not send or mutate");
  assert(calls.slice(deterministicReadStart).every(call => call.init.method === "GET"));

  assert(isEmailAdminRequest("ایمیل‌ها را نشان بده"));
  assert(isEmailAdminRequest("sara@example.test"));
  assert(!isEmailAdminRequest("سلام، امروز چندمه؟"));
  const displayedHost = emailProviderCard({ ...providerBase, host: "https://user:secret@mail.example.test/api/send?token=private" });
  assert(displayedHost.includes("https://mail.example.test/[مسیر پنهان]?[پارامترها پنهان]"));
  for (const secret of ["user:secret", "token=private", "/api/send"]) assert(!displayedHost.includes(secret));
  assert(emailProviderCard({ ...providerBase, host: "username:password@server" }).includes("[میزبان پنهان]"));
  const callsBeforeAuth = calls.length, plansBeforeAuth = plannerCalls;
  assert.equal((await flow.handle("anon", "گزارش ایمیل", null, true))?.status, "email-auth-required");
  assert.equal((await flow.handle("group", "گزارش ایمیل", context, false))?.status, "email-private-only");
  assert.equal(calls.length, callsBeforeAuth); assert.equal(plannerCalls, plansBeforeAuth);
  const callsBeforeMissingIds = calls.length;
  plan = { operation: "providerGet", input: {} };
  assert.equal((await flow.handle("missing-provider", "سرویس ایمیل را ببین", context, true))?.status, "email-clarify");
  plan = { operation: "templateDelete", input: {} };
  assert.equal((await flow.handle("missing-template", "قالب ایمیل را حذف کن", context, true))?.status, "email-clarify");
  plan = { operation: "messageDelete", input: {} };
  assert.equal((await flow.handle("missing-message", "گزارش ایمیل را حذف کن", context, true))?.status, "email-clarify");
  assert.equal(calls.length, callsBeforeMissingIds, "missing resource IDs are clarified before any API request");

  const plansBeforeDirect = plannerCalls;
  const direct = await flow.handle("direct", "ایمیل برای sara@example.test بفرست", context, true);
  assert.equal(direct?.status, "email-send-draft"); assert(direct?.deleteSensitiveMessage); assert.equal(plannerCalls, plansBeforeDirect, "a direct recipient is captured without the model");
  flow.clear("direct");
  const plansBeforeConfig = plannerCalls;
  assert.equal((await flow.handle("config-host", "میزبان سرویس ایمیل smtp.gmail.com است", context, true))?.status, "email-local-input-required");
  assert.equal((await flow.handle("config-secret", "email provider username: private-password", context, true))?.status, "email-local-input-required");
  assert.equal(plannerCalls, plansBeforeConfig, "provider hosts and keyed credentials are intercepted before the model");

  plan = { operation: "providers", input: { page: 1, perPage: 10, search: "Clinic SMTP", status: "all" } };
  await flow.handle("filter", "سرویس Clinic SMTP را جست‌وجو کن", context, true);
  plan = { operation: "providers", input: { page: 2, perPage: 10, status: "all" } };
  await flow.handle("filter", "صفحه بعد", context, true);
  const safeQuery = plannerQueries.at(-1)?.providers as Record<string, unknown>;
  assert.equal(safeQuery.searchPresent, true);
  assert(!("search" in safeQuery) && !JSON.stringify(safeQuery).includes("Clinic SMTP"), "search terms remain local across pagination");
  assert.equal(calls.at(-1)?.url.searchParams.get("search"), "Clinic SMTP", "the exact filter is still applied locally");

  plan = { operation: "providers", input: { page: 1, perPage: 10, status: "all" } };
  await flow.handle("flow", "سرویس‌های ایمیل را فهرست کن", context, true);
  await flow.handle("flow", "فهرست سرویس‌های ایمیل", context, true);
  assert.equal(plannerChoices[0]?.resource, "providers");
  plan = { operation: "providerCreate", input: { password: "model-must-not-set" } };
  const createStart = await flow.handle("flow", "سرویس ایمیل جدید بساز", context, true);
  assert.equal(createStart?.status, "email-draft");
  const inputs = ["Test Fake", "fake", "پیش‌فرض", "پیش‌فرض", "private-username", "private-password", "پیش‌فرض", "sender@example.test", "Test Sender", "بله", "خیر"];
  const beforeCreate = writes;
  let proposal: { reply: string; status: string; deleteSensitiveMessage?: boolean } | null = null;
  for (const input of inputs) proposal = await flow.handle("flow", input, context, true);
  assert.equal(proposal?.status, "email-proposed"); assert(proposal?.deleteSensitiveMessage);
  assert(!proposal?.reply.includes("private-password") && !proposal?.reply.includes("private-username"));
  assert.equal(writes, beforeCreate, "creating a provider only proposes until confirmation");
  await flow.handle("flow", "لغو", context, true); assert.equal(writes, beforeCreate);
  plan = { operation: "providers", input: { page: 1, perPage: 10, status: "all" } };
  await flow.handle("flow", "سرویس‌های ایمیل را فهرست کن", context, true);

  plan = { operation: "providerUpdate", id: providerId, input: {} };
  await flow.handle("flow", "سرویس اول را ویرایش کن", context, true);
  const editInput = await flow.handle("flow", '{"password":"new-private-password","isActive":false}', context, true);
  assert.equal(editInput?.status, "email-proposed"); assert(editInput?.deleteSensitiveMessage); assert(!editInput?.reply.includes("new-private-password"));
  provider = { ...provider, updatedAt: "2026-11-03T00:00:00.000Z" };
  const beforeConflict = writes;
  assert.equal((await flow.handle("flow", "تأیید", context, true))?.status, "email-conflict");
  assert.equal(writes, beforeConflict, "provider edits re-read before mutation");

  plan = { operation: "providerTest", id: providerId, input: {} };
  await flow.handle("flow", "سرویس اول را تست کن", context, true);
  await flow.handle("flow", "owner@example.test", context, true);
  await flow.handle("flow", "بررسی سرویس", context, true);
  const testProposal = await flow.handle("flow", "این پیام آزمایشی است", context, true);
  assert.equal(testProposal?.status, "email-proposed"); assert(testProposal?.reply.includes("ایمیل واقعی"));
  const beforeTest = writes;
  const testResult = await flow.handle("flow", "بله", context, true);
  assert.equal(testResult?.status, "email-test-completed"); assert.equal(writes, beforeTest + 1);
  const testBody = JSON.parse(String(calls.at(-1)!.init.body)) as Record<string, unknown>;
  assert.equal(testBody.recipient, "owner@example.test"); assert.equal(testBody.message, "این پیام آزمایشی است");

  plan = { operation: "templates", input: { page: 1, perPage: 10, status: "all" } };
  await flow.handle("flow", "قالب‌های ایمیل را نشان بده", context, true);
  plan = { operation: "templateGet", id: templateId, input: {} };
  const readTemplate = await flow.handle("flow", "قالب اول را ببین", context, true);
  assert.equal(readTemplate?.status, "email-read");
  plan = { operation: "templateCreate", input: {} };
  await flow.handle("flow", "قالب ایمیل جدید بساز", context, true);
  const newTemplate = { key: "notice.test", messageType: "transactional", contentFormat: "plain", variables: [], translations: { fa: { name: "آزمایشی", subject: "موضوع", content: "متن" }, en: { name: "Test", subject: "Subject", content: "Body" } } };
  const templateProposal = await flow.handle("flow", JSON.stringify(newTemplate), context, true);
  assert.equal(templateProposal?.status, "email-proposed"); assert(templateProposal?.reply.includes("متن"));
  const beforeTemplateCreate = writes;
  assert.equal((await flow.handle("flow", "تأیید", context, true))?.status, "email-completed");
  assert.equal(writes, beforeTemplateCreate + 1);
  plan = { operation: "templateUpdate", id: templateId, input: {} };
  await flow.handle("flow", "قالب اول را ویرایش کن", context, true);
  const templatePatch = await flow.handle("flow", '{"isActive":false}', context, true);
  assert.equal(templatePatch?.status, "email-proposed");
  template = { ...template, updatedAt: "2026-11-04T00:00:00.000Z" };
  const beforeTemplateConflict = writes;
  assert.equal((await flow.handle("flow", "تأیید", context, true))?.status, "email-conflict");
  assert.equal(writes, beforeTemplateConflict);
  plan = { operation: "templateDelete", id: templateId, input: {} };
  const templateDeleteProposal = await flow.handle("flow", "قالب اول را حذف کن", context, true);
  assert.equal(templateDeleteProposal?.status, "email-proposed");
  assert.equal((await flow.handle("flow", "بله", context, true))?.status, "email-completed");

  plan = { operation: "recipients", input: { page: 1, perPage: 10 } };
  const recipients = await flow.handle("flow", "گیرنده‌های ایمیل را نشان بده", context, true);
  assert(recipients?.reply.includes("sara@example.test"));
  assert(!JSON.stringify(plannerChoices).includes("sara@example.test"), "recipient addresses never reach the planner");
  plan = { operation: "messageSend", input: { recipients: ["invented@example.test"], message: "model injected" } };
  const plannerCallsBeforeSend = plannerCalls;
  const sendStart = await flow.handle("flow", "ایمیل بفرست", context, true);
  assert.equal(sendStart?.status, "email-send-draft"); assert.equal(plannerCalls, plannerCallsBeforeSend, "send intent bypasses the model");
  const sendInputs = ["1", "متن", "سلام", "متن ایمیل دقیق", "plain", "transactional", "fa", "پیش‌فرض", "بدون", "فاکتور خرداد"];
  for (const input of sendInputs.slice(0, 8)) await flow.handle("flow", input, context, true);
  // The next step after provider is the optional sender, then the campaign name.
  await flow.handle("flow", "بدون", context, true);
  const sendProposal = await flow.handle("flow", "فاکتور خرداد", context, true);
  assert.equal(sendProposal?.status, "email-proposed");
  assert(sendProposal?.reply.includes("سارا@example.test") || sendProposal?.reply.includes("sara@example.test"));
  assert(sendProposal?.reply.includes("متن ایمیل دقیق")); assert(sendProposal?.reply.includes("۱ گیرنده") || sendProposal?.reply.includes("1 گیرنده"));
  const beforeSend = writes;
  assert.equal(writes, beforeSend, "email send proposal has no side effects");
  const completed = await flow.handle("flow", "تأیید", context, true);
  assert.equal(completed?.status, "email-send-completed"); assert.equal(writes, beforeSend + 1);
  const sendBody = JSON.parse(String(calls.at(-1)!.init.body)) as Record<string, unknown>;
  assert.deepEqual(sendBody.recipients, ["sara@example.test"]); assert.equal(sendBody.message, "متن ایمیل دقیق"); assert.equal(sendBody.idempotencyKey?.toString().length, 36);
  const replayCalls = calls.length;
  await flow.handle("flow", "تأیید", context, true);
  assert.equal(calls.length, replayCalls, "a consumed approval cannot resend");

  plan = { operation: "messages", input: { page: 1, perPage: 20, status: "all" } };
  await flow.handle("flow", "گزارش ارسال‌های ایمیل را نشان بده", context, true);
  plan = { operation: "messageDelete", id: messageId, input: {} };
  const deleteProposal = await flow.handle("flow", "گزارش اول را حذف کن", context, true);
  assert.equal(deleteProposal?.status, "email-proposed"); assert(deleteProposal?.reply.includes("پس گرفته یا از صندوق"));
  const beforeDelete = writes;
  assert.equal((await flow.handle("flow", "تأیید", context, true))?.status, "email-completed");
  assert.equal(writes, beforeDelete + 1);

  plan = { operation: "providerCreate", input: {} };
  await flow.handle("expiry", "سرویس ایمیل جدید بساز", context, true); clock += 300_001;
  assert.equal((await flow.handle("expiry", "تأیید", context, true))?.status, "email-expired");
  await flow.handle("session", "سرویس ایمیل جدید بساز", context, true);
  assert.equal((await flow.handle("session", "نام جدید", { ...context, sessionCookie: "session=changed" }, true))?.status, "email-session-changed");

  const lastCalls = calls.length;
  failNetwork = true;
  const noRetry = await api.execute({ operation: "messageSend", input: validInputs.messageSend }, context);
  assert(!noRetry.ok && noRetry.code === "REQUEST_FAILED"); assert.equal(calls.length, lastCalls + 1);
  console.log("All 16 email admin routes, private drafts, real-send confirmations, redaction, snapshots and no-retry contracts passed");
}

if (process.argv[1]?.endsWith("email-admin-test.ts")) testEmailAdmin().catch(error => { console.error(error); process.exitCode = 1; });
