/**
 * Clear requests for protected operational data or actions that the public web
 * chat cannot fulfil. Personal booking-status questions are recognized even
 * without an imperative verb, while how-to questions stay in general chat.
 */
import { normalize } from "@/lib/text";

const PERSONAL_OPERATION = /(?:\bmy\s+(?:bookings?|appointments?|reservations?|profile|account|notifications?|sessions?|password|transactions?)\b|(?:رزرو(?:ها)?ی?|نوبت(?:ها)?ی?|وقت(?:ها)?ی?|پروفایل|حساب(?:های)?(?:\s+کاربری)?|اعلان(?:ها)?|نشست(?:ها)?|رمز|گذرواژه|تراکنش(?:ها)?)\s*(?:من|خودم))/iu;
const PERSONAL_BOOKING_REFERENCE = /\bmy\s+(?:(?:upcoming|next|future|current|scheduled|existing|recent)\s+)?(?:bookings?|appointments?|reservations?)\b/iu;
const PERSONAL_BOOKING_QUERY = /(?:\b(?:what|which|how many)\b.{0,48}\b(?:appointments?|bookings?|reservations?)\b.{0,40}\b(?:(?:do|did|will)\s+)?i\s+(?:(?:currently|still|already)\s+)?(?:have|booked|am\s+scheduled)\b|\b(?:do|did|will)\s+i\s+(?:(?:currently|still|already)\s+)?have\b.{0,40}\b(?:any\s+)?(?:appointments?|bookings?|reservations?)\b|\b(?:when|what\s+(?:time|date))\b.{0,40}\b(?:is|are|will\s+be)\s+my\b.{0,32}\b(?:appointments?|bookings?|reservations?)\b|\bwhat\s+(?:is|are)\s+my\b.{0,32}\b(?:upcoming\s+|next\s+|current\s+)?(?:appointments?|bookings?|reservations?)\b|\b(?:i\s+(?:want|need)\s+to\s+know|find\s+out|tell\s+me|check)\b.{0,56}\b(?:if|whether)\s+i\s+(?:have|will\s+have)\b.{0,40}\b(?:appointments?|bookings?|reservations?)\b|(?:من\s*)?(?:چه|کدام|کدوم|چند)\s*.{0,24}(?:نوبت|رزرو|وقت).{0,48}(?:دارم|داشتم|خواهم\s*داشت)|(?:نوبت|رزرو|وقت).{0,40}(?:دارم|داشتم|خواهم\s*داشت).{0,12}(?:یا\s*نه)?|(?:میخواهم|میخوام|میخواستم).{0,32}(?:بدونم|بدانم|بفهمم|چک\s*کنم|بررسی\s*کنم).{0,64}(?:نوبت|رزرو|وقت).{0,48}(?:دارم|داشتم|خواهم\s*داشت))/iu;
const INFORMATIONAL_HOW_TO = /(?:\bhow\s+(?:to|do|can|could|would|should)\b|\b(?:explain|describe|show|tell)\s+(?:me\s+)?how\b|\bwhat\s+(?:is\s+)?the\s+(?:process|way|steps?)\s+to\b|(?:چطور|چگونه|چه\s*طوری|نحوه).{0,48}(?:نوبت|رزرو|وقت)|(?:توضیح|راهنمایی).{0,40}(?:چطور|چگونه|نحوه))/iu;
const OPERATION_VERB = /(?:\b(?:book|reserve|schedule|cancel|reschedule|list|show|view|get|find|search|read|create|add|delete|remove|edit|update|change|set|manage|reset|revoke|send|mark|generate|activate|deactivate|disable|enable|pay|refund)\b|رزرو\s*(?:کن|کردن)|وقت\s*(?:بگیر|گرفتن)|نوبت\s*(?:بگیر|گرفتن)|لغو|کنسل|لیست|فهرست|نمایش|نشان|دریافت|ببین|پیدا|جست|ایجاد|بساز|ساخت|اضافه|حذف|پاک|ویرایش|تغییر|مدیریت|بازنشانی|خروج|ارسال|فعال\s*(?:کن|کردن)|غیرفعال\s*(?:کن|کردن)|پرداخت|بازپرداخت)/iu;
const PROTECTED_RESOURCE = /(?:\b(?:bookings?|appointments?|reservations?|slots?|profiles?|accounts?|passwords?|notifications?|sessions?|service catalog|services?|care guides?|working hours?|social links?|settings?|payments?|transactions?|sms|emails?|users?|rules?|polic(?:y|ies))\b|رزرو|نوبت|وقت|پروفایل|حساب(?:های)?(?:\s+کاربری)?|رمز|گذرواژه|اعلان|نشست|خدمات|راهنمای مراقبت|ساعات? کاری|لینک اجتماعی|تنظیمات|پرداخت|تراکنش|پیامک|ایمیل|کاربر|قانون|مقررات)/iu;

export function isProtectedOperationalRequest(message: string): boolean {
  const text = normalize(message).toLowerCase();
  if (PERSONAL_BOOKING_QUERY.test(text)) return true;
  if (INFORMATIONAL_HOW_TO.test(text)) return false;
  return PERSONAL_BOOKING_REFERENCE.test(text)
    || PERSONAL_OPERATION.test(text)
    || (OPERATION_VERB.test(text) && PROTECTED_RESOURCE.test(text));
}
