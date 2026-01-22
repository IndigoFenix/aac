// Parts of Speech Color-Coding and Organization System

export type PartOfSpeech = 
  | 'noun' 
  | 'pronoun' 
  | 'verb' 
  | 'adjective' 
  | 'adverb' 
  | 'preposition' 
  | 'conjunction' 
  | 'interjection'
  | 'article'
  | 'unknown';

export interface PartsOfSpeechColors {
  noun: string;
  pronoun: string;
  verb: string;
  adjective: string;
  adverb: string;
  preposition: string;
  conjunction: string;
  interjection: string;
  article: string;
  unknown: string;
}

export const PARTS_OF_SPEECH_COLORS: PartsOfSpeechColors = {
  noun: '#3B82F6',      // Blue
  pronoun: '#EF4444',   // Red
  verb: '#10B981',      // Green
  adjective: '#8B5CF6', // Purple
  adverb: '#F97316',    // Orange
  preposition: '#92400E', // Brown
  conjunction: '#EAB308', // Yellow
  interjection: '#1F2937', // Black
  article: '#6B7280',   // Gray
  unknown: '#9CA3AF'    // Light Gray
};

// High contrast versions for accessibility
export const PARTS_OF_SPEECH_COLORS_HIGH_CONTRAST: PartsOfSpeechColors = {
  noun: '#1E40AF',      // Darker Blue
  pronoun: '#DC2626',   // Darker Red
  verb: '#059669',      // Darker Green
  adjective: '#7C3AED', // Darker Purple
  adverb: '#EA580C',    // Darker Orange
  preposition: '#78350F', // Darker Brown
  conjunction: '#CA8A04', // Darker Yellow
  interjection: '#000000', // Pure Black
  article: '#374151',   // Darker Gray
  unknown: '#6B7280'    // Medium Gray
};

export const ENGLISH_POS_ORDER: PartOfSpeech[] = [
  'noun',
  'pronoun', 
  'verb',
  'adjective',
  'adverb',
  'preposition',
  'conjunction',
  'interjection'
];

export const HEBREW_POS_ORDER: PartOfSpeech[] = [
  'verb',        // Hebrew puts verbs first
  'noun',
  'adjective',
  'pronoun',
  'adverb',
  'preposition',
  'conjunction',
  'interjection'
];

// Simple parts of speech detection based on common patterns and word lists
const COMMON_NOUNS = new Set([
  'water', 'food', 'home', 'school', 'family', 'friend', 'teacher', 'mom', 'dad', 
  'book', 'toy', 'game', 'music', 'movie', 'car', 'bus', 'house', 'room', 'bed',
  'breakfast', 'lunch', 'dinner', 'snack', 'help', 'work', 'play', 'rest', 'sleep',
  'time', 'day', 'morning', 'afternoon', 'evening', 'night', 'person', 'child'
]);

const COMMON_VERBS = new Set([
  'want', 'need', 'like', 'love', 'hate', 'go', 'come', 'eat', 'drink', 'sleep',
  'play', 'work', 'study', 'read', 'write', 'walk', 'run', 'sit', 'stand', 'talk',
  'listen', 'look', 'see', 'hear', 'feel', 'think', 'know', 'understand', 'learn',
  'teach', 'help', 'give', 'take', 'make', 'do', 'have', 'be', 'am', 'is', 'are'
]);

const COMMON_ADJECTIVES = new Set([
  'good', 'bad', 'big', 'small', 'hot', 'cold', 'happy', 'sad', 'angry', 'excited',
  'tired', 'hungry', 'thirsty', 'sick', 'healthy', 'fast', 'slow', 'easy', 'hard',
  'new', 'old', 'young', 'pretty', 'ugly', 'nice', 'mean', 'funny', 'scary',
  'red', 'blue', 'green', 'yellow', 'black', 'white', 'focused', 'ready'
]);

const COMMON_PRONOUNS = new Set([
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'her', 'its', 'our', 'their', 'mine', 'yours', 'ours', 'theirs',
  'this', 'that', 'these', 'those', 'who', 'what', 'where', 'when', 'why', 'how'
]);

const COMMON_ADVERBS = new Set([
  'quickly', 'slowly', 'carefully', 'loudly', 'quietly', 'very', 'really', 'quite',
  'always', 'never', 'sometimes', 'often', 'usually', 'here', 'there', 'now', 'later',
  'today', 'yesterday', 'tomorrow', 'well', 'badly', 'easily', 'hardly'
]);

const COMMON_PREPOSITIONS = new Set([
  'in', 'on', 'at', 'by', 'for', 'with', 'without', 'to', 'from', 'of', 'about',
  'under', 'over', 'above', 'below', 'between', 'through', 'during', 'before', 'after'
]);

const COMMON_CONJUNCTIONS = new Set([
  'and', 'but', 'or', 'so', 'because', 'if', 'when', 'while', 'although', 'since'
]);

