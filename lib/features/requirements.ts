/**
 * What every action minimally needs before it can be called.
 *
 * The AI fills what it can from the sentence; this table decides whether the
 * request is complete or whether the bot must ask a short Persian question.
 * Keeping it deterministic (instead of trusting the model) prevents the classic
 * failure where a small model invents a fake booking id.
 */

export type Requirements = {
  /** values that come from the URL, e.g. /bookings/:id */
  path?: string[];
  /** query-string values (GET lists) */
  query?: string[];
  /** JSON body values */
  body?: string[];
  /** any-of groups: at least one of these must be present */
  anyOf?: string[][];
};

export const REQUIREMENTS: Record<string, Requirements> = {
  "bookings.list": {},
  "bookings.get": { path: ["id"] },
  "bookings.update": { path: ["id"] },
  "bookings.delete": { path: ["id"] },
  "bookings.create": {
    body: ["fullName", "phone", "items"],
  },

  "working-hours.list": {},
  "working-hours.get": { path: ["id"] },
  "working-hours.update": { path: ["id"] },
  "working-hours.delete": { path: ["id"] },
  "working-hours.create": { body: ["day", "opens", "closes"] },

  "services.list": {},
  "services.get": { path: ["id"] },
  "services.update": { path: ["id"] },
  "services.delete": { path: ["id"] },
  "services.create": {
    body: ["categoryId", "slug", "translations"],
    anyOf: [["price", "priceType"]],
  },

  "service-categories.list": {},
  "service-categories.get": { path: ["id"] },
  "service-categories.update": { path: ["id"] },
  "service-categories.delete": { path: ["id"] },
  "service-categories.create": { body: ["groupId", "slug", "translations"] },

  "service-groups.list": {},
  "service-groups.get": { path: ["id"] },
  "service-groups.update": { path: ["id"] },
  "service-groups.delete": { path: ["id"] },
  "service-groups.create": { body: ["slug", "translations"] },

  "users.list": {},
  "users.create": { body: ["fullName", "email", "phone", "password", "roleKey"] },
  "users.update-status": { path: ["id"], anyOf: [["isActive", "isBanned"]] },
  "users.delete": { path: ["id"] },

  "settings.list": {},
  "settings.get": { path: ["id"] },
  "settings.update": { path: ["id"], anyOf: [["value", "translations", "isActive"]] },
  "settings.delete": { path: ["id"] },
  "settings.create": { body: ["key"], anyOf: [["value", "translations"]] },

  "rules.list": {},
  "rules.get": { path: ["id"] },
  "rules.update": { path: ["id"] },
  "rules.delete": { path: ["id"] },
  "rules.create": { body: ["slug", "translations"] },

  "care-guides.list": {},
  "care-guides.get": { path: ["id"] },
  "care-guides.update": { path: ["id"] },
  "care-guides.delete": { path: ["id"] },
  "care-guides.create": { body: ["slug", "translations"] },

  "care-guide-items.list": {},
  "care-guide-items.get": { path: ["id"] },
  "care-guide-items.update": { path: ["id"] },
  "care-guide-items.delete": { path: ["id"] },
  "care-guide-items.create": { body: ["guideId", "translations"] },
};

/** Persian phrasing of "I still need this field", used when the plan is incomplete. */
export const FIELD_QUESTIONS_FA: Record<string, string> = {
  id: "لطفاً نام یا شمارهٔ مورد موردنظر را مشخص کنید (مثلاً «دی می» یا «شماره ۱»):",
  fullName: "اسم و فامیل مشتری چیست؟",
  phone: "شمارهٔ تلفن مشتری چیست؟",
  email: "ایمیل چیست؟ (اگر ندارد، بفرمایید تا خالی بگذارم)",
  phone_user: "شمارهٔ تلفن کاربر چیست؟",
  password: "یک رمز عبور وارد کنید: حداقل ۸ کاراکتر، با حروف بزرگ و کوچک، عدد و علامت.",
  roleKey: "نقش این کاربر چه باشد؟ (مثلاً admin یا receptionist)",
  items: "کدام خدمت و چه زمانی را می‌خواهید رزرو کنید؟",
  day: "چه روزی از هفته مد نظرتان است؟ (مثلاً شنبه یا دوشنبه)",
  opens: "از چه ساعتی باز باشد؟ مثال: 09:00",
  closes: "تا چه ساعتی باز باشد؟ مثال: 18:00",
  categoryId: "این خدمت در کدام دسته‌بندی باشد؟",
  slug: "یک نام کوتاه انگلیسی برای آدرس صفحه مشخص کنید؛ مثل laser-hair.",
  translations: "عنوان فارسی آن را چه بگذارم؟",
  guideId: "این آیتم مربوط به کدام راهنمای مراقبت است؟",
  groupId: "این دسته زیرمجموعهٔ کدام گروه است؟",
  key: "کلید تنظیم را چه بگذارم؟ (حروف کوچک انگلیسی، مثل site_phone)",
  value: "مقدار آن را چه بگذارم؟",
};

export function questionFor(field: string): string {
  return FIELD_QUESTIONS_FA[field] ?? `مقدار «${field}» را هم بگو لطفاً.`;
}
