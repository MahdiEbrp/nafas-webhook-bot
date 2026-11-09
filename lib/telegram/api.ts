/**
 * Telegram Bot API client — the transport layer.
 *
 * Everything here is plain fetch, so it works on Vercel serverless and in tests.
 * A single `call()` wraps the `{ ok, result } / { ok:false, description }`
 * envelope Telegram uses, so callers never deal with HTTP codes.
 *
 * Only text is sent, and only text and shared contacts are received: a chat bot
 * needs `sendMessage` and `sendChatAction`, the reply keyboard that asks for a
 * phone number, and the three calls that register the webhook.
 */

import { getConfig } from "@/lib/config";
import { logWarn } from "@/lib/log";
import { truncate } from "@/lib/text";

export type TelegramUser = { id: number; is_bot: boolean; first_name: string; username?: string };
export type TelegramChat = { id: number; type: string; first_name?: string; username?: string; title?: string };
/**
 * A shared contact.
 *
 * `user_id` is what makes this trustworthy: when it equals `message.from.id`
 * the user shared *their own* number straight from Telegram, not one they typed
 * or somebody else's card. `phone_number` arrives international (`+989…`).
 */
export type TelegramContact = {
  phone_number: string;
  first_name?: string;
  last_name?: string;
  user_id?: number;
};
export type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  contact?: TelegramContact;
};
export type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
};
export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  /** still in the type on purpose: buttons from an older build can arrive. */
  callback_query?: TelegramCallbackQuery;
};

export type TelegramResult<T> = { ok: true; result: T } | { ok: false; code: number; description: string };

export function telegramConfigured(): boolean {
  return getConfig().telegram.botToken.length > 0;
}

async function call<T>(
  method: string,
  payload: Record<string, unknown> = {},
  options: { timeoutMs?: number } = {},
): Promise<TelegramResult<T>> {
  const { telegram } = getConfig();
  if (!telegram.botToken) {
    return { ok: false, code: 0, description: "TELEGRAM_BOT_TOKEN is not set" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  try {
    const response = await fetch(`${telegram.apiBase}/bot${telegram.botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store",
    });

    const body = (await response.json().catch(() => null)) as
      | { ok: true; result: T }
      | { ok: false; error_code: number; description: string }
      | null;

    if (!body) return { ok: false, code: response.status, description: "Empty response from Telegram" };
    if (!body.ok) {
      // 429 = flood control: the caller may retry later, we just log it.
      logWarn("telegram.call_failed", { method, code: body.error_code, description: truncate(body.description, 160) });
      return { ok: false, code: body.error_code, description: body.description };
    }
    return { ok: true, result: body.result };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return { ok: false, code: 0, description: aborted ? `${method} timed out` : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

/* ────────────────────────────── identity ────────────────────────────── */

export function getMe(): Promise<TelegramResult<TelegramUser>> {
  return call<TelegramUser>("getMe");
}

export function setWebhook(input: {
  url: string;
  secretToken?: string;
  dropPendingUpdates?: boolean;
  allowedUpdates?: string[];
}): Promise<TelegramResult<true>> {
  return call<true>("setWebhook", {
    url: input.url,
    ...(input.secretToken ? { secret_token: input.secretToken } : {}),
    ...(input.dropPendingUpdates ? { drop_pending_updates: true } : {}),
    allowed_updates: input.allowedUpdates ?? ["message"],
    max_connections: 40,
  });
}

export type WebhookInfo = {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  ip_address?: string;
};

export function getWebhookInfo(): Promise<TelegramResult<WebhookInfo>> {
  return call<WebhookInfo>("getWebhookInfo");
}

export function deleteWebhook(): Promise<TelegramResult<true>> {
  return call<true>("deleteWebhook");
}

/* ────────────────────────────── messaging ───────────────────────────── */

export function sendMessage(input: {
  chatId: number;
  text: string;
  replyToMessageId?: number;
  replyMarkup?: Record<string, unknown>;
}): Promise<TelegramResult<TelegramMessage>> {
  return call<TelegramMessage>("sendMessage", {
    chat_id: input.chatId,
    text: truncate(input.text, 4000),
    // No parse_mode on purpose: Persian text must never break parsing.
    link_preview_options: { is_disabled: true },
    ...(input.replyToMessageId ? { reply_to_message_id: input.replyToMessageId } : {}),
    ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
  });
}

/* ────────────────────────────── keyboard ────────────────────────────── */

/**
 * The "share your number" button.
 *
 * `request_contact: true` is Telegram's own mechanism: it puts a button under
 * the field that sends the number *from the user's Telegram account* rather than
 * making them type it. That is what the owner asked for — the number comes from
 * the Telegram API, so it arrives as `message.contact` with `user_id` set, which
 * also tells us it is really theirs.
 *
 * `one_time_keyboard` makes it fold away after the tap; the handler removes it
 * explicitly once the number is stored, so it does not linger over the chat.
 *
 * Groups cannot offer this button, which is why the handler only sends it when
 * `chat.type === "private"` and asks in plain words otherwise.
 */
export function contactKeyboard(label: string): Record<string, unknown> {
  return {
    keyboard: [[{ text: label, request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

/** Takes the keyboard away once it has done its job. */
export function removeKeyboard(): Record<string, unknown> {
  return { remove_keyboard: true };
}

/** Acknowledges a button press (only reachable from buttons of an older build). */
export function answerCallbackQuery(input: { callbackQueryId: string; text?: string }): Promise<TelegramResult<true>> {
  return call<true>("answerCallbackQuery", {
    callback_query_id: input.callbackQueryId,
    ...(input.text ? { text: truncate(input.text, 190) } : {}),
  });
}

/** "typing…" so the user knows the bot is thinking. Fire-and-forget. */
export function sendTyping(chatId: number): void {
  void call("sendChatAction", { chat_id: chatId, action: "typing" }, { timeoutMs: 5_000 });
}
