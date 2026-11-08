/**
 * WHO IS THIS? — staff identity for the Telegram bot, without passwords.
 *
 * WHY NOT SMS OTP
 * ---------------
 * The clinic webhook API has no OTP endpoint (checked: `authenticateWebhook`
 * accepts HTTP Basic only, and the SMS schemas in `lib/webhooks/schema.ts` have
 * no route). Even if they existed, SMS is the wrong tool for a *bot*: a server
 * cannot receive an SMS, and an OTP session expires in minutes, so unattended
 * automation would break.
 *
 * WHAT WE DO INSTEAD
 * ------------------
 * Use the phone number Telegram has already verified. When a user taps
 * "share my phone", Telegram sends their own number, and it is the same number
 * that was SMS-verified when the account was created. We then look that phone up
 * in the clinic's own user list (`GET /api/v1/webhooks/users?search=…`), so the
 * authorization decision still belongs to the clinic's data — we just never ask
 * for a password.
 *
 * Security detail that matters: we only accept the contact if
 * `contact.user_id === from.id`. Without that check a user could forward
 * somebody else's contact card and pretend to be them.
 *
 * NOTE this proves *who the person is*. The middleware still needs its own
 * service credential to talk to the webhook API — that is a machine identity,
 * not a human one, and it must stay a secret in env.
 */

import { logInfo, logWarn } from "@/lib/log";
import { normalize } from "@/lib/text";
import { callWebhook } from "@/lib/webhooks/client";

export type IdentityStatus = "unknown" | "pending" | "verified" | "rejected";

export type Identity = {
  status: IdentityStatus;
  phone?: string;
  clinicUserId?: string;
  fullName?: string;
  roleKey?: string;
  reason?: string;
  pendingText?: string;
  at: number;
};

const TTL_MS = 12 * 60 * 60 * 1000; // a working day
const store = new Map<number, Identity>();

function fresh(entry: Identity | undefined): Identity | undefined {
  if (!entry) return undefined;
  if (Date.now() - entry.at > TTL_MS) return undefined;
  return entry;
}

export function getIdentity(chatId: number): Identity | undefined {
  return fresh(store.get(chatId));
}

export function isVerified(chatId: number): boolean {
  return getIdentity(chatId)?.status === "verified";
}

export function setPending(chatId: number, reason: string, pendingText?: string): void {
  store.set(chatId, { status: "pending", reason, pendingText, at: Date.now() });
}

export function popPendingText(chatId: number): string | undefined {
  const entry = store.get(chatId);
  const text = entry?.pendingText;
  if (entry) {
    delete entry.pendingText;
  }
  return text;
}

export function clearIdentity(chatId: number): void {
  store.delete(chatId);
}

/** Iranian numbers: 09xxxxxxxxx, +98912…, 00989…, 98912… → one canonical form. */
export function normalisePhone(raw: string): string | null {
  const digits = normalize(raw).replace(/[^\d]/g, "");
  if (!digits) return null;

  let value = digits;
  if (value.startsWith("0098")) value = value.slice(4);
  else if (value.startsWith("98") && value.length >= 12) value = value.slice(2);
  else if (value.startsWith("0")) value = value.slice(1);

  // Iranian mobile: 9xxxxxxxxx (10 digits starting with 9). Landlines are 10 too.
  if (value.length !== 10) return null;
  return `0${value}`;
}

/**
 * The same number, written the way the clinic database might store it.
 * Search on the target project is a *contains* match on the raw string, so a
 * single canonical form is not enough: `0912…` never finds `+98912…`.
 */
export function searchVariants(phone: string): string[] {
  const local = phone.replace(/[^\d]/g, ""); // 09121234567
  const national = local.replace(/^0/, ""); // 9121234567
  const last8 = national.slice(-8);
  return [...new Set([local, national, `+98${national}`, `98${national}`, last8].filter(Boolean))];
}

export type ContactInput = {
  phone_number?: string;
  first_name?: string;
  user_id?: number;
};

export type VerifyResult = Identity;

/**
 * Verifies a shared Telegram contact against the clinic's user list.
 * Returns the resulting identity (verified / rejected) and stores it.
 */
