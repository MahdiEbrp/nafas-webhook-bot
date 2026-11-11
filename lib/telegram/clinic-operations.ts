import { createHash } from "node:crypto";
import { z } from "zod";
import { extractDates } from "@/lib/dates/parse";
import { normalize, truncate } from "@/lib/text";
import type { RuleRequestContext } from "@/lib/rules/types";
import {
  ClinicOperationsApi,
  validateClinicCommand,
  type ClinicCommand,
  type ClinicOperation,
  type ClinicResource,
} from "@/lib/clinic-operations/api";
import { planClinicRequest, scrubClinicPlannerText, clinicPlanSchema, type ClinicPlanner } from "@/lib/clinic-operations/planner";
import { createBookingSchema, updateBookingAdminSchema } from "@/lib/validation/bookings";
import { changePasswordSchema } from "@/lib/users/clinic-validation";
import { isWorkingHoursRequest } from "./working-hours";

export type ClinicWorkflowReply = {
  reply: string;
  status: string;
  /** The incoming message contains private contact/account information. */
  deleteSensitiveMessage?: boolean;
};

type Row = Record<string, unknown>;
type Pending = { command: ClinicCommand; snapshot?: unknown; title: string };
type BookingDraft = {
  stage: "group" | "date" | "slot" | "name" | "phone" | "email";
  groups: Row[];
  slots: Row[];
  group?: Row;
  slot?: Row;
  fullName?: string;
  phone?: string;
  email?: string | null;
  date?: string;
};
type PasswordDraft = { stage: "new" | "confirm"; password?: string };
type BookingEditDraft = { id: string; field: "fullName" | "phone" | "email" | "notes"; current?: Row };
type State = {
  actor: string;
  session: string;
  expires: number;
  resource?: ClinicResource;
  rows: Row[];
  query: Record<string, unknown>;
  pending?: Pending;
  target?: Row;
  booking?: BookingDraft;
  bookingAction?: "get" | "update" | "delete";
  bookingUpdate?: { id: string };
  passwordDraft?: PasswordDraft;
  bookingEdit?: BookingEditDraft;
  awaiting?: string;
};

function sensitiveClinicInputPending(state: State | undefined): boolean {
  return Boolean(state?.passwordDraft || state?.bookingEdit
    || (state?.booking && ["name", "phone", "email"].includes(state.booking.stage)));
}

const TTL_MS = 5 * 60_000;
const CONFIRM = /^(?:بله|تایید|تأیید|اجرا|انجام بده|yes|confirm|execute)$/iu;
const CANCEL = /^(?:لغو|بیخیال|بی خیال|انصراف|cancel|\/cancel)$/iu;
const CRUD_WORDS = /(?:ایجاد|بساز|ساخت|اضافه|افزودن|جدید|حذف|پاک(?:سازی)?|ویرایش|تغییر|بهروز|فعال|غیرفعال|لیست|فهرست|نمایش|نشان|دریافت|جزئیات|create|add|new|delete|remove|edit|update|change|list|show|view|read|activate|deactivate|bulk|all)/iu;
const BOOKING_WORDS = /(?:رزرو|نوبت|وقت|appointment|booking|reservation|slot)/iu;
const GROUP_WORDS = /(?:گروه خدمات|گروهها|گروه های خدمات|service groups?|service-groups)/iu;
const CATEGORY_WORDS = /(?:دسته(?:بندی)?(?:های)? خدمات|دسته بندی|category|categories|service-categories)/iu;
const GUIDE_ITEM_WORDS = /(?:آیتم|مورد|نکته|بخش).*(?:راهنمای مراقبت|care guide)|(?:راهنمای مراقبت|care guide).*(?:آیتم|مورد|نکته|item)/iu;
const GUIDE_WORDS = /(?:راهنمای مراقبت|راهنماهای مراقبت|care guides?|care-guides)/iu;
const SLOT_WORDS = /(?:ظرفیت|اسلات|زمانهای? آزاد|زمان خالی|نوبتهای? آزاد|available slots?|time slots?|slots?)/iu;
const NOTIFICATION_WORDS = /(?:اعلانها|اعلان ها|اعلان|اطلاعیه|notification|notifications)/iu;
const LANDING_WORDS = /(?:صفحه اصلی|لندینگ|landing|صفحهٔ خانه|homepage|home page)/iu;
const SERVICES_WORDS = /(?:خدمات|سرویسها|سرویس ها|service catalog|services?)/iu;
const RESOURCE_ACTIONS = /(?:ایجاد|بساز|ساخت|اضافه|افزودن|حذف|پاک|ویرایش|تغییر|فعال|غیرفعال|create|add|new|delete|remove|edit|update|change|activate|deactivate)/iu;
const MY_WORDS = /(?:مال من|رزروهای من|نوبتهای من|نوبت های من|رزرو من|نوبت من|my bookings?|my appointments?|my reservations?|my orders?)/iu;
const MY_BOOKINGS_DIRECT = /(?:رزرو|نوبت|وقت|booking|appointment|reservation)/iu;
const LIST_WORDS = /(?:لیست|فهرست|نمایش|نشان بده|نشون بده|ببین|دریافت|show|list|view|browse|read|catalog)/iu;
const DELETE_WORDS = /(?:حذف|پاک کن|پاکسازی|delete|remove)/iu;
const BULK_WORDS = /(?:همه|تمام|همگی|all|every|filtered|matching)/iu;
const STATUS_WORDS = /(?:وضعیت|حالت|status|پرداخت|پرداخت شد|تکمیل|انجام شد|بازپرداخت)/iu;

const HELP_FA = "**🗂 مدیریت کلینیک در تلگرام**\n\n• «روزهای قابل رزرو رو نشون بده» برای برنامهٔ هفتگی، ساعت‌ها، ظرفیت و الگوهای نوبت\n• «اسلات‌های فردا رو نشون بده» برای زمان‌های تاریخ‌دار و ظرفیت باقی‌مانده؛ این فهرست از برنامهٔ هفتگی جداست\n• «خدمات کلینیک را نشان بده» یا «گروه‌های خدمات را فهرست کن»\n• «راهنماهای مراقبت را نمایش بده» و «آیتم‌های گالری صفحه اصلی را نشان بده»\n• «رزروهای من را نمایش بده» یا «برای من وقت رزرو کن»\n• «اعلان‌های اخیر را نشان بده»\n• مدیریت رزروها، اسلات‌های تاریخ‌دار و محتوا با فهرست، ویرایش یا حذف\n\n🔐 این کارها فقط در گفت‌وگوی خصوصی و با نشست واردشده انجام می‌شوند. همهٔ تغییرها و رزروها پیش از اجرا، پیش‌نمایش دارند و به «تأیید» نیاز دارند. لغو: «لغو».";
const HELP_EN = "**🗂 Clinic workflows in Telegram**\n\n• “Show bookable days” for the recurring weekly schedule, hours, capacity, and slot patterns\n• “Show dated slots tomorrow” for real date-specific slots and remaining capacity; these are separate from the weekly schedule\n• “Show the clinic service catalog” or “List service groups”\n• “Show care guides” or “Show the home-page gallery”\n• “Show my bookings” or “Book an appointment for me”\n• “Show recent notifications”\n• Manage bookings, dated slots, and content with list, edit, or delete requests\n\n🔐 Available only in a private chat with an authenticated session. Every booking and change is previewed and requires explicit confirmation. Cancel: “cancel”.";

function asRecord(value: unknown): Row | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}
function asRows(value: unknown): Row[] {
  if (Array.isArray(value)) return value.map(asRecord).filter((row): row is Row => Boolean(row));
  const record = asRecord(value);
  if (!record) return [];
  if (Array.isArray(record.items)) return record.items.map(asRecord).filter((row): row is Row => Boolean(row));
  if (Array.isArray(record.groups)) return record.groups.map(asRecord).filter((row): row is Row => Boolean(row));
  return [];
}
function str(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
function bool(value: unknown): boolean { return value === true; }
function num(value: unknown, fallback = 0): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function tr(row: Row, locale: "fa" | "en"): Row {
  const translations = asRecord(row.translations);
  return asRecord(translations?.[locale]) ?? {};
}
function rowTitle(resource: ClinicResource, row: Row, locale: "fa" | "en"): string {
  const translated = tr(row, locale);
  const other = tr(row, locale === "fa" ? "en" : "fa");
  const choices: Record<string, unknown[]> = {
    "service-groups": [row.name, translated.name, other.name, row.slug],
    "service-categories": [row.name, translated.name, other.name, row.slug],
    services: [row.title, translated.title, other.title, row.slug],
    "care-guides": [row.name, translated.name, other.name, row.slug],
    "care-guide-items": [row.title, translated.title, other.title],
    "landing-marquee": [row.text, translated.text, other.text],
    "landing-services": [row.title, translated.title, other.title],
    "landing-stats": [row.label, translated.label, other.label],
    "landing-gallery": [row.alt, translated.alt, other.alt, row.caption],
    bookings: [row.groupTitle, row.fullName, row.id],
    slots: [row.slotDate, row.startTime, row.id],
    "my-bookings": [row.groupTitle, row.slotStart, row.groupRef, row.id],
    notifications: [row.action, row.entityType, row.id],
  };
  const candidates = choices[resource] ?? [row.name, row.title, row.label, row.slug, row.id];
  return str(candidates.find((item) => typeof item === "string" && item.trim()));
}
function safePlannerRows(resource: ClinicResource, rows: Row[], locale: "fa" | "en"): Array<Record<string, unknown>> {
  return rows.slice(0, 100).map((row) => ({
    id: row.id,
    title: truncate(rowTitle(resource, row, locale), 100),
    ...(typeof row.slug === "string" ? { slug: truncate(row.slug, 100) } : {}),
    ...(typeof row.isActive === "boolean" ? { isActive: row.isActive } : {}),
    ...(typeof row.status === "string" ? { status: row.status } : {}),
    ...(typeof row.displayOrder === "number" ? { displayOrder: row.displayOrder } : {}),
  }));
}
function safePlannerQuery(query: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (key === "search") {
      safe.searchPresent = typeof value === "string" && Boolean(value.trim());
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
    }
  }
  return safe;
}
/** Resolve a resource without asking a model to classify private booking data. */
export function clinicResourceFromText(textInput: string): ClinicResource | null {
  const text = normalize(textInput).toLowerCase();
  if (!text) return null;
  // Recurring weekday schedules belong to the working-hours workflow, even
  // when the wording contains «booking» or «capacity». Dated slots remain here.
  if (isWorkingHoursRequest(text)) return null;
  if (MY_WORDS.test(text) || /(?:رزروهای? خودم|نوبتهای? خودم|نوبت های خودم)/iu.test(text)) return "my-bookings";
  if (/(?:میخواهم|میخوام|میخواستم|رزرو کنم|وقت بگیرم|نوبت بگیرم|\bbook\s+(?:an?\s+)?(?:appointment|booking|slot)|\bbook\s+me\b|\bbook\s+me\s+(?:an?\s+)?(?:appointment|booking|slot)|\bschedule\s+(?:an?\s+)?appointment|\bmake\s+an?\s+appointment|\breserve\s+(?:an?\s+)?(?:appointment|slot))/iu.test(text) && BOOKING_WORDS.test(text)) return "bookings";
  if (/اعلان|اطلاعیه|notification/iu.test(text)) return "notifications";
  if (/(?:پروفایل|مشخصات حساب|حساب کاربری من|اطلاعات حساب|my profile|my account|who am i)/iu.test(text)) return "profile";
  if (/(?:خروج از حساب|خروج از دستگاه|sign out|log out|logout)/iu.test(text)) return "auth-session";
  if (/(?:نشستهای? دیگر|نشست های دیگر|دستگاههای? دیگر|دستگاه های دیگر|other sessions|other devices)/iu.test(text)) return "sessions";
  if (/(?:تغییر رمز|عوض کردن رمز|گذرواژه|password|change password)/iu.test(text)) return "password";
  if (SLOT_WORDS.test(text)) return "slots";
  if (GUIDE_ITEM_WORDS.test(text)) return "care-guide-items";
  if (GUIDE_WORDS.test(text)) return "care-guides";
  if (LANDING_WORDS.test(text) && /(?:hero|هیرو|بنر اصلی|تصویر اصلی)/iu.test(text)) return "landing-hero";
  if (LANDING_WORDS.test(text) && /(?:section|بخش|سکشن|سئو|seo)/iu.test(text)) return "landing-sections";
  if (/gallery|گالری|تصاویر صفحه|عکسهای? صفحه/iu.test(text)) return "landing-gallery";
  if (/marquee|نوار متحرک|نوار اطلاع|متن چرخان/iu.test(text)) return "landing-marquee";
  if (/(?:آمار|stat|درباره ما|عددهای صفحه)/iu.test(text)) return "landing-stats";
  if (LANDING_WORDS.test(text) && /(?:service card|کارت خدمات|کارتهای خدمات|خدمات صفحه)/iu.test(text)) return "landing-services";
  if (GROUP_WORDS.test(text)) return "service-groups";
  if (CATEGORY_WORDS.test(text)) return "service-categories";
  if (BOOKING_WORDS.test(text)) return "bookings";
  if (SERVICES_WORDS.test(text)) return /(?:catalog summary|catalog overview|خلاصه کاتالوگ|خلاصه خدمات|تعداد خدمات)/iu.test(text) ? "service-catalog" : "services";
  return null;
}

