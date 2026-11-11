import assert from "node:assert/strict";
import {
  CLINIC_OPERATIONS,
  CLINIC_RESOURCES,
  CLINIC_ROUTE_MANIFEST,
  ClinicOperationsApi,
  validateClinicCommand,
  type ClinicCommand,
  type ClinicResource,
} from "@/lib/clinic-operations/api";
import { scrubClinicPlannerText, type ClinicPlan, type ClinicPlanner } from "@/lib/clinic-operations/planner";
import { TelegramClinicOperations } from "@/lib/telegram/clinic-operations";
import { inlineSuggestionsForReply, resolveInlineSuggestion } from "@/lib/telegram/inline-suggestions";
import type { RuleRequestContext } from "@/lib/rules/types";

const ID = "11111111-1111-4111-8111-111111111111";
const GROUP_ID = "22222222-2222-4222-8222-222222222222";
const CATEGORY_ID = "33333333-3333-4333-8333-333333333333";
const SLOT_ID = "44444444-4444-4444-8444-444444444444";
const GUIDE_ID = "55555555-5555-4555-8555-555555555555";
const BOOKING_ID = "66666666-6666-4666-8666-666666666666";
const SECOND_ID = "77777777-7777-4777-8777-777777777777";
const context: RuleRequestContext = {
  actorId: "clinic-user",
  sessionCookie: "clinic_session=private-test-cookie",
  csrfToken: "private-test-csrf",
};
const BASE_URL = "https://clinic.example";

type Call = { url: URL; init: RequestInit };
const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(data), { status, headers });
const envelope = (data: unknown, status = 200) => json({ data }, status);

function collectionCases(
  resource: ClinicResource,
  create: Record<string, unknown>,
  update: Record<string, unknown>,
): ClinicCommand[] {
  return [
    { resource, operation: "list", input: {} },
    { resource, operation: "get", id: ID, input: {} },
    { resource, operation: "create", input: create },
    { resource, operation: "update", id: ID, input: update },
    { resource, operation: "delete", id: ID, input: {} },
    { resource, operation: "bulk", input: { action: "deactivate", scope: "page", ids: [ID] } },
  ];
}

const commands: ClinicCommand[] = [
  ...collectionCases("service-groups", {
    slug: "test-group", translations: { fa: { name: "گروه آزمایشی" }, en: { name: "Test group" } },
  }, { isActive: false }),
  ...collectionCases("service-categories", {
    groupId: GROUP_ID, slug: "test-category", translations: { fa: { name: "دسته آزمایشی" }, en: { name: "Test category" } },
  }, { isActive: false }),
  ...collectionCases("services", {
    categoryId: CATEGORY_ID, slug: "test-service", translations: { fa: { title: "خدمت آزمایشی" }, en: { title: "Test service" } },
  }, { price: 25 }),
  { resource: "service-catalog", operation: "catalog", input: {} },
  ...collectionCases("care-guides", {
    slug: "test-guide", translations: { fa: { name: "راهنمای آزمایشی" }, en: { name: "Test guide" } },
  }, { isActive: false }),
  ...collectionCases("care-guide-items", {
    guideId: GUIDE_ID, translations: { fa: { title: "نکتهٔ آزمایشی" }, en: { title: "Test tip" } },
  }, { highlighted: true }),
  ...collectionCases("landing-marquee", {
    translations: { fa: { text: "متن آزمایشی" }, en: { text: "Test text" } },
  }, { isActive: false }),
  ...collectionCases("landing-services", {
    translations: { fa: { title: "کارت آزمایشی" }, en: { title: "Test card" } },
  }, { isActive: false }),
  ...collectionCases("landing-stats", {
    value: 4, translations: { fa: { label: "آمار آزمایشی" }, en: { label: "Test statistic" } },
  }, { value: 5 }),
  ...collectionCases("landing-gallery", {
    imageUrl: "https://clinic.example/image.jpg", translations: { fa: { alt: "تصویر آزمایشی" }, en: { alt: "Test image" } },
  }, { isActive: false }),
  { resource: "landing-hero", operation: "get", input: {} },
  { resource: "landing-hero", operation: "update", input: { image: "https://clinic.example/hero.jpg" } },
  { resource: "landing-sections", operation: "get", input: {} },
  { resource: "landing-sections", operation: "update", input: { seo: { fa: { seoTitle: "خانه" }, en: { seoTitle: "Home" } } } },
  { resource: "bookings", operation: "list", input: {} },
  { resource: "bookings", operation: "get", id: ID, input: {} },
  { resource: "bookings", operation: "create", input: { fullName: "Alex Example", phone: "+3725551234", groupId: GROUP_ID, slotId: SLOT_ID, locale: "en" } },
  { resource: "bookings", operation: "update", id: ID, input: { status: "paid" } },
  { resource: "bookings", operation: "delete", id: ID, input: {} },
  { resource: "bookings", operation: "bulk", input: { action: "delete", scope: "page", ids: [ID] } },
  { resource: "slots", operation: "availability", input: { from: "2026-12-01", to: "2026-12-01", groupId: GROUP_ID } },
  { resource: "slots", operation: "list", input: {} },
  { resource: "slots", operation: "get", id: ID, input: {} },
  { resource: "slots", operation: "create", input: { slots: [{ slotDate: "2026-12-01", startTime: "09:00", endTime: "10:00", capacity: 1 }] } },
  { resource: "slots", operation: "update", id: ID, input: { capacity: 2 } },
  { resource: "slots", operation: "delete", id: ID, input: {} },
  { resource: "slots", operation: "bulk", input: { action: "deactivate", scope: "page", ids: [ID] } },
  { resource: "slots", operation: "generate", input: {} },
  { resource: "my-bookings", operation: "list", input: {} },
  { resource: "my-bookings", operation: "cancel", id: ID, input: {} },
  { resource: "notifications", operation: "list", input: {} },
  { resource: "notifications", operation: "mark-read", input: {} },
  { resource: "profile", operation: "get", input: {} },
  { resource: "sessions", operation: "revoke-others", input: {} },
  { resource: "password", operation: "change", input: { password: "ServicesSecure1!", confirmPassword: "ServicesSecure1!" } },
  { resource: "auth-session", operation: "logout", input: {} },
];

