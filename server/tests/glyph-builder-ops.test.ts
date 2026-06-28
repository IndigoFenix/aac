/**
 * Tests for the shared SENTENCE BUILDER ops (server/../shared/glyph-builder-ops),
 * the common source the AAC and clinician builders both use for modifier
 * mutation, quality pole-cycling, and pending-join consumption.
 */

import { describe, it, expect } from "@jest/globals";
import {
  applyExclusiveModifier,
  cycleQualityPole,
  pushSlotWithJoin,
} from "../../shared/glyph-builder-ops.js";
import { parseGlyph, serializeGlyph } from "../../shared/glyph-compositor.js";

describe("applyExclusiveModifier", () => {
  it("keeps one member of a transform family at a time (amount/gauge)", () => {
    let g = parseGlyph("cookie");
    g = applyExclusiveModifier(g, 0, "some", "gauge");
    expect(g.slots[0].modifiers).toEqual(["some"]);
    // Picking another gauge value replaces the first.
    g = applyExclusiveModifier(g, 0, "all", "gauge");
    expect(g.slots[0].modifiers).toEqual(["all"]);
    // Tapping the active one again removes it.
    g = applyExclusiveModifier(g, 0, "all", "gauge");
    expect(g.slots[0].modifiers).toEqual([]);
  });
});

describe("cycleQualityPole", () => {
  it("cycles none → positive → negative → none", () => {
    let g = parseGlyph("dog");
    g = cycleQualityPole(g, 0, "good", "bad");
    expect(g.slots[0].modifiers).toEqual(["good"]);
    g = cycleQualityPole(g, 0, "good", "bad");
    expect(g.slots[0].modifiers).toEqual(["bad"]);
    g = cycleQualityPole(g, 0, "good", "bad");
    expect(g.slots[0].modifiers).toEqual([]);
  });
});

describe("pushSlotWithJoin", () => {
  it("pushes a slot and attaches an armed join", () => {
    const g0 = parseGlyph("apple");
    const g1 = pushSlotWithJoin(g0, "🍌", "or");
    expect(g1.slots.map((s) => s.key)).toEqual(["apple", "🍌"]);
    expect(g1.slots[1].join).toBe("or");
    expect(serializeGlyph(g1)).toBe("apple+or+🍌");
  });

  it("pushes without a join when none is armed", () => {
    const g1 = pushSlotWithJoin(parseGlyph("apple"), "🍌", null);
    expect(g1.slots[1].join).toBeUndefined();
    expect(serializeGlyph(g1)).toBe("apple+🍌");
  });
});
