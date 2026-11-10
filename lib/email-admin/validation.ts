import { isIP } from "node:net";
import { z } from "zod";
import { EMAIL_LIMITS, EMAIL_PROVIDER_KINDS, EMAIL_STATUSES } from "./constants";

const emailPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
export const emailAddressSchema = z.string().trim().min(EMAIL_LIMITS.recipientMinLength).max(EMAIL_LIMITS.recipientMaxLength).refine(value => emailPattern.test(value), "Enter a valid email address.");
const pageSchema = z.coerce.number().int().min(EMAIL_LIMITS.pageMin).max(EMAIL_LIMITS.providerListPageMax).default(EMAIL_LIMITS.pageDefault);
const pageSize = (max: number, fallback: number) => z.coerce.number().int().min(EMAIL_LIMITS.pageMin).max(max).default(fallback);
const search = (max: number) => z.string().trim().max(max).optional();
const statusFilter = z.enum(["all", "active", "inactive"]).default("all");
const providerName = z.string().trim().min(EMAIL_LIMITS.providerNameMinLength).max(EMAIL_LIMITS.providerNameMaxLength);
const host = z.string().trim().min(EMAIL_LIMITS.pageMin).max(EMAIL_LIMITS.providerHostMaxLength);
const port = z.coerce.number().int().min(EMAIL_LIMITS.providerPortMin).max(EMAIL_LIMITS.providerPortMax);
const username = z.string().trim().min(EMAIL_LIMITS.pageMin).max(EMAIL_LIMITS.providerUsernameMaxLength);
const password = z.string().trim().min(EMAIL_LIMITS.pageMin).max(EMAIL_LIMITS.providerPasswordMaxLength);
const optionalFromEmail = z.string().trim().max(EMAIL_LIMITS.providerFromEmailMaxLength).optional();
const optionalFromName = z.string().trim().max(EMAIL_LIMITS.providerFromNameMaxLength).optional();
const providerKind = z.enum(EMAIL_PROVIDER_KINDS);
const encryption = z.enum(["ssl", "starttls", "none"]).default("ssl");

export const listEmailProvidersQuerySchema = z.object({
  page: pageSchema,
  perPage: pageSize(EMAIL_LIMITS.providerListPerPageMax, EMAIL_LIMITS.providerListPerPageDefault),
  search: search(EMAIL_LIMITS.providerSearchMaxLength),
  status: statusFilter,
}).strict();

export const createEmailProviderSchema = z.object({
  name: providerName,
  kind: providerKind,
  host,
  port,
  username,
  password,
  encryption,
  fromEmail: optionalFromEmail,
  fromName: optionalFromName,
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
}).strict();

export const updateEmailProviderSchema = z.object({
  name: providerName.optional(),
  kind: providerKind.optional(),
  host: host.optional(),
  port: port.optional(),
  username: username.optional(),
  password: z.string().trim().max(EMAIL_LIMITS.providerPasswordMaxLength).optional(),
  encryption: z.enum(["ssl", "starttls", "none"]).optional(),
  fromEmail: optionalFromEmail,
  fromName: optionalFromName,
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
}).strict().refine(value => value.password === undefined || value.password.length > 0, "Password cannot be empty.").refine(value => Object.values(value).some(item => item !== undefined), "At least one provider field is required.");

export const testEmailProviderSchema = z.object({
  recipient: emailAddressSchema,
  subject: z.string().trim().min(EMAIL_LIMITS.subjectMinLength).max(EMAIL_LIMITS.subjectMaxLength),
  message: z.string().trim().min(EMAIL_LIMITS.messageMinLength).max(EMAIL_LIMITS.messageMaxLength),
}).strict();

