/**
 * STAGE 3 — talk like a human (and like a 10-year-old can follow).
 *
 * A model writes the friendly Persian answer. A deterministic formatter is
 * always computed too, and used when:
 *   • the free-model chain is exhausted,
 *   • the model answer drifts into jargon or is suspiciously short,
 *   • tests run without an API key.
 */

import { getConfig, type Locale } from "@/lib/config";
import { logWarn } from "@/lib/log";
import { complete } from "@/lib/openrouter/client";
import { joinFa, softenJargon, truncate, truncateAtSentence } from "@/lib/text";

import { EXPLAINER_SYSTEM_EN, EXPLAINER_SYSTEM_FA, explainerUserPrompt, type ExplainInput } from "./prompt";

const STATUS_FA: Record<string, string> = {
  pending: "در انتظار پرداخت",
  paid: "پرداخت‌شده",
  waiting: "در انتظار",
  done: "انجام‌شده",
  refunded: "برگشت‌خورده",
  active: "فعال",
  inactive: "غیرفعال",
  banned: "مسدود",
};

const ERROR_FA: Record<string, string> = {
  WEBHOOK_UNAUTHORIZED: "اعتبارنامهٔ دسترسی به سیستم تأیید نشد. لطفاً نام کاربری و رمز وب‌هوک را بررسی کنید.",
  WEBHOOK_FORBIDDEN: "حساب ربات اجازهٔ دسترسی به این بخش را ندارد. لطفاً با مدیر کلینیک هماهنگ کنید تا مجوز لازم را فعال کند.",
  WEBHOOK_RATE_LIMITED: "تعداد درخواست‌ها بیشتر از حد مجاز است. لطفاً چند لحظه بعد مجدداً امتحان کنید.",
  WEBHOOK_TIMEOUT: "پاسخی از سرور کلینیک دریافت نشد و مهلت درخواست به پایان رسید. لطفاً مجدداً تلاش کنید.",
  WEBHOOK_UNREACHABLE: "امکان برقراری ارتباط با سرور کلینیک وجود ندارد. لطفاً اتصال سرور را بررسی کنید.",
  WEBHOOK_NOT_CONFIGURED: "آدرس سرور کلینیک در تنظیمات سیستم مشخص نشده است.",
  NOT_FOUND: "موردی با این مشخصات در سیستم یافت نشد.",
  VALIDATION_ERROR: "اطلاعات ارسالی با فرمت مورد انتظار سیستم همخوانی نداشت.",
  WEBHOOK_HTTP_400: "اطلاعات ارسالی ناقص یا نامعتبر بود و توسط سیستم پذیرفته نشد.",
};

function statusFa(value: unknown): string {
  if (typeof value !== "string") return "نامشخص";
  return STATUS_FA[value] ?? value;
}

export type PickedList = {
  rows: unknown[];
  total: number | null;
  page: number;
  perPage: number;
};

export function pickArray(data: unknown): PickedList | null {
  if (Array.isArray(data)) return { rows: data, total: data.length, page: 1, perPage: 10 };
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["items", "rows", "results", "list", "data", "bookings", "services", "users"]) {
      const value = record[key];
      if (Array.isArray(value)) {
        const total =
          typeof record.total === "number"
            ? record.total
            : typeof record.count === "number"
              ? record.count
              : value.length;
        const page = typeof record.page === "number" && record.page > 0 ? record.page : 1;
        const perPage = typeof record.perPage === "number" && record.perPage > 0 ? record.perPage : 10;
        return { rows: value, total, page, perPage };
      }
    }
  }
  return null;
}

const DAY_FA: Record<string, string> = {
  Saturday: "شنبه",
  Sunday: "یکشنبه",
  Monday: "دوشنبه",
  Tuesday: "سه‌شنبه",
  Wednesday: "چهارشنبه",
  Thursday: "پنجشنبه",
  Friday: "جمعه",
};

