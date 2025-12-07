import { GoogleGenAI } from "@google/genai";
import { LLMProvider, LLMRequest, LLMResponse } from "../llmProvider";

/**
 * Gemini Provider - Minimal API translation layer
 * 
 * Translates between our unified interface and Gemini's API.
 * Uses Gemini's closest analogues to OpenAI's features.
 * No business logic - just API calls.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = "Gemini";
  private client: GoogleGenAI;

  constructor(apiKey?: string) {
    this.client = new GoogleGenAI({
      apiKey: apiKey || process.env.GEMINI_API_KEY || ""
    });
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    try {
      // Extract system message (Gemini uses systemInstruction)
      const systemMessage = request.messages.find(m => m.role === "system");
      const conversationMessages = request.messages.filter(m => m.role !== "system");

      // Build Gemini request config
      const config: any = {
        systemInstruction: systemMessage?.content,
        temperature: request.temperature ?? 0.1, // Lower for Gemini to prevent repetition
        maxOutputTokens: request.maxTokens || 2048
      };

      // Add JSON mode if requested
      if (request.responseFormat?.type === "json_object") {
        config.responseMimeType = "application/json";
        
        // Add schema if provided
        if (request.responseFormat.schema) {
          config.responseSchema = request.responseFormat.schema;
        }
      }

      // Add stop sequences if provided
      if (request.stopSequences && request.stopSequences.length > 0) {
        config.stopSequences = request.stopSequences;
      }

      // Gemini uses a different format for conversation
      // Last user message becomes the prompt
      const lastUserMessage = conversationMessages
        .filter(m => m.role === "user")
        .pop();

      if (!lastUserMessage) {
        throw new Error("No user message found in request");
      }

      // Make the API call
      const requestData = {
        model: "gemini-2.5-flash",
        config,
        contents: lastUserMessage.content
      };

      const response = await this.client.models.generateContent(requestData);
      const text = (response as any).text;

      if (!text) {
        throw new Error("No content in Gemini response");
      }

      // Translate Gemini's response to our format
      return {
        content: text,
        usage: this.extractUsage(response),
        metadata: {
          model: "gemini-2.5-flash",
          provider: "Gemini"
        }
      };
    } catch (error) {
      console.error("Gemini completion failed:", error);
      throw error;
    }
  }

  private extractUsage(response: any): { promptTokens: number; completionTokens: number; totalTokens: number } | undefined {
    // Gemini may include usage metadata
    const usageMetadata = response?.usageMetadata;
    if (usageMetadata) {
      return {
        promptTokens: usageMetadata.promptTokenCount || 0,
        completionTokens: usageMetadata.candidatesTokenCount || 0,
        totalTokens: usageMetadata.totalTokenCount || 0
      };
    }
    return undefined;
  }
}