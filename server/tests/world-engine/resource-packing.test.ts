// RESOURCE PACKING — DENSITY IS DERIVED, NOT AUTHORED
// (`shared/world-engine/planet/packing.ts`, 2026-09-10.)
//
// 🚨 WHY A SUITE AND NOT A COMMENT. The thing this round replaced was four
// hand-balanced numbers on `ecology.ts FORAGE_UNDERSTORY` with a note begging
// the next round to move a cadence back whenever it moved a density. Every
// claim below is the kind of claim that note could only ASK for:
//
//   · a hectare never carries more than it supplies (the pool invariant);
//   · a lone plant gets the whole hectare, and a second plant of equal fit
//     halves it — competition, not addition;
//   · 🚨 ADDING A PLANT DOES NOT MAKE THE CELL RICHER, and REMOVING ONE does
//     not make it richer either. THE USER'S OWN SENTENCE IS THE ACCEPTANCE
//     CRITERION, verbatim: *"they compete and the total food available remains
//     roughly the same."* Measured at the anchor, adding a sixth member:
//
//         bush-like newcomer (500 kcal/m², above the mix)   Σ flow  +2.62 %
//         carrot-like newcomer (174 kcal/m², below the mix) Σ flow  −4.58 %
//         the OLD AUTHORED LAW, a bush row at 43/ha         Σ flow +40.1 %
//
//     🚫 DO NOT "FIX" THE ±3 % WOBBLE INTO AN EXACT ZERO. It is not noise and
//     it is not slop: the LAND is what is conserved, and a newcomer brings no
//     flow of its own — what moves is the community's YIELD MIX (456.05 →
//     467.77 kcal/m² for the bush-like case), because the ground it takes came
//     from plants that are not all worth the same per m². ±3 % IS "roughly the
//     same". +40 % is not, and that contrast is the whole result. Pinning an
//     exact zero could only be done by choosing a fixture at the community's
//     mean yield, i.e. by rigging the test;
//   · the same inputs give byte-equal output (no RNG, no clock);
//   · and the fractional bearing carry never mints or loses a unit.

import { describe, it, expect } from "@jest/globals";
import {
  CANOPY_HEIGHT_M,
  LIGHT_SUPPLY_M2_PER_HA,
  NUTRIENT_SUPPLY_M2_PER_HA_PER_FERTILITY,
  WATER_SUPPLY_M2_PER_HA_PER_RAIN,
  itemsPerBearing,
  packMemberOf,
  packStands,
  packSupplyAt,
  rationsPerBearing,
  type PackMember,
  type PackSupply,
  type Pool,
} from "@shared/world-engine/planet/packing.js";
import {
  crownAreaM2,
  forageYieldKcalPerM2Yr,
  harvestProductsOf,
  naturalSourceOf,
  rootAreaM2,
  wildFoodPlants,
  REAL_FORAGE_YIELD_KCAL_PER_M2_YR,
  type ClimateSample,
  type NaturalProduct,
  type NaturalSource,
} from "@shared/world-engine/products.js";
import {
  RATION_KCAL,
  REAL_FORAGE_CAPTURE_FRACTION,
  REAL_SCALE,
  forageRationsPerHaDaily,
} from "@shared/world-engine/scale.js";
import {
  ITEM_SATIATION_GAMEPLAY,
  gameplaySatiationDaysOf,
  realSatiationDaysOf,
  satiationDaysOf,
} from "@shared/world-engine/kernel/town/goods-kinds.js";
import {
  PLANET_CELL_CLIMATE,
  PLANET_CELL_ECO,
} from "@shared/world-engine/headless/text-quest.js";

const POOLS: Pool[] = ["W", "N", "Lc", "Lu"];

/** The pass's own members for a cell — every food plant it admits that carries
 *  packing geometry, minus the BAKED canopy (`oak`, whose density is the
 *  `eco_tree` field's business and whose cover is this pass's INPUT). */
