// server/services/providers/openai-structured.ts
// OpenAI implementation of StructuredLLMProvider (extracts logic from gpt.ts)

import OpenAI from "openai";
import type { StructuredLLMProvider, StructuredRequest } from "./structured-provider";
import type { GPTResponse, GPTFunctionToolCall } from "../chat/gpt";
import { GPTToolsToRSP } from "../chat/gpt";

export class OpenAIStructuredProvider implements StructuredLLMProvider {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async structuredComplete(request: StructuredRequest): Promise<GPTResponse> {
    // Convert tools to Responses API format
    const rspTools = request.tools ? GPTToolsToRSP(request.tools) : [];

    // Add web search tool if requested
    if (request.useSearch) {
      const sizes = ["low", "medium", "high"] as const;
      rspTools.push({
        type: "web_search_preview",
        search_context_size: sizes[(request.searchContextSize || 1) - 1],
      });
    }

    // Add file_search tool if vector store is provided
    if (request.vectorStoreId) {
      rspTools.push({
        type: "file_search",
        vector_store_ids: [request.vectorStoreId],
      });
    }

    const rspParams: any = {
      model: request.model,
      instructions: request.instructions,
      input: request.input,
      max_output_tokens: request.maxTokens || 150,
      tools: rspTools.length > 0 ? rspTools : undefined,
      text: request.schema
        ? {
            format: {
              type: "json_schema",
              strict: true,
              name: request.schemaName,
              schema: request.schema,
            },
          }
        : undefined,
    };

    const response = await this.openai.responses.create(rspParams);
    return this.parseResponsesResult(response);
  }

  private parseResponsesResult(resp: any): GPTResponse {
    const outs = resp.output || [];
    const searchCalls = outs.filter((o: any) => o.type === "web_search_call");
    const lastMsg = [...outs]
      .reverse()
      .find((o: any) => o.type === "message" && o.role === "assistant");

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
}
