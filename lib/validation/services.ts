import { z } from "zod";

import { SLUG_PATTERN } from "@/lib/validation/slug";

export const priceTypeSchema = z.enum(["fixed", "from", "on_request"]);

export const serviceImageTypeSchema = z.enum(["before", "after", "gallery"]);

export const localeSchema = z.enum(["en", "fa"]);

/** Admin services listing query (search, filters, pagination). */
export const listServicesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    perPage: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(100).optional(),
    categoryId: z.uuid().optional(),
    status: z.enum(["all", "active", "inactive"]).default("all"),
    featured: z.enum(["all", "yes", "no"]).default("all"),
  })
  .strict();

export const serviceGroupI18nSchema = z
  .object({
    locale: localeSchema,
    name: z.string().trim().min(1).max(256),
    description: z.string().trim().max(1000).optional().nullable(),
    seoTitle: z.string().trim().max(256).optional().nullable(),
    seoDescription: z.string().trim().max(512).optional().nullable(),
  })
  .strict();

export const createServiceGroupSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(SLUG_PATTERN, "Slug must be kebab-case"),
    icon: z.string().trim().max(100).optional().nullable(),
    image: z.string().trim().max(2048).optional().nullable(),
    displayOrder: z.number().int().min(0).max(10000).default(0),
    isActive: z.boolean().default(true),
    translations: z
      .object({
        fa: serviceGroupI18nSchema.omit({ locale: true }),
        en: serviceGroupI18nSchema.omit({ locale: true }),
      })
      .strict(),
  })
  .strict();

