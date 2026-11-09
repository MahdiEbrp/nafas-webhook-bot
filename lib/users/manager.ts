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

import { randomUUID } from "node:crypto";

import type { Locale } from "@/lib/config";
import { logInfo, logWarn } from "@/lib/log";
import { normalizeIranPhone, toAsciiDigits } from "@/lib/phone";
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

export type UserManagerOptions = {
  /** When set, calls go to this API instead of the dummy store. */
  baseUrl?: string;
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
      id: "u-1001",
      firstName: "مریم",
      lastName: "احمدی",
      email: "maryam.ahmadi@example.test",
      role: "customer",
      phone: "09121234567",
      status: "active",
      createdAt: SEED_STAMP,
      updatedAt: SEED_STAMP,
    },
    {
      id: "u-1002",
      firstName: "مریم",
      lastName: "رضایی",
      email: "maryam.rezaei@example.test",
      role: "customer",
      phone: "09351234567",
      status: "active",
      createdAt: SEED_STAMP,
      updatedAt: SEED_STAMP,
    },
    {
      id: "u-1003",
      firstName: "علی",
      lastName: "محمدی",
      email: "ali.mohammadi@example.test",
      role: "doctor",
      phone: null,
      status: "disabled",
      createdAt: SEED_STAMP,
      updatedAt: SEED_STAMP,
    },
  ];
}

const MESSAGES: Record<ProposalFailure, Record<Locale, string>> = {
  "invalid-name": { fa: "نام و نام خانوادگی هرکدام باید دست‌کم ۲ نویسه باشند.", en: "First and last names must each contain at least 2 characters." },
  "invalid-email": { fa: "نشانی ایمیل معتبر نیست.", en: "The email address is not valid." },
  "invalid-password": { fa: "رمز باید دست‌کم ۸ نویسه و شامل عدد، حرف بزرگ و نماد ویژه باشد.", en: "The password must be at least 8 characters and include a number, uppercase letter, and special symbol." },
  "invalid-role": { fa: "این نقش معتبر نیست. نقش باید مدیر، پزشک، پذیرش یا مشتری باشد.", en: "The role must be admin, doctor, reception, or customer." },
  "not-found": { fa: "چنین کاربری پیدا نشد.", en: "No such user." },
  "no-change": { fa: "چیزی برای تغییر نگفتی.", en: "You did not ask to change anything." },
  "empty-list": { fa: "لیست خالی است؛ کسی را انتخاب نکرده‌ای.", en: "The list is empty; nobody was selected." },
  "unknown-action": { fa: "این کار را نمی‌شناسم.", en: "I do not know that action." },
  "bad-phone": {
    fa: "این شماره، موبایل ایران نیست. شکل درست مثل ۰۹۱۲۱۲۳۴۵۶۷ است.",
    en: "That is not an Iranian mobile. The right shape is like 09121234567.",
  },
};

