/**
 * The orchestrator — one public function, `handleChat`.
 *
 *   فهمیدن (AI)  →  تأیید (کد)  →  درخواست (کد)  →  توضیح (AI)
 *
 * Endpoint: POST /api/chat
 */

import { getConfig, type Locale } from "@/lib/config";
import { FEATURES, getAction } from "@/lib/features/manifest";
import { logInfo, logWarn } from "@/lib/log";

import { confirmationText, clarifyText, explain } from "./explainer";
import { executeRequest, preparePlan, previewRequest, type PreparedRequest } from "./executor";
import { featureTitleList, featuresAnswer } from "./features-answer";
import { planRequest, type PlannerResult } from "./planner";
import { validatePlan, type ValidatedPlan } from "./plan";
import { previousTurn, rememberTurn, savePending, takePending } from "./session";

export type ChatInput = {
  message: string;
  sessionId: string;
  locale: Locale;
  /** answer to a previous confirmation card */
  confirm?: { token: string; approve: boolean };
  /** if true, a write is only described, never executed */
  dryRun?: boolean;
  /**
   * Skip the planner and jump straight to an action.
   * Used by UI affordances that already know what they want: Telegram inline
   * buttons, dashboards, "quick action" links.
   */
  direct?: { actionId: string; params?: Record<string, unknown> };
};

export type ChatStatus = "answered" | "needs_info" | "needs_confirmation" | "done" | "error";

export type ChatResult = {
  status: ChatStatus;
  reply: string;
  understood: string;
  intent: string;
  actionId: string | null;
  questions?: string[];
  confirmation?: {
    token: string;
    summaryFa: string;
    method: string;
    path: string;
    permission: string;
    danger: string;
    body?: unknown;
  };
  result?: {
    ok: boolean;
    httpStatus: number;
    code?: string;
    requestId?: string;
    data?: unknown;
    ms?: number;
  };
  trace: {
    planner: "ai" | "router";
    writer: "ai" | "fallback";
    plannerModel: string | null;
    writerModel: string | null;
    notice: string | null;
    ms: number;
  };
};

function summarizeForMemory(data: unknown): string {
  if (Array.isArray(data)) return `${data.length} مورد`;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const keys = Object.keys(record).slice(0, 4);
    return keys.length > 0 ? `فیلدهای ${keys.join(", ")}` : "یک آبجکت";
  }
  return "بدون داده";
}

async function runAndExplain(
  request: PreparedRequest,
  input: ChatInput,
  trace: ChatResult["trace"],
): Promise<ChatResult> {
  const result = await executeRequest(request);

  const explanation = await explain({
    userMessage: input.message,
    actionId: request.actionId,
    outcome: !result.ok ? "error" : Array.isArray(result.data) || (result.data && typeof result.data === "object" && Object.keys(result.data as object).length > 0) ? "success" : "empty",
    data: result.ok ? result.data : undefined,
    errorCode: result.ok ? undefined : result.code,
    errorMessage: result.ok ? undefined : result.message,
    locale: input.locale,
  });

  trace.writer = explanation.engine;
  trace.writerModel = explanation.model;

  await rememberTurn(input.sessionId, {
    userMessage: input.message,
    actionId: request.actionId,
    summary: result.ok ? summarizeForMemory(result.data) : `خطا: ${result.code}`,
  });

  return {
    status: result.ok ? "done" : "error",
    reply: explanation.text,
    understood: request.summaryFa,
    intent: request.danger === "read" ? "read" : request.danger === "destructive" ? "delete" : "write",
    actionId: request.actionId,
    result: result.ok
      ? { ok: true, httpStatus: result.status, requestId: result.requestId, data: result.data, ms: result.ms }
      : { ok: false, httpStatus: result.status, code: result.code, requestId: result.requestId, ms: result.ms },
    trace,
  };
}

