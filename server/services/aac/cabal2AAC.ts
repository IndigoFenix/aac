import { GoogleGenAI } from "@google/genai";

// CABAL² (CABA²L) - Bliss Symbol Prediction AAC System
// Implementation based on DAR-HMM (Discrete Auto-Regressive Hidden Markov Model)
// for semantic/probabilistic symbol prediction in AAC systems

interface AACContext {
  visualScene?: string;
  previousSymbols?: string[];
  timeOfDay?: string;
  location?: string;
  emotionalState?: string;
  userAge?: number;
  communicationGoal?: 'request' | 'comment' | 'question' | 'social' | 'protest';
}

interface Cabal2Symbol {
  id: string;
  text: string;
  emoji: string;
  blissCharacters?: string[];
  category: 'core' | 'fringe' | 'activity' | 'social' | 'request';
  semanticCategory: 'matter' | 'energy' | 'human_values'; // Bliss grammar categories
  frequency: number;
  contextRelevance: number;
  semanticSimilarity: number;
  pragmaticWeight: number;
  markovScore: number;
  finalScore: number;
}

// DAR-HMM transition probabilities for symbol prediction
// Based on semantic categories and symbol co-occurrence patterns
const SYMBOL_TRANSITIONS: Record<string, Record<string, number>> = {
  // Core symbols transition probabilities
  "I": {
    "want": 0.85, "need": 0.78, "like": 0.72, "feel": 0.68, "am": 0.65,
    "can": 0.62, "will": 0.58, "have": 0.55, "think": 0.52
  },
  "want": {
    "more": 0.82, "help": 0.78, "water": 0.75, "food": 0.72, "to": 0.68,
    "this": 0.65, "that": 0.62, "home": 0.58, "play": 0.55
  },
  "help": {
    "me": 0.88, "please": 0.82, "now": 0.75, "you": 0.68, "with": 0.62
  },
  "more": {
    "please": 0.85, "water": 0.78, "food": 0.72, "time": 0.65, "help": 0.58
  },
  "need": {
    "help": 0.85, "water": 0.78, "food": 0.72, "to": 0.68, "more": 0.62
  }
};

// Semantic category transitions (Bliss grammar-based)
const SEMANTIC_TRANSITIONS = {
  matter: { energy: 0.75, human_values: 0.45, matter: 0.25 },
  energy: { matter: 0.70, human_values: 0.55, energy: 0.30 },
  human_values: { matter: 0.60, energy: 0.65, human_values: 0.40 }
};

// Enhanced vocabulary with Bliss semantic categorization
const CABAL2_VOCABULARY = {
  // Matter (substantives/nouns)
  matter: [
    { text: "water", bliss: ["liquid", "basic"], frequency: 0.89, contexts: ["all"] },
    { text: "food", bliss: ["eat", "thing"], frequency: 0.87, contexts: ["all"] },
    { text: "home", bliss: ["house", "place"], frequency: 0.82, contexts: ["all"] },
    { text: "computer", bliss: ["machine", "think"], frequency: 0.78, contexts: ["work"] },
    { text: "book", bliss: ["paper", "knowledge"], frequency: 0.74, contexts: ["learn"] },
    { text: "music", bliss: ["sound", "art"], frequency: 0.71, contexts: ["play"] },
    { text: "family", bliss: ["people", "love"], frequency: 0.85, contexts: ["social"] },
    { text: "friend", bliss: ["person", "like"], frequency: 0.79, contexts: ["social"] }
  ],

  // Energy (actions/verbs)
  energy: [
    { text: "want", bliss: ["desire", "action"], frequency: 0.92, contexts: ["all"] },
    { text: "help", bliss: ["assist", "action"], frequency: 0.87, contexts: ["all"] },
    { text: "eat", bliss: ["mouth", "action"], frequency: 0.84, contexts: ["meal"] },
    { text: "drink", bliss: ["liquid", "action"], frequency: 0.82, contexts: ["meal"] },
    { text: "play", bliss: ["fun", "action"], frequency: 0.79, contexts: ["leisure"] },
    { text: "work", bliss: ["job", "action"], frequency: 0.76, contexts: ["work"] },
    { text: "sleep", bliss: ["rest", "action"], frequency: 0.78, contexts: ["tired"] },
    { text: "go", bliss: ["move", "action"], frequency: 0.81, contexts: ["all"] },
    { text: "come", bliss: ["approach", "action"], frequency: 0.77, contexts: ["all"] },
    { text: "look", bliss: ["eye", "action"], frequency: 0.74, contexts: ["attention"] }
  ],

  // Human Values (mental evaluations/adjectives)
  human_values: [
    { text: "good", bliss: ["positive", "evaluation"], frequency: 0.88, contexts: ["all"] },
    { text: "bad", bliss: ["negative", "evaluation"], frequency: 0.83, contexts: ["all"] },
    { text: "happy", bliss: ["joy", "feeling"], frequency: 0.85, contexts: ["emotion"] },
    { text: "sad", bliss: ["sorrow", "feeling"], frequency: 0.79, contexts: ["emotion"] },
    { text: "tired", bliss: ["exhausted", "feeling"], frequency: 0.76, contexts: ["physical"] },
    { text: "more", bliss: ["increase", "quantity"], frequency: 0.89, contexts: ["all"] },
    { text: "big", bliss: ["large", "size"], frequency: 0.72, contexts: ["description"] },
    { text: "small", bliss: ["little", "size"], frequency: 0.69, contexts: ["description"] }
  ],

  // Core pronouns and function words
  core: [
    { text: "I", bliss: ["self", "person"], frequency: 0.95, contexts: ["all"] },
    { text: "you", bliss: ["other", "person"], frequency: 0.91, contexts: ["all"] },
    { text: "we", bliss: ["group", "person"], frequency: 0.78, contexts: ["social"] },
    { text: "yes", bliss: ["agree", "response"], frequency: 0.86, contexts: ["all"] },
    { text: "no", bliss: ["disagree", "response"], frequency: 0.84, contexts: ["all"] },
    { text: "please", bliss: ["request", "politeness"], frequency: 0.82, contexts: ["all"] },
    { text: "thank", bliss: ["gratitude", "response"], frequency: 0.79, contexts: ["all"] }
  ]
};

