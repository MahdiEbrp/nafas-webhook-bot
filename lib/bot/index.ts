/**
 * The whole bot: one public function, `handleChat`.
 *
 * Three layers, in the order they run:
 *
 *   1. IDENTITY  «تو کی هستی؟»            → answered by code, always the same
 *   2. CALENDAR  «امروز چندمه؟», «۱۲ مرداد ۱۴۰۳ چه روزی بود؟»
 *                                           → the date engine computes, the
 *                                             model only words the answer
 *   3. CHAT      everything else           → free conversation
 *
 * The reason layers 1 and 2 are code and not prompting: a small free model
 * invents dates and wobbles on who it is. Neither is acceptable. The model is
 * still the one that *speaks* — it gets the computed facts and phrases them —
 * but if it fails or changes a number, the deterministic text is what the user
 * sees. A correct answer is never lost because the model had a bad day.
 */

import { getConfig, type Locale } from "@/lib/config";
import { logInfo, logWarn } from "@/lib/log";
import { complete, type ChatMessage as ModelMessage } from "@/lib/openrouter/client";
import { normalize } from "@/lib/text";

import { identityAnswer, identityText, isIdentityQuestion } from "./identity";
import { capabilityAnswer, isCapabilityQuestion } from "@/lib/users/intent";
import { dateInstruction, systemPrompt } from "./prompt";
import { answerDateQuestion } from "@/lib/dates/intent";
import { nowFacts } from "@/lib/dates/engine";
import { clearSession, countMessages, getMessages, pushMessage } from "./session";

export type ChatInput = {
  message: string;
  sessionId: string;
  locale?: Locale;
};

export type ChatStatus = "answered" | "empty" | "error";

export type ChatResult = {
  status: ChatStatus;
  reply: string;
  /** which model in the chain actually answered, null when code answered */
  model: string | null;
  /** which layer produced the answer */
  layer: "identity" | "users" | "calendar" | "chat" | "none";
  /** date intent, when the calendar layer handled it */
  dateIntent?: string;
  /** true when the model garbled the facts and the deterministic text was used */
  fellBackToDeterministic?: boolean;
  ms: number;
  /** how many stored messages were sent as context (excludes this turn) */
  contextMessages: number;
  /** true when the model hit max_tokens and the answer may end mid-sentence */
  truncated: boolean;
};

const FALLBACK_FA = "الان یک مشکل کوچک پیش آمد و نتوانستم جواب بدهم. یک لحظهٔ دیگر دوباره بنویس. 🙏";
const FALLBACK_EN = "Something went wrong on my side and I could not answer. Please try again in a moment. 🙏";

const NO_KEY_FA = "کلید هوش مصنوعی تنظیم نشده، پس فعلاً نمی‌توانم فکر کنم. مدیر باید OPENROUTER_API_KEY را بگذارد.";
const NO_KEY_EN = "The AI key is not configured, so I cannot think yet. An admin needs to set OPENROUTER_API_KEY.";

/** Longest message we are willing to feed the model. Keeps free quotas sane. */
const MAX_INPUT_CHARS = 4000;

/** The clock line that goes into every system prompt. */
function clockLine(now: Date, locale: Locale): string {
  const facts = nowFacts(now);
  const view = facts.dates[0];
  if (!view) return "";
  return locale === "en"
    ? `${view.gregorianLong} · Jalali: ${view.jalaliLong} · Hijri: ${view.hijriLong ?? "—"} · ${facts.time} (${facts.zone})`
    : `${view.jalaliLong} · میلادی: ${view.gregorianLong} · قمری: ${view.hijriLong ?? "—"} · ساعت ${facts.time} ${facts.zone}`;
}

/**
 * The model may rephrase the facts but not reinvent them. If its answer does
 * not contain even one of the dates we computed, it drifted — say so, and let
 * the caller fall back.
 */
function mentionsComputedDate(reply: string, dates: Array<{ jalali: string; gregorian: string }>): boolean {
  if (dates.length === 0) return true;
  return dates.some((date) => reply.includes(date.jalali) || reply.includes(date.gregorian));
}

