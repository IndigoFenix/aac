// server/services/providers/openai-chat.ts
// OpenAI implementation of ChatProvider (extracts logic from interactive-agent.ts)

import OpenAI from "openai";
import type {
  ChatProvider,
  ChatRequest,
  ChatCompletionResult,
  StreamChunk,
  ChatMessage,
} from "./streaming-provider";

export class OpenAIChatProvider implements ChatProvider {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  /**
   * Strip content part types that OpenAI Chat Completions doesn't support
   * (e.g. input_audio — only supported by Realtime API, not Chat Completions).
   */
  private sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((msg) => {
      if (!Array.isArray(msg.content)) return msg;
      const filtered = (msg.content as any[]).filter(
        (part: any) => part.type !== "input_audio"
      );
      // If all parts were stripped, convert to text-only
      if (filtered.length === 0) {
        return { ...msg, content: "" };
      }
      return { ...msg, content: filtered };
    });
  }

  async completeChat(request: ChatRequest): Promise<ChatCompletionResult> {
    const messages = this.sanitizeMessages(request.messages);
    const params: any = {
      model: request.model,
      messages: messages as any,
      max_tokens: request.maxTokens || 500,
      temperature: request.temperature ?? 0.7,
    };
    // Only include tools and tool_choice if tools are provided
    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools;
      params.tool_choice = request.toolChoice === "required" ? "required" : request.toolChoice || "auto";
    }
    const response = await this.openai.chat.completions.create(params);

    const message = response.choices[0]?.message;
    const finishReason = response.choices[0]?.finish_reason;
    console.log(`[OpenAIChat] Response: finish_reason=${finishReason}, content=${message?.content?.length || 0}chars, tool_calls=${message?.tool_calls?.length || 0}, completion_tokens=${response.usage?.completion_tokens}`);
    if (!message) {
      return { content: null, toolCalls: [] };
    }

    const toolCalls = (message.tool_calls || []).map((tc: any) => ({
      name: tc.function?.name || "",
      arguments: tc.function?.arguments || "",
    }));

    return {
      content: message.content || null,
      toolCalls,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
          }
        : undefined,
    };
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<StreamChunk> {
    const messages = this.sanitizeMessages(request.messages);
    const params: any = {
      model: request.model,
      messages: messages as any,
      max_tokens: request.maxTokens || 500,
      temperature: request.temperature ?? 0.7,
      stream: true as const,
      stream_options: { include_usage: true },
    };
    // Only include tools and tool_choice if tools are provided
    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools;
      params.tool_choice = request.toolChoice === "required" ? "required" : request.toolChoice || "auto";
    }
    const stream = await this.openai.chat.completions.create(params) as unknown as AsyncIterable<any>;

    let finalUsage: { promptTokens: number; completionTokens: number } | undefined;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (delta?.content) {
        yield { type: "text_delta", text: delta.content };
      }

      if (delta?.tool_calls) {
        for (const toolCall of delta.tool_calls) {
          yield {
            type: "tool_call_delta",
            index: toolCall.index ?? 0,
            name: toolCall.function?.name || undefined,
            arguments: toolCall.function?.arguments || undefined,
          };
        }
      }

      // Capture usage from the final chunk (sent when stream_options.include_usage is true)
      if (chunk.usage) {
        finalUsage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
        };
      }
    }

    yield { type: "done", usage: finalUsage };
  }
}
