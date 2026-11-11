import { createHash } from "node:crypto";
import { normalize } from "@/lib/text";
import { adminReadStatus, matchAdminReadRoute } from "./admin-read-intent";
import { isOtpLoginIntent } from "@/lib/auth/telegram-login";
import type { RuleRequestContext } from "@/lib/rules/types";
import { SettingsAdminApi, validateSettingCommand, type AdminSetting, type SettingCommand } from "@/lib/settings-admin/api";
import { planSettingRequest, settingPlanSchema, type SettingPlanner } from "@/lib/settings-admin/planner";
import { explainSetting, settingFieldsHelp, settingsGuide, sensitiveSetting } from "@/lib/settings-admin/help";
import { jalaliDate } from "./format";

type State = { actor: string; session: string; expires: number; rows: AdminSetting[]; query: Record<string, unknown>; command?: SettingCommand; snapshot?: AdminSetting; draft?: "create" | "edit"; target?: AdminSetting; awaiting?: string };
export function isSettingsAdminRequest(text: string) { return /تنظیمات|تنظیم\s+(?:سیستم|سامانه|سایت|رزرو|کلینیک|جدید|بساز|ایجاد|[a-f0-9]{8}-)|\bsettings\b|\b(?:booking|contact|clinic|pricing)\.[a-z_]+/iu.test(normalize(text)) && !/تنظیمات.*(?:پیامک|سرویس پیامک|sms)/iu.test(normalize(text)); }
const display = (value: unknown) => JSON.stringify(value, null, 2) ?? "تعریف‌نشده";
function deterministicSettingRead(text: string) {
  return matchAdminReadRoute(text, [{
    operation: "list" as const,
    when: /تنظیمات?|\bsettings?\b|\b(?:booking|contact|clinic|pricing)\.[a-z_]+/iu,
    input: value => {
      const status = adminReadStatus(value, [
        { value: "inactive", when: /\b(?:inactive|disabled)\b|غیرفعال/iu },
        { value: "active", when: /\b(?:active|enabled)\b|فعال/iu },
      ]);
      const key = value.match(/\b[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_.-]*)+\b/iu)?.[0];
      return { ...(status ? { status } : {}), ...(key ? { search: key } : {}) };
    },
  }]);
}
export function settingCard(row: AdminSetting, index = 0) {
  const hidden = sensitiveSetting(row.key);
  return `**⚙️ ${index + 1}. ${row.key}**\n💡 کاربرد: ${explainSetting(row.key)}\n• نوع: ${row.type ?? "نامشخص"}\n• مقدار پایه:\n${hidden ? "🔒 مقدار محرمانه نمایش داده نمی‌شود" : display(row.value)}\n• ترجمه‌ها:\n${hidden ? "🔒 پنهان" : display(row.translations)}\n• وضعیت: ${row.isActive ? "فعال" : "غیرفعال"}\n• ترتیب: ${row.displayOrder}\n• شناسه: ${row.id}\n• آخرین تغییر: ${jalaliDate(row.updatedAt)}`;
}
const formHelp = (kind: "create" | "edit", target?: AdminSetting) => `**⚙️ ${kind === "create" ? "ساخت تنظیم" : `ویرایش ${target?.key}`}**\n\n${target ? `💡 ${explainSetting(target.key)}\n\n` : ""}${kind === "create" ? 'کلید، نوع و مقدار دقیق را در JSON بفرست؛ مثلاً {"key":"custom.notice","type":"string","value":"متن دلخواه"}. برای localized علاوه بر translations مقدار پایهٔ value را هم وارد کن.' : 'برای متن، عدد یا روشن/خاموش، مقدار جدید را مستقیم بفرست. برای وضعیت بنویس «وضعیت فعال» یا «وضعیت غیرفعال». تغییرات پیچیده را در JSON بفرست؛ مثلاً {"value":30} یا {"isActive":false}. کلید و نوع قابل تغییر نیستند. برای translations هر دو زبان موردنیاز را کامل بفرست؛ زبان حذف‌شده از ورودی پاک می‌شود.'}\n\n${settingFieldsHelp}\n\n🔐 مقدار وارد مدل یا تاریخچه نمی‌شود؛ پیام مقدار بعد از دریافت حذف می‌شود. تا «تأیید» تغییری اجرا نمی‌شود. انصراف: «لغو». اعتبار: ۵ دقیقه.`;
export class TelegramSettingsAdmin {
  private states = new Map<string, State>();
  constructor(private api = new SettingsAdminApi(), private planner: SettingPlanner = planSettingRequest, private now = Date.now) {}
  clear(owner: string) { this.states.delete(owner); }
  isCollecting(owner: string) { const state = this.states.get(owner); return Boolean(state?.draft && state.expires > this.now()); }
  private signature(context: RuleRequestContext) { return createHash("sha256").update(context.sessionCookie).digest("hex"); }
  async handle(owner: string, text: string, context: RuleRequestContext | null, privateChat: boolean): Promise<{ reply: string; status: string; deleteSensitiveMessage?: boolean } | null> {
    const previous = this.states.get(owner), expired = Boolean(previous && previous.expires <= this.now());
    for (const [key, state] of this.states) if (state.expires <= this.now()) this.states.delete(key);
    let state = this.states.get(owner);
    const value = normalize(text), explicit = isSettingsAdminRequest(text);
    if (!state?.draft && (isOtpLoginIntent(text) || /^\/(?:clear|reset|new)\b/iu.test(text))) { this.clear(owner); return null; }
    const follows = state && (state.command || state.draft || state.awaiting || /اول|دوم|سوم|صفحه|کاربرد|توضیح|حذف|ویرایش|تغییر|فعال|لغو|next|delete|edit/iu.test(value));
    if (!explicit && !follows && !(expired && /^(بله|تایید|تأیید|confirm|yes)$/iu.test(value))) return null;
    const localValue = Boolean(state?.draft || previous?.draft && expired) || /[{}]|(?:password|token|secret|رمز|توکن)\s*[:=]/iu.test(text);
    const reply = (message: string, status = "settings-pending") => ({ reply: message, status, ...(localValue ? { deleteSensitiveMessage: true } : {}) });
    if (!privateChat) return reply("🔐 مدیریت تنظیمات فقط در گفت‌وگوی خصوصی مجاز است.", "settings-private-only");
    if (!context?.actorId.trim() || !context.sessionCookie.trim()) { this.clear(owner); return reply("🔐 ابتدا در خصوصی وارد حساب مجاز شو؛ درخواستی به تنظیمات ارسال نشد.", "settings-auth-required"); }
    if (expired && !explicit) return reply("⏳ زمان درخواست تنظیمات تمام شده؛ از ابتدا شروع کن.", "settings-expired");
    if (state && (state.actor !== context.actorId || state.session !== this.signature(context))) { this.clear(owner); return reply("🔐 نشست عوض شده؛ درخواست تنظیمات را از ابتدا شروع کن.", "settings-session-changed"); }
    if (/^(لغو|cancel|\/cancel)$/iu.test(value)) { this.clear(owner); return reply("↩️ درخواست تنظیمات لغو شد.", "settings-cancelled"); }
    if (!state) {
      if (this.states.size >= 200) return reply("⏳ درخواست‌های زیادی در انتظارند؛ بعداً تلاش کن.", "settings-busy");
      state = { actor: context.actorId, session: this.signature(context), expires: this.now() + 300_000, rows: [], query: {} }; this.states.set(owner, state);
    }
    if (state.command) {
      if (!/^(بله|تایید|تأیید|confirm|yes)$/iu.test(value)) return reply("🔎 تغییر قبلی منتظر است؛ فقط «تأیید» یا «لغو» را بفرست.");
      const command = state.command, snapshot = state.snapshot; state.command = undefined; state.snapshot = undefined;
      if (snapshot && ["update", "delete"].includes(command.operation)) {
        const latest = await this.api.execute({ operation: "get", id: snapshot.id, input: {} }, context);
        if (!latest.ok || JSON.stringify(latest.data) !== JSON.stringify(snapshot)) return reply("⚠️ تنظیم تغییر کرده یا بازخوانی نشد؛ درخواست را دوباره آماده کن.", "settings-conflict");
      }
      return this.run(command, state, context);
    }
    if (state.draft) {
      try {
        const kind = state.draft;
        let parsed: unknown;
        if (kind === "edit" && /^(وضعیت فعال|وضعیت غیرفعال)$/u.test(value)) parsed = { isActive: value === "وضعیت فعال" };
        else if (kind === "edit" && state.target?.type === "string" && !text.trim().startsWith("{")) parsed = { value: text };
        else if (kind === "edit" && state.target?.type === "boolean" && /^(روشن|خاموش|بله|خیر)$/u.test(value)) parsed = { value: /^(روشن|بله)$/u.test(value) };
        else {
          parsed = JSON.parse(kind === "edit" && state.target?.type === "number" ? value : text);
          if (kind === "edit" && (typeof parsed !== "object" || Array.isArray(parsed))) parsed = { value: parsed };
        }
        const command: SettingCommand = { operation: kind === "create" ? "create" : "update", id: state.target?.id, input: parsed };
        command.input = validateSettingCommand(command).input;
        const input = command.input as Record<string, unknown>;
        const type = kind === "create" ? String(input.type) : state.target?.type;
        if (kind === "create" && type === "localized" && input.value === undefined) return reply("⚠️ برای سازگاری با ستون NOT NULL مرجع، مقدار پایهٔ value را همراه ترجمه‌ها بفرست.", "settings-invalid");
        if (input.value !== undefined && type && type !== "localized") {
          const actual = Array.isArray(input.value) ? "array" : typeof input.value;
          if (actual !== type) return reply(`⚠️ مقدار باید از نوع ${type} باشد؛ تبدیل خودکار انجام نمی‌دهم.`, "settings-invalid");
        }
        state.draft = undefined;
        return { ...this.propose(command, state), deleteSensitiveMessage: true };
      } catch { return reply("⚠️ JSON معتبر با فیلدهای مجاز لازم است؛ null، تغییر key/type، و ویرایش خالی مجاز نیست. دوباره بفرست یا «لغو» کن.", "settings-invalid"); }
    }
    if (localValue || /https?:\/\/|\b\d{7,}\b/u.test(text.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/giu, ""))) return reply("🔐 مقدار را در درخواست آزاد نفرست؛ ابتدا بگو «تنظیم موردنظر را ویرایش کن» تا مقدار به‌صورت محلی و بدون مدل دریافت شود.", "settings-invalid");
    if (/راهنما|توضیح.*همه|همه.*توضیح|هر تنظیم|چه.*کار|help/iu.test(value) && !/\b(?:booking|contact|clinic|pricing)\./u.test(value)) return reply(settingsGuide(), "settings-help");
    if (/(?:تنظیم).*?(?:بساز|جدید|ایجاد)|(?:ساخت|ایجاد).*تنظیم/iu.test(value)) { state.draft = "create"; state.target = undefined; return reply(formHelp("create")); }
    const directRead = deterministicSettingRead(text);
    if (directRead) {
      state.awaiting = undefined;
      return this.run({ operation: "list", input: directRead.input }, state, context);
    }
    try {
      const plan = settingPlanSchema.parse(await this.planner(state.awaiting ? `${state.awaiting}\nانتخاب: ${text}` : text, state.rows.map(row => ({ id: row.id, key: row.key, type: row.type })), state.query));
      if (plan.operation === "help") return reply(settingsGuide(), "settings-help");
      if (plan.operation === "clarify") { state.awaiting = text; return reply("🔎 کلید یا شمارهٔ ردیف را مشخص کن؛ مثلاً «تنظیم booking.reminder_hours را توضیح بده» یا «تنظیم دوم را ویرایش کن»."); }
      state.awaiting = undefined;
      if (plan.operation === "create") { state.draft = "create"; state.target = undefined; return reply(formHelp("create")); }
      let id = plan.id;
      if (id && !state.rows.some(row => row.id === id) && !text.includes(id)) return reply("🔎 شناسه را حدس نمی‌زنم؛ فهرست یا شناسهٔ دقیق را بفرست.", "settings-invalid");
      if (["get", "explain", "edit", "delete"].includes(plan.operation)) {
        if (!id && plan.target) {
          if (plan.operation === "explain" && /\./.test(plan.target) && text.includes(plan.target)) return reply(`**💡 ${plan.target}**\n\n${explainSetting(plan.target)}\n\n${settingFieldsHelp}`, "settings-help");
          const found = await this.api.execute({ operation: "list", input: { search: plan.target, perPage: 50 } }, context);
          if (!found.ok) return this.failure(found.code, found.status);
          const data = found.data as { items: AdminSetting[]; total: number };
          const exact = data.items.filter(row => row.key === plan.target);
          if (exact.length === 1) id = exact[0]!.id;
          else if (data.total === 1) id = data.items[0]?.id;
          else { state.rows = data.items; state.awaiting = text; return reply(`🔎 تنظیم یکتایی انتخاب نشد؛ شماره یا شناسه را بفرست.\n\n${data.items.map(settingCard).join("\n\n") || "موردی پیدا نشد."}`, "settings-clarify"); }
        }
        if (!id) { state.awaiting = text; return reply("🔎 کلید، شناسه یا شمارهٔ ردیف کدام تنظیم؟"); }
        const current = await this.api.execute({ operation: "get", id, input: {} }, context);
        if (!current.ok) return this.failure(current.code, current.status);
        const row = current.data as AdminSetting;
        state.target = row; state.rows = [row];
        if (plan.operation === "edit") { state.snapshot = row; state.draft = "edit"; return reply(formHelp("edit", row)); }
        if (plan.operation === "delete") { state.snapshot = row; return this.propose({ operation: "delete", id, input: {} }, state); }
        return reply(settingCard(row), "settings-read");
      }
      if (plan.operation !== "list" && plan.operation !== "bulk") return reply("🔎 نوع عملیات را روشن‌تر مشخص کن.");
      const command: SettingCommand = { operation: plan.operation, input: plan.input };
      if (command.operation === "list" && plan.input.page !== undefined) command.input = { ...state.query, ...plan.input };
      if (command.operation === "bulk") {
        const input = { ...plan.input };
        if (input.scope === "filtered") {
          if (!/(همه|تمام|all)/iu.test(value)) { input.scope = "page"; input.ids = state.rows.map(row => row.id); delete input.filters; }
          else input.filters = { ...state.query, ...(input.filters as object ?? {}) , page: undefined, perPage: undefined };
          if (input.scope === "filtered") { const filters = input.filters as Record<string, unknown>; delete filters.page; delete filters.perPage; }
        }
        if (input.scope === "page" && !input.ids) input.ids = state.rows.map(row => row.id);
        if (Array.isArray(input.ids) && input.ids.some(item => !state!.rows.some(row => row.id === item) && !text.includes(String(item)))) return reply("🔎 شناسه‌های گروهی باید در فهرست دیده شده یا صریحاً وارد شده باشند.", "settings-invalid");
        command.input = input;
      }
      validateSettingCommand(command);
      return command.operation === "list" ? this.run(command, state, context) : this.propose(command, state);
    } catch { return reply("⚠️ درخواست معتبر آماده نشد؛ کلید تنظیم و نوع عملیات را روشن‌تر بگو. هیچ تغییری ارسال نشد.", "settings-invalid"); }
  }
  private propose(command: SettingCommand, state: State) {
    const input = validateSettingCommand(command).input; command.input = input; state.command = command;
    const key = String(input.key ?? (command.id ? state.target?.key : "") ?? "");
    const summary = sensitiveSetting(key) ? "🔒 مقدار و ترجمه‌های محرمانه نمایش داده نمی‌شوند." : display(input);
    return { status: "settings-proposed", reply: `**🔎 تأیید تغییر تنظیمات**\n\n• عملیات: ${{ create: "ساخت", update: "ویرایش", delete: "حذف", bulk: "گروهی", list: "فهرست", get: "مشاهده" }[command.operation]}\n${command.id ? `• شناسه: ${command.id}\n` : ""}${key ? `• کلید: ${key}\n💡 ${explainSetting(key)}\n` : ""}${summary}\n\n⚠️ ${command.operation === "bulk" ? "محدودهٔ گروهی و فیلترها را دقیق بررسی کن؛ نتایج فیلترشده در لحظهٔ اجرا انتخاب می‌شوند." : "تغییر ممکن است روی رزرو، اعلان‌ها یا محتوای عمومی اثر داشته باشد؛ حذف و غیرفعال‌سازی معادل false نیستند."}\n\n🔒 هنوز اجرا نشده. اجرا: «تأیید»؛ انصراف: «لغو». اعتبار: ۵ دقیقه.` };
  }
  private failure(code: string, status?: number) { return { status: "settings-error", reply: `⚠️ درخواست تنظیمات تأیید نشد.\n• کد: ${code}${status ? `\n• HTTP: ${status}` : ""}\nدر خطای شبکه نتیجه ممکن است نامشخص باشد؛ پیش از تکرار فهرست را بررسی کن.` }; }
  private async run(command: SettingCommand, state: State, context: RuleRequestContext) {
    const result = await this.api.execute(command, context);
    if (!result.ok) return this.failure(result.code, result.status);
    if (command.operation === "list") {
      const data = result.data as { items: AdminSetting[]; total: number; page: number };
      state.rows = data.items; state.query = validateSettingCommand(command).input;
      return { status: "settings-listed", reply: `**⚙️ تنظیمات سیستم**\n\n• صفحه: ${data.page}\n• تعداد کل: ${data.total}\n\n${data.items.map(settingCard).join("\n\n") || "📭 تنظیمی پیدا نشد."}\n\nبرای توضیح کامل بگو «راهنمای تنظیمات»؛ برای تغییر بگو «تنظیم دوم را ویرایش کن».` };
    }
    state.rows = []; state.target = undefined;
    if (command.operation === "bulk") { const data = result.data as { requested: number; succeeded: number; failures: unknown[] }; return { status: "settings-completed", reply: `📋 نتیجهٔ عملیات گروهی تنظیمات\n• درخواستی: ${data.requested}\n• موفق: ${data.succeeded}\n• ناموفق: ${data.failures.length}` }; }
    return { status: "settings-completed", reply: `✅ ${command.operation === "create" ? `تنظیم ساخته شد. شناسه: ${(result.data as { id: string }).id}` : command.operation === "delete" ? "حذف تنظیم" : "ویرایش تنظیم"} توسط سرویس تأیید شد. برای مشاهدهٔ نتیجه، فهرست تنظیمات را بخواه.` };
  }
}
