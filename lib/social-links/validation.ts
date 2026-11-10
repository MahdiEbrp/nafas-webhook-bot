// Reference: MahdiEbrp/beauty-clinic @ af5d4f872a7ac8f75fa1e6780e788e83557c5100
import { z } from "zod";

/** Admin social-link listing query (search, status filter, pagination). */
export const listSocialLinksQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    perPage: z.coerce.number().int().min(1).max(50).default(10),
    search: z.string().trim().max(100).optional(),
    status: z.enum(["all", "active", "inactive"]).default("all"),
  })
  .strict();

const urlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    (value) => /^https?:\/\/.+/.test(value),
    "Must be a valid http(s) URL.",
  );

export const createSocialLinkSchema = z
  .object({
    url: urlSchema,
    imageUrl: urlSchema.optional().or(z.literal("").transform(() => undefined)),
    labelFa: z.string().trim().min(1).max(80),
    labelEn: z.string().trim().min(1).max(80),
    displayOrder: z.number().int().min(0).max(100000).default(0),
    isActive: z.boolean().default(true),
  })
  .strict();

export const updateSocialLinkSchema = z
  .object({
    url: urlSchema.optional(),
    imageUrl: urlSchema.optional().or(z.literal("").transform(() => undefined)),
    labelFa: z.string().trim().min(1).max(80).optional(),
    labelEn: z.string().trim().min(1).max(80).optional(),
    displayOrder: z.number().int().min(0).max(100000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const bulkSocialLinksSchema = z
  .object({
    action: z.enum(["activate", "deactivate", "delete"]),
    scope: z.enum(["page", "filtered"]),
    ids: z.array(z.uuid()).max(100).optional(),
    filters: listSocialLinksQuerySchema
      .pick({ search: true, status: true })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "page" && (!value.ids || value.ids.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["ids"],
        message: "Select at least one social link.",
      });
    }
  });

export type ListSocialLinksQuery = z.infer<typeof listSocialLinksQuerySchema>;
export type CreateSocialLinkInput = z.infer<typeof createSocialLinkSchema>;
export type UpdateSocialLinkInput = z.infer<typeof updateSocialLinkSchema>;
export type BulkSocialLinksInput = z.infer<typeof bulkSocialLinksSchema>;
export type SocialLinkStatusFilter = NonNullable<ListSocialLinksQuery["status"]>;