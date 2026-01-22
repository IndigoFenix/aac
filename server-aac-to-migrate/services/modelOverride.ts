import OpenAI from "openai";
import { storage } from "../storage";

// Initialize OpenAI for ChatGPT-5 override
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

/**
 * Centralized model override service for ChatGPT-5
 * When a user enables ChatGPT-5, this service ensures all AI features use ChatGPT-5
 */
export class ModelOverrideService {
  private static instance: ModelOverrideService;
  private userSettings: Map<string, boolean> = new Map(); // Cache user settings

  static getInstance(): ModelOverrideService {
    if (!ModelOverrideService.instance) {
      ModelOverrideService.instance = new ModelOverrideService();
    }
    return ModelOverrideService.instance;
  }

  /**
   * Check if ChatGPT-5 is enabled for a user
   */
  async isChatGPT5Enabled(userId: string): Promise<boolean> {
    try {
      // Check cache first
      if (this.userSettings.has(userId)) {
        return this.userSettings.get(userId)!;
      }

      // Fetch from database
      const user = await storage.getUser(userId);
      const enabled = user?.chatgpt5Enabled || false;
      
      // Cache the result
      this.userSettings.set(userId, enabled);
      
      console.log(`ChatGPT-5 override for user ${userId}: ${enabled ? 'ENABLED' : 'DISABLED'}`);
      return enabled;
    } catch (error) {
      console.error("Error checking ChatGPT-5 setting:", error);
      return false;
    }
  }

  /**
   * Clear cached settings when user updates preferences
   */
  clearUserCache(userId: string): void {
    this.userSettings.delete(userId);
  }

  /**
   * Get the appropriate OpenAI model for ChatGPT-5 features
   */
  getChatGPT5Model(): string {
    return "gpt-4o"; // Using GPT-4o as the most advanced available model
  }

  /**
   * Generate text using ChatGPT-5 (OpenAI GPT-4o)
   */
  async generateChatGPT5Response(
    prompt: string,
    systemInstruction?: string,
    temperature: number = 1,
    maxTokens: number = 1000
  ): Promise<string> {
    try {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      
      if (systemInstruction) {
        messages.push({ role: "system", content: systemInstruction });
      }
      
      messages.push({ role: "user", content: prompt });

      const response = await openai.chat.completions.create({
        model: this.getChatGPT5Model(),
        messages,
        temperature,
        max_tokens: maxTokens,
      });

      return response.choices[0]?.message?.content || "";
    } catch (error) {
      console.error("ChatGPT-5 generation failed:", error);
      
      // Track error in session
      if ((global as any).currentSession) {
        const session = (global as any).currentSession as any;
        if (!session.aiServiceStats) session.aiServiceStats = {};
        if (!session.aiServiceStats.chatgpt5) {
          session.aiServiceStats.chatgpt5 = {
            calls: 0,
            errors: 0,
            tokens: 0,
            status: "active",
            lastUsed: new Date().toISOString()
          };
        }
        session.aiServiceStats.chatgpt5.errors++;
        session.aiServiceStats.chatgpt5.status = "quota_exceeded";
        session.aiServiceStats.chatgpt5.lastError = "Quota exceeded - falling back to Gemini";
        session.aiServiceStats.chatgpt5.lastUsed = new Date().toISOString();
      }
      
      throw new Error(`ChatGPT-5 generation failed: ${error}`);
    }
  }

  /**
   * Analyze image using ChatGPT-5 Vision
   */
  async analyzeChatGPT5Vision(
    imageBase64: string,
    prompt: string,
    systemInstruction?: string
  ): Promise<string> {
    try {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      
      if (systemInstruction) {
        messages.push({ role: "system", content: systemInstruction });
      }
      
      messages.push({
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${imageBase64}`,
              detail: "high"
            }
          }
        ]
      });

      const response = await openai.chat.completions.create({
        model: "gpt-4o", // GPT-4o has vision capabilities
        messages,
        temperature: 0.7,
        max_tokens: 1500,
      });

      return response.choices[0]?.message?.content || "";
    } catch (error) {
      console.error("ChatGPT-5 Vision analysis failed:", error);
      throw new Error(`ChatGPT-5 Vision analysis failed: ${error}`);
    }
  }

  /**
   * Generate structured JSON response using ChatGPT-5
   */
  async generateChatGPT5JSON(
    prompt: string,
    systemInstruction?: string,
    temperature: number = 0.7
  ): Promise<any> {
    try {
      const response = await this.generateChatGPT5Response(
        prompt + "\n\nRespond with valid JSON only, no additional text.",
        systemInstruction,
        temperature,
        2000
      );

      // Clean up response and parse JSON
      let cleanedResponse = response.trim();
      if (cleanedResponse.startsWith("```json")) {
        cleanedResponse = cleanedResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      }

      return JSON.parse(cleanedResponse);
    } catch (error) {
      console.error("ChatGPT-5 JSON generation failed:", error);
      throw new Error(`ChatGPT-5 JSON generation failed: ${error}`);
    }
  }
}

// Export singleton instance
export const modelOverrideService = ModelOverrideService.getInstance();

/**
 * Utility function to check if ChatGPT-5 should be used for a request
 * @param userId - User ID from session or request
 * @returns Promise<boolean> - true if ChatGPT-5 should be used
 */
export async function shouldUseChatGPT5(userId?: string): Promise<boolean> {
  if (!userId) return false;
  return modelOverrideService.isChatGPT5Enabled(userId);
}

/**
 * Wrapper function for ChatGPT-5 text generation with override check
 * @param userId - User ID
 * @param prompt - Text prompt
 * @param systemInstruction - System instruction
 * @param fallbackFunction - Function to call if ChatGPT-5 is not enabled
 * @returns Generated text
 */
export async function generateWithChatGPT5Override<T>(
  userId: string,
  prompt: string,
  systemInstruction: string,
  fallbackFunction: () => Promise<T>
): Promise<T | string> {
  const useChatGPT5 = await shouldUseChatGPT5(userId);
  
  if (useChatGPT5) {
    console.log(`🚀 Using ChatGPT-5 override for user ${userId}`);
    try {
      return await modelOverrideService.generateChatGPT5Response(prompt, systemInstruction);
    } catch (error) {
      console.error("ChatGPT-5 override failed, falling back to default model:", error);
      return fallbackFunction();
    }
  }
  
  return fallbackFunction();
}

/**
 * Wrapper function for ChatGPT-5 vision with override check
 * @param userId - User ID
 * @param imageBase64 - Base64 encoded image
 * @param prompt - Analysis prompt
 * @param systemInstruction - System instruction
 * @param fallbackFunction - Function to call if ChatGPT-5 is not enabled
 * @returns Analysis result
 */
export async function analyzeWithChatGPT5Override<T>(
  userId: string,
  imageBase64: string,
  prompt: string,
  systemInstruction: string,
  fallbackFunction: () => Promise<T>
): Promise<T | string> {
  const useChatGPT5 = await shouldUseChatGPT5(userId);
  
  if (useChatGPT5) {
    console.log(`🚀 Using ChatGPT-5 Vision override for user ${userId}`);
    try {
      return await modelOverrideService.analyzeChatGPT5Vision(imageBase64, prompt, systemInstruction);
    } catch (error) {
      console.error("ChatGPT-5 Vision override failed, falling back to default model:", error);
      return fallbackFunction();
    }
  }
  
  return fallbackFunction();
}