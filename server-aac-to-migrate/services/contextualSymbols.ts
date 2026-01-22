import { GoogleGenAI } from "@google/genai";
import type { ContextData, SymbolSuggestion } from "./openai";
import { generateBERTAACSymbols, type AACContext } from "./bertAAC";
import { generateCabal2Symbols, type Cabal2Symbol } from "./cabal2AAC";
import { getHebrewContextualSymbols, getHebrewSymbol, type HebrewSymbol } from "./hebrewSymbols";
import { storage } from "../storage";
import { shouldUseChatGPT5, modelOverrideService } from "./modelOverride";

// Function to generate appropriate emoji for AAC symbols
function getEmojiForSymbol(text: string, category: string): string {
  const emojiMap: Record<string, string> = {
    // Core vocabulary
    "I": "👤", "want": "🙏", "more": "➕", "help": "✋", "stop": "⏹️",
    "go": "🚶", "like": "👍", "you": "👥", "me": "👤", "yes": "✅",
    "no": "❌", "good": "😊", "bad": "😞", "happy": "😄", "sad": "😢",
    "need": "❗", "done": "✅", "please": "🙏", "thank": "🙏", "sorry": "😞",
    
    // Activity vocabulary  
    "work": "💻", "computer": "🖥️", "coffee": "☕", "breakfast": "🍳",
    "lunch": "🍽️", "eat": "🍽️", "drink": "🥤", "sleep": "😴",
    "play": "🎮", "read": "📖", "write": "✏️", "watch": "👀",
    
    // Emotions and states
    "tired": "😴", "excited": "🤩", "calm": "😌", "focused": "🧠",
    "busy": "⏱️", "ready": "✅", "finished": "🏁", "start": "▶️",
    
    // Time-related
    "morning": "🌅", "afternoon": "☀️", "evening": "🌅", "night": "🌙",
    "today": "📅", "now": "⏰", "later": "⏰", "soon": "🔜",
    
    // Common actions
    "look": "👀", "listen": "👂", "talk": "💬", "walk": "🚶",
    "sit": "🪑", "stand": "🧍", "come": "👋", "give": "🤝"
  };
  
  // Check exact match first
  const normalizedText = text.toLowerCase();
  if (emojiMap[normalizedText]) {
    return emojiMap[normalizedText];
  }
  
  // Category-based defaults
  switch (category) {
    case 'core': return '⭐';
    case 'fringe': return '🔷';
    case 'activity': return '🎯';
    default: return '💬';
  }
}

