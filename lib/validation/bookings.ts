import { z } from "zod";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export const bookingStatusSchema = z.enum([
  "pending",
  "paid",
  "waiting",
  "done",
  "refunded",
]);

export const calendarTypeSchema = z.enum(["gregorian", "jalali"]);

/** A single date (Gregorian YYYY-MM-DD) or Jalali range resolved client-side. */
export const slotDateSchema = z
  .string()
  .trim()
  .regex(DATE_PATTERN, "Date must be YYYY-MM-DD");

/**
 * `groupIds` links a slot to specific service groups (one slot → many groups).
 * An empty array or omitted field means the slot is bookable for ALL groups.
 */
export const createSlotSchema = z
  .object({
    groupIds: z.array(z.uuid()).max(50).optional(),
    slotDate: slotDateSchema,
    startTime: z.string().trim().regex(TIME_PATTERN, "Time must be HH:MM"),
    endTime: z.string().trim().regex(TIME_PATTERN, "Time must be HH:MM"),
    capacity: z.number().int().min(1).max(500).default(1),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.endTime <= data.startTime) {
      ctx.addIssue({
        code: "custom",
        path: ["endTime"],
        message: "End time must be after start time",
      });
    }
  });

export const createSlotsSchema = z
  .object({
    slots: z.array(createSlotSchema).min(1).max(100),
  })
  .strict();

export const updateSlotSchema = z
  .object({
    groupIds: z.array(z.uuid()).max(50).optional(),
    slotDate: slotDateSchema.optional(),
    startTime: z.string().trim().regex(TIME_PATTERN, "Time must be HH:MM").optional(),
    endTime: z.string().trim().regex(TIME_PATTERN, "Time must be HH:MM").optional(),
    capacity: z.number().int().min(1).max(500).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const listSlotsQuerySchema = z
  .object({
    from: slotDateSchema.optional(),
    to: slotDateSchema.optional(),
    groupId: z.uuid().optional(),
  })
  .strict();

export const availableSlotsQuerySchema = z
  .object({
    date: slotDateSchema,
    groupId: z.uuid().optional(),
  })
  .strict();

/** One order line: a service group + slot pair with seat count. */
export const bookingItemSchema = z
  .object({
    groupId: z.uuid(),
    slotId: z.uuid(),
    quantity: z.number().int().min(1).max(10).default(1),
  })
  .strict();

export const createBookingSchema = z
  .object({
    fullName: z.string().trim().min(2).max(160),
    phone: z
      .string()
      .trim()
      .regex(/^[0-9+][0-9\s()-]{6,19}$/, "Enter a valid phone number")
      .max(24),
    email: z.email().trim().max(254).optional().nullable(),
    groupId: z.uuid().optional(),
    slotId: z.uuid().optional(),
    locale: z.enum(["fa", "en"]).default("fa"),
    notes: z.string().trim().max(1000).optional().nullable(),
    /** Multiple service groups sharing one slot (one reservation, many services). */
    items: z.array(bookingItemSchema).min(1).max(10).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.items && data.items.length > 0) {
      // Group booking mode — items provided; groupId/slotId not required.
      return;
    }
    // Single booking mode — groupId and slotId are required.
    if (!data.groupId) {
      ctx.addIssue({
        code: "custom",
        path: ["groupId"],
        message: "Service group is required.",
      });
    }
    if (!data.slotId) {
      ctx.addIssue({
        code: "custom",
        path: ["slotId"],
        message: "Time slot is required.",
      });
    }
  });

/**
 * Multi-group order: one row per item, all sharing the generated group ref.
 * Duplicate (groupId, slotId) lines are allowed — quantities are merged.
 */
export const createBookingGroupSchema = z
  .object({
    fullName: z.string().trim().min(2).max(160),
    phone: z
      .string()
      .trim()
      .regex(/^[0-9+][0-9\s()-]{6,19}$/, "Enter a valid phone number")
      .max(24),
    email: z.email().trim().max(254).optional().nullable(),
    locale: z.enum(["fa", "en"]).default("fa"),
    notes: z.string().trim().max(1000).optional().nullable(),
    consultationRequired: z.boolean().default(false),
    hasAllergies: z.boolean().default(false),
    isPregnant: z.boolean().default(false),
    /** Public orders must accept the clinic booking rules before creation. */
    termsAccepted: z.literal(true),
    items: z.array(bookingItemSchema).min(1).max(10),
  })
  .strict();

export const payBookingGroupSchema = z
  .object({
    bookingId: z.uuid().optional(),
    groupRef: z.string().trim().regex(/^NF-\d{5}$/).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.bookingId) !== Boolean(v.groupRef), {
    message: "Provide exactly one of bookingId or groupRef",
    path: ["groupRef"],
  });

export const myBookingsQuerySchema = z
  .object({
    phone: z
      .string()
      .trim()
      .regex(/^[0-9+][0-9\s()-]{6,19}$/, "Enter a valid phone number")
      .max(24),
  })
  .strict();

export const cancelBookingGroupSchema = z
  .object({
    groupRef: z.string().trim().regex(/^NF-\d{5}$/),
    phone: z
      .string()
      .trim()
      .regex(/^[0-9+][0-9\s()-]{6,19}$/, "Enter a valid phone number")
      .max(24),
  })
  .strict();

export const bookingStatusUpdateSchema = z
  .object({
    status: bookingStatusSchema,
  })
  .strict();

export const listBookingsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    perPage: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(100).optional(),
    status: z.enum(["all", ...bookingStatusSchema.options]).default("all"),
    slotId: z.uuid().optional(),
  })
  .strict();

