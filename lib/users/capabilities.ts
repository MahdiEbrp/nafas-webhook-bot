/**
 * What the user manager can do, written down once.
 *
 * Two consumers, one list. The tests read it to check the class really does each
 * thing it claims, and the bot reads it to answer «چه کارهایی بلدی؟» — so the
 * answer can never drift away from the code the way a hand-written paragraph
 * eventually does.
 *
 * `needsConfirm` is part of the claim, not decoration: it is what the prompt
 * uses to promise the user that nothing happens until they say so.
 */

import type { Locale } from "@/lib/config";

import type { Capability } from "./types";

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "search",
    title: { fa: "جست‌وجوی کاربر", en: "Search users" },
    example: { fa: "کاربرانی که اسمشان مریم است را پیدا کن", en: "Find users called Maryam" },
    needsConfirm: false,
  },
  {
    id: "view",
    title: { fa: "دیدن مشخصات یک کاربر", en: "View one user" },
    example: { fa: "مشخصات کاربری را که شناسهٔ UUID دارد نشان بده", en: "Show a user by its UUID" },
    needsConfirm: false,
  },
  {
    id: "list",
    title: { fa: "فهرست همهٔ کاربران", en: "List all users" },
    example: { fa: "همهٔ کاربران را لیست کن", en: "List every user" },
    needsConfirm: false,
  },
  {
    id: "create",
    title: { fa: "ساخت حساب کاربری", en: "Create a user account" },
    example: { fa: "برای مریم یک حساب مشتری بساز", en: "Create a customer account for Maryam" },
    needsConfirm: true,
  },
  {
    id: "edit",
    title: { fa: "ویرایش مشخصات کاربر", en: "Edit a user" },
    example: { fa: "شمارهٔ کاربر انتخاب‌شده را عوض کن", en: "Change the selected user's phone number" },
    needsConfirm: true,
  },
  {
    id: "role-change",
    title: { fa: "تغییر نقش کاربر", en: "Change a user's role" },
    example: { fa: "نقش این کاربر را به پزشک تغییر بده", en: "Change this user's role to doctor" },
    needsConfirm: true,
  },
  {
    id: "password-change",
    title: { fa: "تغییر رمز عبور", en: "Change a password" },
    example: { fa: "رمز حساب این کاربر را عوض کن", en: "Change this user's password" },
    needsConfirm: true,
  },
  {
    id: "password-reset",
    title: { fa: "بازنشانی رمز و خروج نشست‌ها", en: "Reset a password and revoke sessions" },
    example: { fa: "رمز کاربر را بازنشانی کن", en: "Reset this user's password" },
    needsConfirm: true,
  },
  {
    id: "ban",
    title: { fa: "مسدودکردن حساب", en: "Ban an account" },
    example: { fa: "حساب این کاربر را با ذکر دلیل مسدود کن", en: "Ban this account with a reason" },
    needsConfirm: true,
  },
  {
    id: "unban",
    title: { fa: "رفع مسدودی حساب", en: "Unban an account" },
    example: { fa: "مسدودی این کاربر را بردار", en: "Unban this account" },
    needsConfirm: true,
  },
  {
    id: "delete",
    title: { fa: "حذف یک کاربر", en: "Delete a user" },
    example: { fa: "کاربر انتخاب‌شده را حذف کن", en: "Delete the selected user" },
    needsConfirm: true,
  },
  {
    id: "bulk-enable",
    title: { fa: "فعال‌کردن دسته‌ای کاربران", en: "Enable many users at once" },
    example: { fa: "این دو کاربر را فعال کن", en: "Enable these two users" },
    needsConfirm: true,
  },
  {
    id: "bulk-disable",
    title: { fa: "غیرفعال‌کردن دسته‌ای کاربران", en: "Disable many users at once" },
    example: { fa: "این سه نفر را غیرفعال کن", en: "Disable these three" },
    needsConfirm: true,
  },
  {
    id: "bulk-delete",
    title: { fa: "حذف دسته‌ای کاربران", en: "Delete many users at once" },
    example: { fa: "همهٔ این‌ها را حذف کن", en: "Delete all of these" },
    needsConfirm: true,
  },
  {
    id: "confirm",
    title: { fa: "تأیید یا لغو تغییر", en: "Confirm or cancel a change" },
    example: { fa: "تأیید می‌کنم — یا بی‌خیال", en: "I confirm — or never mind" },
    needsConfirm: false,
  },
];

