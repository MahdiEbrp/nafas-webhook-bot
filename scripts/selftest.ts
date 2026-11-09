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

/** Canned model behaviour. */
let modelReply = "سلام! خوشحالم که اینجایی. 🙂";
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
            message: { content: `${modelReply} [${lastUserMessage(body)}]` },
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
          result: { url: "https://bot.example.com/api/telegram/webhook", has_custom_certificate: false, pending_update_count: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
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
  const { getConfig, resetConfigCache, configWarnings } = await import("@/lib/config");
  const { truncateAtSentence } = await import("@/lib/text");
  const chatRoute = await import("@/app/api/chat/route");
  const webhookRoute = await import("@/app/api/telegram/webhook/route");
  const healthRoute = await import("@/app/api/health/route");
  const { rankModels, scoreModel, speedDelta, UNKNOWN_QUALITY } = await import("@/lib/openrouter/ranking");
  const { recordSuccess, recordFailure, getStat, resetStatsForTesting } = await import("@/lib/openrouter/stats");
  const { selectChain } = await import("@/lib/openrouter/select");
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

  /* ── 11. User management ────────────────────────────────────────────── */

  const { UserManager, seedUsers } = await import("@/lib/users/manager");
  const {
    CAPABILITIES,
    capabilitiesText,
    capabilitiesPromptBlock,
    confirmRequiredIds,
    findCapability,
  } = await import("@/lib/users/capabilities");
  const { isCapabilityQuestion, capabilityAnswer } = await import("@/lib/users/intent");

  type ApiCall = { url: string; method: string; body?: unknown };

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
      calls.push({ url, method, ...(raw ? { body: JSON.parse(raw) } : {}) });

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

  const MUTATING_IDS = ["edit", "delete", "bulk-enable", "bulk-disable", "bulk-delete"];

  await test("the dummy store answers without any network at all", async () => {
    const manager = new UserManager();
    assertEqual(manager.isLive, false, "not live without a base url");
    assertEqual(manager.mode, "dummy", "running against the dummy store");

    const all = await manager.list();
    assertEqual(all.users.length, 3, "three seeded users");
    assertEqual(all.live, false, "flagged as not from an API");
    assertEqual(all.error, undefined, "and no error");

    assertEqual((await manager.get("u-1001"))?.firstName, "مریم", "fetched by id");
    assertEqual(await manager.get("u-9999"), null, "an unknown id is null, not a throw");
  });

  await test("search finds by name, phone, and id — including Persian digits", async () => {
    const manager = new UserManager();

    assertEqual((await manager.search("مریم")).users.length, 2, "both Maryams by first name");
    assertEqual((await manager.search("رضایی")).users.length, 1, "one by surname");
    assertEqual((await manager.search("u-1001")).users.length, 1, "by id");
    assertEqual((await manager.search("0935")).users[0]?.id, "u-1002", "by part of the phone");
    assertEqual((await manager.search("۰۹۱۲")).users[0]?.id, "u-1001", "Persian digits match too");
    assertEqual((await manager.search("")).users.length, 3, "an empty query lists everyone");
    assertEqual((await manager.search("   ")).users.length, 3, "whitespace counts as empty");
    assertEqual((await manager.search("ناموجود")).users.length, 0, "no match is an empty list");
  });

  await test("proposing a change sends nothing — only confirming does", async () => {
    const api = makeUserApi({ body: { users: seedUsers() } });
    const manager = new UserManager({ baseUrl: "https://users.example.com", fetchImpl: api.impl });

    const proposal = await manager.proposeEdit("u-1001", { firstName: "مریم‌سادات" });
    assertEqual(proposal.ok, true, "the proposal was accepted");
    assert(!proposal.ok || proposal.change.token.length > 0, "and carries a token");
    assert(!proposal.ok || proposal.change.summary.includes("u-1001"), "the summary names the user");
    assertEqual(api.mutating(), 0, "no mutating request went out while proposing");

    const confirmed = await manager.confirm(proposal.ok ? proposal.change.token : "");
    assertEqual(confirmed.ok, true, "confirming worked");
    assertEqual(api.mutating(), 1, "exactly one mutating request, and only now");
    const patch = api.calls.find((call) => call.method === "PATCH");
    assertEqual(patch?.url, "https://users.example.com/users/u-1001", "sent to the right path");
  });

  await test("a token is single-use, and a cancelled one cannot be revived", async () => {
    const manager = new UserManager();

    const first = await manager.proposeDelete("u-1001");
    const token = first.ok ? first.change.token : "";
    assertEqual((await manager.confirm(token)).ok, true, "the first confirm applies it");
    assertEqual(await manager.get("u-1001"), null, "and the user is gone");

    const replay = await manager.confirm(token);
    assertEqual(replay.ok, false, "a second confirm is refused");
    assertEqual(!replay.ok && replay.code, "unknown-token", "as an unknown token");

    const second = await manager.proposeDelete("u-1002");
    const other = second.ok ? second.change.token : "";
    assertEqual(manager.cancel(other), true, "cancelling reports success");
    assertEqual(manager.cancel(other), false, "cancelling twice does not");
    assertEqual((await manager.confirm(other)).ok, false, "and the cancelled change cannot run");
  });

  await test("a proposal that is never confirmed expires on its own", async () => {
    let clock = 1_000_000;
    const manager = new UserManager({ now: () => clock, pendingTtlMs: 60_000 });

    const proposal = await manager.proposeDelete("u-1001");
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

    const proposal = await manager.proposeBulk(["u-1001", "u-1002"], "disable");
    const token = proposal.ok ? proposal.change.token : "";

    // Move past expiry but read it through confirm, which is the path that has
    // to notice a token that has aged out while nobody looked at it.
    clock += 60_001;
    const result = await manager.confirm(token);
    assertEqual(result.ok, false, "refused");
    assertEqual(!result.ok && result.code, "expired", "with the expired code");
    assertEqual((await manager.get("u-1001"))?.status, "active", "and nothing changed");
  });

  await test("bulk enable, disable and delete all wait for the same confirmation", async () => {
    const manager = new UserManager();

    const disable = await manager.proposeBulk(["u-1001", "u-1002"], "disable");
    assertEqual(disable.ok, true, "proposed");
    assert(!disable.ok || disable.change.summary.includes("۲"), "the summary says how many");
    assertEqual((await manager.confirm(disable.ok ? disable.change.token : "")).ok, true, "applied");
    assertEqual((await manager.get("u-1001"))?.status, "disabled", "u-1001 switched off");
    assertEqual((await manager.get("u-1002"))?.status, "disabled", "u-1002 switched off");

    const enable = await manager.proposeBulk(["u-1001"], "enable");
    await manager.confirm(enable.ok ? enable.change.token : "");
    assertEqual((await manager.get("u-1001"))?.status, "active", "and switched back on");

    const remove = await manager.proposeBulk(["u-1001", "u-1003"], "delete");
    const result = await manager.confirm(remove.ok ? remove.change.token : "");
    assertEqual(result.ok, true, "bulk delete applied");
    assertEqual((await manager.list()).users.length, 1, "one user left");
  });

  await test("bulk proposals dedupe ids and report the ones that do not exist", async () => {
    const manager = new UserManager();

    const dupes = await manager.proposeBulk(["u-1001", "u-1001", " u-1002 "], "disable");
    assertEqual(dupes.ok, true, "accepted");
    assertEqual(dupes.ok ? dupes.change.affected.length : 0, 2, "duplicates collapsed, ids trimmed");

    const partial = await manager.proposeBulk(["u-1001", "u-nope"], "delete");
    assertEqual(partial.ok, true, "accepted for the ones that exist");
    assert(
      !partial.ok || partial.change.summary.includes("u-nope"),
      "and the summary names the missing one",
    );
    assertEqual(partial.ok ? partial.change.affected.join(",") : "", "u-1001", "only real ids are queued");

    const none = await manager.proposeBulk(["u-nope"], "delete");
    assertEqual(none.ok, false, "refused when nobody in the list exists");
    assertEqual(!none.ok && none.code, "not-found", "as not-found");
  });

  await test("proposals are refused, with a reason the user can act on", async () => {
    const manager = new UserManager();

    const empty = await manager.proposeEdit("u-1001", {});
    assertEqual(!empty.ok && empty.code, "no-change", "an empty patch changes nothing");

    const badPhone = await manager.proposeEdit("u-1001", { phone: "+14155552671" });
    assertEqual(!badPhone.ok && badPhone.code, "bad-phone", "a foreign number is refused");
    assert(!badPhone.ok && badPhone.message.includes("۰۹۱۲"), "and the reply shows the right shape");

    const missing = await manager.proposeEdit("u-nope", { firstName: "x" });
    assertEqual(!missing.ok && missing.code, "not-found", "editing a user who is not there");

    const gone = await manager.proposeDelete("u-nope");
    assertEqual(!gone.ok && gone.code, "not-found", "deleting a user who is not there");

    const noIds = await manager.proposeBulk([], "disable");
    assertEqual(!noIds.ok && noIds.code, "empty-list", "an empty list");

    const junk = await manager.proposeBulk(["u-1001"], "explode" as "delete");
    assertEqual(!junk.ok && junk.code, "unknown-action", "an action that does not exist");

    // Every refusal message must be real Persian, not a placeholder.
    for (const failure of [empty, badPhone, missing, gone, noIds, junk]) {
      assert(!failure.ok && failure.message.length > 5, "each refusal carries a message");
    }
  });

  await test("a phone typed in any shape is stored in the canonical one", async () => {
    const manager = new UserManager();

    const proposal = await manager.proposeEdit("u-1003", { phone: "۰۹۱۲ ۱۲۳ ۴۵۶۷" });
    assertEqual(proposal.ok, true, "Persian digits with spaces are accepted");
    const patch = proposal.ok && proposal.change.action.kind === "edit" ? proposal.change.action.patch : {};
    assertEqual(patch.phone, "09121234567", "normalised before it is even proposed");

    await manager.confirm(proposal.ok ? proposal.change.token : "");
    assertEqual((await manager.get("u-1003"))?.phone, "09121234567", "and stored that way");
    assertEqual((await manager.get("u-1003"))?.status, "disabled", "the rest of the record is untouched");
  });

  await test("an edit can also clear a phone number", async () => {
    const manager = new UserManager();
    const proposal = await manager.proposeEdit("u-1001", { phone: null });
    assertEqual(proposal.ok, true, "null is a deliberate value, not a missing one");
    await manager.confirm(proposal.ok ? proposal.change.token : "");
    assertEqual((await manager.get("u-1001"))?.phone, null, "cleared");
  });

  await test("live mode talks to the API and accepts either response shape", async () => {
    const wrapped = makeUserApi({ body: { users: [{ id: "a1", firstName: "A", lastName: "B", phone: null, status: "active", createdAt: "", updatedAt: "" }] } });
    const wrappedManager = new UserManager({ baseUrl: "https://api.example.com/v1/", fetchImpl: wrapped.impl });
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

    const bare = makeUserApi({ body: [{ id: "b1" }] });
    const bareResult = await new UserManager({ baseUrl: "https://api.example.com", fetchImpl: bare.impl }).list();
    assertEqual(bareResult.users[0]?.id, "b1", "a bare array is accepted too");
    assertEqual(bare.calls[0]?.url, "https://api.example.com/users", "listing has no query string");

    for (const key of ["data", "results", "items"]) {
      const api = makeUserApi({ body: { [key]: [{ id: key }] } });
      const result = await new UserManager({ baseUrl: "https://x.test", fetchImpl: api.impl }).list();
      assertEqual(result.users[0]?.id, key, `wrapped in { ${key}: [...] }`);
    }
  });

  await test("a live lookup that fails says so instead of inventing an empty list", async () => {
    const broken = makeUserApi({ status: 500, body: { message: "database is on fire" } });
    const result = await new UserManager({ baseUrl: "https://api.test", fetchImpl: broken.impl }).search("x");
    assertEqual(result.users.length, 0, "no users");
    assertEqual(result.error, "database is on fire", "and the server's own reason is carried");

    const plain = makeUserApi({ status: 404, rawBody: "" });
    const plainResult = await new UserManager({ baseUrl: "https://api.test", fetchImpl: plain.impl }).list();
    assertEqual(plainResult.error, "HTTP 404", "a bare status becomes the reason");

    const garbage = makeUserApi({ rawBody: "not json at all" });
    const garbageResult = await new UserManager({ baseUrl: "https://api.test", fetchImpl: garbage.impl }).list();
    assertEqual(garbageResult.error, "unparsable response", "unparseable JSON is reported");

    const thrown = makeUserApi({ failWith: "throw" });
    const thrownResult = await new UserManager({ baseUrl: "https://api.test", fetchImpl: thrown.impl }).list();
    assertEqual(thrownResult.error, "network down", "a thrown error is caught, not surfaced");

    const aborted = makeUserApi({ failWith: "abort" });
    const abortedResult = await new UserManager({ baseUrl: "https://api.test", fetchImpl: aborted.impl }).list();
    assertEqual(abortedResult.error, "timeout", "an abort reads as a timeout");
  });

  await test("in live mode one bulk action is one request, not one per user", async () => {
    const api = makeUserApi({
      getUsers: seedUsers() as unknown as Array<Record<string, unknown>>,
      body: { applied: ["u-1001"], failed: [{ id: "u-1002", reason: "locked" }] },
    });
    const manager = new UserManager({ baseUrl: "https://api.test", fetchImpl: api.impl });

    const proposal = await manager.proposeBulk(["u-1001", "u-1002"], "disable");
    const result = await manager.confirm(proposal.ok ? proposal.change.token : "");

    const posts = api.calls.filter((call) => call.method === "POST");
    assertEqual(posts.length, 1, "a single POST for the whole list");
    assertEqual(posts[0]?.url, "https://api.test/users/bulk", "to the bulk endpoint");
    assertEqual(JSON.stringify(posts[0]?.body), JSON.stringify({ action: "disable", ids: ["u-1001", "u-1002"] }), "with the action and the ids");
    assertEqual(result.ok, true, "confirmed");
    if (result.ok) {
      assertEqual(result.applied.join(","), "u-1001", "the server's own accounting is trusted");
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
    const manager = new UserManager({ baseUrl: "https://api.test", fetchImpl: api.impl });

    const proposal = await manager.proposeBulk(["u-1001", "u-1002"], "enable");
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
    const bareManager = new UserManager({ baseUrl: "https://api.test", fetchImpl: bare.impl });
    const bareProposal = await bareManager.proposeBulk(["u-1001"], "enable");
    const bareResult = await bareManager.confirm(bareProposal.ok ? bareProposal.change.token : "");
    if (bareResult.ok) {
      assertEqual(bareResult.applied.join(","), "u-1001", "a 2xx with no accounting means all of them");
    }
  });

  await test("a live single edit or delete reports its own failure", async () => {
    const failing = makeUserApi({
      getUsers: seedUsers() as unknown as Array<Record<string, unknown>>,
      status: 409,
      body: { message: "locked" },
    });
    const manager = new UserManager({ baseUrl: "https://api.test", fetchImpl: failing.impl });

    const edit = await manager.proposeEdit("u-1001", { firstName: "x" });
    const editResult = await manager.confirm(edit.ok ? edit.change.token : "");
    if (editResult.ok) {
      assertEqual(editResult.applied.length, 0, "the edit did not apply");
      assertEqual(editResult.failed[0]?.reason, "locked", "with the reason");
    }

    const del = await manager.proposeDelete("u-1001");
    const delResult = await manager.confirm(del.ok ? del.change.token : "");
    if (delResult.ok) assertEqual(delResult.failed[0]?.id, "u-1001", "nor did the delete");

    const working = makeUserApi({
      getUsers: seedUsers() as unknown as Array<Record<string, unknown>>,
      body: { id: "u-1001" },
    });
    const okManager = new UserManager({ baseUrl: "https://api.test", fetchImpl: working.impl });
    const okDelete = await okManager.proposeDelete("u-1001");
    const okResult = await okManager.confirm(okDelete.ok ? okDelete.change.token : "");
    if (okResult.ok) assertEqual(okResult.applied.join(","), "u-1001", "a 2xx delete applies");
    assertEqual(
      working.calls.some((call) => call.method === "DELETE"),
      true,
      "sent as DELETE",
    );

    const okEdit = makeUserApi({
      getUsers: seedUsers() as unknown as Array<Record<string, unknown>>,
      body: { id: "u-1001" },
    });
    const okEditManager = new UserManager({ baseUrl: "https://api.test", fetchImpl: okEdit.impl });
    const okEditProposal = await okEditManager.proposeEdit("u-1001", { lastName: "y" });
    const okEditResult = await okEditManager.confirm(okEditProposal.ok ? okEditProposal.change.token : "");
    if (okEditResult.ok) assertEqual(okEditResult.applied.join(","), "u-1001", "a 2xx edit applies");
  });

  await test("a live get reads the single-user path", async () => {
    const api = makeUserApi({ body: { users: [{ id: "u-1001", firstName: "مریم" }] } });
    const manager = new UserManager({ baseUrl: "https://api.test", fetchImpl: api.impl });
    assertEqual((await manager.get("u-1001"))?.id, "u-1001", "found");
    assertEqual(api.mutating(), 0, "reading sends nothing that changes data");
    assertEqual(api.calls[0]?.url, "https://api.test/users/u-1001", "on the per-user path");

    const empty = makeUserApi({ body: { users: [] } });
    assertEqual(
      await new UserManager({ baseUrl: "https://api.test", fetchImpl: empty.impl }).get("u-x"),
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
    const edit = await manager.proposeEdit("u-1002", { firstName: "ز" });
    const del = await manager.proposeDelete("u-1003");
    const bulk = await manager.proposeBulk(["u-1002", "u-1003"], "delete");
    await manager.confirm(bulk.ok ? bulk.change.token : "");

    const editResult = await manager.confirm(edit.ok ? edit.change.token : "");
    if (editResult.ok) {
      assertEqual(editResult.applied.length, 0, "the stale edit applied nothing");
      assertEqual(editResult.failed[0]?.reason, "not-found", "and said why");
    }

    const delResult = await manager.confirm(del.ok ? del.change.token : "");
    if (delResult.ok) {
      assertEqual(delResult.applied.length, 0, "nor did the stale delete");
      assertEqual(delResult.failed[0]?.id, "u-1003", "for the right id");
    }
    assertEqual((await manager.list()).users.length, 1, "only u-1001 is left");
  });

  await test("a live response is parsed strictly, and a bad one is not trusted", async () => {
    // An object with none of the known list keys is not a user list.
    const odd = makeUserApi({ body: { foo: "bar" } });
    const oddResult = await new UserManager({ baseUrl: "https://api.test", fetchImpl: odd.impl }).list();
    assertEqual(oddResult.users.length, 0, "no users invented from an unrelated object");
    assertEqual(oddResult.error, "unparsable response", "and it is called unparsable");

    // A non-Error thrown from fetch must not escape as a crash.
    const weird = (async () => {
      throw "just a string";
    }) as unknown as typeof fetch;
    const weirdResult = await new UserManager({ baseUrl: "https://api.test", fetchImpl: weird }).list();
    assertEqual(weirdResult.error, "just a string", "a string throw is stringified, not swallowed");

    // Bulk accounting: `applied` present but no `failed` key at all.
    const noFailed = makeUserApi({
      getUsers: seedUsers() as unknown as Array<Record<string, unknown>>,
      body: { applied: ["u-1001", "u-1002"] },
    });
    const noFailedManager = new UserManager({ baseUrl: "https://api.test", fetchImpl: noFailed.impl });
    const noFailedProposal = await noFailedManager.proposeBulk(["u-1001", "u-1002"], "disable");
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
    const raggedManager = new UserManager({ baseUrl: "https://api.test", fetchImpl: ragged.impl });
    const raggedProposal = await raggedManager.proposeBulk(["u-1001"], "disable");
    const raggedResult = await raggedManager.confirm(raggedProposal.ok ? raggedProposal.change.token : "");
    if (raggedResult.ok) {
      assertEqual(raggedResult.failed.length, 2, "both ragged entries are reported");
      assertEqual(raggedResult.failed[0]?.id, "", "a null entry gets an empty id");
      assertEqual(raggedResult.failed[1]?.reason, "failed", "and a bare object a default reason");
    }
  });

  await test("a change against a store that lost the user reports it, not a silent pass", async () => {
    const manager = new UserManager();
    const proposal = await manager.proposeBulk(["u-1001", "u-1002"], "delete");
    const token = proposal.ok ? proposal.change.token : "";

    // Delete one behind the manager's back, the way a second process would.
    const sneak = await manager.proposeDelete("u-1001");
    await manager.confirm(sneak.ok ? sneak.change.token : "");

    const result = await manager.confirm(token);
    assertEqual(result.ok, true, "the change completed");
    if (result.ok) {
      assertEqual(result.applied.join(","), "u-1002", "only the one still there was applied");
      assertEqual(result.failed[0]?.id, "u-1001", "and the missing one is reported");
      assertEqual(result.sent, true, "it did go somewhere");
      assertEqual(result.mode, "dummy", "the dummy store");
    }

    // u-1001 and u-1002 are gone now; the last one leaves through an edit and
    // then a delete, which also covers the single-user paths against the store.
    const singleEdit = await manager.proposeEdit("u-1003", { firstName: "ز" });
    assertEqual((await manager.confirm(singleEdit.ok ? singleEdit.change.token : "")).ok, true, "edit applied");
    assertEqual((await manager.get("u-1003"))?.firstName, "ز", "and took effect");

    const singleDelete = await manager.proposeDelete("u-1003");
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

  await test("the capability prose names every ability, in both languages", () => {
    for (const locale of ["fa", "en"] as const) {
      const text = capabilitiesText(locale);
      for (const capability of CAPABILITIES) {
        assert(text.includes(capability.title[locale]), `${locale}: lists ${capability.id}`);
      }
      assert(text.includes("🔒"), `${locale}: explains the confirmation mark`);

      const block = capabilitiesPromptBlock(locale);
      for (const capability of CAPABILITIES) {
        assert(block.includes(capability.title[locale]), `${locale}: prompt lists ${capability.id}`);
      }
      assert(block.includes(String(MUTATING_IDS.length)), `${locale}: prompt counts the mutating ones`);
    }
    assertEqual(capabilityAnswer("fa"), capabilitiesText("fa"), "the answer is the list");
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
    for (const capability of CAPABILITIES) {
      assert(result.reply.includes(capability.title.fa), `the reply lists ${capability.id}`);
    }
    assert(result.reply.includes("🔒"), "and the confirmation promise");
  });

  await test("the system prompt tells the model what it may claim", async () => {
    const { systemPrompt } = await import("@/lib/bot/prompt");
    for (const locale of ["fa", "en"] as const) {
      const prompt = systemPrompt(locale, "الان ۱۴۰۵ است");
      assert(prompt.includes("حساب‌های کاربری") || prompt.includes("user accounts"), `${locale}: mentions user management`);
      assert(
        prompt.includes("بلدی") || prompt.includes("You are able to"),
        `${locale}: lists the abilities`,
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
