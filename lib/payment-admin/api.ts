// beauty-clinic af5d4f872a7ac8f75fa1e6780e788e83557c5100: all admin/payment routes.
import { z } from "zod";
import type { RuleRequestContext } from "@/lib/rules/types";
import { createPaymentProviderSchema, updatePaymentProviderSchema, listPaymentProvidersQuerySchema, bulkPaymentProvidersSchema } from "./providers";
import { createPaymentTransactionSchema, updatePaymentTransactionSchema, listPaymentTransactionsQuerySchema } from "./transactions";
const empty = z.object({}).strict(), id = z.uuid();
const root = "/api/v1/admin/payment";
export const paymentOperations = {
  overview: ["GET", "/overview", empty],
  providers: ["GET", "/providers", listPaymentProvidersQuerySchema.strict()],
  providerGet: ["GET", "/providers/:id", empty],
  providerCreate: ["POST", "/providers", createPaymentProviderSchema],
  providerUpdate: ["PATCH", "/providers/:id", updatePaymentProviderSchema],
  providerDelete: ["DELETE", "/providers/:id", empty],
  providerTest: ["POST", "/providers/:id/test", empty],
  providerBulk: ["POST", "/providers/bulk", bulkPaymentProvidersSchema],
  transactions: ["GET", "/transactions", listPaymentTransactionsQuerySchema.strict()],
  transactionCreate: ["POST", "/transactions", createPaymentTransactionSchema],
  transactionUpdate: ["PATCH", "/transactions/:id", updatePaymentTransactionSchema],
} as const;
export type PaymentOperation = keyof typeof paymentOperations;
export type PaymentCommand = { operation: PaymentOperation; id?: string; input: unknown };
export function validatePaymentCommand(command: PaymentCommand) {
  const descriptor = paymentOperations[command.operation];
  if (!descriptor) throw new Error("INVALID_OPERATION");
  const [method, suffix, schema] = descriptor;
  const input = schema.parse(command.input) as Record<string, unknown>;
  if (suffix.includes(":id")) id.parse(command.id);
  for (const key of ["apiUrl", "callbackUrl"]) if (input[key]) {
    const url = new URL(String(input[key]));
    if (url.protocol !== "https:" || url.username || url.password || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(url.hostname) || /\.(local|localhost)$/i.test(url.hostname)) throw new Error("UNSAFE_URL");
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 128 * 1024) throw new Error("BODY_TOO_LARGE");
  return { input, method, path: root + suffix.replace(":id", encodeURIComponent(command.id ?? "")) };
}
export type PaymentResult = { ok: true; data: Record<string, unknown> } | { ok: false; code: string; status?: number };
const provider = z.object({ id, name: z.string(), kind: z.string(), merchantConfigured: z.boolean(), isActive: z.boolean(), isDefault: z.boolean(), healthStatus: z.string(), lastHealthCheckedAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() });
export const transactionSchema = z.object({ id, bookingGroupRef: z.string(), amount: z.string(), currency: z.string(), description: z.string().nullable(), status: z.enum(["pending", "requested", "verified", "failed", "refunded", "cancelled"]), providerId: id.nullable(), providerName: z.string().nullable().optional(), refId: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(), verifiedAt: z.string().nullable(), expiresAt: z.string().nullable() });
const list = (item: z.ZodType) => z.object({ items: z.array(item), page: z.number().int().positive(), perPage: z.number().int().positive(), total: z.number().int().nonnegative(), totalPages: z.number().int().nonnegative() });
function responseData(operation: PaymentOperation, data: unknown): Record<string, unknown> {
  if (operation === "providers") return list(provider).parse(data);
  if (operation === "providerGet") return provider.parse(data);
  if (operation === "transactions") return list(transactionSchema).parse(data);
  if (operation === "transactionUpdate") return transactionSchema.parse(data);
  if (operation === "providerCreate") return z.object({ id }).parse(data);
  if (operation === "transactionCreate") return z.object({ id, authority: z.string(), paymentUrl: z.string().min(1) }).parse(data);
  if (operation === "providerTest") return z.object({ isSuccessful: z.boolean(), responseTimeMs: z.number().nonnegative() }).parse(data);
  if (operation === "providerBulk") return z.object({ requested: z.number().int().nonnegative(), succeeded: z.number().int().nonnegative(), failures: z.array(z.object({ id, code: z.string() })) }).refine(value => value.succeeded + value.failures.length === value.requested).parse(data);
  if (operation === "overview") return z.object({ activeProviderCount: z.number(), totalTransactions: z.number(), verifiedCount: z.number(), pendingCount: z.number(), totalVolume: z.number(), activeProviderPercentage: z.number() }).parse(data);
  return z.object({ success: z.literal(true) }).parse(data);
}
export class PaymentAdminApi {
  constructor(private fetchImpl: typeof fetch = fetch, private baseUrl = process.env.NAFAS_API_BASE_URL?.trim() || "https://nafasbeautyclinic.ir") {}
  async execute(command: PaymentCommand, context: RuleRequestContext): Promise<PaymentResult> {
    let valid: ReturnType<typeof validatePaymentCommand>;
    try { valid = validatePaymentCommand(command); } catch { return { ok: false, code: "INVALID_INPUT" }; }
    if (!context.actorId?.trim() || !context.sessionCookie?.trim()) return { ok: false, code: "AUTH_REQUIRED" };
    try {
      const base = new URL(this.baseUrl);
      if (base.protocol !== "https:" || base.username || base.password) return { ok: false, code: "INVALID_ORIGIN" };
      const url = new URL(valid.path, base);
      if (valid.method === "GET") for (const [key, value] of Object.entries(valid.input)) if (value !== undefined) url.searchParams.set(key, String(value));
      const response = await this.fetchImpl(url, { method: valid.method, headers: { Cookie: context.sessionCookie, Origin: base.origin, "Content-Type": "application/json", ...(context.csrfToken ? { "X-CSRF-Token": context.csrfToken } : {}) }, ...(valid.method === "POST" || valid.method === "PATCH" ? { body: JSON.stringify(valid.input) } : {}), redirect: "error", signal: AbortSignal.timeout(15_000), cache: "no-store" });
      const body = await response.json() as { data?: unknown; error?: { code?: unknown } };
      if (!response.ok || !body || !Object.prototype.hasOwnProperty.call(body, "data")) return { ok: false, status: response.status, code: typeof body?.error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(body.error.code) ? body.error.code : "UPSTREAM_REJECTED" };
      const data = responseData(command.operation, body.data);
      if (command.operation === "transactionCreate") {
        const paymentUrl = new URL(String(data.paymentUrl), base.origin);
        if (paymentUrl.protocol !== "https:" || paymentUrl.username || paymentUrl.password || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(paymentUrl.hostname) || /\.(local|localhost)$/i.test(paymentUrl.hostname)) return { ok: false, code: "UNSAFE_PAYMENT_URL" };
        data.paymentUrl = paymentUrl.href;
        delete data.authority;
      }
      return { ok: true, data };
    } catch (error) { return { ok: false, code: error instanceof z.ZodError ? "INVALID_RESPONSE" : "REQUEST_FAILED" }; }
  }
}
