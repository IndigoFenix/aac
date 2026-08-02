// REFINERY EMERGENCE (resources-and-trade.md §③): DISTANCE is the reason
// refining exists, made mechanical —
//   • the LICENSE (freight.ts refineryLicense): a town whose raw good
//     cannot reach a market at its value density may refine it; a town
//     inside a market's reach ships raw. A dimensionless gate ratio with
//     its derivation printed (the fractal job-description law).
//   • the SITING (refinerySiting), one rung down: a fragile input pulls
//     the works to the input (the smelter to the fuel, the dairy to the
//     herd); everything else stands at the market.
//   • PRESERVATION IS REFINING: milk → cheese multiplies keepDays along
//     with valueDensity — the pastoralists' one exit from the fragile-
//     staple plateau (Gate A's negative case gets its door).
//   • the COMPILER (economy.ts `refines`): the why-here as a build-rule
//     gate on a per-settlement `{key}_license` scalar (initial 1 —
//     licensed until a host running the transport math revokes), and the
//     placement lean derived from the siting physics when unsaid.

import { describe, it, expect } from "@jest/globals";
import {
  carryReachM, freightOf, keepThroughLean, refineryLicense, refinerySiting,
  type NamedFreight,
} from "@shared/world-engine/freight.js";
import { REAL_SCALE, SEASONAL_SCALE } from "@shared/world-engine/scale.js";
import { naturalSources } from "@shared/world-engine/products.js";
import {
  compileEconomy, type BuildingDef, type EconomyDoc,
} from "@shared/world-engine/kernel/modules/economy/economy.js";
import { parseEconomyDoc } from "@shared/world-engine/kernel/modules/economy/json.js";
import {
  createWorld, stepWorld, type WorldSpec,
} from "@shared/world-engine/kernel/cells/index.js";

const row = (good: string): NamedFreight => ({ good, ...freightOf(good) });
const wool = row("wool");
const cloth = row("cloth");
const milk = row("milk");
const cheese = row("cheese");
const food = row("food");

describe("refineryLicense — you refine when the market is out of reach", () => {
  const reach = carryReachM(REAL_SCALE, wool);

  it("a market inside the raw good's reach refuses the license: ship it raw", () => {
    const v = refineryLicense(REAL_SCALE, wool, cloth, reach * 0.5);
    expect(v.licensed).toBe(false);
    expect(v.stranded).toBeCloseTo(0.5);
    expect(v.sentence).toMatch(/ships raw wool/);
  });

  it("a market beyond it licenses — and the refined form is what carries", () => {
    const v = refineryLicense(REAL_SCALE, wool, cloth, reach * 2);
    expect(v.licensed).toBe(true);
    expect(v.stranded).toBeCloseTo(2);
    // Both durable: reach scales with valueDensity alone (cloth = 2× wool).
    expect(v.refinedReachM / v.rawReachM).toBeCloseTo(cloth.valueDensity / wool.valueDensity);
    expect(v.sentence).toMatch(/refines its wool/);
    expect(v.sentence).toMatch(/as cloth it carries/);
  });

  it("licensed but honest when even the refined form falls short", () => {
    const v = refineryLicense(REAL_SCALE, wool, cloth, reach * 3);
    expect(v.licensed).toBe(true);
    expect(v.sentence).toMatch(/falls short/);
  });

  it("no market at all = the shadow case at its purest: licensed", () => {
    const v = refineryLicense(REAL_SCALE, wool, cloth, Infinity);
    expect(v.licensed).toBe(true);
    expect(v.stranded).toBe(Infinity);
    expect(v.sentence).toMatch(/no market exists/);
  });

  it("a fragile raw strands where a staple still travels (milk before grain)", () => {
    const milkReach = carryReachM(REAL_SCALE, milk);
    const foodReach = carryReachM(REAL_SCALE, food);
    expect(milkReach).toBeLessThan(foodReach); // capped at the loss half-life
    const between = (milkReach + foodReach) / 2;
    expect(refineryLicense(REAL_SCALE, milk, cheese, between).licensed).toBe(true);
    expect(refineryLicense(REAL_SCALE, food, cheese, between).licensed).toBe(false);
  });
});

