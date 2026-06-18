// Regression: a SILENT home press (e.g. the "I'm talking" → facilitator
// button) invokes the Board Manager with EMPTY triggers plus a mandatory
// `forceRebuildDirective`. When the model no_changes that mandatory rebuild —
// most common when the user RE-presses the same mode button and the existing
// board already resembles the requested palette — the Coordinator queues a
// retry whose feedback must RE-STATE the directive, not the generic
// "no tool calls" copy (the model may well have called no_change).

import {
  buildEmptyResponseRetryFeedback,
  buildForceRebuildHint,
} from "../services/dual-agent/prompts/board-manager";

const DIRECTIVE =
  "Palette: conversation starters for the user to say to a person in their environment.";

describe("Board Manager — empty-response retry feedback", () => {
  test("force-rebuild directive branch re-demands the rebuild and forbids no_change", () => {
    const fb = buildEmptyResponseRetryFeedback({
      inGuessingMode: false,
      inBuilderMode: false,
      forceRebuildDirective: DIRECTIVE,
    });
    expect(fb).toContain(DIRECTIVE);
    expect(fb).toMatch(/rebuild_board/);
    // The whole point: no_change is rejected on a mandatory topic switch.
    expect(fb).toMatch(/no_change is NOT valid/i);
    // It must NOT claim "no tool calls" — the model often DID call no_change.
    expect(fb).not.toMatch(/no tool calls/i);
  });

  test("force-rebuild directive takes priority over guessing / builder mode", () => {
    const fb = buildEmptyResponseRetryFeedback({
      inGuessingMode: true,
      inBuilderMode: true,
      forceRebuildDirective: DIRECTIVE,
    });
    expect(fb).toContain(DIRECTIVE);
    expect(fb).not.toMatch(/word-finder mode/);
    expect(fb).not.toMatch(/composing in the/);
  });

  test("without a directive, the default empty-response feedback is unchanged", () => {
    const fb = buildEmptyResponseRetryFeedback({
      inGuessingMode: false,
      inBuilderMode: false,
    });
    expect(fb).toMatch(/no tool calls/i);
    expect(fb).toMatch(/rebuild_board/);
    expect(fb).not.toContain(DIRECTIVE);
  });

  test("the force-rebuild HINT also forbids no_change (defense in depth)", () => {
    const hint = buildForceRebuildHint(DIRECTIVE);
    expect(hint).toContain(DIRECTIVE);
    expect(hint).toMatch(/rebuild_board/);
    expect(hint).toMatch(/Do NOT call no_change/i);
  });
});
