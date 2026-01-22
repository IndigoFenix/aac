import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { VertexAI } from "@google-cloud/vertexai";
import { generateChatAgentVoice, generateUserSymbolVoice } from "./voiceManager";
import type { ContextData } from "./openai";
import { storage } from "../storage";
import { modelOverrideService, shouldUseChatGPT5 } from "./modelOverride";

// Initialize OpenAI (for backup)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

// Initialize Gemini Pro for chat conversations (fallback)
const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

// Initialize Vertex AI for primary conversation agent (enterprise quotas)
const vertexAI = new VertexAI({
  project: process.env.GOOGLE_CLOUD_PROJECT_ID!,
  location: process.env.GOOGLE_CLOUD_LOCATION!,
});

export interface ConversationMessage {
  id: string;
  role: 'agent' | 'user';
  content: string;
  timestamp: Date;
  audioUrl?: string;
}

export interface ConversationState {
  userId: string;
  messages: ConversationMessage[];
  currentTopic?: string;
  userProfile?: {
    name?: string;
    age?: number;
    interests?: string[];
    communicationLevel?: 'basic' | 'intermediate' | 'advanced';
  };
}

// Store conversations in memory (in production, use database)
const activeConversations: Map<string, ConversationState> = new Map();

export async function startConversation(
  userId: string, 
  userProfile?: any,
  visualContext?: string,
  language: string = "en",
  emotionalContext?: string,
  audioContext?: any
): Promise<ConversationMessage> {
  console.log("Starting new conversation for user:", userId);
  
  // Get user's custom chat agent prompt or demo scenario
  const user = await storage.getUser(userId);
  let customPrompt = user?.chatAgentPrompt || "You are a supportive, friendly AI assistant helping with communication. Speak like you're talking to a 7-year-old - use simple words, short sentences, and be encouraging. Make observations about what you see and the current situation, but don't ask open-ended questions. Focus on the here and now.";
  
  // Override with demo scenario if demo mode is enabled
  if (user?.demoMode && user?.demoScenario) {
    customPrompt = user.demoScenario;
  }
  
  // Generate context-aware greeting
  const currentHour = new Date().getHours();
  let greeting = "";
  
  const userName = userProfile?.name ? userProfile.name : "";
  const timeGreeting = currentHour >= 6 && currentHour < 12 ? 
    (language === "he" ? "בוקר טוב" : "Good morning") :
    currentHour >= 12 && currentHour < 17 ? 
    (language === "he" ? "צהריים טובים" : "Good afternoon") :
    currentHour >= 17 && currentHour < 21 ? 
    (language === "he" ? "ערב טוב" : "Good evening") : 
    (language === "he" ? "שלום" : "Hello");
  
  // Incorporate visual context and time-based observations into greeting
  if (visualContext && visualContext.length > 10) {
    try {
      const now = new Date();
      const currentHour = now.getHours();
      const timeOfDay = currentHour >= 6 && currentHour < 12 ? "morning" :
                       currentHour >= 12 && currentHour < 17 ? "afternoon" :
                       currentHour >= 17 && currentHour < 21 ? "evening" : "night";
      
      // Remove the placeholder line that was causing the error

      // Include audio context in greeting generation if available
      const audioSpeech = audioContext?.transcript || '';
      const speechPresent = audioContext?.speechPresent || false;
      
      const conversationPrompt = language === "he" ? 
        `אתה יוצר הודעת ברכה הקשרית בעברית. צור הערה חמה והקשרית שכוללת:
1. ברכת זמן מתאימה בעברית
2. התבוננות ספציפית על מה שאתה רואה בסביבה
3. הזכרה טבעית של זמן היום
4. תגובה לרגש המשתמש אם זמין: ${emotionalContext || 'לא זמין'}
5. ${speechPresent && audioSpeech.trim().length > 0 ? `שילוב הקשר של דיבור מבן משפחה/מטפל: "${audioSpeech}" אם רלוונטי` : 'אין דיבור מבני משפחה זוהה'}
6. רק 1-2 משפטים
7. מעקב אחר ההנחיות ההתנהגותיות שלך

התמקד במה שנראה: בגדים, חדר, תאורה, חפצים, פעילויות שקורות עכשיו.
תגיבו בהתאם לרגש:
- שמח: "נראה שאתה בהמון טוב! כיף לראות אותך כך!"
- עצוב: "אני כאן איתך. בואי נמצא משהו שיעשה לך טוב."
- מתוסכל: "נראה שהיום קצת קשה. אולי נמצא דרך לעזור?"
השב רק עם טקסט ההערה, ללא עיצוב.

דוגמאות:
- בוקר: "${timeGreeting}! אני רואה אותך בחדר שלך - נראה כמו יום מצוין להתחיל!"
- צהריים: "${timeGreeting}! אני רואה שאתה בבית - זמן מושלם לקצת כיף!"
- ערב: "${timeGreeting}! נראה נעים במקום שלך - דרך נחמדה לסיים את היום!"` :
        `You are creating a contextual greeting comment. Generate a warm, contextual comment that:
1. Uses the appropriate time greeting
2. Makes a specific observation about what you can see in their environment
3. References the time of day naturally
4. Responds appropriately to user's emotional state: ${emotionalContext || 'not available'}
5. ${speechPresent && audioSpeech.trim().length > 0 ? `Incorporates family/caregiver speech context: "${audioSpeech}" if relevant to the greeting` : 'No family/caregiver speech detected to incorporate'}
6. Is only 1-2 sentences
7. Follows your behavior guidelines exactly

Focus on what's visible: clothing, room, lighting, objects, activities happening now.
Respond appropriately to emotions:
- Happy: "You look like you're having a great time! I love seeing you smile!"
- Sad: "I can see you're feeling down. I'm here with you."
- Frustrated: "It looks like you're having a tough moment. Let's see if we can help."
- Excited: "You look so excited! That energy is wonderful!"
Respond with just the comment text, no formatting.

Time-specific examples:
- Morning: "Good morning! I can see you in your room - looks like a great day to start!"
- Afternoon: "Good afternoon! I see you're at home - perfect time to have some fun!"
- Evening: "Good evening! It looks cozy where you are - nice way to end the day!"`;

      // Check if ChatGPT-5 override is enabled for greeting generation
      const useChatGPT5 = await shouldUseChatGPT5(userId);
      
      if (useChatGPT5) {
        console.log(`🚀 Using ChatGPT-5 override for greeting generation - User ${userId}`);
        try {
          const contextPrompt = `${conversationPrompt}
        
CURRENT CONTEXT:
Time: ${timeGreeting} (${timeOfDay})
User name: ${userName || 'friend'}
Visual scene: ${visualContext}
${emotionalContext ? `Emotional state: ${emotionalContext}` : ""}
${speechPresent && audioSpeech.trim().length > 0 ? `Family/Caregiver speech: "${audioSpeech}"` : ""}
Current location: Home`;

          greeting = await modelOverrideService.generateChatGPT5Response(
            contextPrompt,
            customPrompt,
            0.8,
            150
          ) || getDefaultGreeting(currentHour, userName, language);
        } catch (error) {
          console.error("ChatGPT-5 greeting generation failed, falling back to Gemini:", error);
          // Fall back to original Gemini implementation
          const response = await gemini.models.generateContent({
            model: "gemini-2.5-flash",
            contents: `${conversationPrompt}
        
CURRENT CONTEXT:
Time: ${timeGreeting} (${timeOfDay})
User name: ${userName || 'friend'}
Visual scene: ${visualContext}
${emotionalContext ? `Emotional state: ${emotionalContext}` : ""}
${speechPresent && audioSpeech.trim().length > 0 ? `Family/Caregiver speech: "${audioSpeech}"` : ""}
Current location: Home`,
          });
          
          greeting = response.candidates?.[0]?.content?.parts?.[0]?.text || getDefaultGreeting(currentHour, userName, language);
        }
      } else {
        // Original Gemini implementation
        const response = await gemini.models.generateContent({
          model: "gemini-2.5-flash",
          contents: `${conversationPrompt}
        
CURRENT CONTEXT:
Time: ${timeGreeting} (${timeOfDay})
User name: ${userName || 'friend'}
Visual scene: ${visualContext}
${emotionalContext ? `Emotional state: ${emotionalContext}` : ""}
${speechPresent && audioSpeech.trim().length > 0 ? `Family/Caregiver speech: "${audioSpeech}"` : ""}
Current location: Home`,
        });
        
        greeting = response.candidates?.[0]?.content?.parts?.[0]?.text || getDefaultGreeting(currentHour, userName, language);
      }
    } catch (error) {
      console.error("Error generating contextual greeting:", error);
      greeting = getDefaultGreeting(currentHour, userName, language);
    }
  } else {
    greeting = getDefaultGreeting(currentHour, userName, language);
  }

  const message: ConversationMessage = {
    id: `msg_${Date.now()}`,
    role: 'agent',
    content: greeting,
    timestamp: new Date(),
  };

  // Initialize conversation state
  const conversationState: ConversationState = {
    userId,
    messages: [message],
    userProfile,
    currentTopic: 'greeting'
  };

  activeConversations.set(userId, conversationState);
  
  return message;
}

