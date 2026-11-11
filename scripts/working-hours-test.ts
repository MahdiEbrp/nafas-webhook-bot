import assert from "node:assert/strict";
import { WorkingHoursApi, validateHoursCommand, type HourRow } from "../lib/working-hours/api";
import { TelegramWorkingHours, isBookableDaysRequest, isWorkingHoursRequest } from "../lib/telegram/working-hours";
import { clinicResourceFromText, isClinicOperationsRequest } from "../lib/telegram/clinic-operations";
import type { HoursPlan, HoursPlanner } from "../lib/working-hours/planner";
import type { RuleRequestContext } from "../lib/rules/types";

export async function testWorkingHours() {
  const id = "11111111-1111-4111-8111-111111111111";
  const row: HourRow = { id, day: "Saturday", opens: "09:00", closes: "17:00", capacity: 2, displayOrder: 0, isActive: true, slotCount: 1, patterns: [{ startTime: "10:00", capacity: 2 }] };
  const context = { actorId: "admin", sessionCookie: "session=test", csrfToken: "" };
  const calls: { url: URL; init: RequestInit }[] = [];
  let status = 200, invalidResponse = false, omitListPatterns = false;
  const api = new WorkingHoursApi(async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, init: init! });
    assert.equal((init!.headers as Record<string, string>).Cookie, context.sessionCookie);
    assert.equal((init!.headers as Record<string, string>).Origin, "https://clinic.example");
    assert.equal(init!.redirect, "error");
    if (status !== 200) return new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "private" } }), { status });
    let data: unknown = row;
    if (parsed.pathname.endsWith("/list")) {
      const listed = omitListPatterns ? { ...row, patterns: undefined } : row;
      data = { items: [listed], page: 1, perPage: 20, total: 1 };
    }
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
  const weeklyRequests = [
    "روزهای قابل رزرو رو نشون بده",
    "چه روزهایی آماده رزروه؟",
    "مدیریت برنامهٔ کاری کلینیک",
    "ظرفیت سه‌شنبه رو ۳ کن",
    "ساعات چهارشنبه رو تغییر بده",
    "جمعه رو به روزهای کاری اضافه کن",
    "روز دوشنبه رو غیرفعال کن",
  ];
  for (const request of weeklyRequests) {
    assert(isWorkingHoursRequest(request), `weekly schedule phrase is recognized: ${request}`);
    assert.equal(clinicResourceFromText(request), null, `weekly schedule phrase does not become bookings/slots: ${request}`);
    assert(!isClinicOperationsRequest(request), `weekly schedule phrase does not steal clinic routing: ${request}`);
  }
  for (const request of ["اسلات‌های فردا رو نشون بده", "ظرفیت اسلات ردیف اول رو تغییر بده"]) {
    assert(!isWorkingHoursRequest(request), `dated slot request stays separate: ${request}`);
    assert.equal(clinicResourceFromText(request), "slots", `dated slot request routes to slot management: ${request}`);
  }
  assert(isBookableDaysRequest("روزهای قابل رزرو رو نشون بده"));
  assert.equal((await turn("ساعات کاری را نشان بده"))?.status, "hours-listed");
  const directReadFlow = new TelegramWorkingHours(api, async () => { throw new Error("clear working-hours reads must bypass the planner"); }, () => now);
  const directReadStart = calls.length;
  assert.equal((await directReadFlow.handle("hours-direct", "ساعات کاری پنجشنبهٔ غیرفعال را نشان بده", context, true))?.status, "hours-listed");
  assert.equal(calls.at(-1)?.url.pathname, "/api/v1/working-hours/list");
  assert.equal(calls.at(-1)?.init.method, "GET");
  assert.equal(calls.at(-1)?.url.searchParams.get("status"), "inactive");
  assert.equal(calls.at(-1)?.url.searchParams.get("search"), "Thursday", "the weekday filter is translated to the API's canonical value");
  const beforePublicSchedule = calls.length;
  assert.equal((await directReadFlow.handle("public-days", "روزهای قابل رزرو رو نشون بده", context, false))?.status, "hours-private-only");
  assert.equal(calls.length, beforePublicSchedule, "bookable-day reads remain private-only");
  const bookable = await directReadFlow.handle("bookable-days", "روزهای قابل رزرو رو نشون بده", context, true);
  assert.equal(bookable?.status, "hours-listed");
  assert(bookable?.reply.includes("روزهای قابل رزرو"));
  assert(bookable?.reply.includes("ساعت: 10:00") && bookable.reply.includes("ظرفیت: 2"), "the weekly schedule read includes its slot-pattern times and capacities");
  assert(!bookable?.reply.includes("جایگزین"), "reading patterns is not described as replacing them");
  assert.equal(calls.at(-1)?.url.searchParams.get("status"), "active", "bookable days filter out inactive weekdays");
  assert.equal(calls.at(-1)?.url.searchParams.get("perPage"), "100", "the weekly list includes every available day");
  assert.equal(calls.at(-1)?.init.method, "GET", "bookable-day discovery is read-only");
  const beforeSparseList = calls.length;
  omitListPatterns = true;
  const sparseBookable = await directReadFlow.handle("bookable-days-sparse", "چه روزهایی آماده رزروه؟", context, true);
  omitListPatterns = false;
  assert.equal(sparseBookable?.status, "hours-listed", "a natural question still gets a direct schedule read without the planner");
  assert(sparseBookable?.reply.includes("ساعت: 10:00"), "missing list patterns are filled from the authorized weekday detail GET");
  assert(calls.slice(beforeSparseList).some(call => call.init.method === "GET" && call.url.pathname === `/api/v1/working-hours/${id}`), "patterns omitted by the summary endpoint are fetched through a GET detail route");
  assert.equal((await directReadFlow.handle("hours-direct-all", "ساعات کاری را فهرست کن", context, true))?.status, "hours-listed");
  assert.equal(calls.at(-1)?.url.searchParams.get("status"), "all");
  assert(calls.slice(directReadStart).every(call => call.init.method === "GET"), "deterministic working-hours reads never mutate");
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
  await testPersianWeeklyScheduleCommands();
}

