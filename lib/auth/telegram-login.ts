import { normalize } from "@/lib/text";

import type { SmsOtpFailure, SmsOtpResult } from "./sms-otp";
import { OTP_LOGIN_FLOW_TTL_MS, type OtpLoginFlow, type OtpLoginFlowStore } from "./login-flow-store";

type OtpLoginClient = {
  request(phone: string): Promise<SmsOtpResult>;
  resend(phone: string): Promise<SmsOtpResult>;
  verify(phone: string, code: string, lookupId?: string): Promise<SmsOtpResult>;
};

export type TelegramOtpLoginOptions = {
  otpClient: OtpLoginClient;
  flowStore: OtpLoginFlowStore;
  now?: () => number;
};

export type TelegramOtpLoginResult =
  | { handled: false }
  | { handled: true; status: "login-started" | "phone-requested" | "code-resent" | "authenticated" | "login-cancelled" | "login-error"; reply: string };

const SIX_DIGITS = /^[0-9]{6}$/u;
const PHONE_SHAPE = /^\+?[0-9]{7,15}$/u;
const LOGIN_START_FA = "برای ورود، شمارهٔ موبایلی که در حساب نفس ثبت کرده‌ای بفرست. رمز یک‌بارمصرف را برایت پیامک می‌کنم. برای لغو بنویس «لغو».";
const LOGIN_START_EN = "Send the mobile number registered to your Nafas account. I will text you a one-time code. Write “cancel” to stop.";
const NEED_LOGIN_FA = "برای واردشدن، اول بنویس «می‌خواهم وارد حساب شوم» تا فرایند امن ورود را شروع کنیم.";
const NEED_LOGIN_EN = "First say “I want to log in” to start the secure sign-in flow.";
const STORE_UNAVAILABLE_FA = "ورود فعلاً آماده نیست؛ ذخیره‌سازی امن نشست پیکربندی نشده است. مدیر باید دیتابیس و کلید امن ورود را تنظیم کند.";
const STORE_UNAVAILABLE_EN = "Sign-in is unavailable because secure session storage is not configured. An administrator must configure the database and login encryption key.";
const INVALID_PHONE_FA = "شماره را با ۷ تا ۱۵ رقم بفرست؛ + در ابتدای شماره اختیاری است.";
const INVALID_PHONE_EN = "Send a phone number with 7–15 digits; an initial + is optional.";
const VERIFY_CODE_FA = "کد پیامک‌شده را دقیقاً با ۶ رقم بفرست. برای ارسال دوباره بنویس «ارسال مجدد».";
const VERIFY_CODE_EN = "Send the six-digit code from the SMS. Write “resend code” to get another one.";
const INVALID_CODE_SHAPE_FA = "کد باید دقیقاً ۶ رقم باشد.";
const INVALID_CODE_SHAPE_EN = "The code must contain exactly six digits.";
const LOGIN_CANCELLED_FA = "فرایند ورود لغو شد؛ هیچ کدی بررسی نشد.";
const LOGIN_CANCELLED_EN = "Sign-in cancelled. No code was checked.";
const AUTHENTICATED_FA = "ورود پیامکی تأیید شد. حالا می‌توانی دربارهٔ قوانین کلینیک سؤال کنی یا تغییر بخواهی؛ تغییرها همچنان نیاز به تأیید صریح تو دارند.";
const AUTHENTICATED_EN = "SMS sign-in succeeded. You can now ask about clinic rules or request changes; changes still require your explicit confirmation.";
const AUTHENTICATED_NO_CSRF_FA = "ورود پیامکی تأیید شد، اما سرویس CSRF لازم برای بخش قوانین را برنگرداند. می‌توانی دوباره وارد شوی یا با مدیر تماس بگیری.";
const AUTHENTICATED_NO_CSRF_EN = "SMS sign-in succeeded, but the service did not return the CSRF token needed for rules access. Try again later or contact an administrator.";

function languageText(locale: "fa" | "en", fa: string, en: string): string {
  return locale === "en" ? en : fa;
}

export function isOtpCodeLikeMessage(message: string): boolean {
  return /(?:^|[^0-9])[0-9]{6}(?:$|[^0-9])/u.test(normalize(message));
}

