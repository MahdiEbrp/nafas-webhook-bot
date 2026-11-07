/**
 * STAGE 3 — talk like a human (and like a 10-year-old can follow).
 *
 * A model writes the friendly Persian answer. A deterministic formatter is
 * always computed too, and used when:
 *   • the free-model chain is exhausted,
 *   • the model answer drifts into jargon or is suspiciously short,
 *   • tests run without an API key.
 */

import type { Locale } from "@/lib/config";
import { logWarn } from "@/lib/log";
import { complete } from "@/lib/openrouter/client";
import { joinFa, softenJargon, truncate } from "@/lib/text";

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
  WEBHOOK_UNAUTHORIZED: "کارتِ ورودِ ربات به سیستم قبول نشد. باید نام کاربری و رمز وب‌هوک را در تنظیمات درست کنیم.",
  WEBHOOK_FORBIDDEN: "این کار را برای ربات باز نکرده‌اند. یعنی حسابش اجازهٔ «تغییر دادن» این بخش را ندارد.",
  WEBHOOK_RATE_LIMITED: "الان خیلی درخواست فرستادیم و سیستم گفت یک‌کم صبر کن. چند دقیقه بعد دوباره امتحان کن.",
  WEBHOOK_TIMEOUT: "سیستم اصلی جواب نداد و ما منتظر ماندیم تا وقت تمام شد. یک‌بار دیگر امتحان کن.",
  WEBHOOK_UNREACHABLE: "به سیستم اصلی نرسیدیم. مثل این است که تلفن را گرفته باشیم و کسی گوشی را برندارد.",
  WEBHOOK_NOT_CONFIGURED: "آدرس سیستم اصلی در تنظیمات ربات خالی است؛ اول باید آن را پر کنیم.",
  NOT_FOUND: "چنین چیزی در سیستم نبود. شاید شناسه اشتباه است یا قبلاً پاک شده.",
  VALIDATION_ERROR: "اطلاعاتی که فرستادیم شکل درستی نداشت؛ سیستم قبولش نکرد.",
  WEBHOOK_HTTP_400: "اطلاعات ناقص یا نادرست بود و سیستم قبولش نکرد.",
};

function statusFa(value: unknown): string {
  if (typeof value !== "string") return "نامشخص";
  return STATUS_FA[value] ?? value;
}

function pickArray(data: unknown): { rows: unknown[]; total: number | null } | null {
  if (Array.isArray(data)) return { rows: data, total: data.length };
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
        return { rows: value, total };
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

/** Plain-Persian, zero-AI description of a result. Always available. */
export function fallbackAnswer(input: ExplainInput): string {
  const { outcome, data, errorCode, errorMessage, actionId } = input;

  if (outcome === "error") {
    const friendly = errorCode ? ERROR_FA[errorCode] : undefined;
    const detail = errorMessage ? ` (پیام سیستم: ${truncate(errorMessage, 160)})` : "";
    return `${friendly ?? "یک مشکل پیش آمد و کار انجام نشد."}${detail}\nاگر بخواهی، دوباره امتحان می‌کنم.`;
  }

  const verb = actionId?.endsWith(".delete")
    ? "پاک شد"
    : actionId?.endsWith(".create")
      ? "ساخته شد"
      : actionId?.endsWith(".update") || actionId?.endsWith(".update-status")
        ? "به‌روز شد"
        : null;

  if (verb) {
    return `انجام شد! ✅\nمورد مربوط به «${actionId?.split(".")[0]}» با موفقیت ${verb}.\nاگر بخواهی، الان فهرست را نشانت می‌دهم تا با چشم خودت ببینی.`;
  }

  const list = pickArray(data);
  if (list) {
    if (list.rows.length === 0) {
      return "چیزی پیدا نشد. 🔍\nممکن است در این فیلتر هیچ موردی نباشد؛ فیلتر را بازتر کن یا نام دیگری را امتحان کن.";
    }
    const shown = list.rows.slice(0, 5).map(rowToOneLine).join("\n");
    const more = (list.total ?? list.rows.length) > 5 ? `\n…و ${(list.total ?? 0) - 5} مورد دیگر هم هست.` : "";
    return `بفرما، ${list.total ?? list.rows.length} مورد پیدا کردم:\n${shown}${more}`;
  }

  if (data && typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>)
      .filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value))
      .slice(0, 8);
    if (entries.length > 0) {
      const lines = entries.map(([key, value]) => `• ${key}: ${value === null ? "—" : String(value)}`);
      return `اطلاعات این مورد این است:\n${lines.join("\n")}`;
    }
    return "کار انجام شد، ولی جزئیات زیادی برای گفتن نبود.";
  }

  return "انجام شد. ✅";
}

const JARGON = /\b(endpoint|payload|json|api|http|status code|webhook|schema|uuid|query|request|response)\b/i;

export type Explanation = {
  text: string;
  engine: "ai" | "fallback";
  model: string | null;
  /** the deterministic version, kept for debugging/telemetry */
  fallbackText: string;
};

export async function explain(input: ExplainInput): Promise<Explanation> {
  const fallbackText = fallbackAnswer(input);

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

    // Free models sometimes answer in English or drown the user in jargon.
    // The deterministic version is always correct, so use it when that happens.
    if (text.length < 8 || (input.locale === "fa" && JARGON.test(text) && !/[\u0600-\u06FF]/.test(text))) {
      logWarn("explainer.rejected", { reason: "jargon_or_too_short", model: result.model });
      return { text: fallbackText, engine: "fallback", model: result.model, fallbackText };
    }

    // Strip a leading "خب،" style preamble and markdown bold, keep it clean.
    text = text.replace(/^\s*(خب|باشه)[،,]?\s*/u, "").replace(/\*\*/g, "");

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
      ? "این کار پاک‌کردنی است و برگشتن ندارد."
      : "این کار اطلاعات را تغییر می‌دهد.";
  return [`می‌خواهم این کار را انجام دهم:`, `«${summaryFa}»`, risk, `دسترسی لازم: ${permission}`, "اجازه می‌دهی؟ (بله / نه)"].join("\n");
}

/** Used when the bot genuinely does not know what the user wants. */
export function clarifyText(featureTitles: string[]): string {
  return [
    "دقیقاً نفهمیدم چه کاری می‌خواهی. 🙂",
    "می‌توانم این کارها را انجام دهم:",
    ...featureTitles.map((title) => `• ${title}`),
    "مثلاً بگو: «نوبت‌های امروز را نشان بده» یا «ساعت کاری شنبه را ببین».",
    `اگر منظورت چیز دیگری بود، با کلمه‌های ${joinFa(["نوبت", "خدمت", "کاربر", "تنظیمات"])} شروع کن.`,
  ].join("\n");
}
