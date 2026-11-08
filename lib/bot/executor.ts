/**
 * STAGE 2 — turn a plan into exactly one HTTP call.
 *
 * Everything in this file is deterministic. The AI cannot widen its own
 * permissions, choose its own URL, or skip confirmation, because the action has
 * to exist in the manifest first.
 */

import { getAction, type FeatureAction } from "@/lib/features/manifest";
import { REQUIREMENTS, questionFor } from "@/lib/features/requirements";
import { normalize } from "@/lib/text";
import { callWebhook, type WebhookResult } from "@/lib/webhooks/client";
import { fetchWithCache, invalidateResource } from "./cache";

export type PreparedRequest = {
  actionId: string;
  method: FeatureAction["method"];
  path: string;
  permission: string;
  danger: FeatureAction["danger"];
  pathParams: Record<string, string>;
  query: Record<string, string | number | boolean>;
  body: unknown;
  summaryFa: string;
};

export type Preparation =
  | { kind: "ready"; request: PreparedRequest }
  | { kind: "needs_info"; questions: string[]; actionId: string }
  | { kind: "unknown_action"; actionId: string };

const NUMERIC_FIELDS = new Set([
  "price", "durationMin", "sessionsCount", "displayOrder", "capacity", "quantity", "page", "perPage", "value",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "translations.fa.title" / "items[0].groupId" → nested object */
function setDeep(target: Record<string, unknown>, rawKey: string, value: unknown): void {
  const keys = rawKey
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);

  let cursor: Record<string, unknown> | unknown[] = target;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string;
    const isLast = index === keys.length - 1;
    const nextKey = keys[index + 1];

    if (isLast) {
      if (Array.isArray(cursor)) cursor[Number(key)] = value;
      else cursor[key] = value;
      return;
    }

    const nextIsIndex = nextKey !== undefined && /^\d+$/.test(nextKey);
    if (Array.isArray(cursor)) {
      const index_ = Number(key);
      cursor[index_] ??= nextIsIndex ? [] : {};
      cursor = cursor[index_] as Record<string, unknown> | unknown[];
    } else {
      cursor[key] ??= nextIsIndex ? [] : {};
      cursor = cursor[key] as Record<string, unknown> | unknown[];
    }
  }
}

