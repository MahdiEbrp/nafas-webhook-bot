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
process.env.TELEGRAM_ALLOWED_CHAT_IDS = "777";

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
