// ──────────────────────────────────────────────────────────────────────────────
// Imports
// ──────────────────────────────────────────────────────────────────────────────
import OpenAI from "openai";
import * as tiktoken from "js-tiktoken";

const { getEncoding, getEncodingNameForModel } = tiktoken as any;

const openAIConfiguration = {
  apiKey: process.env["OPENAI_API_KEY"],
};

// ──────────────────────────────────────────────────────────────────────────────
// RESPONSE TYPES
// ──────────────────────────────────────────────────────────────────────────────

export interface GPTResponse {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  content?: any;
  output?: any;
  toolCalls: GPTToolCall[];
  refused: boolean;
  searchCalls?: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// RESPONSES API INPUT ITEMS
// ──────────────────────────────────────────────────────────────────────────────

/** Message item for Responses API input */
export interface GPTMessageItem {
  type: "message";
  role: "user" | "assistant" | "system";
  content: string;
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
  openai: OpenAI;
  lastPrompt: string;
  promptTokens: number;
  completionTokens: number;
  model: string;

  constructor() {
    this.openai = new OpenAI(openAIConfiguration);
    this.lastPrompt = "";
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.model = "gpt-4o-mini";
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
   * Get a structured response from the Responses API
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
    const models = ["gpt-4o-mini", "gpt-4o-mini", "gpt-4o", "o3"];
    const model = models[intelligenceLevel];

    // Convert tools to Responses API format
    const rspTools = GPTToolsToRSP(tools);

    // Add web search tool if requested
    if (useSearch) {
      rspTools.push({
        type: "web_search_preview",
        search_context_size: ["low", "medium", "high"][searchContextSize - 1] as "low" | "medium" | "high",
      });
    }

    // Add file_search tool if vector store is provided
    if (vectorStoreId) {
      rspTools.push({
        type: "file_search",
        vector_store_ids: [vectorStoreId],
      });
      console.log(`[GPT] Added file_search tool with vector store: ${vectorStoreId}`);
    }

    const jsonSchemaFmt = {
      type: "json_schema",
      json_schema: { strict: true, name: schema_name, schema },
    };

    const rspParams: any = {
      model,
      instructions: instructionsText,
      input,
      max_output_tokens: max_tokens,
      tools: rspTools.length > 0 ? rspTools : undefined,
      text: {
        format: { ...jsonSchemaFmt.json_schema, type: jsonSchemaFmt.type },
      },
    };

    const response = await this.openai.responses.create(rspParams);

    return this.parseResponsesResult(response);
  }

  /**
   * Parse the Responses API result into our standard format
   */
  private parseResponsesResult(resp: any): GPTResponse {
    const outs = resp.output || [];
    const searchCalls = outs.filter((o: any) => o.type === "web_search_call");
    const lastMsg = [...outs]
      .reverse()
      .find((o: any) => o.type === "message" && o.role === "assistant");

    // Extract function calls in Responses API format
    const functionCalls: GPTFunctionToolCall[] = outs
      .filter((o: any) => o.type === "function_call")
      .map((fc: any) => ({
        type: "function_call" as const,
        call_id: fc.call_id,
        name: fc.name,
        arguments: fc.arguments,
      }));

    return {
      promptTokens: resp.usage?.input_tokens ?? 0,
      completionTokens: resp.usage?.output_tokens ?? 0,
      cachedTokens: resp.usage?.input_tokens_details?.cached_tokens ?? 0,
      output: outs,
      content: resp.output_text,
      toolCalls: functionCalls,
      refused: lastMsg?.refusal ?? false,
      searchCalls: searchCalls.length,
    };
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
