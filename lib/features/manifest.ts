/**
 * FEATURE MANIFEST
 * ================
 * A machine-readable + human-readable catalog of everything the existing
 * project exposes through `/api/v1/webhooks/*`, rebuilt from the uploaded
 * route + schema dump.
 *
 * Two consumers:
 *  1. The AI planner — it receives a compact form of this list and maps a
 *     Persian request ("نوبتهای فردا رو نشون بده") onto one feature + action.
 *  2. Humans — `GET /api/features` returns this manifest, and `docs/FEATURES.fa.md`
 *     is generated from it (`npm run build:catalog`).
 *
 * The `kid` field is the "explain it to a 10-year-old" text that the answer
 * writer reuses, so the bot can explain itself even with no model available.
 */

export type Danger = "read" | "write" | "destructive";

export type FeatureAction = {
  /** stable id used by the planner, e.g. "bookings.list" */
  id: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** path relative to WEBHOOK_BASE_URL, ":id" is a placeholder */
  path: string;
  /** permission the service user must hold in the existing project */
  permission: string;
  danger: Danger;
  /** true → the bot must ask before running it */
  needsConfirmation: boolean;
  fa: string;
  en: string;
  /** body/query fields the AI is allowed to fill */
  fields?: string[];
};

export type Feature = {
  id: string;
  titleFa: string;
  titleEn: string;
  /** one-sentence plain-Persian explanation, written for a kid */
  kid: string;
  /** everyday examples of what a user might say */
  userWants: string[];
  /** Persian + English trigger words used by the lexical router */
  keywords: string[];
  actions: FeatureAction[];
  /** false when the existing project ships the schema but no route yet */
  available: boolean;
  notes?: string;
};

const read = (id: string, path: string, permission: string): FeatureAction => ({
  id,
  method: "GET",
  path,
  permission,
  danger: "read",
  needsConfirmation: false,
  fa: "خواندن",
  en: "read",
});

const del = (id: string, path: string, permission: string): FeatureAction => ({
  id,
  method: "DELETE",
  path,
  permission,
  danger: "destructive",
  needsConfirmation: true,
  fa: "حذف کردن",
  en: "delete",
});

