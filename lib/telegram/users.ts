import { createHash } from "node:crypto";
import { isOtpLoginIntent } from "@/lib/auth/telegram-login";
import { jalaliDate } from "./format";
import { normalize } from "@/lib/text";
import type { RuleRequestContext } from "@/lib/rules/types";
import { ClinicUsersApi, validateUserCommand, type UserCommand } from "@/lib/users/clinic-api";
import { createUserSchema } from "@/lib/users/clinic-validation";

type Flow = { actor: string; session: string; expires: number; fields?: Record<string, string>; command?: UserCommand };
const operationLabels = { list: "فهرست کاربران", create: "ساخت کاربر", status: "تغییر وضعیت کاربر", role: "تغییر نقش", password: "تغییر رمز عبور", delete: "حذف کاربر", bulk: "عملیات گروهی" };
const fields = ["fullName", "email", "phone", "password", "roleKey"] as const;
const labels = { fullName: "نام کامل", email: "ایمیل", phone: "شماره تماس", password: "رمز عبور (۸ تا ۱۲۸ نویسه، شامل حروف بزرگ و کوچک انگلیسی، رقم و علامت)", roleKey: "کلید نقش مجاز (roleKey)" };
export const USERS_HELP = `**👥 راهنمای مدیریت کاربران**

🔐 مدیریت کاربران فقط در خصوصی و با نشست مجاز انجام می‌شود. برای ساخت بنویس «کاربر جدید بساز» یا از فرمان‌های زیر استفاده کن؛ هر تغییر پیش از اجرا تأیید می‌خواهد.
/users list {"page":1,"perPage":10,"search":"","status":"all"}
/users create {"fullName":"…","email":"…","phone":"…","password":"…","roleKey":"…"}
/users status UUID {"isActive":false,"isBanned":false}
/users role UUID {"roleKey":"…"}
/users password UUID {"password":"…","confirmPassword":"…"}
/users delete UUID
/users bulk {"action":"activate","scope":"page","ids":["UUID"]}
عملیات گروهی: activate، deactivate، ban، unban، change-role، delete، reset-password. برای scope=filtered از filters شامل search/status/role استفاده کن. تغییر نام، ایمیل و تلفن و خواندن تکی با شناسه در API مرجع موجود نیست. لغو: «لغو».`;

export function isUserManagementMessage(text: string): boolean {
  return /^\/users(?:\s|$)/iu.test(text) || /کاربر|کاربران|حساب کاربری|\busers?\b/iu.test(normalize(text))
    && /بساز|ساخت|ایجاد|جدید|لیست|فهرست|نمایش|نشون|نشان|حذف|ویرایش|تغییر|مسدود|فعال|create|new|list|show|delete|edit|update|block/iu.test(normalize(text));
}

/** Passwords and account data stay out of model history and logs. Flows are
 * actor/session-bound, capped and expire; no cookies are retained in the map.
 * Process-local flows fail closed across cold starts (no durable guarantees).
 */
export class TelegramUsers {
  private flows = new Map<string, Flow>();
  constructor(private api = new ClinicUsersApi(), private now = Date.now) {}
  private fingerprint(context: RuleRequestContext): string { return createHash("sha256").update(context.sessionCookie).digest("hex"); }