function membersAt(climate: ClimateSample): PackMember[] {
  const out: PackMember[] = [];
  for (const src of wildFoodPlants(climate)) {
    if (src.species === "oak") continue;
    const m = packMemberOf(src, climate);
    if (m) out.push(m);
  }
  return out;
}

function usedAt(members: readonly PackMember[], packed: { perHa: number }[], pool: Pool): number {
  return members.reduce((a, m, i) => a + packed[i]!.perHa * m.demand[pool], 0);
}

/** Rations a hectare of this cell bears per day, off the pass — the SAME
 *  arithmetic `forage-flow-anchor.test.ts` ② runs over the real mix, so the
 *  two cannot drift. */
function flowAt(climate: ClimateSample, eco: Readonly<Record<string, number>>): number {
  const members = membersAt(climate);
  const packed = packStands(members, packSupplyAt(climate, eco));
  let flow = 0;
  members.forEach((m, i) => {
    const src = naturalSourceOf(m.key)!;
    for (const p of harvestProductsOf(m.key)) {
      if (p.use !== "food") continue;
      flow += (packed[i]!.perHa * rationsPerBearing(src, p)) / (p.regrowDays ?? 1);
    }
  });
  return flow;
}

const foodProductOf = (species: string): NaturalProduct =>
  harvestProductsOf(species).find((p) => p.use === "food")!;

describe("① the pools — a hectare never carries more than it supplies", () => {
  const CELLS: Array<[string, ClimateSample, Record<string, number>]> = [
    ["temperate anchor", PLANET_CELL_CLIMATE, { ...PLANET_CELL_ECO }],
    ["wet tropical", { rain: 1.0753296100845404, tempC: 28.412460127278745, elevation: 7, fertility: 12, ore: 0 }, { tree: 0.24, grass: 0 }],
    ["grassland", { rain: 0.5, tempC: 15, elevation: 5, fertility: 6, ore: 0 }, { tree: 0.02, grass: 0.4 }],
    ["closed canopy", { rain: 1.1, tempC: 10, elevation: 2, fertility: 10, ore: 0 }, { tree: 1, grass: 0 }],
    ["poor dry ground", { rain: 0.22, tempC: 20, elevation: 0, fertility: 1.2, ore: 0 }, { tree: 0, grass: 0.1 }],
  ];

  it.each(CELLS)("Σ nᵢ dᵢᵣ ≤ Sᵣ at EVERY pool — %s", (_name, climate, eco) => {
    const members = membersAt(climate);
    const supply = packSupplyAt(climate, eco);
    const packed = packStands(members, supply);
    for (const pool of POOLS) {
      expect(usedAt(members, packed, pool)).toBeLessThanOrEqual(supply[pool] + 1e-9);
    }
    // …and nothing comes back negative or non-finite, on any ground.
    for (const r of packed) {
      expect(Number.isFinite(r.perHa)).toBe(true);
      expect(r.perHa).toBeGreaterThanOrEqual(0);
    }
  });

  it("a CLOSED canopy leaves no understorey light, so nothing packs under it", () => {
    // `S_Lu = k_L × (1 − cover)`: the pass reads the same baked `eco_tree`
    // field the oaks stand off, which is what keeps a wood and its own floor
    // from disagreeing about how shaded it is.
    const supply = packSupplyAt(PLANET_CELL_CLIMATE, { tree: 1 });
    expect(supply.Lu).toBe(0);
    expect(supply.Lc).toBe(LIGHT_SUPPLY_M2_PER_HA);        // the sky is unshaded
    const packed = packStands(membersAt(PLANET_CELL_CLIMATE), supply);
    for (const r of packed) expect(r.perHa).toBeCloseTo(0, 9);
  });

  it("the supply scales are the cell's own rain and fertility, linearly", () => {
    const wet = packSupplyAt({ ...PLANET_CELL_CLIMATE, rain: 2 }, { tree: 0 });
    expect(wet.W).toBeCloseTo(2 * WATER_SUPPLY_M2_PER_HA_PER_RAIN, 9);
    const rich = packSupplyAt({ ...PLANET_CELL_CLIMATE, fertility: 3 }, { tree: 0 });
    expect(rich.N).toBeCloseTo(3 * NUTRIENT_SUPPLY_M2_PER_HA_PER_FERTILITY, 9);
  });
});

