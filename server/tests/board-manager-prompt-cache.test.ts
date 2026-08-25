// Verifies the Board Manager's explicit Gemini prompt-cache integration:
//   1. Plain turn (no suffix) → ensurePromptCache is consulted; the request
//      carries cachedContent and OMITS system message / tools / toolChoice
//      (the API rejects a request that re-sends them alongside the cache).
//   2. Suffix turn (builder/guessing/retry feedback) → cache skipped; the
//      full base+suffix prompt is inlined with tools, as before caching.
//   3. Cache-create tokens are folded into the turn's promptTokens exactly
//      once (billed at the normal input rate through the existing ledger).
//   4. A rejected cache handle (expired server-side) invalidates the entry
//      and retries inline within the same invocation.
//   5. Cache unavailable (ensure returns null) → inline fallback.

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { ChatRequest, ChatCompletionResult } from "../services/providers/streaming-provider";
import { GeminiChatProvider } from "../services/providers/gemini-chat";

class FakeGeminiProvider extends GeminiChatProvider {
  ensureCalls: any[] = [];
  completeCalls: ChatRequest[] = [];
  invalidated: string[] = [];
  handle: { name: string; createdTokens: number } | null = { name: "cachedContents/test", createdTokens: 0 };
  failCachedCalls = false;

  override async ensurePromptCache(opts: any): Promise<{ name: string; createdTokens: number } | null> {
    this.ensureCalls.push(opts);
    return this.handle;
  }

  override invalidatePromptCache(name: string): void {
    this.invalidated.push(name);
  }

  override async completeChat(request: ChatRequest): Promise<ChatCompletionResult> {
    this.completeCalls.push(request);
    if (request.cachedContent && this.failCachedCalls) {
      throw new Error("CachedContent not found");
    }
    return {
      content: null,
      toolCalls: [{ name: "no_change", arguments: JSON.stringify({ reason: "test" }) }],
      usage: { promptTokens: 1000, completionTokens: 50 },
      finishReason: "STOP",
    };
  }
}

const fakeProvider = new FakeGeminiProvider();

jest.unstable_mockModule("../services/providers/provider-factory", () => ({
  getChatProvider: () => fakeProvider,
}));
jest.unstable_mockModule("../services/dual-agent/agent-flow-logger", () => ({
  flowInput: () => {},
  flowOutput: () => {},
  flowTool: () => {},
  flowNote: () => {},
  flowCost: () => {},
  flowSystemPrompt: () => {},
}));

const { BoardManagerAgent } = await import("../services/dual-agent/board-manager-agent.js");
type InvocationInput = import("../services/dual-agent/board-manager-agent.js").BoardManagerInvocationInput;

function baseInput(overrides: Partial<InvocationInput> = {}): InvocationInput {
  return {
    systemPrompt: "BASE SYSTEM PROMPT",
    toolConfig: { availableBoards: [], hasLoadedBoard: false },
    triggeringEvents: [],
    recentEvents: [],
    currentBoardLabels: [],
    contextSidebarLabels: [],
    model: "gemini-2.5-flash",
    ...overrides,
  } as InvocationInput;
}

beforeEach(() => {
  fakeProvider.ensureCalls.length = 0;
  fakeProvider.completeCalls.length = 0;
  fakeProvider.invalidated.length = 0;
  fakeProvider.handle = { name: "cachedContents/test", createdTokens: 0 };
  fakeProvider.failCachedCalls = false;
});