export async function verifyContact(input: {
  chatId: number;
  fromId: number;
  contact: ContactInput;
}): Promise<VerifyResult> {
  const phone = normalisePhone(input.contact.phone_number ?? "");

  const reject = (reason: string): VerifyResult => {
    const identity: Identity = { status: "rejected", phone: phone ?? undefined, reason, at: Date.now() };
    store.set(input.chatId, identity);
    logWarn("identity.rejected", { chatId: input.chatId, reason });
    return identity;
  };

  // 1. The contact must be the sender's own number.
  if (typeof input.contact.user_id !== "number" || input.contact.user_id !== input.fromId) {
    return reject("not-own-contact");
  }

  if (!phone) {
    return reject(/[\d]/.test(input.contact.phone_number ?? "") ? "foreign-number" : "bad-phone");
  }

  // 2. Ask the clinic: does this phone belong to an active staff member?
  const match = await findUserByPhone(phone);
  if (!match.ok) return reject(match.reason);
  if (!match.row) return reject("phone-not-registered");

  const row = match.row;
  if (row.isActive === false) return reject("user-inactive");
  if (row.isBanned === true) return reject("user-banned");

  const identity: Identity = {
    status: "verified",
    phone,
    clinicUserId: typeof row.id === "string" ? row.id : undefined,
    fullName: typeof row.fullName === "string" ? row.fullName : undefined,
    roleKey: typeof row.roleKey === "string" ? row.roleKey : undefined,
    at: Date.now(),
  };

  store.set(input.chatId, identity);
  logInfo("identity.verified", { chatId: input.chatId, roleKey: identity.roleKey });
  return identity;
}

type LookupResult =
  | { ok: true; row: Record<string, unknown> | null }
  | { ok: false; reason: string };

const SEARCH_PAGE_SIZE = 50; // clinic caps /api/v1/webhooks/users at perPage=50 (Zod max)
const SCAN_PAGES = 3;

/**
 * Finds a user row whose stored phone equals `phone` after normalisation.
 *
 * Why three steps? The clinic's `search` is a plain contains-match on the stored
 * string, and staff numbers are stored inconsistently (`0912…`, `+98912…`,
 * `0912 000 0001`, Persian digits). So we:
 *   1. try several spellings of the number as the search term,
 *   2. and if none hit, scan a bounded number of pages and compare locally,
 *      where normalisation makes the format irrelevant.
 * The final decision is always an exact normalised comparison — never a prefix.
 */
async function findUserByPhone(phone: string): Promise<LookupResult> {
  const checked = new Set<string>();

  const consider = (rows: Array<Record<string, unknown>>): Record<string, unknown> | null => {
    for (const row of rows) {
      const id = typeof row.id === "string" ? row.id : "";
      if (id && checked.has(id)) continue;
      if (id) checked.add(id);
      if (normalisePhone(String(row.phone ?? "")) === phone) return row;
    }
    return null;
  };

  // Step 1 — targeted searches.
  for (const variant of searchVariants(phone)) {
    const result = await callWebhook({
      method: "GET",
      path: "/api/v1/webhooks/users",
      query: { search: variant, perPage: SEARCH_PAGE_SIZE, page: 1 },
    });
    if (!result.ok) {
      if (result.code === "WEBHOOK_FORBIDDEN") return { ok: false, reason: "lookup-forbidden" };
      continue; // a bad search term must not fail the whole login
    }
    const hit = consider(extractRows(result.data));
    if (hit) return { ok: true, row: hit };
  }

  // Step 2 — bounded scan, format-agnostic.
  for (let page = 1; page <= SCAN_PAGES; page += 1) {
    const result = await callWebhook({
      method: "GET",
      path: "/api/v1/webhooks/users",
      query: { page, perPage: SEARCH_PAGE_SIZE },
    });
    if (!result.ok) {
      if (result.code === "WEBHOOK_FORBIDDEN") return { ok: false, reason: "lookup-forbidden" };
      // If the clinic schema requires `search` on GET /users, an unscoped scan is
      // not supported by the target API; stop scanning and report not found.
      if (result.code === "VALIDATION_ERROR") break;
      return { ok: false, reason: `lookup-failed:${result.code}` };
    }
    const rows = extractRows(result.data);
    const hit = consider(rows);
    if (hit) return { ok: true, row: hit };
    if (rows.length < SEARCH_PAGE_SIZE) break; // last page
  }

  return { ok: true, row: null };
}

function extractRows(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["items", "rows", "results", "data", "users"]) {
      if (Array.isArray(record[key])) return record[key] as Array<Record<string, unknown>>;
    }
  }
  return [];
}

/** Telegram cannot render this if the message is long; keep it short. */
export function identitySummary(identity: Identity): string {
  if (identity.status === "verified") {
    return [identity.fullName ?? "کاربر", identity.roleKey ? `(${identity.roleKey})` : "", identity.phone ?? ""]
      .filter(Boolean)
      .join(" • ");
  }
  return identity.reason ?? identity.status;
}

export function resetIdentitiesForTesting(): void {
  store.clear();
}
