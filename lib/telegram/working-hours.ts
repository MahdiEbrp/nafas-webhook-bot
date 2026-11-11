import { createHash } from "node:crypto";
import { normalize } from "@/lib/text";
import { adminReadStatus, matchAdminReadRoute } from "./admin-read-intent";
import { isOtpLoginIntent } from "@/lib/auth/telegram-login";
import type { RuleRequestContext } from "@/lib/rules/types";
import { WorkingHoursApi, validateHoursCommand, type HoursCommand, type HourRow } from "@/lib/working-hours/api";
import { planHoursRequest, hoursPlanSchema, type HoursPlanner } from "@/lib/working-hours/planner";
import { createWorkingHourSchema } from "@/lib/working-hours/validation";

export const DAYS: Record<string, string> = { Saturday: "شنبه", Sunday: "یکشنبه", Monday: "دوشنبه", Tuesday: "سه‌شنبه", Wednesday: "چهارشنبه", Thursday: "پنجشنبه", Friday: "جمعه" };
export function isWorkingHoursRequest(text: string): boolean { return /ساع(?:ا)?ت\s*(?:کاری|کار)|برنامه\s*کاری|شیفت|الگوی\s*نوبت|working[ -]?hours/iu.test(normalize(text)); }
function deterministicHoursRead(text: string) {
  return matchAdminReadRoute(text, [{
    operation: "list" as const,
    when: /ساع(?:ا)?ت\s*(?:کاری|کار)|برنامه\s*کاری|شیفت|الگوی\s*نوبت|working[ -]?hours/iu,
    input: value => {
      const status = adminReadStatus(value, [
        { value: "inactive", when: /\b(?:inactive|disabled)\b|غیرفعال/iu },
        { value: "active", when: /\b(?:active|enabled)\b|فعال/iu },
      ]);
      const words = value.split(/[^\p{L}\p{N}]+/u);
      const day = Object.entries(DAYS).find(([english, persian]) => words.includes(english.toLowerCase()) || words.includes(normalize(persian).toLowerCase()))?.[0];
      return { ...(status ? { status } : {}), ...(day ? { search: day } : {}) };
    },
  }]);
}
type State = { actor: string; session: string; expires: number; rows: HourRow[]; query: Record<string, unknown>; command?: HoursCommand; snapshot?: HourRow; target?: HourRow; draft?: Record<string, unknown>; awaiting?: string };
export function hourCard(row: HourRow, index = 0): string {
  return `**🗓 ${index + 1}. ${DAYS[row.day] ?? row.day}**\n• ساعت شروع: ${row.opens}\n• ساعت پایان: ${row.closes}\n• ظرفیت: ${row.capacity}\n• وضعیت: ${row.isActive ? "🟢 فعال" : "⚪ غیرفعال"}\n• ترتیب نمایش: ${row.displayOrder}\n• شناسه: ${row.id}${row.slotCount !== undefined ? `\n• تعداد الگوهای نوبت: ${row.slotCount}` : ""}${row.patterns ? `\n${hoursFields({ patterns: row.patterns })}` : ""}`;
}
export function hoursFields(input: Record<string, unknown>): string {
  const labels: Record<string, string> = { day: "روز هفته", opens: "ساعت شروع", closes: "ساعت پایان", capacity: "ظرفیت", displayOrder: "ترتیب نمایش", isActive: "فعال" };
  const lines = Object.entries(labels).flatMap(([key, label]) => key in input ? [`• ${label}: ${key === "day" ? DAYS[String(input[key])] : typeof input[key] === "boolean" ? input[key] ? "بله" : "خیر" : String(input[key])}`] : []);
  if (Array.isArray(input.patterns)) {
    lines.push("⚠️ الگوهای نوبت با این فهرست به‌طور کامل جایگزین می‌شوند:");
    if (!input.patterns.length) lines.push("• بدون الگوی صریح (فهرست خالی)");
    for (const item of input.patterns as Array<{ startTime: string; capacity: number; groupIds?: string[] }>) lines.push(`• ساعت: ${item.startTime}؛ ظرفیت: ${item.capacity}\n• شناسه گروه‌ها: ${item.groupIds?.length ? item.groupIds.join("، ") : "تمام گروه‌ها"}`);
  }
  return lines.join("\n");
}
const HELP = "**🕒 مدیریت ساعات کاری**\n\n• «ساعات کاری را نشان بده»\n• «ساعات کاری جدید بساز»\n• «ساعت شروع شنبه را به ۹:۰۰ تغییر بده»\n• «ظرفیت ردیف دوم را ۳ کن»\n• «ساعات کاری جمعه را حذف کن»\n• «همه ساعات کاری غیرفعال را حذف کن»\n\n🔒 تغییرها فقط پس از «تأیید» اجرا می‌شوند. انصراف: «لغو».\nروزِ ردیف ثابت است؛ برای روز دیگری باید ردیف تازه ساخت.";
export class TelegramWorkingHours {
  private states = new Map<string, State>();
  constructor(private api = new WorkingHoursApi(), private planner: HoursPlanner = planHoursRequest, private now = Date.now) {}
  clear(owner: string) { this.states.delete(owner); }
  private signature(context: RuleRequestContext) { return createHash("sha256").update(context.sessionCookie).digest("hex"); }
  async handle(owner: string, text: string, context: RuleRequestContext | null, privateChat: boolean): Promise<{ reply: string; status: string } | null> {
    const current = this.states.get(owner);
    const expired = Boolean(current && current.expires <= this.now());
    for (const [key, state] of this.states) if (state.expires <= this.now()) this.states.delete(key);
    let state = this.states.get(owner);
    const value = normalize(text);
    const explicit = isWorkingHoursRequest(value);
    const follows = state && (state.command || state.draft || state.awaiting || /حذف|پاک|فعال|ویرایش|تغییر|ظرفیت|ردیف|اول|دوم|سوم|چهارم|پنجم|صفحه|الگو|لغو|next|delete|remove|edit|activate|capacity|first|second|pattern/iu.test(value));
    if (isOtpLoginIntent(text) || /^\/(?:clear|reset|new)\b/iu.test(text)) { this.clear(owner); return null; }
    if (!explicit && !follows && !(expired && /^(?:بله|تایید|تأیید|yes|confirm)$/iu.test(value))) return null;
    const reply = (message: string, status = "hours-pending") => ({ reply: message, status });
    if (!privateChat) return reply("🔐 مدیریت ساعات کاری فقط در گفت‌وگوی خصوصی ربات مجاز است.", "hours-private-only");
    if (!context?.actorId.trim() || !context.sessionCookie.trim()) { this.clear(owner); return reply("🔐 ابتدا در خصوصی بنویس «می‌خواهم لاگین کنم». هیچ تغییری ارسال نشده است.", "hours-auth-required"); }
    if (expired && !explicit) return reply("⏳ زمان درخواست تمام شد؛ ساعات کاری را دوباره بخواه و درخواست را از نو شروع کن.", "hours-expired");
    if (state && (state.actor !== context.actorId || state.session !== this.signature(context))) { this.clear(owner); return reply("🔐 نشست تغییر کرده؛ درخواست ساعات کاری را دوباره شروع کن.", "hours-session-changed"); }
    if (/^(لغو|cancel|\/cancel)$/iu.test(value)) { this.clear(owner); return reply("↩️ درخواست ساعات کاری لغو شد؛ تغییری ارسال نشد.", "hours-cancelled"); }
    if (!state) {
      if (this.states.size >= 1000) return reply("⏳ درخواست‌های زیادی در انتظارند؛ کمی بعد تلاش کن.", "hours-busy");
      state = { actor: context.actorId, session: this.signature(context), expires: this.now() + 300_000, rows: [], query: {} };
      this.states.set(owner, state);
    }
    if (state.command) {
      if (!/^(بله|تایید|تأیید|yes|confirm)$/iu.test(value)) return reply("🔎 تغییر قبلی منتظر پاسخ است. برای اجرا «تأیید» و برای کنارگذاشتن «لغو» بفرست.");
      const command = state.command, snapshot = state.snapshot;
      state.command = undefined; state.snapshot = undefined; // single use before network
      if (command.operation === "update" && snapshot) {
        const latest = await this.api.execute({ operation: "get", id: command.id, input: {} }, context);
        if (!latest.ok || JSON.stringify(latest.data) !== JSON.stringify(snapshot)) return reply("⚠️ اطلاعات ساعات کاری عوض شده یا بازخوانی نشد؛ دوباره آن را بررسی و درخواست کن.", "hours-conflict");
      }
      return this.run(command, state, context);
    }
    if (state.draft) {
      const field = ["day", "opens", "closes", "capacity"].find(key => !(key in state!.draft!))!;
      let input: unknown = value;
      if (field === "day") input = Object.keys(DAYS).find(day => normalize(DAYS[day]!).replace(/\s/g, "") === value.replace(/\s/g, "") || day.toLowerCase() === value.toLowerCase()) ?? value;
      if ((field === "opens" || field === "closes") && /^\d{1,2}(?::\d{1,2})?$/u.test(value)) {
        const [hour, minute = "00"] = value.split(":");
        input = `${hour!.padStart(2, "0")}:${minute.padStart(2, "0")}`;
      }
      if (field === "capacity") input = value === "پیشفرض" || value === "پیش فرض" ? 1 : Number(value);
      const schema = createWorkingHourSchema.shape[field as "day" | "opens" | "closes" | "capacity"];
      const parsed = schema.safeParse(input);
      if (!parsed.success) return reply("⚠️ مقدار معتبر نیست. روز هفته، ساعت با قالب ۰۹:۰۰ یا ظرفیت عددی بین ۱ و ۵۰۰ را مطابق سؤال بفرست.");
      if (field === "closes" && String(input) <= String(state.draft.opens)) return reply("⚠️ ساعت پایان باید بعد از شروع و در همان روز باشد؛ ساعت پایان را دوباره بفرست.");
      state.draft[field] = parsed.data;
      const next = ["day", "opens", "closes", "capacity"].find(key => !(key in state!.draft!));
      if (next) return reply(this.prompt(next));
      const command: HoursCommand = { operation: "create", input: state.draft };
      state.draft = undefined;
      return this.propose(command, state);
    }
    if (/(?:ساع(?:ا)?ت|برنامه).*(?:بساز|ایجاد|جدید|اضافه)|(?:ساخت|افزودن).*(?:ساع(?:ا)?ت|برنامه)/iu.test(value)) { state.draft = {}; return reply(this.prompt("day")); }
    const directRead = deterministicHoursRead(text);
    if (directRead) {
      state.awaiting = undefined;
      return this.run({ operation: "list", input: directRead.input }, state, context);
    }
    try {
      const plan = hoursPlanSchema.parse(await this.planner(state.awaiting ? `${state.awaiting}\nتوضیح یا انتخاب کاربر: ${text}` : text, state.rows, state.query));
      if (plan.operation === "clarify") { state.awaiting = text; return reply(`${HELP}\n\n🔎 روز، ردیف یا تغییر موردنظر را دقیق‌تر بگو.`); }
      state.awaiting = undefined;
      if (plan.operation === "start") { state.draft = {}; return reply(this.prompt("day")); }
      let id = plan.id;
      if (id && !state.rows.some(row => row.id === id) && !text.includes(id)) return reply("🔎 ابتدا فهرست ساعات کاری را بخواه یا شناسهٔ دقیق را بفرست؛ شناسه را حدس نمی‌زنم.", "hours-invalid");
      if (["get", "update", "delete"].includes(plan.operation) && !id && plan.day) {
        const found = await this.api.execute({ operation: "list", input: { search: plan.day, perPage: 100 } }, context);
        if (!found.ok) return this.failure(found.code, found.status);
        const rows = (found.data as { items: HourRow[] }).items.filter(row => row.day === plan.day);
        if (rows.length !== 1) return reply("🔎 برای این روز یک ردیف یکتا پیدا نشد؛ فهرست را بررسی کن و روز یا شناسهٔ دقیق را بگو.", "hours-invalid");
        id = rows[0]!.id;
      }
      if (["get", "update", "delete"].includes(plan.operation) && !id) { state.awaiting = text; return reply("🔎 کدام روز یا ردیف ساعات کاری را می‌گویی؟ نام روز یا شناسهٔ دقیقش را بفرست."); }
      const command: HoursCommand = { operation: plan.operation, id, input: plan.input };
      if (command.operation === "list" && plan.input.page !== undefined) command.input = { ...state.query, ...plan.input };
      if (command.operation === "bulk") {
        let input = plan.input;
        if (input.scope === "filtered" && !/(?:همه|تمام|all).*(?:ساعت|ساعات|برنامه|working)|(?:ساعت|ساعات|برنامه|working).*(?:همه|تمام|all)/iu.test(value)) input = { action: input.action, scope: "page", ids: state.rows.map(row => row.id) };
        if (Array.isArray(input.ids) && input.ids.some(id => !state!.rows.some(row => row.id === id) && !text.includes(String(id)))) return reply("🔎 فقط ردیف‌های همین فهرست یا شناسه‌های صریح را می‌توان انتخاب کرد.", "hours-invalid");
        command.input = input;
      }
      const valid = validateHoursCommand(command);
      command.input = valid.input;
      if (command.operation === "get" || command.operation === "list") return this.run(command, state, context);
      if (Array.isArray(valid.input.patterns) && valid.input.patterns.some((pattern: { groupIds?: string[] }) => pattern.groupIds?.some(id => !text.includes(id)))) return reply("🔎 شناسهٔ گروه خدمات را باید خودت دقیق بفرستی؛ گروهی را حدس نمی‌زنم.", "hours-invalid");
      if (command.operation === "update" || command.operation === "delete") {
        const current = await this.api.execute({ operation: "get", id, input: {} }, context);
        if (!current.ok) return this.failure(current.code, current.status);
        const row = current.data as HourRow;
        state.target = row;
        if (command.operation === "update") {
          createWorkingHourSchema.parse({ day: row.day, opens: row.opens, closes: row.closes, ...valid.input });
          state.snapshot = row;
        }
      }
      return this.propose(command, state);
    } catch { return reply("⚠️ درخواست معتبر و دقیقی آماده نشد. روز، ساعت و تغییر موردنظر را روشن‌تر بگو؛ روزِ یک ردیف قابل تغییر نیست. هیچ تغییری ارسال نشد.", "hours-invalid"); }
  }
  private prompt(field: string) {
    const prompts: Record<string, string> = { day: "۱. روز هفته را بفرست؛ مثلاً شنبه.", opens: "۲. ساعت شروع را با قالب ۰۹:۰۰ بفرست.", closes: "۳. ساعت پایان را با قالب ۱۷:۰۰ بفرست؛ باید بعد از شروع باشد.", capacity: "۴. ظرفیت را بفرست (۱ تا ۵۰۰)؛ برای ظرفیت ۱ بنویس «پیش‌فرض»." };
    return `**🕒 ساخت ساعات کاری**\n\n${prompts[field]}\n\n🔒 هنوز تغییری انجام نشده. انصراف: «لغو»\n⏳ اعتبار: ۵ دقیقه`;
  }
  private propose(command: HoursCommand, state: State) {
    command.input = validateHoursCommand(command).input;
    state.command = command;
    const input = command.input as Record<string, unknown>;
    const names = { create: "ساخت ساعات کاری", update: "ویرایش ساعات کاری", delete: "حذف ساعات کاری", bulk: "عملیات گروهی", get: "خواندن", list: "فهرست" };
    const details = command.operation === "bulk" ? `• عملیات گروهی: ${{ activate: "فعال‌سازی", deactivate: "غیرفعال‌سازی", delete: "حذف" }[String(input.action) as "activate"]}\n• محدوده: ${input.scope === "filtered" ? "⚠️ تمام نتایج مطابق فیلتر" : "ردیف‌های انتخاب‌شده"}\n${Array.isArray(input.ids) ? input.ids.map(id => `• شناسه: ${String(id)}`).join("\n") : `• فیلترها:\n${JSON.stringify(input.filters ?? {})}`}` : hoursFields(input);
    return { status: "hours-proposed", reply: `**🔎 تأیید تغییر ساعات کاری**\n\n• عملیات: ${names[command.operation]}${command.id ? `\n• شناسه: ${command.id}` : ""}${state.target && command.id === state.target.id ? `\n• روز: ${DAYS[state.target.day]}\n• بازهٔ فعلی: ${state.target.opens} تا ${state.target.closes}` : ""}\n${details}${command.operation === "delete" || command.operation === "bulk" && input.action === "delete" ? "\n⚠️ حذف شامل الگوهای نوبت وابسته نیز می‌شود." : ""}\n\n🔒 هنوز چیزی ارسال نشده.\n✅ اجرا: «تأیید»\n↩️ انصراف: «لغو»\n⏳ اعتبار: ۵ دقیقه` };
  }
  private failure(code: string, status?: number) { return { status: "hours-error", reply: `**⚠️ درخواست ساعات کاری تأیید نشد**\n\n• کد: ${code}${status ? `\n• وضعیت سرویس: ${status}` : ""}\n🔎 در خطای شبکه، نتیجهٔ اجرا ممکن است نامشخص باشد؛ بدون بررسی دوباره تکرار نکن.` }; }
  private async run(command: HoursCommand, state: State, context: RuleRequestContext) {
    const result = await this.api.execute(command, context);
    if (!result.ok) return this.failure(result.code, result.status);
    if (command.operation === "list") {
      const data = result.data as { items: HourRow[]; page: number; total: number };
      state.rows = data.items; state.query = validateHoursCommand(command).input;
      return { status: "hours-listed", reply: `**🕒 ساعات کاری کلینیک**\n\n📄 صفحه: ${data.page}\n📊 تعداد کل: ${data.total}\n\n${data.items.map(hourCard).join("\n\n") || "📭 ساعات کاری پیدا نشد."}\n\n💬 مثلاً بگو «ساعت شروع ردیف اول را تغییر بده» یا «ساعات کاری جمعه را حذف کن».` };
    }
    if (command.operation === "get") { const row = result.data as HourRow; state.rows = [row]; return { status: "hours-read", reply: hourCard(row) }; }
    state.rows = [];
    if (command.operation === "bulk") {
      const data = result.data as { requested: number; succeeded: number; failures: { id: string; code: string }[] };
      return { status: "hours-completed", reply: `**📋 نتیجهٔ عملیات گروهی ساعات کاری**\n\n• درخواستی: ${data.requested}\n• ✅ موفق: ${data.succeeded}\n• ❌ ناموفق: ${data.failures.length}${data.failures.length ? `\n${data.failures.map(item => `• شناسه: ${item.id}؛ کد: ${/^[A-Z][A-Z0-9_]{0,63}$/.test(item.code) ? item.code : "OPERATION_FAILED"}`).join("\n")}` : ""}` };
    }
    return { status: "hours-completed", reply: `**✅ تغییر ساعات کاری انجام شد**\n\n${command.operation === "delete" ? "🗑 حذف ردیف توسط سرویس تأیید شد." : hourCard(result.data as HourRow)}` };
  }
}