const recipientsSchema = z.array(emailAddressSchema).min(1).max(EMAIL_LIMITS.recipientCountMax);
export const sendEmailSchema = z.object({
  providerId: z.uuid().optional(),
  templateId: z.uuid().optional(),
  messageType: z.enum(["transactional", "marketing"]).default("transactional"),
  contentFormat: z.enum(["plain", "html"]).default("html"),
  fromEmail: z.string().trim().max(EMAIL_LIMITS.providerFromEmailMaxLength).optional(),
  recipients: recipientsSchema,
  subject: z.string().trim().max(EMAIL_LIMITS.subjectMaxLength).optional(),
  message: z.string().trim().max(EMAIL_LIMITS.messageMaxLength).optional(),
  locale: z.enum(["fa", "en"]).default("fa"),
  variables: z.record(z.string(), z.string().max(EMAIL_LIMITS.variableValueMaxLength)).optional(),
  campaignName: z.string().trim().max(EMAIL_LIMITS.campaignNameMaxLength).optional(),
  idempotencyKey: z.string().trim().min(EMAIL_LIMITS.idempotencyKeyMinLength).max(EMAIL_LIMITS.idempotencyKeyMaxLength).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.templateId && !value.message) ctx.addIssue({ code: "custom", path: ["message"], message: "Provide a message or choose a template." });
  if (value.message !== undefined && value.message.trim().length === 0) ctx.addIssue({ code: "custom", path: ["message"], message: "Message cannot be empty." });
  if (!value.templateId && (!value.subject || value.subject.trim().length === 0)) ctx.addIssue({ code: "custom", path: ["subject"], message: "A subject is required for custom email." });
  const normalized = value.recipients.map(item => {
    const [local, domain] = item.trim().toLowerCase().split("@");
    return `${(local ?? "").replace(/\.(?=.*\.)/gu, "").replace(/\.$/u, "")}@${domain ?? ""}`;
  });
  if (new Set(normalized).size !== normalized.length) ctx.addIssue({ code: "custom", path: ["recipients"], message: "Duplicate recipients are not allowed." });
});

export const listEmailMessagesQuerySchema = z.object({
  page: pageSchema,
  perPage: pageSize(EMAIL_LIMITS.messageListPerPageMax, EMAIL_LIMITS.messageListPerPageDefault),
  search: search(EMAIL_LIMITS.messageListSearchMaxLength),
  status: z.enum(["all", ...EMAIL_STATUSES]).default("all"),
  providerId: z.uuid().optional(),
}).strict();

export const listEmailRecipientsQuerySchema = z.object({
  page: pageSchema,
  perPage: pageSize(EMAIL_LIMITS.recipientListPerPageMax, EMAIL_LIMITS.recipientListPerPageDefault),
  search: search(EMAIL_LIMITS.recipientSearchMaxLength),
}).strict();

const variableName = z.string().trim().min(EMAIL_LIMITS.pageMin).max(EMAIL_LIMITS.templateVariableMaxLength).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/);
const translation = z.object({
  name: z.string().trim().min(EMAIL_LIMITS.pageMin).max(EMAIL_LIMITS.templateNameMaxLength),
  subject: z.string().trim().min(EMAIL_LIMITS.subjectMinLength).max(EMAIL_LIMITS.subjectMaxLength),
  content: z.string().trim().min(EMAIL_LIMITS.messageMinLength).max(EMAIL_LIMITS.messageMaxLength),
}).strict();
const translations = z.object({ fa: translation, en: translation }).strict();
const templateFields = {
  key: z.string().trim().min(EMAIL_LIMITS.templateKeyMinLength).max(EMAIL_LIMITS.templateKeyMaxLength).regex(/^[a-z][a-z0-9_.-]*$/),
  externalTemplateId: z.string().trim().regex(/^\d+$/).max(64).optional(),
  messageType: z.enum(["transactional", "marketing"]).default("transactional"),
  contentFormat: z.enum(["plain", "html"]).default("html"),
  variables: z.array(variableName).max(EMAIL_LIMITS.templateVariableCountMax).default([]),
  translations,
  displayOrder: z.number().int().min(EMAIL_LIMITS.templateDisplayOrderMin).max(EMAIL_LIMITS.templateDisplayOrderMax).default(0),
  isActive: z.boolean().default(true),
};
function uniqueVariables(value: { variables?: string[] }, ctx: z.RefinementCtx) {
  if (value.variables && new Set(value.variables).size !== value.variables.length) ctx.addIssue({ code: "custom", path: ["variables"], message: "Template variables must be unique." });
}
export const createEmailTemplateSchema = z.object(templateFields).strict().superRefine(uniqueVariables);
export const updateEmailTemplateSchema = z.object(templateFields).omit({ key: true }).partial().strict().superRefine(uniqueVariables).refine(value => Object.values(value).some(item => item !== undefined), "At least one template field is required.");
export const listEmailTemplatesQuerySchema = z.object({
  page: pageSchema,
  perPage: pageSize(EMAIL_LIMITS.templateListPerPageMax, EMAIL_LIMITS.templateListPerPageDefault),
  search: search(EMAIL_LIMITS.templateSearchMaxLength),
  status: statusFilter,
}).strict();

