import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { normalize } from "@/lib/text";
import { adminReadStatus, matchAdminReadRoute } from "./admin-read-intent";
import { isOtpLoginIntent } from "@/lib/auth/telegram-login";
import type { RuleRequestContext } from "@/lib/rules/types";
import {
  EmailAdminApi,
  type AdminEmailMessage,
  type AdminEmailProvider,
  type AdminEmailRecipient,
  type AdminEmailTemplate,
  type EmailResult,
} from "@/lib/email-admin/api";
import { EMAIL_HELP, EMAIL_PROVIDER_KINDS, EMAIL_STATUSES } from "@/lib/email-admin/constants";
import {
  createEmailProviderSchema,
  createEmailTemplateSchema,
  emailAddressSchema,
  listEmailOperations,
  sendEmailSchema,
  testEmailProviderSchema,
  updateEmailProviderSchema,
  updateEmailTemplateSchema,
  validateEmailCommand,
  type EmailCommand,
  type EmailOperation,
} from "@/lib/email-admin/validation";
import { emailPlanSchema, planEmailRequest, type EmailChoice, type EmailPlanner } from "@/lib/email-admin/planner";
import { jalaliDate } from "./format";

type Row = Record<string, unknown>;
type Resource = "providers" | "messages" | "recipients" | "templates";
type DraftKind = "providerCreate" | "providerUpdate" | "providerTest" | "templateCreate" | "templateUpdate" | "messageSend";
type Draft = { kind: DraftKind; step: string; values: Row; id?: string; templateId?: string };
type Snapshot = { resource: "provider" | "template" | "message"; row: Row; query?: Row };
type State = {
  actor: string;
  session: string;
  expires: number;
  rows: Record<Resource, Row[]>;
  queries: Partial<Record<Resource, Row>>;
  draft?: Draft;
  command?: EmailCommand;
  snapshot?: Snapshot;
  awaiting?: string;
};

const emailPattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/giu;
const yes = /^(?:بله|تایید|تأیید|yes|confirm)$/iu;
const cancel = /^(?:لغو|انصراف|cancel|\/cancel)$/iu;
const skip = /^(?:بدون|ندارد|رد شو|skip|none)$/iu;
const defaultChoice = /^(?:پیشفرض|پیش فرض|default|سرور)$/iu;
const providerFields = ["name", "kind", "host", "port", "username", "password", "encryption", "fromEmail", "fromName", "isActive", "isDefault"] as const;
const providerDefaults: Record<string, { host: string; port: number; encryption: "ssl" | "starttls" | "none" }> = {
  gmail: { host: "smtp.gmail.com", port: 465, encryption: "ssl" },
  outlook: { host: "smtp-mail.outlook.com", port: 587, encryption: "starttls" },
  yahoo: { host: "smtp.mail.yahoo.com", port: 465, encryption: "ssl" },
  liara: { host: "https://mail-service.liara.ir/api/v1/mails", port: 443, encryption: "ssl" },
  fake: { host: "smtp.fake.local", port: 465, encryption: "none" },
};
const providerFieldLabels: Record<string, string> = {
  name: "نام نمایشی", kind: "نوع: gmail، outlook، yahoo، custom، liara یا fake",
  host: "میزبان SMTP یا نشانی HTTPS لیارا (برای سرویس‌های معروف «پیش‌فرض» هم می‌توانی بفرستی)",
  port: "درگاه عددی ۱ تا ۶۵۵۳۵ (برای مقدار معمول بنویس «پیش‌فرض»)",
  username: "نام کاربری سرویس", password: "رمز/توکن سرویس؛ پیام این مرحله پس از دریافت حذف می‌شود",
  encryption: "رمزنگاری: ssl، starttls یا none (پیش‌فرض پیشنهادی قابل استفاده است)",
  fromEmail: "نشانی فرستنده، یا «بدون»", fromName: "نام فرستنده، یا «بدون»",
  isActive: "فعال باشد؟ بله/خیر؛ پیش‌فرض بله", isDefault: "سرویس پیش‌فرض شود؟ بله/خیر؛ انتخاب پیش‌فرض جدید، قبلی را کنار می‌زند",
};
const createSteps = [...providerFields];
const testSteps = ["recipient", "subject", "message"];
const sendSteps = ["recipients", "mode", "template", "locale", "variables", "subject", "message", "contentFormat", "messageType", "provider", "fromEmail", "campaignName"];

export function isEmailAdminRequest(text: string): boolean {
  const value = normalize(text);
  return /ایمیل|پست الکترونیکی|smtp|\bemail\b|\brecipients?\b|\bmail(?:box|ing|er)?\b|emailtemplate|\bfromemail\b|قالب.*(?:ایمیل|نامه)|(?:گزارش|فهرست|آمار|مدیریت|ارسال|تست).*ایمیل|ایمیل.*(?:گزارش|فهرست|آمار|مدیریت|ارسال|تست)/iu.test(value)
    || textHasEmail(text);
}
function deterministicEmailRead(text: string) {
  const activeStatus = (value: string) => adminReadStatus(value, [
    { value: "inactive", when: /\b(?:inactive|disabled)\b|غیرفعال/iu },
    { value: "active", when: /\b(?:active|enabled)\b|فعال/iu },
  ]);
  const messageStatus = (value: string) => adminReadStatus(value, [
    { value: "failed", when: /\b(?:failed|failure|unsuccessful)\b|ناموفق|شکست/iu },
    { value: "delivered", when: /\bdelivered\b|تحویل/iu },
    { value: "sending", when: /\bsending\b|در\s*حال\s*ارسال/iu },
    { value: "queued", when: /\bqueued\b|صف|منتظر/iu },
    { value: "sent", when: /\bsent\b|ارسال\s*شده/iu },
  ]);
  return matchAdminReadRoute(text, [
    { operation: "recipients" as const, when: /\b(?:recipients|contacts)\b|گیرنده(?:ها|های)|گیرندگان|مخاطبین/iu },
    { operation: "templates" as const, when: /\btemplates\b|قالب(?:ها|های)/iu,
      input: value => { const filter = activeStatus(value); return filter ? { status: filter } : {}; } },
    { operation: "providers" as const, when: /\b(?:providers|services|smtp)\b|سرویس(?:ها|های|دهندگان)|ارائه\s*دهندگان/iu,
      input: value => { const filter = activeStatus(value); return filter ? { status: filter } : {}; } },
    { operation: "messages" as const, when: /\bmessages\b|\b(?:logs|history)\b|پیام(?:ها|های)|گزارش\s+ارسال/iu,
      input: value => { const filter = messageStatus(value); return filter ? { status: filter } : {}; } },
    { operation: "messages" as const, when: /\b(?:failed|failure|unsuccessful|delivered|sending|queued|sent)\b|ناموفق|شکست|تحویل|در\s*حال\s*ارسال|صف/iu,
      input: value => { const filter = messageStatus(value); return filter ? { status: filter } : {}; } },
    { operation: "overview" as const, when: /\b(?:overview|stats?|statistics|summary|dashboard|reports?)\b|امار|گزارش/iu },
  ]);
}

export { EMAIL_HELP };