const serviceRow = {
  id: ID,
  slug: "facial-care",
  title: "Facial care",
  translations: { en: { title: "Facial care" }, fa: { title: "مراقبت پوست" } },
  isActive: true,
  price: 20,
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const groupRow = {
  id: GROUP_ID,
  name: "Skin care",
  translations: { en: { name: "Skin care" }, fa: { name: "مراقبت پوست" } },
  isActive: true,
};
const slotRow = {
  id: SLOT_ID,
  slotDate: "2026-12-01",
  startTime: "09:00",
  endTime: "10:00",
  capacity: 1,
  bookedCount: 0,
  available: true,
};
const ownBooking = {
  id: BOOKING_ID,
  groupTitle: "Skin care",
  slotStart: "2026-12-01T09:00:00.000Z",
  status: "pending",
  canCancel: true,
  fullName: "Alex Example",
  phone: "+3725551234",
  email: "alex@example.test",
};

async function testAllowListAndHttpContract() {
  const calls: Call[] = [];
  const api = new ClinicOperationsApi(async (input, init = {}) => {
    calls.push({ url: new URL(String(input)), init });
    return envelope({ items: [], page: 1, total: 0 });
  }, BASE_URL);
  const keys = commands.map((command) => `${command.resource}.${command.operation}`).sort();
  assert.equal(new Set(keys).size, keys.length, "each route operation has one fixture");
  assert.deepEqual(keys, CLINIC_ROUTE_MANIFEST.map((route) => `${route.resource}.${route.operation}`).sort(), "fixtures cover the exact route manifest");
  assert.equal(CLINIC_ROUTE_MANIFEST.length, 81, "all allow-listed methods have HTTP mock coverage");
  assert(CLINIC_RESOURCES.includes("my-bookings"));
  assert(CLINIC_OPERATIONS.includes("cancel"));
  for (const route of CLINIC_ROUTE_MANIFEST) {
    assert(!/webhooks|callback|\/files(?:\/|$)|\/internal(?:\/|$)|notifications\/stream|auth\/register/iu.test(route.path), `excluded route is absent: ${route.path}`);
  }

  for (const command of commands) {
    const expected = CLINIC_ROUTE_MANIFEST.find((route) => route.resource === command.resource && route.operation === command.operation)!;
    const validated = validateClinicCommand(command);
    assert.equal(validated.path, expected.path.replace(":id", ID));
    assert.equal(validated.method, expected.method);
    const result = await api.execute(command, context);
    assert(result.ok, `${command.resource}.${command.operation} succeeds with the mock envelope`);
    const call = calls.at(-1)!;
    assert.equal(call.url.origin, BASE_URL);
    assert.equal(call.url.pathname, expected.path.replace(":id", ID));
    assert.equal(call.init.method, expected.method);
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.credentials, "omit");
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("cookie"), context.sessionCookie, "the Telegram user's authenticated cookie is forwarded");
    assert.equal(headers.get("origin"), BASE_URL);
    assert.equal(headers.get("x-csrf-token"), context.csrfToken);
    const hasBody = ["POST", "PATCH"].includes(expected.method) && Object.keys(validated.input).length > 0;
    if (hasBody) {
      assert.equal(headers.get("content-type"), "application/json");
      assert.deepEqual(JSON.parse(String(call.init.body)), validated.input, `${command.resource}.${command.operation} sends the upstream-validated payload`);
    } else {
      assert.equal(call.init.body, undefined, `${command.resource}.${command.operation} has no fabricated body`);
    }
  }
  assert.equal(calls.length, commands.length, "operations do not retry automatically");
  const availability = calls.find((call) => call.url.pathname === "/api/v1/bookings/slots")!;
  assert.equal(availability.url.searchParams.get("from"), "2026-12-01");
  assert.equal(availability.url.searchParams.get("groupId"), GROUP_ID);

  const beforeRejects = calls.length;
  const invalidCommands = [
    { resource: "services", operation: "create", input: { slug: "bad slug" } },
    { resource: "bookings", operation: "create", input: { fullName: "x", phone: "not-a-phone" } },
    { resource: "notifications", operation: "delete", input: {} },
    { resource: "services", operation: "delete", id: "../../private", input: {} },
    { resource: "webhooks", operation: "list", input: {} },
    { resource: "files", operation: "get", id: ID, input: {} },
    { resource: "payments", operation: "callback", input: {} },
    { resource: "notifications", operation: "stream", input: {} },
    { resource: "auth", operation: "register", input: {} },
  ] as unknown as ClinicCommand[];
  for (const command of invalidCommands) {
    const result = await api.execute(command, context);
    assert.deepEqual(result, { ok: false, code: "INVALID_INPUT" });
  }
  assert.equal(calls.length, beforeRejects, "invalid, guessed, and excluded routes never reach upstream");
  assert.deepEqual(await api.execute({ resource: "services", operation: "list", input: {} }, { ...context, sessionCookie: "" }), { ok: false, code: "AUTH_REQUIRED" });
  assert.equal(calls.length, beforeRejects, "missing auth never sends a request");

  let mode: "ok" | "forbidden" | "rate-limit" | "malformed" | "deep" | "oversized" | "network" = "ok";
  let oversizedCancelled = false;
  const guarded = new ClinicOperationsApi(async () => {
    if (mode === "forbidden") return json({ error: { code: "FORBIDDEN", message: "never-expose-upstream-details" } }, 403);
    if (mode === "rate-limit") return json({ error: { message: "private upstream body" } }, 429);
    if (mode === "malformed") return new Response("not-json");
    if (mode === "deep") {
      let nested: Record<string, unknown> = { value: true };
      for (let index = 0; index < 25; index++) nested = { next: nested };
      return envelope(nested);
    }
    if (mode === "oversized") {
      return new Response(new ReadableStream<Uint8Array>({ cancel() { oversizedCancelled = true; } }), {
        headers: { "content-length": String(2 * 1024 * 1024 + 1) },
      });
    }
    if (mode === "network") throw new Error("private-network-secret");
    return envelope({ ok: true });
  }, BASE_URL);
  mode = "forbidden";
  assert.deepEqual(await guarded.execute({ resource: "services", operation: "list", input: {} }, context), { ok: false, status: 403, code: "FORBIDDEN" });
  mode = "rate-limit";
  assert.deepEqual(await guarded.execute({ resource: "services", operation: "list", input: {} }, context), { ok: false, status: 429, code: "RATE_LIMITED" });
  mode = "malformed";
  assert.deepEqual(await guarded.execute({ resource: "services", operation: "list", input: {} }, context), { ok: false, code: "INVALID_RESPONSE", status: 200 });
  mode = "deep";
  assert.deepEqual(await guarded.execute({ resource: "services", operation: "list", input: {} }, context), { ok: false, code: "INVALID_RESPONSE" });
  mode = "oversized";
  assert.deepEqual(await guarded.execute({ resource: "services", operation: "list", input: {} }, context), { ok: false, code: "INVALID_RESPONSE", status: 200 });
  assert(oversizedCancelled, "oversized upstream response is cancelled before allocation");
  mode = "network";
  assert.deepEqual(await guarded.execute({ resource: "services", operation: "list", input: {} }, context), { ok: false, code: "REQUEST_FAILED" });
  const httpError = JSON.stringify(await guarded.execute({ resource: "services", operation: "list", input: {} }, context));
  assert(!httpError.includes("private-network-secret") && !httpError.includes("never-expose-upstream-details"));

  let forbiddenCalls = 0;
  const insecure = new ClinicOperationsApi(async () => { forbiddenCalls++; return envelope({}); }, "http://clinic.example");
  assert.deepEqual(await insecure.execute({ resource: "services", operation: "list", input: {} }, context), { ok: false, code: "INVALID_ORIGIN" });
  const credentialed = new ClinicOperationsApi(async () => { forbiddenCalls++; return envelope({}); }, "https://user:pass@clinic.example");
  assert.deepEqual(await credentialed.execute({ resource: "services", operation: "list", input: {} }, context), { ok: false, code: "INVALID_ORIGIN" });
  assert.equal(forbiddenCalls, 0, "unsafe API origins are rejected before fetch");
}

