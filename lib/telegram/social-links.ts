import { createHash } from "node:crypto";
import { normalize } from "@/lib/text";
import { adminReadStatus, matchAdminReadRoute } from "./admin-read-intent";
import { isOtpLoginIntent } from "@/lib/auth/telegram-login";
import type { RuleRequestContext } from "@/lib/rules/types";
import { SocialLinksApi, validateSocialCommand, type SocialCommand, type SocialLink } from "@/lib/social-links/api";
import { jalaliDate } from "./format";
import { planSocialRequest, socialPlanSchema, type SocialPlanner } from "@/lib/social-links/planner";
import { createSocialLinkSchema } from "@/lib/social-links/validation";

export function isSocialLinksRequest(text: string): boolean {
  const value = normalize(text);
  return /(?:لینک|پیوند).*(?:اجتماعی|اینستاگرام|تلگرام|واتساپ|فیسبوک|فیس بوک|یوتیوب|لینکدین)|(?:شبکه|شبکههای|شبکه های)\s*اجتماعی|social[ -]?links|سوشال.*لینک/iu.test(value)
    || /لینک|پیوند/u.test(value) && /بساز|ایجاد|افزودن|اضافه|جدید|حذف|پاک|ویرایش|تغییر|فعال|لیست|فهرست|نمایش|نشان|نشون/u.test(value);
}
function deterministicSocialRead(text: string) {
  return matchAdminReadRoute(text, [{
    operation: "list" as const,
    when: /(?:لینک|پیوند).*(?:اجتماعی|اینستاگرام|تلگرام|واتساپ|فیسبوک|فیس\s*بوک|یوتیوب|لینکدین)|(?:شبکه|شبکههای|شبکه های)\s*اجتماعی|social[ -]?links|سوشال.*لینک/iu,
    input: value => {
      const status = adminReadStatus(value, [
        { value: "inactive", when: /\b(?:inactive|disabled)\b|غیرفعال/iu },
        { value: "active", when: /\b(?:active|enabled)\b|فعال/iu },
      ]);
      const platforms = [
        ["instagram", /\binstagram\b|اینستاگرام/iu], ["telegram", /\btelegram\b|تلگرام/iu],
        ["whatsapp", /\bwhatsapp\b|واتساپ/iu], ["facebook", /\bfacebook\b|فیسبوک|فیس\s*بوک/iu],
        ["youtube", /\byoutube\b|یوتیوب/iu], ["linkedin", /\blinkedin\b|لینکدین/iu],
      ] as const;
      const search = platforms.find(([, pattern]) => pattern.test(value))?.[0];
      return { ...(status ? { status } : {}), ...(search ? { search } : {}) };
    },
  }]);
}
type State = { actor: string; session: string; expires: number; rows: SocialLink[]; query: Record<string, unknown>; command?: SocialCommand; snapshot?: SocialLink; target?: SocialLink; draft?: Record<string, unknown>; awaiting?: string };
export function socialCard(row: SocialLink, index = 0): string {
  return `**🔗 ${index + 1}. ${row.labelFa}**\n• عنوان انگلیسی: ${row.labelEn}\n• آدرس:\n${row.url}\n• وضعیت: ${row.isActive ? "🟢 فعال" : "⚪ غیرفعال"}\n• ترتیب نمایش: ${row.displayOrder}\n• تصویر: ${row.imageUrl ?? "ندارد"}\n• شناسه: ${row.id}${row.createdAt ? `\n• تاریخ ثبت: ${jalaliDate(row.createdAt)}` : ""}${row.updatedAt ? `\n• آخرین ویرایش: ${jalaliDate(row.updatedAt)}` : ""}`;
}
export function socialFields(input: Record<string, unknown>): string {
  const labels: Record<string, string> = { labelFa: "عنوان فارسی", labelEn: "عنوان انگلیسی", url: "آدرس", imageUrl: "آدرس تصویر", displayOrder: "ترتیب نمایش", isActive: "فعال" };
  return Object.entries(labels).flatMap(([key, label]) => input[key] !== undefined ? [`• ${label}: ${typeof input[key] === "boolean" ? input[key] ? "بله" : "خیر" : String(input[key])}`] : []).join("\n");
}
const HELP = "**🔗 مدیریت لینک‌های اجتماعی**\n\n• «لینک‌های شبکه‌های اجتماعی را نشان بده»\n• «لینک اجتماعی جدید بساز»\n• «آدرس لینک دوم را به … تغییر بده»\n• «عنوان فارسی لینک اول را … کن»\n• «لینک اینستاگرام را حذف کن»\n• «همه لینک‌های اجتماعی غیرفعال را حذف کن»\n\n🔒 تغییرها فقط پس از «تأیید» اجرا می‌شوند. انصراف: «لغو».\nℹ️ API حذف تصویر موجود با مقدار خالی یا null را پشتیبانی نمی‌کند؛ می‌توان تصویر را جایگزین کرد.";
export class TelegramSocialLinks {
  private states = new Map<string, State>();
  constructor(private api = new SocialLinksApi(), private planner: SocialPlanner = planSocialRequest, private now = Date.now) {}
  isCollecting(owner: string): boolean { const state = this.states.get(owner); return Boolean(state?.draft && state.expires > this.now()); }
  clear(owner: string) { this.states.delete(owner); }
  private signature(context: RuleRequestContext) { return createHash("sha256").update(context.sessionCookie).digest("hex"); }
  async handle(owner: string, text: string, context: RuleRequestContext | null, privateChat: boolean): Promise<{ reply: string; status: string } | null> {
    const current = this.states.get(owner);
    const expired = Boolean(current && current.expires <= this.now());
    for (const [key, state] of this.states) if (state.expires <= this.now()) this.states.delete(key);
    let state = this.states.get(owner);
    const value = normalize(text);
    const explicit = isSocialLinksRequest(value);
    const follows = state && (state.command || state.draft || state.awaiting || /حذف|پاک|فعال|ویرایش|تغییر|آدرس|عنوان|تصویر|ردیف|اول|دوم|سوم|چهارم|پنجم|صفحه|لغو|next|delete|remove|edit|activate|url|label|image|first|second/iu.test(value));
    if (isOtpLoginIntent(text) || /^\/(?:clear|reset|new)\b/iu.test(text)) { this.clear(owner); return null; }
    if (!explicit && !follows && !(expired && /^(?:بله|تایید|تأیید|yes|confirm)$/iu.test(value))) return null;
    const reply = (message: string, status = "social-pending") => ({ reply: message, status });
    if (!privateChat) return reply("🔐 مدیریت لینک‌های اجتماعی فقط در گفت‌وگوی خصوصی ربات مجاز است.", "social-private-only");
    if (!context?.actorId.trim() || !context.sessionCookie.trim()) { this.clear(owner); return reply("🔐 ابتدا در خصوصی بنویس «می‌خواهم لاگین کنم». هیچ تغییری ارسال نشده است.", "social-auth-required"); }
    if (expired && !explicit) return reply("⏳ زمان درخواست تمام شد؛ لینک‌های اجتماعی را دوباره بخواه و درخواست را از نو شروع کن.", "social-expired");
    if (state && (state.actor !== context.actorId || state.session !== this.signature(context))) { this.clear(owner); return reply("🔐 نشست تغییر کرده؛ درخواست لینک‌های اجتماعی را دوباره شروع کن.", "social-session-changed"); }
    if (/^(لغو|cancel|\/cancel)$/iu.test(value)) { this.clear(owner); return reply("↩️ درخواست لینک‌های اجتماعی لغو شد؛ تغییری ارسال نشد.", "social-cancelled"); }
    if (!state) {
      if (this.states.size >= 1000) return reply("⏳ درخواست‌های زیادی در انتظارند؛ کمی بعد تلاش کن.", "social-busy");
      state = { actor: context.actorId, session: this.signature(context), expires: this.now() + 300_000, rows: [], query: {} };
      this.states.set(owner, state);
    }
    if (state.command) {
      if (!/^(بله|تایید|تأیید|yes|confirm)$/iu.test(value)) return reply("🔎 تغییر قبلی منتظر پاسخ است. برای اجرا «تأیید» و برای کنارگذاشتن «لغو» بفرست.");
      const command = state.command, snapshot = state.snapshot;
      state.command = undefined; state.snapshot = undefined; // single use before network
      if ((command.operation === "update" || command.operation === "delete") && snapshot) {
        const latest = await this.api.execute({ operation: "get", id: command.id, input: {} }, context);
        if (!latest.ok || JSON.stringify(latest.data) !== JSON.stringify(snapshot)) return reply("⚠️ اطلاعات لینک‌های اجتماعی عوض شده یا بازخوانی نشد؛ دوباره آن را بررسی و درخواست کن.", "social-conflict");
      }
      return this.run(command, state, context);
    }
    if (state.draft) {
      const field = ["labelFa", "labelEn", "url", "imageUrl"].find(key => !(key in state!.draft!))!;
      const input = field === "imageUrl" && /^(بدون تصویر|ندارد|بدون|skip)$/iu.test(value) ? "" : text.trim();
      const schema = createSocialLinkSchema.shape[field as "labelFa" | "labelEn" | "url" | "imageUrl"];
      if (!schema.safeParse(input).success) return reply("⚠️ عنوان باید ۱ تا ۸۰ نویسه و آدرس یک لینک http یا https با حداکثر ۲۰۴۸ نویسه باشد؛ دوباره بفرست.");
      if ((field === "url" || field === "imageUrl") && input) {
        try { const url = new URL(input); if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error(); }
        catch { return reply("⚠️ آدرس معتبر http یا https بفرست؛ نام کاربری یا رمز را داخل آدرس قرار نده."); }
      }
      state.draft[field] = input;
      const next = ["labelFa", "labelEn", "url", "imageUrl"].find(key => !(key in state!.draft!));
      if (next) return reply(this.prompt(next));
      const command: SocialCommand = { operation: "create", input: state.draft };
      state.draft = undefined;
      return this.propose(command, state);
    }
    if (/(?:لینک|پیوند).*(?:بساز|ایجاد|جدید|اضافه)|(?:ساخت|افزودن).*(?:لینک|پیوند)/iu.test(value)) { state.draft = {}; return reply(this.prompt("labelFa")); }
    // Do not send URLs containing embedded credentials to the intent model.
    if (/https?:\/\/[^/\s]+@/iu.test(text)) return reply("🔐 نام کاربری یا رمز را داخل آدرس نفرست؛ یک آدرس عمومی بدون اطلاعات ورود لازم است.", "social-invalid");
    const directRead = deterministicSocialRead(text);
    if (directRead) {
      state.awaiting = undefined;
      return this.run({ operation: "list", input: directRead.input }, state, context);
    }
    try {
      const plan = socialPlanSchema.parse(await this.planner(state.awaiting ? `${state.awaiting}\nتوضیح یا انتخاب کاربر: ${text}` : text, state.rows, state.query));
      if (plan.operation === "clarify") { state.awaiting = text; return reply(`${HELP}\n\n🔎 عنوان، شمارهٔ ردیف یا تغییر موردنظر را دقیق‌تر بگو.`); }
      state.awaiting = undefined;
      if (plan.operation === "start") { state.draft = {}; return reply(this.prompt("labelFa")); }
      let id = plan.id;
      if (id && !state.rows.some(row => row.id === id) && !text.includes(id)) return reply("🔎 ابتدا فهرست لینک‌های اجتماعی را بخواه یا شناسهٔ دقیق را بفرست؛ شناسه را حدس نمی‌زنم.", "social-invalid");
      if (["get", "update", "delete"].includes(plan.operation) && !id && plan.target) {
        const found = await this.api.execute({ operation: "list", input: { search: plan.target, perPage: 50 } }, context);
        if (!found.ok) return this.failure(found.code, found.status);
        const data = found.data as { items: SocialLink[]; total: number };
        const rows = data.items.filter(row => [row.labelFa, row.labelEn, row.url].some(item => normalize(item).toLowerCase() === normalize(plan.target!).toLowerCase()));
        if (rows.length !== 1 || data.total !== 1) {
          state.rows = data.items; state.awaiting = text;
          const choices = data.items.slice(0, 10).map((row, index) => socialCard(row, index)).join("\n\n");
          return reply(`🔎 لینک یکتایی انتخاب نشد؛ یک گزینه را انتخاب کن یا شناسهٔ دقیق را بفرست.\n\n${choices || "موردی پیدا نشد."}`, "social-clarify");
        }
        id = rows[0]!.id;
      }
      if (["get", "update", "delete"].includes(plan.operation) && !id) { state.awaiting = text; return reply("🔎 کدام لینک را می‌گویی؟ عنوان، آدرس یا شناسهٔ دقیقش را بفرست."); }
      const command: SocialCommand = { operation: plan.operation, id, input: plan.input };
      if (command.operation === "list" && plan.input.page !== undefined) command.input = { ...state.query, ...plan.input };
      if (command.operation === "bulk") {
        let input = plan.input;
        if (input.scope === "filtered" && !/(?:همه|تمام|all).*(?:لینک|پیوند|اجتماعی|social|links?)|(?:لینک|پیوند|اجتماعی|social|links?).*(?:همه|تمام|all)/iu.test(value)) input = { action: input.action, scope: "page", ids: state.rows.map(row => row.id) };
        if (Array.isArray(input.ids) && input.ids.some(id => !state!.rows.some(row => row.id === id) && !text.includes(String(id)))) return reply("🔎 فقط ردیف‌های همین فهرست یا شناسه‌های صریح را می‌توان انتخاب کرد.", "social-invalid");
        command.input = input;
      }
      if (command.operation === "create" || command.operation === "update") {
        for (const key of ["url", "imageUrl", "labelFa", "labelEn"]) {
          const value = plan.input[key];
          if (typeof value === "string" && value && !text.toLowerCase().includes(value.toLowerCase())) return reply("🔎 عنوان یا آدرس جدید را دقیق و کامل بفرست؛ ترجمه یا آدرسی را حدس نمی‌زنم.", "social-invalid");
        }
      }
      const valid = validateSocialCommand(command);
      command.input = valid.input;
      if (command.operation === "get" || command.operation === "list") return this.run(command, state, context);
      if (command.operation === "update" || command.operation === "delete") {
        const current = await this.api.execute({ operation: "get", id, input: {} }, context);
        if (!current.ok) return this.failure(current.code, current.status);
        const row = current.data as SocialLink;
        state.target = row;
        state.snapshot = row;
      }
      return this.propose(command, state);
    } catch { return reply("⚠️ درخواست معتبر و دقیقی آماده نشد. عنوان یا آدرس لینک و تغییر موردنظر را روشن‌تر بگو؛ برای تصویر، آدرس جدید لازم است و حذف با مقدار خالی پشتیبانی نمی‌شود. هیچ تغییری ارسال نشد.", "social-invalid"); }
  }
  private prompt(field: string) {
    const prompts: Record<string, string> = { labelFa: "۱. عنوان فارسی لینک را بفرست؛ مثلاً اینستاگرام.", labelEn: "۲. عنوان انگلیسی لینک را بفرست؛ ترجمه را حدس نمی‌زنم.", url: "۳. آدرس کامل لینک را بفرست؛ باید با http:// یا https:// شروع شود.", imageUrl: "۴. آدرس تصویر را بفرست؛ اگر لازم نیست بنویس «بدون تصویر»." };
    return `**🔗 ساخت لینک اجتماعی**\n\n${prompts[field]}\n\n🔒 هنوز تغییری انجام نشده. انصراف: «لغو»\n⏳ اعتبار: ۵ دقیقه`;
  }

