import { z } from "zod";
import type { RuleRequestContext } from "@/lib/rules/types";
import { sendSmsSchema, listSmsMessagesQuerySchema, listSmsRecipientsQuerySchema } from "./sms-messages";
import { createSmsProviderSchema, updateSmsProviderSchema, testSmsProviderSchema, listSmsProvidersQuerySchema } from "./sms-providers";
import { createSmsTemplateSchema, updateSmsTemplateSchema, listSmsTemplatesQuerySchema } from "./sms-templates";
const empty = z.object({}).strict(), id = z.uuid();
const root = "/api/v1/admin/sms";
export const smsOperations = {
  overview: ["GET", "/overview", empty],
  messages: ["GET", "/messages", listSmsMessagesQuerySchema],
  send: ["POST", "/messages", sendSmsSchema],
  messageDelete: ["DELETE", "/messages/:id", empty],
  delivery: ["POST", "/messages/:id/delivery", empty],
  providers: ["GET", "/providers", listSmsProvidersQuerySchema],
  providerGet: ["GET", "/providers/:id", empty],
  providerCreate: ["POST", "/providers", createSmsProviderSchema],
  providerUpdate: ["PATCH", "/providers/:id", updateSmsProviderSchema.refine(value => Object.values(value).some(item => item !== undefined))],
  providerDelete: ["DELETE", "/providers/:id", empty],
  providerTest: ["POST", "/providers/:id/test", testSmsProviderSchema],
  diagnostics: ["GET", "/diagnostics", z.object({ providerId: id }).strict()],
  received: ["GET", "/received", z.object({ page: z.coerce.number().int().min(1).default(1), perPage: z.coerce.number().int().min(1).max(50).default(20), providerId: id.optional() }).strict()],
  refresh: ["POST", "/received", z.object({ providerId: id }).strict()],
  recipients: ["GET", "/recipients", listSmsRecipientsQuerySchema],
  templates: ["GET", "/templates", listSmsTemplatesQuerySchema],
  templateGet: ["GET", "/templates/:id", empty],
  templateCreate: ["POST", "/templates", createSmsTemplateSchema],
  templateUpdate: ["PATCH", "/templates/:id", updateSmsTemplateSchema.refine(value => Object.values(value).some(item => item !== undefined))],
  templateDelete: ["DELETE", "/templates/:id", empty],
} as const;
export type SmsOperation = keyof typeof smsOperations;
export type SmsCommand = { operation: SmsOperation; id?: string; input: unknown };
export function validateSmsCommand(command: SmsCommand) {
  const descriptor = smsOperations[command.operation];
  if (!descriptor) throw new Error("INVALID_OPERATION");
  const [method, suffix, schema] = descriptor;
  const input = schema.parse(command.input) as Record<string, unknown>;
  if (suffix.includes(":id")) id.parse(command.id);
  if (command.operation === "providerCreate" || command.operation === "providerUpdate") {
    if (input.apiUrl) {
      const url = new URL(String(input.apiUrl));
      if (url.protocol !== "https:" || url.username || url.password || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(url.hostname) || url.hostname.endsWith(".local")) throw new Error("UNSAFE_PROVIDER_URL");
    }
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 128 * 1024) throw new Error("BODY_TOO_LARGE");
  return { input, method, path: root + suffix.replace(":id", encodeURIComponent(command.id ?? "")) };
}
export type SmsResult = { ok: true; data: Record<string, unknown> } | { ok: false; code: string; status?: number };
// Strip unknown response fields before they can reach the UI or planner.
const provider = z.object({ id, name: z.string(), kind: z.string(), isActive: z.boolean(), isDefault: z.boolean(), tokenConfigured: z.boolean().optional(), healthStatus: z.string().optional() });
const translation = z.object({ name: z.string(), content: z.string() });
const template = z.object({ id, key: z.string(), externalTemplateId: z.string().optional(), messageType: z.string(), variables: z.array(z.string()), translations: z.object({ fa: translation.optional(), en: translation.optional() }), isActive: z.boolean(), displayOrder: z.number() });
const message = z.object({ id, recipientMasked: z.string(), providerName: z.string().nullable(), status: z.string(), createdAt: z.string(), sentAt: z.string().nullable().optional(), deliveredAt: z.string().nullable().optional() });
const received = z.object({ id, providerName: z.string().nullable(), line: z.string(), mobileMasked: z.string(), message: z.string(), receivedAt: z.string().nullable(), createdAt: z.string() });
const recipient = z.object({ id, fullName: z.string(), phone: z.string() });
const list = (item: z.ZodType) => z.object({ items: z.array(item), page: z.number().int().positive(), perPage: z.number().int().positive(), total: z.number().int().nonnegative() });
function responseData(operation: SmsOperation, data: unknown): Record<string, unknown> {
  if (operation === "providers") return list(provider).parse(data);
  if (operation === "providerGet") return provider.parse(data);
  if (operation === "templates") return list(template).parse(data);
  if (operation === "templateGet") return template.parse(data);
  if (operation === "messages") return list(message).parse(data);
  if (operation === "received") return list(received).parse(data);
  if (operation === "recipients") return list(recipient).parse(data);
  if (operation === "providerCreate" || operation === "templateCreate") return z.object({ id }).parse(data);
  if (operation === "send") return z.object({ campaignId: id, total: z.number().int().nonnegative(), sent: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), status: z.enum(["sent", "partial", "failed"]), parts: z.number().int().nonnegative(), encoding: z.enum(["gsm7", "unicode"]) }).parse(data);
  if (operation === "providerTest") return z.object({ providerId: id, successful: z.boolean(), responseTimeMs: z.number() }).parse(data);
  if (operation === "delivery") return z.object({ id, status: z.string() }).parse(data);
  if (operation === "refresh") return z.object({ stored: z.number().int().nonnegative() }).parse(data);
  if (operation === "diagnostics") return z.object({ providerId: id, kind: z.string(), credit: z.number().nullable(), lines: z.array(z.string()) }).parse(data);
  if (operation === "overview") return z.object({ stats: z.object({ total: z.number(), sent: z.number(), delivered: z.number(), failed: z.number(), deliveryRate: z.number() }), providerCount: z.number(), activeProviderCount: z.number(), templateCount: z.number(), activeTemplateCount: z.number() }).parse(data);
  return z.object({ ok: z.literal(true) }).parse(data);
}
export class SmsAdminApi {
  constructor(private fetchImpl: typeof fetch = fetch, private baseUrl = process.env.NAFAS_API_BASE_URL?.trim() || "https://nafasbeautyclinic.ir") {}
  async execute(command: SmsCommand, context: RuleRequestContext): Promise<SmsResult> {
    let valid: ReturnType<typeof validateSmsCommand>;
    try { valid = validateSmsCommand(command); } catch { return { ok: false, code: "INVALID_INPUT" }; }
    if (!context.actorId?.trim() || !context.sessionCookie?.trim()) return { ok: false, code: "AUTH_REQUIRED" };
    try {
      const base = new URL(this.baseUrl);
      if (base.protocol !== "https:" || base.username || base.password) return { ok: false, code: "INVALID_ORIGIN" };
      const url = new URL(valid.path, base);
      if (valid.method === "GET") for (const [key, value] of Object.entries(valid.input)) if (value !== undefined) url.searchParams.set(key, String(value));
      const response = await this.fetchImpl(url, { method: valid.method, headers: { Cookie: context.sessionCookie, Origin: base.origin, "Content-Type": "application/json", ...(context.csrfToken ? { "X-CSRF-Token": context.csrfToken } : {}) }, ...(valid.method === "POST" || valid.method === "PATCH" ? { body: JSON.stringify(valid.input) } : {}), redirect: "error", signal: AbortSignal.timeout(15_000), cache: "no-store" });
      const body = await response.json() as { data?: unknown; error?: { code?: unknown } };
      if (!response.ok || !body || !Object.prototype.hasOwnProperty.call(body, "data")) return { ok: false, status: response.status, code: typeof body?.error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(body.error.code) ? body.error.code : "UPSTREAM_REJECTED" };
      return { ok: true, data: responseData(command.operation, body.data) };
    } catch (error) { return { ok: false, code: error instanceof z.ZodError ? "INVALID_RESPONSE" : "REQUEST_FAILED" }; }
  }
}
