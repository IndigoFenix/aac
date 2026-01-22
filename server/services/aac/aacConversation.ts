import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { VertexAI } from "@google-cloud/vertexai";
import { generateChatAgentVoice, generateUserSymbolVoice } from "./voiceManager";
import type { ContextData } from "./aacTypes";
import { studentService } from "../studentService";
import { aacSessionService } from "./aacSessionService";
import { aacModelOverrideService, shouldUseChatGPT5ForStudent } from "./aacModelOverride";
import type { AACMessage } from "@shared/schema";

// Initialize OpenAI (for backup)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

// Initialize Gemini Pro for chat conversations (fallback)
const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

// Initialize Vertex AI for primary conversation agent (enterprise quotas)
let vertexAI: VertexAI | null = null;
try {
  if (process.env.GOOGLE_CLOUD_PROJECT_ID && process.env.GOOGLE_CLOUD_LOCATION) {
    vertexAI = new VertexAI({
      project: process.env.GOOGLE_CLOUD_PROJECT_ID,
      location: process.env.GOOGLE_CLOUD_LOCATION,
    });
  }
} catch (error) {
  console.log('Vertex AI not configured:', error);
}

export interface ConversationMessage {
  id: string;
  role: 'agent' | 'user';
  content: string;
  timestamp: Date;
  audioUrl?: string;
}

export interface ConversationState {
  studentId: string;
  messages: ConversationMessage[];
  currentTopic?: string;
  userProfile?: {
    name?: string;
    age?: number;
    interests?: string[];
    communicationLevel?: 'basic' | 'intermediate' | 'advanced';
  };
}

