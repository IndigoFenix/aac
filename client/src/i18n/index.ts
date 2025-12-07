import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en.json';
import he from './locales/he.json';

const resources = {
  en: {
    translation: en
  },
  he: {
    translation: he
  }
};

// Set document direction based on language
const updateDirection = (language: string) => {
  const dir = language === 'he' ? 'rtl' : 'ltr';
  document.documentElement.dir = dir;
  document.documentElement.lang = language;
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    debug: import.meta.env.DEV,
    
    interpolation: {
      escapeValue: false
    },

    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage']
    }
  });

// Set initial direction
updateDirection(i18n.language);

// Update direction when language changes
i18n.on('languageChanged', updateDirection);

export default i18n;