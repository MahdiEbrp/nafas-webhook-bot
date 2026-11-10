import { TelegramPaymentAdmin, isPaymentAdminRequest } from "@/lib/telegram/payment-admin";
import { TelegramSettingsAdmin, isSettingsAdminRequest } from "@/lib/telegram/settings-admin";
import { TelegramSmsAdmin, isSmsAdminRequest } from "@/lib/telegram/sms-admin";
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
  deleteMessage,
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
import { EncryptedOtpLoginFlowStore } from "@/lib/auth/login-flow-store";
import { SmsOtpClient } from "@/lib/auth/sms-otp";
import { TelegramOtpLogin, isOtpCodeLikeMessage, isOtpLoginIntent, isPhoneNumberMessage } from "@/lib/auth/telegram-login";
import { TelegramSocialLinks, isSocialLinksRequest } from "@/lib/telegram/social-links";
import { TelegramWorkingHours, isWorkingHoursRequest } from "@/lib/telegram/working-hours";
import { isUserManagementMessage } from "@/lib/telegram/users";
import { TelegramUsers } from "@/lib/telegram/users";
import { RulesAssistant, isRulesRequestCandidate } from "@/lib/rules/assistant";

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
const otpClient = new SmsOtpClient();
const otpLogin = new TelegramOtpLogin({ otpClient, flowStore: new EncryptedOtpLoginFlowStore() });
const rulesAssistant = new RulesAssistant({ telegramMode: true });
const telegramUsers = new TelegramUsers();
const workingHours = new TelegramWorkingHours();
const socialLinks = new TelegramSocialLinks();
const smsAdmin = new TelegramSmsAdmin();
const settingsAdmin = new TelegramSettingsAdmin();
const paymentAdmin = new TelegramPaymentAdmin();

function sixDigitCode(text: string): boolean {
  return isOtpCodeLikeMessage(text);
}

function sensitiveOtpInput(text: string): boolean {
  return sixDigitCode(text) || isPhoneNumberMessage(text);
}

const PRIVATE_LOGIN_ONLY: Record<Locale, string> = {
  fa: "برای حفظ حریم خصوصی، ورود پیامکی فقط در گفت‌وگوی خصوصی با ربات انجام می‌شود؛ لطفاً در خصوصی بنویس «می‌خواهم لاگین کنم».",
  en: "For privacy, SMS sign-in is available only in a private chat with the bot. Please message me privately and say “I want to log in.”",
};

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
 * The conversation key for a person.
 *
 * Keyed by Telegram *user* id, not chat id: a chat id belongs to a conversation,
 * so a new chat would start from nothing, and in a group one id is shared by
 * everybody in it. Stored in Postgres as user_id → session_id when a database is
 * configured; the deterministic `tg-<userId>` otherwise. `resolveSessionId`
 * never throws, so a database outage makes the bot forgetful, never silent.
 */
function sessionIdFor(userId: number): Promise<string> {
  return resolveSessionId(userId);
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
    text,
    ...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {}),
  });
}

