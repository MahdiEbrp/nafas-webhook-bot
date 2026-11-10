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

export type CreateUserInput = {
  fullName: string;
  email: string;
  phone: string | null;
  password: string;
  roleKey: string;
};

export type CreateUserResult = {
  id: string;
  error?: string;
  status?: number;
  requestId?: string;
};

export type UserStatusFilter = "all" | "active" | "inactive" | "banned";

export type UpdateUserStatusInput = {
  isActive?: boolean;
  isBanned?: boolean;
  banReason?: string | null;
};

export type UserStatusResult = {
  ok: boolean;
  error?: string;
  status?: number;
  requestId?: string;
};

export type BulkUserAction = "activate" | "deactivate" | "ban" | "unban" | "change-role" | "delete" | "reset-password";

export type BulkUserScope = "page" | "filtered";

export type BulkUserFilters = {
  search?: string;
  status?: UserStatusFilter;
  role?: string;
};

export type BulkUsersInput =
  | { action: BulkUserAction; scope: "page"; ids: string[] }
  | { action: BulkUserAction; scope: "filtered"; filters: BulkUserFilters }
  | { action: "change-role"; scope: "page"; ids: string[]; roleKey: string }
  | { action: "change-role"; scope: "filtered"; filters: BulkUserFilters; roleKey: string };

export type BulkUsersResult = {
  requested: number;
  succeeded: number;
  failures: Array<{ id: string; code: string }>;
  temporaryPasswords?: Array<{ id: string; password: string }>;
  error?: string;
  status?: number;
  requestId?: string;
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
  | { kind: "bulk"; input: RuleBulkInput }
  | { kind: "update-user-status"; id: string; patch: UpdateUserStatusInput }
  | { kind: "soft-delete-user"; id: string }
  | { kind: "bulk-users"; input: BulkUsersInput };

export type RulePendingChange = {
  token: string;
  action: RulePendingAction;
  summary: string;
  expiresAt: number;
};

export type ApplyOutcome = {
  applied: string[];
  failed: Array<{ id: string; reason: string; status?: number }>;
  error?: string;
  status?: number;
  requestId?: string;
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
  | "missing-auth-context"
  | "invalid-user-id"
  | "user-not-found"
  | "self-lockout"
  | "invalid-role"
  | "role-change-self"
  | "user-update-failed"
  | "user-delete-failed"
  | "bulk-user-failed";

export type RuleProposal =
  | { ok: true; change: RulePendingChange }
  | { ok: false; code: RuleProposalFailure; message: string; status?: number; requestId?: string };

export type RuleConfirmResult =
  | {
      ok: true;
      applied: string[];
      appliedCount?: number;
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

export type User = {
  id: string;
  email: string;
  phone: string | null;
  fullName: string | null;
  roleKey: string | null;
  isActive: boolean;
  isBanned: boolean;
  lastLoginAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type UserListResult = {
  users: User[];
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
