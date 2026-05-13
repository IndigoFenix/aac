/**
 * Tests for the pure parsing + layout logic of the glyph compositor.
 * SVG rendering is exercised in client tests; here we cover string parsing,
 * serialization round-trips, layout math, and tone resolution.
 */

import { describe, it, expect } from "@jest/globals";
import {
  parseGlyph,
  serializeGlyph,
  computeLayout,
  dominantToneFamily,
  TONE_COLORS,
  SLOT_UNIT,
  EMPTY_GLYPH,
  pushSlot,
  replaceSlot,
  clearSlot,
  addModifier,
  removeModifier,
  setToneTags,
  mostRecentSlot,
  resolveActiveSlot,
} from "../../shared/glyph-compositor.js";

describe("parseGlyph", () => {
  it("parses a single bare key as a 1-slot glyph", () => {
    const g = parseGlyph("water");
    expect(g.slots.length).toBe(1);
    expect(g.slots[0]).toEqual({ key: "water", modifiers: [], unknown: false });
    expect(g.toneTags).toEqual([]);
  });

  it("flags an AI-generated key as unknown", () => {
    const g = parseGlyph("pikachu");
    expect(g.slots.length).toBe(1);
    expect(g.slots[0].unknown).toBe(true);
  });

  it("parses two slots with `+`", () => {
    const g = parseGlyph("i_me+want");
    expect(g.slots.map((s) => s.key)).toEqual(["i_me", "want"]);
  });

  it("parses three slots with modifiers", () => {
    const g = parseGlyph("i_me+want+water.big.two");
    expect(g.slots.length).toBe(3);
    expect(g.slots[2]).toEqual({
      key: "water",
      modifiers: ["big", "two"],
      unknown: false,
    });
  });

  it("parses a single tone tag", () => {
    const g = parseGlyph("help#question");
    expect(g.toneTags).toEqual(["question"]);
  });

  it("parses multiple tone tags with dotted-multi syntax", () => {
    const g = parseGlyph("help#question.exclamation");
    expect(g.toneTags).toEqual(["question", "exclamation"]);
  });

  it("ignores unknown tone tags but keeps known ones", () => {
    const g = parseGlyph("help#question.fakeworld");
    expect(g.toneTags).toEqual(["question"]);
  });

  it("deduplicates repeated tone tags", () => {
    const g = parseGlyph("help#question.question");
    expect(g.toneTags).toEqual(["question"]);
  });

  it("caps slots at 3", () => {
    const g = parseGlyph("a+b+c+d+e");
    expect(g.slots.length).toBe(3);
  });

  it("handles empty and whitespace input", () => {
    expect(parseGlyph("").slots).toEqual([]);
    expect(parseGlyph("   ").slots).toEqual([]);
    expect(parseGlyph(undefined as unknown as string).slots).toEqual([]);
  });

  it("is tolerant of malformed slots (empty `.` segments)", () => {
    const g = parseGlyph("water..big");
    expect(g.slots[0]).toEqual({
      key: "water",
      modifiers: ["big"],
      unknown: false,
    });
  });

  it("preserves the raw input", () => {
    const input = "i_me+want+water.big#question";
    const g = parseGlyph(input);
    expect(g.raw).toBe(input);
  });
});

describe("serializeGlyph", () => {
  it("round-trips a 3-slot glyph with modifiers and tone", () => {
    const input = "i_me+want+water.big.two#question.exclamation";
    const parsed = parseGlyph(input);
    expect(serializeGlyph(parsed)).toBe(input);
  });

  it("round-trips a bare key", () => {
    expect(serializeGlyph(parseGlyph("water"))).toBe("water");
  });

  it("drops empty slot keys", () => {
    const out = serializeGlyph({
      slots: [
        { key: "water", modifiers: [], unknown: false },
        { key: "", modifiers: [], unknown: true },
      ],
      toneTags: [],
      raw: "",
    });
    expect(out).toBe("water");
  });
});

describe("computeLayout", () => {
  it("single slot fills 100x100", () => {
    const parsed = parseGlyph("water");
    const l = computeLayout(parsed);
    expect(l.viewBoxWidth).toBe(SLOT_UNIT);
    expect(l.viewBoxHeight).toBe(SLOT_UNIT);
    expect(l.slots[0]).toMatchObject({ index: 0, x: 0, y: 0 });
  });

  it("three slots tile left-to-right in LTR", () => {
    const parsed = parseGlyph("a+b+c");
    const l = computeLayout(parsed, false);
    expect(l.viewBoxWidth).toBe(SLOT_UNIT * 3);
    expect(l.slots[0].x).toBe(0);
    expect(l.slots[1].x).toBe(SLOT_UNIT);
    expect(l.slots[2].x).toBe(SLOT_UNIT * 2);
  });

  it("three slots tile right-to-left in RTL", () => {
    const parsed = parseGlyph("a+b+c");
    const l = computeLayout(parsed, true);
    // slot 0 is rightmost in RTL, slot 2 is leftmost
    expect(l.slots[0].x).toBe(SLOT_UNIT * 2);
    expect(l.slots[1].x).toBe(SLOT_UNIT);
    expect(l.slots[2].x).toBe(0);
  });

  it("corner badge anchors top-right in LTR, top-left in RTL", () => {
    const parsed = parseGlyph("a+b#question");
    const ltr = computeLayout(parsed, false);
    expect(ltr.cornerBadge.x).toBeGreaterThan(SLOT_UNIT);
    const rtl = computeLayout(parsed, true);
    expect(rtl.cornerBadge.x).toBe(0);
  });

  it("empty glyph still produces a 1-slot layout (renderer shows placeholder)", () => {
    const l = computeLayout(parseGlyph(""));
    expect(l.viewBoxWidth).toBe(SLOT_UNIT);
    expect(l.slots.length).toBe(1);
  });
});

