/** Telegram native entities use UTF-16 offsets, just like JS string indices.
 * No HTML/Markdown parsing is entrusted to Telegram or to external records. */
export type TextEntity = { type: "bold" | "code"; offset: number; length: number };
const digits = (value: string) => value.replace(/[0-9]/g, digit => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]!);

export function jalaliDate(value: string | number | Date): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "نامشخص";
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", { timeZone: "Asia/Tehran", year: "numeric", month: "long", day: "numeric" }).format(date);
}

export function formatTelegramText(input: string, now = new Date()) {
  const entities: TextEntity[] = [];
  let text = "";
  for (const original of input.split("\n")) {
    let line = original;
    // Whole command lines, JSON, identifiers, and passwords must remain exact.
    const technicalLine = /^\s*(?:\/\w|[{[]|[0-9a-f]{8}-[0-9a-f-]{27}\s*:)/iu.test(line);
    if (!technicalLine) {
      line = line.replace(/(^|\s)(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?)(?=$|\s)/gu,
        (whole, space: string, date: string) => jalaliDate(date) === "نامشخص" ? whole : `${space}${jalaliDate(date)}`);
      line = line.replace(/^(\s*)[-*]\s+/u, "$1• ");
      line = line.replace(/((?:صفحه|تعداد کل|درخواستی|موفق|ناموفق|مجموع|مرحله)\s*[:：]\s*)([0-9]+)/gu,
        (_whole, label: string, number: string) => label + digits(number));
    }
    const heading = !technicalLine && line.match(/^\*\*(.+)\*\*$/u);
    if (heading) line = heading[1]!;
    const start = text.length;
    if (technicalLine) {
      text += line;
      if (line.length) entities.push({ type: "code", offset: start, length: line.length });
    } else {
      // Preserve machine-readable tokens (including all long numeric strings).
      const protectedToken = /https?:\/\/\S+|[A-Za-z0-9_+@./:\-]*[A-Za-z_@][A-Za-z0-9_+@./:\-]*|\+?[0-9]{5,}/g;
      const tokens = /شناسه|(?:user|chat) id/iu.test(line)
        ? new RegExp(`${protectedToken.source}|-?[0-9]+`, "g") : protectedToken;
      let end = 0;
      for (const match of line.matchAll(tokens)) {
        text += digits(line.slice(end, match.index));
        const offset = text.length;
        text += match[0];
        if (/[0-9@_/]/u.test(match[0])) entities.push({ type: "code", offset, length: match[0].length });
        end = match.index! + match[0].length;
      }
      text += digits(line.slice(end));
      if (heading) entities.push({ type: "bold", offset: start, length: text.length - start });
      else {
        const label = line.match(/^(?:[^\p{L}\p{N}]*)([\p{Script=Arabic}\s‌]+[:：])/u);
        if (label) entities.push({ type: "bold", offset: start, length: label[0].length });
      }
    }
    text += "\n";
  }
  text = text.trimEnd();
  // The stamp is the send date, not a fabricated record creation date.
  const stamp = `\n\n🗓 ارسال: ${jalaliDate(now)}`;
  text += stamp;
  return { text, entities: entities.filter(entity => entity.type !== "code" || !entities.some(bold => bold.type === "bold" && entity.offset < bold.offset + bold.length && entity.offset + entity.length > bold.offset)) };
}

/** Chunk after formatting, retaining entities and avoiding split surrogate pairs. */
export function telegramChunks(text: string, entities: TextEntity[], limit = 3900) {
  const chunks: Array<{ text: string; entities: TextEntity[] }> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      if (newline > start + limit / 2) end = newline + 1;
      if (/[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
    }
    chunks.push({ text: text.slice(start, end), entities: entities.flatMap(entity => {
      const a = Math.max(start, entity.offset), b = Math.min(end, entity.offset + entity.length);
      return b > a ? [{ ...entity, offset: a - start, length: b - a }] : [];
    }) });
    start = end;
  }
  return chunks;
}
