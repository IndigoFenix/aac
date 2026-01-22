import { GoogleGenAI } from "@google/genai";

// BERT-based AAC Symbol Prediction using PrAACT methodology
// Adapted from PrAACT (Predictive AAC Technology) research

interface AACContext {
  visualScene?: string;
  previousSymbols?: string[];
  timeOfDay?: string;
  location?: string;
  emotionalState?: string;
  userAge?: number;
  communicationGoal?: 'request' | 'comment' | 'question' | 'social' | 'protest';
}

interface PrAACTSymbol {
  id: string;
  text: string;
  emoji: string;
  category: 'core' | 'fringe' | 'activity';
  frequency: number;
  contextRelevance: number;
  ageAppropriateness: number;
  semanticSimilarity: number;
  pragmaticWeight: number;
  finalScore: number;
}

// Enhanced contextual vocabulary pools for dynamic suggestions
const CONTEXTUAL_VOCABULARY = {
  // Core vocabulary (always included but with contextual weighting)
  core: [
    { text: "I", category: "pronoun", frequency: 0.95, contexts: ["all"] },
    { text: "want", category: "verb", frequency: 0.92, contexts: ["all"] },
    { text: "more", category: "adjective", frequency: 0.89, contexts: ["all"] },
    { text: "help", category: "verb", frequency: 0.87, contexts: ["all"] },
    { text: "you", category: "pronoun", frequency: 0.81, contexts: ["all"] },
    { text: "yes", category: "response", frequency: 0.78, contexts: ["all"] },
    { text: "no", category: "response", frequency: 0.77, contexts: ["all"] }
  ],
  
  // Time-based contextual vocabulary
  morning: [
    { text: "wake", category: "verb", frequency: 0.85, contexts: ["morning"] },
    { text: "breakfast", category: "noun", frequency: 0.82, contexts: ["morning"] },
    { text: "coffee", category: "noun", frequency: 0.79, contexts: ["morning"] },
    { text: "start", category: "verb", frequency: 0.76, contexts: ["morning"] },
    { text: "ready", category: "adjective", frequency: 0.73, contexts: ["morning"] }
  ],
  
  afternoon: [
    { text: "lunch", category: "noun", frequency: 0.84, contexts: ["afternoon"] },
    { text: "work", category: "verb", frequency: 0.81, contexts: ["afternoon"] },
    { text: "busy", category: "adjective", frequency: 0.78, contexts: ["afternoon"] },
    { text: "computer", category: "noun", frequency: 0.75, contexts: ["afternoon"] },
    { text: "meeting", category: "noun", frequency: 0.72, contexts: ["afternoon"] }
  ],
  
  evening: [
    { text: "dinner", category: "noun", frequency: 0.86, contexts: ["evening"] },
    { text: "tired", category: "adjective", frequency: 0.83, contexts: ["evening"] },
    { text: "home", category: "noun", frequency: 0.80, contexts: ["evening"] },
    { text: "relax", category: "verb", frequency: 0.77, contexts: ["evening"] },
    { text: "watch", category: "verb", frequency: 0.74, contexts: ["evening"] }
  ],
  
  // Activity-based contextual vocabulary
  eating: [
    { text: "eat", category: "verb", frequency: 0.88, contexts: ["kitchen", "dining"] },
    { text: "drink", category: "verb", frequency: 0.85, contexts: ["kitchen", "dining"] },
    { text: "taste", category: "verb", frequency: 0.82, contexts: ["eating"] },
    { text: "hungry", category: "adjective", frequency: 0.79, contexts: ["eating"] },
    { text: "thirsty", category: "adjective", frequency: 0.76, contexts: ["eating"] }
  ],
  
  working: [
    { text: "focus", category: "verb", frequency: 0.84, contexts: ["office", "desk"] },
    { text: "type", category: "verb", frequency: 0.81, contexts: ["computer"] },
    { text: "read", category: "verb", frequency: 0.78, contexts: ["reading"] },
    { text: "write", category: "verb", frequency: 0.75, contexts: ["writing"] },
    { text: "think", category: "verb", frequency: 0.72, contexts: ["working"] }
  ],
  
  // Emotional state vocabulary
  happy: [
    { text: "excited", category: "emotion", frequency: 0.86, contexts: ["positive"] },
    { text: "smile", category: "verb", frequency: 0.83, contexts: ["happy"] },
    { text: "fun", category: "adjective", frequency: 0.80, contexts: ["happy"] },
    { text: "enjoy", category: "verb", frequency: 0.77, contexts: ["happy"] },
    { text: "love", category: "verb", frequency: 0.74, contexts: ["happy"] }
  ],
  
  sad: [
    { text: "sad", category: "emotion", frequency: 0.84, contexts: ["negative"] },
    { text: "cry", category: "verb", frequency: 0.81, contexts: ["sad"] },
    { text: "upset", category: "adjective", frequency: 0.78, contexts: ["sad"] },
    { text: "comfort", category: "verb", frequency: 0.75, contexts: ["sad"] },
    { text: "better", category: "adjective", frequency: 0.72, contexts: ["sad"] }
  ],
  
  // Visual context vocabulary
  outdoor: [
    { text: "outside", category: "adverb", frequency: 0.85, contexts: ["outdoor"] },
    { text: "walk", category: "verb", frequency: 0.82, contexts: ["outdoor"] },
    { text: "sun", category: "noun", frequency: 0.79, contexts: ["outdoor"] },
    { text: "play", category: "verb", frequency: 0.76, contexts: ["outdoor"] },
    { text: "fresh", category: "adjective", frequency: 0.73, contexts: ["outdoor"] }
  ],
  
  indoor: [
    { text: "inside", category: "adverb", frequency: 0.83, contexts: ["indoor"] },
    { text: "sit", category: "verb", frequency: 0.80, contexts: ["indoor"] },
    { text: "warm", category: "adjective", frequency: 0.77, contexts: ["indoor"] },
    { text: "comfortable", category: "adjective", frequency: 0.74, contexts: ["indoor"] },
    { text: "room", category: "noun", frequency: 0.71, contexts: ["indoor"] }
  ]
};

