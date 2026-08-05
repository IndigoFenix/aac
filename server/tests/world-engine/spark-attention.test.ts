// server/tests/world-engine/spark-attention.test.ts
//
// The pure attention-field mapping (planning-docs/games/world-engine/attention-spark.md):
// object → motive, ramp/decay, and the effective-meter bonus. The host wiring
// (hover detection, ctx.meter injection, announce) is covered in the quest-host
// suites; this pins the pure core.

import {
  objectMotive,
  attentionActions,
  attentionBonus,
  attentionBonusAny,
  attentionBonusOf,
  attentiveness,
  attentivenessAny,
  attentivenessOf,
  engagementToward,
  ramp,
  decayStrength,
  SPARK,
  type AttentionTargetInfo,
  type AuthorAttention,
  type AuthorDraws,
  type EngagedMember,
  type ObjectAffordances,
  type SparkDraw,
  type SparkFocus,
} from "@shared/world-engine/interaction/behavior/spark-attention.js";

const obj = (o: Partial<ObjectAffordances>): ObjectAffordances => ({
  affords: [],
  properties: [],
  stationKind: null,
  isWater: false,
  ...o,
});

describe("objectMotive — affordance-bound object → motive", () => {
  it("reads a toy's PLAY affordance as fun (over any fixture role it sits on)", () => {
    expect(objectMotive(obj({ affords: ["play"] }))).toBe("fun");
    expect(objectMotive(obj({ properties: ["toy"] }))).toBe("fun");
    // A toy left on a table draws PLAY, not dining — affordance wins.
    expect(objectMotive(obj({ affords: ["play"], stationKind: "table" }))).toBe("fun");
  });

  it("maps food to hunger and water to thirst", () => {
    expect(objectMotive(obj({ properties: ["food"] }))).toBe("hunger");
    expect(objectMotive(obj({ isWater: true }))).toBe("thirst");
  });

  it("maps rest/relief fixtures by their station role", () => {
    expect(objectMotive(obj({ stationKind: "bed" }))).toBe("energy");
    expect(objectMotive(obj({ stationKind: "toilet" }))).toBe("waste");
    expect(objectMotive(obj({ stationKind: "bath" }))).toBe("hygiene");
    expect(objectMotive(obj({ stationKind: "barrel" }))).toBe("thirst");
    expect(objectMotive(obj({ stationKind: "well" }))).toBe("thirst");
    expect(objectMotive(obj({ stationKind: "table" }))).toBe("hunger");
    expect(objectMotive(obj({ stationKind: "bowl" }))).toBe("hunger");
  });

  it("returns null for objects serving no meter-driven motive (a chest, a wall)", () => {
    expect(objectMotive(obj({ stationKind: "chest_food" }))).toBeNull();
    expect(objectMotive(obj({}))).toBeNull();
  });
});

describe("ramp / decay", () => {
  it("ramps to full within ~rampS and clamps at 1", () => {
    let s = 0;
    s = ramp(s, SPARK.rampS / 2);
    expect(s).toBeCloseTo(0.5, 5);
    s = ramp(s, SPARK.rampS); // overshoots — clamped
    expect(s).toBe(1);
  });

  it("decays to zero over the given window and never goes negative", () => {
    let s = 1;
    s = decayStrength(s, SPARK.drawDecayS / 2, SPARK.drawDecayS);
    expect(s).toBeCloseTo(0.5, 5);
    s = decayStrength(s, SPARK.drawDecayS, SPARK.drawDecayS);
    expect(s).toBe(0);
  });
});

describe("attentiveness — engagement is the sole gate", () => {
  const engage = (cid: string, strength = 1): SparkFocus => ({ cid, strength });

  it("an UNENGAGED creature is not attentive at all (nobody is pulled in)", () => {
    expect(attentiveness(null, "resident_0_0")).toBe(0);
    expect(attentiveness(engage("someone_else"), "resident_0_0")).toBe(0);
  });

  it("the ENGAGED creature is attentive at its engagement strength", () => {
    expect(attentiveness(engage("resident_0_0"), "resident_0_0")).toBe(1);
    expect(attentiveness(engage("resident_0_0", 0.4), "resident_0_0")).toBeCloseTo(0.4, 5);
  });
});

