import type { Locale } from "@/lib/config";

const CALLBACK_PREFIX = "nf1:";

type Suggestion = { fa: { label: string; text: string }; en: { label: string; text: string } };
const SUGGESTIONS = {
  help: { fa: { label: "راهنما", text: "/help" }, en: { label: "Help", text: "/help" } },
  login: { fa: { label: "ورود پیامکی", text: "می‌خواهم لاگین کنم" }, en: { label: "SMS sign-in", text: "I want to log in" } },
  today: { fa: { label: "تاریخ امروز", text: "امروز چندمه؟" }, en: { label: "Today's date", text: "What is today's date?" } },
  tomorrow: { fa: { label: "فردا", text: "فردا" }, en: { label: "Tomorrow", text: "tomorrow" } },
  confirm: { fa: { label: "تأیید", text: "تأیید" }, en: { label: "Confirm", text: "confirm" } },
  clinicServices: { fa: { label: "خدمات کلینیک", text: "خدمات کلینیک را نشان بده" }, en: { label: "Clinic services", text: "Show clinic services" } },
  availableSlots: { fa: { label: "زمان‌های آزاد", text: "زمان‌های آزاد را نشان بده" }, en: { label: "Available slots", text: "Show available slots" } },
  careGuides: { fa: { label: "راهنماهای مراقبت", text: "راهنماهای مراقبت را نشان بده" }, en: { label: "Care guides", text: "Show care guides" } },
  notificationsList: { fa: { label: "اعلان‌ها", text: "اعلان‌های اخیر را نشان بده" }, en: { label: "Notifications", text: "Show recent notifications" } },
  bookAppointment: { fa: { label: "رزرو نوبت", text: "برای من نوبت رزرو کن" }, en: { label: "Book an appointment", text: "Book an appointment for me" } },
  myBookings: { fa: { label: "رزروهای من", text: "رزروهای من را نشان بده" }, en: { label: "My bookings", text: "Show my bookings" } },
  bookingsList: { fa: { label: "فهرست رزروهای کلینیک", text: "فهرست رزروهای کلینیک را نشان بده" }, en: { label: "Clinic bookings", text: "List clinic bookings" } },
  bookingPending: { fa: { label: "در انتظار", text: "وضعیت رزرو: pending" }, en: { label: "Pending", text: "Booking status: pending" } },
  bookingPaid: { fa: { label: "پرداخت‌شده", text: "وضعیت رزرو: paid" }, en: { label: "Paid", text: "Booking status: paid" } },
  bookingWaiting: { fa: { label: "در انتظار پرداخت", text: "وضعیت رزرو: waiting" }, en: { label: "Awaiting payment", text: "Booking status: waiting" } },
  bookingDone: { fa: { label: "انجام‌شده", text: "وضعیت رزرو: done" }, en: { label: "Done", text: "Booking status: done" } },
  bookingRefunded: { fa: { label: "بازپرداخت‌شده", text: "وضعیت رزرو: refunded" }, en: { label: "Refunded", text: "Booking status: refunded" } },
  bookingFieldName: { fa: { label: "نام", text: "فیلد رزرو: نام" }, en: { label: "Name", text: "Booking field: name" } },
  bookingFieldPhone: { fa: { label: "شماره تماس", text: "فیلد رزرو: phone" }, en: { label: "Phone", text: "Booking field: phone" } },
  bookingFieldEmail: { fa: { label: "ایمیل", text: "فیلد رزرو: email" }, en: { label: "Email", text: "Booking field: email" } },
  bookingFieldNotes: { fa: { label: "یادداشت", text: "فیلد رزرو: notes" }, en: { label: "Note", text: "Booking field: notes" } },
  bulkPay: { fa: { label: "ثبت پرداخت", text: "عملیات گروهی رزرو: paid" }, en: { label: "Record payment", text: "Bulk booking action: paid" } },
  bulkDone: { fa: { label: "تکمیل", text: "عملیات گروهی رزرو: done" }, en: { label: "Mark done", text: "Bulk booking action: done" } },
  bulkRefund: { fa: { label: "بازپرداخت", text: "عملیات گروهی رزرو: refunded" }, en: { label: "Refund", text: "Bulk booking action: refunded" } },
  bulkDelete: { fa: { label: "حذف رزروها", text: "عملیات گروهی رزرو: delete" }, en: { label: "Delete bookings", text: "Bulk booking action: delete" } },
  rulesList: { fa: { label: "فهرست قوانین", text: "قوانین را فهرست کن" }, en: { label: "List rules", text: "List the rules" } },
  usersList: { fa: { label: "فهرست کاربران", text: "فهرست کاربران را نشان بده" }, en: { label: "List users", text: "Show the user list" } },
  usersCreate: { fa: { label: "ساخت کاربر", text: "کاربر جدید بساز" }, en: { label: "Create a user", text: "Create a new user" } },
  hoursList: { fa: { label: "ساعات کاری", text: "ساعات کاری را نشان بده" }, en: { label: "Working hours", text: "Show working hours" } },
  hoursCreate: { fa: { label: "ساعت کاری جدید", text: "ساعت کاری جدید بساز" }, en: { label: "Add working hours", text: "Create working hours" } },
  socialList: { fa: { label: "لینک‌های اجتماعی", text: "لینک‌های اجتماعی را نشان بده" }, en: { label: "Social links", text: "Show social links" } },
  settingsList: { fa: { label: "تنظیمات", text: "تنظیمات سیستم را نشان بده" }, en: { label: "Settings", text: "Show system settings" } },
  settingsHelp: { fa: { label: "راهنمای تنظیمات", text: "راهنمای تنظیمات را نشان بده" }, en: { label: "Settings help", text: "Show settings help" } },
  smsReport: { fa: { label: "گزارش پیامک", text: "گزارش پیامک را نشان بده" }, en: { label: "SMS report", text: "Show the SMS report" } },
  smsProviders: { fa: { label: "سرویس‌های پیامک", text: "سرویس‌دهنده‌های پیامک را نشان بده" }, en: { label: "SMS providers", text: "Show SMS providers" } },
  smsTemplates: { fa: { label: "قالب‌های پیامک", text: "قالب‌های پیامک را نشان بده" }, en: { label: "SMS templates", text: "Show SMS templates" } },
  emailOverview: { fa: { label: "گزارش ایمیل", text: "گزارش ایمیل را نشان بده" }, en: { label: "Email report", text: "Show the email report" } },
  emailProviders: { fa: { label: "سرویس‌های ایمیل", text: "سرویس‌های ایمیل را نشان بده" }, en: { label: "Email providers", text: "Show email providers" } },
  emailTemplates: { fa: { label: "قالب‌های ایمیل", text: "قالب‌های ایمیل را نشان بده" }, en: { label: "Email templates", text: "Show email templates" } },
  emailMessages: { fa: { label: "گزارش ارسال", text: "گزارش ارسال ایمیل را نشان بده" }, en: { label: "Sent messages", text: "Show sent email messages" } },
  paymentOverview: { fa: { label: "آمار پرداخت", text: "آمار پرداخت را نشان بده" }, en: { label: "Payment overview", text: "Show payment overview" } },
  paymentProviders: { fa: { label: "درگاه‌های پرداخت", text: "درگاه‌های پرداخت را نشان بده" }, en: { label: "Payment providers", text: "Show payment providers" } },
  paymentTransactions: { fa: { label: "تراکنش‌ها", text: "تراکنش‌های پرداخت را نشان بده" }, en: { label: "Transactions", text: "Show payment transactions" } },
  cancel: { fa: { label: "لغو", text: "لغو" }, en: { label: "Cancel", text: "cancel" } },
} as const satisfies Record<string, Suggestion>;

