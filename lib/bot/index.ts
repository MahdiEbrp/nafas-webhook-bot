/**
 * The whole bot: one public function, `handleChat`.
 *
 *   user text → [system prompt + memory] → free model → reply → memory
 *
 * Nothing else happens here. No tools, no routing, no database: if the model is
 * unavailable the bot apologises instead of guessing, and the conversation
 * still makes sense on the next turn.
 */

import { getConfig, type Locale } from "@/lib/config";
import { logInfo, logWarn } from "@/lib/log";
import { complete, type ChatMessage as ModelMessage } from "@/lib/openrouter/client";
import { normalize } from "@/lib/text";

import { systemPrompt } from "./prompt";
import { getMessages, pushMessage, clearSession, countMessages } from "./session";

export type ChatInput = {
  message: string;
  sessionId: string;
  locale?: Locale;
};

export type ChatStatus = "answered" | "empty" | "error";

export type ChatResult = {
  status: ChatStatus;
  reply: string;
  /** which model in the chain actually answered */
  model: string | null;
  /** milliseconds spent, mostly waiting on the model */
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

export async function handleChat(input: ChatInput): Promise<ChatResult> {
  const config = getConfig();
  const locale = input.locale ?? config.defaultLocale;
  const startedAt = Date.now();

  const message = normalize(input.message).slice(0, MAX_INPUT_CHARS);

  if (!message) {
    return {
      status: "empty",
      reply: locale === "en" ? "I did not get any text there — write something and I will answer." : "متنی به دستم نرسید؛ چیزی بنویس تا جواب بدهم. ✍️",
      model: null,
      ms: Date.now() - startedAt,
      contextMessages: 0,
      truncated: false,
    };
  }

  if (!config.openrouterApiKey) {
    logWarn("chat.no_api_key", { sessionId: input.sessionId });
    return {
      status: "error",
      reply: locale === "en" ? NO_KEY_EN : NO_KEY_FA,
      model: null,
      ms: Date.now() - startedAt,
      contextMessages: 0,
      truncated: false,
    };
  }

  const memory = getMessages(input.sessionId, config.history.ttlMs);

  const messages: ModelMessage[] = [
    { role: "system", content: systemPrompt(locale) },
    ...memory.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user", content: message },
  ];

  try {
    const completion = await complete({
      messages,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    });

    const reply = completion.content.trim();
    pushMessage(input.sessionId, "user", message, config.history.maxMessages);
    pushMessage(input.sessionId, "assistant", reply, config.history.maxMessages);

    logInfo("chat.answered", {
      sessionId: input.sessionId,
      model: completion.model,
      attempts: completion.attempts.length,
      contextMessages: memory.length,
      truncated: completion.finishReason === "length",
      ms: Date.now() - startedAt,
    });

    return {
      status: "answered",
      reply,
      model: completion.model,
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

    return {
      status: "error",
      reply: locale === "en" ? FALLBACK_EN : FALLBACK_FA,
      model: null,
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
