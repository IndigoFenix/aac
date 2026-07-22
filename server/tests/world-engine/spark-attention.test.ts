// server/tests/world-engine/spark-attention.test.ts
//
// The pure attention-field mapping (planning-docs/games/attention-spark.md):
// object → motive, ramp/decay, and the effective-meter bonus. The host wiring
// (hover detection, ctx.meter injection, announce) is covered in the quest-host
// suites; this pins the pure core.

import {
  objectMotive,
  attentionBonus,
  attentiveness,
  ramp,
  decayStrength,
  SPARK,
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
    expect(objectMotive(obj({ stationKind: "privy" }))).toBe("waste");
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
  const draw = (o: Partial<SparkDraw>): SparkDraw => ({ motive: "hunger", x: 0, y: 0, strength: 1, ...o });
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
