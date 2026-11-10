import { z } from "zod";

import { SLUG_PATTERN } from "@/lib/validation/slug";

export const careGuideI18nSchema = z
  .object({
    locale: z.enum(["en", "fa"]),
    name: z.string().trim().min(1).max(256),
    description: z.string().trim().max(2000).optional().nullable(),
  })
  .strict();

export const careGuideItemI18nSchema = z
  .object({
    locale: z.enum(["en", "fa"]),
    title: z.string().trim().min(1).max(256),
    description: z.string().trim().max(2000).optional().nullable(),
  })
  .strict();

export const createCareGuideSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(SLUG_PATTERN, "Slug must be kebab-case"),
    icon: z.string().trim().max(100).optional().nullable(),
    displayOrder: z.number().int().min(0).max(10000).default(0),
    isActive: z.boolean().default(true),
    translations: z
      .object({
        fa: careGuideI18nSchema.omit({ locale: true }),
        en: careGuideI18nSchema.omit({ locale: true }),
      })
      .strict(),
  })
  .strict();

export const updateCareGuideSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(SLUG_PATTERN, "Slug must be kebab-case")
      .optional(),
    icon: z.string().trim().max(100).optional().nullable(),
    displayOrder: z.number().int().min(0).max(10000).optional(),
    isActive: z.boolean().optional(),
    translations: z
      .object({
        fa: careGuideI18nSchema.omit({ locale: true }).partial(),
        en: careGuideI18nSchema.omit({ locale: true }).partial(),
      })
      .strict()
      .partial()
      .optional(),
  })
  .strict();

export const listCareGuidesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    perPage: z.coerce.number().int().min(1).max(50).default(10),
    search: z.string().trim().max(100).optional(),
    status: z.enum(["all", "active", "inactive"]).default("all"),
  })
  .strict();

export const bulkCareGuidesSchema = z
  .object({
    action: z.enum(["activate", "deactivate", "delete"]),
    scope: z.enum(["page", "filtered"]),
    ids: z.array(z.uuid()).max(100).optional(),
    filters: listCareGuidesQuerySchema
      .pick({ search: true, status: true })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "page" && (!value.ids || value.ids.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["ids"],
        message: "Select at least one care guide.",
      });
    }
  });

export const createCareGuideItemSchema = z
  .object({
    guideId: z.uuid(),
    highlighted: z.boolean().default(false),
    displayOrder: z.number().int().min(0).max(10000).optional(),
    isActive: z.boolean().default(true),
    translations: z
      .object({
        fa: careGuideItemI18nSchema.omit({ locale: true }),
        en: careGuideItemI18nSchema.omit({ locale: true }),
      })
      .strict(),
  })
  .strict();

export const updateCareGuideItemSchema = z
  .object({
    guideId: z.uuid().optional(),
    highlighted: z.boolean().optional(),
    displayOrder: z.number().int().min(0).max(10000).optional(),
    isActive: z.boolean().optional(),
    translations: z
      .object({
        fa: careGuideItemI18nSchema.omit({ locale: true }).partial(),
        en: careGuideItemI18nSchema.omit({ locale: true }).partial(),
      })
      .strict()
      .partial()
      .optional(),
  })
  .strict();

export const listCareGuideItemsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    perPage: z.coerce.number().int().min(1).max(50).default(10),
    search: z.string().trim().max(100).optional(),
    status: z.enum(["all", "active", "inactive"]).default("all"),
    guideId: z.uuid().optional(),
  })
  .strict();

export const bulkCareGuideItemsSchema = z
  .object({
    action: z.enum(["activate", "deactivate", "delete"]),
    scope: z.enum(["page", "filtered"]),
    ids: z.array(z.uuid()).max(100).optional(),
    filters: listCareGuideItemsQuerySchema
      .pick({ search: true, status: true, guideId: true })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "page" && (!value.ids || value.ids.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["ids"],
        message: "Select at least one care guide item.",
      });
    }
  });

export type CreateCareGuideInput = z.infer<typeof createCareGuideSchema>;
export type UpdateCareGuideInput = z.infer<typeof updateCareGuideSchema>;
export type ListCareGuidesQuery = z.infer<typeof listCareGuidesQuerySchema>;
export type BulkCareGuidesInput = z.infer<typeof bulkCareGuidesSchema>;
export type CareGuideStatusFilter = NonNullable<ListCareGuidesQuery["status"]>;

export type CreateCareGuideItemInput = z.infer<typeof createCareGuideItemSchema>;
export type UpdateCareGuideItemInput = z.infer<typeof updateCareGuideItemSchema>;
export type ListCareGuideItemsQuery = z.infer<typeof listCareGuideItemsQuerySchema>;
export type BulkCareGuideItemsInput = z.infer<typeof bulkCareGuideItemsSchema>;
export type CareGuideItemStatusFilter = NonNullable<ListCareGuideItemsQuery["status"]>;
