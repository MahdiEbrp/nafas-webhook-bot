import type { RuleRequestContext } from "@/lib/rules/types";
import { logWarn } from "@/lib/log";

import { authSessionStore, type AuthSessionStore } from "./session-store";

const DEFAULT_BASE_URL = "https://nafasbeautyclinic.ir";
const PHONE_PATTERN = /^\+?[0-9]{7,15}$/u;
const CODE_PATTERN = /^[0-9]{6}$/u;

export type SmsOtpSuccess = {
  ok: true;
  requestId?: string;
  expiresInMs?: number;
  resendInMs?: number;
  /** True after the session is encrypted and persisted in Postgres. */
  sessionStored?: boolean;
  /** False when the upstream response did not provide a CSRF token. */
  ruleContextAvailable?: boolean;
};

export type SmsOtpFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
  requestId?: string;
};

export type SmsOtpResult = SmsOtpSuccess | SmsOtpFailure;

export type SmsOtpClientOptions = {
  /** Defaults to NAFAS_API_BASE_URL or https://nafasbeautyclinic.ir. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** CSRF may be returned in this response header. Defaults to x-csrf-token. */
  csrfTokenHeader?: string;
  /** Optional CSRF cookie name, if the API uses a readable/double-submit cookie. */
  csrfCookieName?: string;
  /** Injectable for tests or a host-provided secure store. Defaults to encrypted Postgres storage. */
  sessionStore?: AuthSessionStore;
};

type ApiBody = Record<string, unknown>;
type RequestStep = "request" | "verify" | "resend";

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_CODE: "کد یک‌بارمصرف درست نیست.",
  CODE_EXPIRED: "کد یک‌بارمصرف منقضی شده است.",
  TOO_MANY_ATTEMPTS: "تعداد تلاش‌های اشتباه بیش از حد مجاز است.",
  LOCKED_OUT: "حساب موقتاً قفل شده است.",
  ACCOUNT_INACTIVE: "این حساب فعال نیست.",
  ACCOUNT_BANNED: "این حساب در دسترس نیست.",
  RATE_LIMITED: "تعداد درخواست‌ها بیش از حد مجاز است؛ کمی بعد دوباره تلاش کن.",
  SESSION_COOKIE_MISSING: "ورود تأیید شد، اما سرویس cookie نشست را برنگرداند.",
  SESSION_STORAGE_FAILED: "ورود تأیید شد، اما ذخیرهٔ رمزگذاری‌شدهٔ نشست انجام نشد.",
};

function isRecord(value: unknown): value is ApiBody {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const phone = value.trim();
  return PHONE_PATTERN.test(phone) ? phone : null;
}

function setCookieHeaders(headers: Headers): string[] {
  const headerBag = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headerBag.getSetCookie === "function") return headerBag.getSetCookie();
  return (headers.get("set-cookie") ?? "").split(/,(?=\s*[^;,=\s]+=[^;,]*)/u).filter(Boolean);
}

function responseCookies(headers: Headers): string[] {
  const byName = new Map<string, string>();
  for (const setCookie of setCookieHeaders(headers)) {
    const pair = setCookie.split(";", 1)[0]?.trim();
    if (!pair) continue;
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    byName.set(pair.slice(0, separator).trim(), pair);
  }
  return [...byName.values()];
}