describe("BoardManagerAgent prompt cache", () => {
  it("uses cachedContent on a plain turn and omits system/tools from the request", async () => {
    const agent = new BoardManagerAgent("gemini");
    await agent.invoke(baseInput());

    expect(fakeProvider.ensureCalls).toHaveLength(1);
    expect(fakeProvider.ensureCalls[0].systemPrompt).toBe("BASE SYSTEM PROMPT");
    expect(fakeProvider.ensureCalls[0].toolChoice).toBe("required");

    expect(fakeProvider.completeCalls).toHaveLength(1);
    const req = fakeProvider.completeCalls[0];
    expect(req.cachedContent).toBe("cachedContents/test");
    expect(req.tools).toBeUndefined();
    expect(req.toolChoice).toBeUndefined();
    expect(req.messages.some((m) => m.role === "system")).toBe(false);
  });

  it("inlines base+suffix and skips the cache on a suffix turn", async () => {
    const agent = new BoardManagerAgent("gemini");
    await agent.invoke(baseInput({
      systemPromptSuffix: "<builder_mode>\nsuggest words\n</builder_mode>",
    }));

    expect(fakeProvider.ensureCalls).toHaveLength(0);
    const req = fakeProvider.completeCalls[0];
    expect(req.cachedContent).toBeUndefined();
    expect(req.tools).toBeDefined();
    expect(req.toolChoice).toBe("required");
    const system = req.messages.find((m) => m.role === "system");
    expect(system?.content).toContain("BASE SYSTEM PROMPT");
    expect(system?.content).toContain("<builder_mode>");
  });

  // 🚨 Retry feedback must NOT go through the suffix. A suffix turn re-bills the
  // whole prefix at the uncached rate — ~13.5k tokens instead of ~800, roughly
  // 17x a normal turn — and a retry is precisely when that is least affordable:
  // the rejected call was already wasted. Paying 17x for each correction is what
  // let a handful of un-renderable glyphs generate enough throughput to draw
  // Vertex 429s, which then read as "the Board Manager is broken since Vertex".
  it("keeps the prompt cache on a retry turn and puts the feedback in the TURN message", async () => {
    const agent = new BoardManagerAgent("gemini");
    await agent.invoke(baseInput({
      retryFeedback: 'Button "X" — glyph "a+b" contains a key that is not in the registry: `b`.',
    }));

    // The cache is still used — this is the whole point.
    expect(fakeProvider.ensureCalls).toHaveLength(1);
    const req = fakeProvider.completeCalls[0];
    expect(req.cachedContent).toBe("cachedContents/test");
    expect(req.messages.some((m) => m.role === "system")).toBe(false);

    // ...and the correction still reaches the model, on the user turn.
    const user = req.messages.find((m) => m.role === "user");
    expect(user?.content).toContain("<retry_feedback>");
    expect(user?.content).toContain("`b`");
  });

  it("folds cache-create tokens into promptTokens exactly once", async () => {
    fakeProvider.handle = { name: "cachedContents/test", createdTokens: 7000 };
    const agent = new BoardManagerAgent("gemini");

    const first = await agent.invoke(baseInput());
    expect(first.usage?.promptTokens).toBe(8000); // 1000 + 7000 create

    fakeProvider.handle = { name: "cachedContents/test", createdTokens: 0 };
    const second = await agent.invoke(baseInput());
    expect(second.usage?.promptTokens).toBe(1000); // no double count
  });

  it("invalidates and retries inline when the cached call is rejected", async () => {
    fakeProvider.failCachedCalls = true;
    const agent = new BoardManagerAgent("gemini");
    const result = await agent.invoke(baseInput());

    expect(fakeProvider.invalidated).toEqual(["cachedContents/test"]);
    expect(fakeProvider.completeCalls).toHaveLength(2);
    const retry = fakeProvider.completeCalls[1];
    expect(retry.cachedContent).toBeUndefined();
    expect(retry.messages.some((m) => m.role === "system")).toBe(true);
    expect(retry.tools).toBeDefined();
    expect(result.finishReason).toBe("STOP");
  });

  it("falls back to the inline prompt when the cache is unavailable", async () => {
    fakeProvider.handle = null;
    const agent = new BoardManagerAgent("gemini");
    await agent.invoke(baseInput());

    const req = fakeProvider.completeCalls[0];
    expect(req.cachedContent).toBeUndefined();
    expect(req.messages.some((m) => m.role === "system")).toBe(true);
    expect(req.tools).toBeDefined();
  });
});