const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export async function generateContextualSymbols(
  context: any, // Make this flexible to handle different input formats
  currentConversation?: {
    lastAgentMessage?: string;
    conversationTopic?: string;
    userId: string;
  },
  language: string = "en",
  usePcsSymbols: boolean = false
): Promise<SymbolSuggestion[]> {
  console.log("Starting symbol suggestion generation...");
  console.log("Context received:", context);
  
  // Safety check for context
  if (!context) {
    console.log("No context provided, using default context");
    context = { 
      time: "afternoon", 
      location: "Home", 
      visualContext: "No visual context available" 
    };
  }
  
  // Try CABAL² first for symbol prediction
  try {
    console.log("Trying CABAL² with DAR-HMM for symbol prediction...");
    
    // Prepare CABAL² AAC context using DAR-HMM methodology - handle flexible input
    const aacContext: AACContext = {
      visualScene: context?.visualContext || context?.visualScene || 'No visual context available',
      previousSymbols: [],
      timeOfDay: context?.time || context?.timeOfDay || 'afternoon',
      location: context?.location || 'Home',
      emotionalState: context?.emotionalState,
      userAge: context?.userAge || 25,
      communicationGoal: 'comment'
    };

    // Get recent history if available and add to AAC context
    if (currentConversation?.userId) {
      try {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const todayHistory = await storage.getChatHistoryByDateRange(currentConversation.userId, todayStart, now);
        aacContext.previousSymbols = todayHistory.slice(-3).flatMap(entry => (entry.symbols as string[]) || []);
      } catch (error) {
        console.log("Could not retrieve chat history for AAC context");
      }
    }

    // Use CABAL² for symbol prediction with previous symbols context
    const extractSymbolsFromMessage = (message: string): string[] => {
      const symbolPattern = /\b(I|want|need|help|more|good|bad|yes|no|happy|sad|water|food|home|work|play|eat|drink)\b/gi;
      const matches = message.match(symbolPattern);
      return matches ? matches.map(m => m.toLowerCase()) : [];
    };
    
    const previousSymbols = currentConversation?.lastAgentMessage 
      ? extractSymbolsFromMessage(currentConversation.lastAgentMessage)
      : [];
    
    const cabal2Symbols = await generateCabal2Symbols(aacContext, language, usePcsSymbols, previousSymbols);
    console.log(`CABAL² returned ${cabal2Symbols.length} symbol predictions using DAR-HMM`);
    
    // Convert CABAL² symbols to SymbolSuggestion format with emoji
    const convertedSymbols: SymbolSuggestion[] = cabal2Symbols.map(symbol => ({
      id: symbol.id,
      label: symbol.text,
      category: symbol.category,
      priority: Math.round(symbol.finalScore * 10),
      confidence: symbol.finalScore,
      emoji: symbol.emoji,
      reasoning: `CABAL² Score: ${symbol.finalScore.toFixed(2)} - ${symbol.semanticCategory}/${symbol.category} (Markov: ${symbol.markovScore.toFixed(2)})`
    }));
    
    // Add contextual short sentence suggestions
    const sentenceSuggestions = generateShortSentences(context, {
      ...aacContext,
      timeOfDay: aacContext.timeOfDay || "unknown"
    });
    convertedSymbols.push(...sentenceSuggestions);
    
    // If Hebrew language, add Hebrew translations
    if (language === "he") {
      console.log("Applying Hebrew translations to symbols...");
      const hebrewSymbols = convertedSymbols.map(symbol => {
        // Try multiple approaches to find Hebrew translation
        const hebrewSymbol = getHebrewSymbol(symbol.id) || getHebrewSymbol(symbol.label.toLowerCase());
        
        // Manual translation mapping for common symbols
        const manualTranslations: Record<string, string> = {
          "I": "אני", "want": "רוצה", "more": "עוד", "help": "עזרה",
          "yes": "כן", "no": "לא", "good": "טוב", "bad": "רע",
          "happy": "שמח", "sad": "עצוב", "work": "עבודה", "lunch": "ארוחת צהריים",
          "you": "אתה", "eat": "לאכול", "drink": "לשתות", "play": "לשחק",
          "stop": "עצור", "like": "אוהב", "home": "בית", "outside": "בחוץ",
          "sleep": "לישון", "tired": "עייף", "water": "מים", "food": "אוכל"
        };
        
        let translatedLabel = hebrewSymbol?.labelHe || 
                             manualTranslations[symbol.label.toLowerCase()] || 
                             symbol.label;
        
        // For sentences, try to translate key components
        if (symbol.label.includes("I want") || symbol.label.includes("I need")) {
          if (symbol.label.toLowerCase().includes("help")) {
            translatedLabel = "אני צריך עזרה";
          } else if (symbol.label.toLowerCase().includes("water")) {
            translatedLabel = "אני רוצה מים";
          } else if (symbol.label.toLowerCase().includes("lunch")) {
            translatedLabel = "אני רוצה ארוחת צהריים";
          }
        }
        
        const translatedSymbol = {
          ...symbol,
          label: translatedLabel,
          id: symbol.id,
          emoji: symbol.emoji
        };
        
        console.log(`Symbol translation: ${symbol.label} -> ${translatedSymbol.label}`);
        return translatedSymbol;
      });
      console.log("Hebrew translation completed");
      return hebrewSymbols;
    }
    
    return convertedSymbols;
    
  } catch (cabal2Error) {
    console.error("CABAL² symbol prediction failed, falling back to enhanced contextual symbols:", cabal2Error);
    
    // Enhanced fallback: Use contextual vocabulary system
    return getEnhancedContextualSymbols(context, language, currentConversation);
  }
  
  try {
    // Get today's chat history for contextual awareness if userId is provided
    let todayEvents: any[] = [];
    if (currentConversation?.userId) {
      try {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const todayHistory = await storage.getChatHistoryByDateRange(currentConversation.userId, todayStart, now);
        todayEvents = todayHistory.map(entry => ({
          time: entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('en-US', { 
            hour: 'numeric', 
            minute: '2-digit', 
            hour12: true 
          }) : 'Unknown time',
          symbols: entry.symbols || [],
          interpretation: entry.interpretedText || ''
        }));
      } catch (error) {
        console.log("Could not retrieve today's chat history for symbols:", error);
      }
    }

    // Enhanced prompt that considers conversation context and past events
    const conversationContext = currentConversation?.lastAgentMessage 
      ? `\nCurrent conversation context:
Last agent message: "${currentConversation.lastAgentMessage}"
Conversation topic: ${currentConversation?.conversationTopic || 'general'}
      
Please include relevant response symbols like:
- Yes/No if the agent asked a question
- Good/Bad if discussing experiences or feelings  
- Like/Don't Like for preferences
- Want/Don't Want for choices
- Happy/Sad for emotional responses
- More/Stop for continuing or ending topics`
      : "";

    const currentHour = new Date().getHours();
    const timeOfDay = currentHour >= 6 && currentHour < 12 ? "morning" :
                     currentHour >= 12 && currentHour < 17 ? "afternoon" :
                     currentHour >= 17 && currentHour < 21 ? "evening" : "night";
    
    const languageInstructions = language === "he" 
      ? "חשוב מאוד: יש להגיב בעברית בלבד עם תוויות ברים בעברית. השתמש בביטויים עבריים מתאימים לילדים כמו: אני, רוצה, עזרה, עוד, טוב, רע, שמח, עצוב, אוכל, לשתות, לשחק, לישון, אמא, אבא, בית, בחוץ, משחק, צעצועים. כל הסמלים חייבים להיות בעברית."
      : "Respond in English with English symbols and labels.";
    
    const pcsInstructions = usePcsSymbols 
      ? "\n\nIMPORTANT: Use PCS (Picture Communication Symbols) style naming and categories. Focus on:\n- Clear, simple visual representations\n- Standard PCS categories (People, Actions, Things, Feelings, etc.)\n- High-contrast, recognizable symbols\n- Age-appropriate symbol complexity\n- PCS-compatible emoji choices when possible"
      : "";
    
    console.log(`Generating symbols in language: ${language}`);
    
    const prompt = `You are an AI assistant for an AAC communication device. Based on current context, visual environment, time of day, and what happened earlier today, suggest 5-6 relevant communication symbols.

${languageInstructions}${pcsInstructions}

CURRENT CONTEXT:
Time: ${context.time} (${timeOfDay})
Location: ${context.location || 'Home'}
Visual scene: ${context.visualContext || 'No visual data'}
User: ${context.userProfile?.name || 'User'}, Age: ${context.userProfile?.age || 'Unknown'}
Preferences: ${context.userProfile?.preferences || 'No preferences set'}${conversationContext}

TODAY'S PREVIOUS ACTIVITIES:
${todayEvents.length > 0 ? 
  todayEvents.map(event => `- ${event.time}: User communicated "${event.symbols.join(' ')}" (${event.interpretation})`).join('\n') : 
  '- No previous activities recorded today'
}

Focus on symbols that:
1. Connect to the current visual environment and time of day
2. Help respond to any conversation questions asked
3. Can reference or build upon what happened earlier today
4. Express current feelings, needs, and observations
5. Are relevant to typical ${timeOfDay} activities
6. Include symbols that help continue topics from earlier today

CONTEXTUAL EXAMPLES:
- If morning: "breakfast", "ready", "excited", "new day"
- If afternoon & user had breakfast earlier: "lunch", "hungry", "good morning"
- If evening & user was happy earlier: "still happy", "good day", "tired"
- Current visual environment should influence symbol choices

Respond with JSON only:
{
  "suggestions": [
    {"id": "unique_id", "label": "Symbol Label", "emoji": "🔥", "confidence": 0.95, "reasoning": "Why relevant to current context and time"}
  ]
}`;

    const response = await gemini.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });

    let responseText = response.text || "{}";
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const result = JSON.parse(responseText);
    console.log("Contextual symbol suggestions:", result.suggestions?.length || 0);
    
    // Ensure we always have basic response symbols if conversation is active
    let suggestions = result.suggestions || [];
    
    // Remove any duplicates based on ID and label (case-insensitive)
    const uniqueSymbols = new Map();
    suggestions.forEach((symbol: SymbolSuggestion) => {
      const key = `${symbol.id?.toLowerCase()}_${symbol.label?.toLowerCase()}`;
      if (!uniqueSymbols.has(key)) {
        uniqueSymbols.set(key, symbol);
      }
    });
    suggestions = Array.from(uniqueSymbols.values());
    
    if (currentConversation?.lastAgentMessage) {
      const enhancedSuggestions = addConversationalSymbols(suggestions, currentConversation.lastAgentMessage);
      return deduplicateSymbols(enhancedSuggestions).slice(0, 8); // Limit to 8 symbols
    }
    
    // Pad with additional conversational symbols if needed
    const paddedSuggestions = [...suggestions];
    if (paddedSuggestions.length < 8) {
      const additionalSymbols = [
        { id: "more", label: "More", emoji: "➕", confidence: 0.7, reasoning: "Continue conversation" },
        { id: "stop", label: "Stop", emoji: "⏹️", confidence: 0.7, reasoning: "End conversation" },
        { id: "thanks", label: "Thanks", emoji: "🙏", confidence: 0.6, reasoning: "Polite response" },
        { id: "sorry", label: "Sorry", emoji: "😞", confidence: 0.6, reasoning: "Apologetic response" }
      ];
      
      for (const symbol of additionalSymbols) {
        if (paddedSuggestions.length >= 8) break;
        const isDuplicate = paddedSuggestions.some(existing => 
          existing.id?.toLowerCase() === symbol.id?.toLowerCase() || 
          existing.label?.toLowerCase() === symbol.label?.toLowerCase()
        );
        if (!isDuplicate) {
          paddedSuggestions.push(symbol);
        }
      }
    }
    
    return deduplicateSymbols(paddedSuggestions).slice(0, 8);
  } catch (error) {
    console.error("Error generating contextual symbols:", error);
    
    // Track error in session for debug window
    if ((global as any).currentSession) {
      ((global as any).currentSession as any).lastQuotaError = {
        service: "Gemini Flash (Symbols)", 
        error: (error as any)?.message || String(error),
        timestamp: new Date().toISOString()
      };
    }
    return deduplicateSymbols(getConversationalFallbackSymbols(currentConversation?.lastAgentMessage));
  }
}

