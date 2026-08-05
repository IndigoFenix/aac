// HOW A CIRCLE FORMS — the pure formation layer (conversation-form.ts): who
// opens, who is admitted, where a newcomer stands, and which conversation the
// camera is for. No world at all: the host collects the candidates, this decides.
// See planning-docs/games/world-engine/multi-entity-conversations.md §3f.

import { describe, it, expect } from "@jest/globals";
import { mulberry32, hashSeed } from "@shared/prng.js";
import {
  CONV_FORM,
  bystanderJoins,
  mayJoin,
  openerScore,
  pickConversationFocus,
  pickOpener,
  ringSlotFor,
  type FocusCandidate,
  type FormCandidate,
  type RingBody,
} from "@shared/world-engine/interaction/dialogue/conversation-form.js";
import { LOCAL_PLAYER_CID } from "@shared/world-engine/interaction/quest/player-identity.js";

const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The three points that matter on the opener's dial board. `keen` is lonely AND
 *  talkative (0.81), `neutral` is the featureless middle (0.25), and `mute` is
 *  lonely but silent — the same 0.09 score a chatty contented creature carries,
 *  which is the whole point of multiplying the two. */
const keen: FormCandidate = { id: "keen", social: 0.9, expressiveness: 0.9 };
const neutral: FormCandidate = { id: "neutral", social: 0.5, expressiveness: 0.5 };
const mute: FormCandidate = { id: "mute", social: 0.9, expressiveness: 0.1 };

/** Run `pickOpener` n times off ONE seeded stream and tally the winners. Seeded,
 *  so these frequencies are facts about the code rather than samples. */