export const listEmailOperations = {
  overview: ["GET", "/overview", z.object({}).strict()],
  providers: ["GET", "/providers", listEmailProvidersQuerySchema],
  providerCreate: ["POST", "/providers", createEmailProviderSchema],
  providerGet: ["GET", "/providers/:id", z.object({}).strict()],
  providerUpdate: ["PATCH", "/providers/:id", updateEmailProviderSchema],
  providerDelete: ["DELETE", "/providers/:id", z.object({}).strict()],
  providerTest: ["POST", "/providers/:id/test", testEmailProviderSchema],
  messages: ["GET", "/messages", listEmailMessagesQuerySchema],
  messageSend: ["POST", "/messages", sendEmailSchema],
  messageDelete: ["DELETE", "/messages/:id", z.object({}).strict()],
  recipients: ["GET", "/recipients", listEmailRecipientsQuerySchema],
  templates: ["GET", "/templates", listEmailTemplatesQuerySchema],
  templateCreate: ["POST", "/templates", createEmailTemplateSchema],
  templateGet: ["GET", "/templates/:id", z.object({}).strict()],
  templateUpdate: ["PATCH", "/templates/:id", updateEmailTemplateSchema],
  templateDelete: ["DELETE", "/templates/:id", z.object({}).strict()],
} as const;

export type EmailOperation = keyof typeof listEmailOperations;
export type CreateEmailProvider = z.infer<typeof createEmailProviderSchema>;
export type UpdateEmailProvider = z.infer<typeof updateEmailProviderSchema>;
export type SendEmailInput = z.infer<typeof sendEmailSchema>;
export type TestEmailInput = z.infer<typeof testEmailProviderSchema>;
export type EmailTemplateCreate = z.infer<typeof createEmailTemplateSchema>;
export type EmailTemplateUpdate = z.infer<typeof updateEmailTemplateSchema>;
export type EmailCommand = { operation: EmailOperation; id?: string; input: unknown };

function safePublicHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/u, "");
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  return !isIP(name) && name !== "localhost" && !name.endsWith(".localhost") && !name.endsWith(".local")
    && new RegExp(`^(?:${label}\\.)+${label}$`, "u").test(name);
}
function safeEmailProviderHost(kind: unknown, hostValue: unknown): boolean {
  if (typeof hostValue !== "string") return true;
  if (kind === "fake") return true;
  if (kind === "liara") {
    try {
      const parsed = new URL(hostValue);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
        && safePublicHostname(parsed.hostname) && (!parsed.port || parsed.port === "443");
    } catch { return false; }
  }
  try {
    const parsed = new URL(`https://${hostValue}`);
    return parsed.username === "" && parsed.password === "" && parsed.pathname === "/" && !parsed.search && !parsed.hash
      && !parsed.port && safePublicHostname(parsed.hostname);
  } catch { return false; }
}

export function validateEmailCommand(command: EmailCommand) {
  const descriptor = listEmailOperations[command.operation];
  if (!descriptor) throw new Error("INVALID_OPERATION");
  const [method, suffix, schema] = descriptor;
  const input = schema.parse(command.input) as Record<string, unknown>;
  const usesId = suffix.includes(":id");
  if (usesId) z.uuid().parse(command.id);
  if (command.operation === "providerCreate" && !safeEmailProviderHost(input.kind, input.host)) throw new Error("UNSAFE_HOST");
  if (command.operation === "providerUpdate" && input.host !== undefined && !safeEmailProviderHost(input.kind, input.host)) throw new Error("UNSAFE_HOST");
  if (Buffer.byteLength(JSON.stringify(input)) > EMAIL_LIMITS.requestBodyLimitBytes) throw new Error("BODY_TOO_LARGE");
  return { method, input, path: `/api/v1/admin/email${suffix.replace(":id", encodeURIComponent(command.id ?? ""))}` };
}
