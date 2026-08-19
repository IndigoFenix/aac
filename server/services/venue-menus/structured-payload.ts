// server/services/venue-menus/structured-payload.ts
//
// Getting the JSON payload back out of a `structuredComplete()` response.
//
// WHY THIS EXISTS: the venue-menu services are the only callers that talk to
// `StructuredLLMProvider` directly rather than through `chat/gpt.ts`, and the
// providers do not agree on where the payload lands:
//
//   ClaudeStructuredProvider — forces a tool call named STRUCTURED_TOOL_NAME and
//     returns `content` as a JSON STRING (`JSON.stringify(block.input)`).
//     `output` is the raw Anthropic block array, and Anthropic's block type is
//     `tool_use`, not `function_call`.
//   GeminiStructuredProvider — returns `content` as the model's raw text.
//   Real tool calls (a schema used as a genuine tool) arrive normalised in
//     `toolCalls[].arguments`, always a JSON string.
//
// Reading the wrong field does not throw — it yields nothing, and both callers
// are built to fail open on nothing. That is the dangerous shape: a camera
// capture would report every frame as unreadable and a refinement pass would
// silently classify nothing, both looking like ordinary bad luck. One helper,
// covered by tests, instead of that failure mode twice.

/** Strip a ```json fence a model wrapped its answer in. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const body = stripFence(text);
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The structured object a provider returned, or null if there is not one.
 *
 * Tries every shape a provider in this codebase can produce, in order of how
 * authoritative it is. Never throws: this parses untrusted model output, and a
 * malformed response is an expected event, not an exceptional one.
 */
export function extractStructuredPayload(response: unknown): Record<string, unknown> | null {
  if (!response || typeof response !== "object") return null;
  const r = response as Record<string, any>;

  // 1. A genuine tool call, normalised by the provider layer.
  const call = Array.isArray(r.toolCalls) ? r.toolCalls[0] : null;
  if (call?.arguments) {
    if (typeof call.arguments === "string") {
      const parsed = parseJsonObject(call.arguments);
      if (parsed) return parsed;
    } else if (typeof call.arguments === "object" && !Array.isArray(call.arguments)) {
      return call.arguments as Record<string, unknown>;
    }
  }

  // 2. The structured-output path: `content`, string or already an object.
  if (r.content && typeof r.content === "object" && !Array.isArray(r.content)) {
    return r.content as Record<string, unknown>;
  }
  if (typeof r.content === "string") {
    const parsed = parseJsonObject(r.content);
    if (parsed) return parsed;
  }

  // 3. Shapes other SDK surfaces use. Cheap to accept, and it means a provider
  //    added later does not silently return nothing.
  if (typeof r.output_text === "string") {
    const parsed = parseJsonObject(r.output_text);
    if (parsed) return parsed;
  }
  if (r.parsed && typeof r.parsed === "object" && !Array.isArray(r.parsed)) {
    return r.parsed as Record<string, unknown>;
  }

  return null;
}