describe("refinerySiting — the works stand where the physics puts them", () => {
  it("a fragile input pulls the works to it: the dairy stands at the herd", () => {
    const s = refinerySiting(milk, cheese);
    expect(s.at).toBe("input");
    expect(s.sentence).toMatch(/stands at its milk/);
  });

  it("a durable input frees the workshop for the market: the weaver at the square", () => {
    const s = refinerySiting(wool, cloth);
    expect(s.at).toBe("market");
    expect(s.sentence).toMatch(/stands at the market/);
  });

  it("the smelter walks to the fuel — charcoal is the doc's own example", () => {
    const charcoal: NamedFreight = { good: "charcoal", valueDensity: 4, transit: "fragile" };
    const iron: NamedFreight = { good: "iron", valueDensity: 16, transit: "durable" };
    expect(refinerySiting(charcoal, iron).at).toBe("input");
  });
});

describe("preservation is refining — milk → cheese crosses the winter", () => {
  it("the catalogue prices cheese as a refined, durable, KEEPING good", () => {
    expect(cheese.valueDensity).toBeGreaterThan(milk.valueDensity);
    expect(cheese.transit).toBe("durable");
    expect(cheese.keepDays).toBe(180);
  });

  it("the cow's milk declares the refinement, lossy in mass", () => {
    const cow = naturalSources().find(s => s.species === "cow")!;
    const m = cow.products.find(p => p.glyph === "milk")!;
    expect(m.refinesTo).toEqual({ into: "cheese", inPerOut: 5 });
  });

  it("the granary ratio flips across the refinement, on every clock", () => {
    for (const scale of [REAL_SCALE, SEASONAL_SCALE]) {
      // Milk can never be the granary (Gate A's pastoralist plateau)...
      expect(keepThroughLean(scale, milk)).toBeLessThan(0.1);
      // ...but its cheese crosses the lean window as a pile.
      expect(keepThroughLean(scale, cheese)).toBeGreaterThan(1);
    }
  });
});

// ---------------------------------------------------------------- compiler

const building = (key: string, extra: Partial<BuildingDef>): BuildingDef => ({
  key,
  countScalar: `${key}s`,
  cap: { by: "population", rate: 0.01 },
  processes: [],
  construction: { tier: "base", costs: [{ stockpile: "granary", amount: 25 }] },
  mapCap: 1,
  district: null,
  style: { color: "#888", w: 10, h: 10 },
  vignette: { w: 4, h: 4 },
  glyph: "🏭",
  title: key,
  info: [],
  ...extra,
});

const DOC: EconomyDoc = {
  stockpiles: [{ key: "granary", max: 400, construction: true }],
  commodities: [
    // The implicit human species eats "food" — every doc must set a table.
    { key: "food", scalarMax: 100, transport: {} },
    { key: "wool", scalarMax: 100, transport: {} },
    { key: "cloth", scalarMax: 100, transport: {} },
    { key: "milk", scalarMax: 100, transport: {} },
    { key: "cheese", scalarMax: 100, transport: {} },
  ],
  buildings: [
    building("sheepfold", {
      leansToward: "fertility",
      processes: [{ id: "graze", input: "population", output: "wool_out", efficiency: 0.01, capacityRate: 2 }],
    }),
    building("barn", {
      leansToward: "plant",
      processes: [{ id: "milking", input: "population", output: "milk_out", efficiency: 0.01, capacityRate: 2 }],
    }),
    // The two refineries leave `leansToward` UNSAID — the siting derives it.
    building("weaver", {
      refines: { from: "wool", into: "cloth" },
      processes: [{ id: "weave", input: "wool_got", output: "cloth_out", efficiency: 1 }],
    }),
    building("dairy", {
      refines: { from: "milk", into: "cheese" },
      processes: [{ id: "curdle", input: "milk_got", output: "cheese_out", efficiency: 0.5 }],
    }),
  ],
};

