/**
 * Minimal OpenRouter client tuned for FREE models — the bot's only brain.
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
import { selectChain, type SelectionSource } from "./select";
import { getStat, recordFailure, recordSuccess } from "./stats";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
};

export type ChatTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type CompletionOptions = {
  messages: ChatMessage[];
  /** Ask the model for a JSON object (response_format). Supported by all defaults. */
  json?: boolean;
  /** OpenAI-compatible function tools, used by library-level assistants. */
  tools?: ChatTool[];
  toolChoice?: "auto" | "none";
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
  toolCalls?: ChatToolCall[];
  /**
   * The provider's `finish_reason`. `"length"` means max_tokens ran out and the
   * answer stops mid-sentence — callers must not show that to a user.
   */
  finishReason: string | null;
  /** every model we tried, in order, with the reason it was skipped */
  attempts: Array<{ model: string; ok: boolean; ms: number; error?: string; status?: number }>;
  /** how the chain was chosen: auto (live catalog), fixed, or fallback */
  selection: SelectionSource;
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
): Promise<{ content: string; usage?: CompletionResult["usage"]; finishReason: string | null; toolCalls?: ChatToolCall[] }> {
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
        "X-Title": "Nafas Chat Bot",
      },
      body: JSON.stringify({
        model,
        messages: options.messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 1200,
        ...(options.topP === undefined ? {} : { top_p: options.topP }),
        ...(options.json ? { response_format: { type: "json_object" } } : {}),
        ...(options.tools ? { tools: options.tools, tool_choice: options.toolChoice ?? "auto" } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = truncate(await response.text().catch(() => ""), 300);
      throw new ModelCallError(response.status, model, `OpenRouter ${response.status}: ${text}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string | null; reasoning?: string | null; tool_calls?: ChatToolCall[] };
        finish_reason?: string | null;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };

    if (payload.error?.message) {
      throw new ModelCallError(502, model, payload.error.message);
    }

    const choice = payload.choices?.[0];
    const content = choice?.message?.content?.trim() ?? "";
    // Some providers put analysis in content instead of their reasoning field.
    // Reject the whole completion and try the next model; never guess where a
    // safe final answer begins inside a leaked or truncated analysis.
    if (containsAnalysis(content)) {
      throw new ModelCallError(502, model, "Completion contained analysis instead of a final answer");
    }
    const toolCalls = choice?.message?.tool_calls?.filter((call) =>
      call.type === "function" && typeof call.id === "string"
      && typeof call.function?.name === "string" && typeof call.function?.arguments === "string",
    );
    if (!content && (!toolCalls || toolCalls.length === 0)) {
      throw new ModelCallError(502, model, "Empty completion (free model returned no content or tool call)");
    }

    return {
      content,
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      finishReason: choice?.finish_reason ?? null,
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
 * Walks the model chain until one model answers.
 *
 * The chain comes from `selectChain()`: the best free models from the live
 * catalog, ordered by quality and measured speed. Every outcome is fed back
 * into `lib/openrouter/stats.ts`, so the next call already knows that the
 * winner was slow or that the runner-up is rate-limited.
 *
 * Throws an Error with `code = "ALL_MODELS_FAILED"` when the chain is
 * exhausted, so callers can degrade gracefully.
 */
export async function complete(options: CompletionOptions): Promise<CompletionResult> {
  const config = getConfig();

  if (!config.openrouterApiKey) {
    const error = new Error("OPENROUTER_API_KEY is missing") as Error & { code?: string };
    error.code = "NO_API_KEY";
    throw error;
  }

  // An explicit chain wins (tests, and callers that must pin a model).
  const selection = options.modelChain ? null : await selectChain();
  const chain = options.modelChain ?? selection?.chain ?? config.modelChain;
  const source: SelectionSource = options.modelChain ? "fixed" : selection?.source ?? "fixed";

  // An auto-selected pool is already redundant, so each model gets one shot:
  // trying four models once beats trying one model four times.
  const shotsPerModel = options.modelChain ? config.modelRetries + 1 : 1;
  const attempts: CompletionResult["attempts"] = [];

  for (const model of chain) {
    for (let attempt = 0; attempt < shotsPerModel; attempt += 1) {
      const startedAt = Date.now();
      try {
        const { content, usage, finishReason, toolCalls } = await callOnce(model, options, config.modelTimeoutMs);
        const ms = Date.now() - startedAt;
        recordSuccess(model, ms);
        attempts.push({ model, ok: true, ms });
        return { content, model, ...(toolCalls ? { toolCalls } : {}), finishReason, attempts, usage, selection: source };
      } catch (error) {
        const status = error instanceof ModelCallError ? error.status : 0;
        const message = error instanceof Error ? error.message : String(error);
        const ms = Date.now() - startedAt;
        attempts.push({ model, ok: false, ms, error: truncate(message, 200), status });

        // Longer cooldown the more often this model has failed in a row.
        const previous = getStat(model)?.consecutiveFailures ?? 0;
        recordFailure(model, {
          status,
          error: truncate(message, 200),
          cooldownMs: config.modelCooldownMs * Math.min(4, previous + 1),
        });

        if (!isRetryableStatus(status)) {
          // Bad request / unknown model → no point retrying, move to next model.
          logWarn("openrouter.model_skipped", { model, status, message: truncate(message, 200) });
          break;
        }

        // Small back-off before retrying or moving on (free pool needs it).
        if (attempt + 1 < shotsPerModel) {
          await new Promise((resolve) => setTimeout(resolve, 300 + attempt * 500));
        }
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

/** Conservative detection of known provider analysis envelopes. */
export function containsAnalysis(content: string): boolean {
  return /<\/?(?:think|analysis|reasoning)>|(?:^|\n)\s*(?:\d+[.)]\s*)?(?:\*{0,2})(?:Analyze the Request|Analysis of the Request|Formulate the Response|Determine the Next Step|Refining against constraints|Final Polish|Drafting the Response)\b/iu.test(content);
}
