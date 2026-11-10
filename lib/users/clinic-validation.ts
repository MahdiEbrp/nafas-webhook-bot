// Contract mirrored from MahdiEbrp/beauty-clinic at af5d4f872a7ac8f75fa1e6780e788e83557c5100.
import { z } from "zod";

export const emailSchema = z.email().trim().toLowerCase();

export const passwordSchema = z
  .string()
  .min(8, "at least 8 characters")
  .max(128, "at most 128 characters")
  .regex(/[a-z]/, "a lowercase letter")
  .regex(/[A-Z]/, "an uppercase letter")
  .regex(/[0-9]/, "a number")
  .regex(/[^a-zA-Z0-9]/, "a special character");

/** Phone is the login identifier (OTP), so it is required everywhere. */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{7,15}$/, "a valid phone number");

export const signupSchema = z
  .object({
    fullName: z.string().trim().min(2).max(100),
    email: emailSchema,
    phone: phoneSchema,
    password: passwordSchema,
  })
  .strict();

/** Admin user listing query (search, status filter, pagination). */
export const listUsersQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    perPage: z.coerce.number().int().min(1).max(50).default(10),
    search: z.string().trim().max(100).optional(),
    status: z.enum(["all", "active", "inactive", "banned"]).default("all"),
    role: z.string().trim().min(1).max(50).optional(),
  })
  .strict();

/** Admin mutation of a user's account state. */
export const updateUserStatusSchema = z
  .object({
    isActive: z.boolean().optional(),
    isBanned: z.boolean().optional(),
    banReason: z.string().trim().max(500).nullish(),
  })
  .strict()
  .refine((data) => data.isActive !== undefined || data.isBanned !== undefined, {
    message: "Nothing to update.",
  });

export const createUserSchema = z
  .object({
    fullName: z.string().trim().min(2).max(100),
    email: emailSchema,
    phone: phoneSchema,
    password: passwordSchema,
    roleKey: z.string().trim().min(1).max(50),
  })
  .strict();

export const changePasswordSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string().max(128),
  })
  .strict()
  .refine((data) => data.password === data.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match.",
  });

export const changeRoleSchema = z.object({ roleKey: z.string().trim().min(1).max(50) }).strict();

export const bulkUsersSchema = z
  .object({
    action: z.enum(["activate", "deactivate", "ban", "unban", "change-role", "delete", "reset-password"]),
    scope: z.enum(["page", "filtered"]),
    ids: z.array(z.uuid()).max(100).optional(),
    filters: listUsersQuerySchema.pick({ search: true, status: true, role: true }).optional(),
    roleKey: z.string().trim().min(1).max(50).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "page" && (!value.ids || value.ids.length === 0)) ctx.addIssue({ code: "custom", path: ["ids"], message: "Select at least one user." });
    if (value.action === "change-role" && !value.roleKey) ctx.addIssue({ code: "custom", path: ["roleKey"], message: "A role is required." });
  });

export type SignupInput = z.infer<typeof signupSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type BulkUsersInput = z.infer<typeof bulkUsersSchema>;
export type UserStatusFilter = NonNullable<ListUsersQuery["status"]>;
