/**
 * "Who are you?" — answered by code, not by the model.
 *
 * The system prompt says the same thing, and for most phrasings the model gets
 * it right. But a small free model under temperature will sometimes introduce
 * itself as "an AI language model", and the owner of this bot asked for one
 * specific sentence. A handful of exact patterns makes that answer certain, at
 * the cost of about twenty lines.
 */

import { getConfig } from "@/lib/config";

import { prepare } from "@/lib/dates/parse";

const IDENTITY_PATTERNS: RegExp[] = [
  /چی هستی/,
  /کی هستی/,
  /کیستی/,
  /تو کیی/,
  /تو چیی/,
  /خودتو معرفی کن/,
  /خودت را معرفی/,
  /معرفی کن خودت/,
  /اسمت چیه/,
  /اسمت چیست/,
  /اسمتون چیه/,
  /نامت چیه/,
  /نام شما/,
  /چه کاره ای/,
  /چه کاره‌ای/,
  /ربات کی هستی/,
  /who are you/,
  /what are you/,
  /introduce yourself/,
];

export function isIdentityQuestion(message: string): boolean {
  const text = prepare(message);
  return IDENTITY_PATTERNS.some((pattern) => pattern.test(text));
}

/** The one sentence the bot must always give about itself. */
export function identityText(): string {
  const { botName, clinicName } = getConfig();
  return `من ${botName} هستم، دستیار هوشمند ${clinicName}. 🙂`;
}

/** Identity + what the bot can actually do, for «معرفی کن» style questions. */
export function identityAnswer(): string {
  const { botName, clinicName } = getConfig();
  return [
    `من ${botName} هستم، دستیار هوشمند ${clinicName}. 🙂`,
    "",
    "اینجا هستم که با هم گفت‌وگو کنیم. تاریخ هم کارِ من است:",
    "• تاریخ و ساعتِ همین لحظه را از سرور می‌گویم",
    "• تاریخ را بین شمسی، میلادی و قمری جابه‌جا می‌کنم",
    "• فاصلهٔ دو تاریخ و روزهای بینشان را حساب می‌کنم",
    "",
    "کافی است ساده بپرسی؛ مثلاً «امروز چندمه؟» یا «۱۲ مرداد ۱۴۰۳ چه روزی بود؟».",
  ].join("\n");
}
