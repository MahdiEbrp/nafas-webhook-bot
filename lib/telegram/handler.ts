/**
 * TELEGRAM BRIDGE
 *
 * Incoming Telegram update → existing chat pipeline → Persian answer + AI
 * buttons. Nothing new is invented here: the bridge is a thin skin over
 * `handleChat`, so permissions, confirmations and the action manifest all keep
 * working exactly as they do over HTTP.
 *
 * Flow:
 *   /start            → welcome + menu buttons
 *   plain text        → handleChat(message)  → answer + suggested buttons
 *   button a:<action> → handleChat(direct)   → answer + suggested buttons
 *   button c:/x:<tok> → handleChat(confirm)  → write happens or is cancelled
 *   button m / f:     → pure navigation, no AI, no HTTP
 */

import { getConfig, type Locale } from "@/lib/config";
import { handleChat, type ChatResult } from "@/lib/bot";
import { featuresAnswer } from "@/lib/bot/features-answer";
import { getFeature } from "@/lib/features/manifest";
import { logInfo, logWarn } from "@/lib/log";
import {
  answerCallbackQuery,
  sendMessage,
  sendTyping,
  type InlineKeyboard,
  type TelegramUpdate,
} from "@/lib/telegram/api";
import {
  confirmationKeyboard,
  contactRequestKeyboard,
  featureKeyboard,
  menuKeyboard,
  parseCallback,
  suggestionsKeyboard,
  actionLabel,
} from "@/lib/telegram/keyboard";
import {
  clearIdentity,
  getIdentity,
  identitySummary,
  isVerified,
  setPending,
  verifyContact,
} from "@/lib/telegram/identity";
import { suggestNext, tipLine, type Suggestion } from "@/lib/telegram/suggest";

export type BridgeOutcome = {
  handled: boolean;
  reason?: string;
  chatId?: number;
  status?: string;
  actionId?: string | null;
  suggestions?: number;
  text?: string;
};

const MAX_TEXT = 3500;

function isAllowed(chatId: number): boolean {
  const { allowedChatIds } = getConfig().telegram;
  if (allowedChatIds.length === 0) return true; // locked-down deployments should set this
  return allowedChatIds.includes(chatId);
}

function sessionIdFor(chatId: number): string {
  return `tg-${chatId}`;
}

const LOGIN_PROMPT: Record<"fa" | "en", string> = {
  fa: [
    "برای اینکه مطمئن شوم واقعاً از کارمندان کلینیک هستی، یک کار کوچک لازم است. 🔐",
    "",
    "دکمهٔ «📱 ارسال شمارهٔ من» را بزن. تلگرام شماره‌ای را می‌فرستد که خودش قبلاً با پیامک تأییدش کرده — یعنی همان شمارهٔ اصلی تو.",
    "",
    "بعد از آن، شماره‌ات را در فهرست کارمندان سایت کلینیک نگاه می‌کنم. اگر آنجا باشی، وارد می‌شوی.",
    "هیچ رمزی لازم نیست.",
  ].join("\n"),
  en: [
    "To confirm you are clinic staff, one small step is needed. 🔐",
    "",
    "Tap “📱 Share my phone number”. Telegram sends the number it already verified by SMS — your own number.",
    "",
    "I then look that number up in the clinic's staff list. No password needed.",
  ].join("\n"),
};

const LOGIN_DENIED: Record<"fa" | "en", (reason: string) => string> = {
  fa: (reason) =>
    [
      "نتوانستم شماره‌ات را قبول کنم. 🙏",
      "",
      `دلیل: ${reason}`,
      "",
      "چه کار کنی:",
      "• مطمئن شو شماره‌ات در بخش «کاربران» سایت کلینیک ثبت شده و فعال است.",
      "• دوباره دکمهٔ ارسال شماره را بزن (بعضی‌ها شمارهٔ دیگری را فوروارد می‌کنند؛ باید شمارهٔ خودت باشد).",
      "• اگر تازه اضافه شده‌ای، مدیر باید اول حسابت را فعال کند.",
    ].join("\n"),
  en: (reason) =>
    ["I could not verify your number. 🙏", "", `Reason: ${reason}`, "", "Check that your number is an active user in the clinic admin, then try again."].join("\n"),
};