// BERT-like contextual analysis using Gemini with AAC specialization
import { shouldUseChatGPT5ForStudent, aacModelOverrideService } from "./aacModelOverride";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

// Enhanced emoji mapping for contextual symbols
function getEmojiForCoreSymbol(text: string): string {
  const emojiMap: Record<string, string> = {
    // Core vocabulary
    "I": "👤", "want": "🙏", "more": "➕", "help": "✋", "stop": "⏹️",
    "go": "🚶", "like": "👍", "you": "👥", "me": "👤", "yes": "✅",
    "no": "❌", "good": "😊", "bad": "😞", "happy": "😄", "sad": "😢",
    
    // Time-based vocabulary
    "wake": "⏰", "breakfast": "🍳", "coffee": "☕", "start": "▶️", "ready": "✅",
    "lunch": "🍽️", "work": "💻", "busy": "⏱️", "computer": "🖥️", "meeting": "🤝",
    "dinner": "🍽️", "tired": "😴", "home": "🏠", "relax": "😌", "watch": "📺",
    
    // Activity vocabulary  
    "eat": "🍽️", "drink": "🥤", "taste": "👅", "hungry": "😋", "thirsty": "🥤",
    "focus": "🧠", "type": "⌨️", "read": "📖", "write": "✏️", "think": "💭",
    
    // Emotional vocabulary
    "excited": "🤩", "smile": "😊", "fun": "🎉", "enjoy": "😍", "love": "❤️",
    "cry": "😢", "upset": "😟", "comfort": "🤗", "better": "👍",
    
    // Location vocabulary
    "outside": "🌳", "walk": "🚶", "sun": "☀️", "play": "🎮", "fresh": "🌿",
    "inside": "🏠", "sit": "🪑", "warm": "🔥", "comfortable": "😌", "room": "🏠"
  };
  
  return emojiMap[text.toLowerCase()] || "⭐";
}