  private propose(command: SocialCommand, state: State) {
    command.input = validateSocialCommand(command).input;
    state.command = command;
    const input = command.input as Record<string, unknown>;
    const names = { create: "ساخت لینک‌های اجتماعی", update: "ویرایش لینک‌های اجتماعی", delete: "حذف لینک‌های اجتماعی", bulk: "عملیات گروهی", get: "خواندن", list: "فهرست" };
    const details = command.operation === "bulk" ? `• عملیات گروهی: ${{ activate: "فعال‌سازی", deactivate: "غیرفعال‌سازی", delete: "حذف" }[String(input.action) as "activate"]}\n• محدوده: ${input.scope === "filtered" ? "⚠️ تمام نتایج مطابق فیلتر" : "ردیف‌های انتخاب‌شده"}\n${Array.isArray(input.ids) ? input.ids.map(id => `• شناسه: ${String(id)}`).join("\n") : `• فیلترها:\n${JSON.stringify(input.filters ?? {})}`}` : socialFields(input);
    return { status: "social-proposed", reply: `**🔎 تأیید تغییر لینک‌های اجتماعی**\n\n• عملیات: ${names[command.operation]}${command.id ? `\n• شناسه: ${command.id}` : ""}${state.target && command.id === state.target.id ? `\n• عنوان فعلی: ${state.target.labelFa}\n• آدرس فعلی:\n${state.target.url}` : ""}\n${details}\n\n🔒 هنوز چیزی ارسال نشده.\n✅ اجرا: «تأیید»\n↩️ انصراف: «لغو»\n⏳ اعتبار: ۵ دقیقه` };
  }
  private failure(code: string, status?: number) { return { status: "social-error", reply: `**⚠️ درخواست لینک‌های اجتماعی تأیید نشد**\n\n• کد: ${code}${status ? `\n• وضعیت سرویس: ${status}` : ""}\n🔎 در خطای شبکه، نتیجهٔ اجرا ممکن است نامشخص باشد؛ بدون بررسی دوباره تکرار نکن.` }; }
  private async run(command: SocialCommand, state: State, context: RuleRequestContext) {
    const result = await this.api.execute(command, context);
    if (!result.ok) return this.failure(result.code, result.status);
    if (command.operation === "list") {
      const data = result.data as { items: SocialLink[]; page: number; total: number };
      state.rows = data.items; state.query = validateSocialCommand(command).input;
      return { status: "social-listed", reply: `**🔗 لینک‌های اجتماعی کلینیک**\n\n📄 صفحه: ${data.page}\n📊 تعداد کل: ${data.total}\n\n${data.items.map(socialCard).join("\n\n") || "📭 لینک‌های اجتماعی پیدا نشد."}\n\n💬 مثلاً بگو «لینک دوم را حذف کن» یا «آدرس لینک اول را تغییر بده».` };
    }
    if (command.operation === "get") { const row = result.data as SocialLink; state.rows = [row]; return { status: "social-read", reply: socialCard(row) }; }
    state.rows = [];
    if (command.operation === "bulk") {
      const data = result.data as { requested: number; succeeded: number; failures: { id: string; code: string }[] };
      return { status: "social-completed", reply: `**📋 نتیجهٔ عملیات گروهی لینک‌های اجتماعی**\n\n• درخواستی: ${data.requested}\n• ✅ موفق: ${data.succeeded}\n• ❌ ناموفق: ${data.failures.length}${data.failures.length ? `\n${data.failures.map(item => `• شناسه: ${item.id}؛ کد: ${/^[A-Z][A-Z0-9_]{0,63}$/.test(item.code) ? item.code : "OPERATION_FAILED"}`).join("\n")}` : ""}` };
    }
    return { status: "social-completed", reply: `**✅ تغییر لینک‌های اجتماعی انجام شد**\n\n${command.operation === "delete" ? "🗑 حذف لینک توسط سرویس تأیید شد." : command.operation === "create" ? `🔗 لینک ساخته شد.\n• شناسه: ${(result.data as { id: string }).id}` : "✏️ ویرایش لینک توسط سرویس تأیید شد."}\n\nبرای دیدن نتیجه، فهرست لینک‌های اجتماعی را بخواه.` };
  }
}
