/**
 * i18n module for AAC client
 * Exports translations and language configuration
 */

import { en, type Translations } from "./en";
import { he } from "./he";
import { es } from "./es";
import { pt } from "./pt";
import { fr } from "./fr";
import { ru } from "./ru";
import { de } from "./de";
import { ar } from "./ar";
import { zh } from "./zh";
import { yue } from "./yue";
import { ko } from "./ko";

export type LanguageCode = "en" | "he" | "es" | "pt" | "fr" | "ru" | "de" | "ar" | "zh" | "yue" | "ko";

export interface Language {
  code: LanguageCode;
  name: string;
  nativeName: string;
  direction: "ltr" | "rtl";
}

export const SUPPORTED_LANGUAGES: Language[] = [
  { code: "en", name: "English", nativeName: "English", direction: "ltr" },
  { code: "he", name: "Hebrew", nativeName: "עברית", direction: "rtl" },
  { code: "es", name: "Spanish", nativeName: "Español", direction: "ltr" },
  { code: "pt", name: "Portuguese", nativeName: "Português", direction: "ltr" },
  { code: "fr", name: "French", nativeName: "Français", direction: "ltr" },
  { code: "ru", name: "Russian", nativeName: "Русский", direction: "ltr" },
  { code: "de", name: "German", nativeName: "Deutsch", direction: "ltr" },
  { code: "ar", name: "Arabic", nativeName: "العربية", direction: "rtl" },
  { code: "zh", name: "Mandarin", nativeName: "中文", direction: "ltr" },
  { code: "yue", name: "Cantonese", nativeName: "粵語", direction: "ltr" },
  { code: "ko", name: "Korean", nativeName: "한국어", direction: "ltr" },
];

export const translations: Record<LanguageCode, Translations> = {
  en,
  he,
  es,
  pt,
  fr,
  ru,
  de,
  ar,
  zh,
  yue,
  ko,
};

export const DEFAULT_LANGUAGE: LanguageCode = "en";

export function getLanguageByCode(code: string): Language | undefined {
  return SUPPORTED_LANGUAGES.find((lang) => lang.code === code);
}

export function isValidLanguageCode(code: string): code is LanguageCode {
  return SUPPORTED_LANGUAGES.some((lang) => lang.code === code);
}

// =============================================================================
// SIGN LANGUAGES
// =============================================================================

// `isr` is the ISO 639-3 code for Israeli Sign Language. We use it instead of
// the ambiguous "ISL" (which also denotes Indian / Indonesian Sign Language).
export type SignLanguageCode = "asl" | "isr";

export interface SignLanguage {
  code: SignLanguageCode;
  name: string;
  nativeName: string;
}

export const SUPPORTED_SIGN_LANGUAGES: SignLanguage[] = [
  { code: "asl", name: "American Sign Language", nativeName: "ASL" },
  { code: "isr", name: "Israeli Sign Language", nativeName: "שפת הסימנים" },
];

export function isValidSignLanguageCode(code: string): code is SignLanguageCode {
  return SUPPORTED_SIGN_LANGUAGES.some((lang) => lang.code === code);
}

export { type Translations } from "./en";
