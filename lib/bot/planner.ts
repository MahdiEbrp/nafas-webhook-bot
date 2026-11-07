/**
 * STAGE 1 — understand the user.
 *
 * Persian sentence → Plan (feature + action + params).
 *
 * Three layers of safety, in order:
 *   1. A free OpenRouter model produces the plan as JSON.
 *   2. Zod + the manifest validate it (`validatePlan`).
 *   3. If the model fails, times out, or the free quota is gone, the offline
 *      lexical router still produces a usable plan. The bot degrades, it never
 *      crashes — which matters a lot when you run on free models.
 */

import { getConfig, type Locale } from "@/lib/config";
import { extractSlots, slotsForAction } from "@/lib/features/extract";
import { getFeature } from "@/lib/features/manifest";
import { routeMessage } from "@/lib/features/router";
import { logWarn } from "@/lib/log";
import { complete, parseJsonLoose } from "@/lib/openrouter/client";
import { normalize } from "@/lib/text";

import { emptyPlan, planSchema, validatePlan, type Plan, type ValidatedPlan } from "./plan";
import { PLANNER_SYSTEM_EN, PLANNER_SYSTEM_FA, plannerContext, plannerUserPrompt } from "./prompt";

export type PlannerResult = {
  plan: ValidatedPlan;
  engine: "ai" | "router";
  model: string | null;
  /** human-readable Persian note when we had to fall back */
  notice: string | null;
  attempts: Array<{ model: string; ok: boolean; ms: number; error?: string; status?: number }>;
  ms: number;
};

const FEATURE_QUESTION_PATTERNS = [
  /چه کار(هایی|ها)?/,
  /چیکار/,
  /امکانات/,
  /قابلیت/,
  /می ?تونی/,
  /بلدی/,
  /دستت/i,
  /help|capabilit|what can you/i,
];

function looksLikeCapabilityQuestion(message: string): boolean {
  const text = normalize(message);
  return FEATURE_QUESTION_PATTERNS.some((pattern) => pattern.test(text));
}

function routerOnlyPlan(message: string, note: string): { plan: ValidatedPlan; notice: string } {
  const guess = routeMessage(message);

  if (!guess.feature || !guess.actionId) {
    const plan = validatePlan(
      {
        ...emptyPlan(looksLikeCapabilityQuestion(message) ? "features" : "smalltalk"),
        reply: looksLikeCapabilityQuestion(message) ? "" : "",
        confidence: 0.2,
      },
      "router",
    );
    return { plan, notice: note };
  }

  const intent = guess.intent === "unknown" ? "read" : guess.intent;
  const action = getFeature(guess.feature.id)?.actions.find((candidate) => candidate.id === guess.actionId);
  // No model → still pull literal values (uuid, phone, day, price…) out of the sentence.
  const params = slotsForAction(message, action?.fields);

  const plan = validatePlan(
    {
      intent,
      actionId: guess.actionId,
      params,
      missing: [],
      understood: `حدس من: ${guess.feature.titleFa} — ${guess.actionId}`,
      reply: "",
      confidence: Math.min(0.6, 0.25 + guess.score / 10),
    },
    "router",
  );

  return { plan, notice: note };
}

function buildRouterHint(message: string): string {
  const guess = routeMessage(message);
  const slots = extractSlots(message);
  const slotText = Object.entries(slots).length > 0 ? `مقادیری که در جمله دیدم: ${JSON.stringify(slots)}` : "";
  if (!guess.feature) return ["حدس موتور کلمات کلیدی: چیزی پیدا نشد.", slotText].filter(Boolean).join(" | ");
  return [
    `حدس موتور کلمات کلیدی (فقط یک راهنما، خودت تصمیم بگیر): feature=${guess.feature.id}`,
    guess.actionId ? `action=${guess.actionId}` : "",
    `کلمات کلیدی که دید: ${guess.matchedKeywords.join(", ") || "—"}`,
    slotText,
  ]
    .filter(Boolean)
    .join(" | ");
}

