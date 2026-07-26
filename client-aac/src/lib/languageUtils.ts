// Language utility functions for Hebrew and English support

export interface LanguageConfig {
  code: string;
  name: string;
  direction: 'ltr' | 'rtl';
  fontFamily?: string;
}

export const SUPPORTED_LANGUAGES: LanguageConfig[] = [
  {
    code: 'en',
    name: 'English',
    direction: 'ltr'
  },
  {
    code: 'he',
    name: 'עברית',
    direction: 'rtl',
    fontFamily: '"Noto Sans Hebrew", Arial, sans-serif'
  }
];

export function getLanguageConfig(languageCode: string): LanguageConfig {
  return SUPPORTED_LANGUAGES.find(lang => lang.code === languageCode) || SUPPORTED_LANGUAGES[0];
}

export function isRTL(languageCode: string): boolean {
  const config = getLanguageConfig(languageCode);
  return config.direction === 'rtl';
}

export function getTextDirection(languageCode: string): 'ltr' | 'rtl' {
  return getLanguageConfig(languageCode).direction;
}

export function getLanguageFontFamily(languageCode: string): string | undefined {
  return getLanguageConfig(languageCode).fontFamily;
}

// Common UI text translations
export const UI_TRANSLATIONS = {
  en: {
    // Symbol board
    noSymbolsAvailable: "No symbols available",
    loadingSymbols: "Loading symbols...",
    symbolConfidence: "Confidence",
    
    // Chat interface
    typeMessage: "Type your message...",
    sendMessage: "Send",
    clearChat: "Clear Chat",
    noMessages: "No messages yet",
    
    // Controls
    settings: "Settings",
    back: "Back",
    save: "Save",
    cancel: "Cancel",
    
    // Status indicators
    cameraBlocked: "Camera Blocked",
    noOnePresent: "No One Present",
    userNotPresent: "User Not Present",
    standbyMode: "Standby Mode",
    
    // Common actions
    yes: "Yes",
    no: "No",
    more: "More",
    stop: "Stop",
    help: "Help",
    thanks: "Thanks"
  },
  he: {
    // Symbol board
    noSymbolsAvailable: "אין סמלים זמינים",
    loadingSymbols: "טוען סמלים...",
    symbolConfidence: "רמת ביטחון",
    
    // Chat interface
    typeMessage: "הקלד הודעה...",
    sendMessage: "שלח",
    clearChat: "נקה צ'אט",
    noMessages: "אין הודעות עדיין",
    
    // Controls
    settings: "הגדרות",
    back: "חזרה",
    save: "שמור",
    cancel: "ביטול",
    
    // Status indicators
    cameraBlocked: "המצלמה חסומה",
    noOnePresent: "אף אחד לא נוכח",
    userNotPresent: "המשתמש לא נוכח",
    standbyMode: "מצב המתנה",
    
    // Common actions
    yes: "כן",
    no: "לא",
    more: "עוד",
    stop: "עצור",
    help: "עזרה",
    thanks: "תודה"
  }
};

export function translate(key: string, language: string = 'en'): string {
  const translations = UI_TRANSLATIONS[language as keyof typeof UI_TRANSLATIONS] || UI_TRANSLATIONS.en;
  return translations[key as keyof typeof translations] || UI_TRANSLATIONS.en[key as keyof typeof UI_TRANSLATIONS.en] || key;
}

export function detectLanguageFromText(text: string): string {
  // Simple Hebrew detection - check for Hebrew characters
  const hebrewRegex = /[\u0590-\u05FF]/;
  return hebrewRegex.test(text) ? 'he' : 'en';
}

export function formatTextDirection(text: string, language: string): { text: string; dir: 'ltr' | 'rtl' } {
  const direction = getTextDirection(language);
  return {
    text,
    dir: direction
  };
}