const COMMON_INTERJECTIONS = new Set([
  'oh', 'wow', 'hey', 'hi', 'hello', 'goodbye', 'yes', 'no', 'okay', 'thanks',
  'please', 'sorry', 'ouch', 'aha', 'hmm', 'shh'
]);

const ARTICLES = new Set(['a', 'an', 'the']);

export function detectPartOfSpeech(word: string): PartOfSpeech {
  const lowercaseWord = word.toLowerCase().trim();
  
  // Check articles first (most specific)
  if (ARTICLES.has(lowercaseWord)) {
    return 'article';
  }
  
  // Check pronouns (to avoid confusion with other parts)
  if (COMMON_PRONOUNS.has(lowercaseWord)) {
    return 'pronoun';
  }
  
  // Check other parts of speech
  if (COMMON_NOUNS.has(lowercaseWord)) {
    return 'noun';
  }
  
  if (COMMON_VERBS.has(lowercaseWord)) {
    return 'verb';
  }
  
  if (COMMON_ADJECTIVES.has(lowercaseWord)) {
    return 'adjective';
  }
  
  if (COMMON_ADVERBS.has(lowercaseWord)) {
    return 'adverb';
  }
  
  if (COMMON_PREPOSITIONS.has(lowercaseWord)) {
    return 'preposition';
  }
  
  if (COMMON_CONJUNCTIONS.has(lowercaseWord)) {
    return 'conjunction';
  }
  
  if (COMMON_INTERJECTIONS.has(lowercaseWord)) {
    return 'interjection';
  }
  
  // Pattern-based detection for words not in our lists
  
  // Common noun patterns
  if (lowercaseWord.endsWith('ing') || lowercaseWord.endsWith('tion') || 
      lowercaseWord.endsWith('ness') || lowercaseWord.endsWith('ment')) {
    return 'noun';
  }
  
  // Common adjective patterns
  if (lowercaseWord.endsWith('ly') && lowercaseWord.length > 3) {
    return 'adverb'; // Most -ly words are adverbs
  }
  
  if (lowercaseWord.endsWith('ed') || lowercaseWord.endsWith('ing')) {
    return 'verb'; // Past tense or present participle
  }
  
  if (lowercaseWord.endsWith('ful') || lowercaseWord.endsWith('less') ||
      lowercaseWord.endsWith('able') || lowercaseWord.endsWith('ous')) {
    return 'adjective';
  }
  
  // Default to noun for unknown words (common in AAC)
  return 'noun';
}

export function getPartOfSpeechColor(
  partOfSpeech: PartOfSpeech, 
  highContrast: boolean = false
): string {
  const colors = highContrast ? PARTS_OF_SPEECH_COLORS_HIGH_CONTRAST : PARTS_OF_SPEECH_COLORS;
  return colors[partOfSpeech] || colors.unknown;
}

export function organizeSymbolsByPartOfSpeech(
  symbols: Array<{ label: string; [key: string]: any }>,
  ordering: 'english' | 'hebrew' = 'english'
): Array<{ partOfSpeech: PartOfSpeech; symbols: Array<{ label: string; [key: string]: any }> }> {
  
  const posOrder = ordering === 'hebrew' ? HEBREW_POS_ORDER : ENGLISH_POS_ORDER;
  
  // Group symbols by part of speech
  const symbolsByPos = new Map<PartOfSpeech, Array<{ label: string; [key: string]: any }>>();
  
  symbols.forEach(symbol => {
    const pos = detectPartOfSpeech(symbol.label);
    if (!symbolsByPos.has(pos)) {
      symbolsByPos.set(pos, []);
    }
    symbolsByPos.get(pos)!.push(symbol);
  });
  
  // Organize according to the specified order
  const organizedSymbols: Array<{ 
    partOfSpeech: PartOfSpeech; 
    symbols: Array<{ label: string; [key: string]: any }> 
  }> = [];
  
  posOrder.forEach(pos => {
    const symbolsForPos = symbolsByPos.get(pos);
    if (symbolsForPos && symbolsForPos.length > 0) {
      organizedSymbols.push({
        partOfSpeech: pos,
        symbols: symbolsForPos
      });
    }
  });
  
  // Add any remaining parts of speech not in the standard order
  symbolsByPos.forEach((symbols, pos) => {
    if (!posOrder.includes(pos) && symbols.length > 0) {
      organizedSymbols.push({
        partOfSpeech: pos,
        symbols: symbols
      });
    }
  });
  
  return organizedSymbols;
}

export function getPartOfSpeechLabel(partOfSpeech: PartOfSpeech): string {
  const labels: Record<PartOfSpeech, string> = {
    noun: 'Nouns',
    pronoun: 'Pronouns',
    verb: 'Verbs',
    adjective: 'Adjectives',
    adverb: 'Adverbs',
    preposition: 'Prepositions',
    conjunction: 'Conjunctions',
    interjection: 'Interjections',
    article: 'Articles',
    unknown: 'Other'
  };
  
  return labels[partOfSpeech] || 'Other';
}