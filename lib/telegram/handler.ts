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
import { pickArray } from "@/lib/bot/explainer";
import { getFeature } from "@/lib/features/manifest";
import { logInfo, logWarn } from "@/lib/log";
import { truncateAtSentence } from "@/lib/text";
import { prefetchPredictedActions, prefetchMenuActions } from "@/lib/bot/cache";
import { getActiveEdit } from "@/lib/bot/session";
import { getEditableFields } from "@/lib/bot/editing";
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
  popPendingText,
  setPending,
  verifyContact,
} from "@/lib/telegram/identity";
import { defaultTip, suggestNext, tipLine, type Suggestion } from "@/lib/telegram/suggest";

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
    "همکار گرامی، جهت احراز هویت پرسنل کلینیک لطفاً روی دکمهٔ «📱 ارسال شمارهٔ من» ضربه بزنید. 🔐",
    "",
    "شمارهٔ تلگرام شما با فهرست کارکنان سامانهٔ کلینیک بررسی می‌شود و پس از تأیید، بدون نیاز به رمز عبور وارد خواهید شد.",
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
      "امکان احراز هویت در سامانه فراهم نشد. 🙏",
      "",
      `علت: ${reason}`,
      "",
      "راهنما:",
      "• بررسی کنید این شماره تماس در سامانهٔ پرسنل کلینیک ثبت و فعال باشد.",
      "• جهت ورود حتماً از دکمهٔ «ارسال شمارهٔ من» استفاده فرمایید.",
      "• در صورت نیاز، با مدیر سیستم جهت فعال‌سازی حساب کاربری هماهنگ کنید.",
    ].join("\n"),
  en: (reason) =>
    ["I could not verify your number. 🙏", "", `Reason: ${reason}`, "", "Check that your number is an active user in the clinic admin, then try again."].join("\n"),
};

const REASON_FA: Record<string, string> = {
  "not-own-contact": "شمارهٔ ارسالی متعلق به این حساب تلگرام نیست. لطفاً فقط از دکمهٔ «ارسال شمارهٔ من» استفاده کنید.",
  "bad-phone": "شمارهٔ ارسالی معتبر نیست.",
  "foreign-number": "فعلاً فقط شماره‌های ایران (‎+98) در سامانه پذیرفته می‌شوند.",
  "phone-not-registered": "این شماره در فهرست کارکنان کلینیک ثبت نشده است.",
  "user-inactive": "حساب کاربری شما در سامانهٔ کلینیک غیرفعال است.",
  "user-banned": "حساب کاربری مسدود شده است.",
  "lookup-forbidden": "حساب ربات مجوز دسترسی به فهرست کاربران (users.read) را ندارد؛ با مدیر سیستم هماهنگ کنید.",
};

function reasonFa(reason: string | undefined): string {
  if (!reason) return "نامشخص";
  if (reason.startsWith("lookup-failed")) return "نتوانستم فهرست کاربران را از سایت بخوانم؛ یک‌بار دیگر تلاش کن.";
  return REASON_FA[reason] ?? "دلیل نامشخص (مدیر می‌تواند لاگ سرور را ببیند).";
}

