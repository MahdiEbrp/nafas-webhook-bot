/** Shapes shared by the rules client and its proposal/confirmation flow. */

export type RuleLocale = "fa" | "en";
export type RuleStatusFilter = "all" | "active" | "inactive";
export type RuleStatus = "active" | "inactive";

export type RuleTranslation = {
  name: string;
  description: string | null;
};

export type RuleTranslations = Record<RuleLocale, RuleTranslation>;

export type Rule = {
  id: string;
  slug: string;
  translations: RuleTranslations;
  icon: string | null;
  image: string | null;
  color: string | null;
  highlighted: boolean;
  displayOrder: number;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type RuleCreateInput = {
  slug: string;
  translations: {
    fa: { name: string; description?: string | null };
    en: { name: string; description?: string | null };
  };
  icon?: string | null;
  image?: string | null;
  color?: string | null;
  highlighted?: boolean;
  displayOrder?: number;
  isActive?: boolean;
};

export type RuleTranslationPatch = {
  name?: string;
  description?: string | null;
};

export type RulePatch = {
  slug?: string;
  icon?: string | null;
  image?: string | null;
  color?: string | null;
  highlighted?: boolean;
  displayOrder?: number;
  isActive?: boolean;
  translations?: Partial<Record<RuleLocale, RuleTranslationPatch>>;
};

export type RuleListQuery = {
  page?: number;
  perPage?: number;
  search?: string;
  status?: RuleStatusFilter;
};

export type RuleBulkAction = "activate" | "deactivate" | "delete";
export type RuleBulkScope = "page" | "filtered";
export type RuleBulkFilters = {
  search?: string;
  status?: RuleStatusFilter;
};

export type RuleBulkInput =
  | { action: RuleBulkAction; scope: "page"; ids: string[] }
  | { action: RuleBulkAction; scope: "filtered"; filters: RuleBulkFilters };

/** Per-call auth material must come from a trusted, authenticated caller. */
export type RuleRequestContext = {
  actorId: string;
  sessionCookie: string;
  csrfToken: string;
};

export type RulePendingAction =
  | { kind: "create"; id: string; input: RuleCreateInput }
  | { kind: "update"; id: string; patch: RulePatch }
  | { kind: "delete"; id: string }
  | { kind: "bulk"; input: RuleBulkInput };

export type RulePendingChange = {
  token: string;
  action: RulePendingAction;
  summary: string;
  expiresAt: number;
};

export type RuleProposalFailure =
  | "invalid-id"
  | "invalid-slug"
  | "invalid-name"
  | "invalid-description"
  | "invalid-icon"
  | "invalid-image"
  | "invalid-color"
  | "invalid-highlighted"
  | "invalid-display-order"
  | "invalid-is-active"
  | "invalid-translations"
  | "invalid-page"
  | "invalid-per-page"
  | "invalid-search"
  | "invalid-status"
  | "invalid-action"
  | "invalid-scope"
  | "empty-selection"
  | "too-many-ids"
  | "no-change"
  | "not-found"
  | "request-failed"
  | "missing-auth-context";

export type RuleProposal =
  | { ok: true; change: RulePendingChange }
  | { ok: false; code: RuleProposalFailure; message: string; status?: number; requestId?: string };

export type RuleConfirmResult =
  | {
      ok: true;
      applied: string[];
      failed: Array<{ id: string; reason: string; status?: number }>;
      sent: boolean;
      mode: "live" | "dummy";
      requestId?: string;
    }
  | { ok: false; code: "unknown-token" | "expired"; message: string }
  | { ok: false; code: "unauthorized" | "forbidden"; message: string; status: 401 | 403 };

export type RuleReadResult = {
  rule: Rule | null;
  error?: string;
  status?: number;
  requestId?: string;
};

export type RuleListResult = {
  rules: Rule[];
  page: number;
  perPage: number;
  total: number;
  live: boolean;
  error?: string;
  status?: number;
  requestId?: string;
};

export type RuleCapability = {
  id: string;
  title: Record<RuleLocale, string>;
  example: Record<RuleLocale, string>;
  needsConfirm: boolean;
};