const USER_ROLES: readonly UserRole[] = ["admin", "doctor", "reception", "customer"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function validName(value: unknown): value is string {
  return typeof value === "string" && [...value.trim()].length >= 2;
}

function validEmail(value: unknown): value is string {
  return typeof value === "string" && EMAIL_PATTERN.test(value.trim());
}

function validPassword(value: unknown): value is string {
  if (typeof value !== "string" || [...value].length < 8) return false;
  return /\p{N}/u.test(value) && /\p{Lu}/u.test(value) && /[^\p{L}\p{N}]/u.test(value);
}

function validRole(value: unknown): value is UserRole {
  return USER_ROLES.includes(value as UserRole);
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
    return { users: [...this.store.values()], live: false };
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

    const all = [...this.store.values()];
    if (!needle) return { users: all, live: false };

    // Persian digits first: `\D` does not match «۰۹۱۲», so stripping
    // non-digits from a Persian-typed number leaves nothing to search for.
    const ascii = toAsciiDigits(needle);
    const flat = ascii.replace(/\s+/g, " ").toLowerCase();
    const digits = ascii.replace(/\D/g, "");

    const matches = all.filter((user) => {
      const name = `${user.firstName} ${user.lastName}`.toLowerCase();
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
    return this.store.get(userId) ?? null;
  }

  /* ─────────────────────── proposing a change ──────────────────────── */

  /**
   * Describes a new account without sending or storing its password.
   * The secret is held privately until confirmation, then discarded.
   */
  async proposeCreate(input: UserCreateInput): Promise<Proposal> {
    if (!validName(input?.firstName) || !validName(input?.lastName)) return this.refuse("invalid-name");
    if (!validEmail(input?.email)) return this.refuse("invalid-email");
    if (!validPassword(input?.password)) return this.refuse("invalid-password");
    if (!validRole(input?.role)) return this.refuse("invalid-role");

    const phone = normalizeIranPhone(input.phone);
    if (!phone.ok) return this.refuse("bad-phone");

    const stamp = new Date(this.now()).toISOString();
    const user: ManagedUser = {
      id: `u-${randomUUID()}`,
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      email: input.email.trim().toLowerCase(),
      role: input.role,
      phone: phone.normalized,
      status: "active",
      createdAt: stamp,
      updatedAt: stamp,
    };

    return this.hold(
      { kind: "create", user },
      [user.id],
      `ساخت حساب برای ${user.firstName} ${user.lastName} با نقش ${user.role}`,
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
    const fields = Object.keys(patch).filter((key) => patch[key as keyof UserPatch] !== undefined);
    if (fields.length === 0) return this.refuse("no-change");
    if (patch.firstName !== undefined && !validName(patch.firstName)) return this.refuse("invalid-name");
    if (patch.lastName !== undefined && !validName(patch.lastName)) return this.refuse("invalid-name");
    if (patch.email !== undefined && !validEmail(patch.email)) return this.refuse("invalid-email");
    if (patch.role !== undefined && !validRole(patch.role)) return this.refuse("invalid-role");

    if (patch.firstName !== undefined) patch = { ...patch, firstName: patch.firstName.trim() };
    if (patch.lastName !== undefined) patch = { ...patch, lastName: patch.lastName.trim() };
    if (patch.email !== undefined) patch = { ...patch, email: patch.email.trim().toLowerCase() };

    if (patch.phone !== undefined && patch.phone !== null) {
      const check = normalizeIranPhone(patch.phone);
      if (!check.ok) return this.refuse("bad-phone");
      // Store the normalised form, not whatever shape it arrived in.
      patch = { ...patch, phone: check.normalized };
    }

    const existing = await this.get(userId);
    if (!existing) return this.refuse("not-found");

    return this.hold(
      { kind: "edit", userId, patch },
      [userId],
      `ویرایش کاربر ${userId}: ${fields.join("، ")}`,
    );
  }

  async proposeDelete(userId: string): Promise<Proposal> {
    const existing = await this.get(userId);
    if (!existing) return this.refuse("not-found");
    return this.hold({ kind: "delete", userId }, [userId], `حذف کاربر ${userId}`);
  }

  async proposeBulk(userIds: string[], action: BulkAction): Promise<Proposal> {
    if (!["enable", "disable", "delete"].includes(action)) return this.refuse("unknown-action");

    const ids = [...new Set((userIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
    if (ids.length === 0) return this.refuse("empty-list");

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

  private async applyDummy(
    action: PendingChange["action"],
  ): Promise<{ applied: string[]; failed: Array<{ id: string; reason: string }> }> {
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

    if (action.kind === "edit") {
      const user = this.store.get(action.userId);
      if (!user) return { applied, failed: [{ id: action.userId, reason: "not-found" }] };
      touch(user, action.patch as Partial<ManagedUser>);
      return { applied: [user.id], failed };
    }

    if (action.kind === "delete") {
      if (!this.store.delete(action.userId)) {
        return { applied, failed: [{ id: action.userId, reason: "not-found" }] };
      }
      return { applied: [action.userId], failed };
    }

    for (const id of action.userIds) {
      const user = this.store.get(id);
      if (!user) {
        failed.push({ id, reason: "not-found" });
        continue;
      }
      if (action.action === "delete") this.store.delete(id);
      else {
        const status: UserStatus = action.action === "enable" ? "active" : "disabled";
        touch(user, { status });
      }
      applied.push(id);
    }
    return { applied, failed };
  }

  private async applyLive(
    action: PendingChange["action"],
    password?: string,
  ): Promise<{ applied: string[]; failed: Array<{ id: string; reason: string }> }> {
    if (action.kind === "create") {
      const res = await this.request("users", {
        method: "POST",
        body: { ...action.user, password },
      });
      return res.ok
        ? { applied: [action.user.id], failed: [] }
        : { applied: [], failed: [{ id: action.user.id, reason: res.reason }] };
    }

    if (action.kind === "edit") {
      const res = await this.request(`users/${encodeURIComponent(action.userId)}`, {
        method: "PATCH",
        body: action.patch,
      });
      return res.ok
        ? { applied: [action.userId], failed: [] }
        : { applied: [], failed: [{ id: action.userId, reason: res.reason }] };
    }

    if (action.kind === "delete") {
      const res = await this.request(`users/${encodeURIComponent(action.userId)}`, {
        method: "DELETE",
      });
      return res.ok
        ? { applied: [action.userId], failed: [] }
        : { applied: [], failed: [{ id: action.userId, reason: res.reason }] };
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
        failed: action.userIds.map((id) => ({ id, reason: res.reason })),
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
    if (!res.ok) return { users: [], live: true, error: res.reason };

    const users = readUsers(res.body);
    if (!users) return { users: [], live: true, error: "unparsable response" };
    return { users, live: true };
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
    const url = init.absolute ? target : `${this.baseUrl}/${target}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: init.method ?? "GET",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
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
