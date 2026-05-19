/**
 * Pure-logic tests for parseBoardButtons — the parser that turns the AI's
 * "sentence|glyph|fallback|label" comma-separated string into board buttons.
 *
 * The parser is intentionally lenient about the AI's pipe count: the model
 * often emits 3 sections (`sentence|glyph|label`) when it has no fallback to
 * provide, even though the prompt asks for a 4-section form with an empty
 * `||` fallback slot. The 3-section shape is treated as fallback-absent so
 * the AI's intended sentence/glyph/label still land in the right fields.
 */

import { describe, it, expect } from "@jest/globals";
import { parseBoardButtons } from "../services/dual-agent/interactive-agent";

describe("parseBoardButtons", () => {
  it("parses a full 4-section button", () => {
    const [btn] = parseBoardButtons("I want water|i_me+want+💧||Water");
    expect(btn).toMatchObject({
      sentence: "I want water",
      glyph: "i_me+want+💧",
      glyphFallback: undefined,
      label: "Water",
    });
  });

  it("parses a full 4-section button with non-empty fallback", () => {
    const [btn] = parseBoardButtons("I want mars|want+generate:mars|want+🌑.red|Mars");
    expect(btn).toMatchObject({
      sentence: "I want mars",
      glyph: "want+generate:mars",
      glyphFallback: "want+🌑.red",
      label: "Mars",
    });
  });

  it("treats a 3-section button as sentence|glyph|label with no fallback", () => {
    // This is the shape the AI often emits when it has no fallback to give —
    // it drops the empty `||` delimiter rather than leaving the field blank.
    const [btn] = parseBoardButtons("Good morning|i_me+talk+morning|My morning");
    expect(btn).toMatchObject({
      sentence: "Good morning",
      glyph: "i_me+talk+morning",
      glyphFallback: undefined,
      label: "My morning",
    });
  });

  it("treats a 3-section button with empty glyph as fallback-absent", () => {
    // Even when the AI misuses the middle slot, the label still belongs in
    // the LAST position — it should not migrate to glyphFallback.
    const [btn] = parseBoardButtons("i_me+talk+morning||My morning");
    expect(btn.label).toBe("My morning");
    expect(btn.glyphFallback).toBeUndefined();
  });

  it("treats a 2-section button as label|icon (legacy shape)", () => {
    const [btn] = parseBoardButtons("Hello|wave");
    expect(btn.label).toBe("Hello");
    expect(btn.glyph).toBe("wave");
    expect(btn.sentence).toBeUndefined();
  });

  it("treats a bare label (no pipes) as label-only", () => {
    const [btn] = parseBoardButtons("Hello");
    expect(btn.label).toBe("Hello");
    expect(btn.glyph).toBeUndefined();
    expect(btn.sentence).toBeUndefined();
  });

  it("parses multiple comma-separated buttons", () => {
    const buttons = parseBoardButtons(
      "I want water|i_me+want+💧||Water,Hello|👋||Hi"
    );
    expect(buttons).toHaveLength(2);
    expect(buttons[0].label).toBe("Water");
    expect(buttons[1].label).toBe("Hi");
  });

  it("preserves rowSpan/colSpan on full-form buttons", () => {
    const [btn] = parseBoardButtons("Big|big|🎯|Press!|2|3");
    expect(btn.rowSpan).toBe(2);
    expect(btn.colSpan).toBe(3);
  });
});
