// server/services/providers/claude-structured.ts
// Claude implementation of StructuredLLMProvider
// Claude doesn't have native json_schema — we include the schema in the system prompt and parse.

import Anthropic from "@anthropic-ai/sdk";
import { resolveModelId } from "@shared/llm-options";
import type { StructuredLLMProvider, StructuredRequest } from "./structured-provider";
import type { GPTResponse, GPTFunctionToolCall, GPTInputItem } from "../chat/gpt";

export class ClaudeStructuredProvider implements StructuredLLMProvider {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async structuredComplete(request: StructuredRequest): Promise<GPTResponse> {
    const model = resolveModelId("claude", request.model);

    // Build system prompt — include schema instruction since Claude has no native json_schema
    let systemPrompt = request.instructions || "";
    systemPrompt += `\n\nYou MUST respond with valid JSON matching this schema (name: "${request.schemaName}"):\n${JSON.stringify(request.schema, null, 2)}\n\nRespond ONLY with the JSON object, no other text.`;

    // Convert input items to Claude messages
    const { system: extraSystem, messages } = this.convertInputItems(request.input);
    if (extraSystem) {
      systemPrompt = extraSystem + "\n\n" + systemPrompt;
    }

    // Convert tools to Claude format
    const tools = this.convertTools(request);

    const params: any = {
      model,
      system: systemPrompt,
      messages,
      max_tokens: request.maxTokens || 2048,
      temperature: request.temperature ?? 0.7,
    };

    if (tools.length > 0) {
      params.tools = tools;
    }

    const response = await this.client.messages.create(params);
    return this.parseResponse(response);
  }

  private convertInputItems(items: GPTInputItem[]): {
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string | any[] }>;
  } {
    const systemParts: string[] = [];
    const messages: Array<{ role: "user" | "assistant"; content: string | any[] }> = [];

    for (const item of items) {
      if (item.type === "message") {
        if (item.role === "system") {
          const text = typeof item.content === "string"
            ? item.content
            : (item.content as any[]).map((p: any) => p.text || "").join("\n");
          systemParts.push(text);
        } else if (typeof item.content === "string") {
          messages.push({
            role: item.role as "user" | "assistant",
            content: item.content,
          });
        } else {
          // Multimodal content — convert input_image parts to Claude's native format
          const parts = (item.content as any[]);
          const hasImages = parts.some((p: any) => p.type === "input_image");
          if (hasImages) {
            const claudeParts: any[] = [];
            for (const p of parts) {
              if (p.type === "input_text" && p.text) {
                claudeParts.push({ type: "text", text: p.text });
              } else if (p.type === "input_image" && p.image_url) {
                // Parse data URL: "data:image/png;base64,AAAA..."
                const match = (p.image_url as string).match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                  claudeParts.push({
                    type: "image",
                    source: { type: "base64", media_type: match[1], data: match[2] },
                  });
                }
              }
            }
            messages.push({
              role: item.role as "user" | "assistant",
              content: claudeParts,
            });
          } else {
            messages.push({
              role: item.role as "user" | "assistant",
              content: parts.map((p: any) => p.text || "").join("\n"),
            });
          }
        }
      } else if (item.type === "function_call") {
        messages.push({
          role: "assistant",
          content: `[Tool call: ${item.name}(${item.arguments})]`,
        });
      } else if (item.type === "function_call_output") {
        messages.push({
          role: "user",
          content: `[Tool result: ${item.output}]`,
        });
      }
    }

    // Claude requires at least one user message
    if (messages.length === 0) {
      messages.push({ role: "user", content: "Respond." });
    }

    // Claude requires alternating user/assistant messages
    // Merge consecutive same-role messages
    const merged: Array<{ role: "user" | "assistant"; content: string | any[] }> = [];
    for (const msg of messages) {
      if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
        const prev = merged[merged.length - 1];
        // If either side is multimodal (array), merge as arrays
        if (Array.isArray(prev.content) || Array.isArray(msg.content)) {
          const prevParts = Array.isArray(prev.content) ? prev.content : [{ type: "text", text: prev.content }];
          const newParts = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
          prev.content = [...prevParts, ...newParts];
        } else {
          prev.content += "\n" + msg.content;
        }
      } else {
        merged.push({ ...msg });
      }
    }

    // Ensure first message is from user
    if (merged.length > 0 && merged[0].role === "assistant") {
      merged.unshift({ role: "user", content: "(conversation continued)" });
    }

    return { system: systemParts.join("\n\n"), messages: merged };
  }

  private convertTools(request: StructuredRequest): any[] {
    if (!request.tools) return [];
    return request.tools
      .filter((t) => t.type === "function")
      .map((t) => {
        if (t.type !== "function") return null;
        return {
          name: t.function.name,
          description: t.function.description || "",
          input_schema: t.function.parameters,
        };
      })
      .filter(Boolean);
  }

  private parseResponse(response: any): GPTResponse {
    let textContent = "";
    const functionCalls: GPTFunctionToolCall[] = [];

    for (const block of response.content || []) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "tool_use") {
        functionCalls.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        });
      }
    }

    return {
      promptTokens: response.usage?.input_tokens ?? 0,
      completionTokens: response.usage?.output_tokens ?? 0,
      cachedTokens: 0,
      content: textContent,
      output: response.content,
      toolCalls: functionCalls,
      refused: response.stop_reason === "end_turn" && !textContent && functionCalls.length === 0,
      searchCalls: 0,
    };
  }
}