async function testTelegramWorkflows() {
  const calls: Call[] = [];
  const writes: Call[] = [];
  let denyWrites = false;
  let service = { ...serviceRow };
  let myBookings = [{ ...ownBooking }];
  const api = new ClinicOperationsApi(async (input, init = {}) => {
    const url = new URL(String(input));
    const call = { url, init };
    calls.push(call);
    if (["POST", "PATCH", "DELETE"].includes(init.method ?? "GET")) writes.push(call);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("cookie"), context.sessionCookie);
    assert.equal(headers.get("x-csrf-token"), context.csrfToken);
    if (denyWrites && ["POST", "PATCH", "DELETE"].includes(init.method ?? "GET")) {
      return json({ error: { code: "FORBIDDEN", message: "private permission details" } }, 403);
    }
    if (init.method === "GET" && url.pathname === "/api/v1/service-groups") return envelope({ items: [groupRow], page: 1, total: 1 });
    if (init.method === "GET" && url.pathname === "/api/v1/bookings/slots") return envelope({ items: [slotRow] });
    if (init.method === "GET" && url.pathname === "/api/v1/me/bookings") return envelope({ items: myBookings, page: 1, total: myBookings.length });
    if (init.method === "GET" && url.pathname === "/api/v1/services") return envelope({ items: [service], page: Number(url.searchParams.get("page") ?? 1), total: 1 });
    if (init.method === "GET" && url.pathname === `/api/v1/services/${ID}`) return envelope(service);
    if (init.method === "GET" && url.pathname === "/api/v1/auth/me") return envelope({ user: { id: ID, fullName: "Alex Example", email: "alex@example.test", phone: "+3725551234" } });
    if (init.method === "POST" && url.pathname === "/api/v1/bookings") return envelope({ id: BOOKING_ID }, 201);
    if (init.method === "POST" && url.pathname === `/api/v1/me/bookings/${BOOKING_ID}/cancel`) return envelope({ cancelled: 1 });
    if (init.method === "POST" && url.pathname === "/api/v1/auth/password") return envelope({ ok: true });
    return envelope({ ok: true });
  }, BASE_URL);
  let clock = 1_000_000;
  let plannerCalls = 0;
  let invalidations = 0;
  const neverPlan: ClinicPlanner = async () => { plannerCalls++; throw new Error("guided/private paths must not reach planner"); };
  const flow = new TelegramClinicOperations(api, neverPlan, () => clock, async () => { invalidations++; return true; });

  assert.equal((await flow.handle("anon", "show clinic services", null, true, "en"))?.status, "clinic-auth-required");
  assert.equal((await flow.handle("group", "show clinic services", context, false, "en"))?.status, "clinic-private-only");
  assert.equal(calls.length, 0, "auth and private-chat gates do not call upstream");

  assert.equal((await flow.handle("admin-cancel", "Cancel appointment", context, true, "en"))?.status, "booking-cancel-route-clarify", "an ambiguous admin cancellation is not sent through the customer route");
  assert.equal(writes.length, 0);

  const start = await flow.handle("booking", "I want to book an appointment", context, true, "en");
  assert.equal(start?.status, "booking-choose-group");
  const groupButtons = (inlineSuggestionsForReply(start.status, start.reply, "en")?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>).flat();
  assert.equal(groupButtons[0]?.text, "Skin care", "the booking group choice label omits its internal ID");
  const invalidGroup = await flow.handle("booking", "99", context, true, "en");
  assert.equal(invalidGroup?.status, "booking-group-invalid", "an invalid group ordinal keeps the booking flow open and re-shows choices");
  const groupRetryButtons = (inlineSuggestionsForReply(invalidGroup.status, invalidGroup.reply, "en")?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>).flat();
  const groupChoice = resolveInlineSuggestion(groupRetryButtons[0]?.callback_data, "en");
  assert.equal((await flow.handle("booking", groupChoice!, context, true, "en"))?.status, "booking-date");
  const slotPrompt = await flow.handle("booking", "2026-12-01", context, true, "en");
  assert.equal(slotPrompt?.status, "booking-choose-slot");
  assert.equal(calls.at(-1)?.url.searchParams.get("from"), "2026-12-01");
  const slotButtons = (inlineSuggestionsForReply(slotPrompt.status, slotPrompt.reply, "en")?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>).flat();
  assert(slotButtons[0]?.text.startsWith("2026-12-01"), "the time choice is labeled with its displayed date and time");
  const invalidSlot = await flow.handle("booking", "99", context, true, "en");
  assert.equal(invalidSlot?.status, "booking-slot-invalid", "an invalid slot ordinal re-shows the current availability options");
  const slotRetryButtons = (inlineSuggestionsForReply(invalidSlot.status, invalidSlot.reply, "en")?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>).flat();
  const slotChoice = resolveInlineSuggestion(slotRetryButtons[0]?.callback_data, "en");
  assert.equal((await flow.handle("booking", slotChoice!, context, true, "en"))?.status, "booking-name");
  const name = await flow.handle("booking", "Services Example", context, true, "en");
  assert.equal(name?.status, "booking-phone");
  assert(name?.deleteSensitiveMessage, "name is kept out of the planner and marked for deletion");
  const phone = await flow.handle("booking", "+3725551234", context, true, "en");
  assert.equal(phone?.status, "booking-email");
  assert(phone?.deleteSensitiveMessage);
  const beforeBookingWrite = writes.length;
  const bookingPreview = await flow.handle("booking", "skip", context, true, "en");
  assert.equal(bookingPreview?.status, "booking-create");
  assert(bookingPreview?.deleteSensitiveMessage);
  assert(bookingPreview?.reply.includes("••••••34"), "booking preview masks the phone");
  assert(!bookingPreview?.reply.includes("+3725551234"));
  assert.equal(writes.length, beforeBookingWrite, "booking is only proposed before confirmation");
  assert.equal((await flow.handle("booking", "not yet", context, true, "en"))?.status, "clinic-awaiting-confirmation");
  assert.equal(writes.length, beforeBookingWrite);
  assert.equal((await flow.handle("booking", "confirm", context, true, "en"))?.status, "clinic-created");
  assert.equal(writes.length, beforeBookingWrite + 1);
  const bookingCall = writes.at(-1)!;
  assert.equal(bookingCall.url.pathname, "/api/v1/bookings");
  assert.deepEqual(JSON.parse(String(bookingCall.init.body)), {
    fullName: "Services Example", phone: "+3725551234", groupId: GROUP_ID, slotId: SLOT_ID, locale: "en",
  });
  assert.equal(plannerCalls, 0, "guided booking/contact fields never reach the planner");

  assert.equal((await flow.handle("own-cancel", "Show my bookings", context, true, "en"))?.status, "my-bookings-listed");
  const beforeCustomerCancel = writes.length;
  const customerCancel = await flow.handle("own-cancel", "Cancel the first booking", context, true, "en");
  assert.equal(customerCancel?.status, "my-booking-cancel", "a booking follow-up remains owner-scoped");
  assert.equal(writes.length, beforeCustomerCancel, "customer cancellation requires confirmation");
  assert.equal((await flow.handle("own-cancel", "confirm", context, true, "en"))?.status, "my-booking-cancelled");
  assert.equal(writes.length, beforeCustomerCancel + 1);
  assert.equal(writes.at(-1)?.url.pathname, `/api/v1/me/bookings/${BOOKING_ID}/cancel`, "customer cancellation uses the owner-scoped route");
  assert.equal(writes.at(-1)?.init.method, "POST");

  myBookings = [{ ...ownBooking, canCancel: false }];
  assert.equal((await flow.handle("locked-cancel", "Show my bookings", context, true, "en"))?.status, "my-bookings-listed");
  const beforeLockedCancel = writes.length;
  assert.equal((await flow.handle("locked-cancel", "Cancel the first booking", context, true, "en"))?.status, "my-booking-locked");
  assert.equal(writes.length, beforeLockedCancel, "upstream canCancel state is respected");
  myBookings = [{ ...ownBooking }];

  await flow.handle("stale-session", "Show my bookings", context, true, "en");
  await flow.handle("stale-session", "Cancel the first booking", context, true, "en");
  const beforeChangedSession = writes.length;
  assert.equal((await flow.handle("stale-session", "confirm", { ...context, sessionCookie: "different-session" }, true, "en"))?.status, "clinic-session-changed");
  assert.equal(writes.length, beforeChangedSession, "confirmation is bound to the session that proposed it");

  assert.equal((await flow.handle("password-session", "change password", context, true, "en"))?.status, "clinic-password-prompt");
  const changedPasswordInput = await flow.handle("password-session", "ServicesSecure1!", { ...context, sessionCookie: "different-session" }, true, "en");
  assert.equal(changedPasswordInput?.status, "clinic-session-changed");
  assert(changedPasswordInput?.deleteSensitiveMessage, "sensitive input is still deleted when the session changes mid-flow");

  assert.equal((await flow.handle("password", "change password", context, true, "en"))?.status, "clinic-password-prompt");
  assert.equal((await flow.handle("password", "weak", context, true, "en"))?.status, "password-invalid");
  const firstPassword = await flow.handle("password", "ServicesSecure1!", context, true, "en");
  assert.equal(firstPassword?.status, "password-confirm");
  assert(firstPassword?.deleteSensitiveMessage);
  const passwordProposal = await flow.handle("password", "ServicesSecure1!", context, true, "en");
  assert.equal(passwordProposal?.status, "password-proposed");
  assert(passwordProposal?.deleteSensitiveMessage);
  assert(!passwordProposal?.reply.includes("ServicesSecure1!"));
  const beforePasswordConfirm = writes.length;
  assert.equal((await flow.handle("password", "confirm", context, true, "en"))?.status, "password-changed");
  assert.equal(writes.length, beforePasswordConfirm + 1);
  assert.equal(writes.at(-1)?.url.pathname, "/api/v1/auth/password");
  assert.deepEqual(JSON.parse(String(writes.at(-1)?.init.body)), { password: "ServicesSecure1!", confirmPassword: "ServicesSecure1!" });
  assert.equal(invalidations, 1, "password changes revoke upstream sessions and clear the bot's stored session");
  assert(!flow.hasConversation("password"));
  assert.equal(plannerCalls, 0);

  assert.equal((await flow.handle("notifications", "Show recent notifications", context, true, "en"))?.status, "notifications-listed");
  const beforeRead = writes.length;
  assert.equal((await flow.handle("notifications", "Mark all notifications read", context, true, "en"))?.status, "notifications-read");
  assert.equal(writes.length, beforeRead, "mark-read awaits confirmation");
  assert.equal((await flow.handle("notifications", "confirm", context, true, "en"))?.status, "notifications-read");
  assert.equal(writes.at(-1)?.url.pathname, "/api/v1/notifications/read");
  assert.equal(writes.at(-1)?.init.method, "PATCH");

  let pendingClock = 10_000;
  const pendingTtlFlow = new TelegramClinicOperations(api, neverPlan, () => pendingClock);
  const beforeExpiredWrite = writes.length;
  assert.equal((await pendingTtlFlow.handle("pending-ttl", "Mark all notifications read", context, true, "en"))?.status, "notifications-read");
  pendingClock += 4 * 60_000;
  assert.equal((await pendingTtlFlow.handle("pending-ttl", "not yet", context, true, "en"))?.status, "clinic-awaiting-confirmation");
  pendingClock += 60_001;
  assert.equal((await pendingTtlFlow.handle("pending-ttl", "confirm", context, true, "en"))?.status, "clinic-expired");
  assert.equal(writes.length, beforeExpiredWrite, "chatter does not extend a pending confirmation's fixed five-minute expiry");

  assert.equal((await flow.handle("profile", "show my profile", context, true, "en"))?.status, "profile-read");
  assert.equal(calls.at(-1)?.url.pathname, "/api/v1/auth/me");
  assert.equal(plannerCalls, 0);

  denyWrites = true;
  const denied = new TelegramClinicOperations(api, async () => ({ operation: "mark-read", input: {} }), () => clock);
  assert.equal((await denied.handle("denied", "Mark all notifications read", context, true, "en"))?.status, "notifications-read");
  const deniedResult = await denied.handle("denied", "confirm", context, true, "en");
  assert.equal(deniedResult?.status, "clinic-error", "upstream 403 is preserved instead of bypassing permissions");
  assert(deniedResult?.reply.includes("FORBIDDEN"));
  denyWrites = false;

  clock += 5 * 60_000 + 1;
  assert.equal((await flow.handle("expired", "change password", context, true, "en"))?.status, "clinic-password-prompt");
  clock += 5 * 60_000 + 1;
  const expiredSensitive = await flow.handle("expired", "ServicesSecure1!", context, true, "en");
  assert.equal(expiredSensitive?.status, "clinic-expired-sensitive");
  assert(expiredSensitive?.deleteSensitiveMessage, "expired passwords are still kept out of chat history/model input");
  assert.equal(plannerCalls, 0);
}

