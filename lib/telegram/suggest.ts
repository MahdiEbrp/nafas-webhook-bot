/**
 * AI-POWERED BUTTONS & SUGGESTIONS
 *
 * After every answer the bot asks a free model: "what would this user sensibly
 * press next?" The model returns short Persian labels + an action id, and we
 * turn that into a real inline keyboard.
 *
 * Safety rules (same philosophy as the planner):
 *   • a suggestion must map to a real action in the manifest,
 *   • destructive actions are never suggested (no "حذف کن" button),
 *   • labels are capped in length so a phone screen still looks sane,
 *   • if the model fails, we generate suggestions deterministically.
 */

import { getConfig, type Locale } from "@/lib/config";
import { FEATURES, getAction } from "@/lib/features/manifest";
import { logWarn } from "@/lib/log";
import { complete, parseJsonLoose } from "@/lib/openrouter/client";
import { featureTitleList } from "@/lib/bot/features-answer";

export type Suggestion = {
  label: string;
  /** action to run when pressed */
  actionId?: string;
  /** OR a built-in command: menu | features | cancel */
  command?: "menu" | "features" | "cancel";
  /** pagination command */
  page?: { actionId: string; page: number };
  /** why the bot offers this (shown as a hint line) */
  reason?: string;
};

const MAX_SUGGESTIONS = 4;
const MAX_LABEL = 32;

function clean(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const trimmed = label.replace(/\s+/g, " ").trim();
  if (trimmed.length < 2) return null;
  return trimmed.length > MAX_LABEL ? `${trimmed.slice(0, MAX_LABEL - 1)}…` : trimmed;
}

/** Formats a clean button label: removes question marks and standardizes labels. */
export function cleanButtonLabel(label: string, locale: Locale): string {
  let trimmed = label.trim();
  if (/^(🏠\s*)?(منو|menu)$/i.test(trimmed)) {
    return locale === "en" ? "🏠 Back to menu" : "🏠 بازگشت به منو";
  }
  // Strip trailing question marks (؟ and ?) as requested by user
  trimmed = trimmed.replace(/[؟?]+$/, "").trim();
  return trimmed;
}

/** Backward compatibility alias */
export const ensureQuestion = cleanButtonLabel;

/** Non-destructive actions (reads and writes) may become buttons. Destructive actions (delete) are excluded. */
function isSuggestable(actionId: string): boolean {
  const found = getAction(actionId);
  if (!found) return false;
  if (found.action.danger === "destructive") return false;
  return true;
}

/**
 * Tips that only describe the keyboard the user is already looking at are
 * noise — production once shipped "💡 برای دیدن اطلاعات بیشتر، می‌توانی روی هر
 * کدام از این گزینه‌ها ضربه بزنی" right after a broken answer. Drop them.
 */
const BUTTON_FILLER: RegExp[] = [
  /ضربه\s+بزن/,
  /کلیک\s+کن/,
  /روی\s+(هر\s+کدام|یکی)\s+از\s+(این\s+)?(گزینه|دکمه)/,
  /(گزینه|دکمه)\s*های?\s+(زیر|بالا)/,
  /\b(tap|click)\s+(one|any|a|the)\b/i,
  /\bbuttons?\s+below\b/i,
];

function isUsefulTip(tip: string): boolean {
  const trimmed = tip.trim();
  if (trimmed.length <= 3) return false;
  return !BUTTON_FILLER.some((pattern) => pattern.test(trimmed));
}

export function defaultTip(actionId?: string | null): string {
  if (!actionId) return "";
  if (actionId.startsWith("services")) {
    return "برای تغییر قیمت یا مشخصات هر مورد، کافیست نام یا شمارهٔ آن را بنویسید (مثلاً: «قیمت دی می رو ۷ میلیون کن» یا «شماره ۱ رو غیرفعال کن»).";
  }
  if (actionId.startsWith("bookings")) {
    return "برای تغییر هر نوبت، کافیست نام یا شمارهٔ آن را بگویید (مثلاً: «نوبت مریم رو انجام‌شده کن» یا «شماره ۲ رو لغو کن»).";
  }
  if (actionId.startsWith("working-hours")) {
    return "برای تغییر ساعت یا ظرفیت هر روز، کافیست بنویسید (مثلاً: «ساعت شنبه از ۹ تا ۱۹ باشه»).";
  }
  return "";
}

/* ───────────────────────── deterministic fallback ───────────────────── */

