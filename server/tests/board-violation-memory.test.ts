// Session violation memory for the (stateless) Board Manager:
//   1. validateBoardButtons reports structured violations with render-ready
//      offending tokens alongside the human-readable error strings.
//   2. renderViolationMemoryBlock renders one terse reminder per rule,
//      appending tokens where the rule carries them; empty memory → "".
//   3. renderInvocationContext embeds the <recent_mistakes> block in the
//      user-role context (NOT the system prompt — prompt-cache safety).

import { validateBoardButtons } from "../services/dual-agent/board-button-validator";
import { renderViolationMemoryBlock } from "../services/dual-agent/prompts/board-manager";
import { renderInvocationContext } from "../services/dual-agent/board-manager-agent";
import type { BoardManagerInvocationInput } from "../services/dual-agent/board-manager-agent";

describe("validateBoardButtons — structured violations", () => {
  test("bare non-canonical keys report imagekey_no_fallback with the offending keys", () => {
    const { violations } = validateBoardButtons([
      { label: "tell me", glyph: "tell+i_me+about+it" },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("imagekey_no_fallback");
    // At least one of the invented keys is reported (whichever aren't canonical).
    expect(violations[0].tokens.length).toBeGreaterThan(0);
    for (const t of violations[0].tokens) {
      expect("tell+i_me+about+it").toContain(t);
    }
  });

  test("invented modifiers report non_canonical_modifier as .dot forms", () => {
    // Fallback provided so rule 1 (imageKey without fallback — the modifier
    // key doubles as a generation-eligible key) doesn't short-circuit rule 3.
    const { violations } = validateBoardButtons([
      { label: "sad book", glyph: "📖.sad_invented_mod", glyphFallback: "📖" },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("non_canonical_modifier");
    expect(violations[0].tokens).toContain(".sad_invented_mod");
  });

  test("valid buttons produce no violations", () => {
    const { violations, errors } = validateBoardButtons([
      { label: "home", glyph: "i_me+🏠" },
    ]);
    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("renderViolationMemoryBlock", () => {
  test("empty memory renders nothing", () => {
    expect(renderViolationMemoryBlock([])).toBe("");
  });

  test("renders one reminder per rule with tokens appended", () => {
    const block = renderViolationMemoryBlock([
      { rule: "imagekey_no_fallback", tokens: ["tell", "about"] },
      { rule: "duplicate_glyph", tokens: [] },
    ]);
    expect(block).toContain("<recent_mistakes>");
    expect(block).toContain("`tell`");
    expect(block).toContain("`about`");
    expect(block).toContain("identical glyph");
    expect(block).toContain("</recent_mistakes>");
  });

  test("unknown rules are skipped rather than rendered raw", () => {
    const block = renderViolationMemoryBlock([
      { rule: "some_future_rule", tokens: ["x"] },
      { rule: "no_visual", tokens: [] },
    ]);
    expect(block).not.toContain("some_future_rule");
    expect(block).toContain("displayable visual");
  });
});

describe("renderInvocationContext — <recent_mistakes> placement", () => {
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

  test("violation memory renders in the context before <this_invocation>", () => {
    const ctx = renderInvocationContext(input({
      violationMemory: [{ rule: "imagekey_no_fallback", tokens: ["tell"] }],
    }));
    const mistakes = ctx.indexOf("<recent_mistakes>");
    const invocation = ctx.indexOf("<this_invocation>");
    expect(mistakes).toBeGreaterThan(-1);
    expect(invocation).toBeGreaterThan(mistakes);
    expect(ctx).toContain("`tell`");
  });

  test("no block when memory is absent or empty", () => {
    expect(renderInvocationContext(input())).not.toContain("<recent_mistakes>");
    expect(renderInvocationContext(input({ violationMemory: [] }))).not.toContain("<recent_mistakes>");
  });
});
