/**
 * TELEGRAM BRIDGE
 *
 * Incoming Telegram update → `handleChat` → Persian answer. There are no menus
 * and no confirmations: a chat bot reads text and writes text. The one button
 * that exists is Telegram's own "share your number", and it is there because the
 * owner asked for the phone number to come from Telegram rather than from typing.
 *
 * Flow:
 *   no phone on file → the gate asks for one and nothing else is answered
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
  contactKeyboard,
  removeKeyboard,
  sendMessage,
  sendTyping,
  type TelegramUpdate,
} from "@/lib/telegram/api";
import { resolveSessionId, setChatPhone } from "@/lib/db/chat-sessions";
import { getRunner } from "@/lib/db/client";
import { normalizeIranPhone } from "@/lib/phone";
import { confirmPhoneText, ensurePhone } from "@/lib/telegram/phone-gate";

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

/**
 * Whether the phone gate is in force.
 *
 * It needs both a policy and a place to put the number. With no DATABASE_URL
 * there is nowhere to store a phone, so gating would lock every user out with
 * no possible answer — the gate steps aside instead and the bot behaves as it
 * did before. `PHONE_GATE=off` switches the ask off while keeping persistence.
 */
function gateActive(): boolean {
  // `getRunner()` rather than `dbConfigured()`: the question is not "was a URL
  // set" but "is there anywhere to put a number", and the runner is what
  // `setChatPhone` actually writes through. Asking the capability keeps this
  // honest when a runner is injected, as it is in the self-test.
  return getConfig().phoneGate && getRunner() !== null;
}

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

  /* ── 3. The phone gate ─────────────────────────────────────────────────
   *
   * Before anything is answered, this chat must have an Iranian mobile on
   * file. That is the owner's rule, so it sits ahead of the commands too:
   * `/start` from somebody without a number gets the ask, not the welcome.
   *
   * `/id` is the one exception. It stores nothing, it only echoes back what
   * Telegram already sent us, and it is the documented way to discover the
   * chat id for TELEGRAM_ALLOWED_CHAT_IDS. Gating it would make the allowlist
   * impossible to set up, with no way back in.
   */
  if (gateActive() && !/^\/id\b/.test(text)) {
    const say = async (
      line: string,
      options: { replyMarkup?: Record<string, unknown> } = {},
    ): Promise<void> => {
      await sendMessage({
        chatId,
        text: truncateAtSentence(line, MAX_TEXT),
        replyToMessageId: message.message_id,
        ...(options.replyMarkup ? { replyMarkup: options.replyMarkup } : {}),
      });
    };

    const gate = await ensurePhone({
      chatId,
      chatType: message.chat.type,
      text,
      ...(message.contact ? { contact: message.contact } : {}),
      ...(message.from ? { fromId: message.from.id } : {}),
      locale,
      say,
      // Telegram only puts the contact button in a private chat.
      keyboard: () =>
        message.chat.type === "private"
          ? contactKeyboard(locale === "en" ? "📱 Share my number" : "📱 شماره‌ام را بفرست")
          : null,
    });

    if (!gate.pass) return { handled: true, chatId, status: gate.status };
  }

  if (!text) {
    // A shared contact carries no text. If the gate is off, a contact on its own
    // is still worth taking rather than answering "I only read text".
    if (message.contact?.phone_number) {
      const check = normalizeIranPhone(message.contact.phone_number);
      if (check.ok && (await setChatPhone(chatId, check.normalized))) {
        await sendMessage({
          chatId,
          text: confirmPhoneText(locale, check.normalized),
          replyToMessageId: message.message_id,
          replyMarkup: removeKeyboard(),
        });
        return { handled: true, chatId, status: "phone-saved" };
      }
    }
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