const FOLLOW_UPS: Record<string, Suggestion[]> = {
  bookings: [
    { label: "✏️ تغییر وضعیت نوبت", actionId: "bookings.update" },
    { label: "➕ ثبت نوبت جدید", actionId: "bookings.create" },
    { label: "📋 همهٔ نوبت‌ها", actionId: "bookings.list" },
  ],
  services: [
    { label: "✏️ ویرایش قیمت یا خدمت", actionId: "services.update" },
    { label: "➕ ثبت خدمت جدید", actionId: "services.create" },
    { label: "🛍 لیست کامل خدمات", actionId: "services.list" },
    { label: "🗂 بررسی دسته‌بندی‌ها", actionId: "service-categories.list" },
  ],
  "working-hours": [
    { label: "✏️ تغییر ساعت یا ظرفیت", actionId: "working-hours.update" },
    { label: "➕ ثبت شیفت جدید", actionId: "working-hours.create" },
    { label: "🕘 ساعت‌های کاری", actionId: "working-hours.list" },
  ],
  users: [
    { label: "➕ ثبت کاربر جدید", actionId: "users.create" },
    { label: "👥 لیست کاربران", actionId: "users.list" },
  ],
  settings: [
    { label: "✏️ تغییر تنظیمات", actionId: "settings.update" },
    { label: "⚙️ لیست تنظیمات", actionId: "settings.list" },
  ],
  rules: [
    { label: "➕ ثبت قانون جدید", actionId: "rules.create" },
    { label: "📜 قوانین کلینیک", actionId: "rules.list" },
  ],
  "care-guides": [
    { label: "➕ ثبت راهنمای مراقبت", actionId: "care-guides.create" },
    { label: "💚 راهنماهای مراقبت", actionId: "care-guides.list" },
  ],
  "care-guide-items": [
    { label: "➕ ثبت آیتم راهنما", actionId: "care-guide-items.create" },
    { label: "📝 آیتم‌های راهنما", actionId: "care-guide-items.list" },
  ],
  "service-categories": [
    { label: "➕ ثبت دسته‌بندی", actionId: "service-categories.create" },
    { label: "🗂 لیست دسته‌بندی‌ها", actionId: "service-categories.list" },
  ],
  "service-groups": [
    { label: "➕ ثبت گروه خدمات", actionId: "service-groups.create" },
    { label: "📦 گروه‌های خدمات", actionId: "service-groups.list" },
  ],
};