const REASON_FA: Record<string, string> = {
  "not-own-contact": "این شمارهٔ خودت نبود. حتماً از دکمهٔ «ارسال شمارهٔ من» استفاده کن، نه فوروارد کردن کارت کسی دیگر.",
  "bad-phone": "شمارهٔ ارسالی معتبر نبود.",
  "foreign-number": "این شماره ایرانی نیست. فعلاً فقط شماره‌های ایران (‎+98) پذیرفته می‌شوند.",
  "phone-not-registered": "این شماره در فهرست کاربران کلینیک نیست.",
  "user-inactive": "حساب تو غیرفعال است.",
  "user-banned": "حساب تو مسدود شده است.",
  "lookup-forbidden": "ربات اجازهٔ خواندن فهرست کاربران را ندارد؛ به مدیر بگو دسترسی users.read را بدهد.",
};

function reasonFa(reason: string | undefined): string {
  if (!reason) return "نامشخص";
  if (reason.startsWith("lookup-failed")) return "نتوانستم فهرست کاربران را از سایت بخوانم؛ یک‌بار دیگر تلاش کن.";
  return REASON_FA[reason] ?? "دلیل نامشخص (مدیر می‌تواند لاگ سرور را ببیند).";
}

/**
 * Returns true when the message was consumed by the identity gate.
 * Skipped entirely unless TELEGRAM_REQUIRE_IDENTITY=true.
 */
async function identityGate(input: {
  chatId: number;
  fromId: number;
  text: string;
  contact?: { phone_number?: string; first_name?: string; user_id?: number };
  locale: Locale;
}): Promise<boolean> {
  const { requireIdentity } = getConfig().telegram;

  // /whoami and /logout work regardless of the flag.
  if (/^\/whoami\b/.test(input.text)) {
    const identity = getIdentity(input.chatId);
    await sendMessage({
      chatId: input.chatId,
      text: identity
        ? `وضعیت ورود: ${identity.status === "verified" ? "✅ تأییدشده" : "⛔ تأییدنشده"}\n${identitySummary(identity)}`
        : "هنوز وارد نشده‌ای. دکمهٔ «📱 ارسال شمارهٔ من» را بزن.",
      removeKeyboard: true,
    });
    return true;
  }

  if (/^\/logout\b/.test(input.text)) {
    clearIdentity(input.chatId);
    await sendMessage({
      chatId: input.chatId,
      text: input.locale === "en" ? "You are signed out." : "از حساب خارج شدی. هر وقت خواستی دوباره شماره‌ات را بفرست.",
      removeKeyboard: true,
    });
    return true;
  }

  if (!requireIdentity || isVerified(input.chatId)) return false;

  // Already waiting on a contact share (or a previous check) → don't nag again.
  // The user asked: "keep asking the phone number check only once".
  const existing = input.contact ? undefined : getIdentity(input.chatId);
  if (existing?.status === "pending") {
    await sendMessage({
      chatId: input.chatId,
      text:
        input.locale === "en"
          ? "Your number was already sent — I’m checking it now."
          : "شمارهٔ تو از قبل فرستادتی و در حال بررسی است.",
    });
    return true;
  }

  // A shared contact → try to verify.
  if (input.contact) {
    const identity = await verifyContact({ chatId: input.chatId, fromId: input.fromId, contact: input.contact });
    if (identity.status === "verified") {
      await sendMessage({
        chatId: input.chatId,
        text: `خوش آمدی ${identity.fullName ?? ""}! ✅\n${identitySummary(identity)}\n\nحالا هر چه می‌خواهی بپرس، یا از منو انتخاب کن.`,
        keyboard: menuKeyboard(input.locale),
        removeKeyboard: true,
      });
    } else {
      await sendMessage({
        chatId: input.chatId,
        text: LOGIN_DENIED[input.locale](reasonFa(identity.reason)),
        keyboard: contactRequestKeyboard(input.locale),
      });
    }
    return true;
  }

  // Anything else → ask for the phone, by opening the panel first.
  setPending(input.chatId, "awaiting-contact");
  await sendMessage({
    chatId: input.chatId,
    text: LOGIN_PROMPT[input.locale],
    keyboard: contactRequestKeyboard(input.locale),
  });
  logInfo("identity.prompted", { chatId: input.chatId });
  return true;
}