export function isClinicOperationsRequest(text: string): boolean {
  const normalized = normalize(text);
  const resource = clinicResourceFromText(normalized);
  if (!resource && isWorkingHoursRequest(normalized)) return false;
  if (!resource) return /^(?:clinic|کلینیک)$/iu.test(normalized)
    || /(?:\bclinic\b.{0,32}\b(?:help|manage(?:ment)?|operations?|workflow|options|menu)\b|\b(?:help|manage(?:ment)?|operations?|workflow|options|menu)\b.{0,32}\bclinic\b|(?:مدیریت|راهنما|راهنمایی|کمک).{0,24}کلینیک|کلینیک.{0,24}(?:مدیریت|راهنما|راهنمایی|کمک))/iu.test(normalized);
  if (["notifications", "profile", "auth-session", "sessions", "password", "my-bookings"].includes(resource)) return true;
  if (["bookings", "slots", "service-catalog", "services"].includes(resource)) return true;
  return CRUD_WORDS.test(normalize(text)) || /(?:خدمات کلینیک|محتوای صفحه|مدیریت کلینیک|care guide|service group|landing page)/iu.test(normalize(text));
}

export function isBookingCreateIntent(textInput: string): boolean {
  const text = normalize(textInput).toLowerCase();
  if (!BOOKING_WORDS.test(text)) return false;
  if (/(?:لیست|فهرست|نمایش|نشان بده|جزئیات|وضعیت|حذف|لغو رزرو خودم|my bookings|list bookings|booking status|booking list)/iu.test(text)) return false;
  return /(?:میخواهم|میخوام|میخواستم|رزرو کنم|وقت بگیرم|نوبت بگیرم|\bbook\s+(?:an?\s+)?(?:appointment|booking|slot)|\bbook\s+me\b|\bbook\s+me\s+(?:an?\s+)?(?:appointment|booking|slot)|\bschedule\s+(?:an?\s+)?appointment|\bmake\s+an?\s+appointment|\breserve\s+(?:an?\s+)?(?:appointment|slot))/iu.test(text);
}

function sessionSignature(context: RuleRequestContext): string {
  return createHash("sha256").update(context.sessionCookie).digest("hex");
}
function isExplicitAll(text: string): boolean { return BULK_WORDS.test(normalize(text)); }
function sensitiveAuthMessage(locale: "fa" | "en"): string {
  return locale === "fa"
    ? "🔐 برای حفظ حریم خصوصی، این کار فقط در گفت‌وگوی خصوصی و پس از ورود با پیامک انجام می‌شود. بنویس «می‌خواهم لاگین کنم»."
    : "🔐 For privacy, this workflow is available only in a private chat after SMS sign-in. Say “I want to log in.”";
}
function privateOnly(locale: "fa" | "en"): string {
  return locale === "fa" ? "🔐 این گردش‌کار فقط در گفت‌وگوی خصوصی با ربات مجاز است." : "🔐 This workflow is available only in a private chat with the bot.";
}
function operationTitle(resource: ClinicResource, operation: ClinicOperation, locale: "fa" | "en"): string {
  const fa: Record<string, string> = {
    create: "ساخت", update: "ویرایش", delete: "حذف", bulk: "عملیات گروهی", generate: "تولید بازه‌های نوبت",
    cancel: "لغو رزرو", "mark-read": "خوانده‌شده کردن اعلان‌ها", "revoke-others": "خروج از نشست‌های دیگر",
    change: "تغییر گذرواژه", logout: "خروج از حساب", list: "فهرست", availability: "زمان‌های آزاد", catalog: "کاتالوگ", get: "جزئیات",
  };
  const en: Record<string, string> = {
    create: "Create", update: "Update", delete: "Delete", bulk: "Bulk action", generate: "Generate booking slots",
    cancel: "Cancel booking", "mark-read": "Mark notifications read", "revoke-others": "Sign out other sessions",
    change: "Change password", logout: "Sign out", list: "List", availability: "Available slots", catalog: "Catalog", get: "Details",
  };
  const resourceLabelsFa: Record<string, string> = {
    "service-groups": "گروه خدمات", "service-categories": "دسته خدمات", services: "خدمت", "service-catalog": "کاتالوگ خدمات",
    "care-guides": "راهنمای مراقبت", "care-guide-items": "آیتم راهنمای مراقبت", "landing-marquee": "نوار متحرک صفحه اصلی",
    "landing-services": "کارت خدمات صفحه اصلی", "landing-stats": "آمار صفحه اصلی", "landing-gallery": "گالری صفحه اصلی",
    "landing-hero": "بخش اصلی صفحه", "landing-sections": "بخش‌های صفحه", bookings: "رزرو", slots: "اسلات نوبت",
    "my-bookings": "رزروهای من", notifications: "اعلان", profile: "حساب کاربری", sessions: "نشست", password: "گذرواژه", "auth-session": "نشست",
  };
  const resourceLabelsEn: Record<string, string> = {
    "service-groups": "service group", "service-categories": "service category", services: "service", "service-catalog": "service catalog",
    "care-guides": "care guide", "care-guide-items": "care-guide item", "landing-marquee": "landing marquee item",
    "landing-services": "landing service card", "landing-stats": "landing statistic", "landing-gallery": "landing gallery item",
    "landing-hero": "landing hero", "landing-sections": "landing sections", bookings: "booking", slots: "booking slot",
    "my-bookings": "my booking", notifications: "notification", profile: "profile", sessions: "session", password: "password", "auth-session": "session",
  };
  return `${(locale === "fa" ? fa : en)[operation] ?? operation} ${(locale === "fa" ? resourceLabelsFa : resourceLabelsEn)[resource] ?? resource}`;
}

