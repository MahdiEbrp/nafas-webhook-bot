/**
 * The date engine — every calendar operation the bot can do, in one place.
 *
 * One rule runs through this file: **month and year arithmetic uses the
 * `date-fns-jalali` build, never plain `date-fns`.** Measured, not assumed:
 *
 *   addMonths(1403/01/31, +6)  →  date-fns says 1403/07/28 (it stepped six
 *                                  *Gregorian* months and then clamped)
 *                              →  date-fns-jalali says 1403/07/30 ✓
 *   eachMonthOfInterval(1403/01/01…1403/03/31)
 *                              →  date-fns yields 1402/12, 1403/01… (wrong)
 *                              →  date-fns-jalali yields 1403/01, 02, 03 ✓
 *
 * Day and week arithmetic is pure instant math, so either build agrees there.
 *
 * Every function returns both structured facts and a ready-made Persian
 * sentence (`summary`). The bot shows the model the facts and asks it to phrase
 * them naturally; if the model fails or garbles a number, `summary` is what the
 * user gets. A date answer is never lost because the model had a bad day.
 */

import {
  isLeapYear as isLeapYearGregorian,
  getDaysInMonth as getDaysInMonthGregorian,
  setMonth,
} from "date-fns";
import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  differenceInCalendarMonths,
  differenceInCalendarWeeks,
  differenceInCalendarYears,
  eachDayOfInterval,
  eachMonthOfInterval,
  endOfYear,
  getDaysInMonth,
  intervalToDuration,
  isLeapYear,
  subDays,
  subMonths,
} from "date-fns-jalali";
import type { TZDate } from "@date-fns/tz";
import type { Duration } from "date-fns-jalali";

import {
  countFa,
  gregorianLong,
  gregorianShort,
  hijriLong,
  hijriShort,
  jalaliLong,
  jalaliShort,
  timeWithSeconds,
  toPersianDigits,
  weekdayFa,
} from "./format";
import { configuredZone, nowInZone, zoneLabel } from "./timezone";
import type { ParsedDate } from "./parse";

export type DateIntent = "now" | "describe" | "convert" | "between" | "range" | "add" | "monthLength" | "leapYear";

export type DateView = {
  /** how the user referred to it: «امروز», «۱۲ مرداد ۱۴۰۳», … */
  label: string;
  jalali: string;
  jalaliLong: string;
  gregorian: string;
  gregorianLong: string;
  hijri: string | null;
  hijriLong: string | null;
  weekday: string;
};

export type DateFacts = {
  intent: DateIntent;
  /** deterministic Persian answer — the safety net behind the model */
  summary: string;
  zone: string;
  dates: DateView[];
  days?: number;
  weeks?: number;
  months?: number;
  years?: number;
  /** breakdown from intervalToDuration: { years, months, days, … } */
  parts?: Duration;
  range?: string[];
  rangeTotal?: number;
  rangeTruncated?: boolean;
  time?: string;
  daysInMonth?: number;
  isLeap?: boolean;
};

/** Never list more days than this; beyond it we summarise instead. */
const MAX_LISTED_DAYS = 31;

export function viewOf(date: TZDate, label: string): DateView {
  const zone = configuredZone();
  return {
    label,
    jalali: jalaliShort(date),
    jalaliLong: jalaliLong(date),
    gregorian: gregorianShort(date),
    gregorianLong: gregorianLong(date),
    hijri: hijriShort(date, zone),
    hijriLong: hijriLong(date, zone),
    weekday: weekdayFa(date),
  };
}

function calendarLine(view: DateView): string {
  const parts = [`میلادی: ${view.gregorianLong}`];
  if (view.hijriLong) parts.push(`قمری: ${view.hijriLong}`);
  return parts.join(" · ");
}

/* ─────────────────────────────── operations ─────────────────────────────── */

export function nowFacts(now: Date = new Date()): DateFacts {
  const instant = nowInZone(now);
  const view = viewOf(instant, "الان");

  return {
    intent: "now",
    zone: zoneLabel(),
    time: timeWithSeconds(instant),
    dates: [view],
    summary: `الان ${view.jalaliLong} است، ساعت ${timeWithSeconds(instant)} ${zoneLabel()}. (${calendarLine(view)})`,
  };
}

