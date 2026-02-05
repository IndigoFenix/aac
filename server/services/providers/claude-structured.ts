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
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  } {
    const systemParts: string[] = [];
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

    for (const item of items) {
      if (item.type === "message") {
        if (item.role === "system") {
          const text = typeof item.content === "string"
            ? item.content
            : (item.content as any[]).map((p: any) => p.text || "").join("\n");
          systemParts.push(text);
        } else {
          const text = typeof item.content === "string"
            ? item.content
            : (item.content as any[]).map((p: any) => p.text || "").join("\n");
          messages.push({
            role: item.role as "user" | "assistant",
            content: text,
          });
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
    const merged: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const msg of messages) {
      if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
        merged[merged.length - 1].content += "\n" + msg.content;
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
