import { z } from "zod";
import type { RuleRequestContext } from "@/lib/rules/types";
import { createSettingSchema, updateSettingSchema, listSettingsQuerySchema, bulkSettingsSchema } from "./validation";

export const adminSettingSchema = z.object({ id: z.uuid(), key: z.string(), type: z.string().nullable(), value: z.unknown(), translations: z.object({ fa: z.unknown().optional(), en: z.unknown().optional() }), displayOrder: z.number(), isActive: z.boolean(), createdAt: z.string(), updatedAt: z.string() });
export type AdminSetting = z.infer<typeof adminSettingSchema>;
export type SettingCommand = { operation: "list" | "get" | "create" | "update" | "delete" | "bulk"; id?: string; input: unknown };
const schemas = { list: listSettingsQuerySchema, get: z.object({}).strict(), create: createSettingSchema, update: updateSettingSchema.refine(value => Object.values(value).some(item => item !== undefined)), delete: z.object({}).strict(), bulk: bulkSettingsSchema };
export function validateSettingCommand(command: SettingCommand) {
  const schema = schemas[command.operation];
  if (!schema) throw new Error("INVALID_OPERATION");
  const input = schema.parse(command.input) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) throw new Error("BODY_TOO_LARGE");
  const individual = ["get", "update", "delete"].includes(command.operation);
  if (individual) z.uuid().parse(command.id);
  return {
    input,
    path: individual ? `/api/v1/admin/settings/${encodeURIComponent(command.id!)}` : command.operation === "bulk" ? "/api/v1/admin/settings/bulk" : "/api/v1/admin/settings",
    method: ({ list: "GET", get: "GET", create: "POST", update: "PATCH", delete: "DELETE", bulk: "POST" })[command.operation],
  };
}
export type SettingResult = { ok: true; data: unknown } | { ok: false; code: string; status?: number };
export class SettingsAdminApi {
  constructor(private fetchImpl: typeof fetch = fetch, private baseUrl = process.env.NAFAS_API_BASE_URL?.trim() || "https://nafasbeautyclinic.ir") {}
  async execute(command: SettingCommand, context: RuleRequestContext): Promise<SettingResult> {
    let valid: ReturnType<typeof validateSettingCommand>;
    try { valid = validateSettingCommand(command); } catch { return { ok: false, code: "INVALID_INPUT" }; }
    if (!context.actorId?.trim() || !context.sessionCookie?.trim()) return { ok: false, code: "AUTH_REQUIRED" };
    try {
      const base = new URL(this.baseUrl);
      if (base.protocol !== "https:" || base.username || base.password) return { ok: false, code: "INVALID_ORIGIN" };
      const url = new URL(valid.path, base);
      if (valid.method === "GET") for (const [key, value] of Object.entries(valid.input)) if (value !== undefined) url.searchParams.set(key, String(value));
      const response = await this.fetchImpl(url, { method: valid.method,
        headers: { Cookie: context.sessionCookie, Origin: base.origin, "Content-Type": "application/json", ...(context.csrfToken ? { "X-CSRF-Token": context.csrfToken } : {}) },
        ...(valid.method === "POST" || valid.method === "PATCH" ? { body: JSON.stringify(valid.input) } : {}),
        signal: AbortSignal.timeout(10_000), redirect: "error", cache: "no-store",
      });
      const body = await response.json() as { data?: unknown; error?: { code?: unknown } };
      if (!response.ok || !body || !Object.prototype.hasOwnProperty.call(body, "data")) return { ok: false, status: response.status, code: typeof body?.error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(body.error.code) ? body.error.code : "UPSTREAM_REJECTED" };
      let data: unknown;
      if (command.operation === "list") data = z.object({ items: z.array(adminSettingSchema), total: z.number().int().nonnegative(), page: z.number().int().positive(), perPage: z.number().int().positive() }).parse(body.data);
      else if (command.operation === "bulk") data = z.object({ requested: z.number().int().nonnegative(), succeeded: z.number().int().nonnegative(), failures: z.array(z.object({ id: z.uuid(), code: z.string() })) }).refine(value => value.succeeded + value.failures.length === value.requested).parse(body.data);
      else if (command.operation === "delete") data = z.object({ deleted: z.literal(true) }).parse(body.data);
      else if (command.operation === "update") data = z.object({ updated: z.literal(true) }).parse(body.data);
      else if (command.operation === "create") data = z.object({ id: z.uuid() }).parse(body.data);
      else data = z.object({ setting: adminSettingSchema }).parse(body.data).setting;
      return { ok: true, data };
    } catch (error) { return { ok: false, code: error instanceof z.ZodError ? "INVALID_RESPONSE" : "REQUEST_FAILED" }; }
  }
}
