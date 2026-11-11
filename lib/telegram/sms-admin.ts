import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { normalize } from "@/lib/text";
import { adminReadStatus, isExplicitAdminReadIntent, matchAdminReadRoute } from "./admin-read-intent";
import { isOtpLoginIntent } from "@/lib/auth/telegram-login";
import { jalaliDate } from "./format";
import type { RuleRequestContext } from "@/lib/rules/types";
import { SmsAdminApi, smsOperations, validateSmsCommand, type SmsCommand, type SmsOperation } from "@/lib/sms-admin/api";
import { planSmsRequest, smsPlanSchema, type SmsChoice, type SmsPlanner } from "@/lib/sms-admin/planner";
import { normalizeIranianPhone } from "@/lib/sms-admin/phone";
import { credentialsSchema, providerKinds } from "@/lib/sms-admin/sms-shared";

type Draft = { operation: SmsOperation; id?: string; values: Record<string, unknown>; step: number };
type State = { actor: string; session: string; expires: number; choices: SmsChoice[]; query: Record<string, unknown>; command?: SmsCommand; draft?: Draft; awaiting?: string; templateSnapshot?: string };
const lists = ["messages", "providers", "templates", "recipients", "received"];
export function isSmsAdminRequest(text: string): boolean {
  const value = normalize(text);
  if (/(?:کد|رمز|otp|ورود|لاگین)/iu.test(value) && !/مدیریت|سرویس|قالب|گزارش|پنل/iu.test(value)) return false;
  return /\bsms\b|مدیریت.*پیامک|(?:امار|ارسال|فرستادن|گزارش|قالب|سرویس|ارائه دهنده|اعتبار|پیامهای دریافتی).*پیامک|پیامک.*(?:بفرست|ارسال|بزن|گزارش|قالب|سرویس|دریافتی|گیرنده|امار|وضعیت|حذف)|پنل پیامک/iu.test(value)
    || /(?:\bsms\b|پیامک)/iu.test(value) && isExplicitAdminReadIntent(value);
}
function deterministicSmsRead(text: string) {
  const status = (value: string) => adminReadStatus(value, [
    { value: "failed", when: /\b(?:failed|failure|unsuccessful)\b|ناموفق|شکست/iu },
    { value: "delivered", when: /\bdelivered\b|تحویل/iu },
    { value: "sending", when: /\bsending\b|در\s*حال\s*ارسال/iu },
    { value: "queued", when: /\bqueued\b|صف|منتظر/iu },
    { value: "sent", when: /\bsent\b|ارسال\s*شده/iu },
  ]);
  const activeStatus = (value: string) => adminReadStatus(value, [
    { value: "inactive", when: /\b(?:inactive|disabled)\b|غیرفعال/iu },
    { value: "active", when: /\b(?:active|enabled)\b|فعال/iu },
  ]);
  return matchAdminReadRoute(text, [
    { operation: "received" as const, when: /\b(?:received|incoming|inbox)\b|دریافتی|دریافت\s*شده|پیامهای\s+دریافتی/iu },
    { operation: "recipients" as const, when: /\b(?:recipients|contacts)\b|گیرنده(?:ها|های)|گیرندگان|مخاطبین/iu,
      input: value => /رزرو|\bbookings?\b/iu.test(value) ? { audience: "with_bookings" } : {} },
    { operation: "templates" as const, when: /\btemplates\b|قالب(?:ها|های)/iu,
      input: value => { const filter = activeStatus(value); return filter ? { status: filter } : {}; } },
    { operation: "providers" as const, when: /\b(?:providers?|services?)\b|سرویس|ارائه\s*دهنده/iu,
      input: value => { const filter = activeStatus(value); return filter ? { status: filter } : {}; } },
    { operation: "messages" as const, when: /\bmessages?\b|پیامها|پیامک.*(?:ناموفق|شکست|تحویل|ارسال\s*شده|در\s*حال\s*ارسال)|(?:failed|failure|unsuccessful|delivered|sending|queued|sent)/iu,
      input: value => { const filter = status(value); return filter ? { status: filter } : {}; } },
    { operation: "overview" as const, when: /\b(?:overview|stats?|statistics|summary|dashboard)\b|امار|گزارش\s*(?:کلی|عمومی)/iu },
    { operation: "messages" as const, when: /\b(?:sms|messages?)\b|پیامک|پیام/iu,
      input: value => { const filter = status(value); return filter ? { status: filter } : {}; } },
  ]);
}
const HELP = "**📨 مدیریت پیامک**\n\n• «امار پیامک را نشان بده»\n• «گزارش پیامک‌های ناموفق را نشان بده»\n• «سرویس‌دهنده‌های پیامک را نشان بده»\n• «قالب پیامک جدید بساز»\n• «پیامک بفرست»\n• «سرویس‌دهندهٔ دوم را تست کن»\n• «وضعیت تحویل پیامک اول را بررسی کن»\n\n💳 ارسال و تست ممکن است هزینه داشته باشند و فقط پس از تأیید اجرا می‌شوند. عملیات گروهی در API مرجع وجود ندارد.";
const resourceOf = (operation: string) => operation.startsWith("provider") || operation === "diagnostics" || operation === "refresh" ? "providers" : operation.startsWith("template") ? "templates" : "messages";
const fields: Record<string, string[]> = {
  send: ["recipients", "message", "options"], providerTest: ["recipient", "message"],
  providerCreate: ["name", "kind", "apiUrl", "token", "credentials", "sender"], providerUpdate: ["token", "credentials"],
  templateCreate: ["key", "nameFa", "contentFa", "nameEn", "contentEn", "variables", "externalTemplateId"],
};
const prompts: Record<string, string> = {
  recipients: "شمارهٔ گیرنده‌ها را با ویرگول یا خط جدید جدا کن؛ فقط موبایل معتبر ایران، حداکثر ۱۰۰۰ گیرنده.",
  recipient: "شمارهٔ موبایل گیرندهٔ تست را بفرست؛ این تست ممکن است پیامک واقعی و هزینه داشته باشد.",
  message: "متن دقیق پیامک را بفرست (حداکثر ۲۰۰۰ نویسه). برای ارسال با قالب بنویس «قالب: UUID» و شناسهٔ دقیق قالب را جایگزین کن.",
  options: 'تنظیمات اختیاری را به‌صورت JSON بفرست یا بنویس «پیش‌فرض». فیلدها: providerId، templateId، variables، sender، locale، messageType (transactional یا marketing)، campaignName. پیش‌فرض: سرویس پیش‌فرض، فارسی و پیام خدماتی.',
  name: "نام سرویس‌دهنده را بفرست (۲ تا ۸۰ نویسه).", kind: `نوع سرویس را بفرست: ${providerKinds.join("، ")}`,
  apiUrl: "نشانی HTTPS عمومی سرویس‌دهنده را بفرست؛ توکن را داخل آدرس ننویس.", token: "توکن اتصال را بفرست؛ این پیام پس از دریافت حذف می‌شود و مقدار وارد مدل یا خلاصه نخواهد شد.",
  credentials: 'اطلاعات اتصال اختیاری را به‌صورت JSON بفرست یا بنویس «بدون». کلیدهای مجاز: apiKey، username، password، authHeader، authScheme، lineNumber، payloadMode. این پیام حذف می‌شود؛ مقدارها وارد مدل نمی‌شوند.',
  sender: "شمارهٔ فرستنده را بفرست یا بنویس «پیش‌فرض».", key: "کلید یکتای انگلیسی قالب را بفرست؛ مثل appointment_reminder. این کلید بعداً قابل ویرایش نیست.",
  nameFa: "نام فارسی قالب را بفرست.", contentFa: "متن دقیق فارسی قالب را بفرست.", nameEn: "نام انگلیسی قالب را بفرست؛ ترجمه را حدس نمی‌زنم.", contentEn: "متن دقیق انگلیسی قالب را بفرست.",
  variables: "نام متغیرها را با ویرگول جدا کن؛ مثلاً name,date؛ اگر ندارد بنویس «بدون» (حداکثر ۲۰ متغیر یکتا).",
  externalTemplateId: "شناسهٔ عددی قالب در سرویس‌دهنده را بفرست یا بنویس «بدون».",
};
export class TelegramSmsAdmin {
  private states = new Map<string, State>();
  constructor(private api = new SmsAdminApi(), private planner: SmsPlanner = planSmsRequest, private now = Date.now) {}
  clear(owner: string) { this.states.delete(owner); }
  isCollecting(owner: string) { const state = this.states.get(owner); return Boolean(state?.draft && state.expires > this.now()); }
  private signature(context: RuleRequestContext) { return createHash("sha256").update(context.sessionCookie).digest("hex"); }
  async handle(owner: string, text: string, context: RuleRequestContext | null, privateChat: boolean): Promise<{ reply: string; status: string; deleteSensitiveMessage?: boolean } | null> {
    const prior = this.states.get(owner), expired = Boolean(prior && prior.expires <= this.now());
    for (const [key, state] of this.states) if (state.expires <= this.now()) this.states.delete(key);
    let state = this.states.get(owner);
    const value = normalize(text), explicit = isSmsAdminRequest(value);
    if (!state?.draft && (isOtpLoginIntent(text) || /^\/(?:clear|reset|new)\b/iu.test(text))) { this.clear(owner); return null; }
    const follow = state && (state.command || state.draft || state.awaiting || /اول|دوم|سوم|صفحه|حذف|تست|تحویل|اعتبار|فعال|ویرایش|تغییر|قالب|سرویس|لغو|next|delete|test/iu.test(value));
    if (!explicit && !follow && !(expired && /^(بله|تایید|تأیید|yes|confirm)$/iu.test(value))) return null;
    const field = state?.draft ? fields[state.draft.operation]?.[state.draft.step] : undefined;
    const sensitive = ["token", "credentials", "apiUrl"].includes(field ?? "") || /(?:apiKey|password|credentials|authHeader|token|توکن|کلید اتصال)\s*["']?\s*[:=]/iu.test(text);
    const reply = (message: string, status = "sms-pending") => ({ reply: message, status, ...(sensitive ? { deleteSensitiveMessage: true } : {}) });
    if (!privateChat) return reply("🔐 مدیریت پیامک فقط در گفت‌وگوی خصوصی مجاز است؛ اطلاعات اتصال را اینجا نفرست.", "sms-private-only");
    if (!context?.actorId.trim() || !context.sessionCookie.trim()) { this.clear(owner); return reply("🔐 ابتدا در خصوصی با پیامک وارد حساب مجاز شو؛ هیچ درخواست مدیریتی ارسال نشده است.", "sms-auth-required"); }
    if (expired && !explicit) return reply("⏳ زمان جریان پیامک تمام شده؛ آن را از ابتدا شروع کن.", "sms-expired");
    if (state && (state.actor !== context.actorId || state.session !== this.signature(context))) { this.clear(owner); return reply("🔐 نشست تغییر کرده؛ درخواست را از ابتدا شروع کن.", "sms-session-changed"); }
    if (/^(لغو|cancel|\/cancel)$/iu.test(value)) { this.clear(owner); return reply("↩️ درخواست پیامک لغو شد؛ چیزی ارسال یا تغییر داده نشد.", "sms-cancelled"); }
    if (!state) {
      if (this.states.size >= 200) return reply("⏳ درخواست‌های زیادی منتظرند؛ بعداً تلاش کن.", "sms-busy");
      state = { actor: context.actorId, session: this.signature(context), expires: this.now() + 300_000, choices: [], query: {} }; this.states.set(owner, state);
    }
    if (state.command) {
      if (!/^(بله|تایید|تأیید|yes|confirm)$/iu.test(value)) return reply("🔎 درخواست قبلی منتظر است؛ برای اجرا «تأیید» و برای انصراف «لغو» را بفرست.");
      const command = state.command; state.command = undefined; // no retries/replays
      if (command.operation === "send" && state.templateSnapshot) {
        const snapshot = state.templateSnapshot; state.templateSnapshot = undefined;
        const current = await this.api.execute({ operation: "templateGet", id: String((command.input as Record<string, unknown>).templateId), input: {} }, context);
        if (!current.ok || JSON.stringify(current.data) !== snapshot) return reply("⚠️ قالب تغییر کرده یا قابل بررسی نیست؛ ارسال لغو شد. درخواست را از ابتدا شروع کن.", "sms-conflict");
      }
      return this.run(command, state, context);
    }
    if (state.draft) {
      const draft = state.draft;
      try {
        let input: unknown = text.trim();
        const skip = /^(بدون|پیشفرض|پیش فرض|skip|default)$/iu.test(value);
        if (field === "recipients") {
          const raw = text.split(/[,،;\n]+/u).map(item => item.trim()).filter(Boolean);
          const phones = raw.map(normalizeIranianPhone);
          if (!phones.length || phones.some(item => !item) || phones.length > 1000) throw new Error();
          input = [...new Set(phones)];
        } else if (field === "recipient") { input = normalizeIranianPhone(text); if (!input) throw new Error(); }
        else if (field === "message" && draft.operation === "send" && /^قالب\s*[:：]/u.test(value)) {
          draft.values.templateId = z.uuid().parse(value.replace(/^قالب\s*[:：]\s*/u, "")); input = undefined;
        } else if (field === "options") {
          const options = skip ? {} : z.object({ providerId: z.uuid().optional(), templateId: z.uuid().optional(), variables: z.record(z.string(), z.string()).optional(), sender: z.string().optional(), locale: z.enum(["fa", "en"]).optional(), messageType: z.enum(["transactional", "marketing"]).optional(), campaignName: z.string().optional() }).strict().parse(JSON.parse(text));
          Object.assign(draft.values, options); input = undefined;
        } else if (field === "credentials") { input = skip ? undefined : credentialsSchema.parse(JSON.parse(text)); }
        else if (field === "sender" || field === "externalTemplateId") input = skip ? undefined : text.trim();
        else if (field === "variables") input = skip ? [] : text.split(/[,،]/u).map(item => item.trim());
        else if (["contentFa", "contentEn"].includes(field!)) input = z.string().trim().min(1).max(2000).parse(text);
        else if (["nameFa", "nameEn"].includes(field!)) input = z.string().trim().min(1).max(120).parse(text);
        else if (field === "key") input = z.string().min(1).max(80).regex(/^[a-z][a-z0-9_.-]*$/).parse(text.trim());
        else if (field === "name") input = z.string().trim().min(2).max(80).parse(text);
        else if (field === "kind") input = z.enum(providerKinds).parse(text.trim());
        else if (field === "token") input = z.string().trim().min(1).max(4096).parse(text);
        else if (field === "apiUrl") { const url = new URL(text.trim()); if (url.protocol !== "https:" || url.username || url.password) throw new Error(); }
        else if (field === "message") input = z.string().trim().min(1).max(2000).parse(text);
        if (field === "recipients" || input !== undefined) draft.values[field!] = input;
        draft.step++;
        if (draft.step < fields[draft.operation]!.length) return reply(this.prompt(draft));
        let payload = { ...draft.values };
        if (draft.operation === "templateCreate") {
          payload = { key: payload.key, translations: { fa: { name: payload.nameFa, content: payload.contentFa }, en: { name: payload.nameEn, content: payload.contentEn } }, variables: payload.variables, ...(payload.externalTemplateId ? { externalTemplateId: payload.externalTemplateId } : {}) };
        }
        if (draft.operation === "send") {
          if (payload.templateId) delete payload.message;
          payload.idempotencyKey = randomUUID();
          // Render a real template for the approval preview, without involving AI.
          if (payload.templateId) {
            const template = await this.api.execute({ operation: "templateGet", id: String(payload.templateId), input: {} }, context);
            if (!template.ok) throw new Error();
            state.templateSnapshot = JSON.stringify(template.data);
            const tr = template.data.translations as Record<string, { content: string }>;
            const content = tr[String(payload.locale ?? "fa")]?.content;
            if (!content) throw new Error();
            const variables = payload.variables as Record<string, string> | undefined;
            const required = template.data.variables as string[];
            if (required.some(key => !variables?.[key])) throw new Error();
            const preview = content.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (_match, key: string) => variables?.[key] ?? `{{${key}}}`);
            if (/\{\{/.test(preview)) throw new Error();
            state.awaiting = preview; // server-only preview, never planner context
          }
        }
        const command: SmsCommand = { operation: draft.operation, id: draft.id, input: payload };
        command.input = validateSmsCommand(command).input;
        state.draft = undefined;
        return { ...this.propose(command, state), ...(sensitive ? { deleteSensitiveMessage: true } : {}) };
      } catch {
        // If the final assembled body is invalid, restart the wizard rather than
        // keeping step beyond the last field or spilling fields into the model.
        if (draft.step >= fields[draft.operation]!.length) { draft.step = 0; draft.values = {}; state.templateSnapshot = undefined; state.awaiting = undefined; }
        return reply(`⚠️ مقدار یا تنظیمات معتبر نیست؛ دوباره وارد کن.\n\n${this.prompt(draft)}`, "sms-invalid");
      }
    }
    if (sensitive) return reply("🔐 اطلاعات اتصال را در درخواست آزاد ننویس. ابتدا ساخت سرویس یا تغییر توکن را بخواه تا مسیر دریافت امن شروع شود.", "sms-invalid");
    const directRead = deterministicSmsRead(text);
    if (directRead) {
      state.awaiting = undefined;
      const command: SmsCommand = { operation: directRead.operation, input: directRead.input };
      return this.run(command, state, context);
    }
    // Deterministic starts keep private bodies/recipients out of model input.
    if (/(?:ارسال|فرستادن|بفرست|send).*(?:پیامک|sms)|(?:پیامک|sms).*(?:بفرست|ارسال|send)/iu.test(value)) return reply(this.start(state, "send"));
    if (/(?:قالب).*پیامک.*(?:بساز|جدید)|(?:قالب).*جدید.*بساز/u.test(value)) return reply(this.start(state, "templateCreate"));
    try {
      const plan = smsPlanSchema.parse(await this.planner(state.awaiting ? `${state.awaiting}\nانتخاب: ${text}` : text, state.choices, state.query));
      state.awaiting = undefined;
      if (plan.operation === "clarify") { state.awaiting = text; return reply(HELP); }
      const operation = plan.operation === "providerSecret" ? "providerUpdate" : plan.operation as SmsOperation;
      if (!(operation in smsOperations)) return reply(HELP, "sms-invalid");
      const resource = resourceOf(operation);
      const target = plan.id ?? (typeof plan.input.providerId === "string" ? plan.input.providerId : undefined);
      if (target && !state.choices.some(item => item.id === target && item.resource === resource) && !text.includes(target)) return reply("🔎 ابتدا فهرست مربوط را بخواه یا شناسهٔ دقیق را بفرست؛ شناسه‌ای را حدس نمی‌زنم.", "sms-invalid");
      if (["send", "providerCreate", "templateCreate", "providerTest"].includes(operation) || plan.operation === "providerSecret") {
        if ((operation === "providerTest" || plan.operation === "providerSecret") && !plan.id) return reply("🔎 سرویس‌دهنده و شناسه‌اش را ابتدا مشخص کن.");
        return reply(this.start(state, operation, plan.id));
      }
      if (operation === "providerUpdate" && ("token" in plan.input || "credentials" in plan.input)) return reply("🔐 برای تغییر اطلاعات محرمانه، «توکن سرویس‌دهنده را تغییر بده» را بخواه.", "sms-invalid");
      const command: SmsCommand = { operation, id: plan.id, input: lists.includes(operation) && plan.input.page !== undefined && state.query.operation === operation ? { ...(state.query.input as object), ...plan.input } : plan.input };
      command.input = validateSmsCommand(command).input;
      return smsOperations[operation][0] === "GET" ? this.run(command, state, context) : this.propose(command, state);
    } catch { return reply("⚠️ درخواست دقیق و معتبری آماده نشد؛ نوع عملیات و شناسه را روشن‌تر بگو. هیچ ارسال یا تغییری انجام نشده.", "sms-invalid"); }
  }
  private start(state: State, operation: SmsOperation, id?: string) { state.draft = { operation, id, values: {}, step: 0 }; return this.prompt(state.draft); }
  private prompt(draft: Draft) { return `**📨 تکمیل درخواست پیامک**\n\n• مرحله: ${draft.step + 1} از ${fields[draft.operation]!.length}\n${prompts[fields[draft.operation]![draft.step]!] }\n\n🔒 بدون تأیید نهایی اجرا نمی‌شود. انصراف: «لغو»\n⏳ اعتبار جریان: ۵ دقیقه`; }
  private propose(command: SmsCommand, state: State) {
    const input = validateSmsCommand(command).input;
    command.input = input; state.command = command;
    const billable = command.operation === "send" || command.operation === "providerTest";
    const summary: Record<string, unknown> = { ...input };
    for (const field of ["token", "credentials"]) if (field in summary) summary[field] = "[محرمانه؛ در خلاصه نمایش داده نمی‌شود]";
    if (typeof summary.apiUrl === "string") summary.apiUrl = `${new URL(summary.apiUrl).origin} (مسیر محرمانه نمایش داده نمی‌شود)`;
    delete summary.idempotencyKey;
    const preview = command.operation === "send" && input.templateId ? `\n✉️ پیش‌نمایش متن قالب:\n${state.awaiting ?? ""}` : "";
    state.awaiting = undefined;
    const warning = command.operation === "refresh" ? "\n⚠️ دریافت از سرویس ممکن است پیام‌ها را در سرویس‌دهنده خوانده‌شده علامت بزند." : command.operation === "messageDelete" ? "\nℹ️ این کار فقط رکورد گزارش را حذف می‌کند؛ پیامک ارسال‌شده پس گرفته نمی‌شود." : "";
    return { status: "sms-proposed", reply: `**🔎 تأیید درخواست پیامک**\n\n• عملیات: ${command.operation}${command.id ? `\n• شناسه: ${command.id}` : ""}\n${JSON.stringify(summary, null, 2)}${preview}${billable ? "\n💳 ارسال واقعی/تست ممکن است هزینه داشته باشد. تعداد و متن و گیرنده‌ها را دقیق بررسی کن." : ""}${warning}\n\n🔒 هنوز چیزی اجرا نشده.\n✅ اجرا: «تأیید»\n↩️ انصراف: «لغو»\n⏳ اعتبار: ۵ دقیقه` };
  }
  private async run(command: SmsCommand, state: State, context: RuleRequestContext) {
    const result = await this.api.execute(command, context);
    if (!result.ok) return { status: "sms-error", reply: `**⚠️ درخواست پیامک تأیید نشد**\n\n• کد: ${result.code}${result.status ? `\n• HTTP: ${result.status}` : ""}\n🔎 در خطای شبکه نتیجهٔ ارسال ممکن است نامشخص باشد؛ بدون بررسی گزارش‌ها دوباره ارسال نکن.` };
    if (lists.includes(command.operation)) {
      const items = result.data.items as Record<string, unknown>[];
      state.choices = [...state.choices.filter(item => item.resource !== command.operation), ...items.map(item => ({ id: String(item.id), title: String(item.name ?? (item.translations as { fa?: { name: string } } | undefined)?.fa?.name ?? item.fullName ?? item.recipientMasked ?? item.providerName ?? "ردیف"), resource: command.operation }))];
      state.query = { operation: command.operation, input: command.input };
    }
    return { status: smsOperations[command.operation][0] === "GET" ? "sms-read" : "sms-completed", reply: renderSmsResult(command.operation, result.data) };
  }
}
export function renderSmsResult(operation: SmsOperation, data: Record<string, unknown>): string {
  const labels: Record<string, string> = { id: "شناسه", name: "نام", kind: "نوع سرویس", isActive: "فعال", isDefault: "پیش‌فرض", healthStatus: "سلامت سرویس", tokenConfigured: "توکن تنظیم‌شده", recipientMasked: "گیرنده", providerName: "سرویس", status: "وضعیت", createdAt: "تاریخ ثبت", sentAt: "زمان ارسال", deliveredAt: "زمان تحویل", fullName: "نام", phone: "تلفن", key: "کلید قالب", externalTemplateId: "شناسه قالب سرویس", messageType: "نوع پیام", displayOrder: "ترتیب", total: "کل", sent: "ارسال‌شده", delivered: "تحویل‌شده", failed: "ناموفق", deliveryRate: "نرخ تحویل", providerCount: "تعداد سرویس‌ها", activeProviderCount: "سرویس‌های فعال", templateCount: "تعداد قالب‌ها", activeTemplateCount: "قالب‌های فعال", campaignId: "شناسه ارسال", parts: "تعداد بخش پیام", encoding: "کدگذاری", providerId: "شناسه سرویس", credit: "اعتبار", stored: "تعداد ذخیره‌شده", responseTimeMs: "زمان پاسخ (میلی‌ثانیه)", successful: "تست موفق", ok: "تأیید سرویس", line: "خط", mobileMasked: "فرستنده", message: "متن دریافتی", receivedAt: "تاریخ دریافت" };
  const format = (record: Record<string, unknown>) => {
    const lines = Object.entries(labels).flatMap(([key, label]) => record[key] !== undefined && record[key] !== null ? [`• ${label}: ${typeof record[key] === "boolean" ? record[key] ? "بله" : "خیر" : /At$/.test(key) ? jalaliDate(String(record[key])) : String(record[key])}`] : []);
    if (record.stats) lines.push(...Object.entries(record.stats as Record<string, unknown>).map(([key, value]) => `• ${labels[key] ?? key}: ${String(value)}`));
    if (record.lines) lines.push(`• خطوط: ${(record.lines as string[]).join("، ")}`);
    if (record.translations) { const tr = record.translations as Record<string, { name: string; content: string }>; for (const locale of ["fa", "en"]) if (tr[locale]) lines.push(`• نام ${locale}: ${tr[locale].name}\n• متن ${locale}: ${tr[locale].content}`); }
    if (record.variables) lines.push(`• متغیرها: ${(record.variables as string[]).join("، ") || "ندارد"}`);
    return lines.join("\n");
  };
  if (Array.isArray(data.items)) return `**📨 فهرست مدیریت پیامک**\n\n📄 صفحه: ${data.page}\n📊 تعداد کل: ${data.total}\n\n${data.items.map((item, index) => `**📋 ${index + 1}**\n${format(item as Record<string, unknown>)}`).join("\n\n") || "📭 موردی پیدا نشد."}`;
  const failed = data.status === "failed" || data.successful === false;
  return `**${failed ? "⚠️ نتیجه ناموفق" : "📨 نتیجهٔ درخواست پیامک"}**\n\n${format(data)}${operation === "send" ? "\nℹ️ ارسال‌شده به معنی تحویل قطعی به گوشی نیست؛ وضعیت تحویل را جداگانه بررسی کن." : ""}`;
}