describe("② the solo ceiling and the sharing — competition, not addition", () => {
  const SUPPLY: PackSupply = { W: 200, N: 200, Lc: 200, Lu: 100 };
  const member = (key: string, fit: number, root: number, crown: number): PackMember => ({
    key, fit, demand: { W: root, N: root, Lc: 0, Lu: crown },
  });

  it("a LONE member gets S_r / d_ir of its binding pool — the whole hectare", () => {
    const solo = member("only", 1, 5, 10);
    const [got] = packStands([solo], SUPPLY);
    // Light binds (100 / 10 = 10) before water does (200 / 5 = 40).
    expect(got!.perHa).toBeCloseTo(10, 9);
    expect(usedAt([solo], [got!], "Lu")).toBeCloseTo(SUPPLY.Lu, 9);
  });

  it("…and it binds on WATER when water is the scarce pool", () => {
    const thirsty = member("thirsty", 1, 40, 1);
    const [got] = packStands([thirsty], SUPPLY);
    expect(got!.perHa).toBeCloseTo(SUPPLY.W / 40, 9);       // 5, not 100
  });

  it("a SECOND root plant of equal fit halves the first", () => {
    const a = member("a", 1, 40, 1);
    const solo = packStands([a], SUPPLY)[0]!.perHa;
    const packed = packStands([a, member("b", 1, 40, 1)], SUPPLY);
    expect(packed[0]!.perHa).toBeCloseTo(solo / 2, 9);
    expect(packed[1]!.perHa).toBeCloseTo(solo / 2, 9);
  });

  it("an unfit member takes nothing, and its share re-deals to the rest", () => {
    const a = member("a", 1, 40, 1);
    const solo = packStands([a], SUPPLY)[0]!.perHa;
    const packed = packStands([a, member("dead", 0, 40, 1)], SUPPLY);
    expect(packed[1]!.perHa).toBe(0);
    expect(packed[0]!.perHa).toBeCloseTo(solo, 9);          // the re-deal, pass two
  });

  it("no member is ever given MORE than an empty hectare would give it", () => {
    // The solo ceiling: a plant nobody competes with cannot be handed the slack
    // its neighbours left — a hectare is not a bank account.
    const small = member("small", 1, 1, 1);
    const big = member("big", 1, 60, 60);
    const packed = packStands([small, big], SUPPLY);
    const soloSmall = packStands([small], SUPPLY)[0]!.perHa;
    expect(packed[0]!.perHa).toBeLessThanOrEqual(soloSmall + 1e-9);
  });

  it("the answer does not depend on the order the members are given in", () => {
    const a = member("a", 0.7, 6, 9);
    const b = member("b", 0.2, 30, 2);
    const c = member("c", 1.4, 1, 0.4);
    const fwd = packStands([a, b, c], SUPPLY);
    const rev = packStands([c, b, a], SUPPLY);
    const byKey = (rows: { key: string; perHa: number }[]) =>
      Object.fromEntries(rows.map((r) => [r.key, r.perHa]));
    const f = byKey(fwd);
    const r = byKey(rev);
    for (const k of ["a", "b", "c"]) expect(f[k]!).toBeCloseTo(r[k]!, 9);
  });

  it("the layer line is `bodyHeightM >= 8` — canopy draws Lc, everything else Lu", () => {
    expect(CANOPY_HEIGHT_M).toBe(8);
    const oak = packMemberOf(naturalSourceOf("oak")!, PLANET_CELL_CLIMATE)!;
    expect(oak.demand.Lc).toBeGreaterThan(0);
    expect(oak.demand.Lu).toBe(0);
    for (const sp of ["bush", "hazel", "apple_tree", "carrot_plant"]) {
      const m = packMemberOf(naturalSourceOf(sp)!, PLANET_CELL_CLIMATE)!;
      expect(m.demand.Lu).toBeGreaterThan(0);
      expect(m.demand.Lc).toBe(0);
      // …and every plant drinks, on both pools, off the SAME root plate.
      expect(m.demand.W).toBe(m.demand.N);
      expect(m.demand.W).toBeCloseTo(rootAreaM2(naturalSourceOf(sp)!), 9);
    }
  });

  it("membership is `fit > 0`, and a row with no crown is not a candidate", () => {
    // A plant at its range edge is RARE there, not absent — the pass decides
    // how many, so nothing may be rounded out before it is asked.
    const vine = packMemberOf(naturalSourceOf("grape_vine")!, PLANET_CELL_CLIMATE);
    expect(vine).not.toBeNull();
    expect(vine!.fit).toBeGreaterThan(0);
    expect(vine!.fit).toBeLessThan(0.1);                     // barely, at the anchor
    // …a banana cannot live at 12 °C at all (its niche floor is 19).
    expect(packMemberOf(naturalSourceOf("banana_plant")!, PLANET_CELL_CLIMATE)).toBeNull();
    // …and a mineral has no crown, so it never enters the pass.
    expect(packMemberOf(naturalSourceOf("rock")!, PLANET_CELL_CLIMATE)).toBeNull();
  });
});

