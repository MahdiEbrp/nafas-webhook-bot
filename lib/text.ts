/**
 * Text helpers.
 *
 * Persian users type with Arabic yeh/kaf, ZWNJ and Persian digits, so messages
 * are normalised before they reach the model. And because Telegram caps a
 * message at 4096 characters, long answers are cut at a sentence boundary
 * instead of mid-word — a hard cut looks like a broken bot on a phone.
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

  // Drop diacritics and invisible marks, collapse whitespace
  out = out.replace(/[\u064B-\u0652\u0670\u200c\u200f\u200e]/g, "").replace(/\s+/g, " ");

  return out.trim();
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function withEllipsis(text: string): string {
  return /[.!?؟…]$/.test(text) ? text : `${text}…`;
}

/** Cuts at a sentence boundary instead of a character boundary. */
export function truncateAtSentence(text: string, max: number): string {
  if (text.length <= max) return text;

  const window = text.slice(0, max);
  let boundary = -1;
  for (const mark of [". ", "! ", "? ", "؟ ", "… ", ".\n", "!\n", "?\n", "\n"]) {
    const index = window.lastIndexOf(mark);
    if (index === -1) continue;
    const end = mark === "\n" ? index : index + 1;
    if (end > boundary) boundary = end;
  }

  // Only trust a boundary in the second half, otherwise we would return a stub.
  if (boundary > max * 0.5) return withEllipsis(window.slice(0, boundary).trimEnd());

  const space = window.lastIndexOf(" ");
  if (space > max * 0.5) return withEllipsis(window.slice(0, space).trimEnd());

  return withEllipsis(window.trimEnd());
}
