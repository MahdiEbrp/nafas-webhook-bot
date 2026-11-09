/**
 * User management, behind one class.
 *
 * Two backends, one interface. With no `baseUrl` it works against a small
 * in-memory store of dummy users, so the whole thing is usable and testable
 * today. Give it a `baseUrl` and the same calls go over HTTP instead — no
 * caller changes, because the shape of an answer does not depend on where it
 * came from.
 *
 * The rule that shapes the API: **nothing that changes data is sent until
 * somebody confirms it.** Every mutation therefore has two steps —
 *
 *   propose…  →  a `PendingChange` with a token, and not one mutating request
 *   confirm() →  the request actually goes out
 *
 * A proposal that is never confirmed expires. That matters more than it sounds:
 * in a chat, a suggestion made and forgotten must not be executable an hour
 * later by a "yes" that was meant for something else.
 */

import { randomBytes, randomUUID } from "node:crypto";

import type { Locale } from "@/lib/config";
import { logInfo, logWarn } from "@/lib/log";
import { toAsciiDigits } from "@/lib/phone";
import { toPersianDigits } from "@/lib/dates/format";

import { CAPABILITIES } from "./capabilities";
import type {
  BulkAction,
  Capability,
  ConfirmResult,
  ManagedUser,
  PendingChange,
  Proposal,
  ProposalFailure,
  SearchResult,
  UserCreateInput,
  UserPatch,
  UserRole,
  UserStatus,
} from "./types";

export type UserManagerCredentials = { email: string; password: string };

export type UserManagerOptions = {
  /** When set, calls go to this API instead of the dummy store. */
  baseUrl?: string;
  /** Actor credentials; encoded as Basic Auth for every live request and never logged. */
  credentials?: UserManagerCredentials;
  /** Known role keys from the account API; defaults to the provided baseline roles. */
  roleKeys?: readonly string[];
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests, so expiry can be checked without waiting. */
  now?: () => number;
  /** How long a proposal stays valid. Default five minutes. */
  pendingTtlMs?: number;
  /** Replace the seeded dummy users. */
  seed?: ManagedUser[];
  /** Per-request timeout. */
  timeoutMs?: number;
};

type ApplyOutcome = {
  applied: string[];
  failed: Array<{ id: string; reason: string; status?: number }>;
  temporaryPassword?: string;
  passwordChangeRequired?: boolean;
};

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

/** A fixed clock for the seeded rows, so the dummy data never changes shape. */
const SEED_STAMP = "2026-01-01T00:00:00.000Z";

/**
 * The dummy users.
 *
 * Deliberately varied: two actives and a disabled one, one with no phone, one
 * whose name is a prefix of another's, so a search has something real to
 * distinguish. These are placeholders — nothing here is a real person.
 */
export function seedUsers(): ManagedUser[] {
  return [
    {
      id: "11111111-1111-4111-8111-111111111001",
      firstName: "مریم",
      lastName: "احمدی",
      fullName: "مریم احمدی",
      email: "maryam.ahmadi@example.test",
      role: "customer",
      roleKey: "customer",
      phone: "09121234567",
      status: "active",
      isActive: true,
      isBanned: false,
      bannedAt: null,
      banReason: null,
      deletedAt: null,
      createdAt: SEED_STAMP,
      updatedAt: SEED_STAMP,
    },
    {
      id: "11111111-1111-4111-8111-111111111002",
      firstName: "مریم",
      lastName: "رضایی",
      fullName: "مریم رضایی",
      email: "maryam.rezaei@example.test",
      role: "customer",
      roleKey: "customer",
      phone: "09351234567",
      status: "active",
      isActive: true,
      isBanned: false,
      bannedAt: null,
      banReason: null,
      deletedAt: null,
      createdAt: SEED_STAMP,
      updatedAt: SEED_STAMP,
    },
    {
      id: "11111111-1111-4111-8111-111111111003",
      firstName: "علی",
      lastName: "محمدی",
      fullName: "علی محمدی",
      email: "ali.mohammadi@example.test",
      role: "doctor",
      roleKey: "doctor",
      phone: null,
      status: "disabled",
      isActive: false,
      isBanned: false,
      bannedAt: null,
      banReason: null,
      deletedAt: null,
      createdAt: SEED_STAMP,
      updatedAt: SEED_STAMP,
    },
  ];
}