/** Reads `translations.fa.title` / `.name` without trusting the shape. */
function faText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const fa = (value as Record<string, unknown>).fa;
  if (!fa || typeof fa !== "object") return null;
  const record = fa as Record<string, unknown>;
  for (const key of ["title", "name", "question"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return null;
}

/**
 * One human line per row. Tuned for the row shapes this project actually gets:
 * bookings (name+status+phone), working hours (day+times+capacity),
 * services (title+price), settings (key+value), users (name+role).
 */
function rowToOneLine(row: unknown, index: number): string {
  if (row === null || typeof row !== "object") return `${index + 1}. ${String(row)}`;
  const record = row as Record<string, unknown>;

  const translated = faText(record.translations);
  const dayLabel = typeof record.day === "string" ? DAY_FA[record.day] ?? record.day : undefined;

  const humanName =
    record.fullName ??
    translated ??
    record.title ??
    record.name ??
    record.key ??
    record.email ??
    record.slug ??
    dayLabel;

  // A bare uuid helps nobody; show a short prefix only when there is nothing else.
  const name =
    humanName ??
    (typeof record.id === "string" ? `${record.id.slice(0, 8)}…` : undefined);

  const parts: string[] = [String(name ?? "بدون نام")];

  if (dayLabel && humanName !== dayLabel) parts.push(dayLabel);
  if (typeof record.opens === "string" && typeof record.closes === "string") {
    parts.push(`از ${record.opens} تا ${record.closes}`);
  }
  if (typeof record.capacity === "number") parts.push(`ظرفیت ${record.capacity} نفر`);
  if (record.status !== undefined) parts.push(statusFa(record.status));
  if (typeof record.phone === "string") parts.push(record.phone);
  if (typeof record.price === "number") parts.push(`${record.price.toLocaleString("fa-IR")} تومان`);
  if (typeof record.roleKey === "string") parts.push(record.roleKey);
  if (!name && record.value !== undefined) parts.push(String(record.value));

  return `${index + 1}. ${parts.join(" — ")}`;
}

const FEATURE_NAMES_FA: Record<string, string> = {
  bookings: "نوبت",
  "working-hours": "ساعت کاری",
  services: "خدمت",
  "service-categories": "دسته‌بندی",
  "service-groups": "گروه خدمات",
  users: "کاربر",
  settings: "تنظیمات",
  rules: "قانون",
  "care-guides": "راهنمای مراقبت",
  "care-guide-items": "آیتم راهنما",
};

/** Plain-Persian, zero-AI description of a result. Always available. */
export function fallbackAnswer(input: ExplainInput): string {
  const { outcome, data, errorCode, errorMessage, actionId } = input;

  if (outcome === "error") {
    const friendly = errorCode ? ERROR_FA[errorCode] : undefined;
    const detail = errorMessage ? ` (پیام سیستم: ${truncate(errorMessage, 160)})` : "";
    return `${friendly ?? "عملیات با خطا مواجه شد."}${detail}\nدر صورت تمایل می‌توانید دوباره امتحان کنید.`;
  }

  const verb = actionId?.endsWith(".delete")
    ? "حذف شد"
    : actionId?.endsWith(".create")
      ? "ثبت شد"
      : actionId?.endsWith(".update") || actionId?.endsWith(".update-status")
        ? "به‌روزرسانی شد"
        : null;

  if (verb) {
    const featureId = actionId?.split(".")[0] ?? "";
    const itemName = FEATURE_NAMES_FA[featureId] ?? "مورد";
    return `بفرما، ${itemName} با موفقیت ${verb}. ✅`;
  }

  const list = pickArray(data);
  if (list) {
    if (list.rows.length === 0) {
      return "چیزی پیدا نشد. 🔍\nموردی با این مشخصات در سیستم ثبت نشده است.";
    }
    const page = list.page ?? 1;
    const perPage = list.perPage ?? 10;
    const count = list.total ?? list.rows.length;

    let displayRows = list.rows;
    let startIndex = (page - 1) * perPage;
    if (list.rows.length > perPage) {
      displayRows = list.rows.slice(startIndex, startIndex + perPage);
      if (displayRows.length === 0 && list.rows.length > 0) {
        displayRows = list.rows.slice(0, perPage);
        startIndex = 0;
      }
    } else if (list.rows.length <= perPage && page === 1) {
      startIndex = 0;
    }

    const shown = displayRows.map((row, i) => rowToOneLine(row, startIndex + i)).join("\n");
    const remaining = count - (startIndex + displayRows.length);

    let pageHeader = ":";
    if (count > perPage) {
      const totalPages = Math.ceil(count / perPage);
      pageHeader = ` (مرحلهٔ ${page} از ${totalPages} — صفحهٔ ${page} از ${totalPages}):`;
    }

    let more = "";
    if (remaining > 0) {
      more = `\n\n…و ${remaining} مورد دیگر هم هست (می‌توانید بنویسید «صفحه بعد» یا از دکمه‌های مرحلهٔ بعد استفاده کنید).`;
    }

    return `بفرما، ${count} مورد پیدا کردم${pageHeader}\n${shown}${more}`;
  }

  if (data && typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>)
      .filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value))
      .slice(0, 8);
    if (entries.length > 0) {
      const lines = entries.map(([key, value]) => `• ${key}: ${value === null ? "—" : String(value)}`);
      return `بفرما، اطلاعات این مورد را پیدا کردم:\n${lines.join("\n")}`;
    }
    return "بفرما، عملیات با موفقیت انجام شد. ✅";
  }

  return "بفرما، عملیات انجام شد. ✅";
}

const JARGON = /\b(endpoint|payload|json|api|http|status code|webhook|schema|uuid|query|request|response)\b/i;

/**
 * Free models sometimes answer with their working-out instead of an answer:
 *
 *   Analyze the Request:
 *   * Role: Friendly clinic assistant …
 *   * Input Data: …
 *   2. Drafting the Response (Iterative Process):
 *   * Attempt 1 …
 *
 * A clinic's receptionist must never see that, and the text is usually cut off
 * mid-token by `max_tokens` anyway. One strong marker — or several weak ones —
 * means the whole answer is discarded and the deterministic text is used.
 */
