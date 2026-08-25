// ──────────────────────────────────────────────────────────────────────────────
// Imports
// ──────────────────────────────────────────────────────────────────────────────
import * as tiktoken from "js-tiktoken";
import type { LLMProviderKey } from "@shared/llm-options";
import { getStructuredProvider } from "../providers/provider-factory";

const { getEncoding, getEncodingNameForModel } = tiktoken as any;

// ──────────────────────────────────────────────────────────────────────────────
// RESPONSE TYPES
// ──────────────────────────────────────────────────────────────────────────────

export interface GPTResponse {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /**
   * Tokens written to the prompt cache this turn (Anthropic
   * `cache_creation_input_tokens`). Billed at 1.25x base by Anthropic.
   * Omitted/0 for providers that don't report cache writes separately.
   */
  cacheCreationTokens?: number;
  content?: any;
  output?: any;
  toolCalls: GPTToolCall[];
  refused: boolean;
  searchCalls?: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// RESPONSES API INPUT ITEMS
// ──────────────────────────────────────────────────────────────────────────────

/** Content part for multimodal messages */
export interface GPTTextContentPart {
  type: "input_text";
  text: string;
}

export interface GPTImageContentPart {
  type: "input_image";
  image_url: string; // data:image/jpeg;base64,... or https://...
}

export interface GPTDocumentContentPart {
  type: "input_document";
  data_url: string; // data:application/pdf;base64,...
  filename: string;
}

export type GPTContentPart = GPTTextContentPart | GPTImageContentPart | GPTDocumentContentPart;

/** Message item for Responses API input */
export interface GPTMessageItem {
  type: "message";
  role: "user" | "assistant" | "system";
  content: string | GPTContentPart[];
}

/** Function call item for Responses API input (representing a previous tool call) */
export interface GPTFunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

/** Function call output item for Responses API input (representing a tool response) */
export interface GPTFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

/** Union of all input item types */
export type GPTInputItem = GPTMessageItem | GPTFunctionCallItem | GPTFunctionCallOutputItem;

// ──────────────────────────────────────────────────────────────────────────────
// JSON SCHEMA TYPE
// ──────────────────────────────────────────────────────────────────────────────

export type JSONSchema =
  | { $ref: string }
  | ({
      type?:
        | "string"
        | "number"
        | "integer"
        | "boolean"
        | "null"
        | "object"
        | "array"
        | (string & {});
      description?: string;
      enum?: (string | number | boolean | null)[];
      default?: unknown;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      minimum?: number;
      maximum?: number;
      properties?: Record<string, JSONSchema>;
      required?: string[];
      additionalProperties?: boolean | JSONSchema;
      items?: JSONSchema;
      minItems?: number;
      maxItems?: number;
    } & Record<string, unknown>);

// ──────────────────────────────────────────────────────────────────────────────
// TOOL DEFINITIONS (for sending to API)
// ──────────────────────────────────────────────────────────────────────────────

/** Function tool definition - Chat Completions format (converted for Responses API) */
export type GPTFunctionTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: JSONSchema & { type: "object" };
  };
};

export type GPTWebSearchTool = {
  type: "web_search_preview";
  search_context_size?: "low" | "medium" | "high";
};

export type GPTFileSearchTool = {
  type: "file_search";
  vector_store_ids: string[];
};

/** Union of tool definitions */
export type GPTTool = GPTFunctionTool | GPTWebSearchTool | GPTFileSearchTool;

// ──────────────────────────────────────────────────────────────────────────────
// TOOL CALLS (returned from API)
// ──────────────────────────────────────────────────────────────────────────────

/** Function tool call - Responses API format */
export interface GPTFunctionToolCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

/** Everything that can appear as a tool call in output */
export type GPTToolCall = GPTFunctionToolCall;

// ──────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Convert function tools from Chat Completions format to Responses API format
 */
export function GPTToolsToRSP(tools: GPTTool[]): any[] {
  return tools.map((t) => {
    if (t.type === "function") {
      return {
        type: "function",
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      };
    } else {
      return t;
    }
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// GPT CLASS
// ──────────────────────────────────────────────────────────────────────────────

export class GPT {
  lastPrompt: string;
  promptTokens: number;
  completionTokens: number;
  model: string;
  providerConfig?: { provider: LLMProviderKey; model: string; background?: boolean };

  /** `background: true` marks every call from this instance as work nobody is
   *  waiting on a screen for — see `StructuredRequest.background`. */
  constructor(providerConfig?: { provider: LLMProviderKey; model: string; background?: boolean }) {
    this.lastPrompt = "";
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.model = "gpt-4o-mini";
    this.providerConfig = providerConfig;
  }

  tokenCount(text: string) {
    const encodingName = getEncodingNameForModel(this.model);
    const enc = getEncoding(encodingName);
    return enc.encode(text).length;
  }

  resetTokens() {
    this.promptTokens = this.completionTokens = 0;
  }

  /**
   * Get a structured response, delegating to the appropriate provider
   */
  public async getStructuredResponse(
    input: GPTInputItem[],
    schema_name: string,
    schema: any,
    tools: GPTTool[] = [],
    max_tokens: number = 150,
    intelligenceLevel: 0 | 1 | 2 | 3 = 1,
    additionalParams: {
      temperature?: number;
      top_p?: number;
      frequency_penalty?: number;
      presence_penalty?: number;
    },
    useSearch: boolean = false,
    searchContextSize: 1 | 2 | 3 = 1,
    instructionsText: string | undefined = undefined,
    vectorStoreId: string | undefined = undefined
  ): Promise<GPTResponse> {
    const providerKey = this.providerConfig?.provider || "openai";
    const models = ["gpt-4o-mini", "gpt-4o-mini", "gpt-4o", "o3"];
    const model = this.providerConfig?.model || models[intelligenceLevel];

    const provider = getStructuredProvider(providerKey);
    return provider.structuredComplete({
      model,
      input,
      instructions: instructionsText,
      schemaName: schema_name,
      schema,
      tools: tools.length > 0 ? tools : undefined,
      maxTokens: max_tokens,
      temperature: additionalParams.temperature,
      useSearch,
      searchContextSize,
      vectorStoreId,
      ...(this.providerConfig?.background ? { background: true } : {}),
    });
  }

  /**
   * Convert markdown links in content to HTML anchors
   */
  public convertContent(content: string) {
    return content.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g,
      (_match, linkText, urlStr) => {
        try {
          const url = new URL(urlStr);
          url.searchParams.set("utm_source", "hello-computer");
          return `<a href="${url.toString()}">${linkText}</a>`;
        } catch {
          return _match;
        }
      }
    );
  }
}
