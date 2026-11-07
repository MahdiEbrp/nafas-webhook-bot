/**
 * Deterministic slot extraction.
 *
 * A free model usually fills these in nicely, but the bot must still work when
 * the whole free-model pool is rate limited. Everything here is plain regex on
 * normalised Persian text — no network, no guessing about ids.
 *
 * Rule: we only ever extract values the user literally typed. Nothing invented.
 */

import { normalize, toLatinDigits } from "@/lib/text";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
/** Iranian mobile (09xxxxxxxxx / 98912…) and landline with optional separators. */
const PHONE = /(?:\+?98|0)?9\d{2}[\s-]?\d{3}[\s-]?\d{4}|0\d{2,3}[\s-]?\d{3,4}[\s-]?\d{4}/;

const STATUS_WORDS: Array<[RegExp, string]> = [
  [/پرداخت\s*نشده|پرداخت\s*نکرده|پول\s*نداده|unpaid|pending/i, "pending"],
  [/پرداخت\s*شده|پول\s*داده|تسویه|paid/i, "paid"],
  [/در\s*انتظار|منتظر|waiting/i, "waiting"],
  [/انجام\s*شده|تمام\s*شده|انجام شد|done|completed/i, "done"],
  [/برگشت\s*خورده|ریفاند|refund/i, "refunded"],
  [/غیرفعال|inactive/i, "inactive"],
  [/فعال\s*است|فعال|active/i, "active"],
];

const DAYS: Array<[RegExp, string]> = [
  [/شنبه/, "Saturday"],
  [/یک\s*شنبه|یکشنبه/, "Sunday"],
  [/دوشنبه/, "Monday"],
  [/سه\s*شنبه|سهشنبه/, "Tuesday"],
  [/چهار\s*شنبه|چهارشنبه/, "Wednesday"],
  [/پنج\s*شنبه|پنجشنبه/, "Thursday"],
  [/جمعه/, "Friday"],
];

const MULTIPLIERS: Array<[RegExp, number]> = [
  [/میلیون|میلیارد\s*و\s*میلیون|ملیون/, 1_000_000],
  [/هزار/, 1_000],
];

export type Extracted = {
  id?: string;
  phone?: string;
  email?: string;
  status?: string;
  day?: string;
  opens?: string;
  closes?: string;
  price?: number;
  capacity?: number;
  fullName?: string;
};

function extractId(text: string): string | undefined {
  return text.match(UUID)?.[0]?.toLowerCase();
}

function extractPhone(text: string): string | undefined {
  const match = text.match(PHONE);
  if (!match) return undefined;
  const digits = toLatinDigits(match[0]);
  if (digits.length < 10) return undefined;
  return digits.startsWith("98") && digits.length === 12 ? `0${digits.slice(2)}` : digits;
}

