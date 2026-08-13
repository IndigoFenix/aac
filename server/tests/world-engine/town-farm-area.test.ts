// THE AREA SEAM (economy-arc-opening.md, SUPPLY & DEMAND ROUND S2). The
// survey's finding: TownField rects had NO economic reader — the drawn
// fields measured 0.0202 acres/person against the user's own anchors (12
// ancient / 0.5 modern acres/person), 25×/594× short, while the farm's food
// process read an abstract charter scalar (`farmland`) that had no relation
// to what was actually drawn on the map. This suite pins the fix:
//
//   1. REAL_FARM_ACRES_PER_PERSON carries the user's two anchors verbatim.
//   2. The farm's food process reads `field_acres` (population-derived, live
//      every day) instead of the abstract `farmland` charter efficiency.
//   3. THE IDENTITY: acres/person × the process's own reciprocal efficiency
//      === rations/person — food_need and the derived supply close at fill
//      ≈ 1 for a balanced town, by construction, not by coincidence.
//   4. Field GEOMETRY (kernel/town/plan.ts) sums to the same honest acreage
//      the books assume — the map and the books agree.
//
// Pure logic + one live (DB-free) TownWorld stepping — no DOM/GL/DB.

import { describe, it, expect } from "@jest/globals";
import { compileEconomy } from "@shared/world-engine/kernel/modules/economy/index.js";
import { townPlayEconomy } from "@shared/world-engine/interaction/town/town-play.js";
import { createTownWorld } from "@shared/world-engine/kernel/town/town-world.js";
import { townPlan, type TownField } from "@shared/world-engine/kernel/town/plan.js";
import {
  farmAcresPerPerson,
  farmAreaPerPersonM2,
  M2_PER_ACRE,
  producerSurplusFrac,
  REAL_FARM_ACRES_PER_PERSON,
  REAL_SCALE,
  REAL_SURPLUS_FRAC,
  resolveWorldScale,
} from "@shared/world-engine/scale.js";

// ⚖️ σ (S&D σ close) — the farm plans for a SURPLUS above the table, so every
// acreage figure below carries the same (1 + σ) the producer row declares.
// The bare anchor identity (acres × efficiency === rations) is UNTOUCHED and
// still pinned exactly; σ multiplies the DEMAND ROW and the field geometry,
// never the yield per acre.
const SIGMA = REAL_SURPLUS_FRAC.staple;
const SURPLUS = 1 + SIGMA;

describe("REAL_FARM_ACRES_PER_PERSON — the user's anchors, verbatim", () => {
  it("12 acres/person ancient, 0.5 modern — the two data points the user gave", () => {
    expect(REAL_FARM_ACRES_PER_PERSON.ancient).toBe(12);
    expect(REAL_FARM_ACRES_PER_PERSON.modern).toBe(0.5);
  });

  it("the conversion dial is a DIVISOR seat (S3), default 1", () => {
    expect(farmAcresPerPerson("ancient")).toBe(12);
    expect(farmAcresPerPerson("ancient", 1)).toBe(12);
    expect(farmAcresPerPerson("ancient", 2)).toBe(6);
    expect(farmAreaPerPersonM2("ancient")).toBeCloseTo(12 * M2_PER_ACRE, 6);
  });
});

