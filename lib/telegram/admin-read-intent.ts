import { normalize } from "@/lib/text";

/**
 * Shared deterministic front door for unambiguous, read-only admin requests.
 * Each module supplies its own resource vocabulary and query filters; this
 * helper makes the read-vs-write decision consistent across all admin flows.
 */
export type AdminReadRoute<Operation extends string> = {
  operation: Operation;
  when: RegExp;
  input?: (normalizedText: string) => Record<string, unknown>;
};

export type AdminReadMatch<Operation extends string> = {
  operation: Operation;
  input: Record<string, unknown>;
};

const READ_ACTION = /(?:\b(?:list|show|display|view|browse|read|get|report|overview|stats?|statistics|summary|inspect|check)\b|لیست|فهرست|نمایش|نشان|نشون|مشاهده|ببین|بخوان|گزارش|امار|وضعیت|بررسی|چک|جزئیات)/iu;

// Imperative write actions only. Adjectives such as «فعال» and «مسدود» remain
// valid read filters; the verbs «فعال کن» / «مسدود کن» do not.
const WRITE_ACTION = /(?:\b(?:create|add|delete|remove|edit|update|change|set|reset|send|dispatch|test|refresh|activate|deactivate|disable|enable|block|unblock|ban|unban|assign|insert|write)\b|بساز|ساختن?|ایجاد\s*(?:کن|بکن)?|افزودن|اضافه\s*(?:کن|بکن)?|حذف\s*(?:کن|بکن|کردن)?|پاک\s*(?:کن|بکن)?|ویرایش\s*(?:کن|بکن|کردن)?|تغییر\s*(?:بده|ده|کن|بکن|کردن)|به\s*روزرسانی|تنظیم\s+کن|بفرست|ارسال\s*(?:کن|بکن)|تست\s*(?:کن|بگیر)|آزمایش\s*کن|رفرش|فعال\s*(?:کن|بکن|کردن)|غیرفعال\s*(?:کن|بکن|کردن)|مسدود\s*(?:کن|بکن|کردن)|رفع\s*مسدودی\s*(?:کن|بکن)?)/iu;

export function isExplicitAdminReadIntent(text: string): boolean {
  const value = normalize(text).toLowerCase();
  return READ_ACTION.test(value) && !WRITE_ACTION.test(value);
}

/** Collection reads must not steal a targeted ordinal/UUID request (which may
 * need a detail route or conversational context). Let those use the planner. */
export function isExplicitAdminCollectionRead(text: string): boolean {
  const value = normalize(text).toLowerCase();
  const targeted = /\b(?:first|second|third|fourth|fifth|sixth|last)\b|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b|\bpage\s*\d+\b|\b(?:row|item|record)\s*(?:#\s*)?\d+\b|اول|دوم|سوم|چهارم|پنجم|ششم|هفتم|هشتم|نهم|دهم|ردیف\s*\d+/iu.test(value);
  return isExplicitAdminReadIntent(value) && !targeted;
}

/** Resolve one of the caller's explicit safe GET routes, or leave the request
 * to its existing planner/clarification path. Route order is deliberate: put
 * specific resources before summaries and generic collection fallbacks. */
export function matchAdminReadRoute<Operation extends string>(
  text: string,
  routes: readonly AdminReadRoute<Operation>[],
): AdminReadMatch<Operation> | null {
  const normalizedText = normalize(text).toLowerCase();
  if (!isExplicitAdminCollectionRead(normalizedText)) return null;
  const route = routes.find(candidate => candidate.when.test(normalizedText));
  if (!route) return null;
  return { operation: route.operation, input: route.input?.(normalizedText) ?? {} };
}

export function adminReadStatus(
  normalizedText: string,
  states: { value: string; when: RegExp }[],
): string | undefined {
  return states.find(state => state.when.test(normalizedText))?.value;
}