describe("attentionBonus — strong for the engaged creature, zero otherwise", () => {
  const draw = (o: Partial<SparkDraw>): SparkDraw => ({ motive: "hunger", x: 0, y: 0, objId: "obj_0", strength: 1, ...o });
  const engage = (cid: string, strength = 1): SparkFocus => ({ cid, strength });

  it("gives the ENGAGED creature a strong bonus (≥ the fire threshold of 1)", () => {
    const b = attentionBonus(draw({}), engage("resident_0_0"), "resident_0_0", "hunger:food");
    expect(b).toBeCloseTo(SPARK.bonus, 5);
    expect(b).toBeGreaterThanOrEqual(1); // strong enough to make it go use the thing
  });

  it("does NOTHING to an unengaged creature, however near", () => {
    expect(attentionBonus(draw({}), null, "resident_0_0", "hunger:food")).toBe(0);
    expect(attentionBonus(draw({}), engage("resident_0_1"), "resident_0_0", "hunger:food")).toBe(0);
  });

  it("is zero for a non-matching motive, or a spent / area draw", () => {
    const e = engage("resident_0_0");
    expect(attentionBonus(draw({ motive: "energy" }), e, "resident_0_0", "hunger:food")).toBe(0);
    expect(attentionBonus(draw({ motive: null }), e, "resident_0_0", "hunger:food")).toBe(0);
    expect(attentionBonus(draw({ strength: 0 }), e, "resident_0_0", "hunger:food")).toBe(0);
    expect(attentionBonus(null, e, "resident_0_0", "hunger:food")).toBe(0);
  });

  it("scales with draw strength and engagement strength", () => {
    expect(attentionBonus(draw({ strength: 0.5 }), engage("resident_0_0"), "resident_0_0", "hunger:food")).toBeCloseTo(
      SPARK.bonus * 0.5,
      5,
    );
    expect(attentionBonus(draw({}), engage("resident_0_0", 0.5), "resident_0_0", "hunger:food")).toBeCloseTo(
      SPARK.bonus * 0.5,
      5,
    );
  });
});

// ---------------------------------------------------------------------------
// PER-AUTHOR attention (multi-entity-conversations.md §3f) — the singleton dies
// ---------------------------------------------------------------------------

const focus = (cid: string, strength = 1): SparkFocus => ({ cid, strength });
const drawAt = (o: Partial<SparkDraw> = {}): SparkDraw => ({
  motive: "hunger",
  x: 0,
  y: 0,
  objId: "obj_0",
  strength: 1,
  ...o,
});
const ANN = "player:ann";
const BEN = "player:ben";

describe("attentivenessOf / attentivenessAny — one row per author", () => {
  const attention: AuthorAttention = new Map([
    [ANN, focus("mara", 0.8)],
    [BEN, focus("bram")],
  ]);

  it("answers from THAT author's row and nobody else's", () => {
    expect(attentivenessOf(attention, ANN, "mara")).toBeCloseTo(0.8, 5);
    expect(attentivenessOf(attention, BEN, "bram")).toBe(1);
  });

  it("author A's engagement NEVER answers for author B", () => {
    // The singleton bug: whoever hovered last owned everybody's attention.
    expect(attentivenessOf(attention, BEN, "mara")).toBe(0);
    expect(attentivenessOf(attention, ANN, "bram")).toBe(0);
  });

  it("is zero for an author with no row at all, and for an empty/absent map", () => {
    expect(attentivenessOf(attention, "player:cass", "mara")).toBe(0);
    expect(attentivenessOf(new Map(), ANN, "mara")).toBe(0);
    expect(attentivenessOf(null, ANN, "mara")).toBe(0);
  });

  it("ANY takes the STRONGEST hold — a body two children look at is engaged", () => {
    const both: AuthorAttention = new Map([
      [ANN, focus("mara", 0.3)],
      [BEN, focus("mara", 0.9)],
    ]);
    expect(attentivenessAny(both, "mara")).toBeCloseTo(0.9, 5);
    // …and order cannot change the answer.
    const reversed: AuthorAttention = new Map([
      [BEN, focus("mara", 0.9)],
      [ANN, focus("mara", 0.3)],
    ]);
    expect(attentivenessAny(reversed, "mara")).toBeCloseTo(0.9, 5);
    expect(attentivenessAny(attention, "stranger")).toBe(0);
    expect(attentivenessAny(null, "mara")).toBe(0);
  });
});

