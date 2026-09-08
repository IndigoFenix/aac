// How a creature regards another → compliance (relations.ts). The attitude layer
// that makes society rules suggestions, not law. Pure — safe in default `npm test`.

import { describe, it, expect } from "@jest/globals";
import {
  baselineRelation,
  compliance,
  DEFAULT_RELATION,
  deference,
  K_PRESSURE,
  makeRelation,
  nudgeFromGift,
  nudgeFromOutcome,
  nudgeFromThreat,
  nudgeFromYield,
  nudgeRelation,
  type Relation,
} from "@shared/world-engine/interaction/behavior/relations.js";
import {
  makePersonality,
  NEUTRAL_PERSONALITY,
  personalityFromPreset,
} from "@shared/world-engine/interaction/behavior/personality.js";
import { yieldGate, yieldRoute } from "@shared/world-engine/interaction/behavior/willingness.js";

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

// ⓘ THE `RelationBook` BLOCK WAS DELETED, not moved. `createRelationBook` /
// `getRelation` / `setRelation` / `nudgeInBook` had ZERO call sites outside
// these three cases — the live host keeps its own `Map<"observer|subject">` and
// never imported them — so the politics round deleted the family rather than
// carry a second, divergent store into a round that adds an axis to every
// relation. The behaviours those cases pinned (default fallback, DIRECTEDNESS,
// accumulation) are pinned on the functions that actually ship: `makeRelation`
// defaults below, and `nudgeRelation` accumulation in "relation clamping +
// nudges". Nothing that ran in the engine lost coverage.

// ---------------------------------------------------------------------------
// ⑨ THE FEAR AXIS + THE NOISY-OR (politics-substrate-round.md S-1)
// ---------------------------------------------------------------------------

describe("fear — the fourth axis", () => {
  it("is REQUIRED, defaults to 0 everywhere, and clamps like the others", () => {
    expect(DEFAULT_RELATION.fear).toBe(0);
    expect(baselineRelation(makePersonality({ warmth: 1, openness: 1 })).fear).toBe(0);
    expect(makeRelation({}).fear).toBe(0);
    expect(makeRelation({ fear: 5 }).fear).toBe(1);
    expect(makeRelation({ fear: -3 }).fear).toBe(0);
  });

  it("nudgeRelation carries it (and accumulates)", () => {
    const once = nudgeRelation(DEFAULT_RELATION, { fear: 0.2 });
    expect(once.fear).toBeCloseTo(0.2);
    expect(nudgeRelation(once, { fear: 0.2 }).fear).toBeCloseTo(0.4);
  });
});