describe("compileEconomy — refines becomes a license gate and a derived lean", () => {
  const eco = compileEconomy([DOC], { construction: true });

  it("emits the license vars, initial 1 (licensed until geography says no)", () => {
    for (const name of ["weaver_license", "dairy_license"]) {
      const v = eco.vars.find(x => x.name === name);
      expect(v).toEqual({ name, min: 0, max: 1, initial: 1, int: true });
    }
  });

  it("gates ONLY the refinery build rules on their license", () => {
    const gateOf = (id: string) =>
      (eco.rules.find(r => r.id === id)!.when as { all: Array<{ left: { scalar?: string } }> }).all
        .some(c => c.left.scalar?.endsWith("_license"));
    expect(gateOf("build-weaver")).toBe(true);
    expect(gateOf("build-dairy")).toBe(true);
    expect(gateOf("build-sheepfold")).toBe(false);
    expect(gateOf("build-barn")).toBe(false);
  });

  it("lists the refineries with their derived siting", () => {
    expect(eco.refineries).toEqual([
      {
        building: "weaver", from: "wool", into: "cloth", license: "weaver_license",
        siting: "market", sentence: expect.stringMatching(/stands at the market/),
      },
      {
        building: "dairy", from: "milk", into: "cheese", license: "dairy_license",
        siting: "input", sentence: expect.stringMatching(/stands at its milk/),
      },
    ]);
  });

  it("derives the unsaid lean: the dairy leans where its milk comes from", () => {
    const lean = (key: string) => eco.works.find(w => w.key === key)!.leansToward;
    expect(lean("dairy")).toBe("plant"); // the barn's own lean
    expect(lean("weaver")).toBe(null); // market siting keeps the plain lean
    expect(lean("sheepfold")).toBe("fertility"); // authored rows untouched
  });

  it("without construction there is no license var — but the registry stands", () => {
    const bare = compileEconomy([DOC]);
    expect(bare.vars.some(v => v.name.endsWith("_license"))).toBe(false);
    expect(bare.refineries.length).toBe(2);
  });

  it("refuses a refinement of unknown goods, and one that multiplies no value", () => {
    const withRefines = (refines: { from: string; into: string }): EconomyDoc => ({
      ...DOC,
      buildings: [...DOC.buildings!.slice(0, 2), building("odd", {
        refines, processes: [{ id: "x", input: "wool_got", output: "cloth_out", efficiency: 1 }],
      })],
    });
    expect(() => compileEconomy([withRefines({ from: "silk", into: "cloth" })]))
      .toThrow(/refines from unknown commodity "silk"/);
    // Backwards: cloth (4) into wool (2) concentrates nothing.
    expect(() => compileEconomy([withRefines({ from: "cloth", into: "wool" })]))
      .toThrow(/must multiply value/);
  });
});

describe("the gate is load-bearing: an unlicensed town never grows the refinery", () => {
  it("two towns, one verdict each — and a relicensed town resumes growing", () => {
    const eco = compileEconomy([DOC], { construction: true });
    const spec: WorldSpec = {
      id: "refinery-lab",
      entity: {
        id: "town",
        vars: [{ name: "population", min: 0, max: 1_000_000, initial: 0 }, ...eco.vars],
        rules: eco.rules,
      },
      processes: eco.processes,
      sums: eco.sums,
      allocates: eco.allocates,
      flownets: eco.flownets,
    };
    const w = createWorld(spec, 2, []);
    for (const i of [0, 1]) {
      w.scalars.population[i] = 500; // caps: 5 of everything
      w.scalars.granary[i] = 400; // funding for the whole ladder
    }
    w.scalars.weaver_license[1] = 0; // town 1's market is within wool's reach

    for (let d = 0; d < 3; d++) stepWorld(w);
    expect(w.scalars.weavers[0]).toBeGreaterThan(0);
    expect(w.scalars.weavers[1]).toBe(0); // the gate held
    expect(w.scalars.sheepfolds[1]).toBeGreaterThan(0); // everything else builds

    // The market moved away (a desettlement, say): growth resumes — the
    // license gates GROWTH; it never demolishes or freezes history.
    w.scalars.weaver_license[1] = 1;
    stepWorld(w);
    expect(w.scalars.weavers[1]).toBeGreaterThan(0);
  });
});

describe("the JSON gate — refines parses; leansToward may be unsaid only then", () => {
  const jsonBuilding = (extra: Record<string, unknown>): Record<string, unknown> => ({
    key: "weaver", countScalar: "weavers",
    cap: { by: "population", rate: 0.01 },
    processes: [{ id: "weave", input: "wool_got", output: "cloth_out", efficiency: 1 }],
    construction: { tier: "base", costs: [{ stockpile: "granary", amount: 25 }] },
    mapCap: 1, district: null,
    style: { color: "#888", w: 10, h: 10 }, vignette: { w: 4, h: 4 },
    glyph: "🧵", title: "Weaver", info: [],
    ...extra,
  });
  const doc = (b: Record<string, unknown>): unknown => ({ buildings: [b] });

  it("parses the refines block, leansToward absent", () => {
    const parsed = parseEconomyDoc(doc(jsonBuilding({ refines: { from: "wool", into: "cloth" } })), "t");
    expect(parsed.buildings![0].refines).toEqual({ from: "wool", into: "cloth" });
    expect("leansToward" in parsed.buildings![0]).toBe(false);
  });

  it("still requires leansToward on a building that refines nothing", () => {
    expect(() => parseEconomyDoc(doc(jsonBuilding({})), "t")).toThrow(/leansToward/);
  });

  it("rejects a malformed refines block", () => {
    expect(() => parseEconomyDoc(doc(jsonBuilding({ refines: { from: "wool" } })), "t")).toThrow();
  });
});