// Helper function to remove duplicate symbols
function deduplicateSymbols(symbols: SymbolSuggestion[]): SymbolSuggestion[] {
  const uniqueSymbols = new Map();
  
  symbols.forEach(symbol => {
    // Create a unique key based on both ID and label (case-insensitive)
    const idKey = symbol.id?.toLowerCase() || '';
    const labelKey = symbol.label?.toLowerCase() || '';
    const combinedKey = `${idKey}_${labelKey}`;
    
    // Also check for label-only duplicates (e.g., "More" and "more")
    const labelOnlyKey = labelKey;
    
    if (!uniqueSymbols.has(combinedKey) && !uniqueSymbols.has(labelOnlyKey)) {
      uniqueSymbols.set(combinedKey, symbol);
      uniqueSymbols.set(labelOnlyKey, symbol); // Also store by label only to catch variations
    }
  });
  
  // Return only the unique symbols (not the label-only duplicates)
  const result = [];
  const seenLabels = new Set();
  
  for (const symbol of symbols) {
    const labelKey = symbol.label?.toLowerCase() || '';
    if (!seenLabels.has(labelKey)) {
      seenLabels.add(labelKey);
      result.push(symbol);
    }
  }
  
  return result;
}

function addConversationalSymbols(
  existingSymbols: SymbolSuggestion[], 
  lastAgentMessage: string
): SymbolSuggestion[] {
  const message = lastAgentMessage.toLowerCase();
  const conversationalSymbols: SymbolSuggestion[] = [...existingSymbols];
  
  // For observational comments - provide age-appropriate responses
  if (message.includes('cool shirt') || message.includes('having fun') || message.includes('look') || message.includes('can see') || message.includes('nice to see')) {
    const newSymbols = [
      { id: "happy", label: "Happy", emoji: "😊", confidence: 0.95, reasoning: "Response to observation" },
      { id: "yes", label: "Yes", emoji: "✅", confidence: 0.9, reasoning: "Agreement response" },
      { id: "thank_you", label: "Thank You", emoji: "🙏", confidence: 0.9, reasoning: "Polite response" },
      { id: "play", label: "Play", emoji: "🎮", confidence: 0.85, reasoning: "Activity response" },
      { id: "toys", label: "Toys", emoji: "🧸", confidence: 0.8, reasoning: "Topic response" },
      { id: "games", label: "Games", emoji: "🎯", confidence: 0.8, reasoning: "Activity response" },
      { id: "friends", label: "Friends", emoji: "👯", confidence: 0.75, reasoning: "Social response" },
      { id: "excited", label: "Excited", emoji: "🤩", confidence: 0.75, reasoning: "Feeling response" }
    ];
    conversationalSymbols.push(...newSymbols);
    return deduplicateSymbols(conversationalSymbols).slice(0, 8);
  }
  
  // Add Yes/No for questions
  if (message.includes('?') || message.includes('how') || message.includes('what') || message.includes('do you')) {
    conversationalSymbols.push(
      { id: "yes", label: "Yes", emoji: "✅", confidence: 0.95, reasoning: "Response to question" },
      { id: "no", label: "No", emoji: "❌", confidence: 0.95, reasoning: "Response to question" }
    );
  }
  
  // Add feeling responses for comments about emotions or state
  if (message.includes('happy') || message.includes('fun day') || message.includes('good time') || message.includes('ready')) {
    conversationalSymbols.push(
      { id: "happy", label: "Happy", emoji: "😊", confidence: 0.95, reasoning: "Feeling response" },
      { id: "excited", label: "Excited", emoji: "🤩", confidence: 0.9, reasoning: "Feeling response" },
      { id: "yes", label: "Yes", emoji: "✅", confidence: 0.9, reasoning: "Agreement response" },
      { id: "good", label: "Good", emoji: "👍", confidence: 0.85, reasoning: "Positive response" },
      { id: "play", label: "Play", emoji: "🎮", confidence: 0.8, reasoning: "Activity response" },
      { id: "silly", label: "Silly", emoji: "🤪", confidence: 0.8, reasoning: "Age-appropriate feeling" }
    );
  }
  
  // Add Like/Don't Like for preferences
  if (message.includes('like') || message.includes('enjoy') || message.includes('prefer')) {
    conversationalSymbols.push(
      { id: "like", label: "Like", emoji: "❤️", confidence: 0.9, reasoning: "Express preference" },
      { id: "dont_like", label: "Don't Like", emoji: "💔", confidence: 0.9, reasoning: "Express dislike" }
    );
  }
  
  // Add More/Stop for continuation - but lower priority
  conversationalSymbols.push(
    { id: "more", label: "More", emoji: "➕", confidence: 0.7, reasoning: "Continue topic" },
    { id: "stop", label: "Stop", emoji: "⏹️", confidence: 0.7, reasoning: "End topic" }
  );
  
  // Return deduplicated symbols from all sources
  return deduplicateSymbols(conversationalSymbols).slice(0, 8);
}

