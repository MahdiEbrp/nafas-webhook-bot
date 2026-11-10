// Limits and public capabilities mirrored from beauty-clinic at
// af5d4f872a7ac8f75fa1e6780e788e83557c5100.
export const EMAIL_LIMITS = {
  providerNameMinLength: 2, providerNameMaxLength: 80, providerSearchMaxLength: 100,
  providerListPageMax: 100_000, providerListPerPageMax: 50, providerListPerPageDefault: 10,
  providerPasswordMaxLength: 512, providerUsernameMaxLength: 256, providerHostMaxLength: 255,
  providerPortMin: 1, providerPortMax: 65_535, providerFromEmailMaxLength: 254, providerFromNameMaxLength: 120,
  recipientMinLength: 3, recipientMaxLength: 254, subjectMinLength: 1, subjectMaxLength: 998,
  messageMinLength: 1, messageMaxLength: 102_400, messageListSearchMaxLength: 254,
  messageListPerPageMax: 50, messageListPerPageDefault: 20,
  templateKeyMinLength: 1, templateKeyMaxLength: 80, templateNameMaxLength: 120,
  templateVariableMaxLength: 40, templateVariableCountMax: 20,
  templateDisplayOrderMin: 0, templateDisplayOrderMax: 100_000,
  templateListPerPageMax: 50, templateListPerPageDefault: 10, templateSearchMaxLength: 100,
  recipientCountMax: 1_000, recipientSearchMaxLength: 100,
  recipientListPerPageMax: 50, recipientListPerPageDefault: 10,
  variableValueMaxLength: 256, campaignNameMaxLength: 120,
  idempotencyKeyMinLength: 8, idempotencyKeyMaxLength: 128,
  requestBodyLimitBytes: 256 * 1024, recentMessageCount: 8,
  pageMin: 1, pageDefault: 1, emptyLength: 0,
} as const;

export const EMAIL_PROVIDER_KINDS = ["gmail", "outlook", "yahoo", "custom", "liara", "fake"] as const;
export const EMAIL_STATUSES = ["queued", "sending", "sent", "delivered", "failed"] as const;
export const EMAIL_API_ROOT = "/api/v1/admin/email";
export const EMAIL_HELP = `📨 مدیریت ایمیل\n\n• آمار، سرویس‌های ایمیل، قالب‌ها، گیرنده‌ها و گزارش ارسال را بخواه.\n• برای ارسال، «ایمیل بفرست» را بنویس؛ گیرنده و متن در گام‌های خصوصی دریافت و پیش از ارسال نمایش داده می‌شوند.\n• ساخت/ویرایش سرویس و قالب، تست سرویس و حذف گزارش هم پشتیبانی می‌شود.\n\n🔐 فقط در گفت‌وگوی خصوصی و با نشست مجاز. تغییرها و هر ارسال/تست ایمیل نیازمند تأیید صریح‌اند. تست سرویس یک ایمیل واقعی برای گیرندهٔ انتخابی می‌فرستد.\n⚠️ حذف گزارش فقط رکورد داخلی را پاک می‌کند و ایمیل ارسال‌شده را پس نمی‌گیرد. خطای شبکه هنگام ارسال ممکن است نتیجه را نامشخص بگذارد؛ گزارش را بررسی کن و خودکار دوباره نفرست.`;