function idFromRequest(text: string): string | undefined {
  return text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu)?.[0];
}
function ordinal(textInput: string): number | null {
  const text = normalize(textInput).toLowerCase();
  const names: Record<string, number> = {
    "اول": 1, "اولی": 1, "اولین": 1, first: 1, "1st": 1,
    "دوم": 2, "دومی": 2, "دومین": 2, second: 2, "2nd": 2,
    "سوم": 3, "سومی": 3, "سومین": 3, third: 3, "3rd": 3,
    "چهارم": 4, "چهارمی": 4, fourth: 4, "4th": 4,
    "پنجم": 5, "پنجمین": 5, fifth: 5, "5th": 5,
    "ششم": 6, sixth: 6, "6th": 6,
    "هفتم": 7, seventh: 7, "7th": 7,
    "هشتم": 8, eighth: 8, "8th": 8,
    "نهم": 9, ninth: 9, "9th": 9,
    "دهم": 10, tenth: 10, "10th": 10,
  };
  const hit = Object.entries(names).find(([word]) => new RegExp(`(?:^|\\s)${word.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?:$|\\s)`, "iu").test(text));
  if (hit) return hit[1];
  const numeric = text.match(/(?:ردیف|مورد|شماره|گزینه|booking|slot|item|row)?\s*#?\s*(\d{1,3})(?:st|nd|rd|th)?(?:\s|$)/iu);
  return numeric?.[1] ? Number(numeric[1]) : null;
}
function chooseRow(text: string, rows: Row[], resource: ClinicResource, locale: "fa" | "en"): Row | null {
  const id = idFromRequest(text);
  if (id) return rows.find((row) => row.id === id) ?? null;
  const position = ordinal(text);
  if (position !== null && position >= 1) return rows[position - 1] ?? null;
  const normalized = normalize(text).toLowerCase();
  const matches = rows.filter((row) => {
    const title = normalize(rowTitle(resource, row, locale)).toLowerCase();
    const slug = typeof row.slug === "string" ? normalize(row.slug).toLowerCase() : "";
    return (title && (normalized === title || normalized.includes(title))) || (slug && normalized.includes(slug));
  });
  return matches.length === 1 ? matches[0]! : null;
}
function maskPhone(value: unknown): string {
  if (typeof value !== "string" || !value) return "—";
  const digits = value.replace(/\D/g, "");
  return digits.length < 4 ? "••••" : `••••••${digits.slice(-2)}`;
}
function statusFa(status: unknown): string {
  const map: Record<string, string> = { pending: "در انتظار", paid: "پرداخت‌شده", waiting: "در انتظار پرداخت", done: "انجام‌شده", refunded: "بازپرداخت‌شده", active: "فعال", inactive: "غیرفعال", expired: "منقضی" };
  return typeof status === "string" ? map[status] ?? status : "نامشخص";
}
function rowCard(resource: ClinicResource, row: Row, index: number, locale: "fa" | "en"): string {
  const title = rowTitle(resource, row, locale);
  const id = str(row.id);
  if (["bookings", "my-bookings"].includes(resource)) {
    const when = str(row.slotStart ?? row.slotDate, "زمان ثبت نشده");
    const status = locale === "fa" ? statusFa(row.status) : str(row.status, "unknown");
    const name = resource === "bookings" ? `\n• نام: ${str(row.fullName)}` : "";
    const canCancel = resource === "my-bookings" ? `\n• امکان لغو: ${row.canCancel === true ? "بله" : "خیر"}` : "";
    return `**${index + 1}. ${truncate(title, 100)}**${name}\n• زمان: ${when}\n• وضعیت: ${status}${canCancel}\n• شناسه: ${id}`;
  }
  if (resource === "slots") {
    const available = row.available === true ? "✅ آزاد" : row.available === false ? "⛔ پر/غیرفعال" : row.isActive === true ? "🟢 فعال" : row.isActive === false ? "⚪ غیرفعال" : statusFa(row.status);
    const capacity = num(row.capacity);
    const booked = num(row.bookedCount);
    const remaining = Math.max(0, capacity - booked);
    return `**${index + 1}. ${str(row.slotDate)} · ${str(row.startTime)}–${str(row.endTime)}**\n• ظرفیت: ${capacity} · رزروشده: ${booked} · ظرفیت باقی‌مانده: ${remaining}\n• وضعیت: ${available}\n• شناسه: ${id}`;
  }
  const translations = tr(row, locale);
  const summary = str(row.description ?? translations.description ?? row.shortDesc ?? translations.shortDesc ?? row.caption ?? translations.caption, "");
  const active = typeof row.isActive === "boolean" ? `\n• ${locale === "fa" ? "وضعیت" : "Status"}: ${row.isActive ? (locale === "fa" ? "فعال" : "active") : (locale === "fa" ? "غیرفعال" : "inactive")}` : "";
  const slug = typeof row.slug === "string" ? `\n• Slug: ${row.slug}` : "";
  const count = typeof row.categoryCount === "number" ? `\n• ${locale === "fa" ? "دسته‌ها" : "Categories"}: ${row.categoryCount}` : typeof row.serviceCount === "number" ? `\n• ${locale === "fa" ? "خدمات" : "Services"}: ${row.serviceCount}` : "";
  const price = row.price !== undefined ? `\n• ${locale === "fa" ? "قیمت" : "Price"}: ${row.price === null ? "درخواست قیمت" : String(row.price)}` : "";
  const summaryLine = summary ? `\n• ${truncate(summary, 180)}` : "";
  return `**${index + 1}. ${truncate(title, 120)}**${slug}${active}${count}${price}${summaryLine}\n• ${locale === "fa" ? "شناسه" : "ID"}: ${id}`;
}
function paginationText(resource: ClinicResource, data: unknown): string {
  const record = asRecord(data);
  if (!record) return "";
  const page = num(record.page, 0);
  const total = num(record.total, 0);
  if (!page && !total) return "";
  return `\n📄 صفحه ${page || 1} · کل ${total}`;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = asRecord(value);
  if (!record) return JSON.stringify(value);
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}
function nameValue(data: unknown): string {
  const record = asRecord(data);
  if (!record) return "";
  return str(record.name ?? record.fullName ?? asRecord(record.user)?.fullName, "");
}
function requiredFields(resource: ClinicResource): string {
  const fa: Record<string, string> = {
    "service-groups": "slug و نام فارسی و انگلیسی (translations.fa.name و translations.en.name)",
    "service-categories": "شناسهٔ گروه خدمات، slug و نام فارسی و انگلیسی",
    services: "شناسهٔ دسته، slug و عنوان فارسی و انگلیسی؛ در صورت نیاز، توضیح و قیمت",
    "care-guides": "slug و نام فارسی و انگلیسی",
    "care-guide-items": "شناسهٔ راهنما و عنوان فارسی و انگلیسی",
    "landing-marquee": "متن فارسی و انگلیسی",
    "landing-services": "عنوان فارسی و انگلیسی",
    "landing-stats": "مقدار عددی و برچسب فارسی و انگلیسی",
    "landing-gallery": "نشانی تصویر و متن جایگزین فارسی و انگلیسی",
    "landing-hero": "فیلدهای اصلی لازم برای هر دو زبان؛ یا فقط فیلدی مانند image",
    "landing-sections": "کلید بخش و عنوان فارسی و انگلیسی (برای SEO، مقدار هر زبان)",
    slots: "تاریخ میلادی، ساعت شروع و پایان، ظرفیت؛ یا گروهی از این فیلدها برای هر اسلات",
  };
  return fa[resource] ?? "همهٔ فیلدهای لازم و معتبر API";
}
function proposalDetails(command: ClinicCommand, target: Row | undefined, locale: "fa" | "en"): string {
  const input = asRecord(command.input) ?? {};
  const resource = command.resource;
  if (resource === "password") return locale === "fa" ? "• گذرواژهٔ جدید: [پنهان]" : "• New password: [hidden]";
  if (resource === "bookings" && command.operation === "create") {
    return `• نام: ${str(input.fullName)}\n• تلفن: ${maskPhone(input.phone)}\n• گروه خدمات: ${str(asRecord(target)?.groupTitle)}\n• زمان: ${str(asRecord(target)?.slotDate)} ${str(asRecord(target)?.startTime)}${typeof input.email === "string" ? `\n• ایمیل: ${input.email.replace(/^(.).+(@.*)$/u, "$1•••$2")}` : ""}`;
  }
  if (resource === "bookings" && target) {
    const safeTarget = `• رزرو: ${str(target.groupTitle)} · ${str(target.slotStart)}\n• نام: ${str(target.fullName)}\n• تلفن: ${maskPhone(target.phone)}\n• وضعیت فعلی: ${str(target.status)}`;
    const updates = Object.entries(input).map(([key, value]) => {
      const labels: Record<string, string> = { fullName: "نام", phone: "تلفن جدید", email: "ایمیل جدید", notes: "یادداشت", status: "وضعیت جدید" };
      const display = key === "phone" ? maskPhone(value) : key === "email" && typeof value === "string" ? value.replace(/^(.).+(@.*)$/u, "$1•••$2") : key === "notes" && typeof value === "string" ? `[متن یادداشت، ${value.length} نویسه]` : String(value);
      return `• ${labels[key] ?? key}: ${display}`;
    }).join("\n");
    return `${safeTarget}${updates ? `\n${updates}` : ""}`;
  }
  if (command.operation === "bulk") {
    const action = str(input.action);
    const scope = input.scope === "filtered" ? (locale === "fa" ? "تمام نتایج مطابق فیلتر" : "all matching results") : (locale === "fa" ? "ردیف‌های انتخاب‌شده" : "selected rows");
    const ids = Array.isArray(input.ids) ? input.ids.map(String).join(", ") : "";
    return `• ${locale === "fa" ? "عملیات" : "Action"}: ${action}\n• ${locale === "fa" ? "محدوده" : "Scope"}: ${scope}${ids ? `\n• IDs: ${ids}` : `\n• Filters: ${JSON.stringify(input.filters ?? {})}`}`;
  }
  if (target && command.operation === "delete") return `• ${locale === "fa" ? "مورد" : "Item"}: ${rowTitle(resource, target, locale)}\n• ID: ${str(target.id)}`;
  const encoded = JSON.stringify(input, null, 2);
  return encoded && encoded !== "{}" ? truncate(encoded, 1200) : (locale === "fa" ? "• اجرای عملیات مشخص‌شده" : "• Run the requested operation");
}

function statusFromText(textInput: string): string | null {
  const text = normalize(textInput).toLowerCase();
  const pairs: Array<[RegExp, string]> = [
    [/(?:پرداخت شد|پرداختش کن|پرداختشده|paid|mark.*paid)/iu, "paid"],
    [/(?:در انتظار|منتظر|waiting|pending)/iu, text.includes("pending") ? "pending" : "waiting"],
    [/(?:انجام شد|تکمیل|تمام شد|done|complete)/iu, "done"],
    [/(?:بازپرداخت|برگشت وجه|refund|refunded)/iu, "refunded"],
  ];
  return pairs.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}
function adminBookingIntent(textInput: string): ClinicOperation | null {
  const text = normalize(textInput).toLowerCase();
  if (LIST_WORDS.test(text) || /(?:رزروها|نوبتها|appointments|bookings)/iu.test(text) && !RESOURCE_ACTIONS.test(text)) return "list";
  if (/(?:عملیات گروهی|bulk)/iu.test(text)) return "bulk";
  if (DELETE_WORDS.test(text)) return "delete";
  if (STATUS_WORDS.test(text) || statusFromText(text)) return "update";
  if (/(?:جزئیات|اطلاعات|نمایش|show|details|get|read)/iu.test(text)) return "get";
  if (/ویرایش|تغییر|edit|update|change/iu.test(text)) return "update";
  if (/همه|تمام|all|every|filtered|matching/iu.test(text)) return "bulk";
  return null;
}
function dateForApi(text: string): string | null {
  const matches = extractDates(text);
  if (matches.length !== 1) {
    const direct = normalize(text).match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/u);
    if (direct) {
      const year = Number(direct[1]);
      const month = Number(direct[2]);
      const day = Number(direct[3]);
      const date = new Date(Date.UTC(year, month - 1, day));
      return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
        ? `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
        : null;
    }
    return null;
  }
  const date = matches[0]!.date;
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function entityItems(resource: ClinicResource, data: unknown): Row[] {
  if (resource === "service-catalog") {
    const record = asRecord(data);
    return asRows(record?.groups);
  }
  if (resource === "notifications") return asRows(data);
  return asRows(data);
}

export class TelegramClinicOperations {
  private readonly states = new Map<string, State>();

  constructor(
    private readonly api = new ClinicOperationsApi(),
    private readonly planner: ClinicPlanner = planClinicRequest,
    private readonly now = Date.now,
    private readonly onAuthSessionInvalidated?: (owner: string) => Promise<boolean | void>,
  ) {}

  clear(owner: string): void { this.states.delete(owner); }
  private async invalidateStoredSession(owner: string): Promise<boolean> {
    let cleared = true;
    try {
      cleared = (await this.onAuthSessionInvalidated?.(owner)) !== false;
    } catch {
      cleared = false;
    } finally {
      this.clear(owner);
    }
    return cleared;
  }
  isCollecting(owner: string): boolean {
    const state = this.states.get(owner);
    return Boolean(state && (state.pending || state.booking || state.bookingAction || state.bookingUpdate || state.passwordDraft || state.bookingEdit || state.awaiting));
  }
  hasConversation(owner: string): boolean { return this.states.has(owner); }
  expectsSensitiveInput(owner: string): boolean { return sensitiveClinicInputPending(this.states.get(owner)); }
  expectsPhone(owner: string): boolean {
    const state = this.states.get(owner);
    return state?.booking?.stage === "phone" || state?.bookingEdit?.field === "phone";
  }

  async handle(owner: string, text: string, context: RuleRequestContext | null, privateChat: boolean, locale: "fa" | "en" = "fa"): Promise<ClinicWorkflowReply | null> {
    const value = normalize(text);
    const previous = this.states.get(owner);
    const now = this.now();
    for (const [key, state] of this.states) if (state.expires <= now) this.states.delete(key);
    let state = this.states.get(owner);
    const expiredSensitiveInput = Boolean(previous && previous.expires <= now && sensitiveClinicInputPending(previous));
    if (expiredSensitiveInput) {
      this.clear(owner);
      if (CANCEL.test(value)) return { reply: locale === "fa" ? "⏳ مرحلهٔ خصوصی منقضی شد و لغو شد؛ هیچ تغییری انجام نشد." : "⏳ The private step expired and was cancelled; nothing changed.", status: "clinic-expired" };
      return {
        reply: locale === "fa" ? "⏳ مرحلهٔ خصوصی منقضی شد؛ این پیام به سرویس یا مدل ارسال نشد. گردش‌کار را دوباره شروع کن." : "⏳ That private step expired. This message was not sent to the service or the model; start the workflow again.",
        status: "clinic-expired-sensitive",
        deleteSensitiveMessage: true,
      };
    }
    const hasLocalDraft = Boolean(state?.booking || state?.bookingAction || state?.bookingUpdate || state?.passwordDraft || state?.bookingEdit);
    const ownBookingCancelFollowup = state?.resource === "my-bookings"
      && MY_BOOKINGS_DIRECT.test(value)
      && /(?:لغو|کنسل|cancel)/iu.test(value)
      && !/(?:مدیریت|مدیر|admin)/iu.test(value);
    const explicitResource = hasLocalDraft ? null : ownBookingCancelFollowup ? "my-bookings" : clinicResourceFromText(value);
    const explicit = hasLocalDraft ? false : isClinicOperationsRequest(value);
    const follows = Boolean(state && (state.pending || state.booking || state.bookingAction || state.bookingUpdate || state.passwordDraft || state.bookingEdit || state.awaiting || CRUD_WORDS.test(value) || /(?:ردیف|مورد|گزینه|اول|دوم|سوم|چهارم|پنجم|شناسه|صفحه|بعد|لغو|تایید|تأیید|confirm|cancel|next|first|second|third|fourth|fifth|#?\d{1,3}|active|inactive|status|price|slug)/iu.test(value)));
    const expiredConfirm = Boolean(previous && previous.expires <= now && CONFIRM.test(value));
    if (!explicit && !follows && !expiredConfirm) return null;

    const reply = (message: string, status = "clinic-pending", deleteSensitiveMessage = false): ClinicWorkflowReply => ({
      reply: message,
      status,
      ...(deleteSensitiveMessage ? { deleteSensitiveMessage: true } : {}),
    });
    if (!privateChat) return reply(privateOnly(locale), "clinic-private-only", sensitiveClinicInputPending(state));
    if (!context?.actorId.trim() || !context.sessionCookie.trim()) {
      const sensitiveInput = sensitiveClinicInputPending(state);
      this.clear(owner);
      return reply(sensitiveAuthMessage(locale), "clinic-auth-required", sensitiveInput);
    }
    if (expiredConfirm && !explicit) {
      this.clear(owner);
      return reply(locale === "fa" ? "⏳ زمان این درخواست تمام شد؛ عملیات را دوباره از ابتدا شروع کن. هیچ تغییری انجام نشد." : "⏳ This request expired. Start again; no change was made.", "clinic-expired");
    }
    if (state && (state.actor !== context.actorId || state.session !== sessionSignature(context))) {
      const sensitiveInput = sensitiveClinicInputPending(state);
      this.clear(owner);
      state = undefined;
      if (!explicit) return reply(locale === "fa" ? "🔐 نشست ورود تغییر کرده؛ درخواست را دوباره شروع کن." : "🔐 Your sign-in session changed. Start the request again.", "clinic-session-changed", sensitiveInput);
    }
    if (CANCEL.test(value)) {
      this.clear(owner);
      return reply(locale === "fa" ? "↩️ درخواست لغو شد؛ هیچ عملیاتی اجرا نشد." : "↩️ Cancelled. Nothing was executed.", "clinic-cancelled");
    }
    if (state?.pending && !CONFIRM.test(value)) {
      if (explicitResource && explicitResource !== state.resource) {
        this.clear(owner);
        state = undefined;
      } else {
        return reply(locale === "fa" ? "🔎 عملیات قبلی هنوز منتظر پاسخ است. برای اجرا «تأیید» و برای کنارگذاشتن «لغو» بفرست." : "🔎 A previous operation is waiting. Reply “confirm” to run it or “cancel” to discard it.", "clinic-awaiting-confirmation");
      }
    }
    if (state && explicitResource && state.resource && explicitResource !== state.resource && !state.pending) {
      this.clear(owner);
      state = undefined;
    }
    if (!state) {
      if (this.states.size >= 1000) return reply(locale === "fa" ? "⏳ درخواست‌های زیادی در حال انجام است؛ کمی بعد دوباره تلاش کن." : "⏳ Too many requests are active; try again shortly.", "clinic-busy");
      state = { actor: context.actorId, session: sessionSignature(context), expires: this.now() + TTL_MS, rows: [], query: {}, ...(explicitResource ? { resource: explicitResource } : {}) };
      this.states.set(owner, state);
    }

    if (state.pending) {
      if (!CONFIRM.test(value)) return reply(locale === "fa" ? "برای اجرا «تأیید» یا برای انصراف «لغو» بفرست." : "Reply “confirm” to run it or “cancel” to discard it.", "clinic-awaiting-confirmation");
      return this.confirm(owner, state, context, locale);
    }
    state.expires = this.now() + TTL_MS;

    if (state.passwordDraft) return this.passwordStep(state, value, locale);
    if (state.bookingUpdate) return this.bookingUpdateStep(state, value, context, locale);
    if (state.bookingEdit) return this.bookingEditStep(state, value, context, locale);
    if (state.booking) return this.bookingStep(state, value, context, locale);

    const resource = state.resource ?? explicitResource;
    if (!resource) {
      this.clear(owner);
      return reply(locale === "fa" ? "🔎 مشخص کن دربارهٔ خدمات، رزروها، زمان‌های آزاد، راهنمای مراقبت، محتوای صفحه اصلی یا اعلان‌ها می‌پرسی." : "🔎 Tell me whether you mean services, bookings, available slots, care guides, landing content, or notifications.", "clinic-clarify");
    }
    state.resource = resource;

    if (resource === "bookings" && isBookingCreateIntent(value)) return this.startBooking(state, context, locale);
    if (resource === "my-bookings") return this.myBookings(state, value, context, locale);
    if (resource === "bookings") return this.adminBookings(state, value, context, locale);
    if (resource === "notifications") return this.notifications(state, value, context, locale);
    if (resource === "profile") return this.profile(state, context, locale);
    if (resource === "sessions") return this.propose({ resource, operation: "revoke-others", input: {} }, state, undefined, locale);
    if (resource === "password") {
      state.passwordDraft = { stage: "new" };
      return reply(locale === "fa" ? "🔐 گذرواژهٔ جدید را بفرست. باید دست‌کم ۸ نویسه و شامل حروف کوچک و بزرگ، عدد و نشانه باشد. این پیام به مدل ارسال نمی‌شود و برای حذف از تلگرام تلاش می‌کنم." : "🔐 Send the new password (at least 8 characters, with upper- and lowercase, a number, and a symbol). It is not sent to the model; I will try to delete the message.", "clinic-password-prompt");
    }
    if (resource === "auth-session") return this.propose({ resource, operation: "logout", input: {} }, state, undefined, locale);
    if (resource === "service-catalog") return this.runRead({ resource, operation: "catalog", input: {} }, state, context, locale);
    if (resource === "slots" && state.awaiting && dateForApi(value)) {
      const date = dateForApi(value)!;
      const requested = state.awaiting;
      state.awaiting = undefined;
      const groupId = requested ? idFromRequest(requested) : null;
      return this.runRead({ resource, operation: "availability", input: { from: date, to: date, ...(groupId ? { groupId } : {}) } }, state, context, locale);
    }
    if (resource === "slots" && /(?:زمان آزاد|نوبت آزاد|available|availability)/iu.test(value) && !RESOURCE_ACTIONS.test(value)) {
      const date = dateForApi(value);
      if (!date) {
        state.awaiting = value;
        return reply(locale === "fa" ? "📅 برای دیدن زمان‌های آزاد، یک تاریخ دقیق بفرست؛ مثلاً «زمان‌های آزاد 2026-12-01». برای تاریخ شمسی هم روز، ماه و سال را بنویس." : "📅 Include one specific date, for example “available slots 2026-12-01”.", "clinic-date-required");
      }
      const groupId = idFromRequest(value);
      return this.runRead({ resource, operation: "availability", input: { from: date, to: date, ...(groupId ? { groupId } : {}) } }, state, context, locale);
    }
    if (resource === "slots" && /(?:اسلات|slot)/iu.test(value) && !RESOURCE_ACTIONS.test(value)) {
      const date = dateForApi(value);
      const status = /\b(?:inactive|disabled)\b|غیرفعال/iu.test(value)
        ? "inactive"
        : /\bexpired\b|منقضی/iu.test(value)
          ? "expired"
          : /\b(?:active|enabled)\b|فعال/iu.test(value) ? "active" : undefined;
      const groupId = idFromRequest(value);
      const query = {
        ...state.query,
        ...(date ? { search: date, perPage: 100 } : {}),
        ...(status ? { status } : {}),
        ...(groupId ? { groupId } : {}),
      };
      return this.runRead({ resource, operation: "list", input: query }, state, context, locale);
    }
    return this.planAndRun(state, resource, value, context, locale);
  }

  private async startBooking(state: State, context: RuleRequestContext, locale: "fa" | "en"): Promise<ClinicWorkflowReply> {
    const result = await this.api.execute({ resource: "service-groups", operation: "list", input: { page: 1, perPage: 100, status: "active" } }, context);
    if (!result.ok) return this.failure(result.code, result.status, locale);
    const groups = asRows(result.data);
    if (!groups.length) return { reply: locale === "fa" ? "📭 گروه خدمات فعالی برای رزرو پیدا نشد." : "📭 No active service groups were found.", status: "booking-no-groups" };
    state.resource = "bookings";
    state.rows = groups;
    state.booking = { stage: "group", groups, slots: [] };
    const listing = groups.slice(0, 20).map((group, i) => `${i + 1}. ${rowTitle("service-groups", group, locale)}${group.id ? ` · ${group.id}` : ""}`).join("\n");
    return { reply: locale === "fa" ? `**📅 رزرو نوبت**\n\nگروه خدمات را انتخاب کن:\n${listing}\n\nشماره یا شناسه را بفرست. برای انصراف «لغو» بنویس. هیچ رزروی هنوز ثبت نشده.` : `**📅 Book an appointment**\n\nChoose a service group:\n${listing}\n\nSend its number or ID. Say “cancel” to stop. Nothing has been booked.`, status: "booking-choose-group" };
  }

  private async bookingStep(state: State, value: string, context: RuleRequestContext, locale: "fa" | "en"): Promise<ClinicWorkflowReply> {
    const draft = state.booking!;
    if (draft.stage === "group") {
      const group = chooseRow(value, draft.groups, "service-groups", locale);
      if (!group) {
        const listing = draft.groups.slice(0, 20).map((item, index) => `${index + 1}. ${rowTitle("service-groups", item, locale)}${item.id ? ` · ${item.id}` : ""}`).join("\n");
        return { reply: locale === "fa" ? `🔎 یک گروه معتبر را از فهرست انتخاب کن:\n${listing}\n\nشماره یا شناسه را بفرست؛ برای انصراف «لغو» را بزن.` : `🔎 Choose a valid group from the list:\n${listing}\n\nSend its number or ID, or cancel.`, status: "booking-group-invalid" };
      }
      draft.group = group;
      draft.stage = "date";
      return { reply: locale === "fa" ? `✅ گروه «${rowTitle("service-groups", group, locale)}» انتخاب شد.\n📅 حالا تاریخ موردنظر را بفرست؛ می‌توانی تاریخ میلادی، شمسی، «امروز» یا «فردا» بنویسی.` : `✅ Selected “${rowTitle("service-groups", group, locale)}”.\n📅 Send the date: Gregorian, Jalali, “today”, or “tomorrow”.`, status: "booking-date" };
    }
    if (draft.stage === "date") {
      const date = dateForApi(value);
      if (!date || !draft.group || typeof draft.group.id !== "string") return { reply: locale === "fa" ? "📅 تاریخ معتبر و یکتا پیدا نشد. یک تاریخ را واضح بفرست؛ نمونه: 2026-12-01، ۱۴۰۵/۰۹/۱۰، یا «فردا»." : "📅 I couldn't resolve one valid date. Send one date, such as 2026-12-01 or “tomorrow”.", status: "booking-date-invalid" };
      const result = await this.api.execute({ resource: "slots", operation: "availability", input: { from: date, to: date, groupId: draft.group.id } }, context);
      if (!result.ok) return this.failure(result.code, result.status, locale);
      const all = asRows(result.data);
      const slots = all.filter((slot) => slot.available === true);
      if (!slots.length) return { reply: locale === "fa" ? `📭 برای ${date} زمان آزادی برای این گروه پیدا نشد. تاریخ دیگری بفرست؛ رزروی انجام نشده.` : `📭 No available slots were found for ${date}. Send another date; nothing has been booked.`, status: "booking-no-slots" };
      draft.date = date;
      draft.slots = slots;
      draft.stage = "slot";
      const listing = slots.slice(0, 20).map((slot, i) => `${i + 1}. ${str(slot.slotDate)} · ${str(slot.startTime)}–${str(slot.endTime)} · ${Math.max(0, num(slot.capacity) - num(slot.bookedCount))} ${locale === "fa" ? "ظرفیت باقی‌مانده" : "places left"}${slot.id ? ` · ${slot.id}` : ""}`).join("\n");
      return { reply: locale === "fa" ? `**🕒 زمان‌های آزاد ${date}**\n${listing}\n\nزمان را با شماره یا شناسه انتخاب کن.` : `**🕒 Available times for ${date}**\n${listing}\n\nChoose a time by number or ID.`, status: "booking-choose-slot" };
    }
    if (draft.stage === "slot") {
      const slot = chooseRow(value, draft.slots, "slots", locale);
      if (!slot) {
        const listing = draft.slots.slice(0, 20).map((item, index) => `${index + 1}. ${str(item.slotDate)} · ${str(item.startTime)}–${str(item.endTime)} · ${Math.max(0, num(item.capacity) - num(item.bookedCount))} ${locale === "fa" ? "ظرفیت باقی‌مانده" : "places left"}${item.id ? ` · ${item.id}` : ""}`).join("\n");
        return { reply: locale === "fa" ? `🔎 یک زمان آزاد را از فهرست انتخاب کن:\n${listing}\n\nشماره یا شناسه را بفرست؛ برای انصراف «لغو» را بزن.` : `🔎 Choose an available time from the list:\n${listing}\n\nSend its number or ID, or cancel.`, status: "booking-slot-invalid" };
      }
      draft.slot = slot;
      draft.stage = "name";
      return { reply: locale === "fa" ? "👤 نام و نام خانوادگی برای رزرو را بفرست. این پیام به مدل ارسال نمی‌شود و برای حذفش از تلگرام تلاش می‌کنم." : "👤 Send the full name for the booking. This message is not sent to the model; I will try to delete it.", status: "booking-name" };
    }
    if (draft.stage === "name") {
      const parsed = createBookingSchema.shape.fullName.safeParse(value);
      if (!parsed.success) return { reply: locale === "fa" ? "⚠️ نام باید بین ۲ تا ۱۶۰ نویسه باشد؛ دوباره بفرست." : "⚠️ Name must be 2–160 characters. Send it again.", status: "booking-name-invalid", deleteSensitiveMessage: true };
      draft.fullName = parsed.data;
      draft.stage = "phone";
      return { reply: locale === "fa" ? "📱 شماره تماس را بفرست (با کد کشور؛ فقط برای رزرو استفاده می‌شود). پیام برای حذف از تلگرام ارسال می‌شود و به مدل نمی‌رسد." : "📱 Send a contact phone number with country code. It is used only for this booking; I will try to delete the message and it is never sent to the model.", status: "booking-phone", deleteSensitiveMessage: true };
    }
    if (draft.stage === "phone") {
      const parsed = createBookingSchema.shape.phone.safeParse(value);
      if (!parsed.success) return { reply: locale === "fa" ? "⚠️ شماره تماس معتبر نیست؛ شماره را با کد کشور دوباره بفرست." : "⚠️ That phone number is invalid. Send it again with country code.", status: "booking-phone-invalid", deleteSensitiveMessage: true };
      draft.phone = parsed.data;
      draft.stage = "email";
      return { reply: locale === "fa" ? "✉️ ایمیل اختیاری است؛ اگر نمی‌خواهی وارد کنی «رد کن» بنویس. پیام ایمیل به مدل نمی‌رسد و برای حذفش تلاش می‌کنم." : "✉️ Email is optional. Say “skip” if you don't want to provide it. It is not sent to the model; I will try to delete the message.", status: "booking-email", deleteSensitiveMessage: true };
    }
    if (draft.stage === "email") {
      if (/^(?:رد کن|رد|بدون ایمیل|ندارم|skip|none|no email)$/iu.test(value)) draft.email = null;
      else {
        const parsed = createBookingSchema.shape.email.safeParse(value);
        if (!parsed.success || !parsed.data) return { reply: locale === "fa" ? "⚠️ ایمیل معتبر نیست. یک ایمیل بفرست یا «رد کن» بنویس." : "⚠️ That email is invalid. Send a valid email or say “skip”.", status: "booking-email-invalid", deleteSensitiveMessage: true };
        draft.email = parsed.data;
      }
      const input = createBookingSchema.parse({
        fullName: draft.fullName,
        phone: draft.phone,
        ...(draft.email ? { email: draft.email } : {}),
        groupId: draft.group?.id,
        slotId: draft.slot?.id,
        locale,
      });
      const command: ClinicCommand = { resource: "bookings", operation: "create", input };
      const slot = draft.slot;
      const target = slot ? { ...slot, groupTitle: rowTitle("service-groups", draft.group ?? {}, locale) } : undefined;
      state.booking = undefined;
      return this.propose(command, state, target, locale, "booking-create", true);
    }
    return { reply: HELP_FA, status: "booking-help" };
  }

  private async myBookings(state: State, text: string, context: RuleRequestContext, locale: "fa" | "en"): Promise<ClinicWorkflowReply> {
    const cancel = /(?:لغو|کنسل|حذف|cancel)/iu.test(text);
    const id = idFromRequest(text);
    const selected = chooseRow(text, state.rows, "my-bookings", locale);
    if (cancel && (id || selected)) {
      const targetId = id ?? String(selected?.id ?? "");
      const target = state.rows.find((row) => row.id === targetId) ?? selected ?? undefined;
      if (!target) return { reply: locale === "fa" ? "🔎 ابتدا رزروهای خودت را فهرست کن یا شناسهٔ دقیق رزرو را بفرست." : "🔎 List your bookings first or send the exact booking ID.", status: "my-booking-not-found" };
      if (target.canCancel !== true) return { reply: locale === "fa" ? "⛔ این رزرو طبق وضعیت یا مهلت لغو کلینیک قابل لغو نیست." : "⛔ This booking is not cancellable under the clinic's status or cancellation window.", status: "my-booking-locked" };
      state.target = target;
      return this.propose({ resource: "my-bookings", operation: "cancel", id: targetId, input: {} }, state, target, locale, "my-booking-cancel");
    }
    if (LIST_WORDS.test(text) || state.rows.length === 0 || MY_WORDS.test(text)) {
      return this.runRead({ resource: "my-bookings", operation: "list", input: { page: 1, perPage: 10, status: "all" } }, state, context, locale);
    }
    if (cancel) return { reply: locale === "fa" ? "برای لغو، ابتدا فهرست رزروهای خودت را بخواه و سپس شماره یا شناسهٔ رزرو را بفرست." : "To cancel, list your bookings first, then send the booking number or ID.", status: "my-booking-select" };
    return this.planAndRun(state, "my-bookings", text, context, locale);
  }

  private async adminBookings(state: State, text: string, context: RuleRequestContext, locale: "fa" | "en"): Promise<ClinicWorkflowReply> {
    if (/(?:لغو|کنسل|cancel)/iu.test(text) && !DELETE_WORDS.test(text)) {
      state.bookingAction = undefined;
      state.bookingUpdate = undefined;
      return { reply: locale === "fa" ? "لغو مشتری از مسیر «رزروهای من» انجام می‌شود. اگر مدیر هستی، رزرو را با وضعیت مناسب به‌روزرسانی یا پس از بررسی صریحاً حذف کن." : "Customers cancel through “my bookings.” Admins can update a booking status or explicitly delete it after review.", status: "booking-cancel-route-clarify" };
    }
    const explicitOperation = adminBookingIntent(text);
    const operation = explicitOperation ?? state.bookingAction ?? null;
    if (explicitOperation && state.bookingAction) state.bookingAction = undefined;
    if (operation === "list" || state.rows.length === 0 && !operation) {
      const status = statusFromText(text);
      return this.runRead({ resource: "bookings", operation: "list", input: { page: 1, perPage: 20, status: status ?? "all" } }, state, context, locale);
    }
    const id = idFromRequest(text);
    const selected = chooseRow(text, state.rows, "bookings", locale);
    const targetId = id ?? (selected?.id as string | undefined);
    if (operation === "bulk") {
      const action = DELETE_WORDS.test(text) ? "delete" : statusFromText(text) === "paid" ? "pay" : statusFromText(text) === "done" ? "done" : statusFromText(text) === "refunded" ? "refund" : null;
      if (!action) return { reply: locale === "fa" ? "🔎 عملیات گروهی رزرو را مشخص کن: ثبت پرداخت، تکمیل، بازپرداخت یا حذف. برای «همه» باید فیلتر روشن باشد." : "🔎 Choose a bulk action: record payment, mark done, refund, or delete. Specify filters when targeting all matching bookings.", status: "booking-bulk-clarify" };
      const all = isExplicitAll(text);
      const input = all
        ? { action, scope: "filtered", filters: { status: statusFromText(text) ?? "all" } }
        : { action, scope: "page", ids: state.rows.map((row) => String(row.id)) };
      return this.propose({ resource: "bookings", operation: "bulk", input }, state, undefined, locale, "booking-bulk");
    }
    if (["get", "delete", "update"].includes(operation ?? "") && !targetId) {
      state.bookingAction = operation as "get" | "delete" | "update";
      const choices = state.rows.slice(0, 10).map((row, index) => rowCard("bookings", row, index, locale)).join("\n\n");
      return { reply: locale === "fa" ? `🔎 رزرو یکتایی انتخاب نشد؛ یکی از این موارد را انتخاب کن یا فهرست رزروها را دوباره بخواه.\n\n${choices || "📭 رزروی در فهرست فعلی نیست."}` : `🔎 I couldn't identify one booking. Choose one of these or list bookings again.\n\n${choices || "📭 There are no bookings in the current list."}`, status: "booking-select" };
    }
    if (targetId && state.bookingAction === operation) state.bookingAction = undefined;
    if (operation === "get" && targetId) return this.runRead({ resource: "bookings", operation: "get", id: targetId, input: {} }, state, context, locale);
    if (operation === "delete" && targetId) {
      const current = await this.api.execute({ resource: "bookings", operation: "get", id: targetId, input: {} }, context);
      if (!current.ok) return this.failure(current.code, current.status, locale);
      const row = asRecord(current.data) ?? {};
      state.target = row;
      return this.propose({ resource: "bookings", operation: "delete", id: targetId, input: {} }, state, row, locale, "booking-delete");
    }
    if (operation === "update" && targetId) {
      const status = statusFromText(text);
      const field = /(?:تلفن|شماره تماس|phone)/iu.test(text) ? "phone"
        : /(?:ایمیل|email)/iu.test(text) ? "email"
          : /(?:یادداشت|notes?)/iu.test(text) ? "notes"
            : /(?:نام|name)/iu.test(text) && !status ? "fullName" : null;
      if (field && !/(?:به|to)\s*[^\s]+$/iu.test(text)) {
        state.bookingEdit = { id: targetId, field };
        return { reply: locale === "fa" ? `✏️ مقدار جدید ${field === "phone" ? "شمارهٔ تماس" : field === "email" ? "ایمیل" : field === "notes" ? "یادداشت" : "نام"} را در پیام بعدی بفرست. پیام خصوصی است و به مدل ارسال نمی‌شود؛ برای حذفش تلاش می‌کنم.` : `✏️ Send the new ${field === "phone" ? "phone" : field === "email" ? "email" : field === "notes" ? "note" : "name"} in your next message. It stays local and is not sent to the model; I will try to delete the message.`, status: "booking-edit-value" };
      }
      if (status) {
        const current = await this.api.execute({ resource: "bookings", operation: "get", id: targetId, input: {} }, context);
        if (!current.ok) return this.failure(current.code, current.status, locale);
        const row = asRecord(current.data) ?? {};
        state.target = row;
        return this.propose({ resource: "bookings", operation: "update", id: targetId, input: { status } }, state, row, locale, "booking-update");
      }
      state.bookingUpdate = { id: targetId };
      return { reply: locale === "fa" ? "برای تغییر رزرو، وضعیت مقصد را انتخاب کن؛ یا نام، شماره تماس، ایمیل یا یادداشت را تغییر بده." : "Choose a new booking status, or select whether to change the name, phone, email, or note.", status: "booking-update-clarify" };
    }
    return this.planAndRun(state, "bookings", text, context, locale);
  }

  private async bookingUpdateStep(state: State, value: string, context: RuleRequestContext, locale: "fa" | "en"): Promise<ClinicWorkflowReply> {
    const draft = state.bookingUpdate!;
    const status = statusFromText(value);
    if (status) {
      const current = await this.api.execute({ resource: "bookings", operation: "get", id: draft.id, input: {} }, context);
      state.bookingUpdate = undefined;
      if (!current.ok) return this.failure(current.code, current.status, locale);
      const target = asRecord(current.data) ?? {};
      state.target = target;
      return this.propose({ resource: "bookings", operation: "update", id: draft.id, input: { status } }, state, target, locale, "booking-update");
    }

    const field: BookingEditDraft["field"] | null = /(?:تلفن|شماره تماس|phone)/iu.test(value) ? "phone"
      : /(?:ایمیل|email)/iu.test(value) ? "email"
        : /(?:یادداشت|notes?)/iu.test(value) ? "notes"
          : /(?:نام|name)/iu.test(value) ? "fullName" : null;
    if (field) {
      state.bookingUpdate = undefined;
      state.bookingEdit = { id: draft.id, field };
      const label = field === "phone" ? (locale === "fa" ? "شمارهٔ تماس" : "phone")
        : field === "email" ? (locale === "fa" ? "ایمیل" : "email")
          : field === "notes" ? (locale === "fa" ? "یادداشت" : "note")
            : (locale === "fa" ? "نام" : "name");
      return { reply: locale === "fa" ? `✏️ مقدار جدید ${label} را در پیام بعدی بفرست. پیام خصوصی است و به مدل ارسال نمی‌شود؛ برای حذفش تلاش می‌کنم.` : `✏️ Send the new ${label} in your next message. It stays local and is not sent to the model; I will try to delete it.`, status: "booking-edit-value" };
    }
    return { reply: locale === "fa" ? "برای تغییر رزرو، وضعیت مقصد را انتخاب کن؛ یا نام، شماره تماس، ایمیل یا یادداشت را تغییر بده." : "Choose a new booking status, or select whether to change the name, phone, email, or note.", status: "booking-update-clarify" };
  }

  private async bookingEditStep(state: State, value: string, context: RuleRequestContext, locale: "fa" | "en"): Promise<ClinicWorkflowReply> {
    const draft = state.bookingEdit!;
    let parsed: unknown;
    if (draft.field === "fullName") parsed = updateBookingAdminSchema.shape.fullName.safeParse(value);
    else if (draft.field === "phone") parsed = updateBookingAdminSchema.shape.phone.safeParse(value);
    else if (draft.field === "email") parsed = value === "—" || /^(?:حذف|پاک|clear|remove)$/iu.test(value) ? { success: true, data: null } : updateBookingAdminSchema.shape.email.safeParse(value);
    else parsed = value === "—" || /^(?:حذف|پاک|clear|remove)$/iu.test(value) ? { success: true, data: null } : updateBookingAdminSchema.shape.notes.safeParse(value);
    const check = parsed as { success: boolean; data?: unknown };
    if (!check.success) return { reply: locale === "fa" ? "⚠️ مقدار معتبر نیست؛ آن را دوباره بفرست یا بنویس «لغو». پیام به مدل ارسال نمی‌شود." : "⚠️ Invalid value. Send it again or say “cancel”. It is not sent to the model.", status: "booking-edit-invalid", deleteSensitiveMessage: true };
    const current = await this.api.execute({ resource: "bookings", operation: "get", id: draft.id, input: {} }, context);
    if (!current.ok) { state.bookingEdit = undefined; return this.failure(current.code, current.status, locale); }
    const target = asRecord(current.data) ?? {};
    state.bookingEdit = undefined;
    state.target = target;
    const input = { [draft.field]: check.data };
    return this.propose({ resource: "bookings", operation: "update", id: draft.id, input }, state, target, locale, "booking-update", true);
  }

  private async notifications(state: State, text: string, context: RuleRequestContext, locale: "fa" | "en"): Promise<ClinicWorkflowReply> {
    if (/(?:خوانده|همه را خوانده|mark.*read|read all)/iu.test(text)) return this.propose({ resource: "notifications", operation: "mark-read", input: {} }, state, undefined, locale, "notifications-read");
    return this.runRead({ resource: "notifications", operation: "list", input: {} }, state, context, locale);
  }

  private async profile(state: State, context: RuleRequestContext, locale: "fa" | "en"): Promise<ClinicWorkflowReply> {
    const result = await this.api.execute({ resource: "profile", operation: "get", input: {} }, context);
    if (!result.ok) return this.failure(result.code, result.status, locale);
    const user = asRecord(asRecord(result.data)?.user) ?? {};
    const lines = locale === "fa"
      ? [`**👤 حساب کاربری**`, `• نام: ${str(user.fullName)}`, `• ایمیل: ${str(user.email)}`, `• تلفن: ${maskPhone(user.phone)}`, `• شناسه: ${str(user.id)}`]
      : [`**👤 Account**`, `• Name: ${str(user.fullName)}`, `• Email: ${str(user.email)}`, `• Phone: ${maskPhone(user.phone)}`, `• ID: ${str(user.id)}`];
    state.resource = "profile";
    return { reply: lines.join("\n"), status: "profile-read" };
  }

  private async planAndRun(state: State, resource: ClinicResource, text: string, context: RuleRequestContext, locale: "fa" | "en"): Promise<ClinicWorkflowReply> {
    try {
      const selectedRow = state.awaiting ? chooseRow(text, state.rows, resource, locale) : null;
      const followup = selectedRow
        ? `کاربر ردیف ${state.rows.indexOf(selectedRow) + 1} را انتخاب کرد: ${rowTitle(resource, selectedRow, locale)}`
        : `توضیح تکمیلی کاربر: ${text}`;
      const request = state.awaiting ? `${state.awaiting}\n${followup}` : text;
      const rows = isSensitiveResource(resource) ? [] : safePlannerRows(resource, state.rows, locale);
      const plan = clinicPlanSchema.parse(await this.planner(resource, scrubClinicPlannerText(request), rows, safePlannerQuery(state.query)));
      if (plan.operation === "clarify") {
        state.awaiting = request;
        return { reply: locale === "fa" ? `${resource === "service-catalog" ? "کاتالوگ خدمات" : operationTitle(resource, "list", locale)}\n\n🔎 مورد یا تغییر را دقیق‌تر بگو؛ شناسه را حدس نمی‌زنم.\n\n${HELP_FA}` : `🔎 Please clarify the item or change. I will not guess IDs.\n\n${HELP_EN}`, status: "clinic-clarify" };
      }
      if (plan.operation === "start") {
        state.awaiting = request;
        return { reply: locale === "fa" ? `**✍️ اطلاعات لازم برای ${operationTitle(resource, "create", locale)}**\n\nاین موارد را در پیام بعدی کامل و دقیق بفرست:\n• ${requiredFields(resource)}\n\nنام‌ها و توضیحات را برای فارسی و انگلیسی خودت مشخص کن؛ ترجمه یا شناسه‌ای حدس نمی‌زنم. هنوز تغییری انجام نشده.` : `**✍️ Details needed for ${operationTitle(resource, "create", locale)}**\n\nSend the required fields in your next message:\n• ${requiredFields(resource)}\n\nProvide both Persian and English copy yourself; I will not invent translations or IDs. Nothing has been changed.`, status: "clinic-create-details" };
      }
      state.awaiting = undefined;
      const operation = plan.operation as ClinicOperation;
      let id = plan.id;
      if (id && !state.rows.some((row) => row.id === id) && !text.includes(id)) return { reply: locale === "fa" ? "🔎 از شناسه‌های همین فهرست یا شناسه‌ای که خودت دقیق نوشته‌ای استفاده کن." : "🔎 Use an ID from the current list or an exact ID you typed yourself.", status: "clinic-invalid-id" };
      if (["get", "update", "delete"].includes(operation) && !id && plan.target) {
        const matches = state.rows.filter((row) => {
          const title = normalize(rowTitle(resource, row, locale)).toLowerCase();
          const target = normalize(plan.target!).toLowerCase();
          return title === target || title.includes(target) || target.includes(title);
        });
        if (matches.length === 1) id = String(matches[0]!.id);
        else {
          state.awaiting = request;
          return { reply: locale === "fa" ? `🔎 یک مورد یکتا پیدا نشد؛ ابتدا فهرست را بخواه یا شماره/شناسه را دقیق بفرست.\n${state.rows.slice(0, 10).map((row, i) => `${i + 1}. ${rowTitle(resource, row, locale)} · ${str(row.id)}`).join("\n")}` : `🔎 I couldn't resolve one item. List entries or send an exact number/ID.\n${state.rows.slice(0, 10).map((row, i) => `${i + 1}. ${rowTitle(resource, row, locale)} · ${str(row.id)}`).join("\n")}`, status: "clinic-target-ambiguous" };
        }
      }
      if (["get", "update", "delete"].includes(operation) && !id) {
        const selected = chooseRow(text, state.rows, resource, locale);
        if (selected?.id && typeof selected.id === "string") id = selected.id;
      }
      if (["get", "update", "delete"].includes(operation) && !id) return { reply: locale === "fa" ? "🔎 هدف مشخص نیست؛ فهرست را بخواه و شماره یا شناسهٔ دقیق را بفرست." : "🔎 The target is unclear. List the items and send an exact number or ID.", status: "clinic-target-required" };
      let input = plan.input;
      if (operation === "list") input = { ...state.query, ...input };
      if (operation === "bulk") {
        const body = asRecord(input) ?? {};
        if (body.scope === "filtered" && !isExplicitAll(text)) input = { action: body.action, scope: "page", ids: state.rows.map((row) => String(row.id)) };
        const chosen = asRecord(input) ?? {};
        if (chosen.scope === "page") {
          const ids = Array.isArray(chosen.ids) ? chosen.ids.filter((item): item is string => typeof item === "string") : [];
          const invalid = ids.some((item) => !state!.rows.some((row) => row.id === item) && !text.includes(item));
          if (!ids.length || invalid) return { reply: locale === "fa" ? "🔎 برای عملیات صفحه‌ای، ابتدا فهرست را بگیر و فقط ردیف‌های دیده‌شده یا شناسه‌هایی که خودت فرستاده‌ای انتخاب کن." : "🔎 For a page action, list items first and select only visible rows or IDs you explicitly provide.", status: "clinic-bulk-selection-required" };
        }
        if (chosen.scope === "filtered" && !isExplicitAll(text)) return { reply: locale === "fa" ? "⚠️ عملیات روی همهٔ نتایج فیلترشده نیاز به درخواست صریح «همه» دارد." : "⚠️ Acting on all filtered results requires an explicit request for “all”.", status: "clinic-bulk-all-required" };
      }
      const command: ClinicCommand = { resource, operation, ...(id ? { id } : {}), input };
      const validated = validateClinicCommand(command);
      command.input = validated.input;
      if (["list", "get", "availability", "catalog"].includes(operation)) return this.runRead(command, state, context, locale);
      state.target = undefined;
      if (operation === "update" && (id || resource === "landing-hero" || resource === "landing-sections")) {
        const latest = await this.api.execute({ resource, operation: "get", ...(id ? { id } : {}), input: {} }, context);
        if (!latest.ok) return this.failure(latest.code, latest.status, locale);
        state.target = asRecord(latest.data) ?? {};
      }
      if (operation === "delete" && id) {
        const latest = await this.api.execute({ resource, operation: "get", id, input: {} }, context);
        if (!latest.ok) return this.failure(latest.code, latest.status, locale);
        state.target = asRecord(latest.data) ?? {};
      }
      if (operation === "generate" && resource !== "slots") return { reply: HELP_FA, status: "clinic-unsupported" };
      return this.propose(command, state, state.target, locale);
    } catch (error) {
      return { reply: locale === "fa" ? `⚠️ درخواست کامل و معتبر آماده نشد. فیلدها را دقیق مطابق API بنویس؛ برای ایجاد این نوع مورد لازم است: ${requiredFields(resource)}. هیچ تغییری ارسال نشد.` : `⚠️ I couldn't prepare a valid request. Provide the exact API fields; for this resource, creation needs: ${requiredFields(resource)}. Nothing was changed.`, status: "clinic-invalid" };
    }
  }

  private async runRead(command: ClinicCommand, state: State, context: RuleRequestContext, locale: "fa" | "en"): Promise<ClinicWorkflowReply> {
    const result = await this.api.execute(command, context);
    if (!result.ok) return this.failure(result.code, result.status, locale);
    const resource = command.resource;
    const data = result.data;
    if (command.operation === "get") {
      const row = asRecord(data) ?? {};
      state.rows = [row];
      state.target = row;
      return { reply: this.detailReply(resource, row, locale), status: `${resource}-read` };
    }
    state.query = { ...(asRecord(command.input) ?? {}) };
    state.rows = entityItems(resource, data);
    if (resource === "notifications") {
      const record = asRecord(data) ?? {};
      const items = asRows(record.items);
      const unread = num(record.unreadCount);
      const list = items.map((item, i) => `• ${i + 1}. ${statusFa(item.action)} · ${str(item.entityType)} · ${str(item.createdAt)}`).join("\n");
      return { reply: locale === "fa" ? `**🔔 اعلان‌های اخیر**\n• خوانده‌نشده: ${unread}\n${list || "📭 اعلانی نیست."}\n\nبرای خوانده‌شده کردن همه بنویس «اعلان‌ها را خوانده‌شده کن».` : `**🔔 Recent notifications**\n• Unread: ${unread}\n${list || "📭 No notifications."}\n\nSay “mark all notifications read” to clear the unread state.`, status: "notifications-listed" };
    }
    if (resource === "service-catalog") {
      const record = asRecord(data) ?? {};
      const groups = asRows(record.groups);
      const categories = asRows(record.categories);
      const lines = groups.slice(0, 20).map((group, index) => {
        const children = categories.filter((category) => category.groupId === group.id);
        return `${index + 1}. ${rowTitle("service-groups", group, locale)} · ${children.length} ${locale === "fa" ? "دسته" : "categories"}`;
      }).join("\n");
      return { reply: locale === "fa" ? `**💆 کاتالوگ خدمات**\n• تعداد خدمات: ${num(record.totalServices)}\n${lines || "📭 خدمتی پیدا نشد."}\n\nبرای جزئیات یا مدیریت، یک گروه یا دسته را با شناسهٔ دقیق انتخاب کن.` : `**💆 Service catalog**\n• Services: ${num(record.totalServices)}\n${lines || "📭 No services found."}\n\nFor details or management, choose a group or category using its exact ID.`, status: "service-catalog-listed" };
    }
    const rows = state.rows;
    const display = rows.slice(0, 10).map((row, index) => rowCard(resource, row, index, locale)).join("\n\n");
    const total = num(asRecord(data)?.total, rows.length);
    const page = num(asRecord(data)?.page, 1);
    const message = locale === "fa"
      ? `**${resource === "my-bookings" ? "📅 رزروهای من" : operationTitle(resource, command.operation, locale)}**${paginationText(resource, data)}\n\n${display || "📭 موردی پیدا نشد."}\n\n💬 برای تغییر یک مورد، شماره یا شناسه‌اش را بگو. تعداد کل: ${total}${page > 1 ? ` · صفحه ${page}` : ""}`
      : `**${resource === "my-bookings" ? "📅 My bookings" : operationTitle(resource, command.operation, locale)}**${paginationText(resource, data)}\n\n${display || "📭 No items found."}\n\n💬 To change an item, send its number or ID. Total: ${total}${page > 1 ? ` · page ${page}` : ""}`;
    return { reply: message, status: `${resource}-listed` };
  }

  private detailReply(resource: ClinicResource, row: Row, locale: "fa" | "en"): string {
    if (["bookings", "my-bookings"].includes(resource)) return rowCard(resource, row, 0, locale) + `\n• تلفن: ${maskPhone(row.phone)}\n• ایمیل: ${typeof row.email === "string" ? row.email.replace(/^(.).+(@.*)$/u, "$1•••$2") : "—"}`;
    const summary = JSON.stringify(row, null, 2);
    return `**${rowTitle(resource, row, locale)}**\n${truncate(summary ?? "{}", 1800)}`;
  }

  private async propose(command: ClinicCommand, state: State, target: Row | undefined, locale: "fa" | "en", status?: string, sensitive = false): Promise<ClinicWorkflowReply> {
    try {
      command.input = validateClinicCommand(command).input;
    } catch {
      return { reply: locale === "fa" ? "⚠️ فیلدها با قرارداد API سازگار نیستند؛ هیچ درخواستی ارسال نشد." : "⚠️ The fields do not match the API contract; nothing was sent.", status: "clinic-invalid" };
    }
    state.target = target;
    state.pending = { command, ...(target ? { snapshot: target } : {}), title: operationTitle(command.resource, command.operation, locale) };
    const details = proposalDetails(command, target, locale);
    const dangerous = ["delete", "bulk", "cancel", "generate", "mark-read", "revoke-others", "change", "logout"].includes(command.operation);
    return {
      reply: locale === "fa"
        ? `**🔎 پیش‌نمایش: ${state.pending.title}**\n\n${details}\n\n${dangerous ? "⚠️ این عملیات اثر واقعی دارد." : "🔒 هنوز هیچ تغییری ارسال نشده."}\n✅ اجرا: «تأیید»\n↩️ انصراف: «لغو»\n⏳ اعتبار: ۵ دقیقه`
        : `**🔎 Preview: ${state.pending.title}**\n\n${details}\n\n${dangerous ? "⚠️ This action has real effects." : "🔒 Nothing has been changed yet."}\n✅ Run: “confirm”\n↩️ Discard: “cancel”\n⏳ Expires in 5 minutes`,
      status: status ?? "clinic-proposed",
      ...(sensitive ? { deleteSensitiveMessage: true } : {}),
    };
  }

  private async confirm(owner: string, state: State, context: RuleRequestContext, locale: "fa" | "en"): Promise<ClinicWorkflowReply> {
    const pending = state.pending;
    if (!pending) return { reply: locale === "fa" ? "درخواستی برای تأیید وجود ندارد." : "There is nothing waiting for confirmation.", status: "clinic-no-pending" };
    // Single-use before network call; never automatically retry a mutation whose
    // response is ambiguous.
    state.pending = undefined;
    const command = pending.command;
    if (pending.snapshot && ["update", "delete"].includes(command.operation)) {
      const latest = command.resource === "landing-hero" || command.resource === "landing-sections"
        ? await this.api.execute({ resource: command.resource, operation: "get", input: {} }, context)
        : await this.api.execute({ resource: command.resource, operation: "get", id: command.id, input: {} }, context);
      if (!latest.ok || stable(latest.data) !== stable(pending.snapshot)) {
        this.clear(owner);
        return { reply: locale === "fa" ? "⚠️ مورد در سرور تغییر کرده یا بازخوانی نشد؛ برای جلوگیری از بازنویسی اطلاعات جدید، درخواست لغو شد. دوباره فهرست را بررسی کن." : "⚠️ The item changed on the server or could not be reloaded. I cancelled to avoid overwriting newer data; review it and try again.", status: "clinic-conflict" };
      }
    }
    if (command.resource === "my-bookings" && command.operation === "cancel") {
      const listed = await this.api.execute({ resource: "my-bookings", operation: "list", input: { page: 1, perPage: 50, status: "all" } }, context);
      if (!listed.ok || !asRows(listed.data).some((row) => row.id === command.id && row.canCancel === true)) {
        this.clear(owner);
        return { reply: locale === "fa" ? "⚠️ رزرو دیگر قابل لغو نیست یا بازخوانی نشد. فهرست را دوباره بررسی کن." : "⚠️ The booking is no longer cancellable or could not be reloaded. Review your booking list again.", status: "my-booking-conflict" };
      }
    }
    const result = await this.api.execute(command, context);
    if (!result.ok) return this.failure(result.code, result.status, locale);
    state.rows = [];
    state.target = undefined;
    state.awaiting = undefined;
    if (command.resource === "auth-session" && command.operation === "logout") {
      const cleared = await this.invalidateStoredSession(owner);
      return {
        reply: locale === "fa"
          ? `✅ درخواست خروج به سرویس رسید.${cleared ? " نشست ذخیره‌شدهٔ ربات هم پاک شد." : " ⚠️ پاک‌شدن نشست ذخیره‌شده تأیید نشد؛ دوباره وارد شو و اگر ادامه داشت با مدیر تماس بگیر."} برای استفادهٔ دوباره، ورود پیامکی را شروع کن.`
          : `✅ The service signed out this session.${cleared ? " The bot's stored session was cleared too." : " ⚠️ The bot could not confirm clearing its stored session; sign in again and contact an administrator if needed."} Start SMS sign-in to use it again.`,
        status: "auth-logout",
      };
    }
    if (command.resource === "password") {
      const cleared = await this.invalidateStoredSession(owner);
      return {
        reply: locale === "fa"
          ? `✅ گذرواژه تغییر کرد و نشست‌های قبلی باطل شدند.${cleared ? " نشست ذخیره‌شدهٔ ربات هم پاک شد." : " ⚠️ پاک‌شدن نشست ذخیره‌شده تأیید نشد؛ برای اطمینان دوباره وارد شو و با مدیر تماس بگیر."} پیام گذرواژه به مدل ارسال نشد.`
          : `✅ Password changed; the upstream service revoked existing sessions.${cleared ? " The bot's stored session was cleared too." : " ⚠️ The bot could not confirm clearing its saved session; sign in again and contact an administrator if needed."} The password message was not sent to the model.`,
        status: "password-changed",
      };
    }
    if (command.operation === "bulk") {
      const data = asRecord(result.data) ?? {};
      const failures = asRows(data.failures);
      return { reply: locale === "fa" ? `**📋 نتیجهٔ عملیات گروهی**\n• درخواستی: ${num(data.requested)}\n• موفق: ${num(data.succeeded)}\n• ناموفق: ${failures.length}${failures.length ? `\n${failures.slice(0, 10).map((item) => `• ${str(item.id)} · ${/^[A-Z][A-Z0-9_]{0,63}$/u.test(str(item.code, "")) ? item.code : "OPERATION_FAILED"}`).join("\n")}` : ""}` : `**📋 Bulk result**\n• Requested: ${num(data.requested)}\n• Succeeded: ${num(data.succeeded)}\n• Failed: ${failures.length}`, status: "clinic-bulk-completed" };
    }
    if (command.operation === "cancel") {
      const count = num(asRecord(result.data)?.cancelled, 1);
      return { reply: locale === "fa" ? `✅ لغو رزرو ثبت شد. تعداد ردیف‌های لغوشده: ${count}.` : `✅ Booking cancellation recorded. Cancelled rows: ${count}.`, status: "my-booking-cancelled" };
    }
    if (command.operation === "generate") {
      const resultRecord = asRecord(result.data) ?? {};
      return { reply: locale === "fa" ? `✅ تولید اسلات‌ها توسط سرویس انجام شد.${Object.keys(resultRecord).length ? `\n${truncate(JSON.stringify(resultRecord), 500)}` : ""}` : `✅ Slot generation completed.${Object.keys(resultRecord).length ? `\n${truncate(JSON.stringify(resultRecord), 500)}` : ""}`, status: "slots-generated" };
    }
    if (command.operation === "mark-read") return { reply: locale === "fa" ? "✅ اعلان‌های خوانده‌نشده به‌عنوان خوانده‌شده ثبت شدند." : "✅ Unread notifications were marked as read.", status: "notifications-read" };
    if (command.operation === "revoke-others") return { reply: locale === "fa" ? `✅ نشست‌های دیگر بسته شدند. تعداد نشست‌های لغوشده: ${num(asRecord(result.data)?.revoked)}.` : `✅ Other sessions were revoked. Count: ${num(asRecord(result.data)?.revoked)}.`, status: "sessions-revoked" };
    if (command.operation === "delete") return { reply: locale === "fa" ? "✅ حذف در سرویس تأیید شد." : "✅ The service confirmed deletion.", status: "clinic-deleted" };
    if (command.operation === "create") {
      const record = asRecord(result.data) ?? {};
      const id = typeof record.id === "string" ? `\n• شناسه: ${record.id}` : "";
      return { reply: locale === "fa" ? `✅ مورد ایجاد شد.${id}\nبرای بررسی، فهرست را دوباره بخواه.` : `✅ Created.${id}\nList the items again to verify.`, status: "clinic-created" };
    }
    return { reply: locale === "fa" ? "✅ تغییر توسط سرویس تأیید شد. برای بررسی، فهرست را دوباره بخواه." : "✅ The service confirmed the update. List the items again to verify.", status: "clinic-updated" };
  }

  private async passwordStep(state: State, value: string, locale: "fa" | "en"): Promise<ClinicWorkflowReply> {
    const draft = state.passwordDraft!;
    if (draft.stage === "new") {
      const check = changePasswordSchema.shape.password.safeParse(value);
      if (!check.success) return { reply: locale === "fa" ? "⚠️ گذرواژه شرایط لازم را ندارد. یک گذرواژهٔ قوی‌تر بفرست؛ پیام به مدل ارسال نمی‌شود." : "⚠️ That password does not meet the requirements. Send a stronger one; it is not sent to the model.", status: "password-invalid", deleteSensitiveMessage: true };
      draft.password = check.data;
      draft.stage = "confirm";
      return { reply: locale === "fa" ? "🔐 همان گذرواژه را برای تأیید دوباره بفرست. پیام حذف می‌شود و به مدل نمی‌رسد." : "🔐 Send the same password once more to confirm. The message will be deleted and not sent to the model.", status: "password-confirm", deleteSensitiveMessage: true };
    }
    const checked = changePasswordSchema.safeParse({ password: draft.password, confirmPassword: value });
    if (!checked.success) {
      draft.stage = "new";
      draft.password = undefined;
      return { reply: locale === "fa" ? "⚠️ دو گذرواژه یکسان نیستند. از ابتدا یک گذرواژهٔ جدید بفرست." : "⚠️ The passwords do not match. Start again with a new password.", status: "password-mismatch", deleteSensitiveMessage: true };
    }
    state.passwordDraft = undefined;
    return this.propose({ resource: "password", operation: "change", input: checked.data }, state, undefined, locale, "password-proposed", true);
  }

  private failure(code: string, status: number | undefined, locale: "fa" | "en"): ClinicWorkflowReply {
    return {
      reply: locale === "fa"
        ? `**⚠️ درخواست به سرویس نرسید یا تأیید نشد**\n\n• کد: ${/^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : "REQUEST_FAILED"}${status ? `\n• وضعیت: ${status}` : ""}\n🔎 اگر عملیات تغییردهنده بود، نتیجه ممکن است نامشخص باشد؛ پیش از تکرار، فهرست را بازخوانی کن.`
        : `**⚠️ The service did not confirm the request**\n\n• Code: ${/^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : "REQUEST_FAILED"}${status ? `\n• Status: ${status}` : ""}\n🔎 If this was a mutation, its outcome may be unclear. Reload before retrying.`,
      status: "clinic-error",
    };
  }
}

function isSensitiveResource(resource: ClinicResource): boolean {
  return resource === "bookings" || resource === "my-bookings" || resource === "notifications" || resource === "profile" || resource === "password" || resource === "sessions" || resource === "auth-session";
}
