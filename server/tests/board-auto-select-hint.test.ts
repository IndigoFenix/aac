/**
 * AAC Auto-Select follows the hint.
 *
 * The hint is what tells the AAC AI WHEN to load a board, and the checkbox is
 * disabled without one — so a board that gains a hint must gain auto-select
 * too. This used to be wired only into the clinician's text input, which meant
 * a hint the AI wrote through the board generator arrived with the checkbox
 * still unticked: a perfectly good "During mealtimes" board that never fired,
 * and no visible reason why.
 *
 * The rule lives in the board store (client/src/store/board-store.ts) and is
 * shared by both writers. It is pure, so it is tested here rather than through
 * a rendered panel.
 */

import { describe, it, expect } from "@jest/globals";
import { resolveAutomaticSelection } from "../../client/src/store/board-store";

describe("resolveAutomaticSelection", () => {
  it("turns ON when a hint appears where there was none", () => {
    expect(resolveAutomaticSelection(undefined, "During mealtimes", false)).toBe(true);
    expect(resolveAutomaticSelection("", "During mealtimes", false)).toBe(true);
    // Whitespace is not a hint — it would leave the AI with no condition.
    expect(resolveAutomaticSelection("   ", "During mealtimes", false)).toBe(true);
  });

  it("turns OFF when the hint is cleared", () => {
    expect(resolveAutomaticSelection("During mealtimes", "", true)).toBe(false);
    expect(resolveAutomaticSelection("During mealtimes", "   ", true)).toBe(false);
    expect(resolveAutomaticSelection("During mealtimes", undefined, true)).toBe(false);
  });

  it("leaves the clinician's own choice alone while a hint merely CHANGES", () => {
    // Someone who deliberately unticked the box must not have it switched back
    // on by an edit to the wording.
    expect(resolveAutomaticSelection("At lunch", "During mealtimes", false)).toBe(false);
    expect(resolveAutomaticSelection("At lunch", "During mealtimes", true)).toBe(true);
  });

  it("defaults an unknown previous state to off", () => {
    expect(resolveAutomaticSelection("At lunch", "During mealtimes", undefined)).toBe(false);
  });
});