type GateResult =
  | { consumed: false }
  | { consumed: true; executeText?: string };

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
}): Promise<GateResult> {
  const { requireIdentity } = getConfig().telegram;

  // /whoami and /logout work regardless of the flag.
  if (/^\/whoami\b/.test(input.text)) {
    const identity = getIdentity(input.chatId);
    await sendMessage({
      chatId: input.chatId,
      text: identity
        ? `وضعیت ورود: ${identity.status === "verified" ? "✅ تأییدشده" : "⛔ تأییدنشده"}\n${identitySummary(identity)}`
        : "هنوز وارد نشده‌اید. لطفاً دکمهٔ «📱 ارسال شمارهٔ من» را بزنید.",
      removeKeyboard: true,
    });
    return { consumed: true };
  }

  if (/^\/logout\b/.test(input.text)) {
    clearIdentity(input.chatId);
    await sendMessage({
      chatId: input.chatId,
      text: input.locale === "en" ? "You are signed out." : "از حساب کاربری خارج شدید. هر زمان مایل بودید، می‌توانید مجدداً شماره‌تان را ارسال کنید.",
      removeKeyboard: true,
    });
    return { consumed: true };
  }

  if (!requireIdentity || isVerified(input.chatId)) return { consumed: false };

  // Already waiting on a contact share (or a previous check) → don't nag again.
  // The user asked: "keep asking the phone number check only once".
  const existing = input.contact ? undefined : getIdentity(input.chatId);
  if (existing?.status === "pending") {
    if (input.text && !input.text.startsWith("/")) {
      setPending(input.chatId, "awaiting-contact", input.text);
    }
    await sendMessage({
      chatId: input.chatId,
      text:
        input.locale === "en"
          ? "Please share your phone number using the button below to sign in."
          : "هنوز شماره‌تان را ارسال نکرده‌اید؛ لطفاً دکمهٔ «📱 ارسال شمارهٔ من» در پایین صفحه را بزنید تا وارد شوید.",
    });
    return { consumed: true };
  }

  // A shared contact → try to verify.
  if (input.contact) {
    const pendingText = popPendingText(input.chatId);
    const identity = await verifyContact({ chatId: input.chatId, fromId: input.fromId, contact: input.contact });
    if (identity.status === "verified") {
      if (!pendingText) {
        void prefetchMenuActions("main");
        await sendMessage({
          chatId: input.chatId,
          text: `خوش آمدید ${identity.fullName ?? ""}! ✅\n${identitySummary(identity)}\n\nمی‌توانید درخواست خود را بفرمایید یا از منو انتخاب کنید.`,
          keyboard: menuKeyboard(input.locale),
          removeKeyboard: true,
        });
      } else {
        await sendMessage({
          chatId: input.chatId,
          text: `خوش آمدید ${identity.fullName ?? ""}! ✅\n${identitySummary(identity)}`,
          removeKeyboard: true,
        });
      }
      return { consumed: true, executeText: pendingText };
    } else {
      await sendMessage({
        chatId: input.chatId,
        text: LOGIN_DENIED[input.locale](reasonFa(identity.reason)),
        keyboard: contactRequestKeyboard(input.locale),
      });
      return { consumed: true };
    }
  }

  // Anything else → ask for the phone, by opening the panel first.
  const pendingText = input.text && !input.text.startsWith("/") ? input.text : undefined;
  setPending(input.chatId, "awaiting-contact", pendingText);
  await sendMessage({
    chatId: input.chatId,
    text: LOGIN_PROMPT[input.locale],
    keyboard: contactRequestKeyboard(input.locale),
  });
  logInfo("identity.prompted", { chatId: input.chatId });
  return { consumed: true };
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
    `سلام${botName ? ` ${botName}` : ""}! وقت بخیر 👋`,
    "من دستیار کلینیک هستم و برای بررسی و مدیریت نوبت‌ها، خدمات، ساعات کاری، پرسنل و تنظیمات در خدمت شما هستم.",
    "",
    "می‌توانید درخواست خود را محاوره‌ای بنویسید یا از گزینه‌های زیر استفاده کنید:",
    "• نوبت‌های امروز رو نشون بده",
    "• ساعت کاری شنبه‌ها چیه؟",
    "• خدمات فعال رو لیست کن",
    "",
    "پاسخ‌ها سریع و مشخص ارائه می‌شوند و هیچ تغییری بدون تأیید شما ثبت نمی‌شود.",
    "می‌توانید از منو و دکمه‌های زیر هم استفاده کنید.",
  ].join("\n");
}

function statusLine(result: ChatResult, locale: Locale): string {
  const ms = result.trace.ms;
  const engine = result.trace.planner === "ai" ? "🧠" : "⚙️";
  const fast = result.trace.timeTravel ? " ⚡️" : result.trace.fromCache ? " 📦" : "";
  if (locale === "en") return `\n\n${engine}${fast} ${result.actionId ?? "chat"} · ${ms}ms`;
  return `\n\n${engine}${fast} ${result.actionId ?? "گفت‌وگو"} · ${ms} میلی‌ثانیه`;
}

function errorMessage(locale: Locale): string {
  return locale === "en"
    ? "Something went wrong on my side. Please try again in a moment."
    : "یک مشکل از سمت من پیش آمد. یک لحظه بعد دوباره امتحان کن. 🙏";
}