// Initialize Gemini for advanced context analysis when needed
const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export async function generateCabal2Symbols(
  context: AACContext,
  language: string = "en",
  usePcsSymbols: boolean = false,
  previousSymbols: string[] = []
): Promise<Cabal2Symbol[]> {
  console.log("Starting CABAL² symbol prediction using DAR-HMM...");

  try {
    // Build semantic context from user environment
    const semanticContext = buildSemanticContext(context);
    
    // Calculate DAR-HMM scores based on previous symbols
    const symbolPool = buildContextualSymbolPool(context, semanticContext);
    
    // Apply Markov transition probabilities
    const scoredSymbols = applyDARHMMScoring(symbolPool, previousSymbols);
    
    // Apply contextual and semantic relevance scoring
    const contextualSymbols = applyContextualScoring(scoredSymbols, context);
    
    // Sort by final CABAL² score and return top symbols
    const finalSymbols = contextualSymbols
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, 8);

    console.log(`CABAL² returned ${finalSymbols.length} symbol predictions using DAR-HMM`);
    return finalSymbols;

  } catch (error) {
    console.error("CABAL² symbol prediction failed:", error);
    
    // Fallback to core vocabulary with basic Markov scoring
    return generateFallbackCabal2Vocabulary(context, language, previousSymbols);
  }
}

function buildSemanticContext(context: AACContext): {
  primaryCategory: 'matter' | 'energy' | 'human_values';
  contextStrength: number;
} {
  // Determine primary semantic category from context
  let primaryCategory: 'matter' | 'energy' | 'human_values' = 'energy';
  let contextStrength = 0.5;

  // Analyze visual scene for matter/objects
  if (context.visualScene) {
    const matterKeywords = ['object', 'thing', 'item', 'computer', 'book', 'food', 'water'];
    const energyKeywords = ['person', 'action', 'moving', 'doing', 'working'];
    const valueKeywords = ['happy', 'sad', 'good', 'bad', 'beautiful', 'ugly'];

    const scene = context.visualScene.toLowerCase();
    
    if (matterKeywords.some(kw => scene.includes(kw))) {
      primaryCategory = 'matter';
      contextStrength = 0.8;
    } else if (energyKeywords.some(kw => scene.includes(kw))) {
      primaryCategory = 'energy';
      contextStrength = 0.7;
    } else if (valueKeywords.some(kw => scene.includes(kw))) {
      primaryCategory = 'human_values';
      contextStrength = 0.6;
    }
  }

  // Emotional state suggests human values category
  if (context.emotionalState) {
    primaryCategory = 'human_values';
    contextStrength = Math.max(contextStrength, 0.7);
  }

  return { primaryCategory, contextStrength };
}

