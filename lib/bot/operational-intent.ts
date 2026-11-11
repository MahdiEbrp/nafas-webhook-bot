/**
 * Clear requests for protected operational data or actions that the public web
 * chat cannot fulfil. Keep informational discussion (for example, “what is a
 * booking?”) in ordinary chat; require both an operational verb and a protected
 * resource unless the user explicitly refers to their own account data.
 */
import { normalize } from "@/lib/text";

const PERSONAL_OPERATION = /(?:\bmy\s+(?:bookings?|appointments?|reservations?|profile|account|notifications?|sessions?|password|transactions?)\b|(?:رزرو(?:ها)?ی?|نوبت(?:ها)?ی?|وقت(?:ها)?ی?|پروفایل|حساب(?:های)?(?:\s+کاربری)?|اعلان(?:ها)?|نشست(?:ها)?|رمز|گذرواژه|تراکنش(?:ها)?)\s*(?:من|خودم))/iu;
const OPERATION_VERB = /(?:\b(?:book|reserve|schedule|cancel|reschedule|list|show|view|get|find|search|read|create|add|delete|remove|edit|update|change|set|manage|reset|revoke|send|mark|generate|activate|deactivate|disable|enable|pay|refund)\b|رزرو\s*(?:کن|کردن)|وقت\s*(?:بگیر|گرفتن)|نوبت\s*(?:بگیر|گرفتن)|لغو|کنسل|لیست|فهرست|نمایش|نشان|دریافت|ببین|پیدا|جست|ایجاد|بساز|ساخت|اضافه|حذف|پاک|ویرایش|تغییر|مدیریت|بازنشانی|خروج|ارسال|فعال\s*(?:کن|کردن)|غیرفعال\s*(?:کن|کردن)|پرداخت|بازپرداخت)/iu;
const PROTECTED_RESOURCE = /(?:\b(?:bookings?|appointments?|reservations?|slots?|profiles?|accounts?|passwords?|notifications?|sessions?|service catalog|services?|care guides?|working hours?|social links?|settings?|payments?|transactions?|sms|emails?|users?|rules?|polic(?:y|ies))\b|رزرو|نوبت|وقت|پروفایل|حساب(?:های)?(?:\s+کاربری)?|رمز|گذرواژه|اعلان|نشست|خدمات|راهنمای مراقبت|ساعات? کاری|لینک اجتماعی|تنظیمات|پرداخت|تراکنش|پیامک|ایمیل|کاربر|قانون|مقررات)/iu;

export function isProtectedOperationalRequest(message: string): boolean {
  const text = normalize(message).toLowerCase();
  return PERSONAL_OPERATION.test(text) || (OPERATION_VERB.test(text) && PROTECTED_RESOURCE.test(text));
}