export async function startConversation(
  studentId: string,
  userProfile?: any,
  visualContext?: string,
  language: string = "en",
  emotionalContext?: string,
  audioContext?: any
): Promise<ConversationMessage> {
  console.log("Starting new conversation for student:", studentId);

  // Get student's custom chat agent prompt or demo scenario
  const student = await studentService.getStudentById(studentId);
  let customPrompt = student?.aacChatAgentPrompt || "You are a supportive, friendly AI assistant helping with communication. Speak like you're talking to a 7-year-old - use simple words, short sentences, and be encouraging. Make observations about what you see and the current situation, but don't ask open-ended questions. Focus on the here and now.";

  // Override with demo scenario if demo mode is enabled
  if (student?.aacDemoMode && student?.aacDemoScenario) {
    customPrompt = student.aacDemoScenario;
  }

  // Generate context-aware greeting
  const currentHour = new Date().getHours();
  let greeting = "";

  const userName = userProfile?.name ? userProfile.name : (student?.firstName || "");
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
Respond with just the comment text, no formatting.

Time-specific examples:
- Morning: "Good morning! I can see you in your room - looks like a great day to start!"
- Afternoon: "Good afternoon! I see you're at home - perfect time to have some fun!"
- Evening: "Good evening! It looks cozy where you are - nice way to end the day!"`;

      // Check if ChatGPT-5 override is enabled for greeting generation
      const useChatGPT5 = await shouldUseChatGPT5ForStudent(studentId);

      if (useChatGPT5) {
        console.log(`Using ChatGPT-5 override for greeting generation - Student ${studentId}`);
        try {
          const contextPrompt = `${conversationPrompt}

CURRENT CONTEXT:
Time: ${timeGreeting} (${timeOfDay})
User name: ${userName || 'friend'}
Visual scene: ${visualContext}
${emotionalContext ? `Emotional state: ${emotionalContext}` : ""}
${speechPresent && audioSpeech.trim().length > 0 ? `Family/Caregiver speech: "${audioSpeech}"` : ""}
Current location: Home`;

          greeting = await aacModelOverrideService.generateChatGPT5Response(
            contextPrompt,
            customPrompt,
            0.8,
            150
          ) || getDefaultGreeting(currentHour, userName, language);
        } catch (error) {
          console.error("ChatGPT-5 greeting generation failed, falling back to Gemini:", error);
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

  // Store message in session
  const aacMessage: AACMessage = {
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp.toISOString(),
    symbols: [],
  };
  await aacSessionService.addMessage(studentId, aacMessage);

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
  studentId: string,
  userSymbols: string[],
  context: ContextData,
  language: string = "en"
): Promise<ConversationMessage> {
  console.log("Generating agent response for symbols:", userSymbols);

  // Get student's custom chat agent prompt or demo scenario
  const student = await studentService.getStudentById(studentId);
  let customPrompt = student?.aacChatAgentPrompt || "You are a supportive, friendly AI assistant helping with communication. Speak like you're talking to a 7-year-old - use simple words, short sentences, and be encouraging. Make observations about what you see and the current situation, but don't ask open-ended questions. Focus on the here and now.";

  // Override with demo scenario if demo mode is enabled
  if (student?.aacDemoMode && student?.aacDemoScenario) {
    customPrompt = student.aacDemoScenario;
  }

  // Add user message to session
  const userMessage: AACMessage = {
    id: `msg_${Date.now()}_user`,
    role: 'user',
    content: userSymbols.join(" "),
    timestamp: new Date().toISOString(),
    symbols: userSymbols.map((label, index) => ({ id: `symbol_${index}`, label })),
  };
  await aacSessionService.addMessage(studentId, userMessage);

  // Get recent conversation history from session
  const recentMessages = await aacSessionService.getRecentMessages(studentId, 6);
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
- User: ${student?.firstName || 'Friend'}, Age: ${student ? studentService.calculateAge(student?.birthDate) || 'Unknown' : 'Unknown'}
- Emotional state: ${(context as any).emotionalContext || 'neutral/unknown'}
${audioContextDescription}

CONTEXT AWARENESS REQUIREMENTS:
Generate a response that follows your role instructions above and MUST:
1. Acknowledge what the user communicated with their symbols
2. Connect their message to what you can see in their current visual environment
3. Reference the current time of day naturally (this ${timeOfDay}, etc.)
4. Make observations about their current location/surroundings from the visual scene data
5. Respond empathetically to their current emotional state
6. ${speechPresent && audioSpeech.trim().length > 0 ? `IMPORTANT: Incorporate the family/caregiver speech ("${audioSpeech}") if it's relevant to the user's symbols` : 'No family/caregiver speech detected to incorporate'}
7. Be conversational, easy-going, and interesting while keeping it simple
8. Suggest logical next actions or symbols they might want to use based on the conversation
9. Be only 1-2 sentences long
10. Follow your behavior guidelines exactly

Respond with just the conversational text, no formatting.`;

  try {
    // Check if ChatGPT-5 override is enabled for conversation generation
    const useChatGPT5 = await shouldUseChatGPT5ForStudent(studentId);
    let agentResponse: string | undefined;

    if (useChatGPT5) {
      console.log(`Using ChatGPT-5 override for conversation generation - Student ${studentId}`);
      try {
        agentResponse = await aacModelOverrideService.generateChatGPT5Response(
          prompt,
          undefined,
          0.8,
          300
        );
        console.log("ChatGPT-5 response received:", agentResponse);
      } catch (error) {
        console.error("ChatGPT-5 conversation generation failed, falling back to Gemini:", error);
        console.log("Attempting Gemini API conversation generation...");
        const response = await gemini.models.generateContent({
          model: "gemini-2.5-flash",
          contents: prompt,
        });
        agentResponse = response.candidates?.[0]?.content?.parts?.[0]?.text;
        console.log("Gemini API response received:", agentResponse);
      }
    } else {
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

    // Store agent message in session
    const aacAgentMessage: AACMessage = {
      id: agentMessage.id,
      role: agentMessage.role,
      content: agentMessage.content,
      timestamp: agentMessage.timestamp.toISOString(),
      symbols: [],
    };
    await aacSessionService.addMessage(studentId, aacAgentMessage);

    console.log("Agent response generated successfully");
    return agentMessage;

  } catch (error) {
    console.error("Primary AI generation failed:", error);

    // Try Vertex AI as fallback if available
    if (vertexAI) {
      try {
        console.log("Attempting Vertex AI fallback conversation generation...");
        const model = vertexAI.getGenerativeModel({
          model: "gemini-2.5-flash",
          systemInstruction: customPrompt
        });

        const response = await model.generateContent(prompt);
        const agentResponse = response.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";

        if (agentResponse && agentResponse.trim().length > 0) {
          const agentMessage: ConversationMessage = {
            id: `msg_${Date.now()}_agent`,
            role: 'agent',
            content: agentResponse,
            timestamp: new Date(),
          };

          const aacAgentMessage: AACMessage = {
            id: agentMessage.id,
            role: agentMessage.role,
            content: agentMessage.content,
            timestamp: agentMessage.timestamp.toISOString(),
            symbols: [],
          };
          await aacSessionService.addMessage(studentId, aacAgentMessage);

          return agentMessage;
        }
      } catch (vertexError) {
        console.error("Vertex AI fallback failed:", vertexError);
      }
    }

    // Final fallback to OpenAI
    try {
      const fallbackResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: customPrompt
          },
          {
            role: "user",
            content: `User just communicated with symbols: ${userSymbols.join(" ")}. Please respond following the behavioral guidelines above.`
          }
        ],
        max_tokens: 150
      });

      const agentResponse = fallbackResponse.choices[0]?.message?.content || generateSmartFallback(userSymbols, context, language);

      const agentMessage: ConversationMessage = {
        id: `msg_${Date.now()}_agent`,
        role: 'agent',
        content: agentResponse,
        timestamp: new Date(),
      };

      const aacAgentMessage: AACMessage = {
        id: agentMessage.id,
        role: agentMessage.role,
        content: agentMessage.content,
        timestamp: agentMessage.timestamp.toISOString(),
        symbols: [],
      };
      await aacSessionService.addMessage(studentId, aacAgentMessage);

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

      const aacAgentMessage: AACMessage = {
        id: agentMessage.id,
        role: agentMessage.role,
        content: agentMessage.content,
        timestamp: agentMessage.timestamp.toISOString(),
        symbols: [],
      };
      await aacSessionService.addMessage(studentId, aacAgentMessage);

      return agentMessage;
    }
  }
}

