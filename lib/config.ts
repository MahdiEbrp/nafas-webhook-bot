/**
 * Central configuration for the AI webhook bot.
 *
 * Everything is read from environment variables so the same code runs on
 * Vercel, on `next dev`, and in the self-tests (where we inject fakes).
 */

export type Locale = "fa" | "en";

export type AppConfig = {
  /** Base URL of the existing project that exposes /api/v1/webhooks/* */
  webhookBaseUrl: string;
  /** Basic-auth credentials of a service user that owns the webhook permissions */
  webhookUsername: string;
  webhookPassword: string;
  /** OpenRouter */
  openrouterApiKey: string;
  /** Ordered free-model chain, first one that works wins */
  modelChain: string[];
  /** Hard timeout for a single model call */
  modelTimeoutMs: number;
  /** Max attempts per model before falling through to the next */
  modelRetries: number;
  /** Bot entry-point protection (optional but recommended) */
  botApiKey: string | null;
  /** Requests per minute per client for /api/chat */
  chatRateLimit: { limit: number; windowMs: number };
  /** Browser origins allowed to call this middleware directly */
  allowedOrigins: string[];
  /** Real mutations need an explicit confirmation unless this is true */
  allowAutoWrite: boolean;
  defaultLocale: Locale;
  /** Telegram bridge (optional) */
  telegram: {
    botToken: string;
    /** Telegram echoes this back in X-Telegram-Bot-Api-Secret-Token */
    webhookSecret: string;
    /** public https URL of THIS app, used to register the webhook */
    publicUrl: string;
    /** empty = anyone who finds the bot; otherwise an allowlist of chat ids */
    allowedChatIds: number[];
    /** register the webhook automatically when the server boots */
    autoSetup: boolean;
    /** override for local demos / corporate proxies (default: api.telegram.org) */
    apiBase: string;
    /**
     * true → a chat must prove it belongs to a staff phone number before it can
     * touch the clinic (see lib/telegram/identity.ts).
     */
    requireIdentity: boolean;
  };
};

const FREE_SUFFIX = ":free";

/**
 * Free models on OpenRouter change over time, so the chain is configurable.
 * The defaults below were picked because they (a) are `:free`, (b) advertise
 * `tools` + `response_format`, and (c) are strong enough for Persian
 * instruction following. Verified against GET /api/v1/models.
 */
/**
 * The clinic project that owns the webhooks. It is the *upstream* of this
 * middleware — this app never stores clinic data, it only forwards requests.
 */
export const DEFAULT_WEBHOOK_BASE_URL = "https://nafasbeautyclinic.ir";

export const DEFAULT_MODEL_CHAIN = [
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3.5-super-vl:free",
  "xingchen-agi/xing4.0-29b-a4b:free",
  "google/gemma-4-26b-a4b-it:free",
  "liquid/lfm-3-1.7b:free",
];

function normalisePublicUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function list(value: string | undefined, fallback: string[]): string[] {
  const items = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;

  const chain = list(process.env.OPENROUTER_MODELS, DEFAULT_MODEL_CHAIN);
  // Guard-rail: this bot is meant to run on free models only.
  const safeChain = chain.map((id) => (id.endsWith(FREE_SUFFIX) ? id : `${id}${FREE_SUFFIX}`));

  cached = {
    webhookBaseUrl: (process.env.WEBHOOK_BASE_URL ?? DEFAULT_WEBHOOK_BASE_URL).replace(/\/+$/, ""),
    webhookUsername: process.env.WEBHOOK_USERNAME ?? "",
    webhookPassword: process.env.WEBHOOK_PASSWORD ?? "",
    openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
    modelChain: safeChain,
    modelTimeoutMs: int(process.env.MODEL_TIMEOUT_MS, 45_000),
    modelRetries: int(process.env.MODEL_RETRIES, 2),
    botApiKey: process.env.BOT_API_KEY?.trim() || null,
    chatRateLimit: {
      limit: int(process.env.CHAT_RATE_LIMIT, 20),
      windowMs: int(process.env.CHAT_RATE_WINDOW_MS, 60_000),
    },
    allowedOrigins: list(process.env.ALLOWED_ORIGINS, []),
    allowAutoWrite: bool(process.env.ALLOW_AUTO_WRITE, false),
    defaultLocale: (process.env.DEFAULT_LOCALE === "en" ? "en" : "fa") as Locale,
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "",
      webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "",
      publicUrl: (process.env.PUBLIC_APP_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? normalisePublicUrl(process.env.PUBLIC_APP_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "")
        : ""),
      allowedChatIds: (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value !== 0),
      autoSetup: bool(process.env.TELEGRAM_AUTO_SETUP, true),
      apiBase: (process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org").replace(/\/+$/, ""),
      requireIdentity: bool(process.env.TELEGRAM_REQUIRE_IDENTITY, false),
    },
  };

  return cached;
}

/** Only used by tests so they can re-read the environment. */
export function resetConfigCache(): void {
  cached = null;
}

export function configWarnings(config: AppConfig = getConfig()): string[] {
  const warnings: string[] = [];
  if (!config.openrouterApiKey) warnings.push("OPENROUTER_API_KEY is not set — /api/chat cannot think.");
  if (!config.webhookUsername || !config.webhookPassword) {
    warnings.push("WEBHOOK_USERNAME / WEBHOOK_PASSWORD are not set — webhook calls will fail with 401.");
  }
  if (!config.botApiKey) warnings.push("BOT_API_KEY is not set — /api/chat and /api/proxy are open to anyone who finds the URL.");
  if (config.telegram.botToken && !config.telegram.publicUrl) {
    warnings.push("TELEGRAM_BOT_TOKEN is set but PUBLIC_APP_URL is empty — the webhook cannot be registered.");
  }
  if (config.telegram.botToken && !config.telegram.webhookSecret) {
    warnings.push("TELEGRAM_WEBHOOK_SECRET is empty — anyone could POST fake updates to /api/telegram/webhook.");
  }
  if (config.telegram.botToken && config.telegram.allowedChatIds.length === 0) {
    warnings.push("TELEGRAM_ALLOWED_CHAT_IDS is empty — anyone who finds the bot can control the clinic.");
  }
  if (config.telegram.botToken && !config.telegram.requireIdentity && !config.botApiKey) {
    warnings.push(
      "Neither BOT_API_KEY nor TELEGRAM_REQUIRE_IDENTITY is set — the bot has no idea who is talking to it.",
    );
  }
  if (config.allowedOrigins.length === 0) {
    warnings.push("ALLOWED_ORIGINS is empty — browser callers (CORS) will be blocked; server-to-server calls still work.");
  }
  return warnings;
}
