// server/services/providers/structured-provider.ts
// Interface for providers that handle the structured output path (Responses API pattern)

import type {
  GPTResponse,
  GPTInputItem,
  GPTTool,
  JSONSchema,
} from "../chat/gpt";

/**
 * Request for a structured LLM completion (used by clinician + AAC moderator paths).
 * Mirrors the parameters that gpt.ts passes to openai.responses.create().
 */
export interface StructuredRequest {
  model: string;
  input: GPTInputItem[];
  instructions?: string;
  schemaName: string;
  schema: JSONSchema;
  tools?: GPTTool[];
  maxTokens?: number;
  temperature?: number;
  useSearch?: boolean;
  searchContextSize?: 1 | 2 | 3;
  vectorStoreId?: string;
}

/**
 * Provider that can produce structured (JSON-schema-validated) outputs.
 */
export interface StructuredLLMProvider {
  structuredComplete(request: StructuredRequest): Promise<GPTResponse>;
}
