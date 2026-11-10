import assert from "node:assert/strict";
import { RuleManager, seedRules } from "../lib/rules/manager";
import { RulesAssistant } from "../lib/rules/assistant";
import type { CompletionResult } from "../lib/openrouter/client";

export async function testRulesContract() {
  const rules = seedRules();
  const context = { actorId: "owner", sessionCookie: "session=test", csrfToken: "" };
  const calls: { url: URL; init: RequestInit }[] = [];
  let bulkFailure = false;
  const api = new RuleManager({ baseUrl: "https://clinic.example", fetchImpl: async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, init: init! });
    assert.equal((init!.headers as Record<string, string>).Origin, "https://clinic.example");
    assert.equal((init!.headers as Record<string, string>).Cookie, context.sessionCookie);
    assert.equal(init!.redirect, "error");
    if (parsed.pathname.endsWith("/bulk")) return new Response(JSON.stringify({ data: { requested: 2, succeeded: bulkFailure ? 1 : 2, failures: bulkFailure ? [{ id: rules[1]!.id, code: "FORBIDDEN" }] : [] } }));
    if (init!.method === "GET" && parsed.pathname === "/api/v1/rules") return new Response(JSON.stringify({ data: { items: rules, page: 1, perPage: 10, total: 2 } }));
    if (init!.method === "GET") return new Response(JSON.stringify({ data: rules.find(rule => parsed.pathname.endsWith(rule.id)) }));
    if (init!.method === "POST") return new Response(JSON.stringify({ data: { ...rules[0], id: "33333333-3333-4333-8333-333333333333" } }), { status: 201 });
    return new Response(JSON.stringify({ data: { ok: true } }));
  } });
  assert.equal((await api.list({}, context)).total, 2, "actual nested data/items envelope parsed");
  assert.equal((await api.list({ perPage: 51 }, context)).status, undefined);
  assert((await api.list({ perPage: 51 }, context)).error);
  const update = await api.proposeUpdate(rules[0]!.id, { isActive: false }, context);
  assert(update.ok);
  assert(!calls.some(call => call.init.method === "PATCH"));
  assert((await api.confirm(update.change.token, context)).ok);
  assert.equal(calls.at(-1)!.init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), { isActive: false });
  bulkFailure = true;
  const proposal = await api.proposeBulk({ action: "delete", scope: "filtered", filters: { status: "inactive" } }, context);
  assert(proposal.ok);
  const bulk = await api.confirm(proposal.change.token, context);
  assert(bulk.ok);
  assert.equal(bulk.appliedCount, 1);
  assert.equal(bulk.failed[0]?.id, rules[1]!.id);
  assert.equal(bulk.failed[0]?.reason, "FORBIDDEN");

  let tool = "list_rules", args: unknown = {};
  let modelCalls = 0;
  const assistant = new RulesAssistant({ manager: api, telegramMode: true, completeImpl: async options => {
    modelCalls++;
    assert(!JSON.stringify(options.messages).includes(context.sessionCookie));
    if (tool === "delete_rule") assert(JSON.stringify(options.messages).includes(rules[1]!.id), "trusted choices supplied to model");
    return { content: "", model: "test", attempts: [], selection: "fixed", finishReason: "tool_calls", toolCalls: [{ id: "call", type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] } satisfies CompletionResult;
  } });
  const turn = (message: string, ctx = context) => assistant.handle({ conversationId: "private", message, context: ctx });
  const list = await turn("قوانین رو نشان بده");
  assert.equal(list.kind, "read");
  assert(list.reply.includes("📚"));
  assert(list.reply.includes("قانون نوبت‌دهی"));
  assert(assistant.hasFollowup("private", context.actorId, "دومی رو حذف کن"));
  tool = "delete_rule"; args = { id: rules[1]!.id };
  const deletesBefore = calls.filter(call => call.init.method === "DELETE").length;
  assert.equal((await turn("دومی رو حذف کن")).kind, "proposed");
  assert.equal(calls.filter(call => call.init.method === "DELETE").length, deletesBefore);
  assert(assistant.hasPending("private", context.actorId));
  const modelBefore = modelCalls;
  assert.equal((await turn("تأیید")).kind, "confirmed");
  assert.equal(modelCalls, modelBefore);
  assert.equal(calls.at(-1)!.init.method, "DELETE");
  assert(calls.at(-1)!.url.pathname.endsWith(rules[1]!.id));
  args = { id: "99999999-9999-4999-8999-999999999999" };
  assert.equal((await turn("قانون مبهم رو حذف کن")).kind, "conversation", "guessed id rejected");
  args = { id: rules[1]!.id };
  await turn("دومی رو حذف کن");
  assert.equal((await turn("تأیید", { ...context, sessionCookie: "other" })).kind, "error");

  const draft = new RulesAssistant({ manager: api, telegramMode: true, completeImpl: async () => { throw new Error("guided creation must not invent fields"); } });
  const draftTurn = (message: string) => draft.handle({ conversationId: "draft", message, context });
  const postsBefore = calls.filter(call => call.init.method === "POST").length;
  assert.equal((await draftTurn("قانون جدید بساز")).kind, "conversation");
  assert(draft.hasPending("draft", context.actorId));
  await draftTurn("سیاست تازه");
  await draftTurn("New policy");
  assert((await draftTurn("invalid slug!")).reply.includes("معتبر نیست"));
  await draftTurn("new-policy");
  assert.equal((await draftTurn("بدون توضیح")).kind, "proposed");
  assert.equal(calls.filter(call => call.init.method === "POST").length, postsBefore);
  assert.equal((await draftTurn("بله")).kind, "confirmed");
  const creation = JSON.parse(String(calls.at(-1)!.init.body));
  assert.equal(creation.translations.fa.name, "سیاست تازه");
  assert.equal(creation.translations.en.name, "New policy");
  assert.equal(creation.slug, "new-policy");
  assert.equal(creation.translations.fa.description, null);
  assert.equal(creation.isActive, true);
  assert.equal((await draftTurn("قانون جدید بساز")).kind, "conversation");
  assert.equal((await draftTurn("لغو")).kind, "cancelled");
  assert(!draft.hasPending("draft", context.actorId));
}
if (process.argv[1]?.endsWith("rules-contract-test.ts")) {
  testRulesContract().then(() => console.log("Rules API contract and conversational flow tests passed.")).catch(error => { console.error(error); process.exitCode = 1; });
}