function tallyOpeners(cands: readonly FormCandidate[], seed: string, draws = 500): Record<string, number> {
  const rng = mulberry32(hashSeed("convo", seed));
  const counts: Record<string, number> = {};
  for (let i = 0; i < draws; i++) {
    const id = pickOpener(cands, rng) ?? "";
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

/** The join probability, recovered to 3 decimals by sweeping the roll. Reading
 *  the curve this way keeps the monotonicity tests honest about the FUNCTION
 *  rather than about one lucky draw. */
function joinChance(openness: number, warmth: number): number {
  let hits = 0;
  for (let i = 0; i < 1000; i++) if (bystanderJoins(openness, warmth, () => i / 1000)) hits++;
  return hits / 1000;
}

/** Seat a whole ring the way the host will: one body per call, each recording the
 *  angle it was given and handing it straight back in. Returns the finished ring
 *  and the radius the LAST call settled on (the one the whole ring then uses). */
function growRing(radii: readonly number[]): { bodies: RingBody[]; ringR: number } {
  const bodies: RingBody[] = [];
  let ringR = 0;
  radii.forEach((radiusM, i) => {
    const slot = ringSlotFor(bodies, { radiusM });
    bodies.push({ id: `b${i}`, angle: slot.angle, radiusM });
    ringR = slot.ringR;
  });
  return { bodies, ringR };
}

/** The tightest neighbour gap on a formed ring, as SLACK: chord minus the two
 *  girths. THE law is that this never drops below `ringMarginM` — below zero is
 *  where `separateBodies` starts shoving members out of their own conversation. */
function worstClearance(bodies: readonly RingBody[], ringR: number): number {
  if (bodies.length < 2) return Infinity;
  const sorted = [...bodies].sort((a, b) => a.angle! - b.angle!);
  let worst = Infinity;
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    const b = sorted[(i + 1) % sorted.length]!;
    const delta = (((b.angle! - a.angle!) % TWO_PI) + TWO_PI) % TWO_PI;
    const chord = 2 * ringR * Math.sin(delta / 2);
    worst = Math.min(worst, chord - (a.radiusM + b.radiusM));
  }
  return worst;
}

// ---------------------------------------------------------------------------
// pickOpener — the seeded softmax
// ---------------------------------------------------------------------------

describe("openerScore — lonely AND talkative", () => {
  it("multiplies the need by the disposition, so one alone is not enough", () => {
    expect(openerScore(keen)).toBeCloseTo(0.81, 10);
    expect(openerScore(neutral)).toBeCloseTo(0.25, 10);
    expect(openerScore(mute)).toBeCloseTo(0.09, 10);
    // Lonely-but-silent and chatty-but-content are the SAME candidate to this
    // function — neither is the sort that starts something.
    expect(openerScore({ id: "chatty", social: 0.1, expressiveness: 0.9 })).toBeCloseTo(
      openerScore(mute),
      10,
    );
  });

  it("clamps out-of-range and NaN dials instead of poisoning the wheel", () => {
    expect(openerScore({ id: "x", social: 9, expressiveness: 9 })).toBe(1);
    expect(openerScore({ id: "x", social: -5, expressiveness: 0.5 })).toBe(0);
    expect(openerScore({ id: "x", social: NaN, expressiveness: NaN })).toBe(0);
  });
});

describe("pickOpener — nobody to ask", () => {
  it("an empty town has no opener, and costs no draw", () => {
    let draws = 0;
    expect(
      pickOpener([], () => {
        draws++;
        return 0.5;
      }),
    ).toBeNull();
    expect(draws).toBe(0);
  });

  it("consumes exactly ONE draw per call, whatever the candidate count", () => {
    let draws = 0;
    const rng = () => {
      draws++;
      return 0.5;
    };
    pickOpener([keen], rng);
    expect(draws).toBe(1);
    pickOpener([keen, neutral, mute], rng);
    expect(draws).toBe(2);
  });
});

describe("pickOpener — the weighting, read analytically", () => {
  // Weights exp(score/0.35): keen 10.118, neutral 2.043, mute 1.293 ⇒ the wheel
  // hands keen everything below 0.752, neutral to 0.904, mute the rest.
  const cands = [keen, neutral, mute];

  it("gives the lonely talkative creature three quarters of the wheel", () => {
    expect(pickOpener(cands, () => 0)).toBe("keen");
    expect(pickOpener(cands, () => 0.75)).toBe("keen");
    expect(pickOpener(cands, () => 0.8)).toBe("neutral");
    expect(pickOpener(cands, () => 0.9)).toBe("neutral");
    expect(pickOpener(cands, () => 0.95)).toBe("mute");
    expect(pickOpener(cands, () => 0.999999)).toBe("mute");
  });

  it("a single candidate opens whatever it rolls", () => {
    expect(pickOpener([mute], () => 0)).toBe("mute");
    expect(pickOpener([mute], () => 0.999)).toBe("mute");
  });
});

describe("pickOpener — favours the keen, and the tail stays live", () => {
  it("over 500 seeded draws the keen creature leads and the quiet one still opens", () => {
    const counts = tallyOpeners([keen, neutral, mute], "openers");
    expect((counts.keen ?? 0) / 500).toBeGreaterThan(0.6);
    expect((counts.keen ?? 0) / 500).toBeLessThan(0.9); // a favourite, not a monopoly
    expect(counts.neutral ?? 0).toBeGreaterThan(counts.mute ?? 0);
    expect(counts.mute ?? 0).toBeGreaterThan(0); // THE point of softmax over argmax
  });

  // Turn every dial to the same value and the wheel has nothing to prefer: who
  // opens becomes pure chance, which is the honest answer for identical creatures.
  it("identical candidates share the wheel evenly", () => {
    const same = ["a", "b", "c"].map((id) => ({ id, social: 0.5, expressiveness: 0.5 }));
    const counts = tallyOpeners(same, "identical");
    for (const id of ["a", "b", "c"]) {
      expect((counts[id] ?? 0) / 500).toBeGreaterThan(0.25);
      expect((counts[id] ?? 0) / 500).toBeLessThan(0.42);
    }
  });
});

describe("pickOpener — determinism", () => {
  it("the same seed gives the same openers, draw for draw", () => {
    const run = () => {
      const rng = mulberry32(hashSeed("convo", "opener-determinism"));
      return Array.from({ length: 200 }, () => pickOpener([keen, neutral, mute], rng));
    };
    expect(run()).toEqual(run());
  });

  it("a different seed gives a different transcript (the draw is real)", () => {
    const run = (seed: string) => {
      const rng = mulberry32(hashSeed("convo", seed));
      return Array.from({ length: 200 }, () => pickOpener([keen, neutral, mute], rng));
    };
    expect(run("seed-a")).not.toEqual(run("seed-b"));
  });
});

// ---------------------------------------------------------------------------
// bystanderJoins — openness × warmth
// ---------------------------------------------------------------------------

describe("bystanderJoins — the curve", () => {
  it("sits at 0.35 for a featureless bystander", () => {
    // joinBase 0.05 + span 0.6 × (0.6·0.5 + 0.4·0.5)
    expect(joinChance(0.5, 0.5)).toBeCloseTo(0.35, 3);
  });

  it("spans joinBase..joinCeil, and never reaches either certainty", () => {
    expect(joinChance(0, 0)).toBeCloseTo(CONV_FORM.joinBase, 3);
    expect(joinChance(1, 1)).toBeCloseTo(CONV_FORM.joinCeil, 3);
    // Even the warmest, most open bystander sometimes just walks on by …
    expect(bystanderJoins(1, 1, () => 0.99)).toBe(false);
    // … and the most guarded one is occasionally drawn in.
    expect(bystanderJoins(0, 0, () => 0.01)).toBe(true);
  });

  it("rises with OPENNESS at every fixed warmth", () => {
    for (const warmth of [0, 0.5, 1]) {
      const ladder = [0, 0.25, 0.5, 0.75, 1].map((o) => joinChance(o, warmth));
      for (let i = 1; i < ladder.length; i++) expect(ladder[i]!).toBeGreaterThan(ladder[i - 1]!);
    }
  });

  it("rises with WARMTH at every fixed openness", () => {
    for (const openness of [0, 0.5, 1]) {
      const ladder = [0, 0.25, 0.5, 0.75, 1].map((w) => joinChance(openness, w));
      for (let i = 1; i < ladder.length; i++) expect(ladder[i]!).toBeGreaterThan(ladder[i - 1]!);
    }
  });

  it("weights openness above warmth — the dial for walking up to strangers", () => {
    expect(joinChance(1, 0)).toBeGreaterThan(joinChance(0, 1));
  });

  it("clamps out-of-range and NaN dials to the ends of the curve", () => {
    expect(joinChance(9, 9)).toBeCloseTo(CONV_FORM.joinCeil, 3);
    expect(joinChance(-5, -5)).toBeCloseTo(CONV_FORM.joinBase, 3);
    expect(joinChance(NaN, NaN)).toBeCloseTo(CONV_FORM.joinBase, 3);
  });
});

describe("bystanderJoins — determinism", () => {
  it("the same seed gives the same joins, draw for draw", () => {
    const run = () => {
      const rng = mulberry32(hashSeed("convo", "bystander"));
      return Array.from({ length: 200 }, () => bystanderJoins(0.5, 0.5, rng));
    };
    const first = run();
    expect(run()).toEqual(first);
    // And the stream is actually being drawn from — not a constant answer.
    expect(new Set(first).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// mayJoin — the cap constrains NPCs only
// ---------------------------------------------------------------------------

describe("mayJoin — NPCs under the cap", () => {
  const npcs = (n: number) => Array.from({ length: n }, (_, i) => `resident_${i}`);

  it("admits an NPC while there is room and refuses it at the cap", () => {
    expect(mayJoin(npcs(CONV_FORM.maxMembers - 1), "resident_x")).toBe(true);
    expect(mayJoin(npcs(CONV_FORM.maxMembers), "resident_x")).toBe(false);
    expect(mayJoin([], "resident_x")).toBe(true);
  });

  it("never turns a PLAYER away, however full the ring is", () => {
    const full = npcs(CONV_FORM.maxMembers + 3);
    expect(mayJoin(full, LOCAL_PLAYER_CID)).toBe(true);
    expect(mayJoin(full, "player:abc")).toBe(true);
    expect(mayJoin(full, "resident_x")).toBe(false);
  });

  // The motivating case from the doc: a circle already full OF PLAYERS. Another
  // child may still join it; another NPC may not.
  it("a ring full of players still admits a player and refuses an NPC", () => {
    const players = [LOCAL_PLAYER_CID, "player:a", "player:b", "player:c", "player:d"];
    expect(players.length).toBe(CONV_FORM.maxMembers);
    expect(mayJoin(players, "player:e")).toBe(true);
    expect(mayJoin(players, "resident_1")).toBe(false);
  });

  it("re-admitting an existing member is a no-op, not an eviction", () => {
    const full = npcs(CONV_FORM.maxMembers);
    expect(mayJoin(full, full[0]!)).toBe(true);
  });

  it("has nobody to admit when the candidate has no id", () => {
    expect(mayJoin([], "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ringSlotFor — the circle
// ---------------------------------------------------------------------------

describe("ringSlotFor — the pair (n = 2)", () => {
  it("puts the second body opposite the first, at today's pair distance", () => {
    const slot = ringSlotFor([{ id: "a", angle: 0, radiusM: 0.4 }], { radiusM: 0.4 });
    expect(slot.angle).toBeCloseTo(Math.PI, 10);
    expect(slot.ringR).toBeCloseTo(1.4, 10);

    // 2.8 m apart: inside the host's 3.5 m converse contact gate, and nowhere
    // near the 0.8 m at which separation starts shoving.
    const apart = 2 * slot.ringR;
    expect(apart).toBeCloseTo(2.8, 10);
    expect(apart).toBeLessThan(3.5);
    expect(apart).toBeGreaterThan(0.4 + 0.4 + CONV_FORM.ringMarginM);
  });

  it("opens an empty ring at the reference direction", () => {
    const slot = ringSlotFor([], { radiusM: 0.4 });
    expect(slot.angle).toBe(0);
    expect(slot.ringR).toBeCloseTo(CONV_FORM.ringRadius(1), 10);
  });

  it("seats a member the host never placed rather than stacking bodies on one spoke", () => {
    const slot = ringSlotFor([{ id: "a", radiusM: 0.4 }], { radiusM: 0.4 });
    expect(slot.angle).toBeCloseTo(Math.PI, 10); // "a" was seated at 0
    expect(slot.ringR).toBeCloseTo(1.4, 10);
  });
});

describe("ringSlotFor — the newcomer takes the largest gap", () => {
  it("steps into the widest opening, not the nearest one", () => {
    // Three bodies over half the circle: the wide side is 0 → π the long way.
    const existing: RingBody[] = [
      { id: "a", angle: 0, radiusM: 0.4 },
      { id: "b", angle: Math.PI / 2, radiusM: 0.4 },
      { id: "c", angle: Math.PI, radiusM: 0.4 },
    ];
    expect(ringSlotFor(existing, { radiusM: 0.4 }).angle).toBeCloseTo((3 * Math.PI) / 2, 10);
  });

  it("breaks a tie on the earliest gap, so the answer never depends on arrival order", () => {
    const existing: RingBody[] = [
      { id: "a", angle: 0, radiusM: 0.4 },
      { id: "b", angle: Math.PI, radiusM: 0.4 },
    ];
    const shuffled = [existing[1]!, existing[0]!];
    expect(ringSlotFor(existing, { radiusM: 0.4 }).angle).toBeCloseTo(Math.PI / 2, 10);
    expect(ringSlotFor(shuffled, { radiusM: 0.4 })).toEqual(ringSlotFor(existing, { radiusM: 0.4 }));
  });

  it("normalizes whatever angles the host hands back in", () => {
    const wrapped = ringSlotFor([{ id: "a", angle: -TWO_PI, radiusM: 0.4 }], { radiusM: 0.4 });
    expect(wrapped.angle).toBeCloseTo(Math.PI, 10);
    expect(ringSlotFor([{ id: "a", angle: NaN, radiusM: 0.4 }], { radiusM: 0.4 }).angle).toBeCloseTo(
      Math.PI,
      10,
    );
  });
});

describe("ringSlotFor — no dance", () => {
  it("never revisits a seated member's angle as the ring grows", () => {
    const prefixes: number[][] = [];
    const bodies: RingBody[] = [];
    for (let i = 0; i < 5; i++) {
      const slot = ringSlotFor(bodies, { radiusM: 0.4 });
      bodies.push({ id: `b${i}`, angle: slot.angle, radiusM: 0.4 });
      prefixes.push(bodies.map((b) => b.angle!));
    }
    // Every step is the previous ring plus ONE angle — no reordering, no nudging.
    for (let i = 1; i < prefixes.length; i++) {
      expect(prefixes[i]!.slice(0, i)).toEqual(prefixes[i - 1]);
    }
    expect(prefixes.at(-1)).toEqual([0, Math.PI, Math.PI / 2, (3 * Math.PI) / 2, Math.PI / 4]);
  });

  it("is a pure function of the ring it is given", () => {
    const existing: RingBody[] = [
      { id: "a", angle: 0.4, radiusM: 0.4 },
      { id: "b", angle: 2.1, radiusM: 0.6 },
    ];
    expect(ringSlotFor(existing, { radiusM: 0.4 })).toEqual(ringSlotFor(existing, { radiusM: 0.4 }));
    expect(existing[0]!.angle).toBe(0.4); // and it mutates nothing
  });
});

describe("ringSlotFor — the clearance law", () => {
  it("holds for every uniform ring up to the cap", () => {
    for (let n = 2; n <= CONV_FORM.maxMembers + 1; n++) {
      const { bodies, ringR } = growRing(Array.from({ length: n }, () => 0.4));
      expect(worstClearance(bodies, ringR)).toBeGreaterThanOrEqual(CONV_FORM.ringMarginM - 1e-9);
      expect(ringR).toBeLessThanOrEqual(CONV_FORM.ringMaxRadiusM);
    }
  });

  it("holds for a MIXED ring — the bear widens the circle it stands in", () => {
    // A lopsided ring (angles a host read off three bodies standing together):
    // 0.3 rad apart is far tighter than any even split, so the girths bind.
    const tight = (radiusM: number): RingBody[] => [
      { id: "l", angle: 0, radiusM: 0.22 },
      { id: "m", angle: 0.3, radiusM },
      { id: "r", angle: 0.6, radiusM: 0.22 },
    ];

    const allHumans = ringSlotFor(tight(0.22), { radiusM: 0.22 });
    const withBear = ringSlotFor(tight(0.6), { radiusM: 0.22 });

    // Both are pushed past the ringRadius(4) floor by the tight gaps …
    expect(allHumans.ringR).toBeGreaterThan(CONV_FORM.ringRadius(4));
    // … and swapping ONE 0.22 human for a 0.6 bear widens it further still.
    expect(withBear.ringR).toBeGreaterThan(allHumans.ringR);
    expect(withBear.ringR).toBeCloseTo(0.97 / (2 * Math.sin(0.15)), 6);

    for (const [existing, slot] of [
      [tight(0.22), allHumans],
      [tight(0.6), withBear],
    ] as const) {
      const ring = [...existing, { id: "new", angle: slot.angle, radiusM: 0.22 }];
      expect(worstClearance(ring, slot.ringR)).toBeGreaterThanOrEqual(CONV_FORM.ringMarginM - 1e-9);
    }
  });

  it("never shrinks below the conversational floor for a girthless roster", () => {
    const { bodies, ringR } = growRing([0, 0, 0]);
    expect(ringR).toBeCloseTo(CONV_FORM.ringRadius(3), 10);
    expect(worstClearance(bodies, ringR)).toBeGreaterThan(CONV_FORM.ringMarginM);
  });

  it("caps a ring whose members share a spoke instead of returning Infinity", () => {
    const stacked: RingBody[] = [
      { id: "a", angle: 1, radiusM: 0.4 },
      { id: "b", angle: 1, radiusM: 0.4 },
    ];
    const slot = ringSlotFor(stacked, { radiusM: 0.4 });
    expect(Number.isFinite(slot.ringR)).toBe(true);
    expect(slot.ringR).toBe(CONV_FORM.ringMaxRadiusM);
    expect(Number.isFinite(slot.angle)).toBe(true);
  });

  it("survives a roster with no girths at all", () => {
    const slot = ringSlotFor(
      [{ id: "a", angle: 0, radiusM: NaN }, { id: "b", angle: 2, radiusM: -3 }],
      { radiusM: undefined as unknown as number },
    );
    expect(Number.isFinite(slot.ringR)).toBe(true);
    expect(slot.ringR).toBeCloseTo(CONV_FORM.ringRadius(3), 10);
  });
});

// ---------------------------------------------------------------------------
// pickConversationFocus — whose words the camera and the TTS follow
// ---------------------------------------------------------------------------

describe("pickConversationFocus — the player's own conversation wins", () => {
  const mine: FocusCandidate = { id: "mine", hasLocalPlayer: true, distM: 20, lastWordsAgoS: 60 };
  const lively: FocusCandidate = { id: "lively", hasLocalPlayer: false, distM: 1, lastWordsAgoS: 0 };

  it("beats a nearer, louder circle across the square", () => {
    expect(pickConversationFocus([lively, mine])).toBe("mine");
  });

  // The one that matters for a child mid-exchange: a creature thinking about its
  // reply must not cost them the camera.
  it("keeps focus through a long silence in the player's own conversation", () => {
    expect(pickConversationFocus([mine, lively], 1)).toBe("mine");
  });

  it("takes the nearest when the player is somehow in two", () => {
    const far = { ...mine, id: "far", distM: 30 };
    expect(pickConversationFocus([far, mine])).toBe("mine");
  });
});

describe("pickConversationFocus — else the nearest with words on screen", () => {
  const near = (over: Partial<FocusCandidate> = {}): FocusCandidate => ({
    id: "near",
    hasLocalPlayer: false,
    distM: 3,
    lastWordsAgoS: 1,
    ...over,
  });

  it("prefers the nearer of two talking circles", () => {
    expect(pickConversationFocus([near({ id: "far", distM: 9 }), near()])).toBe("near");
  });

  it("skips a nearer circle that has gone quiet past holdS", () => {
    const quiet = near({ id: "quiet", distM: 1, lastWordsAgoS: CONV_FORM.focusHoldS + 0.1 });
    expect(pickConversationFocus([quiet, near({ distM: 9 })])).toBe("near");
  });

  it("holds a circle right up to holdS and drops it after", () => {
    expect(pickConversationFocus([near({ lastWordsAgoS: CONV_FORM.focusHoldS })])).toBe("near");
    expect(pickConversationFocus([near({ lastWordsAgoS: CONV_FORM.focusHoldS + 0.01 })])).toBeNull();
  });

  it("takes holdS from the caller when the camera wants a shorter leash", () => {
    expect(pickConversationFocus([near({ lastWordsAgoS: 3 })], 2)).toBeNull();
    expect(pickConversationFocus([near({ lastWordsAgoS: 3 })], 4)).toBe("near");
  });

  it("focuses NOTHING when every circle has gone quiet", () => {
    expect(pickConversationFocus([near({ lastWordsAgoS: 30 }), near({ id: "b", lastWordsAgoS: 99 })])).toBeNull();
  });

  it("breaks a distance tie on the host's own order", () => {
    expect(pickConversationFocus([near({ id: "first" }), near({ id: "second" })])).toBe("first");
  });
});

describe("pickConversationFocus — edges", () => {
  it("an empty square focuses nothing", () => {
    expect(pickConversationFocus([])).toBeNull();
  });

  it("is deterministic and non-mutating", () => {
    const cands: FocusCandidate[] = [
      { id: "a", hasLocalPlayer: false, distM: 5, lastWordsAgoS: 2 },
      { id: "b", hasLocalPlayer: false, distM: 4, lastWordsAgoS: 2 },
    ];
    const snapshot = JSON.stringify(cands);
    expect(pickConversationFocus(cands)).toBe(pickConversationFocus(cands));
    expect(JSON.stringify(cands)).toBe(snapshot);
  });

  it("ranks an unmeasurable distance last rather than dropping the candidate", () => {
    const broken: FocusCandidate = { id: "broken", hasLocalPlayer: false, distM: NaN, lastWordsAgoS: 1 };
    const fine: FocusCandidate = { id: "fine", hasLocalPlayer: false, distM: 50, lastWordsAgoS: 1 };
    expect(pickConversationFocus([broken, fine])).toBe("fine");
    expect(pickConversationFocus([broken])).toBe("broken");
  });
});
