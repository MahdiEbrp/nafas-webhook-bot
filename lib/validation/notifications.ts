import { z } from "zod";

export const listNotificationsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100).default(1),
    perPage: z.coerce.number().int().min(1).max(50).default(5),
  })
  .strict();

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
