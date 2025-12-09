// src/i18n/index.ts
// Central export for all translations

import { en, TranslationKeys } from './en';
import { he } from './he';

export type LanguageCode = 'en' | 'he' | 'ar' | 'es' | 'fr' | 'de' | 'zh' | 'ja' | 'ru' | 'pt';

export interface Language {
  code: LanguageCode;
  name: string;
  nativeName: string;
  direction: 'ltr' | 'rtl';
}

export const SUPPORTED_LANGUAGES: Language[] = [
  { code: 'en', name: 'English', nativeName: 'English', direction: 'ltr' },
  { code: 'he', name: 'Hebrew', nativeName: 'עברית', direction: 'rtl' },
/*  { code: 'ar', name: 'Arabic', nativeName: 'العربية', direction: 'rtl' },
  { code: 'es', name: 'Spanish', nativeName: 'Español', direction: 'ltr' },
  { code: 'fr', name: 'French', nativeName: 'Français', direction: 'ltr' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', direction: 'ltr' },
  { code: 'zh', name: 'Chinese', nativeName: '中文', direction: 'ltr' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', direction: 'ltr' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', direction: 'ltr' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', direction: 'ltr' },
*/
];

// Type for nested translations
export type Translations = typeof en;

// All translations map
export const translations: Record<LanguageCode, Translations> = {
  en,
  he,
  // Fallback to English for languages not yet translated
  ar: en, // TODO: Add Arabic translations
  es: en, // TODO: Add Spanish translations
  fr: en, // TODO: Add French translations
  de: en, // TODO: Add German translations
  zh: en, // TODO: Add Chinese translations
  ja: en, // TODO: Add Japanese translations
  ru: en, // TODO: Add Russian translations
  pt: en, // TODO: Add Portuguese translations
};

export { en, he };
export type { TranslationKeys };