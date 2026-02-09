// server/services/providers/streaming-provider.ts
// Interface for providers that handle the streaming chat + tools path (interactive agent)

/**
 * A single message in the chat format (matches OpenAI ChatCompletionMessageParam shape).
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: string; [key: string]: any }>;
}

/**
 * Tool definition in OpenAI function-calling format.
 */
export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, any>;
  };
}

/**
 * Non-streaming chat request.
 */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  toolChoice?: "auto" | "required" | "none";
  maxTokens?: number;
  temperature?: number;
}

/**
 * Result of a non-streaming chat completion.
 */
export interface ChatCompletionResult {
  content: string | null;
  toolCalls: Array<{
    name: string;
    arguments: string;
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
  /** Provider-specific finish reason (e.g. "STOP", "MAX_TOKENS", "SAFETY", "RECITATION") */
  finishReason?: string;
}

/**
 * A chunk yielded during streaming.
 */
export type StreamChunk =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_delta"; index: number; name?: string; arguments?: string }
  | { type: "done"; usage?: { promptTokens: number; completionTokens: number } };

/**
 * Provider that can do chat completions and streaming with tool support.
 */
export interface ChatProvider {
  completeChat(request: ChatRequest): Promise<ChatCompletionResult>;
  streamChat(request: ChatRequest): AsyncGenerator<StreamChunk>;
}
