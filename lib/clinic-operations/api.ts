import { z } from "zod";
import type { RuleRequestContext } from "@/lib/rules/types";
import {
  bulkBookingsSchema,
  bulkSlotsSchema,
  createBookingSchema,
  createSlotsSchema,
  listBookingsQuerySchema,
  listSlotsAdminQuerySchema,
  listSlotsQuerySchema,
  myReservationsQuerySchema,
  updateBookingAdminSchema,
  updateSlotSchema,
} from "@/lib/validation/bookings";
import {
  createServiceSchema,
  createServiceCategorySchema,
  createServiceGroupSchema,
  listServicesQuerySchema,
  updateServiceSchema,
  updateServiceCategorySchema,
  updateServiceGroupSchema,
} from "@/lib/validation/services";
import { bulkServicesSchema } from "@/lib/validation/services-admin";
import { bulkServiceCategoriesSchema, listServiceCategoriesQuerySchema } from "@/lib/validation/service-categories-admin";
import { bulkServiceGroupsSchema, listServiceGroupsQuerySchema } from "@/lib/validation/service-groups-admin";
import {
  bulkCareGuideItemsSchema,
  bulkCareGuidesSchema,
  createCareGuideItemSchema,
  createCareGuideSchema,
  listCareGuideItemsQuerySchema,
  listCareGuidesQuerySchema,
  updateCareGuideItemSchema,
  updateCareGuideSchema,
} from "@/lib/validation/care-guides";
import {
  bulkLandingCollectionSchema,
  createGalleryItemSchema,
  createMarqueeItemSchema,
  createServiceCardSchema,
  createStatSchema,
  landingListQuerySchema,
  updateGalleryItemSchema,
  updateHeroSchema,
  updateMarqueeItemSchema,
  updateServiceCardSchema,
  updateSettingsSchema,
  updateStatSchema,
} from "@/lib/validation/landing";
import { changePasswordSchema } from "@/lib/users/clinic-validation";

export const CLINIC_RESOURCES = [
  "service-groups",
  "service-categories",
  "services",
  "service-catalog",
  "care-guides",
  "care-guide-items",
  "landing-marquee",
  "landing-services",
  "landing-stats",
  "landing-gallery",
  "landing-hero",
  "landing-sections",
  "bookings",
  "slots",
  "my-bookings",
  "notifications",
  "profile",
  "sessions",
  "password",
  "auth-session",
] as const;
export type ClinicResource = (typeof CLINIC_RESOURCES)[number];

export const CLINIC_OPERATIONS = [
  "list",
  "availability",
  "admin-list",
  "get",
  "create",
  "update",
  "delete",
  "bulk",
  "generate",
  "cancel",
  "mark-read",
  "revoke-others",
  "change",
  "logout",
  "catalog",
] as const;
export type ClinicOperation = (typeof CLINIC_OPERATIONS)[number];

export type ClinicCommand = {
  resource: ClinicResource;
  operation: ClinicOperation;
  id?: string;
  input?: unknown;
};

export type ValidClinicCommand = {
  resource: ClinicResource;
  operation: ClinicOperation;
  path: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  input: Record<string, unknown>;
};

type Spec = {
  method: ValidClinicCommand["method"];
  path: string;
  schema?: z.ZodType;
  id?: boolean;
};

const empty = z.object({}).strict();
const nonEmpty = (schema: z.ZodType) => schema.refine(
  (value) => value !== null && typeof value === "object" && Object.values(value as Record<string, unknown>).some((item) => item !== undefined),
  "At least one field must be changed.",
);

/**
 * Exact chat-safe API allow-list. In particular, there is intentionally no
 * generic URL/path operation here: callbacks, webhooks, files, internal APIs,
 * and the notification stream cannot be addressed by a Telegram command.
 */
