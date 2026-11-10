import { z } from "zod";

const SUPPORTED_TYPES = ["string", "number", "boolean", "object", "array"] as const;

export const ADMIN_TYPES = [...SUPPORTED_TYPES, "localized"] as const;
export type AdminValueType = (typeof ADMIN_TYPES)[number];

export const localizedValueSchema = z.object({
  fa: z.union([z.string(), z.number()]).optional(),
  en: z.union([z.string(), z.number()]).optional(),
});

const jsonValueSchema: z.ZodType<unknown> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

/** Admin list query for system settings (search, status filter, pagination). */
export const listSettingsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    perPage: z.coerce.number().int().min(1).max(50).default(10),
    search: z.string().trim().max(100).optional(),
    status: z.enum(["all", "active", "inactive"]).default("all"),
  })
  .strict();

export const createSettingSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9_.]*$/),
    value: jsonValueSchema.optional(),
    type: z.enum(ADMIN_TYPES).default("string"),
    isActive: z.boolean().default(true),
    displayOrder: z.number().int().min(0).max(100000).default(0),
    translations: localizedValueSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.type === "localized") {
      if (!value.translations) {
        ctx.addIssue({
          code: "custom",
          path: ["translations"],
          message: "Localized settings require fa and en translations.",
        });
        return;
      }
      if (value.translations.fa === undefined && value.translations.en === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["translations"],
          message: "Provide at least one locale translation.",
        });
      }
    } else if (value.value === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "A value is required for non-localized settings.",
      });
    }
  });

export const updateSettingSchema = z
  .object({
    value: jsonValueSchema.optional(),
    isActive: z.boolean().optional(),
    displayOrder: z.number().int().min(0).max(100000).optional(),
    translations: localizedValueSchema.optional(),
  })
  .strict();

export const bulkSettingsSchema = z
  .object({
    action: z.enum(["activate", "deactivate", "delete"]),
    scope: z.enum(["page", "filtered"]),
    ids: z.array(z.uuid()).max(100).optional(),
    filters: listSettingsQuerySchema
      .pick({ search: true, status: true })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "page" && (!value.ids || value.ids.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["ids"],
        message: "Select at least one setting.",
      });
    }
  });

export type ListSettingsQuery = z.infer<typeof listSettingsQuerySchema>;
export type CreateSettingInput = z.infer<typeof createSettingSchema>;
export type UpdateSettingInput = z.infer<typeof updateSettingSchema>;
export type BulkSettingsInput = z.infer<typeof bulkSettingsSchema>;
export type SettingStatusFilter = NonNullable<ListSettingsQuery["status"]>;

/** Union of create/update input for seed definitions - optional fields have defaults in DB. */
export type SettingInput = Omit<CreateSettingInput, "isActive" | "displayOrder"> & {
  isActive?: boolean;
  displayOrder?: number;
};