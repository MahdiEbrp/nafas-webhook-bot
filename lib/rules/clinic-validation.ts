import { z } from "zod";

// Reference: MahdiEbrp/beauty-clinic @ af5d4f872a7ac8f75fa1e6780e788e83557c5100
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const ruleI18nSchema = z
  .object({
    locale: z.enum(["en", "fa"]),
    name: z.string().trim().min(1).max(256),
    description: z.string().trim().max(2000).optional().nullable(),
  })
  .strict();

export const createRuleSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(SLUG_PATTERN, "Slug must be kebab-case"),
    icon: z.string().trim().max(100).optional().nullable(),
    image: z.string().trim().max(2048).optional().nullable(),
    color: z.string().trim().max(50).optional().nullable(),
    highlighted: z.boolean().default(false),
    displayOrder: z.number().int().min(0).max(10000).default(0),
    isActive: z.boolean().default(true),
    translations: z
      .object({
        fa: ruleI18nSchema.omit({ locale: true }),
        en: ruleI18nSchema.omit({ locale: true }),
      })
      .strict(),
  })
  .strict();

export const updateRuleSchema = z
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
    color: z.string().trim().max(50).optional().nullable(),
    highlighted: z.boolean().optional(),
    displayOrder: z.number().int().min(0).max(10000).optional(),
    isActive: z.boolean().optional(),
    translations: z
      .object({
        fa: ruleI18nSchema.omit({ locale: true }).partial(),
        en: ruleI18nSchema.omit({ locale: true }).partial(),
      })
              .strict()
        .partial()
        .optional(),
  })
  .strict();

export const listRulesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    perPage: z.coerce.number().int().min(1).max(50).default(10),
    search: z.string().trim().max(100).optional(),
    status: z.enum(["all", "active", "inactive"]).default("all"),
  })
  .strict();

export const bulkRulesSchema = z
  .object({
    action: z.enum(["activate", "deactivate", "delete"]),
    scope: z.enum(["page", "filtered"]),
    ids: z.array(z.uuid()).max(100).optional(),
    filters: listRulesQuerySchema
      .pick({ search: true, status: true })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "page" && (!value.ids || value.ids.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["ids"],
        message: "Select at least one rule.",
      });
    }
  });

export type CreateRuleInput = z.infer<typeof createRuleSchema>;
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;
export type ListRulesQuery = z.infer<typeof listRulesQuerySchema>;
export type BulkRulesInput = z.infer<typeof bulkRulesSchema>;
export type RuleStatusFilter = NonNullable<ListRulesQuery["status"]>;