/** The one place that decides which keyboard follows which answer. */
async function keyboardFor(
  result: ChatResult,
  input: { userMessage: string; locale: Locale; sessionId?: string; fast?: boolean },
): Promise<{ keyboard: InlineKeyboard | undefined; tip: string; engine: "ai" | "fallback" | "none"; count: number }> {
  // A write is waiting: the only sensible buttons are yes/no.
  if (result.status === "needs_confirmation" && result.confirmation?.token) {
    return { keyboard: confirmationKeyboard(result.confirmation.token, input.locale), tip: "", engine: "none", count: 2 };
  }

  // Active step-by-step editing controls
  if (input.sessionId) {
    const activeEdit = getActiveEdit(input.sessionId);
    if (activeEdit) {
      const editButtons: Suggestion[] = [];
      const fields = getEditableFields(activeEdit.featureId);
      const currentDef = fields.find((f) => f.key === activeEdit.currentField);
      if (currentDef?.type === "boolean") {
        editButtons.push({ label: "✅ فعال" }, { label: "⛔ غیرفعال" });
      }
      editButtons.push({ label: "⏭️ رد این مرحله" }, { label: "❌ لغو ویرایش" });
      return {
        keyboard: suggestionsKeyboard(editButtons, input.locale),
        tip: "می‌توانید مقدار جدید را تایپ کنید یا از دکمه‌های بالا استفاده فرمایید.",
        engine: "none",
        count: editButtons.length,
      };
    }
  }

  const suggestion = await suggestNext({
    userMessage: input.userMessage,
    actionId: result.actionId,
    status: result.status,
    replyPreview: result.reply,
    locale: input.locale,
    hadError: result.status === "error",
    fast: input.fast,
  });

  const list = [...suggestion.suggestions];

  // If this was a list action and has multiple pages, add step-by-step pagination controls
  if (result.actionId?.endsWith(".list") && result.result?.data) {
    const listData = pickArray(result.result.data);
    if (listData && listData.total && listData.total > listData.perPage) {
      const currentPage = listData.page ?? 1;
      const totalPages = Math.ceil(listData.total / listData.perPage);
      const paginationButtons: Suggestion[] = [];

      if (currentPage < totalPages) {
        paginationButtons.push({
          label: input.locale === "en" ? `📄 Next step (${currentPage + 1}/${totalPages}) ➡️` : `📄 گام بعد: صفحهٔ ${currentPage + 1} از ${totalPages} ➡️`,
          page: { actionId: result.actionId, page: currentPage + 1 },
        });
      }
      if (currentPage > 1) {
        paginationButtons.push({
          label: input.locale === "en" ? `⬅️ Prev step (${currentPage - 1}/${totalPages})` : `⬅️ گام قبل: صفحهٔ ${currentPage - 1} از ${totalPages}`,
          page: { actionId: result.actionId, page: currentPage - 1 },
        });
      }

      list.unshift(...paginationButtons);
    }
  }

  // When the bot is asking questions, fewer buttons = less confusion.
  const finalList = result.status === "needs_info" ? list.slice(0, 3) : list.slice(0, 5);

  // Time Travel predictive prefetching: anticipate next clicks and warm the cache
  const predictions: Array<{
    actionId: string;
    query?: Record<string, string | number | boolean | undefined>;
    pathParams?: Record<string, string>;
  }> = [];

  if (result.actionId?.endsWith(".list") && result.result?.data) {
    const listData = pickArray(result.result.data);
    if (listData && listData.total && listData.total > listData.perPage) {
      const currentPage = listData.page ?? 1;
      const totalPages = Math.ceil(listData.total / listData.perPage);
      if (currentPage < totalPages) {
        predictions.push({
          actionId: result.actionId,
          query: { page: currentPage + 1 },
        });
      }
    }
  }

  for (const s of finalList) {
    if (s.actionId) {
      predictions.push({ actionId: s.actionId });
    }
    if (s.page) {
      predictions.push({ actionId: s.page.actionId, query: { page: s.page.page } });
    }
  }

  if (predictions.length > 0) {
    void prefetchPredictedActions(predictions);
  }

  return {
    keyboard: suggestionsKeyboard(finalList, input.locale),
    tip: suggestion.tip || defaultTip(result.actionId),
    engine: suggestion.engine,
    count: finalList.length,
  };
}

