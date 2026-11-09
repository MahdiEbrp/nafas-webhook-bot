/**
 * Formatting dates in every calendar the bot speaks.
 *
 * Jalali comes from `date-fns-jalali` (a full date-fns fork whose whole API runs
 * on the Jalali calendar, Persian month and weekday names included). Gregorian
 * comes from plain `date-fns`. Hijri comes from the ICU data behind `Intl`,
 * because neither library implements the Islamic lunar calendar.
 *
 * Cross-checked: for 2026-11-09 in Tehran, date-fns-jalali says 1405/08/18 and
 * `Intl` with `ca-persian` says 8/18/1405 — the same answer from two engines.
 */

import { format as formatGregorian } from "date-fns";
import { format as formatJalali } from "date-fns-jalali";

const PERSIAN_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

export function toPersianDigits(value: string | number): string {
  return String(value).replace(/\d/g, (digit) => PERSIAN_DIGITS[Number(digit)] ?? digit);
}

export function toLatinDigits(value: string): string {
  return value.replace(/[۰-۹]/g, (char) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(char))).replace(/[٠-٩]/g, (char) => String("٠١٢٣٤٥٦٧٨٩".indexOf(char)));
}

/** 1405/08/18 with Persian digits — how Iranians write a date. */
export function jalaliShort(date: Date): string {
  return toPersianDigits(formatJalali(date, "yyyy/MM/dd"));
}

/** سه‌شنبه ۱۸ آبان ۱۴۰۵ */
export function jalaliLong(date: Date): string {
  return `${formatJalali(date, "EEEE")} ${toPersianDigits(formatJalali(date, "d MMMM yyyy"))}`;
}

export function gregorianShort(date: Date): string {
  return formatGregorian(date, "yyyy-MM-dd");
}

export function gregorianLong(date: Date): string {
  return formatGregorian(date, "EEEE, d MMMM yyyy");
}

export function weekdayFa(date: Date): string {
  return formatJalali(date, "EEEE");
}

export function timeOf(date: Date): string {
  return toPersianDigits(formatGregorian(date, "HH:mm"));
}

export function timeWithSeconds(date: Date): string {
  return toPersianDigits(formatGregorian(date, "HH:mm:ss"));
}

/**
 * Hijri (Islamic lunar, Umm al-Qura). Returns null when the runtime has no ICU
 * calendar data, so callers can simply skip it.
 */
export function hijriShort(date: Date, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura-nu-latn", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone,
    }).formatToParts(date);

    const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    const year = pick("year").replace(/\s*AH$/i, "").trim();
    if (!year) return null;
    return `${year}/${pick("month")}/${pick("day")}`;
  } catch {
    return null;
  }
}

const HIJRI_MONTHS_FA = [
  "محرم",
  "صفر",
  "ربیع‌الاول",
  "ربیع‌الثانی",
  "جمادی‌الاول",
  "جمادی‌الثانی",
  "رجب",
  "شعبان",
  "رمضان",
  "شوال",
  "ذی‌القعده",
  "ذی‌الحجه",
];

/** "۲۹ صفر ۱۴۴۸" — the month name comes from the table above, not from ICU. */
export function hijriLong(date: Date, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura-nu-latn", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      timeZone,
    }).formatToParts(date);

    const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "");
    const year = Number(
      (parts.find((part) => part.type === "year")?.value ?? "").replace(/\D/g, ""),
    );
    const month = pick("month");
    const day = pick("day");
    if (!year || !month || !day) return null;
    return `${toPersianDigits(day)} ${HIJRI_MONTHS_FA[month - 1] ?? ""} ${toPersianDigits(year)}`.trim();
  } catch {
    return null;
  }
}

/** A number written the way Persians write counts: ۹ روز */
export function countFa(value: number): string {
  return toPersianDigits(value.toLocaleString("en-US"));
}