export function isOtpLoginIntent(message: string): boolean {
  const text = normalize(message).toLowerCase();
  if (/(?:نمی ?خواهم|نمی ?خوام|نمیخواهم|نمیخوام|نمی ?خواستم|don[’']t want|do not want|no need to).{0,40}(?:لاگین|وارد|ورود|sign ?in|log ?in)/u.test(text)) return false;
  return /(?:می ?خواهم|می ?خوام|قصد دارم|i want to|please).{0,32}(?:لاگین|وارد|ورود|sign ?in|log ?in)/u.test(text)
    || /(?:لاگین|ورود|sign ?in|log ?in).{0,24}(?:کن|بشم|شوم|حساب|account|please|now)/u.test(text);
}

function isCancel(message: string): boolean {
  const text = normalize(message).toLowerCase().replace(/[.!؟?،,]+/gu, " ").trim();
  return /^(لغو|بیخیال|منصرف شدم|\/cancel|cancel|stop|never mind)$/u.test(text);
}

function isResend(message: string): boolean {
  const text = normalize(message).toLowerCase();
  return /(?:کد|رمز).{0,20}(?:ارسال|بفرست|دوباره|مجدد)|(?:ارسال|بفرست|دوباره|مجدد).{0,20}(?:کد|رمز)|(?:resend|send again).{0,20}(?:code)?/u.test(text);
}

function phoneFromMessage(message: string): string | null {
  const text = normalize(message);
  const matches = [...text.matchAll(/\+?[0-9][0-9\s().-]{5,22}[0-9]/gu)]
    .map((match) => match[0]?.replace(/[\s().-]/gu, ""))
    .filter((phone): phone is string => Boolean(phone && PHONE_SHAPE.test(phone)));
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] ?? null : null;
}

export function isPhoneNumberMessage(message: string): boolean {
  return phoneFromMessage(message) !== null;
}

function digitsOnly(text: string): string {
  return normalize(text).replace(/\s+/gu, "");
}

function apiFailure(result: SmsOtpFailure, locale: "fa" | "en"): string {
  if (locale === "en") {
    const generic: Record<string, string> = {
      INVALID_CODE: "That code is not correct. Please check the SMS and try again.",
      CODE_EXPIRED: "That code has expired. Start sign-in again to request a new one.",
      TOO_MANY_ATTEMPTS: "There have been too many attempts. Start again later.",
      LOCKED_OUT: "This account is temporarily locked. Please try again later.",
      ACCOUNT_INACTIVE: "This account is inactive. Please contact the clinic.",
      ACCOUNT_BANNED: "This account cannot sign in. Please contact the clinic.",
      RATE_LIMITED: "Too many requests. Wait a little before trying again.",
      SESSION_STORAGE_FAILED: "The SMS was accepted, but secure session storage failed. Please contact an administrator.",
      SESSION_COOKIE_MISSING: "The server did not return a reusable sign-in session. Please contact an administrator.",
    };
    return generic[result.code] ?? "Sign-in failed. Please try again.";
  }
  const generic: Record<string, string> = {
    INVALID_CODE: "این کد درست نیست؛ پیامک را بررسی کن و دوباره بفرست.",
    CODE_EXPIRED: "کد منقضی شده است؛ فرایند ورود را دوباره شروع کن.",
    TOO_MANY_ATTEMPTS: "تعداد تلاش‌ها زیاد شد؛ کمی بعد دوباره شروع کن.",
    LOCKED_OUT: "این حساب موقتاً قفل شده است؛ کمی بعد دوباره تلاش کن.",
    ACCOUNT_INACTIVE: "این حساب فعال نیست؛ با کلینیک تماس بگیر.",
    ACCOUNT_BANNED: "این حساب امکان ورود ندارد؛ با کلینیک تماس بگیر.",
    RATE_LIMITED: "تعداد درخواست‌ها زیاد است؛ کمی صبر کن.",
    SESSION_STORAGE_FAILED: "کد تأیید شد، اما ذخیرهٔ امن نشست انجام نشد؛ با مدیر تماس بگیر.",
    SESSION_COOKIE_MISSING: "سرویس نشست قابل‌استفاده‌ای برنگرداند؛ با مدیر تماس بگیر.",
  };
  return generic[result.code] ?? "ورود انجام نشد؛ دوباره تلاش کن.";
}

function terminalFailure(code: string): boolean {
  return ["CODE_EXPIRED", "TOO_MANY_ATTEMPTS", "LOCKED_OUT", "ACCOUNT_INACTIVE", "ACCOUNT_BANNED", "SESSION_STORAGE_FAILED", "SESSION_COOKIE_MISSING"].includes(code);
}

/**
 * Deterministic Telegram sign-in flow. Phone numbers and OTPs are handled only
 * here and never appended to chat history or sent to the language model.
 */
export class TelegramOtpLogin {
  private readonly otpClient: OtpLoginClient;
  private readonly flowStore: OtpLoginFlowStore;
  private readonly now: () => number;

  constructor(options: TelegramOtpLoginOptions) {
    this.otpClient = options.otpClient;
    this.flowStore = options.flowStore;
    this.now = options.now ?? Date.now;
  }

  async handle(flowId: string, message: string, locale: "fa" | "en" = "fa"): Promise<TelegramOtpLoginResult> {
    let flow: OtpLoginFlow | null;
    try {
      flow = await this.flowStore.get(flowId);
    } catch {
      flow = null;
    }

    if (!flow && isOtpLoginIntent(message)) {
      const started = await this.save(flowId, { step: "phone", expiresAt: this.now() + OTP_LOGIN_FLOW_TTL_MS });
      return started
        ? { handled: true, status: "login-started", reply: languageText(locale, LOGIN_START_FA, LOGIN_START_EN) }
        : { handled: true, status: "login-error", reply: languageText(locale, STORE_UNAVAILABLE_FA, STORE_UNAVAILABLE_EN) };
    }

    if (!flow) {
      if (isOtpCodeLikeMessage(message)) {
        return { handled: true, status: "login-error", reply: languageText(locale, NEED_LOGIN_FA, NEED_LOGIN_EN) };
      }
      return { handled: false };
    }

    if (isCancel(message)) {
      await this.remove(flowId);
      return { handled: true, status: "login-cancelled", reply: languageText(locale, LOGIN_CANCELLED_FA, LOGIN_CANCELLED_EN) };
    }

    if (flow.step === "phone") return this.requestCode(flowId, message, locale);
    if (isResend(message)) return this.resendCode(flowId, flow, locale);
    return this.verifyCode(flowId, flow, message, locale);
  }

  private async requestCode(flowId: string, message: string, locale: "fa" | "en"): Promise<TelegramOtpLoginResult> {
    const phone = phoneFromMessage(message);
    if (!phone) return { handled: true, status: "login-error", reply: languageText(locale, INVALID_PHONE_FA, INVALID_PHONE_EN) };

    const pending: OtpLoginFlow = { step: "code", phone, expiresAt: this.now() + OTP_LOGIN_FLOW_TTL_MS };
    if (!(await this.save(flowId, pending))) {
      return { handled: true, status: "login-error", reply: languageText(locale, STORE_UNAVAILABLE_FA, STORE_UNAVAILABLE_EN) };
    }
    const result = await this.otpClient.request(phone);
    if (!result.ok) {
      await this.remove(flowId);
      return { handled: true, status: "login-error", reply: apiFailure(result, locale) };
    }
    const expiry = Math.min(
      this.now() + OTP_LOGIN_FLOW_TTL_MS,
      this.now() + (result.expiresInMs ?? OTP_LOGIN_FLOW_TTL_MS),
    );
    await this.save(flowId, { step: "code", phone, expiresAt: expiry });
    return { handled: true, status: "phone-requested", reply: languageText(locale, VERIFY_CODE_FA, VERIFY_CODE_EN) };
  }

  private async resendCode(flowId: string, flow: Extract<OtpLoginFlow, { step: "code" }>, locale: "fa" | "en"): Promise<TelegramOtpLoginResult> {
    const result = await this.otpClient.resend(flow.phone);
    if (!result.ok) return { handled: true, status: "login-error", reply: apiFailure(result, locale) };
    const expiry = Math.min(
      this.now() + OTP_LOGIN_FLOW_TTL_MS,
      this.now() + (result.expiresInMs ?? OTP_LOGIN_FLOW_TTL_MS),
    );
    await this.save(flowId, { step: "code", phone: flow.phone, expiresAt: expiry });
    return { handled: true, status: "code-resent", reply: languageText(locale, VERIFY_CODE_FA, VERIFY_CODE_EN) };
  }

  private async verifyCode(flowId: string, flow: Extract<OtpLoginFlow, { step: "code" }>, message: string, locale: "fa" | "en"): Promise<TelegramOtpLoginResult> {
    const code = digitsOnly(message);
    if (!SIX_DIGITS.test(code)) {
      return { handled: true, status: "login-error", reply: languageText(locale, INVALID_CODE_SHAPE_FA, INVALID_CODE_SHAPE_EN) };
    }
    const result = await this.otpClient.verify(flow.phone, code, flowId);
    if (result.ok) {
      await this.remove(flowId);
      return {
        handled: true,
        status: "authenticated",
        reply: result.ruleContextAvailable
          ? languageText(locale, AUTHENTICATED_FA, AUTHENTICATED_EN)
          : languageText(locale, AUTHENTICATED_NO_CSRF_FA, AUTHENTICATED_NO_CSRF_EN),
      };
    }
    if (terminalFailure(result.code)) await this.remove(flowId);
    return { handled: true, status: "login-error", reply: apiFailure(result, locale) };
  }

  private async save(flowId: string, flow: OtpLoginFlow): Promise<boolean> {
    try {
      return await this.flowStore.save(flowId, flow);
    } catch {
      return false;
    }
  }

  private async remove(flowId: string): Promise<void> {
    try {
      await this.flowStore.delete(flowId);
    } catch {
      // Best-effort local cleanup; TTL still bounds pending-flow lifetime.
    }
  }
}