async function processTextMessage(input: {
  chatId: number;
  userId: number;
  text: string;
  locale: Locale;
  sessionId: string;
  ruleContext: Awaited<ReturnType<SmsOtpClient["getRuleRequestContext"]>>;
  replyToMessageId?: number;
}): Promise<BridgeOutcome> {
  const { chatId, userId, text, locale, sessionId, ruleContext, replyToMessageId } = input;
  sendTyping(chatId);

  const result = await handleChat({
    message: text,
    sessionId,
    locale,
    rulesAssistant,
    otpLoginAvailable: true,
    ...(ruleContext ? { ruleContext } : {}),
  });

  await replyText(chatId, result.reply, { replyToMessageId });

  logInfo("telegram.message", { chatId, userId, status: result.status, model: result.model, ms: result.ms });

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

  /*
   * Two different ids, and keeping them apart is the whole point:
   *
   *   chatId — where to send the reply. Telegram addressing, nothing else.
   *   userId — whose settings these are. The key for session and phone.
   *
   * `from` is absent on channel posts and from anonymous group admins, where
   * there is no user to attribute anything to. Guessing at the chat id instead
   * would silently pool strangers into one record, so we decline instead.
   */
  const userId = message.from?.id;
  if (userId === undefined) {
    logWarn("telegram.no_user", { chatId });
    return { handled: false, reason: "no user id on the update", chatId };
  }

  const text = (message.text ?? "").trim();
  const authOwnerId = `telegram-user-${userId}`;

  if (message.chat.type !== "private" && (isOtpLoginIntent(text) || sixDigitCode(text))) {
    await replyText(chatId, PRIVATE_LOGIN_ONLY[locale], { replyToMessageId: message.message_id });
    return { handled: true, chatId, status: "otp-private-only" };
  }

  const ruleContext = message.chat.type === "private"
    ? await otpClient.getRuleRequestContext(authOwnerId)
    : null;

  const collectingUser = telegramUsers.isCollecting(authOwnerId);
  const collectingSocial = socialLinks.isCollecting(authOwnerId);
  const collectingSms = smsAdmin.isCollecting(authOwnerId);
  const collectingSettings = settingsAdmin.isCollecting(authOwnerId);
  const collectingPayment = paymentAdmin.isCollecting(authOwnerId);
  const paymentSwitch = isPaymentAdminRequest(text);
  const otherPaymentDomain = isSettingsAdminRequest(text) || isSmsAdminRequest(text) || isSocialLinksRequest(text) || isWorkingHoursRequest(text) || isUserManagementMessage(text) || isRulesRequestCandidate(text);
  if (!collectingPayment && otherPaymentDomain && !paymentSwitch) paymentAdmin.clear(authOwnerId);
  if (!collectingUser && !collectingSocial && !collectingSms && !collectingSettings && (collectingPayment || paymentSwitch)) {
    settingsAdmin.clear(authOwnerId);
    smsAdmin.clear(authOwnerId);
    socialLinks.clear(authOwnerId);
    telegramUsers.clear(authOwnerId);
    workingHours.clear(authOwnerId);
    rulesAssistant.clear(`telegram-rules-${authOwnerId}`, ruleContext?.actorId ?? authOwnerId);
  }
  const paymentResult = collectingUser || collectingSocial || collectingSms || collectingSettings ? null : await paymentAdmin.handle(authOwnerId, text, ruleContext, message.chat.type === "private");
  if (paymentResult) {
    if (paymentResult.deleteSensitiveMessage) {
      const removed = await deleteMessage(chatId, message.message_id);
      if (!removed.ok) await sendMessage({ chatId, text: "⚠️ حذف پیام اطلاعات پرداخت ممکن نشد؛ خودت آن را حذف کن. مقدار وارد مدل یا تاریخچه نشده است." });
    }
    await sendMessage({ chatId, text: paymentResult.reply });
    return { handled: true, chatId, status: paymentResult.status };
  }
  if (!collectingSettings && !isSettingsAdminRequest(text) && (isSmsAdminRequest(text) || isSocialLinksRequest(text) || isWorkingHoursRequest(text) || isUserManagementMessage(text) || isRulesRequestCandidate(text))) settingsAdmin.clear(authOwnerId);
  if (!collectingUser && !collectingSocial && !collectingSms && (collectingSettings || isSettingsAdminRequest(text))) {
    smsAdmin.clear(authOwnerId);
    socialLinks.clear(authOwnerId);
    telegramUsers.clear(authOwnerId);
    workingHours.clear(authOwnerId);
    rulesAssistant.clear(`telegram-rules-${authOwnerId}`, ruleContext?.actorId ?? authOwnerId);
  }
  const settingsResult = collectingUser || collectingSocial || collectingSms ? null : await settingsAdmin.handle(authOwnerId, text, ruleContext, message.chat.type === "private");
  if (settingsResult) {
    if (settingsResult.deleteSensitiveMessage) {
      const removed = await deleteMessage(chatId, message.message_id);
      if (!removed.ok) await sendMessage({ chatId, text: "⚠️ حذف پیام مقدار تنظیم ممکن نشد؛ خودت آن را حذف کن. مقدار وارد مدل یا تاریخچه نشده است." });
    }
    await sendMessage({ chatId, text: settingsResult.reply });
    return { handled: true, chatId, status: settingsResult.status };
  }

  const otherDomain = isSocialLinksRequest(text) || isWorkingHoursRequest(text) || isUserManagementMessage(text) || isRulesRequestCandidate(text);
  if (!collectingSms && otherDomain && !isSmsAdminRequest(text)) smsAdmin.clear(authOwnerId);
  if (!collectingUser && !collectingSocial && (collectingSms || isSmsAdminRequest(text))) {
    telegramUsers.clear(authOwnerId);
    socialLinks.clear(authOwnerId);
    workingHours.clear(authOwnerId);
    rulesAssistant.clear(`telegram-rules-${authOwnerId}`, ruleContext?.actorId ?? authOwnerId);
  }
  const smsResult = collectingUser || collectingSocial ? null : await smsAdmin.handle(authOwnerId, text, ruleContext, message.chat.type === "private");
  if (smsResult) {
    if (smsResult.deleteSensitiveMessage) {
      const removed = await deleteMessage(chatId, message.message_id);
      if (!removed.ok) await sendMessage({ chatId, text: "⚠️ حذف پیام حاوی اطلاعات اتصال ممکن نشد؛ لطفاً خودت آن را حذف کن. مقدار وارد مدل یا تاریخچه نشده است." });
    }
    await sendMessage({ chatId, text: smsResult.reply });
    return { handled: true, chatId, status: smsResult.status };
  }
  if (!collectingUser && !collectingSocial && isSocialLinksRequest(text)) {
    telegramUsers.clear(authOwnerId);
    workingHours.clear(authOwnerId);
    rulesAssistant.clear(`telegram-rules-${authOwnerId}`, ruleContext?.actorId ?? authOwnerId);
  } else if (!collectingUser && !collectingSocial && (isWorkingHoursRequest(text) || isUserManagementMessage(text) || isRulesRequestCandidate(text))) socialLinks.clear(authOwnerId);
  const socialResult = collectingUser ? null : await socialLinks.handle(authOwnerId, text, ruleContext, message.chat.type === "private");
  if (socialResult) {
    await sendMessage({ chatId, text: socialResult.reply });
    return { handled: true, chatId, status: socialResult.status };
  }

  // Explicit domain switches cancel old proposals so “confirm” can never
  // accidentally approve a change from a different administrative workflow.
  if (!collectingUser && isWorkingHoursRequest(text)) {
    telegramUsers.clear(authOwnerId);
    rulesAssistant.clear(`telegram-rules-${authOwnerId}`, ruleContext?.actorId ?? authOwnerId);
  } else if (isUserManagementMessage(text) || isRulesRequestCandidate(text)) workingHours.clear(authOwnerId);
  const hoursResult = collectingUser ? null : await workingHours.handle(authOwnerId, text, ruleContext, message.chat.type === "private");
  if (hoursResult) {
    await sendMessage({ chatId, text: hoursResult.reply });
    return { handled: true, chatId, status: hoursResult.status };
  }

  const usersResult = await telegramUsers.handle(authOwnerId, message.text ?? "", ruleContext, message.chat.type === "private");
  if (usersResult) {
    if (usersResult.deleteSensitiveMessage) {
      const removed = await deleteMessage(chatId, message.message_id);
      if (!removed.ok) await sendMessage({ chatId, text: "⚠️ نتوانستم پیام حاوی رمز را از تلگرام حذف کنم؛ لطفاً خودت آن پیام را حذف کن. رمز در پاسخ یا تاریخچهٔ مدل درج نشده است." });
    }
    // Account details and temporary passwords are never added to model history.
    await sendMessage({ chatId, text: usersResult.reply });
    return { handled: true, chatId, status: usersResult.status };
  }

  const rulesConversation = `telegram-rules-${authOwnerId}`;
  if (/^\/(?:clear|reset|new)\b/iu.test(text) || isOtpLoginIntent(text)) {
    rulesAssistant.clear(rulesConversation, ruleContext?.actorId ?? authOwnerId);
  } else if (message.chat.type === "private" && ruleContext && text
    && !sensitiveOtpInput(text) && !/^(?:رمز|password)\s*[:：]/iu.test(text)
    && (isRulesRequestCandidate(text) || rulesAssistant.hasPending(rulesConversation, ruleContext.actorId)
      || rulesAssistant.hasFollowup(rulesConversation, ruleContext.actorId, text))) {
    const result = await rulesAssistant.handle({ conversationId: rulesConversation, message: text, locale, context: ruleContext });
    await sendMessage({ chatId, text: result.reply });
    return { handled: true, chatId, status: `rules-${result.kind}` };
  }

  if (message.chat.type === "private" && text) {
    const loginResult = await otpLogin.handle(authOwnerId, text, locale);
    if (loginResult.handled) {
      await replyText(chatId, loginResult.reply, { replyToMessageId: message.message_id });
      return { handled: true, chatId, status: loginResult.status, text: loginResult.reply };
    }
  }

  /* ── 3. The phone gate ─────────────────────────────────────────────────
   *
   * Before anything is answered, this *user* must have an Iranian mobile on
   * file — keyed by user id, so a number given in one chat still counts in
   * another. That is the owner's rule, so it sits ahead of the commands too:
   * `/start` from somebody without a number gets the ask, not the welcome.
   *
   * `/id` is the one exception. It stores nothing, it only echoes back what
   * Telegram already sent us, and it is the documented way to discover the
   * chat id for TELEGRAM_ALLOWED_CHAT_IDS. Gating it would make the allowlist
   * impossible to set up, with no way back in.
   */
  if (gateActive() && !ruleContext && !/^\/id\b/.test(text)) {
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
      userId,
      chatId,
      chatType: message.chat.type,
      text,
      ...(message.contact ? { contact: message.contact } : {}),
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

  if (text && sensitiveOtpInput(text)) {
    const reply = message.chat.type === "private"
      ? locale === "en" ? "Start by saying “I want to log in” before sending a phone number or SMS code." : "پیش از فرستادن شماره یا کد پیامک، بنویس «می‌خواهم لاگین کنم»."
      : PRIVATE_LOGIN_ONLY[locale];
    await replyText(chatId, reply, { replyToMessageId: message.message_id });
    return { handled: true, chatId, status: "otp-login-required" };
  }

  if (!text) {
    // A shared contact carries no text. If the gate is off, a contact on its own
    // is still worth taking rather than answering "I only read text".
    if (message.contact?.phone_number) {
      const check = normalizeIranPhone(message.contact.phone_number);
      if (check.ok && (await setChatPhone(userId, check.normalized))) {
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
    resetConversation(await sessionIdFor(userId));
    await replyText(chatId, CLEARED[locale]);
    logInfo("telegram.clear", { chatId });
    return { handled: true, chatId, status: "cleared" };
  }

  if (/^\/id\b/.test(text)) {
    // Both, and labelled: the chat id is what TELEGRAM_ALLOWED_CHAT_IDS takes,
    // the user id is what settings are stored under. In a private chat they are
    // the same number, in a group they are not.
    await replyText(
      chatId,
      locale === "en"
        ? `Your user id: ${userId}\nThis chat id: ${chatId}`
        : `شناسهٔ کاربری تو: ${userId}\nشناسهٔ این گفت‌وگو: ${chatId}\n` +
            `برای TELEGRAM_ALLOWED_CHAT_IDS شناسهٔ گفت‌وگو را بگذار.`,
    );
    return { handled: true, chatId, status: "id" };
  }

  return await processTextMessage({ chatId, userId, text, locale, sessionId: await sessionIdFor(userId), ruleContext, replyToMessageId: message.message_id });
}
