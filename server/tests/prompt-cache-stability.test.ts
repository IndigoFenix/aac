/**
 * Prompt-cache stability — string-comparison guard.
 *
 * Anthropic prompt caching only produces cache *reads* (0.1x) instead of
 * cache *writes* (1.25x) when the cached prefix — the system prompt + tools —
 * is BYTE-IDENTICAL between consecutive turns. A single value that changes per
 * request (a timestamp, a re-rendered memory snapshot, non-deterministic key
 * order) silently busts the cache: every call becomes a full write, no reads.
 * That happened here (cache_creation ~21k, cache_read 0 on every call).
 *
 * These tests string-compare the cacheable prefix across two consecutive
 * buildPromptAndTools() calls and fail loudly — pointing at the first differing
 * character — if anything in it changes when it shouldn't.
 */

import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { buildPromptAndTools } from "../services/chat/prompt-kit.js";
import { buildCrmAgent } from "../services/crmChat/agentTemplate.js";

/** Returns a human-readable description of the first difference, or null. */
function firstDiff(a: string, b: string): string | null {
  if (a === b) return null;
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  const ctx = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 30), i + 30));
  return `first diff at index ${i} (len ${a.length} vs ${b.length}):\n  A: ${ctx(a)}\n  B: ${ctx(b)}`;
}

function cacheablePrefix(build: { instructions: string; endInstructions?: string; tools: any[] }): string {
  // The system block + the tool definitions are what carry cache_control.
  return (build.instructions + (build.endInstructions ?? "")) + "\n\n" + JSON.stringify(build.tools);
}

const TZ = "Asia/Jerusalem";

function makeCtx(memoryValues: any, memoryState: any) {
  return {
    agent: buildCrmAgent({ systemPrompt: "be friendly" }),
    history: [],
    memoryValues,
    memoryState,
    openedTopics: [],
    conversationSummary: "",
    timezone: TZ,
  };
}

describe("prompt-cache stability", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("produces a byte-identical cacheable prefix for identical inputs", () => {
    const state = { visible: [], page: {}, staticPromptMode: true };
    const a = cacheablePrefix(buildPromptAndTools(makeCtx({}, state)) as any);
    const b = cacheablePrefix(buildPromptAndTools(makeCtx({}, state)) as any);
    const diff = firstDiff(a, b);
    expect(diff).toBeNull();
  });

  it("keeps the cacheable prefix stable across turns when memory mutates (static mode)", () => {
    // Static mode freezes the memory render so the system prompt does NOT change
    // as the AI views/edits memory — that is what lets the cache hit on later turns.
    const state: any = { visible: [], page: {}, staticPromptMode: true };

    // Turn 1: first render freezes _cachedPrompt onto the shared state object.
    const turn1 = cacheablePrefix(buildPromptAndTools(makeCtx({}, state)) as any);

    // Turn 2: same state object, but memory data has changed (a row was added).
    const mutated = { Context_Library: [{ id: "x", title: "New", content: "data" }] };
    const turn2 = cacheablePrefix(buildPromptAndTools(makeCtx(mutated, state)) as any);

    const diff = firstDiff(turn1, turn2);
    // If this fails, the diff message shows exactly which value busted the cache.
    expect(diff).toBeNull();
  });

  it("does not leak the wall clock into the cached prefix (same-day, different hour)", () => {
    // Guards against a future prompt edit injecting Date.now()/new Date() with
    // sub-day granularity into the system block — which would bust the cache every
    // request. Two builds at different times on the SAME day must be identical.
    // (Day-granularity date rolling once per day is intentional and allowed.)
    const state = { visible: [], page: {}, staticPromptMode: true };

    jest.useFakeTimers().setSystemTime(new Date("2026-06-04T08:00:00Z"));
    const a = cacheablePrefix(buildPromptAndTools(makeCtx({}, state)) as any);

    jest.setSystemTime(new Date("2026-06-04T11:30:00Z"));
    const b = cacheablePrefix(buildPromptAndTools(makeCtx({}, { visible: [], page: {}, staticPromptMode: true })) as any);

    expect(firstDiff(a, b)).toBeNull();
  });

  it("keeps the cacheable prefix stable across a serialized (DB round-trip) state", () => {
    // Across turns the state is persisted and reloaded as JSON, so the frozen
    // _cachedPrompt must survive serialization and keep the prefix identical.
    const state1: any = { visible: [], page: {}, staticPromptMode: true };
    const turn1 = cacheablePrefix(buildPromptAndTools(makeCtx({}, state1)) as any);

    // Simulate persist→reload (onUpdateChatState JSON-clones; session.state reload).
    const state2 = JSON.parse(JSON.stringify(state1));
    const mutated = { Context_Library: [{ id: "y", title: "Later", content: "more" }] };
    const turn2 = cacheablePrefix(buildPromptAndTools(makeCtx(mutated, state2)) as any);

    expect(firstDiff(turn1, turn2)).toBeNull();
  });
});
