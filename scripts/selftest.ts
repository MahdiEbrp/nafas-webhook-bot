export {};

/**
 * npm run selftest
 *
 * No API key, no network, no database needed. We fake OpenRouter and the
 * Telegram Bot API, then walk the real pipeline end to end:
 *
 *   POST /api/chat          → handleChat → model → reply + memory
 *   POST /api/telegram/...  → handleTelegramUpdate → sendMessage
 *   GET  /api/health        → config warnings + free-model check
 *
 * This is the fastest way to know the bot still behaves after a change.
 */

import type { TelegramMessage, TelegramUpdate } from "@/lib/telegram/api";

/* ── 0. Fake the outside world before anything imports config ────────── */

process.env.OPENROUTER_API_KEY = "test-key";
process.env.OPENROUTER_MODELS = "test/free-a:free,test/free-b:free";
// The conversation tests below pin the chain on purpose; the selection tests
// further down switch MODEL_SELECTION to "auto" and switch it back.
process.env.MODEL_SELECTION = "fixed";
process.env.MODEL_RETRIES = "1";
process.env.MODEL_TIMEOUT_MS = "2000";
process.env.HISTORY_MESSAGES = "4";
process.env.ALLOWED_ORIGINS = "https://app.example.com";
process.env.BOT_API_KEY = "bot-key-123";
process.env.BOT_NAME = "ربات تست";
process.env.CLINIC_NAME = "کلینیک تست";
process.env.TIME_ZONE = "Asia/Tehran";
process.env.DATE_ASSISTANT = "true";
process.env.TELEGRAM_BOT_TOKEN = "123456:TEST-TOKEN";
process.env.TELEGRAM_WEBHOOK_SECRET = "secret-abc";
process.env.PUBLIC_APP_URL = "https://bot.example.com";
// 777 is the private chat; the negative ids are the groups the user-id tests
// post from. Both kinds have to be allowed or the gate is never reached.
process.env.TELEGRAM_ALLOWED_CHAT_IDS = "777,-100200300,-100999,-100555";

type Call = { url: string; method: string; body?: unknown; headers: Record<string, string> };

const calls: Call[] = [];
let webhookAllowedUpdates: string[] | undefined = ["message"];

/** Canned model behaviour. */
let modelReply = "سلام! خوشحالم که اینجایی. 🙂";
let modelToolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> | null = null;
let modelStatus = 200;
/** Force the first model in the chain to fail so the fallback is exercised. */
let failFirstModel = false;
/** Make every model in the chain fail. */
let failAllModels = false;
/** Reported finish_reason ("length" = the answer was cut by max_tokens). */
let modelFinishReason: string | null = "stop";

/**
 * The fake catalog. Deliberately mixed so ranking has something to decide:
 * a known-strong model, plain mid-table ones, a big-context one, and a runt
 * that must be filtered out for having too little context.
 */
const FREE_CATALOG: Array<{ id: string; context_length: number }> = [
  { id: "test/free-a:free", context_length: 32_000 },
  { id: "test/free-b:free", context_length: 32_000 },
  { id: "test/free-c:free", context_length: 128_000 },
  { id: "deepseek/deepseek-chat:free", context_length: 64_000 },
  { id: "liquid/lfm-3-1.7b:free", context_length: 8_192 },
  { id: "tiny/runt:free", context_length: 2_048 },
];

/** Set to a non-200 to make the catalog fetch fail. */
let catalogStatus = 200;

function lastUserMessage(body: unknown): string {
  const messages = (body as { messages?: Array<{ role: string; content: string }> })?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user") return message.content;
  }
  return "";
}


globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });

  let body: unknown;
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  }
  calls.push({ url, method, body, headers });

  /* OpenRouter — chat completions */
  if (url.includes("openrouter.ai/api/v1/chat/completions")) {
    const model = String((body as { model?: string })?.model ?? "");
    const isFirst = model === "test/free-a:free";

    if (failAllModels || (failFirstModel && isFirst)) {
      return new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: modelToolCalls
              ? { content: null, tool_calls: modelToolCalls }
              : { content: `${modelReply} [${lastUserMessage(body)}]` },
            finish_reason: modelFinishReason,
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: modelStatus, headers: { "Content-Type": "application/json" } },
    );
  }

  /* OpenRouter — model catalog (used by /api/health) */
  if (url.includes("openrouter.ai/api/v1/models")) {
    if (catalogStatus !== 200) {
      return new Response("catalog unavailable", { status: catalogStatus });
    }
    return new Response(
      JSON.stringify({
        data: FREE_CATALOG.map((model) => ({
          id: model.id,
          name: model.id,
          context_length: model.context_length,
          supported_parameters: ["tools", "response_format"],
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  /* Telegram Bot API */
  if (url.includes("/bot123456:TEST-TOKEN/")) {
    const apiMethod = url.split("/bot123456:TEST-TOKEN/")[1] ?? "";
    if (apiMethod === "getMe") {
      return new Response(
        JSON.stringify({ ok: true, result: { id: 424242, is_bot: true, first_name: "ربات تست", username: "chat_test_bot" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (apiMethod === "getWebhookInfo") {
      return new Response(
        JSON.stringify({
          ok: true,
          result: { url: "https://bot.example.com/api/telegram/webhook", has_custom_certificate: false, pending_update_count: 0, ...(webhookAllowedUpdates ? { allowed_updates: webhookAllowedUpdates } : {}) },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (apiMethod === "setWebhook") {
      webhookAllowedUpdates = ((body as { allowed_updates?: string[] })?.allowed_updates ?? []).slice();
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (apiMethod === "sendMessage") {
      return new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: calls.length, date: 1, chat: { id: (body as { chat_id?: number })?.chat_id ?? 0, type: "private" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  throw new Error(`selftest: unexpected fetch to ${url}`);
}) as typeof fetch;

/* ── 2. Tiny test harness ───────────────────────────────────────────── */

let passed = 0;
const failures: string[] = [];

function assert(condition: unknown, label: string): void {
  if (condition) passed += 1;
  else failures.push(label);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual === expected) passed += 1;
  else failures.push(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(`${name} threw: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`  ✗ ${name}`);
  }
}

function sentTexts(): string[] {
  return calls
    .filter((call) => call.url.endsWith("/sendMessage"))
    .map((call) => String((call.body as { text?: string })?.text ?? ""));
}

function lastSent(): string {
  return sentTexts().at(-1) ?? "";
}

/** Full sendMessage payloads, so tests can look at the reply keyboard too. */
function sentPayloads(): Array<Record<string, unknown>> {
  return calls
    .filter((call) => call.url.endsWith("/sendMessage"))
    .map((call) => (call.body ?? {}) as Record<string, unknown>);
}

function lastMarkup(): Record<string, unknown> | undefined {
  return sentPayloads().at(-1)?.reply_markup as Record<string, unknown> | undefined;
}

function telegramUpdate(overrides: Partial<TelegramMessage> = {}): TelegramUpdate {
  const message: TelegramMessage = {
    message_id: 10,
    date: 1,
    from: { id: 777, is_bot: false, first_name: "کاربر" },
    chat: { id: 777, type: "private" },
    ...overrides,
  };
  return { update_id: 1, message };
}

function jsonRequest(payload: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

/* ── 3. Tests ───────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  /* ── 1. Import the real code (after the fetch fake is installed) ────── */
  const { handleChat, resetConversation, conversationLength } = await import("@/lib/bot");
  const { systemPrompt, welcomeText, helpText } = await import("@/lib/bot/prompt");
  const { resetSessionsForTesting, getMessages } = await import("@/lib/bot/session");
  const { handleTelegramUpdate } = await import("@/lib/telegram/handler");
  const { ensureWebhook } = await import("@/lib/telegram/setup");
  const { inlineSuggestionsForReply, resolveInlineSuggestion } = await import("@/lib/telegram/inline-suggestions");
  const { getConfig, resetConfigCache, configWarnings } = await import("@/lib/config");
  const { truncateAtSentence } = await import("@/lib/text");
  const chatRoute = await import("@/app/api/chat/route");
  const webhookRoute = await import("@/app/api/telegram/webhook/route");
  const healthRoute = await import("@/app/api/health/route");
  const { rankModels, scoreModel, speedDelta, UNKNOWN_QUALITY } = await import("@/lib/openrouter/ranking");
  const { recordSuccess, recordFailure, getStat, resetStatsForTesting } = await import("@/lib/openrouter/stats");
  const { selectChain } = await import("@/lib/openrouter/select");
  const { complete } = await import("@/lib/openrouter/client");
  const { resetModelCache } = await import("@/lib/openrouter/models");
  const { answerDateQuestion } = await import("@/lib/dates/intent");
  const { extractDates } = await import("@/lib/dates/parse");
  const { nowFacts, betweenFacts, leapYearFacts, addFacts } = await import("@/lib/dates/engine");
  const { nowInZone } = await import("@/lib/dates/timezone");
  const { isIdentityQuestion, identityText } = await import("@/lib/bot/identity");
  const { normalizeDatabaseUrl, setRunnerForTesting, dbConfigured } = await import("@/lib/db/client");
  const { ensureSchema, resetSchemaCache, SCHEMA_STATEMENTS, TABLE_NAME } = await import("@/lib/db/schema");
  const {
    ensureChatSession,
    resolveSessionId,
    fallbackSessionId,
    newSessionId,
    phoneFor,
    setChatPhone,
    cachedPhoneCount,
    resetChatSessionCacheForTesting,
  } = await import("@/lib/db/chat-sessions");
  const {
    normalizeIranPhone,
    isStoredPhone,
    displayPhone,
    toAsciiDigits,
  } = await import("@/lib/phone");

  console.log("\n🤖 chat bot self-test (offline)\n");
  resetConfigCache();

  await test("config reads the environment and keeps the model chain :free", () => {
    const config = getConfig();
    assertEqual(config.botName, "ربات تست", "bot name");
    assertEqual(config.modelChain.join(","), "test/free-a:free,test/free-b:free", "model chain");
    assertEqual(config.history.maxMessages, 4, "history window");
    assert(configWarnings(config).some((w) => w.includes("OPENROUTER_API_KEY")) === false, "no API-key warning");
  });

  await test("Telegram setup enables callback queries and repairs a message-only webhook", async () => {
    calls.length = 0;
    webhookAllowedUpdates = ["message"];
    const first = await ensureWebhook();
    assertEqual(first.action, "registered", "old message-only webhook is repaired");
    const setupCall = calls.find((call) => call.url.endsWith("/setWebhook"));
    const allowedUpdates = (setupCall?.body as { allowed_updates?: string[] } | undefined)?.allowed_updates ?? [];
    assert(allowedUpdates.includes("message") && allowedUpdates.includes("callback_query"), "webhook receives messages and inline callbacks");
    const second = await ensureWebhook();
    assertEqual(second.action, "unchanged", "callback-enabled webhook is idempotent");
    webhookAllowedUpdates = undefined;
    calls.length = 0;
    const unknownUpdates = await ensureWebhook();
    assertEqual(unknownUpdates.action, "registered", "a webhook with no reported update list is repaired conservatively");
    const repairedUnknown = calls.find((call) => call.url.endsWith("/setWebhook"));
    assert((repairedUnknown?.body as { allowed_updates?: string[] } | undefined)?.allowed_updates?.includes("callback_query"), "repair explicitly subscribes to callbacks when Telegram omits the update list");
  });

  await test("inline suggestion keyboards are contextual, safe, and only use allowlisted callbacks", () => {
    const emailMarkup = inlineSuggestionsForReply("email-clarify", "🔎 Which email resource do you mean?", "en");
    const emailRows = emailMarkup?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>;
    assert(Array.isArray(emailRows) && emailRows.flat().some((button) => button.text === "Email providers"), "email clarification shows contextual inline choices");
    const socialClarifyMarkup = inlineSuggestionsForReply("social-pending", "🔎 Please be more specific about the social link. Cancel is available.", "en");
    assert((socialClarifyMarkup?.inline_keyboard as Array<Array<{ text: string }>>).flat().some((button) => button.text === "Social links"), "clarification suggestions are not reduced to cancel just because help text mentions cancellation");
    const userChoiceMarkup = inlineSuggestionsForReply("users-pending", "Choose a user or cancel:\n1. Alex Example — ID: 11111111-1111-4111-8111-111111111111\n2. Sam Example — ID: 22222222-2222-4222-8222-222222222222", "en");
    const userChoiceButtons = (userChoiceMarkup?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>).flat();
    assertEqual(userChoiceButtons.length, 2, "displayed numbered choices take precedence over a cancel hint");
    assertEqual(userChoiceButtons[1]?.text, "Sam Example", "user-choice buttons omit the internal ID");
    assertEqual(userChoiceButtons[1]?.callback_data, "nf1:pick:2", "user-choice buttons preserve the displayed ordinal");
    const sensitiveMarkup = inlineSuggestionsForReply("payment-invalid", "Invalid secret", "en", true);
    const sensitiveRows = sensitiveMarkup?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>;
    assertEqual(sensitiveRows.flat().length, 1, "sensitive prompts only offer cancellation");
    assertEqual(resolveInlineSuggestion("nf1:clinicServices", "fa"), "خدمات کلینیک را نشان بده", "callback resolves to fixed text");
    assertEqual(resolveInlineSuggestion("nf1:pick:2", "en"), "2", "numbered choice callback resolves only to its bounded ordinal");
    assertEqual(resolveInlineSuggestion("nf1:pick:999", "en"), null, "out-of-range choice callback is rejected");
    assertEqual(resolveInlineSuggestion("arbitrary:delete-all", "fa"), null, "arbitrary callback data is rejected");
    const bookingMarkup = inlineSuggestionsForReply("booking-choose-group", "Choose a service group:\n1. Facial · 11111111-1111-4111-8111-111111111111\n2. Hair · 22222222-2222-4222-8222-222222222222", "en");
    const bookingRows = bookingMarkup?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>;
    assertEqual(bookingRows.flat().length, 2, "visible booking options get individual buttons");
    assertEqual(bookingRows.flat()[0]?.text, "Facial", "button label omits the internal ID");
    assertEqual(bookingRows.flat()[1]?.callback_data, "nf1:pick:2", "each visible row maps to its displayed ordinal");
    const confirmationMarkup = inlineSuggestionsForReply("users-pending", "Reply confirm to apply\nor cancel to stop.", "en");
    assertEqual((confirmationMarkup?.inline_keyboard as Array<Array<unknown>>).flat().length, 2, "pending confirmations have explicit confirm and cancel buttons");
    const safeProposalMarkup = inlineSuggestionsForReply("settings-proposed", "Confirm to apply\nCancel to stop.", "en", true);
    assertEqual((safeProposalMarkup?.inline_keyboard as Array<Array<unknown>>).flat().length, 2, "safe previews keep explicit confirmation buttons after sensitive input is deleted");
    const bookingUpdateMarkup = inlineSuggestionsForReply("booking-update-clarify", "Choose a booking status or field.", "en");
    assertEqual((bookingUpdateMarkup?.inline_keyboard as Array<Array<unknown>>).flat().length, 10, "booking ambiguity presents status and field options");
    assertEqual(resolveInlineSuggestion("nf1:bookingPaid", "en"), "Booking status: paid", "booking status callbacks map to fixed workflow input");
    assertEqual(resolveInlineSuggestion("nf1:bookingFieldEmail", "en"), "Booking field: email", "booking field callbacks map to fixed workflow input");
    const bookingCancelMarkup = inlineSuggestionsForReply("booking-cancel-route-clarify", "Choose the booking workflow.", "en");
    const bookingCancelButtons = (bookingCancelMarkup?.inline_keyboard as Array<Array<{ text: string }>>).flat();
    assert(bookingCancelButtons.some((button) => button.text === "My bookings") && bookingCancelButtons.some((button) => button.text === "Clinic bookings"), "ambiguous cancellation distinguishes customer and admin booking routes");
    const clinicClarifyMarkup = inlineSuggestionsForReply("clinic-clarify", "Tell me whether you mean services, bookings, slots, care guides, or notifications.", "en");
    const clinicClarifyButtons = (clinicClarifyMarkup?.inline_keyboard as Array<Array<{ text: string }>>).flat();
    assert(clinicClarifyButtons.some((button) => button.text === "Available slots") && clinicClarifyButtons.some((button) => button.text === "Care guides") && clinicClarifyButtons.some((button) => button.text === "Notifications"), "generic clinic clarification offers the stated clinic domains");
    assertEqual(resolveInlineSuggestion("nf1:availableSlots", "en"), "Show available slots", "clinic-domain callbacks use fixed request text");
    assertEqual((inlineSuggestionsForReply("booking-phone", "Send a phone number", "en")?.inline_keyboard as Array<Array<{ text: string }>>).flat()[0]?.text, "Cancel", "sensitive booking prompts only offer cancellation");
    assert(inlineSuggestionsForReply("answered", "I don't understand; please clarify.", "en")?.inline_keyboard, "generic uncertainty also gets suggestions");
  });

  await test("OpenRouter accepts a function-tool response without text content", async () => {
    modelToolCalls = [{ id: "call-rules-1", type: "function", function: { name: "list_rules", arguments: JSON.stringify({ status: "active" }) } }];
    try {
      const result = await complete({
        messages: [{ role: "user", content: "قوانین فعال را نشان بده" }],
        tools: [{ type: "function", function: { name: "list_rules", description: "List rules", parameters: { type: "object" } } }],
        modelChain: ["test/free-a:free"],
      });
      assertEqual(result.content, "", "tool-only result has empty content");
      assertEqual(result.toolCalls?.[0]?.function.name, "list_rules", "tool call is exposed to the caller");
      const request = calls.filter((call) => call.url.includes("chat/completions")).at(-1);
      assertEqual((request?.body as { tools?: unknown[] } | undefined)?.tools?.length, 1, "tool schema is sent to OpenRouter");
    } finally {
      modelToolCalls = null;
    }
  });

  await test("system prompt is a conversation prompt, not an instruction sheet", () => {
    const prompt = systemPrompt("fa");
    assert(prompt.includes("ربات تست"), "uses the configured bot name");
    assert(prompt.includes("گفت‌وگو"), "talks about conversation");
    assert(!prompt.includes("actionId"), "no planner/JSON contract leaked in");
    assert(!prompt.includes("webhooks"), "no clinic webhooks leaked in");
  });

  await test("a Persian message gets a Persian answer", async () => {
    resetSessionsForTesting();
    const result = await handleChat({ message: "سلام، حالت چطوره؟", sessionId: "s-1", locale: "fa" });

    assertEqual(result.status, "answered", "status");
    assertEqual(result.model, "test/free-a:free", "first model in the chain answered");
    assert(result.reply.includes("سلام! خوشحالم"), "model reply passed through");
    assert(result.reply.includes("سلام، حالت چطوره؟"), "the user's message reached the model");
    assertEqual(conversationLength("s-1"), 2, "one user + one assistant message stored");
  });

  await test("the stored window is sent back as context on the next turn", async () => {
    resetSessionsForTesting();
    await handleChat({ message: "اسم من علی است", sessionId: "s-2", locale: "fa" });
    const second = await handleChat({ message: "اسمم چی بود؟", sessionId: "s-2", locale: "fa" });

    assertEqual(second.contextMessages, 2, "two previous messages sent as context");

    const lastCall = calls.filter((c) => c.url.includes("chat/completions")).at(-1);
    const messages = (lastCall?.body as { messages: Array<{ role: string }> }).messages;
    assertEqual(messages[0]?.role, "system", "system prompt first");
    assertEqual(messages[1]?.role, "user", "then the remembered user turn");
    assertEqual(messages[2]?.role, "assistant", "then the remembered answer");
    assertEqual(messages[3]?.role, "user", "then the new message");
  });

  await test("default context includes twenty previous exchanges, in order and isolated", async () => {
    const previous = process.env.HISTORY_MESSAGES;
    try {
      delete process.env.HISTORY_MESSAGES;
      resetConfigCache();
      resetSessionsForTesting();
      assertEqual(getConfig().history.maxMessages, 40, "default is twenty pairs");
      await handleChat({ message: "unrelated private session", sessionId: "other-history" });
      for (let i = 0; i < 21; i++) {
        await handleChat({ message: `context marker ${i}`, sessionId: "twenty-history" });
      }
      const result = await handleChat({ message: "continue please", sessionId: "twenty-history" });
      assertEqual(result.contextMessages, 40, "twenty previous exchanges sent");
      const last = calls.filter(c => c.url.includes("chat/completions")).at(-1);
      const messages = (last?.body as { messages: Array<{ role: string; content: string }> }).messages;
      assertEqual(messages.length, 42, "system plus forty history messages plus current request");
      assertEqual(messages[1]?.content, "context marker 1", "oldest exchange evicted");
      assertEqual(messages[39]?.content, "context marker 20", "most recent user message included");
      assertEqual(messages[41]?.content, "continue please", "current request comes last");
      assert(!messages.some(m => m.content.includes("unrelated private session")), "sessions isolated");
    } finally {
      if (previous === undefined) delete process.env.HISTORY_MESSAGES;
      else process.env.HISTORY_MESSAGES = previous;
      resetConfigCache();
      resetSessionsForTesting();
    }
  });

  await test("the memory window is capped and never starts with the assistant", async () => {
    resetSessionsForTesting();
    for (const text of ["یک", "دو", "سه", "چهار", "پنج"]) {
      await handleChat({ message: text, sessionId: "s-3", locale: "fa" });
    }

    const stored = getMessages("s-3", getConfig().history.ttlMs);
    assert(stored.length <= 4, `window capped at 4, got ${stored.length}`);
    assertEqual(stored[0]?.role, "user", "window starts with a user message");
    assertEqual(stored.at(-1)?.content.includes("[پنج]"), true, "newest answer still there");
  });

  await test("/clear forgets the conversation", async () => {
    resetSessionsForTesting();
    await handleChat({ message: "سلام", sessionId: "s-4", locale: "fa" });
    assertEqual(conversationLength("s-4"), 2, "two messages before clearing");

    resetConversation("s-4");
    assertEqual(conversationLength("s-4"), 0, "nothing left after clearing");

    const after = await handleChat({ message: "یادت هست؟", sessionId: "s-4", locale: "fa" });
    assertEqual(after.contextMessages, 0, "no context after a reset");
  });

  await test("an empty message never reaches the model", async () => {
    resetSessionsForTesting();
    const before = calls.length;
    const result = await handleChat({ message: "   ", sessionId: "s-5", locale: "fa" });

    assertEqual(result.status, "empty", "status");
    assertEqual(calls.length, before, "no outbound call was made");
    assertEqual(conversationLength("s-5"), 0, "nothing stored");
  });

  await test("a failing model falls through to the next one in the chain", async () => {
    resetSessionsForTesting();
    failFirstModel = true;
    try {
      const result = await handleChat({ message: "سلام", sessionId: "s-6", locale: "fa" });
      assertEqual(result.status, "answered", "status");
      assertEqual(result.model, "test/free-b:free", "second model answered");
    } finally {
      failFirstModel = false;
    }
  });

  await test("when every model fails the bot apologises instead of guessing", async () => {
    resetSessionsForTesting();
    failAllModels = true;
    try {
      const result = await handleChat({ message: "سلام", sessionId: "s-7", locale: "fa" });
      assertEqual(result.status, "error", "status");
      assert(result.reply.includes("مشکل"), "apology, not a fabricated answer");
      assertEqual(result.model, null, "no model credited");
      assertEqual(conversationLength("s-7"), 0, "a failed turn is not remembered");
    } finally {
      failAllModels = false;
    }
  });

  await test("a truncated answer is reported, not hidden", async () => {
    resetSessionsForTesting();
    modelFinishReason = "length";
    try {
      const result = await handleChat({ message: "یک داستان بلند بگو", sessionId: "s-8", locale: "fa" });
      assertEqual(result.truncated, true, "truncated flag");
    } finally {
      modelFinishReason = "stop";
    }
  });

  await test("POST /api/chat validates the body and the bot key", async () => {
    const badBody = await chatRoute.POST(
      jsonRequest({ nope: true }, { "x-bot-key": "bot-key-123" })
    );
    assertEqual(badBody.status, 400, "invalid body rejected");

    const noKey = await chatRoute.POST(
      jsonRequest({ message: "سلام" })
    );
    assertEqual(noKey.status, 401, "missing bot key rejected");

    const ok = await chatRoute.POST(
      jsonRequest({ message: "سلام", sessionId: "http-1" }, { "x-bot-key": "bot-key-123" })
    );
    assertEqual(ok.status, 200, "authenticated call accepted");
    const payload = (await ok.json()) as { ok: boolean; data: { reply: string; sessionId: string } };
    assertEqual(payload.ok, true, "ok envelope");
    assertEqual(payload.data.sessionId, "http-1", "session echoed back");
    assert(payload.data.reply.length > 0, "reply present");
  });

  await test("POST /api/chat blocks unknown browser origins", async () => {
    const response = await chatRoute.POST(
      jsonRequest({ message: "سلام" }, { origin: "https://evil.example.com", "x-bot-key": "bot-key-123" })
    );
    assertEqual(response.status, 403, "origin blocked");
  });

  await test("GET /api/health reports the model selection", async () => {
    const response = await healthRoute.GET(new Request("http://localhost/api/health"));
    assertEqual(response.status, 200, "status");
    const payload = (await response.json()) as {
      ok: boolean;
      data: {
        bot: { name: string };
        openrouter: {
          configured: boolean;
          selection: { source: string; chain: string[]; catalogSize: number } | null;
          fallbackChain: string[];
        };
        telegram: { configured: boolean; webhookUrl: string | null };
      };
    };
    assertEqual(payload.data.bot.name, "ربات تست", "bot name");
    assertEqual(payload.data.openrouter.configured, true, "openrouter configured");
    assert(payload.data.openrouter.selection !== null, "a selection is reported");
    assert(
      (payload.data.openrouter.selection?.chain.length ?? 0) > 0,
      "the reported chain is not empty",
    );
    assertEqual(payload.data.openrouter.fallbackChain.join(","), "test/free-a:free,test/free-b:free", "fallback chain");
    assertEqual(payload.data.telegram.webhookUrl, "https://bot.example.com/api/telegram/webhook", "webhook url");
  });

  await test("the greeting and help mention the clinic and the date skills", () => {
    const welcome = welcomeText("fa", "کاربر");
    const help = helpText("fa");
    assert(welcome.includes("کلینیک تست"), "welcome names the clinic");
    assert(welcome.includes("تاریخ"), "welcome mentions dates");
    assert(help.includes("کلینیک تست"), "help names the clinic");
    assert(help.includes("شمسی") || help.includes("میلادی"), "help mentions the calendars");
    assert(!welcome.includes('.,"') && !welcome.endsWith(","), "no stray punctuation in the greeting");
  });

  await test("Telegram handles natural-language login before the AI and does not record the message", async () => {
    const previousKey = process.env.AUTH_SESSION_ENCRYPTION_KEY;
    delete process.env.AUTH_SESSION_ENCRYPTION_KEY;
    setRunnerForTesting(null);
    resetSessionsForTesting();
    const beforeModels = calls.filter((call) => call.url.includes("openrouter.ai/api/v1/chat/completions")).length;
    const beforeHistory = conversationLength("tg-777");
    try {
      const result = await handleTelegramUpdate(telegramUpdate({ text: "میخوام لاگین کنم" }));
      assertEqual(result.status, "login-error", "login intent is routed to the secure OTP flow");
      assert(lastSent().includes("ذخیره‌سازی امن نشست پیکربندی نشده"), "missing DB/key fails closed with a clear response");
      assertEqual(calls.filter((call) => call.url.includes("openrouter.ai/api/v1/chat/completions")).length, beforeModels, "login phrase is not sent to the AI");
      assertEqual(conversationLength("tg-777"), beforeHistory, "login phrase is not saved in AI chat history");
    } finally {
      if (previousKey === undefined) delete process.env.AUTH_SESSION_ENCRYPTION_KEY;
      else process.env.AUTH_SESSION_ENCRYPTION_KEY = previousKey;
    }
  });

  await test("Telegram: /start sends the greeting", async () => {
    resetSessionsForTesting();
    calls.length = 0;
    const outcome = await handleTelegramUpdate(telegramUpdate({ text: "/start" }));

    assertEqual(outcome.handled, true, "handled");
    assertEqual(outcome.status, "start", "status");
    assert(lastSent().includes(welcomeText("fa", "کاربر")), "greeting sent");
  });

  await test("Telegram: a plain message is answered by the model", async () => {
    resetSessionsForTesting();
    calls.length = 0;
    modelReply = "چه خبر خوبی!";

    const outcome = await handleTelegramUpdate(telegramUpdate({ text: "امروز خیلی خوشحالم" }));

    assertEqual(outcome.handled, true, "handled");
    assertEqual(outcome.status, "answered", "status");
    assertEqual(outcome.model, "test/free-a:free", "model used");
    assert(lastSent().includes("چه خبر خوبی!"), "model answer sent to the chat");
    assert(
      calls.some((call) => call.url.endsWith("/sendChatAction")),
      "typing indicator sent",
    );
  });

  await test("Telegram: uncertain answers show inline suggestions", async () => {
    resetSessionsForTesting();
    calls.length = 0;
    const previousReply = modelReply;
    modelReply = "I don't understand. Please clarify.";
    try {
      const outcome = await handleTelegramUpdate(telegramUpdate({ text: "این جمله مبهم است" }));
      const markup = lastMarkup();
      const rows = markup?.inline_keyboard as Array<Array<{ text: string; callback_data: string }>> | undefined;
      assertEqual(outcome.status, "answered", "normal chat still answers");
      assert(Array.isArray(rows) && rows.flat().length >= 2, "an inline keyboard appears for an unclear answer");
      assert(rows?.flat().every((button) => button.callback_data.startsWith("nf1:")), "buttons contain only bounded suggestion ids");
    } finally {
      modelReply = previousReply;
    }
  });

  await test("Telegram: inline suggestions are acknowledged and handled as the clicking user's message", async () => {
    resetSessionsForTesting();
    calls.length = 0;
    const modelCallsBefore = calls.filter((call) => call.url.includes("openrouter.ai/api/v1/chat/completions")).length;
    const outcome = await handleTelegramUpdate({
      update_id: 82,
      callback_query: {
        id: "cb-suggestion-1",
        from: { id: 777, is_bot: false, first_name: "کاربر" },
        data: "nf1:clinicServices",
        message: { message_id: 700, date: 1, chat: { id: 777, type: "private" } },
      },
    });
    assertEqual(outcome.status, "clinic-auth-required", "selection enters the same authenticated clinic workflow");
    assert(calls.some((call) => call.url.endsWith("/answerCallbackQuery")), "Telegram's button spinner is acknowledged");
    assert(lastSent().includes("می‌خواهم لاگین کنم"), "the clinic auth requirement is returned");
    assertEqual(calls.filter((call) => call.url.includes("openrouter.ai/api/v1/chat/completions")).length, modelCallsBefore, "button selection is not sent to the general chat model");
  });

  await test("Telegram: /clear resets the conversation", async () => {
    resetSessionsForTesting();
    calls.length = 0;
    await handleTelegramUpdate(telegramUpdate({ text: "سلام" }));
    assertEqual(conversationLength("tg-777"), 2, "conversation stored");

    const outcome = await handleTelegramUpdate(telegramUpdate({ text: "/clear" }));
    assertEqual(outcome.status, "cleared", "status");
    assertEqual(conversationLength("tg-777"), 0, "conversation forgotten");
  });

  await test("Telegram: /id returns the chat id", async () => {
    calls.length = 0;
    const outcome = await handleTelegramUpdate(telegramUpdate({ text: "/id" }));
    assertEqual(outcome.status, "id", "status");
    assert(lastSent().includes("777"), "chat id sent");
  });

  await test("Telegram: a chat outside the allowlist is refused", async () => {
    calls.length = 0;
    const outcome = await handleTelegramUpdate(telegramUpdate({ chat: { id: 999, type: "private" } }));
    assertEqual(outcome.handled, false, "not handled");
    assertEqual(outcome.reason, "chat not allowed", "reason");
    assertEqual(sentTexts().length, 0, "nothing was sent");
  });

  await test("Telegram: a non-text message gets a polite note", async () => {
    calls.length = 0;
    const outcome = await handleTelegramUpdate(telegramUpdate({ text: undefined }));
    assertEqual(outcome.status, "unsupported", "status");
    assert(lastSent().includes("متنی"), "asks for text");
  });

  await test("Telegram: a leftover inline button is acknowledged, not executed", async () => {
    calls.length = 0;
    const outcome = await handleTelegramUpdate({
      update_id: 5,
      callback_query: {
        id: "cb-1",
        from: { id: 777, is_bot: false, first_name: "کاربر" },
        data: "a:users.delete",
        message: { message_id: 9, date: 1, chat: { id: 777, type: "private" } },
      },
    });
    assertEqual(outcome.status, "stale-button", "status");
    assert(lastSent().includes("دکمه"), "explains the buttons are gone");
    assertEqual(conversationLength("tg-777"), 0, "no conversation touched");
  });

  await test("POST /api/telegram/webhook rejects a wrong secret", async () => {
    const response = await webhookRoute.POST(
      new Request("http://localhost/api/telegram/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": "wrong" },
        body: JSON.stringify(telegramUpdate({ text: "سلام" })),
      }),
    );
    assertEqual(response.status, 401, "unauthorized");
  });

  await test("POST /api/telegram/webhook handles an update and always answers 200", async () => {
    resetSessionsForTesting();
    calls.length = 0;
    modelReply = "سلام دوست من";

    const response = await webhookRoute.POST(
      new Request("http://localhost/api/telegram/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": "secret-abc" },
        body: JSON.stringify({ ...telegramUpdate({ text: "درود" }), update_id: 1001 }),
      }),
    );

    assertEqual(response.status, 200, "status");
    const payload = (await response.json()) as { ok: boolean; data: { handled: boolean; status: string } };
    assertEqual(payload.data.handled, true, "handled");
    assertEqual(payload.data.status, "answered", "answered by the model");
    assert(lastSent().includes("سلام دوست من"), "answer sent through Telegram");

    // The same update replayed must not be answered twice.
    calls.length = 0;
    const replay = await webhookRoute.POST(
      new Request("http://localhost/api/telegram/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": "secret-abc" },
        body: JSON.stringify({ ...telegramUpdate({ text: "درود" }), update_id: 1001 }),
      }),
    );
    const replayPayload = (await replay.json()) as { data: { skipped: boolean; reason: string } };
    assertEqual(replayPayload.data.skipped, true, "duplicate skipped");
    assertEqual(sentTexts().length, 0, "nothing sent twice");
  });

  /* ── 4. Automatic model selection ─────────────────────────────────── */

  const catalogModel = (id: string, contextLength = 32_000) => ({
    id,
    name: id,
    contextLength,
    supportsTools: true,
    supportsJsonMode: true,
  });

  await test("speed is worth less than quality, so a slow smart model still wins", () => {
    assertEqual(speedDelta(null), 0, "an unmeasured model gets no speed term");
    assertEqual(Math.round(speedDelta(2500)), 0, "average speed = no change");
    assertEqual(Math.round(speedDelta(1)), 14, "very fast saturates at +14");
    assertEqual(Math.round(speedDelta(99_000)), -14, "very slow saturates at -14");

    const smart = scoreModel(catalogModel("deepseek/deepseek-chat:free", 64_000), {
      latencyMs: 3000,
      bestMs: 3000,
      samples: 5,
      failures: 0,
      consecutiveFailures: 0,
      lastStatus: null,
      lastError: null,
      lastUsedAt: 0,
      cooldownUntil: 0,
    });
    const quick = scoreModel(catalogModel("test/free-a:free"), {
      latencyMs: 5,
      bestMs: 5,
      samples: 5,
      failures: 0,
      consecutiveFailures: 0,
      lastStatus: null,
      lastError: null,
      lastUsedAt: 0,
      cooldownUntil: 0,
    });

    assertEqual(smart.quality, 88, "deepseek has the strong prior");
    assertEqual(quick.quality, UNKNOWN_QUALITY, "an unknown id gets the mid-table prior");
    assert(smart.score > quick.score, `smart ${smart.score} beats quick ${quick.score}`);
  });

  await test("a model that is failing sinks but is never dropped", () => {
    const now = 1_000_000;
    const stat = {
      latencyMs: 100,
      bestMs: 100,
      samples: 3,
      failures: 2,
      consecutiveFailures: 2,
      lastStatus: 429,
      lastError: "quota",
      lastUsedAt: now,
      cooldownUntil: now + 90_000,
    };
    const healthy = scoreModel(catalogModel("test/free-b:free"), undefined, { now });
    const cooling = scoreModel(catalogModel("test/free-a:free"), stat, { now });

    assertEqual(cooling.coolingDown, true, "flagged as cooling down");
    assert(cooling.score < healthy.score, `pushed behind a healthy peer (${cooling.score} < ${healthy.score})`);
    assert(cooling.reason.includes("cooling down"), "reason explains it");

    const ranked = rankModels(
      [catalogModel("test/free-a:free"), catalogModel("test/free-b:free")],
      (id) => (id === "test/free-a:free" ? stat : undefined),
      { now },
    );
    assertEqual(ranked[0]?.id, "test/free-b:free", "the healthy model goes first");
    assertEqual(ranked.length, 2, "the cooling model is still in the list");
  });

  await test("a pinned model gets a boost, and tiny-context models are filtered out", () => {
    const pinned = scoreModel(catalogModel("test/free-a:free"), undefined, { pinned: ["test/free-a:free"] });
    const plain = scoreModel(catalogModel("test/free-a:free"), undefined, {});
    assertEqual(pinned.score - plain.score, 6, "operator boost");

    const ranked = rankModels(
      [catalogModel("test/free-a:free", 32_000), catalogModel("tiny/runt:free", 2_048)],
      () => undefined,
      { minContext: 8_192 },
    );
    assertEqual(ranked.length, 1, "the runt is filtered out");
    assertEqual(ranked[0]?.id, "test/free-a:free", "the usable model survives");
  });

  await test("auto selection builds a chain from the live catalog, best first", async () => {
    resetStatsForTesting();
    resetModelCache();
    catalogStatus = 200;
    const saved = process.env.MODEL_SELECTION;
    process.env.MODEL_SELECTION = "auto";
    resetConfigCache();

    try {
      const selection = await selectChain({ quiet: true });
      assertEqual(selection.source, "auto", "source");
      assertEqual(selection.catalogSize, 6, "whole catalog seen");
      assertEqual(selection.considered, 5, "the runt was filtered out by min context");
      assertEqual(selection.chain.length, getConfig().modelPoolSize, "chain is capped at the pool size");
      assertEqual(selection.chain[0], "deepseek/deepseek-chat:free", "the strongest model goes first");
      assert(!selection.chain.includes("tiny/runt:free"), "the runt is not in the chain");
    } finally {
      if (saved === undefined) delete process.env.MODEL_SELECTION;
      else process.env.MODEL_SELECTION = saved;
      resetConfigCache();
    }
  });

  await test("measured speed reorders models of equal quality", async () => {
    resetStatsForTesting();
    resetModelCache();
    const saved = process.env.MODEL_SELECTION;
    process.env.MODEL_SELECTION = "auto";
    resetConfigCache();

    try {
      // free-a and free-b have the same prior; only speed can separate them.
      recordSuccess("test/free-a:free", 900);
      recordSuccess("test/free-b:free", 40);

      const selection = await selectChain({ quiet: true });
      const a = selection.top.find((model) => model.id === "test/free-a:free");
      const b = selection.top.find((model) => model.id === "test/free-b:free");
      assert(b !== undefined && a !== undefined, "both models are ranked");
      assert((b?.score ?? 0) > (a?.score ?? 0), `the faster one scores higher: ${b?.score} > ${a?.score}`);
    } finally {
      if (saved === undefined) delete process.env.MODEL_SELECTION;
      else process.env.MODEL_SELECTION = saved;
      resetStatsForTesting();
      resetConfigCache();
    }
  });

  await test("one pool slot is kept for a model we have not timed yet", async () => {
    resetStatsForTesting();
    resetModelCache();
    const saved = process.env.MODEL_SELECTION;
    process.env.MODEL_SELECTION = "auto";
    resetConfigCache();

    try {
      // Measure everything that would normally fill the pool.
      for (const id of ["deepseek/deepseek-chat:free", "test/free-c:free", "test/free-a:free", "test/free-b:free"]) {
        recordSuccess(id, 500);
      }

      const selection = await selectChain({ quiet: true });
      const last = selection.chain[selection.chain.length - 1] ?? "";
      const lastModel = selection.top.find((model) => model.id === last);
      assertEqual(lastModel?.samples, 0, "the last slot went to an unmeasured model");
    } finally {
      if (saved === undefined) delete process.env.MODEL_SELECTION;
      else process.env.MODEL_SELECTION = saved;
      resetStatsForTesting();
      resetConfigCache();
    }
  });

  await test("MODEL_SELECTION=fixed ignores the catalog and uses OPENROUTER_MODELS", async () => {
    resetModelCache();
    catalogStatus = 200;
    const saved = process.env.MODEL_SELECTION;
    process.env.MODEL_SELECTION = "fixed";
    resetConfigCache();

    try {
      const selection = await selectChain({ quiet: true });
      assertEqual(selection.source, "fixed", "source");
      assertEqual(selection.chain.join(","), "test/free-a:free,test/free-b:free", "exactly the configured chain");
      assertEqual(selection.catalogSize, 0, "the catalog was not even fetched");
    } finally {
      if (saved === undefined) delete process.env.MODEL_SELECTION;
      else process.env.MODEL_SELECTION = saved;
      resetConfigCache();
    }
  });

  await test("when the catalog is unreachable the bot falls back, it does not stop", async () => {
    resetModelCache();
    catalogStatus = 503;
    const saved = process.env.MODEL_SELECTION;
    process.env.MODEL_SELECTION = "auto";
    resetConfigCache();

    try {
      const selection = await selectChain({ quiet: true });
      assertEqual(selection.source, "fallback", "source");
      assertEqual(selection.chain.join(","), "test/free-a:free,test/free-b:free", "configured chain used");
      assert((selection.note ?? "").includes("catalog unavailable"), "the note says why");
    } finally {
      catalogStatus = 200;
      if (saved === undefined) delete process.env.MODEL_SELECTION;
      else process.env.MODEL_SELECTION = saved;
      resetModelCache();
      resetConfigCache();
    }
  });

  await test("every call teaches the stats: successes are timed, failures cool down", async () => {
    resetSessionsForTesting();
    resetStatsForTesting();
    resetModelCache();
    failFirstModel = true;

    try {
      const result = await handleChat({ message: "سلام", sessionId: "s-stats", locale: "fa" });
      assertEqual(result.model, "test/free-b:free", "the fallback model answered");

      const winner = getStat("test/free-b:free");
      assertEqual(winner?.samples, 1, "the winner was timed once");
      assert(typeof winner?.latencyMs === "number", "a latency was recorded");
      assertEqual(winner?.cooldownUntil, 0, "a success clears any cooldown");

      const loser = getStat("test/free-a:free");
      assertEqual(loser?.consecutiveFailures, 1, "the failure was counted");
      assertEqual(loser?.lastStatus, 429, "the status was kept");
      assert((loser?.cooldownUntil ?? 0) > Date.now(), "the loser is cooling down right now");
    } finally {
      failFirstModel = false;
      resetStatsForTesting();
      resetModelCache();
    }
  });

  /* ── 5. Identity ────────────────────────────────────────────────────── */

  await test("who-are-you is recognised, in every common phrasing", () => {
    for (const text of ["تو کی هستی؟", "چی هستی", "اسمت چیه", "خودتو معرفی کن", "who are you"]) {
      assert(isIdentityQuestion(text), `"${text}" recognised`);
    }
    for (const text of ["سلام خوبی", "امروز چندمه", "حالم بده"]) {
      assert(!isIdentityQuestion(text), `"${text}" is not an identity question`);
    }
  });

  await test("the identity answer names the clinic, without asking any model", async () => {
    resetSessionsForTesting();
    calls.length = 0;

    const result = await handleChat({ message: "تو کی هستی؟", sessionId: "s-id", locale: "fa" });

    assertEqual(result.layer, "identity", "handled by the identity layer");
    assertEqual(result.model, null, "no model was needed");
    assert(result.reply.includes("کلینیک تست"), "names the clinic");
    assert(result.reply.includes("دستیار"), "calls itself the assistant");
    assertEqual(calls.filter((call) => call.url.includes("chat/completions")).length, 0, "no model call");
    assert(identityText().includes("کلینیک تست"), "identityText uses the configured clinic");
  });

  /* ── 6. Reading dates ───────────────────────────────────────────────── */

  const fixedNow = new Date("2026-11-09T12:00:00Z"); // Monday, 1405/08/18 in Tehran
  const ref = nowInZone(fixedNow);

  const oneDate = (text: string) => extractDates(text, ref)[0];

  await test("every date format a Persian user actually types", () => {
    const cases: Array<[string, string]> = [
      ["1403/05/12", "2024-08-02"],
      ["1403-05-12", "2024-08-02"],
      ["1403.5.12", "2024-08-02"],
      ["12/05/1403", "2024-08-02"],
      ["۱۲ مرداد ۱۴۰۳", "2024-08-02"],
      ["مرداد ۱۴۰۳", "2024-07-22"],
      ["2024-08-15", "2024-08-15"],
      ["15 August 2024", "2024-08-15"],
      ["امروز", "2026-11-09"],
      ["فردا", "2026-11-10"],
      ["دیروز", "2026-11-08"],
      ["پریروز", "2026-11-07"],
      ["عید", "2027-03-21"],
      ["۱۴۰۳", "2024-03-20"],
    ];

    for (const [text, expected] of cases) {
      const parsed = oneDate(text);
      const gregorian = parsed ? new Date(parsed.date.getTime()).toISOString().slice(0, 10) : "(none)";
      // Compare on the Tehran-local date, not UTC: the instant is midnight in Tehran.
      const local = parsed
        ? `${parsed.date.getFullYear()}-${String(parsed.date.getMonth() + 1).padStart(2, "0")}-${String(parsed.date.getDate()).padStart(2, "0")}`
        : "(none)";
      assertEqual(local, expected, `"${text}" → ${expected} (got ${gregorian} utc / ${local} local)`);
    }
  });

  await test("«پنجشنبه» is Thursday, not Saturday", () => {
    const thursday = oneDate("پنجشنبه چندمه");
    const saturday = oneDate("شنبه چندمه");
    assertEqual(thursday?.date.getDay(), 4, "پنجشنبه = Thursday (4)");
    assertEqual(saturday?.date.getDay(), 6, "شنبه = Saturday (6)");
  });

  await test("impossible dates are rejected instead of rolled over", () => {
    assertEqual(extractDates("1403/07/31", ref).length, 0, "Mehr has 30 days");
    assertEqual(extractDates("1403/12/31", ref).length, 0, "Esfand 1403 has 30 days");
    assertEqual(extractDates("2023-02-30", ref).length, 0, "February 2023 has 28 days");
    assert(extractDates("1399/12/30", ref).length === 1, "Esfand 1399 really has 30 days (leap)");
  });

  await test("an ordinary sentence that merely mentions a day is not a date question", () => {
    assertEqual(answerDateQuestion("دیروز خیلی خسته بودم", fixedNow), null, "venting, not asking");
    assertEqual(answerDateQuestion("شنبه تعطیله؟", fixedNow), null, "chatting about a holiday");
    assertEqual(answerDateQuestion("حال تو چطوره", fixedNow), null, "small talk");
    assert(answerDateQuestion("دیروز چه روزی بود", fixedNow) !== null, "an explicit question still works");
  });

  /* ── 7. The engine ──────────────────────────────────────────────────── */

  await test("«now» reads the server clock in the configured zone", () => {
    const facts = nowFacts(fixedNow);
    assertEqual(facts.intent, "now", "intent");
    assert(facts.summary.includes("۱۴۰۵/۰۸/۱۸") || facts.dates[0]?.jalali === "۱۴۰۵/۰۸/۱۸", `jalali ${facts.dates[0]?.jalali}`);
    assert(facts.dates[0]?.gregorian === "2026-11-09", `gregorian ${facts.dates[0]?.gregorian}`);
    assert((facts.time ?? "").startsWith("۱۵:۳۰"), `tehran time ${facts.time}`);
    assert(facts.summary.includes("به وقت تهران"), "says which zone");
    assert(facts.dates[0]?.hijri !== null, "hijri present");
  });

  await test("the same instant is a different day in Tehran than in UTC", () => {
    const lateUtc = new Date("2026-11-09T21:30:00Z");
    const tehran = nowInZone(lateUtc, "Asia/Tehran");
    const utc = nowInZone(lateUtc, "UTC");
    assertEqual(tehran.getDate(), 10, "already the 10th in Tehran");
    assertEqual(utc.getDate(), 9, "still the 9th in UTC");
  });

  await test("a bad TIME_ZONE falls back instead of throwing", () => {
    const zone = nowInZone(fixedNow, "Not/AZone");
    assert(Number.isFinite(zone.getTime()), "still produced a date");
  });

  await test("converting a date gives all three calendars", () => {
    const facts = answerDateQuestion("تبدیل 2024-08-15 به شمسی", fixedNow);
    assertEqual(facts?.intent, "convert", "intent");
    assertEqual(facts?.dates[0]?.jalali, "۱۴۰۳/۰۵/۲۵", "jalali");
    assertEqual(facts?.dates[0]?.gregorian, "2024-08-15", "gregorian");
    assertEqual(facts?.dates[0]?.hijri, "1446/02/11", "hijri");
    assert((facts?.dates[0]?.hijriLong ?? "").includes("صفر"), `hijri month name: ${facts?.dates[0]?.hijriLong}`);
  });

  await test("the gap between two dates, in either order", () => {
    const forward = answerDateQuestion("بین 1403/01/01 و 1403/01/10 چند روزه", fixedNow);
    assertEqual(forward?.intent, "between", "intent");
    assertEqual(forward?.days, 9, "9 days apart");

    const backward = answerDateQuestion("بین 1403/01/10 و 1403/01/01 چند روزه", fixedNow);
    assertEqual(backward?.days, 9, "order does not change the answer");

    const facts = betweenFacts(
      { date: ref, calendar: "jalali", raw: "", label: "امروز", source: "relative" },
      { date: ref, calendar: "jalali", raw: "", label: "امروز", source: "relative" },
    );
    assertEqual(facts.days, 0, "the same day is zero days apart");
  });

  await test("counting days across a leap year boundary", () => {
    const facts = answerDateQuestion("از 1403/12/29 تا 1404/01/02 چند روزه", fixedNow);
    assertEqual(facts?.days, 3, "1403 is leap: 12/29 → 12/30 → 01/01 → 01/02");
  });

  await test("listing a range, and stopping when it is long", () => {
    const short = answerDateQuestion("لیست روزهای بین 1403/01/01 و 1403/01/05", fixedNow);
    assertEqual(short?.intent, "range", "intent");
    assertEqual(short?.range?.length, 5, "five days listed");
    assertEqual(short?.rangeTruncated, false, "not truncated");

    const long = answerDateQuestion("لیست روزهای بین 1403/01/01 و 1403/12/29", fixedNow);
    assertEqual(long?.range?.length, 31, "caps the list at 31");
    assertEqual(long?.rangeTruncated, true, "says it was truncated");
    assert((long?.rangeTotal ?? 0) > 31, "still reports the real total");
  });

  await test("adding and subtracting time uses Jalali months, not Gregorian", () => {
    const plus = answerDateQuestion("۲۰ روز بعد از امروز", fixedNow);
    assertEqual(plus?.intent, "add", "intent");
    assert(plus?.dates[1]?.jalali === "۱۴۰۵/۰۹/۰۸", `20 days on: ${plus?.dates[1]?.jalali}`);

    // Six months after 31 Farvardin must clamp to 30 Mehr, not 28.
    const facts = addFacts(
      { date: ref, calendar: "jalali", raw: "", label: "۱۴۰۳/۰۱/۳۱", source: "explicit" },
      6,
      "month",
    );
    void facts;
    const clamped = answerDateQuestion("۶ ماه بعد از 1403/01/31", fixedNow);
    assertEqual(clamped?.dates[1]?.jalali, "۱۴۰۳/۰۷/۳۰", "clamps to the last day of Mehr");

    const minus = answerDateQuestion("۳ ماه قبل از عید", fixedNow);
    assertEqual(minus?.intent, "add", "intent");
    assert(minus?.summary.includes("قبل از"), "worded as before");
  });

  await test("month length and leap years, in the right calendar", () => {
    const mehr = answerDateQuestion("مرداد ۱۴۰۳ چند روزه", fixedNow);
    assertEqual(mehr?.intent, "monthLength", "intent");
    assertEqual(mehr?.daysInMonth, 31, "Mordad has 31 days");

    const esfand = answerDateQuestion("اسفند ۱۴۰۳ چند روزه", fixedNow);
    assertEqual(esfand?.daysInMonth, 30, "Esfand 1403 has 30 days (leap year)");

    const jalali = answerDateQuestion("۱۴۰۳ کبیسه است؟", fixedNow);
    assertEqual(jalali?.isLeap, true, "1403 is a Jalali leap year");

    const gregorian = answerDateQuestion("2024 کبیسه بود؟", fixedNow);
    assertEqual(gregorian?.isLeap, true, "2024 is a Gregorian leap year");
    assertEqual(gregorian?.daysInMonth, 29, "February 2024 has 29 days");

    const plain = answerDateQuestion("2023 کبیسه بود؟", fixedNow);
    assertEqual(plain?.isLeap, false, "2023 is not");

    void leapYearFacts;
  });

  /* ── 8. Wiring: the model words it, the engine decides it ───────────── */

  await test("the system prompt carries the clinic name and the server clock", () => {
    const prompt = systemPrompt("fa", "دوشنبه ۱۸ آبان ۱۴۰۵");
    assert(prompt.includes("کلینیک تست"), "clinic name");
    assert(prompt.includes("دوشنبه ۱۸ آبان ۱۴۰۵"), "the clock line");
    assert(prompt.includes("هرگز از حفظ نگو"), "forbids guessing dates");
  });

  await test("a date question reaches the model together with the computed facts", async () => {
    resetSessionsForTesting();
    calls.length = 0;

    const facts = answerDateQuestion("امروز چندمه؟");
    modelReply = `امروز ${facts?.dates[0]?.jalali} است`;

    const result = await handleChat({ message: "امروز چندمه؟", sessionId: "s-now", locale: "fa" });

    assertEqual(result.layer, "calendar", "calendar layer");
    assertEqual(result.dateIntent, "now", "intent");
    assertEqual(result.fellBackToDeterministic, false, "the model's wording was kept");
    assert(result.reply.includes(facts?.dates[0]?.jalali ?? ""), "the computed date is in the answer");

    const lastCall = calls.filter((call) => call.url.includes("chat/completions")).at(-1);
    const sent = (lastCall?.body as { messages: Array<{ role: string; content: string }> }).messages;
    assert(sent[0]?.content.includes("تاریخ و ساعت فعلی"), "the clock is in the system prompt");
    assert(
      sent.some((entry) => entry.role === "system" && entry.content.includes(`intent: ${facts?.intent ?? ""}`)),
      "the computed facts were sent to the model",
    );
  });

  await test("if the model changes a date, the computed answer wins", async () => {
    resetSessionsForTesting();
    const facts = answerDateQuestion("امروز چندمه؟");
    modelReply = "فکر کنم سال ۱۳۹۰ باشه";

    const result = await handleChat({ message: "امروز چندمه؟", sessionId: "s-garbled", locale: "fa" });

    assertEqual(result.fellBackToDeterministic, true, "fallback engaged");
    assertEqual(result.reply, facts?.summary, "the deterministic summary was sent");
    modelReply = "سلام! خوشحالم که اینجایی. 🙂";
  });

  await test("a date answer survives every model failing", async () => {
    resetSessionsForTesting();
    failAllModels = true;
    const facts = answerDateQuestion("تبدیل 2024-08-15 به شمسی");

    try {
      const result = await handleChat({ message: "تبدیل 2024-08-15 به شمسی", sessionId: "s-down", locale: "fa" });
      assertEqual(result.status, "answered", "still answered");
      assertEqual(result.layer, "calendar", "by the calendar layer");
      assert(result.reply.includes("۱۴۰۳/۰۵/۲۵"), "with the right date");
      assertEqual(result.reply, facts?.summary, "exactly the computed text");
    } finally {
      failAllModels = false;
    }
  });

  await test("DATE_ASSISTANT=false turns the calendar layer off", async () => {
    process.env.DATE_ASSISTANT = "false";
    resetConfigCache();
    try {
      assertEqual(answerDateQuestion("امروز چندمه؟", fixedNow), null, "no date answer");
    } finally {
      process.env.DATE_ASSISTANT = "true";
      resetConfigCache();
    }
  });

  /* ── 9. Persisted chat sessions ─────────────────────────────────────── */

  /**
   * A pretend Postgres. It implements only what chat-sessions.ts actually
   * sends, and records every query so the tests can assert on the SQL.
   */
  /**
   * Splits a parenthesised SQL list on its top-level commas.
   *
   * Depth-aware on purpose: a naive `[^)]*` or a plain `split(",")` breaks on
   * `now()`, which is exactly the kind of wrong answer that makes a guard worse
   * than no guard at all.
   */
  function sqlList(sql: string, opener: RegExp): string[] {
    const at = sql.search(opener);
    if (at < 0) return [];

    let depth = 0;
    let body = "";
    for (let index = at; index < sql.length; index += 1) {
      const char = sql[index];
      if (char === "(") {
        depth += 1;
        // Only the list's own opening paren is skipped. A nested one is real
        // content: dropping it while keeping its partner turns `now()` into
        // `now)`, and the level counter below then never finds the next comma.
        if (depth === 1) continue;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      if (depth > 0) body += char;
    }

    const parts: string[] = [];
    let level = 0;
    let current = "";
    for (const char of body) {
      if (char === "(") level += 1;
      else if (char === ")") level = Math.max(0, level - 1);
      if (char === "," && level === 0) {
        parts.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    parts.push(current.trim());
    return parts.filter(Boolean);
  }

  /**
   * The table's real columns, read out of the real schema statements.
   *
   * Deriving them beats retyping them: a column added to schema.ts is known here
   * immediately, and a column named in SQL but missing from the schema is not.
   */
  const DECLARED_COLUMNS = sqlList(
    SCHEMA_STATEMENTS.find((statement) => /create table/i.test(statement)) ?? "",
    /create table if not exists\s+\w+\s*\(/i,
  ).map((definition) => definition.split(/\s+/)[0]);

  function makeFakeDb() {
    type FakeRow = { session_id: string; phone: string | null; created_at: Date };
    const rows = new Map<number, FakeRow>();
    const queries: string[] = [];
    /** SQL the fake refused, the way Postgres would have. */
    const sqlErrors: string[] = [];
    let failNext = false;

    const stamp = () => new Date("2026-11-09T12:00:00Z").toISOString();

    const shape = (userId: number, row: FakeRow, inserted: boolean) => ({
      telegram_user_id: userId,
      session_id: row.session_id,
      phone: row.phone,
      created_at: row.created_at.toISOString(),
      updated_at: stamp(),
      last_seen_at: stamp(),
      inserted,
    });

    const runner = async (query: string, params: unknown[] = []): Promise<unknown[]> => {
      queries.push(query);
      if (failNext) {
        failNext = false;
        throw new Error("neon unreachable");
      }

      if (/create (table|index) if not exists/i.test(query)) return [];
      // Postgres would widen the table here; a Map has nothing to widen.
      if (/alter table .* add column if not exists/i.test(query)) return [];

      /*
       * The arity guard.
       *
       * A shipped INSERT once named six columns and supplied five values, and
       * this fake did not notice because it only pattern-matched. Real Postgres
       * rejects that on every row, so the check belongs here: if the column list
       * and the value list disagree, or a column does not exist, fail loudly
       * instead of quietly returning a plausible row.
       */
      if (/^\s*insert into\s+chat_sessions/i.test(query)) {
        const columns = sqlList(query, /insert into\s+chat_sessions\s*\(/i);
        const values = sqlList(query, /\bvalues\s*\(/i);

        if (columns.length !== values.length) {
          const detail =
            `INSERT arity mismatch: ${columns.length} columns (${columns.join(", ")}) ` +
            `but ${values.length} values (${values.join(", ")})`;
          sqlErrors.push(detail);
          throw new Error("INSERT has more target columns than expressions");
        }

        for (const column of columns) {
          if (!DECLARED_COLUMNS.includes(column)) {
            sqlErrors.push(`INSERT targets "${column}", which is not a column of ${TABLE_NAME}`);
            throw new Error(`column "${column}" of relation "${TABLE_NAME}" does not exist`);
          }
        }
      }

      if (/insert into chat_sessions/i.test(query)) {
        const userId = Number(params[0]);
        const proposed = String(params[1]);
        // The phone upsert carries the number in $3 and overwrites it on
        // conflict; the session upsert carries no number at all.
        const setsPhone = /set\s+phone\s*=\s*excluded\.phone/i.test(query);
        const incoming = params[2] === null || params[2] === undefined ? null : String(params[2]);

        const existing = rows.get(userId);
        if (existing) {
          if (setsPhone) existing.phone = incoming;
          return [shape(userId, existing, false)];
        }

        const created: FakeRow = {
          session_id: proposed,
          phone: setsPhone ? incoming : null,
          created_at: new Date(stamp()),
        };
        rows.set(userId, created);
        return [shape(userId, created, true)];
      }

      if (/select .* from chat_sessions where telegram_user_id/i.test(query)) {
        const row = rows.get(Number(params[0]));
        return row ? [shape(Number(params[0]), row, false)] : [];
      }

      return [];
    };

    return {
      runner,
      rows,
      queries,
      sqlErrors,
      fail: () => { failNext = true; },
    };
  }

  await test("a pasted connection string is repaired before it is used", () => {
    const pasted =
      "postgresql://neondb_owner:secret@ep-x.neon.tech/neondb?channel_binding=require&amp;sslmode=require";
    const cleaned = normalizeDatabaseUrl(pasted);
    assertEqual(cleaned, "postgresql://neondb_owner:secret@ep-x.neon.tech/neondb?sslmode=require", "repaired");
    assert(!cleaned.includes("&amp;"), "html escaping removed");
    assert(!cleaned.includes("channel_binding"), "libpq-only option dropped");
    assertEqual(
      normalizeDatabaseUrl("postgresql://u:p@h/db"),
      "postgresql://u:p@h/db?sslmode=require",
      "ssl is added when missing",
    );
    assertEqual(normalizeDatabaseUrl("  <postgresql://u:p@h/db>  "), "postgresql://u:p@h/db?sslmode=require", "markdown brackets stripped");
  });

  await test("the schema is idempotent, so it can run on every boot", () => {
    for (const statement of SCHEMA_STATEMENTS) {
      assert(isIdempotent(statement), "every statement can be re-run safely");
    }
    assert(SCHEMA_STATEMENTS.some((statement) => /create table/i.test(statement)), "creates the table");
    assert(SCHEMA_STATEMENTS.some((statement) => /create index/i.test(statement)), "creates the index");
  });

  await test("a new chat is stored, a returning chat keeps its session id", async () => {
    const db = makeFakeDb();
    setRunnerForTesting(db.runner);
    resetSchemaCache();
    resetChatSessionCacheForTesting();

    try {
      const first = await ensureChatSession(4242);
      assert(first !== null, "the row came back");
      assertEqual(first?.isNew, true, "flagged as new");
      assertEqual(db.rows.get(4242)?.session_id, first?.sessionId, "stored under the chat id");
      assert(
        /^[0-9a-f-]{36}$/.test(first?.sessionId ?? ""),
        `session id is a uuid: ${first?.sessionId}`,
      );

      // Clear the in-process cache so the second call really goes through SQL.
      resetChatSessionCacheForTesting();
      const second = await ensureChatSession(4242);
      assertEqual(second?.isNew, false, "not new any more");
      assertEqual(second?.fromCache, false, "read from the database, not from memory");
      assertEqual(second?.sessionId, first?.sessionId, "the same session id is kept");
      assertEqual(db.rows.size, 1, "still exactly one row for that chat");

      assert(
        db.queries.some((query) => /on conflict \(telegram_user_id\) do update/i.test(query)),
        "it is a real upsert, not select-then-insert",
      );
      assert(
        db.queries.some((query) => /xmax = 0/i.test(query)),
        "inserted-vs-updated comes from xmax, not a second query",
      );
    } finally {
      setRunnerForTesting(null);
      resetSchemaCache();
      resetChatSessionCacheForTesting();
    }
  });

  await test("a settled chat is answered from memory, an unsettled one is re-read", async () => {
    const db = makeFakeDb();
    setRunnerForTesting(db.runner);
    resetSchemaCache();
    resetChatSessionCacheForTesting();

    try {
      // No number yet: the chat is *not* settled, so we keep asking the database.
      // Another instance may have collected the number in the meantime, and
      // blocking somebody who already gave theirs is worse than one extra read.
      await ensureChatSession(777);
      const afterFirst = db.queries.length;
      const unsettled = await ensureChatSession(777);
      assertEqual(unsettled?.fromCache, false, "an unsettled chat is re-read, not served from memory");
      assert(db.queries.length > afterFirst, "the re-read really reached the database");

      // Once the number is on file the chat is settled and the DB is off the
      // hot path entirely.
      await setChatPhone(777, "09121234567");
      const afterSave = db.queries.length;
      const settled = await ensureChatSession(777);
      assertEqual(settled?.fromCache, true, "flagged as cached");
      assertEqual(settled?.phone, "09121234567", "the cached entry carries the number");
      assertEqual(db.queries.length, afterSave, "the settled chat issued no query at all");
    } finally {
      setRunnerForTesting(null);
      resetSchemaCache();
      resetChatSessionCacheForTesting();
    }
  });

  await test("without a database the bot falls back, it does not stop", async () => {
    setRunnerForTesting(null);
    resetChatSessionCacheForTesting();
    assertEqual(await ensureChatSession(123), null, "no session from a missing database");
    assertEqual(await resolveSessionId(123), "tg-123", "deterministic fallback");
    assertEqual(fallbackSessionId(123), "tg-123", "same shape as before this feature");
  });

  await test("a database error is logged, not thrown at the user", async () => {
    const db = makeFakeDb();
    setRunnerForTesting(db.runner);
    resetSchemaCache();
    resetChatSessionCacheForTesting();

    try {
      db.fail();
      const sessionId = await resolveSessionId(555);
      assertEqual(sessionId, "tg-555", "the message is still answered");
    } finally {
      setRunnerForTesting(null);
      resetSchemaCache();
      resetChatSessionCacheForTesting();
    }
  });

  /* ── 10. The phone gate ─────────────────────────────────────────────── */

  /** Runs a block with a fresh fake database and an empty outbox. */
  async function withGateDb(run: (db: ReturnType<typeof makeFakeDb>) => Promise<void>): Promise<void> {
    const db = makeFakeDb();
    setRunnerForTesting(db.runner);
    resetSchemaCache();
    resetChatSessionCacheForTesting();
    resetSessionsForTesting();
    calls.length = 0;
    modelReply = "سلام!";
    try {
      await run(db);
    } finally {
      setRunnerForTesting(null);
      resetSchemaCache();
      resetChatSessionCacheForTesting();
      resetSessionsForTesting();
    }
  }

  await test("Iranian numbers are read in every shape and stored as 09XXXXXXXXX", () => {
    const shapes: Array<[string, string]> = [
      ["09121234567", "09121234567"],
      ["۰۹۱۲۱۲۳۴۵۶۷", "09121234567"],
      ["٠٩١٢١٢٣٤٥٦٧", "09121234567"],
      ["+989121234567", "09121234567"],
      ["00989121234567", "09121234567"],
      ["989121234567", "09121234567"],
      ["9121234567", "09121234567"],
      ["+98 912 123 4567", "09121234567"],
      ["0912-123-4567", "09121234567"],
      ["(0912) 123 4567", "09121234567"],
    ];
    for (const [raw, expected] of shapes) {
      const check = normalizeIranPhone(raw);
      assertEqual(check.ok, true, `"${raw}" is accepted`);
      assertEqual(check.ok && check.normalized, expected, `"${raw}" → ${expected}`);
    }
    assertEqual(toAsciiDigits("۰۹۱۲"), "0912", "Persian digits are converted");
    assertEqual(displayPhone("09121234567"), "۰۹۱۲۱۲۳۴۵۶۷", "shown back to the user in Persian");
  });

  await test("anything that is not an Iranian mobile is refused, with a usable reason", () => {
    const refusals: Array<[string, string]> = [
      ["+14155552671", "not-iranian-mobile"],
      ["02112345678", "not-iranian-mobile"],
      ["+442071838750", "too-long"],
      ["0912123456", "too-short"],
      ["091212345678", "too-long"],
      ["سلام", "empty"],
      ["", "empty"],
    ];
    for (const [raw, reason] of refusals) {
      const check = normalizeIranPhone(raw);
      assertEqual(check.ok, false, `"${raw}" is refused`);
      assertEqual(!check.ok && check.reason, reason, `"${raw}" → ${reason}`);
    }
    assertEqual(isStoredPhone("09121234567"), true, "stored form is recognised");
    assertEqual(isStoredPhone("+989121234567"), false, "international form is not the stored form");
    assertEqual(isStoredPhone(null), false, "null is not a phone");
  });

  await test("the schema is safe to apply on every boot", () => {
    const create = SCHEMA_STATEMENTS.find((statement) => /create table/i.test(statement)) ?? "";
    assert(/phone\s+text/.test(create), "a fresh install gets the column");
    assert(
      SCHEMA_STATEMENTS.some((statement) =>
        /alter table \w+ add column if not exists phone text/i.test(statement),
      ),
      "an existing table is widened rather than left phone-less",
    );
    for (const statement of SCHEMA_STATEMENTS) {
      assert(isIdempotent(statement), `still idempotent: ${(statement.split("\n")[0] ?? "").slice(0, 40)}…`);
    }
  });

  /**
   * Idempotent means "safe to run on every boot", and there are two shapes:
   * `if not exists` for create/alter, and a guard against information_schema for
   * the rename — a bare RENAME COLUMN throws the second time round.
   */
  function isIdempotent(statement: string): boolean {
    return /if not exists/i.test(statement) || /if exists[\s\S]*rename column/i.test(statement);
  }

  await test("the key is the user id, and an old chat-id table is migrated", () => {
    const create = SCHEMA_STATEMENTS.find((statement) => /create table/i.test(statement)) ?? "";
    assert(/telegram_user_id\s+bigint\s+primary key/.test(create), "a fresh install is keyed by user id");
    assert(!/telegram_chat_id/.test(create), "and not by chat id");

    const rename = SCHEMA_STATEMENTS.find((statement) => /rename column/i.test(statement));
    assert(rename !== undefined, "there is a rename for databases that predate the change");
    // A bare RENAME COLUMN throws on the second boot, and this list runs on
    // every boot. The guard is what keeps it idempotent.
    assert(
      /information_schema\.columns/.test(rename ?? "") && /if exists/i.test(rename ?? ""),
      "the rename is guarded, so running it twice is harmless",
    );
  });

  await test("a phone number is stored against the chat id and read back", async () => {
    await withGateDb(async (db) => {
      assertEqual(await phoneFor(9001), null, "nothing on file for a new chat");

      await ensureChatSession(9001);
      assertEqual(db.rows.get(9001)?.phone, null, "the row exists before the number does");

      const saved = await setChatPhone(9001, "09121234567");
      assertEqual(saved?.phone, "09121234567", "the write returned the fresh row");
      assertEqual(db.rows.get(9001)?.phone, "09121234567", "the column holds the stored form");
      assertEqual(await phoneFor(9001), "09121234567", "read back under the chat id");
      assertEqual(cachedPhoneCount(), 1, "the cache knows the number now");
      assertEqual(
        db.sqlErrors.length,
        0,
        db.sqlErrors.length === 0
          ? "Postgres-shaped SQL throughout"
          : `Postgres would reject this SQL: ${db.sqlErrors.join(" | ")}`,
      );

      // Last line of defence: nothing but the stored form reaches the column.
      assertEqual(await setChatPhone(9002, "+14155552671"), null, "a foreign number is not written");
      assertEqual(db.rows.get(9002), undefined, "and no row is created for it");
    });
  });

  await test("the gate holds every message until a number is on file", async () => {
    await withGateDb(async () => {
      const outcome = await handleTelegramUpdate(telegramUpdate({ text: "امروز چندمه؟" }));
      assertEqual(outcome.handled, true, "the update was consumed");
      assertEqual(outcome.status, "phone-required", "and held at the gate");

      const markup = lastMarkup();
      assert(markup !== undefined, "a reply keyboard came with the ask");
      const keyboard = markup?.keyboard as Array<Array<{ request_contact?: boolean }>> | undefined;
      assertEqual(
        keyboard?.[0]?.[0]?.request_contact,
        true,
        "the button asks Telegram itself for the contact",
      );
      assert(lastSent().includes("شماره"), "the ask says what is missing");

      assertEqual(
        calls.filter((call) => call.url.includes("chat/completions")).length,
        0,
        "the model was never reached",
      );
    });
  });

  await test("/start is gated too, but /id is not", async () => {
    await withGateDb(async () => {
      const start = await handleTelegramUpdate(telegramUpdate({ text: "/start" }));
      assertEqual(start.status, "phone-required", "no welcome before the number is known");

      const id = await handleTelegramUpdate(telegramUpdate({ text: "/id" }));
      assertEqual(id.status, "id", "/id stays reachable, or the allowlist could never be set");
      assert(lastSent().includes("777"), "and it still echoes the chat id");
    });
  });

  await test("a shared Telegram contact saves the number, then the bot answers", async () => {
    await withGateDb(async (db) => {
      const shared = await handleTelegramUpdate(
        telegramUpdate({ contact: { phone_number: "+989121234567", user_id: 777 } }),
      );
      assertEqual(shared.status, "phone-saved", "the contact was accepted");
      assertEqual(db.rows.get(777)?.phone, "09121234567", "stored as 09XXXXXXXXX, no country code");
      assert(lastSent().includes("۰۹۱۲۱۲۳۴۵۶۷"), "confirmed back in Persian digits");
      assertEqual(lastMarkup()?.remove_keyboard, true, "and the keyboard was taken away");

      const asked = await handleTelegramUpdate(telegramUpdate({ text: "امروز چندمه؟" }));
      assertEqual(asked.status, "answered", "the next message is answered normally");
      assert(
        calls.some((call) => call.url.includes("chat/completions")),
        "the model was reached this time",
      );
    });
  });

  await test("a number typed as text is accepted where the button is not available", async () => {
    await withGateDb(async (db) => {
      const typed = await handleTelegramUpdate(telegramUpdate({ text: "۰۹۱۲۱۲۳۴۵۶۷" }));
      assertEqual(typed.status, "phone-saved", "Persian digits, typed by hand");
      assertEqual(db.rows.get(777)?.phone, "09121234567", "normalised to the stored form");
    });
  });

  await test("a foreign or landline number is refused and the user is asked again", async () => {
    await withGateDb(async (db) => {
      const foreign = await handleTelegramUpdate(
        telegramUpdate({ contact: { phone_number: "+14155552671", user_id: 777 } }),
      );
      assertEqual(foreign.status, "phone-rejected:not-iranian-mobile", "refused");
      assertEqual(db.rows.get(777)?.phone, undefined, "nothing was stored");
      assert(lastSent().includes("۰۹"), "the reply shows the wanted shape");

      // A one-time keyboard is gone once tapped, so it must be offered again.
      const markup = lastMarkup();
      const keyboard = markup?.keyboard as Array<Array<{ request_contact?: boolean }>> | undefined;
      assertEqual(keyboard?.[0]?.[0]?.request_contact, true, "the button is handed back");

      const landline = await handleTelegramUpdate(telegramUpdate({ text: "02112345678" }));
      assertEqual(landline.status, "phone-rejected:not-iranian-mobile", "a landline is not a mobile");
      assertEqual(await phoneFor(777), null, "still nothing on file");
    });
  });

  await test("with no database the gate steps aside instead of locking everyone out", async () => {
    setRunnerForTesting(null);
    resetChatSessionCacheForTesting();
    resetSessionsForTesting();
    calls.length = 0;
    modelReply = "سلام!";
    try {
      assertEqual(dbConfigured(), false, "there is nowhere to put a number");
      const outcome = await handleTelegramUpdate(telegramUpdate({ text: "سلام" }));
      assertEqual(outcome.status, "answered", "so the bot answers, exactly as it did before");
    } finally {
      resetChatSessionCacheForTesting();
      resetSessionsForTesting();
    }
  });

  await test("in a group each member is keyed by their own user id, not the group", async () => {
    await withGateDb(async (db) => {
      const GROUP = -100_200_300;
      const groupUpdate = (userId: number, updateId: number, text: string): TelegramUpdate => ({
        update_id: updateId,
        message: {
          message_id: updateId,
          date: 1,
          from: { id: userId, is_bot: false, first_name: "کاربر" },
          chat: { id: GROUP, type: "group" },
          text,
        },
      });

      await handleTelegramUpdate(groupUpdate(101, 5001, "۰۹۱۲۱۲۳۴۵۶۷"));
      await handleTelegramUpdate(groupUpdate(202, 5002, "۰۹۳۵۱۲۳۴۵۶۷"));

      assertEqual(db.rows.get(101)?.phone, "09121234567", "the first member has their own number");
      assertEqual(db.rows.get(202)?.phone, "09351234567", "the second keeps theirs, not the group's");
      assertEqual(db.rows.get(GROUP), undefined, "the group id itself owns no row");
      assert(db.rows.get(101)?.session_id !== db.rows.get(202)?.session_id, "and separate sessions");
    });
  });

  await test("/id reports both ids, because they mean different things now", async () => {
    await withGateDb(async () => {
      const GROUP = -100_200_300;
      const outcome = await handleTelegramUpdate({
        update_id: 5100,
        message: {
          message_id: 5100,
          date: 1,
          from: { id: 101, is_bot: false, first_name: "کاربر" },
          chat: { id: GROUP, type: "group" },
          text: "/id",
        },
      });
      assertEqual(outcome.status, "id", "the command ran");

      const sent = lastSent();
      assert(sent.includes("101"), "the user id — what settings are stored under");
      assert(sent.includes(String(GROUP)), "and the chat id — what the allowlist takes");
      assert(
        sent.includes("101") && sent.includes("-100200300") && sent.indexOf("101") !== sent.indexOf("-100200300"),
        "as two distinct numbers, not one",
      );
    });
  });

  await test("the same person in two different chats keeps one record", async () => {
    await withGateDb(async (db) => {
      const fromPrivate = telegramUpdate({ text: "۰۹۱۲۱۲۳۴۵۶۷" });
      await handleTelegramUpdate(fromPrivate);

      // Same user id, entirely different chat.
      const fromGroup: TelegramUpdate = {
        update_id: 6001,
        message: {
          message_id: 6001,
          date: 1,
          from: { id: 777, is_bot: false, first_name: "کاربر" },
          chat: { id: -100_999, type: "group" },
          text: "سلام",
        },
      };
      const answered = await handleTelegramUpdate(fromGroup);

      assertEqual(answered.status, "answered", "the number from the other chat still counts");
      assertEqual(db.rows.size, 1, "still exactly one row for that person");
      assertEqual(db.rows.get(777)?.phone, "09121234567", "with their number on it");
    });
  });

  await test("an update with no user is declined rather than misattributed", async () => {
    await withGateDb(async (db) => {
      const channelPost: TelegramUpdate = {
        update_id: 7001,
        message: {
          message_id: 7001,
          date: 1,
          chat: { id: -100_555, type: "channel" },
          text: "سلام",
        },
      };
      const outcome = await handleTelegramUpdate(channelPost);
      assertEqual(outcome.handled, false, "not handled");
      assertEqual(outcome.reason, "no user id on the update", "and the reason says why");
      assertEqual(db.rows.size, 0, "guessing at the chat id would have pooled strangers into one row");
    });
  });

  await test("Telegram: the stored session id is what the conversation is keyed by", async () => {
    const db = makeFakeDb();
    setRunnerForTesting(db.runner);
    resetSchemaCache();
    resetChatSessionCacheForTesting();
    resetSessionsForTesting();
    calls.length = 0;
    modelReply = "سلام";

    try {
      // The phone gate is in force, so the number has to exist before any
      // message is answered. Sharing the contact is the realistic first step.
      const gate = await handleTelegramUpdate(
        telegramUpdate({ contact: { phone_number: "+989121234567", user_id: 777 } }),
      );
      assertEqual(gate.status, "phone-saved", "the gate let the chat through afterwards");

      const outcome = await handleTelegramUpdate(telegramUpdate({ text: "سلام" }));
      assertEqual(outcome.handled, true, "message handled");

      const stored = db.rows.get(777);
      assert(stored !== undefined, "the chat id was written to the database");
      assert(
        /^[0-9a-f-]{36}$/.test(stored?.session_id ?? ""),
        `as a uuid: ${stored?.session_id}`,
      );

      // The model must have been called with that exact session as context key.
      const completion = calls.filter((call) => call.url.includes("chat/completions")).at(-1);
      assert(completion !== undefined, "the model was called");

      // And the conversation memory must live under the same key.
      const { conversationLength } = await import("@/lib/bot");
      assertEqual(conversationLength(stored?.session_id ?? ""), 2, "user + assistant stored under the uuid");
      assertEqual(conversationLength("tg-777"), 0, "the old fallback key is not used");
    } finally {
      setRunnerForTesting(null);
      resetSchemaCache();
      resetChatSessionCacheForTesting();
      modelReply = "سلام! خوشحالم که اینجایی. 🙂";
    }
  });

  await test("session ids are unique per chat and stable within one", () => {
    const a = newSessionId();
    const b = newSessionId();
    assert(a !== b, "two chats get two ids");
    assertEqual(typeof a, "string", "a string");
  });

  /* ── 11. Encrypted auth-session persistence ──────────────────────────── */

  const { EncryptedAuthSessionStore } = await import("@/lib/auth/session-store");
  const masterKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  await test("auth sessions are AES-GCM encrypted, actor-indexed, expiring, and tamper resistant", async () => {
    let now = 1_800_000_000_000;
    const dbState: { row?: { actorHash: unknown; payload: unknown; expiresAt: unknown } } = {};
    const statements: string[] = [];
    const run: import("@/lib/db/client").SqlRunner = async (query, params = []) => {
      statements.push(query);
      if (/^insert into auth_sessions/u.test(query)) {
        dbState.row = { actorHash: params[0], payload: params[1], expiresAt: params[2] };
        return [];
      }
      if (/^select encrypted_payload/u.test(query)) {
        return dbState.row ? [{ encrypted_payload: dbState.row.payload }] : [];
      }
      return [];
    };
    setRunnerForTesting(run);
    resetSchemaCache();
    const store = new EncryptedAuthSessionStore({ encryptionKey: masterKey, now: () => now, maxAgeMs: 60_000 });
    try {
      const session = {
        actorId: "+989121234567",
        lookupId: "telegram-user-777",
        sessionCookie: "session=highly-private-cookie",
        csrfToken: "highly-private-csrf",
      };
      assertEqual(await store.save(session), true, "valid session saved");
      assert(dbState.row !== undefined, "row written");
      const rowText = JSON.stringify(dbState.row);
      assert(!rowText.includes(session.actorId), "phone is not persisted as cleartext");
      assert(!rowText.includes(session.lookupId), "owner id is not persisted as cleartext");
      assert(!rowText.includes(session.sessionCookie), "session cookie is not persisted as cleartext");
      assert(!rowText.includes(session.csrfToken), "CSRF token is not persisted as cleartext");
      assert(typeof dbState.row?.actorHash === "string" && dbState.row.actorHash !== session.lookupId, "actor lookup uses an HMAC digest");
      assert(statements.some((statement) => statement.includes("create table if not exists auth_sessions")), "auth_sessions table schema is ensured");
      const restored = await store.get(session.lookupId);
      assertEqual(restored?.sessionCookie, session.sessionCookie, "cookie decrypts on read");
      assertEqual(restored?.csrfToken, session.csrfToken, "CSRF decrypts on read");
      assertEqual(restored?.expiresAt, now + 60_000, "local max age caps session retention");

      const wrongKey = new EncryptedAuthSessionStore({ encryptionKey: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789", now: () => now });
      assertEqual(await wrongKey.get(session.lookupId), null, "different key cannot decrypt or locate session");
      if (dbState.row) dbState.row.payload = `${String(dbState.row.payload).slice(0, -2)}aa`;
      assertEqual(await store.get(session.lookupId), null, "tampered ciphertext is rejected");
      assertEqual(await store.delete(session.lookupId), true, "local session deletion succeeds");
    } finally {
      setRunnerForTesting(null);
      resetSchemaCache();
    }
  });

  await test("encrypted auth-session storage fails closed without a database or valid key", async () => {
    setRunnerForTesting(null);
    resetSchemaCache();
    const noDatabase = new EncryptedAuthSessionStore({ encryptionKey: masterKey });
    assertEqual(await noDatabase.save({ actorId: "owner", sessionCookie: "session=secret" }), false, "missing database refuses to save");
    const invalidKey = new EncryptedAuthSessionStore({ encryptionKey: "not-a-32-byte-key" });
    assertEqual(await invalidKey.save({ actorId: "owner", sessionCookie: "session=secret" }), false, "invalid encryption key refuses to save");
  });

  await test("Telegram OTP flow state is encrypted and indexed without plaintext phone or Telegram id", async () => {
    const { EncryptedOtpLoginFlowStore } = await import("@/lib/auth/login-flow-store");
    let row: { hash: unknown; payload: unknown; expiresAt: unknown } | undefined;
    const statements: string[] = [];
    const run: import("@/lib/db/client").SqlRunner = async (query, params = []) => {
      statements.push(query);
      if (/^insert into auth_login_flows/u.test(query)) {
        row = { hash: params[0], payload: params[1], expiresAt: params[2] };
        return [];
      }
      if (/^select encrypted_payload from auth_login_flows/u.test(query)) {
        return row ? [{ encrypted_payload: row.payload }] : [];
      }
      return [];
    };
    setRunnerForTesting(run);
    resetSchemaCache();
    const store = new EncryptedOtpLoginFlowStore({ encryptionKey: masterKey, now: () => 1_800_000_000_000 });
    try {
      const flow = { step: "code" as const, phone: "+989121234567", expiresAt: 1_800_000_300_000 };
      assertEqual(await store.save("telegram-user-777", flow), true, "flow saved");
      assert(row !== undefined, "encrypted flow row written");
      const rowText = JSON.stringify(row);
      assert(!rowText.includes("telegram-user-777"), "Telegram user id is not plaintext");
      assert(!rowText.includes(flow.phone), "pending phone is not plaintext");
      assert(typeof row?.hash === "string" && row.hash !== "telegram-user-777", "flow index is HMACed");
      assert(statements.some((statement) => statement.includes("create table if not exists auth_login_flows")), "encrypted flow table schema is ensured");
      assertEqual((await store.get("telegram-user-777"))?.step, "code", "flow decrypts across requests");
    } finally {
      setRunnerForTesting(null);
      resetSchemaCache();
    }
  });

  await test("Telegram natural-language OTP login handles Persian digits and never returns secrets", async () => {
    const { TelegramOtpLogin, isOtpLoginIntent } = await import("@/lib/auth/telegram-login");
    const flows = new Map<string, import("@/lib/auth/login-flow-store").OtpLoginFlow>();
    const calls: Array<{ method: string; values: string[] }> = [];
    const otpClient = {
      request: async (phone: string) => {
        calls.push({ method: "request", values: [phone] });
        return { ok: true as const, expiresInMs: 300_000 };
      },
      resend: async (phone: string) => {
        calls.push({ method: "resend", values: [phone] });
        return { ok: true as const, expiresInMs: 300_000 };
      },
      verify: async (phone: string, code: string, lookupId?: string) => {
        calls.push({ method: "verify", values: [phone, code, lookupId ?? ""] });
        return { ok: true as const, sessionStored: true, ruleContextAvailable: true };
      },
    };
    const flowStore: import("@/lib/auth/login-flow-store").OtpLoginFlowStore = {
      save: async (id, flow) => { flows.set(id, structuredClone(flow)); return true; },
      get: async (id) => flows.get(id) ?? null,
      delete: async (id) => flows.delete(id),
    };
    const login = new TelegramOtpLogin({ otpClient, flowStore, now: () => 1_800_000_000_000 });
    assertEqual(isOtpLoginIntent("میخوام لاگین کنم"), true, "Persian login phrase recognized without asking the model");
    const started = await login.handle("telegram-user-777", "میخوام لاگین کنم");
    assertEqual(started.handled && started.status, "login-started", "login flow starts");
    const requested = await login.handle("telegram-user-777", "شماره من +۹۸۹۱۲۱۲۳۴۵۶۷ است");
    assertEqual(requested.handled && requested.status, "phone-requested", "SMS code requested");
    assertEqual(calls[0]?.values[0], "+989121234567", "Persian phone digits are normalized");
    const resent = await login.handle("telegram-user-777", "کد رو دوباره بفرست");
    assertEqual(resent.handled && resent.status, "code-resent", "resend phrase handled");
    const verified = await login.handle("telegram-user-777", "۱۲۳۴۵۶");
    assertEqual(verified.handled && verified.status, "authenticated", "six-digit code verifies");
    assertEqual(JSON.stringify(calls[2]?.values), JSON.stringify(["+989121234567", "123456", "telegram-user-777"]), "OTP and Telegram owner are passed to the secure client");
    assert(!JSON.stringify([started, requested, resent, verified]).includes("+989121234567"), "responses never echo the phone");
    assert(!JSON.stringify([started, requested, resent, verified]).includes("123456"), "responses never echo the OTP");
    assertEqual(flows.has("telegram-user-777"), false, "flow is removed after success");
  });

  /* ── 12. SMS OTP client ──────────────────────────────────────────────── */

  const { SmsOtpClient } = await import("@/lib/auth/sms-otp");

  await test("SMS OTP request, resend, and verify use the documented HTTPS API", async () => {
    const calls: Array<{ url: string; body: unknown; headers: Headers }> = [];
    let responseStatus = 200;
    let responseBody: unknown = { ok: true, expiresInMs: 300000, resendInMs: 60000 };
    let responseHeaders = new Headers({ "content-type": "application/json", "x-request-id": "otp-request-1" });
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const headers = new Headers(init.headers);
      calls.push({ url: typeof input === "string" ? input : String(input), body: JSON.parse(String(init.body)) as unknown, headers });
      return new Response(JSON.stringify(responseBody), { status: responseStatus, headers: responseHeaders });
    };
    const savedSessions: import("@/lib/auth/session-store").StoredAuthSession[] = [];
    const sessionStore: import("@/lib/auth/session-store").AuthSessionStore = {
      save: async (session) => { savedSessions.push(structuredClone(session)); return true; },
      get: async (actorId) => savedSessions.find((session) => (session.lookupId ?? session.actorId) === actorId) ?? null,
      delete: async (actorId) => {
        const index = savedSessions.findIndex((session) => session.actorId === actorId);
        if (index < 0) return false;
        savedSessions.splice(index, 1);
        return true;
      },
    };
    const otp = new SmsOtpClient({ fetchImpl, sessionStore });
    const requested = await otp.request("  +989121234567  ");
    assertEqual(requested.ok, true, "SMS request accepted");
    assertEqual(requested.ok ? requested.expiresInMs : undefined, 300000, "expiry returned by API");
    assertEqual(requested.ok ? requested.resendInMs : undefined, 60000, "resend cooldown returned by API");
    assertEqual(calls[0]?.url, "https://nafasbeautyclinic.ir/api/v1/auth/otp/request", "default API base URL and request path");
    assertEqual(JSON.stringify(calls[0]?.body), JSON.stringify({ channel: "sms", phone: "+989121234567" }), "phone is trimmed and channel fixed to SMS");

    const resent = await otp.resend("09121234567");
    assertEqual(resent.ok, true, "resend accepted");
    assertEqual(calls[1]?.url, "https://nafasbeautyclinic.ir/api/v1/auth/otp/resend", "resend path");
    assertEqual(JSON.stringify(calls[1]?.body), JSON.stringify({ channel: "sms", phone: "09121234567" }), "resend body matches the contract");

    const cookieHeaders = new Headers({ "content-type": "application/json", "x-request-id": "otp-verify-1", "x-csrf-token": "csrf-private" });
    cookieHeaders.append("set-cookie", "session=server-session; Path=/; HttpOnly; Secure; SameSite=Lax");
    responseHeaders = cookieHeaders;
    responseBody = { ok: true };
    const verified = await otp.verify("+989121234567", "123456", "telegram-user-777");
    assertEqual(verified.ok, true, "valid verification accepted");
    assertEqual(calls[2]?.url, "https://nafasbeautyclinic.ir/api/v1/auth/otp/verify", "verify path");
    assertEqual(JSON.stringify(calls[2]?.body), JSON.stringify({ phone: "+989121234567", code: "123456" }), "verify body has phone and six-digit code");
    if (verified.ok) {
      assertEqual(verified.sessionStored, true, "session is persisted before verify returns");
      assertEqual(verified.ruleContextAvailable, true, "session and CSRF are available for Rules API");
      assertEqual(verified.requestId, "otp-verify-1", "request id is returned");
      const context = await otp.getRuleRequestContext("telegram-user-777");
      assertEqual(context?.actorId, "+989121234567", "verified phone binds the actor");
      assertEqual(context?.csrfToken, "csrf-private", "CSRF response header is recovered from storage");
      assert(context?.sessionCookie.includes("session=server-session"), "server session cookie is recovered from storage");
      assert(!JSON.stringify(verified).includes("server-session"), "raw session cookie is not returned in the verification result");
      assert(!JSON.stringify(verified).includes("csrf-private"), "raw CSRF token is not returned in the verification result");
      assert(savedSessions[0]?.sessionCookie.includes("session=server-session"), "the injected store received the session for secure persistence");
      assertEqual(savedSessions[0]?.lookupId, "telegram-user-777", "session is indexed to the trusted Telegram owner id");
    }

    const beforeInvalid = calls.length;
    const invalidPhone = await otp.request("12345");
    const invalidCode = await otp.verify("09121234567", "12345x");
    assertEqual(invalidPhone.ok ? "ok" : invalidPhone.status, 400, "invalid phone rejected locally");
    assertEqual(invalidCode.ok ? "ok" : invalidCode.status, 400, "non-six-digit code rejected locally");
    assertEqual(calls.length, beforeInvalid, "invalid input never reaches API");
  });

  await test("SMS OTP failures preserve API errors and cookie sessions support Origin-protected rules", async () => {
    const fetchWith = (status: number, payload: unknown, headers = new Headers({ "content-type": "application/json" })): typeof fetch =>
      async () => new Response(JSON.stringify(payload), { status, headers });
    const invalid = await new SmsOtpClient({ fetchImpl: fetchWith(401, { code: "INVALID_CODE" }) }).verify("09121234567", "123456");
    assertEqual(invalid.ok ? "ok" : invalid.code, "INVALID_CODE", "invalid code is mapped");
    assertEqual(invalid.ok ? "ok" : invalid.status, 401, "401 is preserved");
    assert(invalid.ok === false && invalid.message.includes("درست نیست"), "localized invalid-code message");

    const locked = await new SmsOtpClient({ fetchImpl: fetchWith(423, { code: "LOCKED_OUT" }) }).verify("09121234567", "123456");
    assertEqual(locked.ok ? "ok" : locked.code, "LOCKED_OUT", "lockout code is preserved");
    assertEqual(locked.ok ? "ok" : locked.status, 423, "423 is preserved");

    const noCookie = await new SmsOtpClient({ fetchImpl: fetchWith(200, { ok: true }) }).verify("09121234567", "123456");
    assertEqual(noCookie.ok ? "ok" : noCookie.code, "SESSION_COOKIE_MISSING", "success without Set-Cookie cannot establish a reusable session");

    const cookieOnly = new Headers({ "content-type": "application/json" });
    cookieOnly.append("set-cookie", "session=server-session; Path=/; HttpOnly; Secure");
    const cookieOnlyStore: import("@/lib/auth/session-store").AuthSessionStore = {
      save: async () => true,
      get: async () => ({ actorId: "09121234567", sessionCookie: "session=server-session" }),
      delete: async () => true,
    };
    const missingCsrfClient = new SmsOtpClient({ fetchImpl: fetchWith(200, { ok: true }, cookieOnly), sessionStore: cookieOnlyStore });
    const missingCsrf = await missingCsrfClient.verify("09121234567", "123456");
    // beauty-clinic withSecurity checks Origin/Host on mutations, not a token.
    assertEqual(missingCsrf.ok ? missingCsrf.ruleContextAvailable : null, true, "cookie session is usable with the verified Origin-based rules contract");
    const cookieContext = await missingCsrfClient.getRuleRequestContext("09121234567");
    assertEqual(cookieContext?.sessionCookie, "session=server-session", "trusted cookie session is loaded server-side");
    assertEqual(cookieContext?.csrfToken, "", "no CSRF token is fabricated");

    const storageFailure = new SmsOtpClient({
      fetchImpl: fetchWith(200, { ok: true }, cookieOnly),
      sessionStore: { save: async () => false, get: async () => null, delete: async () => false },
    });
    const rejectedSession = await storageFailure.verify("09121234567", "123456");
    assertEqual(rejectedSession.ok ? "ok" : rejectedSession.code, "SESSION_STORAGE_FAILED", "storage failure fails closed after upstream verification");
    assert(!JSON.stringify(rejectedSession).includes("server-session"), "storage failure response contains no session material");
  });

  /* ── 12. Rules client ────────────────────────────────────────────────── */

  const { RuleManager, seedRules } = await import("@/lib/rules/manager");
  const { RulesAssistant } = await import("@/lib/rules/assistant");
  const RULE_CONTEXT = { actorId: "operator-1", sessionCookie: "session=private-cookie", csrfToken: "private-csrf" };
  const RULE_CREATE = {
    slug: "new-clinic-rule",
    translations: {
      fa: { name: "  قانون تازه  ", description: "  توضیح  " },
      en: { name: "  New rule  ", description: null },
    },
  };

  await test("AI rules assistant executes read tools and summarizes trusted results", async () => {
    const ruleCalls: Array<{ name: string; arguments: string }> = [];
    const fakeComplete = (async (options: import("@/lib/openrouter/client").CompletionOptions) => {
      assert((options.messages[0]?.content ?? "").includes("دستیار دقیق مدیریت قوانین"), "rules safety prompt is sent to the model");
      if (options.tools) {
        assert(options.tools.length >= 5, "AI receives rule function tools");
        assert(!JSON.stringify(options.messages).includes(RULE_CONTEXT.sessionCookie), "session cookie is never sent to AI");
        ruleCalls.push({ name: "list_rules", arguments: "" });
        return {
          content: "", model: "test/free-a:free", finishReason: "tool_calls", attempts: [], selection: "fixed" as const,
          toolCalls: [{ id: "read-1", type: "function" as const, function: { name: "list_rules", arguments: JSON.stringify({ status: "active" }) } }],
        };
      }
      assertEqual(options.messages.at(-1)?.role, "tool", "API results are returned to the model as tool output");
      return { content: "یک قانون فعال پیدا شد.", model: "test/free-a:free", finishReason: "stop", attempts: [], selection: "fixed" as const };
    }) as typeof complete;
    const manager = new RuleManager({ baseUrl: "" });
    const assistant = new RulesAssistant({ manager, completeImpl: fakeComplete });
    const result = await assistant.handle({ conversationId: "rules-ai-1", message: "قوانین فعال را نشان بده", locale: "fa", context: RULE_CONTEXT });
    assertEqual(result.kind, "read", "read action completes through the library");
    assertEqual(result.reply, "یک قانون فعال پیدا شد.", "AI phrases the API result");
    assertEqual(ruleCalls[0]?.name, "list_rules", "only the requested read function is selected");
  });

  await test("AI-proposed rule mutations wait for an explicit deterministic confirmation", async () => {
    let modelCalls = 0;
    const fakeComplete = (async () => {
      modelCalls += 1;
      return {
        content: "", model: "test/free-a:free", finishReason: "tool_calls", attempts: [], selection: "fixed" as const,
        toolCalls: [{ id: "create-1", type: "function" as const, function: { name: "create_rule", arguments: JSON.stringify(RULE_CREATE) } }],
      };
    }) as typeof complete;
    const manager = new RuleManager({ baseUrl: "" });
    const assistant = new RulesAssistant({ manager, completeImpl: fakeComplete });
    const proposed = await assistant.handle({ conversationId: "rules-ai-2", message: "قانون تازه‌ای بساز", locale: "fa", context: RULE_CONTEXT });
    assertEqual(proposed.kind, "proposed", "AI action creates only a proposal");
    assert(proposed.reply.includes("تأیید") && proposed.reply.includes("هنوز هیچ تغییری انجام نشده"), "the user sees explicit confirmation wording");
    assert(proposed.reply.includes("دادهٔ آزمایشی محلی"), "dummy mode is clearly labeled before confirmation");
    assertEqual((await manager.list()).total, 2, "proposal has not changed data");

    const ambiguous = await assistant.handle({ conversationId: "rules-ai-2", message: "فکر کنم خوبه", locale: "fa", context: RULE_CONTEXT });
    assertEqual(ambiguous.kind, "proposed", "ambiguous assent does not execute");
    assertEqual(modelCalls, 1, "confirmation is not delegated to model interpretation");
    assertEqual((await manager.list()).total, 2, "ambiguous answer leaves store unchanged");

    const confirmed = await assistant.handle({ conversationId: "rules-ai-2", message: "بله", locale: "fa", context: RULE_CONTEXT });
    assertEqual(confirmed.kind, "confirmed", "explicit yes applies the mutation");
    assert(confirmed.reply.includes("چیزی به API بیرونی ارسال نشد"), "dummy confirmation cannot claim a remote write");
    assertEqual((await manager.list()).total, 3, "only the explicit yes changes data");
    assertEqual(modelCalls, 1, "confirmation is deterministic, not another model call");

    const cancelledAssistant = new RulesAssistant({ manager: new RuleManager({ baseUrl: "" }), completeImpl: fakeComplete });
    await cancelledAssistant.handle({ conversationId: "rules-ai-3", message: "قانونی بساز", context: RULE_CONTEXT });
    const cancelled = await cancelledAssistant.handle({ conversationId: "rules-ai-3", message: "لغو", context: RULE_CONTEXT });
    assertEqual(cancelled.kind, "cancelled", "explicit cancel discards the proposal");
  });

  await test("handleChat lists rules capabilities honestly with and without an authenticated integration", async () => {
    const fakeComplete = (async (options: import("@/lib/openrouter/client").CompletionOptions) => {
      if (options.tools) {
        return {
          content: "", model: "test/free-a:free", finishReason: "tool_calls", attempts: [], selection: "fixed" as const,
          toolCalls: [{ id: "chat-rule-read", type: "function" as const, function: { name: "list_rules", arguments: JSON.stringify({ status: "active" }) } }],
        };
      }
      return { content: "یک قانون فعال وجود دارد.", model: "test/free-a:free", finishReason: "stop", attempts: [], selection: "fixed" as const };
    }) as typeof complete;
    const manager = new RuleManager({ baseUrl: "" });
    const assistant = new RulesAssistant({ manager, completeImpl: fakeComplete });
    resetSessionsForTesting();
    const result = await handleChat({
      message: "قوانین فعال را نشان بده",
      sessionId: "chat-rules-ai",
      locale: "fa",
      rulesAssistant: assistant,
      ruleContext: RULE_CONTEXT,
    });
    assertEqual(result.layer, "rules", "rules tool flow is integrated into handleChat when injected");
    assertEqual(result.reply, "یک قانون فعال وجود دارد.", "AI answer is returned by the chat library");

    const defaultCapabilities = await handleChat({ message: "چه کارهایی بلدی؟", sessionId: "chat-rules-caps-default", locale: "fa" });
    assert(defaultCapabilities.reply.includes("قوانین را هم می‌توانم فهرست و مدیریت کنم"), "rules are listed even for the default route");
    assert(defaultCapabilities.reply.includes("این درخواست نشست احراز هویت معتبر ندارد"), "default integration limits are disclosed");
    assert(defaultCapabilities.reply.includes("فهرست و مدیریت"), "the short answer summarizes rules capabilities");
    assert(!defaultCapabilities.reply.includes("رزرو نوبت") && !defaultCapabilities.reply.includes("کاتالوگ خدمات"), "Telegram-only clinic workflows are not advertised without otpLoginAvailable");

    const activeCapabilities = await handleChat({
      message: "چه کارهایی بلدی؟",
      sessionId: "chat-rules-caps-active",
      locale: "fa",
      rulesAssistant: assistant,
      ruleContext: RULE_CONTEXT,
    });
    assert(activeCapabilities.reply.includes("در این اتصال، دستیار قوانین با نشست احراز هویت‌شده فعال است"), "enabled integration is described accurately");

    const telegramCapabilities = await handleChat({
      message: "چه کارهایی بلدی؟",
      sessionId: "chat-otp-caps",
      locale: "fa",
      otpLoginAvailable: true,
    });
    assert(telegramCapabilities.reply.includes("ورود به حساب نفس با کد یک‌بارمصرف پیامکی"), "Telegram capabilities disclose the OTP login flow");
    assert(telegramCapabilities.reply.includes("می‌خواهم لاگین کنم"), "capabilities show the natural-language login example");
    assert(telegramCapabilities.reply.includes("ایمیل") && telegramCapabilities.reply.includes("پرداخت"), "the concise summary includes current email and payment tools");
    assert(telegramCapabilities.reply.length < 500, "the complete Telegram capability answer stays brief");
  });

  await test("dummy rules validate, paginate, filter, and require confirmation for writes", async () => {
    const manager = new RuleManager({ baseUrl: "", now: () => Date.parse("2026-06-01T00:00:00.000Z") });
    assertEqual((await manager.list()).total, 2, "two rules are seeded");
    assertEqual((await manager.list({ status: "active" })).rules.length, 1, "active filter");
    assertEqual((await manager.list({ status: "inactive" })).rules.length, 1, "inactive filter");
    assertEqual((await manager.list({ search: "CANCELLATION" })).total, 1, "case-insensitive bilingual search");
    assertEqual((await manager.list({ page: 2, perPage: 1 })).rules[0]?.slug, "cancellation-policy", "pagination is applied");
    assertEqual((await manager.list({ page: 0 })).error, "page باید عدد صحیحی بین ۱ تا ۱۰۰۰۰۰ باشد.", "invalid page is rejected");

    const invalidSlug = await manager.proposeCreate({ ...RULE_CREATE, slug: "Bad Slug" });
    assertEqual(invalidSlug.ok ? "ok" : invalidSlug.code, "invalid-slug", "slug is kebab-case");
    const invalidOrder = await manager.proposeCreate({ ...RULE_CREATE, displayOrder: 10001 });
    assertEqual(invalidOrder.ok ? "ok" : invalidOrder.code, "invalid-display-order", "display order is bounded");
    const invalidCases: Array<[string, () => Promise<{ ok: boolean; code?: string }>]> = [
      ["invalid-name", () => manager.proposeCreate({ ...RULE_CREATE, translations: { ...RULE_CREATE.translations, fa: { name: " ", description: null } } })],
      ["invalid-description", () => manager.proposeCreate({ ...RULE_CREATE, translations: { ...RULE_CREATE.translations, en: { name: "Valid", description: "x".repeat(2001) } } })],
      ["invalid-icon", () => manager.proposeCreate({ ...RULE_CREATE, icon: "x".repeat(101) })],
      ["invalid-image", () => manager.proposeCreate({ ...RULE_CREATE, image: "x".repeat(2049) })],
      ["invalid-color", () => manager.proposeCreate({ ...RULE_CREATE, color: "x".repeat(51) })],
      ["invalid-highlighted", () => manager.proposeCreate({ ...RULE_CREATE, highlighted: "yes" as unknown as boolean })],
      ["invalid-is-active", () => manager.proposeCreate({ ...RULE_CREATE, isActive: 1 as unknown as boolean })],
    ];
    for (const [expected, operation] of invalidCases) {
      const result = await operation();
      assertEqual(result.ok ? "ok" : result.code, expected, `${expected} is rejected`);
    }
    assert((await manager.list({ perPage: 101 })).error?.includes("perPage"), "perPage is bounded");
    assert((await manager.list({ search: "x".repeat(101) })).error?.includes("جست‌وجو"), "search length is bounded");

    const proposal = await manager.proposeCreate(RULE_CREATE);
    assertEqual(proposal.ok, true, "valid create is proposed");
    assertEqual((await manager.list()).total, 2, "proposal alone does not mutate the store");
    const confirmed = await manager.confirm(proposal.ok ? proposal.change.token : "");
    assertEqual(confirmed.ok, true, "confirmed create applies");
    const created = confirmed.ok ? (await manager.get(confirmed.applied[0] ?? "")).rule : null;
    assertEqual(created?.slug, "new-clinic-rule", "created slug is stored");
    assertEqual(created?.translations.fa.name, "قانون تازه", "names are trimmed");
    assertEqual(created?.translations.fa.description, "توضیح", "descriptions are trimmed");
    assertEqual(created?.highlighted, false, "highlighted default is false");
    assertEqual(created?.displayOrder, 0, "display order default is zero");
    assertEqual(created?.isActive, true, "active default is true");

    const id = created?.id ?? "";
    const update = await manager.proposeUpdate(id, { translations: { en: { name: "Updated name" } } });
    const changed = await manager.confirm(update.ok ? update.change.token : "");
    const after = (await manager.get(id)).rule;
    assertEqual(changed.ok, true, "confirmed patch applies");
    assertEqual(after?.translations.en.name, "Updated name", "only the requested locale/name changes");
    assertEqual(after?.translations.fa.name, "قانون تازه", "other locale is retained");
    assertEqual(after?.translations.en.description, null, "unmentioned description remains null");

    const bulk = await manager.proposeBulk({ action: "deactivate", scope: "filtered", filters: { search: "new-clinic-rule" } });
    const bulkResult = await manager.confirm(bulk.ok ? bulk.change.token : "");
    assertEqual(bulkResult.ok, true, "filtered bulk change is confirmed");
    assertEqual((await manager.get(id)).rule?.isActive, false, "filtered bulk deactivates the match");

    const tooMany = await manager.proposeBulk({ action: "delete", scope: "page", ids: Array.from({ length: 101 }, () => id) });
    assertEqual(tooMany.ok ? "ok" : tooMany.code, "too-many-ids", "bulk page is capped at 100 ids");
    const deleteProposal = await manager.proposeDelete(id);
    assertEqual(deleteProposal.ok, true, "delete requires an explicit proposal");
    assert((await manager.get(id)).rule !== null, "delete proposal leaves the rule in place");
    const deleted = await manager.confirm(deleteProposal.ok ? deleteProposal.change.token : "");
    assertEqual(deleted.ok, true, "confirmed deletion applies");
    assertEqual((await manager.get(id)).rule, null, "deleted rule is gone");
  });

  await test("live rules client sends per-call session and CSRF context only on requests", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers; body?: unknown; credentials?: RequestCredentials }> = [];
    let responseBody: unknown = { rules: seedRules(), page: 1, perPage: 10, total: 2 };
    let responseStatus = 200;
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      const headers = new Headers(init.headers);
      calls.push({
        url: typeof input === "string" ? input : String(input),
        method: init.method ?? "GET",
        headers,
        body: init.body ? JSON.parse(String(init.body)) as unknown : undefined,
        credentials: init.credentials,
      });
      return new Response(JSON.stringify(responseBody), {
        status: responseStatus,
        headers: { "content-type": "application/json", "x-request-id": "rules-request-1" },
      });
    };
    const manager = new RuleManager({ baseUrl: "https://rules.example.test", fetchImpl });
    const missingContext = await manager.list();
    assertEqual(missingContext.status, 401, "live request without context is unauthorized");
    assertEqual(calls.length, 0, "missing auth makes no network request");

    const listed = await manager.list({ page: 2, perPage: 5, search: " policy ", status: "active" }, RULE_CONTEXT);
    assertEqual(listed.total, 2, "live list parses pagination");
    assertEqual(listed.requestId, "rules-request-1", "request id is surfaced");
    const get = calls[0];
    assert(get?.url.includes("/api/v1/rules?page=2&perPage=5&status=active&search=policy"), "list query is normalized and encoded");
    assertEqual(get?.headers.get("cookie"), RULE_CONTEXT.sessionCookie, "cookie comes from this call context");
    assertEqual(get?.headers.get("x-csrf-token"), RULE_CONTEXT.csrfToken, "CSRF token comes from this call context");
    assertEqual(get?.credentials, "omit", "fetch does not add ambient credentials");

    const rejected = await manager.proposeCreate(RULE_CREATE);
    assertEqual(rejected.ok ? "ok" : rejected.code, "missing-auth-context", "live mutation proposal needs auth context");
    const proposal = await manager.proposeCreate(RULE_CREATE, RULE_CONTEXT);
    assertEqual(proposal.ok, true, "authenticated mutation is proposed");
    assertEqual(calls.length, 1, "proposal sends no request");
    assert(!JSON.stringify(proposal).includes(RULE_CONTEXT.sessionCookie), "pending change never exposes cookie");
    const wrongActor = await manager.confirm(proposal.ok ? proposal.change.token : "", { ...RULE_CONTEXT, actorId: "operator-2" });
    assertEqual(wrongActor.ok ? "ok" : wrongActor.code, "forbidden", "confirmation is bound to proposing actor");
    assertEqual(calls.length, 1, "wrong actor cannot trigger a request");

    responseBody = { rule: { ...seedRules()[0], id: "22222222-2222-4222-8222-222222222299", slug: "new-clinic-rule" } };
    const result = await manager.confirm(proposal.ok ? proposal.change.token : "", RULE_CONTEXT);
    assertEqual(result.ok, true, "same actor can confirm");
    const post = calls[1];
    assertEqual(post?.method, "POST", "create uses POST");
    assertEqual(post?.url, "https://rules.example.test/api/v1/rules", "create endpoint");
    assertEqual((post?.body as { slug?: string } | undefined)?.slug, "new-clinic-rule", "create body is normalized");
    assertEqual(result.ok ? result.requestId : undefined, "rules-request-1", "write request id is surfaced");

    responseStatus = 429;
    responseBody = { message: "Too many requests" };
    const limited = await manager.list({}, RULE_CONTEXT);
    assertEqual(limited.status, 429, "rate limit status is preserved");
    assertEqual(limited.error, "Too many requests", "API error message is returned");
  });

  await test("live rules client uses PATCH, DELETE, and bulk endpoints with safe validation", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const rule = seedRules()[0]!;
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      calls.push({ url: typeof input === "string" ? input : String(input), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) as unknown : undefined });
      const body = init.method === "GET" ? { rule } : { applied: [rule.id], failed: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    const manager = new RuleManager({ baseUrl: "https://rules.example.test", fetchImpl });
    const patch = await manager.proposeUpdate(rule.id, { translations: { fa: { description: null }, en: { name: "Changed" } } }, RULE_CONTEXT);
    assertEqual(patch.ok, true, "patch proposal can read target rule");
    const patched = await manager.confirm(patch.ok ? patch.change.token : "", RULE_CONTEXT);
    assertEqual(patched.ok, true, "patch confirmation succeeds");
    const patchRequest = calls.find((call) => call.method === "PATCH");
    assertEqual(patchRequest?.url, `https://rules.example.test/api/v1/rules/${rule.id}`, "PATCH endpoint");
    assertEqual((patchRequest?.body as { translations?: { en?: { name?: string } } } | undefined)?.translations?.en?.name, "Changed", "patch body stays partial");

    const bulk = await manager.proposeBulk({ action: "activate", scope: "page", ids: [rule.id] }, RULE_CONTEXT);
    const bulkResult = await manager.confirm(bulk.ok ? bulk.change.token : "", RULE_CONTEXT);
    assertEqual(bulkResult.ok, true, "bulk confirmation succeeds");
    const bulkRequest = calls.find((call) => call.url.endsWith("/bulk"));
    assertEqual(bulkRequest?.method, "POST", "bulk uses POST");
    assertEqual((bulkRequest?.body as { scope?: string } | undefined)?.scope, "page", "scope is transmitted");

    const deletion = await manager.proposeDelete(rule.id, RULE_CONTEXT);
    const deleted = await manager.confirm(deletion.ok ? deletion.change.token : "", RULE_CONTEXT);
    assertEqual(deleted.ok, true, "delete confirmation succeeds");
    assert(calls.some((call) => call.method === "DELETE" && call.url.endsWith(`/${rule.id}`)), "delete endpoint uses DELETE");

    const insecure = await new RuleManager({ baseUrl: "http://rules.example.test", fetchImpl }).list({}, RULE_CONTEXT);
    assertEqual(insecure.status, 0, "session cookies are never sent over plain HTTP");
  });

  /* ── 12. User management ────────────────────────────────────────────── */

  const { UserManager, seedUsers } = await import("@/lib/users/manager");
  const {
    CAPABILITIES,
    capabilitiesText,
    capabilitiesPromptBlock,
    confirmRequiredIds,
    findCapability,
  } = await import("@/lib/users/capabilities");
  const { isCapabilityQuestion, capabilityAnswer } = await import("@/lib/users/intent");

  const TEST_USER_CREDENTIALS = { email: "admin@example.test", password: "Manager123!" };

  type ApiCall = { url: string; method: string; body?: unknown; authorization?: string };

  /**
   * A pretend user API.
   *
   * It records every request so the tests can assert on *what was sent and
   * when* — which is the whole point of the confirmation rule. `mutating()`
   * counts only the verbs that change data, so "proposing sent nothing" is a
   * check on the wire and not on a return value.
   */
  function makeUserApi(options: {
    status?: number;
    body?: unknown;
    rawBody?: string;
    failWith?: "throw" | "abort";
    /**
     * What GETs answer with.
     *
     * Needed because a proposal reads the user before offering to change it, so
     * an API that answers every verb with the same body makes every proposal
     * fail with not-found and the mutation is never reached.
     */
    getUsers?: Array<Record<string, unknown>>;
  } = {}) {
    const calls: ApiCall[] = [];
    const impl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const raw = typeof init?.body === "string" ? init.body : undefined;
      const authorization = new Headers(init?.headers).get("Authorization") ?? undefined;
      calls.push({ url, method, ...(raw ? { body: JSON.parse(raw) } : {}), ...(authorization ? { authorization } : {}) });

      if (options.failWith === "abort") {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      if (options.failWith === "throw") throw new Error("network down");

      const isRead = method === "GET";
      const payload: unknown = isRead && options.getUsers ? { users: options.getUsers } : undefined;
      const bodyText =
        options.rawBody ?? JSON.stringify(payload ?? options.body ?? { users: [] });
      return new Response(bodyText, {
        status: isRead && options.getUsers ? 200 : options.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    return {
      impl,
      calls,
      mutating: () => calls.filter((call) => call.method !== "GET").length,
    };
  }

  const MUTATING_IDS = ["create", "edit", "role-change", "password-change", "password-reset", "ban", "unban", "delete", "bulk-enable", "bulk-disable", "bulk-delete"];

  await test("the dummy store answers without any network at all", async () => {
    const manager = new UserManager();
    assertEqual(manager.isLive, false, "not live without a base url");
    assertEqual(manager.mode, "dummy", "running against the dummy store");

    const all = await manager.list();
    assertEqual(all.users.length, 3, "three seeded users");
    assertEqual(all.live, false, "flagged as not from an API");
    assertEqual(all.error, undefined, "and no error");

    assertEqual((await manager.get("11111111-1111-4111-8111-111111111001"))?.firstName, "مریم", "fetched by id");
    assertEqual(await manager.get("11111111-1111-4111-8111-111111119999"), null, "an unknown id is null, not a throw");
  });

  await test("creating an account waits for confirmation and never stores its password in dummy data", async () => {
    const manager = new UserManager();
    const input = {
      fullName: "  مریم احمدی ",
      email: "  MARYAM@EXAMPLE.TEST ",
      phone: "+989121234567",
      password: "Secret123!",
      roleKey: "admin" as const,
    };
    const proposal = await manager.proposeCreate(input);
    assertEqual(proposal.ok, true, "a valid account can be proposed");
    assertEqual((await manager.list()).users.length, 3, "proposal has not created anything yet");
    assertEqual(manager.pendingCount(), 1, "the proposal waits for confirmation");
    const action = proposal.ok ? proposal.change.action : null;
    assert(action?.kind === "create", "the pending change is a create");
    assert(!JSON.stringify(proposal).includes(input.password), "the public proposal does not expose the password");
    assert(proposal.ok && !proposal.change.summary.includes(input.email), "the summary avoids personal details");

    const confirmed = await manager.confirm(proposal.ok ? proposal.change.token : "");
    assertEqual(confirmed.ok, true, "confirmation creates the account");
    const createdId = confirmed.ok ? confirmed.applied[0] ?? "" : "";
    const created = await manager.get(createdId);
    assertEqual(created?.firstName, "مریم", "names are trimmed");
    assertEqual(created?.lastName, "احمدی", "surname is trimmed");
    assertEqual(created?.fullName, "مریم احمدی", "full name is trimmed");
    assertEqual(created?.email, "maryam@example.test", "email is trimmed and lowercased");
    assertEqual(created?.phone, "+989121234567", "international phone is normalized to ASCII digits");
    assertEqual(created?.roleKey, "admin", "the selected role key is saved");
    assertEqual(created?.status, "active", "a new account starts active");
    assert(created !== null && !("password" in created), "dummy data never retains the password");
  });

  await test("live account creation sends the password only after confirmation", async () => {
    const api = makeUserApi({ body: { ok: true } });
    const manager = new UserManager({ baseUrl: "https://users.example.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: api.impl });
    const input = {
      fullName: "مریم احمدی", email: "maryam@example.test",
      phone: "+989121234567", password: "Secret123!", roleKey: "doctor" as const,
    };
    const proposal = await manager.proposeCreate(input);
    assertEqual(proposal.ok, true, "proposal accepted");
    assertEqual(api.mutating(), 0, "not one write before yes");
    assert(!JSON.stringify(api.calls).includes(input.password), "the password was not sent while proposing");
    const result = await manager.confirm(proposal.ok ? proposal.change.token : "");
    assertEqual(result.ok, true, "confirmed request completed");
    const post = api.calls.find((call) => call.method === "POST");
    assertEqual(post?.url, "https://users.example.test/users", "POSTs to the users collection");
    assertEqual((post?.body as Record<string, unknown> | undefined)?.password, input.password, "password goes only in the confirmed request");
    assertEqual((post?.body as Record<string, unknown> | undefined)?.roleKey, "doctor", "role key is included");
    assertEqual(JSON.stringify(Object.keys(post?.body as object).sort()), JSON.stringify(["email", "fullName", "password", "phone", "roleKey"].sort()), "the API receives only account fields");
    assert(api.calls.every((call) => call.authorization === `Basic ${Buffer.from("admin@example.test:Manager123!").toString("base64")}`), "every live request uses Basic Auth");

    const failingApi = makeUserApi({ status: 409, body: { message: "duplicate email" } });
    const failingManager = new UserManager({ baseUrl: "https://users.example.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: failingApi.impl });
    const failedProposal = await failingManager.proposeCreate(input);
    const failedResult = await failingManager.confirm(failedProposal.ok ? failedProposal.change.token : "");
    assertEqual(failedResult.ok, true, "API failure is reported as a failed application, not a thrown error");
    if (failedResult.ok) {
      assertEqual(failedResult.applied.length, 0, "failed create applies nothing");
      assertEqual(failedResult.failed[0]?.reason, "duplicate email", "the API reason is returned");
      assertEqual(failedResult.failed[0]?.status, 409, "email conflict status is preserved");
    }
  });

  await test("dummy mode enforces case-insensitive unique emails on create and edit", async () => {
    const manager = new UserManager();
    const duplicateCreate = await manager.proposeCreate({
      fullName: "Maryam Ahmadi", email: " MARYAM.AHMADI@example.test ",
      phone: "+989121234567", password: "Secret123!", roleKey: "customer",
    });
    assertEqual(!duplicateCreate.ok && duplicateCreate.code, "email-taken", "existing email refused on create");

    const duplicateEdit = await manager.proposeEdit("11111111-1111-4111-8111-111111111001", {
      email: " MARYAM.REZAEI@example.test ",
    });
    assertEqual(!duplicateEdit.ok && duplicateEdit.code, "email-taken", "another account's email refused on edit");
    const selfEmail = await manager.proposeEdit("11111111-1111-4111-8111-111111111001", {
      email: " MARYAM.AHMADI@example.test ",
    });
    assertEqual(selfEmail.ok, true, "an account can retain its own email");
  });

  await test("account creation rejects invalid names, email, phone, password, and role", async () => {
    const manager = new UserManager();
    const valid = {
      fullName: "مریم احمدی", email: "maryam@example.test",
      phone: "+989121234567", password: "Secret123!", roleKey: "customer" as const,
    };
    const cases: Array<{ input: unknown; code: string }> = [
      { input: { ...valid, fullName: "م" }, code: "invalid-name" },
      { input: { ...valid, fullName: "الف".repeat(101) }, code: "invalid-name" },
      { input: { ...valid, email: "not-an-email" }, code: "invalid-email" },
      { input: { ...valid, email: undefined }, code: "invalid-email" },
      { input: { ...valid, email: `${"a".repeat(246)}@test.com` }, code: "invalid-email" },
      { input: { ...valid, password: "Abc1!" }, code: "invalid-password" },
      { input: { ...valid, password: "Abcdefg!" }, code: "invalid-password" },
      { input: { ...valid, password: "abcdefg1!" }, code: "invalid-password" },
      { input: { ...valid, password: "Abcdefg1" }, code: "invalid-password" },
      { input: { ...valid, password: `${"Abc123!"}${"x".repeat(122)}` }, code: "invalid-password" },
      { input: { ...valid, phone: "+1 (415)5552671" }, code: "invalid-phone" },
      { input: { ...valid, phone: "123456" }, code: "invalid-phone" },
      { input: { ...valid, phone: `1${"2".repeat(15)}` }, code: "invalid-phone" },
      { input: { ...valid, roleKey: "owner" }, code: "invalid-role" },
      { input: { ...valid, roleKey: undefined }, code: "invalid-role" },
    ];
    for (const item of cases) {
      const result = await manager.proposeCreate(item.input as never);
      assertEqual(!result.ok && result.code, item.code, `invalid input refused as ${item.code}`);
    }
    assertEqual(manager.pendingCount(), 0, "invalid forms do not create pending actions");

    const missingName = await manager.proposeCreate({ ...valid, fullName: undefined } as never);
    assertEqual(!missingName.ok && missingName.code, "invalid-name", "missing name is refused safely");
    const missingInput = await manager.proposeCreate(undefined as never);
    assertEqual(!missingInput.ok && missingInput.code, "invalid-name", "a missing payload is rejected safely");
    const missingPhone = await manager.proposeCreate({ ...valid, phone: undefined } as never);
    assertEqual(!missingPhone.ok && missingPhone.code, "invalid-phone", "a missing phone is refused");

    const boundary = await manager.proposeCreate({
      fullName: "AB".repeat(50),
      email: `${"a".repeat(245)}@test.com`,
      phone: "1234567",
      password: "Aa1!xxxx",
      roleKey: "receptionist",
    });
    assertEqual(boundary.ok, true, "upper and lower field boundaries are valid");

    const customRoleManager = new UserManager({ roleKeys: ["clinic-auditor"] });
    const customRole = await customRoleManager.proposeCreate({ ...valid, roleKey: "clinic-auditor" });
    assertEqual(customRole.ok, true, "configured roles-table keys can be used too");
  });

  await test("editing validates and normalizes name, email, and role fields", async () => {
    const manager = new UserManager();
    const badName = await manager.proposeEdit("11111111-1111-4111-8111-111111111001", { fullName: "م" });
    assertEqual(!badName.ok && badName.code, "invalid-name", "short full name refused");
    const badFirstName = await manager.proposeEdit("11111111-1111-4111-8111-111111111001", { firstName: "م" });
    assertEqual(!badFirstName.ok && badFirstName.code, "invalid-name", "short legacy first name refused");
    const badLastName = await manager.proposeEdit("11111111-1111-4111-8111-111111111001", { lastName: " " });
    assertEqual(!badLastName.ok && badLastName.code, "invalid-name", "blank surname refused");
    const badEmail = await manager.proposeEdit("11111111-1111-4111-8111-111111111001", { email: "bad" });
    assertEqual(!badEmail.ok && badEmail.code, "invalid-email", "bad email refused");
    const badRole = await manager.proposeEdit("11111111-1111-4111-8111-111111111001", { roleKey: "owner" as never });
    assertEqual(!badRole.ok && badRole.code, "invalid-role", "unknown role key refused");
    const badLegacyRole = await manager.proposeEdit("11111111-1111-4111-8111-111111111001", { role: "owner" as never });
    assertEqual(!badLegacyRole.ok && badLegacyRole.code, "invalid-role", "unknown legacy role refused");

    const proposal = await manager.proposeEdit("11111111-1111-4111-8111-111111111001", {
      firstName: "  مریم‌سادات ", lastName: " احمدی ",
      email: " NEW@EXAMPLE.TEST ", roleKey: "receptionist",
    });
    assertEqual(proposal.ok, true, "valid fields proposed");
    await manager.confirm(proposal.ok ? proposal.change.token : "");
    const updated = await manager.get("11111111-1111-4111-8111-111111111001");
    assertEqual(updated?.firstName, "مریم‌سادات", "first name trimmed");
    assertEqual(updated?.lastName, "احمدی", "last name trimmed");
    assertEqual(updated?.email, "new@example.test", "email canonicalized");
    assertEqual(updated?.roleKey, "receptionist", "role key changed");
    const invalidRoleProposal = await manager.proposeRoleChange("11111111-1111-4111-8111-111111111001", "owner");
    assertEqual(!invalidRoleProposal.ok && invalidRoleProposal.code, "invalid-role", "unlisted role keys are refused");
    const roleProposal = await manager.proposeRoleChange("11111111-1111-4111-8111-111111111001", "admin");
    assertEqual(roleProposal.ok, true, "known role can be proposed");
    await manager.confirm(roleProposal.ok ? roleProposal.change.token : "");
    assertEqual((await manager.get("11111111-1111-4111-8111-111111111001"))?.roleKey, "admin", "role change waits then applies");

    const canonical = await manager.proposeEdit("11111111-1111-4111-8111-111111111001", {
      fullName: "  نام کامل  ", role: "doctor", status: "disabled",
    });
    await manager.confirm(canonical.ok ? canonical.change.token : "");
    const canonicalUser = await manager.get("11111111-1111-4111-8111-111111111001");
    assertEqual(canonicalUser?.fullName, "نام کامل", "canonical full name is trimmed");
    assertEqual(canonicalUser?.roleKey, "doctor", "legacy role field maps to the role key");
    assertEqual(canonicalUser?.isActive, false, "disabled status maps to inactive");
    assertEqual(canonicalUser?.status, "disabled", "status is retained in dummy data");

    const activate = await manager.proposeEdit("11111111-1111-4111-8111-111111111001", { status: "active" });
    await manager.confirm(activate.ok ? activate.change.token : "");
    assertEqual((await manager.get("11111111-1111-4111-8111-111111111001"))?.isActive, true, "active status maps to active flag");
  });

  await test("ban and unban wait for confirmation and update the dummy status", async () => {
    const manager = new UserManager({ now: () => Date.parse("2026-06-01T00:00:00.000Z") });
    const tooLong = await manager.proposeBan("11111111-1111-4111-8111-111111111001", "x".repeat(501));
    assertEqual(!tooLong.ok && tooLong.code, "invalid-ban-reason", "reason over 500 is refused");

    const ban = await manager.proposeBan("11111111-1111-4111-8111-111111111001", "  fraud report  ");
    assertEqual(ban.ok, true, "ban proposal accepted");
    assertEqual((await manager.get("11111111-1111-4111-8111-111111111001"))?.isBanned, false, "no ban before confirmation");
    const banned = await manager.confirm(ban.ok ? ban.change.token : "");
    assertEqual(banned.ok, true, "ban confirmed");
    const user = await manager.get("11111111-1111-4111-8111-111111111001");
    assertEqual(user?.isBanned, true, "marked banned");
    assertEqual(user?.bannedAt, "2026-06-01T00:00:00.000Z", "ban timestamp recorded");
    assertEqual(user?.banReason, "fraud report", "reason trimmed");
    assertEqual(user?.status, "banned", "status reflects ban");

    const unban = await manager.proposeUnban("11111111-1111-4111-8111-111111111001");
    await manager.confirm(unban.ok ? unban.change.token : "");
    const restored = await manager.get("11111111-1111-4111-8111-111111111001");
    assertEqual(restored?.isBanned, false, "ban cleared");
    assertEqual(restored?.bannedAt, null, "timestamp cleared");
    assertEqual(restored?.banReason, null, "reason cleared");
    assertEqual(restored?.status, "active", "active user restored as active");

    const disabledBan = await manager.proposeBan("11111111-1111-4111-8111-111111111003");
    await manager.confirm(disabledBan.ok ? disabledBan.change.token : "");
    const disabledUnban = await manager.proposeUnban("11111111-1111-4111-8111-111111111003");
    await manager.confirm(disabledUnban.ok ? disabledUnban.change.token : "");
    assertEqual((await manager.get("11111111-1111-4111-8111-111111111003"))?.status, "disabled", "inactive user stays inactive when unbanned");
  });

  await test("live role assignment sends roleKey for server-side grant authorization", async () => {
    const api = makeUserApi({ getUsers: seedUsers() as unknown as Array<Record<string, unknown>> });
    const manager = new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: api.impl });
    const proposal = await manager.proposeRoleChange("11111111-1111-4111-8111-111111111001", "doctor");
    assertEqual(api.mutating(), 0, "role change waits for confirmation");
    const result = await manager.confirm(proposal.ok ? proposal.change.token : "");
    assertEqual(result.ok, true, "role change outcome returned");
    const request = api.calls.find((call) => call.method === "PATCH");
    assertEqual(JSON.stringify(request?.body), JSON.stringify({ roleKey: "doctor" }), "role key sent as canonical API field");
    assert(request?.authorization?.startsWith("Basic "), "actor identity sent for server permission checks");
  });

  await test("ban and unban calls carry explicit state to the authenticated API", async () => {
    const api = makeUserApi({ getUsers: seedUsers() as unknown as Array<Record<string, unknown>> });
    const manager = new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: api.impl });
    const ban = await manager.proposeBan("11111111-1111-4111-8111-111111111001", "abuse");
    assertEqual(api.mutating(), 0, "proposal does not send a state change");
    await manager.confirm(ban.ok ? ban.change.token : "");
    const unban = await manager.proposeUnban("11111111-1111-4111-8111-111111111001");
    await manager.confirm(unban.ok ? unban.change.token : "");
    const patches = api.calls.filter((call) => call.method === "PATCH");
    assertEqual(JSON.stringify(patches.map((call) => call.body)), JSON.stringify([
      { isBanned: true, banReason: "abuse" },
      { isBanned: false, banReason: null },
    ]), "ban/unban are explicit PATCH actions");
    assert(patches.every((call) => call.authorization?.startsWith("Basic ")), "both updates authenticated");
  });

  await test("stale ban and password actions refuse users soft-deleted before confirmation", async () => {
    const manager = new UserManager();
    const ban = await manager.proposeBan("11111111-1111-4111-8111-111111111002");
    const unban = await manager.proposeUnban("11111111-1111-4111-8111-111111111002");
    const passwordChange = await manager.proposePasswordChange(
      "11111111-1111-4111-8111-111111111002", "Strong123!", "Strong123!",
    );
    const passwordReset = await manager.proposePasswordReset("11111111-1111-4111-8111-111111111002");
    const deletion = await manager.proposeDelete("11111111-1111-4111-8111-111111111002");
    await manager.confirm(deletion.ok ? deletion.change.token : "");

    for (const action of [ban, unban, passwordChange, passwordReset]) {
      const result = await manager.confirm(action.ok ? action.change.token : "");
      assertEqual(result.ok, true, "the attempted operation returns an outcome");
      assert(result.ok && result.failed[0]?.reason === "not-found", "soft-deleted account is refused at apply time");
    }
    const missingChange = await manager.proposePasswordChange("11111111-1111-4111-8111-111111119999", "Strong123!", "Strong123!");
    assertEqual(!missingChange.ok && missingChange.code, "not-found", "password change refuses an unknown target");
    const missingReset = await manager.proposePasswordReset("11111111-1111-4111-8111-111111119999");
    assertEqual(!missingReset.ok && missingReset.code, "not-found", "reset refuses an unknown target");
  });

  await test("password change validates matching secrets and never exposes them before confirmation", async () => {
    const manager = new UserManager();
    const invalid = await manager.proposePasswordChange(
      "11111111-1111-4111-8111-111111111001", "abc", "abc",
    );
    assertEqual(!invalid.ok && invalid.code, "invalid-password", "weak password refused");
    const mismatch = await manager.proposePasswordChange(
      "11111111-1111-4111-8111-111111111001", "Strong123!", "Different123!",
    );
    assertEqual(!mismatch.ok && mismatch.code, "password-mismatch", "confirmation must match");

    const proposal = await manager.proposePasswordChange(
      "11111111-1111-4111-8111-111111111001", "Strong123!", "Strong123!",
    );
    assertEqual(proposal.ok, true, "strong matching password proposed");
    assert(!JSON.stringify(proposal).includes("Strong123!"), "new password stays private in the proposal");
    const result = await manager.confirm(proposal.ok ? proposal.change.token : "");
    assertEqual(result.ok, true, "dummy change confirmed");
    const changedUser = await manager.get("11111111-1111-4111-8111-111111111001");
    assert(changedUser !== null && !("password" in changedUser) && !("passwordHash" in changedUser), "dummy record never stores a raw password or hash");
  });

  await test("password reset delegates generation to API; dummy reset follows the documented format", async () => {
    const api = makeUserApi({
      getUsers: seedUsers() as unknown as Array<Record<string, unknown>>,
      body: { temporaryPassword: "AbCdEf0123456789aA1!", passwordChangeRequired: true },
    });
    const live = new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: api.impl });
    const proposal = await live.proposePasswordReset("11111111-1111-4111-8111-111111111001");
    assertEqual(api.mutating(), 0, "proposal does not reset yet");
    const confirmed = await live.confirm(proposal.ok ? proposal.change.token : "");
    assertEqual(confirmed.ok, true, "reset response succeeds");
    if (confirmed.ok) {
      assertEqual(confirmed.temporaryPassword, "AbCdEf0123456789aA1!", "temporary password returned to the caller");
      assertEqual(confirmed.passwordChangeRequired, true, "forced next-login change is signalled");
    }
    const reset = api.calls.find((call) => call.url.endsWith("/reset-password"));
    assertEqual(reset?.method, "POST", "dedicated reset endpoint used");
    assertEqual(reset?.authorization?.startsWith("Basic "), true, "reset is authenticated");

    const dummy = new UserManager();
    const dummyProposal = await dummy.proposePasswordReset("11111111-1111-4111-8111-111111111001");
    const dummyResult = await dummy.confirm(dummyProposal.ok ? dummyProposal.change.token : "");
    assert(dummyResult.ok && /^[A-Za-z0-9_-]{16}aA1!$/u.test(dummyResult.temporaryPassword ?? ""), "dummy temporary secret uses 12 base64url bytes plus the required suffix");
    assertEqual(dummyResult.ok && dummyResult.passwordChangeRequired, true, "dummy marks change required too");
  });

  await test("live password changes send the matched password only after confirmation", async () => {
    const api = makeUserApi({ getUsers: seedUsers() as unknown as Array<Record<string, unknown>> });
    const manager = new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: api.impl });
    const proposal = await manager.proposePasswordChange(
      "11111111-1111-4111-8111-111111111001", "Strong123!", "Strong123!",
    );
    assertEqual(api.mutating(), 0, "proposal does not send password");
    const confirmed = await manager.confirm(proposal.ok ? proposal.change.token : "");
    assertEqual(confirmed.ok, true, "password change completed");
    const request = api.calls.find((call) => call.method === "PUT");
    assertEqual(request?.url, "https://api.test/users/11111111-1111-4111-8111-111111111001/password", "password endpoint used");
    assertEqual(JSON.stringify(request?.body), JSON.stringify({ newPassword: "Strong123!", confirmation: "Strong123!" }), "both matching values go only after confirmation");
  });

  await test("live password, ban, and reset failures preserve API errors", async () => {
    const badStateApi = makeUserApi({
      getUsers: seedUsers() as unknown as Array<Record<string, unknown>>,
      status: 409,
      body: { message: "not allowed" },
    });
    const manager = new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: badStateApi.impl });
    const ban = await manager.proposeBan("11111111-1111-4111-8111-111111111001");
    const banResult = await manager.confirm(ban.ok ? ban.change.token : "");
    assert(banResult.ok && banResult.failed[0]?.reason === "not allowed", "ban failures are returned");
    const change = await manager.proposePasswordChange(
      "11111111-1111-4111-8111-111111111001", "Strong123!", "Strong123!",
    );
    const changeResult = await manager.confirm(change.ok ? change.change.token : "");
    assert(changeResult.ok && changeResult.failed[0]?.reason === "not allowed", "password failures are returned");

    const limitedApi = makeUserApi({
      getUsers: seedUsers() as unknown as Array<Record<string, unknown>>,
      status: 429,
      body: { message: "rate limit exceeded" },
    });
    const limited = new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: limitedApi.impl });
    const reset = await limited.proposePasswordReset("11111111-1111-4111-8111-111111111001");
    const resetResult = await limited.confirm(reset.ok ? reset.change.token : "");
    assert(resetResult.ok && resetResult.failed[0]?.reason === "rate limit exceeded", "429 is surfaced from the API");
    assert(resetResult.ok && resetResult.failed[0]?.status === 429, "the upstream status code is preserved too");
  });

  await test("password reset tolerates missing or non-object API response data", async () => {
    const noSecret = makeUserApi({
      getUsers: seedUsers() as unknown as Array<Record<string, unknown>>,
      body: { passwordChangeRequired: false },
    });
    const noSecretManager = new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: noSecret.impl });
    const noSecretProposal = await noSecretManager.proposePasswordReset("11111111-1111-4111-8111-111111111001");
    const noSecretResult = await noSecretManager.confirm(noSecretProposal.ok ? noSecretProposal.change.token : "");
    assert(noSecretResult.ok && noSecretResult.temporaryPassword === undefined, "missing temporary password stays absent");
    assertEqual(noSecretResult.ok && noSecretResult.passwordChangeRequired, false, "explicit false is preserved");

    const calls: string[] = [];
    const stringBodyFetch = (async (_input: unknown, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(method);
      return new Response(method === "GET" ? JSON.stringify({ users: seedUsers() }) : "reset accepted", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const stringBodyManager = new UserManager({
      baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: stringBodyFetch,
    });
    const stringBodyProposal = await stringBodyManager.proposePasswordReset("11111111-1111-4111-8111-111111111001");
    const stringBodyResult = await stringBodyManager.confirm(stringBodyProposal.ok ? stringBodyProposal.change.token : "");
    assert(stringBodyResult.ok && stringBodyResult.temporaryPassword === undefined, "non-object response has no password");
    assertEqual(stringBodyResult.ok && stringBodyResult.passwordChangeRequired, true, "missing flag defaults to forced change");
    assertEqual(calls.join(","), "GET,POST", "one lookup and one confirmed reset");
  });

  await test("search finds by name, phone, and id — including Persian digits", async () => {
    const manager = new UserManager();

    assertEqual((await manager.search("مریم")).users.length, 2, "both Maryams by first name");
    assertEqual((await manager.search("رضایی")).users.length, 1, "one by surname");
    assertEqual((await manager.search("11111111-1111-4111-8111-111111111001")).users.length, 1, "by id");
    assertEqual((await manager.search("maryam.ahmadi@example.test")).users[0]?.id, "11111111-1111-4111-8111-111111111001", "by email");
    assertEqual((await manager.search("0935")).users[0]?.id, "11111111-1111-4111-8111-111111111002", "by part of the phone");
    assertEqual((await manager.search("۰۹۱۲")).users[0]?.id, "11111111-1111-4111-8111-111111111001", "Persian digits match too");
    assertEqual((await manager.search("")).users.length, 3, "an empty query lists everyone");
    assertEqual((await manager.search("   ")).users.length, 3, "whitespace counts as empty");
    assertEqual((await manager.search("ناموجود")).users.length, 0, "no match is an empty list");
  });

  await test("proposing a change sends nothing — only confirming does", async () => {
    const api = makeUserApi({ body: { users: seedUsers() } });
    const manager = new UserManager({ baseUrl: "https://users.example.com", credentials: TEST_USER_CREDENTIALS, fetchImpl: api.impl });

    const proposal = await manager.proposeEdit("11111111-1111-4111-8111-111111111001", { firstName: "مریم‌سادات" });
    assertEqual(proposal.ok, true, "the proposal was accepted");
    assert(!proposal.ok || proposal.change.token.length > 0, "and carries a token");
    assert(!proposal.ok || proposal.change.summary.includes("11111111-1111-4111-8111-111111111001"), "the summary names the user");
    assertEqual(api.mutating(), 0, "no mutating request went out while proposing");

    const confirmed = await manager.confirm(proposal.ok ? proposal.change.token : "");
    assertEqual(confirmed.ok, true, "confirming worked");
    assertEqual(api.mutating(), 1, "exactly one mutating request, and only now");
    const patch = api.calls.find((call) => call.method === "PATCH");
    assertEqual(patch?.url, "https://users.example.com/users/11111111-1111-4111-8111-111111111001", "sent to the right path");
  });

  await test("a token is single-use, and a cancelled one cannot be revived", async () => {
    const manager = new UserManager();

    const first = await manager.proposeDelete("11111111-1111-4111-8111-111111111001");
    const token = first.ok ? first.change.token : "";
    assertEqual((await manager.confirm(token)).ok, true, "the first confirm applies it");
    assertEqual(await manager.get("11111111-1111-4111-8111-111111111001"), null, "and the user is gone");

    const replay = await manager.confirm(token);
    assertEqual(replay.ok, false, "a second confirm is refused");
    assertEqual(!replay.ok && replay.code, "unknown-token", "as an unknown token");

    const second = await manager.proposeDelete("11111111-1111-4111-8111-111111111002");
    const other = second.ok ? second.change.token : "";
    assertEqual(manager.cancel(other), true, "cancelling reports success");
    assertEqual(manager.cancel(other), false, "cancelling twice does not");
    assertEqual((await manager.confirm(other)).ok, false, "and the cancelled change cannot run");
  });

  await test("a proposal that is never confirmed expires on its own", async () => {
    let clock = 1_000_000;
    const manager = new UserManager({ now: () => clock, pendingTtlMs: 60_000 });

    const proposal = await manager.proposeDelete("11111111-1111-4111-8111-111111111001");
    const token = proposal.ok ? proposal.change.token : "";
    assert(manager.pendingChange(token) !== null, "valid right after proposing");
    assertEqual(manager.pendingCount(), 1, "one change waiting");

    clock += 59_999;
    assert(manager.pendingChange(token) !== null, "still valid one ms before expiry");

    clock += 2;
    assertEqual(manager.pendingChange(token), null, "expired, and dropped from the map");

    const late = await manager.confirm(token);
    assertEqual(late.ok, false, "a late yes does not apply it");
    assertEqual(!late.ok && late.code, "unknown-token", "the token is already gone");
  });

  await test("an expired token still held in the map is refused as expired", async () => {
    let clock = 1_000_000;
    const manager = new UserManager({ now: () => clock, pendingTtlMs: 60_000 });

    const proposal = await manager.proposeBulk(["11111111-1111-4111-8111-111111111001", "11111111-1111-4111-8111-111111111002"], "disable");
    const token = proposal.ok ? proposal.change.token : "";

    // Move past expiry but read it through confirm, which is the path that has
    // to notice a token that has aged out while nobody looked at it.
    clock += 60_001;
    const result = await manager.confirm(token);
    assertEqual(result.ok, false, "refused");
    assertEqual(!result.ok && result.code, "expired", "with the expired code");
    assertEqual((await manager.get("11111111-1111-4111-8111-111111111001"))?.status, "active", "and nothing changed");
  });

  await test("bulk enable, disable and delete all wait for the same confirmation", async () => {
    const manager = new UserManager();

    const disable = await manager.proposeBulk(["11111111-1111-4111-8111-111111111001", "11111111-1111-4111-8111-111111111002"], "disable");
    assertEqual(disable.ok, true, "proposed");
    assert(!disable.ok || disable.change.summary.includes("۲"), "the summary says how many");
    assertEqual((await manager.confirm(disable.ok ? disable.change.token : "")).ok, true, "applied");
    assertEqual((await manager.get("11111111-1111-4111-8111-111111111001"))?.status, "disabled", "11111111-1111-4111-8111-111111111001 switched off");
    assertEqual((await manager.get("11111111-1111-4111-8111-111111111002"))?.status, "disabled", "11111111-1111-4111-8111-111111111002 switched off");

    const enable = await manager.proposeBulk(["11111111-1111-4111-8111-111111111001"], "enable");
    await manager.confirm(enable.ok ? enable.change.token : "");
    assertEqual((await manager.get("11111111-1111-4111-8111-111111111001"))?.status, "active", "and switched back on");

    const remove = await manager.proposeBulk(["11111111-1111-4111-8111-111111111001", "11111111-1111-4111-8111-111111111003"], "delete");
    const result = await manager.confirm(remove.ok ? remove.change.token : "");
    assertEqual(result.ok, true, "bulk delete applied");
    assertEqual((await manager.list()).users.length, 1, "one user left");
  });

  await test("bulk proposals dedupe ids and report the ones that do not exist", async () => {
    const manager = new UserManager();

    const dupes = await manager.proposeBulk(["11111111-1111-4111-8111-111111111001", "11111111-1111-4111-8111-111111111001", " 11111111-1111-4111-8111-111111111002 "], "disable");
    assertEqual(dupes.ok, true, "accepted");
    assertEqual(dupes.ok ? dupes.change.affected.length : 0, 2, "duplicates collapsed, ids trimmed");

    const partial = await manager.proposeBulk(["11111111-1111-4111-8111-111111111001", "11111111-1111-4111-8111-111111119999"], "delete");
    assertEqual(partial.ok, true, "accepted for the ones that exist");
    assert(
      !partial.ok || partial.change.summary.includes("11111111-1111-4111-8111-111111119999"),
      "and the summary names the missing one",
    );
    assertEqual(partial.ok ? partial.change.affected.join(",") : "", "11111111-1111-4111-8111-111111111001", "only real ids are queued");

    const none = await manager.proposeBulk(["11111111-1111-4111-8111-111111119999"], "delete");
    assertEqual(none.ok, false, "refused when nobody in the list exists");
    assertEqual(!none.ok && none.code, "not-found", "as not-found");
  });

  await test("proposals are refused, with a reason the user can act on", async () => {
    const manager = new UserManager();

    const malformedEdit = await manager.proposeEdit("not-a-uuid", {});
    assertEqual(!malformedEdit.ok && malformedEdit.code, "invalid-user-id", "edit target must be a UUID");
    const malformedBan = await manager.proposeBan("not-a-uuid");
    assertEqual(!malformedBan.ok && malformedBan.code, "invalid-user-id", "ban target must be a UUID");
    const malformedUnban = await manager.proposeUnban("not-a-uuid");
    assertEqual(!malformedUnban.ok && malformedUnban.code, "invalid-user-id", "unban target must be a UUID");
    const malformedPasswordChange = await manager.proposePasswordChange("not-a-uuid", "Strong123!", "Strong123!");
    assertEqual(!malformedPasswordChange.ok && malformedPasswordChange.code, "invalid-user-id", "password-change target must be a UUID");
    const malformedReset = await manager.proposePasswordReset("not-a-uuid");
    assertEqual(!malformedReset.ok && malformedReset.code, "invalid-user-id", "reset target must be a UUID");

    const missingBan = await manager.proposeBan("11111111-1111-4111-8111-111111119999");
    assertEqual(!missingBan.ok && missingBan.code, "not-found", "ban refuses an unknown user");
    const missingUnban = await manager.proposeUnban("11111111-1111-4111-8111-111111119999");
    assertEqual(!missingUnban.ok && missingUnban.code, "not-found", "unban refuses an unknown user");

    const empty = await manager.proposeEdit("11111111-1111-4111-8111-111111111001", {});
    assertEqual(!empty.ok && empty.code, "no-change", "an empty patch changes nothing");

    const badPhone = await manager.proposeEdit("11111111-1111-4111-8111-111111111001", { phone: "+1 4155552671" });
    assertEqual(!badPhone.ok && badPhone.code, "invalid-phone", "a formatted phone is refused");
    assert(!badPhone.ok && badPhone.message.includes("۷ تا ۱۵"), "and the reply shows the accepted shape");

    const missing = await manager.proposeEdit("11111111-1111-4111-8111-111111119999", { firstName: "نام" });
    assertEqual(!missing.ok && missing.code, "not-found", "editing a user who is not there");

    const gone = await manager.proposeDelete("11111111-1111-4111-8111-111111119999");
    assertEqual(!gone.ok && gone.code, "not-found", "deleting a user who is not there");
    const invalidId = await manager.proposeDelete("not-a-uuid");
    assertEqual(!invalidId.ok && invalidId.code, "invalid-user-id", "malformed target ids refused");
    const invalidBulkId = await manager.proposeBulk(["u-123"], "delete");
    assertEqual(!invalidBulkId.ok && invalidBulkId.code, "invalid-user-id", "malformed ids refused in bulk");

    const noIds = await manager.proposeBulk([], "disable");
    assertEqual(!noIds.ok && noIds.code, "empty-list", "an empty list");

    const junk = await manager.proposeBulk(["11111111-1111-4111-8111-111111111001"], "explode" as "delete");
    assertEqual(!junk.ok && junk.code, "unknown-action", "an action that does not exist");

    // Every refusal message must be real Persian, not a placeholder.
    for (const failure of [empty, badPhone, missing, gone, noIds, junk]) {
      assert(!failure.ok && failure.message.length > 5, "each refusal carries a message");
    }
  });

  await test("a phone typed in any shape is stored in the canonical one", async () => {
    const manager = new UserManager();

    const proposal = await manager.proposeEdit("11111111-1111-4111-8111-111111111003", { phone: "۰۹۱۲۱۲۳۴۵۶۷" });
    assertEqual(proposal.ok, true, "Persian digits with spaces are accepted");
    const patch = proposal.ok && proposal.change.action.kind === "edit" ? proposal.change.action.patch : {};
    assertEqual(patch.phone, "09121234567", "normalised before it is even proposed");

    await manager.confirm(proposal.ok ? proposal.change.token : "");
    assertEqual((await manager.get("11111111-1111-4111-8111-111111111003"))?.phone, "09121234567", "and stored that way");
    assertEqual((await manager.get("11111111-1111-4111-8111-111111111003"))?.status, "disabled", "the rest of the record is untouched");
  });

  await test("an edit can also clear a phone number", async () => {
    const manager = new UserManager();
    const proposal = await manager.proposeEdit("11111111-1111-4111-8111-111111111001", { phone: null });
    assertEqual(proposal.ok, true, "null is a deliberate value, not a missing one");
    await manager.confirm(proposal.ok ? proposal.change.token : "");
    assertEqual((await manager.get("11111111-1111-4111-8111-111111111001"))?.phone, null, "cleared");
  });

  await test("live user lists hide soft-deleted and malformed rows", async () => {
    const deleted = { ...seedUsers()[0], deletedAt: "2026-01-02T00:00:00.000Z" };
    const rows = [...seedUsers(), deleted, null] as unknown as Array<Record<string, unknown>>;
    const api = makeUserApi({ getUsers: rows });
    const manager = new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: api.impl });
    const listed = await manager.list();
    assertEqual(listed.users.length, 3, "soft-deleted and null rows are not exposed");

    const deletedApi = makeUserApi({ getUsers: [deleted] as unknown as Array<Record<string, unknown>> });
    const deletedManager = new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: deletedApi.impl });
    assertEqual(await deletedManager.get("11111111-1111-4111-8111-111111111001"), null, "a deleted target is treated as missing");
  });

  await test("live requests fail closed without actor Basic Auth credentials", async () => {
    const api = makeUserApi();
    const missing = await new UserManager({ baseUrl: "https://api.test", fetchImpl: api.impl }).list();
    assertEqual(missing.error, "missing or invalid Basic Auth credentials", "missing credentials return an auth error");
    assertEqual(missing.status, 401, "missing credentials are 401");
    assertEqual(api.calls.length, 0, "no unauthenticated request is sent");

    const blankEmail = await new UserManager({ baseUrl: "https://api.test", credentials: { email: " ", password: "secret" }, fetchImpl: api.impl }).list();
    assertEqual(blankEmail.error, "missing or invalid Basic Auth credentials", "blank email is rejected");
    const blankPassword = await new UserManager({ baseUrl: "https://api.test", credentials: { email: "a@example.test", password: "" }, fetchImpl: api.impl }).list();
    assertEqual(blankPassword.error, "missing or invalid Basic Auth credentials", "blank password is rejected");
    assertEqual(api.calls.length, 0, "invalid credentials never reach fetch");

    const insecure = await new UserManager({
      baseUrl: "http://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: api.impl,
    }).list();
    assertEqual(insecure.error, "HTTPS is required for Basic Auth", "clear-text Basic Auth is refused");
    assertEqual(api.calls.length, 0, "credentials are never sent over HTTP");
  });

  await test("live mode talks to the API and accepts either response shape", async () => {
    const wrapped = makeUserApi({ body: { users: [{ id: "a1", firstName: "A", lastName: "B", phone: null, status: "active", createdAt: "", updatedAt: "" }] } });
    const wrappedManager = new UserManager({ baseUrl: "https://api.example.com/v1/", credentials: TEST_USER_CREDENTIALS, fetchImpl: wrapped.impl });
    assertEqual(wrappedManager.isLive, true, "live once a base url is set");
    assertEqual(wrappedManager.mode, "live", "mode follows");
    const wrappedResult = await wrappedManager.search("مریم");
    assertEqual(wrappedResult.live, true, "flagged as from the API");
    assertEqual(wrappedResult.users[0]?.id, "a1", "wrapped in { users: [...] }");
    assertEqual(
      wrapped.calls[0]?.url,
      "https://api.example.com/v1/users?q=%D9%85%D8%B1%DB%8C%D9%85",
      "trailing slash collapsed and the query encoded",
    );
    assertEqual(
      wrapped.calls[0]?.authorization,
      `Basic ${Buffer.from("admin@example.test:Manager123!").toString("base64")}`,
      "Basic Auth is also attached to GET reads",
    );

    const bare = makeUserApi({ body: [{ id: "b1" }] });
    const bareResult = await new UserManager({ baseUrl: "https://api.example.com", credentials: TEST_USER_CREDENTIALS, fetchImpl: bare.impl }).list();
    assertEqual(bareResult.users[0]?.id, "b1", "a bare array is accepted too");
    assertEqual(bare.calls[0]?.url, "https://api.example.com/users", "listing has no query string");

    for (const key of ["data", "results", "items"]) {
      const api = makeUserApi({ body: { [key]: [{ id: key }] } });
      const result = await new UserManager({ baseUrl: "https://x.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: api.impl }).list();
      assertEqual(result.users[0]?.id, key, `wrapped in { ${key}: [...] }`);
    }
  });

  await test("a live lookup that fails says so instead of inventing an empty list", async () => {
    const broken = makeUserApi({ status: 500, body: { message: "database is on fire" } });
    const result = await new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: broken.impl }).search("x");
    assertEqual(result.users.length, 0, "no users");
    assertEqual(result.error, "database is on fire", "and the server's own reason is carried");

    const plain = makeUserApi({ status: 404, rawBody: "" });
    const plainResult = await new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: plain.impl }).list();
    assertEqual(plainResult.error, "HTTP 404", "a bare status becomes the reason");

    const garbage = makeUserApi({ rawBody: "not json at all" });
    const garbageResult = await new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: garbage.impl }).list();
    assertEqual(garbageResult.error, "unparsable response", "unparseable JSON is reported");

    const thrown = makeUserApi({ failWith: "throw" });
    const thrownResult = await new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: thrown.impl }).list();
    assertEqual(thrownResult.error, "network down", "a thrown error is caught, not surfaced");

    const aborted = makeUserApi({ failWith: "abort" });
    const abortedResult = await new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: aborted.impl }).list();
    assertEqual(abortedResult.error, "timeout", "an abort reads as a timeout");
  });

  await test("in live mode one bulk action is one request, not one per user", async () => {
    const api = makeUserApi({
      getUsers: seedUsers() as unknown as Array<Record<string, unknown>>,
      body: { applied: ["11111111-1111-4111-8111-111111111001"], failed: [{ id: "11111111-1111-4111-8111-111111111002", reason: "locked" }] },
    });
    const manager = new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: api.impl });

    const proposal = await manager.proposeBulk(["11111111-1111-4111-8111-111111111001", "11111111-1111-4111-8111-111111111002"], "disable");
    const result = await manager.confirm(proposal.ok ? proposal.change.token : "");

    const posts = api.calls.filter((call) => call.method === "POST");
    assertEqual(posts.length, 1, "a single POST for the whole list");
    assertEqual(posts[0]?.url, "https://api.test/users/bulk", "to the bulk endpoint");
    assertEqual(JSON.stringify(posts[0]?.body), JSON.stringify({ action: "disable", ids: ["11111111-1111-4111-8111-111111111001", "11111111-1111-4111-8111-111111111002"] }), "with the action and the ids");
    assertEqual(result.ok, true, "confirmed");
    if (result.ok) {
      assertEqual(result.applied.join(","), "11111111-1111-4111-8111-111111111001", "the server's own accounting is trusted");
      assertEqual(result.failed[0]?.reason, "locked", "including its failures");
      assertEqual(result.mode, "live", "and it says where it went");
    }
  });

  await test("a bulk request the server rejects fails every id, not silently none", async () => {
    const api = makeUserApi({
      getUsers: seedUsers() as unknown as Array<Record<string, unknown>>,
      status: 500,
      body: { message: "nope" },
    });
    const manager = new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: api.impl });

    const proposal = await manager.proposeBulk(["11111111-1111-4111-8111-111111111001", "11111111-1111-4111-8111-111111111002"], "enable");
    const result = await manager.confirm(proposal.ok ? proposal.change.token : "");
    assertEqual(result.ok, true, "the call itself completed");
    if (result.ok) {
      assertEqual(result.applied.length, 0, "nothing applied");
      assertEqual(result.failed.length, 2, "and both ids are reported as failed");
    }

    const bare = makeUserApi({
      getUsers: seedUsers() as unknown as Array<Record<string, unknown>>,
      body: { ok: true },
    });
    const bareManager = new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: bare.impl });
    const bareProposal = await bareManager.proposeBulk(["11111111-1111-4111-8111-111111111001"], "enable");
    const bareResult = await bareManager.confirm(bareProposal.ok ? bareProposal.change.token : "");
    if (bareResult.ok) {
      assertEqual(bareResult.applied.join(","), "11111111-1111-4111-8111-111111111001", "a 2xx with no accounting means all of them");
    }
  });

  await test("a live single edit or delete reports its own failure", async () => {
    const failing = makeUserApi({
      getUsers: seedUsers() as unknown as Array<Record<string, unknown>>,
      status: 409,
      body: { message: "locked" },
    });
    const manager = new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: failing.impl });

    const edit = await manager.proposeEdit("11111111-1111-4111-8111-111111111001", { firstName: "نام" });
    const editResult = await manager.confirm(edit.ok ? edit.change.token : "");
    if (editResult.ok) {
      assertEqual(editResult.applied.length, 0, "the edit did not apply");
      assertEqual(editResult.failed[0]?.reason, "locked", "with the reason");
    }

    const del = await manager.proposeDelete("11111111-1111-4111-8111-111111111001");
    const delResult = await manager.confirm(del.ok ? del.change.token : "");
    if (delResult.ok) assertEqual(delResult.failed[0]?.id, "11111111-1111-4111-8111-111111111001", "nor did the delete");

    const working = makeUserApi({
      getUsers: seedUsers() as unknown as Array<Record<string, unknown>>,
      body: { id: "11111111-1111-4111-8111-111111111001" },
    });
    const okManager = new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: working.impl });
    const okDelete = await okManager.proposeDelete("11111111-1111-4111-8111-111111111001");
    const okResult = await okManager.confirm(okDelete.ok ? okDelete.change.token : "");
    if (okResult.ok) assertEqual(okResult.applied.join(","), "11111111-1111-4111-8111-111111111001", "a 2xx delete applies");
    assertEqual(
      working.calls.some((call) => call.method === "DELETE"),
      true,
      "sent as DELETE",
    );

    const okEdit = makeUserApi({
      getUsers: seedUsers() as unknown as Array<Record<string, unknown>>,
      body: { id: "11111111-1111-4111-8111-111111111001" },
    });
    const okEditManager = new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: okEdit.impl });
    const okEditProposal = await okEditManager.proposeEdit("11111111-1111-4111-8111-111111111001", { lastName: "نام" });
    const okEditResult = await okEditManager.confirm(okEditProposal.ok ? okEditProposal.change.token : "");
    if (okEditResult.ok) assertEqual(okEditResult.applied.join(","), "11111111-1111-4111-8111-111111111001", "a 2xx edit applies");
  });

  await test("a live get reads the single-user path", async () => {
    const api = makeUserApi({ body: { users: [{ id: "11111111-1111-4111-8111-111111111001", firstName: "مریم" }] } });
    const manager = new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: api.impl });
    assertEqual((await manager.get("11111111-1111-4111-8111-111111111001"))?.id, "11111111-1111-4111-8111-111111111001", "found");
    assertEqual(api.mutating(), 0, "reading sends nothing that changes data");
    assertEqual(api.calls[0]?.url, "https://api.test/users/11111111-1111-4111-8111-111111111001", "on the per-user path");

    const empty = makeUserApi({ body: { users: [] } });
    assertEqual(
      await new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: empty.impl }).get("11111111-1111-4111-8111-111111119998"),
      null,
      "an empty result is null",
    );
  });

  await test("missing arguments are treated as empty, not as a crash", async () => {
    const manager = new UserManager();

    // A model or a webhook can hand us undefined where a string belongs. Both
    // of these must degrade to "no filter" rather than throw.
    assertEqual((await manager.search(undefined as unknown as string)).users.length, 3, "search(undefined) lists everyone");
    const none = await manager.proposeBulk(undefined as unknown as string[], "disable");
    assertEqual(!none.ok && none.code, "empty-list", "proposeBulk(undefined) is an empty list");

    const onlyBlank = await manager.proposeBulk(["", "   "], "disable");
    assertEqual(!onlyBlank.ok && onlyBlank.code, "empty-list", "and so is a list of blanks");

    assertEqual(manager.pendingChange("never-issued"), null, "an unknown token has no pending change");
  });

  await test("an edit or delete for a user who vanished mid-flight is reported", async () => {
    const manager = new UserManager();

    // Propose both, then let the bulk one land first — the single edit and
    // delete are now aimed at a row that is no longer there.
    const edit = await manager.proposeEdit("11111111-1111-4111-8111-111111111002", { firstName: "رضا" });
    const del = await manager.proposeDelete("11111111-1111-4111-8111-111111111003");
    const bulk = await manager.proposeBulk(["11111111-1111-4111-8111-111111111002", "11111111-1111-4111-8111-111111111003"], "delete");
    await manager.confirm(bulk.ok ? bulk.change.token : "");

    const editResult = await manager.confirm(edit.ok ? edit.change.token : "");
    if (editResult.ok) {
      assertEqual(editResult.applied.length, 0, "the stale edit applied nothing");
      assertEqual(editResult.failed[0]?.reason, "not-found", "and said why");
    }

    const delResult = await manager.confirm(del.ok ? del.change.token : "");
    if (delResult.ok) {
      assertEqual(delResult.applied.length, 0, "nor did the stale delete");
      assertEqual(delResult.failed[0]?.id, "11111111-1111-4111-8111-111111111003", "for the right id");
    }
    assertEqual((await manager.list()).users.length, 1, "only 11111111-1111-4111-8111-111111111001 is left");
  });

  await test("a live response is parsed strictly, and a bad one is not trusted", async () => {
    // An object with none of the known list keys is not a user list.
    const odd = makeUserApi({ body: { foo: "bar" } });
    const oddResult = await new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: odd.impl }).list();
    assertEqual(oddResult.users.length, 0, "no users invented from an unrelated object");
    assertEqual(oddResult.error, "unparsable response", "and it is called unparsable");

    // A non-Error thrown from fetch must not escape as a crash.
    const weird = (async () => {
      throw "just a string";
    }) as unknown as typeof fetch;
    const weirdResult = await new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: weird }).list();
    assertEqual(weirdResult.error, "just a string", "a string throw is stringified, not swallowed");

    // Bulk accounting: `applied` present but no `failed` key at all.
    const noFailed = makeUserApi({
      getUsers: seedUsers() as unknown as Array<Record<string, unknown>>,
      body: { applied: ["11111111-1111-4111-8111-111111111001", "11111111-1111-4111-8111-111111111002"] },
    });
    const noFailedManager = new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: noFailed.impl });
    const noFailedProposal = await noFailedManager.proposeBulk(["11111111-1111-4111-8111-111111111001", "11111111-1111-4111-8111-111111111002"], "disable");
    const noFailedResult = await noFailedManager.confirm(noFailedProposal.ok ? noFailedProposal.change.token : "");
    if (noFailedResult.ok) {
      assertEqual(noFailedResult.applied.length, 2, "both applied");
      assertEqual(noFailedResult.failed.length, 0, "and a missing failed key means none");
    }

    // A `failed` list containing a null and an entry with no fields at all.
    const ragged = makeUserApi({
      getUsers: seedUsers() as unknown as Array<Record<string, unknown>>,
      body: { applied: [], failed: [null, {}] },
    });
    const raggedManager = new UserManager({ baseUrl: "https://api.test", credentials: TEST_USER_CREDENTIALS, fetchImpl: ragged.impl });
    const raggedProposal = await raggedManager.proposeBulk(["11111111-1111-4111-8111-111111111001"], "disable");
    const raggedResult = await raggedManager.confirm(raggedProposal.ok ? raggedProposal.change.token : "");
    if (raggedResult.ok) {
      assertEqual(raggedResult.failed.length, 2, "both ragged entries are reported");
      assertEqual(raggedResult.failed[0]?.id, "", "a null entry gets an empty id");
      assertEqual(raggedResult.failed[1]?.reason, "failed", "and a bare object a default reason");
    }
  });

  await test("a change against a store that lost the user reports it, not a silent pass", async () => {
    const manager = new UserManager();
    const proposal = await manager.proposeBulk(["11111111-1111-4111-8111-111111111001", "11111111-1111-4111-8111-111111111002"], "delete");
    const token = proposal.ok ? proposal.change.token : "";

    // Delete one behind the manager's back, the way a second process would.
    const sneak = await manager.proposeDelete("11111111-1111-4111-8111-111111111001");
    await manager.confirm(sneak.ok ? sneak.change.token : "");

    const result = await manager.confirm(token);
    assertEqual(result.ok, true, "the change completed");
    if (result.ok) {
      assertEqual(result.applied.join(","), "11111111-1111-4111-8111-111111111002", "only the one still there was applied");
      assertEqual(result.failed[0]?.id, "11111111-1111-4111-8111-111111111001", "and the missing one is reported");
      assertEqual(result.sent, true, "it did go somewhere");
      assertEqual(result.mode, "dummy", "the dummy store");
    }

    // 11111111-1111-4111-8111-111111111001 and 11111111-1111-4111-8111-111111111002 are gone now; the last one leaves through an edit and
    // then a delete, which also covers the single-user paths against the store.
    const singleEdit = await manager.proposeEdit("11111111-1111-4111-8111-111111111003", { firstName: "رضا" });
    assertEqual((await manager.confirm(singleEdit.ok ? singleEdit.change.token : "")).ok, true, "edit applied");
    assertEqual((await manager.get("11111111-1111-4111-8111-111111111003"))?.firstName, "رضا", "and took effect");

    const singleDelete = await manager.proposeDelete("11111111-1111-4111-8111-111111111003");
    assertEqual((await manager.confirm(singleDelete.ok ? singleDelete.change.token : "")).ok, true, "delete applied");
    assertEqual((await manager.list()).users.length, 0, "the store can be emptied");
  });

  await test("the capability list is real, unique, and honest about confirmation", () => {
    const manager = new UserManager();
    assertEqual(manager.capabilities(), CAPABILITIES, "the class exposes the same list");

    const ids = CAPABILITIES.map((capability) => capability.id);
    assertEqual(new Set(ids).size, ids.length, "no duplicate ids");

    for (const id of MUTATING_IDS) {
      assert(findCapability(id)?.needsConfirm === true, `${id} needs confirmation`);
    }
    for (const id of ["search", "view", "list", "confirm"]) {
      assert(findCapability(id)?.needsConfirm === false, `${id} is a read`);
    }
    assertEqual(findCapability("nope"), undefined, "an unknown id is undefined");
    assertEqual(confirmRequiredIds().sort().join(","), MUTATING_IDS.slice().sort().join(","), "the mutating set matches");
  });

  await test("the user-facing capability answer is concise while the system prompt retains exact details", () => {
    for (const locale of ["fa", "en"] as const) {
      const text = capabilitiesText(locale);
      assert(text.length < 300, `${locale}: answer stays brief`);
      assert(text.includes(locale === "fa" ? "تأیید" : "confirmation"), `${locale}: still explains the confirmation boundary`);

      const block = capabilitiesPromptBlock(locale);
      for (const capability of CAPABILITIES) {
        assert(block.includes(capability.title[locale]), `${locale}: detailed system prompt retains ${capability.id}`);
      }
      assert(block.includes(String(MUTATING_IDS.length)), `${locale}: prompt counts the mutating ones`);
    }
    assertEqual(capabilityAnswer("fa"), capabilitiesText("fa"), "the answer is the short summary");
    assertEqual(capabilityAnswer(), capabilitiesText("fa"), "and it defaults to Persian");
  });

  await test("«چه کارهایی بلدی؟» is recognised and answered from the list", async () => {
    for (const question of [
      "چه کارهایی بلدی؟",
      "چیکارا بلدی",
      "چه قابلیت‌هایی داری",
      "what can you do?",
      "what are your capabilities",
    ]) {
      assertEqual(isCapabilityQuestion(question), true, `"${question}" is a capability question`);
    }
    for (const other of ["امروز چندمه؟", "سلام", "حال تو چطوره", "what is the time"]) {
      assertEqual(isCapabilityQuestion(other), false, `"${other}" is not`);
    }

    const result = await handleChat({ message: "چه کارهایی بلدی؟", sessionId: "cap-1", locale: "fa" });
    assertEqual(result.layer, "users", "answered by the users layer");
    assertEqual(result.model, null, "without asking a model");
    assert(result.reply.includes("کاربران"), "the concise answer summarizes account management");
    assert(result.reply.includes("تأیید"), "and retains the confirmation promise");
    assert(result.reply.length < 500, "the answer does not dump every operation");
  });

  await test("the system prompt tells the model what it may claim", async () => {
    const { systemPrompt } = await import("@/lib/bot/prompt");
    for (const locale of ["fa", "en"] as const) {
      const prompt = systemPrompt(locale, "الان ۱۴۰۵ است");
      assert(prompt.includes(locale === "fa" ? "حساب‌های کاربری" : "user-account"), `${locale}: mentions user management`);
      assert(
        prompt.includes(locale === "fa" ? "مستقیماً به مدل وصل نیست" : "NOT directly connected"),
        `${locale}: states the model is not an admin integration`,
      );
    }
  });

  await test("long answers are cut at a sentence, not mid-word", () => {
    const long = `${"این یک جملهٔ کامل است. ".repeat(60)}پایان`;
    const cut = truncateAtSentence(long, 300);
    assert(cut.length <= 301, `length ${cut.length} within limit`);
    assert(/[.!?؟…]$/.test(cut), "ends on a sentence terminator, not mid-word");
    assert(cut.includes("این یک جملهٔ کامل است."), "kept whole sentences");
  });

  await test("Telegram account creation is intercepted before login and model calls", async () => {
    for (const text of ["کاربر جدید بساز", "نمیخوام لاگین کنم کاربر جدید بساز", "شماره تماس : 09000000000"]) {
      const before = calls.length;
      const outcome = await handleTelegramUpdate(telegramUpdate({ text }));
      assertEqual(outcome.status, "users-auth-required", "account changes require authenticated session");
      const outgoing = calls.slice(before);
      assert(!outgoing.some(call => call.url.includes("openrouter") || call.url.includes("/auth/otp/")), "no model or OTP call");
    }
  });

  await test("Telegram formatting preserves identifiers and uses native entities", async () => {
    const { testTelegramFormatting } = await import("./telegram-format-test");
    testTelegramFormatting();
    const { sendMessage } = await import("@/lib/telegram/api");
    await sendMessage({ chatId: 777, text: "**👥 کاربران**\nصفحه: 12" });
    const request = calls.filter(call => call.url.endsWith("/sendMessage")).at(-1)!;
    const payload = request.body as { text: string; entities?: Array<{ type: string }>; parse_mode?: string };
    assert(payload.text.includes("۱۲"), "Persian display digits");
    assert(payload.entities?.some(entity => entity.type === "bold"), "native Telegram bold entity");
    assertEqual(payload.parse_mode, undefined, "external text is not parsed as HTML/Markdown");
  });

  await test("Telegram password-message deletion uses message ids without copying secrets", async () => {
    const { deleteMessage } = await import("@/lib/telegram/api");
    await deleteMessage(777, 42);
    const request = calls.filter(call => call.url.endsWith("/deleteMessage")).at(-1)!;
    assertEqual(JSON.stringify(request.body), JSON.stringify({ chat_id: 777, message_id: 42 }), "only routing ids sent for deletion");
  });

  await test("All email admin API contracts and secure confirmed workflows", async () => {
    const { testEmailAdmin } = await import("./email-admin-test");
    await testEmailAdmin();
  });

  await test("Telegram email management is private, authenticated, and keeps address input out of the model", async () => {
    const before = calls.length;
    const result = await handleTelegramUpdate(telegramUpdate({ text: "گزارش ایمیل را نشان بده" }));
    assertEqual(result.status, "email-auth-required", "email admin requires login");
    assert(!calls.slice(before).some(call => call.url.includes("openrouter") || call.url.includes("/api/v1/admin/email")), "no model or email API call without authentication");
    const group = await handleTelegramUpdate(telegramUpdate({ text: "گزارش ایمیل را نشان بده", chat: { id: -100200300, type: "group" } }));
    assertEqual(group.status, "email-private-only", "email management is private-only");
    const address = await handleTelegramUpdate(telegramUpdate({ text: "ایمیل به private@example.test بفرست" }));
    assertEqual(address.status, "email-auth-required", "recipient addresses are intercepted before the model");
    assert(!calls.slice(before).some(call => call.url.includes("openrouter") || call.url.includes("/api/v1/admin/email")), "email addresses never reach model or API before authorized confirmation");
  });

  await test("All payment admin API contracts and secure confirmed workflows", async () => {
    const { testPaymentAdmin } = await import("./payment-admin-test");
    await testPaymentAdmin();
  });

  await test("Telegram payment management is private and authenticated", async () => {
    const before = calls.length;
    const result = await handleTelegramUpdate(telegramUpdate({ text: "آمار پرداخت را نشان بده" }));
    assertEqual(result.status, "payment-auth-required", "payment requires login");
    assert(!calls.slice(before).some(call => call.url.includes("openrouter") || call.url.includes("/admin/payment")), "no model or payment request without authentication");
    const grouped = await handleTelegramUpdate(telegramUpdate({ text: "آمار پرداخت را نشان بده", chat: { id: -100200300, type: "group" } }));
    assertEqual(grouped.status, "payment-private-only", "no payment management in groups");
  });

  await test("Settings API contracts, explanations and secure conversational operations", async () => {
    const { testSettingsAdmin } = await import("./settings-admin-test");
    await testSettingsAdmin();
  });

  await test("SMS API contracts and secure confirmed conversational operations", async () => {
    const { testSmsAdmin } = await import("./sms-admin-test");
    await testSmsAdmin();
  });

  await test("social-links API contract and confirmed conversational operations", async () => {
    const { testSocialLinks } = await import("./social-links-test");
    await testSocialLinks();
  });

  await test("Telegram settings management is private and authenticated", async () => {
    const before = calls.length;
    const result = await handleTelegramUpdate(telegramUpdate({ text: "تنظیمات را نشان بده" }));
    assertEqual(result.status, "settings-auth-required", "settings require login");
    assert(!calls.slice(before).some(call => call.url.includes("openrouter") || call.url.includes("/admin/settings")), "no model or settings request without authentication");
    const grouped = await handleTelegramUpdate(telegramUpdate({ text: "تنظیمات را نشان بده", chat: { id: -100200300, type: "group" } }));
    assertEqual(grouped.status, "settings-private-only", "settings never exposed in groups");
  });

  await test("Telegram social-link management is private and authenticated", async () => {
    const before = calls.length;
    const result = await handleTelegramUpdate(telegramUpdate({ text: "لینک‌های اجتماعی را نشان بده" }));
    assertEqual(result.status, "social-auth-required", "no access without login");
    assert(!calls.slice(before).some(call => call.url.includes("openrouter") || call.url.includes("/social-links")), "no model or external API without authentication");
    const grouped = await handleTelegramUpdate(telegramUpdate({ text: "لینک‌های اجتماعی را نشان بده", chat: { id: -100200300, type: "group" } }));
    assertEqual(grouped.status, "social-private-only", "no administrative data in groups");
  });

  await test("working-hours contract and confirmed conversational operations", async () => {
    const { testWorkingHours } = await import("./working-hours-test");
    await testWorkingHours();
  });

  await test("Telegram working-hours requests require a private authenticated session", async () => {
    const before = calls.length;
    const result = await handleTelegramUpdate(telegramUpdate({ text: "ساعات کاری را نشان بده" }));
    assertEqual(result.status, "hours-auth-required", "working-hours route precedes model and OTP handling");
    assert(!calls.slice(before).some(call => call.url.includes("openrouter") || call.url.includes("/working-hours")), "no model/API request without authentication");
    const grouped = await handleTelegramUpdate(telegramUpdate({ text: "ساعات کاری را نشان بده", chat: { id: -100200300, type: "group" } }));
    assertEqual(grouped.status, "hours-private-only", "no working-hours account data in groups");
  });

  await test("beauty-clinic rules API contract and conversational flows", async () => {
    const { testRulesContract } = await import("./rules-contract-test");
    await testRulesContract();
  });

  await test("beauty-clinic users API contract and Telegram confirmations", async () => {
    const { testUsersContract } = await import("./users-contract-test");
    await testUsersContract();
  });

  await test("negative login requests never start OTP", async () => {
    const { isOtpLoginIntent } = await import("@/lib/auth/telegram-login");
    for (const text of ["نمیخوام لاگین کنم کاربر جدید بساز", "نمی‌خواهم وارد حساب شوم", "I don't want to log in"]) {
      assertEqual(isOtpLoginIntent(text), false, "negated login rejected");
    }
    assertEqual(isOtpLoginIntent("میخوام لاگین کنم"), true, "positive login still works");
  });

  await test("user operations are recognized without confusing login", async () => {
    const { isUserManagementMessage } = await import("@/lib/telegram/users");
    for (const text of ["کاربر جدید بساز", "نمیخوام لاگین کنم کاربر جدید بساز", "/users list", "create a new user"]) {
      assertEqual(isUserManagementMessage(text), true, "user request recognized");
    }
    assertEqual(isUserManagementMessage("میخوام لاگین کنم"), false, "login separate");
    assertEqual(isUserManagementMessage("09000000000"), false, "bare phone remains OTP input outside a user flow");
  });

  await test("provider analysis envelopes are rejected", async () => {
    const { containsAnalysis } = await import("@/lib/openrouter/client");
    assert(containsAnalysis("1.  **Analyze the Request:**\nprivate analysis"), "numbered analysis caught");
    assert(containsAnalysis("<think>private analysis</think>hello"), "think tags caught");
    assertEqual(containsAnalysis("سلام! لطفاً درخواستت را روشن‌تر بگو."), false, "ordinary response accepted");
  });

  console.log(`\n${failures.length === 0 ? "🎉" : "⚠️"}  ${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  • ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
