import { z } from "zod";

import { listServicesQuerySchema } from "./services";

export type ListServicesAdminQuery = z.infer<typeof listServicesQuerySchema>;

export type ServiceStatusFilter = NonNullable<ListServicesAdminQuery["status"]>;
export type ServiceFeaturedFilter = NonNullable<ListServicesAdminQuery["featured"]>;

/**
 * Bulk actions for service catalog entries. Mirrors the service-categories
 * admin schema: page-scoped bulk actions carry explicit ids, filtered-scoped
 * actions re-derive ids server-side from the active filters.
 */
export const bulkServicesSchema = z
  .object({
    action: z.enum(["activate", "deactivate", "delete"]),
    scope: z.enum(["page", "filtered"]),
    ids: z.array(z.uuid()).max(100).optional(),
    filters: listServicesQuerySchema
      .pick({ search: true, status: true, featured: true, categoryId: true })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "page" && (!value.ids || value.ids.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["ids"],
        message: "Select at least one service.",
      });
    }
  });

export type BulkServicesInput = z.infer<typeof bulkServicesSchema>;