export async function generateBERTAACSymbols(context: AACContext, language: string = "en", usePCS: boolean = false, studentId?: string): Promise<PrAACTSymbol[]> {
  try {
    console.log("Starting BERT-based AAC symbol prediction using PrAACT methodology...");

    // Add Hebrew language instruction if needed
    const languageInstruction = language === "he"
      ? "חשוב: יצר סמלים בעברית בלבד! השתמש במילים עבריות כמו: אני, רוצה, עזרה, עוד, טוב, רע, שמח, עצוב, אוכל, לשתות, לשחק, לישון. כל התגובות צריכות להיות בעברית עם סמלי אמוג'י מתאימים."
      : "Generate symbols in English.";

    // PrAACT-based prompt engineering for AAC-specific symbol prediction
    const aacPrompt = constructPrAACTPrompt(context, language, usePCS, languageInstruction);

    // Check if ChatGPT-5 override is enabled for BERT AAC symbols
    const useChatGPT5 = studentId ? await shouldUseChatGPT5ForStudent(studentId) : false;
    let rawResponse: string | undefined;

    if (useChatGPT5) {
      console.log(`🚀 Using ChatGPT-5 override for BERT AAC symbols - Student ${studentId}`);
      try {
        const systemInstruction = `You are a specialized BERT-based AAC (Augmentative and Alternative Communication) prediction engine using PrAACT methodology. 
        
        ${languageInstruction}
        
        PrAACT Principles:
        1. Prioritize CORE vocabulary (high-frequency words used across contexts)
        2. Consider pragmatic functions (request, comment, question, social interaction)
        3. Apply developmental appropriateness based on user age
        4. Weight contextual relevance from visual/environmental cues
        5. Include fringe vocabulary specific to current activity/location
        
        Symbol Categories:
        - CORE: Universal high-frequency words (I=אני, want=רוצה, more=עוד, help=עזרה, stop=עצור, go=ללכת, like=אוהב, good=טוב, bad=רע for Hebrew)
        - FRINGE: Context-specific vocabulary (coffee=קפה, computer=מחשב, work=עבודה, meeting=פגישה for Hebrew)
        - ACTIVITY: Action-related words for current situation
        
        Always respond with valid JSON array of symbol objects including appropriate emoji for each symbol.
        
        CRITICAL: Generate DIVERSE, CONTEXTUAL symbols that change based on the situation.
        DO NOT return the same symbols every time - adapt to:
        - Time of day (morning: wake, breakfast; afternoon: lunch, work; evening: dinner, tired)
        - Visual context (computer screen: type, work, focus; kitchen: eat, drink, hungry)
        - Emotional state (happy: smile, excited, fun; tired: rest, sleep, comfortable)
        - User age (children: play, fun, toys; adults: work, meeting, focus)
        
        Emoji Guidelines:
        - Core: I=👤, want=🙏, help=✋, stop=⏹️, more=➕, good=😊, bad=😞
        - Activities: work=💻, eat=🍽️, sleep=😴, play=🎮, type=⌨️, read=📖
        - Emotions: happy=😄, sad=😢, excited=🤩, tired=😴, smile=😊
        - Time: wake=⏰, breakfast=🍳, lunch=🍽️, dinner=🍽️, coffee=☕
        - Places: home=🏠, outside=🌳, room=🏠, computer=🖥️`;

        const jsonResponse = await aacModelOverrideService.generateChatGPT5JSON(
          aacPrompt,
          systemInstruction,
          0.7
        );

        rawResponse = JSON.stringify(jsonResponse);
      } catch (error) {
        console.error("ChatGPT-5 BERT AAC generation failed, falling back to Gemini:", error);
        // Fall back to original Gemini implementation
        const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      config: {
        systemInstruction: `You are a specialized BERT-based AAC (Augmentative and Alternative Communication) prediction engine using PrAACT methodology. 
        
        PrAACT Principles:
        1. Prioritize CORE vocabulary (high-frequency words used across contexts)
        2. Consider pragmatic functions (request, comment, question, social interaction)
        3. Apply developmental appropriateness based on user age
        4. Weight contextual relevance from visual/environmental cues
        5. Include fringe vocabulary specific to current activity/location
        
        Symbol Categories:
        - CORE: Universal high-frequency words (I, want, more, help, stop, go, like, good, bad)
        - FRINGE: Context-specific vocabulary (coffee, computer, work, meeting)
        - ACTIVITY: Action-related words for current situation
        
        Always respond with valid JSON array of symbol objects including appropriate emoji for each symbol.
        
        CRITICAL: Generate DIVERSE, CONTEXTUAL symbols that change based on the situation.
        DO NOT return the same symbols every time - adapt to:
        - Time of day (morning: wake, breakfast; afternoon: lunch, work; evening: dinner, tired)
        - Visual context (computer screen: type, work, focus; kitchen: eat, drink, hungry)
        - Emotional state (happy: smile, excited, fun; tired: rest, sleep, comfortable)
        - User age (children: play, fun, toys; adults: work, meeting, focus)
        
        Emoji Guidelines:
        - Core: I=👤, want=🙏, help=✋, stop=⏹️, more=➕, good=😊, bad=😞
        - Activities: work=💻, eat=🍽️, sleep=😴, play=🎮, type=⌨️, read=📖
        - Emotions: happy=😄, sad=😢, excited=🤩, tired=😴, smile=😊
        - Time: wake=⏰, breakfast=🍳, lunch=🍽️, dinner=🍽️, coffee=☕
        - Places: home=🏠, outside=🌳, room=🏠, computer=🖥️`,
        responseMimeType: "application/json",
        responseSchema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              emoji: { type: "string" },
              category: { type: "string", enum: ["core", "fringe", "activity"] },
              frequency: { type: "number" },
              contextRelevance: { type: "number" },
              ageAppropriateness: { type: "number" },
              semanticSimilarity: { type: "number" },
              pragmaticWeight: { type: "number" },
              finalScore: { type: "number" }
            },
            required: ["id", "text", "emoji", "category", "frequency", "contextRelevance", "ageAppropriateness", "semanticSimilarity", "pragmaticWeight", "finalScore"]
          }
        }
      },
      contents: aacPrompt
    });

        rawResponse = response.candidates?.[0]?.content?.parts?.[0]?.text;
      }
    } else {
      // Original Gemini implementation
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        config: {
          systemInstruction: `You are a specialized BERT-based AAC (Augmentative and Alternative Communication) prediction engine using PrAACT methodology. 
          
          ${languageInstruction}
          
          PrAACT Principles:
          1. Prioritize CORE vocabulary (high-frequency words used across contexts)
          2. Consider pragmatic functions (request, comment, question, social interaction)
          3. Apply developmental appropriateness based on user age
          4. Weight contextual relevance from visual/environmental cues
          5. Include fringe vocabulary specific to current activity/location
          
          Symbol Categories:
          - CORE: Universal high-frequency words (I, want, more, help, stop, go, like, good, bad)
          - FRINGE: Context-specific vocabulary (coffee, computer, work, meeting)
          - ACTIVITY: Action-related words for current situation
          
          Always respond with valid JSON array of symbol objects including appropriate emoji for each symbol.
          
          CRITICAL: Generate DIVERSE, CONTEXTUAL symbols that change based on the situation.
          DO NOT return the same symbols every time - adapt to:
          - Time of day (morning: wake, breakfast; afternoon: lunch, work; evening: dinner, tired)
          - Visual context (computer screen: type, work, focus; kitchen: eat, drink, hungry)
          - Emotional state (happy: smile, excited, fun; tired: rest, sleep, comfortable)
          - User age (children: play, fun, toys; adults: work, meeting, focus)
          
          Emoji Guidelines:
          - Core: I=👤, want=🙏, help=✋, stop=⏹️, more=➕, good=😊, bad=😞
          - Activities: work=💻, eat=🍽️, sleep=😴, play=🎮, type=⌨️, read=📖
          - Emotions: happy=😄, sad=😢, excited=🤩, tired=😴, smile=😊
          - Time: wake=⏰, breakfast=🍳, lunch=🍽️, dinner=🍽️, coffee=☕
          - Places: home=🏠, outside=🌳, room=🏠, computer=🖥️`,
          responseMimeType: "application/json",
          responseSchema: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                text: { type: "string" },
                emoji: { type: "string" },
                category: { type: "string", enum: ["core", "fringe", "activity"] },
                frequency: { type: "number" },
                contextRelevance: { type: "number" },
                ageAppropriateness: { type: "number" },
                semanticSimilarity: { type: "number" },
                pragmaticWeight: { type: "number" },
                finalScore: { type: "number" }
              },
              required: ["id", "text", "emoji", "category", "frequency", "contextRelevance", "ageAppropriateness", "semanticSimilarity", "pragmaticWeight", "finalScore"]
            }
          }
        },
        contents: aacPrompt
      });

      rawResponse = response.candidates?.[0]?.content?.parts?.[0]?.text;
    }
    if (!rawResponse) {
      throw new Error("Empty response from BERT AAC model");
    }

    const symbols: PrAACTSymbol[] = JSON.parse(rawResponse);
    
    // Apply PrAACT scoring algorithm
    const scoredSymbols = applyPrAACTScoring(symbols, context);
    
    // Sort by final PrAACT score (highest first)
    const rankedSymbols = scoredSymbols.sort((a, b) => b.finalScore - a.finalScore);
    
    console.log(`BERT AAC generated ${rankedSymbols.length} symbols using PrAACT methodology`);
    return rankedSymbols.slice(0, 8); // Return top 8 predictions
    
  } catch (error) {
    console.error("BERT AAC symbol prediction failed:", error);
    
    // Enhanced fallback: Return contextual vocabulary with dynamic scoring
    return generateFallbackCoreVocabulary(context, language);
  }
}

