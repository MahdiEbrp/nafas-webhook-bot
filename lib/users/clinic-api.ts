import { z } from "zod";
import { bulkUsersSchema, changePasswordSchema, changeRoleSchema, createUserSchema, listUsersQuerySchema, updateUserStatusSchema } from "./clinic-validation";
import type { RuleRequestContext } from "@/lib/rules/types";

export type UserOperation = "list" | "create" | "status" | "delete" | "role" | "password" | "bulk";
export type UserCommand = { operation: UserOperation; id?: string; input: unknown };
export type ValidUserCommand = { operation: UserOperation; path: string; method: string; input: Record<string, unknown> };
const schemas = { list: listUsersQuerySchema, create: createUserSchema, status: updateUserStatusSchema, delete: z.object({}).strict(), role: changeRoleSchema, password: changePasswordSchema, bulk: bulkUsersSchema };

/** Only actual routes in beauty-clinic are supported: no profile PATCH or GET by id exists. */
export function validateUserCommand(command: UserCommand): ValidUserCommand {
  const schema = schemas[command.operation];
  if (!schema) throw new Error("INVALID_OPERATION");
  const input = schema.parse(command.input) as Record<string, unknown>;
  const needsId = ["status", "delete", "role", "password"].includes(command.operation);
  if (needsId && !z.uuid().safeParse(command.id).success) throw new Error("INVALID_ID");
  const suffix = command.operation === "role" ? "/role" : command.operation === "password" ? "/password" : "";
  const path = needsId ? `/api/v1/users/${encodeURIComponent(command.id!)}${suffix}` : command.operation === "bulk" ? "/api/v1/users/bulk" : "/api/v1/users";
  const method = ({ list: "GET", create: "POST", status: "PATCH", delete: "DELETE", role: "PATCH", password: "POST", bulk: "POST" })[command.operation];
  return { operation: command.operation, path, method, input };
}

export type UserApiResult = { ok: true; data: unknown } | { ok: false; code: string; status?: number };
export class ClinicUsersApi {
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly baseUrl = process.env.NAFAS_API_BASE_URL?.trim() || "https://nafasbeautyclinic.ir") {}

  async execute(command: UserCommand, context: RuleRequestContext): Promise<UserApiResult> {
    let valid: ValidUserCommand;
    try { valid = validateUserCommand(command); } catch { return { ok: false, code: "INVALID_INPUT" }; }
    if (!context.actorId.trim() || !context.sessionCookie.trim()) {
      return { ok: false, code: "AUTH_CONTEXT_REQUIRED" };
    }
    try {
      const base = new URL(this.baseUrl);
      if (base.protocol !== "https:" || base.username || base.password) return { ok: false, code: "INVALID_API_ORIGIN" };
      const url = new URL(valid.path, base);
      if (valid.method === "GET") {
        for (const [key, value] of Object.entries(valid.input)) if (value !== undefined) url.searchParams.set(key, String(value));
      }
      const response = await this.fetchImpl(url, {
        method: valid.method,
        headers: { Cookie: context.sessionCookie, Origin: base.origin, ...(context.csrfToken ? { "X-CSRF-Token": context.csrfToken } : {}), ...(valid.method !== "GET" && valid.method !== "DELETE" ? { "Content-Type": "application/json" } : {}) },
        ...(valid.method !== "GET" && valid.method !== "DELETE" ? { body: JSON.stringify(valid.input) } : {}),
        signal: AbortSignal.timeout(10_000), redirect: "error", cache: "no-store",
      });
      const body = await response.json() as { data?: unknown; error?: { code?: unknown } };
      if (!response.ok || !body || typeof body !== "object" || !Object.prototype.hasOwnProperty.call(body, "data")) return { ok: false, status: response.status, code: typeof body?.error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(body.error.code) ? body.error.code : "UPSTREAM_REJECTED" };
      return { ok: true, data: body.data };
    } catch {
      // Never include request payload, password, cookies, or upstream error text.
      return { ok: false, code: "REQUEST_FAILED" };
    }
  }
}
