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
      if (typeof window !== 'undefined') {
        // Check localStorage first
        const stored = localStorage.getItem('aac-language') as LanguageCode;
        if (stored && SUPPORTED_LANGUAGES.some(l => l.code === stored)) {
          return stored;
        }
        // Try to detect from browser
        const browserLang = navigator.language.split('-')[0] as LanguageCode;
        if (SUPPORTED_LANGUAGES.some(l => l.code === browserLang)) {
          return browserLang;
        }
      }
      return defaultLanguage;
    });
  
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
      if (typeof window !== 'undefined') {
        localStorage.setItem('aac-language', code);
      }
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
        return Object.entries(params).reduce((str, [paramKey, paramValue]) => {
          return str.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramValue));
        }, value);
      }
  
      return value;
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