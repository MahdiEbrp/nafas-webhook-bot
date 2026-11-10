import type { z } from "zod";
import { createHash } from "node:crypto";
import { normalize } from "@/lib/text";
import { isOtpLoginIntent } from "@/lib/auth/telegram-login";
import type { RuleRequestContext } from "@/lib/rules/types";
import { PaymentAdminApi, paymentOperations, validatePaymentCommand, type PaymentCommand, type PaymentOperation } from "@/lib/payment-admin/api";
import { planPaymentRequest, paymentPlanSchema, type PaymentChoice, type PaymentPlanner } from "@/lib/payment-admin/planner";
import { jalaliDate } from "./format";
type Row = Record<string, unknown>;
type Draft = { operation: PaymentOperation; id?: string; values: Row; step: number };
type State = { actor: string; session: string; expires: number; rows: { providers: Row[]; transactions: Row[] }; query: Record<string, unknown>; draft?: Draft; command?: PaymentCommand; snapshot?: Row; awaiting?: string };
export function isPaymentAdminRequest(text: string): boolean {
  const value = normalize(text);
  return /\bpayments?\b|درگاه|مرچنت|تراکنش|(?:مدیریت|امار|گزارش|درخواست|لینک|وضعیت|فهرست|لیست|تست).*پرداخت|پرداخت.*(?:بساز|مدیریت|گزارش|تست|درخواست|لینک|وضعیت)/iu.test(value);
}
export const PAYMENT_HELP = "**💳 مدیریت پرداخت**\n\n• «آمار پرداخت را نشان بده»\n• «درگاه‌های پرداخت را نشان بده»\n• «درگاه پرداخت جدید بساز»\n• «درگاه دوم را ویرایش کن»\n• «درگاه اول را تست کن»\n• «تراکنش‌های ناموفق را نشان بده»\n• «درخواست پرداخت بساز»\n• «تراکنش دوم را ویرایش کن»\n\n🔒 فقط در خصوصی و با نشست مجاز؛ تغییرها با تأیید صریح.\n⚠️ تست درگاه درخواست واقعی ۱۰۰۰ ریالی ایجاد می‌کند؛ تغییر وضعیت تراکنش فقط ثبت مدیریتی است، نه تأیید بانک، بازپرداخت یا تغییر وضعیت رزرو.\nℹ️ این API عملیات بازپرداخت بانکی، تأیید بانکی، حذف تراکنش یا عملیات گروهی تراکنش ندارد.";
const steps: Record<string, string[]> = { providerCreate: ["name", "kind", "merchantId", "apiUrl", "callbackUrl", "options"], providerUpdate: ["patch"], transactionCreate: ["bookingGroupRef", "amount", "description", "providerId"], transactionUpdate: ["patch"] };
const prompts: Record<string, string> = {
  name: "نام درگاه را بفرست؛ ۲ تا ۸۰ نویسه.", kind: "نوع درگاه را دقیق بفرست: zarinpal، tabapay، zibal، idpay، nextpay، mellat، parsian یا fake. وجود نام در فهرست به معنی یکپارچه‌سازی اختصاصی همهٔ درگاه‌ها نیست.",
  merchantId: "شناسهٔ مرچنت/کلید اتصال را بفرست؛ ۸ تا ۶۴ نویسه. پیام حذف می‌شود؛ مقدار وارد مدل یا پیش‌نمایش نمی‌شود.",
  apiUrl: "نشانی HTTPS عمومی API درگاه را بفرست؛ برای استفاده از مقدار پیش‌فرض آداپتور بنویس «پیش‌فرض». اطلاعات ورود را داخل URL ننویس.",
  callbackUrl: "نشانی HTTPS عمومی بازگشت پرداخت را بفرست یا بنویس «پیش‌فرض» تا سرور مقصد را تعیین کند. مقصد اشتباه می‌تواند تأیید پرداخت را مختل کند.",
  options: 'تنظیمات اختیاری را در JSON بفرست یا «پیش‌فرض»: {"isActive":true,"isDefault":false,"sandbox":true}. sandbox را صریح انتخاب کن؛ پیش‌فرض به معنی محیط آزمایشی نیست. انتخاب پیش‌فرض جدید می‌تواند درگاه پیش‌فرض قبلی را تغییر دهد.',
  bookingGroupRef: "شناسهٔ گروه رزرو را دقیق بفرست؛ قالب NF-12345. تعلق رزرو و مبلغ را خودت بررسی کن؛ این مسیر تضمین تطبیق مبلغ با رزرو نمی‌دهد.",
  amount: "مبلغ دقیق را به تومان بفرست؛ عدد صحیح ۱۰۰۰ تا ۱۰۰۰۰۰۰۰۰۰. سرور برای درخواست درگاه آن را ×۱۰ و به ریال تبدیل می‌کند.",
  description: "توضیح دقیق درخواست پرداخت را بفرست (حداکثر ۵۰۰ نویسه) یا «بدون».",
  providerId: "شناسهٔ UUID درگاه را بفرست یا «پیش‌فرض» برای انتخاب درگاه توسط سرور. نام درگاه یا شناسه را حدس نمی‌زنم.",
};
function prompt(draft: Draft) {
  const field = steps[draft.operation]![draft.step]!;
  const patch = draft.operation === "providerUpdate" ? 'تغییرات دقیق درگاه را در JSON بفرست. فیلدها: name، kind، merchantId، apiUrl، callbackUrl، isActive، isDefault، sandbox. فقط فیلدهای موردنظر را وارد کن. merchantId پنهان می‌ماند؛ مقدار sandbox فعلی در پاسخ API موجود نیست و حدس زده نمی‌شود.' : 'تغییرات دقیق تراکنش را در JSON بفرست. فقط description و status مجازند. status: pending، requested، verified، failed، refunded، cancelled. ⚠️ verified تأیید بانک نیست و refunded بازپرداخت پول نیست؛ این مسیر فقط رکورد را تغییر می‌دهد و رزرو را هم تأیید نمی‌کند.';
  return `**💳 تکمیل درخواست پرداخت**\n\n• مرحله: ${draft.step + 1} از ${steps[draft.operation]!.length}\n${field === "patch" ? patch : prompts[field]}\n\n🔐 پیام مقدار پس از دریافت حذف می‌شود؛ وارد مدل یا تاریخچه نمی‌شود. تا تأیید نهایی اجرا نمی‌شود. انصراف: «لغو». اعتبار: ۵ دقیقه.`;
}
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
export class TelegramPaymentAdmin {
  private states = new Map<string, State>();
  constructor(private api = new PaymentAdminApi(), private planner: PaymentPlanner = planPaymentRequest, private now = Date.now) {}
  clear(owner: string) { this.states.delete(owner); }
  isCollecting(owner: string) { const state = this.states.get(owner); return Boolean(state?.draft && state.expires > this.now()); }
  private signature(context: RuleRequestContext) { return createHash("sha256").update(context.sessionCookie).digest("hex"); }
  async handle(owner: string, text: string, context: RuleRequestContext | null, privateChat: boolean): Promise<{ reply: string; status: string; deleteSensitiveMessage?: boolean } | null> {
    const previous = this.states.get(owner), expired = Boolean(previous && previous.expires <= this.now());
    for (const [key, state] of this.states) if (state.expires <= this.now()) this.states.delete(key);
    let state = this.states.get(owner);
    const value = normalize(text), explicit = isPaymentAdminRequest(text);
    if (!state?.draft && (isOtpLoginIntent(text) || /^\/(?:clear|reset|new)\b/iu.test(text))) { this.clear(owner); return null; }
    const follows = state && (state.command || state.draft || state.awaiting || /اول|دوم|سوم|صفحه|حذف|ویرایش|تغییر|فعال|تست|لغو|next|delete|edit|test/iu.test(value));
    if (!explicit && !follows && !(expired && /^(بله|تایید|تأیید|yes|confirm)$/iu.test(value))) return null;
    const sensitive = Boolean(state?.draft || expired && previous?.draft) || /[{}]|https?:\/\/|(?:merchant|مرچنت|token|توکن|password|رمز)\s*[:=]/iu.test(text);
    const reply = (message: string, status = "payment-pending") => ({ reply: message, status, ...(sensitive ? { deleteSensitiveMessage: true } : {}) });
    if (!privateChat) return reply("🔐 مدیریت پرداخت فقط در گفت‌وگوی خصوصی مجاز است؛ کلید اتصال را اینجا نفرست.", "payment-private-only");
    if (!context?.actorId.trim() || !context.sessionCookie.trim()) { this.clear(owner); return reply("🔐 ابتدا در خصوصی وارد حساب مجاز شو؛ درخواست پرداختی ارسال نشده است.", "payment-auth-required"); }
    if (expired && !explicit) return reply("⏳ زمان درخواست پرداخت تمام شده؛ از ابتدا شروع کن.", "payment-expired");
    if (state && (state.actor !== context.actorId || state.session !== this.signature(context))) { this.clear(owner); return reply("🔐 نشست تغییر کرده؛ درخواست پرداخت را از ابتدا شروع کن.", "payment-session-changed"); }
    if (/^(لغو|cancel|\/cancel)$/iu.test(value)) { this.clear(owner); return reply("↩️ درخواست پرداخت لغو شد؛ چیزی به درگاه ارسال نشد.", "payment-cancelled"); }
    if (!state) {
      if (this.states.size >= 200) return reply("⏳ درخواست‌های زیادی منتظرند؛ بعداً تلاش کن.", "payment-busy");
      state = { actor: context.actorId, session: this.signature(context), expires: this.now() + 300_000, rows: { providers: [], transactions: [] }, query: {} }; this.states.set(owner, state);
    }
    if (state.command) {
      if (!/^(بله|تایید|تأیید|yes|confirm)$/iu.test(value)) return reply("🔎 درخواست قبلی منتظر است؛ «تأیید» یا «لغو» را بفرست.");
      const command = state.command, snapshot = state.snapshot; state.command = undefined; state.snapshot = undefined;
      if (snapshot) {
        const latest = command.operation === "transactionUpdate" ? await this.findTransaction(snapshot, context) : await this.api.execute({ operation: "providerGet", id: String(snapshot.id), input: {} }, context);
        if (!latest.ok || pretty(latest.data) !== pretty(snapshot)) return reply("⚠️ اطلاعات عوض شده یا بازخوانی نشد؛ درخواست لغو شد، دوباره بررسی کن.", "payment-conflict");
      }
      return this.run(command, state, context);
    }
    if (state.draft) {
      const draft = state.draft, field = steps[draft.operation]![draft.step]!;
      const skip = /^(بدون|پیشفرض|پیش فرض|skip|default)$/iu.test(value);
      try {
        let input: unknown = text.trim();
        if (field === "patch") draft.values = JSON.parse(text) as Row;
        else if (field === "amount") { if (!/^\d+$/.test(value)) throw new Error(); input = Number(value); }
        else if (field === "options") { const options = skip ? {} : JSON.parse(text); if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["isActive", "isDefault", "sandbox"].includes(key))) throw new Error(); Object.assign(draft.values, options); input = undefined; }
        else if (["apiUrl", "callbackUrl", "providerId", "description"].includes(field) && skip) input = field === "apiUrl" ? "" : undefined;
        if (field !== "patch" && input !== undefined) draft.values[field] = input;
        // Validate every field locally against the exact route schema before advancing.
        const operation = draft.operation;
        if (field !== "patch" && field !== "options") {
          const schema = operation === "providerCreate" ? paymentOperations.providerCreate[2] : paymentOperations.transactionCreate[2];
          const fieldSchema = (schema.shape as Record<string, z.ZodType>)[field];
          if (fieldSchema) fieldSchema.parse(draft.values[field]);
        }
        draft.step++;
        if (draft.step < steps[operation]!.length) return reply(prompt(draft));
        const command: PaymentCommand = { operation, id: draft.id, input: draft.values };
        command.input = validatePaymentCommand(command).input;
        state.draft = undefined;
        return { ...this.propose(command, state), deleteSensitiveMessage: true };
      } catch {
        if (draft.step >= steps[draft.operation]!.length) { draft.step = 0; draft.values = {}; }
        return reply(`⚠️ مقدار معتبر نیست؛ دوباره بفرست.\n\n${prompt(draft)}`, "payment-invalid");
      }
    }
    if (sensitive) return reply("🔐 مقادیر یا کلید اتصال را در درخواست آزاد نفرست؛ ابتدا ساخت یا ویرایش درگاه/تراکنش را بخواه تا فرم محلی شروع شود.", "payment-invalid");
    if (/راهنما|help/iu.test(value) || /بازپرداخت|استرداد|refund|تایید بانکی|تأیید بانکی|حذف.*تراکنش/iu.test(value)) return reply(PAYMENT_HELP, "payment-help");
    if (/(?:درگاه).*(?:بساز|جدید|ایجاد)|(?:ساخت|ایجاد).*درگاه/iu.test(value)) return reply(this.start(state, "providerCreate"));
    if (/(?:درخواست|لینک).*پرداخت.*(?:بساز|ایجاد|جدید)|(?:ساخت|ایجاد).*(?:پرداخت|تراکنش)/iu.test(value)) return reply(this.start(state, "transactionCreate"));
    try {
      const plan = paymentPlanSchema.parse(await this.planner(state.awaiting ? `${state.awaiting}\nانتخاب: ${text}` : text, this.choices(state), state.query));
      if (plan.operation === "help") return reply(PAYMENT_HELP, "payment-help");
      if (plan.operation === "clarify") { state.awaiting = text; return reply(PAYMENT_HELP); }
      state.awaiting = undefined;
      const operation = plan.operation;
      let id = plan.id;
      const resource = operation.startsWith("transaction") ? "transactions" : "providers";
      if (id && !state.rows[resource].some(row => row.id === id) && !text.includes(id)) return reply("🔎 ابتدا فهرست مرتبط را بخواه یا شناسهٔ دقیق را بفرست؛ شناسه را حدس نمی‌زنم.", "payment-invalid");
      if (operation.startsWith("provider") && !["providers", "providerCreate", "providerBulk"].includes(operation) && !id && plan.target) {
        const found = await this.api.execute({ operation: "providers", input: { search: plan.target, perPage: 50 } }, context);
        if (!found.ok) return this.failure(found.code, found.status);
        const rows = found.data.items as Row[]; state.rows.providers = rows;
        if (found.data.total !== 1 || rows.length !== 1) { state.awaiting = text; return reply(`🔎 درگاه یکتایی انتخاب نشد؛ شماره یا شناسه را بفرست.\n\n${rows.map(paymentCard).join("\n\n") || "موردی پیدا نشد."}`); }
        id = String(rows[0]!.id);
      }
      if (["providerCreate", "transactionCreate"].includes(operation)) return reply(this.start(state, operation));
      if (["providerUpdate", "providerDelete", "providerTest", "providerGet", "transactionUpdate"].includes(operation)) {
        if (!id) { state.awaiting = text; return reply("🔎 شناسه یا شمارهٔ ردیف را مشخص کن؛ برای تراکنش ابتدا فهرست تراکنش‌ها را بخواه."); }
        if (operation === "transactionUpdate") {
          const row = state.rows.transactions.find(row => row.id === id);
          if (!row) return reply("🔎 این API مشاهدهٔ تکی تراکنش ندارد؛ ابتدا گزارش را با کد رزرو جست‌وجو و تراکنش را انتخاب کن.", "payment-invalid");
          state.snapshot = row;
          return reply(this.start(state, operation, id));
        }
        const current = await this.api.execute({ operation: "providerGet", id, input: {} }, context);
        if (!current.ok) return this.failure(current.code, current.status);
        state.rows.providers = [current.data];
        if (operation === "providerGet") return reply(paymentCard(current.data), "payment-read");
        state.snapshot = current.data;
        if (operation === "providerUpdate") return reply(this.start(state, operation, id));
        return this.propose({ operation, id, input: {} }, state);
      }
      const command: PaymentCommand = { operation, input: plan.input };
      if (["providers", "transactions"].includes(operation) && plan.input.page !== undefined && state.query.operation === operation) command.input = { ...(state.query.input as object), ...plan.input };
      if (operation === "providerBulk") {
        const input = { ...plan.input };
        if (input.scope === "filtered" && !/همه|تمام|all/iu.test(value)) { input.scope = "page"; input.ids = state.rows.providers.map(row => row.id); delete input.filters; }
        if (input.scope === "filtered" && !input.filters) input.filters = state.query.operation === "providers" ? Object.fromEntries(Object.entries(state.query.input as Row).filter(([key]) => ["search", "status"].includes(key))) : {};
        if (input.scope === "page" && !input.ids) input.ids = state.rows.providers.map(row => row.id);
        if (Array.isArray(input.ids) && input.ids.some(item => !state!.rows.providers.some(row => row.id === item) && !text.includes(String(item)))) return reply("🔎 فقط شناسه‌های دیده‌شده یا صریح قابل انتخاب‌اند.", "payment-invalid");
        command.input = input;
      }
      command.input = validatePaymentCommand(command).input;
      return paymentOperations[operation][0] === "GET" ? this.run(command, state, context) : this.propose(command, state);
    } catch { return reply("⚠️ درخواست معتبر آماده نشد؛ نوع عملیات و ردیف را دقیق‌تر بگو. چیزی ارسال یا تغییر داده نشد.", "payment-invalid"); }
  }
  private choices(state: State): PaymentChoice[] { return (["providers", "transactions"] as const).flatMap(resource => state.rows[resource].map(row => ({ id: String(row.id), title: String(resource === "providers" ? row.name : row.bookingGroupRef), resource }))); }
  private start(state: State, operation: PaymentOperation, id?: string) { state.draft = { operation, id, values: {}, step: 0 }; return prompt(state.draft); }
  private propose(command: PaymentCommand, state: State) {
    const input = validatePaymentCommand(command).input; command.input = input; state.command = command;
    const summary = { ...input };
    if (summary.merchantId !== undefined) summary.merchantId = "[محرمانه؛ پنهان]";
    for (const key of ["apiUrl", "callbackUrl"]) if (summary[key]) summary[key] = `${new URL(String(summary[key])).origin} [مسیر و پارامترها پنهان]`;
    const operationNames: Record<PaymentOperation, string> = { overview: "آمار پرداخت", providers: "فهرست درگاه‌ها", providerGet: "مشاهدهٔ درگاه", providerCreate: "ساخت درگاه", providerUpdate: "ویرایش درگاه", providerDelete: "حذف درگاه", providerTest: "تست درگاه", providerBulk: "عملیات گروهی درگاه‌ها", transactions: "فهرست تراکنش‌ها", transactionCreate: "ساخت درخواست پرداخت", transactionUpdate: "ویرایش مدیریتی تراکنش" };
    if (command.operation === "providerCreate" && summary.sandbox === undefined) summary.sandbox = "مشخص نشده؛ محیط آزمایشی تضمین نیست";
    const warning = command.operation === "providerTest" ? "⚠️ تست، درخواست واقعی پرداخت ۱۰۰۰ ریالی (۱۰۰ تومان) با شرح Health check ایجاد می‌کند و سلامت درگاه را ثبت می‌کند؛ پرداخت وجه را انجام نمی‌دهد و تضمین محیط آزمایشی نیست." : command.operation === "transactionCreate" ? `⚠️ درخواست واقعی پرداخت ساخته می‌شود؛ مبلغ ${input.amount} تومان = ${Number(input.amount) * 10} ریال. این کار برداشت/واریز قطعی نیست. این endpoint کلید idempotency ندارد؛ تکرار می‌تواند درخواست تکراری بسازد.` : command.operation === "transactionUpdate" ? "⚠️ فقط وضعیت/توضیح رکورد تغییر می‌کند؛ verified تأیید بانک نیست، refunded پولی برنمی‌گرداند و وضعیت رزرو تغییر نمی‌کند." : command.operation === "providerBulk" ? "⚠️ محدوده و فیلترها را بررسی کن؛ filtered در لحظهٔ اجرا انتخاب می‌شود. ممکن است برخی ردیف‌ها ناموفق شوند." : "⚠️ تغییر درگاه، پیش‌فرض، محیط یا حذف می‌تواند پرداخت‌های بعدی را مختل کند. حذف درگاه دارای تراکنش ممکن است مسدود شود.";
    return { status: "payment-proposed", reply: `**🔎 تأیید عملیات پرداخت**\n\n• عملیات: ${operationNames[command.operation]}${command.id ? `\n• شناسه: ${command.id}` : ""}\n${pretty(summary)}\n\n${warning}\n\n🔒 هنوز اجرا نشده. اجرا: «تأیید»؛ انصراف: «لغو». اعتبار: ۵ دقیقه.` };
  }
  private async findTransaction(snapshot: Row, context: RuleRequestContext) {
    // There is no individual GET. Bound the re-read instead of inventing one.
    const result = await this.api.execute({ operation: "transactions", input: { search: snapshot.bookingGroupRef, perPage: 50, page: 1, status: "all" } }, context);
    if (!result.ok) return result;
    if (Number(result.data.total) > 50) return { ok: false as const, code: "AMBIGUOUS_SNAPSHOT" };
    const row = (result.data.items as Row[]).find(row => row.id === snapshot.id);
    return row ? { ok: true as const, data: row } : { ok: false as const, code: "NOT_FOUND" };
  }
  private failure(code: string, status?: number) { return { status: "payment-error", reply: `⚠️ نتیجهٔ درخواست پرداخت تأیید نشد.\n• کد: ${code}${status ? `\n• HTTP: ${status}` : ""}\nدر خطای شبکه نتیجه ممکن است نامشخص باشد؛ ابتدا گزارش‌ها را بررسی کن. بدون بررسی دوباره درخواست نساز یا تست نکن.` }; }
  private async run(command: PaymentCommand, state: State, context: RuleRequestContext) {
    const result = await this.api.execute(command, context);
    if (!result.ok) return this.failure(result.code, result.status);
    if (command.operation === "providers" || command.operation === "transactions") {
      state.rows[command.operation] = result.data.items as Row[]; state.query = { operation: command.operation, input: command.input };
      return { status: "payment-listed", reply: `**💳 ${command.operation === "providers" ? "درگاه‌ها" : "تراکنش‌ها"}**\n\n• صفحه: ${result.data.page}\n• تعداد کل: ${result.data.total}\n\n${(result.data.items as Row[]).map(paymentCard).join("\n\n") || "📭 موردی پیدا نشد."}` };
    }
    if (command.operation === "providerBulk") {
      state.rows.providers = [];
      const data = result.data as { requested: number; succeeded: number; failures: { id: string; code: string }[] };
      return { status: "payment-completed", reply: `📋 نتیجهٔ عملیات گروهی درگاه‌ها\n• درخواستی: ${data.requested}\n• موفق: ${data.succeeded}\n• ناموفق: ${data.failures.length}\n${data.failures.map(item => `• ${item.id}: ${/^[A-Z][A-Z0-9_]{0,63}$/.test(item.code) ? item.code : "OPERATION_FAILED"}`).join("\n")}` };
    }
    if (command.operation === "transactionCreate") {
      return { status: "payment-completed", reply: `**💳 درخواست پرداخت ساخته شد؛ وجه هنوز پرداخت نشده**\n\n• شناسه: ${result.data.id}\n• لینک پرداخت:\n${result.data.paymentUrl}\n⚠️ لینک را فقط برای پرداخت‌کنندهٔ مجاز استفاده کن. درخواست را خودکار تکرار نکن.` };
    }
    if (command.operation === "transactionUpdate") return { status: "payment-completed", reply: `📋 تغییر مدیریتی رکورد تأیید شد؛ نه تأیید بانکی یا بازپرداخت.\n\n${paymentCard(result.data)}` };
    return { status: paymentOperations[command.operation][0] === "GET" ? "payment-read" : "payment-completed", reply: paymentCard(result.data) };
  }
}
export function paymentCard(row: Row, index = 0) {
  const labels: Record<string, string> = { id: "شناسه", name: "نام درگاه", kind: "نوع", merchantConfigured: "مرچنت تنظیم‌شده", isActive: "فعال", isDefault: "پیش‌فرض", healthStatus: "سلامت", lastHealthCheckedAt: "آخرین تست", bookingGroupRef: "کد گروه رزرو", amount: "مبلغ ثبت‌شده", currency: "واحد ثبت‌شده", description: "توضیح", status: "وضعیت رکورد", providerId: "شناسه درگاه", providerName: "نام درگاه", refId: "شناسه مرجع", createdAt: "ثبت", updatedAt: "ویرایش", verifiedAt: "زمان تأیید ثبت‌شده", expiresAt: "انقضا", activeProviderCount: "درگاه‌های فعال", totalTransactions: "کل تراکنش‌ها", verifiedCount: "رکوردهای verified", pendingCount: "رکوردهای pending", totalVolume: "جمع مبالغ رکوردهای verified", activeProviderPercentage: "درصد درگاه فعال", isSuccessful: "تست موفق", responseTimeMs: "زمان پاسخ (میلی‌ثانیه)", success: "تأیید سرویس" };
  return `**${row.isSuccessful === false ? "⚠️ تست درگاه ناموفق" : `💳 ${index + 1}. نتیجهٔ پرداخت`}**\n${Object.entries(labels).flatMap(([key, label]) => row[key] !== undefined && row[key] !== null ? [`• ${label}: ${typeof row[key] === "boolean" ? row[key] ? "بله" : "خیر" : /At$/.test(key) ? jalaliDate(String(row[key])) : String(row[key])}`] : []).join("\n")}`;
}
