// server/tests/input-glyphs-serialize.test.ts
//
// Experiment (glyphInputTranslation): `serializeInputGlyphs` turns a tool
// call's `input_glyphs` arg into one {glyph, fallback} per SENTENCE for the
// translation strip. Covers the multi-sentence shape, single-sentence shape,
// the backward-compatible flat shape, `gen`→fallback handling, and junk input.

import { serializeInputGlyphs } from "../services/dual-agent/interactive-agent";

describe("serializeInputGlyphs", () => {
  test("array of SENTENCES → one entry per sentence, in order", () => {
    const out = serializeInputGlyphs([
      [{ sym: "👋" }, { sym: "hello" }],
      [{ sym: "how" }, { sym: "you" }, { sym: "❓" }],
    ]);
    expect(out).toEqual([
      { glyph: "👋+hello" },
      { glyph: "how+you+❓" },
    ]);
  });

  test("single sentence wrapped in one inner array → one entry", () => {
    const out = serializeInputGlyphs([[{ sym: "want" }, { sym: "go" }, { sym: "🌳" }]]);
    expect(out).toEqual([{ glyph: "want+go+🌳" }]);
  });

  test("backward-compat: a FLAT array of glyph objects is treated as one sentence", () => {
    const out = serializeInputGlyphs([{ sym: "want" }, { sym: "water" }]);
    expect(out).toEqual([{ glyph: "want+water" }]);
  });

  test("a `gen` glyph yields both the generated key and a fallback string", () => {
    const out = serializeInputGlyphs([
      [{ sym: "i_me" }, { gen: "planet_mars", fb: { sym: "🌑" } }],
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].glyph).toBe("i_me+generate:planet_mars");
    expect(out[0].fallback).toBe("i_me+🌑");
  });

  test("empty sentences are dropped; an all-empty input yields []", () => {
    expect(serializeInputGlyphs([[], [{ sym: "ok" }], []])).toEqual([{ glyph: "ok" }]);
    expect(serializeInputGlyphs([])).toEqual([]);
    expect(serializeInputGlyphs(undefined)).toEqual([]);
    expect(serializeInputGlyphs("nope")).toEqual([]);
  });
});
