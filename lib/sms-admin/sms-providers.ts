// Contract: MahdiEbrp/beauty-clinic @ af5d4f872a7ac8f75fa1e6780e788e83557c5100
import { z } from "zod";

import { SMS_ERROR_MESSAGES, SMS_LIMITS } from "./constants";
import { normalizeIranianPhone } from "./phone";
import {
  credentialsSchema,
  pageSchema,
  positivePageSize,
  providerKinds,
  providerName,
  safeUrlSchema,
  senderSchema,
} from "./sms-shared";

export const listSmsProvidersQuerySchema = z
  .object({
    page: pageSchema,
    perPage: positivePageSize
      .max(SMS_LIMITS.providerListPerPageMax)
      .default(SMS_LIMITS.providerListPerPageDefault),
    search: z
      .string()
      .trim()
      .max(SMS_LIMITS.providerSearchMaxLength)
      .optional(),
    status: z.enum(["all", "active", "inactive"]).default("all"),
  })
  .strict();

export const createSmsProviderSchema = z
  .object({
    name: providerName,
    kind: z.enum(providerKinds),
    apiUrl: safeUrlSchema,
    token: z
      .string()
      .trim()
      .min(SMS_LIMITS.tokenMinLength)
      .max(SMS_LIMITS.providerTokenMaxLength),
    credentials: credentialsSchema.optional(),
    sender: senderSchema,
    isActive: z.boolean().default(true),
    isDefault: z.boolean().default(false),
  })
  .strict();

export const updateSmsProviderSchema = z
  .object({
    name: providerName.optional(),
    kind: z.enum(providerKinds).optional(),
    apiUrl: safeUrlSchema.optional(),
    token: z
      .string()
      .trim()
      .max(SMS_LIMITS.providerTokenMaxLength)
      .optional(),
    credentials: credentialsSchema.optional(),
    sender: senderSchema,
    isActive: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.token === undefined ||
      value.token.length > SMS_LIMITS.emptyLength,
    SMS_ERROR_MESSAGES.tokenEmpty,
  );

export const testSmsProviderSchema = z
  .object({
    recipient: z
      .string()
      .trim()
      .min(SMS_LIMITS.recipientMinLength)
      .max(SMS_LIMITS.recipientMaxLength),
    message: z
      .string()
      .trim()
      .min(SMS_LIMITS.messageMinLength)
      .max(SMS_LIMITS.messageMaxLength),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!normalizeIranianPhone(value.recipient)) {
      ctx.addIssue({
        code: "custom",
        path: ["recipient"],
        message: SMS_ERROR_MESSAGES.invalidIranianMobile,
      });
    }
  });

export type ListSmsProvidersQuery = z.infer<typeof listSmsProvidersQuerySchema>;
export type CreateSmsProviderInput = z.infer<typeof createSmsProviderSchema>;
export type UpdateSmsProviderInput = z.infer<typeof updateSmsProviderSchema>;
export type TestSmsProviderInput = z.infer<typeof testSmsProviderSchema>;