function constructPrAACTPrompt(context: AACContext, language: string, usePCS: boolean, languageInstruction?: string): string {
  const contextElements = [];
  
  if (context.visualScene) {
    contextElements.push(`Visual Context: ${context.visualScene}`);
  }
  
  if (context.previousSymbols && context.previousSymbols.length > 0) {
    contextElements.push(`Previous Communication: ${context.previousSymbols.join(' → ')}`);
  }
  
  if (context.timeOfDay) {
    contextElements.push(`Time: ${context.timeOfDay}`);
  }
  
  if (context.location) {
    contextElements.push(`Location: ${context.location}`);
  }
  
  if (context.emotionalState) {
    contextElements.push(`Emotional State: ${context.emotionalState}`);
  }
  
  const userAge = context.userAge || 25;
  const ageGroup = userAge < 12 ? "child" : userAge < 18 ? "adolescent" : "adult";
  
  const pcsInstruction = usePCS ? `
  Use PCS (Picture Communication Symbols) standards:
  - Clear, simple vocabulary
  - Age-appropriate complexity
  - Categories: People, Actions, Things, Feelings
  - Avoid abstract concepts for children` : "";

  return `Generate AAC symbol predictions using PrAACT methodology for a ${ageGroup} user.

Context:
${contextElements.join('\n')}

Language: ${language}
${languageInstruction || ""}
${pcsInstruction}

Apply PrAACT scoring:
1. Frequency: How often this word is used in AAC (0-1)
2. Context Relevance: How relevant to current situation (0-1) 
3. Age Appropriateness: How suitable for user's developmental level (0-1)
4. Semantic Similarity: How related to visual/contextual cues (0-1)
5. Pragmatic Weight: How useful for communication goals (0-1)

MANDATORY CONTEXTUAL ADAPTATION:
1. ALWAYS include 2-3 core symbols (I, want, help, more) for consistency
2. VARY the remaining 5-6 symbols based on context:
   - Morning (6-12): wake, breakfast, coffee, start, ready
   - Afternoon (12-17): lunch, work, busy, computer, meeting  
   - Evening (17-21): dinner, tired, home, relax, watch
   - Kitchen/dining: eat, drink, hungry, taste, thirsty
   - Computer/office: type, focus, read, write, think
   - Happy state: smile, excited, fun, enjoy, love
   - Tired state: rest, sleep, comfortable, warm, better
   - Outdoor: outside, walk, sun, play, fresh
   - Indoor: inside, sit, room, comfortable, warm

3. Weight symbols by relevance:
   - Direct visual matches: 0.9+ contextRelevance
   - Time-appropriate: 0.8+ contextRelevance  
   - Emotional matches: 0.7+ contextRelevance
   - Generic core: 0.6 contextRelevance

Generate 8 diverse, contextually-appropriate symbols mixing core with relevant fringe vocabulary.`;
}

