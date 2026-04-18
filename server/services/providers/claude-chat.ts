// server/services/providers/claude-chat.ts
// Claude implementation of ChatProvider

import { resolveModelId } from "@shared/llm-options";
import { getAnthropicClient } from "./anthropic-client";
import type {
  ChatProvider,
  ChatRequest,
  ChatCompletionResult,
  StreamChunk,
} from "./streaming-provider";

export class ClaudeChatProvider implements ChatProvider {
  private client = getAnthropicClient();

  async completeChat(request: ChatRequest): Promise<ChatCompletionResult> {
    const model = resolveModelId("claude", request.model);
    const { system, messages, tools, toolChoice } = this.buildRequest(request);

    const params: any = {
      model,
      system: system
        ? [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }]
        : undefined,
      messages,
      max_tokens: request.maxTokens || 500,
      temperature: request.temperature ?? 0.7,
    };

    if (tools.length > 0) {
      params.tools = tools;
      params.tool_choice = toolChoice;
    }

    const response = await this.client.messages.create(params);

    const cached = (response.usage as any)?.cache_read_input_tokens ?? 0;
    console.log(`[ClaudeChat] Response: stop_reason=${response.stop_reason}, blocks=${response.content?.length || 0}, output_tokens=${response.usage?.output_tokens}, cached_input=${cached}`);

    let content = "";
    const toolCalls: Array<{ name: string; arguments: string }> = [];

