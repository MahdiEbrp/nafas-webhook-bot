#!/usr/bin/env node
/**
 * Fake Telegram Bot API for local demos.
 *
 *   node mock/telegram-mock.mjs          # http://127.0.0.1:4020/bot<token>/...
 *
 * Point TELEGRAM_API_BASE at it to watch the bot "log in", register a webhook,
 * and send messages without touching real Telegram. Not used in production.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.TG_MOCK_PORT || 4020);
const log = [];
/** stateful, so "did the bot really register?" is visible */
const state = { webhookUrl: "", pending: 0 };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const method = url.pathname.split("/").pop();

  if (url.pathname === "/__log") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(log, null, 2));
  }

  if (method === "setWebhook") state.webhookUrl = body.url ?? "";
  if (method === "deleteWebhook") state.webhookUrl = "";
  log.push({ method, body, at: new Date().toISOString() });
  console.log(`[tg-mock] ${method}`, JSON.stringify(body).slice(0, 200));

  const results = {
    getMe: { id: 424242, is_bot: true, first_name: "Clinic Demo Bot", username: "clinic_demo_bot" },
    setWebhook: true,
    deleteWebhook: true,
    getWebhookInfo: { url: state.webhookUrl, has_custom_certificate: false, pending_update_count: state.pending },
    sendMessage: { message_id: log.length, chat: { id: body.chat_id ?? 0, type: "private" }, date: Date.now() / 1000 | 0, text: body.text },
    answerCallbackQuery: true,
    sendChatAction: true,
  };

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, result: results[method] ?? true }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[tg-mock] fake Telegram Bot API on http://127.0.0.1:${PORT}`);
  console.log(`[tg-mock] inspect what the bot sent: curl http://127.0.0.1:${PORT}/__log`);
});
