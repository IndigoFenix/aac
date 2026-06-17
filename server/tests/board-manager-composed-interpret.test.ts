// Regression: a composed SENTENCE (user pressed Play in the SENTENCE BUILDER)
// must steer the Board Manager toward interpret() — NOT a board rebuild.
//
// The original bug: `sentence_composed` was folded into `hasUserInput`, so the
// per-invocation action hint said "Action: rebuild_board", and the event
// rendered as "[USER (composed) to AI]" — a tag no instruction referenced. The
// model rebuilt the board instead of voicing the sentence, so composed
// sentences were never interpreted or spoken aloud.

import {
  invocationActionHint,
  renderEventLine,
} from "../services/dual-agent/prompts/board-manager";
import { T } from "../services/memory-schema/canonical-terms";
import type {
  SentenceComposedEvent,
  ButtonPressedEvent,
  InterpretIntentEvent,
} from "../services/dual-agent/agent-events";

const composed: SentenceComposedEvent = {
  type: "sentence_composed",
  source: "client",
  timestamp: 0,
  glyphs: ["make", "🎮"],
  sentence: "make(🎮)",
};

const press: ButtonPressedEvent = {
  type: "button_pressed",
  source: "client",
  timestamp: 0,
  label: "I want pizza",
  sentence: "I want pizza",
  target: "DEVICE",
};

const interpretIntent: InterpretIntentEvent = {
  type: "interpret_intent",
  source: "board-manager",
  timestamp: 0,
  sentence: "I want to play a game",
};

describe("Board Manager — composed-sentence interpret routing", () => {
  test("composed sentence yields an interpret hint, not rebuild_board", () => {
    const hint = invocationActionHint([composed]);
    expect(hint).toContain("interpret(sentence)");
    expect(hint).not.toMatch(/rebuild_board/);
  });

  test("composed-sentence hint wins even when batched with builder_closed", () => {
    // The builder closes the instant Play is pressed, so the deferred
    // invocation usually carries both events together.
    const hint = invocationActionHint([
      composed,
      { type: "builder_closed", source: "client", timestamp: 0 },
    ]);
    expect(hint).toContain("interpret(sentence)");
    expect(hint).not.toMatch(/rebuild_board/);
  });

  test("a normal button press still asks for a follow-up board", () => {
    const hint = invocationActionHint([press]);
    expect(hint).toMatch(/rebuild_board/);
    expect(hint).not.toContain("interpret(sentence)");
  });

  test("the post-interpret follow-up rebuilds the board", () => {
    // After interpret() runs, the coordinator re-invokes with the
    // interpret_intent event to build the follow-up surface.
    const hint = invocationActionHint([interpretIntent]);
    expect(hint).toMatch(/rebuild_board/);
  });

  test("composed sentence renders with the canonical [SENTENCE COMPOSED] tag", () => {
    const line = renderEventLine(composed);
    expect(line).toBe(`${T.tagComposed} "make(🎮)"`);
    expect(line).toContain("[SENTENCE COMPOSED]");
    // The old, instruction-less rendering must be gone.
    expect(line).not.toContain("(composed) to AI");
  });
});