function applyPrAACTScoring(symbols: PrAACTSymbol[], context: AACContext): PrAACTSymbol[] {
  return symbols.map(symbol => {
    // PrAACT weighted scoring algorithm
    const coreWeight = symbol.category === 'core' ? 1.2 : 1.0;
    const ageWeight = context.userAge && context.userAge < 12 ? 
      (symbol.ageAppropriateness * 1.3) : symbol.ageAppropriateness;
    
    // Calculate final PrAACT score
    const finalScore = (
      (symbol.frequency * 0.25) +
      (symbol.contextRelevance * 0.30) +
      (ageWeight * 0.20) +
      (symbol.semanticSimilarity * 0.15) +
      (symbol.pragmaticWeight * 0.10)
    ) * coreWeight;
    
    return {
      ...symbol,
      finalScore: Math.round(finalScore * 100) / 100
    };
  });
}

function generateFallbackCoreVocabulary(context: AACContext, language: string): PrAACTSymbol[] {
  console.log(`Using fallback core vocabulary for AAC in language: ${language}`);
  
  // Hebrew vocabulary mapping for fallback
  const hebrewVocabulary = language === "he" ? {
    "I": "אני",
    "want": "רוצה", 
    "more": "עוד",
    "help": "עזרה",
    "stop": "עצור",
    "good": "טוב",
    "bad": "רע",
    "yes": "כן",
    "no": "לא",
    "happy": "שמח",
    "sad": "עצוב",
    "eat": "לאכול",
    "drink": "לשתות",
    "play": "לשחק",
    "sleep": "לישון",
    "work": "לעבוד",
    "home": "בית",
    "outside": "בחוץ",
    "inside": "בפנים"
  } : {};
  
  // Determine time-based context for better variety
  const currentHour = new Date().getHours();
  const timeContext = currentHour >= 6 && currentHour < 12 ? "morning" :
                     currentHour >= 12 && currentHour < 17 ? "afternoon" : "evening";
  
  // Build contextual vocabulary pool
  let vocabularyPool: any[] = [...CONTEXTUAL_VOCABULARY.core];
  
  // Add time-based vocabulary
  if (CONTEXTUAL_VOCABULARY[timeContext as keyof typeof CONTEXTUAL_VOCABULARY]) {
    vocabularyPool.push(...CONTEXTUAL_VOCABULARY[timeContext as keyof typeof CONTEXTUAL_VOCABULARY]);
  }
  
  // Add emotional context if available
  if (context.emotionalState) {
    const emotionKey = context.emotionalState.toLowerCase().includes('happy') ? 'happy' :
                      context.emotionalState.toLowerCase().includes('sad') ? 'sad' : null;
    if (emotionKey && CONTEXTUAL_VOCABULARY[emotionKey as keyof typeof CONTEXTUAL_VOCABULARY]) {
      vocabularyPool.push(...CONTEXTUAL_VOCABULARY[emotionKey as keyof typeof CONTEXTUAL_VOCABULARY]);
    }
  }
  
  // Add visual context vocabulary
  if (context.visualScene) {
    const isOutdoor = context.visualScene.toLowerCase().includes('outdoor') || 
                     context.visualScene.toLowerCase().includes('outside');
    const contextKey = isOutdoor ? 'outdoor' : 'indoor';
    vocabularyPool.push(...CONTEXTUAL_VOCABULARY[contextKey]);
    
    // Add activity-specific vocabulary
    if (context.visualScene.toLowerCase().includes('computer') || 
        context.visualScene.toLowerCase().includes('desk')) {
      vocabularyPool.push(...CONTEXTUAL_VOCABULARY.working);
    }
    if (context.visualScene.toLowerCase().includes('kitchen') || 
        context.visualScene.toLowerCase().includes('dining')) {
      vocabularyPool.push(...CONTEXTUAL_VOCABULARY.eating);
    }
  }
  
  // Remove duplicates and sort by frequency
  const uniqueVocabulary = vocabularyPool.filter((word, index, self) => 
    index === self.findIndex(w => w.text === word.text)
  ).sort((a, b) => b.frequency - a.frequency);
  
  // Return top 8 contextual symbols with PrAACT scoring and Hebrew translation
  return uniqueVocabulary.slice(0, 8).map((word, index) => {
    const translatedText = language === "he" && hebrewVocabulary[word.text] 
      ? hebrewVocabulary[word.text] 
      : word.text;
    
    return {
      id: `contextual_${word.text.toLowerCase()}`,
      text: translatedText,
      emoji: getEmojiForCoreSymbol(word.text),
      category: word.category === 'pronoun' || word.category === 'verb' ? 'core' : 
               word.category === 'emotion' ? 'activity' : 'fringe',
      frequency: word.frequency,
      contextRelevance: 0.85 - (index * 0.05), // Higher relevance for earlier items
      ageAppropriateness: 0.9,
      semanticSimilarity: 0.8,
      pragmaticWeight: 0.85,
      finalScore: (word.frequency * 0.9) + (0.85 - (index * 0.05)) * 0.1
    };
  });
}

// Export for contextual symbols service integration
export { AACContext, PrAACTSymbol };