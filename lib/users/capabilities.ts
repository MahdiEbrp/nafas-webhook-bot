/*
 * What the legacy user manager can do, written down once.
 *
 * The detailed capability registry still drives authorization-oriented prompts
 * and tests. The user-facing answer is deliberately compact, per the owner's
 * request; it must not dump a long item-by-item list when asked what the bot can do.
 */

import type { Locale } from "@/lib/config";
import type { Capability } from "./types";

export const CAPABILITIES: readonly Capability[] = [
  { id: "search", title: { fa: "جست‌وجوی کاربر", en: "Search users" }, example: { fa: "کاربرانی که اسمشان مریم است را پیدا کن", en: "Find users called Maryam" }, needsConfirm: false },
  { id: "view", title: { fa: "دیدن مشخصات یک کاربر", en: "View one user" }, example: { fa: "مشخصات کاربری را که شناسهٔ UUID دارد نشان بده", en: "Show a user by its UUID" }, needsConfirm: false },
  { id: "list", title: { fa: "فهرست همهٔ کاربران", en: "List all users" }, example: { fa: "همهٔ کاربران را لیست کن", en: "List every user" }, needsConfirm: false },
  { id: "create", title: { fa: "ساخت حساب کاربری", en: "Create a user account" }, example: { fa: "برای مریم یک حساب مشتری بساز", en: "Create a customer account for Maryam" }, needsConfirm: true },
  { id: "edit", title: { fa: "ویرایش مشخصات کاربر", en: "Edit a user" }, example: { fa: "شمارهٔ کاربر انتخاب‌شده را عوض کن", en: "Change the selected user's phone number" }, needsConfirm: true },
  { id: "role-change", title: { fa: "تغییر نقش کاربر", en: "Change a user's role" }, example: { fa: "نقش این کاربر را به پزشک تغییر بده", en: "Change this user's role to doctor" }, needsConfirm: true },
  { id: "password-change", title: { fa: "تغییر رمز عبور", en: "Change a password" }, example: { fa: "رمز حساب این کاربر را عوض کن", en: "Change this user's password" }, needsConfirm: true },
  { id: "password-reset", title: { fa: "بازنشانی رمز و خروج نشست‌ها", en: "Reset a password and revoke sessions" }, example: { fa: "رمز کاربر را بازنشانی کن", en: "Reset this user's password" }, needsConfirm: true },
  { id: "ban", title: { fa: "مسدودکردن حساب", en: "Ban an account" }, example: { fa: "حساب این کاربر را با ذکر دلیل مسدود کن", en: "Ban this account with a reason" }, needsConfirm: true },
  { id: "unban", title: { fa: "رفع مسدودی حساب", en: "Unban this account" }, example: { fa: "مسدودی این کاربر را بردار", en: "Unban this account" }, needsConfirm: true },
  { id: "delete", title: { fa: "حذف یک کاربر", en: "Delete a user" }, example: { fa: "کاربر انتخاب‌شده را حذف کن", en: "Delete the selected user" }, needsConfirm: true },
  { id: "bulk-enable", title: { fa: "فعال‌کردن دسته‌ای کاربران", en: "Enable many users at once" }, example: { fa: "این دو کاربر را فعال کن", en: "Enable these two users" }, needsConfirm: true },
  { id: "bulk-disable", title: { fa: "غیرفعال‌کردن دسته‌ای کاربران", en: "Disable many users at once" }, example: { fa: "این سه نفر را غیرفعال کن", en: "Disable these three" }, needsConfirm: true },
  { id: "bulk-delete", title: { fa: "حذف دسته‌ای کاربران", en: "Delete many users at once" }, example: { fa: "همهٔ این‌ها را حذف کن", en: "Delete all of these" }, needsConfirm: true },
  { id: "confirm", title: { fa: "تأیید یا لغو تغییر", en: "Confirm or cancel a change" }, example: { fa: "تأیید می‌کنم — یا بی‌خیال", en: "I confirm — or never mind" }, needsConfirm: false },
];

export function confirmRequiredIds(): string[] {
  return CAPABILITIES.filter(capability => capability.needsConfirm).map(capability => capability.id);
}
export function findCapability(id: string): Capability | undefined { return CAPABILITIES.find(capability => capability.id === id); }

/** Compact user-facing summary. The detailed registry remains in the system prompt. */
export function capabilitiesText(locale: Locale): string {
  return locale === "en"
    ? "I can search and view user accounts; sensitive account changes wait for your confirmation. For live admin tools, message me privately on Telegram and describe what you need."
    : "می‌توانم کاربران را جست‌وجو و مشخصاتشان را ببینم؛ تغییرهای حساس حساب فقط پس از تأیید انجام می‌شوند. برای ابزارهای مدیریتی واقعی، در خصوصی تلگرام خواسته‌ات را طبیعی بنویس.";
}

/** Short prompt block, with detailed user-operation limits kept explicit. */
export function capabilitiesPromptBlock(locale: Locale): string {
  const list = CAPABILITIES.map(capability => `- ${capability.title[locale]}`).join("\n");
  const locked = confirmRequiredIds().length;
  return locale === "en"
    ? ["The legacy user-account module supports the following operations, but is NOT directly connected to the language model. Live Telegram user operations use a separate private flow. Ask for natural wording; never recommend slash commands or collect account details in model chat:", list, "", `${locked} operations change data; describe the change and wait for an explicit yes.`].join("\n")
    : ["ماژول قدیمی حساب‌های کاربری این عملیات را دارد، اما مستقیماً به مدل وصل نیست. کارهای واقعی تلگرام در مسیر خصوصی جداگانه انجام می‌شوند؛ خواسته را طبیعی بپرس، فرمان اسلش‌دار پیشنهاد نکن و مشخصات کاربر را در گفت‌وگوی مدل نگیر:", list, "", `${locked} عملیات داده را تغییر می‌دهند؛ اول تغییر را توضیح بده و منتظر تأیید صریح بمان.`].join("\n");
}
