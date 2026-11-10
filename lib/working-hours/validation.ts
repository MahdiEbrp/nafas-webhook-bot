// Reference: MahdiEbrp/beauty-clinic @ af5d4f872a7ac8f75fa1e6780e788e83557c5100
import { z } from "zod";

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** English weekday names — the same set stored in the `working_hours` table. */
export const workingHoursDaySchema = z.enum([
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]);

/** One explicit start time + capacity row of a per-weekday slot pattern. */
export const slotPatternSchema = z
  .object({
    startTime: z.string().trim().regex(TIME_PATTERN, "Time must be HH:MM"),
    capacity: z.number().int().min(1).max(500),
    /** Linked service groups; empty/omitted = the slot accepts all groups. */
    groupIds: z.array(z.uuid()).max(50).optional(),
  })
  .strict();

export type SlotPatternInput = z.infer<typeof slotPatternSchema>;

const MAX_PATTERN_ROWS = 96;

function duplicateStartIssue(ctx: z.RefinementCtx, patterns: SlotPatternInput[]) {
  const times = patterns.map((pattern) => pattern.startTime);
  if (new Set(times).size !== times.length) {
    ctx.addIssue({
      code: "custom",
      path: ["patterns"],
      message: "Each pattern start time must be unique.",
    });
  }
}

export const createWorkingHourSchema = z
  .object({
    day: workingHoursDaySchema,
    opens: z.string().trim().regex(TIME_PATTERN, "Time must be HH:MM"),
    closes: z.string().trim().regex(TIME_PATTERN, "Time must be HH:MM"),
    capacity: z.number().int().min(1).max(500).default(1),
    displayOrder: z.number().int().min(0).max(1000).default(0),
    isActive: z.boolean().default(true),
    patterns: z.array(slotPatternSchema).max(MAX_PATTERN_ROWS).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.closes <= data.opens) {
      ctx.addIssue({
        code: "custom",
        path: ["closes"],
        message: "Closes must be after opens",
      });
    }
  })
  .superRefine((data, ctx) => {
    if (data.patterns) duplicateStartIssue(ctx, data.patterns);
  });

export type CreateWorkingHourInput = z.infer<typeof createWorkingHourSchema>;

/** The day cannot move — it is the unique identity of a working-hours row. */
export const updateWorkingHourSchema = z
  .object({
    opens: z.string().trim().regex(TIME_PATTERN, "Time must be HH:MM").optional(),
    closes: z.string().trim().regex(TIME_PATTERN, "Time must be HH:MM").optional(),
    capacity: z.number().int().min(1).max(500).optional(),
    displayOrder: z.number().int().min(0).max(1000).optional(),
    isActive: z.boolean().optional(),
    patterns: z.array(slotPatternSchema).max(MAX_PATTERN_ROWS).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.closes && data.opens && data.closes <= data.opens) {
      ctx.addIssue({
        code: "custom",
        path: ["closes"],
        message: "Closes must be after opens",
      });
    }
  })
  .superRefine((data, ctx) => {
    if (data.patterns) duplicateStartIssue(ctx, data.patterns);
  });

export type UpdateWorkingHourInput = z.infer<typeof updateWorkingHourSchema>;

export const listWorkingHoursQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    perPage: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(100).optional(),
    status: z.enum(["all", "active", "inactive"]).default("all"),
  })
  .strict();

export type ListWorkingHoursQuery = z.infer<typeof listWorkingHoursQuerySchema>;

export const bulkWorkingHoursSchema = z
  .object({
    action: z.enum(["activate", "deactivate", "delete"]),
    scope: z.enum(["page", "filtered"]),
    ids: z.array(z.uuid()).max(100).optional(),
    filters: listWorkingHoursQuerySchema
      .pick({ search: true, status: true })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "page" && (!value.ids || value.ids.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["ids"],
        message: "Select at least one working-hours row.",
      });
    }
  });

export type BulkWorkingHoursInput = z.infer<typeof bulkWorkingHoursSchema>;