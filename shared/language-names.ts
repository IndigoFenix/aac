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

// Reverse lookup (lowercased English name → code), so helpers below accept
// either a code ("he") or a display name ("Hebrew") — the live agents thread a
// code, but the social peer prompt is handed the resolved NAME.
const NAME_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(LANGUAGE_NAMES).map(([code, name]) => [name.toLowerCase(), code]),
);

/**
 * Languages whose SECOND-PERSON address / predicate marks the addressee's
 * grammatical gender (verbs, pronouns, and/or adjectives), so a prompt must be
 * told the student's gender to conjugate correctly. Codes only; resolved via
 * NAME_TO_CODE when a display name is passed. Deliberately EXCLUDES languages
 * where address is gender-neutral (English, Mandarin, Cantonese, Korean) and
 * German (2nd-person verbs/predicate adjectives don't inflect for the
 * addressee's gender), to avoid emitting a pointless directive.
 */
const GENDER_MARKING_LANGUAGES = new Set(["he", "ar", "es", "pt", "fr", "ru"]);

/** True when `codeOrName` is a language that marks the addressee's grammatical
 *  gender (see GENDER_MARKING_LANGUAGES). Accepts a code or an English name. */
export function languageMarksGender(codeOrName: string | null | undefined): boolean {
  if (!codeOrName) return false;
  const s = codeOrName.trim().toLowerCase();
  if (GENDER_MARKING_LANGUAGES.has(s)) return true;
  const code = NAME_TO_CODE[s];
  return code ? GENDER_MARKING_LANGUAGES.has(code) : false;
}
