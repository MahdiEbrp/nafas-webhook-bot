/**
 * The phone gate.
 *
 * The owner's rule: before any message is answered, be sure the chat has a phone
 * number on file. If it does not, ask for it — through Telegram's own contact
 * button, so the number arrives from their Telegram account rather than from
 * their thumbs.
 *
 * The number is kept as `09XXXXXXXXX`, Iranian mobiles only. Anything else is
 * refused with a reason the user can act on, and they are asked again.
 *
 * Deliberately a separate module: the gate is a policy, the handler is routing,
 * and mixing them would bury the one inside the other.
 */

import type { Locale } from "@/lib/config";
import { logInfo, logWarn } from "@/lib/log";
import {
  displayPhone,
  normalizeIranPhone,
  phoneRejectionMessage,
  type PhoneRejection,
} from "@/lib/phone";
import { phoneFor, setChatPhone } from "@/lib/db/chat-sessions";
import type { TelegramContact } from "@/lib/telegram/api";

export type GateOutcome =
  /** number on file; the handler may answer the message */
  | { pass: true; phone: string }
  /** the gate is not in force; the handler may answer the message */
  | { pass: true; phone: null; skipped: "disabled" | "no-database" }
  /** we asked, or refused, or just saved the number; the handler must stop */
  | { pass: false; status: string };

/** What the gate needs in order to ask in the right way. */
export type GateInput = {
  chatId: number;
  /** Telegram only offers the contact button in a private chat */
  chatType: string;
  text: string;
  contact?: TelegramContact;
  /** `message.from.id`, so we can tell their own number from somebody else's */
  fromId?: number;
  locale: Locale;
  /** sends a line to the user; keeps this module free of the transport */
  say: (text: string, options?: { replyMarkup?: Record<string, unknown> }) => Promise<void>;
  /** builds the "share your number" keyboard, or null when unavailable */
  keyboard: () => Record<string, unknown> | null;
};

const ASK_PRIVATE = {
  fa:
    "سلام! پیش از هر چیز، شمارهٔ موبایلت را لازم دارم. 📱\n" +
    "روی دکمهٔ زیر بزن تا شماره‌ات از خودِ تلگرام فرستاده شود، یا همین‌جا تایپش کن (مثلاً ۰۹۱۲۱۲۳۴۵۶۷).\n" +
    "فقط شمارهٔ موبایل ایران را قبول می‌کنم.",
  en:
    "Hi! Before anything else I need your mobile number. 📱\n" +
    "Tap the button below to share it straight from Telegram, or just type it here (e.g. 09121234567).\n" +
    "I only accept Iranian mobile numbers.",
} satisfies Record<Locale, string>;

const ASK_TYPED = {
  fa:
    "سلام! پیش از هر چیز، شمارهٔ موبایلت را لازم دارم. 📱\n" +
    "شماره‌ات را همین‌جا بنویس، مثلاً ۰۹۱۲۱۲۳۴۵۶۷.\n" +
    "فقط شمارهٔ موبایل ایران را قبول می‌کنم.",
  en:
    "Hi! Before anything else I need your mobile number. 📱\n" +
    "Please write it here, e.g. 09121234567.\n" +
    "I only accept Iranian mobile numbers.",
} satisfies Record<Locale, string>;

/** «شماره‌ات را گرفتم: ۰۹۱۲۱۲۳۴۵۶۷» — shared with the handler. */
export function confirmPhoneText(locale: Locale, phone: string): string {
  const shown = displayPhone(phone);
  return locale === "en"
    ? `Got your number: ${shown} ✅ Now ask me anything.`
    : `شماره‌ات را گرفتم: ${shown} ✅ حالا هر چه می‌خواهی بپرس.`;
}

/**
 * Runs the gate for one incoming message.
 *
 * `pass: true` means "answer the message". `pass: false` means "this message was
 * about the phone number, and we already replied".
 *
 * Nothing here throws. A database that is down reads as "no number yet", which
 * is the same answer as a brand-new user and is handled the same way — the worst
 * a failing database can do is make the bot ask again.
 */
export async function ensurePhone(input: GateInput): Promise<GateOutcome> {
  const { chatId, chatType, locale, say, keyboard } = input;

  const existing = await phoneFor(chatId);
  if (existing) return { pass: true, phone: existing };

  /* ── they shared a contact through the Telegram button ─────────────── */
  if (input.contact?.phone_number) {
    return await acceptNumber({ ...input, raw: input.contact.phone_number });
  }

  /* ── they typed something ──────────────────────────────────────────── */
  if (input.text) {
    const check = normalizeIranPhone(input.text);
    // A number typed where the gate is waiting is an answer to the question, so
    // it is worth accepting. Anything that is not a number is a question asked
    // too early, and the ask is the reply.
    if (check.ok) return await acceptNumber({ ...input, raw: input.text });
    if (check.reason !== "empty" && /\d/.test(input.text)) {
      // There were digits and they did not add up — say why, then ask again.
      await say(phoneRejectionMessage(check.reason, locale), {
        ...(chatType === "private" && keyboard() ? { replyMarkup: keyboard()! } : {}),
      });
      logInfo("phone.rejected", { chatId, reason: check.reason, source: "typed" });
      return { pass: false, status: `phone-rejected:${check.reason}` };
    }
  }

  /* ── otherwise: ask ────────────────────────────────────────────────── */
  const markup = chatType === "private" ? keyboard() : null;
  await say(markup ? ASK_PRIVATE[locale] : ASK_TYPED[locale], {
    ...(markup ? { replyMarkup: markup } : {}),
  });
  logInfo("phone.asked", { chatId, chatType, withKeyboard: markup !== null });
  return { pass: false, status: "phone-required" };
}

/** Validates one raw number and stores it, telling the user what happened. */
async function acceptNumber(input: GateInput & { raw: string }): Promise<GateOutcome> {
  const { chatId, locale, say, keyboard, chatType } = input;

  const check = normalizeIranPhone(input.raw);
  if (!check.ok) {
    const reason: PhoneRejection = check.reason;
    // A one-time keyboard is gone once tapped, so hand it back rather than
    // leaving them with nothing to press.
    const markup = chatType === "private" ? keyboard() : null;
    await say(phoneRejectionMessage(reason, locale), {
      ...(markup ? { replyMarkup: markup } : {}),
    });
    logWarn("phone.rejected", { chatId, reason, source: "contact" });
    return { pass: false, status: `phone-rejected:${reason}` };
  }

  const saved = await setChatPhone(chatId, check.normalized);
  if (!saved) {
    // The write did not land. Asking again is better than pretending: a number
    // we cannot store is a number we do not have.
    await say(phoneRejectionMessage("not-iranian-mobile", locale));
    logWarn("phone.save_failed", { chatId });
    return { pass: false, status: "phone-save-failed" };
  }

  // Telegram tells us whether the shared card was really theirs.
  const sharedSelf =
    input.contact?.user_id === undefined || input.contact.user_id === input.fromId;
  if (!sharedSelf) {
    logWarn("phone.contact_not_self", { chatId, contactUserId: input.contact?.user_id });
  }

  await say(confirmPhoneText(locale, check.normalized), { replyMarkup: { remove_keyboard: true } });
  logInfo("phone.saved", { chatId, sharedSelf });
  return { pass: false, status: "phone-saved" };
}
