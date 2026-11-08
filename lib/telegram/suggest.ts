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
  /** why the bot offers this (shown as a hint line) */
  reason?: string;
};

const MAX_SUGGESTIONS = 4;
const MAX_LABEL = 28;

function clean(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const trimmed = label.replace(/\s+/g, " ").trim();
  if (trimmed.length < 2) return null;
  return trimmed.length > MAX_LABEL ? `${trimmed.slice(0, MAX_LABEL - 1)}…` : trimmed;
}

/** Only read-ish, non-destructive actions may become buttons. */
function isSuggestable(actionId: string): boolean {
  const found = getAction(actionId);
  if (!found) return false;
  if (found.action.danger !== "read") return false;
  // "get one by id" makes a poor button: the user has no id to give.
  return !found.action.path.includes(":id");
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

/* ───────────────────────── deterministic fallback ───────────────────── */

const FOLLOW_UPS: Record<string, Suggestion[]> = {
  bookings: [
    { label: "📋 همهٔ نوبت‌ها", actionId: "bookings.list" },
  ],
  services: [
    { label: "🛍 لیست خدمات", actionId: "services.list" },
    { label: "🗂 دسته‌بندی‌ها", actionId: "service-categories.list" },
  ],
  "working-hours": [{ label: "🕘 ساعت‌های کاری", actionId: "working-hours.list" }],
  users: [{ label: "👥 کاربران", actionId: "users.list" }],
  settings: [{ label: "⚙️ تنظیمات", actionId: "settings.list" }],
  rules: [{ label: "📜 قوانین", actionId: "rules.list" }],
  "care-guides": [{ label: "💚 راهنمای مراقبت", actionId: "care-guides.list" }],
  "care-guide-items": [{ label: "📝 آیتم‌های راهنما", actionId: "care-guide-items.list" }],
  "service-categories": [{ label: "🗂 دسته‌بندی‌ها", actionId: "service-categories.list" }],
  "service-groups": [{ label: "📦 گروه‌های خدمات", actionId: "service-groups.list" }],
};

export function fallbackSuggestions(context: { actionId?: string | null; locale: Locale; hadError?: boolean }): Suggestion[] {
  if (context.locale === "en") {
    return [
      { label: "📋 Bookings", actionId: "bookings.list" },
      { label: "🛍 Services", actionId: "services.list" },
      { label: "🏠 Menu", command: "menu" },
    ];
  }

  if (context.hadError) {
    return [
      { label: "🔄 دوباره امتحان کن", actionId: context.actionId ?? "bookings.list" },
      { label: "🏠 منو", command: "menu" },
    ];
  }

  const featureId = context.actionId?.split(".")[0];
  const own = featureId ? FOLLOW_UPS[featureId] ?? [] : [];
  const generic: Suggestion[] = [
    { label: "📋 نوبت‌ها", actionId: "bookings.list" },
    { label: "🛍 خدمات", actionId: "services.list" },
    { label: "🕘 ساعت کاری", actionId: "working-hours.list" },
    { label: "🏠 منو", command: "menu" },
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
  const home: Suggestion = { label: "🏠 منو", command: "menu" };
  if (!limited.some((suggestion) => suggestion.command === "menu")) {
    return [...limited.slice(0, MAX_SUGGESTIONS - 1), home];
  }
  return limited;
}

/* ────────────────────────────── AI version ──────────────────────────── */

const SYSTEM_FA = `تو کمک می‌کنی کاربرِ یک ربات اداری کلینیک، قدم بعدی را انتخاب کند.
بر اساس «آنچه کاربر گفت» و «نتیجه‌ای که گرفت»، حداکثر ۳ دکمهٔ مفید پیشنهاد بده.

قواعد:
1. فقط JSON برگردان: {"suggestions":[{"label":"...","actionId":"..."}],"tip":"یک جملهٔ کوتاه"}
2. actionId باید دقیقاً از این فهرست باشد و فقط اکشن‌های خواندن (read) مجازند:
{FIELDS}
3. label کوتاه، فارسیِ محاوره‌ای، حداکثر ۳ کلمه، با یک ایموجی در اول. مثال: "📋 همهٔ نوبت‌ها"
4. هیچ پیشنهاد حذف/تغییر نده. هیچ actionId از خودت نساز.
5. اگر پیشنهاد خوبی نداری، آرایهٔ خالی بده.
6. tip: اگر نکتهٔ مفیدی داری بگو، وگرنه رشتهٔ خالی.`;

const SYSTEM_EN = `Suggest up to 3 useful next-step buttons for a clinic admin bot.
Reply with JSON only: {"suggestions":[{"label":"...","actionId":"..."}],"tip":""}
actionId must be one of these read-only actions: {FIELDS}
Short labels with one emoji. Never suggest deletes or edits.`;

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

  // Never spend a model call on an obvious dead end.
  if (!getConfig().openrouterApiKey) {
    return { suggestions: fallback, tip: "", engine: "fallback" };
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
      const label = clean(record.label);
      const actionId = typeof record.actionId === "string" ? record.actionId.trim() : "";
      if (!label || !isSuggestable(actionId)) continue;
      if (cleaned.some((suggestion) => suggestion.actionId === actionId && suggestion.label === label)) continue;
      cleaned.push({ label, actionId });
    }

    if (cleaned.length === 0) {
      return { suggestions: fallback, tip: "", engine: "fallback" };
    }

    // Always leave the user a way home.
    if (!cleaned.some((suggestion) => suggestion.command === "menu")) {
      cleaned.push({ label: input.locale === "en" ? "🏠 Menu" : "🏠 منو", command: "menu" });
    }

    const rawTip = typeof parsed.tip === "string" ? parsed.tip.trim().slice(0, 160) : "";
    return { suggestions: cleaned.slice(0, MAX_SUGGESTIONS), tip: isUsefulTip(rawTip) ? rawTip : "", engine: "ai" };
  } catch (error) {
    logWarn("telegram.suggest_fallback", { message: error instanceof Error ? error.message : "unknown" });
    return { suggestions: fallback, tip: "", engine: "fallback" };
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
