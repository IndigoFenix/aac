import OpenAI from "openai";
import { LLMProvider, LLMRequest, LLMResponse } from "../llmProvider";

/**
 * OpenAI Provider - Minimal API translation layer
 * 
 * Translates between our unified interface and OpenAI's API.
 * No business logic - just API calls.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = "OpenAI";
  private client: OpenAI;

  constructor(apiKey?: string) {
    this.client = new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY
    });
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    try {
      // OpenAI requires the word "json" in messages when using json_object mode
      let messages = request.messages;
      
      if (request.responseFormat?.type === "json_object") {
        // Ensure "json" appears in the system message
        messages = messages.map(msg => {
          if (msg.role === "system" && !msg.content.toLowerCase().includes("json")) {
            return {
              ...msg,
              content: msg.content + "\n\nRespond with valid JSON only."
            };
          }
          return msg;
        });
      }
      
      // Translate our format to OpenAI's format
      const completion = await this.client.chat.completions.create({
        model: "gpt-4o",
        messages: messages,
        temperature: request.temperature ?? 0.3,
        max_tokens: request.maxTokens,
        stop: request.stopSequences,
        response_format: request.responseFormat?.type === "json_object" 
          ? { type: "json_object" }
          : undefined
      });

      const choice = completion.choices[0];
      if (!choice?.message?.content) {
        throw new Error("No content in OpenAI response");
      }

      // Translate OpenAI's response to our format
      return {
        content: choice.message.content,
        usage: completion.usage ? {
          promptTokens: completion.usage.prompt_tokens,
          completionTokens: completion.usage.completion_tokens,
          totalTokens: completion.usage.total_tokens
        } : undefined,
        metadata: {
          model: completion.model,
          provider: "OpenAI",
          finishReason: choice.finish_reason
        }
      };
    } catch (error) {
      console.error("OpenAI completion failed:", error);
      throw error;
    }
  }
}