describe("townPlayEconomy — the farm's food process reads field_acres", () => {
  const eco = compileEconomy([townPlayEconomy()], { construction: true });
  const farmProc = eco.processes.find((p) => p.id === "farm")!;

  it("🚨 input is the honest field acreage, not the abstract charter scalar", () => {
    expect(farmProc.input).toBe("field_acres");
    expect(farmProc.input).not.toBe("farmland");
  });

  it("the labor gate is UNCHANGED — a town still needs a built, staffed farm", () => {
    expect(farmProc.capacityBy).toBe("farms");
    expect(farmProc.capacityRate).toBe(5);
  });

  it("`farmland` (the charter scalar) still feeds the weaver — untouched, out of S2's scope", () => {
    const weaveProc = eco.processes.find((p) => p.id === "weave")!;
    expect(weaveProc.input).toBe("farmland");
  });

  it("🚨 THE IDENTITY — acres/person × the process's own efficiency === rations/person", () => {
    // field_acres' demand IS pop × farmAcresPerPerson(tier) × (1 + σ) (the
    // generic per-capita mechanism food_need itself rides — economy.ts
    // demandInputs/traitDemands, re-parameterized, not forked).
    const acresPerPerson = eco.traitDemands.find((d) => d.resource === "field_acres")!.value;
    const rationsPerPerson = eco.traitDemands.find((d) => d.resource === "food")!.value;
    expect(rationsPerPerson).toBeCloseTo(0.001, 12); // the caloric anchor, for the record
    // ⚖️ THE BARE ANCHOR IDENTITY IS UNMOVED. σ buys MORE LAND at the SAME
    // yield per acre, so the reciprocal pair the S2 seam is built on still
    // multiplies out to exactly one ration per person per day.
    expect(farmAcresPerPerson("ancient") * farmProc.efficiency!).toBeCloseTo(rationsPerPerson, 15);
    // 🚨 σ — MOVED PIN, WITH WHY (S&D σ close). S2 wrote the demand row at the
    // bare anchor, which closed the books at `food_got ≡ food_need` exactly
    // and left the town no slack: the granary banked 0, so no industry was
    // ever funded and no household could bank. The row now carries the farm's
    // own declared margin.
    expect(acresPerPerson).toBeCloseTo(farmAcresPerPerson("ancient") * SURPLUS, 15);
    // grain_out = field_acres × efficiency = pop × (acresPerPerson × efficiency)
    // and food_need = pop × rationsPerPerson, so the bracketed term is the
    // ration EXACTLY SCALED BY (1 + σ): the town grows a fifth more than it
    // eats, on purpose, and that fifth is the granary's whole income.
    expect(acresPerPerson * farmProc.efficiency!).toBeCloseTo(rationsPerPerson * SURPLUS, 15);
  });

  it("🚨 σ — the farm carries the SPEC-SIDE seat, and it is the staple anchor", () => {
    // The seat is per-producer and lives on the producer row (user law); the
    // map (plan.ts field geometry) and the books (the demand row above) both
    // read THIS number, so they can never disagree.
    const farmRow = eco.works.find((w) => w.key === "farm")!;
    expect(farmRow.surplusFrac).toBe(REAL_SURPLUS_FRAC.staple);
    expect(producerSurplusFrac(farmRow.surplusFrac, "staple")).toBe(SIGMA);
    // The craft works declare nothing and INHERIT the class anchor — the seat
    // is real for them, and inert until their scale is need-derived.
    for (const key of ["weaver", "tailor"]) {
      const row = eco.works.find((w) => w.key === key)!;
      expect(row.surplusFrac).toBeUndefined();
      expect(producerSurplusFrac(row.surplusFrac)).toBe(REAL_SURPLUS_FRAC.craft);
    }
  });

  it("σ is anchored in realism, and is NOT the conversion dial", () => {
    // The historical band the anchor is drawn from (10–30% above the table);
    // the staple's value is its middle, the craft class plans half of it.
    expect(REAL_SURPLUS_FRAC.staple).toBe(0.2);
    expect(REAL_SURPLUS_FRAC.craft).toBe(0.1);
    expect(REAL_SURPLUS_FRAC.staple).toBeGreaterThanOrEqual(0.1);
    expect(REAL_SURPLUS_FRAC.staple).toBeLessThanOrEqual(0.3);
    // 🚨 σ AND `resource_compression` MUST NEVER MULTIPLY (S3's single-
    // application law). A world that compresses conversion leaves the farmer
    // the same declared margin above whatever the table then costs: the ratio
    // of the demand row to the bare anchor is σ at ANY dial.
    for (const dial of [1, 2, 4]) {
      const ecoD = compileEconomy([townPlayEconomy(resolveWorldScale({ resource_compression: dial }))], {
        construction: true,
      });
      const acres = ecoD.traitDemands.find((d) => d.resource === "field_acres")!.value;
      expect(acres / farmAcresPerPerson("ancient", dial)).toBeCloseTo(SURPLUS, 12);
    }
  });
});

