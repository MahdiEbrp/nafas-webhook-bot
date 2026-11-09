/**
 * Reading a date out of a Persian sentence.
 *
 * This is the fiddly part of a Persian date bot: the same string of digits can
 * be Jalali or Gregorian, the day can come before or after the month, and people
 * write «۱۲ مرداد ۱۴۰۳», «1403/05/12», «2024-08-15» and «فردا» expecting the
 * same understanding. So:
 *
 *   1. normalise (Persian digits → ASCII, Arabic letters → Persian)
 *   2. find every date-like span in the sentence, in order
 *   3. classify each span by which calendar it must belong to
 *
 * Classification rule for a bare 4-digit year, which is where mistakes happen:
 *   1200–1799 → Jalali   (1403 is a Persian year; Gregorian 1403 is medieval)
 *   1800–2200 → Gregorian
 * Anything else is rejected rather than guessed.
 */

import {
  addDays,
  isValid,
  parse as parseJalali,
  format as formatJalali,
  startOfDay,
} from "date-fns-jalali";
import { TZDate } from "@date-fns/tz";

import { normalize } from "@/lib/text";

import { configuredZone, nowInZone } from "./timezone";
import { toLatinDigits, toPersianDigits } from "./format";

export type Calendar = "jalali" | "gregorian";

/**
 * Where a date came from decides how much it proves.
 * `explicit` («۱۲ مرداد ۱۴۰۳», «2024-08-15») only appears when the user really
 * is talking about a date. `relative` («دیروز») also shows up in ordinary
 * sentences — «دیروز خیلی خسته بودم» — so on its own it must not turn the
 * message into a date query.
 */
export type DateSource = "explicit" | "relative" | "weekday" | "eid";

export type ParsedDate = {
  /** start of that day, pinned to the configured zone */
  date: TZDate;
  calendar: Calendar;
  /** the slice of the user's sentence we matched */
  raw: string;
  /** how the user referred to it: «امروز», «۱۲ مرداد ۱۴۰۳», … */
  label: string;
  source: DateSource;
};

export const JALALI_MONTHS = [
  "فروردین",
  "اردیبهشت",
  "خرداد",
  "تیر",
  "مرداد",
  "شهریور",
  "مهر",
  "ابان",
  "اذر",
  "دی",
  "بهمن",
  "اسفند",
];

/** Normalised (ZWNJ-stripped) so «پنج‌شنبه» and «پنجشنبه» both match. */
const MONTH_INDEX: Record<string, number> = Object.fromEntries(
  JALALI_MONTHS.map((name, index) => [normalize(name).replace(/\s+/g, ""), index]),
);
// Common misspellings / short forms people actually type.
MONTH_INDEX["اذر"] = 8;
MONTH_INDEX["آذر"] = 8;
MONTH_INDEX["اسفند"] = 11;

const WEEKDAYS: Array<{ name: string; index: number }> = [
  { name: "شنبه", index: 6 }, // Saturday = 6 in date-fns (Sunday = 0)
  { name: "یکشنبه", index: 0 },
  { name: "1شنبه", index: 0 },
  { name: "دوشنبه", index: 1 },
  { name: "سهشنبه", index: 2 },
  { name: "3شنبه", index: 2 },
  { name: "چهارشنبه", index: 4 - 1 },
  { name: "پنجشنبه", index: 4 },
  { name: "جمعه", index: 5 },
];

const RELATIVE_DAYS: Array<{ pattern: RegExp; offset: number; label: string }> = [
  { pattern: /پریروز/, offset: -2, label: "پریروز" },
  { pattern: /دیروز/, offset: -1, label: "دیروز" },
  { pattern: /پسفردا/, offset: 2, label: "پس‌فردا" },
  { pattern: /فردا/, offset: 1, label: "فردا" },
  { pattern: /امروز|امروزه/, offset: 0, label: "امروز" },
];

const GREGORIAN_MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10,
  december: 11, dec: 11,
};

/** Prepares a sentence for matching: Persian digits → ASCII, ZWNJ gone, lower-case. */
export function prepare(text: string): string {
  return normalize(text).toLowerCase().replace(/\u200c/g, "");
}

function jalaliYearOf(reference: TZDate): number {
  return Number(formatJalali(reference, "yyyy"));
}

/** True when y/m/d is a real Jalali date (rejects 1403/07/31 and friends). */
export function isValidJalali(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const parsed = parseJalali(`${year}/${month}/${day}`, "yyyy/M/d", new Date());
  if (!isValid(parsed)) return false;
  return formatJalali(parsed, "yyyy/M/d") === `${year}/${month}/${day}`;
}

