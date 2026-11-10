import { z } from "zod";
import type { RuleRequestContext } from "@/lib/rules/types";
import { createWorkingHourSchema, updateWorkingHourSchema, listWorkingHoursQuerySchema, bulkWorkingHoursSchema, workingHoursDaySchema, slotPatternSchema } from "./validation";

export const hourRowSchema = z.object({ id: z.uuid(), day: workingHoursDaySchema, opens: z.string(), closes: z.string(), capacity: z.number(), displayOrder: z.number(), isActive: z.boolean(), slotCount: z.number().optional(), patterns: z.array(slotPatternSchema.extend({ id: z.string().optional() })).optional() });
export type HourRow = z.infer<typeof hourRowSchema>;
export type HoursCommand = { operation: "list" | "get" | "create" | "update" | "delete" | "bulk"; id?: string; input: unknown };
const schemas = { list: listWorkingHoursQuerySchema, get: z.object({}).strict(), create: createWorkingHourSchema, update: updateWorkingHourSchema.refine(value => Object.keys(value).length > 0), delete: z.object({}).strict(), bulk: bulkWorkingHoursSchema };
export function validateHoursCommand(command: HoursCommand) {
  const schema = schemas[command.operation];
  if (!schema) throw new Error("INVALID_OPERATION");
  const input = schema.parse(command.input) as Record<string, unknown>;
  const individual = ["get", "update", "delete"].includes(command.operation);
  if (individual) z.uuid().parse(command.id);
  return {
    input,
    path: individual ? `/api/v1/working-hours/${encodeURIComponent(command.id!)}` : command.operation === "list" ? "/api/v1/working-hours/list" : command.operation === "bulk" ? "/api/v1/working-hours/bulk" : "/api/v1/working-hours",
    method: ({ list: "GET", get: "GET", create: "POST", update: "PATCH", delete: "DELETE", bulk: "POST" })[command.operation],
  };
}
export type HoursResult = { ok: true; data: unknown } | { ok: false; code: string; status?: number };
export class WorkingHoursApi {
  constructor(private fetchImpl: typeof fetch = fetch, private baseUrl = process.env.NAFAS_API_BASE_URL?.trim() || "https://nafasbeautyclinic.ir") {}
  async execute(command: HoursCommand, context: RuleRequestContext): Promise<HoursResult> {
    let valid: ReturnType<typeof validateHoursCommand>;
    try { valid = validateHoursCommand(command); } catch { return { ok: false, code: "INVALID_INPUT" }; }
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
      if (command.operation === "list") data = z.object({ items: z.array(hourRowSchema), total: z.number().int().nonnegative(), page: z.number().int().positive(), perPage: z.number().int().positive() }).parse(body.data);
      else if (command.operation === "bulk") data = z.object({ requested: z.number().int().nonnegative(), succeeded: z.number().int().nonnegative(), failures: z.array(z.object({ id: z.uuid(), code: z.string() })) }).refine(value => value.succeeded + value.failures.length === value.requested).parse(body.data);
      else if (command.operation === "delete") data = z.object({ ok: z.literal(true) }).parse(body.data);
      else data = hourRowSchema.parse(body.data);
      return { ok: true, data };
    } catch (error) { return { ok: false, code: error instanceof z.ZodError ? "INVALID_RESPONSE" : "REQUEST_FAILED" }; }
  }
}
