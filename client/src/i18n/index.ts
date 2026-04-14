// src/i18n/index.ts
// Central export for all translations

import { en } from './en';
import { he } from './he';
import { es } from './es';
import { pt } from './pt';
import { fr } from './fr';
import { ru } from './ru';
import { de } from './de';
import { ar } from './ar';
import { zh } from './zh';
import { yue } from './yue';
import { ko } from './ko';

export type LanguageCode = 'en' | 'he' | 'es' | 'pt' | 'fr' | 'ru' | 'de' | 'ar' | 'zh' | 'yue' | 'ko';

export interface Language {
  code: LanguageCode;
  name: string;
  nativeName: string;
  direction: 'ltr' | 'rtl';
}

export const SUPPORTED_LANGUAGES: Language[] = [
  { code: 'en', name: 'English', nativeName: 'English', direction: 'ltr' },
  { code: 'he', name: 'Hebrew', nativeName: 'עברית', direction: 'rtl' },
  { code: 'es', name: 'Spanish', nativeName: 'Español', direction: 'ltr' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', direction: 'ltr' },
  { code: 'fr', name: 'French', nativeName: 'Français', direction: 'ltr' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', direction: 'ltr' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', direction: 'ltr' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', direction: 'rtl' },
  { code: 'zh', name: 'Mandarin', nativeName: '中文', direction: 'ltr' },
  { code: 'yue', name: 'Cantonese', nativeName: '粵語', direction: 'ltr' },
  { code: 'ko', name: 'Korean', nativeName: '한국어', direction: 'ltr' },
];

// Type for nested translations
export type Translations = typeof en;

// All translations map
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

export { en, he, es, pt, fr, ru, de, ar, zh, yue, ko };