const STRONG_REASONING_MARKERS: RegExp[] = [
  /analy[sz]e the request/i,
  /drafting the response/i,
  /iterative process/i,
  /chain[-\s]of[-\s]thought/i,
  /تحلیل درخواست/,
  /پیش‌نویس پاسخ/,
  // echoes of our own prompt — the model talking to itself, not to the user
  /کاربر گفته بود\s*[:"]/,
  /اکشنی که اجرا شد/,
  /دادهٔ خام/,
];

const WEAK_REASONING_MARKERS: RegExp[] = [
  /input data/i,
  /\battempt\s*\d+\b/i,
  /\bstep\s*\d+\s*:/i,
  /^\s*[-*•]\s*\*{0,2}(role|language|constraints|input data)\b/im,
  /\*{0,2}(role|constraints)\*{0,2}\s*:\s*\S/i,
  /^\s*\d+\.\s*(drafting|refining|analy[sz]ing)/im,
];

/** True when the model answered with its scaffolding rather than an answer. */
export function looksLikeReasoningDump(text: string): boolean {
  if (STRONG_REASONING_MARKERS.some((pattern) => pattern.test(text))) return true;
  return WEAK_REASONING_MARKERS.filter((pattern) => pattern.test(text)).length >= 2;
}

/** An answer longer than this stops being a chat message and becomes a wall. */
const MAX_REPLY_CHARS = 1200;


export type Explanation = {
  text: string;
  engine: "ai" | "fallback";
  model: string | null;
  /** the deterministic version, kept for debugging/telemetry */
  fallbackText: string;
};

export async function explain(input: ExplainInput): Promise<Explanation> {
  const fallbackText = fallbackAnswer(input);
  const config = getConfig();

  // Fast templated mode: skip OpenRouter completely for instant, 100% reliable responses.
  // Enabled by default ("instance of AI use Templated base like بفرما ... پیدا کردم its faster").
  if (config.useTemplateExplainer) {
    return { text: fallbackText, engine: "fallback", model: null, fallbackText };
  }

  try {
    const result = await complete({
      messages: [
        { role: "system", content: input.locale === "en" ? EXPLAINER_SYSTEM_EN : EXPLAINER_SYSTEM_FA },
        { role: "user", content: explainerUserPrompt(input) },
      ],
      temperature: 0.4,
      maxTokens: 500,
    });

    let text = softenJargon(result.content.trim());

    // `finish_reason: "length"` means max_tokens ran out and the last word is
    // half-written (production saw "…سه‌شنبه و چهارشن"). Not an answer → drop it.
    if (result.finishReason === "length") {
      logWarn("explainer.rejected", { reason: "truncated", model: result.model, chars: text.length });
      return { text: fallbackText, engine: "fallback", model: result.model, fallbackText };
    }

    // The model answered with its own reasoning ("Analyze the Request: …").
    if (looksLikeReasoningDump(text)) {
      logWarn("explainer.rejected", { reason: "reasoning_dump", model: result.model, chars: text.length });
      return { text: fallbackText, engine: "fallback", model: result.model, fallbackText };
    }

    // Free models sometimes answer in English or drown the user in jargon.
    // The deterministic version is always correct, so use it when that happens.
    if (text.length < 8 || (input.locale === "fa" && JARGON.test(text) && !/[\u0600-\u06FF]/.test(text))) {
      logWarn("explainer.rejected", { reason: "jargon_or_too_short", model: result.model });
      return { text: fallbackText, engine: "fallback", model: result.model, fallbackText };
    }

    // Strip a leading "خب،" style preamble and markdown bold, keep it clean.
    text = text.replace(/^\s*(خب|باشه)[،,]?\s*/u, "").replace(/\*\*/g, "");

    // Keep a runaway monologue out of the chat, and never end mid-word.
    text = truncateAtSentence(text, MAX_REPLY_CHARS).trim();

    return { text, engine: "ai", model: result.model, fallbackText };
  } catch (error) {
    logWarn("explainer.fallback", { message: (error as Error).message });
    return { text: fallbackText, engine: "fallback", model: null, fallbackText };
  }
}

/** Persian one-liner used in confirmation cards. */
export function confirmationText(summaryFa: string, danger: string, permission: string): string {
  const risk =
    danger === "destructive"
      ? "⚠️ توجه: این عملیات اطلاعات را حذف می‌کند و قابل بازگشت نیست."
      : "ℹ️ این عملیات اطلاعات ثبت‌شده در سیستم را تغییر می‌دهد.";
  return [
    "درخواست ثبت تغییرات:",
    `«${summaryFa}»`,
    risk,
    `دسترسی لازم: ${permission}`,
    "آیا این مورد تأیید است؟ (بله / نه)",
  ].join("\n");
}

/** Used when the bot genuinely does not know what the user wants. */
export function clarifyText(featureTitles: string[]): string {
  return [
    "درخواست شما دقیقاً مشخص نبود. لطفاً بفرمایید کدام بخش را می‌خواهید بررسی کنیم: 🙂",
    ...featureTitles.map((title) => `• ${title}`),
    "برای نمونه می‌توانید بنویسید: «نوبت‌های امروز را نشان بده» یا «ساعت کاری شنبه‌ها».",
  ].join("\n");
}