async function testPersianWeeklyScheduleCommands() {
  const tuesdayId = "22222222-2222-4222-8222-222222222222";
  const mondayId = "33333333-3333-4333-8333-333333333333";
  const fridayId = "44444444-4444-4444-8444-444444444444";
  const context: RuleRequestContext = { actorId: "weekly-admin", sessionCookie: "weekly-session=test", csrfToken: "weekly-csrf" };
  const rows = new Map<string, HourRow>([
    [tuesdayId, { id: tuesdayId, day: "Tuesday", opens: "09:00", closes: "17:00", capacity: 2, displayOrder: 2, isActive: true, patterns: [{ startTime: "10:00", capacity: 2 }] }],
    [mondayId, { id: mondayId, day: "Monday", opens: "09:00", closes: "17:00", capacity: 2, displayOrder: 1, isActive: true, patterns: [] }],
  ]);
  const calls: { url: URL; init: RequestInit }[] = [];
  const writes: { url: URL; init: RequestInit }[] = [];
  const api = new WorkingHoursApi(async (input, init = {}) => {
    const url = new URL(String(input));
    const call = { url, init };
    calls.push(call);
    if (["POST", "PATCH", "DELETE"].includes(init.method ?? "GET")) writes.push(call);
    if (url.pathname === "/api/v1/working-hours/list") {
      const search = url.searchParams.get("search");
      const status = url.searchParams.get("status");
      const items = [...rows.values()].filter(row => (!search || row.day === search) && (status === "active" ? row.isActive : status === "inactive" ? !row.isActive : true));
      return new Response(JSON.stringify({ data: { items, page: 1, perPage: Number(url.searchParams.get("perPage") ?? 20), total: items.length } }));
    }
    if (url.pathname === "/api/v1/working-hours" && init.method === "POST") {
      const input = JSON.parse(String(init.body)) as Omit<HourRow, "id">;
      const created: HourRow = { ...input, id: fridayId };
      rows.set(fridayId, created);
      return new Response(JSON.stringify({ data: created }));
    }
    const id = url.pathname.split("/").at(-1)!;
    const current = rows.get(id);
    if (!current) return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 });
    if (init.method === "PATCH") {
      const patch = JSON.parse(String(init.body)) as Partial<HourRow>;
      const updated = { ...current, ...patch };
      rows.set(id, updated);
      return new Response(JSON.stringify({ data: updated }));
    }
    if (init.method === "DELETE") {
      rows.delete(id);
      return new Response(JSON.stringify({ data: { ok: true } }));
    }
    return new Response(JSON.stringify({ data: current }));
  }, "https://clinic.example");
  let plan: HoursPlan = { operation: "clarify", input: {} };
  const plannerRequests: string[] = [];
  const planner: HoursPlanner = async request => {
    plannerRequests.push(request);
    return plan;
  };
  const flow = new TelegramWorkingHours(api, planner, () => 20);
  const turn = (owner: string, text: string) => flow.handle(owner, text, context, true);

  plan = { operation: "update", day: "Tuesday", input: { capacity: 3 } };
  const beforeCapacityWrite = writes.length;
  const capacityPreview = await turn("capacity-tuesday", "ظرفیت سه‌شنبه رو ۳ کن");
  assert.equal(capacityPreview?.status, "hours-proposed");
  assert(capacityPreview?.reply.includes("ظرفیت: 3"));
  assert.equal(writes.length, beforeCapacityWrite, "weekday capacity changes are only previewed");
  assert.equal(calls.find(call => call.url.pathname === "/api/v1/working-hours/list" && call.url.searchParams.get("search") === "Tuesday")?.init.method, "GET");
  assert.equal((await turn("capacity-tuesday", "تأیید"))?.status, "hours-completed");
  assert.equal(writes.at(-1)?.init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(writes.at(-1)?.init.body)), { capacity: 3 });

  plan = { operation: "update", day: "Tuesday", input: { patterns: [{ startTime: "11:00", capacity: 3 }] } };
  const beforePatternPreview = writes.length;
  const patternPreview = await turn("pattern-tuesday", "الگوی نوبت سه‌شنبه رو تغییر بده");
  assert.equal(patternPreview?.status, "hours-proposed");
  assert(patternPreview?.reply.includes("به‌طور کامل جایگزین"), "pattern replacement is explicit in the preview");
  assert.equal(writes.length, beforePatternPreview, "pattern edits never write before confirmation");
  assert.equal((await turn("pattern-tuesday", "تأیید"))?.status, "hours-completed");
  assert.deepEqual(JSON.parse(String(writes.at(-1)?.init.body)), { patterns: [{ startTime: "11:00", capacity: 3 }] });

  const beforeClarification = writes.length;
  plan = { operation: "clarify", input: {} };
  const vagueHours = await turn("hours-wednesday", "ساعات چهارشنبه رو تغییر بده");
  assert.equal(vagueHours?.status, "hours-pending", "an unspecified hours change stays in the weekly schedule and asks for clarification");
  assert(plannerRequests.at(-1)?.includes("ساعات چهارشنبه رو تغییر بده"));
  assert.equal(writes.length, beforeClarification);

  plan = { operation: "update", day: "Monday", input: { isActive: false } };
  const beforeDeactivate = writes.length;
  assert.equal((await turn("deactivate-monday", "روز دوشنبه رو غیرفعال کن"))?.status, "hours-proposed");
  assert.equal(writes.length, beforeDeactivate);
  assert.equal((await turn("deactivate-monday", "بله"))?.status, "hours-completed");
  assert.deepEqual(JSON.parse(String(writes.at(-1)?.init.body)), { isActive: false });

  const beforeAdd = writes.length;
  const addStart = await turn("add-friday", "جمعه رو به روزهای کاری اضافه کن");
  assert.equal(addStart?.status, "hours-pending");
  assert(addStart?.reply.includes("ساعت شروع") && addStart.reply.includes("جمعه"), "adding a weekday asks for its missing hours without losing or guessing the selected day");
  assert.equal(plannerRequests.length, 4, "weekday creation starts a guided form without asking the planner");
  await turn("add-friday", "۰۹:۰۰");
  await turn("add-friday", "۱۷:۰۰");
  const addPreview = await turn("add-friday", "۳");
  assert.equal(addPreview?.status, "hours-proposed");
  assert(addPreview?.reply.includes("جمعه"));
  assert.equal(writes.length, beforeAdd, "new weekday is proposed before the POST");
  assert.equal((await turn("add-friday", "تأیید"))?.status, "hours-completed");
  assert.equal(writes.at(-1)?.url.pathname, "/api/v1/working-hours");
  assert.deepEqual(JSON.parse(String(writes.at(-1)?.init.body)), { day: "Friday", opens: "09:00", closes: "17:00", capacity: 3, displayOrder: 0, isActive: true });
}
if (process.argv[1]?.endsWith("working-hours-test.ts")) {
  testWorkingHours().then(() => console.log("Working-hours API and conversational tests passed.")).catch(error => { console.error(error); process.exitCode = 1; });
}