describe("③ 🚨 THE ANCHOR IS THE FLOW, AND A NEW PLANT BRINGS NONE OF ITS OWN", () => {
  const ANCHOR_ECO = { ...PLANET_CELL_ECO };

  it("the temperate anchor cell bears exactly `forageRationsPerHaDaily`", () => {
    const measured = flowAt(PLANET_CELL_CLIMATE, ANCHOR_ECO);
    expect(measured / forageRationsPerHaDaily(REAL_SCALE)).toBeCloseTo(1, 3);
  });

  it("🚨 ADDING a sixth temperate member does NOT ADD ITS OWN FLOW — it divides the hectare", () => {
    // THE USER'S RULING, EXECUTABLE, AND MEASURED RATHER THAN ASSUMED. A
    // hectare's light and water are THE budget: a new plant DIVIDES it, it does
    // not extend it. Under the old authored densities a new
    // `FORAGE_UNDERSTORY` row simply ADDED its own number — a bush-like row at
    // the shipped 43/ha would have raised this cell's flow by 40 %, silently
    // and forever.
    //
    // ⚖️ WHAT IS CONSERVED IS THE LAND, NOT THE FLOW TO THE LAST DECIMAL, and
    // saying so is the honest version of the ruling. The crown area is pinned
    // to `S_Lu` before and after; what moves is the YIELD MIX, because the
    // newcomer displaces the incumbents in proportion to fit and the plants it
    // takes ground from are not all worth the same per m². Measured at the
    // anchor: a BUSH-like newcomer (500 kcal/m², above the community's 456)
    // moves Σ flow +2.6 %; a CARROT-like one (174) moves it −4.6 %. That is
    // ecology — a cell that admits a richer plant is a slightly richer cell —
    // and it is two orders of magnitude away from the old law's +40 %.
    const members = membersAt(PLANET_CELL_CLIMATE);
    const supply = packSupplyAt(PLANET_CELL_CLIMATE, ANCHOR_ECO);
    const base = packStands(members, supply);
    // A believable temperate newcomer: bush-sized, bush-fit, bush yield.
    const bush = members.find((m) => m.key === "bush")!;
    const extra: PackMember = { key: "synthetic", fit: bush.fit, demand: { ...bush.demand } };
    const grown = packStands([...members, extra], supply);

    // ① THE LAND BUDGET IS UNCHANGED — the pass cannot conjure ground.
    //
    // ⚖️ AND IT SATURATES VERY SLIGHTLY BETTER WITH THE SIXTH MEMBER (129.4241
    // → 129.4896 m², which is `S_Lu` to the last digit). That is not noise: the
    // pass's second deal hands the slack the incumbents' SOLO CEILINGS left
    // behind to whoever can still use it, and a newcomer can. It is the
    // water-filling working, and the honest reading of "a hectare is a budget".
    const crown = (rows: { perHa: number }[], ms: PackMember[]): number =>
      ms.reduce((a, m, i) => a + rows[i]!.perHa * m.demand.Lu, 0);
    expect(crown(grown, [...members, extra])).toBeLessThanOrEqual(supply.Lu + 1e-9);
    expect(crown(grown, [...members, extra])).toBeGreaterThanOrEqual(crown(base, members));
    expect(crown(grown, [...members, extra])).toBeCloseTo(crown(base, members), 0);

    // ② AND THE FLOW DID NOT GROW BY A MEMBER'S WORTH.
    const areaYield = (rows: { key: string; perHa: number }[], ms: PackMember[]): number => {
      let kcal = 0;
      ms.forEach((m, i) => {
        const src = m.key === "synthetic" ? naturalSourceOf("bush")! : naturalSourceOf(m.key)!;
        const p = foodProductOf(src.species);
        kcal += rows[i]!.perHa * m.demand.Lu * forageYieldKcalPerM2Yr(src, p);
      });
      return (kcal * REAL_FORAGE_CAPTURE_FRACTION) / (365 * RATION_KCAL);
    };
    const before = areaYield(base, members);
    const after = areaYield(grown, [...members, extra]);
    expect(after / before).toBeGreaterThan(0.95);
    expect(after / before).toBeLessThan(1.05);
    // The counterfactual, said out loud: what the AUTHORED law would have added.
    const authored =
      (base[members.findIndex((m) => m.key === "bush")]!.perHa *
        rationsPerBearing(naturalSourceOf("bush")!, foodProductOf("bush"))) /
      (foodProductOf("bush").regrowDays ?? 1);
    expect(authored / before).toBeGreaterThan(0.3);   // +40 %, measured
    expect(after - before).toBeLessThan(authored / 10);

    // ③ …and the incumbents genuinely gave ground for it.
    const bushIdx = members.findIndex((m) => m.key === "bush");
    expect(grown[bushIdx]!.perHa).toBeLessThan(base[bushIdx]!.perHa);
    expect(grown[grown.length - 1]!.perHa).toBeGreaterThan(0);
  });

  it("REMOVING hazel raises the others, and still does not beat the anchor", () => {
    const members = membersAt(PLANET_CELL_CLIMATE);
    const supply = packSupplyAt(PLANET_CELL_CLIMATE, ANCHOR_ECO);
    const base = packStands(members, supply);
    const without = members.filter((m) => m.key !== "hazel");
    const thinned = packStands(without, supply);
    for (const key of ["bush", "apple_tree", "carrot_plant"]) {
      const b = base[members.findIndex((m) => m.key === key)]!.perHa;
      const t = thinned[without.findIndex((m) => m.key === key)]!.perHa;
      expect(t).toBeGreaterThan(b);                          // the ground re-deals
    }
    // …but the hectare is no richer for it: hazel is the DENSEST calorie in
    // the wood, so losing it costs flow even as the survivors thicken.
    let flow = 0;
    without.forEach((m, i) => {
      const src = naturalSourceOf(m.key)!;
      const p = foodProductOf(m.key);
      flow += (thinned[i]!.perHa * rationsPerBearing(src, p)) / (p.regrowDays ?? 1);
    });
    expect(flow).toBeLessThanOrEqual(forageRationsPerHaDaily(REAL_SCALE) * 1.001);
  });

  it("drier and poorer ground bears LESS, and that is water binding for real", () => {
    const anchor = flowAt(PLANET_CELL_CLIMATE, ANCHOR_ECO);
    const grass = flowAt(
      { rain: 0.5, tempC: 15, elevation: 5, fertility: 6, ore: 0 },
      { tree: 0.02, grass: 0.4 },
    );
    expect(grass).toBeLessThan(anchor);
    expect(grass / anchor).toBeGreaterThan(0.2);   // poorer, not barren
    expect(grass / anchor).toBeLessThan(0.5);
  });
});