const MESSAGES: Record<ProposalFailure, Record<Locale, string>> = {
  "invalid-name": { fa: "نام کامل باید پس از حذف فاصله‌های کناری ۲ تا ۱۰۰ نویسه باشد.", en: "Full name must contain 2 to 100 characters after trimming." },
  "invalid-email": { fa: "ایمیل معتبر نیست یا بیشتر از ۲۵۴ نویسه دارد.", en: "Email is invalid or longer than 254 characters." },
  "email-taken": { fa: "این ایمیل قبلاً برای حساب دیگری ثبت شده است.", en: "That email is already used by another account." },
  "invalid-password": { fa: "رمز باید ۸ تا ۱۲۸ نویسه و شامل حرف کوچک، حرف بزرگ، عدد و نماد ویژه باشد.", en: "Password must be 8 to 128 characters with lowercase, uppercase, a number, and a special character." },
  "invalid-role": { fa: "نقش باید یکی از مدیر، پزشک، پذیرش یا مشتری باشد.", en: "Role must be admin, doctor, receptionist, or customer." },
  "invalid-phone": { fa: "شماره باید ۷ تا ۱۵ رقم داشته باشد و فقط با + اختیاری در ابتدا نوشته شود.", en: "Phone must contain 7 to 15 digits, optionally prefixed with +." },
  "invalid-user-id": { fa: "شناسهٔ کاربر باید UUID معتبر باشد.", en: "User id must be a valid UUID." },
  "invalid-ban-reason": { fa: "دلیل مسدودسازی نباید بیشتر از ۵۰۰ نویسه باشد.", en: "Ban reason must not exceed 500 characters." },
  "password-mismatch": { fa: "رمز تازه و تکرارش با هم یکی نیستند.", en: "The new password and confirmation do not match." },

  "not-found": { fa: "چنین کاربری پیدا نشد.", en: "No such user." },
  "no-change": { fa: "چیزی برای تغییر نگفتی.", en: "You did not ask to change anything." },
  "empty-list": { fa: "لیست خالی است؛ کسی را انتخاب نکرده‌ای.", en: "The list is empty; nobody was selected." },
  "unknown-action": { fa: "این کار را نمی‌شناسم.", en: "I do not know that action." },
};

const USER_ROLES: readonly UserRole[] = ["admin", "doctor", "receptionist", "customer"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PHONE_PATTERN = /^\+?[0-9]{7,15}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function validName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = [...value.trim()].length;
  return length >= 2 && length <= 100;
}

function validEmail(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return normalized.length <= 254 && EMAIL_PATTERN.test(normalized);
}

function validPassword(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) return false;
  return /\p{Ll}/u.test(value) && /\p{Lu}/u.test(value) && /\p{N}/u.test(value) && /[\p{P}\p{S}]/u.test(value);
}

function validPhone(value: unknown): value is string {
  return typeof value === "string" && PHONE_PATTERN.test(toAsciiDigits(value.trim()));
}

function validRole(value: unknown, roleKeys: readonly string[]): value is UserRole {
  return typeof value === "string" && roleKeys.includes(value);
}

function validUserId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Accepts an API that wraps its list, or one that returns a bare array. */
function readUsers(body: unknown): ManagedUser[] | null {
  if (Array.isArray(body)) return body as ManagedUser[];
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["users", "data", "results", "items"]) {
      if (Array.isArray(record[key])) return record[key] as ManagedUser[];
    }
  }
  return null;
}