function isValidGregorian(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const parsed = new TZDate(year, month - 1, day, configuredZone());
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

function jalaliDate(year: number, month: number, day: number): TZDate | null {
  if (!isValidJalali(year, month, day)) return null;
  const parsed = parseJalali(`${year}/${month}/${day}`, "yyyy/M/d", new Date());
  return startOfDay(new TZDate(parsed.getTime(), configuredZone())) as TZDate;
}

function gregorianDate(year: number, month: number, day: number): TZDate | null {
  if (!isValidGregorian(year, month, day)) return null;
  return startOfDay(new TZDate(year, month - 1, day, configuredZone())) as TZDate;
}

type Candidate = {
  index: number;
  length: number;
  raw: string;
  label: string;
  date: TZDate;
  calendar: Calendar;
  source: DateSource;
};

function classifyYear(year: number): Calendar | null {
  if (year >= 1200 && year <= 1799) return "jalali";
  if (year >= 1800 && year <= 2200) return "gregorian";
  return null;
}

/**
 * Every date mentioned in `text`, in the order they appear.
 * `reference` is "now" in the configured zone — relative words depend on it.
 */
export function extractDates(text: string, reference: TZDate = nowInZone()): ParsedDate[] {
  const input = prepare(text);
  const found: Candidate[] = [];
  const taken = new Array<boolean>(input.length).fill(false);

  const claim = (index: number, length: number): boolean => {
    for (let i = index; i < index + length; i += 1) {
      if (taken[i]) return false;
    }
    for (let i = index; i < index + length; i += 1) taken[i] = true;
    return true;
  };

  const push = (candidate: Candidate): void => {
    if (claim(candidate.index, candidate.length)) {
      found.push(candidate);
    }
  };

  /* ── 1. Numeric dates: 1403/05/12 · 12/05/1403 · 2024-08-15 · 1403.5.12 ── */
  const numeric = /(\d{3,4})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,4})|(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4})/g;
  for (const match of input.matchAll(numeric)) {
    const index = match.index ?? 0;
    const raw = match[0];
    const numbers = (match[1] ? [match[1], match[2], match[3]] : [match[6], match[5], match[4]]).map(Number);
    const [a, b, c] = numbers as [number, number, number];

    // Year first: 1403/05/12 or 2024-08-15
    const firstAsCalendar = classifyYear(a);
    if (firstAsCalendar === "jalali") {
      const date = jalaliDate(a, b, c);
      if (date) {
        push({ index, length: raw.length, raw, label: toPersianDigits(raw.replace(/[-.]/g, "/")), date, calendar: "jalali", source: "explicit" });
        continue;
      }
    }
    if (firstAsCalendar === "gregorian") {
      const date = gregorianDate(a, b, c);
      if (date) {
        push({ index, length: raw.length, raw, label: raw.replace(/\//g, "-"), date, calendar: "gregorian", source: "explicit" });
        continue;
      }
    }

    // Day first: 12/05/1403 or 15/08/2024
    const lastAsCalendar = classifyYear(c);
    if (lastAsCalendar === "jalali") {
      const date = jalaliDate(c, b, a);
      if (date) {
        push({ index, length: raw.length, raw, label: toPersianDigits(`${c}/${b}/${a}`), date, calendar: "jalali", source: "explicit" });
        continue;
      }
    }
    if (lastAsCalendar === "gregorian") {
      const date = gregorianDate(c, b, a);
      if (date) {
        push({ index, length: raw.length, raw, label: `${c}-${b}-${a}`, date, calendar: "gregorian", source: "explicit" });
      }
    }
  }

  /* ── 2. «۱۲ مرداد ۱۴۰۳» / «مرداد ۱۴۰۳» / «۱۲ مرداد» ─────────────────── */
  const monthNames = Object.keys(MONTH_INDEX).sort((x, y) => y.length - x.length).join("|");
  const withMonth = new RegExp(`(\\d{1,2})\\s*(${monthNames})(?:\\s*(\\d{4}))?|(${monthNames})\\s*(\\d{4})`, "g");
  for (const match of input.matchAll(withMonth)) {
    const index = match.index ?? 0;
    const raw = match[0];
    const day = Number(match[1]);
    const nameFromDayForm = match[2];
    const yearFromDayForm = match[3];
    const nameFromYearForm = match[4];
    const yearFromNameForm = match[5];

    const monthName = nameFromDayForm ?? nameFromYearForm;
    const monthIndex = monthName ? MONTH_INDEX[monthName.replace(/\s+/g, "")] : undefined;
    if (monthIndex === undefined) continue;

    const year = Number(yearFromDayForm ?? yearFromNameForm ?? String(jalaliYearOf(reference)));
    if (!Number.isFinite(year)) continue;

    // «مرداد ۱۴۰۳» with no day → the first of that month.
    const effectiveDay = Number.isFinite(day) && day > 0 ? day : 1;
    const date = jalaliDate(year, monthIndex + 1, effectiveDay);
    if (!date) continue;

    const label = Number.isFinite(day) && day > 0
      ? `${toPersianDigits(effectiveDay)} ${monthName} ${toPersianDigits(year)}`
      : `${monthName} ${toPersianDigits(year)}`;
    push({ index, length: raw.length, raw, label, date, calendar: "jalali", source: "explicit" });
  }

  /* ── 3. English month names → Gregorian ──────────────────────────────── */
  const englishMonths = Object.keys(GREGORIAN_MONTHS).sort((x, y) => y.length - x.length).join("|");
  const english = new RegExp(`(\\d{1,2})\\s+(${englishMonths})(?:,?\\s+(\\d{4}))?|(${englishMonths})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?`, "g");
  for (const match of input.matchAll(english)) {
    const index = match.index ?? 0;
    const raw = match[0];
    const name = (match[2] ?? match[4] ?? "").toLowerCase();
    const monthIndex = GREGORIAN_MONTHS[name];
    if (monthIndex === undefined) continue;

    const day = Number(match[1] ?? match[5]);
    const effectiveYear = Number(match[3] ?? match[6] ?? reference.getFullYear());
    if (!Number.isFinite(day) || day <= 0) continue;

    const date = gregorianDate(effectiveYear, monthIndex + 1, day);
    if (!date) continue;
    // The label is rebuilt from the parts, because `raw` comes from the
    // lower-cased form of the sentence.
    const prettyMonth = name.charAt(0).toUpperCase() + name.slice(1);
    push({
      index,
      length: raw.length,
      raw,
      label: `${day} ${prettyMonth} ${effectiveYear}`,
      date,
      calendar: "gregorian",
      source: "explicit",
    });
  }

  /* ── 4. Relative words ───────────────────────────────────────────────── */
  for (const entry of RELATIVE_DAYS) {
    const match = entry.pattern.exec(input);
    if (!match) continue;
    const index = match.index;
    const date = addDays(startOfDay(reference), entry.offset) as TZDate;
    push({ index, length: match[0].length, raw: match[0], label: entry.label, date, calendar: "jalali", source: "relative" });
  }

  /* ── 5. Bare weekday names → the next one (today if it is that day) ──── */
  const weekdaysLongestFirst = [...WEEKDAYS].sort((a, b) => b.name.length - a.name.length);
  for (const entry of weekdaysLongestFirst) {
    const name = entry.name.replace(/\s+/g, "");
    const index = input.indexOf(name);
    if (index === -1) continue;
    // Skip it when the weekday is part of a longer date we already matched.
    const today = reference.getDay();
    const delta = (entry.index - today + 7) % 7;
    const date = addDays(startOfDay(reference), delta) as TZDate;
    push({ index, length: name.length, raw: name, label: `${entry.name}`, date, calendar: "jalali", source: "weekday" });
  }

  /* ── 6. «عید» / «نوروز» → 1 Farvardin ────────────────────────────────── */
  const eid = /(عید|نوروز)/.exec(input);
  if (eid) {
    const year = jalaliYearOf(reference);
    const thisYear = jalaliDate(year, 1, 1);
    const nextYear = jalaliDate(year + 1, 1, 1);
    const date = thisYear && thisYear.getTime() >= startOfDay(reference).getTime() ? thisYear : nextYear;
    if (date) {
      push({ index: eid.index, length: eid[0].length, raw: eid[0], label: "نوروز", date, calendar: "jalali", source: "eid" });
    }
  }

  /* ── 2b. A bare year on its own: «۱۴۰۳ کبیسه است؟», «سال ۱۴۰۳» ──────── */
  const bareYear = /(?:^|[\s(«])((?:1[2-7]\d{2})|(?:1[89]\d{2}|2[012]\d{2}))(?=[\s)».,!?:;]|$)/g;
  for (const match of input.matchAll(bareYear)) {
    const index = (match.index ?? 0) + (match[0].length - (match[1]?.length ?? match[0].length));
    const year = Number(match[1]);
    const calendar = classifyYear(year);
    const date = calendar === "jalali" ? jalaliDate(year, 1, 1) : gregorianDate(year, 1, 1);
    if (!date) continue;
    push({
      index,
      length: (match[1] ?? "").length,
      raw: match[1] ?? "",
      label: `سال ${toPersianDigits(year)}`,
      date,
      calendar: calendar ?? "jalali",
      source: "explicit",
    });
  }

  return found
    .sort((a, b) => a.index - b.index)
    .map(({ date, calendar, raw, label, source }) => ({ date, calendar, raw, label, source }));
}
