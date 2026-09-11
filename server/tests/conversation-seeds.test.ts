/**
 * Conversation SEEDS — the initializer section and its two delivery points.
 *
 * The seed bank is written once per session by the enhancer's `seeds` call
 * and rides the Board Manager's CACHEABLE base prompt; the per-turn
 * [STALLED] note that tells the model to spend one rides the invocation
 * context. This pins both halves, plus the section spec's two rules that
 * are the whole point of the feature: seeds must name things, and the
 * section must never come back empty.
 */

import { describe, it, test, expect } from "@jest/globals";
import { PLAN_CALLS, buildPlanCall, type PlanContext } from "../services/dual-agent/session-plan.js";
import { buildBoardManagerPrompt } from "../services/dual-agent/prompts/board-manager.js";
import { renderInvocationContext } from "../services/dual-agent/board-manager-agent.js";
import type { BoardManagerInvocationInput } from "../services/dual-agent/board-manager-agent.js";

const NONCES = { outputNonce: "N0NCE", untrustedNonce: "UNTR" };

function makeCtx(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    studentName: "Daniel",
    language: "en",
    languageName: "English",
    studentDataParts: ["Name: Daniel", "Age: 39"],
    isChild: false,
    customRules: [],
    autoNotes: [],
    interestList: ["geology", "science"],
    languageLevel: null as any,
    singleGlyphButtons: false,
    events: [],
    locationSection: "",
    locationKey: "none",
    nowMs: Date.parse("2026-09-09T12:00:00Z"),
    weekday: 3,
    localDate: "2026-09-09",
    dayPart: "afternoon",
    ...overrides,
  } as PlanContext;
}

describe("session-plan — the seeds call", () => {
  const spec = PLAN_CALLS.find((c) => c.call === "seeds")!;

  it("exists, produces conversationSeeds, and caches with today's group", () => {
    expect(spec).toBeDefined();
    expect(spec.group).toBe("goals");
    expect(spec.tags).toEqual([{ tag: "conversation_seeds", key: "conversationSeeds" }]);
  });

  it("names the failure it exists to prevent, so the model knows what a bad seed is", () => {
    const built = buildPlanCall(spec, makeCtx(), NONCES).systemPrompt;
    expect(built).toContain("I want to talk about something else");
    expect(built).toContain("I want to ask a question");
  });

  it("requires every seed to name something and to carry a second move", () => {
    const built = buildPlanCall(spec, makeCtx(), NONCES).systemPrompt;
    expect(built).toContain("at least one noun a stranger could point at");
    expect(built).toMatch(/SECOND MOVE/);
  });

  it("forbids an empty section — thin data is the case that stalls most", () => {
    const built = buildPlanCall(spec, makeCtx(), NONCES).systemPrompt;
    expect(built).toContain("NEVER LEAVE THIS SECTION EMPTY");
  });

  it("picks up the previous session's loose threads when there is a summary", () => {
    const built = buildPlanCall(
      spec,
      makeCtx({ lastSessionSummary: "Daniel talked about volcanoes." }),
      NONCES,
    ).systemPrompt;
    expect(built).toContain("volcanoes");
  });
});

describe("board-manager prompt — <conversation_seeds>", () => {
  const base = (conversationSeeds?: string) =>
    buildBoardManagerPrompt({
      studentName: "Daniel",
      language: "en",
      conversationSeeds,
    } as any).base;

  test("the bank rides the cacheable base when the session has one", () => {
    const prompt = base('- volcanoes: "I like volcanoes" → which one is biggest');
    expect(prompt).toContain("<conversation_seeds>");
    expect(prompt).toContain("I like volcanoes");
  });

  test("no block at all when the session planned no seeds", () => {
    expect(base(undefined)).not.toContain("<conversation_seeds>");
  });

  test("rations to ONE seed and forbids the AI voicing it itself", () => {
    const prompt = base('- volcanoes: "I like volcanoes" → which one is biggest');
    expect(prompt).toMatch(/Spend exactly ONE/);
    expect(prompt).toMatch(/never voice the seed yourself/i);
    // A seed must not override a conversation that already has a subject.
    expect(prompt).toMatch(/RESERVE, not a script/);
  });
});

describe("renderInvocationContext — the [STALLED] note", () => {
  function input(overrides: Partial<BoardManagerInvocationInput> = {}): BoardManagerInvocationInput {
    return {
      systemPrompt: "base",
      toolConfig: { availableBoards: [], hasLoadedBoard: false },
      triggeringEvents: [],
      recentEvents: [],
      currentBoardLabels: [],
      contextSidebarLabels: [],
      model: "gemini-2.5-flash",
      ...overrides,
    } as BoardManagerInvocationInput;
  }

  test("renders after the action hint, where the model attends most", () => {
    const ctx = renderInvocationContext(input({
      stallDirective: "[STALLED] Spend ONE seed from <conversation_seeds> on this rebuild.",
    }));
    expect(ctx.indexOf("[STALLED]")).toBeGreaterThan(ctx.indexOf("<this_invocation>"));
  });

  test("absent unless the coordinator supplied one", () => {
    expect(renderInvocationContext(input())).not.toContain("[STALLED]");
    expect(renderInvocationContext(input({ stallDirective: "   " }))).not.toContain("[STALLED]");
  });

  test("a retry correction still outranks it", () => {
    const ctx = renderInvocationContext(input({
      stallDirective: "[STALLED] Spend ONE seed.",
      retryFeedback: "fix your glyphs",
    }));
    expect(ctx.indexOf("<retry_feedback>")).toBeGreaterThan(ctx.indexOf("[STALLED]"));
  });
});