const specs: Record<ClinicResource, Partial<Record<ClinicOperation, Spec>>> = {
  "service-groups": {
    list: { method: "GET", path: "/api/v1/service-groups", schema: listServiceGroupsQuerySchema },
    get: { method: "GET", path: "/api/v1/service-groups/:id", schema: empty, id: true },
    create: { method: "POST", path: "/api/v1/service-groups", schema: createServiceGroupSchema },
    update: { method: "PATCH", path: "/api/v1/service-groups/:id", schema: nonEmpty(updateServiceGroupSchema), id: true },
    delete: { method: "DELETE", path: "/api/v1/service-groups/:id", schema: empty, id: true },
    bulk: { method: "POST", path: "/api/v1/service-groups/bulk", schema: bulkServiceGroupsSchema },
  },
  "service-categories": {
    list: { method: "GET", path: "/api/v1/service-categories", schema: listServiceCategoriesQuerySchema },
    get: { method: "GET", path: "/api/v1/service-categories/:id", schema: empty, id: true },
    create: { method: "POST", path: "/api/v1/service-categories", schema: createServiceCategorySchema },
    update: { method: "PATCH", path: "/api/v1/service-categories/:id", schema: nonEmpty(updateServiceCategorySchema), id: true },
    delete: { method: "DELETE", path: "/api/v1/service-categories/:id", schema: empty, id: true },
    bulk: { method: "POST", path: "/api/v1/service-categories/bulk", schema: bulkServiceCategoriesSchema },
  },
  services: {
    list: { method: "GET", path: "/api/v1/services", schema: listServicesQuerySchema },
    get: { method: "GET", path: "/api/v1/services/:id", schema: empty, id: true },
    create: { method: "POST", path: "/api/v1/services", schema: createServiceSchema },
    update: { method: "PATCH", path: "/api/v1/services/:id", schema: nonEmpty(updateServiceSchema), id: true },
    delete: { method: "DELETE", path: "/api/v1/services/:id", schema: empty, id: true },
    bulk: { method: "POST", path: "/api/v1/services/bulk", schema: bulkServicesSchema },
  },
  "service-catalog": {
    catalog: { method: "GET", path: "/api/v1/services/catalog", schema: empty },
  },
  "care-guides": {
    list: { method: "GET", path: "/api/v1/care-guides", schema: listCareGuidesQuerySchema },
    get: { method: "GET", path: "/api/v1/care-guides/:id", schema: empty, id: true },
    create: { method: "POST", path: "/api/v1/care-guides", schema: createCareGuideSchema },
    update: { method: "PATCH", path: "/api/v1/care-guides/:id", schema: nonEmpty(updateCareGuideSchema), id: true },
    delete: { method: "DELETE", path: "/api/v1/care-guides/:id", schema: empty, id: true },
    bulk: { method: "POST", path: "/api/v1/care-guides/bulk", schema: bulkCareGuidesSchema },
  },
  "care-guide-items": {
    list: { method: "GET", path: "/api/v1/care-guide-items", schema: listCareGuideItemsQuerySchema },
    get: { method: "GET", path: "/api/v1/care-guide-items/:id", schema: empty, id: true },
    create: { method: "POST", path: "/api/v1/care-guide-items", schema: createCareGuideItemSchema },
    update: { method: "PATCH", path: "/api/v1/care-guide-items/:id", schema: nonEmpty(updateCareGuideItemSchema), id: true },
    delete: { method: "DELETE", path: "/api/v1/care-guide-items/:id", schema: empty, id: true },
    bulk: { method: "POST", path: "/api/v1/care-guide-items/bulk", schema: bulkCareGuideItemsSchema },
  },
  "landing-marquee": {
    list: { method: "GET", path: "/api/v1/landing/marquee", schema: landingListQuerySchema },
    get: { method: "GET", path: "/api/v1/landing/marquee/:id", schema: empty, id: true },
    create: { method: "POST", path: "/api/v1/landing/marquee", schema: createMarqueeItemSchema },
    update: { method: "PATCH", path: "/api/v1/landing/marquee/:id", schema: nonEmpty(updateMarqueeItemSchema), id: true },
    delete: { method: "DELETE", path: "/api/v1/landing/marquee/:id", schema: empty, id: true },
    bulk: { method: "POST", path: "/api/v1/landing/marquee/bulk", schema: bulkLandingCollectionSchema },
  },
  "landing-services": {
    list: { method: "GET", path: "/api/v1/landing/services", schema: landingListQuerySchema },
    get: { method: "GET", path: "/api/v1/landing/services/:id", schema: empty, id: true },
    create: { method: "POST", path: "/api/v1/landing/services", schema: createServiceCardSchema },
    update: { method: "PATCH", path: "/api/v1/landing/services/:id", schema: nonEmpty(updateServiceCardSchema), id: true },
    delete: { method: "DELETE", path: "/api/v1/landing/services/:id", schema: empty, id: true },
    bulk: { method: "POST", path: "/api/v1/landing/services/bulk", schema: bulkLandingCollectionSchema },
  },
  "landing-stats": {
    list: { method: "GET", path: "/api/v1/landing/stats", schema: landingListQuerySchema },
    get: { method: "GET", path: "/api/v1/landing/stats/:id", schema: empty, id: true },
    create: { method: "POST", path: "/api/v1/landing/stats", schema: createStatSchema },
    update: { method: "PATCH", path: "/api/v1/landing/stats/:id", schema: nonEmpty(updateStatSchema), id: true },
    delete: { method: "DELETE", path: "/api/v1/landing/stats/:id", schema: empty, id: true },
    bulk: { method: "POST", path: "/api/v1/landing/stats/bulk", schema: bulkLandingCollectionSchema },
  },
  "landing-gallery": {
    list: { method: "GET", path: "/api/v1/landing/gallery", schema: landingListQuerySchema },
    get: { method: "GET", path: "/api/v1/landing/gallery/:id", schema: empty, id: true },
    create: { method: "POST", path: "/api/v1/landing/gallery", schema: createGalleryItemSchema },
    update: { method: "PATCH", path: "/api/v1/landing/gallery/:id", schema: nonEmpty(updateGalleryItemSchema), id: true },
    delete: { method: "DELETE", path: "/api/v1/landing/gallery/:id", schema: empty, id: true },
    bulk: { method: "POST", path: "/api/v1/landing/gallery/bulk", schema: bulkLandingCollectionSchema },
  },
  "landing-hero": {
    get: { method: "GET", path: "/api/v1/landing/hero", schema: empty },
    update: { method: "PATCH", path: "/api/v1/landing/hero", schema: nonEmpty(updateHeroSchema) },
  },
  "landing-sections": {
    get: { method: "GET", path: "/api/v1/landing/sections", schema: empty },
    update: { method: "PATCH", path: "/api/v1/landing/sections", schema: nonEmpty(updateSettingsSchema) },
  },
  bookings: {
    list: { method: "GET", path: "/api/v1/bookings", schema: listBookingsQuerySchema },
    get: { method: "GET", path: "/api/v1/bookings/:id", schema: empty, id: true },
    create: { method: "POST", path: "/api/v1/bookings", schema: createBookingSchema },
    update: { method: "PATCH", path: "/api/v1/bookings/:id", schema: nonEmpty(updateBookingAdminSchema), id: true },
    delete: { method: "DELETE", path: "/api/v1/bookings/:id", schema: empty, id: true },
    bulk: { method: "POST", path: "/api/v1/bookings/bulk", schema: bulkBookingsSchema },
  },
  slots: {
    availability: { method: "GET", path: "/api/v1/bookings/slots", schema: listSlotsQuerySchema },
    list: { method: "GET", path: "/api/v1/bookings/slots/list", schema: listSlotsAdminQuerySchema },
    get: { method: "GET", path: "/api/v1/bookings/slots/:id", schema: empty, id: true },
    create: { method: "POST", path: "/api/v1/bookings/slots", schema: createSlotsSchema },
    update: { method: "PATCH", path: "/api/v1/bookings/slots/:id", schema: nonEmpty(updateSlotSchema), id: true },
    delete: { method: "DELETE", path: "/api/v1/bookings/slots/:id", schema: empty, id: true },
    bulk: { method: "POST", path: "/api/v1/bookings/slots/bulk", schema: bulkSlotsSchema },
    generate: { method: "POST", path: "/api/v1/bookings/slots/generate", schema: empty },
  },
  "my-bookings": {
    list: { method: "GET", path: "/api/v1/me/bookings", schema: myReservationsQuerySchema },
    cancel: { method: "POST", path: "/api/v1/me/bookings/:id/cancel", schema: empty, id: true },
  },
  notifications: {
    list: { method: "GET", path: "/api/v1/notifications", schema: empty },
    "mark-read": { method: "PATCH", path: "/api/v1/notifications/read", schema: empty },
  },
  profile: { get: { method: "GET", path: "/api/v1/auth/me", schema: empty } },
  sessions: { "revoke-others": { method: "DELETE", path: "/api/v1/auth/sessions", schema: empty } },
  password: { change: { method: "POST", path: "/api/v1/auth/password", schema: changePasswordSchema } },
  "auth-session": { logout: { method: "POST", path: "/api/v1/auth/logout", schema: empty } },
};

