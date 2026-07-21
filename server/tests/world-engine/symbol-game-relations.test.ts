// How a creature regards another → compliance (relations.ts). The attitude layer
// that makes society rules suggestions, not law. Pure — safe in default `npm test`.

import { describe, it, expect } from "@jest/globals";
import {
  baselineRelation,
  compliance,
  createRelationBook,
  DEFAULT_RELATION,
  getRelation,
  makeRelation,
  nudgeFromGift,
  nudgeInBook,
  nudgeRelation,
  setRelation,
} from "@shared/world-engine/interaction/behavior/relations.js";
import {
  makePersonality,
  NEUTRAL_PERSONALITY,
  personalityFromPreset,
} from "@shared/world-engine/interaction/behavior/personality.js";

describe("compliance — the command-following weight", () => {
  it("a neutral stranger is near-ignored", () => {
    expect(compliance(DEFAULT_RELATION)).toBeLessThan(0.15);
  });

  it("a liked, trusted, recognized commander is reliably obeyed", () => {
    const pet = makeRelation({ affinity: 0.7, trust: 0.8, authority: 0.9 });
    expect(compliance(pet)).toBeGreaterThan(0.7);
  });

  it("a resented authority drags its feet despite standing", () => {
    const boss = makeRelation({ affinity: -0.9, trust: 0.3, authority: 0.9 });
    const liked = makeRelation({ affinity: 0.9, trust: 0.3, authority: 0.9 });
    expect(compliance(boss)).toBeLessThan(compliance(liked));
    expect(compliance(boss)).toBeLessThan(0.45); // affinity gate really bites
  });

  it("authority is the primary driver (dominates trust at equal levels)", () => {
    const byAuthority = makeRelation({ authority: 0.8, trust: 0 });
    const byTrust = makeRelation({ authority: 0, trust: 0.8 });
    expect(compliance(byAuthority)).toBeGreaterThan(compliance(byTrust));
  });

  it("is monotonic in each axis (more never hurts)", () => {
    const base = makeRelation({ affinity: 0, trust: 0.5, authority: 0.5 });
    expect(compliance(nudgeRelation(base, { authority: 0.3 }))).toBeGreaterThan(compliance(base));
    expect(compliance(nudgeRelation(base, { trust: 0.3 }))).toBeGreaterThan(compliance(base));
    expect(compliance(nudgeRelation(base, { affinity: 0.3 }))).toBeGreaterThan(compliance(base));
  });
});

describe("compliance — genome-aware temperament (social-bot unification)", () => {
  const rel = makeRelation({ affinity: 0.4, trust: 0.6, authority: 0.7 });

  it("NEUTRAL_PERSONALITY matches the no-personality result exactly", () => {
    expect(compliance(rel, NEUTRAL_PERSONALITY)).toBeCloseTo(compliance(rel));
  });

  it("an assertive creature obeys the SAME commander less; a yielding one more", () => {
    const stubborn = makePersonality({ assertiveness: 1 });
    const yielding = makePersonality({ assertiveness: 0 });
    expect(compliance(rel, stubborn)).toBeLessThan(compliance(rel));
    expect(compliance(rel, yielding)).toBeGreaterThan(compliance(rel));
  });

  it("patience and warmth nudge compliance up", () => {
    expect(compliance(rel, makePersonality({ patience: 1 }))).toBeGreaterThan(compliance(rel));
    expect(compliance(rel, makePersonality({ warmth: 1 }))).toBeGreaterThan(compliance(rel));
  });

  it("the obedience floor lets a drone obey a total STRANGER (no relationship)", () => {
    const stranger = DEFAULT_RELATION; // authority 0, no bond
    expect(compliance(stranger)).toBeLessThan(0.15); // a normal creature ignores a stranger
    expect(compliance(stranger, makePersonality({ obedience: 1 }))).toBe(1); // a drone obeys anyway
  });

  it("a soldier (high floor) mostly complies without a bond; the relation still adds on top", () => {
    const soldier = makePersonality({ obedience: 0.75 });
    const toStranger = compliance(DEFAULT_RELATION, soldier);
    const toCommander = compliance(makeRelation({ authority: 0.9, trust: 0.8 }), soldier);
    expect(toStranger).toBeGreaterThan(0.7);
    expect(toCommander).toBeGreaterThan(toStranger); // earned respect stacks on the floor
  });
});

