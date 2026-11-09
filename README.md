# nafas chat bot 💬

یک **چت‌بات گفت‌وگومحور** به زبان فارسی. هیچ منوی دکمه‌ای، هیچ وب‌هوکی، هیچ دیتابیسی — فقط:
حرفِ کاربر → مدل → جواب.

پروژه یک بک‌اند Next.js است که روی Vercel دیپلوی می‌شود و از دو راه در دسترس است:

- **تلگرام** — ربات، پیام را می‌خواند و جواب می‌دهد.
- **HTTP** — `POST /api/chat` برای هر اپ یا صفحه‌ای که می‌خواهد چت کند (یک صفحهٔ چتِ ساده هم روی `/` هست).

> نسخهٔ قبلی این مخزن یک واسطِ وب‌هوک برای کلینیک بود. همهٔ آن امکانات حذف شده‌اند؛
> الان فقط گفت‌وگو باقی مانده است.

---

## مسیرِ یک پیام

```
کاربر می‌نویسد
      │
      ▼
 /api/telegram/webhook  ← یا →  POST /api/chat
      │
      ▼
 handleChat()               lib/bot/index.ts
      │  پرامپت سیستم + حافظهٔ گفت‌وگو
      ▼
 OpenRouter (زنجیرهٔ مدل‌های :free)   lib/openrouter/client.ts
      │  اولین مدلی که جواب بدهد برنده است
      ▼
 جواب فارسی + ذخیره در حافظه
```

حافظهٔ گفت‌وگو در حافظهٔ همان پروسه نگه داشته می‌شود (چند پیامِ آخر، با TTL) —
بدون دیتابیس. اگر کاربرِ هم‌زمانِ زیادی داشتی، همین یک فایل
(`lib/bot/session.ts`) را به Upstash/Redis وصل کن.

## فایل‌ها

| مسیر | کار |
| --- | --- |
| `lib/bot/index.ts` | کل بات: `handleChat()` |
| `lib/bot/prompt.ts` | شخصیت بات، سلام و راهنما |
| `lib/bot/session.ts` | حافظهٔ گفت‌وگو (پنجرهٔ لغزان + TTL) |
| `lib/openrouter/client.ts` | صدا زدن مدل‌های مجانی، با زنجیرهٔ جایگزین |
| `lib/telegram/handler.ts` | تبدیل آپدیت تلگرام به یک پیام متنی |
| `lib/telegram/api.ts` | کلاینت Bot API (فقط `sendMessage` و دوستان) |
| `app/route.ts` | صفحهٔ چتِ مرورگر |
| `app/api/chat/route.ts` | `POST /api/chat` |
| `app/api/telegram/webhook/route.ts` | ورودی تلگرام |
| `app/api/health/route.ts` | وضعیت کلیدها و مدل‌ها |

## راه‌اندازی

```bash
npm install
cp .env.example .env.local     # OPENROUTER_API_KEY را بگذار
npm run dev                    # http://localhost:3000
```

برای تلگرام:

```bash
# ۱) از @BotFather توکن بگیر و در TELEGRAM_BOT_TOKEN بگذار
# ۲) آدرس https خودِ پروژه را در PUBLIC_APP_URL بگذار
npm run telegram:setup         # وب‌هوک را ثبت می‌کند
```

بعد از هر استارتِ سرور، ثبت وب‌هوک خودکار انجام می‌شود (`instrumentation.ts`)؛
`npm run telegram:setup` فقط برای وقتی است که می‌خواهی دستی انجامش بدهی.

## بررسی

```bash
npm run check        # typecheck + خودتستی
```

`npm run selftest` کاملاً **آفلاین** است: OpenRouter و تلگرام را جعل می‌کند و مسیر واقعی
کد را از ابتدا تا انتها می‌زند — از `handleChat` و حافظهٔ گفت‌وگو تا هر دو route
و هندلر تلگرام. نه کلید می‌خواهد نه شبکه.

## متغیرهای محیطی

فهرست کامل با توضیح در [`.env.example`](.env.example). مهم‌ترین‌ها:

| متغیر | چرا |
| --- | --- |
| `OPENROUTER_API_KEY` | بدون آن بات فکر نمی‌کند |
| `OPENROUTER_MODELS` | زنجیرهٔ مدل‌های مجانی؛ `npm run models` زنده بودنشان را چک می‌کند |
| `BOT_NAME` | اسمی که بات برای خودش به کار می‌برد |
| `HISTORY_MESSAGES` | چند پیامِ آخر به‌عنوان زمینه به مدل برود |
| `BOT_API_KEY` | محافظت از `/api/chat` |
| `ALLOWED_ORIGINS` | چه دامنه‌هایی از مرورگر اجازهٔ صدا زدن دارند |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` / `PUBLIC_APP_URL` | وصل شدن به تلگرام |
| `TELEGRAM_ALLOWED_CHAT_IDS` | فقط این چت‌ها بتوانند با بات حرف بزنند |

## دستورها در تلگرام

| دستور | کار |
| --- | --- |
| `/start` | سلام دوباره |
| `/help` | بات چیست و چه می‌کند |
| `/clear` (`/reset`, `/new`) | فراموش کردن گفت‌وگو و شروع تازه |
| `/id` | شناسهٔ عددی چت (برای `TELEGRAM_ALLOWED_CHAT_IDS`) |

## API

```bash
curl -X POST https://<your-app>/api/chat \
  -H 'Content-Type: application/json' \
  -H 'x-bot-key: <BOT_API_KEY>' \
  -d '{"message":"سلام، حالت چطوره؟","sessionId":"demo"}'
```

```json
{
  "ok": true,
  "data": {
    "status": "answered",
    "reply": "سلام! خوبم، تو چطوری؟ 🙂",
    "model": "liquid/lfm-3-1.7b:free",
    "ms": 812,
    "contextMessages": 2,
    "truncated": false,
    "sessionId": "demo"
  }
}
```

`status` یکی از `answered | empty | error` است. بات وقتی مدل جواب نمی‌دهد
**حدس نمی‌زند**؛ `error` برمی‌گرداند و از کاربر می‌خواهد دوباره تلاش کند.

مسیرهای دیگر: `GET /api/health`، `GET|POST /api/telegram/setup`.