function getConversationalFallbackSymbols(lastAgentMessage?: string): SymbolSuggestion[] {
  // Age-appropriate fallback symbols for 7-year-old
  const baseSymbols = [
    { id: "yes", label: "Yes", emoji: "✅", confidence: 0.9, reasoning: "Basic response" },
    { id: "no", label: "No", emoji: "❌", confidence: 0.9, reasoning: "Basic response" },
    { id: "happy", label: "Happy", emoji: "😊", confidence: 0.8, reasoning: "Common feeling" },
    { id: "play", label: "Play", emoji: "🎮", confidence: 0.8, reasoning: "Age-appropriate activity" },
    { id: "toys", label: "Toys", emoji: "🧸", confidence: 0.75, reasoning: "Age-appropriate interest" },
    { id: "snack", label: "Snack", emoji: "🍪", confidence: 0.75, reasoning: "Age-appropriate need" },
    { id: "more", label: "More", emoji: "➕", confidence: 0.7, reasoning: "Continue conversation" },
    { id: "help", label: "Help", emoji: "🙋", confidence: 0.6, reasoning: "Common need" }
  ];
  
  return baseSymbols;
}

function getHebrewTranslation(symbolId: string): string | null {
  const hebrewSymbol = getHebrewSymbol(symbolId);
  return hebrewSymbol ? hebrewSymbol.labelHe : null;
}

