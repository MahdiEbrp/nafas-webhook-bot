/**
 * STEP-BY-STEP EDITING (ویرایش مرحله‌به‌مرحله)
 *
 * Guides the user through modifying an item field by field with clear
 * stage indicators (مرحله ۱ از ۴), skip options, and confirmation.
 */

import { getActiveEdit, setActiveEdit, clearActiveEdit, type ActiveEditState } from "./session";
import { normalize } from "@/lib/text";

export type EditableFieldDef = {
  key: string;
  labelFa: string;
  promptFa: string;
  type: "text" | "number" | "boolean";
};

export function getEditableFields(featureId: string): EditableFieldDef[] {
  switch (featureId) {
    case "services":
      return [
        { key: "translations.fa.title", labelFa: "عنوان خدمت", promptFa: "عنوان جدید خدمت را وارد کنید:", type: "text" },
        { key: "price", labelFa: "قیمت خدمت", promptFa: "قیمت جدید را به تومان وارد کنید (مثلاً ۵۰۰۰۰۰):", type: "number" },
        { key: "durationMin", labelFa: "مدت زمان", promptFa: "مدت زمان انجام خدمت را به دقیقه وارد کنید (مثلاً ۴۵):", type: "number" },
        { key: "isActive", labelFa: "وضعیت فعال", promptFa: "وضعیت خدمت را مشخص کنید (فعال یا غیرفعال):", type: "boolean" },
      ];
    case "bookings":
      return [
        { key: "fullName", labelFa: "نام مشتری", promptFa: "نام و نام خانوادگی مشتری را وارد کنید:", type: "text" },
        { key: "phone", labelFa: "شماره تماس", promptFa: "شماره تلفن همراه مشتری را وارد کنید:", type: "text" },
        { key: "notes", labelFa: "یادداشت نوبت", promptFa: "یادداشت جدید نوبت را وارد کنید:", type: "text" },
      ];
    case "working-hours":
      return [
        { key: "opens", labelFa: "ساعت شروع", promptFa: "ساعت بازگشایی را وارد کنید (مثلاً 09:00):", type: "text" },
        { key: "closes", labelFa: "ساعت پایان", promptFa: "ساعت پایان کار را وارد کنید (مثلاً 18:00):", type: "text" },
        { key: "isActive", labelFa: "وضعیت روز", promptFa: "وضعیت این روز کاری را مشخص کنید (فعال یا غیرفعال):", type: "boolean" },
      ];
    case "service-categories":
    case "service-groups":
    case "rules":
    case "care-guides":
      return [
        { key: "translations.fa.title", labelFa: "عنوان فارسی", promptFa: "عنوان جدید را به فارسی وارد کنید:", type: "text" },
        { key: "slug", labelFa: "شناسه انگلیسی (slug)", promptFa: "نام کوتاه انگلیسی را وارد کنید (مثلاً skin-care):", type: "text" },
      ];
    case "settings":
      return [
        { key: "value", labelFa: "مقدار تنظیم", promptFa: "مقدار جدید این تنظیم را وارد کنید:", type: "text" },
        { key: "isActive", labelFa: "وضعیت", promptFa: "وضعیت این تنظیم را مشخص کنید (فعال یا غیرفعال):", type: "boolean" },
      ];
    case "care-guide-items":
      return [
        { key: "translations.fa.title", labelFa: "عنوان مورد راهنما", promptFa: "عنوان جدید را وارد کنید:", type: "text" },
      ];
    case "users":
      return [
        { key: "fullName", labelFa: "نام و نام خانوادگی", promptFa: "نام جدید کاربر را وارد کنید:", type: "text" },
        { key: "phone", labelFa: "شماره تلفن", promptFa: "شماره تلفن جدید را وارد کنید:", type: "text" },
        { key: "roleKey", labelFa: "نقش کاربر", promptFa: "نقش کاربر را مشخص کنید (مثلاً admin یا receptionist):", type: "text" },
        { key: "isActive", labelFa: "وضعیت حساب", promptFa: "وضعیت حساب کاربر را مشخص کنید (فعال یا غیرفعال):", type: "boolean" },
      ];
    default:
      return [
        { key: "translations.fa.title", labelFa: "عنوان", promptFa: "عنوان جدید را وارد کنید:", type: "text" },
      ];
  }
}

function toFaDigits(value: number | string): string {
  const faDigits = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
  return String(value).replace(/\d/g, (digit) => faDigits[Number(digit)] ?? digit);
}

