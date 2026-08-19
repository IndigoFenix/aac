/**
 * Tests for reading a structured payload back out of a provider response.
 *
 * This is a REGRESSION SUITE before it is anything else. The venue-menu
 * services are the only callers that talk to `StructuredLLMProvider` directly
 * rather than through `chat/gpt.ts`, and both of them originally looked for the
 * payload in `output` / `parsed` / `output_text` — none of which is where
 * `ClaudeStructuredProvider` puts it. It puts a JSON STRING in `content`.
 *
 * Reading the wrong field does not throw. It returns nothing, and both callers
 * fail open on nothing: every camera frame would report as unreadable and every
 * refinement would classify nothing, each looking like ordinary bad luck. The
 * fixtures below are therefore shaped like the providers' real output, not like
 * a convenient object.
 *
 * DB-free, no live LLM (the fake provider seam): belongs in `test:unit`.
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import { extractStructuredPayload } from "../services/venue-menus/structured-payload.js";
import {
  parseRefinementResponse,
  requestMenuRefinement,
} from "../services/venue-menus/refinement-agent.js";
import { parseExtractionResponse } from "../services/venue-menus/camera-extraction.js";
import { installFakeLlm, uninstallFakeLlm } from "./helpers/llm-mock.js";

/** What ClaudeStructuredProvider.parseResponse actually returns. */
function claudeResponse(payload: unknown) {
  return {
    promptTokens: 10,
    completionTokens: 20,
    cachedTokens: 0,
    // JSON.stringify(block.input) — a STRING, not an object.
    content: JSON.stringify(payload),
    // The raw Anthropic block array. Note the block type: `tool_use`, never
    // `function_call` — the shape the original parser was hunting for.
    output: [{ type: "tool_use", name: "_structured_response", input: payload }],
    toolCalls: [],
    refused: false,
  };
}

describe("extractStructuredPayload — every envelope a provider in this repo uses", () => {
  it("reads a Claude structured response (JSON string in content)", () => {
    expect(extractStructuredPayload(claudeResponse({ entries: [{ index: 0 }] }))).toEqual({
      entries: [{ index: 0 }],
    });
  });

  it("reads a Gemini response whose text is fenced", () => {
    const response = {
      content: '```json\n{"items":[{"name":"Falafel"}]}\n```',
      toolCalls: [],
      refused: false,
    };
    expect(extractStructuredPayload(response)).toEqual({ items: [{ name: "Falafel" }] });
  });

  it("reads a genuine tool call from toolCalls[].arguments", () => {
    const response = {
      content: "",
      toolCalls: [{ type: "function_call", call_id: "a", name: "x", arguments: '{"entries":[]}' }],
      refused: false,
    };
    expect(extractStructuredPayload(response)).toEqual({ entries: [] });
  });

  it("accepts content that is already an object", () => {
    expect(extractStructuredPayload({ content: { entries: [1] }, toolCalls: [] })).toEqual({
      entries: [1],
    });
  });

  it("accepts output_text and parsed for surfaces added later", () => {
    expect(extractStructuredPayload({ output_text: '{"a":1}' })).toEqual({ a: 1 });
    expect(extractStructuredPayload({ parsed: { a: 1 } })).toEqual({ a: 1 });
  });

  it("returns null rather than throwing on anything unusable", () => {
    for (const bad of [null, undefined, 42, "text", {}, { content: "not json" }, { content: "[]" }]) {
      expect(extractStructuredPayload(bad)).toBeNull();
    }
  });

  it("prefers a tool call over content when both are present", () => {
    const response = {
      content: JSON.stringify({ entries: ["from_content"] }),
      toolCalls: [{ arguments: JSON.stringify({ entries: ["from_tool"] }) }],
    };
    expect(extractStructuredPayload(response)).toEqual({ entries: ["from_tool"] });
  });
});

describe("parseRefinementResponse", () => {
  it("pulls entries out of a real Claude response shape", () => {
    const entries = [{ index: 0, keep: true, kind: "food" }];
    expect(parseRefinementResponse(claudeResponse({ entries }))).toEqual(entries);
  });

  it("returns [] when entries is missing or not an array", () => {
    expect(parseRefinementResponse(claudeResponse({}))).toEqual([]);
    expect(parseRefinementResponse(claudeResponse({ entries: "nope" }))).toEqual([]);
    expect(parseRefinementResponse({ content: "garbage" })).toEqual([]);
  });
});

describe("parseExtractionResponse", () => {
  it("reads items out of a real Claude response shape", () => {
    const page = parseExtractionResponse(
      claudeResponse({
        language: "he",
        currency: "ILS",
        items: [{ name: "רול אנטריקוט", price: 48, priceText: "₪48", confidence: 0.9 }],
      }),
    );

    expect(page).not.toBeNull();
    expect(page!.language).toBe("he");
    expect(page!.currency).toBe("ILS");
    expect(page!.items).toHaveLength(1);
    expect(page!.items[0]).toMatchObject({ name: "רול אנטריקוט", price: 48, priceText: "₪48" });
  });

  it("returns null when there is no items array — a frame we could not read", () => {
    expect(parseExtractionResponse(claudeResponse({ language: "he" }))).toBeNull();
    expect(parseExtractionResponse({ content: "" })).toBeNull();
  });
});

describe("requestMenuRefinement — through the provider seam", () => {
  afterEach(() => uninstallFakeLlm());

  it("numbers the rows it sends and returns the entries the model gave back", async () => {
    const llm = installFakeLlm();
    llm.structured.enqueue(
      claudeResponse({ entries: [{ index: 0, keep: true, kind: "food" }] }) as any,
    );

    const entries = await requestMenuRefinement(
      [
        { name: "רול אנטריקוט", price: 48, priceText: "₪48", category: "טורטיות" },
        { name: "קוקה קולה", price: 13, priceText: "₪13" },
      ],
      { targetLanguage: "he" },
    );

    expect(entries).toEqual([{ index: 0, keep: true, kind: "food" }]);

    const [request] = llm.structured.calls;
    const sent = String((request.input[0] as any).content);
    // Indexes must be unambiguous, and the price must travel with the row —
    // it is what separates two sizes of one dish from a genuine duplicate.
    expect(sent).toContain("0. רול אנטריקוט ₪48 [טורטיות]");
    expect(sent).toContain("1. קוקה קולה ₪13");
    expect(request.instructions).toContain("Translate each name into he");
  });

  it("skips the call entirely for an empty menu", async () => {
    const llm = installFakeLlm();
    expect(await requestMenuRefinement([])).toEqual([]);
    expect(llm.structured.calls).toHaveLength(0);
  });

  it("returns [] when the provider throws — annotation fails OPEN", async () => {
    // No response enqueued: FakeStructuredProvider throws. The caller must
    // still get a menu, with every row kept and unclassified.
    installFakeLlm();
    expect(await requestMenuRefinement([{ name: "Falafel" }])).toEqual([]);
  });
});
