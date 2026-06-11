// server/services/providers/gemini-structured.ts
// Gemini implementation of StructuredLLMProvider

import { GoogleGenAI } from "@google/genai";
import type { StructuredLLMProvider, StructuredRequest } from "./structured-provider";
import type { GPTResponse, GPTFunctionToolCall, GPTInputItem } from "../chat/gpt";

export class GeminiStructuredProvider implements StructuredLLMProvider {
  private client: GoogleGenAI;

  constructor() {
    this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
  }

  async structuredComplete(request: StructuredRequest): Promise<GPTResponse> {
    // Build Gemini contents from GPTInputItem[]
    const { systemInstruction, contents } = this.convertInputItems(
      request.input,
      request.instructions
    );

    // Build tool declarations
    const tools = this.convertTools(request);

    const config: any = {
      systemInstruction,
      temperature: request.temperature ?? 0.7,
      maxOutputTokens: request.maxTokens || 2048,
      // Only use JSON response format when a schema is provided.
      // When schema is undefined (e.g. md mode), the model returns plain text.
      ...(request.schema
        ? { responseMimeType: "application/json", responseSchema: this.cleanSchema(request.schema) }
        : {}),
    };

    if (tools.length > 0) {
      config.tools = [{ functionDeclarations: tools }];
    }

    const response = await this.client.models.generateContent({
      model: request.model,
      config,
      contents,
    });

    return this.parseResponse(response);
  }

  /**
   * Convert GPTInputItem[] to Gemini's contents format.
   * System messages become systemInstruction; user/assistant become contents.
   */
  private convertInputItems(
    items: GPTInputItem[],
    instructions?: string
  ): { systemInstruction: string; contents: any } {
    let systemParts: string[] = [];
    if (instructions) systemParts.push(instructions);

    const contents: Array<{ role: string; parts: any[] }> = [];

    for (const item of items) {
      if (item.type === "message") {
        if (item.role === "system") {
          const text = typeof item.content === "string"
            ? item.content
            : (item.content as any[]).map((p: any) => p.text || "").join("\n");
          systemParts.push(text);
        } else if (typeof item.content === "string") {
          contents.push({
            role: item.role === "assistant" ? "model" : "user",
            parts: [{ text: item.content }],
          });
        } else {
          // Multimodal content — convert input_image parts to Gemini's inlineData format
          const parts: any[] = [];
          for (const p of item.content as any[]) {
            if (p.type === "input_text" && p.text) {
              parts.push({ text: p.text });
            } else if (p.type === "input_image" && p.image_url) {
              const match = (p.image_url as string).match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
              }
            }
          }
          if (parts.length === 0) parts.push({ text: "" });
          contents.push({
            role: item.role === "assistant" ? "model" : "user",
            parts,
          });
        }
      } else if (item.type === "function_call") {
        // Represent as model turn with function call
        contents.push({
          role: "model",
          parts: [{ text: `[Tool call: ${item.name}(${item.arguments})]` }],
        });
      } else if (item.type === "function_call_output") {
        // Represent as user turn with tool result
        contents.push({
          role: "user",
          parts: [{ text: `[Tool result: ${item.output}]` }],
        });
      }
    }

    // Gemini needs at least one content entry
    if (contents.length === 0) {
      contents.push({ role: "user", parts: [{ text: "Respond." }] });
    }

    return {
      systemInstruction: systemParts.join("\n\n"),
      contents,
    };
  }

  /**
   * Convert GPTTool[] to Gemini functionDeclarations.
   */
  private convertTools(request: StructuredRequest): any[] {
    if (!request.tools) return [];
    return request.tools
      .filter((t) => t.type === "function")
      .map((t) => {
        if (t.type !== "function") return null;
        return {
          name: t.function.name,
          description: t.function.description || "",
          parameters: this.cleanSchema(t.function.parameters),
        };
      })
      .filter(Boolean);
  }

  /**
   * Remove additionalProperties and $ref from schema since Gemini doesn't support them.
   */
  private cleanSchema(schema: any): any {
    if (!schema || typeof schema !== "object") return schema;
    // Preserve arrays (required, enum, etc.) — recurse into elements
    if (Array.isArray(schema)) {
      return schema.map((item: any) => this.cleanSchema(item));
    }
    const cleaned: any = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === "additionalProperties" || key === "$ref") continue;
      // Gemini expects "type" to be a string, not an array like ["string"]
      if (key === "type" && Array.isArray(value)) {
        const filtered = value.filter((t: string) => t !== "null");
        cleaned[key] = filtered[0] || "string";
        continue;
      }
      if (typeof value === "object" && value !== null) {
        cleaned[key] = this.cleanSchema(value);
      } else {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }

  private parseResponse(response: any): GPTResponse {
    const text = response?.text || "";
    const usage = response?.usageMetadata;

    // Check for function calls in the response
    const functionCalls: GPTFunctionToolCall[] = [];
    const candidates = response?.candidates || [];
    for (const candidate of candidates) {
      const parts = candidate?.content?.parts || [];
      for (const part of parts) {
        if (part.functionCall) {
          functionCalls.push({
            type: "function_call",
            call_id: `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          });
        }
      }
    }

    return {
      promptTokens: usage?.promptTokenCount || 0,
      // Thinking tokens bill as output on Gemini 2.5
      completionTokens: (usage?.candidatesTokenCount || 0) + (usage?.thoughtsTokenCount || 0),
      cachedTokens: usage?.cachedContentTokenCount || 0,
      content: text,
      output: candidates,
      toolCalls: functionCalls,
      refused: false,
      searchCalls: 0,
    };
  }
}
