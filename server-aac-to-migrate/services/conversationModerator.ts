import { generateContextualSymbols } from "./contextualSymbols";

interface ConversationState {
  userId: string;
  lastResponse: string;
  responseCount: number;
  lastResponseTime: Date;
  visualContext: string;
  userProfile?: any;
}

// Store conversation states in memory (would be in database in production)
const conversationStates = new Map<string, ConversationState>();

/**
 * Enhanced conversation moderator that pushes for flowing dialogue
 * and provides contextually relevant responses
 */
export class ConversationModerator {
  
  static async moderateConversation(
    userId: string, 
    symbols: string[], 
    visualContext: string,
    userProfile?: any
  ): Promise<{ message: string; shouldContinue: boolean }> {
    
    const currentTime = new Date();
    let state = conversationStates.get(userId);
    
    if (!state) {
      state = {
        userId,
        lastResponse: "",
        responseCount: 0,
        lastResponseTime: currentTime,
        visualContext,
        userProfile
      };
      conversationStates.set(userId, state);
    }
    
    // Update state
    state.visualContext = visualContext;
    state.userProfile = userProfile;
    state.responseCount++;
    
    // Analyze symbol sequence to understand intent
    const symbolSequence = symbols.join(" ");
    const intent = this.analyzeUserIntent(symbolSequence, state);
    
    // Generate contextual response
    const response = await this.generateFlowingResponse(intent, state, visualContext);
    
    // Update last response
    state.lastResponse = response.message;
    state.lastResponseTime = currentTime;
    
    return response;
  }
  
  private static analyzeUserIntent(symbols: string, state: ConversationState): string {
    const lowerSymbols = symbols.toLowerCase();
    
    // Greeting patterns
    if (lowerSymbols.includes("hello") || lowerSymbols.includes("hi") || lowerSymbols.includes("good")) {
      return "greeting";
    }
    
    // Need/want patterns
    if (lowerSymbols.includes("want") || lowerSymbols.includes("need") || lowerSymbols.includes("like")) {
      return "desire";
    }
    
    // Action patterns
    if (lowerSymbols.includes("go") || lowerSymbols.includes("play") || lowerSymbols.includes("do")) {
      return "action";
    }
    
    // Feeling patterns
    if (lowerSymbols.includes("happy") || lowerSymbols.includes("sad") || lowerSymbols.includes("tired")) {
      return "emotion";
    }
    
    // Food patterns
    if (lowerSymbols.includes("eat") || lowerSymbols.includes("drink") || lowerSymbols.includes("hungry")) {
      return "food";
    }
    
    // Help patterns
    if (lowerSymbols.includes("help") || lowerSymbols.includes("please") || lowerSymbols.includes("need")) {
      return "assistance";
    }
    
    return "general";
  }
  
  private static async generateFlowingResponse(
    intent: string, 
    state: ConversationState, 
    visualContext: string
  ): Promise<{ message: string; shouldContinue: boolean }> {
    
    const timeOfDay = this.getTimeOfDay();
    const contextualPrompts = this.getContextualPrompts(visualContext);
    
    let message = "";
    let shouldContinue = true;
    
    switch (intent) {
      case "greeting":
        message = this.generateGreetingResponse(timeOfDay, contextualPrompts);
        break;
        
      case "desire":
        message = this.generateDesireResponse(contextualPrompts, state);
        break;
        
      case "action":
        message = this.generateActionResponse(contextualPrompts, visualContext);
        break;
        
      case "emotion":
        message = this.generateEmotionResponse(contextualPrompts);
        break;
        
      case "food":
        message = this.generateFoodResponse(timeOfDay, contextualPrompts);
        break;
        
      case "assistance":
        message = this.generateAssistanceResponse(contextualPrompts);
        break;
        
      default:
        message = this.generateGeneralResponse(contextualPrompts, state);
    }
    
    // Add follow-up question to keep conversation flowing
    if (state.responseCount % 3 === 0) {
      message += " " + this.generateFollowUpQuestion(intent, visualContext);
    }
    
    return { message, shouldContinue };
  }
  