  async handle(owner: string, text: string, context: RuleRequestContext | null, privateChat: boolean): Promise<{ reply: string; status: string } | null> {
    const now = this.now();
    for (const [key, flow] of this.flows) if (flow.expires <= now) this.flows.delete(key);
    const value = normalize(text);
    let flow = this.flows.get(owner);
    const details = /^(?:نام|نام کامل|ایمیل|شماره تماس|تلفن|رمز عبور|نقش|name|email|phone|password)\s*[:：]/iu.test(value);
    if (flow && (isOtpLoginIntent(text) || /^\/(?:clear|reset|new)\b/iu.test(text))) {
      this.flows.delete(owner);
      return null;
    }
    if (!flow && !isUserManagementMessage(text) && !details) return null;
    const reply = (message: string, status = "users-pending") => ({
      reply: message.startsWith("**") ? message : `${status === "users-cancelled" ? "**↩️ عملیات لغو شد**" : /required|invalid|changed|busy|only/u.test(status) ? "**🔔 راهنمای درخواست**" : "**📝 مدیریت کاربران**"}\n\n${message}`,
      status,
    });
    if (!privateChat) return reply("مدیریت کاربران فقط در گفت‌وگوی خصوصی ربات مجاز است. اطلاعات شخصی یا رمز را اینجا نفرست.", "users-private-only");
    if (/^(لغو|cancel|\/cancel)$/iu.test(value)) { this.flows.delete(owner); return reply("عملیات کاربران لغو شد؛ تغییری ارسال نشد.", "users-cancelled"); }
    if (!context) { this.flows.delete(owner); return reply("برای مدیریت کاربران ابتدا در خصوصی بنویس «می‌خواهم لاگین کنم». هیچ اطلاعاتی ذخیره یا تغییری ارسال نشد.", "users-auth-required"); }
    if (flow && (flow.actor !== context.actorId || flow.session !== this.fingerprint(context))) {
      this.flows.delete(owner); return reply("نشست تغییر کرده است؛ درخواست را دوباره شروع کن.", "users-session-changed");
    }
    if (/^\/users\s+help$/iu.test(text)) return reply(USERS_HELP, "users-help");
    // A new explicit command discards the old proposal, never implicitly confirms it.
    if (isUserManagementMessage(text)) { this.flows.delete(owner); flow = undefined; }
    if (flow?.command) {
      if (!/^(تایید|تأیید|بله|confirm|yes)$/iu.test(value)) return reply("برای اجرای پیشنهاد «تأیید» و برای کنارگذاشتن «لغو» را بفرست.");
      this.flows.delete(owner); // single-use, removed before awaiting network
      return this.run(flow.command, context);
    }
    if (!flow && /(?:کاربر.*(?:بساز|ایجاد|جدید)|(?:create|new).*user)/iu.test(value) && !text.startsWith("/users")) {
      if (this.flows.size >= 1000) return reply("ظرفیت درخواست‌های منتظر تکمیل است؛ بعداً تلاش کن.", "users-busy");
      flow = { actor: context.actorId, session: this.fingerprint(context), expires: now + 300_000, fields: {} };
      this.flows.set(owner, flow);
      return reply(`**👤 ساخت کاربر جدید**\n\n📝 ${labels.fullName} را بفرست.\n\n🔒 هنوز تغییری انجام نشده.\n↩️ انصراف: «لغو»`);
    }
    if (flow?.fields) {
      const field = fields.find(key => flow!.fields![key] === undefined)!;
      // Preserve passwords exactly, normalize only non-secret field digits/labels.
      const input = field === "password" ? text : value.replace(/^[^:：]{1,24}[:：]\s*/u, "");
      const parsed = createUserSchema.shape[field].safeParse(input);
      if (!parsed.success) return reply(`مقدار ${labels[field]} معتبر نیست؛ دوباره بفرست. مقدار قبلی ذخیره نشد.`);
      flow.fields[field] = parsed.data;
      const next = fields.find(key => flow!.fields![key] === undefined);
      if (next) return reply(`**📝 تکمیل مشخصات کاربر**\n\n• مرحله: ${fields.indexOf(next) + 1} از ${fields.length}\n• اطلاعات موردنیاز: ${labels[next]}\n\n↩️ انصراف: «لغو»`);
      const command: UserCommand = { operation: "create", input: { ...flow.fields } };
      flow.fields = undefined;
      flow.command = command;
      return reply(`نام: ${String((command.input as Record<string, unknown>).fullName)}؛ نقش: ${String((command.input as Record<string, unknown>).roleKey)}\nاطلاعات ساخت کاربر آماده است. هنوز چیزی ارسال نشده؛ برای ایجاد حساب «تأیید» و برای انصراف «لغو» را بفرست.`);
    }
    let command: UserCommand;
    try {
      const match = text.match(/^\/users\s+(list|create|status|role|password|delete|bulk)(?:\s+([0-9a-f-]{36}))?(?:\s+(\{[\s\S]*\}))?\s*$/iu);
      if (match) command = { operation: match[1]!.toLowerCase() as UserCommand["operation"], id: match[2], input: match[3] ? JSON.parse(match[3]) : {} };
      else if (/(?:لیست|فهرست|نشون|نمایش|نشان|list|show)/iu.test(value) && isUserManagementMessage(text)) command = { operation: "list", input: {} };
      else return reply(USERS_HELP, "users-help");
      validateUserCommand(command);
    } catch { return reply("فرمان، شناسه یا فیلدها معتبر نیستند. /users help را ببین. مقدار ورودی ذخیره نشد.", "users-invalid"); }
    if (command.operation === "list") return this.run(command, context);
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

  private async run(command: UserCommand, context: RuleRequestContext) {
    const result = await this.api.execute(command, context);
    if (!result.ok) return { status: "users-error", reply: `**⚠️ درخواست انجام نشد**\n\n• کد خطا: ${result.code}${result.status ? `\n• وضعیت سرویس: HTTP ${result.status}` : ""}\n\n🔎 پیش از تکرار، نتیجه را بررسی کن؛ در خطای شبکه ممکن است وضعیت اجرای درخواست مشخص نباشد.` };
    const data = result.data as Record<string, unknown> | null;
    if (command.operation === "list") {
      if (!data || !Array.isArray(data.items)) return { status: "users-error", reply: "ساختار پاسخ فهرست کاربران معتبر نیست." };
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
      return { status: "users-listed", reply: `**👥 فهرست کاربران**\n\n📄 صفحه: ${String(data.page)}\n📊 تعداد کل: ${String(data.total)}\n\n${lines.join("\n\n") || "📭 کاربری با این مشخصات پیدا نشد."}\n\n➡️ فرمان صفحهٔ بعد:\n/users list ${JSON.stringify({ ...validateUserCommand(command).input, page: Number(data.page || 1) + 1 })}` };
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