describe("④ determinism — same inputs, byte-equal output, twice", () => {
  it("the pass is pure: no RNG, no clock, no session", () => {
    const members = membersAt(PLANET_CELL_CLIMATE);
    const supply = packSupplyAt(PLANET_CELL_CLIMATE, PLANET_CELL_ECO);
    const a = JSON.stringify(packStands(members, supply));
    const b = JSON.stringify(packStands(members, supply));
    expect(a).toBe(b);
    // …and it does not consume its inputs.
    expect(JSON.stringify(membersAt(PLANET_CELL_CLIMATE))).toBe(JSON.stringify(members));
    expect(supply).toEqual(packSupplyAt(PLANET_CELL_CLIMATE, PLANET_CELL_ECO));
  });
});

describe("⑤ the bearing law — a carry that never mints and never loses", () => {
  it("a bearing is the plant's own production, prorated to its cadence", () => {
    const src = naturalSourceOf("bush")!;
    const p = foodProductOf("bush");
    const expected =
      (forageYieldKcalPerM2Yr(src, p) *
        crownAreaM2(src) *
        ((p.regrowDays ?? 0) / 365) *
        REAL_FORAGE_CAPTURE_FRACTION) /
      RATION_KCAL;
    expect(rationsPerBearing(src, p)).toBeCloseTo(expected, 12);
    expect(itemsPerBearing(src, p)).toBeCloseTo(expected / satiationDaysOf("berry"), 12);
    // A small plant bears LESS than one item a cadence, a tree more — which is
    // the whole reason the carry exists.
    expect(itemsPerBearing(src, p)).toBeLessThan(1);
    expect(itemsPerBearing(naturalSourceOf("hazel")!, foodProductOf("hazel"))).toBeGreaterThan(1);
    // …and a row with no packing geometry answers 0, which callers read as
    // "keep the original one-unit law".
    const sheep = naturalSourceOf("sheep")!;
    expect(crownAreaM2(sheep)).toBe(0);
    expect(itemsPerBearing(sheep, harvestProductsOf("sheep")[0]!)).toBe(0);
  });

  it("🚨 over 1000 cadences the carry mints exactly ⌊n × rate⌋ — never one more, never one fewer", () => {
    const src = naturalSourceOf("bush")!;
    const rate = itemsPerBearing(src, foodProductOf("bush"));
    for (const pop of [1, 3, 12, 30]) {
      let carry = 0;
      let minted = 0;
      for (let k = 0; k < 1000; k++) {
        const total = carry + pop * rate;
        const whole = Math.floor(total);
        carry = total - whole;
        minted += whole;
        // The invariant, checked EVERY cadence rather than only at the end:
        // what has been minted plus what is still owed is exactly what the
        // plants have produced. Nothing is created, nothing evaporates.
        expect(minted + carry).toBeCloseTo((k + 1) * pop * rate, 6);
        expect(carry).toBeGreaterThanOrEqual(0);
        expect(carry).toBeLessThan(1);
        expect(Number.isInteger(whole)).toBe(true);
      }
      expect(minted).toBe(Math.floor(1000 * pop * rate));
    }
  });

  it("a plant that bears less than one item a cadence still bears, on schedule", () => {
    // The failure this forbids: floor a 0.53 every cadence with no carry and a
    // berry bush NEVER bears a berry, forever.
    const rate = itemsPerBearing(naturalSourceOf("bush")!, foodProductOf("bush"));
    let carry = 0;
    let first = -1;
    for (let k = 0; k < 100 && first < 0; k++) {
      carry += rate;
      if (carry >= 1) { carry -= 1; first = k + 1; }
    }
    expect(first).toBe(Math.ceil(1 / rate));
  });
});