  private static getTimeOfDay(): string {
    const hour = new Date().getHours();
    if (hour < 12) return "morning";
    if (hour < 17) return "afternoon";
    return "evening";
  }
  
  private static getContextualPrompts(visualContext: string): string[] {
    const prompts: string[] = [];
    const context = visualContext.toLowerCase();
    
    if (context.includes("computer") || context.includes("screen")) {
      prompts.push("I see you're at your computer");
    }
    if (context.includes("indoor") || context.includes("room")) {
      prompts.push("You're inside today");
    }
    if (context.includes("desk") || context.includes("workspace")) {
      prompts.push("You're at your workspace");
    }
    
    return prompts;
  }
  
  private static generateGreetingResponse(timeOfDay: string, context: string[]): string {
    const greetings = [
      `Good ${timeOfDay}! How are you feeling today?`,
      `Hello! Nice to see you this ${timeOfDay}.`,
      `Hi there! What's on your mind this ${timeOfDay}?`
    ];
    
    let response = greetings[Math.floor(Math.random() * greetings.length)];
    
    if (context.length > 0) {
      response += ` ${context[0]}.`;
    }
    
    return response;
  }
  
  private static generateDesireResponse(context: string[], state: ConversationState): string {
    const responses = [
      "That sounds interesting! Tell me more about what you'd like.",
      "I understand what you want. How can we make that happen?",
      "That's a great idea! What's the first step?"
    ];
    
    return responses[Math.floor(Math.random() * responses.length)];
  }
  
  private static generateActionResponse(context: string[], visualContext: string): string {
    const responses = [
      "That sounds like fun! What do you want to do first?",
      "I like that idea! How would you like to start?",
      "Great choice! Tell me more about your plan."
    ];
    
    return responses[Math.floor(Math.random() * responses.length)];
  }
  
  private static generateEmotionResponse(context: string[]): string {
    const responses = [
      "I can see how you're feeling. Would you like to talk about it?",
      "Thanks for sharing that with me. What's making you feel this way?",
      "I appreciate you telling me about your feelings. What would help?"
    ];
    
    return responses[Math.floor(Math.random() * responses.length)];
  }
  
  private static generateFoodResponse(timeOfDay: string, context: string[]): string {
    const responses = [
      `It's ${timeOfDay} - are you thinking about a meal or snack?`,
      "Food sounds good! What are you in the mood for?",
      "I understand you're thinking about food. What sounds tasty?"
    ];
    
    return responses[Math.floor(Math.random() * responses.length)];
  }
  
  private static generateAssistanceResponse(context: string[]): string {
    const responses = [
      "I'm here to help! What do you need assistance with?",
      "Of course I can help! What would you like me to do?",
      "I'd be happy to help you. What's the first thing we should work on?"
    ];
    
    return responses[Math.floor(Math.random() * responses.length)];
  }
  
  private static generateGeneralResponse(context: string[], state: ConversationState): string {
    const responses = [
      "That's interesting! Can you tell me more?",
      "I see what you're saying. What else is on your mind?",
      "Thanks for sharing that. What would you like to talk about next?"
    ];
    
    return responses[Math.floor(Math.random() * responses.length)];
  }
  
  private static generateFollowUpQuestion(intent: string, visualContext: string): string {
    const questions = [
      "What do you think about that?",
      "How does that make you feel?",
      "What would you like to do next?",
      "Is there anything else you'd like to share?",
      "What's the most important thing to you right now?"
    ];
    
    return questions[Math.floor(Math.random() * questions.length)];
  }
  
  static clearConversation(userId: string): void {
    conversationStates.delete(userId);
  }
  
  static getConversationState(userId: string): ConversationState | undefined {
    return conversationStates.get(userId);
  }
}