describe("attentionBonusOf / attentionBonusAny — the PAIRING LAW", () => {
  it("pairs an author's draw with that SAME author's engagement", () => {
    const draws: AuthorDraws = new Map([[ANN, drawAt()]]);
    const attention: AuthorAttention = new Map([[ANN, focus("mara")]]);
    expect(attentionBonusOf(draws, attention, ANN, "mara", "hunger:food")).toBeCloseTo(SPARK.bonus, 5);
  });

  it("NEVER crosses two authors — Ann engages Mara, Ben looks at the bread, nothing happens", () => {
    // The instruction neither child gave. Crossed reads are what the map exists
    // to make unwritable.
    const draws: AuthorDraws = new Map([[BEN, drawAt()]]);
    const attention: AuthorAttention = new Map([[ANN, focus("mara")]]);
    expect(attentionBonusOf(draws, attention, ANN, "mara", "hunger:food")).toBe(0); // Ann points at nothing
    expect(attentionBonusOf(draws, attention, BEN, "mara", "hunger:food")).toBe(0); // Ben engaged nobody
    expect(attentionBonusAny(draws, attention, "mara", "hunger:food")).toBe(0);
  });

  it("ANY gives the strongest author's bonus, and is order-independent", () => {
    const draws: AuthorDraws = new Map([
      [ANN, drawAt({ strength: 0.5 })],
      [BEN, drawAt()],
    ]);
    const attention: AuthorAttention = new Map([
      [ANN, focus("mara")],
      [BEN, focus("mara")],
    ]);
    expect(attentionBonusAny(draws, attention, "mara", "hunger:food")).toBeCloseTo(SPARK.bonus, 5);
    expect(attentionBonusAny(draws, attention, "bram", "hunger:food")).toBe(0);
  });

  it("keeps every gate of the singleton: motive match, live draw, engagement", () => {
    const attention: AuthorAttention = new Map([[ANN, focus("mara")]]);
    expect(attentionBonusOf(new Map([[ANN, drawAt({ motive: "energy" })]]), attention, ANN, "mara", "hunger:food")).toBe(0);
    expect(attentionBonusOf(new Map([[ANN, drawAt({ motive: null })]]), attention, ANN, "mara", "hunger:food")).toBe(0);
    expect(attentionBonusOf(new Map([[ANN, drawAt({ strength: 0 })]]), attention, ANN, "mara", "hunger:food")).toBe(0);
    expect(attentionBonusOf(null, attention, ANN, "mara", "hunger:food")).toBe(0);
    expect(attentionBonusAny(new Map([[ANN, drawAt()]]), null, "mara", "hunger:food")).toBe(0);
  });

  it("agrees with the singleton it replaces (the host's flip must be a no-op)", () => {
    const d = drawAt({ strength: 0.6 });
    const f = focus("mara", 0.5);
    expect(attentionBonusOf(new Map([[ANN, d]]), new Map([[ANN, f]]), ANN, "mara", "hunger:food")).toBeCloseTo(
      attentionBonus(d, f, "mara", "hunger:food"),
      5,
    );
  });
});

