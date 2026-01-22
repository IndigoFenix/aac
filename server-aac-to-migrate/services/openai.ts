import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { analyzeVideoFrame, type VideoAnalysisResult } from "./videoIntelligence";

// the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "default_key" 
});

// Initialize Gemini for visual analysis
const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface ContextData {
  time: string;
  location?: string;
  visualContext?: string;
  userProfile?: {
    name: string;
    age?: number;
    preferences?: string;
  };
  recentHistory?: Array<{
    symbols: string[];
    timestamp: string;
  }>;
}

export interface SymbolSuggestion {
  id: string;
  label: string;
  emoji: string;
  confidence: number;
  reasoning: string;
  category?: string;
  priority?: number;
}

export async function generateSymbolSuggestions(
  context: ContextData,
  language: string = "en"
): Promise<SymbolSuggestion[]> {
  console.log("Starting symbol suggestion generation...");
  
  // Using Gemini as default AI provider
  try {
    console.log(`Trying Gemini for symbol suggestions in language: ${language}...`);
    
    const languageInstructions = language === "he" 
      ? "IMPORTANT: Respond in Hebrew with Hebrew symbols and labels. Use Hebrew words like: אוכל (food), משחק (play), מים (water), עזרה (help), רוצה (want), לא (no), כן (yes), תודה (thank you). Use appropriate Hebrew cultural context and everyday Hebrew expressions suitable for children."
      : "Respond in English with English symbols and labels.";
    
    const geminiPrompt = `You are an AI assistant for an AAC communication device for a 7-year-old child. Based on this context, suggest 8 relevant communication symbols using simple words and concepts appropriate for a 7-year-old:

${languageInstructions}

Time: ${context.time}
Location: ${context.location || 'Unknown'}
Visual scene: ${context.visualContext || 'No visual data'}
User: ${context.userProfile?.name || 'User'}, Age: ${context.userProfile?.age || 'Unknown'}
Preferences: ${context.userProfile?.preferences || 'No preferences set'}

Respond with JSON only:
{
  "suggestions": [
    {"id": "unique_id", "label": "Symbol Label", "emoji": "🔥", "confidence": 0.95, "reasoning": "Why relevant"}
  ]
}`;

    const geminiResponse = await gemini.models.generateContent({
      model: "gemini-2.5-flash",
      contents: geminiPrompt,
    });

    console.log("Gemini response received for symbols, parsing...");
    
    // Clean up Gemini response - remove markdown code blocks
    let responseText = geminiResponse.text || "{}";
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const geminiResult = JSON.parse(responseText);
    console.log("Gemini symbol suggestions:", geminiResult.suggestions?.length || 0);
    return geminiResult.suggestions || getContextualFallbackSymbols(context, language);
  } catch (geminiError) {
    console.error("Error generating symbol suggestions with Gemini:", geminiError);
    console.log("Using contextual fallback symbols");
    return getContextualFallbackSymbols(context, language);
  }
}

