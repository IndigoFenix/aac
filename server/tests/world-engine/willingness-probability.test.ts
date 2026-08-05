// PROBABILISTIC WILLINGNESS (multi-entity-conversations.md §3d) — the same
// scores, read through a soft edge instead of a hard threshold, plus ATTEND, the
// fourth member of the gate family (compliance=DO, generosity=GIVE,
// sociability=JOIN, attend=ANSWER).
//
// What this suite is really guarding is that fuzzy did NOT mean unlearnable:
// the curve is strictly monotone (every dial still moves the creature the way it
// used to) and saturating (a game that seeds a strong bond gets near-certainty,
// which is how cause and effect stays teachable). It also pins the existing
// exported gates, because nothing here is allowed to have changed them yet.
//
// The curve functions are pure — they produce probabilities and never draw. The
// DRAW is the last three sections: `selectAct`'s give/invite arms rolling against
// the curve from `ctx.rng`, the legacy no-rng path proving byte-identity, and the
// authored `meta.playerRelation` knob that makes a fixed game deterministic
// again.

import { describe, it, expect } from "@jest/globals";
import {
  attend,
  gateProbability,
  gateTemperature,
  generosity,
  sociability,
  willingnessToJoin,
} from "@shared/world-engine/interaction/behavior/willingness.js";
import {
  DEFAULT_RELATION,
  compliance,
  makeRelation,
  type Relation,
} from "@shared/world-engine/interaction/behavior/relations.js";
import {
  NEUTRAL_PERSONALITY,
  makePersonality,
  personalityFromPreset,
  type Personality,
} from "@shared/world-engine/interaction/behavior/personality.js";
import {
  selectAct,
  type DialogueAct,
  type ProjectionOpts,
} from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";
import { createCreatureWorld } from "@shared/world-engine/interaction/behavior/creatures.js";
import { VOLUNTEER_COMPLIANCE } from "@shared/world-engine/interaction/behavior/task-pool.js";
import { hashSeed, mulberry32 } from "@shared/prng.js";

/** Samples of a one-argument function over [lo,hi], for monotonicity checks. */
function ramp(f: (v: number) => number, lo = 0, hi = 1, steps = 40): number[] {
  return Array.from({ length: steps + 1 }, (_, i) => f(lo + ((hi - lo) * i) / steps));
}

function isStrictlyIncreasing(xs: number[]): boolean {
  return xs.every((v, i) => i === 0 || v > xs[i - 1]!);
}

function isNonDecreasing(xs: number[]): boolean {
  return xs.every((v, i) => i === 0 || v >= xs[i - 1]!);
}