async function testAmbiguousClinicAndBookingFollowups() {
  const calls: Call[] = [];
  const writes: Call[] = [];
  const services = [
    { ...serviceRow },
    { ...serviceRow, id: SECOND_ID, slug: "facial-massage", title: "Facial massage", translations: { en: { title: "Facial massage" }, fa: { title: "ماساژ صورت" } } },
  ];
  let bookings: Array<Record<string, unknown>> = [
    { ...ownBooking },
    { ...ownBooking, id: SECOND_ID, fullName: "Sam Example", groupTitle: "Hair care", status: "waiting", email: "sam@example.test" },
  ];
  const api = new ClinicOperationsApi(async (input, init = {}) => {
    const url = new URL(String(input));
    const call = { url, init };
    calls.push(call);
    if (["POST", "PATCH", "DELETE"].includes(init.method ?? "GET")) writes.push(call);

    if (init.method === "GET" && url.pathname === "/api/v1/services") return envelope({ items: services, page: 1, total: services.length });
    if (init.method === "GET" && url.pathname.startsWith("/api/v1/services/")) {
      return envelope(services.find((row) => row.id === url.pathname.split("/").at(-1)) ?? {});
    }
    if (init.method === "DELETE" && url.pathname.startsWith("/api/v1/services/")) return envelope({ deleted: 1 });

    if (init.method === "GET" && url.pathname === "/api/v1/bookings") return envelope({ items: bookings, page: 1, total: bookings.length });
    if (init.method === "GET" && url.pathname.startsWith("/api/v1/bookings/")) {
      return envelope(bookings.find((row) => row.id === url.pathname.split("/").at(-1)) ?? {});
    }
    if (init.method === "PATCH" && url.pathname.startsWith("/api/v1/bookings/")) {
      const id = url.pathname.split("/").at(-1);
      const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
      const index = bookings.findIndex((row) => row.id === id);
      if (index >= 0) bookings[index] = { ...bookings[index], ...patch };
      return envelope(bookings[index] ?? { ok: true });
    }
    return envelope({ ok: true });
  }, BASE_URL);

  const plannerRequests: string[] = [];
  const planner: ClinicPlanner = async (resource, request, rows) => {
    plannerRequests.push(request);
    if (resource === "services" && /show services/iu.test(request)) return { operation: "list", input: { page: 1, perPage: 10 } };
    if (resource === "services" && /delete facial service/iu.test(request) && !request.includes("کاربر ردیف")) {
      return { operation: "delete", target: "facial", input: {} };
    }
    if (resource === "services" && request.includes("کاربر ردیف 2 را انتخاب کرد")) {
      assert(request.includes("Facial massage"), "the numbered follow-up keeps the chosen row's visible label");
      assert(rows.some((row) => row.id === SECOND_ID), "only safe, current list rows accompany the clarification");
      return { operation: "delete", id: SECOND_ID, input: {} };
    }
    throw new Error(`Unexpected planner request: ${resource}: ${request}`);
  };
  const flow = new TelegramClinicOperations(api, planner);

  const genericClinicFlow = new TelegramClinicOperations(api, planner);
  const genericClarify = await genericClinicFlow.handle("clinic-topic", "مدیریت کلینیک", context, true, "en");
  assert.equal(genericClarify?.status, "clinic-clarify");
  const genericButtons = (inlineSuggestionsForReply("clinic-clarify", genericClarify!.reply, "en")?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>).flat();
  const slotsText = resolveInlineSuggestion(genericButtons.find((button) => button.text === "Available slots")?.callback_data, "en");
  assert.equal(slotsText, "Show available slots");
  assert.equal((await genericClinicFlow.handle("clinic-topic", slotsText!, context, true, "en"))?.status, "clinic-date-required", "a generic clinic-clarification suggestion enters its date-specific workflow");

  assert.equal((await flow.handle("ambiguous-service", "Show services", context, true, "en"))?.status, "services-listed");
  const ambiguous = await flow.handle("ambiguous-service", "Delete facial service", context, true, "en");
  assert.equal(ambiguous?.status, "clinic-target-ambiguous");
  const serviceChoices = inlineSuggestionsForReply("clinic-target-ambiguous", ambiguous!.reply, "en")?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>;
  assert.equal(serviceChoices.flat().length, 2, "an ambiguous clinic target exposes the displayed rows as numbered buttons");
  assert.equal(serviceChoices.flat()[1]?.text, "Facial massage", "a clinic target button labels the row without its internal ID");
  const selectedService = resolveInlineSuggestion(serviceChoices.flat()[1]?.callback_data, "en");
  assert.equal(selectedService, "2");
  const beforeServiceDelete = writes.length;
  const servicePreview = await flow.handle("ambiguous-service", selectedService!, context, true, "en");
  assert.equal(servicePreview?.status, "clinic-proposed", servicePreview?.reply ?? "the button choice returns through the normal mutation preview");
  assert.equal(writes.length, beforeServiceDelete, "choosing a row does not execute its deletion");
  assert(plannerRequests.at(-1)?.includes("Delete facial service") && plannerRequests.at(-1)?.includes("Facial massage"), "the clarification preserves the original request and selected row context");
  assert.equal((await flow.handle("ambiguous-service", "confirm", context, true, "en"))?.status, "clinic-deleted");
  assert.equal(writes.at(-1)?.url.pathname, `/api/v1/services/${SECOND_ID}`);
  assert.equal(writes.at(-1)?.init.method, "DELETE");

  const cancelRouteFlow = new TelegramClinicOperations(api, planner);
  const cancelClarification = await cancelRouteFlow.handle("booking-route", "Cancel booking", context, true, "en");
  assert.equal(cancelClarification?.status, "booking-cancel-route-clarify");
  const cancelRouteButtons = (inlineSuggestionsForReply("booking-cancel-route-clarify", cancelClarification!.reply, "en")?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>).flat();
  const myBookingsText = resolveInlineSuggestion(cancelRouteButtons.find((button) => button.text === "My bookings")?.callback_data, "en");
  assert.equal(myBookingsText, "Show my bookings");
  assert.equal((await cancelRouteFlow.handle("booking-route", myBookingsText!, context, true, "en"))?.status, "my-bookings-listed", "the cancellation clarification callback enters the customer-owned booking workflow");

  assert.equal((await flow.handle("booking-status", "List clinic bookings", context, true, "en"))?.status, "bookings-listed");
  const bookingAmbiguous = await flow.handle("booking-status", "Update booking", context, true, "en");
  assert.equal(bookingAmbiguous?.status, "booking-select", "an unspecified booking target asks the user to choose from the current list");
  const bookingChoices = inlineSuggestionsForReply("booking-select", bookingAmbiguous!.reply, "en")?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>;
  assert.equal(bookingChoices.flat().length, 2);
  assert.equal(bookingChoices.flat()[1]?.text, "Hair care", "booking selection labels omit the booking's internal ID");
  const selectedBooking = resolveInlineSuggestion(bookingChoices.flat()[1]?.callback_data, "en");
  assert.equal(selectedBooking, "2");
  assert.equal((await flow.handle("booking-status", selectedBooking!, context, true, "en"))?.status, "booking-update-clarify", "the ordinal enters the pending booking-update workflow");
  const paidChoice = resolveInlineSuggestion("nf1:bookingPaid", "en");
  assert.equal(paidChoice, "Booking status: paid");
  const beforeStatusConfirm = writes.length;
  const statusPreview = await flow.handle("booking-status", paidChoice!, context, true, "en");
  assert.equal(statusPreview?.status, "booking-update", "a suggested status follows the existing preview workflow");
  assert.equal(writes.length, beforeStatusConfirm, "a status button never skips explicit confirmation");
  assert(calls.some((call) => call.init.method === "GET" && call.url.pathname === `/api/v1/bookings/${SECOND_ID}`), "the selected booking is reloaded before proposing its update");
  assert.equal((await flow.handle("booking-status", "confirm", context, true, "en"))?.status, "clinic-updated");
  assert.equal(writes.at(-1)?.url.pathname, `/api/v1/bookings/${SECOND_ID}`);
  assert.deepEqual(JSON.parse(String(writes.at(-1)?.init.body)), { status: "paid" });

  assert.equal((await flow.handle("booking-field", "List clinic bookings", context, true, "en"))?.status, "bookings-listed");
  assert.equal((await flow.handle("booking-field", "Update the first booking", context, true, "en"))?.status, "booking-update-clarify");
  const emailChoice = resolveInlineSuggestion("nf1:bookingFieldEmail", "en");
  assert.equal(emailChoice, "Booking field: email");
  assert.equal((await flow.handle("booking-field", emailChoice!, context, true, "en"))?.status, "booking-edit-value");
  assert(flow.expectsSensitiveInput("booking-field"), "the new field value is collected by the local sensitive-input workflow");
  const beforeEmailConfirm = writes.length;
  const emailPreview = await flow.handle("booking-field", "new@example.test", context, true, "en");
  assert.equal(emailPreview?.status, "booking-update");
  assert(emailPreview?.deleteSensitiveMessage, "the new email is marked for deletion");
  assert(!emailPreview?.reply.includes("new@example.test"), "the email is masked in the confirmation preview");
  assert.equal(writes.length, beforeEmailConfirm, "the sensitive field edit remains confirmation-gated");
  assert.equal((await flow.handle("booking-field", "confirm", context, true, "en"))?.status, "clinic-updated");
  assert.equal(writes.at(-1)?.url.pathname, `/api/v1/bookings/${BOOKING_ID}`);
  assert.deepEqual(JSON.parse(String(writes.at(-1)?.init.body)), { email: "new@example.test" });
}