type SuggestionId = keyof typeof SUGGESTIONS;
type InlineButton = { text: string; callback_data: string };

function keyboard(buttons: InlineButton[]): Record<string, unknown> {
  const rows: InlineButton[][] = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  return { inline_keyboard: rows };
}

function inlineKeyboard(ids: readonly SuggestionId[], locale: Locale): Record<string, unknown> {
  return keyboard(ids.map((id) => ({
    text: SUGGESTIONS[id][locale].label,
    callback_data: `${CALLBACK_PREFIX}${id}`,
  })));
}

/** Build buttons for real, numbered choices already shown in a clarification. */
function numberedChoices(status: string, text: string): Record<string, unknown> | undefined {
  if (!/(?:booking-choose-(?:group|slot)|booking-(?:group|slot)-invalid|clinic-target-ambiguous|social-clarify|settings-clarify|users-pending|booking-select)/iu.test(status)) return undefined;

  const buttons: InlineButton[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const clean = line.trim().replace(/^\*\*/u, "").replace(/\*\*$/u, "").replace(/^[•*-]\s*/u, "");
    const match = clean.match(/^(?:[^\d\n]{0,30}?)?(\d{1,2})[.)]\s+(.+)$/u);
    if (!match) continue;
    const number = Number(match[1]);
    if (!Number.isInteger(number) || number < 1 || number > 99) continue;
    const label = (match[2] ?? "")
      .replace(/\s*(?:·|—|–|-)\s*(?:(?:شناسه|ID)\s*[:：]?\s*)?[0-9a-f-]{8,}\s*$/iu, "")
      .replace(/[*`]/gu, "")
      .trim();
    if (!label) continue;
    buttons.push({ text: Array.from(label).slice(0, 48).join(""), callback_data: `${CALLBACK_PREFIX}pick:${number}` });
    if (buttons.length >= 10) break;
  }
  return buttons.length ? keyboard(buttons) : undefined;
}

function domainSuggestions(status: string): readonly SuggestionId[] {
  if (/^clinic-clarify/iu.test(status)) return ["clinicServices", "bookAppointment", "myBookings", "bookingsList", "availableSlots", "careGuides", "notificationsList"];
  if (/^booking-cancel-route-clarify/iu.test(status)) return ["myBookings", "bookingsList", "cancel"];
  if (/^booking-bulk-clarify/iu.test(status)) return ["bulkPay", "bulkDone", "bulkRefund", "bulkDelete", "cancel"];
  if (/^booking-update-clarify/iu.test(status)) return ["bookingPending", "bookingPaid", "bookingWaiting", "bookingDone", "bookingRefunded", "bookingFieldName", "bookingFieldPhone", "bookingFieldEmail", "bookingFieldNotes", "cancel"];
  if (/^booking-select/iu.test(status)) return ["bookingsList", "cancel"];
  if (/^booking-(?:choose|group|slot)/iu.test(status)) return ["cancel"];
  if (/^(?:my-booking|booking|slots|service-catalog|clinic|profile|password|sessions|notifications)/iu.test(status)) {
    return ["clinicServices", "bookAppointment", "myBookings", "cancel"];
  }
  if (/^email/iu.test(status)) return ["emailOverview", "emailProviders", "emailTemplates", "emailMessages"];
  if (/^payment/iu.test(status)) return ["paymentOverview", "paymentProviders", "paymentTransactions"];
  if (/^sms/iu.test(status)) return ["smsReport", "smsProviders", "smsTemplates"];
  if (/^settings/iu.test(status)) return ["settingsList", "settingsHelp", "cancel"];
  if (/^social/iu.test(status)) return ["socialList", "cancel"];
  if (/^hours/iu.test(status)) return ["hoursList", "hoursCreate", "cancel"];
  if (/^users/iu.test(status)) return ["usersList", "usersCreate", "cancel"];
  if (/^rules/iu.test(status)) return ["rulesList", "help", "cancel"];
  return ["help", "today", "clinicServices", "myBookings"];
}

const UNCLEAR_STATUS = /(?:clarify|ambiguous|target-required|selection-required|all-required|invalid|unsupported|not-found|select|choose|empty|(?:^|-)error$)/iu;
const UNCLEAR_REPLY = /(?:🔎|متوجه نشدم|نفهمیدم|منظورت.{0,30}(?:چی|چیه|کدام)|میشه.{0,20}(?:بیشتر|واضح‌تر)|بیشتر توضیح|روشن‌تر|دقیق‌تر|کدام|کدوم|شناسه.{0,20}(?:بفرست|مشخص|انتخاب)|شماره.{0,20}(?:بفرست|انتخاب)|درخواست.{0,20}(?:روشن|واضح)|نمی(?:دانم|دونم)|اطلاعات کافی نیست|couldn['’]?t understand|didn['’]?t understand|please clarify|please rephrase|please specify|be more specific|what do you mean|not sure what you mean|don['’]?t know|couldn['’]?t answer|can['’]?t answer|need more (?:information|details)|which (?:one|item|option|service|booking|group|time)|choose (?:an item|one|the|a )|select (?:an item|one|the|a )|exact (?:number|ID))/iu;

/** Return an inline keyboard only when the bot needs clarification or recovery. */
export function inlineSuggestionsForReply(
  status: string,
  text: string,
  locale: Locale,
  sensitive = false,
): Record<string, unknown> | undefined {
  const asksForConfirmation = /(?:تأیید|تایید|confirm)[\s\S]{0,100}(?:لغو|cancel)|(?:لغو|cancel)[\s\S]{0,100}(?:تأیید|تایید|confirm)/iu.test(text);
  const hasProposal = /(?:^|-)(?:proposed|awaiting-confirmation)$/iu.test(status)
    || /(?:🔎 پیش‌نمایش:|🔎 Preview:)/u.test(text)
    || /(?:(?:تغییر|درخواست) قبلی (?:منتظر|هنوز اجرا نشده)|previous (?:change|request|operation) is waiting)/iu.test(text);
  if (hasProposal || asksForConfirmation) return inlineKeyboard(["confirm", "cancel"], locale);

  if (/auth-required|session-changed|login-required/iu.test(status)) {
    return inlineKeyboard(["login", "help"], locale);
  }
  if (/(?:booking-date(?:-invalid|-required)?|booking-no-slots|clinic-date-required)/iu.test(status)) {
    return inlineKeyboard(["today", "tomorrow", "cancel"], locale);
  }
  if (/booking-(?:name|phone|email|edit-value|edit-invalid)|password-(?:prompt|invalid|confirm|mismatch)/iu.test(status)) {
    return inlineKeyboard(["cancel"], locale);
  }
  if (sensitive) return inlineKeyboard(["cancel"], locale);

  const choices = numberedChoices(status, text);
  if (choices) return choices;
  if (UNCLEAR_STATUS.test(status) || UNCLEAR_REPLY.test(text)) return inlineKeyboard(domainSuggestions(status), locale);
  if (/(?:^|-)(?:pending|draft|collecting)$/iu.test(status) && /(?:لغو|انصراف|cancel|stop)/iu.test(text)) {
    return inlineKeyboard(["cancel"], locale);
  }
  return undefined;
}

/** Resolve only known, bounded callback values; arbitrary callback text is never executed. */
export function resolveInlineSuggestion(data: string | undefined, locale: Locale): string | null {
  if (!data?.startsWith(CALLBACK_PREFIX)) return null;
  const value = data.slice(CALLBACK_PREFIX.length);
  const selectedRow = value.match(/^pick:([1-9]\d?)$/u);
  if (selectedRow) return selectedRow[1] ?? null;
  const id = value as SuggestionId;
  return Object.prototype.hasOwnProperty.call(SUGGESTIONS, id) ? SUGGESTIONS[id][locale].text : null;
}
