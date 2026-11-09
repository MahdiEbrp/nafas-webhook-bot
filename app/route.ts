import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * GET / — a tiny chat page, so the bot can be tried in a browser without
 * Telegram. The project is backend-only: no React, no CSS pipeline, one
 * template string that costs nothing to build.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function GET(): Promise<Response> {
  const config = getConfig();
  const botName = escapeHtml(config.botName);

  const html = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${botName} — گفت‌وگو</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b1020; color: #e8ecf8;
         font-family: ui-sans-serif, system-ui, "Segoe UI", Vazirmatn, Tahoma, sans-serif; line-height: 1.8; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 20px 16px 28px; display: flex; flex-direction: column; height: 100vh; }
  header { display: flex; align-items: center; gap: 10px; padding-bottom: 12px; border-bottom: 1px solid #1e2947; }
  h1 { font-size: 20px; margin: 0; }
  .dim { color: #8fa2ca; font-size: 12.5px; }
  .spacer { flex: 1; }
  button.ghost { background: #16203a; border: 1px solid #24325a; color: #c9d6f2; border-radius: 10px; padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer; }
  #log { flex: 1; overflow: auto; padding: 16px 0; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 82%; padding: 9px 13px; border-radius: 14px; white-space: pre-wrap; font-size: 14.5px; }
  .msg.user { align-self: flex-start; background: #2f62d8; color: #fff; border-bottom-left-radius: 4px; }
  .msg.bot { align-self: flex-end; background: #101931; border: 1px solid #1e2947; border-bottom-right-radius: 4px; }
  .msg.meta { align-self: center; background: none; color: #7f92ba; font-size: 11.5px; padding: 0; }
  form { display: flex; gap: 8px; padding-top: 10px; border-top: 1px solid #1e2947; }
  textarea { flex: 1; min-height: 46px; max-height: 140px; background: #0a1224; color: #e8ecf8; border: 1px solid #24325a;
             border-radius: 12px; padding: 12px; font: inherit; font-size: 14.5px; resize: none; }
  button.send { background: #2f62d8; color: white; border: 0; border-radius: 12px; padding: 0 20px; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: progress; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${botName} 💬</h1>
    <span class="dim">یک چت‌بات ساده — فقط گفت‌وگو</span>
    <span class="spacer"></span>
    <button class="ghost" id="clear" type="button">گفت‌وگوی تازه</button>
  </header>

  <div id="log">
    <div class="msg bot">سلام! من ${botName} هستم. هر چه دوست داری بنویس تا با هم حرف بزنیم. 🙂</div>
  </div>

  <form id="form">
    <textarea id="input" placeholder="حرف خودت را بنویس…" rows="1"></textarea>
    <button class="send" id="send" type="submit">بفرست</button>
  </form>
</div>

<script>
(function () {
  var log = document.getElementById('log');
  var input = document.getElementById('input');
  var form = document.getElementById('form');
  var send = document.getElementById('send');
  var sessionId = 'web-' + Math.random().toString(36).slice(2, 10);

  function add(kind, text) {
    var div = document.createElement('div');
    div.className = 'msg ' + kind;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  async function submit() {
    var text = input.value.trim();
    if (!text) return;

    add('user', text);
    input.value = '';
    input.style.height = 'auto';
    send.disabled = true;
    var thinking = add('meta', '… دارد تایپ می‌کند');

    try {
      var response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId: sessionId }),
      });
      var json = await response.json();
      thinking.remove();
      if (!json.ok) {
        add('bot', 'خطا: ' + (json.error && json.error.message));
      } else {
        add('bot', json.data.reply);
        if (json.data.model) add('meta', json.data.model + ' · ' + json.data.ms + 'ms');
      }
    } catch (error) {
      thinking.remove();
      add('bot', 'شبکه جواب نداد: ' + error.message);
    } finally {
      send.disabled = false;
      input.focus();
    }
  }

  form.onsubmit = function (event) { event.preventDefault(); submit(); };
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
  });
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });

  document.getElementById('clear').onclick = function () {
    sessionId = 'web-' + Math.random().toString(36).slice(2, 10);
    log.innerHTML = '';
    add('bot', 'گفت‌وگوی تازه شروع شد. چه خبر؟ 🙂');
  };
})();
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
