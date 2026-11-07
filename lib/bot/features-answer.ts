/**
 * "What can you do?" — answered without spending a single model token.
 *
 * This is also the fallback for a vague request: the user sees the real feature
 * list, with a kid-level explanation of each one, and a copy-paste example.
 */

import { FEATURES } from "@/lib/features/manifest";
import type { Locale } from "@/lib/config";

export function featuresAnswerFa(options?: { detailed?: boolean }): string {
  const detailed = options?.detailed ?? true;
  const lines: string[] = [];

  lines.push("من دستیار کلینیک هستم. 🙋");
  lines.push("کارم این است که حرف تو را بفهمم و همان را در سیستم کلینیک انجام دهم.");
  lines.push("");
  lines.push("این‌ها کارهایی است که بلدم:");

  for (const feature of FEATURES) {
    if (!feature.available) {
      lines.push(`• ${feature.titleFa} — فعلاً آماده نیست (فقط طرحش هست).`);
      continue;
    }
    lines.push(`• ${feature.titleFa}`);
    if (detailed) {
      lines.push(`   ↳ ${feature.kid}`);
      const example = feature.userWants[0];
      if (example) lines.push(`   ↳ مثلاً بگو: «${example}»`);
    }
  }

  lines.push("");
  lines.push("هر کاری کردم، اول برایت توضیح می‌دهم؛ و کارهای خطرناک (مثل حذف) را بدون اجازهٔ تو انجام نمی‌دهم.");
  return lines.join("\n");
}

export function featuresAnswerEn(): string {
  return [
    "I am the clinic assistant. I understand your request and do it in the clinic system.",
    "",
    "Things I can do:",
    ...FEATURES.map((feature) => `• ${feature.titleEn}${feature.available ? "" : " (not wired yet)"}`),
    "",
    "Anything destructive (like deleting) always needs your confirmation first.",
  ].join("\n");
}

export function featuresAnswer(locale: Locale, options?: { detailed?: boolean }): string {
  return locale === "en" ? featuresAnswerEn() : featuresAnswerFa(options);
}

/** Short version used inside confirmation/clarification messages. */
export function featureTitleList(locale: Locale): string[] {
  return FEATURES.filter((feature) => feature.available).map((feature) =>
    locale === "en" ? feature.titleEn : feature.titleFa,
  );
}
