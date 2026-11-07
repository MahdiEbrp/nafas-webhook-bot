import { getConfig } from "@/lib/config";
import { FEATURES, permissionMatrix } from "@/lib/features/manifest";

export const dynamic = "force-dynamic";

/**
 * GET / — a zero-dependency HTML page that documents the API and lets you try
 * the bot. This project is backend-only: no React pages, no components, no CSS
 * pipeline. The page is one template string so it costs nothing to build.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderFeatures(): string {
  return FEATURES.map((feature) => {
    const actions = feature.actions
      .map(
        (action) =>
          `<li><code>${escapeHtml(action.method)} ${escapeHtml(action.path)}</code>
           <span class="perm">${escapeHtml(action.permission)}</span>
           <span class="danger ${action.danger}">${action.danger}</span>
           <div class="dim">${escapeHtml(action.fa)}</div></li>`,
      )
      .join("");

    return `<details class="card" ${feature.available ? "" : "open"}>
      <summary><strong>${escapeHtml(feature.titleFa)}</strong> <span class="dim">${escapeHtml(feature.titleEn)}</span>
        ${feature.available ? "" : '<span class="danger destructive">no route</span>'}
        <span class="count">${feature.actions.length} action</span>
      </summary>
      <p class="kid">${escapeHtml(feature.kid)}</p>
      <p class="dim">مثلاً: ${feature.userWants.map((w) => `«${escapeHtml(w)}»`).join(" • ")}</p>
      ${actions ? `<ul class="actions">${actions}</ul>` : '<p class="dim">هنوز آدرسی برای این بخش وجود ندارد.</p>'}
    </details>`;
  }).join("");
}

function renderPermissions(): string {
  return Object.entries(permissionMatrix())
    .map(
      ([permission, meta]) =>
        `<tr><td><code>${escapeHtml(permission)}</code></td><td><span class="danger ${meta.danger}">${meta.danger}</span></td><td class="dim">${meta.actions.length}</td></tr>`,
    )
    .join("");
}

export async function GET(): Promise<Response> {
  const config = getConfig();
  const available = FEATURES.filter((feature) => feature.available).length;

  const html = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ربات وب‌هوک کلینیک — API</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b1020; color: #e8ecf8;
         font-family: ui-sans-serif, system-ui, "Segoe UI", Vazirmatn, Tahoma, sans-serif; line-height: 1.75; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 28px 20px 80px; }
  h1 { font-size: 26px; margin: 0 0 6px; }
  h2 { font-size: 18px; margin: 34px 0 12px; border-bottom: 1px solid #1e2947; padding-bottom: 8px; }
  .lead { color: #9fb0d6; margin: 0 0 18px; }
  .badges { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .badge { background: #131c33; border: 1px solid #24325a; border-radius: 999px; padding: 4px 12px; font-size: 12px; color: #a9bce4; }
  code { background: #0f1730; border: 1px solid #1d2949; border-radius: 6px; padding: 1px 6px;
         font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; direction: ltr; display: inline-block; }
  .card { background: #101931; border: 1px solid #1e2947; border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; }
  .card summary { cursor: pointer; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .dim { color: #8fa2ca; font-size: 13px; }
  .topology { display: grid; grid-template-columns: 1fr auto 1fr auto 1fr; gap: 8px; align-items: center;
              background: #0d1529; border: 1px solid #1e2947; border-radius: 14px; padding: 14px; margin: 18px 0 6px; }
  .node { background: #101931; border: 1px solid #24325a; border-radius: 12px; padding: 10px 12px; text-align: center; }
  .node.me { border-color: #3b6fd4; box-shadow: 0 0 0 1px #3b6fd4 inset; }
  .node-title { font-size: 13px; margin-bottom: 4px; }
  .node-body { font-size: 12.5px; }
  .arrow { text-align: center; font-size: 11px; color: #7f92ba; line-height: 1.5; }
  @media (max-width: 720px) { .topology { grid-template-columns: 1fr; } }
  .kid { background: #0d1529; border-inline-start: 3px solid #3b6fd4; border-radius: 8px; padding: 8px 12px; color: #c8d5f0; font-size: 13.5px; }
  .count { margin-inline-start: auto; font-size: 12px; color: #7f92ba; }
  .actions { list-style: none; padding: 0; margin: 10px 0 0; }
  .actions li { border-top: 1px dashed #1d2949; padding: 8px 0; }
  .perm { font-size: 11.5px; color: #93a6cf; background: #0f1730; border-radius: 6px; padding: 1px 7px; margin: 0 6px; direction: ltr; display: inline-block; }
  .danger { font-size: 11px; border-radius: 6px; padding: 1px 7px; }
  .danger.read { background: #10321f; color: #6ee7a0; }
  .danger.write { background: #33280c; color: #f3c969; }
  .danger.destructive { background: #3a1418; color: #ff8b96; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { text-align: start; padding: 8px 6px; border-bottom: 1px solid #1a2545; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
  .panel { background: #101931; border: 1px solid #1e2947; border-radius: 12px; padding: 14px; }
  #log { background: #0a1224; border: 1px solid #1d2949; border-radius: 12px; padding: 12px; height: 320px;
         overflow: auto; font-size: 13.5px; white-space: pre-wrap; }
  .msg { margin-bottom: 10px; }
  .msg.user { color: #9fd0ff; }
  .msg.bot { color: #dbe6ff; }
  .msg.meta { color: #7f92ba; font-size: 11.5px; }
  textarea { width: 100%; min-height: 62px; background: #0a1224; color: #e8ecf8; border: 1px solid #24325a;
             border-radius: 10px; padding: 10px; font: inherit; resize: vertical; }
  button { background: #2f62d8; color: white; border: 0; border-radius: 10px; padding: 9px 16px; font: inherit; cursor: pointer; }
  button.ghost { background: #16203a; border: 1px solid #24325a; color: #c9d6f2; }
  button:disabled { opacity: .5; cursor: progress; }
  .row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  a { color: #7fb0ff; }
</style>
</head>
<body>
<div class="wrap">
  <h1>ربات وب‌هوک کلینیک 🤖</h1>
  <p class="lead">این یک بک‌اندِ Next.js برای Vercel است که <strong>واسطِ</strong> بین سایت کلینیک و پروژهٔ ورسلی است. فارسی می‌فهمد، با مدل‌های <strong>مجانیِ OpenRouter</strong> فکر می‌کند، و کار را از طریق وب‌هوک‌های سایت انجام می‌دهد.</p>

  <div class="topology">
    <div class="node up">
      <div class="node-title">🌐 سایت کلینیک (upstream)</div>
      <div class="node-body">nafasbeautyclinic.ir<br><span class="dim">صاحب داده‌ها و ‎/api/v1/webhooks/*</span></div>
    </div>
    <div class="arrow">▲<br><span>Basic Auth<br><span class="dim">رمز فقط اینجاست</span></span></div>
    <div class="node me">
      <div class="node-title">🤖 همین پروژه (این واسط)</div>
      <div class="node-body">AI + proxy + rate limit + audit<br><span class="dim">Vercel · بدون دیتابیس</span></div>
    </div>
    <div class="arrow">▲<br><span>x-bot-key</span></div>
    <div class="node down">
      <div class="node-title">📦 پروژهٔ ورسلی (downstream)</div>
      <div class="node-body">اپ/ربات/پنل شما<br><span class="dim">رمز سایت را نمی‌بیند</span></div>
    </div>
  </div>
  <div class="badges">
    <span class="badge">${available} بخش آماده</span>
    <span class="badge">${FEATURES.reduce((sum, f) => sum + f.actions.length, 0)} اکشن</span>
    <span class="badge">مدل‌ها: ${config.modelChain.length} مدل مجانی (زنجیره‌ای)</span>
    <span class="badge">upstream: ${escapeHtml(config.webhookBaseUrl)}</span>
    <span class="badge">CORS: ${config.allowedOrigins.length === 0 ? "سرور-به-سرور" : escapeHtml(config.allowedOrigins.join(", "))}</span>
    <span class="badge">تلگرام: ${config.telegram.botToken ? (config.telegram.publicUrl ? `✅ ${escapeHtml(config.telegram.publicUrl)}` : "⚠️ آدرس ثبت نشده") : "خاموش"}</span>
  </div>

  <div class="topology">
    <div class="node up">
      <div class="node-title">📱 تلگرام</div>
      <div class="node-body">پیام فارسی یا فشار دکمه<br><span class="dim">webhook + secret</span></div>
    </div>
    <div class="arrow">▼</div>
    <div class="node me">
      <div class="node-title">🤖 همین پروژه</div>
      <div class="node-body">فهمیدن → تأیید → اجرا → توضیح<br><span class="dim">+ ساخت دکمه با AI</span></div>
    </div>
    <div class="arrow">▼</div>
    <div class="node down">
      <div class="node-title">🌐 سایت کلینیک</div>
      <div class="node-body">‎/api/v1/webhooks/*<br><span class="dim">داده‌ها همان‌جا می‌مانند</span></div>
    </div>
  </div>

  <h2>۱. امتحان کن</h2>
  <div class="panel">
    <div id="log"><div class="msg bot">سلام! بنویس چه می‌خواهی. مثلاً: «نوبت‌های امروز رو نشون بده» یا «تو چه کارهایی می‌تونی بکنی؟»</div></div>
    <textarea id="input" placeholder="حرف خودت را فارسی بنویس…"></textarea>
    <div class="row">
      <button id="send">بفرست</button>
      <button class="ghost" id="features">چه کارهایی بلدی؟</button>
      <button class="ghost" id="hey">سلام</button>
    </div>
    <p class="dim">اگر پاسخ «اجازه می‌دهی؟» بود، با دکمهٔ تأیید همان کار اجرا می‌شود — بدون تأیید شما هیچ چیزی تغییر نمی‌کند.</p>
  </div>

  <h2>۲. امکانات (همان چیزی که هوش مصنوعی می‌بیند)</h2>
  ${renderFeatures()}

  <h2>۳. دسترسی‌ها</h2>
  <table>
    <thead><tr><th>permission</th><th>نوع</th><th>تعداد اکشن</th></tr></thead>
    <tbody>${renderPermissions()}</tbody>
  </table>

  <h2>۴. تلگرام</h2>
  <div class="panel">
    <p>${config.telegram.botToken
      ? config.telegram.publicUrl
        ? `ربات وصل است. هربار سرور بالا بیاید، لاگین و ثبت وب‌هوک خودکار انجام می‌شود:<br><code>${escapeHtml(config.telegram.publicUrl)}/api/telegram/webhook</code>`
        : "توکن هست ولی <code>PUBLIC_APP_URL</code> خالی است، پس آدرسی برای ثبت وب‌هوک نداریم."
      : "خاموش است. توکن را از @BotFather بگیر و در <code>TELEGRAM_BOT_TOKEN</code> بگذار."}</p>
    <p class="dim">بعد از هر جواب، هوش مصنوعی ۳ دکمهٔ «قدم بعدی» پیشنهاد می‌دهد — فقط از اکشن‌های خواندنِ منیفست، هیچ دکمهٔ حذفی ساخته نمی‌شود.</p>
    <p class="dim">دستورها: <code>/start</code> · <code>/menu</code> · <code>/help</code> · <code>/id</code> · <code>/whoami</code> · <code>/logout</code></p>
    <p class="dim"><strong>ورود بدون رمز:</strong> ${config.telegram.requireIdentity ? "روشن است ✅ — هر چت باید شمارهٔ تلگرامش را با فهرست کاربران سایت تطبیق دهد." : "خاموش است. با TELEGRAM_REQUIRE_IDENTITY=true روشن می‌شود: کاربر دکمهٔ «ارسال شمارهٔ من» را می‌زند، شماره‌ای که تلگرام خودش با پیامک تأیید کرده، در «کاربران» سایت جست‌وجو می‌شود."}</p>
    <p class="dim">⚠️ OTP با پیامک از سمت سایت هنوز ممکن نیست: وب‌هوک‌ها فقط Basic auth دارند و برای بخش پیامک route وجود ندارد.</p>
  </div>

  <h2>۵. مسیرهای API</h2>
  <div class="grid">
    <div class="panel"><code>POST /api/chat</code><p class="dim">حالت هوشمند: حرف فارسی → فهمیدن → تأیید → انجام → توضیح ساده</p></div>
    <div class="panel"><code>GET|POST|PATCH|DELETE /api/proxy/api/v1/webhooks/…</code><p class="dim">حالت واسط خام (بدون AI): پروژهٔ ورسلی همان درخواست آشنای خودش را از اینجا می‌فرستد. فقط اکشن‌های منیفست رد می‌شوند.</p></div>
    <div class="panel"><code>GET /api/features</code><p class="dim">فهرست کامل امکانات + دسترسی‌ها (‎?shape=tools برای تعریف tool)</p></div>
    <div class="panel"><code>POST /api/telegram/webhook</code><p class="dim">تلگرام اینجا آپدیت می‌فرستد؛ بدون secret جواب نمی‌دهد</p></div>
    <div class="panel"><code>GET|POST /api/telegram/setup</code><p class="dim">وضعیت / ثبت / حذف وب‌هوک تلگرام (لاگین دستی)</p></div>
    <div class="panel"><code>GET /api/health</code><p class="dim">وضعیت کلیدها، مدل‌های مجانی و ‎?deep=1 برای تست واقعی وب‌هوک</p></div>
  </div>

  <h2>۶. کدام حالت را انتخاب کنم؟</h2>
  <table>
    <thead><tr><th>اگر …</th><th>از این استفاده کن</th></tr></thead>
    <tbody>
      <tr><td>کاربر فارسی می‌نویسد و باید خودش فهمیده شود</td><td><code>POST /api/chat</code></td></tr>
      <tr><td>برنامهٔ تو می‌داند چه می‌خواهد (مثلاً صفحهٔ لیست نوبت‌ها)</td><td><code>/api/proxy/…</code> — سریع‌تر و بدون هزینهٔ مدل</td></tr>
      <tr><td>می‌خواهی از گوشی، بدون هیچ اپی، کار کنی</td><td>ربات تلگرام — <code>npm run telegram:setup</code></td></tr>
      <tr><td>فقط می‌خواهی مطمئن شوی اتصال به سایت برقرار است</td><td><code>GET /api/health?deep=1</code> یا <code>npm run doctor</code></td></tr>
    </tbody>
  </table>
</div>
<script>
(function () {
  var log = document.getElementById('log');
  var input = document.getElementById('input');
  var send = document.getElementById('send');
  var sessionId = 'web-' + Math.random().toString(36).slice(2, 10);
  var pendingToken = null;

  function add(kind, text) {
    var div = document.createElement('div');
    div.className = 'msg ' + kind;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  async function call(payload) {
    send.disabled = true;
    var thinking = add('meta', '… دارد فکر می‌کند');
    try {
      var response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ sessionId: sessionId }, payload)),
      });
      var json = await response.json();
      thinking.remove();
      if (!json.ok) { add('bot', 'خطا: ' + (json.error && json.error.message)); return; }
      var data = json.data;
      add('bot', data.reply);
      add('meta', '[' + data.status + '] اکشن: ' + (data.actionId || '—') + ' • مغز: ' + data.trace.planner + ' / ' + data.trace.writer + ' • ' + data.trace.ms + 'ms');
      pendingToken = data.confirmation ? data.confirmation.token : null;
      if (pendingToken) {
        var row = document.createElement('div');
        row.className = 'row';
        var yes = document.createElement('button');
        yes.textContent = 'بله، انجام بده';
        yes.onclick = function () { call({ message: 'تأیید می‌کنم', confirm: { token: pendingToken, approve: true } }); };
        var no = document.createElement('button');
        no.className = 'ghost';
        no.textContent = 'نه، لغو کن';
        no.onclick = function () { call({ message: 'لغو', confirm: { token: pendingToken, approve: false } }); };
        row.appendChild(yes); row.appendChild(no);
        log.appendChild(row);
        log.scrollTop = log.scrollHeight;
      }
    } catch (error) {
      thinking.remove();
      add('bot', 'شبکه جواب نداد: ' + error.message);
    } finally {
      send.disabled = false;
    }
  }

  function submit() {
    var text = input.value.trim();
    if (!text) return;
    add('user', text);
    input.value = '';
    call({ message: text });
  }

  send.onclick = submit;
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
  });
  document.getElementById('features').onclick = function () { add('user', 'چه کارهایی بلدی؟'); call({ message: 'چه کارهایی می‌تونی انجام بدی؟' }); };
  document.getElementById('hey').onclick = function () { add('user', 'سلام'); call({ message: 'سلام' }); };
})();
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
