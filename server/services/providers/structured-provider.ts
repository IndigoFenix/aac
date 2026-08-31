// server/services/providers/structured-provider.ts
// Interface for providers that handle the structured output path (Responses API pattern)

import type {
  GPTResponse,
  GPTInputItem,
  GPTTool,
  JSONSchema,
} from "../chat/gpt";
import type { DisclosureContext } from "../processorDisclosure";

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
  /**
   * This work is BACKGROUND: nobody is waiting on a screen for it.
   *
   * On Vertex it sends `X-Vertex-AI-LLM-Request-Type: shared`, which keeps the
   * call on pay-as-you-go and out of any Provisioned Throughput reservation.
   * The reservation exists for the live path — a child pressing a button and
   * waiting for a board — and a session summary or a menu extraction must never
   * consume capacity that a waiting child needs.
   *
   * It is also the honest label: these calls can be retried, delayed, or lost
   * without anyone noticing, which is exactly what shared capacity offers.
   */
  background?: boolean;
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
 * Provider that can produce structured (JSON-schema-validated) outputs.
 */
export interface StructuredLLMProvider {
  structuredComplete(request: StructuredRequest): Promise<GPTResponse>;
}