export function describeFacts(parsed: ParsedDate): DateFacts {
  const view = viewOf(parsed.date, parsed.label);

  return {
    intent: "describe",
    zone: zoneLabel(),
    dates: [view],
    summary: `${view.jalaliLong}\n${calendarLine(view)}`,
  };
}

export function convertFacts(parsed: ParsedDate): DateFacts {
  const view = viewOf(parsed.date, parsed.label);

  return {
    intent: "convert",
    zone: zoneLabel(),
    dates: [view],
    summary: [
      `${parsed.label} برابر است با:`,
      `• شمسی: ${view.jalaliLong} (${view.jalali})`,
      `• میلادی: ${view.gregorianLong} (${view.gregorian})`,
      `• قمری: ${view.hijriLong ?? view.hijri ?? "—"}`,
    ].join("\n"),
  };
}

export function betweenFacts(first: ParsedDate, second: ParsedDate): DateFacts {
  // Order-independent: «بین X و Y» must not return a negative count.
  const [earlier, later] =
    first.date.getTime() <= second.date.getTime() ? [first, second] : [second, first];

  const days = differenceInCalendarDays(later.date, earlier.date);
  const parts = intervalToDuration({ start: earlier.date, end: later.date });

  // «امروز (۱۴۰۵/۰۸/۱۸)» helps; «۱۴۰۳/۰۱/۰۱ (۱۴۰۳/۰۱/۰۱)» is just noise.
  const withLabel = (parsed: ParsedDate): string => {
    const short = jalaliShort(parsed.date);
    return parsed.label === short || parsed.label.replace(/[/-]/g, "/") === short.replace(/[/-]/g, "/")
      ? short
      : `${parsed.label} (${short})`;
  };

  const breakdown: string[] = [];
  if (parts.years) breakdown.push(`${countFa(parts.years)} سال`);
  if (parts.months) breakdown.push(`${countFa(parts.months)} ماه`);
  if (parts.days) breakdown.push(`${countFa(parts.days)} روز`);

  return {
    intent: "between",
    zone: zoneLabel(),
    dates: [viewOf(earlier.date, earlier.label), viewOf(later.date, later.label)],
    days,
    weeks: differenceInCalendarWeeks(later.date, earlier.date),
    months: differenceInCalendarMonths(later.date, earlier.date),
    years: differenceInCalendarYears(later.date, earlier.date),
    parts,
    summary:
      days === 0
        ? `${earlier.label} و ${later.label} همان یک روز هستند: ${viewOf(earlier.date, "").jalaliLong}`
        : `از ${withLabel(earlier)} تا ${withLabel(later)} ${countFa(days)} روز فاصله است` +
          (breakdown.length > 0 ? ` — یعنی ${breakdown.join(" و ")}.` : "."),
  };
}

export function rangeFacts(first: ParsedDate, second: ParsedDate): DateFacts {
  const [start, end] = first.date.getTime() <= second.date.getTime() ? [first, second] : [second, first];
  const all = eachDayOfInterval({ start: start.date, end: end.date });
  const listed = all.slice(0, MAX_LISTED_DAYS).map((day) => {
    const date = day as TZDate;
    return `${weekdayFa(date)} ${jalaliShort(date)} (${gregorianShort(date)})`;
  });

  return {
    intent: "range",
    zone: zoneLabel(),
    dates: [viewOf(start.date, start.label), viewOf(end.date, end.label)],
    range: listed,
    rangeTotal: all.length,
    rangeTruncated: all.length > listed.length,
    days: all.length,
    summary:
      `از ${start.label} تا ${end.label} ${countFa(all.length)} روز است.` +
      (all.length > listed.length
        ? ` فقط ${countFa(listed.length)} روز اول را می‌نویسم: ${listed[0]} … ${listed[listed.length - 1]}`
        : `\n${listed.join("\n")}`),
  };
}

