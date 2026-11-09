import type { RuleRequestContext } from "@/lib/rules/types";
import { logWarn } from "@/lib/log";

const DEFAULT_BASE_URL = "https://nafasbeautyclinic.ir";
const PHONE_PATTERN = /^\+?[0-9]{7,15}$/u;
const CODE_PATTERN = /^[0-9]{6}$/u;

export type SmsOtpSession = {
  /** Cookie header for server-to-server calls; never log or send this to a model. */
  cookieHeader: string;
  /** CSRF value returned in a response header or configured CSRF cookie. */
  csrfToken?: string;
  /** Available only when both session cookie and CSRF token were returned. */
  ruleRequestContext?: RuleRequestContext;
};

export type SmsOtpSuccess = {
  ok: true;
  requestId?: string;
  expiresInMs?: number;
  resendInMs?: number;
  session?: SmsOtpSession;
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
};

function isRecord(value: unknown): value is ApiBody {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const phone = value.trim();
  return PHONE_PATTERN.test(phone) ? phone : null;
}

function responseCookies(headers: Headers): string[] {
  const headerBag = headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = typeof headerBag.getSetCookie === "function"
    ? headerBag.getSetCookie()
    : (headers.get("set-cookie") ?? "").split(/,(?=\s*[^;,=\s]+=[^;,]*)/u);
  const byName = new Map<string, string>();
  for (const setCookie of setCookies) {
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

  constructor(options: SmsOtpClientOptions = {}) {
    const configuredBaseUrl = options.baseUrl ?? (process.env.NAFAS_API_BASE_URL?.trim() || DEFAULT_BASE_URL);
    this.baseUrl = configuredBaseUrl.trim().replace(/\/+$/u, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.csrfTokenHeader = options.csrfTokenHeader ?? "x-csrf-token";
    this.csrfCookieName = options.csrfCookieName?.trim() || undefined;
  }

  request(phoneInput: string): Promise<SmsOtpResult> {
    return this.post("request", phoneInput);
  }

  resend(phoneInput: string): Promise<SmsOtpResult> {
    return this.post("resend", phoneInput);
  }

  async verify(phoneInput: string, codeInput: string): Promise<SmsOtpResult> {
    const phone = normalizedPhone(phoneInput);
    if (!phone) return this.invalid("شماره باید با + اختیاری و ۷ تا ۱۵ رقم نوشته شود.");
    if (typeof codeInput !== "string" || !CODE_PATTERN.test(codeInput)) {
      return this.invalid("کد یک‌بارمصرف باید دقیقاً ۶ رقم باشد.");
    }

    const result = await this.send("verify", "/api/v1/auth/otp/verify", { phone, code: codeInput });
    if (!result.ok) return result;
    const cookies = responseCookies(result.headers);
    const csrfToken = result.headers.get(this.csrfTokenHeader)?.trim()
      || (this.csrfCookieName ? cookieValue(cookies, this.csrfCookieName) : undefined);
    const sessionCookie = cookies.join("; ");
    const ruleRequestContext = sessionCookie && csrfToken
      ? { actorId: phone, sessionCookie, csrfToken }
      : undefined;

    return {
      ok: true,
      requestId: result.requestId,
      ...(sessionCookie ? { session: { cookieHeader: sessionCookie, ...(csrfToken ? { csrfToken } : {}), ...(ruleRequestContext ? { ruleRequestContext } : {}) } } : {}),
    };
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
