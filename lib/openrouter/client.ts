/**
 * Minimal OpenRouter client tuned for FREE models.
 *
 * Free models on OpenRouter are rate limited (429) and sometimes momentarily
 * unavailable (5xx / empty content). A single call therefore walks a *chain* of
 * free models: the first model that returns usable content wins. This is the
 * whole reliability trick of the project.
 *
 * Only plain `fetch` is used so the code runs on the Edge runtime too.
 */

import { getConfig } from "@/lib/config";
import { logWarn } from "@/lib/log";
import { truncate } from "@/lib/text";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CompletionOptions = {
  messages: ChatMessage[];
  /** Ask the model for a JSON object (response_format). Supported by all defaults. */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** Override the configured free-model chain. */
  modelChain?: string[];
  /** Passed to the model; free models accept the standard OpenRouter fields. */
  topP?: number;
  signal?: AbortSignal;
};

export type CompletionResult = {
  content: string;
  model: string;
  /** every model we tried, in order, with the reason it was skipped */
  attempts: Array<{ model: string; ok: boolean; ms: number; error?: string; status?: number }>;
  usage?: { promptTokens?: number; completionTokens?: number };
};

/** Errors that mean "try the next model in the chain". */
function isRetryableStatus(status: number): boolean {
  return [401, 402, 408, 409, 429, 500, 502, 503, 504, 520, 522, 524].includes(status);
}

class ModelCallError extends Error {
  constructor(
    readonly status: number,
    readonly model: string,
    message: string,
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

async function callOnce(
  model: string,
  options: CompletionOptions,
  timeoutMs: number,
): Promise<{ content: string; usage?: CompletionResult["usage"] }> {
  const config = getConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort);

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openrouterApiKey}`,
        "Content-Type": "application/json",
        // OpenRouter uses these for attribution / rankings.
        "HTTP-Referer": process.env.PUBLIC_APP_URL ?? "https://localhost",
        "X-Title": "Clinic Webhook AI Bot",
      },
      body: JSON.stringify({
        model,
        messages: options.messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 1200,
        ...(options.topP === undefined ? {} : { top_p: options.topP }),
        ...(options.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = truncate(await response.text().catch(() => ""), 300);
      throw new ModelCallError(response.status, model, `OpenRouter ${response.status}: ${text}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null; reasoning?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };

    if (payload.error?.message) {
      throw new ModelCallError(502, model, payload.error.message);
    }

    const content = payload.choices?.[0]?.message?.content?.trim() ?? "";
    if (!content) {
      throw new ModelCallError(502, model, "Empty completion (free model returned no content)");
    }

    return {
      content,
      usage: {
        promptTokens: payload.usage?.prompt_tokens,
        completionTokens: payload.usage?.completion_tokens,
      },
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Walks the free-model chain until one model answers.
 * Throws an ApiError-ish Error with `code = "ALL_MODELS_FAILED"` when the chain
 * is exhausted, so callers can degrade gracefully.
 */
export async function complete(options: CompletionOptions): Promise<CompletionResult> {
  const config = getConfig();

  if (!config.openrouterApiKey) {
    const error = new Error("OPENROUTER_API_KEY is missing") as Error & { code?: string };
    error.code = "NO_API_KEY";
    throw error;
  }

  const chain = options.modelChain ?? config.modelChain;
  const attempts: CompletionResult["attempts"] = [];

  for (const model of chain) {
    for (let attempt = 0; attempt <= config.modelRetries; attempt += 1) {
      const startedAt = Date.now();
      try {
        const { content, usage } = await callOnce(model, options, config.modelTimeoutMs);
        attempts.push({ model, ok: true, ms: Date.now() - startedAt });
        return { content, model, attempts, usage };
      } catch (error) {
        const status = error instanceof ModelCallError ? error.status : 0;
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({ model, ok: false, ms: Date.now() - startedAt, error: truncate(message, 200), status });

        if (!isRetryableStatus(status)) {
          // Bad request / unknown model → no point retrying, move to next model.
          logWarn("openrouter.model_skipped", { model, status, message: truncate(message, 200) });
          break;
        }

        // Small back-off before retrying or moving on (free pool needs it).
        await new Promise((resolve) => setTimeout(resolve, 300 + attempt * 500));
      }
    }
  }

  const error = new Error("All free models failed") as Error & { code?: string; attempts?: unknown };
  error.code = "ALL_MODELS_FAILED";
  error.attempts = attempts;
  throw error;
}

/**
 * Extract a JSON object from a model answer.
 *
 * Small free models love wrapping JSON in ```json fences or adding a sentence
 * before it, so we try, in order: direct parse → fenced block → first {...} span.
 */
export function parseJsonLoose<T = unknown>(content: string): T {
  const trimmed = content.trim();

  const attempts: string[] = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) attempts.push(fenced[1].trim());

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    attempts.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // keep trying
    }
  }

  // Last resort: remove trailing commas, which is the most common breakage.
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1")) as T;
    } catch {
      // keep trying
    }
  }

  throw new Error("Model did not return parseable JSON");
}