function welcomeText(locale: Locale, botName?: string): string {
  if (locale === "en") {
    return [
      `Hi${botName ? ` ${botName}` : ""}! I am the clinic assistant. 👋`,
      "",
      "Tell me what you need in plain words — for example:",
      "• show today's bookings",
      "• what are Saturday's working hours?",
      "• list active services",
      "",
      "I always explain things simply, and I never change anything without your OK.",
      "Use the buttons below, or just type.",
    ].join("\n");
  }

  return [
    `سلام${botName ? ` ${botName}` : ""}! 👋`,
    "من دستیار کلینیک هستم.",
    "",
    "هر چه می‌خواهی با زبان خودت بنویس؛ مثلاً:",
    "• نوبت‌های امروز رو نشون بده",
    "• ساعت کاری شنبه‌ها چیه؟",
    "• خدمات فعال رو لیست کن",
    "",
    "همه‌چیز را ساده توضیح می‌دهم و هیچ‌وقت بدون اجازهٔ تو چیزی را تغییر نمی‌دهم.",
    "از دکمه‌های زیر استفاده کن، یا خودت بنویس.",
  ].join("\n");
}

function statusLine(result: ChatResult, locale: Locale): string {
  const ms = result.trace.ms;
  const engine = result.trace.planner === "ai" ? "🧠" : "⚙️";
  if (locale === "en") return `\n\n${engine} ${result.actionId ?? "chat"} · ${ms}ms`;
  return `\n\n${engine} ${result.actionId ?? "گفت‌وگو"} · ${ms} میلی‌ثانیه`;
}

function errorMessage(locale: Locale): string {
  return locale === "en"
    ? "Something went wrong on my side. Please try again in a moment."
    : "یک مشکل از سمت من پیش آمد. یک لحظه بعد دوباره امتحان کن. 🙏";
}

