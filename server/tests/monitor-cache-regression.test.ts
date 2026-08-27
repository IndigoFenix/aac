// Monitor prompt-cache regression guards (2026-08-27).
//
// The Monitor's Claude prompt cache went from a 1% hit rate to reading the
// whole prefix on every round after three fixes, each of which is one line
// away from regressing:
//   1. STATE  — dual-agent-service must build the Monitor's chat state in
//               static prompt mode (`memoryState.staticPromptMode: true`).
//   2. PROMPT — the assembled system prompt + tools (the cacheable prefix)
//               must be byte-identical across fresh states, memory writes,
//               viewed paths, and the time of day.
//   3. SOURCE — sessionService.enrichCorePrompt must not put a sub-day
//               timestamp into the system prompt (it did: an ISO stamp that
//               busted the cache on every new manager).
// The provider layer (cache_control placement) is pinned separately in
// claude-structured-cache.test.ts; the DB round-trip in
// integration/monitor-history-ownership.test.ts.

import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { readFileSync } from "fs";
import { join } from "path";
import { buildPromptAndTools } from "../services/chat/prompt-kit.js";
import { buildMonitorSystemPrompt, getAACMemoryFields } from "../services/memory-schema/aac-memory-schema.js";
import { STUDENT_MEMORY_FIELDS } from "../services/memory-schema/student-memory-schema.js";
import { LIBRARY_TOPICS_FIELD } from "../services/memory-schema/topic-memory-schema.js";
import { getAACSettingsMemoryFields } from "../services/memory-schema/aac-settings-memory-schema.js";
import { buildMonitorChatState, monitorMemoryState } from "../services/dual-agent/monitor-chat-state.js";

function firstDiff(a: string, b: string): string | null {
  if (a === b) return null;
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  const ctx = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 40));
  return `first diff at ${i} (len ${a.length} vs ${b.length}):\n  A: ${ctx(a)}\n  B: ${ctx(b)}`;
}

/** The two blocks that carry cache_control: system text + tool definitions. */
function cacheablePrefix(build: { instructions: string; endInstructions?: string; tools: any[] }): string {
  return build.instructions + (build.endInstructions ?? "") + "\n\n" + JSON.stringify(build.tools);
}

// ---------------------------------------------------------------------------
// 1. STATE
// ---------------------------------------------------------------------------

