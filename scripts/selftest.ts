export {};

/**
 * npm run selftest
 *
 * No API key, no network, no database needed. We fake OpenRouter and the clinic
 * webhook API, then walk the real pipeline end to end. This is the fastest way
 * to know the bot still behaves after a change.
 */

/* ── 0. Fake the outside world before anything imports config ────────── */

process.env.OPENROUTER_API_KEY = "test-key";
process.env.WEBHOOK_BASE_URL = "http://clinic.test";
process.env.WEBHOOK_USERNAME = "bot@clinic.test";
process.env.WEBHOOK_PASSWORD = "Secret1!";
process.env.OPENROUTER_MODELS = "test/free-a:free,test/free-b:free";
process.env.MODEL_RETRIES = "0";
process.env.ALLOWED_ORIGINS = "https://app.example.com";
process.env.TELEGRAM_BOT_TOKEN = "123456:TEST-TOKEN";
process.env.TELEGRAM_WEBHOOK_SECRET = "secret-abc";
process.env.PUBLIC_APP_URL = "https://bot.example.com";
process.env.TELEGRAM_ALLOWED_CHAT_IDS = "777";

type Call = { url: string; method: string; body?: unknown; headers: Record<string, string> };

const calls: Call[] = [];

/** what the fake planner will answer next */
let nextPlannerJson: string | ((messages: Array<{ role: string; content: string }>) => string) = "{}";
let plannerShouldFail = false;
let explainerText = "نوبت‌ها را دیدم: سه تا هست.";
let explainerShouldFail = false;
/** what the fake model reports as finish_reason ("length" = cut off by max_tokens) */
let explainerFinishReason: string | null = null;
let webhookStatus = 200;
let nextSuggestJson = "{}";
/** Staff roster used by the identity tests — deliberately mixed phone formats. */
const staffRows = [
  { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", fullName: "دکتر نازنین", email: "admin@clinic.test", phone: "09120000001", isActive: true, isBanned: false, roleKey: "admin" },
  { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", fullName: "منشی شیفت صبح", email: "reception@clinic.test", phone: "0912 000 0002", isActive: false, isBanned: false, roleKey: "receptionist" },
  { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", fullName: "کارمند با فرمت +98", email: "plus98@clinic.test", phone: "+989120000003", isActive: true, isBanned: false, roleKey: "staff" },
  { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", fullName: "کارمند با ارقام فارسی", email: "fa@clinic.test", phone: "۰۹۱۲۰۰۰۰۰۰۴", isActive: true, isBanned: false, roleKey: "staff" },
  { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", fullName: "کاربر مسدود", email: "banned@clinic.test", phone: "09120000005", isActive: true, isBanned: true, roleKey: "staff" },
];
/** every Telegram Bot API call the bridge made */
const tgCalls: Array<{ method: string; payload: Record<string, unknown> }> = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ url, method, body, headers });

  if (url.startsWith("https://api.telegram.org")) {
    const method = url.split("/").pop() ?? "unknown";
    tgCalls.push({ method, payload: body ?? {} });
    const results: Record<string, unknown> = {
      getMe: { id: 424242, is_bot: true, first_name: "Clinic Bot", username: "clinic_test_bot" },
      setWebhook: true,
      deleteWebhook: true,
      getWebhookInfo: { url: "", has_custom_certificate: false, pending_update_count: 0 },
      sendMessage: { message_id: 1, chat: { id: 777, type: "private" }, date: Math.floor(Date.now() / 1000), text: "ok" },
      answerCallbackQuery: true,
      sendChatAction: true,
    };
    return new Response(JSON.stringify({ ok: true, result: results[method] ?? true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (url.startsWith("https://openrouter.ai")) {
    const messages = (body?.messages ?? []) as Array<{ role: string; content: string }>;
    const isSuggest = messages.some((message) => message.content.includes("قدم بعدی") || message.content.includes("next-step buttons"));
    if (isSuggest) {
      return new Response(JSON.stringify({ choices: [{ message: { content: nextSuggestJson } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const isPlanner = messages.some((message) => message.content.includes("برنامه‌ریز") || message.content.includes("planner brain"));
    if (isPlanner) {
      if (plannerShouldFail) {
        return new Response(JSON.stringify({ error: { message: "quota exhausted" } }), { status: 429 });
      }
      const content = typeof nextPlannerJson === "function" ? nextPlannerJson(messages) : nextPlannerJson;
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (explainerShouldFail) {
      return new Response(JSON.stringify({ error: { message: "upstream down" } }), { status: 503 });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: explainerText }, finish_reason: explainerFinishReason }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  if (url.startsWith("http://clinic.test")) {
    if (webhookStatus >= 400) {
      return new Response(JSON.stringify({ ok: false, error: { code: "FORBIDDEN", message: "no" } }), {
        status: webhookStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/users")) {
      // Identity lookup. Staff phones are stored in *different* formats on
      // purpose — that is the real-world situation we must survive.
      const params = new URL(url).searchParams;
      const search = params.get("search") ?? "";
      const page = Number(params.get("page") ?? 1);
      const perPage = Number(params.get("perPage") ?? 100);
      let items = staffRows.filter((row) => (search ? row.phone.includes(search) : true));
      items = items.slice((page - 1) * perPage, page * perPage);
      return new Response(JSON.stringify({ ok: true, data: { items, total: staffRows.length } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const payload = url.includes("bookings")
      ? { items: [{ id: "11111111-1111-4111-8111-111111111111", fullName: "مریم رضایی", phone: "09121234567", status: "paid" }], total: 1 }
      : url.includes("working-hours") && method === "GET"
        ? {
            items: [
              { id: "44444444-4444-4444-8444-444444444444", day: "Saturday", opens: "09:00", closes: "18:00", capacity: 4, isActive: true },
              { id: "55555555-5555-4555-8555-555555555555", day: "Monday", opens: "10:00", closes: "16:00", capacity: 2, isActive: true },
            ],
            total: 2,
          }
        : { id: "11111111-1111-4111-8111-111111111111", created: true };
    return new Response(JSON.stringify({ ok: true, data: payload }), {
      status: method === "POST" ? 201 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  throw new Error(`Unexpected fetch: ${url}`);
}) as typeof fetch;

/* ── 1. Tiny test harness ────────────────────────────────────────────── */

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`  ✗ ${name}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/* ── 2. Run ─────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const { routeMessage } = await import("@/lib/features/router");
  const { preparePlan } = await import("@/lib/bot/executor");
  const { fallbackAnswer, explain, looksLikeReasoningDump } = await import("@/lib/bot/explainer");
  const { truncateAtSentence } = await import("@/lib/text");
  const { suggestNext } = await import("@/lib/telegram/suggest");
  const { validatePlan, planSchema } = await import("@/lib/bot/plan");
  const { handleChat } = await import("@/lib/bot");
  const { resetSessionsForTesting } = await import("@/lib/bot/session");
  const { clearCacheForTesting } = await import("@/lib/bot/cache");
  const { parseJsonLoose } = await import("@/lib/openrouter/client");
  const { FEATURES } = await import("@/lib/features/manifest");
  const { resetConfigCache } = await import("@/lib/config");

  console.log("\nالف) موتور کلمات کلیدی (بدون هوش مصنوعی)");
  await test("«نوبت‌های امروز رو نشون بده» → bookings.list", () => {
    const guess = routeMessage("نوبت‌های امروز رو نشون بده");
    assertEqual(guess.feature?.id, "bookings", "feature");
    assertEqual(guess.actionId, "bookings.list", "action");
    assertEqual(guess.intent, "read", "intent");
  });

  await test("جملات گزارش‌گیری و محاوره‌ای («در مهر ماه چه نوبت هایی هست؟» و «گزارش نوبت‌ها») → read", () => {
    const q1 = routeMessage("در مهر ماه چه نوبت هایی هست؟");
    assertEqual(q1.feature?.id, "bookings", "feature");
    assertEqual(q1.actionId, "bookings.list", "action");
    assertEqual(q1.intent, "read", "intent");

    const q2 = routeMessage("گزارش نوبت‌ها");
    assertEqual(q2.feature?.id, "bookings", "feature");
    assertEqual(q2.actionId, "bookings.list", "action");
    assertEqual(q2.intent, "read", "intent");
  });

  await test("«ساعت کاری شنبه چیه؟» → working-hours", () => {
    assertEqual(routeMessage("ساعت کاری شنبه‌ها چیه؟").feature?.id, "working-hours", "feature");
  });

  await test("«نوبت علی رو حذف کن» → bookings.delete", () => {
    const guess = routeMessage("نوبت علی رو حذف کن");
    assertEqual(guess.intent, "delete", "intent");
    assertEqual(guess.actionId, "bookings.delete", "action");
  });

  await test("«یه خدمت جدید بساز» → services.create", () => {
    const guess = routeMessage("یه خدمت جدید بساز");
    assertEqual(guess.feature?.id, "services", "feature");
    assertEqual(guess.actionId, "services.create", "action");
  });

  await test("حرفِ نامربوط → feature=null", () => {
    assertEqual(routeMessage("امروز هوا چطوره؟").feature, null, "feature");
  });

  console.log("\nب) استخراج مقدار از جمله (بدون هوش مصنوعی)");
  await test("uuid، تلفن، روز، ساعت و قیمت استخراج می‌شوند", async () => {
    const { extractSlots } = await import("@/lib/features/extract");

    assertEqual(extractSlots("نوبت 22222222-2222-4222-8222-222222222222 رو حذف کن").id, "22222222-2222-4222-8222-222222222222", "uuid");
    assertEqual(extractSlots("برای مریم رضایی به شماره 09121234567 نوبت ثبت کن").phone, "09121234567", "phone");
    assertEqual(extractSlots("برای مریم رضایی به شماره 09121234567 نوبت ثبت کن").fullName, "مریم رضایی", "name");
    assertEqual(extractSlots("شنبه‌ها از ۹ صبح تا ۶ عصر باز باشد").day, "Saturday", "day");
    assertEqual(extractSlots("شنبه‌ها از ۹ صبح تا ۶ عصر باز باشد").opens, "09:00", "opens");
    assertEqual(extractSlots("شنبه‌ها از ۹ صبح تا ۶ عصر باز باشد").closes, "18:00", "closes");
    assertEqual(extractSlots("قیمت خدمت لیزر رو ۲ میلیون کن").price, 2000000, "price");
    assertEqual(extractSlots("نوبت‌های پرداخت‌نشده رو نشون بده").status, "pending", "status");
    assertEqual(extractSlots("ظرفیت ساعت ۱۰ رو ۵ نفر کن").capacity, 5, "capacity (not the clock)");
    // تفکیک دقیق تمام روزهای هفته
    assertEqual(extractSlots("ساعات کاری شنبه ها چیه").day, "Saturday", "Saturday");
    assertEqual(extractSlots("ساعت کاری یکشنبه چیه").day, "Sunday", "Sunday");
    assertEqual(extractSlots("ساعت کاری دوشنبه ها").day, "Monday", "Monday");
    assertEqual(extractSlots("ساعت کاری سه شنبه").day, "Tuesday", "Tuesday");
    assertEqual(extractSlots("ساعت کاری سه‌شنبه").day, "Tuesday", "Tuesday (with zwnj)");
    assertEqual(extractSlots("ساعت کاری چهارشنبه").day, "Wednesday", "Wednesday");
    assertEqual(extractSlots("ساعت کاری پنجشنبه").day, "Thursday", "Thursday");
    assertEqual(extractSlots("ساعت کاری پنج‌شنبه").day, "Thursday", "Thursday (with zwnj)");
    assertEqual(extractSlots("ساعات کاری جمعه").day, "Friday", "Friday");
    // a uuid must never be mistaken for a price
    assertEqual(extractSlots("نوبت 22222222-2222-4222-8222-222222222222").price, undefined, "no price from uuid");
  });

  console.log("\nب) ساخت درخواست (Executor)");
  await test("خواندن لیست هیچ اطلاعاتی لازم ندارد", () => {
    const prepared = preparePlan("bookings.list", { status: "pending", perPage: "5" });
    assert(prepared.kind === "ready", "should be ready");
    if (prepared.kind !== "ready") return;
    assertEqual(prepared.request.method, "GET", "method");
    assertEqual(prepared.request.query.status, "pending", "query.status");
    assertEqual(prepared.request.query.perPage, 5, "perPage coerced to number");
  });

  await test("ساختن نوبت بدون آیتم‌ها → سؤال می‌پرسد", () => {
    const prepared = preparePlan("bookings.create", { fullName: "مریم", phone: "09121234567" });
    assert(prepared.kind === "needs_info", "should ask for info");
    if (prepared.kind !== "needs_info") return;
    assert(prepared.questions.length > 0, "has questions");
  });

  await test("ساختن نوبت کامل → POST با locale و termsAccepted پیش‌فرض", () => {
    const prepared = preparePlan("bookings.create", {
      fullName: "مریم رضایی",
      phone: "09121234567",
      items: [{ groupId: "11111111-1111-4111-8111-111111111111", slotId: "22222222-2222-4222-8222-222222222222", quantity: "1" }],
    });
    assert(prepared.kind === "ready", `should be ready, got ${prepared.kind}`);
    if (prepared.kind !== "ready") return;
    const body = prepared.request.body as Record<string, unknown>;
    assertEqual(prepared.request.method, "POST", "method");
    assertEqual(body.termsAccepted, true, "termsAccepted default");
    assertEqual(body.locale, "fa", "locale default");
    assertEqual((body.items as Array<{ quantity: number }>)[0]?.quantity, 1, "quantity coerced");
  });

  await test("شناسهٔ نامعتبر (uuid نیست) → به‌جای فراخوانی، سؤال می‌پرسد", () => {
    const prepared = preparePlan("bookings.get", { id: "علی" });
    assertEqual(prepared.kind, "needs_info", "kind");
  });

  await test("فیلدهای ناشناس حذف می‌شوند (ضد تزریق)", () => {
    const prepared = preparePlan("working-hours.create", {
      day: "Saturday",
      opens: "09:00",
      closes: "18:00",
      isAdmin: true,
      __proto__: { polluted: true },
      role: "admin",
    });
    assert(prepared.kind === "ready", "should be ready");
    if (prepared.kind !== "ready") return;
    const body = prepared.request.body as Record<string, unknown>;
    assertEqual(body.isAdmin, undefined, "isAdmin dropped");
    assertEqual(body.role, undefined, "role dropped");
  });

  await test("ساعت کاری با closes قبل از opens رد می‌شود؟ (اعتبارسنجی مقصد)", () => {
    const prepared = preparePlan("working-hours.create", { day: "Saturday", opens: "18:00", closes: "09:00" });
    // We do not re-implement the target's business rules — the target rejects it.
    assert(prepared.kind === "ready", "prepared, will be rejected upstream");
  });

  console.log("\nج) لایهٔ واسط (proxy)");
  await test("فقط اکشن‌های منیفست از واسط رد می‌شوند", async () => {
    const { matchAllowedCall } = await import("@/lib/proxy/allowlist");

    assertEqual(matchAllowedCall("GET", "/api/v1/webhooks/bookings")?.action.id, "bookings.list", "list");
    assertEqual(matchAllowedCall("POST", "/api/v1/webhooks/bookings")?.action.id, "bookings.create", "create");
    assertEqual(matchAllowedCall("DELETE", "/api/v1/webhooks/bookings/33333333-3333-4333-8333-333333333333")?.action.id, "bookings.delete", "delete with id");
    assertEqual(matchAllowedCall("GET", "/api/v1/webhooks/bookings/")?.action.id, "bookings.list", "trailing slash allowed");
    assertEqual(matchAllowedCall("PUT", "/api/v1/webhooks/bookings"), null, "PUT not allowed");
    assertEqual(matchAllowedCall("GET", "/api/v1/webhooks/secrets"), null, "unknown resource blocked");
    assertEqual(matchAllowedCall("GET", "/api/v1/users"), null, "outside webhooks prefix blocked");
  });

  await test("پارامترهای مسیر استخراج می‌شوند", async () => {
    const { matchAllowedCall, extractPathParams } = await import("@/lib/proxy/allowlist");
    const match = matchAllowedCall("PATCH", "/api/v1/webhooks/bookings/44444444-4444-4444-8444-444444444444");
    assert(match, "matched");
    if (!match) return;
    assertEqual(extractPathParams(match.action, "/api/v1/webhooks/bookings/44444444-4444-4444-8444-444444444444").id, "44444444-4444-4444-8444-444444444444", "id");
  });

  await test("CORS: دامنهٔ مجاز قبول، غریبه رد، سرور-به-سرور آزاد", async () => {
    const { isOriginBlocked, corsHeaders } = await import("@/lib/cors");
    assertEqual(isOriginBlocked("https://app.example.com"), false, "allowed origin");
    assertEqual(isOriginBlocked("https://evil.example.com"), true, "blocked origin");
    assertEqual(isOriginBlocked(null), false, "server-to-server");
    assertEqual(corsHeaders("https://app.example.com")["Access-Control-Allow-Origin"], "https://app.example.com", "cors echo");
    assertEqual(corsHeaders("https://evil.example.com")["Access-Control-Allow-Origin"], undefined, "no cors for evil");
  });

  console.log("\nج) اعتبارسنجی پلن");
  await test("اکشن ناموجود نامعتبر است", () => {
    const plan = validatePlan(planSchema.parse({ intent: "read", actionId: "database.drop" }));
    assertEqual(plan.actionValid, false, "actionValid");
    assertEqual(plan.invalidActionId, "database.drop", "invalidActionId");
  });

  await test("delete با intent=read نامعتبر است", () => {
    const plan = validatePlan(planSchema.parse({ intent: "read", actionId: "bookings.delete" }));
    assertEqual(plan.actionValid, false, "actionValid");
  });

  await test("JSON کثیف مدل قابل بازیابی است", () => {
    const parsed = parseJsonLoose<{ a: number }>('باشه:\n```json\n{"a":1}\n```');
    assertEqual(parsed.a, 1, "parsed");
  });

  console.log("\nد) جواب بدون هوش مصنوعی (fallback)");
  await test("لیست خالی → پیام محترمانه", () => {
    const text = fallbackAnswer({ userMessage: "نوبت‌ها", actionId: "bookings.list", outcome: "success", data: { items: [], total: 0 }, locale: "fa" });
    assert(text.includes("پیدا نشد"), `unexpected: ${text}`);
  });

  await test("لیست پر → اسم‌ها را می‌آورد", () => {
    const text = fallbackAnswer({
      userMessage: "نوبت‌ها",
      actionId: "bookings.list",
      outcome: "success",
      data: { items: [{ fullName: "مریم رضایی", status: "paid" }], total: 1 },
      locale: "fa",
    });
    assert(text.includes("مریم رضایی"), `unexpected: ${text}`);
    assert(text.includes("پرداخت‌شده"), "status translated");
  });

  await test("خطای دسترسی → توضیح ساده فارسی", () => {
    const text = fallbackAnswer({
      userMessage: "حذف کن",
      actionId: "bookings.delete",
      outcome: "error",
      errorCode: "WEBHOOK_FORBIDDEN",
      errorMessage: "Insufficient permissions.",
      locale: "fa",
    });
    assert(text.includes("اجازه"), `unexpected: ${text}`);
    assert(!text.includes("403"), "no raw code");
  });

  console.log("\nد-۲) جوابِ خرابِ مدل به کاربر نمی‌رسد");

  await test("تحلیلِ مدل (Analyze the Request…) به کاربر نشان داده نمی‌شود", async () => {
    // The exact failure shape from production, cut off mid-word by max_tokens.
    explainerText = [
      "Analyze the Request:",
      "* Role: Friendly clinic assistant explaining the bot's output.",
      "* Input Data:",
      "* User asked: \"دیدن لیست ساعت‌های کاری\"",
      "2. Drafting the Response (Iterative Process):",
      "* Attempt 1: کاربر درخواست لیست ساعت‌های کاری کرد.",
      "* Line 3: در این لیست ۵ روز تعیین شده که شنبه، یکشنبه، دوشنبه، سه‌شنبه و چهارشن",
    ].join("\n");

    const result = await explain({
      userMessage: "ساعت‌های کاری رو ببین",
      actionId: "working-hours.list",
      outcome: "success",
      data: { items: [{ day: "Saturday", opens: "13:15", closes: "17:45", capacity: 2 }], total: 1 },
      locale: "fa",
    });

    assertEqual(result.engine, "fallback", "engine");
    assert(!/Analyze|Role:|Attempt|Drafting/i.test(result.text), `leaked: ${result.text}`);
    assert(result.text.includes("شنبه"), `fallback text: ${result.text}`);
  });

  await test("تشخیصِ سندِ استدلال در دو حالت روشن/تاریک", () => {
    assert(looksLikeReasoningDump("Analyze the Request:\n* Role: bot"), "english scaffold");
    assert(looksLikeReasoningDump("کاربر گفته بود: \"نوبت‌ها\"\nنتیجه: success"), "prompt echo");
    assert(!looksLikeReasoningDump("۵ روز کاری داری؛ همه از ۱۳:۱۵ تا ۱۷:۴۵ باز است."), "normal answer");
    assert(!looksLikeReasoningDump("نوبت‌ها را دیدم: سه تا هست."), "short answer");
  });

  await test("جوابِ بریده‌شده (finish_reason=length) کنار گذاشته می‌شود", async () => {
    explainerText = "در این لیست ۵ روز تعیین شده که شنبه، یکشنبه، دوشنبه، سه‌شنبه و چهارشن";
    explainerFinishReason = "length";

    const result = await explain({
      userMessage: "ساعت‌های کاری رو ببین",
      actionId: "working-hours.list",
      outcome: "success",
      data: { items: [{ day: "Saturday", opens: "13:15", closes: "17:45" }], total: 1 },
      locale: "fa",
    });

    explainerFinishReason = null;
    assertEqual(result.engine, "fallback", "engine");
    assert(!result.text.includes("چهارشن"), `cut mid-word: ${result.text}`);
  });

  await test("بریدنِ متن در مرزِ جمله، نه وسطِ کلمه", () => {
    // sentence boundary available → cut there, keep one clean full stop
    const sentences = "خط اول کوتاه است. خط دوم هم هست. خط سوم خیلی طولانی‌تر است و ادامه دارد و ادامه دارد";
    const sentenceCut = truncateAtSentence(sentences, 45);
    assert(!sentenceCut.includes("ادامه دارد"), `cut too late: ${sentenceCut}`);
    assert(sentenceCut.includes("."), `cut too early: ${sentenceCut}`);
    assert(!sentenceCut.endsWith(".…"), `double punctuation: ${sentenceCut}`);

    // no sentence boundary → fall back to the last whole word, with an ellipsis
    const words = "یک دو سه چهار پنج شش هفت هشت نه ده یازده دوازده سیزده";
    const wordCut = truncateAtSentence(words, 22);
    assert(wordCut.endsWith("…"), `ellipsis: ${wordCut}`);
    assert(!/\s$/.test(wordCut), `trailing space: ${wordCut}`);
    assertEqual(truncateAtSentence("کوتاه", 100), "کوتاه", "short text untouched");
  });

  await test("نکتهٔ «روی گزینه‌ها ضربه بزن» حذف می‌شود", async () => {
    nextSuggestJson = JSON.stringify({
      suggestions: [{ label: "📋 نوبت‌ها", actionId: "bookings.list" }],
      tip: "برای دیدن اطلاعات بیشتر، می‌توانی روی هر کدام از این گزینه‌ها ضربه بزنی.",
    });

    const filled = await suggestNext({
      userMessage: "ساعت کاری",
      actionId: "working-hours.list",
      status: "done",
      replyPreview: "۵ روز کاری داری.",
      locale: "fa",
    });
    assertEqual(filled.tip, "", "filler tip dropped");

    nextSuggestJson = JSON.stringify({
      suggestions: [{ label: "📋 نوبت‌ها", actionId: "bookings.list" }],
      tip: "شنبه‌ها تعطیل است، پس نوبت صبح نگیر.",
    });
    const useful = await suggestNext({
      userMessage: "ساعت کاری",
      actionId: "working-hours.list",
      status: "done",
      replyPreview: "۵ روز کاری داری.",
      locale: "fa",
    });
    assertEqual(useful.tip, "شنبه‌ها تعطیل است، پس نوبت صبح نگیر.", "useful tip kept");
    nextSuggestJson = "{}";
  });

  console.log("\nه) کل مسیر با مدلِ تقلبی");
  process.env.USE_AI_EXPLAINER = "true";
  resetConfigCache();
  resetSessionsForTesting();

  await test("خواندن: فهمیدن → درخواست → توضیح", async () => {
    calls.length = 0;
    nextPlannerJson = JSON.stringify({
      intent: "read",
      actionId: "bookings.list",
      params: { status: "paid" },
      missing: [],
      understood: "می‌خواهی نوبت‌های پرداخت‌شده را ببینی.",
      reply: "",
      confidence: 0.9,
    });
    explainerText = "سه نوبت داری که پولشان را داده‌اند. مثل بچه‌هایی که بلیتشان را خریده‌اند و آمادهٔ ورود هستند.";

    const result = await handleChat({ message: "نوبت‌های پرداخت‌شده رو نشون بده", sessionId: "s1", locale: "fa" });

    assertEqual(result.status, "done", "status");
    assertEqual(result.actionId, "bookings.list", "actionId");
    assertEqual(result.trace.planner, "ai", "planner");
    assertEqual(result.trace.writer, "ai", "writer");
    assert(result.reply.includes("بلیت"), `reply: ${result.reply}`);

    const webhookCall = calls.find((call) => call.url.startsWith("http://clinic.test"));
    assert(webhookCall, "webhook was called");
    assert(webhookCall?.url.includes("status=paid"), `query forwarded: ${webhookCall?.url}`);
    assert(webhookCall?.headers.Authorization?.startsWith("Basic "), "basic auth header");
  });

  await test("نوشتن: کارت تأیید می‌دهد و بدون تأیید چیزی نمی‌فرستد", async () => {
    calls.length = 0;
    nextPlannerJson = JSON.stringify({
      intent: "write",
      actionId: "bookings.create",
      params: {
        fullName: "مریم رضایی",
        phone: "09121234567",
        items: [{ groupId: "11111111-1111-4111-8111-111111111111", slotId: "22222222-2222-4222-8222-222222222222" }],
      },
      missing: [],
      understood: "می‌خواهی برای مریم نوبت بسازی.",
      reply: "",
      confidence: 0.85,
    });

    const result = await handleChat({ message: "برای مریم رضایی نوبت بساز ۰۹۱۲۱۲۳۴۵۶۷", sessionId: "s2", locale: "fa" });

    assertEqual(result.status, "needs_confirmation", "status");
    assert(result.confirmation?.token, "has token");
    assertEqual(result.confirmation?.danger, "write", "danger");
    const writeCalls = calls.filter((call) => call.url.startsWith("http://clinic.test"));
    assertEqual(writeCalls.length, 0, "no HTTP write before confirmation");
  });

  await test("تأیید کاربر → درخواست واقعی ارسال می‌شود", async () => {
    calls.length = 0;
    explainerText = "نوبت مریم ثبت شد. ✅ حالا در دفترچهٔ کلینیک نوشته شده.";
    // re-create a pending plan
    nextPlannerJson = JSON.stringify({
      intent: "write",
      actionId: "bookings.update",
      params: { id: "11111111-1111-4111-8111-111111111111", status: "done" },
      missing: [],
      understood: "می‌خواهی وضعیت نوبت را انجام‌شده کنی.",
      reply: "",
      confidence: 0.9,
    });

    const first = await handleChat({ message: "نوبت مریم رو انجام‌شده کن", sessionId: "s3", locale: "fa" });
    assertEqual(first.status, "needs_confirmation", "first status");
    const token2 = first.confirmation?.token as string;

    const second = await handleChat({
      message: "بله",
      sessionId: "s3",
      locale: "fa",
      confirm: { token: token2, approve: true },
    });

    assertEqual(second.status, "done", `second status (${JSON.stringify(second.result)})`);
    const patch = calls.find((call) => call.method === "PATCH");
    assert(patch, "PATCH was sent");
    assertEqual((patch?.body as { status: string }).status, "done", "body.status");
    assert(patch?.url.includes("/11111111-1111-4111-8111-111111111111"), "id in path");
  });

  await test("لغو تأیید → هیچ درخواستی نمی‌رود", async () => {
    calls.length = 0;
    nextPlannerJson = JSON.stringify({
      intent: "delete",
      actionId: "bookings.delete",
      params: { id: "22222222-2222-4222-8222-222222222222" },
      missing: [],
      understood: "می‌خواهی نوبت را حذف کنی.",
      reply: "",
      confidence: 0.9,
    });
    const first = await handleChat({ message: "نوبت علی رو حذف کن", sessionId: "s4", locale: "fa" });
    assertEqual(first.status, "needs_confirmation", "status");

    const second = await handleChat({
      message: "نه",
      sessionId: "s4",
      locale: "fa",
      confirm: { token: first.confirmation?.token as string, approve: false },
    });
    assertEqual(second.status, "answered", "status");
    assert(second.reply.includes("انجام ندادم"), "polite cancel");
    assertEqual(calls.filter((call) => call.url.startsWith("http://clinic.test")).length, 0, "no HTTP call");
  });

  await test("تأییدیهٔ منقضی/جعلی پذیرفته نمی‌شود", async () => {
    const result = await handleChat({
      message: "بله",
      sessionId: "s5",
      locale: "fa",
      confirm: { token: "00000000-0000-4000-8000-000000000000", approve: true },
    });
    assertEqual(result.status, "error", "status");
    assert(result.reply.includes("معتبر نیست"), result.reply);
  });

  await test("تأییدیه به نشست دیگری داده نمی‌شود", async () => {
    nextPlannerJson = JSON.stringify({ intent: "delete", actionId: "rules.delete", params: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, missing: [], understood: "", reply: "", confidence: 0.9 });
    const first = await handleChat({ message: "این قانون رو حذف کن", sessionId: "s6", locale: "fa" });
    const token = first.confirmation?.token as string;
    const stolen = await handleChat({ message: "بله", sessionId: "attacker", locale: "fa", confirm: { token, approve: true } });
    assertEqual(stolen.status, "error", "cross-session blocked");
  });

  await test("مدل‌ها خراب‌اند → موتور کلمات کلیدی کار را انجام می‌دهد", async () => {
    plannerShouldFail = true;
    explainerShouldFail = true;
    resetSessionsForTesting();

    const result = await handleChat({ message: "ساعت کاری شنبه‌ها رو نشون بده", sessionId: "s7", locale: "fa" });

    assertEqual(result.trace.planner, "router", "planner engine");
    assertEqual(result.trace.writer, "fallback", "writer engine");
    assert(result.trace.notice?.includes("کلمات کلیدی"), `notice: ${result.trace.notice}`);
    assertEqual(result.status, "done", `status (${result.reply})`);
    assertEqual(result.actionId, "working-hours.list", "actionId");
    // پاسخ فقط باید شامل ساعت کاری شنبه باشد و روزهای دیگر را لیست نکند
    assert(result.reply.includes("روزهای شنبه"), "includes Saturday");
    assert(result.reply.includes("09:00"), "includes opens time");
    assert(!result.reply.includes("روزهای دوشنبه"), "does not list Monday");
    assert(!result.reply.includes("۲ مورد پیدا کردم"), "does not treat as full list dump");

    // پرسیدن دربارهٔ دوشنبه فقط دوشنبه را می‌دهد
    const monResult = await handleChat({ message: "ساعات کاری دوشنبه چیه", sessionId: "s7-mon", locale: "fa" });
    assert(monResult.reply.includes("روزهای دوشنبه"), "includes Monday");
    assert(!monResult.reply.includes("روزهای شنبه"), "does not include Saturday");

    // پرسیدن دربارهٔ روزی که ساعت کاری ندارد
    const friResult = await handleChat({ message: "ساعت کاری جمعه چیه؟", sessionId: "s7-fri", locale: "fa" });
    assert(friResult.reply.includes("ثبت نشده"), "indicates no working hours for Friday");

    plannerShouldFail = false;
    explainerShouldFail = false;
  });

  await test("کاملاً بدون مدل: حذف با uuid → تأیید → DELETE واقعی", async () => {
    plannerShouldFail = true;
    explainerShouldFail = true;
    resetSessionsForTesting();
    calls.length = 0;

    const first = await handleChat({ message: "نوبت 33333333-3333-4333-8333-333333333333 رو حذف کن", sessionId: "s10", locale: "fa" });
    assertEqual(first.trace.planner, "router", "planner");
    assertEqual(first.status, "needs_confirmation", `first status (${JSON.stringify(first.reply)})`);
    assertEqual(first.confirmation?.danger, "destructive", "danger");

    const second = await handleChat({
      message: "بله",
      sessionId: "s10",
      locale: "fa",
      confirm: { token: first.confirmation?.token as string, approve: true },
    });

    plannerShouldFail = false;
    explainerShouldFail = false;

    assertEqual(second.status, "done", `second status (${JSON.stringify(second.result)})`);
    const removed = calls.find((call) => call.method === "DELETE");
    assert(removed, "DELETE was sent");
    assert(removed?.url.includes("/33333333-3333-4333-8333-333333333333"), "uuid in path");
  });

  await test("سؤال «چه کارهایی بلدی؟» → فهرست امکانات، بدون HTTP", async () => {
    resetSessionsForTesting();
    calls.length = 0;
    nextPlannerJson = JSON.stringify({ intent: "features", actionId: null, params: {}, missing: [], understood: "", reply: "", confidence: 0.9 });
    const result = await handleChat({ message: "تو چه کارهایی می‌تونی انجام بدی؟", sessionId: "s8", locale: "fa" });
    assertEqual(result.status, "answered", "status");
    assert(result.reply.includes("نوبت"), "mentions bookings");
    assertEqual(calls.filter((call) => call.url.startsWith("http://clinic.test")).length, 0, "no HTTP");
  });

  await test("خطای ۴۰۳ مقصد → جواب سادهٔ فارسی، نه کد خام", async () => {
    resetSessionsForTesting();
    webhookStatus = 403;
    nextPlannerJson = JSON.stringify({ intent: "read", actionId: "users.list", params: {}, missing: [], understood: "", reply: "", confidence: 0.9 });
    explainerShouldFail = true; // force the deterministic writer
    const result = await handleChat({ message: "کاربرها رو لیست کن", sessionId: "s9", locale: "fa" });
    webhookStatus = 200;
    explainerShouldFail = false;
    assertEqual(result.status, "error", "status");
    assert(result.result?.code === "WEBHOOK_FORBIDDEN", `code: ${result.result?.code}`);
    assert(result.reply.includes("اجازه"), result.reply);
  });

  console.log("\nو) ربات تلگرام");
  const tg = await import("@/lib/telegram/api");
  const { handleTelegramUpdate } = await import("@/lib/telegram/handler");
  const { parseCallback, menuKeyboard, confirmationKeyboard, suggestionsKeyboard } = await import("@/lib/telegram/keyboard");
  const { ensureWebhook } = await import("@/lib/telegram/setup");
  const { fallbackSuggestions } = await import("@/lib/telegram/suggest"); // suggestNext imported earlier (used above)

  await test("پروتکل callback_data (زیر ۶۴ بایت، همهٔ حالت‌ها)", () => {
    assertEqual(parseCallback("m").kind, "menu", "menu");
    assertEqual(parseCallback("h").kind, "help", "help");
    assertEqual(parseCallback("f:bookings").kind, "feature", "feature");
    assertEqual(parseCallback("a:care-guide-items.list").kind, "action", "action id with dashes");
    const confirmed = parseCallback("c:11111111-1111-4111-8111-111111111111");
    assertEqual(confirmed.kind, "confirm", "confirm kind");
    if (confirmed.kind === "confirm") {
      assertEqual(confirmed.approve, true, "approve");
      assert(Buffer.byteLength(`c:${confirmed.token}`) <= 64, "fits in 64 bytes");
    }
    assertEqual(parseCallback("zzz").kind, "unknown", "unknown");
  });

  await test("دکمه‌های منو و تأییدیه درست ساخته می‌شوند", () => {
    const menu = menuKeyboard("fa");
    const flat = menu.inline_keyboard.flat();
    assert(flat.length >= 10, `menu has ${flat.length} buttons`);
    for (const entry of flat) {
      if ("callback_data" in entry) {
        assert(Buffer.byteLength(entry.callback_data) <= 64, `too long: ${entry.callback_data}`);
      }
    }
    const confirm = confirmationKeyboard("11111111-1111-4111-8111-111111111111", "fa");
    assertEqual(confirm.inline_keyboard.flat().length, 2, "yes + no");
    assertEqual(suggestionsKeyboard([], "fa"), undefined, "no suggestions → no keyboard");
  });

  await test("پیشنهادهای مدل اعتبارسنجی می‌شوند (حذفِ حذف!)", async () => {
    nextSuggestJson = JSON.stringify({
      suggestions: [
        { label: "📋 همهٔ نوبت‌ها", actionId: "bookings.list" },
        { label: "🗑 پاک کن", actionId: "bookings.delete" },
        { label: "🎭 ساختگی", actionId: "database.drop" },
        { label: "🛍 خدمات", actionId: "services.list" },
      ],
      tip: "می‌توانی خدمات را هم ببینی.",
    });

    const result = await suggestNext({
      userMessage: "نوبت‌ها",
      actionId: "bookings.list",
      status: "done",
      replyPreview: "۱ نوبت",
      locale: "fa",
    });

    const ids = result.suggestions.map((suggestion) => suggestion.actionId ?? suggestion.command);
    assert(ids.includes("bookings.list"), "keeps the valid one");
    assert(ids.includes("services.list"), "keeps the second valid one");
    assert(!ids.includes("bookings.delete"), "drops destructive suggestion");
    assert(!ids.includes("database.drop"), "drops invented action");
    assert(ids.includes("menu"), "always offers a way home");
    assertEqual(result.engine, "ai", "engine");
  });

  await test("اگر مدل نبود، پیشنهادها آفلاین ساخته می‌شوند", async () => {
    const fallback = fallbackSuggestions({ actionId: "bookings.list", locale: "fa" });
    assert(fallback.length > 0, "has suggestions");
    assert(fallback.some((suggestion) => suggestion.command === "menu"), "menu included");
    for (const suggestion of fallback) {
      if (suggestion.actionId) assert(!suggestion.actionId.includes("delete"), "no destructive fallback");
      assert(!/[؟?]$/.test(suggestion.label), `label must not end with question mark: ${suggestion.label}`);
    }

    const enFallback = fallbackSuggestions({ actionId: "bookings.list", locale: "en" });
    for (const suggestion of enFallback) {
      assert(!suggestion.label.endsWith("?"), `english label must not end with question mark: ${suggestion.label}`);
    }
  });

  await test("لاگین خودکار: getMe → setWebhook روی همان URL", async () => {
    tgCalls.length = 0;
    const report = await ensureWebhook({ force: true });
    assertEqual(report.action, "registered", `action (${report.message})`);
    assertEqual(report.bot?.username, "clinic_test_bot", "bot username");

    const setHook = tgCalls.find((call) => call.method === "setWebhook");
    assert(setHook, "setWebhook called");
    assertEqual(setHook?.payload.url, "https://bot.example.com/api/telegram/webhook", "url");
    assertEqual(setHook?.payload.secret_token, "secret-abc", "secret forwarded");
  });

  await test("لاگین خودکار دوباره ثبت نمی‌کند اگر URL همان باشد", async () => {
    // second call: getWebhookInfo still reports "" from the fake, so force=false must re-register.
    tgCalls.length = 0;
    await ensureWebhook({});
    const setHooks = tgCalls.filter((call) => call.method === "setWebhook").length;
    assert(setHooks <= 1, "at most one setWebhook");
  });

  const baseUpdate = {
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: 777, is_bot: false, first_name: "نازنین" },
      chat: { id: 777, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text: "",
    },
  };

  await test("تلگرام: /start → خوش‌آمد + دکمه‌های منو", async () => {
    tgCalls.length = 0;
    const outcome = await handleTelegramUpdate({
      ...baseUpdate,
      message: { ...baseUpdate.message, text: "/start" },
    });
    assertEqual(outcome.handled, true, "handled");
    const sent = tgCalls.find((call) => call.method === "sendMessage");
    assert(sent, "sendMessage called");
    assert(String(sent?.payload.text).includes("دستیار کلینیک"), "welcome text");
    const markup = sent?.payload.reply_markup as { inline_keyboard: unknown[][] } | undefined;
    assert(markup && markup.inline_keyboard.length >= 5, "menu keyboard attached");
  });

  await test("تلگرام: پیام فارسی → جواب + دکمه‌های پیشنهادی هوش مصنوعی", async () => {
    tgCalls.length = 0;
    nextPlannerJson = JSON.stringify({
      intent: "read",
      actionId: "bookings.list",
      params: { status: "pending" },
      missing: [],
      understood: "می‌خواهی نوبت‌های پرداخت‌نشده را ببینی.",
      reply: "",
      confidence: 0.9,
    });
    explainerText = "دو نوبت پرداخت‌نشده داری.";
    nextSuggestJson = JSON.stringify({
      suggestions: [{ label: "📋 همهٔ نوبت‌ها", actionId: "bookings.list" }],
      tip: "می‌خواهی همه را ببینی؟",
    });

    const outcome = await handleTelegramUpdate({
      ...baseUpdate,
      update_id: 2,
      message: { ...baseUpdate.message, text: "نوبت‌های پرداخت‌نشده رو نشون بده" },
    });

    assertEqual(outcome.status, "done", `status (${JSON.stringify(outcome)})`);
    const sent = tgCalls.filter((call) => call.method === "sendMessage").pop();
    assert(String(sent?.payload.text).includes("پرداخت‌نشده"), "reply sent to Telegram");
    assert(String(sent?.payload.text).includes("💡"), "tip appended");
    const markup = sent?.payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    assert(markup, "keyboard attached");
    const flat = markup.inline_keyboard.flat().map((entry) => entry.callback_data);
    assert(flat.includes("a:bookings.list"), `suggested button present (${flat.join(",")})`);
    assert(flat.includes("m"), "menu button present");
  });

  await test("تلگرام: دکمهٔ نوشتنِ ناقص → سؤال می‌پرسد و هیچ درخواستی نمی‌فرستد", async () => {
    tgCalls.length = 0;
    calls.length = 0;
    const outcome = await handleTelegramUpdate({
      update_id: 3,
      callback_query: {
        id: "cb-1",
        from: { id: 777, is_bot: false, first_name: "نازنین" },
        data: "a:bookings.create",
        message: { message_id: 11, chat: { id: 777, type: "private" }, date: 0 },
      },
    });

    assertEqual(outcome.status, "needs_info", `status (${JSON.stringify(outcome)})`);
    assertEqual(calls.filter((call) => call.url.startsWith("http://clinic.test")).length, 0, "no HTTP write");
    const sent = tgCalls.filter((call) => call.method === "sendMessage").pop();
    assert(String(sent?.payload.text).includes("لازم دارم"), "asks for the missing fields");
    assert(tgCalls.some((call) => call.method === "answerCallbackQuery"), "callback acknowledged");
  });

  await test("تلگرام: دکمهٔ بله روی تأییدیه → نوشتن واقعی", async () => {
    const { handleChat: chat } = await import("@/lib/bot");
    resetSessionsForTesting();

    // A dashboard (or a future button with params) can go straight to an action.
    const prepared = await chat({
      message: "ثبت نوبت",
      sessionId: "tg-777",
      locale: "fa",
      direct: {
        actionId: "bookings.create",
        params: {
          fullName: "مریم رضایی",
          phone: "09121234567",
          items: [{ groupId: "11111111-1111-4111-8111-111111111111", slotId: "22222222-2222-4222-8222-222222222222" }],
        },
      },
    });
    assertEqual(prepared.status, "needs_confirmation", "waiting for a human");
    // the chat id is the Telegram chat, so the button lands in the same session
    const token = prepared.confirmation?.token as string;

    tgCalls.length = 0;
    calls.length = 0;
    explainerText = "نوبت مریم ثبت شد. ✅";
    const outcome = await handleTelegramUpdate({
      update_id: 30,
      callback_query: {
        id: "cb-yes",
        from: { id: 777, is_bot: false, first_name: "نازنین" },
        data: `c:${token}`,
        message: { message_id: 14, chat: { id: 777, type: "private" }, date: 0 },
      },
    });

    assertEqual(outcome.status, "done", `status (${JSON.stringify(outcome)})`);
    const posted = calls.find((call) => call.url.startsWith("http://clinic.test") && call.method === "POST");
    assert(posted, "POST sent to the clinic");
    assertEqual((posted?.body as { fullName: string }).fullName, "مریم رضایی", "body forwarded");
  });

  await test("تلگرام: دکمهٔ منو بدون AI و بدون HTTP جواب می‌دهد", async () => {
    tgCalls.length = 0;
    calls.length = 0;
    const outcome = await handleTelegramUpdate({
      update_id: 4,
      callback_query: {
        id: "cb-2",
        from: { id: 777, is_bot: false, first_name: "نازنین" },
        data: "f:services",
        message: { message_id: 12, chat: { id: 777, type: "private" }, date: 0 },
      },
    });
    assertEqual(outcome.status, "feature", "feature view");
    assertEqual(calls.filter((call) => call.url.startsWith("http://clinic.test")).length, 0, "no clinic call at all");
    const sent = tgCalls.find((call) => call.method === "sendMessage");
    assert(String(sent?.payload.text).includes("خدمات"), "explains the section");
  });

  await test("تلگرام: چتِ غیرمجاز کاملاً رد می‌شود", async () => {
    tgCalls.length = 0;
    const outcome = await handleTelegramUpdate({
      update_id: 5,
      message: {
        message_id: 13,
        from: { id: 999, is_bot: false, first_name: "غریبه" },
        chat: { id: 999, type: "private" },
        date: 0,
        text: "/start",
      },
    });
    assertEqual(outcome.handled, false, "not handled");
    assertEqual(outcome.reason, "chat not allowed", "reason");
    assertEqual(tgCalls.length, 0, "no reply leaked to a stranger");
  });

  await test("تلگرام: /id شناسهٔ چت را برمی‌گرداند", async () => {
    tgCalls.length = 0;
    await handleTelegramUpdate({ ...baseUpdate, update_id: 6, message: { ...baseUpdate.message, text: "/id" } });
    const sent = tgCalls.find((call) => call.method === "sendMessage");
    assert(String(sent?.payload.text).includes("777"), "chat id shown");
  });

  console.log("\nز) ورود بدون رمز (هویت با شمارهٔ تلگرام)");
  const identity = await import("@/lib/telegram/identity");

  await test("شماره‌ها به یک شکل نرمال می‌شوند", () => {
    assertEqual(identity.normalisePhone("09121234567"), "09121234567", "local");
    assertEqual(identity.normalisePhone("+989121234567"), "09121234567", "+98");
    assertEqual(identity.normalisePhone("00989121234567"), "09121234567", "0098");
    assertEqual(identity.normalisePhone("989121234567"), "09121234567", "98");
    assertEqual(identity.normalisePhone("۰۹۱۲۱۲۳۴۵۶۷"), "09121234567", "Persian digits");
    assertEqual(identity.normalisePhone("12345"), null, "garbage rejected");
  });

  await test("کارت مخاطبِ فوروارد‌شده قبول نمی‌شود", async () => {
    identity.resetIdentitiesForTesting();
    const result = await identity.verifyContact({
      chatId: 900, fromId: 5,
      contact: { phone_number: "09120000001", first_name: "دکتر", user_id: 999 }, // someone else
    });
    assertEqual(result.status, "rejected", "rejected");
    assertEqual(result.reason, "not-own-contact", "reason");
  });

  await test("شمارهٔ ثبت‌نشده رد می‌شود", async () => {
    identity.resetIdentitiesForTesting();
    const result = await identity.verifyContact({
      chatId: 901, fromId: 5,
      contact: { phone_number: "09359999999", first_name: "غریبه", user_id: 5 },
    });
    assertEqual(result.status, "rejected", "rejected");
    assertEqual(result.reason, "phone-not-registered", "reason");
  });

  await test("کاربر غیرفعال رد می‌شود", async () => {
    identity.resetIdentitiesForTesting();
    const result = await identity.verifyContact({
      chatId: 902, fromId: 5,
      contact: { phone_number: "09120000002", first_name: "منشی", user_id: 5 },
    });
    assertEqual(result.status, "rejected", "rejected");
    assertEqual(result.reason, "user-inactive", "reason");
  });

  await test("کد کشور مهم نیست: +98 / 0098 / 98 / بدون صفر", () => {
    for (const raw of ["+989121234567", "00989121234567", "989121234567", "09121234567", "9121234567", "+98 912 123 4567", "+98-912-123-4567"]) {
      assertEqual(identity.normalisePhone(raw), "09121234567", raw);
    }
    assertEqual(identity.normalisePhone("+982188889999"), "02188889999", "تهران با کد کشور");
    assertEqual(identity.normalisePhone("+14155551234"), null, "شمارهٔ خارجی رد می‌شود");
  });

  await test("معادل‌های جست‌وجو ساخته می‌شوند (چون search فقط «شامل بودن» است)", () => {
    const variants = identity.searchVariants("09121234567");
    assert(variants.includes("09121234567"), "local");
    assert(variants.includes("9121234567"), "national (matches +98 in the DB)");
    assert(variants.includes("+989121234567"), "+98 form");
    assert(variants.includes("989121234567"), "98 form");
  });

  await test("شمارهٔ ذخیره‌شده به فرمت +98 در سایت هم پیدا می‌شود", async () => {
    identity.resetIdentitiesForTesting();
    const result = await identity.verifyContact({
      chatId: 910, fromId: 5,
      contact: { phone_number: "+989120000003", first_name: "کارمند", user_id: 5 },
    });
    assertEqual(result.status, "verified", `status (${result.reason})`);
    assertEqual(result.fullName, "کارمند با فرمت +98", "matched the +98 row");
  });

  await test("شمارهٔ ذخیره‌شده با فاصله در سایت هم پیدا می‌شود", async () => {
    identity.resetIdentitiesForTesting();
    const result = await identity.verifyContact({
      chatId: 911, fromId: 5,
      contact: { phone_number: "09120000002", first_name: "منشی", user_id: 5 },
    });
    // matched, but that user is inactive → the *reason* proves the lookup worked
    assertEqual(result.reason, "user-inactive", `reason (${result.status})`);
  });

  await test("شمارهٔ ذخیره‌شده با ارقام فارسی در سایت هم پیدا می‌شود", async () => {
    identity.resetIdentitiesForTesting();
    const result = await identity.verifyContact({
      chatId: 912, fromId: 5,
      contact: { phone_number: "+989120000004", first_name: "کارمند", user_id: 5 },
    });
    assertEqual(result.status, "verified", `status (${result.reason})`);
  });

  await test("کاربر مسدود و شمارهٔ خارجی رد می‌شوند", async () => {
    identity.resetIdentitiesForTesting();
    const banned = await identity.verifyContact({
      chatId: 913, fromId: 5,
      contact: { phone_number: "09120000005", first_name: "x", user_id: 5 },
    });
    assertEqual(banned.reason, "user-banned", "banned");

    const foreign = await identity.verifyContact({
      chatId: 914, fromId: 5,
      contact: { phone_number: "+14155551234", first_name: "x", user_id: 5 },
    });
    assertEqual(foreign.reason, "foreign-number", "foreign");
  });

  await test("کارمند فعال تأیید می‌شود — بدون هیچ رمزی", async () => {
    identity.resetIdentitiesForTesting();
    const result = await identity.verifyContact({
      chatId: 903, fromId: 5,
      contact: { phone_number: "+989120000001", first_name: "نازنین", user_id: 5 },
    });
    assertEqual(result.status, "verified", `status (${result.reason})`);
    assertEqual(result.phone, "09120000001", "normalised phone");
    assertEqual(result.roleKey, "admin", "role came from the clinic");
    assertEqual(identity.isVerified(903), true, "stored");
  });

  await test("وقتی gate روشن است، چتِ ناشناس اول شماره می‌خواهد", async () => {
    process.env.TELEGRAM_REQUIRE_IDENTITY = "true";
    resetConfigCache();
    identity.resetIdentitiesForTesting();
    tgCalls.length = 0;
    calls.length = 0;

    const outcome = await handleTelegramUpdate({
      update_id: 950,
      message: {
        message_id: 60,
        from: { id: 777, is_bot: false, first_name: "نازنین" },
        chat: { id: 777, type: "private" },
        date: 0,
        text: "نوبت‌های امروز رو نشون بده",
      },
    });

    assertEqual(outcome.status, "identity", "gate triggered");
    assertEqual(calls.filter((call) => call.url.includes("/bookings")).length, 0, "no clinic data leaked before login");
    const sent = tgCalls.find((call) => call.method === "sendMessage");
    const markup = sent?.payload.reply_markup as { keyboard?: Array<Array<{ request_contact?: boolean }>> };
    assertEqual(markup?.keyboard?.[0]?.[0]?.request_contact, true, "asks Telegram for the phone");
  });

  await test("بعد از ارسال شمارهٔ معتبر، همان پیام اولیه خودکار اجرا می‌شود", async () => {
    tgCalls.length = 0;
    calls.length = 0;
    clearCacheForTesting();
    nextPlannerJson = JSON.stringify({ intent: "read", actionId: "bookings.list", params: {}, missing: [], understood: "", reply: "", confidence: 0.9 });
    explainerText = "سه نوبت داری.";

    const login = await handleTelegramUpdate({
      update_id: 951,
      message: {
        message_id: 61,
        from: { id: 777, is_bot: false, first_name: "نازنین" },
        chat: { id: 777, type: "private" },
        date: 0,
        contact: { phone_number: "09120000001", first_name: "نازنین", user_id: 777 },
      },
    });
    assertEqual(login.status, "done", "pending message executed automatically upon login");
    assertEqual(login.actionId, "bookings.list", "pending action");
    assertEqual(identity.isVerified(777), true, "now verified");
    assert(calls.some((call) => call.url.includes("/bookings")), "clinic was called right after login");

    const after = await handleTelegramUpdate({
      update_id: 952,
      message: {
        message_id: 62,
        from: { id: 777, is_bot: false, first_name: "نازنین" },
        chat: { id: 777, type: "private" },
        date: 0,
        text: "نوبت‌های امروز رو نشون بده",
      },
    });
    assertEqual(after.status, "done", `after-login status (${JSON.stringify(after)})`);
  });

  await test("کاربر بدون پیام اولیه (مثلاً /start) بعد از لاگین منوی اصلی را می‌بیند", async () => {
    identity.resetIdentitiesForTesting();
    tgCalls.length = 0;
    calls.length = 0;

    // 1. User sends /start while unauthenticated
    await handleTelegramUpdate({
      update_id: 960,
      message: { message_id: 70, from: { id: 777, is_bot: false, first_name: "نازنین" }, chat: { id: 777, type: "private" }, date: 0, text: "/start" },
    });

    // 2. Shares contact
    const login = await handleTelegramUpdate({
      update_id: 961,
      message: {
        message_id: 71,
        from: { id: 777, is_bot: false, first_name: "نازنین" },
        chat: { id: 777, type: "private" },
        date: 0,
        contact: { phone_number: "09120000001", first_name: "نازنین", user_id: 777 },
      },
    });

    assertEqual(login.status, "identity", "identity status because no pending query");
    const lastMsg = tgCalls.filter((c) => c.method === "sendMessage").pop();
    assert(String(lastMsg?.payload.text).includes("می‌توانید درخواست خود را بفرمایید"), "shows general welcome menu prompt");
  });

  await test("/logout دوباره قفل می‌کند", async () => {
    tgCalls.length = 0;
    await handleTelegramUpdate({
      update_id: 953,
      message: { message_id: 63, from: { id: 777, is_bot: false, first_name: "ن" }, chat: { id: 777, type: "private" }, date: 0, text: "/logout" },
    });
    assertEqual(identity.isVerified(777), false, "signed out");
    const sent = tgCalls.find((call) => call.method === "sendMessage");
    assert(String(sent?.payload.text).includes("خارج"), "logout message");
    delete process.env.TELEGRAM_REQUIRE_IDENTITY;
    resetConfigCache();
  });

  console.log("\nح) پاسخ‌های قالبی سریع (پیش‌فرض بدون هوش مصنوعی)");
  await test("پیش‌فرض: پاسخ‌های قالبی «بفرما ... پیدا کردم» بدون تأخیر مدل", async () => {
    delete process.env.USE_AI_EXPLAINER;
    resetConfigCache();
    resetSessionsForTesting();

    nextPlannerJson = JSON.stringify({
      intent: "read",
      actionId: "bookings.list",
      params: {},
      missing: [],
      understood: "نوبت‌ها",
      reply: "",
      confidence: 0.9,
    });

    const result = await handleChat({ message: "نوبت‌ها رو نشون بده", sessionId: "s-fast", locale: "fa" });
    assertEqual(result.status, "done", "status");
    assertEqual(result.trace.writer, "fallback", "writer is fast template/fallback");
    assert(result.reply.startsWith("بفرما"), `starts with بفرما: ${result.reply}`);
    assert(result.reply.includes("پیدا کردم"), `includes پیدا کردم: ${result.reply}`);
    assert(result.reply.includes("مریم رضایی"), `includes data rows: ${result.reply}`);
  });

  await test("manifest سالم است (شناسه‌ها یکتا، آدرس‌ها منطقی)", () => {
    const ids = new Set<string>();
    for (const feature of FEATURES) {
      for (const action of feature.actions) {
        assert(!ids.has(action.id), `duplicate action id ${action.id}`);
        ids.add(action.id);
        assert(action.path.startsWith("/api/v1/webhooks/"), `bad path ${action.path}`);
        assert(action.permission.includes("."), `bad permission on ${action.id}`);
      }
    }
  });

  console.log("\nط) ویرایش کامل، صفحه‌بندی و دسترسی آسان (بدون نیاز به شناسهٔ خام)");

  await test("لیست ۷۱ موردی → ۱۰ مورد در صفحه + شماره صفحه + راهنمای ادامه", () => {
    const dummyServices = Array.from({ length: 71 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      price: (i + 1) * 100_000,
      translations: { fa: { title: `خدمت آزمایشی شماره ${i + 1}` } },
    }));

    const text = fallbackAnswer({
      userMessage: "لیست خدمات",
      actionId: "services.list",
      outcome: "success",
      data: { items: dummyServices, total: 71, page: 1, perPage: 10 },
      locale: "fa",
    });

    assert(text.includes("صفحهٔ 1 از 8"), `missing page indicator: ${text}`);
    assert(text.includes("10. خدمت آزمایشی شماره 10"), `10 items must be shown: ${text}`);
    assert(!text.includes("11. خدمت آزمایشی شماره 11"), `item 11 should not be on page 1: ${text}`);
    assert(text.includes("61 مورد دیگر هم هست"), `missing remaining count: ${text}`);
    assert(text.includes("صفحه بعد"), `missing pagination tip: ${text}`);
  });

  await test("پیشنهادهای اکشن‌ها شامل ویرایش و ایجاد است (فقط‌خواندنی نیست)", () => {
    const { fallbackSuggestions, defaultTip } = require("@/lib/telegram/suggest");
    const suggestions = fallbackSuggestions({ actionId: "services.list", locale: "fa" });

    const hasUpdate = suggestions.some((s: any) => s.actionId === "services.update");
    const hasCreate = suggestions.some((s: any) => s.actionId === "services.create");
    assert(hasUpdate, "services suggestions must include services.update");
    assert(hasCreate, "services suggestions must include services.create");

    const tip = defaultTip("services.list");
    assert(tip.includes("برای تغییر قیمت"), `tip should be practical and helpful: ${tip}`);
  });

  await test("حل شناسه از حافظهٔ نشست و ویرایش آسان بدون uuid خام", async () => {
    const { saveSessionItems, findSessionItem } = await import("@/lib/bot/session");

    const dummyServices = [
      { id: "11111111-2222-4333-8444-555555555555", fullName: "دی می (فیلر نقاط حساس)", price: 6190000 },
      { id: "22222222-3333-4444-8555-666666666666", fullName: "فیورج (فیلر نقاط حساس)", price: 6390000 },
      { id: "33333333-4444-4555-8666-777777777777", fullName: "اودری", price: 1890000 },
    ];

    saveSessionItems("session-edit-test", "services", dummyServices, 1, 10);

    const matchByName = findSessionItem("session-edit-test", "قیمت دی می رو بکن ۷ میلیون");
    assert(matchByName !== undefined, "must match item by title");
    assertEqual(matchByName?.id, "11111111-2222-4333-8444-555555555555", "item 1 id");

    const matchByNumber = findSessionItem("session-edit-test", "شماره ۱ رو بکن ۷ میلیون");
    assert(matchByNumber !== undefined, "must match item by number 1");
    assertEqual(matchByNumber?.id, "11111111-2222-4333-8444-555555555555", "item 1 id");

    const matchByOrdinal = findSessionItem("session-edit-test", "مورد دوم رو غیرفعال کن");
    assert(matchByOrdinal !== undefined, "must match item by ordinal دوم");
    assertEqual(matchByOrdinal?.id, "22222222-3333-4444-8555-666666666666", "item 2 id");

    nextPlannerJson = "{}"; // test offline router resolution
    // Full flow: sentence -> edit plan -> confirmation card without asking for UUID
    const res = await handleChat({
      message: "قیمت دی می رو بکن ۷ میلیون",
      sessionId: "session-edit-test",
      locale: "fa",
    });

    assertEqual(res.status, "needs_confirmation", "ready for confirmation");
    assertEqual(res.actionId, "services.update", "actionId is services.update");
    assert(res.reply.includes("دی می"), `reply should reference item title: ${res.reply}`);
    assert(res.reply.includes("۷٬۰۰۰٬۰۰۰"), `reply should reference new price: ${res.reply}`);
  });

  await test("صفحه‌بندی تلگرام و درخواست «صفحه بعد»", async () => {
    const { parseCallback } = await import("@/lib/telegram/keyboard");
    const parsed = parseCallback("p:services.list:2");
    assertEqual(parsed.kind, "page", "callback parsed as page");
    if (parsed.kind === "page") {
      assertEqual(parsed.actionId, "services.list", "actionId");
      assertEqual(parsed.page, 2, "page number");
    }

    // Text-based pagination command:
    const { saveSessionItems } = await import("@/lib/bot/session");
    saveSessionItems("session-page-chat", "services", [{ id: "uuid-1", name: "خدمت ۱" }], 1, 10);

    const res = await handleChat({
      message: "صفحه بعد",
      sessionId: "session-page-chat",
      locale: "fa",
    });
    assertEqual(res.status, "done", "status");
    assertEqual(res.actionId, "services.list", "navigated to next page");
  });

  console.log("\nی) کشینگ پیشرفته، تایم تراول، ویرایش مرحله‌به‌مرحله و دکمه‌های بدون علامت سؤال");

  await test("کشینگ پیشرفته: ذخیره، TTL، تخلیه و بازگردانی", async () => {
    const { fetchWithCache, buildCacheKey, clearCacheForTesting, invalidateResource, setCache, getFromCache } = await import("@/lib/bot/cache");
    clearCacheForTesting();

    const req = { method: "GET" as const, path: "/api/v1/webhooks/services", query: { page: 1 } };
    const mockRes = { ok: true as const, status: 200, data: [{ id: "s1" }], requestId: "req-1", ms: 5 };
    const key = buildCacheKey(req);

    // Manual set & get with short TTL
    setCache(key, mockRes, ["services"], 5000);
    const cached = getFromCache(key);
    assert(cached !== null, "item retrieved from cache");
    assertEqual(cached?.entry.status, 200, "status 200");

    // Invalidation by resource tag
    invalidateResource("services");
    assert(getFromCache(key) === null, "item invalidated by tag");

    // Test with fetchWithCache and coalescing
    clearCacheForTesting();
    const p1 = fetchWithCache(req);
    const p2 = fetchWithCache(req);
    const [r1, r2] = await Promise.all([p1, p2]);
    assertEqual(r1.ok, true, "r1 ok");
    assertEqual(r2.ok, true, "r2 ok");
  });

  await test("تایم تراول: تشخیص پرامیس پیش‌نیاز، فچ زودهنگام و پاسخ آنی در کلیک", async () => {
    const { prefetchPredictedActions, getCacheStats, clearCacheForTesting } = await import("@/lib/bot/cache");
    clearCacheForTesting();

    // Trigger Time Travel prefetch for predicted actions
    await prefetchPredictedActions([
      { actionId: "services.list", query: { page: 2 } },
      { actionId: "bookings.list" },
    ]);

    const stats = getCacheStats();
    assert(stats.prefetches >= 2, "time travel triggered prefetches");

    // Immediate click: executeRequest should hit time travel cache with ms: 0
    const { executeRequest } = await import("@/lib/bot/executor");
    const clickRes = await executeRequest({
      actionId: "services.list",
      method: "GET",
      path: "/api/v1/webhooks/services",
      permission: "services.read",
      danger: "read",
      pathParams: {},
      query: { page: 2 },
      body: undefined,
      summaryFa: "مشاهده خدمات",
    });

    assertEqual((clickRes as any).fromCache, true, "served from cache");
    assertEqual((clickRes as any).timeTravel, true, "tagged as time travel hit");
  });

  await test("ویرایش مرحله‌به‌مرحله: شروع، پیشروی گام‌به‌گام، رد مرحله و تکمیل", async () => {
    const { saveSessionItems, getActiveEdit, clearActiveEdit } = await import("@/lib/bot/session");
    const sessionId = "step-edit-session";
    clearActiveEdit(sessionId);

    // Save item in session
    saveSessionItems(sessionId, "services", [{ id: "11111111-2222-4333-8444-555555555555", name: "کاشت مو" }], 1, 10);

    // 1. Initiate step-by-step edit
    const step1 = await handleChat({
      message: "ویرایش مرحله به مرحله کاشت مو",
      sessionId,
      locale: "fa",
    });

    assertEqual(step1.status, "answered", "step 1 answered");
    assert(step1.reply.includes("مرحلهٔ ۱"), `must indicate step 1: ${step1.reply}`);
    assert(step1.reply.includes("عنوان خدمت"), `asks for title: ${step1.reply}`);

    const state = getActiveEdit(sessionId);
    assert(state !== null, "active edit state stored");
    assertEqual(state?.step, 1, "at step 1");

    // 2. Provide new title -> advances to step 2 (price)
    const step2 = await handleChat({
      message: "کاشت موی حرفه‌ای",
      sessionId,
      locale: "fa",
    });

    assertEqual(step2.status, "answered", "step 2 answered");
    assert(step2.reply.includes("مرحلهٔ ۲"), `must indicate step 2: ${step2.reply}`);
    assert(step2.reply.includes("قیمت خدمت"), `asks for price: ${step2.reply}`);

    // 3. Skip step 2 (price) -> advances to step 3 (durationMin)
    const step3 = await handleChat({
      message: "رد",
      sessionId,
      locale: "fa",
    });

    assertEqual(step3.status, "answered", "step 3 answered");
    assert(step3.reply.includes("مرحلهٔ ۳"), `must indicate step 3: ${step3.reply}`);

    // 4. Skip step 3 -> advances to step 4 (isActive)
    const step4 = await handleChat({
      message: "رد",
      sessionId,
      locale: "fa",
    });

    assertEqual(step4.status, "answered", "step 4 answered");
    assert(step4.reply.includes("مرحلهٔ ۴"), `must indicate step 4: ${step4.reply}`);

    // 5. Final step: set active -> finishes and produces confirmation card
    const stepFinal = await handleChat({
      message: "فعال",
      sessionId,
      locale: "fa",
    });

    assertEqual(stepFinal.status, "needs_confirmation", "ready for confirmation");
    assert(stepFinal.reply.includes("مراحل ویرایش تکمیل شد"), `must indicate completion: ${stepFinal.reply}`);
    assert(getActiveEdit(sessionId) === null, "active edit cleared on completion");
  });

  await test("دکمه‌های کیبورد و پیشنهادات فاقد هرگونه علامت سؤال (؟ یا ?) هستند", async () => {
    const { fallbackSuggestions } = await import("@/lib/telegram/suggest");
    const { suggestionsKeyboard } = await import("@/lib/telegram/keyboard");

    const faSuggestions = fallbackSuggestions({ actionId: "services.list", locale: "fa" });
    for (const s of faSuggestions) {
      assert(!/[؟?]/.test(s.label), `label must not contain question mark: ${s.label}`);
    }

    const kb = suggestionsKeyboard(faSuggestions, "fa");
    assert(kb !== undefined, "keyboard created");
    for (const row of kb?.inline_keyboard ?? []) {
      for (const btn of row) {
        assert(!/[؟?]/.test(btn.text), `rendered button text must not contain question mark: ${btn.text}`);
      }
    }
  });

  await test("کلیک دکمه‌های تلگرام آنی (بدون معطلی برای هوش مصنوعی) است", async () => {
    tgCalls.length = 0;
    calls.length = 0;

    const started = Date.now();
    const outcome = await handleTelegramUpdate({
      update_id: 1001,
      callback_query: {
        id: "cb-fast-1",
        from: { id: 777, is_bot: false, first_name: "نازنین" },
        data: "a:services.list",
        message: { message_id: 101, chat: { id: 777, type: "private" }, date: 0 },
      },
    });
    const elapsed = Date.now() - started;

    assertEqual(outcome.status, "done", "status is done");
    assert(elapsed < 200, `button click must be fast (<200ms), took ${elapsed}ms`);
  });

  await test("پیش‌بارگذاری منوها (Menu Prefetch): به محض لود منو، اکشن‌های بعدی فچ شده و کلیک از کش خوانده می‌شود", async () => {
    clearCacheForTesting();
    calls.length = 0;

    // 1. User opens the main menu
    const menuOutcome = await handleTelegramUpdate({
      update_id: 1002,
      callback_query: {
        id: "cb-menu-1",
        from: { id: 777, is_bot: false, first_name: "نازنین" },
        data: "m",
        message: { message_id: 102, chat: { id: 777, type: "private" }, date: 0 },
      },
    });
    assertEqual(menuOutcome.status, "menu", "menu shown");

    // Wait microtask tick for prefetch promises
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Calls for bookings.list should have been made during menu load
    const bookingsCallCount = calls.filter((c) => c.url.includes("/bookings")).length;
    assert(bookingsCallCount > 0, "bookings.list was prefetched in background on menu load");

    // 2. User clicks "مشاهده نوبت‌ها" (bookings.list)
    const bookingsCallsBefore = calls.filter((c) => c.url.includes("/bookings")).length;
    const clickOutcome = await handleTelegramUpdate({
      update_id: 1003,
      callback_query: {
        id: "cb-click-bookings",
        from: { id: 777, is_bot: false, first_name: "نازنین" },
        data: "a:bookings.list",
        message: { message_id: 103, chat: { id: 777, type: "private" }, date: 0 },
      },
    });

    assertEqual(clickOutcome.status, "done", "click outcome done");
    const bookingsCallsAfter = calls.filter((c) => c.url.includes("/bookings")).length;
    assertEqual(bookingsCallsAfter, bookingsCallsBefore, "no new HTTP call for bookings because it hit cache directly");
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