describe("dominantToneFamily", () => {
  it("question tag wins outright", () => {
    expect(dominantToneFamily(parseGlyph("water#question"))).toBe("question");
    expect(dominantToneFamily(parseGlyph("i_me+want#question"))).toBe("question");
  });

  it("verb's tone wins over non-verb slots", () => {
    // `i_me` is comment-toned, `want` is request-toned — request should win
    expect(dominantToneFamily(parseGlyph("i_me+want"))).toBe("request");
  });

  it("falls back to first slot's tone when no verb present", () => {
    // `mom` is social — should pick that
    expect(dominantToneFamily(parseGlyph("mom+water"))).toBe("social");
  });

  it("defaults to comment when nothing resolves", () => {
    expect(dominantToneFamily(parseGlyph("not_a_thing"))).toBe("comment");
    expect(dominantToneFamily(parseGlyph(""))).toBe("comment");
  });

  it("every tone family has a defined color", () => {
    for (const fam of ["request", "comment", "feeling", "social", "question"] as const) {
      expect(TONE_COLORS[fam]).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });
});

describe("pure glyph mutations", () => {
  it("pushSlot appends slots in order and caps at 3", () => {
    let g = EMPTY_GLYPH;
    g = pushSlot(g, "i_me");
    g = pushSlot(g, "want");
    g = pushSlot(g, "water");
    expect(g.slots.map((s) => s.key)).toEqual(["i_me", "want", "water"]);
    // 4th push is a no-op
    g = pushSlot(g, "more");
    expect(g.slots.length).toBe(3);
  });

  it("pushSlot marks unknown keys", () => {
    const g = pushSlot(EMPTY_GLYPH, "pikachu");
    expect(g.slots[0].unknown).toBe(true);
  });

  it("replaceSlot swaps in place, leaving other slots untouched", () => {
    let g = parseGlyph("i_me+want+water");
    g = replaceSlot(g, 1, "give");
    expect(g.slots.map((s) => s.key)).toEqual(["i_me", "give", "water"]);
  });

  it("replaceSlot is a no-op for out-of-range indices", () => {
    const g = parseGlyph("i_me");
    expect(replaceSlot(g, 5, "mom")).toBe(g);
    expect(replaceSlot(g, -1, "mom")).toBe(g);
  });

  it("clearSlot removes a slot and shifts later slots down", () => {
    let g = parseGlyph("i_me+want+water");
    g = clearSlot(g, 1);
    expect(g.slots.map((s) => s.key)).toEqual(["i_me", "water"]);
  });

  it("addModifier appends and dedupes", () => {
    let g = parseGlyph("water");
    g = addModifier(g, 0, "big");
    g = addModifier(g, 0, "big");
    g = addModifier(g, 0, "not");
    expect(g.slots[0].modifiers).toEqual(["big", "not"]);
  });

  it("removeModifier removes only the named modifier", () => {
    let g = parseGlyph("water.big.not");
    g = removeModifier(g, 0, "big");
    expect(g.slots[0].modifiers).toEqual(["not"]);
  });

  it("setToneTags dedupes and drops unknowns", () => {
    const g = setToneTags(EMPTY_GLYPH, [
      "question",
      "question",
      "exclamation",
      // @ts-expect-error — intentional invalid tag
      "fake_tag",
    ]);
    expect(g.toneTags).toEqual(["question", "exclamation"]);
  });

  it("mostRecentSlot returns last index, or null for empty", () => {
    expect(mostRecentSlot(EMPTY_GLYPH)).toBeNull();
    expect(mostRecentSlot(parseGlyph("a"))).toBe(0);
    expect(mostRecentSlot(parseGlyph("a+b+c"))).toBe(2);
  });

  it("resolveActiveSlot: explicit wins, else falls back to most-recent", () => {
    const g = parseGlyph("a+b+c");
    expect(resolveActiveSlot(g, 1)).toBe(1);
    expect(resolveActiveSlot(g, null)).toBe(2);
    expect(resolveActiveSlot(g, 99)).toBe(2);
    expect(resolveActiveSlot(EMPTY_GLYPH, null)).toBeNull();
  });

  it("pushSlot does not mutate the input", () => {
    const g = parseGlyph("a");
    const after = pushSlot(g, "b");
    expect(g.slots.length).toBe(1);
    expect(after.slots.length).toBe(2);
  });

  it("the resulting glyph round-trips through serialize/parse", () => {
    let g = EMPTY_GLYPH;
    g = pushSlot(g, "i_me");
    g = pushSlot(g, "want");
    g = pushSlot(g, "water");
    g = addModifier(g, 2, "big");
    g = setToneTags(g, ["question"]);
    const str = serializeGlyph(g);
    expect(str).toBe("i_me+want+water.big#question");
    const reparsed = parseGlyph(str);
    expect(reparsed.slots.map((s) => s.key)).toEqual(g.slots.map((s) => s.key));
    expect(reparsed.toneTags).toEqual(g.toneTags);
  });
});
