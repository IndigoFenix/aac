/**
 * i18n module for AAC client
 * Exports translations and language configuration
 */

import { en, type Translations } from "./en";
import { he } from "./he";

export type LanguageCode = "en" | "he";

export interface Language {
  code: LanguageCode;
  name: string;
  nativeName: string;
  direction: "ltr" | "rtl";
}

export const SUPPORTED_LANGUAGES: Language[] = [
  { code: "en", name: "English", nativeName: "English", direction: "ltr" },
  { code: "he", name: "Hebrew", nativeName: "עברית", direction: "rtl" },
];

export const translations: Record<LanguageCode, Translations> = {
  en,
  he,
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

export type SignLanguageCode = "asl" | "isl";

export interface SignLanguage {
  code: SignLanguageCode;
  name: string;
  nativeName: string;
}

export const SUPPORTED_SIGN_LANGUAGES: SignLanguage[] = [
  { code: "asl", name: "American Sign Language", nativeName: "ASL" },
  { code: "isl", name: "Israeli Sign Language", nativeName: "שפת הסימנים" },
];

export function isValidSignLanguageCode(code: string): code is SignLanguageCode {
  return SUPPORTED_SIGN_LANGUAGES.some((lang) => lang.code === code);
}

export { type Translations } from "./en";
