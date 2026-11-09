import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

import { getRunner } from "@/lib/db/client";
import { ensureSchema } from "@/lib/db/schema";

const TABLE = "auth_login_flows";
const VERSION = "v1";
export const OTP_LOGIN_FLOW_TTL_MS = 10 * 60 * 1000;

export type OtpLoginFlow =
  | { step: "phone"; expiresAt: number }
  | { step: "code"; phone: string; expiresAt: number };

export interface OtpLoginFlowStore {
  save(flowId: string, flow: OtpLoginFlow): Promise<boolean>;
  get(flowId: string): Promise<OtpLoginFlow | null>;
  delete(flowId: string): Promise<boolean>;
}

export type EncryptedOtpLoginFlowStoreOptions = {
  encryptionKey?: string;
  now?: () => number;
  maxAgeMs?: number;
};

type Envelope = { version: typeof VERSION; iv: string; tag: string; ciphertext: string };

function readKey(raw: string | undefined): Buffer | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^[0-9a-f]{64}$/iu.test(value)) return Buffer.from(value, "hex");
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 ? decoded : null;
}

function deriveKey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.from("nafas-auth-sessions-v1"), Buffer.from(purpose), 32));
}

function flowDigest(flowId: string, key: Buffer): string {
  return createHmac("sha256", deriveKey(key, "login-flow-index"))
    .update(flowId, "utf8")
    .digest("hex");
}

function encrypt(flow: OtpLoginFlow, key: Buffer, digest: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(key, "login-flow-encryption"), iv);
  cipher.setAAD(Buffer.from(digest, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(flow), "utf8")),
    cipher.final(),
  ]);
  const envelope: Envelope = {
    version: VERSION,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

function decrypt(value: unknown, key: Buffer, digest: string): OtpLoginFlow | null {
  if (typeof value !== "string") return null;
  try {
    const envelope = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Envelope>;
    if (envelope.version !== VERSION || !envelope.iv || !envelope.tag || !envelope.ciphertext) return null;
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(key, "login-flow-encryption"), Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(Buffer.from(digest, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const raw = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const flow = parsed as Partial<OtpLoginFlow>;
    if (typeof flow.expiresAt !== "number" || !Number.isFinite(flow.expiresAt)) return null;
    if (flow.step === "phone") return { step: "phone", expiresAt: flow.expiresAt };
    if (flow.step === "code" && typeof flow.phone === "string" && flow.phone.length > 0) {
      return { step: "code", phone: flow.phone, expiresAt: flow.expiresAt };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Short-lived OTP conversation state. Flow ids and phone numbers are never
 * stored in plaintext: the DB key is an HMAC and the whole flow is encrypted.
 */
export class EncryptedOtpLoginFlowStore implements OtpLoginFlowStore {
  private readonly keyOverride?: string;
  private readonly now: () => number;
  private readonly maxAgeMs: number;

  constructor(options: EncryptedOtpLoginFlowStoreOptions = {}) {
    this.keyOverride = options.encryptionKey;
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? OTP_LOGIN_FLOW_TTL_MS;
  }

  async save(flowIdInput: string, flow: OtpLoginFlow): Promise<boolean> {
    const flowId = flowIdInput.trim();
    const now = this.now();
    if (!flowId || flowId.length > 256 || !Number.isFinite(flow.expiresAt) || flow.expiresAt <= now) return false;
    const key = readKey(this.keyOverride ?? process.env.AUTH_SESSION_ENCRYPTION_KEY);
    const run = getRunner();
    if (!key || !run || !Number.isFinite(this.maxAgeMs) || this.maxAgeMs <= 0) return false;
    const digest = flowDigest(flowId, key);
    const expiresAt = Math.min(flow.expiresAt, now + this.maxAgeMs);
    const safeFlow = { ...flow, expiresAt } as OtpLoginFlow;
    const payload = encrypt(safeFlow, key, digest);
    try {
      if (!(await ensureSchema(run))) return false;
      await run(`
        insert into ${TABLE} (flow_id_hash, encrypted_payload, expires_at, updated_at)
        values ($1, $2, to_timestamp($3 / 1000.0), now())
        on conflict (flow_id_hash) do update
          set encrypted_payload = excluded.encrypted_payload,
              expires_at = excluded.expires_at,
              updated_at = now()
      `.trim(), [digest, payload, expiresAt]);
      return true;
    } catch {
      return false;
    }
  }

  async get(flowIdInput: string): Promise<OtpLoginFlow | null> {
    const flowId = flowIdInput.trim();
    if (!flowId || flowId.length > 256) return null;
    const key = readKey(this.keyOverride ?? process.env.AUTH_SESSION_ENCRYPTION_KEY);
    const run = getRunner();
    if (!key || !run) return null;
    const digest = flowDigest(flowId, key);
    try {
      if (!(await ensureSchema(run))) return null;
      const rows = await run(`
        select encrypted_payload from ${TABLE}
         where flow_id_hash = $1 and expires_at > now()
         limit 1
      `.trim(), [digest]);
      const row = rows[0] as { encrypted_payload?: unknown } | undefined;
      const flow = row ? decrypt(row.encrypted_payload, key, digest) : null;
      if (!flow || flow.expiresAt <= this.now()) return null;
      return flow;
    } catch {
      return null;
    }
  }

  async delete(flowIdInput: string): Promise<boolean> {
    const flowId = flowIdInput.trim();
    if (!flowId || flowId.length > 256) return false;
    const key = readKey(this.keyOverride ?? process.env.AUTH_SESSION_ENCRYPTION_KEY);
    const run = getRunner();
    if (!key || !run) return false;
    try {
      if (!(await ensureSchema(run))) return false;
      await run(`delete from ${TABLE} where flow_id_hash = $1`, [flowDigest(flowId, key)]);
      return true;
    } catch {
      return false;
    }
  }
}