export const updateServiceGroupSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(SLUG_PATTERN, "Slug must be kebab-case")
      .optional(),
    icon: z.string().trim().max(100).optional().nullable(),
    image: z.string().trim().max(2048).optional().nullable(),
    displayOrder: z.number().int().min(0).max(10000).optional(),
    isActive: z.boolean().optional(),
    translations: z
      .object({
        fa: serviceGroupI18nSchema.omit({ locale: true }).partial(),
        en: serviceGroupI18nSchema.omit({ locale: true }).partial(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const serviceCategoryI18nSchema = z
  .object({
    locale: localeSchema,
    name: z.string().trim().min(1).max(256),
    description: z.string().trim().max(1000).optional().nullable(),
    seoTitle: z.string().trim().max(256).optional().nullable(),
    seoDescription: z.string().trim().max(512).optional().nullable(),
  })
  .strict();

export const createServiceCategorySchema = z
  .object({
    groupId: z.uuid(),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(SLUG_PATTERN, "Slug must be kebab-case"),
    icon: z.string().trim().max(100).optional().nullable(),
    image: z.string().trim().max(2048).optional().nullable(),
    displayOrder: z.number().int().min(0).max(10000).default(0),
    isActive: z.boolean().default(true),
    translations: z
      .object({
        fa: serviceCategoryI18nSchema.omit({ locale: true }),
        en: serviceCategoryI18nSchema.omit({ locale: true }),
      })
      .strict(),
  })
  .strict();

export const updateServiceCategorySchema = z
  .object({
    groupId: z.uuid().optional(),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(SLUG_PATTERN, "Slug must be kebab-case")
      .optional(),
    icon: z.string().trim().max(100).optional().nullable(),
    image: z.string().trim().max(2048).optional().nullable(),
    displayOrder: z.number().int().min(0).max(10000).optional(),
    isActive: z.boolean().optional(),
    translations: z
      .object({
        fa: serviceCategoryI18nSchema.omit({ locale: true }).partial(),
        en: serviceCategoryI18nSchema.omit({ locale: true }).partial(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const serviceI18nSchema = z
  .object({
    locale: localeSchema,
    title: z.string().trim().min(1).max(256),
    shortDesc: z.string().trim().max(512).optional().nullable(),
    fullDesc: z.string().trim().max(4000).optional().nullable(),
    seoTitle: z.string().trim().max(60).optional().nullable(),
    seoDescription: z.string().trim().max(160).optional().nullable(),
  })
  .strict();

export const serviceImageInputSchema = z
  .object({
    imageUrl: z.string().trim().min(1).max(2048),
    type: serviceImageTypeSchema.default("gallery"),
    displayOrder: z.number().int().min(0).max(10000).default(0),
  })
  .strict();

export const serviceFaqInputSchema = z
  .object({
    question: z.string().trim().min(1).max(512),
    answer: z.string().trim().min(1).max(4000),
    displayOrder: z.number().int().min(0).max(10000).default(0),
  })
  .strict();

export const serviceFaqI18nSchema = z
  .object({
    locale: localeSchema,
    question: z.string().trim().min(1).max(512),
    answer: z.string().trim().min(1).max(4000),
  })
  .strict();

export const createServiceSchema = z
  .object({
    categoryId: z.uuid(),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(SLUG_PATTERN, "Slug must be kebab-case"),
    price: z.coerce.number().nonnegative().max(1_000_000_000).optional().nullable(),
    priceType: priceTypeSchema.default("fixed"),
    durationMin: z.number().int().min(1).max(1440).optional().nullable(),
    sessionsCount: z.number().int().min(1).max(100).default(1),
    coverImage: z.string().trim().max(2048).optional().nullable(),
    isActive: z.boolean().default(true),
    isFeatured: z.boolean().default(false),
    displayOrder: z.number().int().min(0).max(10000).default(0),
    translations: z
      .object({
        fa: serviceI18nSchema.omit({ locale: true }),
        en: serviceI18nSchema.omit({ locale: true }),
      })
      .strict(),
    images: z.array(serviceImageInputSchema).max(50).optional(),
    faqs: z
      .array(
        z
          .object({
            displayOrder: z.number().int().min(0).max(10000).default(0),
            translations: z
              .object({
                fa: serviceFaqI18nSchema.omit({ locale: true }),
                en: serviceFaqI18nSchema.omit({ locale: true }),
              })
              .strict(),
          })
          .strict()
      )
      .max(50)
      .optional(),
  })
  .strict();

export const updateServiceSchema = z
  .object({
    categoryId: z.uuid().optional(),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(SLUG_PATTERN, "Slug must be kebab-case")
      .optional(),
    price: z.coerce.number().nonnegative().max(1_000_000_000).optional().nullable(),
    priceType: priceTypeSchema.optional(),
    durationMin: z.number().int().min(1).max(1440).optional().nullable(),
    sessionsCount: z.number().int().min(1).max(100).optional(),
    coverImage: z.string().trim().max(2048).optional().nullable(),
    isActive: z.boolean().optional(),
    isFeatured: z.boolean().optional(),
    displayOrder: z.number().int().min(0).max(10000).optional(),
    translations: z
      .object({
        fa: serviceI18nSchema.omit({ locale: true }).partial(),
        en: serviceI18nSchema.omit({ locale: true }).partial(),
      })
      .strict()
      .optional(),
    images: z.array(serviceImageInputSchema).max(50).optional(),
    faqs: z
      .array(
        z
          .object({
            displayOrder: z.number().int().min(0).max(10000).default(0),
            translations: z
              .object({
                fa: serviceFaqI18nSchema.omit({ locale: true }),
                en: serviceFaqI18nSchema.omit({ locale: true }),
              })
              .strict(),
          })
          .strict()
      )
      .max(50)
      .optional(),
  })
  .strict();

export type CreateServiceInput = z.infer<typeof createServiceSchema>;
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;
export type CreateServiceGroupInput = z.infer<typeof createServiceGroupSchema>;
export type UpdateServiceGroupInput = z.infer<typeof updateServiceGroupSchema>;
export type CreateServiceCategoryInput = z.infer<typeof createServiceCategorySchema>;
export type UpdateServiceCategoryInput = z.infer<typeof updateServiceCategorySchema>;
export type ListServicesQuery = z.infer<typeof listServicesQuerySchema>;