describe("deference — the RATIFIED noisy-OR (owner's ruling ③)", () => {
  const grid: Relation[] = [];
  for (const fear of [0, 0.5, 1]) {
    for (const authority of [0, 0.4, 0.9]) {
      for (const trust of [0, 0.5, 1]) {
        for (const affinity of [-1, 0, 0.8]) {
          grid.push(makeRelation({ affinity, trust, authority, fear }));
        }
      }
    }
  }
  const people = [NEUTRAL_PERSONALITY, makePersonality({ assertiveness: 1 }), personalityFromPreset("soldier")];

  it("🚨 WITH NO ctx IT IS `compliance`, EXACTLY (===, not close-to) — the bench guarantee", () => {
    for (const rel of grid) {
      expect(deference(rel)).toBe(compliance(rel));
      for (const p of people) expect(deference(rel, p)).toBe(compliance(rel, p));
    }
  });

  it("🚨 fear 0 ⇒ identity for ANY ctx — a fearless relation cannot be coerced", () => {
    for (const rel of grid.filter((r) => r.fear === 0)) {
      for (const ctx of [{ certainty: 1 }, { certainty: 1, pressure: 3 }, { pressure: 9 }]) {
        expect(deference(rel, NEUTRAL_PERSONALITY, ctx)).toBe(compliance(rel, NEUTRAL_PERSONALITY));
      }
    }
  });

  it("certainty 0 ⇒ identity even at full fear — an unseen defiance costs nothing", () => {
    const scared = makeRelation({ fear: 1 });
    expect(deference(scared, NEUTRAL_PERSONALITY, { certainty: 0, pressure: 5 })).toBe(
      compliance(scared, NEUTRAL_PERSONALITY),
    );
  });

  it("is monotone in fear, in certainty and in pressure", () => {
    const p = NEUTRAL_PERSONALITY;
    const at = (fear: number, certainty: number, pressure = 0) =>
      deference(makeRelation({ trust: 0.3, fear }), p, { certainty, pressure });
    expect(at(0.6, 1)).toBeGreaterThan(at(0.3, 1));
    expect(at(0.6, 1)).toBeGreaterThan(at(0.6, 0.5));
    expect(at(0.3, 0.5, 1)).toBeGreaterThan(at(0.3, 0.5, 0));
    // K_PRESSURE = 1 means FULL pressure exactly doubles the coerced term.
    expect(K_PRESSURE).toBe(1);
    expect(at(0.2, 0.5, 1)).toBeCloseTo(at(0.4, 0.5, 0));
  });

  it("SATURATES: an already-total earned route stays 1 whatever the coercion", () => {
    const total = makeRelation({ affinity: 1, trust: 1, authority: 1 });
    expect(compliance(total)).toBe(1);
    expect(deference(total, NEUTRAL_PERSONALITY, { certainty: 1 })).toBe(1);
    expect(deference(makeRelation({ affinity: 1, trust: 1, authority: 1, fear: 1 }), NEUTRAL_PERSONALITY, { certainty: 1 })).toBe(1);
  });

  it("the obedience floor still applies on top of the coerced route", () => {
    const stranger = makeRelation({ fear: 0.5 });
    const drone = personalityFromPreset("drone");
    expect(deference(stranger, drone, { certainty: 1 })).toBe(1);
    const soldier = makePersonality({ obedience: 0.75 });
    expect(deference(stranger, soldier, { certainty: 1 })).toBeGreaterThan(0.75);
  });

  it("never leaves 0..1", () => {
    const wild = makeRelation({ affinity: 0.9, trust: 1, authority: 1, fear: 1 });
    const d = deference(wild, NEUTRAL_PERSONALITY, { certainty: 1, pressure: 100 });
    expect(d).toBeLessThanOrEqual(1);
    expect(d).toBeGreaterThanOrEqual(0);
  });
});

describe("the outcome / threat / yield nudges (M1 + §S-1)", () => {
  it("an order that HELPED earns AUTHORITY (and a little trust); one that failed takes it back", () => {
    const base = makeRelation({ authority: 0.5, trust: 0.5 });
    const helped = nudgeFromOutcome(base, { helped: true });
    expect(helped.authority).toBeCloseTo(0.56);
    expect(helped.trust).toBeCloseTo(0.52);
    const failed = nudgeFromOutcome(base, { helped: false });
    expect(failed.authority).toBeCloseTo(0.46);
    expect(failed.trust).toBeCloseTo(0.48);
    // authority moves FASTER than trust in both directions — one errand says a
    // lot about the right to direct and little about judgment.
    expect(helped.authority - base.authority).toBeGreaterThan(helped.trust - base.trust);
  });

  it("magnitude scales it, and it never moves affinity or fear", () => {
    const base = makeRelation({ authority: 0.2, trust: 0.2, affinity: 0.4, fear: 0.3 });
    const big = nudgeFromOutcome(base, { helped: true, magnitude: 3 });
    expect(big.authority - base.authority).toBeCloseTo(3 * 0.06);
    expect(big.affinity).toBe(base.affinity);
    expect(big.fear).toBe(base.fear);
  });

  it("a THREAT buys fear and costs liking — a credibility-0 threat buys nothing but the insult", () => {
    const base = DEFAULT_RELATION;
    const backed = nudgeFromThreat(base, { credibility: 1 });
    expect(backed.fear).toBeCloseTo(0.2);
    expect(backed.affinity).toBeCloseTo(-0.08);
    const empty = nudgeFromThreat(base, { credibility: 0 });
    expect(empty.fear).toBe(0);
    expect(empty.affinity).toBeCloseTo(-0.08); // the affinity cost is FLAT
    expect(backed.authority).toBe(base.authority); // 🚨 a threat NEVER earns authority
  });

  it("a YIELD by the EARNED route buys authority; by the COERCED route it buys fear and costs liking", () => {
    const base = makeRelation({ affinity: 0.2, authority: 0.2, fear: 0.1 });
    const prestige = nudgeFromYield(base, { route: "L" });
    expect(prestige.authority).toBeCloseTo(0.28);
    expect(prestige.fear).toBe(base.fear);
    expect(prestige.affinity).toBe(base.affinity);
    const dominance = nudgeFromYield(base, { route: "C" });
    expect(dominance.authority).toBe(base.authority); // 🚨 ruling ③, in one line
    expect(dominance.fear).toBeCloseTo(0.18);
    expect(dominance.affinity).toBeCloseTo(0.16);
  });
});