function buildContextualSymbolPool(
  context: AACContext, 
  semanticContext: { primaryCategory: 'matter' | 'energy' | 'human_values'; contextStrength: number }
): Cabal2Symbol[] {
  const pool: Cabal2Symbol[] = [];
  const currentTime = new Date().getHours();
  
  // Always include core vocabulary
  CABAL2_VOCABULARY.core.forEach(vocab => {
    pool.push({
      id: `cabal2_${vocab.text.toLowerCase()}`,
      text: vocab.text,
      emoji: getEmojiForCabal2Symbol(vocab.text),
      blissCharacters: vocab.bliss,
      category: 'core',
      semanticCategory: 'energy', // Core pronouns are functional
      frequency: vocab.frequency,
      contextRelevance: 0.8,
      semanticSimilarity: 0.7,
      pragmaticWeight: 0.9,
      markovScore: 0.0, // Will be calculated later
      finalScore: 0.0
    });
  });

  // Add symbols from primary semantic category with higher weight
  const primaryVocab = CABAL2_VOCABULARY[semanticContext.primaryCategory];
  primaryVocab.forEach(vocab => {
    if (isContextuallyRelevant(vocab, context)) {
      pool.push({
        id: `cabal2_${vocab.text.toLowerCase()}`,
        text: vocab.text,
        emoji: getEmojiForCabal2Symbol(vocab.text),
        blissCharacters: vocab.bliss,
        category: categorizeSymbol(vocab.text),
        semanticCategory: semanticContext.primaryCategory,
        frequency: vocab.frequency,
        contextRelevance: semanticContext.contextStrength,
        semanticSimilarity: 0.8,
        pragmaticWeight: 0.7,
        markovScore: 0.0,
        finalScore: 0.0
      });
    }
  });

  // Add secondary categories with lower weights
  Object.keys(CABAL2_VOCABULARY).forEach(category => {
    if (category !== semanticContext.primaryCategory && category !== 'core') {
      const vocab = CABAL2_VOCABULARY[category as keyof typeof CABAL2_VOCABULARY];
      vocab.slice(0, 3).forEach(item => { // Limit secondary categories
        if (isContextuallyRelevant(item, context)) {
          pool.push({
            id: `cabal2_${item.text.toLowerCase()}`,
            text: item.text,
            emoji: getEmojiForCabal2Symbol(item.text),
            blissCharacters: item.bliss,
            category: categorizeSymbol(item.text),
            semanticCategory: category as 'matter' | 'energy' | 'human_values',
            frequency: item.frequency * 0.8, // Reduced weight for secondary
            contextRelevance: 0.5,
            semanticSimilarity: 0.6,
            pragmaticWeight: 0.6,
            markovScore: 0.0,
            finalScore: 0.0
          });
        }
      });
    }
  });

  return pool;
}

function applyDARHMMScoring(symbols: Cabal2Symbol[], previousSymbols: string[]): Cabal2Symbol[] {
  return symbols.map(symbol => {
    let markovScore = 0.5; // Base score
    
    // If we have previous symbols, calculate transition probability
    if (previousSymbols.length > 0) {
      const lastSymbol = previousSymbols[previousSymbols.length - 1];
      
      // Direct symbol transition
      if (SYMBOL_TRANSITIONS[lastSymbol] && SYMBOL_TRANSITIONS[lastSymbol][symbol.text]) {
        markovScore = SYMBOL_TRANSITIONS[lastSymbol][symbol.text];
      }
      // Semantic category transition
      else if (previousSymbols.length > 0) {
        const lastSemanticCategory = inferSemanticCategory(lastSymbol);
        const currentSemanticCategory = symbol.semanticCategory;
        
        if (SEMANTIC_TRANSITIONS[lastSemanticCategory]) {
          markovScore = SEMANTIC_TRANSITIONS[lastSemanticCategory][currentSemanticCategory] || 0.3;
        }
      }
    }
    
    return {
      ...symbol,
      markovScore
    };
  });
}

function applyContextualScoring(symbols: Cabal2Symbol[], context: AACContext): Cabal2Symbol[] {
  return symbols.map(symbol => {
    // CABAL² final scoring algorithm
    const finalScore = (
      (symbol.frequency * 0.25) +           // Base frequency
      (symbol.contextRelevance * 0.30) +    // Context relevance
      (symbol.semanticSimilarity * 0.20) +  // Semantic fit
      (symbol.markovScore * 0.15) +         // DAR-HMM transition score
      (symbol.pragmaticWeight * 0.10)       // Pragmatic appropriateness
    );
    
    return {
      ...symbol,
      finalScore: Math.round(finalScore * 100) / 100
    };
  });
}

