/**
 * Language Context for AAC client
 * Provides language selection, RTL support, and translation functions
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from "react";
import {
  translations,
  SUPPORTED_LANGUAGES,
  SUPPORTED_SIGN_LANGUAGES,
  DEFAULT_LANGUAGE,
  type LanguageCode,
  type Language,
  type SignLanguageCode,
  type SignLanguage,
  type Translations,
  isValidLanguageCode,
  isValidSignLanguageCode,
  getLanguageByCode,
} from "@/i18n";

const STORAGE_KEY = "aac-language";
const SIGN_LANGUAGE_STORAGE_KEY = "aac-sign-language";

interface LanguageContextType {
  /** Current language code */
  language: LanguageCode;
  /** Full language info (code, name, nativeName, direction) */
  languageInfo: Language;
  /** Whether current language is RTL */
  isRTL: boolean;
  /** Text direction ('ltr' or 'rtl') */
  direction: "ltr" | "rtl";
  /** Change the current language */
  setLanguage: (code: LanguageCode) => void;
  /** Translation function with optional parameter interpolation */
  t: (key: string, params?: Record<string, string | number>) => string;
  /** List of supported languages */
  supportedLanguages: Language[];
  /** Current sign language (null = disabled) */
  signLanguage: SignLanguageCode | null;
  /** Change the current sign language (null to disable) */
  setSignLanguage: (code: SignLanguageCode | null) => void;
  /** List of supported sign languages */
  supportedSignLanguages: SignLanguage[];
}

const LanguageContext = createContext<LanguageContextType | null>(null);

interface LanguageProviderProps {
  children: ReactNode;
  defaultLanguage?: LanguageCode;
}

export function LanguageProvider({ children, defaultLanguage = DEFAULT_LANGUAGE }: LanguageProviderProps) {
  // Initialize language from localStorage or browser preference
  const [language, setLanguageState] = useState<LanguageCode>(() => {
    // Try localStorage first
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isValidLanguageCode(stored)) {
      return stored;
    }

    // Try browser language
    const browserLang = navigator.language.split("-")[0];
    if (isValidLanguageCode(browserLang)) {
      return browserLang;
    }

    return defaultLanguage;
  });

  // Initialize sign language from localStorage
  const [signLanguage, setSignLanguageState] = useState<SignLanguageCode | null>(() => {
    const stored = localStorage.getItem(SIGN_LANGUAGE_STORAGE_KEY);
    if (stored && isValidSignLanguageCode(stored)) {
      return stored;
    }
    return null;
  });

  // Get current language info
  const languageInfo = useMemo(() => {
    return getLanguageByCode(language) || SUPPORTED_LANGUAGES[0];
  }, [language]);

  // Derived values
  const isRTL = languageInfo.direction === "rtl";
  const direction = languageInfo.direction;

  // Apply language settings to document
  useEffect(() => {
    document.documentElement.dir = direction;
    document.documentElement.lang = language;

    // Add RTL/LTR class to root element
    document.documentElement.classList.remove("rtl", "ltr");
    document.documentElement.classList.add(direction);
  }, [language, direction]);

  // Change language handler
  const setLanguage = useCallback((code: LanguageCode) => {
    setLanguageState(code);
    localStorage.setItem(STORAGE_KEY, code);
  }, []);

  // Change sign language handler
  const setSignLanguage = useCallback((code: SignLanguageCode | null) => {
    setSignLanguageState(code);
    if (code) {
      localStorage.setItem(SIGN_LANGUAGE_STORAGE_KEY, code);
    } else {
      localStorage.removeItem(SIGN_LANGUAGE_STORAGE_KEY);
    }
  }, []);

  // Translation function with parameter interpolation
  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      // Get nested value using dot notation
      const keys = key.split(".");
      let value: any = translations[language];

      for (const k of keys) {
        if (value && typeof value === "object" && k in value) {
          value = value[k];
        } else {
          // Fallback to English
          value = translations.en;
          for (const fallbackKey of keys) {
            if (value && typeof value === "object" && fallbackKey in value) {
              value = value[fallbackKey];
            } else {
              // Return key if not found
              console.warn(`[i18n] Missing translation key: ${key}`);
              return key;
            }
          }
          break;
        }
      }

      // If not a string, return key
      if (typeof value !== "string") {
        console.warn(`[i18n] Translation key "${key}" is not a string`);
        return key;
      }

      // Interpolate parameters
      if (params) {
        return value.replace(/\{(\w+)\}/g, (_, paramKey) => {
          return params[paramKey]?.toString() ?? `{${paramKey}}`;
        });
      }

      return value;
    },
    [language]
  );

  const contextValue = useMemo(
    () => ({
      language,
      languageInfo,
      isRTL,
      direction,
      setLanguage,
      t,
      supportedLanguages: SUPPORTED_LANGUAGES,
      signLanguage,
      setSignLanguage,
      supportedSignLanguages: SUPPORTED_SIGN_LANGUAGES,
    }),
    [language, languageInfo, isRTL, direction, setLanguage, t, signLanguage, setSignLanguage]
  );

  return (
    <LanguageContext.Provider value={contextValue}>
      {children}
    </LanguageContext.Provider>
  );
}

/**
 * Hook to access language context
 * @throws Error if used outside of LanguageProvider
 */
export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return context;
}

export { type LanguageCode, type Language, type SignLanguageCode, type SignLanguage };