describe("Monitor chat state (dual-agent-service save)", () => {
  const live = { muteState: "unmuted", memoryContext: "ctx", enhancedSections: {}, sessionSummary: "s", summarizedMsgCount: 3 };

  it("is built in STATIC prompt mode", () => {
    expect(buildMonitorChatState({}, live).memoryState).toEqual({ visible: [], page: {}, staticPromptMode: true });
  });

  it("overwrites a legacy dynamic-mode row and keeps the framework's history + summary", () => {
    const prior = { history: [{ role: "user", content: "x" }], conversationSummary: "sum", memoryState: {}, openedTopics: ["t"] };
    const s = buildMonitorChatState(prior, live);
    expect((s.memoryState as any).staticPromptMode).toBe(true);
    expect(s.history).toEqual(prior.history);
    expect(s.conversationSummary).toBe("sum");
    expect(s.openedTopics).toEqual([]);
  });

  it("hands out a fresh state object each time (the memory system writes _cachedPrompt onto it)", () => {
    expect(monitorMemoryState()).not.toBe(monitorMemoryState());
  });

  it("carries the frozen render (_cachedPrompt) across the per-save reset, and only that", () => {
    const prior = { memoryState: { visible: ["/Student_Notes"], page: { x: 1 }, staticPromptMode: true, _cachedPrompt: "FROZEN" } };
    const s = buildMonitorChatState(prior, live).memoryState as any;
    expect(s._cachedPrompt).toBe("FROZEN");
    expect(s.visible).toEqual([]);
    expect(s.page).toEqual({});
    expect(s.staticPromptMode).toBe(true);
    // A legacy row without one starts clean.
    expect((buildMonitorChatState({ memoryState: {} }, live).memoryState as any)._cachedPrompt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. PROMPT
// ---------------------------------------------------------------------------

const STUDENT = { name: "Sam Test", aacSettings: { chatAgentPrompt: null, autoAacPrompt: null, dynamicBoardsEnabled: true }, framework: null };

/** The Monitor's agent as sessionService assembles it for an AAC session:
 *  the Monitor system prompt + Student_* fields + library + AAC context +
 *  settings (no prompt fields). */
function monitorAgent() {
  return {
    name: "AAC Monitor",
    corePrompt: buildMonitorSystemPrompt(STUDENT, "unmuted", [{ id: "b1", name: "Meals", hint: "mealtime" }]),
    memoryFields: [
      ...STUDENT_MEMORY_FIELDS.filter((f: any) => String(f.id).startsWith("Student_")),
      LIBRARY_TOPICS_FIELD,
      ...getAACMemoryFields(),
      ...getAACSettingsMemoryFields({ includePrompts: false }),
    ],
  };
}

function build(memoryValues: any, memoryState: any) {
  return buildPromptAndTools({
    agent: monitorAgent() as any,
    history: [],
    memoryValues,
    memoryState,
    openedTopics: [],
    conversationSummary: "",
    timezone: "Asia/Jerusalem",
  } as any);
}

const NOTES_V1 = { Student_Notes: [{ date: "2026-08-27", note: "likes fish" }] };
const NOTES_V2 = { Student_Notes: [{ date: "2026-08-27", note: "likes fish" }, { date: "2026-08-27", note: "asked about caves" }] };

describe("Monitor cacheable prefix (system + tools)", () => {
  afterEach(() => { jest.useRealTimers(); });

  it("is identical across FRESH static states — the per-run reset must not change it", () => {
    // dual-agent-service rebuilds memoryState on every save, so nothing
    // (no _cachedPrompt) carries between Monitor runs. Two fresh states must
    // still render the same bytes.
    const a = cacheablePrefix(build(NOTES_V1, monitorMemoryState()));
    const b = cacheablePrefix(build(NOTES_V1, monitorMemoryState()));
    expect(firstDiff(a, b)).toBeNull();
  });

  it("does not change when the Monitor writes memory between runs (the real save cycle)", () => {
    // Run 1 renders and freezes `_cachedPrompt` onto its state; the framework
    // persists that state; dual-agent-service then REBUILDS the state for the
    // next run from the persisted row. The frozen render must survive that
    // rebuild — a fresh render would pick up the new note ("2 items") and
    // move the prefix on exactly the run that follows a write.
    const run1State = monitorMemoryState();
    const a = cacheablePrefix(build(NOTES_V1, run1State));
    expect(run1State._cachedPrompt).toBeTruthy();
    const persisted = JSON.parse(JSON.stringify({ memoryState: run1State, history: [] }));
    const run2State = buildMonitorChatState(persisted, {}).memoryState;
    const b = cacheablePrefix(build(NOTES_V2, run2State));
    expect(firstDiff(a, b)).toBeNull();
  });

  it("(the leak this guards) a FRESH state after a write WOULD move the prefix", () => {
    // Documents why `_cachedPrompt` must be carried: static mode's first
    // render is value-aware (array item counts). If this ever passes with a
    // null diff, the renderer became value-free and the carry is redundant.
    const a = cacheablePrefix(build(NOTES_V1, monitorMemoryState()));
    const b = cacheablePrefix(build(NOTES_V2, monitorMemoryState()));
    expect(firstDiff(a, b)).not.toBeNull();
  });

  it("does not change after a `view` marks paths visible", () => {
    const a = cacheablePrefix(build(NOTES_V2, monitorMemoryState()));
    const viewed = { ...monitorMemoryState(), visible: ["/Student_Notes", "/Context_Progress"] };
    const b = cacheablePrefix(build(NOTES_V2, viewed));
    expect(firstDiff(a, b)).toBeNull();
  });

  it("does not change with the time of day", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-27T06:00:00Z"));
    const a = cacheablePrefix(build(NOTES_V1, monitorMemoryState()));
    jest.setSystemTime(new Date("2026-08-27T18:45:30.123Z"));
    const b = cacheablePrefix(build(NOTES_V1, monitorMemoryState()));
    expect(firstDiff(a, b)).toBeNull();
  });

  it("carries no Interactive-Agent quote and no [UPDATE_PROMPT] (13k tokens per round)", () => {
    const p = build(NOTES_V1, monitorMemoryState()).instructions;
    expect(p).not.toContain("Interactive Agent's Current Prompt");
    expect(p).not.toContain("UPDATE_PROMPT");
  });
});

// ---------------------------------------------------------------------------
// 3. SOURCE
// ---------------------------------------------------------------------------

describe("sessionService.enrichCorePrompt source guard", () => {
  it("puts no sub-day timestamp into the system prompt", () => {
    // The manager-level prompt assembly needs a DB session to run, so guard
    // the source directly: this closure prepends to EVERY system prompt, and a
    // `new Date().toISOString()` here is exactly what made every Monitor run
    // and clinician turn rewrite its whole cache prefix.
    const src = readFileSync(join(process.cwd(), "server", "services", "sessionService.ts"), "utf8");
    const start = src.indexOf("const enrichCorePrompt = ");
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf("\n  }", start);
    // Code only — the comment above the line documents the old bug by name.
    const body = src.slice(start, end).split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
    expect(body).toContain("printCurrentDateLine(");
    expect(body).not.toMatch(/new Date\(|toISOString\(|Date\.now\(|toLocaleTimeString\(/);
  });
});