function askForInfo(plan: ValidatedPlan, questions: string[], trace: ChatResult["trace"]): ChatResult {
  const intro =
    plan.actionValid && plan.actionId
      ? "برای ثبت و تکمیل این درخواست، این اطلاعات را لازم دارم:"
      : "برای انجام این کار به اطلاعات بیشتری نیاز دارم:";
  return {
    status: "needs_info",
    reply: [intro, ...questions.map((question) => `• ${question}`)].join("\n"),
    understood: plan.understood || plan.actionId || "",
    intent: plan.intent,
    actionId: plan.actionId ?? null,
    questions,
    trace,
  };
}

/** A plan that came from a button, not from a sentence. */
function directPlan(direct: { actionId: string; params?: Record<string, unknown> }): PlannerResult {
  const found = getAction(direct.actionId);
  const intent = found ? (found.action.danger === "read" ? "read" : found.action.danger === "destructive" ? "delete" : "write") : "read";

  const plan = validatePlan(
    {
      intent,
      actionId: direct.actionId,
      params: direct.params ?? {},
      missing: [],
      understood: found ? found.action.fa : direct.actionId,
      reply: "",
      confidence: 1,
    },
    "router",
  );

  return { plan, engine: "router", model: null, notice: null, attempts: [], ms: 0 };
}