function getDefaultGreeting(currentHour: number, userName?: string, language: string = "en"): string {
  const name = userName ? ` ${userName}` : "";
  
  if (language === "he") {
    if (currentHour >= 6 && currentHour < 12) {
      return `בוקר טוב${name}! נראה שאתה מוכן ליום מהנה!`;
    } else if (currentHour >= 12 && currentHour < 17) {
      return `צהריים טובים${name}! אני רואה שאתה נהנה!`;
    } else if (currentHour >= 17 && currentHour < 21) {
      return `ערב טוב${name}! נראה שאתה שמח היום!`;
    } else {
      return `שלום${name}! נחמד לראות אותך!`;
    }
  } else {
    if (currentHour >= 6 && currentHour < 12) {
      return `Good morning${name}! You look ready for a fun day!`;
    } else if (currentHour >= 12 && currentHour < 17) {
      return `Good afternoon${name}! I can see you're having a good time!`;
    } else if (currentHour >= 17 && currentHour < 21) {
      return `Good evening${name}! You look happy today!`;
    } else {
      return `Hi${name}! Nice to see you!`;
    }
  }
}

export async function generateAgentResponse(
  userId: string, 
  userSymbols: string[], 
  context: ContextData,
  language: string = "en"
): Promise<ConversationMessage> {
  console.log("Generating agent response for symbols:", userSymbols);
  
  const conversation = activeConversations.get(userId);
  if (!conversation) {
    throw new Error("No active conversation found");
  }

  // Get user's custom chat agent prompt or demo scenario
  const user = await storage.getUser(userId);
  let customPrompt = user?.chatAgentPrompt || "You are a supportive, friendly AI assistant helping with communication. Speak like you're talking to a 7-year-old - use simple words, short sentences, and be encouraging. Make observations about what you see and the current situation, but don't ask open-ended questions. Focus on the here and now.";
  
  // Override with demo scenario if demo mode is enabled
  if (user?.demoMode && user?.demoScenario) {
    customPrompt = user.demoScenario;
  }

  // Add user message to conversation
  const userMessage: ConversationMessage = {
    id: `msg_${Date.now()}_user`,
    role: 'user',
    content: userSymbols.join(" "),
    timestamp: new Date(),
  };
  conversation.messages.push(userMessage);

  // Get today's chat history for contextual awareness
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let todayEvents: any[] = [];
  
  try {
    const todayHistory = await storage.getChatHistoryByDateRange(userId, todayStart, now);
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
    console.log("Could not retrieve today's chat history:", error);
  }

  // Generate contextual response using Gemini
  const recentMessages = conversation.messages.slice(-6); // Last 6 messages for context
  const conversationHistory = recentMessages.map(m => 
    `${m.role === 'agent' ? 'Agent' : 'User'}: ${m.content}`
  ).join('\n');

  const currentHour = new Date().getHours();
  const timeOfDay = currentHour >= 6 && currentHour < 12 ? "morning" :
                   currentHour >= 12 && currentHour < 17 ? "afternoon" :
                   currentHour >= 17 && currentHour < 21 ? "evening" : "night";

  const languageInstruction = language === "he" 
    ? "IMPORTANT: השב בעברית בלבד. השתמש בביטויים עבריים טבעיים והתאם לגיל ילדים. כל הטקסט צריך להיות בתווים עבריים." 
    : "Respond in English.";

  // Extract audio context from session if available
  const audioContext = (context as any).audioContext;
  const audioSpeech = audioContext?.transcript || '';
  const audioLanguage = audioContext?.detectedLanguage || '';
  const ambientSounds = audioContext?.ambientSounds || [];
  const speechPresent = audioContext?.speechPresent || false;
  
  // Build audio context description
  let audioContextDescription = '';
  if (speechPresent && audioSpeech.trim().length > 0) {
    audioContextDescription = `
AUDIO CONTEXT FROM ENVIRONMENT (Family/Caregiver Speech):
- Recent speech detected: "${audioSpeech}"
- Language: ${audioLanguage || 'Unknown'}
- This is likely from a family member, caregiver, or someone nearby (not the main AAC user)
- Consider this speech as additional environmental context that may relate to the user's symbols
- Reference this speech if it's relevant to what the user is communicating about
`;
  } else if (ambientSounds.length > 0) {
    audioContextDescription = `
AUDIO ENVIRONMENT:
- Ambient sounds detected: ${ambientSounds.join(', ')}
- No clear speech from family/caregivers at the moment
`;
  }

  const prompt = `${languageInstruction}

ROLE AND BEHAVIOR INSTRUCTIONS:
${customPrompt}

Conversation history:
${conversationHistory}

User just communicated with symbols: ${userSymbols.join(" ")}

CURRENT CONTEXT (Must reference in response):
- Time: ${context.time} (${timeOfDay})
- Location: Home
- Visual scene: ${context.visualContext || 'Basic indoor environment'}
- User: ${conversation.userProfile?.name || 'Friend'}, Age: ${conversation.userProfile?.age || 'Unknown'}
- Emotional state: ${(context as any).emotionalContext || 'neutral/unknown'}
${audioContextDescription}

TODAY'S EVENTS (Use for contextual awareness):
${todayEvents.length > 0 ? 
  todayEvents.map(event => `- ${event.time}: User communicated "${event.symbols.join(' ')}" (${event.interpretation})`).join('\n') : 
  '- No previous events today'
}

CONTEXT AWARENESS REQUIREMENTS:
Generate a response that follows your role instructions above and MUST:
1. Acknowledge what the user communicated with their symbols
2. Connect their message to what you can see in their current visual environment from Vertex AI analysis
3. Reference the current time of day naturally (this ${timeOfDay}, etc.)
4. Make observations about their current location/surroundings from the visual scene data
5. Respond empathetically to their current emotional state (happy, sad, frustrated, excited, etc.)
6. ${speechPresent && audioSpeech.trim().length > 0 ? `IMPORTANT: Incorporate the family/caregiver speech ("${audioSpeech}") if it's relevant to the user's symbols - this provides additional context about what's happening around them` : 'No family/caregiver speech detected to incorporate'}
7. Be conversational, easy-going, and interesting while keeping it simple
8. Suggest logical next actions or symbols they might want to use based on the conversation
9. Be only 1-2 sentences long
10. Follow your behavior guidelines exactly

EMOTIONAL RESPONSE GUIDELINES:
- Happy: Celebrate their joy! Share their excitement and energy
- Sad: Offer comfort and understanding. Be gentle and supportive  
- Frustrated: Acknowledge their feelings and suggest calming activities
- Excited: Match their energy and enthusiasm appropriately
- Focused: Support their concentration and acknowledge their determination

VISUAL INTEGRATION PRIORITY:
- Use the detailed Vertex AI visual analysis to make specific, accurate observations
- Reference actual objects, lighting, setting details from the scene analysis
- Connect their symbols to what's actually visible in their environment
- Make predictions about what they might want to communicate next
- Keep the conversation flowing naturally and engagingly

CONVERSATION STYLE:
- Easy-going and relaxed tone
- Show genuine interest in what they're sharing
- Make simple but insightful connections
- Offer gentle encouragement to continue communicating

Respond with just the conversational text, no formatting.`;

  try {
    // Check if ChatGPT-5 override is enabled for conversation generation
    const useChatGPT5 = await shouldUseChatGPT5(userId);
    let agentResponse: string | undefined;
    
    if (useChatGPT5) {
      console.log(`🚀 Using ChatGPT-5 override for conversation generation - User ${userId}`);
      try {
        agentResponse = await modelOverrideService.generateChatGPT5Response(
          prompt,
          undefined, // System instruction already in prompt
          0.8,
          300
        );
        console.log("ChatGPT-5 response received:", agentResponse);
      } catch (error) {
        console.error("ChatGPT-5 conversation generation failed, falling back to Gemini:", error);
        // Fall back to original Gemini implementation
        console.log("Attempting Gemini API conversation generation...");
        const response = await gemini.models.generateContent({
          model: "gemini-2.5-flash",
          contents: prompt,
        });
        agentResponse = response.candidates?.[0]?.content?.parts?.[0]?.text;
        console.log("Gemini API response received:", agentResponse);
      }
    } else {
      // Original Gemini implementation
      console.log("Attempting Gemini API conversation generation...");
      const response = await gemini.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
      });
      agentResponse = response.candidates?.[0]?.content?.parts?.[0]?.text;
      console.log("Gemini API response received:", agentResponse);
    }
    
    if (!agentResponse || agentResponse.trim().length === 0) {
      throw new Error("Empty response from AI model");
    }
    
    const agentMessage: ConversationMessage = {
      id: `msg_${Date.now()}_agent`,
      role: 'agent',
      content: agentResponse,
      timestamp: new Date(),
    };

    conversation.messages.push(agentMessage);
    activeConversations.set(userId, conversation);

    console.log("Agent response generated successfully with Gemini API");
    return agentMessage;
    
  } catch (error) {
    console.error("Gemini API failed, trying Vertex AI fallback:", error);
    
    // Track error in session for debug window
    if ((global as any).currentSession) {
      ((global as any).currentSession as any).lastQuotaError = {
        service: "Gemini API", 
        error: (error as any)?.message || String(error),
        timestamp: new Date().toISOString()
      };
    }
    
    // Try Vertex AI as fallback
    try {
      console.log("Attempting Vertex AI fallback conversation generation...");
      const model = vertexAI.getGenerativeModel({ 
        model: "gemini-2.5-flash",
        systemInstruction: customPrompt
      });

      const response = await model.generateContent(prompt);

      const agentResponse = response.response?.text() || "";
      console.log("Vertex AI fallback response received:", agentResponse);
      
      if (!agentResponse || agentResponse.trim().length === 0) {
        throw new Error("Empty response from Vertex AI");
      }
      
      const agentMessage: ConversationMessage = {
        id: `msg_${Date.now()}_agent`,
        role: 'agent',
        content: agentResponse,
        timestamp: new Date(),
      };

      conversation.messages.push(agentMessage);
      activeConversations.set(userId, conversation);

      console.log("Agent response generated successfully with Vertex AI fallback");
      return agentMessage;
      
    } catch (vertexError) {
      console.error("Vertex AI fallback failed, trying OpenAI:", vertexError);
      
      // Final fallback to OpenAI with the same prompt
    try {
      const fallbackResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: prompt.split('\n').slice(0, 10).join('\n') // Use first part of prompt to avoid token limits
          },
          {
            role: "user", 
            content: `User just communicated with symbols: ${userSymbols.join(" ")}. Please respond following the behavioral guidelines above.`
          }
        ],
        max_tokens: 150
      });

      const agentResponse = fallbackResponse.choices[0]?.message?.content || generateSmartFallback(userSymbols, context);
      console.log("OpenAI fallback response:", agentResponse);
      
      const agentMessage: ConversationMessage = {
        id: `msg_${Date.now()}_agent`,
        role: 'agent',
        content: agentResponse,
        timestamp: new Date(),
      };

      conversation.messages.push(agentMessage);
      activeConversations.set(userId, conversation);
      
      return agentMessage;
      
    } catch (openaiError) {
      console.error("OpenAI fallback also failed:", openaiError);
      
      // Smart contextual fallback based on symbols and context
      const smartResponse = generateSmartFallback(userSymbols, context, language);
      
      const agentMessage: ConversationMessage = {
        id: `msg_${Date.now()}_agent`,
        role: 'agent',
        content: smartResponse,
        timestamp: new Date(),
      };

      conversation.messages.push(agentMessage);
      activeConversations.set(userId, conversation);
      
      return agentMessage;
    }
    }
  }
}

export function getConversationHistory(userId: string): ConversationMessage[] {
  const conversation = activeConversations.get(userId);
  return conversation?.messages || [];
}

export async function generateMessageAudio(messageId: string, text: string, language: string = "en", userProfile?: any, isUserMessage: boolean = false): Promise<Buffer> {
  console.log("Generating audio for message:", messageId, "Language:", language, "isUserMessage:", isUserMessage);
  
  if (isUserMessage) {
    // User symbol responses use age/gender matched voices
    return await generateUserSymbolVoice(text, language, userProfile);
  } else {
    // Chat agent responses always use female voice
    return await generateChatAgentVoice(text, language);
  }
}

// Smart fallback function when AI services fail - provides contextual responses
function generateSmartFallback(userSymbols: string[], context: any, language: string = "en"): string {
  const symbols = userSymbols.join(" ").toLowerCase();
  const currentHour = new Date().getHours();
  const timeOfDay = currentHour >= 17 ? "evening" : currentHour >= 12 ? "afternoon" : "morning";
  
  // Extract contextual information
  const visualContext = context?.visualContext?.toLowerCase() || '';
  const emotionalState = context?.emotionalContext?.toLowerCase() || '';
  
  if (language === "he") {
    // Hebrew contextual responses
    if (symbols.includes("happy") || symbols.includes("good") || symbols.includes("שמח") || symbols.includes("טוב")) {
      if (timeOfDay === "morning") {
        return `נהדר! אני רואה שאתה מתחיל את הבוקר בטוב לב! השמש בוהקת בחוץ והכל נראה מצוין.`;
      } else if (timeOfDay === "afternoon") {
        return `איזה כיף! באמת נראה שאתה נהנה היום. האור הנעים בחדר מראה שהכל בסדר.`;
      } else {
        return `מקסים! נראה שהערב שלך טוב. אני רואה שאתה מרוצה ממה שקורה כאן.`;
      }
    } else if (symbols.includes("eat") || symbols.includes("food") || symbols.includes("hungry") || symbols.includes("אוכל") || symbols.includes("רעב")) {
      if (timeOfDay === "morning") {
        return `ארוחת בוקר נשמעת כמו רעיון מעולה! בטח זמן לאכול משהו טוב לפני שהיום מתחיל.`;
      } else if (timeOfDay === "afternoon") {
        return `ארוחת צהריים! בזמן הזה של היום בטח יש לך כוח לאכול משהו טעים.`;
      } else {
        return `אוכל לערב נשמע נפלא! אני רואה שזה הזמן לארוחה נעימה.`;
      }
    } else if (symbols.includes("play") || symbols.includes("fun") || symbols.includes("משחק") || symbols.includes("כיף")) {
      return `משחק זה תמיד רעיון נהדר! אני רואה שיש לך אנרגיה לבלות ולהנות.`;
    } else if (symbols.includes("tired") || symbols.includes("rest") || symbols.includes("עייף") || symbols.includes("מנוחה")) {
      return `נראה שאתה קצת עייף. בזמן הזה של ה${timeOfDay === "morning" ? "בוקר" : timeOfDay === "afternoon" ? "יום" : "ערב"} זה בסדר גמור לנוח קצת.`;
    } else if (symbols.includes("help") || symbols.includes("need") || symbols.includes("עזרה") || symbols.includes("צריך")) {
      return `כמובן שאני כאן לעזור לך! מה שאתה צריך, בזמן הזה של היום, זה החשוב ביותר.`;
    } else if (symbols.includes("work") || symbols.includes("focus") || symbols.includes("type") || symbols.includes("עבודה")) {
      return `עבודה זה משהו חשוב! אני רואה שאתה מתרכז ועושה דברים חשובים כאן.`;
    } else if (symbols.includes("outside") || symbols.includes("sun") || symbols.includes("walk") || symbols.includes("בחוץ")) {
      return `בחוץ נשמע נפלא! אני רואה שהמזג אוויר נעים והזמן מתאים לצאת.`;
    } else {
      return `אני רואה שאתה אומר לי "${userSymbols.join(" ")}". זה מעניין! מה עוד קורה כאן ב${timeOfDay === "morning" ? "בוקר" : timeOfDay === "afternoon" ? "צהריים" : "ערב"} הזה?`;
    }
  } else {
    // English contextual responses
    if (symbols.includes("happy") || symbols.includes("good") || symbols.includes("smile") || symbols.includes("excited")) {
      if (visualContext.includes('computer') || visualContext.includes('desk')) {
        return `That's wonderful! I can see you're feeling good while working at your computer this ${timeOfDay}. The setup looks comfortable!`;
      } else if (visualContext.includes('kitchen') || visualContext.includes('dining')) {
        return `Great! You look happy in the kitchen area. It's nice to see you enjoying this ${timeOfDay} here.`;
      } else if (visualContext.includes('outdoor') || symbols.includes('outside')) {
        return `Fantastic! Being outside with that positive energy looks perfect for this ${timeOfDay}!`;
      } else {
        return `That's wonderful! Your happy mood really brightens up this ${timeOfDay}. I can see you're in a great space.`;
      }
    } else if (symbols.includes("eat") || symbols.includes("food") || symbols.includes("hungry") || symbols.includes("drink")) {
      if (timeOfDay === "morning") {
        return `Breakfast sounds perfect! This morning timing is ideal for getting some good fuel for the day.`;
      } else if (timeOfDay === "afternoon") {
        return `Lunch time! You're right on schedule for this ${timeOfDay}. What sounds good to you?`;
      } else {
        return `Dinner sounds great for this ${timeOfDay}! I can see you're ready for a good meal.`;
      }
    } else if (symbols.includes("play") || symbols.includes("fun") || symbols.includes("games")) {
      if (emotionalState.includes('excited') || emotionalState.includes('happy')) {
        return `Playing sounds perfect with that excited energy I can see! You look ready for some fun activities.`;
      } else {
        return `Fun and games sound great for this ${timeOfDay}! I can see you're in the mood for some enjoyable activities.`;
      }
    } else if (symbols.includes("tired") || symbols.includes("rest") || symbols.includes("sleep")) {
      return `I can see that you might need some rest. This ${timeOfDay} is a good time to take things easy and recharge.`;
    } else if (symbols.includes("help") || symbols.includes("need") || symbols.includes("support")) {
      return `I'm absolutely here to help! Looking at your situation this ${timeOfDay}, whatever you need is important to me.`;
    } else if (symbols.includes("work") || symbols.includes("focus") || symbols.includes("type") || symbols.includes("computer")) {
      if (visualContext.includes('computer') || visualContext.includes('desk')) {
        return `I can see you're focused on your work at the computer! You look really concentrated and productive this ${timeOfDay}.`;
      } else {
        return `Work and focus - I can tell you're in that productive mindset this ${timeOfDay}. You look determined!`;
      }
    } else if (symbols.includes("outside") || symbols.includes("sun") || symbols.includes("walk") || symbols.includes("nature")) {
      return `Going outside sounds wonderful! This ${timeOfDay} looks perfect for enjoying some fresh air and movement.`;
    } else if (symbols.includes("yes") || symbols.includes("ok") || symbols.includes("agree")) {
      return `Great! I can see you're ready to go with whatever's happening this ${timeOfDay}. You look confident!`;
    } else if (symbols.includes("no") || symbols.includes("stop") || symbols.includes("different")) {
      return `That's completely okay! Sometimes this ${timeOfDay} calls for something different. What would feel better for you?`;
    } else if (symbols.includes("think") || symbols.includes("learn") || symbols.includes("read") || symbols.includes("write")) {
      return `I can see you're in a thoughtful mood this ${timeOfDay}! ${visualContext.includes('computer') ? 'Working at the computer seems to be going well.' : 'Learning and thinking are so important.'}`;
    } else if (symbols.includes("more") || symbols.includes("continue") || symbols.includes("again")) {
      return `More sounds great! I can see you're ready to keep going with whatever we're doing this ${timeOfDay}.`;
    } else if (symbols.includes("i") || symbols.includes("me") || symbols.includes("want")) {
      if (visualContext.includes('computer')) {
        return `I hear you! Being at the computer this ${timeOfDay}, you probably have specific things you want to accomplish.`;
      } else {
        return `I'm listening to what you want to share this ${timeOfDay}. You seem to have something on your mind.`;
      }
    } else {
      // Dynamic contextual fallback based on visual environment
      if (visualContext.includes('computer') || visualContext.includes('desk') || visualContext.includes('development') || visualContext.includes('coding')) {
        return `I see you mentioned "${userSymbols.join(" ")}" while working at your computer this ${timeOfDay}. You look focused and productive - tell me more about what you're working on!`;
      } else if (visualContext.includes('kitchen') || visualContext.includes('dining') || visualContext.includes('food')) {
        return `You're sharing "${userSymbols.join(" ")}" from what looks like the kitchen area. This ${timeOfDay} is perfect for whatever you're thinking about!`;
      } else if (visualContext.includes('outdoor') || visualContext.includes('outside') || visualContext.includes('park')) {
        return `Nice that you're mentioning "${userSymbols.join(" ")}" while being outside this ${timeOfDay}. The environment looks perfect for activities!`;
      } else {
        return `You're telling me about "${userSymbols.join(" ")}" this ${timeOfDay}. I can see you have something important to share - what's happening in your day?`;
      }
    }
  }
}

export function clearConversation(userId: string): void {
  activeConversations.delete(userId);
  console.log("Conversation cleared for user:", userId);
}

export function getActiveConversation(userId: string): ConversationState | undefined {
  return activeConversations.get(userId);
}