export type ClinicRouteManifestEntry = {
  resource: ClinicResource;
  operation: ClinicOperation;
  method: ValidClinicCommand["method"];
  path: string;
};

/** Concrete, testable inventory of the exact upstream routes exposed to chat. */
export const CLINIC_ROUTE_MANIFEST: readonly ClinicRouteManifestEntry[] = Object.freeze(
  Object.entries(specs).flatMap(([resource, operations]) =>
    Object.entries(operations).flatMap(([operation, spec]) => spec ? [Object.freeze({
      resource: resource as ClinicResource,
      operation: operation as ClinicOperation,
      method: spec.method,
      path: spec.path,
    })] : []),
  ),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeId(value: unknown): string | null {
  return typeof value === "string" && z.uuid().safeParse(value).success ? value : null;
}

export function validateClinicCommand(command: ClinicCommand): ValidClinicCommand {
  const spec = specs[command.resource]?.[command.operation];
  if (!spec) throw new Error("UNSUPPORTED_OPERATION");
  const parsed = (spec.schema ?? empty).parse(command.input ?? {});
  if (!isRecord(parsed)) throw new Error("INVALID_INPUT");
  const id = spec.id ? normalizeId(command.id) : null;
  if (spec.id && !id) throw new Error("INVALID_ID");
  if (!spec.id && command.id !== undefined) throw new Error("UNEXPECTED_ID");
  const path = spec.id ? spec.path.replace(":id", encodeURIComponent(id!)) : spec.path;
  return { resource: command.resource, operation: command.operation, path, method: spec.method, input: parsed };
}

export type ClinicApiResult = { ok: true; data: unknown } | { ok: false; code: string; status?: number };

function safeResponseValue(value: unknown, depth = 0): unknown {
  if (depth > 20) throw new Error("RESPONSE_TOO_DEEP");
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (value.length > 100_000) throw new Error("RESPONSE_STRING_TOO_LONG");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new Error("RESPONSE_ARRAY_TOO_LONG");
    return value.map((item) => safeResponseValue(item, depth + 1));
  }
  if (!isRecord(value) || Object.keys(value).length > 500) throw new Error("INVALID_RESPONSE_VALUE");
  const clean: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    if (key.length > 128) throw new Error("RESPONSE_KEY_TOO_LONG");
    clean[key] = safeResponseValue(item, depth + 1);
  }
  return clean;
}

