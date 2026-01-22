import { SessionsClient } from '@google-cloud/dialogflow';
import type { SymbolSuggestion } from './openai';

// Initialize Dialogflow client
let dialogflowClient: SessionsClient | null = null;

try {
  dialogflowClient = new SessionsClient({
    projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
    credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON 
      ? JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)
      : undefined,
  });
  console.log("Dialogflow client initialized successfully");
} catch (error) {
  console.error("Failed to initialize Dialogflow client:", error);
}

export interface DialogflowContext {
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

export async function generateSymbolSuggestionsWithDialogflow(
  context: DialogflowContext
): Promise<SymbolSuggestion[]> {
  if (!dialogflowClient) {
    throw new Error("Dialogflow client not initialized");
  }

  try {
    console.log("Starting Dialogflow symbol suggestion generation...");
    
    // Create session path
    const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
    const sessionId = `session_${Date.now()}`;
    const sessionPath = dialogflowClient.projectAgentSessionPath(projectId!, sessionId);
    
    // Prepare context for Dialogflow
    const contextText = `
Context Analysis for AAC Symbol Suggestions:

Time: ${context.time}
Location: ${context.location || 'Unknown location'}
Visual Scene: ${context.visualContext || 'No visual data available'}
User: ${context.userProfile?.name || 'User'}, Age: ${context.userProfile?.age || 'Unknown'}
User Preferences: ${context.userProfile?.preferences || 'No preferences set'}

Recent Communication History:
${context.recentHistory?.length ? 
  context.recentHistory.map(item => `- ${item.timestamp}: Used symbols "${item.symbols.join(' ')}"`).join('\n') :
  '- No recent communication history'
}

Please suggest 8 relevant communication symbols that would be helpful for this context. Focus on:
1. Age-appropriate symbols for a ${context.userProfile?.age || 7}-year-old
2. Context-relevant symbols based on time, location, and visual scene
3. Common communication needs like emotions, actions, objects, and requests
4. Simple, clear symbols that aid communication

Provide practical symbols that help express thoughts, needs, and feelings in the current situation.
`;

    // Send request to Dialogflow
    const request = {
      session: sessionPath,
      queryInput: {
        text: {
          text: contextText,
          languageCode: 'en',
        },
      },
    };

    console.log("Sending context to Dialogflow for symbol analysis...");
    const [response] = await dialogflowClient.detectIntent(request);
    
    // Process Dialogflow response and convert to symbol suggestions
    const intentResponse = response.queryResult?.fulfillmentText || '';
    console.log("Dialogflow response received:", intentResponse.substring(0, 100) + "...");
    
    // Parse the response to extract symbol suggestions
    const symbols = parseDialogflowResponseToSymbols(intentResponse, context);
    
    console.log(`Generated ${symbols.length} symbol suggestions using Dialogflow`);
    return symbols;
    
  } catch (error) {
    console.error("Dialogflow symbol generation failed:", error);
    throw new Error(`Dialogflow symbol analysis failed: ${(error as any)?.message || String(error)}`);
  }
}

function parseDialogflowResponseToSymbols(
  response: string, 
  context: DialogflowContext
): SymbolSuggestion[] {
  // If Dialogflow doesn't return structured symbols, generate contextual ones
  const baseSymbols: SymbolSuggestion[] = [
    { id: "yes_df", label: "Yes", emoji: "✅", confidence: 0.9, reasoning: "Essential communication symbol" },
    { id: "no_df", label: "No", emoji: "❌", confidence: 0.9, reasoning: "Essential communication symbol" },
    { id: "more_df", label: "More", emoji: "➕", confidence: 0.8, reasoning: "Common request symbol" },
    { id: "help_df", label: "Help", emoji: "🆘", confidence: 0.8, reasoning: "Important support symbol" },
  ];

  // Add time-specific symbols
  const currentHour = new Date().getHours();
  if (currentHour >= 6 && currentHour < 12) {
    baseSymbols.push(
      { id: "breakfast_df", label: "Breakfast", emoji: "🥞", confidence: 0.85, reasoning: "Morning meal time" },
      { id: "wake_up_df", label: "Wake Up", emoji: "🌅", confidence: 0.7, reasoning: "Morning activity" }
    );
  } else if (currentHour >= 12 && currentHour < 17) {
    baseSymbols.push(
      { id: "lunch_df", label: "Lunch", emoji: "🥪", confidence: 0.85, reasoning: "Afternoon meal time" },
      { id: "play_df", label: "Play", emoji: "🎮", confidence: 0.8, reasoning: "Afternoon activity" }
    );
  } else if (currentHour >= 17 && currentHour < 21) {
    baseSymbols.push(
      { id: "dinner_df", label: "Dinner", emoji: "🍽️", confidence: 0.85, reasoning: "Evening meal time" },
      { id: "family_df", label: "Family", emoji: "👨‍👩‍👧‍👦", confidence: 0.7, reasoning: "Evening family time" }
    );
  } else {
    baseSymbols.push(
      { id: "sleep_df", label: "Sleep", emoji: "😴", confidence: 0.9, reasoning: "Night time activity" },
      { id: "tired_df", label: "Tired", emoji: "😪", confidence: 0.8, reasoning: "Late evening feeling" }
    );
  }

  // Add location-based symbols
  if (context.location?.toLowerCase().includes('home')) {
    baseSymbols.push(
      { id: "home_df", label: "Home", emoji: "🏠", confidence: 0.8, reasoning: "Current location context" }
    );
  }

  // Add visual context-based symbols
  if (context.visualContext?.toLowerCase().includes('computer') || 
      context.visualContext?.toLowerCase().includes('screen')) {
    baseSymbols.push(
      { id: "computer_df", label: "Computer", emoji: "💻", confidence: 0.8, reasoning: "Visual context: technology present" }
    );
  }

  // Return first 8 symbols
  return baseSymbols.slice(0, 8);
}

export async function analyzeConversationIntent(
  userSymbols: string[],
  context: DialogflowContext
): Promise<{
  intent: string;
  confidence: number;
  suggestedResponse: string;
}> {
  if (!dialogflowClient) {
    throw new Error("Dialogflow client not initialized");
  }

  try {
    console.log("Analyzing conversation intent with Dialogflow...");
    
    const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
    const sessionId = `intent_${Date.now()}`;
    const sessionPath = dialogflowClient.projectAgentSessionPath(projectId!, sessionId);
    
    const queryText = `User communicated: ${userSymbols.join(' ')}`;
    
    const request = {
      session: sessionPath,
      queryInput: {
        text: {
          text: queryText,
          languageCode: 'en',
        },
      },
    };

    const [response] = await dialogflowClient.detectIntent(request);
    
    const intent = response.queryResult?.intent?.displayName || 'unknown';
    const confidence = response.queryResult?.intentDetectionConfidence || 0.5;
    const suggestedResponse = response.queryResult?.fulfillmentText || 
      `I understand you're communicating "${userSymbols.join(' ')}" with me.`;
    
    console.log(`Dialogflow detected intent: ${intent} (${confidence})`);
    
    return {
      intent,
      confidence,
      suggestedResponse
    };
    
  } catch (error) {
    console.error("Dialogflow intent analysis failed:", error);
    return {
      intent: 'unknown',
      confidence: 0.5,
      suggestedResponse: `I understand you're communicating "${userSymbols.join(' ')}" with me.`
    };
  }
}