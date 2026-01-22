// Hebrew symbol translations and cultural adaptations
export interface HebrewSymbol {
  id: string;
  label: string;
  labelHe: string;
  emoji: string;
  category: string;
  confidence: number;
  reasoning: string;
}

export const hebrewSymbolTranslations: Record<string, HebrewSymbol> = {
  // Basic responses
  "yes": {
    id: "yes",
    label: "Yes",
    labelHe: "כן",
    emoji: "✅",
    category: "response",
    confidence: 0.9,
    reasoning: "Basic positive response"
  },
  "no": {
    id: "no", 
    label: "No",
    labelHe: "לא",
    emoji: "❌",
    category: "response",
    confidence: 0.9,
    reasoning: "Basic negative response"
  },
  
  // Emotions
  "happy": {
    id: "happy",
    label: "Happy",
    labelHe: "שמח",
    emoji: "😊",
    category: "emotion",
    confidence: 0.8,
    reasoning: "Common positive emotion"
  },
  "sad": {
    id: "sad",
    label: "Sad", 
    labelHe: "עצוב",
    emoji: "😢",
    category: "emotion",
    confidence: 0.8,
    reasoning: "Common negative emotion"
  },
  "angry": {
    id: "angry",
    label: "Angry",
    labelHe: "כועס",
    emoji: "😠",
    category: "emotion",
    confidence: 0.7,
    reasoning: "Strong negative emotion"
  },
  "love": {
    id: "love",
    label: "Love",
    labelHe: "אהבה",
    emoji: "❤️",
    category: "emotion",
    confidence: 0.8,
    reasoning: "Strong positive emotion"
  },
  
  // Basic needs
  "eat": {
    id: "eat",
    label: "Eat",
    labelHe: "לאכול",
    emoji: "🍽️",
    category: "need",
    confidence: 0.9,
    reasoning: "Basic human need"
  },
  "drink": {
    id: "drink",
    label: "Drink",
    labelHe: "לשתות",
    emoji: "🥤",
    category: "need",
    confidence: 0.9,
    reasoning: "Basic human need"
  },
  "sleep": {
    id: "sleep",
    label: "Sleep",
    labelHe: "לישון",
    emoji: "😴",
    category: "need",
    confidence: 0.8,
    reasoning: "Basic human need"
  },
  "help": {
    id: "help",
    label: "Help",
    labelHe: "עזרה",
    emoji: "🙋",
    category: "need",
    confidence: 0.9,
    reasoning: "Common request"
  },
  
  // Activities
  "play": {
    id: "play",
    label: "Play",
    labelHe: "לשחק",
    emoji: "🎮",
    category: "activity",
    confidence: 0.8,
    reasoning: "Common activity"
  },
  "learn": {
    id: "learn",
    label: "Learn",
    labelHe: "ללמוד",
    emoji: "📚",
    category: "activity",
    confidence: 0.7,
    reasoning: "Educational activity"
  },
  "work": {
    id: "work",
    label: "Work",
    labelHe: "לעבוד",
    emoji: "💼",
    category: "activity",
    confidence: 0.7,
    reasoning: "Common activity"
  },
  "music": {
    id: "music",
    label: "Music",
    labelHe: "מוזיקה",
    emoji: "🎵",
    category: "activity",
    confidence: 0.6,
    reasoning: "Entertainment activity"
  },
  
  // Family and relationships (culturally adapted for Hebrew speakers)
  "family": {
    id: "family",
    label: "Family",
    labelHe: "משפחה",
    emoji: "👨‍👩‍👧‍👦",
    category: "people",
    confidence: 0.8,
    reasoning: "Important relationship concept"
  },
  "mom": {
    id: "mom",
    label: "Mom",
    labelHe: "אמא",
    emoji: "👩",
    category: "people",
    confidence: 0.9,
    reasoning: "Primary caregiver"
  },
  "dad": {
    id: "dad",
    label: "Dad",
    labelHe: "אבא",
    emoji: "👨",
    category: "people",
    confidence: 0.9,
    reasoning: "Primary caregiver"
  },
  "friend": {
    id: "friend",
    label: "Friend",
    labelHe: "חבר",
    emoji: "👫",
    category: "people",
    confidence: 0.7,
    reasoning: "Social relationship"
  },
  
  // Common requests
  "want": {
    id: "want",
    label: "Want",
    labelHe: "רוצה",
    emoji: "🙏",
    category: "request",
    confidence: 0.9,
    reasoning: "Common desire expression"
  },
  "need": {
    id: "need",
    label: "Need",
    labelHe: "צריך",
    emoji: "❗",
    category: "request",
    confidence: 0.9,
    reasoning: "Strong necessity expression"
  },
  "more": {
    id: "more",
    label: "More",
    labelHe: "עוד",
    emoji: "➕",
    category: "request",
    confidence: 0.8,
    reasoning: "Common quantity request"
  },
  "stop": {
    id: "stop",
    label: "Stop",
    labelHe: "עצור",
    emoji: "⏹️",
    category: "request",
    confidence: 0.8,
    reasoning: "Important control command"
  },
  
  // Places (adapted for Israeli context)
  "home": {
    id: "home",
    label: "Home",
    labelHe: "בית",
    emoji: "🏠",
    category: "place",
    confidence: 0.8,
    reasoning: "Primary location"
  },
  "school": {
    id: "school",
    label: "School",
    labelHe: "בית ספר",
    emoji: "🏫",
    category: "place",
    confidence: 0.7,
    reasoning: "Educational environment"
  },
  "park": {
    id: "park",
    label: "Park",
    labelHe: "גן",
    emoji: "🌳",
    category: "place",
    confidence: 0.6,
    reasoning: "Recreation location"
  },
  "hospital": {
    id: "hospital",
    label: "Hospital",
    labelHe: "בית חולים",
    emoji: "🏥",
    category: "place",
    confidence: 0.5,
    reasoning: "Medical facility"
  }
};

