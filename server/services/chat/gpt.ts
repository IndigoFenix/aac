// ──────────────────────────────────────────────────────────────────────────────
// Imports
// ──────────────────────────────────────────────────────────────────────────────
import OpenAI from "openai";
import * as tiktoken from "js-tiktoken";

// If your js-tiktoken typings are behind, this keeps TS happy while
// preserving the runtime behavior you had with require().
const { getEncoding, getEncodingNameForModel } = tiktoken as any;

const openAIConfiguration = {
  apiKey: process.env["OPENAI_API_KEY"],
};

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

export interface GPTMessage {
  role: "user" | "assistant" | "system" | "tool";
  content?: string;
  tool_call_id?: string; // for tool calls, the ID of the tool being called
  tool_calls?: GPTToolCall[]; // for tool messages, the tool calls made by the assistant
  metadata?: { [key: string]: any };
}

// ──────────────────────────────────────────────────────────────────────────────
//  ░░  Utility:  Draft-07 JSON-Schema (pruned to what the tool API supports)  ░░
// ──────────────────────────────────────────────────────────────────────────────
export type JSONSchema =
  | { $ref: string }
  | ({

      // core
      type?:
        | "string"
        | "number"
        | "integer"
        | "boolean"
        | "null"
        | "object"
        | "array"
        | (string & {}); // future-proof
      description?: string;
      enum?: (string | number | boolean | null)[];
      default?: unknown;

      // strings
      minLength?: number;
      maxLength?: number;
      pattern?: string;

      // numbers
      minimum?: number;
      maximum?: number;

      // objects
      properties?: Record<string, JSONSchema>;
      required?: string[];
      additionalProperties?: boolean | JSONSchema;

      // arrays
      items?: JSONSchema;
      minItems?: number;
      maxItems?: number;
    } & Record<string, unknown>); // allow extra non-standard keywords

// ──────────────────────────────────────────────────────────────────────────────
//  ░░  1.  TOOLS SENT *TO* THE COMPLETIONS ENDPOINT                            ░░
// ──────────────────────────────────────────────────────────────────────────────
export type GPTFunctionTool = {
  /** Fixed discriminator */
  type: "function";
  /** Call signature the model should respect */
  function: {
    name: string; // ≤64 chars, a JS identifier
    description?: string; // counts toward prompt tokens
    parameters: JSONSchema & { type: "object" }; // root *must* be object
  };
};

export type GPTCodeInterpreterTool = {
  type: "code_interpreter";
  /** Currently no extra properties are allowed, but we keep it open */
  code_interpreter?: Record<string, never>;
};

export type GPTRetrievalTool = {
  type: "retrieval";
  retrieval?: Record<string, never>;
};

export type GPTWebSearchTool = {
  type: "web_search_preview";
  search_context_size?: "low" | "medium" | "high"; // default: low
};

/** Union of everything allowed in the `tools` array */
export type GPTTool =
  | GPTFunctionTool
  | GPTCodeInterpreterTool
  | GPTRetrievalTool
  | GPTWebSearchTool;

// ──────────────────────────────────────────────────────────────────────────────
//  ░░  2.  TOOL-CALL OBJECTS RETURNED BY THE MODEL (message.tool_calls)        ░░
// ──────────────────────────────────────────────────────────────────────────────
export interface GPTFunctionToolCall {
  id: string; // “call_…” unique within the chat session
  type: "function";
  function: {
    name: string; // must match a declared tool
    /** Raw JSON string produced by the model */
    arguments: string;
  };
}

export interface GPTCodeInterpreterToolCall {
  id: string;
  type: "code_interpreter";
  code_interpreter: {
    /** Python code the model wants to run */
    code: string;
    /** Optional files referenced/created during execution */
    files?: {
      id: string; // file IDs in the OpenAI file store
      purpose?: string; // e.g. "input", "output", "plot"
    }[];
  };
}

/** Retrieval calls contain no arguments today */
export interface GPTRetrievalToolCall {
  id: string;
  type: "retrieval";
  retrieval?: Record<string, never>;
}

/** Everything that can appear in `message.tool_calls` */
export type GPTToolCall =
  | GPTFunctionToolCall
  | GPTCodeInterpreterToolCall
  | GPTRetrievalToolCall;

export function GPTToolsToRSP(tools: GPTTool[]) {
  return tools.map((t) => {
    if (t.type === "function") {
      return {
        type: t.type,
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      };
    } else {
      return t;
    }
  });
}

export class GPT {
  // IMPORTANT: this is now an *instance* type, not typeof OpenAI
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

