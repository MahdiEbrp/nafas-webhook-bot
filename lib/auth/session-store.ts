import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

import { logWarn } from "@/lib/log";

import { getRunner } from "@/lib/db/client";
import { ensureSchema } from "@/lib/db/schema";

export const AUTH_SESSION_TABLE = "auth_sessions";
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const VERSION = "v1";

export type StoredAuthSession = {
  /** Authenticated account identifier (usually the verified phone), encrypted in the row payload. */
  actorId: string;
  /** Optional trusted owner key for lookup (for example a Telegram user's stable session id). Also encrypted. */
  lookupId?: string;
  sessionCookie: string;
  csrfToken?: string;
  /** Optional upstream cookie/API expiry in Unix milliseconds. */
  expiresAt?: number;
};

export interface AuthSessionStore {
  save(session: StoredAuthSession): Promise<boolean>;
  get(actorId: string): Promise<StoredAuthSession | null>;
  delete(actorId: string): Promise<boolean>;
}

export type EncryptedAuthSessionStoreOptions = {
  /** 32-byte key as 64 hex chars or base64. Defaults to AUTH_SESSION_ENCRYPTION_KEY. */
  encryptionKey?: string;
  /** Local retention cap; upstream expiry, when known, can only shorten it. */
  maxAgeMs?: number;
  now?: () => number;
};

type EncryptedPayload = {
  version: typeof VERSION;
  iv: string;
  tag: string;
  ciphertext: string;
};

type SessionRow = { encrypted_payload?: unknown };

function readKey(raw: string | undefined): Buffer | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^[0-9a-f]{64}$/iu.test(value)) return Buffer.from(value, "hex");
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 ? decoded : null;
}

function derivedKey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.from("nafas-auth-sessions-v1"), Buffer.from(purpose), 32));
}

function actorDigest(actorId: string, key: Buffer): string {
  return createHmac("sha256", derivedKey(key, "actor-index"))
    .update(actorId, "utf8")
    .digest("hex");
}

function encryptPayload(session: StoredAuthSession, key: Buffer, digest: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedKey(key, "session-encryption"), iv);
  cipher.setAAD(Buffer.from(digest, "utf8"));
  const plaintext = Buffer.from(JSON.stringify(session), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const payload: EncryptedPayload = {
    version: VERSION,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: encrypted.toString("base64url"),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decryptPayload(value: unknown, key: Buffer, digest: string): StoredAuthSession | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const payload = parsed as Partial<EncryptedPayload>;
    if (payload.version !== VERSION || !payload.iv || !payload.tag || !payload.ciphertext) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derivedKey(key, "session-encryption"),
      Buffer.from(payload.iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(digest, "utf8"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const session: unknown = JSON.parse(plaintext);
    if (!session || typeof session !== "object") return null;
    const record = session as Partial<StoredAuthSession>;
    if (
      typeof record.actorId !== "string"
      || typeof record.sessionCookie !== "string"
      || !record.sessionCookie
      || (record.lookupId !== undefined && typeof record.lookupId !== "string")
      || (record.csrfToken !== undefined && typeof record.csrfToken !== "string")
      || (record.expiresAt !== undefined && typeof record.expiresAt !== "number")
    ) return null;
    return record as StoredAuthSession;
  } catch {
    return null;
  }
}

function validSession(session: StoredAuthSession): boolean {
  return typeof session.actorId === "string" && session.actorId.trim().length > 0
    && typeof session.sessionCookie === "string" && session.sessionCookie.trim().length > 0
    && (session.lookupId === undefined || (typeof session.lookupId === "string" && session.lookupId.trim().length > 0))
    && (session.csrfToken === undefined || typeof session.csrfToken === "string");
}

/**
 * Stores the session cookie and CSRF token only as AES-256-GCM ciphertext.
 * The indexed actor key is an HMAC, so the account phone is not stored in clear.
 * Missing/invalid encryption key or missing database fails closed.
 */
export class EncryptedAuthSessionStore implements AuthSessionStore {
  private readonly keyOverride?: string;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(options: EncryptedAuthSessionStoreOptions = {}) {
    this.keyOverride = options.encryptionKey;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
  }

  async save(input: StoredAuthSession): Promise<boolean> {
    if (!validSession(input) || !Number.isFinite(this.maxAgeMs) || this.maxAgeMs <= 0) return false;
    const key = readKey(this.keyOverride ?? process.env.AUTH_SESSION_ENCRYPTION_KEY);
    const run = getRunner();
    if (!key || !run) return false;

    const actorId = input.actorId.trim();
    const lookupId = input.lookupId?.trim() || actorId;
    const digest = actorDigest(lookupId, key);
    const expiryCap = this.now() + this.maxAgeMs;
    const expiry = Math.min(input.expiresAt ?? expiryCap, expiryCap);
    if (!Number.isFinite(expiry) || expiry <= this.now()) return false;
    const session = { ...input, actorId, lookupId, expiresAt: expiry };
    const encrypted = encryptPayload(session, key, digest);
    const sql = `
      insert into ${AUTH_SESSION_TABLE} (actor_id_hash, encrypted_payload, expires_at, created_at, updated_at)
      values ($1, $2, to_timestamp($3 / 1000.0), now(), now())
      on conflict (actor_id_hash) do update
        set encrypted_payload = excluded.encrypted_payload,
            expires_at = excluded.expires_at,
            updated_at = now()
    `.trim();

    try {
      if (!(await ensureSchema(run))) return false;
      await run(sql, [digest, encrypted, expiry]);
      return true;
    } catch {
      logWarn("db.auth_session_save_failed", { operation: "upsert" });
      return false;
    }
  }

  async get(actorIdInput: string): Promise<StoredAuthSession | null> {
    if (typeof actorIdInput !== "string" || !actorIdInput.trim()) return null;
    const key = readKey(this.keyOverride ?? process.env.AUTH_SESSION_ENCRYPTION_KEY);
    const run = getRunner();
    if (!key || !run) return null;
    const lookupId = actorIdInput.trim();
    const digest = actorDigest(lookupId, key);
    const sql = `
      select encrypted_payload
        from ${AUTH_SESSION_TABLE}
       where actor_id_hash = $1 and expires_at > now()
       limit 1
    `.trim();

    try {
      if (!(await ensureSchema(run))) return null;
      const rows = await run(sql, [digest]);
      const row = rows[0] as SessionRow | undefined;
      if (!row) return null;
      const session = decryptPayload(row.encrypted_payload, key, digest);
      if (!session || (session.lookupId ?? session.actorId) !== lookupId || (session.expiresAt !== undefined && session.expiresAt <= this.now())) return null;
      return session;
    } catch {
      logWarn("db.auth_session_read_failed", { operation: "select" });
      return null;
    }
  }

  async delete(actorIdInput: string): Promise<boolean> {
    if (typeof actorIdInput !== "string" || !actorIdInput.trim()) return false;
    const key = readKey(this.keyOverride ?? process.env.AUTH_SESSION_ENCRYPTION_KEY);
    const run = getRunner();
    if (!key || !run) return false;
    const digest = actorDigest(actorIdInput.trim(), key);
    try {
      if (!(await ensureSchema(run))) return false;
      await run(`delete from ${AUTH_SESSION_TABLE} where actor_id_hash = $1`, [digest]);
      return true;
    } catch {
      logWarn("db.auth_session_delete_failed", { operation: "delete" });
      return false;
    }
  }
}

export const authSessionStore: AuthSessionStore = new EncryptedAuthSessionStore();
