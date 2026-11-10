import assert from "node:assert/strict";
import { WorkingHoursApi, validateHoursCommand, type HourRow } from "../lib/working-hours/api";
import { TelegramWorkingHours, isWorkingHoursRequest } from "../lib/telegram/working-hours";
import type { HoursPlan } from "../lib/working-hours/planner";

export async function testWorkingHours() {
  const id = "11111111-1111-4111-8111-111111111111";
  const row: HourRow = { id, day: "Saturday", opens: "09:00", closes: "17:00", capacity: 2, displayOrder: 0, isActive: true, patterns: [] };
  const context = { actorId: "admin", sessionCookie: "session=test", csrfToken: "" };
  const calls: { url: URL; init: RequestInit }[] = [];
  let status = 200, invalidResponse = false;
  const api = new WorkingHoursApi(async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, init: init! });
    assert.equal((init!.headers as Record<string, string>).Cookie, context.sessionCookie);
    assert.equal((init!.headers as Record<string, string>).Origin, "https://clinic.example");
    assert.equal(init!.redirect, "error");
    if (status !== 200) return new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "private" } }), { status });
    let data: unknown = row;
    if (parsed.pathname.endsWith("/list")) data = { items: [row], page: 1, perPage: 20, total: 1 };
    if (parsed.pathname.endsWith("/bulk")) data = { requested: 2, succeeded: 1, failures: [{ id, code: "OPERATION_FAILED" }] };
    if (init!.method === "DELETE") data = { ok: true };
    return new Response(JSON.stringify(invalidResponse ? {} : { data }));
  }, "https://clinic.example");
  const create = { day: "Saturday", opens: "09:00", closes: "17:00", capacity: 2 };
  for (const operation of ["list", "get", "create", "update", "delete", "bulk"] as const) {
    const input = operation === "create" ? create : operation === "update" ? { capacity: 3 } : operation === "bulk" ? { action: "delete", scope: "page", ids: [id] } : {};
    assert.equal((await api.execute({ operation, id, input }, context)).ok, true);
    const expected = operation === "list" ? "/api/v1/working-hours/list" : operation === "bulk" ? "/api/v1/working-hours/bulk" : operation === "create" ? "/api/v1/working-hours" : `/api/v1/working-hours/${id}`;
    assert.equal(calls.at(-1)!.url.pathname, expected);
    assert.equal(calls.at(-1)!.init.method, { list: "GET", get: "GET", create: "POST", update: "PATCH", delete: "DELETE", bulk: "POST" }[operation]);
  }
  assert.throws(() => validateHoursCommand({ operation: "update", id, input: { day: "Sunday" } }), "weekday immutable");
  assert.throws(() => validateHoursCommand({ operation: "create", input: { ...create, closes: "08:00" } }));
  assert.throws(() => validateHoursCommand({ operation: "create", input: { ...create, patterns: [{ startTime: "10:00", capacity: 1 }, { startTime: "10:00", capacity: 2 }] } }));
  assert.throws(() => validateHoursCommand({ operation: "create", input: { ...create, capacity: 501 } }));
  assert.throws(() => validateHoursCommand({ operation: "update", id, input: {} }));
  assert.throws(() => validateHoursCommand({ operation: "list", input: { perPage: 101 } }));
  assert.throws(() => validateHoursCommand({ operation: "delete", id: "../bad", input: {} }));
  assert.equal((await api.execute({ operation: "list", input: {} }, { ...context, sessionCookie: "" })).ok, false);

  let now = 10;
  let plan: HoursPlan = { operation: "list", input: {} };
  let plans = 0;
  const flow = new TelegramWorkingHours(api, async (request, rows) => {
    plans++;
    assert(!request.includes(context.sessionCookie));
    if (request.includes("دوم")) assert.equal(rows[0]?.id, id);
    return plan;
  }, () => now);
  const turn = (text: string, ctx = context) => flow.handle("owner", text, ctx, true);
  assert.equal((await flow.handle("owner", "ساعات کاری را نشان بده", null, true))?.status, "hours-auth-required");
  assert.equal((await flow.handle("owner", "ساعات کاری را نشان بده", context, false))?.status, "hours-private-only");
  assert(isWorkingHoursRequest("ساعات کاری را نشان بده"));
  assert(!isWorkingHoursRequest("قوانین را نشان بده"));
  assert.equal((await turn("ساعات کاری را نشان بده"))?.status, "hours-listed");
  plan = { operation: "delete", id, input: {} };
  const deletes = () => calls.filter(call => call.init.method === "DELETE").length;
  const beforeDelete = deletes();
  const proposal = await turn("ردیف دوم را حذف کن");
  assert.equal(proposal?.status, "hours-proposed");
  assert(proposal?.reply.includes("شنبه"));
  assert(proposal?.reply.includes("الگوهای نوبت"));
  assert.equal(deletes(), beforeDelete);
  const plansBefore = plans;
  assert.equal((await turn("تأیید"))?.status, "hours-completed");
  assert.equal(plans, plansBefore, "confirmation is deterministic");
  assert.equal(deletes(), beforeDelete + 1);
  await turn("تأیید");
  assert.equal(deletes(), beforeDelete + 1, "no replay");

  plan = { operation: "update", day: "Saturday", input: { opens: "18:00" } };
  assert.equal((await turn("ساعت کاری شنبه را تغییر بده"))?.status, "hours-invalid", "one-sided patch validated against current close");
  plan = { operation: "update", day: "Saturday", input: { opens: "10:00" } };
  assert.equal((await turn("ساعت کاری شنبه را تغییر بده"))?.status, "hours-proposed");
  assert.equal((await turn("بله"))?.status, "hours-completed");
  assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), { opens: "10:00" });
  plan = { operation: "delete", id: "99999999-9999-4999-8999-999999999999", input: {} };
  assert.equal((await turn("ساعات کاری را حذف کن"))?.status, "hours-invalid", "guessed id rejected");

  // Guided input accepts Persian weekdays/digits and never calls the model.
  const guided = new TelegramWorkingHours(api, async () => { throw new Error("no AI for field collection"); }, () => now);
  const guide = (text: string) => guided.handle("guided", text, context, true);
  await guide("ساعات کاری جدید بساز");
  await guide("شنبه");
  await guide("۰۹:۰۰");
  assert((await guide("۰۸:۰۰"))?.reply.includes("بعد از شروع"));
  await guide("۱۷:۰۰");
  assert.equal((await guide("پیش‌فرض"))?.status, "hours-proposed");
  const posts = calls.filter(call => call.init.method === "POST").length;
  assert.equal((await guide("بله"))?.status, "hours-completed");
  assert.equal(calls.filter(call => call.init.method === "POST").length, posts + 1);
  assert.equal(JSON.parse(String(calls.at(-1)!.init.body)).capacity, 1);
  await guide("ساعات کاری جدید بساز");
  await guide("شنبه"); await guide("۰۹:۰۰"); await guide("۱۷:۰۰"); await guide("۲");
  assert.equal((await guide("لغو"))?.status, "hours-cancelled");
  await guide("بله");
  assert.equal(calls.filter(call => call.init.method === "POST").length, posts + 1);

  plan = { operation: "create", input: create };
  await turn("ساعات کاری شنبه را اضافه کن"); // starts guided draft
  flow.clear("owner");
  await turn("ساعات کاری ثبت شود"); // complete plan -> proposal
  assert.equal((await turn("تأیید", { ...context, sessionCookie: "changed" }))?.status, "hours-session-changed");
  await turn("ساعات کاری ثبت شود");
  now += 300_001;
  assert.equal((await turn("بله"))?.status, "hours-expired");
  status = 403;
  assert.deepEqual(await api.execute({ operation: "list", input: {} }, context), { ok: false, status: 403, code: "FORBIDDEN" });
  status = 200; invalidResponse = true;
  assert.equal((await api.execute({ operation: "delete", id, input: {} }, context)).ok, false);
  const failing = new WorkingHoursApi(async () => { throw new Error("secret"); }, "https://clinic.example");
  assert.deepEqual(await failing.execute({ operation: "list", input: {} }, context), { ok: false, code: "REQUEST_FAILED" });
}
if (process.argv[1]?.endsWith("working-hours-test.ts")) {
  testWorkingHours().then(() => console.log("Working-hours API and conversational tests passed.")).catch(error => { console.error(error); process.exitCode = 1; });
}