  public async getStructuredResponse(
    messages: GPTMessage[],
    schema_name: string,
    schema: any,
    tools: GPTTool[] = [],
    max_tokens: number = 150,
    intelligenceLevel: 0 | 1 | 2 | 3 = 1,
    additionalParams: {
      temperature?: number; // Randomness
      top_p?: number;
      frequency_penalty?: number; // Higher values make the model less likely to repeat
      presence_penalty?: number; // Higher values make the model more likely to talk about things that have not been mentioned before
    },
    useSearch: boolean = false,
    searchContextSize: 1 | 2 | 3 = 1,
    useResponsesAPI: boolean = false,
    instructionsText: string | undefined = undefined
  ): Promise<GPTResponse> {
    const chatModels = ["gpt-4o-mini", "gpt-4o-mini", "gpt-4o", "o3"];
    const searchModels = [
      "gpt-4o-mini-search-preview",
      "gpt-4o-mini-search-preview",
      "gpt-4o-search-preview",
      "o3",
    ]; // o3-pro has no search SKU
    const model =
      useSearch && !useResponsesAPI
        ? searchModels[intelligenceLevel]
        : chatModels[intelligenceLevel];

    /* ------------------------------------------------------------------ */
    // Shared params for both endpoints
    const jsonSchemaFmt = {
      type: "json_schema",
      json_schema: { strict: true, name: schema_name, schema },
    };

    if (!useResponsesAPI) {
      /* =========  path A : classic chat.completions  ========= */
      const messagesNoMeta = messages.map((m: any) => {
        const { metadata, ...rest } = m;
        return rest;
      });
      const params: any = {
        model,
        messages: messagesNoMeta,
        max_tokens,
        response_format: jsonSchemaFmt,
        tools,
      };
      for (let k in additionalParams)
        params[k] = additionalParams[k as keyof typeof additionalParams];

      if (useSearch) {
        params["web_search_options"] = {
          search_context_size:
            searchContextSize == 1
              ? "low"
              : searchContextSize == 2
              ? "medium"
              : searchContextSize == 3
              ? "high"
              : "low",
        };
      }

      console.log(params);

      // In chat-completions we still need a separate SKU for search
      const completion = await this.openai.chat.completions.create(params);

      return this.parseChatResult(completion);
    } else {
      /* =========  path B : Responses API  ========= */
      // Attach the built–in search tool when requested
      const rspTools = GPTToolsToRSP(tools);
      if (useSearch) {
        rspTools.push({
          type: "web_search_preview",
          search_context_size: ["low", "medium", "high"][
            searchContextSize - 1
          ] as "low" | "medium" | "high",
        });
      }

      const rspParams: any = {
        model,
        instructions: instructionsText,
        input: messages,
        max_output_tokens: max_tokens,
        tools: rspTools,
        text: {
          format: { ...jsonSchemaFmt.json_schema, type: jsonSchemaFmt.type },
        },
      };

      const response = await this.openai.responses.create(rspParams);

      return this.parseResponsesResult(response);
    }
  }

  /* -------------- helpers to normalise the two return shapes ---------- */

  private parseChatResult(comp: any): GPTResponse {
    const m = comp.choices[0].message;
    const refused = !!m.refusal;
    return {
      promptTokens: comp.usage.prompt_tokens,
      completionTokens: comp.usage.completion_tokens,
      cachedTokens: m?.prompt_tokens_details?.cached_tokens ?? 0,
      content: m.content?.trim(),
      toolCalls: m.tool_calls ?? [],
      refused: refused,
      // For chat completions + search-preview: at most ONE surcharge
      searchCalls:
        m.tool_calls?.filter((c: any) => c.type === "web_search_preview")
          .length ?? 0,
    };
  }

  private parseResponsesResult(resp: any): GPTResponse {
    // Responses API returns an 'output' array  (assistant responses + tool calls)
    const outs = resp.output;
    const searchCalls = outs.filter((o: any) => o.type === "web_search_call");
    const lastMsg = outs
      .reverse()
      .find((o: any) => o.type === "assistant_response");

    return {
      promptTokens: resp.usage.prompt_tokens,
      completionTokens: resp.usage.completion_tokens,
      cachedTokens: resp.usage.cached_tokens ?? 0,
      output: outs,
      content: resp.output_text, //lastMsg?.content?.trim(),
      toolCalls: resp.output.filter(
        (o: any) => o.type === "function_call"
      ) as any,
      refused: lastMsg?.refusal ?? false,
      searchCalls: searchCalls.length,
    };
  }

  public convertContent(content: string) {
    return content.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g,
      (_match, linkText, urlStr) => {
        try {
          const url = new URL(urlStr);
          // overwrite or add utm_source
          url.searchParams.set("utm_source", "hello-computer");
          return `<a href="${url.toString()}">${linkText}</a>`;
        } catch {
          // if URL parsing fails, leave the original markdown
          return _match;
        }
      }
    );
  }
}
