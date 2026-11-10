import { createHash } from "node:crypto";
import { isOtpLoginIntent } from "@/lib/auth/telegram-login";
import { jalaliDate } from "./format";
import { normalize } from "@/lib/text";
import type { RuleRequestContext } from "@/lib/rules/types";
import { ClinicUsersApi, validateUserCommand, type UserCommand } from "@/lib/users/clinic-api";
import { planUserRequest, type UserPlanner, type UserChoice } from "@/lib/users/planner";
import { createUserSchema } from "@/lib/users/clinic-validation";

type Flow = { actor: string; session: string; expires: number; fields?: Record<string, string>; command?: UserCommand };
const operationLabels = { list: "فهرست کاربران", create: "ساخت کاربر", status: "تغییر وضعیت کاربر", role: "تغییر نقش", password: "تغییر رمز عبور", delete: "حذف کاربر", bulk: "عملیات گروهی" };
const fields = ["fullName", "email", "phone", "password", "roleKey"] as const;
const labels = { fullName: "نام کامل", email: "ایمیل", phone: "شماره تماس", password: "رمز عبور (حداقل ۸ نویسه، شامل حروف بزرگ و کوچک انگلیسی، رقم و علامت)", roleKey: "نقش کاربر" };
export const USERS_HELP = `**👥 مدیریت سادهٔ کاربران**

• 👤 ساخت: «یک کاربر جدید بساز»
• 🔎 جست‌وجو: «کاربری به نام سارا پیدا کن»
• 📋 فهرست: «کاربران فعال را نشان بده»
• 🗑 حذف: «کاربر دوم را حذف کن» یا «کاربر با نام … را حذف کن»
• 🟢 وضعیت: «کاربر اول را غیرفعال کن»
• 🎭 نقش: «نقش کاربر اول را به … تغییر بده»
• 👥 گروهی: «همهٔ کاربران غیرفعال را حذف کن»

🔒 هر تغییر را ابتدا برای بررسی نشان می‌دهم و فقط پس از «تأیید» اجرا می‌کنم.
↩️ برای توقف بنویس «لغو».`;
export function isUserManagementMessage(text: string): boolean {
  return /^\/users(?:\s|$)/iu.test(text) || /کاربر|کاربران|حساب کاربری|\busers?\b/iu.test(normalize(text))
    && /بساز|ساخت|ایجاد|افزودن|اضافه|ثبت|جدید|لیست|فهرست|نمایش|نشون|نشان|حذف|پاک|پیدا|جستجو|جست‌وجو|ویرایش|تغییر|بازنشانی|رمز|مسدود|فعال|reset|password|create|new|list|show|delete|edit|update|block/iu.test(normalize(text));
}

/** Passwords and account data stay out of model history and logs. Flows are
 * actor/session-bound, capped and expire; no cookies are retained in the map.
 * Process-local flows fail closed across cold starts (no durable guarantees).
 */
export class TelegramUsers {
  private flows = new Map<string, Flow>();
  clear(owner: string): void { this.flows.delete(owner); this.lists.delete(owner); this.awaiting.delete(owner); }
  private lists = new Map<string, { actor: string; session: string; expires: number; choices: UserChoice[]; query: Record<string, unknown> }>();
  private awaiting = new Map<string, { actor: string; session: string; expires: number; request: string }>();
  constructor(private api = new ClinicUsersApi(), private now = Date.now, private planner: UserPlanner = planUserRequest) {}
  private fingerprint(context: RuleRequestContext): string { return createHash("sha256").update(context.sessionCookie).digest("hex"); }