describe("gateProbability — a soft edge on the OLD threshold", () => {
  it("is exactly a coin flip AT the threshold (\"just barely willing\" always was)", () => {
    expect(gateProbability(0.7, 0.7, 0.1)).toBeCloseTo(0.5, 12);
    expect(gateProbability(0.35, 0.35, 0.02)).toBeCloseTo(0.5, 12);
    expect(gateProbability(0, 0, 0.18)).toBeCloseTo(0.5, 12);
  });

  it("is STRICTLY INCREASING in score — no decision inverts, so no tuning is undone", () => {
    for (const t of [0.02, 0.1, 0.18]) {
      expect(isStrictlyIncreasing(ramp((s) => gateProbability(s, 0.5, t)))).toBe(true);
    }
  });

  it("stays a probability in [0,1] across the whole score range", () => {
    for (const p of ramp((s) => gateProbability(s, 0.5, 0.1), -2, 3, 100)) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      expect(Number.isFinite(p)).toBe(true);
    }
  });

  it("SATURATES to near-certainty well above the bar — the fixed-game pedagogy mechanism", () => {
    // A game seeds the player high authority/affinity; the score lands far up
    // the curve and the creature answers essentially always.
    expect(gateProbability(0.9, 0.5, 0.02)).toBeGreaterThan(0.999);
    expect(gateProbability(1.0, 0.35, 0.02)).toBeGreaterThan(0.999);
  });

  it("…and to near-zero well below it — a clear no never surprises with a lucky yes", () => {
    expect(gateProbability(0.1, 0.5, 0.02)).toBeLessThan(0.001);
    expect(gateProbability(0, 0.35, 0.02)).toBeLessThan(0.001);
  });

  it("is SYMMETRIC about the threshold (equal distances mirror to 1−p)", () => {
    expect(gateProbability(0.6, 0.5, 0.1) + gateProbability(0.4, 0.5, 0.1)).toBeCloseTo(1, 12);
  });

  it("a HIGHER temperature is a softer edge — closer to the coin flip on both sides", () => {
    const hot = gateProbability(0.65, 0.5, 0.18);
    const cold = gateProbability(0.65, 0.5, 0.02);
    expect(cold).toBeGreaterThan(hot); // above the bar: colder ⇒ more certain yes
    expect(hot).toBeGreaterThan(0.5);
    expect(gateProbability(0.35, 0.5, 0.18)).toBeGreaterThan(gateProbability(0.35, 0.5, 0.02));
  });

  it("survives a degenerate temperature (0 / negative) as a steep curve, never NaN", () => {
    for (const t of [0, -1]) {
      // Steep but still a curve: strict near the bar, and never non-finite
      // anywhere (far out it saturates to the representable 0 and 1).
      expect(isStrictlyIncreasing(ramp((s) => gateProbability(s, 0.5, t), 0.4, 0.6))).toBe(true);
      const wide = ramp((s) => gateProbability(s, 0.5, t), -1, 2, 100);
      expect(wide.every(Number.isFinite)).toBe(true);
      expect(isNonDecreasing(wide)).toBe(true);
      expect(gateProbability(0.5, 0.5, t)).toBeCloseTo(0.5, 12);
    }
  });
});

describe("gateTemperature — volatile creatures are noisy, stable ones near-deterministic", () => {
  it("spans 0.02 (perfectly stable) … 0.18 (fully volatile)", () => {
    expect(gateTemperature(makePersonality({ stability: 1 }))).toBeCloseTo(0.02, 12);
    expect(gateTemperature(makePersonality({ stability: 0 }))).toBeCloseTo(0.18, 12);
    expect(gateTemperature(NEUTRAL_PERSONALITY)).toBeCloseTo(0.1, 12);
  });

  it("DECREASES with stability, and never leaves those bounds", () => {
    const xs = ramp((stability) => gateTemperature(makePersonality({ stability })));
    expect(isStrictlyIncreasing([...xs].reverse())).toBe(true); // strictly decreasing
    for (const t of xs) {
      expect(t).toBeGreaterThanOrEqual(0.02);
      expect(t).toBeLessThanOrEqual(0.18);
    }
  });

  it("a `unit`/`drone` (stability 1) is effectively the old HARD threshold", () => {
    const t = gateTemperature(personalityFromPreset("unit"));
    expect(gateProbability(0.45, 0.35, t)).toBeGreaterThan(0.99); // clears ⇒ yes
    expect(gateProbability(0.25, 0.35, t)).toBeLessThan(0.01); // short ⇒ no
  });

  it("an `oddball` (stability 0.2) is a genuine maybe near the bar", () => {
    const t = gateTemperature(personalityFromPreset("oddball"));
    const p = gateProbability(0.4, 0.35, t);
    expect(p).toBeGreaterThan(0.55);
    expect(p).toBeLessThan(0.85);
  });
});