export async function handleChat(input: ChatInput): Promise<ChatResult> {
  const config = getConfig();
  const locale = input.locale ?? config.defaultLocale;
  const startedAt = Date.now();

  const message = normalize(input.message).slice(0, MAX_INPUT_CHARS);

  if (!message) {
    return {
      status: "empty",
      reply:
        locale === "en"
          ? "I did not get any text there — write something and I will answer."
          : "متنی به دستم نرسید؛ چیزی بنویس تا جواب بدهم. ✍️",
      model: null,
      layer: "none",
      ms: Date.now() - startedAt,
      contextMessages: 0,
      truncated: false,
    };
  }

  /* ── 1. Identity — never delegated ─────────────────────────────────── */
  if (isIdentityQuestion(message)) {
    const reply = /من|معرفی|who are you|what are you|introduce/.test(message) && message.length > 12
      ? identityAnswer()
      : identityText();

    pushMessage(input.sessionId, "user", message, config.history.maxMessages);
    pushMessage(input.sessionId, "assistant", reply, config.history.maxMessages);
    logInfo("chat.identity", { sessionId: input.sessionId });

    return {
      status: "answered",
      reply,
      model: null,
      layer: "identity",
      ms: Date.now() - startedAt,
      contextMessages: 0,
      truncated: false,
    };
  }

  /* ── 1b. Capabilities — read from the list, never paraphrased ────────
   *
   * «چه کارهایی بلدی؟» is answered from `lib/users/capabilities.ts` so the
   * bot cannot claim an ability the UserManager does not have, or forget one
   * it does. The list is the source of truth for both the code and the model.
   */
  if (isCapabilityQuestion(message)) {
    const reply = capabilityAnswer(locale);

    pushMessage(input.sessionId, "user", message, config.history.maxMessages);
    pushMessage(input.sessionId, "assistant", reply, config.history.maxMessages);
    logInfo("chat.capabilities", { sessionId: input.sessionId });

    return {
      status: "answered",
      reply,
      model: null,
      layer: "users",
      ms: Date.now() - startedAt,
      contextMessages: 0,
      truncated: false,
    };
  }

  /* ── 2. Calendar — computed here, worded by the model ──────────────── */
  const facts = answerDateQuestion(message);

  if (!config.openrouterApiKey) {
    // Without a model the date layer can still answer on its own.
    if (facts) {
      pushMessage(input.sessionId, "user", message, config.history.maxMessages);
      pushMessage(input.sessionId, "assistant", facts.summary, config.history.maxMessages);
      return {
        status: "answered",
        reply: facts.summary,
        model: null,
        layer: "calendar",
        dateIntent: facts.intent,
        fellBackToDeterministic: true,
        ms: Date.now() - startedAt,
        contextMessages: 0,
        truncated: false,
      };
    }
    logWarn("chat.no_api_key", { sessionId: input.sessionId });
    return {
      status: "error",
      reply: locale === "en" ? NO_KEY_EN : NO_KEY_FA,
      model: null,
      layer: "none",
      ms: Date.now() - startedAt,
      contextMessages: 0,
      truncated: false,
    };
  }

  const memory = getMessages(input.sessionId, config.history.ttlMs);
  const clock = clockLine(new Date(), locale);

  const messages: ModelMessage[] = [
    { role: "system", content: systemPrompt(locale, clock) },
    ...memory.map((turn) => ({ role: turn.role, content: turn.content })),
  ];

  if (facts) {
    messages.push({
      role: "system",
      content: dateInstruction(facts, locale),
    });
  }
  messages.push({ role: "user", content: message });

  try {
    const completion = await complete({
      messages,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    });

    let reply = completion.content.trim();
    let fellBack = false;

    // The model must not reinvent the numbers the engine computed.
    if (facts && !mentionsComputedDate(reply, facts.dates)) {
      logWarn("chat.date_garbled", { sessionId: input.sessionId, intent: facts.intent });
      reply = facts.summary;
      fellBack = true;
    }
    if (facts && !reply) {
      reply = facts.summary;
      fellBack = true;
    }

    pushMessage(input.sessionId, "user", message, config.history.maxMessages);
    pushMessage(input.sessionId, "assistant", reply, config.history.maxMessages);

    logInfo("chat.answered", {
      sessionId: input.sessionId,
      model: completion.model,
      layer: facts ? "calendar" : "chat",
      dateIntent: facts?.intent ?? null,
      attempts: completion.attempts.length,
      contextMessages: memory.length,
      truncated: completion.finishReason === "length",
      ms: Date.now() - startedAt,
    });

    return {
      status: "answered",
      reply,
      model: completion.model,
      layer: facts ? "calendar" : "chat",
      dateIntent: facts?.intent,
      fellBackToDeterministic: fellBack,
      ms: Date.now() - startedAt,
      contextMessages: memory.length,
      truncated: completion.finishReason === "length",
    };
  } catch (error) {
    const code = (error as { code?: string })?.code;
    logWarn("chat.failed", {
      sessionId: input.sessionId,
      code: code ?? null,
      message: error instanceof Error ? error.message : "unknown",
    });

    // Even with every model down, a date answer is already computed.
    if (facts) {
      return {
        status: "answered",
        reply: facts.summary,
        model: null,
        layer: "calendar",
        dateIntent: facts.intent,
        fellBackToDeterministic: true,
        ms: Date.now() - startedAt,
        contextMessages: memory.length,
        truncated: false,
      };
    }

    return {
      status: "error",
      reply: locale === "en" ? FALLBACK_EN : FALLBACK_FA,
      model: null,
      layer: "none",
      ms: Date.now() - startedAt,
      contextMessages: memory.length,
      truncated: false,
    };
  }
}

/** Starts a brand-new conversation (the /clear command). */
export function resetConversation(sessionId: string): void {
  clearSession(sessionId);
}

/** Number of stored messages for a session — used by tests and /status. */
export function conversationLength(sessionId: string): number {
  return countMessages(sessionId, getConfig().history.ttlMs);
}