function getContextualFallbackSymbols(context: ContextData, language: string = "en"): SymbolSuggestion[] {
  const currentHour = new Date().getHours();
  // Age-appropriate fallback symbols for 7-year-old
  const baseSymbols = language === "he" ? [
    { id: "happy", label: "שמח", emoji: "😊", confidence: 0.8, reasoning: "רגש בסיסי" },
    { id: "play", label: "לשחק", emoji: "🎮", confidence: 0.8, reasoning: "פעילות מתאימה לגיל" },
    { id: "toys", label: "צעצועים", emoji: "🧸", confidence: 0.7, reasoning: "עניין מתאים לגיל" },
    { id: "yes", label: "כן", emoji: "✅", confidence: 0.7, reasoning: "תגובה בסיסית" },
    { id: "no", label: "לא", emoji: "❌", confidence: 0.7, reasoning: "תגובה בסיסית" }
  ] : [
    { id: "happy", label: "Happy", emoji: "😊", confidence: 0.8, reasoning: "Basic emotion" },
    { id: "play", label: "Play", emoji: "🎮", confidence: 0.8, reasoning: "Age-appropriate activity" },
    { id: "toys", label: "Toys", emoji: "🧸", confidence: 0.7, reasoning: "Age-appropriate interest" },
    { id: "yes", label: "Yes", emoji: "✅", confidence: 0.7, reasoning: "Basic response" },
    { id: "no", label: "No", emoji: "❌", confidence: 0.7, reasoning: "Basic response" }
  ];

  // Add time-based symbols appropriate for 7-year-old
  if (currentHour >= 6 && currentHour < 12) {
    baseSymbols.push(language === "he" ? 
      { id: "breakfast", label: "ארוחת בוקר", emoji: "🥞", confidence: 0.9, reasoning: "פעילות בוקר" } :
      { id: "breakfast", label: "Breakfast", emoji: "🥞", confidence: 0.9, reasoning: "Morning activity" });
    baseSymbols.push(language === "he" ? 
      { id: "school", label: "בית ספר", emoji: "🏫", confidence: 0.8, reasoning: "פעילות בוקר" } :
      { id: "school", label: "School", emoji: "🏫", confidence: 0.8, reasoning: "Morning activity" });
  } else if (currentHour >= 12 && currentHour < 17) {
    baseSymbols.push(language === "he" ? 
      { id: "lunch", label: "ארוחת צהריים", emoji: "🥪", confidence: 0.8, reasoning: "פעילות אחר הצהריים" } :
      { id: "lunch", label: "Lunch", emoji: "🥪", confidence: 0.8, reasoning: "Afternoon activity" });
    baseSymbols.push(language === "he" ? 
      { id: "games", label: "משחקים", emoji: "🎯", confidence: 0.8, reasoning: "פעילות אחר הצהריים" } :
      { id: "games", label: "Games", emoji: "🎯", confidence: 0.8, reasoning: "Afternoon activity" });
  } else if (currentHour >= 17 && currentHour < 21) {
    baseSymbols.push(language === "he" ? 
      { id: "dinner", label: "ארוחת ערב", emoji: "🍕", confidence: 0.8, reasoning: "פעילות ערב" } :
      { id: "dinner", label: "Dinner", emoji: "🍕", confidence: 0.8, reasoning: "Evening activity" });
    baseSymbols.push(language === "he" ? 
      { id: "family", label: "משפחה", emoji: "👨‍👩‍👧‍👦", confidence: 0.8, reasoning: "פעילות ערב" } :
      { id: "family", label: "Family", emoji: "👨‍👩‍👧‍👦", confidence: 0.8, reasoning: "Evening activity" });
  } else {
    baseSymbols.push(language === "he" ? 
      { id: "bedtime", label: "שעת השינה", emoji: "🛏️", confidence: 0.8, reasoning: "פעילות לילה" } :
      { id: "bedtime", label: "Bedtime", emoji: "🛏️", confidence: 0.8, reasoning: "Night activity" });
    baseSymbols.push(language === "he" ? 
      { id: "tired", label: "עייף", emoji: "😴", confidence: 0.8, reasoning: "הרגשה בלילה" } :
      { id: "tired", label: "Tired", emoji: "😴", confidence: 0.8, reasoning: "Night feeling" });
  }

  return baseSymbols.slice(0, 8);
}