describe("engagementToward — ROSTER first, spark second, zero otherwise", () => {
  const members: EngagedMember[] = [
    { id: ANN, engagement: 1 },
    { id: "mara", engagement: 0.5 },
    { id: "bram", engagement: 1 },
  ];

  it("reads a fellow member's OWN engagement, not the gaze resting on them", () => {
    // Being in a conversation together IS mutual attention: nobody stares at the
    // person they are talking to, and a listener must not become less answerable
    // the longer the conversation runs.
    expect(engagementToward(members, null, ANN, "mara")).toBeCloseTo(0.5, 5);
    expect(engagementToward(members, new Map(), ANN, "bram")).toBe(1);
  });

  it("the ROSTER WINS over a contradicting spark row", () => {
    const attention: AuthorAttention = new Map([[ANN, focus("mara", 0.05)]]);
    expect(engagementToward(members, attention, ANN, "mara")).toBeCloseTo(0.5, 5);
  });

  it("needs BOTH in the circle — an outsider's hold on a member falls to the spark", () => {
    const attention: AuthorAttention = new Map([[BEN, focus("mara", 0.7)]]);
    expect(engagementToward(members, attention, BEN, "mara")).toBeCloseTo(0.7, 5);
    // …and with no spark either, the outsider holds nothing.
    expect(engagementToward(members, null, BEN, "mara")).toBe(0);
  });

  it("falls to the spark when the TARGET is outside the circle", () => {
    const attention: AuthorAttention = new Map([[ANN, focus("stranger", 0.4)]]);
    expect(engagementToward(members, attention, ANN, "stranger")).toBeCloseTo(0.4, 5);
  });

  it("falls to the spark with no roster at all, and stays PER-AUTHOR there", () => {
    const attention: AuthorAttention = new Map([[ANN, focus("mara", 0.9)]]);
    expect(engagementToward(null, attention, ANN, "mara")).toBeCloseTo(0.9, 5);
    expect(engagementToward(undefined, attention, ANN, "mara")).toBeCloseTo(0.9, 5);
    expect(engagementToward([], attention, ANN, "mara")).toBeCloseTo(0.9, 5);
    expect(engagementToward(null, attention, BEN, "mara")).toBe(0); // not Ben's spark
  });

  it("THE NO-AMBIENT-RESPONSE LAW: an unengaged non-member is ZERO", () => {
    // The "way too strong" failure. No amount of roster machinery may pull in a
    // creature the author never engaged and never sat down with.
    expect(engagementToward(members, new Map([[ANN, focus("mara")]]), ANN, "stranger")).toBe(0);
    expect(engagementToward(null, null, ANN, "stranger")).toBe(0);
  });

  it("clamps a wild roster value to 0..1", () => {
    expect(engagementToward([{ id: ANN, engagement: 1 }, { id: "mara", engagement: 99 }], null, ANN, "mara")).toBe(1);
    expect(engagementToward([{ id: ANN, engagement: 1 }, { id: "mara", engagement: -3 }], null, ANN, "mara")).toBe(0);
  });
});

describe("attentionActions — item type × state → the default act", () => {
  const info = (o: Partial<AttentionTargetInfo>): AttentionTargetInfo => ({
    affords: [],
    properties: [],
    stationKind: null,
    isWater: false,
    states: [],
    isClothing: false,
    unclaimed: false,
    loose: false,
    stockLow: false,
    ...o,
  });
  const kinds = (i: AttentionTargetInfo) => attentionActions(i).map((a) => a.kind);

  it("meter-gated defaults: food→eat, water→drink, toy→play, bed→sleep, toilet→use, bath→wash", () => {
    expect(kinds(info({ properties: ["food"] }))[0]).toBe("eat");
    expect(kinds(info({ isWater: true }))[0]).toBe("drink");
    expect(kinds(info({ affords: ["play"] }))[0]).toBe("play");
    expect(kinds(info({ stationKind: "bed" }))[0]).toBe("sleep");
    expect(kinds(info({ stationKind: "toilet" }))[0]).toBe("use");
    expect(kinds(info({ stationKind: "bath" }))[0]).toBe("wash");
    expect(attentionActions(info({ properties: ["food"] }))[0]!.motive).toBe("hunger");
  });

  it("a DIRTY item wants washing before anything — even a dirty shirt or toy", () => {
    expect(kinds(info({ states: ["dirty"], isClothing: true }))[0]).toBe("washItem");
    expect(kinds(info({ states: ["dirty"], affords: ["play"] }))[0]).toBe("washItem");
  });

  it("clean clothing wears at ANY time (no meter gate)", () => {
    const acts = attentionActions(info({ isClothing: true }));
    expect(acts[0]!.kind).toBe("wear");
    expect(acts[0]!.motive).toBeUndefined();
  });

  it("anytime fallthrough: unclaimed loose → get, owned loose → tidy, low stock → getMore", () => {
    expect(kinds(info({ loose: true, unclaimed: true }))).toEqual(["get", "tidy"]);
    expect(kinds(info({ loose: true }))).toEqual(["tidy"]);
    expect(kinds(info({ stockLow: true }))).toEqual(["getMore"]);
  });

  it("an unwilling meter act FALLS THROUGH to the anytime acts (a not-hungry body still GETS the free apple)", () => {
    // The host walks the list: eat gated → get → tidy.
    expect(kinds(info({ properties: ["food"], loose: true, unclaimed: true }))).toEqual(["eat", "get", "tidy"]);
  });

  it("a wall asks nothing", () => {
    expect(kinds(info({}))).toEqual([]);
  });
});