export class UserManager {
  private readonly baseUrl: string;
  private readonly authorization?: string;
  private readonly roleKeys: readonly string[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly pendingTtlMs: number;
  private readonly timeoutMs: number;
  /** Always present: with no base url this *is* the backend. */
  private readonly store: Map<string, ManagedUser>;
  private readonly pending = new Map<string, PendingChange>();
  /** Kept separately so `pendingChange()` and logs can never expose passwords. */
  private readonly pendingPasswords = new Map<string, string>();
  private readonly locale: Locale;

  constructor(options: UserManagerOptions = {}) {
    // A trailing slash would double up in every path built from it.
    this.baseUrl = (options.baseUrl ?? "").trim().replace(/\/+$/, "");
    const authEmail = options.credentials?.email.trim().toLowerCase();
    const authPassword = options.credentials?.password;
    this.authorization = authEmail && authPassword
      ? `Basic ${Buffer.from(`${authEmail}:${authPassword}`, "utf8").toString("base64")}`
      : undefined;
    this.roleKeys = options.roleKeys ?? USER_ROLES;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.pendingTtlMs = options.pendingTtlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.locale = "fa";

    this.store = new Map();
    for (const user of options.seed ?? seedUsers()) this.store.set(user.id, { ...user });
  }

  /** True when calls go to a real API rather than the dummy store. */
  get isLive(): boolean {
    return this.baseUrl.length > 0;
  }

  /**
   * Where a confirmed change goes.
   *
   * Only two answers. A third "nowhere" state was tempting — a manager with no
   * store and no url — but it is unreachable: every proposal checks that its
   * user exists first, so with nowhere to look nothing can ever be proposed,
   * and `confirm` would have no way to get there. Dead states are worse than
   * missing ones.
   */
  get mode(): "live" | "dummy" {
    return this.isLive ? "live" : "dummy";
  }

  /** The capability list, so callers do not have to import a second module. */
  capabilities(): readonly Capability[] {
    return CAPABILITIES;
  }

  /* ───────────────────────────── reading ───────────────────────────── */

  async list(): Promise<SearchResult> {
    if (this.isLive) return await this.fetchUsers("");
    return { users: [...this.store.values()].filter((user) => !user.deletedAt), live: false };
  }

  /**
   * Finds users by id, email, phone, or either part of their name.
   *
   * Matching is on normalised text and a prefix of the phone, so «مر» finds
   * both Maryams and «0912» finds the first one. An empty query returns
   * everything rather than nothing, because "search for nothing" in a chat
   * almost always means "show me the list".
   */
  async search(query: string): Promise<SearchResult> {
    const needle = (query ?? "").trim();
    if (this.isLive) return await this.fetchUsers(needle);

    const all = [...this.store.values()].filter((user) => !user.deletedAt);
    if (!needle) return { users: all, live: false };

    // Persian digits first: `\D` does not match «۰۹۱۲», so stripping
    // non-digits from a Persian-typed number leaves nothing to search for.
    const ascii = toAsciiDigits(needle);
    const flat = ascii.replace(/\s+/g, " ").toLowerCase();
    const digits = ascii.replace(/\D/g, "");

    const matches = all.filter((user) => {
      const name = (user.fullName || [user.firstName, user.lastName].filter(Boolean).join(" ")).toLowerCase();
      if (name.includes(flat) || user.email.toLowerCase().includes(flat)) return true;
      if (user.id.toLowerCase() === flat) return true;
      // A phone typed with Persian digits still has to match.
      if (digits.length >= 3 && user.phone && user.phone.includes(digits)) return true;
      return false;
    });

    return { users: matches, live: false };
  }

  async get(userId: string): Promise<ManagedUser | null> {
    if (this.isLive) {
      const result = await this.fetchUsers("", `users/${encodeURIComponent(userId)}`);
      return result.users[0] ?? null;
    }
    const user = this.store.get(userId);
    return user && !user.deletedAt ? user : null;
  }

  /* ─────────────────────── proposing a change ──────────────────────── */

  /**
   * Describes a new account without sending or storing its password.
   * The secret is held privately until confirmation, then discarded.
   */
  async proposeCreate(input: UserCreateInput): Promise<Proposal> {
    if (!validName(input?.fullName)) return this.refuse("invalid-name");
    if (!validEmail(input?.email)) return this.refuse("invalid-email");
    if (!validPhone(input?.phone)) return this.refuse("invalid-phone");
    if (!validPassword(input?.password)) return this.refuse("invalid-password");
    if (!validRole(input?.roleKey, this.roleKeys)) return this.refuse("invalid-role");

    const fullName = input.fullName.trim();
    const [firstName = fullName, ...lastParts] = fullName.split(/\s+/u);
    const lastName = lastParts.join(" ");
    const email = input.email.trim().toLowerCase();
    if (!this.isLive && [...this.store.values()].some((user) => user.email.toLowerCase() === email)) {
      return this.refuse("email-taken");
    }
    const phone = toAsciiDigits(input.phone.trim());
    const stamp = new Date(this.now()).toISOString();
    const user: ManagedUser = {
      id: randomUUID(),
      fullName,
      firstName,
      lastName,
      email,
      role: input.roleKey,
      roleKey: input.roleKey,
      phone,
      status: "active",
      isActive: true,
      isBanned: false,
      bannedAt: null,
      banReason: null,
      deletedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
    };

    return this.hold(
      { kind: "create", user },
      [user.id],
      `ساخت حساب برای ${user.fullName} با نقش ${user.roleKey}`,
      input.password,
    );
  }

  /**
   * Describes an edit and holds it. Sends nothing.
   *
   * The user is read first — a read is not a change — so the proposal can be
   * refused here rather than after the user has confirmed something impossible.
   */
  async proposeEdit(userId: string, patch: UserPatch): Promise<Proposal> {
    if (!validUserId(userId)) return this.refuse("invalid-user-id");
    const fields = Object.keys(patch).filter((key) => patch[key as keyof UserPatch] !== undefined);
    if (fields.length === 0) return this.refuse("no-change");
    if (patch.fullName !== undefined && !validName(patch.fullName)) return this.refuse("invalid-name");
    if (patch.firstName !== undefined && !validName(patch.firstName)) return this.refuse("invalid-name");
    if (patch.lastName !== undefined && !validName(patch.lastName)) return this.refuse("invalid-name");
    if (patch.email !== undefined && !validEmail(patch.email)) return this.refuse("invalid-email");
    if (patch.role !== undefined && !validRole(patch.role, this.roleKeys)) return this.refuse("invalid-role");
    if (patch.roleKey !== undefined && !validRole(patch.roleKey, this.roleKeys)) return this.refuse("invalid-role");

    if (patch.fullName !== undefined) patch = { ...patch, fullName: patch.fullName.trim() };
    if (patch.firstName !== undefined) patch = { ...patch, firstName: patch.firstName.trim() };
    if (patch.lastName !== undefined) patch = { ...patch, lastName: patch.lastName.trim() };
    if (patch.email !== undefined) patch = { ...patch, email: patch.email.trim().toLowerCase() };
    if (patch.role !== undefined) patch = { ...patch, roleKey: patch.role };

    if (patch.phone !== undefined && patch.phone !== null) {
      if (!validPhone(patch.phone)) return this.refuse("invalid-phone");
      patch = { ...patch, phone: toAsciiDigits(patch.phone.trim()) };
    }

    const existing = await this.get(userId);
    if (!existing) return this.refuse("not-found");
    if (
      !this.isLive && patch.email !== undefined &&
      [...this.store.values()].some((user) => user.id !== userId && user.email.toLowerCase() === patch.email)
    ) return this.refuse("email-taken");

    if (patch.firstName !== undefined || patch.lastName !== undefined) {
      const currentName = existing.fullName || [existing.firstName, existing.lastName].filter(Boolean).join(" ");
      const [currentFirst = "", ...currentLast] = currentName.split(/\s+/u);
      const fullName = `${patch.firstName ?? currentFirst} ${patch.lastName ?? currentLast.join(" ")}`.trim();
      patch = { ...patch, fullName };
    }
    if (patch.roleKey !== undefined) patch = { ...patch, role: patch.roleKey };
    if (patch.status !== undefined) patch = { ...patch, isActive: patch.status === "active" };

    return this.hold(
      { kind: "edit", userId, patch },
      [userId],
      `ویرایش کاربر ${userId}: ${fields.join("، ")}`,
    );
  }

  /** Role assignment goes through the same confirmed edit flow; the API must run assertCanGrantRole. */
  async proposeRoleChange(userId: string, roleKey: UserRole): Promise<Proposal> {
    if (!validRole(roleKey, this.roleKeys)) return this.refuse("invalid-role");
    return await this.proposeEdit(userId, { roleKey });
  }

  async proposeBan(userId: string, reason?: string): Promise<Proposal> {
    if (!validUserId(userId)) return this.refuse("invalid-user-id");
    const trimmedReason = reason?.trim() || null;
    if (trimmedReason && [...trimmedReason].length > 500) return this.refuse("invalid-ban-reason");
    const existing = await this.get(userId);
    if (!existing) return this.refuse("not-found");
    return this.hold(
      { kind: "ban", userId, reason: trimmedReason },
      [userId],
      `مسدودکردن کاربر ${userId}`,
    );
  }

  async proposeUnban(userId: string): Promise<Proposal> {
    if (!validUserId(userId)) return this.refuse("invalid-user-id");
    const existing = await this.get(userId);
    if (!existing) return this.refuse("not-found");
    return this.hold({ kind: "unban", userId }, [userId], `رفع مسدودی کاربر ${userId}`);
  }

  async proposePasswordChange(
    userId: string,
    newPassword: string,
    confirmation: string,
  ): Promise<Proposal> {
    if (!validUserId(userId)) return this.refuse("invalid-user-id");
    if (!validPassword(newPassword)) return this.refuse("invalid-password");
    if (newPassword !== confirmation) return this.refuse("password-mismatch");
    const existing = await this.get(userId);
    if (!existing) return this.refuse("not-found");
    return this.hold(
      { kind: "password-change", userId },
      [userId],
      `تغییر رمز کاربر ${userId}`,
      newPassword,
    );
  }

  async proposePasswordReset(userId: string): Promise<Proposal> {
    if (!validUserId(userId)) return this.refuse("invalid-user-id");
    const existing = await this.get(userId);
    if (!existing) return this.refuse("not-found");
    return this.hold(
      { kind: "password-reset", userId },
      [userId],
      `بازنشانی رمز کاربر ${userId}`,
    );
  }

  async proposeDelete(userId: string): Promise<Proposal> {
    if (!validUserId(userId)) return this.refuse("invalid-user-id");
    const existing = await this.get(userId);
    if (!existing) return this.refuse("not-found");
    return this.hold({ kind: "delete", userId }, [userId], `حذف کاربر ${userId}`);
  }

  async proposeBulk(userIds: string[], action: BulkAction): Promise<Proposal> {
    if (!["enable", "disable", "delete"].includes(action)) return this.refuse("unknown-action");

    const ids = [...new Set((userIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
    if (ids.length === 0) return this.refuse("empty-list");
    if (ids.some((id) => !validUserId(id))) return this.refuse("invalid-user-id");

    // Only offer to act on users that exist. Silently dropping an id the caller
    // typo'd is how a bulk delete ends up doing something other than intended.
    const known: string[] = [];
    const missing: string[] = [];
    for (const id of ids) ((await this.get(id)) ? known : missing).push(id);
    if (known.length === 0) return this.refuse("not-found");

    const verb =
      action === "enable" ? "فعال‌کردن" : action === "disable" ? "غیرفعال‌کردن" : "حذف";
    const note = missing.length > 0 ? ` (${missing.join("، ")} پیدا نشد)` : "";
    return this.hold(
      { kind: "bulk", action, userIds: known },
      known,
      `${verb} ${toPersianDigits(known.length)} کاربر${note}`,
    );
  }

  /* ────────────────────── confirming or dropping ───────────────────── */

  /** The proposal behind a token, or null when it is gone or too old. */
  pendingChange(token: string): PendingChange | null {
    const change = this.pending.get(token);
    if (!change) return null;
    if (change.expiresAt <= this.now()) {
      this.pending.delete(token);
      this.pendingPasswords.delete(token);
      return null;
    }
    return change;
  }

  /** How many proposals are waiting. Useful in a health check. */
  pendingCount(): number {
    return this.pending.size;
  }

  cancel(token: string): boolean {
    this.pendingPasswords.delete(token);
    return this.pending.delete(token);
  }

  /**
   * Carries out a proposal. This is the only place a mutating request is made.
   *
   * A token is single-use: it is removed before the work is attempted, so a
   * retry cannot apply the same change twice — which for a delete is harmless
   * and for a bulk edit is not.
   */
  async confirm(token: string): Promise<ConfirmResult> {
    const change = this.pending.get(token);
    if (!change) return { ok: false, code: "unknown-token", message: "چنین درخواستی وجود ندارد." };

    this.pending.delete(token);
    const password = this.pendingPasswords.get(token);
    this.pendingPasswords.delete(token);

    if (change.expiresAt <= this.now()) {
      logWarn("users.change_expired", { token, kind: change.action.kind });
      return {
        ok: false,
        code: "expired",
        message: "این تغییر منقضی شده. دوباره بگو تا از اول پیشنهاد بدهم.",
      };
    }

    const mode = this.mode;
    const outcome =
      mode === "live"
        ? await this.applyLive(change.action, password)
        : await this.applyDummy(change.action);

    logInfo("users.change_applied", {
      kind: change.action.kind,
      mode,
      applied: outcome.applied.length,
      failed: outcome.failed.length,
    });

    return { ok: true, ...outcome, sent: true, mode };
  }

  /* ───────────────────────────── internals ─────────────────────────── */

  private refuse(code: ProposalFailure): Proposal {
    return { ok: false, code, message: MESSAGES[code][this.locale] };
  }

  private hold(
    action: PendingChange["action"],
    affected: string[],
    summary: string,
    password?: string,
  ): Proposal {
    const token = randomUUID();
    const change: PendingChange = {
      token,
      action,
      summary,
      affected,
      expiresAt: this.now() + this.pendingTtlMs,
    };
    this.pending.set(token, change);
    if (password !== undefined) this.pendingPasswords.set(token, password);
    logInfo("users.change_proposed", { kind: action.kind, affected: affected.length });
    return { ok: true, change };
  }

  private async applyDummy(action: PendingChange["action"]): Promise<ApplyOutcome> {
    const applied: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    const stamp = new Date(this.now()).toISOString();

    const touch = (user: ManagedUser, patch: Partial<ManagedUser>): void => {
      this.store.set(user.id, { ...user, ...patch, updatedAt: stamp });
    };

    if (action.kind === "create") {
      this.store.set(action.user.id, { ...action.user });
      return { applied: [action.user.id], failed };
    }

    if (action.kind === "ban" || action.kind === "unban") {
      const user = this.store.get(action.userId);
      if (!user || user.deletedAt) return { applied, failed: [{ id: action.userId, reason: "not-found" }] };
      if (action.kind === "ban") {
        touch(user, { isBanned: true, bannedAt: stamp, banReason: action.reason, status: "banned" });
      } else {
        touch(user, {
          isBanned: false,
          bannedAt: null,
          banReason: null,
          status: user.isActive ? "active" : "disabled",
        });
      }
      return { applied: [action.userId], failed };
    }

    if (action.kind === "edit") {
      const user = this.store.get(action.userId);
      if (!user || user.deletedAt) return { applied, failed: [{ id: action.userId, reason: "not-found" }] };
      touch(user, action.patch as Partial<ManagedUser>);
      return { applied: [user.id], failed };
    }

    if (action.kind === "delete") {
      const user = this.store.get(action.userId);
      if (!user || user.deletedAt) return { applied, failed: [{ id: action.userId, reason: "not-found" }] };
      touch(user, { deletedAt: stamp });
      return { applied: [action.userId], failed };
    }

    if (action.kind === "password-change" || action.kind === "password-reset") {
      const user = this.store.get(action.userId);
      if (!user || user.deletedAt) return { applied, failed: [{ id: action.userId, reason: "not-found" }] };
      if (action.kind === "password-change") return { applied: [action.userId], failed };
      return {
        applied: [action.userId],
        failed,
        temporaryPassword: `${randomBytes(12).toString("base64url")}aA1!`,
        passwordChangeRequired: true,
      };
    }

    for (const id of action.userIds) {
      const user = this.store.get(id);
      if (!user || user.deletedAt) {
        failed.push({ id, reason: "not-found" });
        continue;
      }
      if (action.action === "delete") touch(user, { deletedAt: stamp });
      else {
        const status: UserStatus = action.action === "enable" ? "active" : "disabled";
        touch(user, { status, isActive: status === "active" });
      }
      applied.push(id);
    }
    return { applied, failed };
  }

  private async applyLive(action: PendingChange["action"], password?: string): Promise<ApplyOutcome> {
    if (action.kind === "create") {
      const res = await this.request("users", {
        method: "POST",
        body: {
          fullName: action.user.fullName,
          email: action.user.email,
          phone: action.user.phone,
          password,
          roleKey: action.user.roleKey,
        },
      });
      return res.ok
        ? { applied: [action.user.id], failed: [] }
        : { applied: [], failed: [{ id: action.user.id, reason: res.reason, status: res.status }] };
    }

    if (action.kind === "ban" || action.kind === "unban") {
      const body = action.kind === "ban"
        ? { isBanned: true, banReason: action.reason }
        : { isBanned: false, banReason: null };
      const res = await this.request(`users/${encodeURIComponent(action.userId)}`, {
        method: "PATCH",
        body,
      });
      return res.ok
        ? { applied: [action.userId], failed: [] }
        : { applied: [], failed: [{ id: action.userId, reason: res.reason, status: res.status }] };
    }

    if (action.kind === "edit") {
      const body: Record<string, unknown> = { ...action.patch };
      delete body.firstName;
      delete body.lastName;
      delete body.role;
      delete body.status;
      const res = await this.request(`users/${encodeURIComponent(action.userId)}`, {
        method: "PATCH",
        body,
      });
      return res.ok
        ? { applied: [action.userId], failed: [] }
        : { applied: [], failed: [{ id: action.userId, reason: res.reason, status: res.status }] };
    }

    if (action.kind === "delete") {
      const res = await this.request(`users/${encodeURIComponent(action.userId)}`, {
        method: "DELETE",
      });
      return res.ok
        ? { applied: [action.userId], failed: [] }
        : { applied: [], failed: [{ id: action.userId, reason: res.reason, status: res.status }] };
    }

    if (action.kind === "password-change") {
      const res = await this.request(`users/${encodeURIComponent(action.userId)}/password`, {
        method: "PUT",
        body: { newPassword: password, confirmation: password },
      });
      return res.ok
        ? { applied: [action.userId], failed: [] }
        : { applied: [], failed: [{ id: action.userId, reason: res.reason, status: res.status }] };
    }

    if (action.kind === "password-reset") {
      const res = await this.request(`users/${encodeURIComponent(action.userId)}/reset-password`, {
        method: "POST",
        body: {},
      });
      if (!res.ok) return { applied: [], failed: [{ id: action.userId, reason: res.reason, status: res.status }] };
      const body = res.body && typeof res.body === "object" ? res.body as Record<string, unknown> : {};
      return {
        applied: [action.userId],
        failed: [],
        ...(typeof body.temporaryPassword === "string" ? { temporaryPassword: body.temporaryPassword } : {}),
        passwordChangeRequired: body.passwordChangeRequired !== false,
      };
    }

    // One call for the whole list: a bulk action is one decision, and N
    // requests would be N chances to end up half-applied.
    const res = await this.request("users/bulk", {
      method: "POST",
      body: { action: action.action, ids: action.userIds },
    });
    if (!res.ok) {
      return {
        applied: [],
        failed: action.userIds.map((id) => ({ id, reason: res.reason, status: res.status })),
      };
    }

    // Trust the server's own accounting when it gives one; otherwise assume it
    // took all of them, since it said 2xx.
    const body = res.body as Record<string, unknown> | null;
    if (body && Array.isArray(body.applied)) {
      const applied = body.applied.map(String);
      const reported = Array.isArray(body.failed) ? (body.failed as unknown[]) : [];
      const failed = reported.map((entry) => {
        const record = (entry ?? {}) as Record<string, unknown>;
        return { id: String(record.id ?? ""), reason: String(record.reason ?? "failed") };
      });
      return { applied, failed };
    }
    return { applied: [...action.userIds], failed: [] };
  }

  private async fetchUsers(query: string, path = "users"): Promise<SearchResult> {
    const url = query
      ? `${this.baseUrl}/${path}?q=${encodeURIComponent(query)}`
      : `${this.baseUrl}/${path}`;

    const res = await this.request(url, { absolute: true });
    if (!res.ok) return { users: [], live: true, error: res.reason, status: res.status };

    const users = readUsers(res.body);
    if (!users) return { users: [], live: true, error: "unparsable response" };
    return {
      users: users.filter((user) => Boolean(user) && typeof user === "object" && !user.deletedAt),
      live: true,
    };
  }

  /**
   * One HTTP call, wrapped.
   *
   * Never throws: a transport failure is reported as `{ ok: false }` so a chat
   * turn can say "it did not work" instead of surfacing a stack trace.
   */
  private async request(
    target: string,
    init: { method?: string; body?: unknown; absolute?: boolean } = {},
  ): Promise<{ ok: boolean; status: number; reason: string; body: unknown }> {
    if (!this.authorization) {
      return { ok: false, status: 401, reason: "missing or invalid Basic Auth credentials", body: null };
    }
    if (!/^https:\/\//iu.test(this.baseUrl)) {
      return { ok: false, status: 0, reason: "HTTPS is required for Basic Auth", body: null };
    }

    const url = init.absolute ? target : `${this.baseUrl}/${target}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: init.method ?? "GET",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: this.authorization,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
        cache: "no-store",
      });

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
        const detail =
          body && typeof body === "object" && "message" in (body as Record<string, unknown>)
            ? String((body as Record<string, unknown>).message)
            : `HTTP ${response.status}`;
        logWarn("users.request_failed", { method: init.method ?? "GET", status: response.status });
        return { ok: false, status: response.status, reason: detail, body };
      }
      return { ok: true, status: response.status, reason: "", body };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      const reason = aborted ? "timeout" : error instanceof Error ? error.message : String(error);
      logWarn("users.request_error", { method: init.method ?? "GET", reason });
      return { ok: false, status: 0, reason, body: null };
    } finally {
      clearTimeout(timer);
    }
  }
}