describe("yieldGate — pressure beats resistance (S-5)", () => {
  const neutral = NEUTRAL_PERSONALITY;

  it("a neutral STRANGER is never yielded to, witnessed or not", () => {
    expect(yieldGate(neutral, DEFAULT_RELATION, {})).toBe(false);
    expect(yieldGate(neutral, DEFAULT_RELATION, { certainty: 1 })).toBe(false);
    // fear 0 + authority 0 is every relation that ships today.
    expect(yieldGate(neutral, makeRelation({ affinity: 0.8 }), { certainty: 1 })).toBe(false);
  });

  it("a FAMILY-strength relation (authority 0.8) DOES yield — the first real case", () => {
    const family = makeRelation({ affinity: 0.5, trust: 0.8, authority: 0.8 });
    expect(yieldGate(neutral, family, {})).toBe(true);
    expect(yieldGate(neutral, family, { certainty: 1 })).toBe(true);
  });

  it("an ASSERTIVE body resists more (same relation, opposite answer)", () => {
    const family = makeRelation({ affinity: 0.5, trust: 0.8, authority: 0.8 });
    expect(yieldGate(makePersonality({ assertiveness: 0 }), family, {})).toBe(true);
    expect(yieldGate(makePersonality({ assertiveness: 1 }), family, {})).toBe(false);
  });

  it("🚨 INNATE OBEDIENCE ALONE IS NOT A YIELD — the asker must hold a CLAIM", () => {
    // `deference` folds in the obedience FLOOR, which is a disposition toward
    // COMMANDERS. An easy-going creature toward somebody with no standing and
    // nothing to threaten with is not yielding — that conversation already
    // happened at the generosity step. Without this the whole
    // `willingness-probability` suite moves (a `companion` would hand anything
    // to anyone), which is how the guard was found.
    const easyGoing = personalityFromPreset("companion"); // obedience 0.35
    expect(deference(DEFAULT_RELATION, easyGoing)).toBeGreaterThan(0.2 + 0.6 * 0.2); // over the bar…
    expect(yieldGate(easyGoing, DEFAULT_RELATION, {})).toBe(false); // …and still no yield
    expect(yieldGate(personalityFromPreset("drone"), makeRelation({ affinity: 0.9 }), { certainty: 1 })).toBe(false);
    // A claim — recognized standing, or a cost to refusing that WOULD be seen.
    expect(yieldGate(easyGoing, makeRelation({ authority: 0.4 }), {})).toBe(true);
    expect(yieldGate(easyGoing, makeRelation({ fear: 0.9 }), { certainty: 1 })).toBe(true);
  });

  it("fear + a WITNESS can carry a yield an earned relation never would", () => {
    const feared = makeRelation({ fear: 0.9 });
    expect(yieldGate(neutral, feared, { certainty: 0 })).toBe(false); // unseen ⇒ no pressure
    expect(yieldGate(neutral, feared, { certainty: 1 })).toBe(true);
  });

  it("the ROUTE is 'C' exactly when fear·certainty outweighs the earned route", () => {
    const feared = makeRelation({ fear: 0.9 });
    expect(yieldRoute(neutral, feared, 1)).toBe("C");
    expect(yieldRoute(neutral, feared, 0)).toBe("L");
    const family = makeRelation({ affinity: 0.5, trust: 0.8, authority: 0.8 });
    expect(yieldRoute(neutral, family, 1)).toBe("L"); // no fear ⇒ never coerced
    expect(yieldRoute(neutral, makeRelation({ ...family, fear: 0.9 }), 1)).toBe("C");
  });
});
