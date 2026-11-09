/**
 * «چه کارهایی بلدی؟» — answered by code, from the capability list.
 *
 * Same reasoning as the identity layer in `lib/bot/identity.ts`: the owner asked
 * for the bot to report *exactly* what this class can do. A model asked to
 * summarise its own abilities will paraphrase, drop items, and sooner or later
 * invent one — and an invented ability that deletes users is the worst kind of
 * mistake. Reading the list costs nothing and cannot drift.
 */

import type { Locale } from "@/lib/config";
import { prepare } from "@/lib/dates/parse";

import { capabilitiesText } from "./capabilities";

/**
 * `prepare` strips the Persian half-space, so every pattern here is written
 * without one. Adding a pattern with `‌` in it would simply never match.
 */
const CAPABILITY_PATTERNS: RegExp[] = [
  /چه کارهایی بلدی/,
  /چه کارهایی میدان/,
  /چه کارهایی میتون/,
  /چه کارهایی میتوان/,
  /چه کار میتون/,
  /چه کار میتوان/,
  /چیکارا بلدی/,
  /چیکارها بلدی/,
  /چیا بلدی/,
  /چی بلدی/,
  /چه قابلیتهایی داری/,
  /قابلیتهات/,
  /توانایی هات/,
  /چه امکاناتی داری/,
  /چه چیزهایی بلدی/,
  /what can you do/,
  /what are you capable of/,
  /what are your capabilities/,
  /list your capabilities/,
  /your capabilities/,
];

export function isCapabilityQuestion(message: string): boolean {
  const text = prepare(message);
  return CAPABILITY_PATTERNS.some((pattern) => pattern.test(text));
}

/** The full answer: every capability, and the promise that changes wait. */
export function capabilityAnswer(locale: Locale = "fa"): string {
  return capabilitiesText(locale);
}