export function fallbackSuggestions(context: { actionId?: string | null; locale: Locale; hadError?: boolean }): Suggestion[] {
  if (context.locale === "en") {
    return [
      { label: "📋 View bookings", actionId: "bookings.list" },
      { label: "🛍 Check services", actionId: "services.list" },
      { label: "🏠 Back to menu", command: "menu" },
    ];
  }

  if (context.hadError) {
    return [
      { label: "🔄 دوباره امتحان کنم", actionId: context.actionId ?? "bookings.list" },
      { label: "🏠 بازگشت به منو", command: "menu" },
    ];
  }

  const featureId = context.actionId?.split(".")[0];
  const own = featureId ? FOLLOW_UPS[featureId] ?? [] : [];
  const generic: Suggestion[] = [
    { label: "📋 مشاهدهٔ نوبت‌ها", actionId: "bookings.list" },
    { label: "🛍 بررسی خدمات", actionId: "services.list" },
    { label: "🕘 ساعت کاری کلینیک", actionId: "working-hours.list" },
    { label: "🏠 بازگشت به منو", command: "menu" },
  ];

  // One button per actionId: two different labels for the same call is just noise.
  const seen = new Set<string>();
  const merged = [...own, ...generic].filter((suggestion) => {
    if (!isSuggestable(suggestion.actionId ?? "")) return false;
    const key = suggestion.actionId ?? suggestion.command ?? "";
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const limited = merged.slice(0, MAX_SUGGESTIONS);
  // A way back to the menu is never optional.
  const home: Suggestion = {
    label: "🏠 بازگشت به منو",
    command: "menu",
  };
  if (!limited.some((suggestion) => suggestion.command === "menu")) {
    return [...limited.slice(0, MAX_SUGGESTIONS - 1), home];
  }
  return limited;
}

/* ────────────────────────────── AI version ──────────────────────────── */

const SYSTEM_FA = `تو کمک می‌کنی کاربرِ یک ربات اداری کلینیک، قدم بعدی را انتخاب کند.
بر اساس «آنچه کاربر گفت» و «نتیجه‌ای که گرفت»، حداکثر ۳ دکمهٔ مفید پیشنهاد بده (هم مشاهده و هم ویرایش/ثبت مجاز است).

قواعد:
1. فقط JSON برگردان: {"suggestions":[{"label":"...","actionId":"..."}],"tip":"یک راهنمای کوتاه"}
2. actionId باید دقیقاً از این فهرست باشد:
{FIELDS}
3. عنوان دکمه‌ها (label) را حتماً بدون علامت سؤال (بدون ؟ یا ?) بنویس. عنوان‌ها باید خبری، کوتاه (حداکثر ۴ کلمه) و با یک ایموجی در اول باشد.
مثال‌ها:
- "✏️ ویرایش قیمت یا خدمت"
- "➕ ثبت خدمت جدید"
- "📋 مشاهدهٔ نوبت‌ها"
- "🕘 ساعت‌های کاری"
4. اکشن‌های مخرب مانند حذف (delete) پیشنهاد نده. هیچ actionId از خودت نساز.
5. اگر پیشنهاد خوبی نداری، آرایهٔ خالی بده.
6. tip: یک راهنمای کوتاه و کاربردی به پرسنل کلینیک بده (مثلاً: «برای ویرایش قیمت کافیست بنویسید: قیمت دی می رو ۷ میلیون کن»)، یا خالی بگذار.`;

const SYSTEM_EN = `Suggest up to 3 useful next-step buttons for a clinic admin bot.
Reply with JSON only: {"suggestions":[{"label":"...","actionId":"..."}],"tip":""}
actionId must be one of these actions: {FIELDS}
Write labels as short, clean phrases WITHOUT question marks (e.g. "✏️ Edit service", "➕ Add booking", "📋 View bookings"). One emoji at the start. Never suggest deletes.`;

export function suggestableActionIds(): string[] {
  return FEATURES.flatMap((feature) => feature.actions)
    .filter((action) => isSuggestable(action.id))
    .map((action) => action.id);
}

export async function suggestNext(input: {
  userMessage: string;
  actionId?: string | null;
  status: string;
  replyPreview: string;
  locale: Locale;
  hadError?: boolean;
}): Promise<{ suggestions: Suggestion[]; tip: string; engine: "ai" | "fallback" }> {
  const fallback = fallbackSuggestions({ actionId: input.actionId, locale: input.locale, hadError: input.hadError });
  const fallbackTip = defaultTip(input.actionId);

  // Never spend a model call on an obvious dead end.
  if (!getConfig().openrouterApiKey) {
    return { suggestions: fallback, tip: fallbackTip, engine: "fallback" };
  }

  const system = (input.locale === "en" ? SYSTEM_EN : SYSTEM_FA).replace("{FIELDS}", suggestableActionIds().join(", "));
  const user = [
    `کاربر گفت: """${input.userMessage}"""`,
    `اکشن: ${input.actionId ?? "—"}`,
    `وضعیت: ${input.status}`,
    `خلاصهٔ جواب: ${input.replyPreview.slice(0, 400)}`,
  ].join("\n");

  try {
    const result = await complete({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      json: true,
      temperature: 0.3,
      maxTokens: 300,
    });

    const parsed = parseJsonLoose<{ suggestions?: unknown[]; tip?: unknown }>(result.content);
    const raw = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];

    const cleaned: Suggestion[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const rawLabel = clean(record.label);
      const actionId = typeof record.actionId === "string" ? record.actionId.trim() : "";
      if (!rawLabel || !isSuggestable(actionId)) continue;
      const label = ensureQuestion(rawLabel, input.locale);
      if (cleaned.some((suggestion) => suggestion.actionId === actionId && suggestion.label === label)) continue;
      cleaned.push({ label, actionId });
    }

    if (cleaned.length === 0) {
      return { suggestions: fallback, tip: fallbackTip, engine: "fallback" };
    }

    // Always leave the user a way home.
    if (!cleaned.some((suggestion) => suggestion.command === "menu")) {
      cleaned.push({
        label: input.locale === "en" ? "🏠 Back to menu?" : "🏠 به منو برگردیم؟",
        command: "menu",
      });
    }

    const rawTip = typeof parsed.tip === "string" ? parsed.tip.trim().slice(0, 160) : "";
    return { suggestions: cleaned.slice(0, MAX_SUGGESTIONS), tip: isUsefulTip(rawTip) ? rawTip : "", engine: "ai" };
  } catch (error) {
    logWarn("telegram.suggest_fallback", { message: error instanceof Error ? error.message : "unknown" });
    return { suggestions: fallback, tip: fallbackTip, engine: "fallback" };
  }
}

/** One-line Persian hint published above the keyboard (optional). */
export function tipLine(tip: string): string {
  return tip ? `\n\n💡 ${tip}` : "";
}

export function featureMenuButtons(locale: Locale): Array<{ label: string; featureId: string }> {
  return FEATURES.filter((feature) => feature.available).map((feature) => ({
    label: locale === "en" ? feature.titleEn : feature.titleFa,
    featureId: feature.id,
  }));
}

export function featureTitles(locale: Locale): string[] {
  return featureTitleList(locale);
}