export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;

/**
 * Query params for the signed-in customer's own reservations list: the admin
 * list filters without the staff-only `slotId` scope.
 */
export const myReservationsQuerySchema = listBookingsQuerySchema.pick({
  page: true,
  perPage: true,
  search: true,
  status: true,
});

export type MyReservationsQuery = z.infer<typeof myReservationsQuerySchema>;

/**
 * Paginated admin slot list (separate from the date-range calendar fetch).
 */
export const listSlotsAdminQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    perPage: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(100).optional(),
    status: z.enum(["all", "active", "inactive", "expired"]).default("all"),
    groupId: z.uuid().optional(),
  })
  .strict();

export type ListSlotsAdminQuery = z.infer<typeof listSlotsAdminQuerySchema>;

/**
 * Bulk actions for the reservations admin list.
 */
export const bulkBookingsSchema = z
  .object({
    action: z.enum(["pay", "done", "refund", "delete"]),
    scope: z.enum(["page", "filtered"]),
    ids: z.array(z.uuid()).max(100).optional(),
    filters: listBookingsQuerySchema
      .pick({ search: true, status: true })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "page" && (!value.ids || value.ids.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["ids"],
        message: "Select at least one reservation.",
      });
    }
  });

export type BulkBookingsInput = z.infer<typeof bulkBookingsSchema>;

/**
 * Bulk actions for the slots admin list.
 */
export const bulkSlotsSchema = z
  .object({
    action: z.enum(["activate", "deactivate", "delete"]),
    scope: z.enum(["page", "filtered"]),
    ids: z.array(z.uuid()).max(100).optional(),
    filters: listSlotsAdminQuerySchema
      .pick({ search: true, status: true })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "page" && (!value.ids || value.ids.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["ids"],
        message: "Select at least one slot.",
      });
    }
  });

export type BulkSlotsInput = z.infer<typeof bulkSlotsSchema>;

/**
 * Admin update for an existing reservation: editable customer fields + status.
 */
export const updateBookingAdminSchema = z
  .object({
    fullName: z.string().trim().min(2).max(160).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^[0-9+][0-9\s()-]{6,19}$/, "Enter a valid phone number")
      .max(24)
      .optional(),
    email: z.email().trim().max(254).optional().nullable(),
    notes: z.string().trim().max(1000).optional().nullable(),
    status: bookingStatusSchema.optional(),
  })
  .strict();

export type UpdateBookingAdminInput = z.infer<typeof updateBookingAdminSchema>;

export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type CreateBookingGroupInput = z.infer<typeof createBookingGroupSchema>;
export type PayBookingGroupInput = z.infer<typeof payBookingGroupSchema>;
export type MyBookingsQuery = z.infer<typeof myBookingsQuerySchema>;
export type CancelBookingGroupInput = z.infer<typeof cancelBookingGroupSchema>;
export type CreateSlotInput = z.infer<typeof createSlotSchema>;
export type CreateSlotsInput = z.infer<typeof createSlotsSchema>;
export type UpdateSlotInput = z.infer<typeof updateSlotSchema>;
export type ListSlotsQuery = z.infer<typeof listSlotsQuerySchema>;
export type AvailableSlotsQuery = z.infer<typeof availableSlotsQuerySchema>;
export type BookingStatusUpdateInput = z.infer<typeof bookingStatusUpdateSchema>;