/** The one place that decides which keyboard follows which answer. */
async function keyboardFor(
  result: ChatResult,
  input: { userMessage: string; locale: Locale },
): Promise<{ keyboard: InlineKeyboard | undefined; tip: string; engine: "ai" | "fallback" | "none"; count: number }> {
  // A write is waiting: the only sensible buttons are yes/no.
  if (result.status === "needs_confirmation" && result.confirmation?.token) {
    return { keyboard: confirmationKeyboard(result.confirmation.token, input.locale), tip: "", engine: "none", count: 2 };
  }

  const suggestion = await suggestNext({
    userMessage: input.userMessage,
    actionId: result.actionId,
    status: result.status,
    replyPreview: result.reply,
    locale: input.locale,
    hadError: result.status === "error",
  });

  // When the bot is asking questions, fewer buttons = less confusion.
  const list = result.status === "needs_info" ? suggestion.suggestions.slice(0, 3) : suggestion.suggestions;

  return {
    keyboard: suggestionsKeyboard(list, input.locale),
    tip: suggestion.tip,
    engine: suggestion.engine,
    count: list.length,
  };
}

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<BridgeOutcome> {
  const { defaultLocale } = getConfig();
  const locale: Locale = defaultLocale;

  /* ── 1. Button presses ─────────────────────────────────────────────── */
  if (update.callback_query) {
    const query = update.callback_query;
    const chatId = query.message?.chat.id;
    if (!chatId) return { handled: false, reason: "callback without chat" };
    if (!isAllowed(chatId)) return { handled: false, reason: "chat not allowed", chatId };

    const parsed = parseCallback(query.data ?? "");
    const sessionId = sessionIdFor(chatId);

    // Pure navigation: no AI, no HTTP, instant.
    if (parsed.kind === "menu") {
      await answerCallbackQuery({ callbackQueryId: query.id });
      await sendMessage({
        chatId,
        text: locale === "en" ? "What should I work on?" : "روی کدام بخش کار کنم؟ 👇",
        keyboard: menuKeyboard(locale),
      });
      return { handled: true, chatId, status: "menu" };
    }

    if (parsed.kind === "help") {
      await answerCallbackQuery({ callbackQueryId: query.id });
      await sendMessage({ chatId, text: featuresAnswer(locale), keyboard: menuKeyboard(locale) });
      return { handled: true, chatId, status: "help" };
    }

    if (parsed.kind === "feature") {
      const feature = getFeature(parsed.featureId);
      await answerCallbackQuery({ callbackQueryId: query.id });
      if (!feature) {
        await sendMessage({ chatId, text: locale === "en" ? "Unknown section." : "این بخش را نمی‌شناسم.", keyboard: menuKeyboard(locale) });
        return { handled: true, chatId, status: "unknown-feature" };
      }
      await sendMessage({
        chatId,
        text: `${feature.titleFa}\n\n${feature.kid}`,
        keyboard: featureKeyboard(feature.id, locale) ?? menuKeyboard(locale),
      });
      return { handled: true, chatId, status: "feature" };
    }

    if (parsed.kind === "unknown" || parsed.kind === "action" || parsed.kind === "confirm") {
      const label =
        parsed.kind === "action"
          ? actionLabel(parsed.actionId, locale)
          : parsed.kind === "confirm"
            ? parsed.approve
              ? "تأیید"
              : "لغو"
            : "دکمهٔ ناشناس";

      await answerCallbackQuery({ callbackQueryId: query.id, text: label });
      sendTyping(chatId);

      let result: ChatResult;
      try {
        result =
          parsed.kind === "confirm"
            ? await handleChat({ message: parsed.approve ? "تأیید می‌کنم" : "لغو", sessionId, locale, confirm: { token: parsed.token, approve: parsed.approve } })
            : parsed.kind === "action"
              ? await handleChat({ message: label, sessionId, locale, direct: { actionId: parsed.actionId } })
              : await handleChat({ message: parsed.raw, sessionId, locale });
      } catch (error) {
        logWarn("telegram.handle_failed", { message: error instanceof Error ? error.message : "unknown" });
        await sendMessage({ chatId, text: errorMessage(locale), keyboard: menuKeyboard(locale) });
        return { handled: true, chatId, status: "error", reason: "exception" };
      }

      const ui = await keyboardFor(result, { userMessage: label, locale });
      await sendMessage({
        chatId,
        text: `${result.reply}${ui.tip ? tipLine(ui.tip) : ""}`.slice(0, MAX_TEXT),
        keyboard: ui.keyboard,
      });

      logInfo("telegram.action", { chatId, actionId: result.actionId, status: result.status, suggestions: ui.count });
      return { handled: true, chatId, status: result.status, actionId: result.actionId, suggestions: ui.count };
    }

    return { handled: false, reason: "unreachable" };
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

  // Identity first: a shared contact arrives as a message *without* text, and an
  // unverified chat must not reach the clinic at all.
  const consumed = await identityGate({
    chatId,
    fromId: message.from?.id ?? 0,
    text,
    contact: message.contact,
    locale,
  });
  if (consumed) return { handled: true, chatId, status: "identity" };

  if (!text) {
    await sendMessage({ chatId, text: locale === "en" ? "I can only read text for now." : "فعلاً فقط پیام متنی را می‌خوانم. ✍️" });
    return { handled: true, chatId, status: "unsupported" };
  }

  const firstName = message.from?.first_name;

  if (/^\/(start|menu)\b/.test(text)) {
    await sendMessage({
      chatId,
      text: welcomeText(locale, firstName),
      keyboard: menuKeyboard(locale),
      replyToMessageId: message.message_id,
    });
    logInfo("telegram.start", { chatId });
    return { handled: true, chatId, status: "start" };
  }

  if (/^\/(help|features)\b/.test(text)) {
    await sendMessage({ chatId, text: featuresAnswer(locale), keyboard: menuKeyboard(locale) });
    return { handled: true, chatId, status: "help" };
  }

  if (/^\/id\b/.test(text)) {
    await sendMessage({
      chatId,
      text: locale === "en" ? `Your chat id: ${chatId}` : `شناسهٔ گفت‌وگوی تو: ${chatId}\nاین را در TELEGRAM_ALLOWED_CHAT_IDS بگذار تا فقط تو دسترسی داشته باشی.`,
    });
    return { handled: true, chatId, status: "id" };
  }

  sendTyping(chatId);

  let result: ChatResult;
  try {
    result = await handleChat({ message: text, sessionId: sessionIdFor(chatId), locale });
  } catch (error) {
    logWarn("telegram.chat_failed", { chatId, message: error instanceof Error ? error.message : "unknown" });
    await sendMessage({ chatId, text: errorMessage(locale), keyboard: menuKeyboard(locale) });
    return { handled: true, chatId, status: "error", reason: "exception" };
  }

  const ui = await keyboardFor(result, { userMessage: text, locale });
  await sendMessage({
    chatId,
    text: `${result.reply}${ui.tip ? tipLine(ui.tip) : ""}`.slice(0, MAX_TEXT),
    keyboard: ui.keyboard,
    replyToMessageId: message.message_id,
  });

  logInfo("telegram.message", {
    chatId,
    status: result.status,
    actionId: result.actionId,
    planner: result.trace.planner,
    suggestions: ui.count,
  });

  return {
    handled: true,
    chatId,
    status: result.status,
    actionId: result.actionId,
    suggestions: ui.count,
    text: result.reply,
  };
}