describe("⑥ the seats stay where they are — the yield table and the satiation ladder", () => {
  it("the class table is real readings, and only the wild vine leaves its band", () => {
    expect(REAL_FORAGE_YIELD_KCAL_PER_M2_YR).toEqual({
      shrub_fruit: 500, mast: 533, tree_fruit: 260, herb_root: 174,
    });
    const overridden = (["apple_tree", "banana_plant", "grape_vine", "carrot_plant",
      "bush", "hazel", "wild_onion"] as const)
      .filter((sp) => foodProductOf(sp).yieldKcalPerM2Yr !== undefined);
    expect(overridden).toEqual(["grape_vine"]);
    const vine = naturalSourceOf("grape_vine")!;
    expect(forageYieldKcalPerM2Yr(vine, foodProductOf("grape_vine"))).toBe(110);
    // …and every other bearer resolves through its CLASS, never a per-row number.
    const apple = naturalSourceOf("apple_tree")!;
    expect(forageYieldKcalPerM2Yr(apple, foodProductOf("apple_tree")))
      .toBe(REAL_FORAGE_YIELD_KCAL_PER_M2_YR.tree_fruit);
  });

  it("🚫 `satiationDaysOf` DID NOT MOVE — the kcal figures are reported, not applied", () => {
    // The user's ruling stands ("fruits are roughly similar"): every raw food
    // still clears 0.2 person-days, whatever its calories say.
    for (const g of ["apple", "banana", "grape", "berry", "nut", "carrot", "onion"]) {
      expect(satiationDaysOf(g)).toBe(0.2);
    }
    // The REAL foundation under that class value, and the multiplier that
    // makes a real apple land on it exactly.
    expect(realSatiationDaysOf(95)).toBeCloseTo(95 / RATION_KCAL, 12);
    expect(gameplaySatiationDaysOf(95)).toBeCloseTo(0.2, 4);
    expect(ITEM_SATIATION_GAMEPLAY).toBeCloseTo(4.2105, 9);
    // …and the spread that keeps them OUT of the ladder for now, stated so a
    // future round can see what it would be spending.
    const kcal = (sp: string): number => foodProductOf(sp).kcalPerItem!;
    expect(gameplaySatiationDaysOf(kcal("bush"))).toBeCloseTo(0.105, 3);   // berry
    expect(gameplaySatiationDaysOf(kcal("hazel"))).toBeCloseTo(0.396, 3);  // nut
    expect(gameplaySatiationDaysOf(kcal("carrot_plant"))).toBeCloseTo(0.053, 3);
    expect(gameplaySatiationDaysOf(kcal("wild_onion"))).toBeCloseTo(0.008, 3);
  });

  it("every bearing plant declares its geometry, and the canopy declares but is not packed", () => {
    const bearers: NaturalSource[] = wildFoodPlants();
    for (const src of bearers) {
      expect(src.crownRadiusM).toBeGreaterThan(0);
      expect(src.rootRadiusM).toBeGreaterThan(0);
      // The root plate is never narrower than the crown — a plant that shades
      // more ground than it drinks from is not a plant.
      expect(rootAreaM2(src)).toBeGreaterThanOrEqual(crownAreaM2(src) - 1e-9);
      expect(forageYieldKcalPerM2Yr(src, foodProductOf(src.species))).toBeGreaterThan(0);
    }
    // The oak states its crown (the pass reads canopy COVER off the baked
    // field and a reader must be able to price a canopy stand) and bears no
    // food, so it can never be packed as forage.
    const oak = naturalSourceOf("oak")!;
    expect(oak.crownRadiusM).toBeGreaterThan(0);
    expect(oak.yieldClass).toBeUndefined();
    expect(bearers.some((s) => s.species === "oak")).toBe(false);
  });
});
