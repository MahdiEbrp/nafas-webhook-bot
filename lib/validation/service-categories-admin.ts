import { z } from "zod";

/** Admin service-category listing query (search, status filter, pagination). */
export const listServiceCategoriesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    perPage: z.coerce.number().int().min(1).max(50).default(10),
    search: z.string().trim().max(100).optional(),
    status: z.enum(["all", "active", "inactive"]).default("all"),
  })
  .strict();

export const bulkServiceCategoriesSchema = z
  .object({
    action: z.enum(["activate", "deactivate", "delete"]),
    scope: z.enum(["page", "filtered"]),
    ids: z.array(z.uuid()).max(100).optional(),
    filters: listServiceCategoriesQuerySchema
      .pick({ search: true, status: true })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "page" && (!value.ids || value.ids.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["ids"],
        message: "Select at least one service category.",
      });
    }
  });

export type ListServiceCategoriesQuery = z.infer<typeof listServiceCategoriesQuerySchema>;
export type BulkServiceCategoriesInput = z.infer<typeof bulkServiceCategoriesSchema>;
export type CategoryStatusFilter = NonNullable<
  ListServiceCategoriesQuery["status"]
>;
