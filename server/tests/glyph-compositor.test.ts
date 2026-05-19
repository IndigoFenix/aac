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
  MAX_SLOTS,
  EMPTY_GLYPH,
  pushSlot,
  replaceSlot,
  clearSlot,
  addModifier,
  removeModifier,
  setPayload,
  clearPayload,
  setToneTags,
  mostRecentSlot,
  resolveActiveSlot,
  canResolveGlyph,
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

  it("caps slots at MAX_SLOTS", () => {
    // Build a glyph string with twice the cap; the parser must clamp.
    const overflow = Array.from({ length: MAX_SLOTS * 2 }, (_, i) => `k${i}`).join("+");
    const g = parseGlyph(overflow);
    expect(g.slots.length).toBe(MAX_SLOTS);
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

  it("parses a composable host with a payload", () => {
    const g = parseGlyph("want(water)");
    expect(g.slots[0].key).toBe("want");
    expect(g.slots[0].payload).toBe("water");
    expect(g.slots[0].payloadUnknown).toBe(false);
    expect(g.slots[0].modifiers).toEqual([]);
  });

  it("parses host(payload) combined with modifiers", () => {
    const g = parseGlyph("want(water).please");
    expect(g.slots[0]).toMatchObject({
      key: "want",
      payload: "water",
      modifiers: ["please"],
    });
  });

  it("flags an unknown payload key", () => {
    const g = parseGlyph("want(pikachu)");
    expect(g.slots[0].payload).toBe("pikachu");
    expect(g.slots[0].payloadUnknown).toBe(true);
  });

  it("empty parens produce no payload", () => {
    const g = parseGlyph("want()");
    expect(g.slots[0].key).toBe("want");
    expect(g.slots[0].payload).toBeUndefined();
  });

  it("payload form survives across multiple slots", () => {
    const g = parseGlyph("i_me+want(water)+please");
    expect(g.slots.map((s) => s.key)).toEqual(["i_me", "want", "please"]);
    expect(g.slots[1].payload).toBe("water");
  });

  it("strips [] brackets around slot keys (legacy imageKey marker)", () => {
    // Brackets are the previous syntax — still tolerated for backward
    // compat. The parser ignores them and resolves the inner key normally.
    const generated = parseGlyph("[pikachu]");
    expect(generated.slots[0].key).toBe("pikachu");
    expect(generated.slots[0].unknown).toBe(true);

    const canonical = parseGlyph("[water]");
    expect(canonical.slots[0].key).toBe("water");
    expect(canonical.slots[0].unknown).toBe(false);

    const compound = parseGlyph("i_me+want+[planet_mars]");
    expect(compound.slots.map((s) => s.key)).toEqual(["i_me", "want", "planet_mars"]);
    expect(compound.slots[2].unknown).toBe(true);

    const inPayload = parseGlyph("want([volcano])");
    expect(inPayload.slots[0].payload).toBe("volcano");
    expect(inPayload.slots[0].payloadUnknown).toBe(true);

    const inModifier = parseGlyph("water.[spicy]");
    expect(inModifier.slots[0].modifiers).toEqual(["spicy"]);
  });

  it("strips `generate:` prefix from slot keys (current imageKey marker)", () => {
    // `generate:` is the current AI-facing syntax — the prompt steers the
    // model toward it instead of brackets to avoid the bracket character
    // tripping Vertex's function-call serializer. Behavior matches
    // brackets: inner key resolves normally (canonical wins when present).
    const generated = parseGlyph("generate:pikachu");
    expect(generated.slots[0].key).toBe("pikachu");
    expect(generated.slots[0].unknown).toBe(true);

    const canonical = parseGlyph("generate:water");
    expect(canonical.slots[0].key).toBe("water");
    expect(canonical.slots[0].unknown).toBe(false);

    const compound = parseGlyph("i_me+want+generate:planet_mars");
    expect(compound.slots.map((s) => s.key)).toEqual(["i_me", "want", "planet_mars"]);
    expect(compound.slots[2].unknown).toBe(true);

    const inPayload = parseGlyph("want(generate:volcano)");
    expect(inPayload.slots[0].payload).toBe("volcano");
    expect(inPayload.slots[0].payloadUnknown).toBe(true);

    const inModifier = parseGlyph("water.generate:spicy");
    expect(inModifier.slots[0].modifiers).toEqual(["spicy"]);
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

  it("round-trips a host with payload + modifier", () => {
    const input = "want(water).please";
    expect(serializeGlyph(parseGlyph(input))).toBe(input);
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
  it("pushSlot appends slots in order and caps at MAX_SLOTS", () => {
    let g = EMPTY_GLYPH;
    // The first three pushes still produce the canonical 3-slot sentence
    // shape (subject + verb + object) — historically the common case.
    g = pushSlot(g, "i_me");
    g = pushSlot(g, "want");
    g = pushSlot(g, "water");
    expect(g.slots.map((s) => s.key)).toEqual(["i_me", "want", "water"]);
    // Fill up to the cap.
    for (let i = g.slots.length; i < MAX_SLOTS; i++) {
      g = pushSlot(g, `extra${i}`);
    }
    expect(g.slots.length).toBe(MAX_SLOTS);
    // Pushes beyond the cap are no-ops.
    g = pushSlot(g, "overflow");
    expect(g.slots.length).toBe(MAX_SLOTS);
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

  it("setPayload only succeeds on composable hosts", () => {
    // `want` is composable
    let g = parseGlyph("want");
    g = setPayload(g, 0, "blicket_unknown_key");
    expect(g.slots[0].payload).toBe("blicket_unknown_key");
    expect(g.slots[0].payloadUnknown).toBe(true); // made-up key not in registry

    g = setPayload(g, 0, "water");
    expect(g.slots[0].payload).toBe("water");
    expect(g.slots[0].payloadUnknown).toBe(false);

    // `i_me` is not composable — should be a no-op
    const before = parseGlyph("i_me");
    const after = setPayload(before, 0, "water");
    expect(after.slots[0].payload).toBeUndefined();
  });

  it("clearPayload removes the payload but keeps the host", () => {
    let g = parseGlyph("give(water)");
    expect(g.slots[0].payload).toBe("water");
    g = clearPayload(g, 0);
    expect(g.slots[0].payload).toBeUndefined();
    expect(g.slots[0].key).toBe("give");
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

describe("canResolveGlyph — custom symbols", () => {
  // `symbol:<id>` is an explicit custom-symbol reference. canResolveKey
  // treats it as resolvable so canResolveGlyph doesn't force the whole
  // glyph onto its fallback string just because the slot isn't in the
  // registry. The actual URL is constructed by the client resolver.
  it("treats a bare symbol:<id> as resolvable", () => {
    expect(canResolveGlyph("symbol:abc123")).toBe(true);
  });

  it("treats symbol:<id> as resolvable inside a multi-slot glyph", () => {
    // i_me and want are canonical; the symbol slot would previously have
    // tipped canResolveGlyph to false and the renderer would have used
    // the fallback string — now it can render the glyph directly.
    expect(canResolveGlyph("i_me+want+symbol:abc")).toBe(true);
  });

  it("treats symbol:<id> as resolvable as a payload", () => {
    expect(canResolveGlyph("want(symbol:abc)")).toBe(true);
  });

  it("still falls back when an unknown bare key is used", () => {
    // A snake_case key that the compositor can't resolve (no registry
    // entry, no emoji, no cached symbol) is NOT resolvable — that's the
    // path that forces the fallback string until generation lands.
    expect(canResolveGlyph("pikachu")).toBe(false);
  });

  it("treats face:<id> as resolvable (renders 👤 when no cache hit)", () => {
    // Like symbol:, face: is always resolvable. The client-side
    // resolver may return null when no face is cached, which sends the
    // slot to its emoji fallback — and resolveEmoji maps `face:` to
    // 👤 so the slot never shows ❓.
    expect(canResolveGlyph("face:contact-123")).toBe(true);
    expect(canResolveGlyph("i_me+see+face:contact-123")).toBe(true);
  });
});
