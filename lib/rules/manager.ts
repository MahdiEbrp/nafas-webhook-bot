import { randomUUID } from "node:crypto";

import { logWarn } from "@/lib/log";

import type {
  Rule,
  RuleBulkAction,
  RuleBulkFilters,
  RuleBulkInput,
  RuleCapability,
  RuleConfirmResult,
  RuleCreateInput,
  RuleListQuery,
  RuleListResult,
  RuleLocale,
  RulePatch,
  RulePendingAction,
  RulePendingChange,
  RuleProposal,
  RuleProposalFailure,
  RuleRequestContext,
  RuleReadResult,
  RuleStatusFilter,
  User,
  UserListResult,
  RuleTranslation,
  RuleTranslationPatch,
  RuleTranslations,
} from "./types";

export type RuleManagerOptions = {
  /** Full HTTPS origin/prefix of the external application API. Empty means dummy data. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  pendingTtlMs?: number;
  timeoutMs?: number;
  seed?: Rule[];
};

type HttpResult = {
  ok: boolean;
  status: number;
  requestId?: string;
  reason: string;
  body: unknown;
};

type ApplyOutcome = {
  applied: string[];
  failed: Array<{ id: string; reason: string; status?: number }>;
  requestId?: string;
};

type Normalized<T> = { ok: true; value: T } | { ok: false; code: RuleProposalFailure };

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_API_BASE_URL = "https://nafasbeautyclinic.ir";
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LOCALES: readonly RuleLocale[] = ["fa", "en"];
const STATUS_FILTERS: readonly RuleStatusFilter[] = ["all", "active", "inactive"];
const BULK_ACTIONS: readonly RuleBulkAction[] = ["activate", "deactivate", "delete"];

const MESSAGES: Record<RuleProposalFailure, string> = {
  "invalid-id": "شناسهٔ قانون باید UUID معتبر باشد.",
  "invalid-slug": "شناسهٔ کوتاه باید ۱ تا ۱۶۰ نویسه و به‌شکل kebab-case باشد.",
  "invalid-name": "نام هر ترجمه باید پس از trim بین ۱ تا ۲۵۶ نویسه باشد.",
  "invalid-description": "توضیح هر ترجمه نباید بیشتر از ۲۰۰۰ نویسه باشد.",
  "invalid-icon": "آیکن نباید بیشتر از ۱۰۰ نویسه باشد.",
  "invalid-image": "نشانی تصویر نباید بیشتر از ۲۰۴۸ نویسه باشد.",
  "invalid-color": "رنگ نباید بیشتر از ۵۰ نویسه باشد.",
  "invalid-highlighted": "مقدار highlighted باید true یا false باشد.",
  "invalid-display-order": "ترتیب نمایش باید عدد صحیحی بین ۰ تا ۱۰۰۰۰ باشد.",
  "invalid-is-active": "مقدار isActive باید true یا false باشد.",
  "invalid-translations": "نام فارسی و انگلیسی هر دو لازم هستند.",
  "invalid-page": "page باید عدد صحیحی بین ۱ تا ۱۰۰۰۰۰ باشد.",
  "invalid-per-page": "perPage باید عدد صحیحی بین ۱ تا ۵۰ باشد.",
  "invalid-search": "عبارت جست‌وجو نباید بیشتر از ۱۰۰ نویسه باشد.",
  "invalid-status": "status باید all، active یا inactive باشد.",
  "invalid-action": "این عملیات دسته‌ای معتبر نیست.",
  "invalid-scope": "scope باید page یا filtered باشد.",
  "empty-selection": "دست‌کم یک قانون را انتخاب کن.",
  "too-many-ids": "در هر عملیات حداکثر ۱۰۰ قانون را می‌توان انتخاب کرد.",
  "no-change": "هیچ تغییری برای اعمال مشخص نشده است.",
  "not-found": "قانون پیدا نشد.",
  "request-failed": "درخواست به API قوانین انجام نشد.",
  "missing-auth-context": "زمینهٔ احراز هویت معتبر برای این درخواست در دسترس نیست.",
};

export function seedRules(): Rule[] {
  const stamp = "2026-01-01T00:00:00.000Z";
  return [
    {
      id: "22222222-2222-4222-8222-222222222201",
      slug: "appointment-policy",
      translations: {
        fa: { name: "قانون نوبت‌دهی", description: null },
        en: { name: "Appointment policy", description: null },
      },
      icon: null,
      image: null,
      color: null,
      highlighted: false,
      displayOrder: 0,
      isActive: true,
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: "22222222-2222-4222-8222-222222222202",
      slug: "cancellation-policy",
      translations: {
        fa: { name: "قانون لغو نوبت", description: "برای لغو زودتر اطلاع بده." },
        en: { name: "Cancellation policy", description: null },
      },
      icon: "calendar",
      image: null,
      color: "#6750A4",
      highlighted: true,
      displayOrder: 1,
      isActive: false,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];
}

export const RULE_CAPABILITIES: readonly RuleCapability[] = [
  { id: "users.list", title: { fa: "فهرست کاربران", en: "List users" }, example: { fa: "لیست کاربران را نشان بده", en: "List users" }, needsConfirm: false },
  { id: "rules.list", title: { fa: "فهرست‌کردن قوانین", en: "List rules" }, example: { fa: "قوانین فعال را نشان بده", en: "List active rules" }, needsConfirm: false },
  { id: "rules.view", title: { fa: "دیدن یک قانون", en: "View one rule" }, example: { fa: "قانون را با شناسه‌اش پیدا کن", en: "Get a rule by its id" }, needsConfirm: false },
  { id: "rules.create", title: { fa: "ساخت قانون", en: "Create a rule" }, example: { fa: "قانونی با نام سیاست نوبت‌دهی بساز", en: "Create an appointment-policy rule" }, needsConfirm: true },
  { id: "rules.update", title: { fa: "ویرایش قانون", en: "Update a rule" }, example: { fa: "نام انگلیسی قانون را عوض کن", en: "Update a rule's English name" }, needsConfirm: true },
  { id: "rules.delete", title: { fa: "حذف قانون", en: "Delete a rule" }, example: { fa: "قانون انتخاب‌شده را حذف کن", en: "Delete the selected rule" }, needsConfirm: true },
  { id: "rules.bulk", title: { fa: "فعال‌سازی، غیرفعال‌سازی یا حذف گروهی قوانین", en: "Bulk-activate, deactivate, or delete rules" }, example: { fa: "قوانین این صفحه را غیرفعال کن", en: "Deactivate the rules on this page" }, needsConfirm: true },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validContext(value: unknown): value is RuleRequestContext {
  return isRecord(value)
    && typeof value.actorId === "string" && value.actorId.trim().length > 0
    && typeof value.sessionCookie === "string" && value.sessionCookie.trim().length > 0
    && typeof value.csrfToken === "string" && value.csrfToken.trim().length > 0;
}

function validReadContext(value: unknown): value is RuleRequestContext {
  return isRecord(value)
    && typeof value.actorId === "string" && value.actorId.trim().length > 0
    && typeof value.sessionCookie === "string" && value.sessionCookie.trim().length > 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return [...trimmed].length >= 1 && [...trimmed].length <= 256 ? trimmed : null;
}

function normalizeDescription(value: unknown): Normalized<string | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, code: "invalid-description" };
  const trimmed = value.trim();
  if ([...trimmed].length > 2000) return { ok: false, code: "invalid-description" };
  return { ok: true, value: trimmed };
}

function normalizeOptionalString(
  value: unknown,
  max: number,
  code: "invalid-icon" | "invalid-image" | "invalid-color",
): Normalized<string | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, code };
  const trimmed = value.trim();
  return [...trimmed].length <= max ? { ok: true, value: trimmed } : { ok: false, code };
}

function validDisplayOrder(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000;
}

function normalizeCreate(input: RuleCreateInput): Normalized<RuleCreateInput> {
  if (!isRecord(input) || !isRecord(input.translations)) return { ok: false, code: "invalid-translations" };
  const slug = typeof input.slug === "string" ? input.slug.trim() : "";
  if (slug.length < 1 || slug.length > 160 || !SLUG_PATTERN.test(slug)) return { ok: false, code: "invalid-slug" };

  const normalizedTranslations = {} as RuleTranslations;
  for (const locale of LOCALES) {
    const translation = input.translations[locale];
    if (!isRecord(translation)) return { ok: false, code: "invalid-translations" };
    const name = normalizeName(translation.name);
    if (name === null) return { ok: false, code: "invalid-name" };
    const description = normalizeDescription(translation.description === undefined ? null : translation.description);
    if (!description.ok) return description;
    normalizedTranslations[locale] = { name, description: description.value };
  }

  const icon = normalizeOptionalString(input.icon === undefined ? null : input.icon, 100, "invalid-icon");
  if (!icon.ok) return icon;
  const image = normalizeOptionalString(input.image === undefined ? null : input.image, 2048, "invalid-image");
  if (!image.ok) return image;
  const color = normalizeOptionalString(input.color === undefined ? null : input.color, 50, "invalid-color");
  if (!color.ok) return color;
  const highlighted = input.highlighted === undefined ? false : input.highlighted;
  if (typeof highlighted !== "boolean") return { ok: false, code: "invalid-highlighted" };
  const displayOrder = input.displayOrder === undefined ? 0 : input.displayOrder;
  if (!validDisplayOrder(displayOrder)) return { ok: false, code: "invalid-display-order" };
  const isActive = input.isActive === undefined ? true : input.isActive;
  if (typeof isActive !== "boolean") return { ok: false, code: "invalid-is-active" };

  return {
    ok: true,
    value: {
      slug,
      translations: {
        fa: { name: normalizedTranslations.fa.name, description: normalizedTranslations.fa.description },
        en: { name: normalizedTranslations.en.name, description: normalizedTranslations.en.description },
      },
      icon: icon.value,
      image: image.value,
      color: color.value,
      highlighted,
      displayOrder,
      isActive,
    },
  };
}

function normalizePatch(patch: RulePatch): Normalized<RulePatch> {
  if (!isRecord(patch)) return { ok: false, code: "no-change" };
  const keys = Object.keys(patch).filter((key) => (patch as Record<string, unknown>)[key] !== undefined);
  if (keys.length === 0) return { ok: false, code: "no-change" };
  const value: RulePatch = {};

  if (patch.slug !== undefined) {
    if (typeof patch.slug !== "string") return { ok: false, code: "invalid-slug" };
    const slug = patch.slug.trim();
    if (slug.length < 1 || slug.length > 160 || !SLUG_PATTERN.test(slug)) return { ok: false, code: "invalid-slug" };
    value.slug = slug;
  }
  if (patch.icon !== undefined) {
    const result = normalizeOptionalString(patch.icon, 100, "invalid-icon");
    if (!result.ok) return result;
    value.icon = result.value;
  }
  if (patch.image !== undefined) {
    const result = normalizeOptionalString(patch.image, 2048, "invalid-image");
    if (!result.ok) return result;
    value.image = result.value;
  }
  if (patch.color !== undefined) {
    const result = normalizeOptionalString(patch.color, 50, "invalid-color");
    if (!result.ok) return result;
    value.color = result.value;
  }
  if (patch.highlighted !== undefined) {
    if (typeof patch.highlighted !== "boolean") return { ok: false, code: "invalid-highlighted" };
    value.highlighted = patch.highlighted;
  }
  if (patch.displayOrder !== undefined) {
    if (!validDisplayOrder(patch.displayOrder)) return { ok: false, code: "invalid-display-order" };
    value.displayOrder = patch.displayOrder;
  }
  if (patch.isActive !== undefined) {
    if (typeof patch.isActive !== "boolean") return { ok: false, code: "invalid-is-active" };
    value.isActive = patch.isActive;
  }
  if (patch.translations !== undefined) {
    if (!isRecord(patch.translations)) return { ok: false, code: "invalid-translations" };
    const translations: Partial<Record<RuleLocale, RuleTranslationPatch>> = {};
    for (const locale of LOCALES) {
      const source = patch.translations[locale];
      if (source === undefined) continue;
      if (!isRecord(source)) return { ok: false, code: "invalid-translations" };
      const translated: RuleTranslationPatch = {};
      if (source.name !== undefined) {
        const name = normalizeName(source.name);
        if (name === null) return { ok: false, code: "invalid-name" };
        translated.name = name;
      }
      if (source.description !== undefined) {
        const description = normalizeDescription(source.description);
        if (!description.ok) return description;
        translated.description = description.value;
      }
      if (Object.keys(translated).length > 0) translations[locale] = translated;
    }
    if (Object.keys(translations).length > 0) value.translations = translations;
  }
  if (Object.keys(value).length === 0) return { ok: false, code: "no-change" };
  return { ok: true, value };
}

function normalizeListQuery(query: RuleListQuery = {}): Normalized<Required<Pick<RuleListQuery, "page" | "perPage" | "status">> & Pick<RuleListQuery, "search">> {
  const page = query.page === undefined ? 1 : query.page;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > 100_000) {
    return { ok: false, code: "invalid-page" };
  }
  const perPage = query.perPage === undefined ? 10 : query.perPage;
  if (typeof perPage !== "number" || !Number.isInteger(perPage) || perPage < 1 || perPage > 50) {
    return { ok: false, code: "invalid-per-page" };
  }
  let search: string | undefined;
  if (query.search !== undefined) {
    if (typeof query.search !== "string") return { ok: false, code: "invalid-search" };
    search = query.search.trim();
    if ([...search].length > 100) return { ok: false, code: "invalid-search" };
  }
  const status = query.status === undefined ? "all" : query.status;
  if (!STATUS_FILTERS.includes(status)) return { ok: false, code: "invalid-status" };
  return { ok: true, value: { page, perPage, status, ...(search ? { search } : {}) } };
}

function validateBulk(input: RuleBulkInput): Normalized<RuleBulkInput> {
  if (!isRecord(input)) return { ok: false, code: "invalid-scope" };
  if (!BULK_ACTIONS.includes(input.action as RuleBulkAction)) return { ok: false, code: "invalid-action" };
  if (input.scope === "page") {
    if (!Array.isArray(input.ids) || input.ids.length === 0) return { ok: false, code: "empty-selection" };
    if (input.ids.length > 100) return { ok: false, code: "too-many-ids" };
    if (!input.ids.every(isUuid)) return { ok: false, code: "invalid-id" };
    return { ok: true, value: { action: input.action as RuleBulkAction, scope: "page", ids: [...input.ids] } };
  }
  if (input.scope === "filtered") {
    if (!isRecord(input.filters)) return { ok: false, code: "invalid-scope" };
    const filterKeys = Object.keys(input.filters);
    if (filterKeys.some((key) => key !== "search" && key !== "status")) return { ok: false, code: "invalid-scope" };
    const normalized = normalizeListQuery({
      ...(input.filters.search === undefined ? {} : { search: input.filters.search as string }),
      ...(input.filters.status === undefined ? {} : { status: input.filters.status as RuleStatusFilter }),
    });
    if (!normalized.ok) return normalized;
    return {
      ok: true,
      value: {
        action: input.action as RuleBulkAction,
        scope: "filtered",
        filters: {
          ...(normalized.value.search === undefined ? {} : { search: normalized.value.search }),
          status: normalized.value.status,
        },
      },
    };
  }
  return { ok: false, code: "invalid-scope" };
}

function listPayload(body: unknown): { rules: Rule[]; page?: number; perPage?: number; total?: number } | null {
  if (Array.isArray(body)) return { rules: body as Rule[] };
  if (!isRecord(body)) return null;
  const candidate = body.rules ?? body.data ?? body.items;
  if (Array.isArray(candidate)) {
    const pagination = isRecord(body.pagination) ? body.pagination : body;
    return {
      rules: candidate as Rule[],
      ...(typeof pagination.page === "number" ? { page: pagination.page } : {}),
      ...(typeof pagination.perPage === "number" ? { perPage: pagination.perPage } : {}),
      ...(typeof pagination.total === "number" ? { total: pagination.total } : {}),
    };
  }
  return null;
}

function singleRule(body: unknown): Rule | null {
  if (!isRecord(body)) return null;
  for (const candidate of [body.rule, body.data]) {
    if (!isRecord(candidate)) continue;
    if (isRecord(candidate.rule)) return candidate.rule as unknown as Rule;
    if (typeof candidate.id === "string") return candidate as unknown as Rule;
  }
  return typeof body.id === "string" ? body as unknown as Rule : null;
}

function searchMatches(rule: Rule, search: string): boolean {
  const term = search.toLowerCase();
  const values = [
    rule.slug,
    rule.translations?.fa?.name,
    rule.translations?.fa?.description ?? "",
    rule.translations?.en?.name,
    rule.translations?.en?.description ?? "",
  ];
  return values.some((value) => typeof value === "string" && value.toLowerCase().includes(term));
}

export class RuleManager {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly pendingTtlMs: number;
  private readonly timeoutMs: number;
  private readonly store = new Map<string, Rule>();
  private readonly pending = new Map<string, RulePendingChange>();
  private readonly pendingActors = new Map<string, string>();

  constructor(options: RuleManagerOptions = {}) {
    const configuredBaseUrl = process.env.RULES_API_BASE_URL?.trim()
      || process.env.NAFAS_API_BASE_URL?.trim()
      || DEFAULT_API_BASE_URL;
    this.baseUrl = (options.baseUrl ?? configuredBaseUrl).trim().replace(/\/+$/u, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.pendingTtlMs = options.pendingTtlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    for (const rule of options.seed ?? seedRules()) this.store.set(rule.id, structuredClone(rule));
  }

  get isLive(): boolean {
    return this.baseUrl.length > 0;
  }

  capabilities(): readonly RuleCapability[] {
    return RULE_CAPABILITIES;
  }

  async list(query: RuleListQuery = {}, context?: RuleRequestContext): Promise<RuleListResult> {
    const normalized = normalizeListQuery(query);
    if (!normalized.ok) {
      return { rules: [], page: 1, perPage: 10, total: 0, live: this.isLive, error: MESSAGES[normalized.code] };
    }
    const { page, perPage, status, search } = normalized.value;
    if (this.isLive) {
      const params = new URLSearchParams({ page: String(page), perPage: String(perPage), status });
      if (search) params.set("search", search);
      const result = await this.request(`/api/v1/rules?${params.toString()}`, { method: "GET" }, context);
      if (!result.ok) {
        return {
          rules: [], page, perPage, total: 0, live: true,
          error: result.reason, status: result.status, requestId: result.requestId,
        };
      }
      const payload = listPayload(result.body);
      if (!payload) {
        return { rules: [], page, perPage, total: 0, live: true, error: "unparsable response", status: result.status, requestId: result.requestId };
      }
      return {
        rules: payload.rules.filter((rule) => isRecord(rule) && typeof rule.id === "string"),
        page: payload.page ?? page,
        perPage: payload.perPage ?? perPage,
        total: payload.total ?? payload.rules.length,
        live: true,
        requestId: result.requestId,
      };
    }

    let rules = [...this.store.values()];
    if (status === "active") rules = rules.filter((rule) => rule.isActive);
    if (status === "inactive") rules = rules.filter((rule) => !rule.isActive);
    if (search) rules = rules.filter((rule) => searchMatches(rule, search));
    const total = rules.length;
    const start = (page - 1) * perPage;
    return { rules: rules.slice(start, start + perPage), page, perPage, total, live: false };
  }

  async get(id: string, context?: RuleRequestContext): Promise<RuleReadResult> {
    if (!isUuid(id)) return { rule: null, error: MESSAGES["invalid-id"], status: 400 };
    if (this.isLive) {
      const result = await this.request(`/api/v1/rules/${encodeURIComponent(id)}`, { method: "GET" }, context);
      if (!result.ok) return { rule: null, error: result.reason, status: result.status, requestId: result.requestId };
      const rule = singleRule(result.body);
      return rule
        ? { rule, requestId: result.requestId }
        : { rule: null, error: "unparsable response", status: result.status, requestId: result.requestId };
    }
    return { rule: this.store.get(id) ?? null };
  }

  async listUsers(context?: RuleRequestContext): Promise<UserListResult> {
    if (this.isLive && !validReadContext(context)) {
      return { users: [], page: 1, perPage: 10, total: 0, live: true, error: MESSAGES["missing-auth-context"], status: 401 };
    }
    if (this.isLive) {
      const result = await this.request("/api/v1/users", { method: "GET" }, context);
      if (!result.ok) {
        return {
          users: [], page: 1, perPage: 10, total: 0, live: true,
          error: result.reason, status: result.status, requestId: result.requestId,
        };
      }
      const wrapped = isRecord(result.body) ? result.body : {};
      // beauty-clinic wraps all success responses in { data: ... }
      const body = isRecord(wrapped.data) ? wrapped.data : wrapped;
      const items = Array.isArray(body.items) ? body.items : [];
      const pagination = isRecord(body) ? body : {};
      return {
        users: items
          .filter((u: unknown) => isRecord(u) && typeof (u as Record<string, unknown>).id === "string")
          .map((u) => {
            const record = u as Record<string, unknown>;
            const roles = Array.isArray(record.roles) ? record.roles : [];
            return {
              id: String(record.id ?? ""),
              email: typeof record.email === "string" ? record.email : "",
              phone: typeof record.phone === "string" ? record.phone : null,
              fullName:
                typeof record.fullName === "string" && record.fullName
                  ? record.fullName
                  : typeof record.email === "string"
                    ? record.email.split("@")[0]
                    : "بدون نام",
              roleKey: roles.length ? String(roles[0]) : null,
              isActive: Boolean(record.isActive),
              isBanned: Boolean(record.isBanned),
              lastLoginAt:
                typeof record.lastLoginAt === "string" ? record.lastLoginAt : undefined,
              createdAt:
                typeof record.createdAt === "string" ? record.createdAt : undefined,
            } as User;
          }),
        page: typeof pagination.page === "number" ? pagination.page : 1,
        perPage: typeof pagination.perPage === "number" ? pagination.perPage : 10,
        total: typeof pagination.total === "number" ? pagination.total : items.length,
        live: true,
        requestId: result.requestId,
      };
    }
    return { users: [], page: 1, perPage: 10, total: 0, live: false };
  }

  async proposeCreate(input: RuleCreateInput, context?: RuleRequestContext): Promise<RuleProposal> {
    if (this.isLive && !validContext(context)) return this.refuse("missing-auth-context", 401);
    const normalized = normalizeCreate(input);
    if (!normalized.ok) return this.refuse(normalized.code);
    const id = randomUUID();
    return this.hold(
      { kind: "create", id, input: normalized.value },
      `ساخت قانون «${normalized.value.translations.fa.name}» / ${normalized.value.translations.en.name}`,
      context,
    );
  }

  async proposeUpdate(id: string, patch: RulePatch, context?: RuleRequestContext): Promise<RuleProposal> {
    if (!isUuid(id)) return this.refuse("invalid-id");
    if (this.isLive && !validContext(context)) return this.refuse("missing-auth-context", 401);
    const normalized = normalizePatch(patch);
    if (!normalized.ok) return this.refuse(normalized.code);
    const found = await this.get(id, context);
    if (!found.rule) {
      if (found.status && found.status !== 404) return this.refuse("request-failed", found.status, found.requestId);
      return this.refuse("not-found", found.status, found.requestId);
    }
    return this.hold({ kind: "update", id, patch: normalized.value }, `ویرایش قانون ${found.rule.slug}`, context);
  }

  async proposeDelete(id: string, context?: RuleRequestContext): Promise<RuleProposal> {
    if (!isUuid(id)) return this.refuse("invalid-id");
    if (this.isLive && !validContext(context)) return this.refuse("missing-auth-context", 401);
    const found = await this.get(id, context);
    if (!found.rule) {
      if (found.status && found.status !== 404) return this.refuse("request-failed", found.status, found.requestId);
      return this.refuse("not-found", found.status, found.requestId);
    }
    return this.hold({ kind: "delete", id }, `حذف قانون ${found.rule.slug}`, context);
  }

  async proposeBulk(input: RuleBulkInput, context?: RuleRequestContext): Promise<RuleProposal> {
    if (this.isLive && !validContext(context)) return this.refuse("missing-auth-context", 401);
    const normalized = validateBulk(input);
    if (!normalized.ok) return this.refuse(normalized.code);
    const actionLabel: Record<RuleBulkAction, string> = {
      activate: "فعال‌سازی",
      deactivate: "غیرفعال‌سازی",
      delete: "حذف",
    };
    const summary = normalized.value.scope === "page"
      ? `${actionLabel[normalized.value.action]} ${normalized.value.ids.length} قانون`
      : `${actionLabel[normalized.value.action]} قوانین مطابق فیلترها`;
    return this.hold({ kind: "bulk", input: normalized.value }, summary, context);
  }

  pendingChange(token: string): RulePendingChange | null {
    const change = this.pending.get(token);
    if (!change) return null;
    if (change.expiresAt <= this.now()) {
      this.pending.delete(token);
      this.pendingActors.delete(token);
      return null;
    }
    return change;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  cancel(token: string): boolean {
    this.pendingActors.delete(token);
    return this.pending.delete(token);
  }

  async confirm(token: string, context?: RuleRequestContext): Promise<RuleConfirmResult> {
    const change = this.pending.get(token);
    if (!change) return { ok: false, code: "unknown-token", message: "چنین تغییری پیدا نشد." };
    if (this.isLive && !validContext(context)) return { ok: false, code: "unauthorized", message: "زمینهٔ احراز هویت معتبر نیست.", status: 401 };
    if (this.isLive && this.pendingActors.get(token) !== context?.actorId) return { ok: false, code: "forbidden", message: "این تغییر به نشست کاربر دیگری تعلق دارد.", status: 403 };
    this.pending.delete(token);
    this.pendingActors.delete(token);
    if (change.expiresAt <= this.now()) {
      return { ok: false, code: "expired", message: "زمان تأیید این تغییر تمام شده است؛ دوباره پیشنهادش بده." };
    }
    const outcome = this.isLive ? await this.applyLive(change.action, context) : this.applyDummy(change.action);
    return { ok: true, ...outcome, sent: true, mode: this.isLive ? "live" : "dummy" };
  }

  private refuse(code: RuleProposalFailure, status?: number, requestId?: string): RuleProposal {
    return { ok: false, code, message: MESSAGES[code], ...(status === undefined ? {} : { status }), ...(requestId ? { requestId } : {}) };
  }

  private hold(action: RulePendingAction, summary: string, context?: RuleRequestContext): RuleProposal {
    const change: RulePendingChange = {
      token: randomUUID(),
      action,
      summary,
      expiresAt: this.now() + this.pendingTtlMs,
    };
    this.pending.set(change.token, change);
    if (this.isLive && context) this.pendingActors.set(change.token, context.actorId);
    return { ok: true, change };
  }

  private applyDummy(action: RulePendingAction): ApplyOutcome {
    if (action.kind === "create") {
      const stamp = new Date(this.now()).toISOString();
      const rule: Rule = {
        id: action.id,
        slug: action.input.slug,
        translations: {
          fa: { name: action.input.translations.fa.name, description: action.input.translations.fa.description ?? null },
          en: { name: action.input.translations.en.name, description: action.input.translations.en.description ?? null },
        },
        icon: action.input.icon ?? null,
        image: action.input.image ?? null,
        color: action.input.color ?? null,
        highlighted: action.input.highlighted ?? false,
        displayOrder: action.input.displayOrder ?? 0,
        isActive: action.input.isActive ?? true,
        createdAt: stamp,
        updatedAt: stamp,
      };
      this.store.set(rule.id, rule);
      return { applied: [rule.id], failed: [] };
    }
    if (action.kind === "update") {
      const existing = this.store.get(action.id);
      if (!existing) return { applied: [], failed: [{ id: action.id, reason: MESSAGES["not-found"], status: 404 }] };
      const patch = action.patch;
      const translations = { ...existing.translations };
      for (const locale of LOCALES) {
        const translationPatch = patch.translations?.[locale];
        if (translationPatch) translations[locale] = { ...translations[locale], ...translationPatch };
      }
      this.store.set(action.id, {
        ...existing,
        ...patch,
        translations,
        updatedAt: new Date(this.now()).toISOString(),
      });
      return { applied: [action.id], failed: [] };
    }
    if (action.kind === "delete") {
      if (!this.store.delete(action.id)) return { applied: [], failed: [{ id: action.id, reason: MESSAGES["not-found"], status: 404 }] };
      return { applied: [action.id], failed: [] };
    }
    return this.applyDummyBulk(action.input);
  }

  private applyDummyBulk(input: RuleBulkInput): ApplyOutcome {
    let selected: Rule[];
    if (input.scope === "page") {
      selected = input.ids.map((id) => this.store.get(id)).filter((rule): rule is Rule => rule !== undefined);
    } else {
      const query = normalizeListQuery(input.filters);
      const search = query.ok ? query.value.search : undefined;
      const status = query.ok ? query.value.status : "all";
      selected = [...this.store.values()].filter((rule) => {
        if (status === "active" && !rule.isActive) return false;
        if (status === "inactive" && rule.isActive) return false;
        return !search || searchMatches(rule, search);
      });
    }
    const applied: string[] = [];
    const failed: Array<{ id: string; reason: string; status?: number }> = [];
    for (const rule of selected) {
      if (input.action === "delete") this.store.delete(rule.id);
      else rule.isActive = input.action === "activate";
      applied.push(rule.id);
    }
    if (input.scope === "page") {
      for (const id of input.ids) {
        if (!this.store.has(id) && !applied.includes(id)) failed.push({ id, reason: MESSAGES["not-found"], status: 404 });
      }
    }
    return { applied, failed };
  }

  private async applyLive(action: RulePendingAction, context?: RuleRequestContext): Promise<ApplyOutcome> {
    if (action.kind === "create") {
      const result = await this.request("/api/v1/rules", { method: "POST", body: action.input }, context);
      if (!result.ok) return { applied: [], failed: [{ id: action.id, reason: result.reason, status: result.status }], requestId: result.requestId };
      const created = singleRule(result.body);
      if (!created?.id) {
        return {
          applied: [],
          failed: [{ id: "", reason: "API response did not include the created rule id", status: result.status }],
          requestId: result.requestId,
        };
      }
      return { applied: [created.id], failed: [], requestId: result.requestId };
    }
    if (action.kind === "update") {
      const result = await this.request(`/api/v1/rules/${encodeURIComponent(action.id)}`, { method: "PATCH", body: action.patch }, context);
      return result.ok
        ? { applied: [action.id], failed: [], requestId: result.requestId }
        : { applied: [], failed: [{ id: action.id, reason: result.reason, status: result.status }], requestId: result.requestId };
    }
    if (action.kind === "delete") {
      const result = await this.request(`/api/v1/rules/${encodeURIComponent(action.id)}`, { method: "DELETE" }, context);
      return result.ok
        ? { applied: [action.id], failed: [], requestId: result.requestId }
        : { applied: [], failed: [{ id: action.id, reason: result.reason, status: result.status }], requestId: result.requestId };
    }
    const result = await this.request("/api/v1/rules/bulk", { method: "POST", body: action.input }, context);
    if (result.ok) {
      const body = isRecord(result.body) ? result.body : {};
      const applied = Array.isArray(body.applied) ? body.applied.map(String) : action.input.scope === "page" ? [...action.input.ids] : [];
      const failed = Array.isArray(body.failed)
        ? body.failed.map((item) => {
            const record = isRecord(item) ? item : {};
            return { id: String(record.id ?? ""), reason: String(record.reason ?? "failed") };
          })
        : [];
      return { applied, failed, requestId: result.requestId };
    }
    const ids = action.input.scope === "page" ? action.input.ids : [];
    return {
      applied: [],
      failed: ids.map((id) => ({ id, reason: result.reason, status: result.status })),
      requestId: result.requestId,
    };
  }

  private async request(
    path: string,
    init: { method: string; body?: unknown },
    context?: RuleRequestContext,
  ): Promise<HttpResult> {
    if (!validReadContext(context)) return { ok: false, status: 401, reason: "missing authenticated request context", body: null };
    if (!/^https:\/\//iu.test(this.baseUrl)) return { ok: false, status: 0, reason: "HTTPS is required for session cookies", body: null };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Cookie: context.sessionCookie,
          ...(context.csrfToken ? { "X-CSRF-Token": context.csrfToken } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
      const requestId = response.headers.get("x-request-id") ?? undefined;
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      if (!response.ok) {
        const reason = isRecord(body) && typeof body.message === "string" ? body.message : `HTTP ${response.status}`;
        logWarn("rules.request_failed", { method: init.method, status: response.status, ...(requestId ? { requestId } : {}) });
        return { ok: false, status: response.status, reason, body, requestId };
      }
      return { ok: true, status: response.status, reason: "", body, requestId };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      const reason = aborted ? "timeout" : "network error";
      logWarn("rules.request_error", { method: init.method, reason });
      return { ok: false, status: 0, reason, body: null };
    } finally {
      clearTimeout(timer);
    }
  }
}