function apiErrorCode(body: unknown, status: number): string {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code = error?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)
    ? code
    : status === 429 ? "RATE_LIMITED" : "UPSTREAM_REJECTED";
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Read in bounded chunks so a faulty upstream cannot force an unbounded body allocation. */
async function readBoundedResponse(response: Response): Promise<string | null> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}

export class ClinicOperationsApi {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = process.env.NAFAS_API_BASE_URL?.trim() || "https://nafasbeautyclinic.ir",
  ) {}

  async execute(command: ClinicCommand, context: RuleRequestContext): Promise<ClinicApiResult> {
    let valid: ValidClinicCommand;
    try {
      valid = validateClinicCommand(command);
    } catch {
      return { ok: false, code: "INVALID_INPUT" };
    }
    if (!context.actorId?.trim() || !context.sessionCookie?.trim()) return { ok: false, code: "AUTH_REQUIRED" };

    try {
      const base = new URL(this.baseUrl);
      if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
        return { ok: false, code: "INVALID_ORIGIN" };
      }
      const url = new URL(valid.path, base);
      if (valid.method === "GET") {
        for (const [key, value] of Object.entries(valid.input)) {
          if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
        }
      }
      const body = ["POST", "PATCH"].includes(valid.method) && Object.keys(valid.input).length > 0
        ? JSON.stringify(valid.input)
        : undefined;
      if (body && Buffer.byteLength(body, "utf8") > 512 * 1024) return { ok: false, code: "INVALID_INPUT" };
      const response = await this.fetchImpl(url, {
        method: valid.method,
        headers: {
          Accept: "application/json",
          Cookie: context.sessionCookie,
          Origin: base.origin,
          ...(valid.method !== "GET" && body ? { "Content-Type": "application/json" } : {}),
          ...(context.csrfToken ? { "X-CSRF-Token": context.csrfToken } : {}),
        },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
      });
      const raw = await readBoundedResponse(response);
      if (raw === null) return { ok: false, code: "INVALID_RESPONSE", status: response.status };
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return { ok: false, code: "INVALID_RESPONSE", status: response.status }; }
      const envelope = isRecord(parsed) ? parsed : null;
      if (!response.ok || !envelope || !Object.prototype.hasOwnProperty.call(envelope, "data")) {
        return { ok: false, status: response.status, code: apiErrorCode(parsed, response.status) };
      }
      return { ok: true, data: safeResponseValue(envelope.data) };
    } catch (error) {
      const code = error instanceof Error && error.message.startsWith("RESPONSE_") ? "INVALID_RESPONSE" : "REQUEST_FAILED";
      return { ok: false, code };
    }
  }
}
