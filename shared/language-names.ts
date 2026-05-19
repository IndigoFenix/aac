/**
 * Canonical mapping from ISO-style language codes to English display names.
 * Used wherever a language code is surfaced to a human or an LLM — the raw
 * 2-letter code is ambiguous to large models (e.g. "he" is not reliably read
 * as Hebrew), so prompts should always include the full name.
 *
 * Mirrors the codes in `client-aac/src/i18n/index.ts` and
 * `shared/schema-private.ts` (students.primary_language enum).
 */

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  he: "Hebrew",
  es: "Spanish",
  pt: "Portuguese",
  fr: "French",
  ru: "Russian",
  de: "German",
  ar: "Arabic",
  zh: "Mandarin",
  yue: "Cantonese",
  ko: "Korean",
};

/**
 * Return the English name for a language code (e.g. "he" → "Hebrew").
 * Falls back to the code itself when unknown so callers always get a string.
 */
export function getLanguageName(code: string | null | undefined): string {
  if (!code) return "English";
  return LANGUAGE_NAMES[code] ?? code;
}
