import { jalaliDate } from "@/lib/telegram/format";
import type { Rule } from "./types";

export function ruleCard(rule: Rule, index = 0): string {
  return [
    `**📜 ${index + 1}. ${rule.translations?.fa?.name ?? rule.slug}**`,
    `• نام انگلیسی: ${rule.translations?.en?.name ?? "—"}`,
    `• وضعیت: ${rule.isActive ? "🟢 فعال" : "⚪ غیرفعال"}`,
    `• برجسته: ${rule.highlighted ? "⭐ بله" : "خیر"}`,
    `• ترتیب نمایش: ${rule.displayOrder}`,
    ...(rule.translations?.fa?.description ? [`• توضیح: ${rule.translations.fa.description}`] : []),
    ...(rule.translations?.en?.description ? [`• توضیح انگلیسی: ${rule.translations.en.description}`] : []),
    `• شناسهٔ کوتاه: ${rule.slug}`,
    `• شناسه: ${rule.id}`,
    ...(rule.createdAt ? [`• تاریخ ثبت: ${jalaliDate(rule.createdAt)}`] : []),
    ...(rule.updatedAt ? [`• آخرین ویرایش: ${jalaliDate(rule.updatedAt)}`] : []),
  ].join("\n");
}
export function rulesList(rules: Rule[], page: number, total: number, live: boolean): string {
  return `**📚 فهرست قوانین کلینیک**\n\n📄 صفحه: ${page}\n📊 تعداد کل: ${total}\n${live ? "" : "🧪 دادهٔ آزمایشی محلی؛ به سرویس واقعی وصل نیست.\n"}\n${rules.map(ruleCard).join("\n\n") || "📭 قانونی پیدا نشد."}\n\n💬 مثلاً بگو «قانون دوم را حذف کن»، «قانون اول را غیرفعال کن» یا «صفحهٔ بعد قوانین را نشان بده».`;
}

export function ruleFields(fields: Record<string, unknown>): string {
  const labels: Record<string, string> = { slug: "شناسهٔ کوتاه", icon: "آیکن", image: "تصویر", color: "رنگ", highlighted: "برجسته", displayOrder: "ترتیب نمایش", isActive: "فعال" };
  const lines = Object.entries(labels).flatMap(([key, label]) => key in fields
    ? [`• ${label}: ${fields[key] === null ? "پاک شود" : typeof fields[key] === "boolean" ? fields[key] ? "بله" : "خیر" : String(fields[key])}`] : []);
  const translations = fields.translations as Record<string, Record<string, unknown>> | undefined;
  for (const locale of ["fa", "en"]) {
    const translation = translations?.[locale];
    if (!translation) continue;
    for (const [key, label] of [["name", "نام"], ["description", "توضیح"]]) {
      if (key! in translation) lines.push(`• ${label} ${locale === "fa" ? "فارسی" : "انگلیسی"}: ${translation[key!] === null ? "بدون توضیح" : String(translation[key!])}`);
    }
  }
  return lines.join("\n");
}

export function ruleBulkDetails(input: Record<string, unknown>): string {
  const action: Record<string, string> = { activate: "فعال‌سازی", deactivate: "غیرفعال‌سازی", delete: "حذف" };
  const status: Record<string, string> = { all: "همه", active: "فعال", inactive: "غیرفعال" };
  const filters = input.filters as Record<string, unknown> | undefined;
  return [
    `• عملیات: ${action[String(input.action)] ?? String(input.action)}`,
    `• محدوده: ${input.scope === "filtered" ? "⚠️ تمام نتایج مطابق فیلتر" : "قوانین انتخاب‌شده"}`,
    ...(Array.isArray(input.ids) ? input.ids.map(id => `• شناسه: ${String(id)}`) : []),
    ...(input.scope === "filtered" ? [`• وضعیت: ${status[String(filters?.status ?? "all")]}`, `• جست‌وجو: ${String(filters?.search || "بدون محدودیت")}`] : []),
  ].join("\n");
}
