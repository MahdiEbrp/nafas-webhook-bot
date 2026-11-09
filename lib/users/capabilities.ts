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
    example: { fa: "مشخصات کاربر u-1002 را نشان بده", en: "Show me user u-1002" },
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
    example: { fa: "شمارهٔ کاربر u-1002 را عوض کن", en: "Change the number for u-1002" },
    needsConfirm: true,
  },
  {
    id: "delete",
    title: { fa: "حذف یک کاربر", en: "Delete a user" },
    example: { fa: "کاربر u-1002 را حذف کن", en: "Delete user u-1002" },
    needsConfirm: true,
  },
  {
    id: "bulk-enable",
    title: { fa: "فعال‌کردن دسته‌ای کاربران", en: "Enable many users at once" },
    example: { fa: "u-1001 و u-1003 را فعال کن", en: "Enable u-1001 and u-1003" },
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
      "Here is everything I can do with user accounts:",
      "",
      ...lines,
      "",
      "🔒 means I describe the change first and wait for your yes. Nothing is sent until you confirm, and an unconfirmed change expires on its own.",
    ].join("\n");
  }

  return [
    "این کارها را روی حساب‌های کاربری بلدم:",
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
      "You can manage user accounts. You are able to:",
      list,
      "",
      `${locked} of these change data. Never claim one has happened: describe it and wait for an explicit yes.`,
    ].join("\n");
  }

  return [
    "تو می‌توانی حساب‌های کاربری را مدیریت کنی. این کارها را بلدی:",
    list,
    "",
    `${locked} مورد از این‌ها داده را تغییر می‌دهد. هرگز نگو انجام شد: اول توضیح بده و منتظر «بله»ی صریح بمان.`,
  ].join("\n");
}
