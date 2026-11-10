import { z } from "zod";

const providerKinds = ["zarinpal", "tabapay", "zibal", "idpay", "nextpay", "mellat", "parsian", "fake"] as const;
import { PAYMENT_LIMITS } from "./constants";
const safeUrlSchema = z
  .string()
  .trim()
  .max(PAYMENT_LIMITS.apiUrlMaxLength)
  .refine((v) => {
    if (!v) return true;
    try {
      const u = new URL(v);
      return u.protocol === "https:" || u.hostname === "localhost" || u.hostname.endsWith(".local");
    } catch {
      return false;
    }
  }, "Provider URL must use HTTPS.");

export const createPaymentProviderSchema = z
  .object({
    name: z.string().trim().min(PAYMENT_LIMITS.providerNameMinLength).max(PAYMENT_LIMITS.providerNameMaxLength),
    kind: z.enum(providerKinds),
    merchantId: z.string().trim().min(PAYMENT_LIMITS.merchantIdMinLength).max(PAYMENT_LIMITS.merchantIdMaxLength),
    apiUrl: safeUrlSchema,
    callbackUrl: z.string().trim().max(PAYMENT_LIMITS.callbackUrlMaxLength).optional(),
    isActive: z.boolean().default(true),
    isDefault: z.boolean().default(false),
    sandbox: z.boolean().optional(),
  })
  .strict();

export const updatePaymentProviderSchema = z
  .object({
    name: z.string().trim().min(PAYMENT_LIMITS.providerNameMinLength).max(PAYMENT_LIMITS.providerNameMaxLength).optional(),
    kind: z.enum(providerKinds).optional(),
    merchantId: z.string().trim().min(PAYMENT_LIMITS.merchantIdMinLength).max(PAYMENT_LIMITS.merchantIdMaxLength).optional(),
    apiUrl: safeUrlSchema.optional(),
    callbackUrl: z.string().trim().max(PAYMENT_LIMITS.callbackUrlMaxLength).optional(),
    isActive: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    sandbox: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "No fields to update");

export const listPaymentProvidersQuerySchema = z.object({
  page: z.coerce.number().int().min(PAYMENT_LIMITS.pageMin).max(PAYMENT_LIMITS.transactionListPageMax).default(PAYMENT_LIMITS.pageDefault).optional(),
  perPage: z.coerce.number().int().min(1).max(PAYMENT_LIMITS.providerListPerPageMax).default(PAYMENT_LIMITS.providerListPerPageDefault).optional(),
  search: z.string().trim().max(PAYMENT_LIMITS.providerSearchMaxLength).optional(),
  status: z.enum(["all", "active", "inactive"]).default("all").optional(),
});

export const testPaymentProviderSchema = z.object({}).strict();

/**
 * Bulk actions for the payment providers admin list.
 */
export const bulkPaymentProvidersSchema = z
  .object({
    action: z.enum(["activate", "deactivate", "delete"]),
    scope: z.enum(["page", "filtered"]),
    ids: z.array(z.uuid()).max(100).optional(),
    filters: listPaymentProvidersQuerySchema
      .pick({ search: true, status: true })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "page" && (!value.ids || value.ids.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["ids"],
        message: "Select at least one provider.",
      });
    }
  });

export type BulkPaymentProvidersInput = z.infer<typeof bulkPaymentProvidersSchema>;

export type CreatePaymentProviderInput = z.infer<typeof createPaymentProviderSchema>;
export type UpdatePaymentProviderInput = z.infer<typeof updatePaymentProviderSchema>;
export type ListPaymentProvidersQuery = z.infer<typeof listPaymentProvidersQuerySchema>;