export async function analyzeVisualContext(base64Image: string): Promise<string> {
  try {
    const contents = [
      {
        inlineData: {
          data: base64Image,
          mimeType: "image/jpeg",
        },
      },
      "Analyze this image for AAC communication context. Identify: objects, people, activities, emotions, and any contextual clues that could help suggest relevant communication symbols. Be concise and focus on elements a non-verbal person might want to communicate about."
    ];

    const response = await gemini.models.generateContent({
      model: "gemini-2.5-pro",
      contents: contents,
    });

    return response.text || "No visual context available";
  } catch (error) {
    console.error("Error analyzing visual context with Gemini:", error);
    
    // Fallback to OpenAI if Gemini fails
    try {
      console.log("Trying OpenAI fallback for visual analysis...");
      
      if (!process.env.OPENAI_API_KEY) {
        console.log("No OpenAI API key available for fallback");
        return "Visual analysis unavailable (no fallback key)";
      }
      
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Analyze this image for AAC communication context. Identify: objects, people, activities, emotions, and any contextual clues that could help suggest relevant communication symbols. Be concise and focus on elements a non-verbal person might want to communicate about."
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`
                }
              }
            ],
          },
        ],
        max_tokens: 300,
      });

      return response.choices[0].message.content || "Visual analysis unavailable";
    } catch (openaiError) {
      console.error("OpenAI fallback also failed:", openaiError);
      return "Visual analysis unavailable";
    }
  }
}

export async function interpretSymbolSequence(
  symbols: string[],
  context: ContextData
): Promise<string> {
  try {
    console.log("Interpreting symbol sequence with Gemini...");
    const prompt = `You are helping interpret a sequence of AAC symbols into natural speech. 

Symbol sequence: ${symbols.join(' → ')}
Context: Time: ${context.time}, Visual: ${context.visualContext || 'None'}

Convert this symbol sequence into natural, conversational speech that represents the user's likely intent. Consider:
- The user's age and communication level
- The current context and situation
- Natural flow and grammar
- Emotional tone if applicable

Respond with just the interpreted speech, no extra formatting.`;

    const response = await gemini.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });

    return response.text || symbols.join(" ");
  } catch (error) {
    console.error("Error interpreting symbol sequence with Gemini:", error);
    return symbols.join(" ");
  }
}

export async function detectPersonDetails(base64Image: string, expectedAge?: number, expectedGender?: string): Promise<{
  personPresent: boolean;
  isMainUser: boolean;
  detectedAge?: number;
  detectedGender?: string;
  confidence: number;
}> {
  try {
    const prompt = `Analyze this image and detect if there is a person present. If a person is detected, estimate their age and gender.

Expected user profile: ${expectedAge ? `Age: ${expectedAge}` : 'Age: unknown'}, ${expectedGender ? `Gender: ${expectedGender}` : 'Gender: unknown'}

Respond with JSON in this exact format:
{
  "personPresent": boolean,
  "isMainUser": boolean,
  "detectedAge": number or null,
  "detectedGender": "male" or "female" or "unknown" or null,
  "confidence": number between 0 and 1
}

Rules:
- If no person is detected, set personPresent to false and all other fields to null/false
- If a person is detected but no expected profile provided, set isMainUser to true (assume it's the main user)
- If expected profile provided, compare detected age/gender with expected values
- Age match within ±5 years is acceptable
- Set isMainUser to true only if both age and gender reasonably match expected profile
- Confidence represents how certain you are about the detection and matching`;

    const response = await gemini.models.generateContent({
      model: "gemini-2.5-flash",
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            personPresent: { type: "boolean" },
            isMainUser: { type: "boolean" },
            detectedAge: { type: ["number", "null"] },
            detectedGender: { type: ["string", "null"] },
            confidence: { type: "number" }
          },
          required: ["personPresent", "isMainUser", "confidence"]
        }
      },
      contents: [
        {
          inlineData: {
            data: base64Image,
            mimeType: "image/jpeg",
          },
        },
        prompt
      ],
    });

    const result = JSON.parse(response.text || '{"personPresent": false, "isMainUser": false, "confidence": 0}');
    
    return {
      personPresent: result.personPresent || false,
      isMainUser: result.isMainUser || false,
      detectedAge: result.detectedAge,
      detectedGender: result.detectedGender,
      confidence: Math.max(0, Math.min(1, result.confidence || 0))
    };
  } catch (error) {
    console.error("Error detecting person details with Gemini:", error);
    
    // Fallback to OpenAI if Gemini fails
    try {
      console.log("Trying OpenAI fallback for person detection...");
      
      if (!process.env.OPENAI_API_KEY) {
        console.log("No OpenAI API key available for fallback");
        return {
          personPresent: false,
          isMainUser: false,
          confidence: 0
        };
      }
      
      const openaiPrompt = `Analyze this image and detect if there is a person present. If a person is detected, estimate their age and gender.

Expected user profile: ${expectedAge ? `Age: ${expectedAge}` : 'Age: unknown'}, ${expectedGender ? `Gender: ${expectedGender}` : 'Gender: unknown'}

Respond with JSON in this exact format:
{
  "personPresent": boolean,
  "isMainUser": boolean,
  "detectedAge": number or null,
  "detectedGender": "male" or "female" or "unknown" or null,
  "confidence": number between 0 and 1
}

Rules:
- If no person is detected, set personPresent to false and all other fields to null/false
- If a person is detected but no expected profile provided, set isMainUser to true (assume it's the main user)
- If expected profile provided, compare detected age/gender with expected values
- Age match within ±5 years is acceptable
- Set isMainUser to true only if both age and gender reasonably match expected profile
- Confidence represents how certain you are about the detection and matching`;

      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: openaiPrompt
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`
                }
              }
            ],
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: 300,
      });

      const result = JSON.parse(response.choices[0].message.content || '{"personPresent": false, "isMainUser": false, "confidence": 0}');
      
      return {
        personPresent: result.personPresent || false,
        isMainUser: result.isMainUser || false,
        detectedAge: result.detectedAge,
        detectedGender: result.detectedGender,
        confidence: Math.max(0, Math.min(1, result.confidence || 0))
      };
    } catch (openaiError) {
      console.error("OpenAI fallback also failed:", openaiError);
      return {
        personPresent: false,
        isMainUser: false,
        confidence: 0
      };
    }
  }
}

export async function analyzeImageWithOpenAI(imageBuffer: Buffer, prompt: string): Promise<string> {
  try {
    const base64Image = imageBuffer.toString('base64');
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt
            },
            {
              type: "image_url", 
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`
              }
            }
          ],
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 500,
    });

    return response.choices[0].message.content || "";
  } catch (error) {
    console.error("OpenAI image analysis failed:", error);
    throw error;
  }
}