export function startStepByStepEdit(params: {
  sessionId: string;
  actionId: string;
  itemId: string;
  itemTitle?: string;
}): { reply: string; state: ActiveEditState } {
  const featureId = params.actionId.split(".")[0] ?? "";
  const fields = getEditableFields(featureId);
  const firstField = fields[0]!;
  const pending = fields.slice(1).map((f) => f.key);

  const state: ActiveEditState = {
    actionId: params.actionId,
    itemId: params.itemId,
    itemTitle: params.itemTitle,
    featureId,
    step: 1,
    totalSteps: fields.length,
    currentField: firstField.key,
    pendingFields: pending,
    collectedValues: {},
    updatedAt: Date.now(),
  };

  setActiveEdit(params.sessionId, state);

  const titlePart = params.itemTitle ? ` برای «${params.itemTitle}»` : "";
  const reply = [
    `ویرایش مرحله‌به‌مرحله${titlePart} آغاز شد. ✏️`,
    "",
    `📌 مرحلهٔ ۱ از ${toFaDigits(state.totalSteps)} (${firstField.labelFa}):`,
    firstField.promptFa,
    "",
    "راهنما: برای حفظ مقدار قبلی بنویسید «رد» یا دکمهٔ «رد این مرحله» را بزنید. برای خروج «لغو» را بفرستید.",
  ].join("\n");

  return { reply, state };
}

function parseFieldValue(fieldDef: EditableFieldDef, raw: string): unknown {
  const norm = normalize(raw).trim();
  if (fieldDef.type === "number") {
    const digits = norm.replace(/[^\d.-]/g, "");
    if (digits) {
      const num = Number(digits);
      if (!Number.isNaN(num)) return num;
    }
  }
  if (fieldDef.type === "boolean") {
    const lower = norm.toLowerCase();
    if (["فعال", "بله", "true", "yes", "1", "روشن"].includes(lower)) return true;
    if (["غیرفعال", "خیر", "نه", "false", "no", "0", "خاموش"].includes(lower)) return false;
  }
  return raw.trim();
}

export function handleStepByStepInput(params: {
  sessionId: string;
  message: string;
}): {
  handled: boolean;
  reply?: string;
  isComplete?: boolean;
  cancelled?: boolean;
  finalParams?: Record<string, unknown>;
  actionId?: string;
  itemTitle?: string;
} {
  const state = getActiveEdit(params.sessionId);
  if (!state) return { handled: false };

  const norm = normalize(params.message).trim();

  // 1. Cancellation check
  if (/^(لغو|انصراف|کنسل|خروج|لغو ویرایش)$/i.test(norm)) {
    clearActiveEdit(params.sessionId);
    return {
      handled: true,
      cancelled: true,
      reply: "ویرایش مرحله‌به‌مرحله لغو شد و هیچ تغییری ثبت نگردید. 👍",
    };
  }

  const fields = getEditableFields(state.featureId);
  const currentDef = fields.find((f) => f.key === state.currentField) ?? {
    key: state.currentField,
    labelFa: state.currentField,
    promptFa: `مقدار «${state.currentField}» را وارد کنید:`,
    type: "text" as const,
  };

  // 2. Skip check
  const isSkip = /^(رد|بدون تغییر|رد شو|رد کن|رد این مرحله|بعدی|skip)$/i.test(norm);
  const nextCollected = { ...state.collectedValues };

  if (!isSkip) {
    const parsed = parseFieldValue(currentDef, params.message);
    nextCollected[state.currentField] = parsed;
  }

  // 3. Any steps left?
  if (state.pendingFields.length === 0) {
    // All steps finished
    clearActiveEdit(params.sessionId);

    if (Object.keys(nextCollected).length === 0) {
      return {
        handled: true,
        reply: "همهٔ مراحل را رد کردید؛ بنابراین تغییری در مشخصات این مورد اعمال نشد. 🙂",
      };
    }

    return {
      handled: true,
      isComplete: true,
      actionId: state.actionId,
      itemTitle: state.itemTitle,
      finalParams: {
        ...nextCollected,
        id: state.itemId,
        ...(state.itemTitle ? { _itemTitle: state.itemTitle } : {}),
      },
    };
  }

  // Move to next step
  const nextKey = state.pendingFields[0]!;
  const remainingPending = state.pendingFields.slice(1);
  const nextStep = state.step + 1;
  const nextDef = fields.find((f) => f.key === nextKey) ?? {
    key: nextKey,
    labelFa: nextKey,
    promptFa: `مقدار «${nextKey}» را وارد کنید:`,
    type: "text" as const,
  };

  const nextState: ActiveEditState = {
    ...state,
    step: nextStep,
    currentField: nextKey,
    pendingFields: remainingPending,
    collectedValues: nextCollected,
    updatedAt: Date.now(),
  };

  setActiveEdit(params.sessionId, nextState);

  const statusPrefix = isSkip ? "این مرحله بدون تغییر رد شد." : "مقدار جدید ثبت شد. ✅";
  const reply = [
    statusPrefix,
    "",
    `📌 مرحلهٔ ${toFaDigits(nextStep)} از ${toFaDigits(state.totalSteps)} (${nextDef.labelFa}):`,
    nextDef.promptFa,
    "",
    "(برای حفظ مقدار قبلی بنویسید «رد» یا دکمهٔ «رد این مرحله» را بزنید)",
  ].join("\n");

  return {
    handled: true,
    reply,
  };
}

export function cancelStepByStepEdit(sessionId: string): boolean {
  clearActiveEdit(sessionId);
  return true;
}
