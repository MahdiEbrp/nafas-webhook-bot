/**
 * Types for the user-management layer.
 *
 * Kept in their own file because three modules need them — the manager, the
 * capability list, and the tests — and a type that lives inside the class file
 * drags the class along with it wherever it is imported.
 */

import type { Locale } from "@/lib/config";

/** The displayed state; the API keeps active and banned as separate flags. */
export type UserStatus = "active" | "disabled" | "banned";
/** Role keys are data-driven by the backend roles table. */
export type UserRole = string;

export type ManagedUser = {
  id: string;
  /** Canonical API field; split names are optional legacy aliases. */
  fullName: string;
  firstName?: string;
  lastName?: string;
  email: string;
  /** Canonical role field from the API; `role` is a legacy alias. */
  roleKey: UserRole;
  role?: UserRole;
  /** A phone number with 7–15 digits, optionally prefixed with `+`. */
  phone: string | null;
  status?: UserStatus;
  isActive: boolean;
  isBanned: boolean;
  bannedAt: string | null;
  banReason: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * What an edit may change.
 *
 * Deliberately narrow: `id`, `createdAt` and `updatedAt` are not editable, so
 * there is no way to ask for a change that would corrupt the record.
 */
export type UserPatch = {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  roleKey?: UserRole;
  /** Legacy alias; live requests translate it to `roleKey`. */
  role?: UserRole;
  phone?: string | null;
  status?: "active" | "disabled";
  isActive?: boolean;
  isBanned?: boolean;
  banReason?: string | null;
};

/** Details required when creating an account. Password is never part of a user record. */
export type UserCreateInput = {
  fullName: string;
  email: string;
  phone: string;
  password: string;
  roleKey: UserRole;
};

/** The three things that can be done to a whole list at once. */
export type BulkAction = "enable" | "disable" | "delete";

/** What a pending change intends to do, before anybody has agreed to it. */
export type PendingAction =
  | { kind: "create"; user: ManagedUser }
  | { kind: "edit"; userId: string; patch: UserPatch }
  | { kind: "ban"; userId: string; reason: string | null }
  | { kind: "unban"; userId: string }
  | { kind: "password-change"; userId: string }
  | { kind: "password-reset"; userId: string }
  | { kind: "delete"; userId: string }
  | { kind: "bulk"; action: BulkAction; userIds: string[] };

/**
 * A change that has been described but not carried out.
 *
 * This is the whole point of the confirmation rule: nothing leaves the process
 * until somebody calls `confirm` with this token, and the token expires so a
 * proposal forgotten mid-conversation can never be executed hours later.
 */
export type PendingChange = {
  token: string;
  action: PendingAction;
  /** One human-readable line saying what will happen, in the user's language. */
  summary: string;
  /** The ids the change would touch, so the summary can be checked against them. */
  affected: string[];
  /** Epoch ms. After this the token is refused. */
  expiresAt: number;
};

/** Why a proposal was refused. Every one of these is worth telling the user. */
export type ProposalFailure =
  | "invalid-name"
  | "invalid-email"
  | "email-taken"
  | "invalid-password"
  | "invalid-role"
  | "invalid-phone"
  | "invalid-user-id"
  | "invalid-ban-reason"
  | "password-mismatch"
  | "not-found"
  | "no-change"
  | "empty-list"
  | "unknown-action";

export type Proposal =
  | { ok: true; change: PendingChange }
  | { ok: false; code: ProposalFailure; message: string };

export type ConfirmFailure = "unknown-token" | "expired";

export type ConfirmResult =
  | {
      ok: true;
      /** ids the change really applied to */
      applied: string[];
      /** ids it could not apply to, each with a reason */
      failed: Array<{ id: string; reason: string; status?: number }>;
      /** true once the change reached a backend */
      sent: boolean;
      /** which backend carried it out */
      mode: "live" | "dummy";
      /** Present after a live password reset; never written to logs. */
      temporaryPassword?: string;
      /** The API should set this for reset-password responses. */
      passwordChangeRequired?: boolean;
    }
  | { ok: false; code: ConfirmFailure; message: string };

export type SearchResult = {
  users: ManagedUser[];
  /** true when the answer came from the API rather than the dummy store */
  live: boolean;
  /** set when the lookup failed; the list is then empty, not silently wrong */
  error?: string;
  /** upstream HTTP status when a live lookup fails (401/403/404/429, etc.) */
  status?: number;
};

/** One thing the class can do, in a shape both code and prose can use. */
export type Capability = {
  /** stable id, used in tests and in the system prompt */
  id: string;
  title: Record<Locale, string>;
  /** an example of how a person would actually ask for it */
  example: Record<Locale, string>;
  /** true when carrying it out needs a confirmation first */
  needsConfirm: boolean;
};