// Enhanced contextual symbols function that provides dynamic suggestions
function getEnhancedContextualSymbols(
  context: ContextData,
  language: string = "en",
  currentConversation?: { lastAgentMessage?: string; conversationTopic?: string; userId: string }
): SymbolSuggestion[] {
  console.log("Using enhanced contextual vocabulary system for dynamic symbols");
  
  // Core vocabulary that's always included
  const coreSymbols = [
    { text: "I", category: "core", frequency: 0.95, emoji: "👤" },
    { text: "want", category: "core", frequency: 0.92, emoji: "🙏" },
    { text: "help", category: "core", frequency: 0.87, emoji: "✋" },
    { text: "more", category: "core", frequency: 0.89, emoji: "➕" }
  ];
  
  // Determine contextual symbols based on environment
  let contextualSymbols: any[] = [];
  const currentHour = new Date().getHours();
  const visualContext = context.visualContext?.toLowerCase() || '';
  const emotionalState = (context as any).emotionalState?.toLowerCase() || '';
  
  // Time-based contextual suggestions (varies by time of day)
  if (currentHour >= 6 && currentHour < 12) {
    // Morning suggestions
    contextualSymbols.push(
      { text: "wake", category: "activity", frequency: 0.85, emoji: "⏰" },
      { text: "breakfast", category: "activity", frequency: 0.82, emoji: "🍳" },
      { text: "coffee", category: "fringe", frequency: 0.79, emoji: "☕" },
      { text: "start", category: "activity", frequency: 0.76, emoji: "▶️" }
    );
  } else if (currentHour >= 12 && currentHour < 17) {
    // Afternoon suggestions  
    contextualSymbols.push(
      { text: "work", category: "activity", frequency: 0.81, emoji: "💻" },
      { text: "lunch", category: "activity", frequency: 0.84, emoji: "🍽️" },
      { text: "busy", category: "fringe", frequency: 0.78, emoji: "⏱️" },
      { text: "focus", category: "activity", frequency: 0.75, emoji: "🧠" }
    );
  } else {
    // Evening suggestions
    contextualSymbols.push(
      { text: "dinner", category: "activity", frequency: 0.86, emoji: "🍽️" },
      { text: "tired", category: "activity", frequency: 0.83, emoji: "😴" },
      { text: "home", category: "fringe", frequency: 0.80, emoji: "🏠" },
      { text: "relax", category: "activity", frequency: 0.77, emoji: "😌" }
    );
  }
  
  // Visual context adaptations
  if (visualContext.includes('computer') || visualContext.includes('desk') || visualContext.includes('screen')) {
    contextualSymbols.push(
      { text: "type", category: "activity", frequency: 0.81, emoji: "⌨️" },
      { text: "read", category: "activity", frequency: 0.78, emoji: "📖" },
      { text: "write", category: "activity", frequency: 0.75, emoji: "✏️" },
      { text: "think", category: "activity", frequency: 0.72, emoji: "💭" }
    );
  }
  
  if (visualContext.includes('kitchen') || visualContext.includes('dining')) {
    contextualSymbols.push(
      { text: "eat", category: "activity", frequency: 0.88, emoji: "🍽️" },
      { text: "drink", category: "activity", frequency: 0.85, emoji: "🥤" },
      { text: "hungry", category: "fringe", frequency: 0.79, emoji: "😋" },
      { text: "taste", category: "activity", frequency: 0.82, emoji: "👅" }
    );
  }
  
  if (visualContext.includes('outdoor') || visualContext.includes('outside')) {
    contextualSymbols.push(
      { text: "outside", category: "fringe", frequency: 0.85, emoji: "🌳" },
      { text: "walk", category: "activity", frequency: 0.82, emoji: "🚶" },
      { text: "sun", category: "fringe", frequency: 0.79, emoji: "☀️" },
      { text: "play", category: "activity", frequency: 0.76, emoji: "🎮" }
    );
  }
  
  // Emotional state adaptations
  if (emotionalState.includes('focused') || emotionalState.includes('concentrated')) {
    contextualSymbols.push(
      { text: "focus", category: "activity", frequency: 0.84, emoji: "🧠" },
      { text: "concentrate", category: "activity", frequency: 0.81, emoji: "🤔" },
      { text: "think", category: "activity", frequency: 0.78, emoji: "💭" },
      { text: "learn", category: "activity", frequency: 0.75, emoji: "📚" }
    );
  }
  
  // Combine core and contextual, remove duplicates
  const allSymbols = [...coreSymbols, ...contextualSymbols];
  const uniqueSymbols = allSymbols.filter((symbol, index, self) => 
    index === self.findIndex(s => s.text === symbol.text)
  );
  
  // Add contextual short sentence suggestions to enhanced fallback
  const sentenceSuggestions = generateShortSentences(context, {
    visualScene: context.visualContext,
    timeOfDay: context.time,
    emotionalState: (context as any).emotionalState,
    userAge: (context as any).userAge || 25
  } as any);
  
  allSymbols.push(...sentenceSuggestions.map((s: SymbolSuggestion) => ({
    text: s.label,
    category: s.category as any,
    frequency: s.confidence,
    emoji: s.emoji
  })));
  
  // Remove duplicates again after adding sentences
  const finalUniqueSymbols = allSymbols.filter((symbol, index, self) => 
    index === self.findIndex(s => s.text === symbol.text)
  );
  
  // Sort by contextual relevance and take top 10 (increased to include sentences)
  const rankedSymbols = finalUniqueSymbols
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 10);
  
  // Convert to SymbolSuggestion format
  return rankedSymbols.map((symbol, index) => ({
    id: `contextual_${symbol.text.toLowerCase().replace(/\s+/g, '_')}`,
    label: symbol.text,
    category: symbol.category,
    priority: Math.max(10 - index, 1),
    confidence: symbol.frequency,
    emoji: symbol.emoji,
    reasoning: `Dynamic contextual suggestion - ${symbol.category} vocabulary for current situation`
  }));
}