export async function handleChat(input: ChatInput): Promise<ChatResult> {
  const startedAt = Date.now();
  const config = getConfig();
  const trace: ChatResult["trace"] = {
    planner: "router",
    writer: "fallback",
    plannerModel: null,
    writerModel: null,
    notice: null,
    ms: 0,
  };

  /* ── 1. Answering a confirmation card ─────────────────────────────── */
  if (input.confirm) {
    const pending = await takePending(input.confirm.token, input.sessionId);
    if (!pending) {
      return {
        status: "error",
        reply:
          "این تأییدیه دیگر معتبر نیست (منقضی شده یا مربوط به گفت‌وگوی دیگری است).\nلطفاً درخواستت را یک‌بار دیگر بنویس تا دوباره آماده کنم.",
        understood: "",
        intent: "write",
        actionId: null,
        trace: { ...trace, ms: Date.now() - startedAt },
      };
    }

    if (!input.confirm.approve) {
      logInfo("bot.confirmation_declined", { actionId: pending.plan.actionId });
      await rememberTurn(input.sessionId, { userMessage: input.message, actionId: pending.plan.actionId ?? null, summary: "کاربر لغو کرد" });
      return {
        status: "answered",
        reply: "درخواست لغو شد و انجام ندادم. 👍\nهر زمان نیاز داشتید، بفرمایید تا اقدام کنم.",
        understood: pending.summaryFa,
        intent: pending.plan.intent,
        actionId: pending.plan.actionId ?? null,
        trace: { ...trace, ms: Date.now() - startedAt },
      };
    }

    const prepared = preparePlan(pending.plan.actionId ?? "", pending.plan.params);
    if (prepared.kind !== "ready") {
      const questions = prepared.kind === "needs_info" ? prepared.questions : ["این کار دیگر پشتیبانی نمی‌شود."];
      return askForInfo(
        { ...pending.plan, actionValid: false, invalidActionId: null, source: "model" },
        questions,
        { ...trace, ms: Date.now() - startedAt },
      );
    }

    logInfo("bot.confirmation_approved", { actionId: prepared.request.actionId });
    const result = await runAndExplain(prepared.request, input, trace);
    return { ...result, trace: { ...trace, ms: Date.now() - startedAt } };
  }

  /* ── 2. Understand the sentence (or take the button's word for it) ── */
  const previous = await previousTurn(input.sessionId);
  const planned = input.direct
    ? directPlan(input.direct)
    : await planRequest({
        message: input.message,
        locale: input.locale,
        previous: previous
          ? { userMessage: previous.userMessage, actionId: previous.actionId, summary: previous.summary }
          : null,
      });

  trace.planner = planned.engine;
  trace.plannerModel = planned.model;
  trace.notice = planned.notice;

  const plan = planned.plan;
  const finish = (result: ChatResult): ChatResult => ({ ...result, trace: { ...trace, ms: Date.now() - startedAt } });

  /* ── 3. Talking, not acting ───────────────────────────────────────── */
  if (plan.intent === "features") {
    const reply = plan.reply && plan.reply.length > 30 ? plan.reply : featuresAnswer(input.locale);
    await rememberTurn(input.sessionId, { userMessage: input.message, actionId: null, summary: "لیست امکانات" });
    return finish({
      status: "answered",
      reply,
      understood: plan.understood || "می‌خواهی بدانی چه کارهایی بلدم.",
      intent: plan.intent,
      actionId: null,
      trace,
    });
  }

  if (plan.intent === "smalltalk" || plan.intent === "out_of_scope") {
    const featureCount = FEATURES.filter((feature) => feature.available).length;
    const reply =
      plan.reply && plan.reply.length > 5
        ? plan.reply
        : input.locale === "en"
          ? `Hi! I can work with ${featureCount} parts of the clinic system (bookings, services, staff, settings…). Ask me something like "show today's bookings".`
          : `سلام! وقت بخیر 🙂\nمن دستیار کلینیک هستم و در بخش‌های نوبت‌ها، خدمات، ساعات کاری، پرسنل و تنظیمات سیستم می‌توانم به شما کمک کنم.\nبرای نمونه می‌توانید بفرمایید: «نوبت‌های امروز را نشان بده» یا «ساعت کاری شنبه‌ها».`;
    await rememberTurn(input.sessionId, { userMessage: input.message, actionId: null, summary: "گفت‌وگوی عمومی" });
    return finish({
      status: "answered",
      reply,
      understood: plan.understood || "",
      intent: plan.intent,
      actionId: null,
      trace,
    });
  }

  /* ── 4. Acting ────────────────────────────────────────────────────── */
  if (!plan.actionId || !plan.actionValid) {
    logWarn("bot.no_action", { intent: plan.intent, invalidActionId: plan.invalidActionId });
    return finish({
      status: "answered",
      reply: clarifyText(featureTitleList(input.locale)),
      understood: plan.understood || "نفهمیدم",
      intent: plan.intent,
      actionId: null,
      trace,
    });
  }

  const prepared = preparePlan(plan.actionId, plan.params);
  if (prepared.kind === "unknown_action") {
    return finish({
      status: "answered",
      reply: clarifyText(featureTitleList(input.locale)),
      understood: plan.understood,
      intent: plan.intent,
      actionId: plan.actionId,
      trace,
    });
  }
  if (prepared.kind === "needs_info") {
    await rememberTurn(input.sessionId, { userMessage: input.message, actionId: plan.actionId, summary: "اطلاعات کم بود" });
    return finish(askForInfo(plan, prepared.questions, trace));
  }

  const request = prepared.request;

  // Reads are safe and cheap → run immediately.
  if (request.danger === "read") {
    const result = await runAndExplain(request, input, trace);
    return { ...result, trace: { ...trace, ms: Date.now() - startedAt } };
  }

  // Writes/deletes: dry-run → confirmation card, unless auto-write is enabled
  // for non-destructive writes.
  const autoAllowed = config.allowAutoWrite && request.danger === "write" && !input.dryRun;

  if (autoAllowed) {
    logInfo("bot.autowrite", { actionId: request.actionId });
    const result = await runAndExplain(request, input, trace);
    return { ...result, trace: { ...trace, ms: Date.now() - startedAt } };
  }

  const token = crypto.randomUUID();
  const preview = previewRequest(request);
  await savePending({
    token,
    sessionId: input.sessionId,
    plan: { ...plan, params: plan.params },
    userMessage: input.message,
    summaryFa: request.summaryFa,
  });

  logInfo("bot.confirmation_requested", { actionId: request.actionId, danger: request.danger });

  return finish({
    status: "needs_confirmation",
    reply: confirmationText(request.summaryFa, request.danger, request.permission),
    understood: plan.understood || request.summaryFa,
    intent: plan.intent,
    actionId: request.actionId,
    confirmation: {
      token,
      summaryFa: request.summaryFa,
      method: preview.method,
      path: preview.path,
      permission: preview.permission,
      danger: preview.danger,
      body: input.dryRun ? preview.body : preview.body,
    },
    trace,
  });
}