export const FEATURES: Feature[] = [
  {
    id: "bookings",
    titleFa: "نوبت‌ها و رزروها",
    titleEn: "Bookings",
    kid: "نوبت‌ها همان «قراری» هستند که مشتری با کلینیک می‌گذارد. مثل این است که روی تقویم بنویسی: «فلانی ساعت ۵ می‌آید». این بخش می‌تواند لیست قرارها را ببیند، قرار تازه بسازد، یک قرار را عوض کند یا پاک کند.",
    userWants: [
      "نوبت‌های امروز رو نشون بده",
      "یک نوبت جدید برای مریم با شماره ۰۹۱۲... ثبت کن",
      "نوبت فلانی رو کنسل کن",
      "چند نوبت پرداخت‌نشده داریم؟",
    ],
    keywords: [
      "نوبت", "نوبتها", "نوبت‌ها", "رزرو", "قرار", "وقت", "کنسل", "لغو", "بیعانه",
      "booking", "bookings", "appointment", "appointments", "reservation",
    ],
    actions: [
      {
        ...read("bookings.list", "/api/v1/webhooks/bookings", "appointments.read"),
        fa: "دیدن لیست نوبت‌ها (با صفحه‌بندی، جستجو و فیلتر وضعیت)",
        en: "list bookings (pagination, search, status filter)",
        fields: ["page", "perPage", "search", "status", "slotId"],
      },
      {
        ...read("bookings.get", "/api/v1/webhooks/bookings/:id", "appointments.read"),
        fa: "دیدن جزئیات یک نوبت",
        en: "get one booking",
        fields: ["id"],
      },
      {
        id: "bookings.create",
        method: "POST",
        path: "/api/v1/webhooks/bookings",
        permission: "appointments.write",
        danger: "write",
        needsConfirmation: true,
        fa: "ساختن نوبت جدید",
        en: "create a booking",
        fields: [
          "fullName", "phone", "email", "locale", "notes", "consultationRequired",
          "hasAllergies", "isPregnant", "termsAccepted", "items[].groupId", "items[].slotId", "items[].quantity",
        ],
      },
      {
        id: "bookings.update",
        method: "PATCH",
        path: "/api/v1/webhooks/bookings/:id",
        permission: "appointments.write",
        danger: "write",
        needsConfirmation: true,
        fa: "تغییر نام/تلفن/یادداشت/وضعیت یک نوبت",
        en: "update a booking",
        fields: ["id", "fullName", "phone", "email", "notes", "status"],
      },
      {
        ...del("bookings.delete", "/api/v1/webhooks/bookings/:id", "appointments.manage"),
        fa: "پاک کردن کامل یک نوبت",
        en: "delete a booking",
        fields: ["id"],
      },
    ],
    available: true,
    notes: "وضعیت‌های مجاز: pending | paid | waiting | done | refunded",
  },
  {
    id: "working-hours",
    titleFa: "ساعت‌های کاری",
    titleEn: "Working hours",
    kid: "این بخش دفترچهٔ ساعت‌های کاری کلینیک است: از چه ساعتی باز است، تا چه ساعتی، و در هر ساعت چند نفر جا داریم. مثل زنگ‌های مدرسه که معلوم می‌کند کلاس‌ها کِی شروع می‌شوند.",
    userWants: [
      "ساعت کاری شنبه‌ها چیه؟",
      "شنبه‌ها رو از ۹ صبح تا ۶ عصر کن",
      "ظرفیت ساعت ۱۰ رو بیشتر کن",
    ],
    keywords: [
      "ساعت کاری", "ساعات کاری", "ساعت‌های کاری", "شیفت", "باز", "بسته", "ظرفیت", "تعطیل",
      "working hours", "shift", "capacity", "open", "close",
    ],
    actions: [
      {
        ...read("working-hours.list", "/api/v1/webhooks/working-hours", "appointments.read"),
        fa: "دیدن لیست ساعت‌های کاری",
        en: "list working hours",
        fields: ["page", "perPage", "search", "status"],
      },
      {
        ...read("working-hours.get", "/api/v1/webhooks/working-hours/:id", "appointments.read"),
        fa: "دیدن یک رکورد ساعت کاری",
        en: "get one working hour",
        fields: ["id"],
      },
      {
        id: "working-hours.create",
        method: "POST",
        path: "/api/v1/webhooks/working-hours",
        permission: "appointments.write",
        danger: "write",
        needsConfirmation: true,
        fa: "اضافه کردن روز کاری",
        en: "create a working day",
        fields: ["day", "opens", "closes", "capacity", "displayOrder", "isActive", "patterns[]"],
      },
      {
        id: "working-hours.update",
        method: "PATCH",
        path: "/api/v1/webhooks/working-hours/:id",
        permission: "appointments.write",
        danger: "write",
        needsConfirmation: true,
        fa: "تغییر ساعت/ظرفیت یک روز",
        en: "update a working day",
        fields: ["id", "opens", "closes", "capacity", "displayOrder", "isActive", "patterns[]"],
      },
      {
        ...del("working-hours.delete", "/api/v1/webhooks/working-hours/:id", "appointments.manage"),
        fa: "حذف یک روز کاری",
        en: "delete a working day",
        fields: ["id"],
      },
    ],
    available: true,
    notes: "روزها به انگلیسی: Sunday..Saturday. ساعت‌ها با فرمت HH:MM و 24 ساعتی.",
  },
  {
    id: "services",
    titleFa: "خدمات کلینیک",
    titleEn: "Services",
    kid: "خدمات یعنی کارهایی که کلینیک انجام می‌دهد؛ مثل «اصلاح مو» یا «پاکسازی پوست». هر خدمت قیمت، مدت‌زمان، عکس و چند سؤال پرتکرار دارد.",
    userWants: [
      "لیست خدمات فعال رو نشون بده",
      "یه خدمت جدید به اسم «لیزر» با قیمت ۲ میلیون بساز",
      "قیمت این خدمت رو عوض کن",
      "خدمات ویژه کدوم‌اند؟",
    ],
    keywords: [
      "خدمات", "خدمت", "سرویس", "قیمت", "تعرفه", "ویژه", "پرطرفدار",
      "service", "services", "price", "pricing", "featured",
    ],
    actions: [
      {
        ...read("services.list", "/api/v1/webhooks/services", "services.read"),
        fa: "دیدن لیست خدمات",
        en: "list services",
        fields: ["page", "perPage", "search", "categoryId", "status", "featured"],
      },
      {
        ...read("services.get", "/api/v1/webhooks/services/:id", "services.read"),
        fa: "دیدن یک خدمت",
        en: "get one service",
        fields: ["id"],
      },
      {
        id: "services.create",
        method: "POST",
        path: "/api/v1/webhooks/services",
        permission: "services.write",
        danger: "write",
        needsConfirmation: true,
        fa: "ساختن خدمت جدید",
        en: "create a service",
        fields: [
          "categoryId", "slug", "price", "priceType", "durationMin", "sessionsCount",
          "coverImage", "isActive", "isFeatured", "displayOrder",
          "translations.fa.title", "translations.en.title", "images[]", "faqs[]",
        ],
      },
      {
        id: "services.update",
        method: "PATCH",
        path: "/api/v1/webhooks/services/:id",
        permission: "services.write",
        danger: "write",
        needsConfirmation: true,
        fa: "تغییر یک خدمت (قیمت، عنوان، فعال بودن…)",
        en: "update a service",
        fields: ["id", "price", "priceType", "durationMin", "isActive", "isFeatured", "translations.fa.title"],
      },
      {
        ...del("services.delete", "/api/v1/webhooks/services/:id", "services.manage"),
        fa: "حذف یک خدمت",
        en: "delete a service",
        fields: ["id"],
      },
    ],
    available: true,
    notes: "priceType: fixed | from | on_request. هر خدمت باید categoryId معتبر داشته باشد.",
  },
  {
    id: "service-categories",
    titleFa: "دسته‌بندی خدمات",
    titleEn: "Service categories",
    kid: "دسته‌بندی مثل کشوهای یک کمد است. خدمات را داخل کشوها می‌گذاریم تا پیدا کردنشان راحت‌تر شود؛ مثلاً کشوی «پوست» و کشوی «مو».",
    userWants: ["دسته‌های خدمات چی هستن؟", "یه دستهٔ جدید به اسم «پوست» بساز"],
    keywords: ["دسته خدمات", "دسته‌بندی", "کتگوری", "category", "categories"],
    actions: [
      {
        ...read("service-categories.list", "/api/v1/webhooks/service-categories", "services.read"),
        fa: "دیدن دسته‌ها",
        en: "list categories",
        fields: ["page", "perPage", "search", "status"],
      },
      {
        ...read("service-categories.get", "/api/v1/webhooks/service-categories/:id", "services.read"),
        fa: "دیدن یک دسته",
        en: "get one category",
        fields: ["id"],
      },
      {
        id: "service-categories.create",
        method: "POST",
        path: "/api/v1/webhooks/service-categories",
        permission: "services.write",
        danger: "write",
        needsConfirmation: true,
        fa: "ساختن دستهٔ جدید",
        en: "create a category",
        fields: ["groupId", "slug", "icon", "image", "displayOrder", "isActive", "translations.fa.name"],
      },
      {
        id: "service-categories.update",
        method: "PATCH",
        path: "/api/v1/webhooks/service-categories/:id",
        permission: "services.write",
        danger: "write",
        needsConfirmation: true,
        fa: "تغییر یک دسته",
        en: "update a category",
        fields: ["id", "groupId", "slug", "isActive", "translations.fa.name"],
      },
      {
        ...del("service-categories.delete", "/api/v1/webhooks/service-categories/:id", "services.manage"),
        fa: "حذف یک دسته",
        en: "delete a category",
        fields: ["id"],
      },
    ],
    available: true,
  },
  {
    id: "service-groups",
    titleFa: "گروه‌های خدمات",
    titleEn: "Service groups",
    kid: "گروه، قفسهٔ بزرگ‌تر است و دسته داخل آن می‌نشیند. مثل «کتابخانه → قفسهٔ داستان → کتاب‌های ترسناک».",
    userWants: ["گروه‌های خدمات رو نشون بده", "یه گروه جدید بساز"],
    keywords: ["گروه خدمات", "گروه", "group", "groups"],
    actions: [
      {
        ...read("service-groups.list", "/api/v1/webhooks/service-groups", "services.read"),
        fa: "دیدن گروه‌ها",
        en: "list groups",
        fields: ["page", "perPage", "search", "status"],
      },
      {
        ...read("service-groups.get", "/api/v1/webhooks/service-groups/:id", "services.read"),
        fa: "دیدن یک گروه",
        en: "get one group",
        fields: ["id"],
      },
      {
        id: "service-groups.create",
        method: "POST",
        path: "/api/v1/webhooks/service-groups",
        permission: "services.write",
        danger: "write",
        needsConfirmation: true,
        fa: "ساختن گروه جدید",
        en: "create a group",
        fields: ["slug", "icon", "image", "displayOrder", "isActive", "translations.fa.name"],
      },
      {
        id: "service-groups.update",
        method: "PATCH",
        path: "/api/v1/webhooks/service-groups/:id",
        permission: "services.write",
        danger: "write",
        needsConfirmation: true,
        fa: "تغییر یک گروه",
        en: "update a group",
        fields: ["id", "slug", "isActive", "translations.fa.name"],
      },
      {
        ...del("service-groups.delete", "/api/v1/webhooks/service-groups/:id", "services.manage"),
        fa: "حذف یک گروه",
        en: "delete a group",
        fields: ["id"],
      },
    ],
    available: true,
  },
  {
    id: "users",
    titleFa: "کاربران و کارمندان",
    titleEn: "Users & staff",
    kid: "این‌ها آدم‌هایی هستند که اجازهٔ ورود به سیستم را دارند: مدیر، منشی، پرسنل. برای هر نفر می‌شود حساب ساخت، غیرفعالش کرد یا دسترسی‌اش را بست.",
    userWants: [
      "کاربرهای فعال رو لیست کن",
      "یه حساب برای منشی جدید بساز",
      "فلانی رو غیرفعال کن",
      "کی مدیره؟",
    ],
    keywords: [
      "کاربر", "کاربرها", "کاربران", "کارمند", "منشی", "مدیر", "پرسنل", "نقش", "دسترسی", "بلاک", "بن",
      "user", "users", "staff", "employee", "role", "ban",
    ],
    actions: [
      {
        ...read("users.list", "/api/v1/webhooks/users", "users.read"),
        fa: "دیدن لیست کاربران",
        en: "list users",
        fields: ["page", "perPage", "search", "status", "role"],
      },
      {
        id: "users.create",
        method: "POST",
        path: "/api/v1/webhooks/users",
        permission: "users.write",
        danger: "write",
        needsConfirmation: true,
        fa: "ساختن کاربر جدید",
        en: "create a user",
        fields: ["fullName", "email", "phone", "password", "roleKey"],
      },
      {
        id: "users.update-status",
        method: "PATCH",
        path: "/api/v1/webhooks/users/:id",
        permission: "users.manage",
        danger: "write",
        needsConfirmation: true,
        fa: "فعال/غیرفعال/بن کردن یک کاربر",
        en: "activate / deactivate / ban a user",
        fields: ["id", "isActive", "isBanned", "banReason"],
      },
      {
        ...del("users.delete", "/api/v1/webhooks/users/:id", "users.manage"),
        fa: "حذف یک کاربر",
        en: "delete a user",
        fields: ["id"],
      },
    ],
    available: true,
    notes: "رمز عبور باید حداقل ۸ کاراکتر و شامل حرف بزرگ، حرف کوچک، عدد و علامت باشد.",
  },
  {
    id: "settings",
    titleFa: "تنظیمات سایت",
    titleEn: "Settings",
    kid: "تنظیمات، کلیدهای جادویی سایت هستند: شمارهٔ تماس، آدرس، متن‌های ثابت. عوض کردن هر کدام، سایت را عوض می‌کند.",
    userWants: ["شماره تماس کلینیک چیه؟", "شماره تلفن رو عوض کن", "تنظیمات رو لیست کن"],
    keywords: ["تنظیمات", "تنظیم", "شماره تماس", "آدرس", "setting", "settings", "config"],
    actions: [
      {
        ...read("settings.list", "/api/v1/webhooks/settings", "settings.read"),
        fa: "دیدن تنظیمات",
        en: "list settings",
        fields: ["page", "perPage", "search", "status"],
      },
      {
        ...read("settings.get", "/api/v1/webhooks/settings/:id", "settings.read"),
        fa: "دیدن یک تنظیم",
        en: "get one setting",
        fields: ["id"],
      },
      {
        id: "settings.create",
        method: "POST",
        path: "/api/v1/webhooks/settings",
        permission: "settings.write",
        danger: "write",
        needsConfirmation: true,
        fa: "ساختن تنظیم جدید",
        en: "create a setting",
        fields: ["key", "value", "type", "isActive", "translations.fa", "translations.en"],
      },
      {
        id: "settings.update",
        method: "PATCH",
        path: "/api/v1/webhooks/settings/:id",
        permission: "settings.write",
        danger: "write",
        needsConfirmation: true,
        fa: "تغییر مقدار یک تنظیم",
        en: "update a setting",
        fields: ["id", "value", "isActive", "translations.fa"],
      },
      {
        ...del("settings.delete", "/api/v1/webhooks/settings/:id", "settings.manage"),
        fa: "حذف یک تنظیم",
        en: "delete a setting",
        fields: ["id"],
      },
    ],
    available: true,
    notes: "type: string | number | boolean | json | localized",
  },
  {
    id: "rules",
    titleFa: "قوانین کلینیک",
    titleEn: "Rules",
    kid: "قوانین همان تذکرهای کوچک هستند: «نیم ساعت قبل بیایید»، «اگر لغو کردید خبر بدهید». سایت آن‌ها را به مشتری نشان می‌دهد.",
    userWants: ["قوانین رو نشون بده", "یه قانون جدید اضافه کن"],
    keywords: ["قوانین", "قانون", "شرایط", "rule", "rules"],
    actions: [
      {
        ...read("rules.list", "/api/v1/webhooks/rules", "rules.read"),
        fa: "دیدن قوانین",
        en: "list rules",
        fields: ["page", "perPage", "search", "status"],
      },
      {
        ...read("rules.get", "/api/v1/webhooks/rules/:id", "rules.read"),
        fa: "دیدن یک قانون",
        en: "get one rule",
        fields: ["id"],
      },
      {
        id: "rules.create",
        method: "POST",
        path: "/api/v1/webhooks/rules",
        permission: "rules.write",
        danger: "write",
        needsConfirmation: true,
        fa: "ساختن قانون جدید",
        en: "create a rule",
        fields: ["slug", "icon", "color", "highlighted", "displayOrder", "isActive", "translations.fa.name"],
      },
      {
        id: "rules.update",
        method: "PATCH",
        path: "/api/v1/webhooks/rules/:id",
        permission: "rules.write",
        danger: "write",
        needsConfirmation: true,
        fa: "تغییر یک قانون",
        en: "update a rule",
        fields: ["id", "highlighted", "isActive", "translations.fa.name"],
      },
      {
        ...del("rules.delete", "/api/v1/webhooks/rules/:id", "rules.manage"),
        fa: "حذف یک قانون",
        en: "delete a rule",
        fields: ["id"],
      },
    ],
    available: true,
  },
  {
    id: "care-guides",
    titleFa: "راهنمای مراقبت",
    titleEn: "Care guides",
    kid: "بعد از درمان، مشتری باید بداند چه کار کند: چه چیزی بخورد، چه چیزی نه. این راهنماها همان برگه‌های «بعد از کار چه کنیم؟» هستند.",
    userWants: ["راهنمای مراقبت بعد از لیزر رو نشون بده", "یه راهنمای جدید بساز"],
    keywords: ["راهنما", "مراقبت", "بعد از درمان", "guide", "guides", "care"],
    actions: [
      {
        ...read("care-guides.list", "/api/v1/webhooks/care-guides", "care-guides.read"),
        fa: "دیدن راهنماها",
        en: "list care guides",
        fields: ["page", "perPage", "search", "status"],
      },
      {
        ...read("care-guides.get", "/api/v1/webhooks/care-guides/:id", "care-guides.read"),
        fa: "دیدن یک راهنما",
        en: "get one care guide",
        fields: ["id"],
      },
      {
        id: "care-guides.create",
        method: "POST",
        path: "/api/v1/webhooks/care-guides",
        permission: "care-guides.write",
        danger: "write",
        needsConfirmation: true,
        fa: "ساختن راهنمای جدید",
        en: "create a care guide",
        fields: ["slug", "icon", "displayOrder", "isActive", "translations.fa.name"],
      },
      {
        id: "care-guides.update",
        method: "PATCH",
        path: "/api/v1/webhooks/care-guides/:id",
        permission: "care-guides.write",
        danger: "write",
        needsConfirmation: true,
        fa: "تغییر یک راهنما",
        en: "update a care guide",
        fields: ["id", "isActive", "translations.fa.name"],
      },
      {
        ...del("care-guides.delete", "/api/v1/webhooks/care-guides/:id", "care-guides.manage"),
        fa: "حذف یک راهنما",
        en: "delete a care guide",
        fields: ["id"],
      },
    ],
    available: true,
  },
  {
    id: "care-guide-items",
    titleFa: "آیتم‌های راهنمای مراقبت",
    titleEn: "Care guide items",
    kid: "هر راهنما از چند تکهٔ کوچک ساخته می‌شود؛ مثل فهرست کارها: «۱. دو ساعت ورزش نکن ۲. ضدآفتاب بزن». هر تکه یک آیتم است.",
    userWants: ["آیتم‌های راهنمای لیزر رو ببین", "یه آیتم جدید به این راهنما اضافه کن"],
    keywords: ["آیتم راهنما", "مورد راهنما", "care guide item", "guide item", "items"],
    actions: [
      {
        ...read("care-guide-items.list", "/api/v1/webhooks/care-guide-items", "care-guides.read"),
        fa: "دیدن آیتم‌های راهنما",
        en: "list care guide items",
        fields: ["page", "perPage", "search", "status", "guideId"],
      },
      {
        ...read("care-guide-items.get", "/api/v1/webhooks/care-guide-items/:id", "care-guides.read"),
        fa: "دیدن یک آیتم",
        en: "get one item",
        fields: ["id"],
      },
      {
        id: "care-guide-items.create",
        method: "POST",
        path: "/api/v1/webhooks/care-guide-items",
        permission: "care-guides.write",
        danger: "write",
        needsConfirmation: true,
        fa: "اضافه کردن آیتم به راهنما",
        en: "create an item",
        fields: ["guideId", "highlighted", "displayOrder", "isActive", "translations.fa.title"],
      },
      {
        id: "care-guide-items.update",
        method: "PATCH",
        path: "/api/v1/webhooks/care-guide-items/:id",
        permission: "care-guides.write",
        danger: "write",
        needsConfirmation: true,
        fa: "تغییر یک آیتم",
        en: "update an item",
        fields: ["id", "guideId", "highlighted", "isActive", "translations.fa.title"],
      },
      {
        ...del("care-guide-items.delete", "/api/v1/webhooks/care-guide-items/:id", "care-guides.manage"),
        fa: "حذف یک آیتم",
        en: "delete an item",
        fields: ["id"],
      },
    ],
    available: true,
  },
  {
    id: "sms",
    titleFa: "پیامک",
    titleEn: "SMS",
    kid: "پیامک یعنی فرستادن یک پیام کوتاه به گوشی مشتری، مثل یادآوری نوبت. در پروژهٔ فعلی فقط «طرح» آن ساخته شده (provider، template، message) ولی هنوز آدرس (route) ندارد؛ پس ربات فقط می‌تواند توضیحش بدهد و کاری انجام دهد که route دارد.",
    userWants: ["یه پیامک یادآوری بفرست", "قالب‌های پیامک چی هستن؟"],
    keywords: ["پیامک", "اس‌ام‌اس", "sms", "provider", "template", "message"],
    actions: [],
    available: false,
    notes: "lib/webhooks/schema.ts بخش SMS را دارد اما app/api/v1/webhooks/sms/route.ts در پروژه وجود ندارد.",
  },
];