  async handle(owner: string, text: string, context: RuleRequestContext | null, privateChat: boolean): Promise<{ reply: string; status: string; deleteSensitiveMessage?: boolean } | null> {
    const now = this.now();
    for (const [key, flow] of this.flows) if (flow.expires <= now) this.flows.delete(key);
    for (const map of [this.lists, this.awaiting]) for (const [key, entry] of map) {
      if (entry.expires <= now || (key === owner && (!context || entry.actor !== context.actorId || entry.session !== this.fingerprint(context)))) map.delete(key);
    }
    const value = normalize(text);
    let flow = this.flows.get(owner);
    const details = /^(?:نام|نام کامل|ایمیل|شماره تماس|تلفن|رمز عبور|نقش|name|email|phone|password)\s*[:：]/iu.test(value);
    const passwordStep = Boolean(flow?.fields && fields.find(key => flow!.fields![key] === undefined) === "password");
    if (flow && !passwordStep && (isOtpLoginIntent(text) || /^\/(?:clear|reset|new)\b/iu.test(text))) {
      this.flows.delete(owner);
      return null;
    }
    const prior = this.awaiting.get(owner);
    const followup = this.lists.has(owner) && /حذف|پاک|مسدود|فعال|نقش|رمز|بازنشانی|صفحه|reset|password|delete|remove|ban|role|next/iu.test(value);
    if (!flow && !prior && !followup && !isUserManagementMessage(text) && !details) return null;
    const sensitive = Boolean(flow?.fields && fields.find(key => flow!.fields![key] === undefined) === "password") || /"(?:password|confirmPassword)"\s*:/u.test(text);
    const reply = (message: string, status = "users-pending") => ({
      reply: message.startsWith("**") ? message : `${status === "users-cancelled" ? "**↩️ عملیات لغو شد**" : /required|invalid|changed|busy|only/u.test(status) ? "**🔔 راهنمای درخواست**" : "**📝 مدیریت کاربران**"}\n\n${message}`,
      status,
      ...(sensitive ? { deleteSensitiveMessage: true } : {}),
    });
    if (!privateChat) return reply("مدیریت کاربران فقط در گفت‌وگوی خصوصی ربات مجاز است. اطلاعات شخصی یا رمز را اینجا نفرست.", "users-private-only");
    if (/^(لغو|cancel|\/cancel)$/iu.test(value)) { this.flows.delete(owner); this.awaiting.delete(owner); return reply("عملیات کاربران لغو شد؛ تغییری ارسال نشد.", "users-cancelled"); }
    if (!context) { this.flows.delete(owner); return reply("برای مدیریت کاربران ابتدا در خصوصی بنویس «می‌خواهم لاگین کنم». هیچ اطلاعاتی ذخیره یا تغییری ارسال نشد.", "users-auth-required"); }
    if (flow && (flow.actor !== context.actorId || flow.session !== this.fingerprint(context))) {
      this.flows.delete(owner); return reply("نشست تغییر کرده است؛ درخواست را دوباره شروع کن.", "users-session-changed");
    }
    if (/^\/users\s+help$/iu.test(text)) return reply(USERS_HELP, "users-help");
    // A new explicit command discards the old proposal, never implicitly confirms it.
    if (!flow?.fields && isUserManagementMessage(text)) { this.flows.delete(owner); flow = undefined; }
    if (flow?.command) {
      if (!/^(تایید|تأیید|بله|confirm|yes)$/iu.test(value)) return reply("برای اجرای پیشنهاد «تأیید» و برای کنارگذاشتن «لغو» را بفرست.");
      this.flows.delete(owner); // single-use, removed before awaiting network
      return { ...await this.run(flow.command, context, owner), ...(sensitive ? { deleteSensitiveMessage: true } : {}) };
    }
    if (!flow && /(?:کاربر.*(?:بساز|ایجاد|جدید)|(?:create|new).*user)/iu.test(value) && !text.startsWith("/users")) {
      if (this.flows.size >= 1000) return reply("ظرفیت درخواست‌های منتظر تکمیل است؛ بعداً تلاش کن.", "users-busy");
      this.awaiting.delete(owner);
      flow = { actor: context.actorId, session: this.fingerprint(context), expires: now + 300_000, fields: { roleKey: "customer" } };
      this.flows.set(owner, flow);
      return reply(`**👤 ساخت کاربر جدید**\n\n📝 در ۴ قدم ساده حساب مشتری را آماده می‌کنیم.\n\n۱. ${labels.fullName} را بفرست.\n\n🔒 هنوز تغییری انجام نشده.\n↩️ انصراف: «لغو»`);
    }
    if (flow?.fields) {
      const field = fields.find(key => flow!.fields![key] === undefined)!;
      // Preserve passwords exactly, normalize only non-secret field digits/labels.
      const input = field === "password" ? text : value.replace(/^[^:：]{1,24}[:：]\s*/u, "");
      const parsed = createUserSchema.shape[field].safeParse(input);
      if (!parsed.success) return reply(`مقدار ${labels[field]} معتبر نیست؛ دوباره بفرست. مقدار قبلی ذخیره نشد.`);
      flow.fields[field] = parsed.data;
      const next = fields.find(key => flow!.fields![key] === undefined);
      if (next) return reply(`**📝 تکمیل مشخصات کاربر**\n\n• مرحله: ${fields.indexOf(next) + 1} از ${fields.length - 1}\n• اطلاعات موردنیاز: ${labels[next]}${next === "password" ? "\n\n🔐 پیام رمزت پس از دریافت حذف می‌شود؛ رمز فقط موقتاً در سرور نگهداری می‌شود.\n⏳ این فرایند ۵ دقیقه اعتبار دارد؛ اگر قطع شد، ابتدا ساخت را از نو شروع کن." : ""}\n\n↩️ انصراف: «لغو»`);
      const command: UserCommand = { operation: "create", input: { ...flow.fields } };
      flow.fields = undefined;
      flow.command = command;
      return reply(`نام: ${String((command.input as Record<string, unknown>).fullName)}؛ نقش: ${String((command.input as Record<string, unknown>).roleKey)}\nاطلاعات ساخت کاربر آماده است. هنوز چیزی ارسال نشده؛ برای ایجاد حساب «تأیید» و برای انصراف «لغو» را بفرست.`);
    }
    let command: UserCommand;
    try {
      const match = text.match(/^\/users\s+(list|create|status|role|password|delete|bulk)(?:\s+([0-9a-f-]{36}))?(?:\s+(\{[\s\S]*\}))?\s*$/iu);
      if (match) command = { operation: match[1]!.toLowerCase() as UserCommand["operation"], id: match[2], input: match[3] ? JSON.parse(match[3]) : {} };
      else if (/^(?:لیست کاربران|فهرست کاربران|list users)$/iu.test(value)) command = { operation: "list", input: {} };
      else {
        if (/(?:رمز|password)/iu.test(text) && !/(?:بازنشانی|ریست|reset)/iu.test(text)) return reply("رمز را فقط وقتی در مرحلهٔ دریافت امن رمز هستی بفرست؛ برای ساخت بنویس «کاربر جدید بساز».", "users-help");
        if (sensitive || details) return reply("ابتدا بنویس «کاربر جدید بساز» تا مشخصات را امن و مرحله‌به‌مرحله دریافت کنم.", "users-invalid");
        const request = prior ? `${prior.request}\nنام یا شناسهٔ موردنظر: ${text}` : text;
        const choices = this.lists.get(owner)?.choices ?? [];
        const plan = await this.planner(request, choices);
        this.awaiting.delete(owner);
        if (plan.operation === "clarify" || (["delete", "status", "role", "password"].includes(plan.operation) && !plan.id && !plan.target)) {
          if (this.awaiting.size >= 1000) return reply("درخواست‌های زیادی در انتظارند؛ کمی بعد دوباره تلاش کن.", "users-busy");
          this.awaiting.set(owner, { actor: context.actorId, session: this.fingerprint(context), expires: now + 300_000, request: text });
          return reply("نام دقیق یا شناسهٔ کاربر موردنظر را بفرست؛ اگر چند نفر هم‌نام باشند از تو می‌خواهم یکی را انتخاب کنی.");
        }
        if (plan.operation === "create") {
          if (this.flows.size >= 1000) return reply("درخواست‌های زیادی منتظرند؛ بعداً تلاش کن.", "users-busy");
          this.flows.set(owner, { actor: context.actorId, session: this.fingerprint(context), expires: now + 300_000, fields: { roleKey: "customer" } });
          return reply("**👤 ساخت حساب مشتری**\n\n۱. نام کامل کاربر را بفرست.\n↩️ انصراف: «لغو»");
        }
        let id = plan.id;
        if (id && !choices.some(choice => choice.id === id) && !text.includes(id)) return reply("کاربر انتخاب‌شده در فهرست معتبر این گفت‌وگو نیست؛ ابتدا نامش را برای جست‌وجو بفرست.", "users-invalid");
        if (plan.target && !id && /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(plan.target) && text.includes(plan.target)) id = plan.target;
        if (plan.target && !id) {
          const found = await this.api.execute({ operation: "list", input: { search: plan.target, perPage: 50 } }, context);
          const data = found.ok ? found.data as { items?: Array<{ id: string; fullName: string }>; total?: number } : null;
          if (!data || !Array.isArray(data.items)) return reply("جست‌وجوی کاربر انجام نشد؛ دوباره تلاش کن.", "users-error");
          const matches = data.items.filter(item => normalize(item.fullName) === normalize(plan.target!));
          if (matches.length !== 1 || data.total !== 1) {
            await this.run({ operation: "list", input: { search: plan.target, perPage: 50 } }, context, owner);
            if (this.awaiting.size >= 1000) return reply("درخواست‌های زیادی منتظرند؛ بعداً تلاش کن.", "users-busy");
            this.awaiting.set(owner, { actor: context.actorId, session: this.fingerprint(context), expires: now + 300_000, request });
            const options = data.items.map((item, index) => `• ${index + 1}. ${item.fullName} — شناسه: ${item.id}`).join("\n");
            return reply(`کاربر یکتایی انتخاب نشد؛ نام دقیق یا شناسهٔ یکی از موارد را بفرست:\n${options || "موردی پیدا نشد."}`);
          }
          id = matches[0]!.id;
        }
        if (plan.operation === "password") return reply("برای امنیت، رمز جدید را در درخواست هوش مصنوعی ننویس. برای بازنشانی بگو «رمز کاربر موردنظر را بازنشانی کن».", "users-help");
        if (plan.operation === "list") command = { operation: "list", input: {
          ...(plan.page ? this.lists.get(owner)?.query ?? {} : {}),
          ...(plan.search !== undefined ? { search: plan.search } : {}),
          ...(plan.status ? { status: plan.status } : {}), ...(plan.page ? { page: plan.page } : {}),
        } };
        else if (plan.operation === "bulk") {
          if (!plan.action || (!plan.all && !plan.ids?.length) || plan.ids?.some(id => !choices.some(choice => choice.id === id))) return reply("محدودهٔ عملیات مشخص نیست. بگو کدام کاربران و چه تغییری می‌خواهی.", "users-invalid");
          // “all of them” after a list means that visible selection, not the
          // whole database. Global filtered scope needs explicit user wording.
          if (plan.all && !/(?:همه|تمام|all).*(?:کاربر|users?)|(?:کاربر|users?).*(?:همه|تمام|all)/iu.test(text)) {
            plan.all = false;
            plan.ids = choices.map(choice => choice.id);
            if (!plan.ids.length) return reply("اول مشخص کن کدام کاربران را می‌خواهی تغییر دهی.", "users-invalid");
          }
          command = { operation: "bulk", input: { action: plan.action, scope: plan.all ? "filtered" : "page", ...(plan.all ? { filters: { ...(plan.status ? { status: plan.status } : {}), ...(plan.search ? { search: plan.search } : {}) } } : { ids: plan.ids }), ...(plan.roleKey ? { roleKey: plan.roleKey } : {}) } };
        } else if (plan.operation === "delete") command = { operation: "delete", id, input: {} };
        else if (plan.operation === "role") command = { operation: "role", id, input: { roleKey: plan.roleKey } };
        else command = { operation: "status", id, input: { ...(plan.isActive !== undefined ? { isActive: plan.isActive } : {}), ...(plan.isBanned !== undefined ? { isBanned: plan.isBanned } : {}) } };
      }
      validateUserCommand(command);
    } catch { return reply("نتوانستم درخواست را دقیق و معتبر آماده کنم. نام کاربر و تغییر موردنظر را روشن‌تر بگو؛ مثلاً «کاربر دوم را حذف کن». هیچ تغییری ارسال نشد.", "users-invalid"); }
    if (command.operation === "list") return this.run(command, context, owner);
    if (this.flows.size >= 1000) return reply("ظرفیت درخواست‌ها تکمیل است؛ بعداً تلاش کن.", "users-busy");
    this.flows.set(owner, { actor: context.actorId, session: this.fingerprint(context), expires: now + 300_000, command });
    // Safe summary: no password, email, phone, or arbitrary API text is echoed.
    const input = command.input as Record<string, unknown>;
    let scope = "";
    if (command.operation === "status") {
      scope = [input.isActive !== undefined ? `• وضعیت حساب: ${input.isActive ? "🟢 فعال" : "⚪ غیرفعال"}` : "", input.isBanned !== undefined ? `• مسدودی: ${input.isBanned ? "⛔ مسدود" : "✅ رفع مسدودی"}` : "", input.banReason ? `• دلیل: ${String(input.banReason)}` : ""].filter(Boolean).join("\n");
    } else if (command.operation === "role") scope = `• نقش جدید: ${String(input.roleKey)}`;
    else if (command.operation === "create") scope = `• نام: ${String(input.fullName)}\n• نقش: ${String(input.roleKey)}`;
    else if (command.operation === "bulk") scope = `• عملیات گروهی: ${String(input.action)}\n• محدوده: ${input.scope === "filtered" ? "تمام نتایج فیلترشده ⚠️" : "کاربران انتخاب‌شده"}\n${Array.isArray(input.ids) ? input.ids.map(id => `• شناسه: ${String(id)}`).join("\n") : ""}${input.filters ? `\n• فیلترها:\n${JSON.stringify(input.filters)}` : ""}${input.roleKey ? `\n• نقش: ${String(input.roleKey)}` : ""}`;
    return reply(`**🔎 بررسی و تأیید درخواست**\n\n• عملیات: ${operationLabels[command.operation]}${command.id ? `\n• شناسه: ${command.id}` : ""}${scope ? `\n${scope}` : ""}\n\n🔒 هنوز تغییری ارسال نشده است.\n✅ اجرا: «تأیید»\n↩️ انصراف: «لغو»\n⏳ مهلت تأیید: ۵ دقیقه`);
  }

