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
import { slotsForAction } from "@/lib/features/extract";
import { detectIntent } from "@/lib/features/router";

import { confirmationText, clarifyText, explain, pickArray } from "./explainer";
import { executeRequest, preparePlan, previewRequest, type PreparedRequest } from "./executor";
import { featureTitleList, featuresAnswer } from "./features-answer";
import { planRequest, type PlannerResult } from "./planner";
import { validatePlan, type ValidatedPlan } from "./plan";
import { handleStepByStepInput, startStepByStepEdit } from "./editing";
import {
  findSessionItem,
  getLastPageInfo,
  previousTurn,
  rememberTurn,
  savePending,
  saveSessionItems,
  takePending,
} from "./session";

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
    fromCache?: boolean;
    timeTravel?: boolean;
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

  if ((result as { fromCache?: boolean }).fromCache) trace.fromCache = true;
  if ((result as { timeTravel?: boolean }).timeTravel) trace.timeTravel = true;

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

  if (result.ok && result.data && request.actionId.endsWith(".list")) {
    const featureId = request.actionId.split(".")[0] ?? "";
    const list = pickArray(result.data);
    if (list && list.rows.length > 0) {
      saveSessionItems(
        input.sessionId,
        featureId,
        list.rows,
        typeof request.query.page === "number" ? Number(request.query.page) : list.page,
        typeof request.query.perPage === "number" ? Number(request.query.perPage) : list.perPage,
      );
    }
  }

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

  /* ── 0. Step-by-step editing in progress ───────────────────────────── */
  if (!input.direct && !input.confirm) {
    const editStep = handleStepByStepInput({
      sessionId: input.sessionId,
      message: input.message,
    });

    if (editStep.handled) {
      if (editStep.cancelled || (!editStep.isComplete && editStep.reply)) {
        return {
          status: "answered",
          reply: editStep.reply ?? "",
          understood: "ویرایش مرحله‌به‌مرحله",
          intent: "write",
          actionId: null,
          trace: { ...trace, ms: Date.now() - startedAt },
        };
      }

      if (editStep.isComplete && editStep.finalParams && editStep.actionId) {
        const prepared = preparePlan(editStep.actionId, editStep.finalParams);
        if (prepared.kind === "ready") {
          const autoAllowed = config.allowAutoWrite && prepared.request.danger === "write" && !input.dryRun;
          if (autoAllowed) {
            logInfo("bot.autowrite.step_by_step", { actionId: prepared.request.actionId });
            const result = await runAndExplain(prepared.request, input, trace);
            return { ...result, trace: { ...trace, ms: Date.now() - startedAt } };
          }

          const token = crypto.randomUUID();
          const preview = previewRequest(prepared.request);
          await savePending({
            token,
            sessionId: input.sessionId,
            plan: {
              actionId: editStep.actionId,
              params: editStep.finalParams,
              intent: "write",
              missing: [],
              understood: prepared.request.summaryFa,
              reply: "",
              confidence: 1,
            },
            userMessage: input.message,
            summaryFa: prepared.request.summaryFa,
          });

          return {
            status: "needs_confirmation",
            reply: `مراحل ویرایش تکمیل شد! 🎯\n\n${confirmationText(prepared.request.summaryFa, prepared.request.danger, prepared.request.permission)}`,
            understood: prepared.request.summaryFa,
            intent: "write",
            actionId: prepared.request.actionId,
            confirmation: {
              token,
              summaryFa: prepared.request.summaryFa,
              method: preview.method,
              path: preview.path,
              permission: preview.permission,
              danger: preview.danger,
              body: preview.body,
            },
            trace: { ...trace, ms: Date.now() - startedAt },
          };
        } else if (prepared.kind === "needs_info") {
          return askForInfo(
            {
              actionId: editStep.actionId,
              params: editStep.finalParams,
              intent: "write",
              actionValid: true,
              invalidActionId: null,
              missing: [],
              understood: "ویرایش",
              reply: "",
              confidence: 1,
              source: "router",
            },
            prepared.questions,
            { ...trace, ms: Date.now() - startedAt },
          );
        }
      }
    }
  }

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

  /* ── 1.5 Pagination requests ── */
  const pageMatch = input.message.match(/(?:برو به\s*)?صفحه\s*(بعد|قبل|\d+)|(موارد\s*بیشتر|بقیه\s*موارد|ادامه)/);
  if (pageMatch && !input.direct) {
    const last = getLastPageInfo(input.sessionId);
    if (last.actionId) {
      const currentPage = last.page ?? 1;
      let targetPage = currentPage;
      if (pageMatch[1] === "بعد" || pageMatch[2]) targetPage = currentPage + 1;
      else if (pageMatch[1] === "قبل") targetPage = Math.max(1, currentPage - 1);
      else if (pageMatch[1]) targetPage = Math.max(1, Number(pageMatch[1]));

      return await handleChat({
        ...input,
        direct: { actionId: last.actionId, params: { page: targetPage } },
      });
    }
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

  if (plan.intent === "smalltalk" || plan.intent === "out_of_scope" || !plan.actionId) {
    const matchedItem = findSessionItem(input.sessionId, input.message);
    if (matchedItem) {
      const slots = slotsForAction(input.message, undefined);
      const intent = detectIntent(input.message);
      const isWrite = intent === "write";
      const isDelete = intent === "delete";

      let resolvedActionId: string | null = null;
      if (isDelete) {
        resolvedActionId = `${matchedItem.featureId}.delete`;
      } else if (isWrite || Object.keys(slots).length > 0) {
        resolvedActionId = `${matchedItem.featureId}.update`;
      }

      if (resolvedActionId) {
        plan.intent = isDelete ? "delete" : "write";
        plan.actionId = resolvedActionId;
        plan.actionValid = true;
        plan.params = { ...slots, id: matchedItem.id, _itemTitle: matchedItem.name };
        if (slots.status === "inactive") plan.params.isActive = false;
        if (slots.status === "active") plan.params.isActive = true;
        logInfo("bot.action_inferred_from_item", { actionId: resolvedActionId, id: matchedItem.id, name: matchedItem.name });
      }
    }
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
  if (plan.actionId && !plan.actionId.endsWith(".list") && !plan.params.id) {
    const matched = findSessionItem(input.sessionId, input.message);
    if (matched) {
      plan.params.id = matched.id;
      plan.params._itemTitle = matched.name;
      logInfo("bot.item_resolved_from_session", { id: matched.id, name: matched.name, actionId: plan.actionId });
    }
  }

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

  // Step-by-step editing trigger
  if (plan.actionId && plan.actionId.endsWith(".update") && plan.params.id) {
    const editKeys = Object.keys(plan.params).filter((k) => k !== "id" && !k.startsWith("_"));
    const wantsStepByStep = input.message.includes("مرحله") || editKeys.length === 0;
    if (wantsStepByStep) {
      const stepEdit = startStepByStepEdit({
        sessionId: input.sessionId,
        actionId: plan.actionId,
        itemId: String(plan.params.id),
        itemTitle: typeof plan.params._itemTitle === "string" ? plan.params._itemTitle : undefined,
      });
      return finish({
        status: "answered",
        reply: stepEdit.reply,
        understood: `آغاز ویرایش مرحله‌به‌مرحله ${plan.params._itemTitle ?? ""}`.trim(),
        intent: "write",
        actionId: plan.actionId,
        trace,
      });
    }
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
