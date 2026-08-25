// src/contexts/LanguageContext.tsx
import React, { 
    createContext, 
    useContext, 
    useState, 
    useEffect, 
    useCallback, 
    ReactNode 
  } from 'react';
  import {
    translations,
    SUPPORTED_LANGUAGES,
    LanguageCode,
    Language,
    Translations
  } from '@/i18n';
  import { adaptStudentLabel } from '@/lib/studentLabel';
  
  // ============================================================================
  // TYPES
  // ============================================================================
  
  type TranslationValue = string | { [key: string]: TranslationValue };
  
  interface LanguageContextType {
    language: LanguageCode;
    languageInfo: Language;
    isRTL: boolean;
    direction: 'ltr' | 'rtl';
    setLanguage: (code: LanguageCode) => void;
    t: (key: string, params?: Record<string, string | number>) => string;
    supportedLanguages: Language[];
  }
  
  // ============================================================================
  // CONTEXT
  // ============================================================================
  
  const LanguageContext = createContext<LanguageContextType | null>(null);
  
  export const useLanguage = () => {
    const context = useContext(LanguageContext);
    if (!context) {
      throw new Error('useLanguage must be used within a LanguageProvider');
    }
    return context;
  };
  
  // ============================================================================
  // HELPER: Get nested value from object by dot-notation key
  // ============================================================================
  
  function getNestedValue(obj: any, path: string): string | undefined {
    const keys = path.split('.');
    let current = obj;
    
    for (const key of keys) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = current[key];
    }
    
    return typeof current === 'string' ? current : undefined;
  }
  
  // ============================================================================
  // HELPERS: locale resolution + persistence
  // ============================================================================

  const LANGUAGE_STORAGE_KEY = 'aac-language';

  const isSupported = (code: string | null | undefined): code is LanguageCode =>
    !!code && SUPPORTED_LANGUAGES.some(l => l.code === code);

  /**
   * The locale the URL itself names — either the per-locale landing path
   * (/he, /es, ...) or the ?lang=xx query the prerender crawler uses.
   * Returns null on every other path, including the English root.
   */
  function localeFromUrl(): LanguageCode | null {
    if (typeof window === 'undefined') return null;
    // First path segment must exactly match a supported locale code.
    const firstSegment = window.location.pathname.split('/').filter(Boolean)[0];
    if (isSupported(firstSegment)) return firstSegment;
    const queryLang = new URLSearchParams(window.location.search).get('lang');
    if (isSupported(queryLang)) return queryLang;
    return null;
  }

  function readStoredLanguage(): LanguageCode | null {
    if (typeof window === 'undefined') return null;
    try {
      const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
      return isSupported(stored) ? stored : null;
    } catch {
      // Safari private mode / blocked storage — fall through to detection.
      return null;
    }
  }

  function storeLanguage(code: LanguageCode): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
    } catch {
      /* storage unavailable — language is still correct for this page load */
    }
  }

  // ============================================================================
  // PROVIDER
  // ============================================================================
  
  interface LanguageProviderProps {
    children: ReactNode;
    defaultLanguage?: LanguageCode;
  }
  
  export const LanguageProvider = ({ 
    children, 
    defaultLanguage = 'en' 
  }: LanguageProviderProps) => {
    const [language, setLanguageState] = useState<LanguageCode>(() => {
      // URL path/query takes priority — the SEO-prerendered locale pages
      // (/he, /es, ...) must render in the language their URL advertises.
      const fromUrl = localeFromUrl();
      if (fromUrl) return fromUrl;
      const stored = readStoredLanguage();
      if (stored) return stored;
      if (typeof window !== 'undefined') {
        // Try to detect from browser
        const browserLang = navigator.language.split('-')[0];
        if (isSupported(browserLang)) return browserLang;
      }
      return defaultLanguage;
    });

    // Landing on a per-locale URL is an explicit language choice, so remember it.
    // Without this, following the landing page's "Log in" link (a real navigation
    // to /login, which carries no locale segment) re-resolved the language from
    // scratch and dropped the visitor back to the browser default.
    useEffect(() => {
      const fromUrl = localeFromUrl();
      if (fromUrl) storeLanguage(fromUrl);
      // Mount-only: later switches persist through setLanguage below.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
  
    const languageInfo = SUPPORTED_LANGUAGES.find(l => l.code === language) || SUPPORTED_LANGUAGES[0];
    const isRTL = languageInfo.direction === 'rtl';
    const direction = languageInfo.direction;
  
    // Apply direction to document
    useEffect(() => {
      document.documentElement.dir = direction;
      document.documentElement.lang = language;
      document.documentElement.setAttribute('data-direction', direction);
      
      // Add RTL/LTR class for easier CSS targeting
      if (isRTL) {
        document.documentElement.classList.add('rtl');
        document.documentElement.classList.remove('ltr');
      } else {
        document.documentElement.classList.add('ltr');
        document.documentElement.classList.remove('rtl');
      }
    }, [direction, language, isRTL]);
  
    const setLanguage = useCallback((code: LanguageCode) => {
      setLanguageState(code);
      storeLanguage(code);
    }, []);
  
    // Translation function with nested key support and parameter interpolation
    const t = useCallback((key: string, params?: Record<string, string | number>): string => {
      // Try current language first
      let value = getNestedValue(translations[language], key);
      
      // Fallback to English if not found
      if (value === undefined && language !== 'en') {
        value = getNestedValue(translations.en, key);
      }
      
      // Return key if still not found
      if (value === undefined) {
        console.warn(`Translation key not found: ${key}`);
        return key;
      }
  
      // Interpolate parameters
      if (params) {
        value = Object.entries(params).reduce((str, [paramKey, paramValue]) => {
          return str.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramValue));
        }, value);
      }

      // Replace {{STUDENT}}/{{STUDENTS}} placeholders with context-appropriate labels
      return adaptStudentLabel(value);
    }, [language]);
  
    const contextValue: LanguageContextType = {
      language,
      languageInfo,
      isRTL,
      direction,
      setLanguage,
      t,
      supportedLanguages: SUPPORTED_LANGUAGES,
    };
  
    return (
      <LanguageContext.Provider value={contextValue}>
        {children}
      </LanguageContext.Provider>
    );
  };
  
  // Re-export types and constants for convenience
  export { SUPPORTED_LANGUAGES };
  export type { LanguageCode, Language };