/** Ids of the capabilities that must not run without a yes from the user. */
export function confirmRequiredIds(): string[] {
  return CAPABILITIES.filter((capability) => capability.needsConfirm).map(
    (capability) => capability.id,
  );
}

export function findCapability(id: string): Capability | undefined {
  return CAPABILITIES.find((capability) => capability.id === id);
}

/**
 * The prose answer to «چه کارهایی بلدی؟».
 *
 * Built from the list rather than written by hand, and it says plainly that
 * changes wait for a yes. A bot that can delete users must not sound like it
 * will do so on a whim.
 */
export function capabilitiesText(locale: Locale): string {
  const lines = CAPABILITIES.map((capability) => {
    const title = capability.title[locale];
    const example = capability.example[locale];
    return `• ${title}${capability.needsConfirm ? " 🔒" : ""} — مثلاً: «${example}»`;
  });

  if (locale === "en") {
    return [
      "The legacy user accounts module has these capabilities. For the supported live Telegram operations and their limits, describe what you want naturally in a private chat (for example, delete the second user):",
      "",
      ...lines,
      "",
      "🔒 means I describe the change first and wait for your yes. Nothing is sent until you confirm, and an unconfirmed change expires on its own.",
    ].join("\n");
  }

  return [
    "ماژول قدیمی حساب‌های کاربری قابلیت‌های زیر را دارد؛ برای عملیات واقعیِ پشتیبانی‌شده و محدودیت‌های API در تلگرام، در خصوصی خواسته‌ات را طبیعی بنویس؛ مثلاً «کاربر دوم را حذف کن»:",
    "",
    ...lines,
    "",
    "🔒 یعنی اول تغییر را توضیح می‌دهم و منتظر «بله»ی تو می‌مانم. تا تأیید نکنی چیزی ارسال نمی‌شود، و تغییری که تأیید نشود خودش باطل می‌شود.",
  ].join("\n");
}

/**
 * The block injected into the system prompt, so the model knows what it may
 * claim. Kept short on purpose: this goes into every request and a free model
 * stops reading somewhere.
 */
export function capabilitiesPromptBlock(locale: Locale): string {
  const list = CAPABILITIES.map((capability) => `- ${capability.title[locale]}`).join("\n");
  const locked = confirmRequiredIds().length;

  if (locale === "en") {
    return [
      "The module for user accounts supports the following abilities, but it is NOT connected directly to the language model. Live Telegram user operations use a separate private conversational flow. Ask users to describe the desired change naturally; never recommend slash commands; do not collect account details through conversation:",
      list,
      "",
      `${locked} of these change data. Never claim one has happened: describe it and wait for an explicit yes.`,
    ].join("\n");
  }

  return [
    "ماژول حساب‌های کاربری قابلیت‌های زیر را دارد، اما مستقیماً به مدل متصل نیست. عملیات واقعی تلگرام در مسیر خصوصی و محاوره‌ای انجام می‌شود. بگو خواسته‌اش را طبیعی بنویسد؛ هرگز فرمان اسلش‌دار پیشنهاد نکن؛ در گفت‌وگوی مدل مشخصات کاربر جمع نکن:",
    list,
    "",
    `${locked} مورد از این‌ها داده را تغییر می‌دهد. هرگز نگو انجام شد: اول توضیح بده و منتظر «بله»ی صریح بمان.`,
  ].join("\n");
}