// Function to generate contextual short sentence suggestions
function generateShortSentences(
  context: ContextData,
  aacContext: { visualScene?: string; timeOfDay: string; emotionalState?: string; userAge: number }
): SymbolSuggestion[] {
  const sentences: SymbolSuggestion[] = [];
  const currentHour = new Date().getHours();
  const visualContext = context.visualContext?.toLowerCase() || '';
  const emotionalState = aacContext.emotionalState?.toLowerCase() || '';
  
  // Time-based sentences
  if (currentHour >= 6 && currentHour < 12) {
    sentences.push(
      {
        id: "sentence_good_morning",
        label: "Good morning",
        category: "greeting",
        priority: 8,
        confidence: 0.85,
        emoji: "🌅",
        reasoning: "Morning greeting sentence"
      },
      {
        id: "sentence_i_want_breakfast",
        label: "I want breakfast",
        category: "request",
        priority: 7,
        confidence: 0.82,
        emoji: "🍳",
        reasoning: "Morning food request"
      }
    );
  } else if (currentHour >= 12 && currentHour < 17) {
    sentences.push(
      {
        id: "sentence_i_want_lunch",
        label: "I want lunch",
        category: "request",
        priority: 8,
        confidence: 0.84,
        emoji: "🍽️",
        reasoning: "Afternoon food request"
      },
      {
        id: "sentence_need_break",
        label: "I need a break",
        category: "request",
        priority: 6,
        confidence: 0.78,
        emoji: "⏸️",
        reasoning: "Work break request"
      }
    );
  } else {
    sentences.push(
      {
        id: "sentence_i_want_dinner",
        label: "I want dinner",
        category: "request",
        priority: 8,
        confidence: 0.86,
        emoji: "🍽️",
        reasoning: "Evening food request"
      },
      {
        id: "sentence_i_am_tired",
        label: "I am tired",
        category: "feeling",
        priority: 7,
        confidence: 0.83,
        emoji: "😴",
        reasoning: "Evening tiredness expression"
      }
    );
  }
  
  // Universal sentences
  sentences.push(
    {
      id: "sentence_i_want_water",
      label: "I want water",
      category: "request",
      priority: 8,
      confidence: 0.88,
      emoji: "💧",
      reasoning: "Basic hydration request"
    },
    {
      id: "sentence_need_help",
      label: "I need help",
      category: "request",
      priority: 9,
      confidence: 0.92,
      emoji: "🆘",
      reasoning: "Essential assistance request"
    }
  );
  
  // Visual context-based sentences
  if (visualContext.includes('computer') || visualContext.includes('screen')) {
    sentences.push({
      id: "sentence_i_am_working",
      label: "I am working",
      category: "activity",
      priority: 7,
      confidence: 0.84,
      emoji: "💻",
      reasoning: "Computer work activity"
    });
  }
  
  // Emotional state-based sentences
  if (emotionalState.includes('focused') || emotionalState.includes('concentrated')) {
    sentences.push({
      id: "sentence_i_am_thinking",
      label: "I am thinking",
      category: "activity",
      priority: 6,
      confidence: 0.78,
      emoji: "💭",
      reasoning: "Focused mental activity"
    });
  }
  
  // Remove duplicates and return top sentences
  const uniqueSentences = sentences.filter((sentence, index, self) => 
    index === self.findIndex(s => s.label === sentence.label)
  );
  
  return uniqueSentences
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3); // Return top 3 sentence suggestions
}