export async function getConversationHistory(studentId: string): Promise<ConversationMessage[]> {
  const aacMessages = await aacSessionService.getConversationHistory(studentId);
  return aacMessages.map(m => ({
    id: m.id,
    role: m.role as 'agent' | 'user',
    content: m.content,
    timestamp: new Date(m.timestamp),
    audioUrl: m.audioUrl,
  }));
}

/**
 * Simplified chat function that accepts symbols and an optional image
 * The AI can see the current camera frame directly in its context
 */
export async function generateChatResponse(
  studentId: string,
  userSymbols: string[],
  imageBuffer?: Buffer,
  language: string = "en"
): Promise<ConversationMessage> {
  console.log("Generating chat response for symbols:", userSymbols, "with image:", !!imageBuffer);

  // Get student profile
  const student = await studentService.getStudentById(studentId);
  const studentAge = student ? studentService.calculateAge(student?.birthDate) : undefined;

  let customPrompt = student?.aacChatAgentPrompt ||
    "You are a supportive, friendly AI assistant helping with communication. Speak like you're talking to a 7-year-old - use simple words, short sentences, and be encouraging. Make observations about what you see and the current situation, but don't ask open-ended questions. Focus on the here and now.";

  // Override with demo scenario if enabled
  if (student?.aacDemoMode && student?.aacDemoScenario) {
    customPrompt = student.aacDemoScenario;
  }

  // Add user message to session
  const userMessage: AACMessage = {
    id: `msg_${Date.now()}_user`,
    role: 'user',
    content: userSymbols.join(" "),
    timestamp: new Date().toISOString(),
    symbols: userSymbols.map((label, index) => ({ id: `symbol_${index}`, label })),
  };
  await aacSessionService.addMessage(studentId, userMessage);

  // Get recent conversation history
  const recentMessages = await aacSessionService.getRecentMessages(studentId, 6);
  const conversationHistory = recentMessages.map(m =>
    `${m.role === 'agent' ? 'Agent' : 'User'}: ${m.content}`
  ).join('\n');

  const currentHour = new Date().getHours();
  const timeOfDay = currentHour >= 6 && currentHour < 12 ? "morning" :
                   currentHour >= 12 && currentHour < 17 ? "afternoon" :
                   currentHour >= 17 && currentHour < 21 ? "evening" : "night";

  const languageInstruction = language === "he"
    ? "IMPORTANT: השב בעברית בלבד. השתמש בביטויים עבריים טבעיים והתאם לגיל ילדים."
    : "Respond in English.";

  const textPrompt = `${languageInstruction}

ROLE AND BEHAVIOR:
${customPrompt}

CONVERSATION HISTORY:
${conversationHistory}

USER JUST COMMUNICATED WITH SYMBOLS: ${userSymbols.join(" ")}

CURRENT CONTEXT:
- Time: ${new Date().toLocaleTimeString()} (${timeOfDay})
- User: ${student?.firstName || 'Friend'}, Age: ${studentAge || 'Unknown'}
${imageBuffer ? '- You can see the current camera view in the attached image. Use what you see to make your response contextual and relevant.' : ''}

INSTRUCTIONS:
1. Acknowledge what the user communicated with their symbols
2. ${imageBuffer ? 'Reference what you can see in the image naturally' : 'Respond based on the conversation context'}
3. Be conversational, easy-going, and interesting while keeping it simple
4. Keep your response to 1-2 sentences
5. Don't ask open-ended questions

Respond with just the conversational text, no formatting.`;

  try {
    let agentResponse: string | undefined;

    if (imageBuffer) {
      // Use Gemini with multimodal input (text + image)
      console.log("Using multimodal Gemini with image...");
      const base64Image = imageBuffer.toString('base64');

      const response = await gemini.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              { text: textPrompt },
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: base64Image
                }
              }
            ]
          }
        ]
      });

      agentResponse = response.candidates?.[0]?.content?.parts?.[0]?.text;
    } else {
      // Text-only response
      console.log("Using text-only Gemini...");
      const response = await gemini.models.generateContent({
        model: "gemini-2.5-flash",
        contents: textPrompt,
      });
      agentResponse = response.candidates?.[0]?.content?.parts?.[0]?.text;
    }

    if (!agentResponse || agentResponse.trim().length === 0) {
      agentResponse = generateSmartFallback(userSymbols, {}, language);
    }

    const agentMessage: ConversationMessage = {
      id: `msg_${Date.now()}_agent`,
      role: 'agent',
      content: agentResponse,
      timestamp: new Date(),
    };

    // Store agent message in session
    const aacAgentMessage: AACMessage = {
      id: agentMessage.id,
      role: agentMessage.role,
      content: agentMessage.content,
      timestamp: agentMessage.timestamp.toISOString(),
      symbols: [],
    };
    await aacSessionService.addMessage(studentId, aacAgentMessage);

    console.log("Chat response generated:", agentResponse.substring(0, 100));
    return agentMessage;

  } catch (error) {
    console.error("Chat generation failed:", error);

    // Fallback response
    const fallbackResponse = generateSmartFallback(userSymbols, {}, language);
    const agentMessage: ConversationMessage = {
      id: `msg_${Date.now()}_agent`,
      role: 'agent',
      content: fallbackResponse,
      timestamp: new Date(),
    };

    const aacAgentMessage: AACMessage = {
      id: agentMessage.id,
      role: agentMessage.role,
      content: agentMessage.content,
      timestamp: agentMessage.timestamp.toISOString(),
      symbols: [],
    };
    await aacSessionService.addMessage(studentId, aacAgentMessage);

    return agentMessage;
  }
}

