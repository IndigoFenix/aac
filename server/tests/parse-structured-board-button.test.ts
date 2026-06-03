/**
 * Pure-logic tests for parseStructuredBoardButton — the canonical parser
 * for structured-array button inputs from the AI's tool calls.
 *
 * The structured parser bypasses the pipe round-trip entirely, so a comma
 * inside a field value (e.g. Hebrew "כן, אני רוצה לדבר") can't fragment a
 * button. This is the regression that caused binary-choice options to
 * render as fa-comment bubbles with the wrong escape option ("neither"
 * instead of "maybe").
 */

import { describe, it, expect } from "@jest/globals";
import { parseStructuredBoardButton, parseBoardButton } from "../services/dual-agent/interactive-agent";

describe("parseStructuredBoardButton", () => {
  it("parses a basic structured button", () => {
    const btn = parseStructuredBoardButton({
      speech: "I want water",
      sentence: "i_me+want+💧",
      label: "Water",
    });
    expect(btn).toMatchObject({
      sentence: "I want water",
      glyph: "i_me+want+💧",
      glyphFallback: undefined,
      label: "Water",
    });
  });

  it("preserves a speech field containing a comma (no fragmentation)", () => {
    // This is the regression: a comma in the speech field used to fragment
    // the pipe-encoded button, dropping the glyph and producing a default
    // fa-comment icon. The structured parser sees the field intact.
    const btn = parseStructuredBoardButton({
      speech: "כן, אני רוצה לדבר על זה",
      sentence: "yes+want+talk+that",
      label: "כן",
    });
    expect(btn).not.toBeNull();
    expect(btn!.sentence).toBe("כן, אני רוצה לדבר על זה");
    expect(btn!.glyph).toBe("yes+want+talk+that");
    expect(btn!.label).toBe("כן");
  });

  it("derives iconRef from a single-slot fallback emoji", () => {
    const btn = parseStructuredBoardButton({
      speech: "Hello",
      sentence: "generate:greeting",
      fallback: "👋",
      label: "Hi",
    });
    expect(btn!.iconRef).toBe("👋");
  });

  it("derives imageKey from a single-slot bare snake_case glyph (no emoji-swap)", () => {
    // A snake_case key NOT in the emoji registry routes to imageKey for
    // potential symbol generation.
    const btn = parseStructuredBoardButton({
      speech: "...",
      sentence: "fictional_unknown_concept_xyz",
      label: "Thing",
    });
    expect(btn!.imageKey).toBe("fictional_unknown_concept_xyz");
  });

  it("emoji-swaps a registered key on the glyph field", () => {
    // When the glyph is a registered emoji-key, the parser swaps iconRef
    // to the emoji and clears imageKey (no symbol generation needed).
    const btn = parseStructuredBoardButton({
      speech: "I'm happy",
      sentence: "happy",
      label: "Happy",
    });
    expect(btn!.imageKey).toBeUndefined();
    expect(btn!.iconRef).not.toBe("fas fa-comment");
  });

  it("strips [GUESS] prefix from label and tags buttonType", () => {
    const btn = parseStructuredBoardButton({
      speech: "It's a dog",
      sentence: "🐕",
      label: "[GUESS] Dog",
    });
    expect(btn!.label).toBe("Dog");
    expect(btn!.buttonType).toBe("guess");
  });

  it("strips [NARROW:dim] prefix and records dimension + value", () => {
    const btn = parseStructuredBoardButton({
      speech: "an animal",
      sentence: "🐾",
      label: "[NARROW:category] animal",
    });
    expect(btn!.label).toBe("animal");
    expect(btn!.buttonType).toBe("narrow");
    expect(btn!.narrowDimension).toBe("category");
    expect(btn!.narrowValue).toBe("animal");
  });

  it("returns null when label is missing", () => {
    const btn = parseStructuredBoardButton({
      speech: "x",
      sentence: "y",
    });
    expect(btn).toBeNull();
  });

  it("returns null on non-object input", () => {
    expect(parseStructuredBoardButton(null)).toBeNull();
    expect(parseStructuredBoardButton(undefined)).toBeNull();
    expect(parseStructuredBoardButton("just a string")).toBeNull();
  });

  it("preserves rowSpan/colSpan when >= 2", () => {
    const btn = parseStructuredBoardButton({
      speech: "big",
      sentence: "big",
      label: "Big",
      rowSpan: 2,
      colSpan: 3,
    });
    expect(btn!.rowSpan).toBe(2);
    expect(btn!.colSpan).toBe(3);
  });

  it("drops rowSpan/colSpan < 2", () => {
    const btn = parseStructuredBoardButton({
      speech: "x",
      sentence: "y",
      label: "Z",
      rowSpan: 1,
      colSpan: 1,
    });
    expect(btn!.rowSpan).toBeUndefined();
    expect(btn!.colSpan).toBeUndefined();
  });
});

describe("parseBoardButton (dispatcher)", () => {
  it("routes strings to the pipe parser", () => {
    // iconRef is derived from the FALLBACK slot's single-emoji, not the glyph slot
    // (the glyph compositor handles emoji glyphs directly).
    const btn = parseBoardButton("Hi|generate:wave|👋|Hello");
    expect(btn!.label).toBe("Hello");
    expect(btn!.iconRef).toBe("👋");
  });

  it("routes objects to the structured parser", () => {
    const btn = parseBoardButton({
      speech: "Hi",
      sentence: "generate:wave",
      fallback: "👋",
      label: "Hello",
    });
    expect(btn!.label).toBe("Hello");
    expect(btn!.iconRef).toBe("👋");
  });

  it("returns null for other inputs", () => {
    expect(parseBoardButton(42)).toBeNull();
    expect(parseBoardButton(true)).toBeNull();
    expect(parseBoardButton(null)).toBeNull();
  });
});
