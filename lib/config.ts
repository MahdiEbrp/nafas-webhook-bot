/**
 * Central configuration for the chat bot.
 *
 * Everything is read from environment variables so the same code runs on
 * Vercel, on `next dev`, and in the self-tests (where we inject fakes).
 *
 * This project is *only* a conversation: user text in → AI text out. There is
 * no database, no upstream API, no tools. The configuration therefore only
 * covers three things: which model thinks, how much memory a conversation
 * keeps, and how the bot is reached (HTTP + Telegram).
 */

export type Locale = "fa" | "en";

export type AppConfig = {
  /** OpenRouter */
  openrouterApiKey: string;
  /** Fallback / pinned chain: used when auto-selection is off or the catalog is unreachable */
  modelChain: string[];
  /** "auto" picks the best free models from the live catalog; "fixed" uses modelChain only */
  modelSelection: "auto" | "fixed";
  /** How many auto-selected models to try, in order, before giving up */
  modelPoolSize: number;
  /** Ignore catalog models with less context than this (a chat with memory needs room) */
  modelMinContext: number;
  /** How long a model that just failed waits before it can be picked first again */
  modelCooldownMs: number;
  /** Hard timeout for a single model call */
  modelTimeoutMs: number;
  /** Max attempts per model before falling through to the next */
  modelRetries: number;
  /** Sampling controls for the chat completion */
  temperature: number;
  maxTokens: number;
  /** Conversation memory: how many messages per session, and how long they live */
  history: { maxMessages: number; ttlMs: number };
  /** Name the bot uses for itself in the system prompt and greetings */
  botName: string;
  /** The clinic the bot introduces itself as the assistant of */
  clinicName: string;
  /** IANA zone used for "what time is it" — the server usually runs UTC */
  timeZone: string;
  /** Kill switch for the deterministic date/calendar layer */
  dateAssistant: boolean;
  /**
   * Postgres (Neon) connection string for persisted settings. Empty = the bot
   * runs without a database, exactly as it did before.
   */
  databaseUrl: string;
  /** Bot entry-point protection (optional but recommended) */
  botApiKey: string | null;
  /** Requests per minute per client for /api/chat */
  chatRateLimit: { limit: number; windowMs: number };
  /** Browser origins allowed to call this bot directly */
  allowedOrigins: string[];
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
  };
};

const FREE_SUFFIX = ":free";

/**
 * The fallback chain. Free models on OpenRouter change over time, so with
 * MODEL_SELECTION=auto (the default) this list is only a safety net for when
 * the catalog cannot be fetched, plus a hint that these ids are trusted — they
 * get a small ranking boost. Run `npm run models` to see today's live ranking.
 */
export const DEFAULT_MODEL_CHAIN = [
  "liquid/lfm-3-1.7b:free",
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3.5-super-vl:free",
  "xingchen-agi/xing4.0-29b-a4b:free",
  "google/gemma-4-26b-a4b-it:free",
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

function float(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
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
    openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
    modelChain: safeChain,
    modelSelection: process.env.MODEL_SELECTION?.trim().toLowerCase() === "fixed" ? "fixed" : "auto",
    modelPoolSize: Math.max(1, Math.min(8, int(process.env.MODEL_POOL_SIZE, 4))),
    modelMinContext: int(process.env.MODEL_MIN_CONTEXT, 8192),
    modelCooldownMs: int(process.env.MODEL_COOLDOWN_MS, 90_000),
    modelTimeoutMs: int(process.env.MODEL_TIMEOUT_MS, 45_000),
    modelRetries: int(process.env.MODEL_RETRIES, 2),
    temperature: Math.min(2, Math.max(0, float(process.env.TEMPERATURE, 0.7))),
    maxTokens: int(process.env.MAX_TOKENS, 700),
    history: {
      maxMessages: Math.min(40, int(process.env.HISTORY_MESSAGES, 12)),
      ttlMs: int(process.env.HISTORY_TTL_MS, 30 * 60 * 1000),
    },
    botName: process.env.BOT_NAME?.trim() || "نفَس",
    clinicName: process.env.CLINIC_NAME?.trim() || "کلینیک زیبایی نفس",
    timeZone: process.env.TIME_ZONE?.trim() || "Asia/Tehran",
    dateAssistant: bool(process.env.DATE_ASSISTANT, true),
    databaseUrl: (process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "").trim(),
    botApiKey: process.env.BOT_API_KEY?.trim() || null,
    chatRateLimit: {
      limit: int(process.env.CHAT_RATE_LIMIT, 20),
      windowMs: int(process.env.CHAT_RATE_WINDOW_MS, 60_000),
    },
    allowedOrigins: list(process.env.ALLOWED_ORIGINS, []),
    defaultLocale: (process.env.DEFAULT_LOCALE === "en" ? "en" : "fa") as Locale,
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "",
      webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "",
      publicUrl: normalisePublicUrl(
        process.env.PUBLIC_APP_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "",
      ),
      allowedChatIds: (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value !== 0),
      autoSetup: bool(process.env.TELEGRAM_AUTO_SETUP, true),
      apiBase: (process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org").replace(/\/+$/, ""),
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
  if (!config.openrouterApiKey) warnings.push("OPENROUTER_API_KEY is not set — the bot cannot think.");
  if (!config.botApiKey) warnings.push("BOT_API_KEY is not set — /api/chat is open to anyone who finds the URL.");
  if (config.telegram.botToken && !config.telegram.publicUrl) {
    warnings.push("TELEGRAM_BOT_TOKEN is set but PUBLIC_APP_URL is empty — the webhook cannot be registered.");
  }
  if (config.telegram.botToken && !config.telegram.webhookSecret) {
    warnings.push("TELEGRAM_WEBHOOK_SECRET is empty — anyone could POST fake updates to /api/telegram/webhook.");
  }
  if (config.telegram.botToken && config.telegram.allowedChatIds.length === 0) {
    warnings.push("TELEGRAM_ALLOWED_CHAT_IDS is empty — anyone who finds the bot can talk to it.");
  }
  if (!config.databaseUrl) {
    warnings.push("DATABASE_URL is not set — chat sessions are not persisted; every chat uses tg-<chatId>.");
  }
  if (config.allowedOrigins.length === 0) {
    warnings.push("ALLOWED_ORIGINS is empty — browser callers (CORS) will be blocked; server-to-server calls still work.");
  }
  return warnings;
}