export const FEATURE_IDS = FEATURES.map((feature) => feature.id);

export function getFeature(id: string): Feature | undefined {
  return FEATURES.find((feature) => feature.id === id);
}

export function getAction(id: string): { feature: Feature; action: FeatureAction } | undefined {
  for (const feature of FEATURES) {
    const action = feature.actions.find((candidate) => candidate.id === id);
    if (action) return { feature, action };
  }
  return undefined;
}

/** All permissions the bot may need, grouped by danger — used by /api/features and docs. */
export function permissionMatrix(): Record<string, { danger: Danger; actions: string[] }> {
  const out: Record<string, { danger: Danger; actions: string[] }> = {};
  for (const feature of FEATURES) {
    for (const action of feature.actions) {
      const entry = out[action.permission] ?? { danger: action.danger, actions: [] };
      if (action.danger === "destructive") entry.danger = "destructive";
      else if (action.danger === "write" && entry.danger === "read") entry.danger = "write";
      entry.actions.push(action.id);
      out[action.permission] = entry;
    }
  }
  return out;
}

/**
 * Compact view handed to the planner model. Keeps the prompt small (free models
 * have generous context, but smaller prompts = faster + fewer 429s).
 */
export function manifestForPrompt(): string {
  return FEATURES.map((feature) => {
    const actions = feature.actions
      .map((action) => `${action.id}(${action.method} ${action.path}${action.fields ? ` fields:${action.fields.join("|")}` : ""})`)
      .join("; ");
    return `- ${feature.id} :: ${feature.titleFa} :: keywords[${feature.keywords.slice(0, 8).join(",")}] :: ${actions || "NO ROUTE"}`;
  }).join("\n");
}