describe("attend — the ANSWER gate", () => {
  const neutral = () => attend(NEUTRAL_PERSONALITY, DEFAULT_RELATION, 0);

  it("sits mid-scale for a neutral creature toward a stranger it is not engaged with", () => {
    // 0.45·0.5 + 0.35·0.5 + 0.2·0 = 0.4
    expect(neutral()).toBeCloseTo(0.4, 12);
  });

  it("is monotone in EXPRESSIVENESS (a quiet creature stays quiet even among friends)", () => {
    const xs = ramp((expressiveness) =>
      attend(makePersonality({ expressiveness }), makeRelation({ affinity: 0.5 }), 0.5),
    );
    expect(isStrictlyIncreasing(xs)).toBe(true);
  });

  it("is monotone in AFFINITY across the full signed range", () => {
    const xs = ramp(
      (affinity) => attend(NEUTRAL_PERSONALITY, makeRelation({ affinity }), 0.5),
      -1,
      1,
    );
    expect(isStrictlyIncreasing(xs)).toBe(true);
  });

  it("is monotone in ENGAGEMENT — the one LIVE term in the family", () => {
    const xs = ramp((engagement) => attend(NEUTRAL_PERSONALITY, DEFAULT_RELATION, engagement));
    expect(isStrictlyIncreasing(xs)).toBe(true);
    expect(xs.at(-1)!).toBeCloseTo(0.6, 12); // 0.4 + 0.2
  });

  it("reaches the ends of [0,1] exactly, and clamps beyond them", () => {
    const most = attend(makePersonality({ expressiveness: 1 }), makeRelation({ affinity: 1 }), 1);
    const least = attend(makePersonality({ expressiveness: 0 }), makeRelation({ affinity: -1 }), 0);
    expect(most).toBeCloseTo(1, 12);
    expect(least).toBeCloseTo(0, 12);
    // Out-of-range inputs saturate rather than escaping the unit interval.
    const over = attend({ ...NEUTRAL_PERSONALITY, expressiveness: 5 }, makeRelation({ affinity: 9 }), 7);
    const under = attend({ ...NEUTRAL_PERSONALITY, expressiveness: -5 }, makeRelation({ affinity: -9 }), -7);
    expect(over).toBeLessThanOrEqual(1);
    expect(over).toBeCloseTo(1, 12);
    expect(under).toBe(0);
  });

  it("stays in [0,1] over a sweep of the whole dial space", () => {
    for (const e of [0, 0.25, 0.5, 0.75, 1]) {
      for (const a of [-1, -0.4, 0, 0.4, 1]) {
        for (const g of [0, 0.5, 1]) {
          const v = attend(makePersonality({ expressiveness: e }), makeRelation({ affinity: a }), g);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("a talkative creature answers a stranger more readily than a reticent friend does", () => {
    const talkativeStranger = attend(
      makePersonality({ expressiveness: 0.95 }),
      makeRelation({ affinity: 0 }),
      0.5,
    );
    const quietFriend = attend(
      makePersonality({ expressiveness: 0.1 }),
      makeRelation({ affinity: 0.9 }),
      0.5,
    );
    expect(talkativeStranger).toBeGreaterThan(quietFriend);
  });

  it("composes with the curve: engaged + liked + expressive ⇒ answers as good as always", () => {
    const p = personalityFromPreset("companion", { expressiveness: 0.9, stability: 0.8 });
    const urge = attend(p, makeRelation({ affinity: 0.9, trust: 0.8, authority: 0.8 }), 1);
    expect(gateProbability(urge, 0.4, gateTemperature(p))).toBeGreaterThan(0.99);
  });
});

describe("the existing gates are UNCHANGED (zero behavior change is the acceptance bar)", () => {
  it("generosity still returns its current numbers", () => {
    // 0.55·warmth + 0.55·affinity01 − 0.1, clamped.
    expect(generosity(NEUTRAL_PERSONALITY, DEFAULT_RELATION)).toBeCloseTo(0.45, 12);
    expect(generosity(personalityFromPreset("companion"), makeRelation({ affinity: 0.8 }))).toBeCloseTo(
      0.8625,
      12,
    );
    expect(generosity(makePersonality({ warmth: 0.1 }), makeRelation({ affinity: -0.5 }))).toBeCloseTo(
      0.0925,
      12,
    );
    expect(generosity(makePersonality({ warmth: 0 }), makeRelation({ affinity: -1 }))).toBe(0);
  });

  it("sociability is still exactly generosity (one formula, deliberately)", () => {
    for (const w of [0, 0.35, 0.5, 1]) {
      for (const a of [-1, 0, 0.6, 1]) {
        const p = makePersonality({ warmth: w });
        const r = makeRelation({ affinity: a });
        expect(sociability(p, r)).toBe(generosity(p, r));
      }
    }
  });

  it("willingnessToJoin still admits a neutral asker and still refuses a cold refusal", () => {
    expect(willingnessToJoin()).toBe(true); // neutral/neutral = 0.45 ≥ 0.35
    expect(willingnessToJoin({ personality: makePersonality({ warmth: 0.1 }), relation: makeRelation({ affinity: -0.5 }) })).toBe(
      false,
    );
    // …and a firing need still overrides the social gate outright.
    expect(
      willingnessToJoin({
        personality: makePersonality({ warmth: 0.1 }),
        relation: makeRelation({ affinity: -0.5 }),
        level: 1,
      }),
    ).toBe(true);
  });

  it("attend is NOT a copy of generosity — it reads a different set of dials", () => {
    const p = makePersonality({ warmth: 1, expressiveness: 0 });
    const r = makeRelation({ affinity: 0.5 });
    expect(attend(p, r, 0.5)).not.toBeCloseTo(generosity(p, r), 6);
  });
});

describe("the gate family is still monotone end-to-end through the curve", () => {
  it("a warmer owner is never less likely to give (score ↑ ⇒ probability ↑)", () => {
    const xs = ramp((warmth) =>
      gateProbability(
        generosity(makePersonality({ warmth }), DEFAULT_RELATION),
        0.7,
        gateTemperature(NEUTRAL_PERSONALITY),
      ),
    );
    expect(isStrictlyIncreasing(xs)).toBe(true);
    expect(isNonDecreasing(xs)).toBe(true);
  });

  it("the old hard answer and the soft one agree wherever the score is not borderline", () => {
    const t = gateTemperature(makePersonality({ stability: 0.9 }));
    for (const warmth of [0, 0.1, 0.9, 1]) {
      const p = makePersonality({ warmth });
      const r = makeRelation({ affinity: warmth > 0.5 ? 0.9 : -0.9 });
      const score = sociability(p, r);
      const hard = score >= 0.35;
      const soft = gateProbability(score, 0.35, t);
      expect(hard ? soft > 0.99 : soft < 0.01).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE DRAW — the gates as the game actually runs them
// ═══════════════════════════════════════════════════════════════════════════
//
// Everything above is arithmetic on probabilities. What follows runs the two
// fuzzy gates through the REAL dialogue arms — `selectAct`'s `request`
// (generosity) and `invite` (sociability) — with the turn's seeded stream
// arriving exactly where the host puts it, on `DialogueCtx.rng`. The pinned
// property is the WIRING: that the stream reaches the gate, that only the
// judgment step is fuzzy, and that no-stream means the old answer to the byte.

/** Bear holds ONE cookie and wants nothing. Both facts are load-bearing: with no
 *  open need it quotes no counter-price (so the request reaches the verdict), and
 *  with a single cookie it has no SURPLUS (so a failed generosity draw is a real
 *  refusal and not a fall-through to step 5). Fresh per call — selectAct mutates. */
function askWorld() {
  return createCreatureWorld(
    [{ id: "bear" }, { id: "me" }],
    [{ id: "cookie1", ownerId: "bear", kind: "cookie" }],
  );
}

const REQUEST: DialogueAct = { kind: "request", itemId: "cookie1", glyph: "i_me + want + cookie" };
const INVITE: DialogueAct = { kind: "invite", verb: "eat", glyph: "eat + with + i_me" };

/** The two dials the gates read, plus a `canJoin` that always says the gathering
 *  is physically possible — so an invite's answer is purely the SOCIAL half. */
function dialogueOpts(personality: Personality, relation: Relation): ProjectionOpts {
  return {
    symbolOf: (id) => id,
    personalityOf: () => personality,
    relationOf: () => relation,
    canJoin: () => true,
  };
}

/** Did "give me the cookie" actually hand it over? `undefined` rng = the legacy
 *  path (no stream at all), which is how every caller that predates §3d calls in. */
function gave(personality: Personality, relation: Relation, rng?: () => number): boolean {
  const w = askWorld();
  const res = selectAct(w, "bear", "me", REQUEST, "c", dialogueOpts(personality, relation), rng ? { rng } : undefined);
  return res.responseGlyph === "yes";
}

/** Did "come and eat with me" get an "ok"? */
function joined(personality: Personality, relation: Relation, rng?: () => number): boolean {
  const w = askWorld();
  const res = selectAct(w, "bear", "me", INVITE, "c", dialogueOpts(personality, relation), rng ? { rng } : undefined);
  return res.responseGlyph === "ok";
}

/** A draw that always CLEARS the gate (0 < p for every real probability). */
const ALWAYS = () => 0;
/** …and one that never does: above every probability the curve produces short of
 *  saturation, so it fails a genuine maybe and a warm friend alike. */
const NEVER = () => 0.999999;

const STRANGER = { personality: NEUTRAL_PERSONALITY, relation: DEFAULT_RELATION }; // generosity 0.45 — under the 0.7 bar
const FRIEND = {
  personality: personalityFromPreset("companion"),
  relation: makeRelation({ affinity: 0.8 }),
}; // generosity 0.8625 — over it

describe("the give gate through selectAct — ctx.rng decides what a threshold used to", () => {
  it("a passing draw gifts what the hard bar refused (the stranger's lucky day)", () => {
    expect(generosity(STRANGER.personality, STRANGER.relation)).toBeLessThan(0.7);
    expect(gave(STRANGER.personality, STRANGER.relation, ALWAYS)).toBe(true);
  });

  it("a failing draw refuses what the hard bar granted (even a friend can say no)", () => {
    expect(generosity(FRIEND.personality, FRIEND.relation)).toBeGreaterThan(0.7);
    expect(gave(FRIEND.personality, FRIEND.relation, NEVER)).toBe(false);
  });

  it("SATURATION beats the unlucky roll: a stable creature with a strong bond still gives", () => {
    // The fixed-game guarantee end to end — this is what `meta.playerRelation`
    // buys. Score far above the bar × a near-deterministic temperament ⇒ the
    // probability is past 0.999, so even a 0.999 roll clears it.
    const bonded = personalityFromPreset("companion", { stability: 1 });
    const relation = makeRelation({ affinity: 0.9, trust: 0.8, authority: 0.9 });
    expect(gave(bonded, relation, () => 0.999)).toBe(true);
  });

  it("only the JUDGMENT is fuzzy — a bound keepsake is refused on a perfect roll", () => {
    const w = askWorld();
    w.items.cookie1!.bound = true;
    const res = selectAct(w, "bear", "me", REQUEST, "c", dialogueOpts(FRIEND.personality, FRIEND.relation), {
      rng: ALWAYS,
    });
    expect(res.responseGlyph).not.toBe("yes"); // step 1 is bedrock, not a coin flip
  });

  it("…and a covering DEBT is settled on the worst roll (step 2 is bedrock too)", () => {
    const w = askWorld();
    w.creatures.bear!.debts.me = 5; // ≥ the cookie's value
    const res = selectAct(w, "bear", "me", REQUEST, "c", dialogueOpts(STRANGER.personality, STRANGER.relation), {
      rng: NEVER,
    });
    expect(res.responseGlyph).toBe("yes");
  });
});

describe("the join gate through selectAct — the same stream, the other verdict", () => {
  it("a passing draw accepts an invitation a cold creature would have refused", () => {
    const cold = makePersonality({ warmth: 0.1 });
    const dislike = makeRelation({ affinity: -0.5 });
    expect(sociability(cold, dislike)).toBeLessThan(0.35);
    expect(joined(cold, dislike, ALWAYS)).toBe(true);
  });

  it("a failing draw refuses one a neutral creature would have accepted", () => {
    expect(sociability(NEUTRAL_PERSONALITY, DEFAULT_RELATION)).toBeGreaterThan(0.35);
    expect(joined(NEUTRAL_PERSONALITY, DEFAULT_RELATION, NEVER)).toBe(false);
  });

  it("WANTING the activity is never a draw — a firing need accepts on the worst roll", () => {
    // The `level >= 1` branch stays deterministic (you do not turn down dinner you
    // are hungry for because of a roll). Exercised on the gate directly: the invite
    // arm has no meter to pass, so this is where that branch lives.
    expect(
      willingnessToJoin({
        personality: makePersonality({ warmth: 0.1 }),
        relation: makeRelation({ affinity: -0.5 }),
        level: 1,
        rng: NEVER,
      }),
    ).toBe(true);
  });
});

describe("seed reproducibility — the same stream is the same world", () => {
  /** The affinity that lands `generosity` EXACTLY on the free-gift bar for this
   *  warmth: a true coin flip, which is the only place a reproducibility test can
   *  see the stream at all (anywhere else saturation would answer for it). */
  const borderlineAffinity = (warmth: number) => (0.7 + 0.1 - 0.55 * warmth) / 0.275 - 1;

  const p = makePersonality({ warmth: 0.9 });
  const r = makeRelation({ affinity: borderlineAffinity(0.9) });

  /** The host's keying (quest-host `convoRng`): one FRESH generator per TURN,
   *  keyed by world seed, conversation and turn — never one stream for a session. */
  const turnRng = (seed: number, turn: number) => mulberry32(hashSeed(seed, "convo", "bear", turn));
  const transcript = (seed: number) =>
    Array.from({ length: 12 }, (_, turn) => gave(p, r, turnRng(seed, turn)));

  it("sits on the bar, so every turn is genuinely undecided", () => {
    expect(generosity(p, r)).toBeCloseTo(0.7, 12);
    expect(gateProbability(generosity(p, r), 0.7, gateTemperature(p))).toBeCloseTo(0.5, 12);
  });

  it("the same seed replays the same verdicts, ask for ask", () => {
    expect(transcript(4242)).toEqual(transcript(4242));
  });

  it("a per-TURN key really varies — asking twice is a new question, not a rerun", () => {
    const t = transcript(4242);
    expect(t).toContain(true);
    expect(t).toContain(false);
  });

  it("a different world seed is a different world", () => {
    expect(transcript(4242)).not.toEqual(transcript(99));
  });
});

describe("the LEGACY path — no rng means the old hard thresholds, unchanged", () => {
  it("give: the stranger is refused and the friend is gifted, exactly as before", () => {
    expect(gave(STRANGER.personality, STRANGER.relation)).toBe(false);
    expect(gave(FRIEND.personality, FRIEND.relation)).toBe(true);
  });

  it("join: the neutral asker is admitted and the cold refusal stands", () => {
    expect(joined(NEUTRAL_PERSONALITY, DEFAULT_RELATION)).toBe(true);
    expect(joined(makePersonality({ warmth: 0.1 }), makeRelation({ affinity: -0.5 }))).toBe(false);
  });

  it("the boundary is still `>=` — a score exactly ON the bar passes without a draw", () => {
    const p = makePersonality({ warmth: 0.5 });
    const r = makeRelation({ affinity: (0.35 + 0.1 - 0.55 * 0.5) / 0.275 - 1 });
    expect(sociability(p, r)).toBeCloseTo(0.35, 12);
    expect(willingnessToJoin({ personality: p, relation: r })).toBe(true); // hard: >=
    expect(willingnessToJoin({ personality: p, relation: r, rng: NEVER })).toBe(false); // soft: a coin flip
  });

  it("a creature just SHORT of the bar is still refused with no stream", () => {
    const p = makePersonality({ warmth: 0.5 });
    const r = makeRelation({ affinity: (0.35 + 0.1 - 0.55 * 0.5) / 0.275 - 1 - 0.01 });
    expect(sociability(p, r)).toBeLessThan(0.35);
    expect(willingnessToJoin({ personality: p, relation: r })).toBe(false);
    expect(willingnessToJoin({ personality: p, relation: r, rng: ALWAYS })).toBe(true);
  });
});

describe("meta.playerRelation — the authority knob a fixed game seeds (decision 2)", () => {
  /** The household bond quest-host falls back to for a family member. */
  const FAMILY: Relation = { affinity: 0.5, trust: 0.8, authority: 0.8 };

  /**
   * quest-host's exported `authoredRelation`, MIRRORED — the host module cannot be
   * value-imported here (its chain reaches a `.tsx`, which this jest config does
   * not transform; every other host-adjacent suite in this folder mirrors for the
   * same reason). Kept to ONE expression so the mirror is checkable by eye against
   * the original, and the rules it encodes are asserted below rather than assumed.
   */
  const authoredRelation = (
    meta: { playerRelation?: Partial<Relation> },
    fallback: Relation = DEFAULT_RELATION,
  ): Relation => (meta.playerRelation ? { ...DEFAULT_RELATION, ...meta.playerRelation } : fallback);

  it("a plain stranger never clears the volunteer bar — which is why the knob exists", () => {
    expect(compliance(authoredRelation({}))).toBeLessThan(VOLUNTEER_COMPLIANCE);
  });

  it("seeded authority 0.9 clears an order gate that DEFAULT_RELATION fails", () => {
    const seeded = authoredRelation({ playerRelation: { authority: 0.9 } });
    expect(seeded.authority).toBe(0.9);
    expect(compliance(DEFAULT_RELATION)).toBeLessThan(VOLUNTEER_COMPLIANCE);
    expect(compliance(seeded)).toBeGreaterThanOrEqual(VOLUNTEER_COMPLIANCE);
  });

  it("no knob ⇒ the family/stranger fallback stands (free play keeps its fuzz)", () => {
    expect(authoredRelation({}, FAMILY)).toEqual(FAMILY);
    expect(authoredRelation({})).toEqual(DEFAULT_RELATION);
  });

  it("the knob speaks OVER the family fallback, and unset axes come from the default", () => {
    // Not a merge with whatever standing the household happened to grant:
    // `{authority: 0.9}` means exactly that, so a game can seed a commanding but
    // unloved figure as deliberately as a beloved one.
    expect(authoredRelation({ playerRelation: { authority: 0.9 } }, FAMILY)).toEqual({
      affinity: DEFAULT_RELATION.affinity,
      trust: DEFAULT_RELATION.trust,
      authority: 0.9,
    });
  });

  it("and the SATURATION payoff: a seeded bond makes the fuzzy give gate certain", () => {
    // The whole argument for decision 2 in one assertion. A fixed game seeds the
    // standing; the monotone-saturating curve turns it into near-certainty; the
    // child asks and the thing happens, roll or no roll.
    const seeded = authoredRelation({ playerRelation: { affinity: 0.95, trust: 0.9, authority: 0.9 } });
    const steady = personalityFromPreset("companion", { stability: 1 });
    expect(gateProbability(generosity(steady, seeded), 0.7, gateTemperature(steady))).toBeGreaterThan(0.999);
    expect(gave(steady, seeded, () => 0.999)).toBe(true);
    // …while the same creature toward an UNSEEDED player is a genuine maybe.
    expect(gave(steady, DEFAULT_RELATION, () => 0.999)).toBe(false);
  });
});