export async function generateMessageAudio(messageId: string, text: string, language: string = "en", userProfile?: any, isUserMessage: boolean = false): Promise<Buffer> {
  console.log("Generating audio for message:", messageId, "Language:", language, "isUserMessage:", isUserMessage);

  if (isUserMessage) {
    return await generateUserSymbolVoice(text, language, userProfile);
  } else {
    return await generateChatAgentVoice(text, language);
  }
}

// Smart fallback function when AI services fail
function generateSmartFallback(userSymbols: string[], context: any, language: string = "en"): string {
  const symbols = userSymbols.join(" ").toLowerCase();
  const currentHour = new Date().getHours();
  const timeOfDay = currentHour >= 17 ? "evening" : currentHour >= 12 ? "afternoon" : "morning";

  const visualContext = context?.visualContext?.toLowerCase() || '';
  const emotionalState = context?.emotionalContext?.toLowerCase() || '';

  if (language === "he") {
    if (symbols.includes("happy") || symbols.includes("good") || symbols.includes("שמח") || symbols.includes("טוב")) {
      return `נהדר! אני רואה שאתה מתחיל את ה${timeOfDay === "morning" ? "בוקר" : timeOfDay === "afternoon" ? "יום" : "ערב"} בטוב לב!`;
    } else if (symbols.includes("eat") || symbols.includes("food") || symbols.includes("hungry") || symbols.includes("אוכל") || symbols.includes("רעב")) {
      return `ארוחה נשמעת כמו רעיון מעולה! בזמן הזה של ה${timeOfDay === "morning" ? "בוקר" : timeOfDay === "afternoon" ? "יום" : "ערב"} בטח זמן לאכול משהו טוב.`;
    } else if (symbols.includes("play") || symbols.includes("fun") || symbols.includes("משחק") || symbols.includes("כיף")) {
      return `משחק זה תמיד רעיון נהדר! אני רואה שיש לך אנרגיה לבלות ולהנות.`;
    } else if (symbols.includes("help") || symbols.includes("עזרה") || symbols.includes("צריך")) {
      return `כמובן שאני כאן לעזור לך! מה שאתה צריך הוא החשוב ביותר.`;
    } else {
      return `אני רואה שאתה אומר לי "${userSymbols.join(" ")}". זה מעניין! מה עוד קורה כאן?`;
    }
  } else {
    if (symbols.includes("happy") || symbols.includes("good") || symbols.includes("smile") || symbols.includes("excited")) {
      return `That's wonderful! Your happy mood really brightens up this ${timeOfDay}!`;
    } else if (symbols.includes("eat") || symbols.includes("food") || symbols.includes("hungry") || symbols.includes("drink")) {
      return `${timeOfDay === "morning" ? "Breakfast" : timeOfDay === "afternoon" ? "Lunch" : "Dinner"} sounds perfect! What sounds good to you?`;
    } else if (symbols.includes("play") || symbols.includes("fun") || symbols.includes("games")) {
      return `Fun and games sound great for this ${timeOfDay}! You look ready for some enjoyable activities.`;
    } else if (symbols.includes("help") || symbols.includes("need") || symbols.includes("support")) {
      return `I'm absolutely here to help! Whatever you need is important to me.`;
    } else if (symbols.includes("yes") || symbols.includes("ok") || symbols.includes("agree")) {
      return `Great! I can see you're ready to go with whatever's happening this ${timeOfDay}!`;
    } else if (symbols.includes("no") || symbols.includes("stop") || symbols.includes("different")) {
      return `That's completely okay! Sometimes we need something different. What would feel better for you?`;
    } else {
      return `You're telling me about "${userSymbols.join(" ")}" this ${timeOfDay}. I can see you have something important to share!`;
    }
  }
}

export async function clearConversation(studentId: string): Promise<void> {
  await aacSessionService.clearConversation(studentId);
  console.log("Conversation cleared for student:", studentId);
}
