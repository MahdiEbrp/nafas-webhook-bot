// Contract: MahdiEbrp/beauty-clinic @ af5d4f872a7ac8f75fa1e6780e788e83557c5100
import { z } from "zod";

import { SMS_ERROR_MESSAGES, SMS_LIMITS } from "./constants";
import { SMS_PROVIDER_OPTIONS } from "./provider-kinds";

export const providerKinds = SMS_PROVIDER_OPTIONS.map((option) => option.kind) as [
  (typeof SMS_PROVIDER_OPTIONS)[number]["kind"],
  ...(typeof SMS_PROVIDER_OPTIONS)[number]["kind"][],
];

export const safeUrlSchema = z
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.hostname === "localhost";
  }, SMS_ERROR_MESSAGES.unsafeProviderUrl);

export const credentialsSchema = z
  .object({
    apiKey: z.string().trim().max(SMS_LIMITS.providerApiKeyMaxLength).optional(),
    username: z
      .string()
      .trim()
      .max(SMS_LIMITS.providerUsernameMaxLength)
      .optional(),
    password: z.string().max(SMS_LIMITS.providerPasswordMaxLength).optional(),
    authHeader: z
      .string()
      .trim()
      .max(SMS_LIMITS.providerAuthHeaderMaxLength)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    authScheme: z.enum(["bearer", "x-api-key", "token", "none"]).optional(),
    lineNumber: z
      .string()
      .trim()
      .max(SMS_LIMITS.providerLineNumberMaxLength)
      .optional(),
    payloadMode: z.enum(["standard", "bulk"]).optional(),
  })
  .strict();

export const providerName = z
  .string()
  .trim()
  .min(SMS_LIMITS.providerNameMinLength)
  .max(SMS_LIMITS.providerNameMaxLength);

export const senderSchema = z
  .string()
  .trim()
  .max(SMS_LIMITS.providerSenderMaxLength)
  .optional();

export const pageSchema = z
  .coerce
  .number()
  .int()
  .min(SMS_LIMITS.pageMin)
  .max(SMS_LIMITS.providerListPageMax)
  .default(SMS_LIMITS.pageDefault);

export const positivePageSize = z
  .coerce
  .number()
  .int()
  .min(SMS_LIMITS.pageMin);
