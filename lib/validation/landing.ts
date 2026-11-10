import { z } from "zod";

import { localeSchema } from "./services";

export const landingListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(100).default(10),
    search: z.string().trim().max(200).optional(),
    status: z.enum(["all", "active", "inactive"]).default("all"),
  })
  .strict();

// --- Marquee items ---------------------------------------------------------

const marqueeI18nSchema = z
  .object({ locale: localeSchema, text: z.string().trim().min(1).max(300) })
  .strict();

export const createMarqueeItemSchema = z
  .object({
    icon: z.string().trim().max(100).optional().nullable(),
    displayOrder: z.number().int().min(0).max(10000).default(0),
    isActive: z.boolean().default(true),
    translations: z
      .object({
        fa: marqueeI18nSchema.omit({ locale: true }),
        en: marqueeI18nSchema.omit({ locale: true }),
      })
      .strict(),
  })
  .strict();

export const updateMarqueeItemSchema = createMarqueeItemSchema.partial().strict();

// --- Service cards ---------------------------------------------------------

const serviceCardI18nSchema = z
  .object({
    locale: localeSchema,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional().nullable(),
    ctaLabel: z.string().trim().max(120).optional().nullable(),
  })
  .strict();

export const createServiceCardSchema = z
  .object({
    icon: z.string().trim().max(100).optional().nullable(),
    image: z.string().trim().max(2048).optional().nullable(),
    displayOrder: z.number().int().min(0).max(10000).default(0),
    isActive: z.boolean().default(true),
    translations: z
      .object({
        fa: serviceCardI18nSchema.omit({ locale: true }),
        en: serviceCardI18nSchema.omit({ locale: true }),
      })
      .strict(),
  })
  .strict();

export const updateServiceCardSchema = createServiceCardSchema.partial().strict();

// --- About stats -----------------------------------------------------------

const statI18nSchema = z
  .object({ locale: localeSchema, label: z.string().trim().min(1).max(120) })
  .strict();

export const createStatSchema = z
  .object({
    value: z.number().int().min(0).max(1000000000),
    compact: z.boolean().default(false),
    plus: z.boolean().default(false),
    displayOrder: z.number().int().min(0).max(10000).default(0),
    isActive: z.boolean().default(true),
    translations: z
      .object({
        fa: statI18nSchema.omit({ locale: true }),
        en: statI18nSchema.omit({ locale: true }),
      })
      .strict(),
  })
  .strict();

export const updateStatSchema = createStatSchema.partial().strict();

// --- Gallery items ---------------------------------------------------------

const galleryI18nSchema = z
  .object({
    locale: localeSchema,
    caption: z.string().trim().max(300).optional().nullable(),
    alt: z.string().trim().min(1).max(300),
  })
  .strict();

export const createGalleryItemSchema = z
  .object({
    imageUrl: z.string().trim().min(1).max(2048),
    displayOrder: z.number().int().min(0).max(10000).default(0),
    isActive: z.boolean().default(true),
    translations: z
      .object({
        fa: galleryI18nSchema.omit({ locale: true }),
        en: galleryI18nSchema.omit({ locale: true }),
      })
      .strict(),
  })
  .strict();

export const updateGalleryItemSchema = createGalleryItemSchema.partial().strict();

// --- Hero ------------------------------------------------------------------

const heroI18nSchema = z
  .object({
    locale: localeSchema,
    title: z.string().trim().min(1).max(300),
    tagline: z.string().trim().max(200).optional().nullable(),
    description: z.string().trim().max(2000).optional().nullable(),
    ctaLabel1: z.string().trim().min(1).max(120),
    ctaLabel2: z.string().trim().min(1).max(120),
  })
  .strict();

export const updateHeroSchema = z
  .object({
    image: z.string().trim().max(2048).optional().nullable(),
    taglineIcon: z.string().trim().max(100).optional().nullable(),
    translations: z
      .object({
        fa: heroI18nSchema.omit({ locale: true }),
        en: heroI18nSchema.omit({ locale: true }),
      })
      .strict(),
  })
  .partial()
  .strict();

// --- Settings (sections + SEO) ---------------------------------------------

const sectionSettingsI18nSchema = z
  .object({
    locale: localeSchema,
    heading: z.string().trim().min(1).max(300),
    description: z.string().trim().max(2000).optional().nullable(),
  })
  .strict();

const sectionSettingsSchema = z
  .object({
    key: z.string().trim().min(1).max(80),
    translations: z
      .object({
        fa: sectionSettingsI18nSchema.omit({ locale: true }),
        en: sectionSettingsI18nSchema.omit({ locale: true }),
      })
      .strict(),
  })
  .strict();

const seoSchema = z
  .object({
    fa: z
      .object({ seoTitle: z.string().trim().max(200).optional().nullable(), seoDescription: z.string().trim().max(500).optional().nullable() })
      .strict(),
    en: z
      .object({ seoTitle: z.string().trim().max(200).optional().nullable(), seoDescription: z.string().trim().max(500).optional().nullable() })
      .strict(),
  })
  .strict();

export const updateSettingsSchema = z
  .object({
    seo: seoSchema.optional(),
    sections: z.array(sectionSettingsSchema).max(20).default([]),
  })
  .strict();

// --- Bulk actions ----------------------------------------------------------

export const bulkLandingCollectionSchema = z
  .object({
    action: z.enum(["activate", "deactivate", "delete"]),
    scope: z.enum(["page", "filtered"]),
    ids: z.array(z.uuid()).max(100).optional(),
    filters: landingListQuerySchema
      .pick({ search: true, status: true })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "page" && (!value.ids || value.ids.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["ids"],
        message: "Select at least one item.",
      });
    }
  });