export async function planRequest(input: {
  message: string;
  locale: Locale;
  previous?: { userMessage: string; actionId: string | null; summary: string } | null;
  signal?: AbortSignal;
}): Promise<PlannerResult> {
  const startedAt = Date.now();
  const config = getConfig();
  const system = input.locale === "en" ? PLANNER_SYSTEM_EN : PLANNER_SYSTEM_FA;

  const messages = [
    { role: "system" as const, content: system },
    {
      role: "user" as const,
      content: plannerUserPrompt(input.message, [plannerContext(input.previous ?? null), buildRouterHint(input.message)].filter(Boolean).join("\n")),
    },
  ];

  try {
    const first = await complete({
      messages,
      json: true,
      temperature: 0.1,
      maxTokens: 700,
      signal: input.signal,
    });

    let raw: unknown;
    try {
      raw = parseJsonLoose(first.content);
    } catch {
      // One cheap repair attempt — the most common free-model failure.
      const repaired = await complete({
        messages: [
          ...messages,
          { role: "assistant" as const, content: first.content.slice(0, 1500) },
          { role: "user" as const, content: "این JSON نبود. فقط و فقط یک آبجکت JSON معتبر با همان کلیدها برگردان." },
        ],
        json: true,
        temperature: 0,
        maxTokens: 700,
        signal: input.signal,
      });
      raw = parseJsonLoose(repaired.content);
      first.attempts.push(...repaired.attempts);
    }

    const parsed = planSchema.safeParse(raw);
    if (!parsed.success) {
      logWarn("planner.schema_mismatch", { issues: parsed.error.issues });
      const fallback = routerOnlyPlan(input.message, "جواب مدل شکل درستی نداشت، از حدس خودم استفاده کردم.");
      return {
        plan: fallback.plan,
        engine: "router",
        model: first.model,
        notice: fallback.notice,
        attempts: first.attempts,
        ms: Date.now() - startedAt,
      };
    }

    let validated = validatePlan(parsed.data, "model");

    // Model named a real action but with a mismatched danger, or invented one:
    // trust the offline router instead of running something unexpected.
    if (parsed.data.actionId && !validated.actionValid) {
      const guess = routeMessage(input.message);
      if (guess.actionId) {
        validated = validatePlan(
          { ...parsed.data, actionId: guess.actionId, intent: guess.intent === "unknown" ? parsed.data.intent : guess.intent },
          "merged",
        );
      } else {
        validated = validatePlan({ ...parsed.data, actionId: null }, "merged");
      }
    }

    // Capability questions never need an HTTP call.
    if (looksLikeCapabilityQuestion(input.message) && !validated.actionValid) {
      validated = validatePlan({ ...validated, intent: "features", actionId: null }, "merged");
    }

    return {
      plan: validated,
      engine: "ai",
      model: first.model,
      notice: null,
      attempts: first.attempts,
      ms: Date.now() - startedAt,
    };
  } catch (error) {
    const code = (error as { code?: string }).code ?? "MODEL_ERROR";
    logWarn("planner.fallback", { code, models: config.modelChain.length });

    const notice =
      code === "NO_API_KEY"
        ? "کلید OpenRouter تنظیم نشده، پس با موتور کلمات کلیدی کار کردم."
        : code === "ALL_MODELS_FAILED"
          ? "همهٔ مدل‌های مجانی الان شلوغ بودند، پس با موتور کلمات کلیدی کار کردم."
          : "مدل جواب نداد، با موتور کلمات کلیدی کار کردم.";

    const fallback = routerOnlyPlan(input.message, notice);
    return {
      plan: fallback.plan,
      engine: "router",
      model: null,
      notice: fallback.notice,
      attempts: ((error as { attempts?: PlannerResult["attempts"] }).attempts ?? []) as PlannerResult["attempts"],
      ms: Date.now() - startedAt,
    };
  }
}

export type { Plan, ValidatedPlan };
