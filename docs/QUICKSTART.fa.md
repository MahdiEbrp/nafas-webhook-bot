# شروع سریع (۵ دقیقه)

## ۱. نصب

```bash
unzip ai-webhook-bot.zip
cd ai-webhook-bot
npm install
```

## ۲. ببین بدون هیچ تنظیمی کار می‌کند

دو ترمینال باز کن:

```bash
# ترمینال ۱ — شبیه‌ساز سایت کلینیک (بدون دست‌زدن به دادهٔ واقعی)
npm run mock-api

# ترمینال ۲ — خود ربات
npm run dev
```

بعد:

- مرورگر: <http://localhost:3000> ← صفحهٔ مستندات + کنسول گفت‌وگوی فارسی
- یا این را در ترمینال سوم بزن تا کل مسیر را ببینی:

```bash
npm run demo
```

```bash
npm run selftest    # ۵۹ تست، بدون کلید و بدون اینترنت
```

## ۳. وصل کردن به سایت واقعی

در Vercel (یا `.env.local`):

```bash
WEBHOOK_BASE_URL=https://nafasbeautyclinic.ir
WEBHOOK_USERNAME=<ایمیل کاربر سرویس>
WEBHOOK_PASSWORD=<رمز آن کاربر>
OPENROUTER_API_KEY=sk-or-v1-...      # از openrouter.ai/keys (مجانی)
BOT_API_KEY=<یک رشتهٔ تصادفی>
ALLOWED_ORIGINS=https://nafasbeautyclinic.ir
```

بعد چک کن:

```bash
npm run doctor      # DNS/TLS + مسیر وب‌هوک + اعتبار کلید + جدول مجوزها
```

## ۴. تلگرام (۳۰ ثانیه)

```bash
# ۱) در تلگرام به @BotFather پیام بده: /newbot  → توکن
# ۲) در env:
TELEGRAM_BOT_TOKEN=123:ABC
TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32)
PUBLIC_APP_URL=https://<project>.vercel.app
TELEGRAM_REQUIRE_IDENTITY=true
# ۳) ثبت وب‌هوک:
npm run telegram:setup
```

بعد در تلگرام: `/start` → دکمهٔ «📱 ارسال شمارهٔ من» → وارد می‌شوی.
`/id` را بفرست و عدد را در `TELEGRAM_ALLOWED_CHAT_IDS` بگذار.

## ۵. دیپلوی

```bash
npm i -g vercel
vercel link
vercel env add OPENROUTER_API_KEY production
vercel env add WEBHOOK_BASE_URL production
vercel env add WEBHOOK_USERNAME production
vercel env add WEBHOOK_PASSWORD production
vercel env add BOT_API_KEY production
vercel --prod
```

---

## فایل‌های مهم

| فایل | کار |
| --- | --- |
| `lib/features/manifest.ts` | ⭐ فهرست ۴۹ اکشن مجاز — تنها منبع حقیقت |
| `lib/bot/` | فهمیدن → تأیید → اجرا → توضیح |
| `lib/openrouter/client.ts` | زنجیرهٔ مدل‌های مجانی |
| `lib/telegram/` | ربات تلگرام + دکمه‌های AI + ورود بدون رمز |
| `app/api/chat/` | حالت هوشمند |
| `app/api/proxy/` | حالت واسط خام |
| `README.md` | مستندات کامل |
| `docs/FEATURES.fa.md` | فهرست امکانات (خودکار) |
| `docs/ARCHITECTURE.md` | چرا این‌طوری ساخته شده |

## اگر گیر کردی

| علامت | علت | کار |
| --- | --- | --- |
| `WEBHOOK_UNAUTHORIZED (401)` | نام کاربری/رمز وب‌هوک | `npm run doctor` |
| `WEBHOOK_FORBIDDEN (403)` | کاربر سرویس آن دسترسی را ندارد | نقش کاربر را در سایت اصلاح کن |
| «همهٔ مدل‌های مجانی شلوغ بودند» | سهمیهٔ OpenRouter | `npm run models` → مدل زنده را در `OPENROUTER_MODELS` بگذار |
| «ربات جواب نمی‌دهد» در تلگرام | وب‌هوک ثبت نشده | `npm run telegram:setup -- --force` |
| «این شماره در فهرست کاربران کلینیک نیست» | شماره در سایت نیست یا فرمتش عجیب است | کاربر را اضافه کن؛ ربات با ‎+98/0098/فاصله هم می‌گردد |