    for (const block of response.content || []) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        });
      }
    }

    return {
      content: content || null,
      toolCalls,
      usage: response.usage
        ? {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
          }
        : undefined,
    };
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<StreamChunk> {
    const model = resolveModelId("claude", request.model);
    const { system, messages, tools, toolChoice } = this.buildRequest(request);

    const params: any = {
      model,
      system: system
        ? [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }]
        : undefined,
      messages,
      max_tokens: request.maxTokens || 500,
      temperature: request.temperature ?? 0.7,
      stream: true,
    };

    if (tools.length > 0) {
      params.tools = tools;
      params.tool_choice = toolChoice;
    }

    const stream = this.client.messages.stream(params);

    let toolCallIndex = 0;
    // Track partial tool input JSON per block index
    const toolInputBuffers = new Map<number, { name: string; json: string }>();

    for await (const event of stream) {
      if (request.signal?.aborted) break;

      if (event.type === "content_block_start") {
        const block = (event as any).content_block;
        if (block?.type === "tool_use") {
          toolInputBuffers.set((event as any).index, { name: block.name, json: "" });
          yield {
            type: "tool_call_delta",
            index: toolCallIndex,
            name: block.name,
            arguments: undefined,
          };
        }
      } else if (event.type === "content_block_delta") {
        const delta = (event as any).delta;
        if (delta?.type === "text_delta" && delta.text) {
          yield { type: "text_delta", text: delta.text };
        } else if (delta?.type === "input_json_delta" && delta.partial_json) {
          const idx = (event as any).index;
          const buf = toolInputBuffers.get(idx);
          if (buf) {
            buf.json += delta.partial_json;
            yield {
              type: "tool_call_delta",
              index: toolCallIndex,
              name: undefined,
              arguments: delta.partial_json,
            };
          }
        }
      } else if (event.type === "content_block_stop") {
        const idx = (event as any).index;
        if (toolInputBuffers.has(idx)) {
          toolInputBuffers.delete(idx);
          toolCallIndex++;
        }
      }
    }

    // Get usage from the final aggregated message
    let finalUsage: { promptTokens: number; completionTokens: number } | undefined;
    try {
      const finalMessage = await stream.finalMessage();
      if (finalMessage.usage) {
        finalUsage = {
          promptTokens: finalMessage.usage.input_tokens,
          completionTokens: finalMessage.usage.output_tokens,
        };
      }
    } catch (e) {
      // Stream may already be consumed; usage is best-effort
    }

    yield { type: "done", usage: finalUsage };
  }

  private buildRequest(request: ChatRequest) {
    const systemParts: string[] = [];
    type ClaudeContent = string | Array<any>;
    const messages: Array<{ role: "user" | "assistant"; content: ClaudeContent }> = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        const text = typeof msg.content === "string"
          ? msg.content
          : (msg.content as any[]).map((p: any) => p.text || "").join("\n");
        systemParts.push(text);
      } else if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
        // Assistant message with tool use blocks
        const blocks: any[] = [];
        if (msg.content && typeof msg.content === "string") {
          blocks.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          let input: any = {};
          try { input = JSON.parse(tc.arguments); } catch {}
          blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
        }
        messages.push({ role: "assistant", content: blocks });
      } else if (msg.role === "tool" && msg.toolCallId) {
        // Tool result — Claude requires tool_result inside a user message
        const resultContent = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: msg.toolCallId, content: resultContent }],
        });
      } else if (typeof msg.content === "string") {
        messages.push({
          role: msg.role as "user" | "assistant",
          content: msg.content,
        });
      } else if (msg.content === null) {
        // Skip null-content messages
      } else {
        // Multi-part content (text + images)
        const blocks: any[] = [];
        for (const part of msg.content as any[]) {
          // Handle both OpenAI Chat ("text") and Responses API ("input_text") formats
          if ((part.type === "text" || part.type === "input_text") && part.text) {
            blocks.push({ type: "text", text: part.text });
          } else if (part.type === "input_image" && part.image_url) {
            const match = (part.image_url as string).match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              blocks.push({
                type: "image",
                source: { type: "base64", media_type: match[1] as any, data: match[2] },
              });
            }
          } else if (part.type === "image_url" && part.image_url?.url) {
            const url: string = part.image_url.url;
            if (url.startsWith("data:")) {
              const match = url.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                blocks.push({
                  type: "image",
                  source: { type: "base64", media_type: match[1] as any, data: match[2] },
                });
              }
            } else {
              blocks.push({ type: "text", text: `[Image: ${url}]` });
            }
          } else if (part.type === "input_document" && part.data_url) {
            const match = (part.data_url as string).match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              const mimeType = match[1];
              const base64Data = match[2];
              if (mimeType === "application/pdf") {
                blocks.push({
                  type: "document",
                  source: { type: "base64", media_type: "application/pdf", data: base64Data },
                });
              } else {
                const text = Buffer.from(base64Data, "base64").toString("utf-8");
                blocks.push({ type: "text", text: `--- ${part.filename || "file"} ---\n${text}\n---` });
              }
            }
          }
        }
        if (blocks.length > 0) {
          messages.push({
            role: msg.role as "user" | "assistant",
            content: blocks,
          });
        }
      }
    }

    // Merge consecutive same-role messages (Claude requires alternating)
    const merged: Array<{ role: "user" | "assistant"; content: ClaudeContent }> = [];
    for (const msg of messages) {
      if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
        const prev = merged[merged.length - 1];
        const prevBlocks = typeof prev.content === "string"
          ? [{ type: "text", text: prev.content }]
          : prev.content;
        const currBlocks = typeof msg.content === "string"
          ? [{ type: "text", text: msg.content }]
          : msg.content;
        prev.content = [...prevBlocks, ...currBlocks];
      } else {
        merged.push({ ...msg });
      }
    }

    // Ensure first message is from user
    if (merged.length === 0 || merged[0].role === "assistant") {
      merged.unshift({ role: "user", content: "(conversation continued)" });
    }

    // Convert tools
    const tools = (request.tools || []).map((t) => ({
      name: t.function.name,
      description: t.function.description || "",
      input_schema: t.function.parameters,
    }));

    // Map tool choice
    let toolChoice: any = { type: "auto" };
    if (request.toolChoice === "required") {
      toolChoice = { type: "any" };
    } else if (request.toolChoice === "none") {
      toolChoice = { type: "none" };
    }

    return {
      system: systemParts.join("\n\n"),
      messages: merged,
      tools,
      toolChoice,
    };
  }
}
