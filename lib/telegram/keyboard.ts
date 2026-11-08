/**
 * Inline keyboards + the callback-data protocol.
 *
 * Telegram allows only 64 bytes of `callback_data`, so the wire format is a
 * one-letter prefix plus an id:
 *
 *   m            → open the menu
 *   h            → show what I can do (text)
 *   f:<feature>  → list that feature's read actions
 *   a:<action>   → run that action
 *   c:<token>    → confirm a pending write
 *   x:<token>    → cancel a pending write
 *
 * A uuid token is 36 chars, so `c:<uuid>` = 38 bytes — safe.
 */

import type { InlineKeyboard, ReplyKeyboardMarkup, TelegramButton } from "@/lib/telegram/api";
import { FEATURES, getFeature, getAction } from "@/lib/features/manifest";
import type { Locale } from "@/lib/config";
import type { Suggestion } from "@/lib/telegram/suggest";

const MAX_CALLBACK_BYTES = 64;

export type ParsedCallback =
  | { kind: "menu" }
  | { kind: "help" }
  | { kind: "feature"; featureId: string }
  | { kind: "action"; actionId: string }
  | { kind: "page"; actionId: string; page: number }
  | { kind: "confirm"; token: string; approve: boolean }
  | { kind: "text"; text: string }
  | { kind: "unknown"; raw: string };

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function button(text: string, callbackData: string): TelegramButton | null {
  if (byteLength(callbackData) > MAX_CALLBACK_BYTES) return null;
  return { text, callback_data: callbackData };
}

/** Builds rows of max 2 buttons, dropping anything Telegram would reject. */
function grid(buttons: Array<TelegramButton | null>, perRow = 2): TelegramButton[][] {
  const valid = buttons.filter((entry): entry is TelegramButton => entry !== null);
  const rows: TelegramButton[][] = [];
  for (let index = 0; index < valid.length; index += perRow) rows.push(valid.slice(index, index + perRow));
  return rows;
}

function t(locale: Locale, fa: string, en: string): string {
  return locale === "en" ? en : fa;
}

export function parseCallback(data: string): ParsedCallback {
  const raw = data.trim();
  if (raw === "m") return { kind: "menu" };
  if (raw === "h") return { kind: "help" };

  const [prefix, ...rest] = raw.split(":");
  const value = rest.join(":");

  if (prefix === "p" && value) {
    const parts = value.split(":");
    return { kind: "page", actionId: parts[0] ?? "", page: Math.max(1, Number(parts[1] ?? 1)) };
  }
  if (prefix === "f" && value) return { kind: "feature", featureId: value };
  if (prefix === "a" && value) return { kind: "action", actionId: value };
  if (prefix === "c" && value) return { kind: "confirm", token: value, approve: true };
  if (prefix === "x" && value) return { kind: "confirm", token: value, approve: false };
  if (prefix === "t" && value) return { kind: "text", text: value };

  return { kind: "unknown", raw };
}

/* ─────────────────────────────── keyboards ───────────────────────────── */

export function suggestionsKeyboard(suggestions: Suggestion[], locale: Locale): InlineKeyboard | undefined {
  const buttons: Array<TelegramButton | null> = [];

  for (const suggestion of suggestions) {
    const cleanLabel = suggestion.label.replace(/[؟?]+$/, "").trim();
    if (suggestion.page) {
      buttons.push(button(cleanLabel, `p:${suggestion.page.actionId}:${suggestion.page.page}`));
    } else if (suggestion.actionId) {
      buttons.push(button(cleanLabel, `a:${suggestion.actionId}`));
    } else if (suggestion.command === "menu") {
      buttons.push(button(cleanLabel, "m"));
    } else if (suggestion.command === "features") {
      buttons.push(button(cleanLabel, "h"));
    } else if (cleanLabel) {
      buttons.push(button(cleanLabel, `t:${cleanLabel}`));
    }
  }

  const rows = grid(buttons, 2);
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

export function confirmationKeyboard(token: string, locale: Locale): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        button(t(locale, "✅ بله، انجام بده", "✅ Yes, do it"), `c:${token}`) ?? { text: "✅", callback_data: "c" },
        button(t(locale, "❌ نه، لغو", "❌ No, cancel"), `x:${token}`) ?? { text: "❌", callback_data: "x" },
      ],
    ],
  };
}

/**
 * The "login without a password" button.
 *
 * Telegram shows a native "Share my phone number" prompt. The number it sends is
 * the one already verified for that account (Telegram SMS-verified it at signup),
 * and it cannot be somebody else's — see `verifyContact`.
 */
export function contactRequestKeyboard(locale: Locale): ReplyKeyboardMarkup {
  return {
    keyboard: [[{ text: t(locale, "📱 ارسال شمارهٔ من", "📱 Share my phone number"), request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
    input_field_placeholder: t(locale, "برای ورود، شماره‌ات را بفرست", "Tap the button to sign in"),
  };
}

export function menuKeyboard(locale: Locale): InlineKeyboard {
  const features = FEATURES.filter((feature) => feature.available);
  const buttons: Array<TelegramButton | null> = features.map((feature) =>
    button(`${featureEmoji(feature.id)} ${t(locale, feature.titleFa, feature.titleEn)}`, `f:${feature.id}`),
  );
  buttons.push(button(t(locale, "❓ راهنما", "❓ Help"), "h"));

  return { inline_keyboard: grid(buttons, 2) };
}

export function featureKeyboard(featureId: string, locale: Locale): InlineKeyboard | undefined {
  const feature = getFeature(featureId);
  if (!feature) return undefined;

  // Include reads and non-destructive writes (create, update) so staff can directly view or edit/create!
  const actions = feature.actions.filter(
    (action) => action.danger !== "destructive" && (!action.path.includes(":id") || action.id.endsWith(".update")),
  );
  const buttons: Array<TelegramButton | null> = actions.map((action) => {
    const prefix = action.id.endsWith(".update") ? "✏️ " : action.id.endsWith(".create") ? "➕ " : "▫️ ";
    return button(`${prefix}${t(locale, action.fa, action.en)}`, `a:${action.id}`);
  });
  buttons.push(button(t(locale, "⬅️ منو", "⬅️ Menu"), "m"));

  const rows = grid(buttons, 1);
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

function featureEmoji(featureId: string): string {
  const map: Record<string, string> = {
    bookings: "📋",
    "working-hours": "🕘",
    services: "🛍",
    "service-categories": "🗂",
    "service-groups": "📦",
    users: "👥",
    settings: "⚙️",
    rules: "📜",
    "care-guides": "💚",
    "care-guide-items": "📝",
    sms: "✉️",
  };
  return map[featureId] ?? "▫️";
}

/** Human-readable label for an action, used in replies. */
export function actionLabel(actionId: string, locale: Locale): string {
  const found = getAction(actionId);
  if (!found) return actionId;
  return t(locale, found.action.fa, found.action.en);
}