async function processTextMessage(input: {
  chatId: number;
  text: string;
  locale: Locale;
  replyToMessageId?: number;
}): Promise<BridgeOutcome> {
  const { chatId, text, locale, replyToMessageId } = input;
  sendTyping(chatId);

  let result: ChatResult;
  try {
    result = await handleChat({ message: text, sessionId: sessionIdFor(chatId), locale });
  } catch (error) {
    logWarn("telegram.chat_failed", { chatId, message: error instanceof Error ? error.message : "unknown" });
    await sendMessage({ chatId, text: errorMessage(locale), keyboard: menuKeyboard(locale) });
    return { handled: true, chatId, status: "error", reason: "exception" };
  }

  const ui = await keyboardFor(result, { userMessage: text, locale, sessionId: sessionIdFor(chatId) });
  await sendMessage({
    chatId,
    text: truncateAtSentence(`${result.reply}${ui.tip ? tipLine(ui.tip) : ""}`, MAX_TEXT),
    keyboard: ui.keyboard,
    ...(replyToMessageId ? { replyToMessageId } : {}),
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
      void answerCallbackQuery({ callbackQueryId: query.id });
      void prefetchMenuActions("main");
      await sendMessage({
        chatId,
        text: locale === "en" ? "What should I work on?" : "لطفاً بخش مورد نظر خود را انتخاب کنید: 👇",
        keyboard: menuKeyboard(locale),
      });
      return { handled: true, chatId, status: "menu" };
    }

    if (parsed.kind === "help") {
      void answerCallbackQuery({ callbackQueryId: query.id });
      await sendMessage({ chatId, text: featuresAnswer(locale), keyboard: menuKeyboard(locale) });
      return { handled: true, chatId, status: "help" };
    }

    if (parsed.kind === "feature") {
      const feature = getFeature(parsed.featureId);
      void answerCallbackQuery({ callbackQueryId: query.id });
      if (!feature) {
        await sendMessage({ chatId, text: locale === "en" ? "Unknown section." : "این بخش را نمی‌شناسم.", keyboard: menuKeyboard(locale) });
        return { handled: true, chatId, status: "unknown-feature" };
      }
      void prefetchMenuActions(feature.id);
      await sendMessage({
        chatId,
        text: `${feature.titleFa}\n\n${feature.kid}`,
        keyboard: featureKeyboard(feature.id, locale) ?? menuKeyboard(locale),
      });
      return { handled: true, chatId, status: "feature" };
    }

    if (parsed.kind === "text") {
      void answerCallbackQuery({ callbackQueryId: query.id, text: parsed.text });
      return await processTextMessage({ chatId, text: parsed.text, locale });
    }

    if (parsed.kind === "page") {
      void answerCallbackQuery({ callbackQueryId: query.id, text: `صفحهٔ ${parsed.page}` });
      sendTyping(chatId);

      let result: ChatResult;
      try {
        result = await handleChat({
          message: `صفحه ${parsed.page}`,
          sessionId,
          locale,
          direct: { actionId: parsed.actionId, params: { page: parsed.page } },
        });
      } catch (error) {
        logWarn("telegram.handle_failed", { message: error instanceof Error ? error.message : "unknown" });
        await sendMessage({ chatId, text: errorMessage(locale), keyboard: menuKeyboard(locale) });
        return { handled: true, chatId, status: "error", reason: "exception" };
      }

      const ui = await keyboardFor(result, { userMessage: `صفحه ${parsed.page}`, locale, sessionId, fast: true });
      await sendMessage({
        chatId,
        text: truncateAtSentence(`${result.reply}${ui.tip ? tipLine(ui.tip) : ""}`, MAX_TEXT),
        keyboard: ui.keyboard,
      });

      logInfo("telegram.page", { chatId, actionId: result.actionId, page: parsed.page, status: result.status });
      return { handled: true, chatId, status: result.status, actionId: result.actionId, suggestions: ui.count };
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

      void answerCallbackQuery({ callbackQueryId: query.id, text: label });
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

      const ui = await keyboardFor(result, { userMessage: label, locale, sessionId, fast: true });
      await sendMessage({
        chatId,
        text: truncateAtSentence(`${result.reply}${ui.tip ? tipLine(ui.tip) : ""}`, MAX_TEXT),
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
  const gate = await identityGate({
    chatId,
    fromId: message.from?.id ?? 0,
    text,
    contact: message.contact,
    locale,
  });
  if (gate.consumed) {
    if (gate.executeText) {
      return await processTextMessage({
        chatId,
        text: gate.executeText,
        locale,
      });
    }
    return { handled: true, chatId, status: "identity" };
  }

  if (!text) {
    await sendMessage({ chatId, text: locale === "en" ? "I can only read text for now." : "فعلاً فقط پیام متنی را می‌خوانم. ✍️" });
    return { handled: true, chatId, status: "unsupported" };
  }

  const firstName = message.from?.first_name;

  if (/^\/(start|menu)\b/.test(text)) {
    void prefetchMenuActions("main");
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

  return await processTextMessage({
    chatId,
    text,
    locale,
    replyToMessageId: message.message_id,
  });
}