describe("S&D S3 — the dial is WIRED, and the identity survives it", () => {
  it("townPlayEconomy(scale) reads resourceCompression as the conversionDial", () => {
    const dial2 = resolveWorldScale({ resource_compression: 2 });
    const eco2 = compileEconomy([townPlayEconomy(dial2)], { construction: true });
    const farmProc2 = eco2.processes.find((p) => p.id === "farm")!;
    const acresPerPerson2 = eco2.traitDemands.find((d) => d.resource === "field_acres")!.value;
    // MOVED PIN, WITH WHY (σ): the dial still HALVES the anchor (6, half of
    // 12) — the demand row simply also carries the farm's declared margin,
    // and the two are independent factors that never multiply into each other.
    expect(acresPerPerson2).toBeCloseTo(farmAcresPerPerson("ancient", 2) * SURPLUS, 15);
    // THE IDENTITY HOLDS AT ANY DIAL — the acreage anchor and the process
    // efficiency are reciprocals of ONE formula, so a smaller declared
    // acreage is exactly compensated by a proportionally larger yield/acre;
    // a town's books never oversupply or starve merely because the dial moved.
    const rationsPerPerson2 = eco2.traitDemands.find((d) => d.resource === "food")!.value;
    expect(farmAcresPerPerson("ancient", 2) * farmProc2.efficiency!).toBeCloseTo(rationsPerPerson2, 15);
    expect(acresPerPerson2 * farmProc2.efficiency!).toBeCloseTo(rationsPerPerson2 * SURPLUS, 15);
  });

  it("kernel/town/plan.ts's field geometry reads the SAME dial (map ≡ books)", () => {
    const dial4 = resolveWorldScale({ resource_compression: 4 });
    const eco = compileEconomy([townPlayEconomy(REAL_SCALE)], { construction: true });
    const town = createTownWorld({
      economy: eco, charter: { farmland: 420, ore_access: 0 },
      startPop: 900, seedScalars: { farms: 2 }, key: "dialfield",
    });
    town.step(50);
    const pop = town.scalar("population");
    const planReal = townPlan(town, eco, "dialfield", 11);
    const planDial = townPlan(town, eco, "dialfield", 11, 0, undefined, [], undefined, undefined, dial4);
    const fieldAreaM2 = (fields: readonly TownField[]) => fields.reduce((s, f) => s + f.w * f.h, 0);
    const targetDial4 = pop * farmAreaPerPersonM2("ancient", 4) * SURPLUS; // a quarter the acreage
    // Stochastic patch jitter — the same ±40% ballpark S2's own suite gates
    // on (patch COUNT is a rendering-resolution cap; patch SIZE is exact in
    // expectation, not per-seed).
    expect(fieldAreaM2(planDial.fields)).toBeGreaterThan(targetDial4 * 0.6);
    expect(fieldAreaM2(planDial.fields)).toBeLessThan(targetDial4 * 1.4);
    // A no-scale caller (worldgen, far-LOD twins) is UNCHANGED — the dial
    // defaults to 1 exactly as S2 shipped it — and a QUARTER the acreage at
    // dial 4 reads unmistakably smaller than the undialed field.
    expect(fieldAreaM2(planDial.fields)).toBeLessThan(fieldAreaM2(planReal.fields) * 0.5);
  });
});

describe("a live TownWorld — field_acres tracks population, food closes at fill ≈ 1", () => {
  const eco = compileEconomy([townPlayEconomy()], { construction: true });

  it("field_acres is written every day off the CURRENT population, exactly like food_need", () => {
    const town = createTownWorld({
      economy: eco, charter: { farmland: 420, ore_access: 0 },
      startPop: 200, seedScalars: { farms: 1 }, key: "acreford",
    });
    expect(town.scalar("field_acres")).toBeCloseTo(200 * 12 * SURPLUS, 6);
    town.step(10);
    // Whatever the population did over those 10 days (growth/starvation),
    // field_acres reads off the SAME day's population — the map is never
    // one day stale against the books.
    expect(town.scalar("field_acres")).toBeCloseTo(town.scalar("population") * 12 * SURPLUS, 6);
  });

  it("🚨 a farmed town's food fill closes to ≈ 1 — capacity does not bind at village scale", () => {
    const town = createTownWorld({
      economy: eco, charter: { farmland: 420, ore_access: 0 },
      startPop: 200, seedScalars: { farms: 1 }, key: "acreford2",
    });
    town.step(10);
    const need = town.scalar("food_need");
    const got = town.scalar("food_got");
    expect(need).toBeGreaterThan(0);
    // ⚖️ THE BOOKS CAP `got` AT `need` STRUCTURALLY — the flow net's
    // `satisfied = dem × min(1, supply/dem)`. So a town growing σ MORE than
    // it eats still reads a perfect fill; the surplus is not in `got`.
    expect(got / need).toBeCloseTo(1, 3);
  });

  it("🚨 σ — AND THE SURPLUS LANDS IN THE GRANARY (the drift path fills again)", () => {
    // THE DEFECT THIS CLOSES (S&D round close, the eight-faced one): with the
    // demand row at the bare anchor, `food_out − food_need` was 0 every day,
    // so the flow net's positive residual — the ONLY income the granary has —
    // was 0 too. Nothing funded the industry tier, so weavers = tailors = 0
    // and `clothing_got` stayed 0 forever.
    const town = createTownWorld({
      economy: eco, charter: { farmland: 420, ore_access: 0 },
      startPop: 200, seedScalars: { farms: 1 }, key: "granaryfill",
    });
    expect(town.scalar("granary")).toBe(0);
    // 🚨 THE RATE IS σ EXACTLY, not a guess: the flow net's positive residual
    // is `food_out − food_need = σ × food_need`, and one stepped day of it is
    // what the granary gains.
    town.step(1);
    expect(town.scalar("granary")).toBeCloseTo(SIGMA * 200 * 0.001, 12);
    let income = town.scalar("granary");
    for (let d = 0; d < 29; d++) {
      const before = town.scalar("granary");
      town.step(1);
      // The day's need is written at ITS OWN day start (off that day's
      // population), so the rate this day banked is read AFTER the step.
      income += SIGMA * town.scalar("food_need");
      // Each day either banks the margin or spends it on a work — never
      // neither (which is the state S2 left the town in).
      expect(town.scalar("granary")).not.toBe(before);
    }
    // CONSERVATION: everything the fields earned is either still in the
    // granary or standing in the town as a funded work.
    const farmsBuilt = town.scalar("farms") - 1;
    const farmCost = eco.works.find((w) => w.key === "farm")!.construction.costs[0]!.amount;
    expect(farmsBuilt).toBeGreaterThan(0); // it FUNDED something, which is the point
    expect(town.scalar("granary") + farmsBuilt * farmCost).toBeCloseTo(income, 6);
  });
});

