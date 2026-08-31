// server/services/providers/streaming-provider.ts
// Interface for providers that handle the streaming chat + tools path (interactive agent)

import type { DisclosureContext } from "../processorDisclosure";

/**
 * A single message in the chat format (matches OpenAI ChatCompletionMessageParam shape).
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | Array<{ type: string; [key: string]: any }>;
  /** Tool calls made by the assistant (present on assistant messages) */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /** ID of the tool call this message is responding to (present on tool messages) */
  toolCallId?: string;
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
  /** Gemini 2.5+ thinking-token budget (0 disables thinking). Thinking tokens
   *  count against maxTokens, so an unbounded default can starve a forced
   *  function call of output room (surfaces as MALFORMED_FUNCTION_CALL).
   *  Ignored by providers without a thinking knob. */
  thinkingBudget?: number;
  /** Gemini explicit-cache resource name (from ensurePromptCache). When set,
   *  the caller must OMIT system messages, tools, and toolChoice — they live
   *  in the cache and the API rejects a request that re-sends them. */
  cachedContent?: string;
  /** Abort signal — when triggered, the stream should stop as soon as possible */
  signal?: AbortSignal;
  /**
   * AKIM §18.5 — who this request's content is about, for the disclosure log.
   * The provider records the send; the ids ride on the request because a DTO
   * survives queue hops and generator boundaries that AsyncLocalStorage does
   * not. Omitted ⇒ the ambient `runWithDisclosureContext` is used; absent
   * both, the send is logged as `contextMissing` rather than dropped.
   */
  disclosure?: DisclosureContext;
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
    /** Prompt-cache read tokens (Anthropic cache_read_input_tokens), billed 0.1x. */
    cachedTokens?: number;
    /** Prompt-cache write tokens (Anthropic cache_creation_input_tokens), billed 1.25x. */
    cacheCreationTokens?: number;
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
  | { type: "done"; usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number; cacheCreationTokens?: number } };

/**
 * Provider that can do chat completions and streaming with tool support.
 */
export interface ChatProvider {
  completeChat(request: ChatRequest): Promise<ChatCompletionResult>;
  streamChat(request: ChatRequest): AsyncGenerator<StreamChunk>;
}
