// Contract: MahdiEbrp/beauty-clinic @ af5d4f872a7ac8f75fa1e6780e788e83557c5100
import { z } from "zod";

import { SMS_ERROR_MESSAGES, SMS_LIMITS } from "./constants";
import { pageSchema, positivePageSize } from "./sms-shared";

const variableSchema = z
  .string()
  .trim()
  .min(SMS_LIMITS.messageMinLength)
  .max(SMS_LIMITS.templateVariableMaxLength)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/);

const templateTranslationSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(SMS_LIMITS.messageMinLength)
      .max(SMS_LIMITS.templateNameMaxLength),
    content: z
      .string()
      .trim()
      .min(SMS_LIMITS.messageMinLength)
      .max(SMS_LIMITS.messageMaxLength),
  })
  .strict();

const templateTranslationsSchema = z
  .object({
    fa: templateTranslationSchema,
    en: templateTranslationSchema,
  })
  .strict();

export const listSmsTemplatesQuerySchema = z
  .object({
    page: pageSchema,
    perPage: positivePageSize
      .max(SMS_LIMITS.templateListPerPageMax)
      .default(SMS_LIMITS.templateListPerPageDefault),
    search: z
      .string()
      .trim()
      .max(SMS_LIMITS.templateSearchMaxLength)
      .optional(),
    status: z.enum(["all", "active", "inactive"]).default("all"),
  })
  .strict();

const templateFields = {
  key: z
    .string()
    .trim()
    .min(SMS_LIMITS.templateKeyMinLength)
    .max(SMS_LIMITS.templateKeyMaxLength)
    .regex(/^[a-z][a-z0-9_.-]*$/),
  externalTemplateId: z
    .string()
    .trim()
    .regex(/^\d+$/)
    .max(64)
    .optional(),
  messageType: z.enum(["transactional", "marketing"]).default("transactional"),
  variables: z
    .array(variableSchema)
    .max(SMS_LIMITS.templateVariableCountMax)
    .default([]),
  translations: templateTranslationsSchema,
  displayOrder: z
    .number()
    .int()
    .min(SMS_LIMITS.templateDisplayOrderMin)
    .max(SMS_LIMITS.templateDisplayOrderMax)
    .default(SMS_LIMITS.zero),
  isActive: z.boolean().default(true),
};

function rejectDuplicateVariables(
  value: { variables?: string[] },
  ctx: z.RefinementCtx,
) {
  if (value.variables && new Set(value.variables).size !== value.variables.length) {
    ctx.addIssue({
      code: "custom",
      path: ["variables"],
      message: SMS_ERROR_MESSAGES.templateVariablesNotUnique,
    });
  }
}

export const createSmsTemplateSchema = z
  .object(templateFields)
  .strict()
  .superRefine((value, ctx) => {
    rejectDuplicateVariables(value, ctx);
  });

export const updateSmsTemplateSchema = z
  .object(templateFields)
  .omit({ key: true })
  .partial()
  .strict()
  .superRefine((value, ctx) => {
    rejectDuplicateVariables(value, ctx);
  });

export type ListSmsTemplatesQuery = z.infer<typeof listSmsTemplatesQuerySchema>;
export type CreateSmsTemplateInput = z.infer<typeof createSmsTemplateSchema>;
export type UpdateSmsTemplateInput = z.infer<typeof updateSmsTemplateSchema>;
