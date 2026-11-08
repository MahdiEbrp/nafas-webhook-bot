/**
 * Deterministic, offline "first guess" router.
 *
 * Why this exists: free OpenRouter models are small and sometimes answer with
 * a slightly wrong feature id. We compute a cheap lexical guess from the
 * Persian sentence (keyword + verb matching) and hand it to the model as a
 * strong hint. If the model fails completely, we can still fall back to it — the
 * bot keeps working even when the free quota is exhausted.
 */

import { FEATURES, type Feature } from "@/lib/features/manifest";
import { normalizeLower } from "@/lib/text";

export type Intent = "read" | "write" | "delete" | "unknown";

const DELETE_WORDS = ["حذف", "پاک کن", "پاکش کن", "بردار", "بنداز", "delete", "remove"];
const WRITE_WORDS = [
  "بساز", "ایجاد", "اضافه کن", "ثبت کن", "جدید", "تغییر", "عوض کن", "ویرایش", "آپدیت",
  "اصلاح", "فعال کن", "غیرفعال کن", "بن کن", "لغو کن", "کنسل کن", "بلاک کن",
  "create", "add", "update", "change", "edit", "cancel", "activate", "deactivate", "ban",
];
const READ_WORDS = [
  "نشون", "نشان", "ببین", "لیست", "فهرست", "چند", "چیست", "چیا", "چیه", "کو", "کدام",
  "گزارش", "جستجو", "سرچ", "بگرد", "بیار", "بگیر", "وضعیت",
  "چه", "چی", "هست", "داریم", "داری", "آمار", "اطلاعات", "بررسی", "خبر",
  "show", "list", "get", "find", "search", "what", "how many", "report",
];

export type RouteGuess = {
  intent: Intent;
  feature: Feature | null;
  actionId: string | null;
  score: number;
  matchedKeywords: string[];
  runnerUp: Feature | null;
};

function includesAny(haystack: string, needles: string[]): string[] {
  return needles.filter((needle) => haystack.includes(needle));
}

export function detectIntent(message: string): Intent {
  const text = normalizeLower(message);
  // delete wins over write ("نوبت رو حذف کن" is not an update)
  if (includesAny(text, DELETE_WORDS).length > 0) return "delete";
  if (includesAny(text, WRITE_WORDS).length > 0) return "write";
  if (includesAny(text, READ_WORDS).length > 0) return "read";
  return "read";
}

function scoreFeature(text: string, feature: Feature): { score: number; matched: string[] } {
  let score = 0;
  const matched: string[] = [];
  for (const keyword of feature.keywords) {
    const needle = normalizeLower(keyword);
    if (!needle) continue;
    if (text.includes(needle)) {
      // Long, specific keywords ("ساعت کاری") beat short generic ones ("گروه").
      score += Math.min(4, Math.max(1, Math.round(needle.length / 4)));
      matched.push(keyword);
    }
  }
  return { score, matched };
}

export function pickAction(feature: Feature, intent: Intent, message: string): string | null {
  const text = normalizeLower(message);
  const byIntent = (danger: string) => feature.actions.find((action) => action.danger === danger);

  if (intent === "delete") {
    return byIntent("destructive")?.id ?? null;
  }

  if (intent === "write") {
    const isCreate = includesAny(text, ["بساز", "ایجاد", "اضافه", "ثبت", "جدید", "create", "add"]).length > 0;
    if (isCreate) return feature.actions.find((a) => a.id.endsWith(".create"))?.id ?? byIntent("write")?.id ?? null;
    return feature.actions.find((a) => a.id.endsWith(".update") || a.id.endsWith(".update-status"))?.id ?? byIntent("write")?.id ?? null;
  }

  if (intent === "read") {
    // "جزئیات این نوبت" / a bare uuid → single get, otherwise the list.
    const looksSingle = /[0-9a-f]{8}-[0-9a-f]{4}/i.test(text);
    if (looksSingle) return feature.actions.find((a) => a.id.endsWith(".get"))?.id ?? byIntent("read")?.id ?? null;
    return feature.actions.find((a) => a.id.endsWith(".list"))?.id ?? byIntent("read")?.id ?? null;
  }

  return feature.actions.find((a) => a.id.endsWith(".list"))?.id ?? feature.actions[0]?.id ?? null;
}

export function routeMessage(message: string): RouteGuess {
  const text = normalizeLower(message);
  const scored = FEATURES.map((feature) => ({ feature, ...scoreFeature(text, feature) })).sort(
    (a, b) => b.score - a.score,
  );

  const best = scored[0];
  const runnerUp = scored[1]?.feature ?? null;
  const intent = detectIntent(message);

  if (!best || best.score === 0) {
    return { intent, feature: null, actionId: null, score: 0, matchedKeywords: [], runnerUp };
  }

  return {
    intent,
    feature: best.feature,
    actionId: pickAction(best.feature, intent, message),
    score: best.score,
    matchedKeywords: best.matched,
    runnerUp,
  };
}
