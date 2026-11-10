import { normalize } from "@/lib/text";
import type { Locale } from "@/lib/config";

/** No user-management API is connected to the Telegram bridge yet. */
export function isUnsupportedUserRequest(message: string): boolean {
  const text = normalize(message).toLowerCase();
  return /(?:کاربر|کاربران|حساب کاربری|\busers?\b|\baccount\b)/u.test(text)
    && /(?:بساز|ساخت|ایجاد|جدید|لیست|فهرست|نمایش|نشون|نشان|حذف|ویرایش|تغییر|مسدود|فعال|create|new|list|show|delete|edit|update|block)/u.test(text)
    // Labeled account details must not be mistaken for an OTP/login attempt,
    // persisted in conversation history, or sent to a conversational model.
    || /^(?:نام|نام کامل|نام کاربر|ایمیل|شماره تماس|تلفن|name|full name|email|phone)\s*[:：]/u.test(text);
}

export function unsupportedUserReply(locale: Locale): string {
  return locale === "en"
    ? "User management is not connected to this Telegram bot yet, so I cannot create an account. No user was created. Please do not send personal account details here; an administrator must connect the authenticated users API first."
    : "مدیریت کاربران هنوز به این ربات تلگرام متصل نشده؛ فعلاً نمی‌توانم حساب بسازم یا کاربران را مدیریت کنم. هیچ کاربری ساخته نشده است. لطفاً مشخصات شخصی نفرست؛ مدیر باید ابتدا API احراز هویت‌شدهٔ کاربران را متصل کند.";
}
