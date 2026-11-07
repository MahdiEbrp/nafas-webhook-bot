/**
 * Persian/English text normalisation helpers.
 *
 * Persian users type with Arabic yeh/kaf, ZWNJ, Persian digits, lots of extra
 * spaces and sometimes without any vowels. Normalising first makes the lexical
 * router far more reliable, which matters because free models are small.
 */

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

export function normalize(text: string): string {
  let out = text.normalize("NFKC");

  // Persian / Arabic digits → ASCII
  out = out.replace(/[۰-۹]/g, (char) => String(PERSIAN_DIGITS.indexOf(char)));
  out = out.replace(/[٠-٩]/g, (char) => String(ARABIC_DIGITS.indexOf(char)));

  // Arabic letters → Persian equivalents
  out = out.replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/ۀ/g, "ه").replace(/أ|إ|آ/g, "ا");

  // Drop diacritics and ZWNJ, collapse whitespace
  out = out.replace(/[\u064B-\u0652\u0670\u200c\u200f\u200e]/g, "").replace(/\s+/g, " ");

  return out.trim();
}

export function normalizeLower(text: string): string {
  return normalize(text).toLowerCase();
}

/** "۱٬۲۳۴" / "1,234" / "۱۲۳۴" → 1234 */
export function toLatinDigits(text: string): string {
  return normalize(text).replace(/[^\d]/g, "");
}

const KID_GLOSSARY: Array<[RegExp, string]> = [
  [/webhook/gi, "دَرِ پشتیِ سایت (Webhook)"],
  [/api/gi, "دَرِ ورودیِ سایت (API)"],
  [/endpoint/gi, "آدرسِ دَر"],
  [/token/gi, "کارتِ ورود"],
  [/نسخه|deploy/gi, "نسخهٔ تازهٔ سایت"],
  [/rate.?limit/gi, "سهمیهٔ درخواست‌ها"],
];

/**
 * Last-resort safety net: if the model writes heavy jargon, soften a few terms.
 * The real "kid language" work is done by the prompt, this only catches leaks.
 */
export function softenJargon(text: string): string {
  let out = text;
  for (const [pattern, replacement] of KID_GLOSSARY) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Formats a list of Persian items into "الف، ب و ج" */
export function joinFa(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] as string;
  const head = items.slice(0, -1).join("، ");
  return `${head} و ${items[items.length - 1]}`;
}