async function testPlannerPrivacyAndFreshReads() {
  const calls: Call[] = [];
  const writes: Call[] = [];
  let service = { ...serviceRow };
  const api = new ClinicOperationsApi(async (input, init = {}) => {
    const url = new URL(String(input));
    const call = { url, init };
    calls.push(call);
    if (["POST", "PATCH", "DELETE"].includes(init.method ?? "GET")) writes.push(call);
    if (init.method === "GET" && url.pathname === "/api/v1/services") return envelope({ items: [service], page: Number(url.searchParams.get("page") ?? 1), total: 1 });
    if (init.method === "GET" && url.pathname === `/api/v1/services/${ID}`) return envelope(service);
    return envelope({ ok: true });
  }, BASE_URL);
  const observations: Array<{ resource: ClinicResource; request: string; rows: Array<Record<string, unknown>>; query: Record<string, unknown> }> = [];
  let plan: ClinicPlan = { operation: "list", input: { page: 1, perPage: 10, search: "alex@example.test" } };
  const planner: ClinicPlanner = async (resource, request, rows, query) => {
    observations.push({ resource, request, rows, query });
    return plan;
  };
  const flow = new TelegramClinicOperations(api, planner);
  const request = "show services for alex@example.test +3725551234 on 2026-12-01";
  assert.equal((await flow.handle("search", request, context, true, "en"))?.status, "services-listed");
  assert(!observations[0]!.request.includes("alex@example.test"));
  assert(!observations[0]!.request.includes("+3725551234"));
  assert(observations[0]!.request.includes("2026-12-01"), "date literals are preserved while phone-shaped values are scrubbed");
  assert.equal(calls.at(-1)?.url.searchParams.get("search"), "alex@example.test", "exact filters are still applied locally");

  plan = { operation: "list", input: { page: 2, perPage: 10 } };
  assert.equal((await flow.handle("search", "next page", context, true, "en"))?.status, "services-listed");
  assert.equal(observations[1]!.query.searchPresent, true);
  assert(!JSON.stringify(observations[1]!.query).includes("alex@example.test"));
  assert(!JSON.stringify(observations[1]!.query).includes("+3725551234"));
  assert.equal(calls.at(-1)?.url.searchParams.get("search"), "alex@example.test", "pagination keeps the private search filter out of the planner but in the API request");
  assert.equal(calls.at(-1)?.url.searchParams.get("page"), "2");
  assert.equal(scrubClinicPlannerText("2026-12-01, +3725551234, alex@example.test"), "2026-12-01, [phone redacted], [email redacted]");

  plan = { operation: "list", input: { page: 1, perPage: 10 } };
  assert.equal((await flow.handle("mutation", "Show services", context, true, "en"))?.status, "services-listed");
  plan = { operation: "delete", id: ID, input: {} };
  const beforeDelete = writes.length;
  const proposal = await flow.handle("mutation", "Delete the first service", context, true, "en");
  assert.equal(proposal?.status, "clinic-proposed");
  assert.equal(writes.length, beforeDelete, "a destructive edit is previewed first");
  service = { ...service, updatedAt: "2026-11-02T00:00:00.000Z" };
  assert.equal((await flow.handle("mutation", "confirm", context, true, "en"))?.status, "clinic-conflict");
  assert.equal(writes.length, beforeDelete, "stale snapshots are rejected before mutation");
  assert(calls.some((call) => call.init.method === "GET" && call.url.pathname === `/api/v1/services/${ID}`), "fresh read is performed before applying a mutation");
}

export async function testClinicOperations() {
  await testAllowListAndHttpContract();
  await testTelegramWorkflows();
  await testAmbiguousClinicAndBookingFollowups();
  await testPlannerPrivacyAndFreshReads();
}

if (process.argv[1]?.endsWith("clinic-operations-test.ts")) {
  testClinicOperations().then(() => console.log("Clinic operations route contract, HTTP mock, privacy, and Telegram workflow tests passed."))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
