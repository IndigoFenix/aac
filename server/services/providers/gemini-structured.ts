// server/services/providers/gemini-structured.ts
// Gemini implementation of StructuredLLMProvider

import { GoogleGenAI } from "@google/genai";
import type { StructuredLLMProvider, StructuredRequest } from "./structured-provider";
import type { GPTResponse, GPTFunctionToolCall, GPTInputItem } from "../chat/gpt";
import { vertexClientOptions } from "./vertex-config";
import { getModelOption } from "@shared/llm-options";

export class GeminiStructuredProvider implements StructuredLLMProvider {
  /** Vertex client, when a GCP project is configured. */
  private vertexClient: GoogleGenAI | null;
  /** AI Studio key client. Built lazily — a Vertex-only deployment has no key
   *  and must not construct one just to leave it unused. */
  private keyClient: GoogleGenAI | null = null;
  /** True when a GCP project is configured at all. */
  readonly usingVertex: boolean;

  /**
   * Vertex WHEN IT IS CONFIGURED, the AI Studio key otherwise.
   *
   * 🚨 Note the difference from `GeminiChatProvider`, which takes Vertex as an
   * opt-in argument: here it is the DEFAULT. That asymmetry is deliberate and
   * is the lesson of the 2026-08-20 incident. Opt-in works when every caller
   * has session context to thread the flag through — the chat provider's do.
   * The structured provider's callers are mostly free functions with no session
   * at all (the caption services, the session summariser, the startup and
   * open-decision resolvers, the menu extraction and refinement passes), so an
   * opt-in flag would be forgotten exactly the way it was forgotten before, and
   * the forgetting is silent: the free key works fine until the day it does
   * not, and then a feature stops working for a reason that looks nothing like
   * a quota.
   *
   * Defaulting means a deployment with a project configured has ONE billing
   * path for Gemini, which is what `vertex-config` exists to guarantee.
   */
  constructor() {
    const vertex = vertexClientOptions();
    this.usingVertex = !!vertex;
    if (vertex) {
      console.log(
        `[GeminiStructured] Using Vertex AI (project=${vertex.project}, location=${vertex.location})`,
      );
      this.vertexClient = new GoogleGenAI(vertex);
    } else {
      // No project configured: a developer machine, or a deployment that is
      // missing its secrets. Say which, because the second case is broken
      // rather than merely local — see docs/INFRASTRUCTURE.md.
      console.warn(
        "[GeminiStructured] No GOOGLE_CLOUD_PROJECT_ID — using GEMINI_API_KEY (free tier).",
      );
      this.vertexClient = null;
    }
  }

  private keyed(): GoogleGenAI {
    if (!this.keyClient) {
      this.keyClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
    }
    return this.keyClient;
  }

  /**
   * Which client answers THIS request.
   *
   * Vertex whenever it is configured, EXCEPT for a model the registry says is
   * not published there — the same test the coordinator applies to the live
   * Board Manager. Today the only such Gemini model is live-only and cannot do
   * structured output, so this branch is unreachable; it is here because that
   * list changes, and a new preview model landing on the public API first would
   * otherwise fail as an opaque Vertex 404 rather than quietly working.
   */
  private clientFor(model: string): GoogleGenAI {
    if (!this.vertexClient) return this.keyed();
    const option = getModelOption("gemini", model);
    if (option && option.availableOnVertex === false) {
      if (!process.env.GEMINI_API_KEY) {
        console.warn(
          `[GeminiStructured] ${model} is not on Vertex and GEMINI_API_KEY is unset — the call will fail.`,
        );
      }
      return this.keyed();
    }
    return this.vertexClient;
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

    // Background work rides shared (pay-as-you-go) capacity, never a
    // Provisioned Throughput reservation. Only meaningful on Vertex; the AI
    // Studio endpoint ignores it, so it is safe to send either way.
    if (request.background && this.usingVertex) {
      config.httpOptions = {
        ...(config.httpOptions ?? {}),
        headers: {
          ...(config.httpOptions?.headers ?? {}),
          "X-Vertex-AI-LLM-Request-Type": "shared",
        },
      };
    }

    const response = await this.clientFor(request.model).models.generateContent({
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
