/**
 * Minimal LLM Provider Interface
 * 
 * Provides a unified abstraction over different LLM APIs.
 * Based on OpenAI's chat completions API structure.
 */

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  /**
   * Conversation messages
   */
  messages: Message[];

  /**
   * Response format configuration
   */
  responseFormat?: {
    type: "text" | "json_object";
    schema?: any; // JSON schema for structured output
  };

  /**
   * Generation parameters
   */
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];

  /**
   * Optional metadata for tracking
   */
  metadata?: {
    userId?: string;
    requestId?: string;
    [key: string]: any;
  };
}

export interface LLMResponse {
  /**
   * Generated content
   */
  content: string;

  /**
   * Token usage information
   */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };

  /**
   * Provider-specific metadata
   */
  metadata?: {
    model: string;
    provider: string;
    [key: string]: any;
  };
}

/**
 * Minimal LLM Provider Interface
 * 
 * Providers only handle API translation - no business logic.
 */
export interface LLMProvider {
  /**
   * Provider name for logging/debugging
   */
  readonly name: string;

  /**
   * Generate completion
   */
  complete(request: LLMRequest): Promise<LLMResponse>;
}