describe("kernel/town/plan.ts — field GEOMETRY sums to the same honest acreage", () => {
  const eco = compileEconomy([townPlayEconomy()], { construction: true });

  function fieldAreaM2(fields: readonly TownField[]): number {
    return fields.reduce((sum, f) => sum + f.w * f.h, 0);
  }

  it("a farmland town's Σ field area lands in the honest ballpark of pop × 12 acres × (1 + σ)", () => {
    // A big-enough population pins the patch count at TOWN_DIMS.fieldPatchCap
    // (rendering ceiling), which shrinks the jitter-sampling variance of the
    // realized sum against its analytic target — still stochastic (each
    // patch's w/h is independently jittered), so the bound is a ballpark,
    // not an exact equality.
    const town = createTownWorld({
      economy: eco, charter: { farmland: 420, ore_access: 0 },
      startPop: 900, seedScalars: { farms: 2 }, key: "widefield",
    });
    town.step(200);
    const plan = townPlan(town, eco, "widefield", 11);
    expect(plan.fields.length).toBeGreaterThan(0);
    const pop = town.scalar("population");
    // MOVED PIN, WITH WHY (σ): the ground the town works is what it PLANS to
    // work, and that is the table plus the farm's declared margin — read off
    // the producer row, exactly as the geometry itself reads it, so map ≡
    // books survives the change instead of being restated here.
    const targetM2 = pop * farmAreaPerPersonM2("ancient") * SURPLUS;
    const measuredM2 = fieldAreaM2(plan.fields);
    // 594× short (the survey's own measurement of the pre-S2 code) would
    // fail this by two orders of magnitude; a generous ±40% band catches a
    // broken derivation without chasing RNG-seed-specific noise.
    expect(measuredM2).toBeGreaterThan(targetM2 * 0.6);
    expect(measuredM2).toBeLessThan(targetM2 * 1.4);
    // Measured, for the record (see the round's landing notes for the
    // before/after acres-per-person figure this produces).
    const acresPerPerson = measuredM2 / M2_PER_ACRE / pop;
    expect(acresPerPerson).toBeGreaterThan(farmAcresPerPerson("ancient") * SURPLUS * 0.6);
    expect(acresPerPerson).toBeLessThan(farmAcresPerPerson("ancient") * SURPLUS * 1.4);
  });

  it("fields are GROUND, not clamped to the town's built extent (the out-field precedent)", () => {
    // No guard clips a field's rect to plan.radius/extentM — fields are
    // paint, not streets, and a big honest acreage is expected to reach
    // past the walkable disc (recorded design decision, S2 landing notes).
    const town = createTownWorld({
      economy: eco, charter: { farmland: 420, ore_access: 0 },
      startPop: 900, seedScalars: { farms: 2 }, key: "widefield2",
    });
    town.step(200);
    const plan = townPlan(town, eco, "widefield2", 11);
    const beyond = plan.fields.some((f) => {
      const cx = f.dx + f.w / 2;
      const cy = f.dy + f.h / 2;
      return Math.hypot(cx, cy) + Math.max(f.w, f.h) / 2 > plan.radius;
    });
    expect(beyond).toBe(true);
  });

  it("a zero-population plan lays no fields (unchanged gate)", () => {
    const town = createTownWorld({
      economy: eco, charter: { farmland: 420, ore_access: 0 },
      startPop: 0, seedScalars: { farms: 0 }, key: "empty",
    });
    const plan = townPlan(town, eco, "empty", 11);
    expect(plan.fields).toHaveLength(0);
  });
});
