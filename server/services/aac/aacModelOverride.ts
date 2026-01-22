import OpenAI from "openai";
import { studentService } from "../studentService";

// Initialize OpenAI for ChatGPT-5 override
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

/**
 * AAC Model Override Service
 * Centralized model override service for ChatGPT-5 for AAC students.
 * When a student has model override enabled, this service ensures all AI features use ChatGPT-5
 */
export class AACModelOverrideService {
  private static instance: AACModelOverrideService;
  private studentSettings: Map<string, boolean> = new Map(); // Cache student settings

  static getInstance(): AACModelOverrideService {
    if (!AACModelOverrideService.instance) {
      AACModelOverrideService.instance = new AACModelOverrideService();
    }
    return AACModelOverrideService.instance;
  }

  /**
   * Check if ChatGPT-5 is enabled for a student
   */
  async isChatGPT5Enabled(studentId: string): Promise<boolean> {
    try {
      // Check cache first
      if (this.studentSettings.has(studentId)) {
        return this.studentSettings.get(studentId)!;
      }

      // Fetch from database
      const student = await studentService.getStudentById(studentId);
      // Check if student has model override set to a ChatGPT model
      const enabled = student?.aacModelOverride?.includes('gpt') || false;

      // Cache the result
      this.studentSettings.set(studentId, enabled);

      console.log(`ChatGPT-5 override for student ${studentId}: ${enabled ? 'ENABLED' : 'DISABLED'}`);
      return enabled;
    } catch (error) {
      console.error("Error checking ChatGPT-5 setting:", error);
      return false;
    }
  }

  /**
   * Clear cached settings when student updates preferences
   */
  clearStudentCache(studentId: string): void {
    this.studentSettings.delete(studentId);
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
export const aacModelOverrideService = AACModelOverrideService.getInstance();

/**
 * Utility function to check if ChatGPT-5 should be used for a student
 * @param studentId - Student ID from session or request
 * @returns Promise<boolean> - true if ChatGPT-5 should be used
 */
export async function shouldUseChatGPT5ForStudent(studentId?: string): Promise<boolean> {
  if (!studentId) return false;
  return aacModelOverrideService.isChatGPT5Enabled(studentId);
}

/**
 * Wrapper function for ChatGPT-5 text generation with override check
 * @param studentId - Student ID
 * @param prompt - Text prompt
 * @param systemInstruction - System instruction
 * @param fallbackFunction - Function to call if ChatGPT-5 is not enabled
 * @returns Generated text
 */
export async function generateWithChatGPT5Override<T>(
  studentId: string,
  prompt: string,
  systemInstruction: string,
  fallbackFunction: () => Promise<T>
): Promise<T | string> {
  const useChatGPT5 = await shouldUseChatGPT5ForStudent(studentId);

  if (useChatGPT5) {
    console.log(`Using ChatGPT-5 override for student ${studentId}`);
    try {
      return await aacModelOverrideService.generateChatGPT5Response(prompt, systemInstruction);
    } catch (error) {
      console.error("ChatGPT-5 override failed, falling back to default model:", error);
      return fallbackFunction();
    }
  }

  return fallbackFunction();
}

/**
 * Wrapper function for ChatGPT-5 vision with override check
 * @param studentId - Student ID
 * @param imageBase64 - Base64 encoded image
 * @param prompt - Analysis prompt
 * @param systemInstruction - System instruction
 * @param fallbackFunction - Function to call if ChatGPT-5 is not enabled
 * @returns Analysis result
 */
export async function analyzeWithChatGPT5Override<T>(
  studentId: string,
  imageBase64: string,
  prompt: string,
  systemInstruction: string,
  fallbackFunction: () => Promise<T>
): Promise<T | string> {
  const useChatGPT5 = await shouldUseChatGPT5ForStudent(studentId);

  if (useChatGPT5) {
    console.log(`Using ChatGPT-5 Vision override for student ${studentId}`);
    try {
      return await aacModelOverrideService.analyzeChatGPT5Vision(imageBase64, prompt, systemInstruction);
    } catch (error) {
      console.error("ChatGPT-5 Vision override failed, falling back to default model:", error);
      return fallbackFunction();
    }
  }

  return fallbackFunction();
}
