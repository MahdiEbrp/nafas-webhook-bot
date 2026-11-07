/**
 * npm run build:catalog
 *
 * Regenerates docs/FEATURES.fa.md from the manifest, so the documentation can
 * never drift away from what the bot is actually allowed to do.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FEATURES, permissionMatrix } from "@/lib/features/manifest";

const DANGER_FA: Record<string, string> = {
  read: "خواندن — بی‌خطر",
  write: "تغییر دادن — نیاز به تأیید",
  destructive: "حذف کردن — خطرناک",
};

function build(): string {
  const lines: string[] = [];
  const push = (line = "") => lines.push(line);

  push("# فهرست امکانات ربات وب‌هوک کلینیک");
  push();
  push("این فایل به‌طور خودکار از `lib/features/manifest.ts` ساخته می‌شود. دستی ویرایش نکنید.");
  push();
  push(`تعداد بخش‌ها: **${FEATURES.length}** — بخش‌های آماده: **${FEATURES.filter((f) => f.available).length}** — مجموع اکشن‌ها: **${FEATURES.reduce((sum, f) => sum + f.actions.length, 0)}**`);
  push();
  push("## خلاصه");
  push();
  push("| بخش | نام فارسی | اکشن‌ها | آماده؟ |");
  push("| --- | --- | --- | --- |");
  for (const feature of FEATURES) {
    push(`| \`${feature.id}\` | ${feature.titleFa} | ${feature.actions.length} | ${feature.available ? "✅" : "❌"} |`);
  }
  push();

  for (const feature of FEATURES) {
    push(`## ${feature.titleFa} (\`${feature.id}\`)`);
    push();
    push(`> ${feature.kid}`);
    push();
    push("**مثال‌هایی از حرف کاربر:** " + feature.userWants.map((want) => `«${want}»`).join(" • "));
    push();
    push("**کلمه‌های کلیدی:** " + feature.keywords.join("، "));
    push();
    if (feature.actions.length === 0) {
      push("⚠ این بخش هنوز آدرس (route) ندارد و ربات فقط می‌تواند توضیحش بدهد.");
      push();
      continue;
    }
    push("| اکشن | متد و آدرس | دسترسی لازم | نوع | تأیید لازم؟ | توضیح |");
    push("| --- | --- | --- | --- | --- | --- |");
    for (const action of feature.actions) {
      push(
        `| \`${action.id}\` | \`${action.method} ${action.path}\` | \`${action.permission}\` | ${DANGER_FA[action.danger] ?? action.danger} | ${action.needsConfirmation ? "بله" : "نه"} | ${action.fa} |`,
      );
    }
    push();
    if (feature.actions.some((action) => action.fields?.length)) {
      push("**فیلدهایی که هوش مصنوعی می‌تواند پر کند:**");
      push();
      for (const action of feature.actions) {
        if (action.fields?.length) push(`- \`${action.id}\`: ${action.fields.map((field) => `\`${field}\``).join("، ")}`);
      }
      push();
    }
    if (feature.notes) {
      push(`**نکته:** ${feature.notes}`);
      push();
    }
  }

  push("## جدول دسترسی‌ها");
  push();
  push("| permission | نوع | تعداد اکشن |");
  push("| --- | --- | --- |");
  for (const [permission, meta] of Object.entries(permissionMatrix())) {
    push(`| \`${permission}\` | ${DANGER_FA[meta.danger]} | ${meta.actions.length} |`);
  }
  push();
  push("## قانون طلایی");
  push();
  push("هوش مصنوعی فقط می‌تواند یکی از اکشن‌های بالا را انتخاب کند. آدرس، متد، دسترسی و تأییدِ لازم همه در کد تعیین شده‌اند؛ بنابراین مدل نمی‌تواند کارِ خارج از این فهرست انجام دهد.");
  push();

  return lines.join("\n");
}

const outputDir = join(process.cwd(), "docs");
mkdirSync(outputDir, { recursive: true });
const outputPath = join(outputDir, "FEATURES.fa.md");
writeFileSync(outputPath, build(), "utf8");
console.log(`✓ wrote ${outputPath}`);
