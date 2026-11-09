/**
 * Iranian mobile numbers: read them, normalise them, refuse anything else.
 *
 * The stored form is always `09XXXXXXXXX` — eleven digits, no country code,
 * exactly as the owner asked. Everything else (a Telegram contact share, a
 * number typed with Persian digits, `+98…`, `0098…`, spaces and dashes) is
 * rewritten to that one shape or rejected.
 *
 * Why a separate module: phone handling is pure string work with a long list of
 * inputs that must all land on the same answer, and the Telegram layer should
 * not carry that table. It is also the only place the "Iran only" rule lives, so
 * widening it later is a one-file change.
 */

import { toPersianDigits } from "@/lib/dates/format";

/** `09` followed by nine digits. This is the whole "is it Iranian" rule. */
export const IRAN_MOBILE = /^09\d{9}$/;

/** How many digits a stored Iranian mobile has. */
export const IRAN_MOBILE_LENGTH = 11;

export type PhoneRejection =
  /** nothing usable in the input at all */
  | "empty"
  /** digits were there, but fewer than an Iranian mobile */
  | "too-short"
  /** digits were there, but more than an Iranian mobile */
  | "too-long"
  /** right length, but not `09…` — a landline, a foreign number, a typo */
  | "not-iranian-mobile";

export type PhoneCheck =
  | { ok: true; normalized: string }
  | { ok: false; reason: PhoneRejection };

/**
 * Persian and Arabic-Indic digits to ASCII.
 *
 * Not a nicety: a Persian speaker very often types `۰۹۱۲۱۲۳۴۵۶۷`, and without
 * this their own number reads as garbage. `String.replace` with a digit class
 * catches both ranges in two passes.
 */
export function toAsciiDigits(input: string): string {
  return input
    .replace(/[۰-۹]/g, (char) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(char)))
    .replace(/[٠-٩]/g, (char) => String("٠١٢٣٤٥٦٧٨٩".indexOf(char)));
}

/**
 * Reads a phone number in any shape and answers with the stored form.
 *
 * Order matters in here:
 *   1. digits first, so `+98 (912) 123-4567` and `۰۹۱۲…` are already plain
 *   2. `00` international prefix, then `98` country code, then a leading `0`
 *   3. a bare `9XXXXXXXXX` (10 digits) gets its `0` back
 *   4. only then is the result checked against `09\d{9}`
 *
 * Step 3 runs before the check because `9121234567` is how people say their
 * number out loud, and rejecting it would be pedantry.
 */
export function normalizeIranPhone(input: string): PhoneCheck {
  const digits = toAsciiDigits(input ?? "").replace(/\D/g, "");

  if (digits.length === 0) return { ok: false, reason: "empty" };

  let local = digits;

  // `0098…` and `98…` are both the country code. Strip whichever is present,
  // but only when what is left is a plausible mobile — otherwise `98` is part
  // of somebody's number and we must not eat it.
  if (local.startsWith("0098")) local = local.slice(4);
  else if (local.startsWith("980")) local = local.slice(2);
  else if (local.startsWith("98") && local.length === 12) local = local.slice(2);

  // `9121234567` → `09121234567`
  if (local.length === IRAN_MOBILE_LENGTH - 1 && local.startsWith("9")) local = `0${local}`;

  if (local.length < IRAN_MOBILE_LENGTH) return { ok: false, reason: "too-short" };
  if (local.length > IRAN_MOBILE_LENGTH) return { ok: false, reason: "too-long" };
  if (!IRAN_MOBILE.test(local)) return { ok: false, reason: "not-iranian-mobile" };

  return { ok: true, normalized: local };
}

/** True when the string is already in stored form. Used before re-writing. */
export function isStoredPhone(value: string | null | undefined): boolean {
  return typeof value === "string" && IRAN_MOBILE.test(value);
}

/** `09121234567` → `۰۹۱۲۱۲۳۴۵۶۷`, for showing the number back to the user. */
export function displayPhone(value: string): string {
  return toPersianDigits(value);
}

/**
 * What to tell the user when their number was refused, in their language.
 *
 * The messages stay concrete — «this is a landline» beats «invalid input»,
 * because the user can then fix it themselves without another round trip.
 */
export function phoneRejectionMessage(reason: PhoneRejection, locale: "fa" | "en"): string {
  if (locale === "en") {
    switch (reason) {
      case "empty":
        return "I could not find a phone number in that. Send it as 09121234567.";
      case "too-short":
        return "That number is too short. An Iranian mobile is 11 digits, like 09121234567.";
      case "too-long":
        return "That number is too long. An Iranian mobile is 11 digits, like 09121234567.";
      case "not-iranian-mobile":
        return "That does not look like an Iranian mobile. I only accept numbers starting with 09, like 09121234567.";
    }
  }
  switch (reason) {
    case "empty":
      return "شماره‌ای در پیام‌ات پیدا نکردم. شماره‌ات را مثل ۰۹۱۲۱۲۳۴۵۶۷ بفرست.";
    case "too-short":
      return "این شماره کوتاه است. شمارهٔ موبایل ایران ۱۱ رقم است، مثلاً ۰۹۱۲۱۲۳۴۵۶۷.";
    case "too-long":
      return "این شماره بلند است. شمارهٔ موبایل ایران ۱۱ رقم است، مثلاً ۰۹۱۲۱۲۳۴۵۶۷.";
    case "not-iranian-mobile":
      return "این شماره، موبایل ایران به نظر نمی‌رسد. فقط شماره‌هایی که با ۰۹ شروع می‌شوند را قبول می‌کنم، مثلاً ۰۹۱۲۱۲۳۴۵۶۷.";
  }
}