function coerce(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  const leaf = key.split(".").pop() ?? key;
  if (NUMERIC_FIELDS.has(leaf) && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  if (leaf === "isActive" || leaf === "isFeatured" || leaf === "highlighted") {
    if (["true", "بله", "yes", "1", "فعال"].includes(value.trim().toLowerCase())) return true;
    if (["false", "خیر", "no", "0", "غیرفعال"].includes(value.trim().toLowerCase())) return false;
  }
  if (leaf === "phone") {
    return value.trim().replace(/[\s\-()]/g, "");
  }
  return value;
}

/**
 * Recursively: normalise Persian digits, trim strings, coerce numbers/booleans,
 * and drop empty values. Runs on nested arrays/objects too, so
 * `items[0].quantity: "۱"` becomes `1`.
 */
function sanitizeNode(value: unknown, key: string): unknown {
  if (typeof value === "string") {
    const normalized = normalize(value);
    return normalized.length > 0 ? coerce(key, normalized) : undefined;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => sanitizeNode(item, key)).filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = sanitizeNode(childValue, childKey);
      if (cleaned !== undefined) out[childKey] = cleaned;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return value;
}

/**
 * Keeps only the fields the action actually accepts. A hallucinated
 * `{"admin":true}` or a stray `{"__proto__":...}` never reaches the network.
 */
function pickAllowed(action: FeatureAction, params: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set<string>(["id"]);
  for (const field of action.fields ?? []) {
    allowed.add(field);
    // "items[].groupId" also allows "items"
    allowed.add(field.split(/[.[]/)[0] as string);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    const root = key.split(/[.[]/)[0] as string;
    if (!allowed.has(key) && !allowed.has(root)) continue;
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;

    const leaf = key.replace(/\[\d+\]/g, "").split(".").pop() ?? key;
    const cleaned = sanitizeNode(value, leaf);
    if (cleaned === undefined) continue;
    if (key.includes(".") || key.includes("[")) setDeep(out, key, cleaned);
    else out[key] = cleaned;
  }
  if (typeof params._itemTitle === "string" && params._itemTitle) {
    out._itemTitle = params._itemTitle;
  }
  return out;
}

function describe(action: FeatureAction, values: Record<string, unknown>): string {
  const bits: string[] = [];
  const push = (label: string, key: string) => {
    const value = values[key];
    if (value !== undefined && value !== null && value !== "") bits.push(`${label}: ${String(value)}`);
  };

  if (typeof values._itemTitle === "string" && values._itemTitle) {
    bits.push(`مورد: ${values._itemTitle}`);
  }

  push("نام", "fullName");
  push("تلفن", "phone");
  push("ایمیل", "email");
  push("وضعیت", "status");
  if (typeof values.price === "number") {
    bits.push(`قیمت: ${values.price.toLocaleString("fa-IR")} تومان`);
  } else if (values.price !== undefined && values.price !== null && values.price !== "") {
    bits.push(`قیمت: ${String(values.price)}`);
  }
  push("روز", "day");
  push("از ساعت", "opens");
  push("تا ساعت", "closes");
  push("ظرفیت", "capacity");
  if (!values._itemTitle) {
    push("شناسه", "id");
  }
  push("کلید", "key");
  push("نقش", "roleKey");

  const title = values.title ?? (values.translations as { fa?: { title?: string; name?: string } } | undefined)?.fa?.title;
  const name = values.name ?? (values.translations as { fa?: { title?: string; name?: string } } | undefined)?.fa?.name;
  if (typeof title === "string") bits.unshift(`عنوان: ${title}`);
  if (typeof name === "string") bits.unshift(`نام: ${name}`);

  return bits.length > 0 ? bits.join(" • ") : action.fa;
}

export function preparePlan(actionId: string, rawParams: Record<string, unknown>): Preparation {
  const found = getAction(actionId);
  if (!found) return { kind: "unknown_action", actionId };

  const { action } = found;
  const requirements = REQUIREMENTS[actionId] ?? {};
  const params = pickAllowed(action, rawParams);

  const missing: string[] = [];

  const pathParams: Record<string, string> = {};
  for (const key of requirements.path ?? []) {
    const value = params[key];
    if (typeof value !== "string" || value.trim() === "") {
      missing.push(key);
      continue;
    }
    if (key === "id" && !UUID_PATTERN.test(value.trim())) {
      missing.push(key);
      continue;
    }
    pathParams[key] = value.trim();
  }

  const body: Record<string, unknown> = {};
  for (const key of requirements.body ?? []) {
    if (params[key] === undefined) missing.push(key);
  }
  for (const [key, value] of Object.entries(params)) {
    if (key in pathParams || key.startsWith("_")) continue;
    const root = key.split(/[.[]/)[0] as string;
    if ((requirements.query ?? []).includes(key)) continue;
    if (requirements.body && requirements.body.length > 0 && ![...requirements.body, ...(action.fields ?? [])].some((field) => field.split(/[.[]/)[0] === root)) {
      continue;
    }
    body[key] = value;
  }

  for (const group of requirements.anyOf ?? []) {
    const satisfied = group.some((key) => params[key] !== undefined);
    if (!satisfied) missing.push(group[0] as string);
  }

  if (missing.length > 0) {
    return {
      kind: "needs_info",
      actionId,
      questions: [...new Set(missing)].map(questionFor),
    };
  }

  // GET → query string, writes → JSON body
  const query: Record<string, string | number | boolean> = {};
  let requestBody: unknown = undefined;

  if (action.method === "GET") {
    for (const [key, value] of Object.entries(params)) {
      if (key === "id") continue;
      if (typeof value === "object") continue;
      query[key] = value as string | number | boolean;
    }
  } else if (action.method === "DELETE") {
    requestBody = undefined;
  } else {
    requestBody = body;
    // Mirrors the target project's zod defaults for bookings.
    if (actionId === "bookings.create") {
      const record = requestBody as Record<string, unknown>;
      record.termsAccepted ??= true;
      record.locale ??= "fa";
    }
  }

  const request: PreparedRequest = {
    actionId,
    method: action.method,
    path: action.path,
    permission: action.permission,
    danger: action.danger,
    pathParams,
    query,
    body: requestBody,
    summaryFa: `${action.fa} — ${describe(action, params)}`,
  };

  return { kind: "ready", request };
}

export async function executeRequest(request: PreparedRequest): Promise<WebhookResult> {
  const resource = request.actionId.split(".")[0] ?? "";

  if (request.method !== "GET") {
    // Invalidate cached reads for this resource immediately when a write/delete executes
    invalidateResource(resource);
    return callWebhook({
      method: request.method,
      path: request.path,
      pathParams: request.pathParams,
      query: request.query,
      body: request.body,
    });
  }

  // GET requests use the advanced cache & coalescing layer
  return fetchWithCache(
    {
      method: request.method,
      path: request.path,
      pathParams: request.pathParams,
      query: request.query,
      body: request.body,
    },
    { tags: [resource] },
  );
}

/** Redacted view for confirmation cards / logs: never echo passwords back. */
export function previewRequest(request: PreparedRequest): {
  method: string;
  path: string;
  permission: string;
  danger: string;
  body: unknown;
} {
  const body = request.body;
  if (body && typeof body === "object") {
    const clone = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    if (typeof clone.password === "string") clone.password = "••••••";
    return {
      method: request.method,
      path: request.path.replace(/:([a-zA-Z_]+)/g, (_m, key: string) => request.pathParams[key] ?? `:${key}`),
      permission: request.permission,
      danger: request.danger,
      body: clone,
    };
  }

  return {
    method: request.method,
    path: request.path.replace(/:([a-zA-Z_]+)/g, (_m, key: string) => request.pathParams[key] ?? `:${key}`),
    permission: request.permission,
    danger: request.danger,
    body: undefined,
  };
}