  private async run(command: UserCommand, context: RuleRequestContext, owner?: string) {
    const result = await this.api.execute(command, context);
    if (!result.ok) return { status: "users-error", reply: `**⚠️ درخواست انجام نشد**\n\n• کد خطا: ${result.code}${result.status ? `\n• وضعیت سرویس: HTTP ${result.status}` : ""}\n\n🔎 پیش از تکرار، نتیجه را بررسی کن؛ در خطای شبکه ممکن است وضعیت اجرای درخواست مشخص نباشد.` };
    const data = result.data as Record<string, unknown> | null;
    if (command.operation === "list") {
      if (!data || !Array.isArray(data.items)) return { status: "users-error", reply: "ساختار پاسخ فهرست کاربران معتبر نیست." };
      if (owner) {
        if (this.lists.size >= 1000) this.lists.delete(this.lists.keys().next().value!);
        this.lists.set(owner, { actor: context.actorId, session: this.fingerprint(context), expires: this.now() + 300_000, query: validateUserCommand(command).input, choices: data.items.map((item: Record<string, unknown>) => ({ id: String(item.id), fullName: String(item.fullName ?? "") })) });
      }
      const lines = data.items.map((item: Record<string, unknown>, index: number) => {
        const status = item.isBanned ? "⛔ مسدود" : item.isActive ? "🟢 فعال" : "⚪ غیرفعال";
        const roles: Record<string, string> = { admin: "مدیر", customer: "مشتری", support: "پشتیبانی", moderator: "ناظر" };
        return [
          `**👤 ${index + 1}. ${String(item.fullName ?? "بدون نام")}**`,
          `• وضعیت: ${status}`,
          `• نقش: ${Array.isArray(item.roles) ? item.roles.map(role => roles[String(role)] ?? String(role)).join("، ") : "—"}`,
          `• ایمیل: ${String(item.email ?? "—")}`,
          `• تلفن: ${String(item.phone ?? "—")}`,
          `• شناسه: ${String(item.id ?? "—")}`,
          ...(item.createdAt ? [`• تاریخ ثبت: ${jalaliDate(String(item.createdAt))}`] : []),
          ...(item.lastLoginAt ? [`• آخرین ورود: ${jalaliDate(String(item.lastLoginAt))}`] : []),
        ].join("\n");
      });
      return { status: "users-listed", reply: `**👥 فهرست کاربران**\n\n📄 صفحه: ${String(data.page)}\n📊 تعداد کل: ${String(data.total)}\n\n${lines.join("\n\n") || "📭 کاربری با این مشخصات پیدا نشد."}\n\n➡️ برای صفحهٔ بعد بنویس «صفحه ${Number(data.page || 1) + 1} کاربران را نشان بده».` };
    }
    if (command.operation === "bulk") {
      // Temporary reset passwords are only delivered here, never to model/history/logs.
      const passwords = Array.isArray(data?.temporaryPasswords) ? data.temporaryPasswords.map((entry: { id: string; password: string }) => `${entry.id}: ${entry.password}`).join("\n") : "";
      const failures = Array.isArray(data?.failures) ? data.failures.map((entry: { id?: string; code?: string }) => `${String(entry.id)}: ${typeof entry.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(entry.code) ? entry.code : "OPERATION_FAILED"}`).join("\n") : "";
      return { status: "users-completed", reply: `**📋 نتیجهٔ عملیات گروهی**\n\n• 📥 درخواستی: ${String(data?.requested)}\n• ✅ موفق: ${String(data?.succeeded)}\n• ❌ ناموفق: ${Array.isArray(data?.failures) ? data.failures.length : "نامشخص"}${failures ? `\n\n⚠️ موارد ناموفق:\n${failures}` : ""}${passwords ? `\n\n🔐 رمزهای موقت — محرمانه\nدر ورود بعدی باید تغییر کنند.\n${passwords}` : ""}` };
    }
    const operations = operationLabels;
    return { status: "users-completed", reply: `**✅ عملیات با موفقیت انجام شد**\n\n• عملیات: ${operations[command.operation]}\n• نتیجه: تأییدشده توسط سرویس${command.operation === "create" && typeof data?.id === "string" ? `\n• شناسه: ${data.id}` : ""}` };
  }
}
