/**
 * TELEGRAM BRIDGE
 *
 * Incoming Telegram update → `handleChat` → Persian answer. That is the whole
 * file. There are no buttons, no menus and no confirmations any more: a chat
 * bot reads text and writes text.
 *
 * Flow:
 *   /start        → greeting
 *   /help         → what this bot is
 *   /clear /reset → forget the conversation
 *   /id           → the chat's numeric id (for TELEGRAM_ALLOWED_CHAT_IDS)
 *   anything else → handleChat(text) → answer
 */

import { getConfig, type Locale } from "@/lib/config";
import { handleChat, resetConversation } from "@/lib/bot";
import { helpText, welcomeText } from "@/lib/bot/prompt";
import { logInfo, logWarn } from "@/lib/log";
import { truncateAtSentence } from "@/lib/text";
import {
  answerCallbackQuery,
  sendMessage,
  sendTyping,
  type TelegramUpdate,
} from "@/lib/telegram/api";
import { resolveSessionId } from "@/lib/db/chat-sessions";

export type BridgeOutcome = {
  handled: boolean;
  reason?: string;
  chatId?: number;
  status?: string;
  model?: string | null;
  ms?: number;
  text?: string;
};

/** Telegram caps a message at 4096 characters; leave room for the ellipsis. */
const MAX_TEXT = 3900;

function isAllowed(chatId: number): boolean {
  const { allowedChatIds } = getConfig().telegram;
  if (allowedChatIds.length === 0) return true; // locked-down deployments should set this
  return allowedChatIds.includes(chatId);
}

/**
 * The conversation key for a chat.
 *
 * Stored in Postgres as chat_id → session_id when a database is configured; the
 * deterministic `tg-<chatId>` otherwise. `resolveSessionId` never throws, so a
 * database outage makes the bot forgetful, never silent.
 */
function sessionIdFor(chatId: number): Promise<string> {
  return resolveSessionId(chatId);
}

const CLEARED: Record<Locale, string> = {
  fa: "باشه، همه‌چیز را فراموش کردم. گفت‌وگوی تازه شروع شد. 🙂",
  en: "Done — I forgot everything. Fresh start. 🙂",
};

const NO_TEXT: Record<Locale, string> = {
  fa: "فعلاً فقط پیام متنی را می‌خوانم. ✍️",
  en: "I can only read text messages for now. ✍️",
};

const STALE_BUTTON: Record<Locale, string> = {
  fa: "آن دکمه‌ها مال نسخهٔ قبلی بودند و دیگر کار نمی‌کنند؛ خیلی ساده با حرفِ خودت بنویس. 🙂",
  en: "Those buttons are from an older version and no longer work — just write to me in plain words. 🙂",
};

async function replyText(
  chatId: number,
  text: string,
  options: { replyToMessageId?: number } = {},
): Promise<void> {
  await sendMessage({
    chatId,
    text: truncateAtSentence(text, MAX_TEXT),
    ...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {}),
  });
}

async function processTextMessage(input: {
  chatId: number;
  text: string;
  locale: Locale;
  replyToMessageId?: number;
}): Promise<BridgeOutcome> {
  const { chatId, text, locale, replyToMessageId } = input;
  sendTyping(chatId);

  const result = await handleChat({ message: text, sessionId: await sessionIdFor(chatId), locale });

  await replyText(chatId, result.reply, { replyToMessageId });

  logInfo("telegram.message", { chatId, status: result.status, model: result.model, ms: result.ms });

  return {
    handled: true,
    chatId,
    status: result.status,
    model: result.model,
    ms: result.ms,
    text: result.reply,
  };
}

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<BridgeOutcome> {
  const locale: Locale = getConfig().defaultLocale;

  /* ── 1. Leftover button presses ────────────────────────────────────── */
  if (update.callback_query) {
    const query = update.callback_query;
    const chatId = query.message?.chat.id;
    if (!chatId) return { handled: false, reason: "callback without chat" };
    if (!isAllowed(chatId)) return { handled: false, reason: "chat not allowed", chatId };

    void answerCallbackQuery({ callbackQueryId: query.id });
    await replyText(chatId, STALE_BUTTON[locale]);
    return { handled: true, chatId, status: "stale-button" };
  }

  /* ── 2. Plain messages ─────────────────────────────────────────────── */
  const message = update.message ?? update.edited_message;
  if (!message?.chat) return { handled: false, reason: "no message" };

  const chatId = message.chat.id;
  if (!isAllowed(chatId)) {
    logWarn("telegram.chat_blocked", { chatId });
    return { handled: false, reason: "chat not allowed", chatId };
  }

  const text = (message.text ?? "").trim();

  if (!text) {
    await replyText(chatId, NO_TEXT[locale]);
    return { handled: true, chatId, status: "unsupported" };
  }

  const firstName = message.from?.first_name;

  if (/^\/(start|menu)\b/.test(text)) {
    await replyText(chatId, welcomeText(locale, firstName), { replyToMessageId: message.message_id });
    logInfo("telegram.start", { chatId });
    return { handled: true, chatId, status: "start" };
  }

  if (/^\/(help|features)\b/.test(text)) {
    await replyText(chatId, helpText(locale));
    return { handled: true, chatId, status: "help" };
  }

  if (/^\/(clear|reset|new)\b/.test(text)) {
    resetConversation(await sessionIdFor(chatId));
    await replyText(chatId, CLEARED[locale]);
    logInfo("telegram.clear", { chatId });
    return { handled: true, chatId, status: "cleared" };
  }

  if (/^\/id\b/.test(text)) {
    await replyText(
      chatId,
      locale === "en"
        ? `Your chat id: ${chatId}`
        : `شناسهٔ گفت‌وگوی تو: ${chatId}\nاین را در TELEGRAM_ALLOWED_CHAT_IDS بگذار تا فقط تو دسترسی داشته باشی.`,
    );
    return { handled: true, chatId, status: "id" };
  }

  return await processTextMessage({ chatId, text, locale, replyToMessageId: message.message_id });
}
