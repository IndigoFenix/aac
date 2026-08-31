// Provider-layer prompt-cache guard for ClaudeStructuredProvider (the path
// every Monitor run and clinician turn takes). Pins:
//   - cache_control sits on the system block, the last tool, and the last
//     message block (system + tools + conversation-so-far are cacheable);
//   - the provider adds NOTHING volatile: identical instructions/tools give
//     byte-identical `system` and `tools` params even when the messages differ;
//   - system-role history items (memory snapshots, summaries) go into the
//     first user message, never into the cached system block.

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";

const created: any[] = [];
const fakeClient = {
  messages: {
    create: async (params: any) => {
      created.push(params);
      return {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "_structured_response", input: { text: "OK" } }],
        usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
    },
  },
};

// The factory must export EVERYTHING the module under test imports — under
// ESM a missing name is a hard link error at import time, not an undefined at
// call time, so the whole suite fails to load. `isUsingVertex` is read by the
// provider's AKIM §18.5 disclosure record (it decides `endpoint: vertex|api`);
// false is the production default (ANTHROPIC_USE_VERTEX unset).
jest.unstable_mockModule("../services/providers/anthropic-client", () => ({
  getAnthropicClient: () => fakeClient,
  isUsingVertex: () => false,
}));

const { ClaudeStructuredProvider } = await import("../services/providers/claude-structured.js");
const { setDisclosureSink } = await import("../services/processorDisclosure.js");

const TOOLS = [
  { type: "function", function: { name: "manageMemory", description: "memory ops", parameters: { type: "object", properties: { ops: { type: "array" } }, required: ["ops"] } } },
  { type: "function", function: { name: "pruneMessages", description: "prune", parameters: { type: "object", properties: {} } } },
] as any;

function request(userText: string, memorySnapshot: string) {
  return {
    model: "claude-haiku",
    instructions: "MONITOR SYSTEM PROMPT",
    schemaName: "monitor",
    schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } as any,
    tools: TOOLS,
    input: [
      { type: "message", role: "system", content: memorySnapshot },
      { type: "message", role: "user", content: userText },
    ] as any,
  };
}

// Swallow the disclosure row this provider now writes. Without a sink the
// default one lazily imports activityLogService → server/db.ts, which would
// drag a Postgres pool into a DB-free unit suite; and with no student context
// attached it would print the contextMissing marker on every call. Neither is
// this suite's subject.
beforeEach(() => { setDisclosureSink(() => {}); created.length = 0; delete process.env.CLAUDE_CACHE_DEBUG; });
afterEach(() => { setDisclosureSink(null); });

describe("ClaudeStructuredProvider — prompt-cache breakpoints", () => {
  it("marks system, last tool and last message block as cacheable", async () => {
    await new ClaudeStructuredProvider().structuredComplete(request("hello", "[memory v1]") as any);
    const p = created[0];
    expect(p.system).toHaveLength(1);
    expect(p.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(p.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
    const last = p.messages.at(-1);
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content.at(-1).cache_control).toEqual({ type: "ephemeral" });
  });

  it("keeps system + tools byte-identical across calls whose messages differ", async () => {
    const provider = new ClaudeStructuredProvider();
    await provider.structuredComplete(request("first turn", "[memory v1]") as any);
    await provider.structuredComplete(request("a later, different turn", "[memory v2 — notes changed]") as any);
    const [a, b] = created;
    expect(JSON.stringify(a.system)).toBe(JSON.stringify(b.system));
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
    expect(a.model).toBe(b.model);
  });

  it("keeps system-role history (memory snapshots) OUT of the cached system block", async () => {
    await new ClaudeStructuredProvider().structuredComplete(request("hi", "[memory snapshot that changes every round]") as any);
    const p = created[0];
    expect(p.system[0].text).toBe("MONITOR SYSTEM PROMPT");
    expect(JSON.stringify(p.messages)).toContain("memory snapshot that changes every round");
  });

  it("puts no clock into the request", async () => {
    await new ClaudeStructuredProvider().structuredComplete(request("hi", "[m]") as any);
    const body = JSON.stringify(created[0]);
    expect(body).not.toMatch(/20\d\d-\d\d-\d\dT\d\d:\d\d/);
  });
});