function extractTime(text: string, kind: "opens" | "closes"): string | undefined {
  // "از ۹ صبح", "تا ۶ عصر", "09:00"
  const colon = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g);
  const words = /(از|تا)\s*(\d{1,2})(?::(\d{2}))?\s*(صبح|ظهر|عصر|شب)?/g;

  const found: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = words.exec(text)) !== null) {
    const marker = match[1];
    let hour = Number(match[2]);
    const minute = Number(match[3] ?? 0);
    const period = match[4];
    if ((period === "عصر" || period === "شب") && hour < 12) hour += 12;
    if (period === "ظهر" && hour < 12) hour = 12;
    if (hour > 23) continue;
    found.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}${marker === "از" ? "|from" : "|to"}`);
  }

  if (kind === "opens") {
    const from = found.find((value) => value.endsWith("|from"));
    if (from) return from.replace("|from", "");
    if (colon?.[0]) return colon[0];
    return found[0]?.replace(/\|(from|to)$/, "");
  }

  const to = found.find((value) => value.endsWith("|to"));
  if (to) return to.replace("|to", "");
  if (colon && colon.length > 1) return colon[1];
  return undefined;
}

function extractPrice(text: string): number | undefined {
  const match = text.match(/(\d[\d,٫٬]*)\s*(میلیون|ملیون|هزار|تومان|ریال)?/);
  if (!match) return undefined;

  const rawNumber = Number(toLatinDigits(match[1] ?? ""));
  if (!Number.isFinite(rawNumber) || rawNumber === 0) return undefined;

  const unit = match[2] ?? "";
  const multiplier = MULTIPLIERS.find(([pattern]) => pattern.test(unit))?.[1] ?? 1;
  const value = rawNumber * multiplier;
  return value >= 1000 ? value : undefined;
}

function extractCapacity(masked: string): number | undefined {
  // "۵ نفر" is the least ambiguous phrasing.
  const people = masked.match(/(\d{1,3})\s*نفر/);
  if (people?.[1]) {
    const value = Number(toLatinDigits(people[1]));
    if (value > 0 && value <= 500) return value;
  }
  // Otherwise "ظرفیت … ۵", but never a clock time ("ساعت ۱۰").
  const byCapacity = masked.match(/ظرفیت(?!\s*ساعت)[^\d]{0,10}(\d{1,3})(?!\s*:)/);
  if (byCapacity?.[1]) {
    const value = Number(toLatinDigits(byCapacity[1]));
    if (value > 0 && value <= 500) return value;
  }
  return undefined;
}

function extractName(text: string): string | undefined {
  const patterns = [
    /(?:برای|به\s*نام|به\s*اسم|اسمش)\s+([^\d،,.!?]{2,40}?)(?=\s*(?:به|با|در|ساعت|نوبت|رزرو|ثبت|بساز|بگیر|حذف|کن)(?![\u0600-\u06FF])|[,،.!?]|$)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1]?.trim();
    if (value && value.split(/\s+/).length <= 4 && !/^(این|آن|اون|یک|یه|همه|لیست)/.test(value)) return value;
  }
  return undefined;
}

/**
 * Blanks out ids / phones / emails / clock times before the "fuzzy" extractors
 * run, so a uuid never becomes a price and "ساعت ۱۰" never becomes a capacity.
 */
function maskHardValues(text: string): { masked: string; withoutTimes: string } {
  const masked = text
    .replace(new RegExp(UUID.source, "gi"), " ")
    .replace(new RegExp(PHONE.source, "g"), " ")
    .replace(new RegExp(EMAIL.source, "g"), " ");
  const withoutTimes = masked
    .replace(/(?:ساعت\s*)?\b([01]?\d|2[0-3]):([0-5]\d)\b/g, " ")
    .replace(/ساعت\s*\d{1,2}/g, " ");
  return { masked, withoutTimes };
}

export function extractSlots(message: string): Extracted {
  const text = normalize(message);
  const { masked, withoutTimes } = maskHardValues(text);
  const out: Extracted = {};

  const id = extractId(text);
  if (id) out.id = id;

  const phone = extractPhone(text);
  if (phone) out.phone = phone;

  const email = text.match(EMAIL)?.[0];
  if (email) out.email = email;

  for (const [pattern, status] of STATUS_WORDS) {
    if (pattern.test(text)) {
      out.status = status;
      break;
    }
  }

  for (const [pattern, day] of DAYS) {
    if (pattern.test(text)) {
      out.day = day;
      break;
    }
  }

  const opens = extractTime(masked, "opens");
  if (opens) out.opens = opens;
  const closes = extractTime(masked, "closes");
  if (closes && closes !== opens) out.closes = closes;

  const price = extractPrice(masked);
  if (price !== undefined) out.price = price;

  const capacity = extractCapacity(withoutTimes);
  if (capacity !== undefined) out.capacity = capacity;

  const name = extractName(masked);
  if (name) out.fullName = name;

  return out;
}

/** Keeps only the keys the chosen action can accept. */
export function slotsForAction(message: string, allowedFields: string[] | undefined): Record<string, unknown> {
  const slots = extractSlots(message) as Record<string, unknown>;
  const allowed = new Set((allowedFields ?? []).map((field) => field.split(/[.[]/)[0] as string));
  allowed.add("id");

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(slots)) {
    if (allowed.has(key)) out[key] = value;
  }
  return out;
}
