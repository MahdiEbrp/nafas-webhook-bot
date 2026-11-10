import assert from "node:assert/strict";
import { ClinicUsersApi, validateUserCommand, type UserCommand } from "../lib/users/clinic-api";
import { RulesAssistant } from "../lib/rules/assistant";
import { TelegramUsers } from "../lib/telegram/users";

export async function testUsersContract() {
  const id = "11111111-1111-4111-8111-111111111111";
  const context = { actorId: "actor", sessionCookie: "session=test", csrfToken: "" };
  const profile = { fullName: "Test User", email: "test@example.com", phone: "+12025550123", password: "Example123!", roleKey: "customer" };
  const calls: { url: string; init: RequestInit }[] = [];
  let status = 200;
  let data: unknown = { id };
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify(status === 200 ? { data } : { error: { code: "FORBIDDEN", message: "sensitive upstream message" } }), { status });
  };
  const api = new ClinicUsersApi(fetcher, "https://clinic.example");
  const commands: [UserCommand, string, string][] = [
    [{ operation: "list", input: { page: 2, search: "a b", role: "customer", status: "banned" } }, "GET", "/api/v1/users"],
    [{ operation: "create", input: profile }, "POST", "/api/v1/users"],
    [{ operation: "status", id, input: { isActive: false, isBanned: true, banReason: "test" } }, "PATCH", `/api/v1/users/${id}`],
    [{ operation: "delete", id, input: {} }, "DELETE", `/api/v1/users/${id}`],
    [{ operation: "role", id, input: { roleKey: "customer" } }, "PATCH", `/api/v1/users/${id}/role`],
    [{ operation: "password", id, input: { password: "Example123!", confirmPassword: "Example123!" } }, "POST", `/api/v1/users/${id}/password`],
  ];
  for (const [command, method, path] of commands) {
    assert.equal((await api.execute(command, context)).ok, true);
    const call = calls.at(-1)!;
    assert.equal(new URL(call.url).pathname, path);
    assert.equal(call.init.method, method);
    assert.equal((call.init.headers as Record<string, string>).Origin, "https://clinic.example");
    assert.equal((call.init.headers as Record<string, string>).Cookie, "session=test");
    assert.equal(call.init.redirect, "error");
  }
  const invalidOperation = { operation: "not-a-user-operation", input: {} } as unknown as UserCommand;
  assert.throws(() => validateUserCommand(invalidOperation));
  assert.deepEqual(await api.execute(invalidOperation, context), { ok: false, code: "INVALID_INPUT" });
  assert.deepEqual(await api.execute({ operation: "list", input: { perPage: 51 } }, context), { ok: false, code: "INVALID_INPUT" });
  const beforeInvalidOrigins = calls.length;
  for (const origin of ["http://clinic.example", "https://user@clinic.example", "https://:secret@clinic.example"]) {
    assert.deepEqual(await new ClinicUsersApi(fetcher, origin).execute({ operation: "list", input: {} }, context), { ok: false, code: "INVALID_API_ORIGIN" });
  }
  assert.equal(calls.length, beforeInvalidOrigins, "invalid origins never reach fetch");
  for (const malformed of [
    { status: 200, body: "null" },
    { status: 200, body: '"not an object"' },
    { status: 200, body: "{}" },
    { status: 500, body: JSON.stringify({ error: { code: 123 } }) },
    { status: 500, body: JSON.stringify({ error: { code: "invalid code" } }) },
  ]) {
    const malformedApi = new ClinicUsersApi(async () => new Response(malformed.body, { status: malformed.status }), "https://clinic.example");
    assert.deepEqual(await malformedApi.execute({ operation: "list", input: {} }, context), { ok: false, status: malformed.status, code: "UPSTREAM_REJECTED" });
  }
  for (const action of ["activate", "deactivate", "ban", "unban", "change-role", "delete", "reset-password"]) {
    const command: UserCommand = { operation: "bulk", input: { action, scope: "page", ids: [id], ...(action === "change-role" ? { roleKey: "customer" } : {}) } };
    assert.equal((await api.execute(command, context)).ok, true);
    assert.equal(new URL(calls.at(-1)!.url).pathname, "/api/v1/users/bulk");
  }
  assert.throws(() => validateUserCommand({ operation: "status", id, input: { fullName: "unsupported" } }));
  assert.throws(() => validateUserCommand({ operation: "password", id, input: { password: "Example123!", confirmPassword: "mismatch" } }));
  assert.throws(() => validateUserCommand({ operation: "bulk", input: { action: "delete", scope: "page", ids: [] } }));
  assert.throws(() => validateUserCommand({ operation: "bulk", input: { action: "change-role", scope: "filtered" } }));
  assert.throws(() => validateUserCommand({ operation: "delete", id: "../bad", input: {} }));
  assert.throws(() => validateUserCommand({ operation: "list", input: { perPage: 51 } }));
  assert.equal((await api.execute(commands[1]![0], { ...context, sessionCookie: "" })).ok, false);

  let now = 100;
  const flow = new TelegramUsers(api, () => now);
  calls.length = 0;
  assert.equal((await flow.handle("a", "کاربر جدید بساز", null, true))?.status, "users-auth-required");
  assert.equal((await flow.handle("a", "کاربر جدید بساز", context, false))?.status, "users-private-only");
  await flow.handle("a", "کاربر جدید بساز", context, true);
  for (const field of [profile.fullName, profile.email, profile.phone, profile.password, profile.roleKey]) {
    const response = await flow.handle("a", field, context, true);
    assert(response);
    assert(!response.reply.includes(profile.password));
  }
  assert.equal(calls.length, 0, "no creation before confirmation");
  assert.equal(await flow.handle("other", "تأیید", context, true), null, "isolated owner");
  assert.equal((await flow.handle("a", "تأیید", context, true))?.status, "users-completed");
  assert.equal(calls.length, 1);
  await flow.handle("a", "تأیید", context, true);
  assert.equal(calls.length, 1, "no replay");
  await flow.handle("a", `/users delete ${id}`, context, true);
  await flow.handle("a", "لغو", context, true);
  await flow.handle("a", "تأیید", context, true);
  assert.equal(calls.length, 1, "cancel prevents delete");
  await flow.handle("a", `/users delete ${id}`, context, true);
  assert.equal((await flow.handle("a", "تأیید", { ...context, sessionCookie: "new" }, true))?.status, "users-session-changed");
  await flow.handle("a", `/users delete ${id}`, context, true);
  now += 300_001;
  await flow.handle("a", "تأیید", context, true);
  assert.equal(calls.length, 1, "expired command cannot run");
  data = { items: [{ id, fullName: "Test User", email: "test@example.com", isActive: true, isBanned: false }], page: 1, total: 1 };
  assert.equal((await flow.handle("a", "لیست کاربران", context, true))?.status, "users-listed");
  status = 403;
  const result = await flow.handle("a", "/users list", context, true);
  assert.equal(result?.status, "users-error");
  assert(!result?.reply.includes("sensitive"));
  // Conversational deletion resolves only server-provided choices and still
  // requires a separate, single-use confirmation.
  status = 200;
  const secondId = "22222222-2222-4222-8222-222222222222";
  data = { items: [{ id, fullName: "First" }, { id: secondId, fullName: "Second" }], page: 1, total: 2 };
  let plannerCalls = 0;
  const conversational = new TelegramUsers(api, () => now, async (request, choices) => {
    plannerCalls++;
    assert.equal(request, "دومی رو حذف کن");
    assert.equal(choices[1]?.id, secondId);
    return { operation: "delete", id: secondId };
  });
  await conversational.handle("owner", "لیست کاربران", context, true);
  const countBeforeDelete = calls.length;
  const proposal = await conversational.handle("owner", "دومی رو حذف کن", context, true);
  assert(!proposal?.reply.includes("/users"));
  assert(proposal?.reply.includes(secondId));
  assert.equal(calls.length, countBeforeDelete, "AI cannot directly execute deletion");
  await conversational.handle("owner", "تأیید", context, true);
  assert.equal(calls.at(-1)?.init.method, "DELETE");
  assert(calls.at(-1)?.url.endsWith(secondId));
  assert.equal(plannerCalls, 1);
  const secretFlow = new TelegramUsers(api, () => now, async () => { throw new Error("Password must never reach planner"); });
  await secretFlow.handle("secret", "کاربر جدید بساز", context, true);
  await secretFlow.handle("secret", profile.fullName, context, true);
  await secretFlow.handle("secret", profile.email, context, true);
  const prompt = await secretFlow.handle("secret", profile.phone, context, true);
  assert(prompt?.reply.includes("حذف"));
  const invalid = await secretFlow.handle("secret", "weak", context, true);
  assert.equal(invalid?.deleteSensitiveMessage, true, "even invalid password messages are deleted");
  const secretReceived = await secretFlow.handle("secret", profile.password, context, true);
  assert.equal(secretReceived?.deleteSensitiveMessage, true);
  assert(!secretReceived?.reply.includes(profile.password));
  await secretFlow.handle("secret", "تأیید", context, true);
  assert.equal(JSON.parse(String(calls.at(-1)?.init.body)).password, profile.password, "password retained until confirmed creation");
  assert.equal(JSON.parse(String(calls.at(-1)?.init.body)).roleKey, "customer");
  const assistant = new RulesAssistant({ completeImpl: async (options) => {
    assert(!options.tools?.some(tool => ["create_user", "delete_user", "bulk_users", "update_user_status"].includes(tool.function.name)));
    return { content: "", model: "test", toolCalls: [{ id: "call", type: "function", function: { name: "create_user", arguments: JSON.stringify(profile) } }], finishReason: "tool_calls", attempts: [], selection: "fixed" };
  } });
  const guarded = await assistant.handle({ conversationId: "private", message: "create", context });
  assert.equal(guarded.kind, "error", "unsolicited mutation tool call rejected");
  assert(guarded.reply.includes("کاربر دوم"));
  const unavailable = new ClinicUsersApi(async () => { throw new Error("secret"); }, "https://clinic.example");
  assert.deepEqual(await unavailable.execute({ operation: "list", input: {} }, context), { ok: false, code: "REQUEST_FAILED" });

  const { resetConfigCache } = await import("@/lib/config");
  const savedFetch = globalThis.fetch;
  const savedSelection = process.env.MODEL_SELECTION;
  const savedModels = process.env.OPENROUTER_MODELS;
  const savedKey = process.env.OPENROUTER_API_KEY;
  process.env.MODEL_SELECTION = "fixed";
  process.env.OPENROUTER_MODELS = "test/free-a:free";
  process.env.OPENROUTER_API_KEY = "test-key";
  resetConfigCache();
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    assert(url.includes("openrouter.ai/api/v1/chat/completions"), "planner uses the mocked model endpoint");
    const request = JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content: string }> };
    assert(request.messages?.some(message => message.role === "user" && message.content.includes("لیست کاربران")));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ operation: "list", page: 1 }) }, finish_reason: "stop" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const { planUserRequest } = await import("../lib/users/planner");
    assert.deepEqual(await planUserRequest("لیست کاربران", []), { operation: "list", page: 1 });
  } finally {
    globalThis.fetch = savedFetch;
    if (savedSelection === undefined) delete process.env.MODEL_SELECTION;
    else process.env.MODEL_SELECTION = savedSelection;
    if (savedModels === undefined) delete process.env.OPENROUTER_MODELS;
    else process.env.OPENROUTER_MODELS = savedModels;
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
    resetConfigCache();
  }
}

if (process.argv[1]?.endsWith("users-contract-test.ts")) {
  testUsersContract().then(() => console.log("Users API contract and Telegram flow tests passed.")).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