function parsedEmails(text: string): string[] {
  emailPattern.lastIndex = 0;
  return [...text.matchAll(emailPattern)].map(match => match[0]);
}
function textHasEmail(text: string): boolean { return parsedEmails(text).length > 0; }
function localSensitive(text: string): boolean {
  const configField = /(?:^|[\s,{])(?:password|pass|username|token|secret|host(?:name)?|server|port|encryption|from[_ -]?(?:email|name)|api[_ -]?url|endpoint|credential(?:s)?|رمز|گذرواژه|توکن|میزبان|درگاه|گیرنده|متن)\s*(?::|=|\bis\b|\bequals?\b)\s*["']?[^\s,;}'"]+/iu;
  const configAddress = /https?:\/\/\S+|(?:^|[^\p{L}\p{N}@])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:\/[^\s]*)?|(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?!\d)|\blocalhost\b/iu;
  return textHasEmail(text) || /[{}]/u.test(text) || configField.test(text) || configAddress.test(text);
}
function pretty(value: unknown): string { return JSON.stringify(value, null, 2) ?? ""; }
function safeCode(value: string): string { return /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : "UPSTREAM_REJECTED"; }
function digits(value: string): string { return normalize(value); }
function maskAddress(value: string): string {
  const at = value.lastIndexOf("@");
  if (at < 1) return "••••";
  const local = value.slice(0, at);
  return `${local.slice(0, Math.min(2, local.length))}•••${value.slice(at)}`;
}
function safeHostDisplay(value: string): string {
  const candidate = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(candidate)) {
    try {
      const url = new URL(candidate);
      return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : "/[مسیر پنهان]"}${url.search ? "?[پارامترها پنهان]" : ""}`;
    } catch { return "[میزبان پنهان]"; }
  }
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  return new RegExp(`^(?:${label}\\.)*${label}$`, "iu").test(candidate) ? candidate : "[میزبان پنهان]";
}
function safeError(result: Extract<EmailResult, { ok: false }>): string {
  const indeterminate = result.code === "REQUEST_FAILED";
  return `⚠️ درخواست ایمیل تأیید نشد.\n• کد: ${safeCode(result.code)}${result.status ? `\n• HTTP: ${result.status}` : ""}\n${indeterminate ? "نتیجهٔ شبکه ممکن است نامشخص باشد؛ پیش از هر تکرار، گزارش ارسال/وضعیت سرویس را بررسی کن. ربات خودکار تکرار نمی‌کند." : "محتوای خام خطای سرویس برای جلوگیری از افشای اطلاعات نمایش داده نمی‌شود."}`;
}

export function emailProviderCard(row: Row, index = 0): string {
  const health = row.healthStatus === "healthy" ? "سالم" : row.healthStatus === "unhealthy" ? "ناسالم" : "نامشخص";
  const host = typeof row.host === "string" ? safeHostDisplay(row.host) : "—";
  return `📨 ${index + 1}. ${String(row.name ?? "سرویس ایمیل")}\n• نوع: ${String(row.kind ?? "نامشخص")}\n• میزبان/درگاه: ${host}:${String(row.port ?? "—")} (${String(row.encryption ?? "—")})\n• فرستنده: ${String(row.fromEmail ?? "—")}${row.fromName ? ` · ${String(row.fromName)}` : ""}\n• وضعیت: ${row.isActive ? "فعال" : "غیرفعال"} · ${row.isDefault ? "پیش‌فرض" : "عادی"} · سلامت: ${health}\n• رمز ذخیره‌شده: ${row.passwordConfigured ? "بله؛ مقدار پنهان" : "خیر"}\n• شناسه: ${String(row.id ?? "—")}\n• آخرین تغییر: ${row.updatedAt ? jalaliDate(String(row.updatedAt)) : "نامشخص"}`;
}
export function emailMessageCard(row: Row, index = 0): string {
  return `✉️ ${index + 1}. ${String(row.status ?? "نامشخص")}\n• گیرنده: ${String(row.recipientMasked ?? "پنهان")}\n• سرویس: ${String(row.providerName ?? "—")}${row.providerKind ? ` (${String(row.providerKind)})` : ""}\n• ایجاد: ${jalaliDate(String(row.createdAt ?? ""))}${row.sentAt ? ` · ارسال: ${jalaliDate(String(row.sentAt))}` : ""}${row.deliveredAt ? ` · تحویل: ${jalaliDate(String(row.deliveredAt))}` : ""}\n• شناسهٔ گزارش: ${String(row.id ?? "—")}`;
}
export function emailTemplateCard(row: Row, index = 0, includeContent = false): string {
  const translations = (row.translations ?? {}) as Record<string, Row>;
  const fa = (translations.fa ?? {}) as Row;
  const en = (translations.en ?? {}) as Row;
  const head = `🧩 ${index + 1}. ${String(row.key ?? "قالب")}\n• نام فارسی: ${String(fa.name ?? "—")} · نام انگلیسی: ${String(en.name ?? "—")}\n• نوع/قالب: ${String(row.messageType ?? "—")} / ${String(row.contentFormat ?? "—")}\n• متغیرها: ${Array.isArray(row.variables) ? row.variables.join(", ") || "ندارد" : "—"}\n• وضعیت: ${row.isActive ? "فعال" : "غیرفعال"} · ترتیب: ${String(row.displayOrder ?? 0)}\n• شناسه: ${String(row.id ?? "—")}`;
  if (!includeContent) return head;
  return `${head}\n\n[FA]\nموضوع: ${String(fa.subject ?? "—")}\n${String(fa.content ?? "—")}\n\n[EN]\nSubject: ${String(en.subject ?? "—")}\n${String(en.content ?? "—")}`;
}
function recipientCard(row: Row, index = 0): string {
  return `👤 ${index + 1}. ${String(row.fullName ?? "نامشخص")}\n• ایمیل: ${String(row.email ?? "—")}\n• شناسهٔ کاربر: ${String(row.id ?? "—")}`;
}
function overviewCard(data: Row): string {
  const stats = data.stats as Row;
  const providers = (data.providers as Row[]).map((row, index) => `• ${index + 1}. ${String(row.name)} (${String(row.kind)}) — ${row.isActive ? "فعال" : "غیرفعال"}، سلامت: ${String(row.healthStatus)}${row.isDefault ? "، پیش‌فرض" : ""}`).join("\n");
  const recent = (data.recentMessages as Row[]).map(emailMessageCard).join("\n\n");
  return `**📨 گزارش ایمیل**\n\n• کل پیام‌ها: ${String(stats.total)}\n• پذیرفته/ارسال‌شده: ${String(stats.sent)}\n• تحویل‌شده: ${String(stats.delivered)}\n• ناموفق: ${String(stats.failed)}\n• نرخ تحویل ثبت‌شده: ${String(stats.deliveryRate)}٪\n• سرویس فعال: ${String(data.activeProviderCount)} از ${String(data.providerCount)}\n• قالب فعال: ${String(data.activeTemplateCount)} از ${String(data.templateCount)}\n\n**سرویس‌ها**\n${providers || "موردی نیست."}\n\n**آخرین گزارش‌ها**\n${recent || "موردی نیست."}`;
}
function providerPreview(input: Row): Row {
  const safe: Row = { ...input };
  if (safe.password !== undefined) safe.password = "[محرمانه؛ مقدار پنهان]";
  if (safe.username !== undefined) safe.username = "[محرمانه؛ مقدار پنهان]";
  if (typeof safe.host === "string") safe.host = safeHostDisplay(safe.host);
  if (typeof safe.fromEmail === "string" && safe.fromEmail) safe.fromEmail = maskAddress(safe.fromEmail);
  return safe;
}
function extractTemplatePreview(content: string, values: Record<string, string>): string {
  return content.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`MISSING:${key}`);
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
  });
}

export class TelegramEmailAdmin {
  private states = new Map<string, State>();
  constructor(private api = new EmailAdminApi(), private planner: EmailPlanner = planEmailRequest, private now = Date.now) {}
  clear(owner: string) { this.states.delete(owner); }
  isCollecting(owner: string) { const state = this.states.get(owner); return Boolean(state?.draft && state.expires > this.now()); }
  private signature(context: RuleRequestContext) { return createHash("sha256").update(context.sessionCookie).digest("hex"); }

  async handle(owner: string, text: string, context: RuleRequestContext | null, privateChat: boolean): Promise<{ reply: string; status: string; deleteSensitiveMessage?: boolean } | null> {
    const previous = this.states.get(owner);
    const expired = Boolean(previous && previous.expires <= this.now());
    for (const [key, item] of this.states) if (item.expires <= this.now()) this.states.delete(key);
    let state = this.states.get(owner);
    const value = normalize(text);
    const explicit = isEmailAdminRequest(text);
    if (!state?.draft && (isOtpLoginIntent(text) || /^\/(?:clear|reset|new)\b/iu.test(text))) { this.clear(owner); return null; }
    const follows = Boolean(state && (state.command || state.draft || state.awaiting || /اول|دوم|سوم|چهارم|صفحه|بعدی|حذف|ویرایش|تغییر|ارسال|تست|لغو|انتخاب|next|delete|edit|send/iu.test(value)));
    if (!explicit && !follows && !(expired && yes.test(value))) return null;
    const sensitive = Boolean(state?.draft) || expired && Boolean(previous?.draft) || localSensitive(text);
    const reply = (message: string, status = "email-pending", deleteValue = sensitive) => ({ reply: message, status, ...(deleteValue ? { deleteSensitiveMessage: true } : {}) });
    if (!privateChat) return reply("🔐 مدیریت ایمیل فقط در گفت‌وگوی خصوصی مجاز است؛ نشانی‌ها، متن‌ها و اطلاعات سرویس را در گروه نفرست.", "email-private-only");
    if (!context?.actorId.trim() || !context.sessionCookie.trim()) { this.clear(owner); return reply("🔐 ابتدا در گفت‌وگوی خصوصی وارد حساب مجاز شو؛ هیچ درخواست ایمیلی ارسال نشد.", "email-auth-required"); }
    if (expired && !explicit) { this.clear(owner); return reply("⏳ درخواست ایمیل منقضی شد؛ از ابتدا شروع کن.", "email-expired"); }
    if (state && (state.actor !== context.actorId || state.session !== this.signature(context))) { this.clear(owner); return reply("🔐 نشست تغییر کرده؛ درخواست ایمیل را از ابتدا شروع کن.", "email-session-changed"); }
    if (cancel.test(value)) { this.clear(owner); return reply("↩️ درخواست ایمیل لغو شد؛ چیزی ارسال یا تغییر نکرد.", "email-cancelled"); }
    if (!state) {
      if (this.states.size >= 200) return reply("⏳ درخواست‌های زیادی در انتظارند؛ بعداً تلاش کن.", "email-busy");
      state = { actor: context.actorId, session: this.signature(context), expires: this.now() + 300_000, rows: { providers: [], messages: [], recipients: [], templates: [] }, queries: {} };
      this.states.set(owner, state);
    }
    if (state.command) {
      if (!yes.test(value)) return reply("🔎 درخواست قبلی هنوز اجرا نشده؛ برای اجرا دقیقاً «تأیید» بفرست یا «لغو» کن.");
      const command = state.command;
      const snapshot = state.snapshot;
      // Consume approval synchronously before awaiting the network; replayed confirmations cannot repeat a send.
      state.command = undefined;
      state.snapshot = undefined;
      if (snapshot) {
        const latest = await this.readSnapshot(snapshot, context);
        if (!latest || !this.sameSnapshot(snapshot, latest)) return reply("⚠️ ردیف تغییر کرده، حذف شده یا بازخوانی نشد؛ عملیات لغو شد. دوباره فهرست را بررسی کن.", "email-conflict");
      }
      return this.run(command, state, context);
    }
    if (state.draft) return this.collectDraft(state, text, value, context, reply);

    const extracted = parsedEmails(text);
    if (extracted.length) {
      if (this.isSendIntent(value)) {
        state.draft = { kind: "messageSend", step: "mode", values: { recipients: extracted } };
        return reply(`گیرنده‌ها به‌صورت محلی دریافت شدند (${extracted.length}).\n\nقالب آماده می‌خواهی یا متن دلخواه؟ بنویس «قالب» یا «متن».\n\n⏳ اعتبار ۵ دقیقه؛ اطلاعات به مدل یا تاریخچه فرستاده نشده است.`, "email-send-draft", true);
      }
      if (/(?:پیام|ارسال|گزارش|تراکنش|mail|message|sent)/iu.test(value) && /(?:گزارش|فهرست|جستجو|پیدا|نمایش|وضعیت|پیام|history|list|show|search)/iu.test(value)) {
        return this.run({ operation: "messages", input: { page: 1, perPage: 20, status: "all", search: extracted[0] } }, state, context).then(result => ({ ...result, deleteSensitiveMessage: true }));
      }
      if (/(?:گیرنده|مخاطب|کاربر|recipient|contact)/iu.test(value)) {
        return this.run({ operation: "recipients", input: { page: 1, perPage: 10, search: extracted[0] } }, state, context).then(result => ({ ...result, deleteSensitiveMessage: true }));
      }
      return reply("🔐 نشانی ایمیل در پیام آزاد استفاده نمی‌شود. برای ارسال بنویس «ایمیل بفرست»؛ نشانی و متن در فرم خصوصی دریافت می‌شوند. برای جست‌وجو بگو «گزارش پیام برای این نشانی را پیدا کن». پیام حذف می‌شود و نشانی وارد مدل نمی‌شود.", "email-private-input", true);
    }

    if (this.isSendIntent(value)) {
      state.draft = { kind: "messageSend", step: "recipients", values: {} };
      return reply(this.draftPrompt(state.draft), "email-send-draft", true);
    }
    if (localSensitive(text) && !state.draft) return reply("🔐 اطلاعات ایمیل را مستقیم در درخواست آزاد نفرست. ابتدا عملیات را بخواه تا نشانی، متن یا اطلاعات سرویس در فرم محلی دریافت شود؛ مقدار به مدل سپرده نمی‌شود.", "email-local-input-required", true);
    if (/راهنما|راهنمای ایمیل|help/iu.test(value)) return reply(EMAIL_HELP, "email-help", false);
    const directRead = deterministicEmailRead(text);
    if (directRead) {
      state.awaiting = undefined;
      return this.run({ operation: directRead.operation, input: directRead.input }, state, context);
    }
    if (state.awaiting) {
      const prior = state.awaiting;
      state.awaiting = undefined;
      text = `${prior}\nانتخاب: ${text}`;
    }

    let plan;
    try {
      const query = this.safePlannerQuery(state);
      plan = emailPlanSchema.parse(await this.planner(text, this.choices(state), query));
    } catch { return reply("⚠️ خواستهٔ ایمیل را دقیق‌تر بگو؛ مثلاً «گزارش ایمیل»، «فهرست گیرنده‌ها» یا «قالب‌ها را نشان بده».", "email-clarify", false); }
    if (plan.operation === "help") return reply(EMAIL_HELP, "email-help", false);
    if (plan.operation === "clarify") { state.awaiting = text; return reply("🔎 مشخص کن منظورت سرویس، گزارش ارسال، گیرنده یا قالب ایمیل است.", "email-clarify", false); }
    if (plan.operation === "messageSend") {
      state.draft = { kind: "messageSend", step: "recipients", values: {} };
      return reply(this.draftPrompt(state.draft), "email-send-draft", false);
    }
    if (plan.operation === "providerCreate" || plan.operation === "templateCreate") {
      const kind = plan.operation;
      state.draft = { kind, step: "0", values: {} };
      return reply(this.draftPrompt(state.draft), "email-draft", false);
    }

    try {
      let input = plan.input;
      const listOperation = ["providers", "messages", "recipients", "templates"].includes(plan.operation);
      if (listOperation && typeof plan.input.search === "string" && plan.input.search && !normalize(text).includes(normalize(plan.input.search))) {
        return reply("🔎 عبارت جست‌وجو را دقیقاً در پیام خود بنویس؛ مقدار جست‌وجو را حدس نمی‌زنم.", "email-clarify", false);
      }
      if (["providers", "messages", "recipients", "templates"].includes(plan.operation) && plan.input.page !== undefined) {
        const resource = plan.operation as Resource;
        const priorQuery = state.queries[resource] ?? {};
        input = { ...priorQuery, ...plan.input };
      }
      let command: EmailCommand;
      let id = plan.id;
      const resource = this.resourceFor(plan.operation);
      if (plan.target && !normalize(text).includes(normalize(plan.target))) return reply("🔎 نام جست‌وجو را دقیقاً در درخواستت بنویس؛ موردی را حدس نمی‌زنم.", "email-clarify", false);
      if (resource && plan.target && !id) {
        const target = normalize(plan.target);
        const existing = state.rows[resource].filter(row => this.matchesTarget(resource, row, target));
        if (existing.length === 1) id = String(existing[0]!.id);
        else if ((resource === "providers" || resource === "templates") && existing.length === 0) {
          const searchOperation = resource;
          const searchResult = await this.api.execute({ operation: searchOperation, input: resource === "providers" ? { page: 1, perPage: 50, search: plan.target, status: "all" } : { page: 1, perPage: 50, search: plan.target, status: "all" } }, context);
          if (!searchResult.ok) return reply(safeError(searchResult), "email-error", false);
          const rows = searchResult.data.items as Row[];
          state.rows[resource] = rows;
          const exact = rows.filter(row => this.matchesTarget(resource, row, target));
          if (exact.length === 1) id = String(exact[0]!.id);
          else { state.awaiting = text; return reply(`${exact.length ? "🔎 چند مورد پیدا شد؛ شماره را مشخص کن." : "📭 مورد یکتایی پیدا نشد؛ جست‌وجو را دقیق‌تر بگو."}\n\n${rows.map((row, index) => resource === "providers" ? emailProviderCard(row, index) : emailTemplateCard(row, index)).join("\n\n") || "موردی نیست."}`, "email-clarify", false); }
        } else if (existing.length > 1) { state.awaiting = text; return reply(`🔎 چند ردیف با این نام هست؛ شناسه یا شماره را از فهرست بگو.\n\n${existing.map((row, index) => resource === "providers" ? emailProviderCard(row, index) : resource === "templates" ? emailTemplateCard(row, index) : emailMessageCard(row, index)).join("\n\n")}`, "email-clarify", false); }
      }
      if (resource && id) {
        const found = state.rows[resource].some(row => row.id === id);
        if (!found && !text.includes(id)) return reply("🔎 شناسه را حدس نمی‌زنم؛ ابتدا فهرست مربوطه را بخواه یا شناسهٔ دقیق را بفرست.", "email-invalid", false);
        if (plan.operation === "messageDelete" && !found) return reply("🔎 حذف گزارش فقط برای ردیفی ممکن است که در فهرست پیام‌ها دیده‌ای؛ ابتدا گزارش را بخواه.", "email-invalid", false);
      }
      if (["providerGet", "providerUpdate", "providerDelete", "providerTest"].includes(plan.operation) && !id) {
        state.awaiting = text;
        return reply("🔎 کدام سرویس ایمیل؟ شماره یا شناسهٔ آن را از فهرست مشخص کن.", "email-clarify", false);
      }
      if (["templateGet", "templateUpdate", "templateDelete"].includes(plan.operation) && !id) {
        state.awaiting = text;
        return reply("🔎 کدام قالب ایمیل؟ شماره یا شناسهٔ آن را از فهرست قالب‌ها مشخص کن.", "email-clarify", false);
      }
      if (plan.operation === "messageDelete" && !id) {
        state.awaiting = text;
        return reply("🔎 کدام گزارش پیام را حذف کنم؟ ابتدا گزارش ارسال را فهرست کن و شمارهٔ ردیف را بگو.", "email-clarify", false);
      }
      command = { operation: plan.operation as EmailOperation, ...(id ? { id } : {}), input };
      if (["providerUpdate", "providerTest", "templateUpdate"].includes(plan.operation)) command.input = {};
      else command.input = validateEmailCommand(command).input;
      if (["overview", "providers", "messages", "recipients", "templates"].includes(plan.operation)) return this.run(command, state, context);
      if (["providerGet", "providerUpdate", "providerDelete", "providerTest"].includes(plan.operation)) {
        if (!id) { state.awaiting = text; return reply("🔎 کدام سرویس ایمیل؟ شماره یا شناسه را از فهرست سرویس‌ها مشخص کن.", "email-clarify", false); }
        const current = await this.api.execute({ operation: "providerGet", id, input: {} }, context);
        if (!current.ok) return reply(safeError(current), "email-error", false);
        const row = current.data as Row;
        state.rows.providers = [row];
        if (plan.operation === "providerGet") return reply(emailProviderCard(row), "email-read", false);
        if (plan.operation === "providerUpdate") { state.snapshot = { resource: "provider", row }; state.draft = { kind: "providerUpdate", id, step: "patch", values: {} }; return reply(this.draftPrompt(state.draft), "email-draft", false); }
        if (plan.operation === "providerTest") { state.snapshot = { resource: "provider", row }; state.draft = { kind: "providerTest", id, step: "recipient", values: {} }; return reply(this.draftPrompt(state.draft), "email-draft", false); }
        return this.propose({ operation: "providerDelete", id, input: {} }, state, { resource: "provider", row });
      }
      if (["templateGet", "templateUpdate", "templateDelete"].includes(plan.operation)) {
        if (!id) { state.awaiting = text; return reply("🔎 کدام قالب ایمیل؟ شماره یا شناسه را از فهرست قالب‌ها مشخص کن.", "email-clarify", false); }
        const current = await this.api.execute({ operation: "templateGet", id, input: {} }, context);
        if (!current.ok) return reply(safeError(current), "email-error", false);
        const row = current.data as Row;
        state.rows.templates = [row];
        if (plan.operation === "templateGet") return reply(emailTemplateCard(row, 0, true), "email-read", false);
        if (plan.operation === "templateUpdate") { state.snapshot = { resource: "template", row }; state.draft = { kind: "templateUpdate", id, step: "json", values: {} }; return reply(this.draftPrompt(state.draft), "email-draft", false); }
        return this.propose({ operation: "templateDelete", id, input: {} }, state, { resource: "template", row });
      }
      if (plan.operation === "messageDelete") {
        if (!id) { state.awaiting = text; return reply("🔎 کدام گزارش پیام را حذف کنم؟ ابتدا گزارش ارسال را فهرست کن و شمارهٔ ردیف را بگو.", "email-clarify", false); }
        const row = state.rows.messages.find(item => item.id === id);
        if (!row) return reply("🔎 این API مشاهدهٔ تکی گزارش ندارد؛ فقط ردیفی را حذف می‌کنم که در فهرست پیام‌ها دیده شده باشد.", "email-invalid", false);
        return this.propose({ operation: "messageDelete", id, input: {} }, state, { resource: "message", row, query: state.queries.messages ?? {} });
      }
      return reply("🔎 این عملیات در API ایمیل موجود نیست؛ «راهنمای ایمیل» را بخواه.", "email-unsupported", false);
    } catch {
      return reply("⚠️ اطلاعات درخواست معتبر نبود. هیچ ایمیلی ارسال یا داده‌ای تغییر نکرد؛ فهرست/فرم را دوباره بررسی کن.", "email-invalid", false);
    }
  }

  private isSendIntent(value: string): boolean {
    return /(?:ایمیل|نامه).{0,40}(?:بفرست|ارسال\s+کن)|(?:بفرست|ارسال\s+کن).{0,40}(?:ایمیل|نامه)|\bsend\b.{0,40}\bemail\b|\bemail\b.{0,40}\bsend\b/iu.test(value);
  }
  private resourceFor(operation: string): Resource | null {
    if (operation.startsWith("provider")) return "providers";
    if (operation.startsWith("template")) return "templates";
    if (operation.startsWith("message")) return "messages";
    if (operation === "recipients") return "recipients";
    return null;
  }
  private matchesTarget(resource: Resource, row: Row, target: string): boolean {
    const fields = resource === "providers" ? [row.name, row.kind]
      : resource === "templates" ? [row.key, (row.translations as Row | undefined)?.fa && ((row.translations as Row).fa as Row).name, (row.translations as Row | undefined)?.en && ((row.translations as Row).en as Row).name]
        : resource === "messages" ? [row.id, row.recipientMasked, row.status]
          : [row.fullName, row.email];
    return fields.some(field => typeof field === "string" && normalize(field) === target);
  }
  private choices(state: State): EmailChoice[] {
    const result: EmailChoice[] = [];
    for (const [index, row] of state.rows.providers.entries()) result.push({ id: String(row.id), title: `${index + 1}. ${String(row.name)} (${String(row.kind)})`, resource: "providers" });
    for (const [index, row] of state.rows.templates.entries()) result.push({ id: String(row.id), title: `${index + 1}. ${String(row.key)}`, resource: "templates" });
    for (const [index, row] of state.rows.messages.entries()) result.push({ id: String(row.id), title: `${index + 1}. ${String(row.status)} (${String(row.recipientMasked)})`, resource: "messages" });
    for (const [index, row] of state.rows.recipients.entries()) result.push({ id: String(row.id), title: `Recipient ${index + 1}`, resource: "recipients" });
    return result;
  }
  private safePlannerQuery(state: State): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [resource, query] of Object.entries(state.queries)) {
      if (!query) continue;
      const { search: _privateSearch, ...safeFilters } = query;
      output[resource] = { ...safeFilters, ...(typeof _privateSearch === "string" && _privateSearch ? { searchPresent: true } : {}) };
    }
    return output;
  }

  private draftPrompt(draft: Draft): string {
    if (draft.kind === "providerCreate") {
      const field = createSteps[Number(draft.step)]!;
      const hint = field === "host" && draft.values.kind && providerDefaults[String(draft.values.kind)] ? `\nمقدار معمول این نوع: ${providerDefaults[String(draft.values.kind)]!.host}` : "";
      return `**📨 ساخت سرویس ایمیل — مرحله ${Number(draft.step) + 1} از ${createSteps.length}**\n\n${providerFieldLabels[field]}${hint}\n\n🔐 این پیام در مدل یا تاریخچه قرار نمی‌گیرد و پس از دریافت حذف می‌شود. برای مقادیر اختیاری «بدون» بنویس؛ لغو: «لغو». اعتبار: ۵ دقیقه.`;
    }
    if (draft.kind === "providerUpdate") return `**📨 ویرایش سرویس ایمیل**\n\nفقط patch دقیق را در JSON بفرست؛ فیلدهای مجاز: name, kind, host, port, username, password, encryption, fromEmail, fromName, isActive, isDefault. رمز و نام‌کاربری در پیش‌نمایش پنهان می‌شوند. برای حذف نشانی/نام فرستنده، رشتهٔ خالی بفرست. پیام حذف می‌شود؛ تا «تأیید» چیزی تغییر نمی‌کند.\n\nلغو: «لغو». اعتبار: ۵ دقیقه.`;
    if (draft.kind === "providerTest") {
      const stepIndex = testSteps.indexOf(draft.step);
      const field = testSteps[stepIndex]!;
      const prompt = field === "recipient" ? "نشانی ایمیلی را وارد کن که اجازهٔ دریافت پیام آزمایشی دارد."
        : field === "subject" ? "موضوع دقیق ایمیل آزمایشی را بفرست."
          : "متن دقیق ایمیل آزمایشی را بفرست.";
      return `**📨 تست سرویس ایمیل — مرحله ${stepIndex + 1} از ${testSteps.length}**\n\n${prompt}\n\n⚠️ تست، ایمیل واقعی برای گیرنده می‌فرستد و نتیجهٔ سلامت را ثبت می‌کند. هر ورودی حذف می‌شود و تا تأیید نهایی ارسال نمی‌شود. لغو: «لغو».`;
    }
    if (draft.kind === "templateCreate") return `**🧩 ساخت قالب ایمیل**\n\nJSON کامل را محلی بفرست؛ نمونه:\n{"key":"booking.confirmed","messageType":"transactional","contentFormat":"html","variables":["name"],"translations":{"fa":{"name":"تأیید رزرو","subject":"رزرو {{name}}","content":"<p>سلام {{name}}</p>"},"en":{"name":"Booking confirmed","subject":"Booking {{name}}","content":"<p>Hello {{name}}</p>"}}}\n\nفیلدهای اختیاری: externalTemplateId, displayOrder, isActive. محتوای قالب وارد مدل/تاریخچه نمی‌شود؛ پیام حذف می‌شود و پیش از ذخیره نمایش داده خواهد شد. لغو: «لغو».`;
    if (draft.kind === "templateUpdate") return `**🧩 ویرایش قالب ایمیل**\n\nPatch دقیق JSON را بفرست. فیلدهای مجاز: externalTemplateId, messageType, contentFormat, variables, translations (هر دو fa و en کامل), displayOrder, isActive. کلید قالب قابل تغییر نیست. متن‌ها محلی دریافت، پیام حذف و پیش از تأیید نمایش داده می‌شوند. شناسهٔ خارجی فقط طبق محدودیت API قابل تغییر است. لغو: «لغو».`;
    const step = draft.step;
    const prompts: Record<string, string> = {
      recipients: "گیرنده‌ها را با کاما یا هر کدام در یک خط بفرست؛ یا شماره‌های فهرست «گیرنده‌ها» را جدا کن. حداکثر ۱۰۰۰ نشانی؛ تکراری‌ها پذیرفته نیستند.",
      mode: "از قالب فعال استفاده می‌کنی یا متن دلخواه؟ بنویس «قالب» یا «متن».",
      template: "شماره یا شناسهٔ قالب فعال را از فهرست بالا انتخاب کن.",
      locale: "زبان قالب را بنویس: fa یا en.",
      variables: 'مقادیر قالب را در JSON بفرست، مثلاً {"name":"سارا"}؛ اگر متغیری ندارد بنویس «بدون».',
      subject: "موضوع دقیق ایمیل را بفرست.",
      message: "متن دقیق ایمیل را بفرست.",
      contentFormat: "قالب محتوا: html یا plain؛ برای مقدار پیش‌فرض بنویس «پیش‌فرض» (html).",
      messageType: "نوع ارسال: transactional یا marketing؛ پیش‌فرض transactional است.",
      provider: "شناسهٔ UUID سرویس فعال را بفرست، یا «پیش‌فرض» تا سرور سرویس پیش‌فرض را انتخاب کند.",
      fromEmail: "نشانی فرستندهٔ جایگزین را بفرست، یا «بدون» برای استفاده از تنظیم سرویس.",
      campaignName: "نام این ارسال/کمپین را بفرست یا «بدون».",
    };
    return `**✉️ آماده‌سازی ارسال ایمیل**\n\nمرحلهٔ ${sendSteps.indexOf(step) + 1}: ${prompts[step] ?? prompts.recipients}\n\n🔐 نشانی‌ها و محتوا به مدل یا تاریخچه فرستاده نمی‌شوند و پیام هر مرحله حذف می‌شود. ارسال واقعی فقط پس از نمایش پیش‌نمایش کامل و تأیید تو انجام می‌شود. لغو: «لغو». اعتبار: ۵ دقیقه.`;
  }

  private async collectDraft(state: State, text: string, value: string, context: RuleRequestContext, reply: (message: string, status?: string, deleteValue?: boolean) => { reply: string; status: string; deleteSensitiveMessage?: boolean }) {
    const draft = state.draft!;
    try {
      if (draft.kind === "providerCreate") return this.collectProviderCreate(state, draft, text, value, reply);
      if (draft.kind === "providerUpdate") {
        const patch = JSON.parse(text) as unknown;
        const input = updateEmailProviderSchema.parse(patch) as Row;
        const command: EmailCommand = { operation: "providerUpdate", id: draft.id, input };
        validateEmailCommand(command);
        state.draft = undefined;
        return { ...this.propose(command, state, state.snapshot), deleteSensitiveMessage: true };
      }
      if (draft.kind === "providerTest") return this.collectProviderTest(state, draft, text, value, reply);
      if (draft.kind === "templateCreate") {
        const input = createEmailTemplateSchema.parse(JSON.parse(text)) as Row;
        const command: EmailCommand = { operation: "templateCreate", input };
        validateEmailCommand(command);
        state.draft = undefined;
        return { ...this.propose(command, state), deleteSensitiveMessage: true };
      }
      if (draft.kind === "templateUpdate") {
        const input = updateEmailTemplateSchema.parse(JSON.parse(text)) as Row;
        const command: EmailCommand = { operation: "templateUpdate", id: draft.id, input };
        validateEmailCommand(command);
        state.draft = undefined;
        return { ...this.propose(command, state, state.snapshot), deleteSensitiveMessage: true };
      }
      return this.collectSend(state, draft, text, value, context, reply);
    } catch (error) {
      const message = error instanceof Error && error.message.startsWith("MISSING:") ? `قالب به متغیر «${error.message.slice(8)}» نیاز دارد؛ مقدارش را اضافه کن.`
        : draft.kind === "providerCreate" ? `⚠️ مقدار این مرحله معتبر نیست (${String(draft.step)}). ${this.draftPrompt(draft)}`
          : draft.kind === "providerTest" ? `⚠️ مقدار معتبر نیست. ${this.draftPrompt(draft)}`
            : draft.kind === "messageSend" ? `⚠️ مقدار معتبر نیست یا از محدودیت API خارج است. ${this.draftPrompt(draft)}`
              : "⚠️ JSON یا مقدار معتبر مطابق فیلدهای مجاز لازم است. دوباره بفرست یا «لغو» کن.";
      return reply(message, "email-invalid", true);
    }
  }

  private collectProviderCreate(state: State, draft: Draft, text: string, value: string, reply: (message: string, status?: string, deleteValue?: boolean) => { reply: string; status: string; deleteSensitiveMessage?: boolean }) {
    const field = createSteps[Number(draft.step)]!;
    let item: unknown = text.trim();
    const skipField = skip.test(value);
    if (["fromEmail", "fromName"].includes(field) && skipField) item = undefined;
    if (["isActive", "isDefault"].includes(field)) {
      if (defaultChoice.test(value)) item = field === "isActive";
      else if (/^(?:بله|فعال|yes|true)$/iu.test(value)) item = true;
      else if (/^(?:خیر|نه|غیرفعال|no|false)$/iu.test(value)) item = false;
      else throw new Error("BOOLEAN");
    }
    if (field === "kind") item = String(item).trim().toLowerCase();
    if (["host", "port", "encryption"].includes(field) && defaultChoice.test(value)) {
      const config = providerDefaults[String(draft.values.kind)];
      if (!config) throw new Error("CUSTOM_NEEDS_EXPLICIT_HOST");
      item = field === "host" ? config.host : field === "port" ? config.port : config.encryption;
    }
    if (field === "port" && item !== undefined) item = Number(normalize(String(item)).replace(/\D/gu, ""));
    if (field === "encryption") item = String(item).toLowerCase();
    if (field === "fromEmail" && item !== undefined && item !== "") item = emailAddressSchema.parse(item);
    if (field === "name") item = z.string().trim().min(2).max(80).parse(item);
    if (field === "kind") item = z.enum(EMAIL_PROVIDER_KINDS).parse(item);
    if (field === "host") item = z.string().trim().min(1).max(255).parse(item);
    if (field === "port") item = z.coerce.number().int().min(1).max(65_535).parse(item);
    if (field === "username") item = z.string().trim().min(1).max(256).parse(item);
    if (field === "password") item = z.string().trim().min(1).max(512).parse(item);
    if (field === "encryption") item = z.enum(["ssl", "starttls", "none"]).parse(item);
    if (field === "fromName" && item !== undefined) item = z.string().trim().max(120).parse(item);
    if (field === "fromEmail" && item !== undefined) item = z.string().trim().max(254).parse(item);
    if (item !== undefined) draft.values[field] = item;
    else delete draft.values[field];
    draft.step = String(Number(draft.step) + 1);
    if (Number(draft.step) < createSteps.length) return reply(this.draftPrompt(draft), "email-draft", true);
    const input = createEmailProviderSchema.parse(draft.values) as Row;
    const command: EmailCommand = { operation: "providerCreate", input };
    validateEmailCommand(command);
    state.draft = undefined;
    return { ...this.propose(command, state), deleteSensitiveMessage: true };
  }

  private collectProviderTest(state: State, draft: Draft, text: string, _value: string, reply: (message: string, status?: string, deleteValue?: boolean) => { reply: string; status: string; deleteSensitiveMessage?: boolean }) {
    const index = testSteps.indexOf(draft.step);
    const field = testSteps[index]!;
    const parsed = field === "recipient" ? emailAddressSchema.parse(text) : field === "subject" ? z.string().trim().min(1).max(998).parse(text) : z.string().trim().min(1).max(102_400).parse(text);
    draft.values[field] = parsed;
    draft.step = testSteps[index + 1] ?? "done";
    if (draft.step !== "done") return reply(this.draftPrompt(draft), "email-draft", true);
    const input = testEmailProviderSchema.parse(draft.values) as Row;
    const command: EmailCommand = { operation: "providerTest", id: draft.id, input };
    validateEmailCommand(command);
    state.draft = undefined;
    return { ...this.propose(command, state, state.snapshot), deleteSensitiveMessage: true };
  }

  private async collectSend(state: State, draft: Draft, text: string, value: string, context: RuleRequestContext, reply: (message: string, status?: string, deleteValue?: boolean) => { reply: string; status: string; deleteSensitiveMessage?: boolean }) {
    let step = draft.step;
    const values = draft.values;
    if (step === "recipients") {
      const available = state.rows.recipients;
      const normalized = digits(text.trim());
      if (/^(?:همه|همهٔ فهرست|all shown)$/iu.test(normalized)) {
        if (!available.length) throw new Error("LIST_RECIPIENTS_FIRST");
        values.recipients = available.map(row => String(row.email));
      } else if (/^[\d\s,،;]+$/u.test(normalized) && /\d/u.test(normalized)) {
        const indexes = normalized.split(/[\s,،;]+/u).filter(Boolean).map(Number);
        if (!available.length || indexes.some(index => index < 1 || index > available.length)) throw new Error("LIST_RECIPIENTS_FIRST");
        values.recipients = [...new Set(indexes)].map(index => String(available[index - 1]!.email));
      } else {
        const items = text.split(/[\s,،;]+/u).filter(Boolean);
        values.recipients = items.map(item => emailAddressSchema.parse(item));
      }
      const chosenRecipients = values.recipients as string[];
      if (new Set(chosenRecipients.map(item => item.toLowerCase())).size !== chosenRecipients.length) throw new Error("DUPLICATE_RECIPIENTS");
      draft.step = "mode";
      return reply(`✅ ${chosenRecipients.length} گیرنده دریافت شد.\n\n${this.draftPrompt(draft)}`, "email-draft", true);
    }
    if (step === "mode") {
      if (/قالب|template/iu.test(value)) {
        const result = await this.api.execute({ operation: "templates", input: { page: 1, perPage: 50, status: "active" } }, context);
        if (!result.ok) return reply(safeError(result), "email-error", true);
        const templates = result.data.items as Row[];
        state.rows.templates = templates;
        if (!templates.length) throw new Error("NO_ACTIVE_TEMPLATES");
        draft.step = "template";
        return reply(`قالب‌های فعال:\n\n${templates.map((row, index) => emailTemplateCard(row, index)).join("\n\n")}\n\n${this.draftPrompt(draft)}`, "email-draft", true);
      }
      if (/متن|دلخواه|custom|پیام/iu.test(value)) { draft.step = "subject"; return reply(this.draftPrompt(draft), "email-draft", true); }
      throw new Error("CHOOSE_TEMPLATE_OR_CUSTOM");
    }
    if (step === "template") {
      const template = this.selectTemplate(text, state.rows.templates);
      if (!template) throw new Error("TEMPLATE_NOT_IN_LIST");
      draft.templateId = String(template.id);
      values.templateId = String(template.id);
      values.messageType = template.messageType;
      values.contentFormat = template.contentFormat;
      draft.step = "locale";
      return reply(this.draftPrompt(draft), "email-draft", true);
    }
    if (step === "locale") {
      const locale = value.toLowerCase();
      if (locale !== "fa" && locale !== "en") throw new Error("LOCALE");
      values.locale = locale;
      if (draft.kind === "messageSend" && draft.templateId) {
        const template = state.rows.templates.find(row => row.id === draft.templateId);
        if (!template || !(template.translations as Row)[locale]) throw new Error("TEMPLATE_LOCALE");
        draft.step = "variables";
      } else {
        draft.step = "provider";
      }
      return reply(this.draftPrompt(draft), "email-draft", true);
    }
    if (step === "variables") {
      const variables = skip.test(value) ? {} : JSON.parse(text) as unknown;
      const parsed = z.record(z.string(), z.string().max(256)).parse(variables);
      values.variables = parsed;
      const template = state.rows.templates.find(row => row.id === draft.templateId);
      const translation = (template?.translations as Row | undefined)?.[String(values.locale)] as Row | undefined;
      if (!translation) throw new Error("TEMPLATE_LOCALE");
      extractTemplatePreview(String(translation.subject), parsed);
      extractTemplatePreview(String(translation.content), parsed);
      draft.step = "provider";
      return reply(this.draftPrompt(draft), "email-draft", true);
    }
    if (step === "subject") { values.subject = z.string().trim().min(1).max(998).parse(text); draft.step = "message"; return reply(this.draftPrompt(draft), "email-draft", true); }
    if (step === "message") { values.message = z.string().trim().min(1).max(102_400).parse(text); draft.step = "contentFormat"; return reply(this.draftPrompt(draft), "email-draft", true); }
    if (step === "contentFormat") {
      values.contentFormat = defaultChoice.test(value) ? "html" : value.toLowerCase();
      if (values.contentFormat !== "plain" && values.contentFormat !== "html") throw new Error("FORMAT");
      draft.step = "messageType"; return reply(this.draftPrompt(draft), "email-draft", true);
    }
    if (step === "messageType") {
      values.messageType = defaultChoice.test(value) ? "transactional" : value.toLowerCase();
      if (values.messageType !== "transactional" && values.messageType !== "marketing") throw new Error("MESSAGE_TYPE");
      draft.step = "locale"; return reply(this.draftPrompt(draft), "email-draft", true);
    }
    if (step === "provider") {
      if (!defaultChoice.test(value)) {
        const id = z.uuid().safeParse(text.trim());
        if (id.success) values.providerId = id.data;
        else {
          const normalized = digits(text.trim());
          if (!/^\d+$/u.test(normalized)) throw new Error("PROVIDER_ID_OR_DEFAULT");
          const result = await this.api.execute({ operation: "providers", input: { page: 1, perPage: 50, status: "active" } }, context);
          if (!result.ok) return reply(safeError(result), "email-error", true);
          state.rows.providers = result.data.items as Row[];
          const index = Number(normalized);
          if (index < 1 || index > state.rows.providers.length) throw new Error("PROVIDER_INDEX");
          values.providerId = String(state.rows.providers[index - 1]!.id);
        }
      }
      draft.step = "fromEmail"; return reply(this.draftPrompt(draft), "email-draft", true);
    }
    if (step === "fromEmail") {
      if (!skip.test(value)) values.fromEmail = emailAddressSchema.parse(text);
      draft.step = "campaignName"; return reply(this.draftPrompt(draft), "email-draft", true);
    }
    if (step === "campaignName") {
      if (!skip.test(value)) values.campaignName = z.string().trim().max(120).parse(text);
      const input = sendEmailSchema.parse({ ...values, idempotencyKey: randomUUID() }) as Row;
      const command: EmailCommand = { operation: "messageSend", input };
      validateEmailCommand(command);
      draft.step = "done";
      state.draft = undefined;
      return { ...this.propose(command, state), deleteSensitiveMessage: true };
    }
    throw new Error("INVALID_DRAFT_STEP");
  }

  private selectTemplate(text: string, templates: Row[]): Row | undefined {
    const value = digits(text.trim());
    if (/^\d+$/u.test(value)) return templates[Number(value) - 1];
    const id = z.uuid().safeParse(text.trim());
    if (id.success) return templates.find(row => row.id === id.data);
    return templates.find(row => row.key === text.trim());
  }

  private propose(command: EmailCommand, state: State, snapshot?: Snapshot) {
    command.input = validateEmailCommand(command).input;
    state.command = command;
    state.snapshot = snapshot;
    const input = command.input as Row;
    let details: string;
    let warning: string;
    if (command.operation === "providerCreate" || command.operation === "providerUpdate") {
      details = pretty(providerPreview(input));
      warning = "تغییر سرویس می‌تواند ارسال‌های بعدی را مختل کند. رمز و نام‌کاربری نمایش داده نشده‌اند. تبدیل این سرویس به پیش‌فرض، پیش‌فرض قبلی را کنار می‌زند.";
    } else if (command.operation === "providerDelete") {
      details = emailProviderCard(snapshot?.row ?? {}); warning = "حذف نرم است و سرویس غیرفعال می‌شود؛ ارسال‌های قبلی تغییر نمی‌کنند.";
    } else if (command.operation === "providerTest") {
      details = `سرویس: ${emailProviderCard(snapshot?.row ?? {})}\nگیرنده: ${String(input.recipient)}\nموضوع: ${String(input.subject)}\nمتن:\n${String(input.message)}`;
      warning = snapshot?.row.kind === "fake" ? "⚠️ سرویس fake شبیه‌سازی است؛ نوع‌های دیگر تست را به یک گیرندهٔ واقعی می‌فرستند. سرویس ممکن است تست را به‌عنوان ایمیل عادی ثبت کند." : "⚠️ پس از تأیید، ایمیل واقعی با موضوع و متن بالا برای گیرنده ارسال و نتیجهٔ سلامت ذخیره می‌شود؛ تحویل قطعی تضمین نیست.";
    } else if (command.operation === "messageSend") {
      details = this.sendPreview(input, state);
      warning = `⚠️ پس از تأیید، سرویس ایمیل واقعی به ${String((input.recipients as string[]).length)} گیرنده ارسال می‌شود. برای بازاریابی مطمئن شو گیرنده‌ها رضایت داده‌اند. پذیرش سرویس مساوی تحویل قطعی نیست؛ در نتیجهٔ جزئی فقط موارد موفق گزارش می‌شوند.`;
    } else if (command.operation === "messageDelete") {
      details = emailMessageCard(snapshot?.row ?? {}); warning = "⚠️ فقط رکورد گزارش داخلی حذف می‌شود؛ ایمیل ارسال‌شده پس گرفته یا از صندوق گیرنده پاک نمی‌شود.";
    } else if (command.operation === "templateCreate" || command.operation === "templateUpdate") {
      details = pretty(input); warning = "متن‌ها و ترجمه‌های قالب دقیقاً ذخیره می‌شوند. در ویرایش، اگر translations را بفرستی هر دو زبان جایگزین می‌شوند.";
    } else {
      details = emailTemplateCard(snapshot?.row ?? {}, 0, true); warning = "قالب نرم‌حذف و غیرفعال می‌شود؛ ارسال‌های ثبت‌شده تغییر نمی‌کنند.";
    }
    return { status: "email-proposed", reply: `**🔎 تأیید عملیات ایمیل**\n\n• عملیات: ${command.operation}\n${command.id ? `• شناسه: ${command.id}\n` : ""}${details}\n\n${warning}\n\n🔒 هنوز اجرا نشده. برای اجرا دقیقاً «تأیید» بفرست؛ «لغو» برای انصراف. اعتبار: ۵ دقیقه.` };
  }

  private sendPreview(input: Row, state: State): string {
    const recipients = input.recipients as string[];
    const templateId = input.templateId as string | undefined;
    let subject = String(input.subject ?? "");
    let body = String(input.message ?? "");
    let templateName = "";
    if (templateId) {
      const template = state.rows.templates.find(row => row.id === templateId);
      const translations = template?.translations as Row | undefined;
      const translation = translations?.[String(input.locale)] as Row | undefined;
      if (template && translation) {
        templateName = String(template.key);
        const variables = (input.variables ?? {}) as Record<string, string>;
        subject = extractTemplatePreview(String(translation.subject), variables);
        body = extractTemplatePreview(String(translation.content), variables);
      }
    }
    return `• گیرنده‌ها (${recipients.length}):\n${recipients.map((address, index) => `${index + 1}. ${address}`).join("\n")}\n• سرویس: ${input.providerId ? String(input.providerId) : "پیش‌فرض سرور"}\n• فرستندهٔ جایگزین: ${input.fromEmail ?? "تنظیم سرویس"}\n• نوع/قالب/زبان: ${String(input.messageType)} / ${String(input.contentFormat)} / ${String(input.locale)}\n${templateName ? `• قالب: ${templateName}\n` : ""}${input.campaignName ? `• نام ارسال: ${String(input.campaignName)}\n` : ""}• موضوع نهایی:\n${subject}\n\n• متن نهایی:\n${body}`;
  }

  private async readSnapshot(snapshot: Snapshot, context: RuleRequestContext): Promise<Row | null> {
    if (snapshot.resource === "provider") {
      const result = await this.api.execute({ operation: "providerGet", id: String(snapshot.row.id), input: {} }, context);
      return result.ok ? result.data : null;
    }
    if (snapshot.resource === "template") {
      const result = await this.api.execute({ operation: "templateGet", id: String(snapshot.row.id), input: {} }, context);
      return result.ok ? result.data : null;
    }
    const query = { ...(snapshot.query ?? {}), page: 1, perPage: 50 };
    const result = await this.api.execute({ operation: "messages", input: query }, context);
    if (!result.ok || Number(result.data.total) > 50) return null;
    return (result.data.items as Row[]).find(row => row.id === snapshot.row.id) ?? null;
  }
  private sameSnapshot(snapshot: Snapshot, latest: Row): boolean {
    if (snapshot.resource !== "message") return snapshot.row.id === latest.id && snapshot.row.updatedAt === latest.updatedAt;
    return ["id", "status", "recipientMasked", "providerName", "providerKind", "createdAt"].every(key => snapshot.row[key] === latest[key]);
  }

  private async run(command: EmailCommand, state: State, context: RuleRequestContext) {
    const result = await this.api.execute(command, context);
    if (!result.ok) return { status: "email-error", reply: safeError(result) };
    const data = result.data;
    if (command.operation === "overview") return { status: "email-overview", reply: overviewCard(data) };
    if (["providers", "messages", "recipients", "templates"].includes(command.operation)) {
      const resource = command.operation as Resource;
      const rows = data.items as Row[];
      state.rows[resource] = rows;
      state.queries[resource] = validateEmailCommand(command).input;
      const total = Number(data.total), page = Number(data.page), totalPages = Number(data.totalPages);
      const title = { providers: "سرویس‌های ایمیل", messages: "گزارش ایمیل‌ها", recipients: "گیرندگان فعال ایمیل", templates: "قالب‌های ایمیل" }[resource];
      const cards = rows.map((row, index) => resource === "providers" ? emailProviderCard(row, index) : resource === "messages" ? emailMessageCard(row, index) : resource === "recipients" ? recipientCard(row, index) : emailTemplateCard(row, index));
      return { status: "email-listed", reply: `**📨 ${title}**\n\n• صفحه: ${page} از ${totalPages}\n• تعداد کل: ${total}\n\n${cards.join("\n\n") || "📭 موردی پیدا نشد."}\n\n${resource === "recipients" ? "نشانی‌ها فقط در همین گفت‌وگوی خصوصی نمایش داده می‌شوند. برای ارسال به ردیف‌های دیده‌شده، در فرم ارسال شماره‌ها را انتخاب کن." : resource === "messages" ? "برای حذف یک گزارش بگو «گزارش دوم را حذف کن»؛ این کار ایمیل را پس نمی‌گیرد." : "برای صفحهٔ بعد بگو «صفحهٔ بعد»؛ برای تغییر، ردیف را شماره‌اش بگو."}` };
    }
    if (command.operation === "messageSend") {
      state.rows.messages = [];
      const summary = data as Row;
      return { status: "email-send-completed", reply: `📨 نتیجهٔ پذیرش سرویس ایمیل\n• شناسهٔ کمپین: ${String(summary.campaignId)}\n• گیرنده‌ها: ${String(summary.total)}\n• پذیرفته/ارسال‌شده: ${String(summary.sent)}\n• ناموفق: ${String(summary.failed)}\n• وضعیت: ${String(summary.status)}\n\n⚠️ این نتیجه به معنی تحویل قطعی نیست؛ گزارش‌های ارسال را برای وضعیت delivered بررسی کن. اگر نتیجهٔ شبکه مبهم بود، دوباره ارسال نکن تا گزارش را بررسی کنی.` };
    }
    if (command.operation === "providerTest") {
      const test = data as Row;
      return { status: "email-test-completed", reply: `${test.successful ? "✅ سرویس ایمیل تست را پذیرفت" : "⚠️ سرویس ایمیل تست را نپذیرفت"}\n• زمان پاسخ: ${String(test.responseTimeMs)} میلی‌ثانیه\n\nپذیرش سرویس تضمین تحویل به صندوق گیرنده نیست؛ خطای خام و شناسهٔ پیام نمایش داده نمی‌شود.` };
    }
    if (command.operation === "messageDelete") return { status: "email-completed", reply: "✅ رکورد گزارش از پایگاه‌داده حذف شد؛ ایمیل از صندوق گیرنده پس گرفته نشد." };
    if (command.operation === "providerCreate") return { status: "email-completed", reply: `✅ سرویس ایمیل ساخته شد. شناسه: ${String(data.id)}\n🔐 نام‌کاربری و رمز در پاسخ ربات نمایش داده نمی‌شوند.` };
    if (command.operation === "templateCreate") return { status: "email-completed", reply: `✅ قالب ایمیل ساخته شد. شناسه: ${String(data.id)}` };
    if (command.operation === "providerUpdate" || command.operation === "providerDelete" || command.operation === "templateUpdate" || command.operation === "templateDelete") {
      state.rows[command.operation.startsWith("provider") ? "providers" : "templates"] = [];
      return { status: "email-completed", reply: `✅ عملیات ${command.operation.startsWith("provider") ? "سرویس ایمیل" : "قالب ایمیل"} توسط API تأیید شد. برای بررسی نتیجه، فهرست را دوباره بخواه.` };
    }
    if (command.operation === "providerGet") return { status: "email-read", reply: emailProviderCard(data) };
    if (command.operation === "templateGet") return { status: "email-read", reply: emailTemplateCard(data, 0, true) };
    return { status: "email-completed", reply: "✅ درخواست ایمیل با موفقیت انجام شد." };
  }

}