function cookieValue(cookies: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const pair = cookies.find((cookie) => cookie.startsWith(prefix));
  if (!pair) return undefined;
  const raw = pair.slice(prefix.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function upstreamExpiry(headers: Headers): number | undefined {
  const expiries: number[] = [];
  for (const cookie of setCookieHeaders(headers)) {
    const maxAge = cookie.match(/(?:^|;)\s*max-age\s*=\s*(-?\d+)/iu)?.[1];
    if (maxAge !== undefined) {
      const seconds = Number(maxAge);
      if (Number.isFinite(seconds)) expiries.push(Date.now() + seconds * 1000);
      continue;
    }
    const expires = cookie.match(/(?:^|;)\s*expires\s*=\s*([^;]+)/iu)?.[1];
    if (expires) {
      const parsed = Date.parse(expires);
      if (Number.isFinite(parsed)) expiries.push(parsed);
    }
  }
  return expiries.length ? Math.min(...expiries) : undefined;
}

function apiError(body: unknown, status: number): { code: string; message: string } {
  const record = isRecord(body) ? body : {};
  const code = typeof record.code === "string"
    ? record.code
    : typeof record.error === "string"
      ? record.error
      : status === 429 ? "RATE_LIMITED" : `HTTP_${status}`;
  const message = ERROR_MESSAGES[code]
    ?? (typeof record.message === "string" ? record.message.slice(0, 300) : "درخواست ورود انجام نشد.");
  return { code, message };
}

function readExpiry(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class SmsOtpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly csrfTokenHeader: string;
  private readonly csrfCookieName?: string;
  private readonly sessionStore: AuthSessionStore;

  constructor(options: SmsOtpClientOptions = {}) {
    const configuredBaseUrl = options.baseUrl ?? (process.env.NAFAS_API_BASE_URL?.trim() || DEFAULT_BASE_URL);
    this.baseUrl = configuredBaseUrl.trim().replace(/\/+$/u, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.csrfTokenHeader = options.csrfTokenHeader ?? "x-csrf-token";
    this.csrfCookieName = options.csrfCookieName?.trim() || undefined;
    this.sessionStore = options.sessionStore ?? authSessionStore;
  }

  request(phoneInput: string): Promise<SmsOtpResult> {
    return this.post("request", phoneInput);
  }

  resend(phoneInput: string): Promise<SmsOtpResult> {
    return this.post("resend", phoneInput);
  }

  async verify(phoneInput: string, codeInput: string, lookupIdInput?: string): Promise<SmsOtpResult> {
    const phone = normalizedPhone(phoneInput);
    if (!phone) return this.invalid("شماره باید با + اختیاری و ۷ تا ۱۵ رقم نوشته شود.");
    const lookupId = lookupIdInput?.trim() || phone;
    if (lookupId.length > 256) return this.invalid("شناسهٔ نشست معتبر نیست.");
    if (typeof codeInput !== "string" || !CODE_PATTERN.test(codeInput)) {
      return this.invalid("کد یک‌بارمصرف باید دقیقاً ۶ رقم باشد.");
    }

    const result = await this.send("verify", "/api/v1/auth/otp/verify", { phone, code: codeInput });
    if (!result.ok) return result;
    const cookies = responseCookies(result.headers);
    const sessionCookie = cookies.join("; ");
    if (!sessionCookie) {
      return {
        ok: false,
        status: 502,
        code: "SESSION_COOKIE_MISSING",
        message: ERROR_MESSAGES.SESSION_COOKIE_MISSING ?? "نشست احراز هویت دریافت نشد.",
        ...(result.requestId ? { requestId: result.requestId } : {}),
      };
    }
    const csrfToken = result.headers.get(this.csrfTokenHeader)?.trim()
      || (this.csrfCookieName ? cookieValue(cookies, this.csrfCookieName) : undefined);
    const expiresAt = upstreamExpiry(result.headers);
    let saved = false;
    try {
      saved = await this.sessionStore.save({
        actorId: phone,
        ...(lookupId === phone ? {} : { lookupId }),
        sessionCookie,
        ...(csrfToken ? { csrfToken } : {}),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
    } catch {
      // Keep storage failures fail-closed without logging or returning secrets.
    }
    if (!saved) {
      return {
        ok: false,
        status: 503,
        code: "SESSION_STORAGE_FAILED",
        message: ERROR_MESSAGES.SESSION_STORAGE_FAILED ?? "ذخیره نشست انجام نشد.",
        ...(result.requestId ? { requestId: result.requestId } : {}),
      };
    }
    return {
      ok: true,
      ...(result.requestId ? { requestId: result.requestId } : {}),
      sessionStored: true,
      ruleContextAvailable: Boolean(csrfToken),
    };
  }

  /** Decrypts a session only when needed; callers must keep the result server-side. */
  async getRuleRequestContext(lookupIdInput: string): Promise<RuleRequestContext | null> {
    const lookupId = lookupIdInput.trim();
    if (!lookupId || lookupId.length > 256) return null;
    let stored: Awaited<ReturnType<AuthSessionStore["get"]>>;
    try {
      stored = await this.sessionStore.get(lookupId);
    } catch {
      return null;
    }
    if (!stored || (stored.lookupId ?? stored.actorId) !== lookupId || !stored.actorId.trim() || !stored.sessionCookie.trim() || !stored.csrfToken?.trim()) return null;
    return { actorId: stored.actorId, sessionCookie: stored.sessionCookie, csrfToken: stored.csrfToken };
  }

  /** Removes the locally stored encrypted session; it does not revoke it upstream. */
  async clearStoredSession(lookupIdInput: string): Promise<boolean> {
    const lookupId = lookupIdInput.trim();
    if (!lookupId || lookupId.length > 256) return false;
    try {
      return await this.sessionStore.delete(lookupId);
    } catch {
      return false;
    }
  }

  private async post(step: "request" | "resend", phoneInput: string): Promise<SmsOtpResult> {
    const phone = normalizedPhone(phoneInput);
    if (!phone) return this.invalid("شماره باید با + اختیاری و ۷ تا ۱۵ رقم نوشته شود.");
    const result = await this.send(step, `/api/v1/auth/otp/${step}`, { channel: "sms", phone });
    if (!result.ok) return result;
    return {
      ok: true,
      requestId: result.requestId,
      ...(readExpiry(result.body.expiresInMs) === undefined ? {} : { expiresInMs: readExpiry(result.body.expiresInMs) }),
      ...(readExpiry(result.body.resendInMs) === undefined ? {} : { resendInMs: readExpiry(result.body.resendInMs) }),
    };
  }

  private invalid(message: string): SmsOtpFailure {
    return { ok: false, status: 400, code: "VALIDATION_ERROR", message };
  }

  private async send(
    step: RequestStep,
    path: string,
    body: Record<string, string>,
  ): Promise<
    | { ok: true; body: ApiBody; headers: Headers; requestId?: string }
    | SmsOtpFailure
  > {
    if (!/^https:\/\//iu.test(this.baseUrl)) {
      return { ok: false, status: 0, code: "INSECURE_BASE_URL", message: "نشانی API برای ورود باید HTTPS باشد." };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      const requestId = response.headers.get("x-request-id") ?? undefined;
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      if (!response.ok || !isRecord(parsed) || parsed.ok !== true) {
        const error = apiError(parsed, response.status);
        logWarn("auth.otp_failed", { step, status: response.status, code: error.code, ...(requestId ? { requestId } : {}) });
        return { ok: false, status: response.status, ...error, ...(requestId ? { requestId } : {}) };
      }
      return { ok: true, body: parsed, headers: response.headers, requestId };
    } catch (error) {
      const timeout = error instanceof Error && error.name === "AbortError";
      const code = timeout ? "TIMEOUT" : "NETWORK_ERROR";
      logWarn("auth.otp_network_error", { step, code });
      return { ok: false, status: 0, code, message: timeout ? "درخواست ورود بیش از حد طول کشید." : "ارتباط با سرویس ورود برقرار نشد." };
    } finally {
      clearTimeout(timer);
    }
  }
}