export function getHebrewSymbol(symbolId: string): HebrewSymbol | null {
  return hebrewSymbolTranslations[symbolId] || null;
}

export function getAllHebrewSymbols(): HebrewSymbol[] {
  return Object.values(hebrewSymbolTranslations);
}

export function getSymbolsByCategory(category: string, language: string = "en"): HebrewSymbol[] {
  return Object.values(hebrewSymbolTranslations)
    .filter(symbol => symbol.category === category)
    .sort((a, b) => b.confidence - a.confidence);
}

// Hebrew-specific contextual symbol suggestions
export function getHebrewContextualSymbols(context: string): HebrewSymbol[] {
  const suggestions: HebrewSymbol[] = [];
  const lowerContext = context.toLowerCase();
  
  // Meal time context
  if (lowerContext.includes('meal') || lowerContext.includes('kitchen') || lowerContext.includes('food')) {
    suggestions.push(
      hebrewSymbolTranslations.eat,
      hebrewSymbolTranslations.drink,
      hebrewSymbolTranslations.want,
      hebrewSymbolTranslations.more
    );
  }
  
  // School/learning context
  if (lowerContext.includes('school') || lowerContext.includes('study') || lowerContext.includes('learn')) {
    suggestions.push(
      hebrewSymbolTranslations.learn,
      hebrewSymbolTranslations.help,
      hebrewSymbolTranslations.need,
      hebrewSymbolTranslations.yes,
      hebrewSymbolTranslations.no
    );
  }
  
  // Play/recreation context
  if (lowerContext.includes('play') || lowerContext.includes('game') || lowerContext.includes('fun')) {
    suggestions.push(
      hebrewSymbolTranslations.play,
      hebrewSymbolTranslations.happy,
      hebrewSymbolTranslations.more,
      hebrewSymbolTranslations.friend
    );
  }
  
  // Home/family context
  if (lowerContext.includes('home') || lowerContext.includes('family')) {
    suggestions.push(
      hebrewSymbolTranslations.family,
      hebrewSymbolTranslations.mom,
      hebrewSymbolTranslations.dad,
      hebrewSymbolTranslations.home,
      hebrewSymbolTranslations.love
    );
  }
  
  // Default fallback symbols
  if (suggestions.length === 0) {
    suggestions.push(
      hebrewSymbolTranslations.yes,
      hebrewSymbolTranslations.no,
      hebrewSymbolTranslations.want,
      hebrewSymbolTranslations.help,
      hebrewSymbolTranslations.happy
    );
  }
  
  return suggestions;
}