export function addFacts(parsed: ParsedDate, amount: number, unit: "day" | "week" | "month" | "year"): DateFacts {
  const sign = amount < 0 ? -1 : 1;
  const value = Math.abs(amount);

  const shift = (input: TZDate, times: number): TZDate => {
    const stepped = sign > 0 ? times : -times;
    switch (unit) {
      case "week":
        return addDays(input, stepped * 7) as TZDate;
      case "month":
        return addMonths(input, stepped) as TZDate;
      case "year":
        return addMonths(input, stepped * 12) as TZDate;
      default:
        return addDays(input, stepped) as TZDate;
    }
  };

  const result = shift(parsed.date, value);
  const view = viewOf(result, "");
  const unitFa = { day: "روز", week: "هفته", month: "ماه", year: "سال" }[unit];

  return {
    intent: "add",
    zone: zoneLabel(),
    dates: [viewOf(parsed.date, parsed.label), view],
    days: differenceInCalendarDays(result, parsed.date),
    summary: `${countFa(value)} ${unitFa} ${sign > 0 ? "بعد از" : "قبل از"} ${parsed.label} (${viewOf(parsed.date, "").jalali}) می‌شود ${view.jalaliLong}. (${calendarLine(view)})`,
  };
}

export function monthLengthFacts(parsed: ParsedDate): DateFacts {
  const days = getDaysInMonth(parsed.date);
  const view = viewOf(parsed.date, parsed.label);

  return {
    intent: "monthLength",
    zone: zoneLabel(),
    dates: [view],
    daysInMonth: days,
    summary: `این ماه ${countFa(days)} روز دارد (${view.jalaliLong}).`,
  };
}

/**
 * Leap year — in the calendar the user actually wrote.
 *
 * «۱۴۰۳ کبیسه است؟» is a Jalali question (Esfand has 30 days). «2024 کبیسه
 * بود؟» is a Gregorian one (February has 29). Answering the second with Jalali
 * rules would say "no" about a year that plainly is leap, so the calendar of the
 * parsed date decides which rule and which month we report.
 */
export function leapYearFacts(parsed: ParsedDate): DateFacts {
  const view = viewOf(parsed.date, parsed.label);

  if (parsed.calendar === "gregorian") {
    const leap = isLeapYearGregorian(parsed.date);
    const february = getDaysInMonthGregorian(setMonth(parsed.date, 1) as TZDate);
    const yearFa = toPersianDigits(gregorianShort(parsed.date).slice(0, 4));
    return {
      intent: "leapYear",
      zone: zoneLabel(),
      dates: [view],
      isLeap: leap,
      daysInMonth: february,
      summary: leap
        ? `بله، سال ${yearFa} میلادی کبیسه است و فوریهٔ آن ${toPersianDigits(february)} روز دارد. (برابر با ${view.jalaliLong} تا …)`
        : `نه، سال ${yearFa} میلادی کبیسه نیست و فوریهٔ آن ${toPersianDigits(february)} روز دارد.`,
    };
  }

  const leap = isLeapYear(parsed.date);
  // The last day of a Jalali year always falls in Esfand, so its month length
  // is Esfand's length — 30 in a leap year, 29 otherwise.
  const esfandDays = getDaysInMonth(endOfYear(parsed.date) as TZDate);
  const yearFa = view.jalali.split("/")[0] ?? "";

  return {
    intent: "leapYear",
    zone: zoneLabel(),
    dates: [view],
    isLeap: leap,
    daysInMonth: esfandDays,
    summary: leap
      ? `بله، سال ${yearFa} کبیسه است و اسفندِ آن ${toPersianDigits(esfandDays)} روز دارد.`
      : `نه، سال ${yearFa} کبیسه نیست و اسفندِ آن ${toPersianDigits(esfandDays)} روز دارد.`,
  };
}

/** «۲۰ روز قبل» style helpers the intent layer needs. */
export function shiftDays(parsed: ParsedDate, days: number): TZDate {
  return (days >= 0 ? addDays(parsed.date, days) : subDays(parsed.date, Math.abs(days))) as TZDate;
}

export function shiftMonths(parsed: ParsedDate, months: number): TZDate {
  return (months >= 0 ? addMonths(parsed.date, months) : subMonths(parsed.date, Math.abs(months))) as TZDate;
}