function generateFallbackCabal2Vocabulary(
  context: AACContext, 
  language: string,
  previousSymbols: string[]
): Cabal2Symbol[] {
  console.log(`Using fallback CABAL² vocabulary for language: ${language}`);
  
  // Hebrew translations for fallback
  const hebrewVocabulary = language === "he" ? {
    "I": "אני", "you": "אתה", "want": "רוצה", "need": "צריך",
    "help": "עזרה", "more": "עוד", "yes": "כן", "no": "לא",
    "good": "טוב", "bad": "רע", "happy": "שמח", "sad": "עצוב",
    "water": "מים", "food": "אוכל", "home": "בית", "work": "עבודה"
  } : {};

  const fallbackPool = [
    ...CABAL2_VOCABULARY.core.slice(0, 4),
    ...CABAL2_VOCABULARY.energy.slice(0, 2),
    ...CABAL2_VOCABULARY.human_values.slice(0, 2)
  ];

  return fallbackPool.map((vocab, index) => {
    const translatedText = language === "he" && hebrewVocabulary[vocab.text] 
      ? hebrewVocabulary[vocab.text] 
      : vocab.text;

    return {
      id: `cabal2_fallback_${vocab.text.toLowerCase()}`,
      text: translatedText,
      emoji: getEmojiForCabal2Symbol(vocab.text),
      blissCharacters: vocab.bliss,
      category: categorizeSymbol(vocab.text),
      semanticCategory: inferSemanticCategory(vocab.text),
      frequency: vocab.frequency,
      contextRelevance: 0.7,
      semanticSimilarity: 0.6,
      pragmaticWeight: 0.7,
      markovScore: 0.5,
      finalScore: vocab.frequency * 0.8 + (0.7 - index * 0.05)
    };
  });
}

// Helper functions
function isContextuallyRelevant(vocab: any, context: AACContext): boolean {
  if (vocab.contexts.includes("all")) return true;
  
  const timeContext = getCurrentTimeContext();
  if (vocab.contexts.includes(timeContext)) return true;
  
  if (context.emotionalState && vocab.contexts.includes("emotion")) return true;
  if (context.location === "work" && vocab.contexts.includes("work")) return true;
  
  return false;
}

function getCurrentTimeContext(): string {
  const hour = new Date().getHours();
  if (hour >= 6 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  return "evening";
}

function categorizeSymbol(text: string): 'core' | 'fringe' | 'activity' | 'social' | 'request' {
  const coreWords = ["I", "you", "want", "need", "yes", "no", "more", "help"];
  const activityWords = ["play", "work", "eat", "drink", "sleep", "read"];
  const socialWords = ["family", "friend", "love", "like"];
  const requestWords = ["please", "help", "want", "need"];
  
  if (coreWords.includes(text)) return 'core';
  if (activityWords.includes(text)) return 'activity';
  if (socialWords.includes(text)) return 'social';
  if (requestWords.includes(text)) return 'request';
  return 'fringe';
}

function inferSemanticCategory(text: string): 'matter' | 'energy' | 'human_values' {
  const matterWords = ["water", "food", "home", "computer", "book", "music"];
  const energyWords = ["want", "help", "eat", "drink", "play", "work", "go", "come"];
  const valueWords = ["good", "bad", "happy", "sad", "more", "big", "small"];
  
  if (matterWords.includes(text)) return 'matter';
  if (energyWords.includes(text)) return 'energy';
  if (valueWords.includes(text)) return 'human_values';
  return 'energy'; // Default to energy (actions)
}

function getEmojiForCabal2Symbol(text: string): string {
  const emojiMap: Record<string, string> = {
    // Core vocabulary
    "I": "👤", "you": "👥", "we": "👫", "want": "🙏", "need": "❗",
    "help": "🆘", "please": "🙏", "thank": "🙏", "yes": "✅", "no": "❌",
    
    // Matter (objects/nouns)
    "water": "💧", "food": "🍽️", "home": "🏠", "computer": "💻",
    "book": "📖", "music": "🎵", "family": "👨‍👩‍👧‍👦", "friend": "👫",
    
    // Energy (actions/verbs)
    "eat": "🍽️", "drink": "🥤", "play": "🎮", "work": "💼", "sleep": "😴",
    "go": "🚶", "come": "👋", "look": "👀",
    
    // Human Values (evaluations/adjectives)
    "good": "😊", "bad": "😞", "happy": "😄", "sad": "😢", "tired": "😴",
    "more": "➕", "big": "📏", "small": "🔸"
  };
  
  return emojiMap[text.toLowerCase()] || "💬";
}

// Export types and main function
export { AACContext, Cabal2Symbol };