import { z } from "zod";
import type { RuleRequestContext } from "@/lib/rules/types";
import { EMAIL_API_ROOT, EMAIL_LIMITS, EMAIL_PROVIDER_KINDS, EMAIL_STATUSES } from "./constants";
import {
  emailAddressSchema,
  listEmailOperations,
  validateEmailCommand,
  type EmailCommand,
  type EmailOperation,
} from "./validation";

const uuid = z.uuid();
const providerSchema = z.object({
  id: uuid,
  name: z.string(),
  kind: z.enum(EMAIL_PROVIDER_KINDS),
  host: z.string(),
  port: z.number().int().min(1).max(65_535),
  encryption: z.enum(["ssl", "starttls", "none"]),
  fromEmail: z.string().nullable(),
  fromName: z.string().nullable(),
  passwordConfigured: z.boolean(),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  healthStatus: z.enum(["unknown", "healthy", "unhealthy"]),
  lastHealthCheckedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const messageSchema = z.object({
  id: uuid,
  recipientMasked: z.string(),
  providerName: z.string().nullable(),
  providerKind: z.enum(EMAIL_PROVIDER_KINDS).nullable(),
  status: z.enum(EMAIL_STATUSES),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
});
const templateTranslationSchema = z.object({ name: z.string(), subject: z.string(), content: z.string() });
const templateSchema = z.object({
  id: uuid,
  key: z.string(),
  externalTemplateId: z.string().optional(),
  messageType: z.enum(["transactional", "marketing"]),
  contentFormat: z.enum(["plain", "html"]),
  variables: z.array(z.string()),
  translations: z.object({ fa: templateTranslationSchema.optional(), en: templateTranslationSchema.optional() }),
  isActive: z.boolean(),
  displayOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const page = (item: z.ZodType) => z.object({
  items: z.array(item),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
});
export type AdminEmailProvider = z.infer<typeof providerSchema>;
export type AdminEmailMessage = z.infer<typeof messageSchema>;
export type AdminEmailTemplate = z.infer<typeof templateSchema>;
export type AdminEmailRecipient = { id: string; fullName: string; email: string };
export type EmailResult = { ok: true; data: Record<string, unknown> } | { ok: false; code: string; status?: number };

function responseData(operation: EmailOperation, value: unknown): Record<string, unknown> {
  if (operation === "overview") {
    return z.object({
      stats: z.object({ total: z.number().nonnegative(), sent: z.number().nonnegative(), delivered: z.number().nonnegative(), failed: z.number().nonnegative(), deliveryRate: z.number().min(0).max(100) }),
      providerCount: z.number().nonnegative(), activeProviderCount: z.number().nonnegative(),
      templateCount: z.number().nonnegative(), activeTemplateCount: z.number().nonnegative(),
      providers: z.array(z.object({ id: uuid, name: z.string(), kind: z.enum(EMAIL_PROVIDER_KINDS), healthStatus: z.enum(["unknown", "healthy", "unhealthy"]), isActive: z.boolean(), isDefault: z.boolean(), lastHealthCheckedAt: z.string().nullable() })),
      recentMessages: z.array(messageSchema),
    }).parse(value);
  }
  if (operation === "providers") return page(providerSchema).parse(value);
  if (operation === "providerGet") return providerSchema.parse(value);
  if (operation === "providerCreate" || operation === "templateCreate") return z.object({ id: uuid }).parse(value);
  if (["providerUpdate", "providerDelete", "messageDelete", "templateUpdate", "templateDelete"].includes(operation)) return z.object({ ok: z.literal(true) }).parse(value);
  if (operation === "providerTest") return z.object({ providerId: uuid, successful: z.boolean(), responseTimeMs: z.number().nonnegative() }).parse(value);
  if (operation === "messages") return page(messageSchema).parse(value);
  if (operation === "messageSend") {
    // Do not return the raw subject/provider response; only the operational summary.
    const summary = z.object({ campaignId: uuid, total: z.number().int().nonnegative(), sent: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), status: z.enum(["sent", "partial", "failed"]), characters: z.number().int().nonnegative() }).parse(value);
    return summary;
  }
  if (operation === "recipients") return page(z.object({ id: uuid, fullName: z.string(), email: emailAddressSchema })).parse(value);
  if (operation === "templates") return page(templateSchema).parse(value);
  if (operation === "templateGet") return templateSchema.parse(value);
  throw new Error("INVALID_OPERATION");
}

export class EmailAdminApi {
  constructor(
    private fetchImpl: typeof fetch = fetch,
    private baseUrl = process.env.NAFAS_API_BASE_URL?.trim() || "https://nafasbeautyclinic.ir",
  ) {}

  async execute(command: EmailCommand, context: RuleRequestContext): Promise<EmailResult> {
    let valid: ReturnType<typeof validateEmailCommand>;
    try { valid = validateEmailCommand(command); }
    catch { return { ok: false, code: "INVALID_INPUT" }; }
    if (!context.actorId?.trim() || !context.sessionCookie?.trim()) return { ok: false, code: "AUTH_REQUIRED" };
    try {
      const base = new URL(this.baseUrl);
      if (base.protocol !== "https:" || base.username || base.password) return { ok: false, code: "INVALID_ORIGIN" };
      const origin = base.origin;
      const url = new URL(valid.path, origin);
      if (valid.method === "GET") {
        for (const [key, item] of Object.entries(valid.input)) if (item !== undefined) url.searchParams.set(key, String(item));
      }
      const headers: Record<string, string> = {
        Cookie: context.sessionCookie,
        Origin: origin,
        "Content-Type": "application/json",
        ...(context.csrfToken ? { "X-CSRF-Token": context.csrfToken } : {}),
      };
      const response = await this.fetchImpl(url, {
        method: valid.method,
        headers,
        ...(valid.method === "POST" || valid.method === "PATCH" ? { body: JSON.stringify(valid.input) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(command.operation === "messageSend" ? 120_000 : 20_000),
        cache: "no-store",
      });
      let body: { data?: unknown; error?: { code?: unknown } } | null;
      try { body = await response.json() as typeof body; }
      catch { return { ok: false, status: response.status, code: response.ok ? "INVALID_RESPONSE" : "UPSTREAM_REJECTED" }; }
      if (!response.ok || !body || !Object.prototype.hasOwnProperty.call(body, "data")) {
        const code = typeof body?.error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(body.error.code) ? body.error.code : "UPSTREAM_REJECTED";
        return { ok: false, status: response.status, code };
      }
      return { ok: true, data: responseData(command.operation, body.data) };
    } catch (error) {
      return { ok: false, code: error instanceof z.ZodError ? "INVALID_RESPONSE" : "REQUEST_FAILED" };
    }
  }
}

// Keep route roots and body-size checks reachable from tests and consumers.
export { EMAIL_API_ROOT, EMAIL_LIMITS, listEmailOperations };