describe("personality presets — non-standard characters are just points, not types", () => {
  it("a drone obeys anyone; a wild creature obeys almost no one", () => {
    const stranger = DEFAULT_RELATION;
    expect(compliance(stranger, personalityFromPreset("drone"))).toBe(1);
    expect(compliance(stranger, personalityFromPreset("wildcreature"))).toBeLessThan(0.1);
  });

  it("the 'unit' preset is fully compliant regardless of relationship", () => {
    expect(compliance(makeRelation({ affinity: -1 }), personalityFromPreset("unit"))).toBe(1);
  });

  it("a ruler takes no orders itself (obedience floor 0), even from an authority", () => {
    // The ruler's OWN compliance is low; others deferring to IT lives in their relation.authority.
    const ruler = personalityFromPreset("ruler");
    expect(compliance(makeRelation({ authority: 0.9, trust: 0.9 }), ruler)).toBeLessThan(
      compliance(makeRelation({ authority: 0.9, trust: 0.9 })),
    );
  });

  it("presets accept per-dial overrides", () => {
    expect(personalityFromPreset("drone", { warmth: 0.9 }).warmth).toBe(0.9);
    expect(personalityFromPreset("drone", { warmth: 0.9 }).obedience).toBe(1); // preset value kept
  });
});

describe("baselineRelation — genome seeds a stranger's starting relation", () => {
  it("a warm creature extends goodwill; a cold one starts near zero affinity", () => {
    expect(baselineRelation(makePersonality({ warmth: 1 })).affinity).toBeGreaterThan(0.2);
    expect(baselineRelation(makePersonality({ warmth: 0 })).affinity).toBeLessThan(-0.2);
  });

  it("authority is never innate — always earned", () => {
    expect(baselineRelation(makePersonality({ warmth: 1, openness: 1 })).authority).toBe(0);
  });
});

describe("relation clamping + nudges", () => {
  it("makeRelation clamps out-of-range values", () => {
    const r = makeRelation({ affinity: 5, trust: -3, authority: 2 });
    expect(r.affinity).toBe(1);
    expect(r.trust).toBe(0);
    expect(r.authority).toBe(1);
  });

  it("a gift raises affinity and a little trust, and saturates (can't max in one)", () => {
    const before = DEFAULT_RELATION;
    const after = nudgeFromGift(before, 3);
    expect(after.affinity).toBeGreaterThan(before.affinity);
    expect(after.trust).toBeGreaterThan(before.trust);
    expect(after.affinity).toBeLessThan(1);
  });
});

describe("relation book — directed store with default fallback", () => {
  it("unknown pairs read as the neutral default", () => {
    const book = createRelationBook();
    expect(getRelation(book, "bear", "player")).toEqual(DEFAULT_RELATION);
  });

  it("relations are DIRECTED (bear→player need not equal player→bear)", () => {
    const book = createRelationBook();
    setRelation(book, "bear", "player", makeRelation({ authority: 0.9 }));
    expect(getRelation(book, "bear", "player").authority).toBe(0.9);
    expect(getRelation(book, "player", "bear").authority).toBe(0); // untouched
  });

  it("nudgeInBook accumulates in place", () => {
    const book = createRelationBook();
    nudgeInBook(book, "bear", "player", { affinity: 0.2 });
    nudgeInBook(book, "bear", "player", { affinity: 0.2 });
    expect(getRelation(book, "bear", "player").affinity).toBeCloseTo(0.4);
  });
});
