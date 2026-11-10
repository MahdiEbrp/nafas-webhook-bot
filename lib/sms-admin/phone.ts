const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

function toLatinDigits(value: string): string {
  return [...value]
    .map((character) => {
      const persianIndex = PERSIAN_DIGITS.indexOf(character);
      if (persianIndex >= 0) return String(persianIndex);
      const arabicIndex = ARABIC_DIGITS.indexOf(character);
      return arabicIndex >= 0 ? String(arabicIndex) : character;
    })
    .join("");
}

/** Normalizes Iranian mobile formats to +989xxxxxxxxx. */
export function normalizeIranianPhone(value: string): string | null {
  const compact = toLatinDigits(value).replace(/[\s().-]/g, "");
  let normalized = compact;
  if (normalized.startsWith("0098")) normalized = `+${normalized.slice(2)}`;
  else if (normalized.startsWith("98")) normalized = `+${normalized}`;
  else if (normalized.startsWith("09")) normalized = `+98${normalized.slice(1)}`;
  if (!/^\+989\d{9}$/.test(normalized)) return null;
  return normalized;
}

