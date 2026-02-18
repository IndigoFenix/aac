// server/services/providers/claude-structured.ts
// Claude implementation of StructuredLLMProvider
// Uses a forced tool-call pattern for structured output since Claude has no
// native json_schema response format.  A synthetic "_structured_response" tool
// whose input_schema is the desired output schema is always provided, and
// tool_choice is set to "any" so the model MUST call a tool on every turn.

import Anthropic from "@anthropic-ai/sdk";
import { resolveModelId } from "@shared/llm-options";
import type { StructuredLLMProvider, StructuredRequest } from "./structured-provider";
import type { GPTResponse, GPTFunctionToolCall, GPTInputItem } from "../chat/gpt";

/** Name of the synthetic tool used to enforce structured output. */
const STRUCTURED_TOOL_NAME = "_structured_response";

export class ClaudeStructuredProvider implements StructuredLLMProvider {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async structuredComplete(request: StructuredRequest): Promise<GPTResponse> {
    const model = resolveModelId("claude", request.model);

    // Build system prompt (no schema instructions needed — the tool enforces it)
    let systemPrompt = request.instructions || "";

    // Convert input items to Claude messages
    const { system: extraSystem, messages } = this.convertInputItems(request.input);
    if (extraSystem) {
      systemPrompt = extraSystem + "\n\n" + systemPrompt;
    }

    // Convert real tools to Claude format and append the structured output tool
    const tools = this.convertTools(request);
    tools.push({
      name: STRUCTURED_TOOL_NAME,
      description:
        "Return your final structured response. Call this tool when you are " +
        "ready to reply to the user (i.e. you have no more tool calls to make). " +
        "The input MUST conform to the output schema.",
      input_schema: request.schema,
    });

    const params: any = {
      model,
      system: systemPrompt
        ? [{ type: "text" as const, text: systemPrompt, cache_control: { type: "ephemeral" as const } }]
        : undefined,
      messages,
      max_tokens: request.maxTokens || 2048,
      temperature: request.temperature ?? 0.7,
      tools,
      // Force the model to call at least one tool on every turn.
      // It will call real tools when it needs to, and _structured_response
      // when it is ready to produce its final answer.
      tool_choice: { type: "any" as const },
    };

    const response = await this.client.messages.create(params);
    return this.parseResponse(response);
  }

  // ---------------------------------------------------------------------------
  // Input conversion
  // ---------------------------------------------------------------------------

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
        // Use Claude's native tool_use content block so the model
        // recognises prior tool calls and doesn't mimic them as text.
        let parsedInput: any = {};
        try { parsedInput = JSON.parse(item.arguments || "{}"); } catch {}
        messages.push({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: item.call_id,
              name: item.name,
              input: parsedInput,
            },
          ],
        });
      } else if (item.type === "function_call_output") {
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: item.call_id,
              content: item.output,
            },
          ],
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

  // ---------------------------------------------------------------------------
  // Tool conversion
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Response parsing
  // ---------------------------------------------------------------------------

  private parseResponse(response: any): GPTResponse {
    let textContent = "";
    let structuredContent = "";
    const functionCalls: GPTFunctionToolCall[] = [];

    for (const block of response.content || []) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "tool_use") {
        if (block.name === STRUCTURED_TOOL_NAME) {
          // This is the structured output — extract as content JSON
          structuredContent = JSON.stringify(block.input || {});
        } else {
          // Real tool call — pass through
          functionCalls.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          });
        }
      }
    }

    // If there are real tool calls, prioritise those (the structured response
    // will come on a subsequent turn after tool results are provided).
    // Otherwise, use the structured content as the response.
    const content = functionCalls.length > 0
      ? textContent
      : (structuredContent || textContent);

    return {
      promptTokens: response.usage?.input_tokens ?? 0,
      completionTokens: response.usage?.output_tokens ?? 0,
      cachedTokens: response.usage?.input_tokens_details?.cache_read_input_tokens ?? 0,
      content,
      output: response.content,
      toolCalls: functionCalls,
      refused: response.stop_reason === "end_turn" && !textContent && !structuredContent && functionCalls.length === 0,
      searchCalls: 0,
    };
  }
}
