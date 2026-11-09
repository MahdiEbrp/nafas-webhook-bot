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
process.env.MODEL_RETRIES = "1";
process.env.MODEL_TIMEOUT_MS = "2000";
process.env.HISTORY_MESSAGES = "4";
process.env.ALLOWED_ORIGINS = "https://app.example.com";
process.env.BOT_API_KEY = "bot-key-123";
process.env.BOT_NAME = "ربات تست";
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

const FREE_MODEL_IDS = ["test/free-a:free", "test/free-b:free", "test/free-c:free"];

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
    return new Response(
      JSON.stringify({
        data: FREE_MODEL_IDS.map((id) => ({
          id,
          name: id,
          context_length: 8192,
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
  const { systemPrompt, welcomeText } = await import("@/lib/bot/prompt");
  const { resetSessionsForTesting, getMessages } = await import("@/lib/bot/session");
  const { handleTelegramUpdate } = await import("@/lib/telegram/handler");
  const { getConfig, resetConfigCache, configWarnings } = await import("@/lib/config");
  const { truncateAtSentence } = await import("@/lib/text");
  const chatRoute = await import("@/app/api/chat/route");
  const webhookRoute = await import("@/app/api/telegram/webhook/route");
  const healthRoute = await import("@/app/api/health/route");

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

  await test("GET /api/health reports config + free models", async () => {
    const response = await healthRoute.GET(new Request("http://localhost/api/health"));
    assertEqual(response.status, 200, "status");
    const payload = (await response.json()) as {
      ok: boolean;
      data: {
        bot: { name: string };
        openrouter: { configured: boolean; freeModels: { count: number; configuredChainAlive: boolean } };
        telegram: { configured: boolean; webhookUrl: string | null };
      };
    };
    assertEqual(payload.data.bot.name, "ربات تست", "bot name");
    assertEqual(payload.data.openrouter.configured, true, "openrouter configured");
    assertEqual(payload.data.openrouter.freeModels.count, 3, "free models counted");
    assertEqual(payload.data.openrouter.freeModels.configuredChainAlive, true, "configured chain is alive");
    assertEqual(payload.data.telegram.webhookUrl, "https://bot.example.com/api/telegram/webhook", "webhook url");
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
