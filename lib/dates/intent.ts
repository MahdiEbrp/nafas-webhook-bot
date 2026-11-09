/**
 * Intent detection for date questions.
 *
 * Deliberately rule-based rather than model-based. Small free models are good at
 * phrasing a sentence and unreliable at arithmetic, so the split is:
 *
 *   this file decides *what* was asked and runs the real date math
 *   the model only decides *how* the answer sounds
 *
 * Detection is two steps: first pull every date out of the sentence
 * (`extractDates`), then classify by keywords. That is far more robust than one
 * giant regex per phrasing, and a new way of writing a date automatically works
 * for every intent.
 */

import { getConfig } from "@/lib/config";

import {
  addFacts,
  betweenFacts,
  convertFacts,
  describeFacts,
  leapYearFacts,
  monthLengthFacts,
  nowFacts,
  rangeFacts,
  type DateFacts,
} from "./engine";
import { extractDates, type ParsedDate } from "./parse";
import { prepare } from "./parse";
import { nowInZone } from "./timezone";

const NOW_WORDS = /(امروز چندم|امروزچندم|تاریخ امروز|تاریخ الان|ساعت چند|ساعت چنده|الان ساعت|ساعت الان|چه ساعتی|چند شنبه|امروز چه روز|امروز چند|تاریخ و ساعت|الان چند|امروز چنده|what time|what is the date|todays date)/;

/**
 * Words that turn a soft date mention («دیروز») into a date question.
 *
 * Matched against *tokens*, never substrings: «دیروز» contains «روز», so a
 * substring test would read a tired user's message as a calendar query.
 */
const DATE_QUESTION_TOKENS = new Set([
  "چندم", "چندمه", "چند", "چنده", "تاریخ", "روزی", "تاریخی", "ساعت",
  "تبدیل", "معادل", "کبیسه", "فاصله", "اختلاف", "لیست", "فهرست",
  "شمسی", "میلادی", "قمری", "هجری", "کی", "چه", "چطور", "محاسبه", "بشمار",
]);

function hasDateQuestionToken(text: string): boolean {
  return text
    .split(/[\s،,.!?:;()«»\-]+/)
    .filter(Boolean)
    .some((token) => DATE_QUESTION_TOKENS.has(token));
}

const LEAP_WORDS = /کبیسه/;
const MONTH_LENGTH_WORDS = /(چند روزه|چند روز است|چند روز دارد|چند روز هست|تعداد روز)/;
const CONVERT_WORDS = /(تبدیل|معادل|به شمسی|به جلالی|به میلادی|به قمری|به هجری|شمسیش|میلادیش|قمریش)/;
const RANGE_WORDS = /(لیست|فهرست|روزهای بین|همه روزهای|همهٔ روزهای|تک تک|تکتک|بشمار|یکی یکی|روز به روز)/;
const BETWEEN_WORDS = /(چند روز|چند روزه|چند وقت|چند ماه|چند سال|فاصله|اختلاف|بین|مدت|چقدر)/;

type AddSpec = { amount: number; unit: "day" | "week" | "month" | "year"; sign: 1 | -1 };

const UNIT_MAP: Record<string, "day" | "week" | "month" | "year"> = {
  روز: "day",
  روزها: "day",
  هفته: "week",
  ماه: "month",
  سال: "year",
};

/** «۲۰ روز بعد از …», «۳ ماه قبل از …», «به اضافه ۱۰ روز» */
function findAdd(text: string): AddSpec | null {
  const backwards = /(\d+)\s*(روز|هفته|ماه|سال)\s*(قبل|پیش)/.exec(text);
  if (backwards?.[1] && backwards[2]) {
    return { amount: Number(backwards[1]), unit: UNIT_MAP[backwards[2]] ?? "day", sign: -1 };
  }

  const forwards = /(\d+)\s*(روز|هفته|ماه|سال)\s*(بعد|پس|دیگر|دیگه|بعدی)/.exec(text);
  if (forwards?.[1] && forwards[2]) {
    return { amount: Number(forwards[1]), unit: UNIT_MAP[forwards[2]] ?? "day", sign: 1 };
  }

  const plus = /(?:به اضافه|\+)\s*(\d+)\s*(روز|هفته|ماه|سال)/.exec(text);
  if (plus?.[1] && plus[2]) {
    return { amount: Number(plus[1]), unit: UNIT_MAP[plus[2]] ?? "day", sign: 1 };
  }

  const bare = /(\d+)\s*(روز|هفته|ماه|سال)\s*(بعد از|از)/.exec(text);
  if (bare?.[1] && bare[2]) {
    return { amount: Number(bare[1]), unit: UNIT_MAP[bare[2]] ?? "day", sign: 1 };
  }

  return null;
}

/** Two dates can be mentioned in either order; keep them distinct. */
function twoDistinct(dates: ParsedDate[]): [ParsedDate, ParsedDate] | null {
  if (dates.length < 2) return null;
  for (let i = 1; i < dates.length; i += 1) {
    const first = dates[0];
    const second = dates[i];
    if (first && second && first.date.getTime() !== second.date.getTime()) return [first, second];
  }
  return null;
}

/**
 * Answers a date question, or returns null when the message is not about dates.
 * The result always carries a correct Persian `summary`; the bot may ask the
 * model to rephrase it, but never to recompute it.
 */
export function answerDateQuestion(message: string, now: Date = new Date()): DateFacts | null {
  if (!getConfig().dateAssistant) return null;

  const text = prepare(message);
  const reference = nowInZone(now);
  const dates = extractDates(text, reference);

  const wantsNow = NOW_WORDS.test(text);
  const onlyToday = dates.length === 1 && dates[0]?.label === "امروز";

  // «ساعت چنده» / «امروز چندمه» — the current instant, read off the server.
  if (wantsNow && (dates.length === 0 || onlyToday)) {
    return nowFacts(now);
  }

  if (dates.length === 0) return null;

  /*
   * Gate: a relative word alone does not make this a date question.
   *   «۱۲ مرداد ۱۴۰۳ چه روزی بود»  → explicit date → answer it
   *   «فردا چندمه»                 → relative + «چندمه» → answer it
   *   «دیروز خیلی خسته بودم»       → relative, no date word → let the model
   *                                   respond as a friend would
   */
  /*
   * «۲۰ روز بعد از امروز» carries its own intent in the «۲۰ روز بعد» part, so
   * an arithmetic phrase counts as a question too — otherwise a message whose
   * only date is «امروز» would be waved through to small talk.
   */
  const arithmetic = findAdd(text);
  // «عید»/«نوروز» is named on purpose, so it counts as an explicit date too.
  const hasExplicit = dates.some((date) => date.source === "explicit" || date.source === "eid");
  if (!hasExplicit && !arithmetic && !hasDateQuestionToken(text)) return null;

  const first = dates[0];
  if (!first) return null;

  /*
   * Two dates outrank the single-date intents: «بین X و Y چند روزه» also
   * contains «چند روزه», so checking month length first would answer with the
   * length of a month nobody asked about.
   */
  const pair = twoDistinct(dates);
  if (pair) {
    if (RANGE_WORDS.test(text)) return rangeFacts(pair[0], pair[1]);
    return betweenFacts(pair[0], pair[1]);
  }

  if (LEAP_WORDS.test(text)) return leapYearFacts(first);
  if (MONTH_LENGTH_WORDS.test(text)) return monthLengthFacts(first);
  if (CONVERT_WORDS.test(text)) return convertFacts(first);

  if (arithmetic) return addFacts(first, arithmetic.amount * arithmetic.sign, arithmetic.unit);

  return describeFacts(first);
}
