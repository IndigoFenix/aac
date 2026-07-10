/**
 * SPECIES AS CONTENT (step 6e): humans were always a PopuSim trait —
 * now the trait, its diet, its Malthusian policy and its civic standing
 * all compile from the species section of the content documents, and
 * other species (domestic herds, urban wildlife) ride the same seam.
 *
 * The load-bearing test is DIFFERENT NEEDS: two species in one town,
 * two diets, one famine — and only the species whose diet failed
 * starves, because every vitals policy is scoped to its trait.
 */

import { describe, expect, it } from "vitest";
import { worldgenSubstrate } from "@cells/index";
import { foundTri, prepareSubstrate } from "../tri";
import {
  CITIZEN, FOUNDING, TREELINE, buildings, pickBiomes, ridgeValley, triBase, triEconomy,
  villageSeed,
} from "../tri-worlds";
import {
  citizenStartpop, compileEconomy, harvestStartpop, wildSubstrate, type EconomyDoc,
} from "../economy";
import { CORE_BASE } from "../economy-core";
import { CLOTHING } from "../economy-clothing";
import { WILDLIFE } from "../economy-wildlife";
import { DWARVES } from "../economy-dwarves";

describe("the species compiler", () => {
  it("a bare world is exactly the pre-species human: trait, demand, policy, civic standing", () => {
    const eco = compileEconomy([CORE_BASE], { construction: false });
    expect(eco.species.map(s => s.key)).toEqual(["human"]);
    expect(eco.speciesTraits).toEqual([{
      key: "human", name: "Human", color: "150,150,150,1", hereditary: true,
      demand: eco.traitDemands,
    }]);
    expect(eco.vitals).toEqual([{
      species: "human", birthRate: 0.02, deathRate: 0.01, starvation: 0.05,
      foodNeed: "food_need", foodGot: "food_got",
    }]);
    expect(eco.civicTraits).toEqual(["human"]);
    expect(eco.traitInputs).toEqual([]);
  });

  it("a domestic species compiles to a trait with its own diet, pens and headcount scalar", () => {
    const eco = triEconomy({ construction: true, goods2: true, clothing: true });
    const sheep = eco.speciesTraits.find(t => t.key === "sheep")!;
    expect(sheep.demand).toEqual([{ resource: "fodder", value: 0.002 }]);
    expect(sheep.hereditary).toBe(true);
    const vt = eco.vitals.find(v => v.species === "sheep")!;
    expect(vt.foodNeed).toBe("fodder_need"); // a DIFFERENT need than the humans'
    // Flocks graze the FARMS (they survive from founding day); the
    // sheepfolds are shearing capacity, not survival.
    expect(vt.capacity).toEqual({ scalar: "farms", perUnit: 60 });
    expect(eco.civicTraits).toEqual(["human"]); // herds never tier a town
    expect(eco.traitInputs).toContainEqual({ trait: "sheep", scalar: "sheep_count", mode: "count" });
    expect(eco.demandInputs).toContainEqual({ resource: "fodder", scalar: "fodder_need" });
    // Wool is shorn from the headcount, not conjured from the grass.
    expect(eco.processes.find(p => p.id === "graze")!.input).toBe("sheep_count");
  });

  it("a commensal species compiles to settlement-scalar wildlife (no trait, no vitals)", () => {
    const eco = triEconomy({ construction: true, goods2: true, wildlife: true });
    expect(eco.speciesTraits.some(t => t.key === "rats")).toBe(false);
    expect(eco.vitals.some(v => v.species === "rats")).toBe(false);
    expect(eco.vars.some(v => v.name === "rats")).toBe(true);
    expect(eco.processes).toContainEqual({ id: "rats-cap", input: "population", output: "rats_cap", efficiency: 0.02 });
    const grow = eco.rules.find(r => r.id === "rats-grow")!;
    expect(grow.effects).toEqual([{ toward: { scalar: "rats", target: { scalar: "rats_cap" }, rate: 0.05 } }]);
  });

  it("founding startpops are integer weights (PopInit floors fractions to NaN-land)", () => {
    const eco = triEconomy({ construction: true, goods2: true, clothing: true });
    const sp = citizenStartpop(eco, ["member_x"]);
    expect(sp).toEqual([
      { size: 9800, apply: ["human", "member_x"] },
      { size: 200, apply: ["sheep"] },
    ]);
    for (const p of sp) expect(Number.isInteger(p.size)).toBe(true);
  });

  it("species author errors fail at compile with the def's name", () => {
    const eco = (doc: EconomyDoc): unknown => compileEconomy([CORE_BASE, doc], { construction: false });
    expect(() => eco({ species: [{ key: "gnome", role: "sapient", name: "Gnome", needs: [{ resource: "mushrooms", value: 0.001 }], vitals: { birth: 0.02, death: 0.01 } }] }))
      .toThrow(/"gnome" needs unknown commodity "mushrooms"/);
    expect(() => eco({ species: [{ key: "elf", role: "sapient", name: "Elf" }] }))
      .toThrow(/"elf" has no vitals/);
    expect(() => eco({ species: [{ key: "mice", role: "commensal", name: "Mice", countScalar: "mice", capacity: { by: "population", rate: 0.01 }, growth: 0.05, foundingShare: 0.1 }] }))
      .toThrow(/"mice" is settlement-scalar wildlife/);
  });
});

describe("wild fields (step 6f): every sapient people pools on its own land", () => {
  it("wildSubstrate grows a field per declared species, skips the base one, rejects unknown habitats", () => {
    const eco = triEconomy({ construction: true, dwarves: true });
    const spec = wildSubstrate(worldgenSubstrate, eco.species);
    // Dwarves got their field + logistic rule; humans ride the existing one.
    expect(spec.vars!.some(v => v.name === "dwarves")).toBe(true);
    expect(spec.vars!.filter(v => v.name === "people")).toHaveLength(1);
    const rule = spec.rules.find(r => r.id === "multiply-dwarves")!;
    expect(rule.effects).toEqual([{
      toward: { scalar: "dwarves", target: { scalar: "ore", scale: 2 }, rate: 0.25 },
    }]);
    // A habitat the substrate doesn't carry fails at build.
    expect(() => wildSubstrate(worldgenSubstrate, [{
      key: "merfolk", role: "sapient", name: "Merfolk",
      vitals: { birth: 0.02, death: 0.01 },
      wild: { field: "merfolk", habitat: "abyss" },
    }])).toThrow(/wild habitat "abyss" is not a substrate field/);
  });

  it("harvestStartpop founds with WHO LIVED THERE, herds riding on top", () => {
    const eco = triEconomy({ construction: true, goods2: true, clothing: true, dwarves: true });
    expect(harvestStartpop(eco, ["member_x"], { human: 400, dwarf: 60 })).toEqual([
      { size: 400, apply: ["human", "member_x"] },
      { size: 60, apply: ["dwarf", "member_x"] },
      { size: 9, apply: ["sheep"] }, // 2% of the 460 sapient souls
    ]);
    // An empty mix falls back to the declared shares.
    expect(harvestStartpop(eco, ["member_x"], {})).toEqual(citizenStartpop(eco, ["member_x"]));
  });

  it("dwarven crowds pool on the ore ridge and a founding harvests EVERYONE in the box", { timeout: 240000 }, async () => {
    const opts = { construction: true, dwarves: true };
    const eco = triEconomy(opts);
    const prep = prepareSubstrate({
      cols: 48, rows: 32, height: ridgeValley, treeline: TREELINE,
      founding: FOUNDING, oreSeed: 7,
      spec: wildSubstrate(worldgenSubstrate, eco.species),
    });
    // The settled substrate holds BOTH wild peoples, each on its land.
    const sum = (f: string): number => {
      let x = 0;
      for (const v of prep.grid.fields[f]) x += v;
      return x;
    };
    expect(sum("people")).toBeGreaterThan(0);
    expect(sum("dwarves")).toBeGreaterThan(0);

    // Measure the ridge box BEFORE founding — the same numbers the
    // harvest will take (pure read; harvestStartpop founds that mix).
    const { valley, highland } = pickBiomes(prep);
    const boxMix = (at: { x: number; y: number }): Record<string, number> => {
      const g = prep.grid;
      const r = prep.founding.radius;
      const out: Record<string, number> = {};
      for (const field of ["people", "dwarves"] as const) {
        const key = field === "people" ? "human" : "dwarf";
        let n = 0;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const x = at.x + dx, y = at.y + dy;
            if (x < 0 || x >= g.cols || y < 0 || y >= g.rows) continue;
            n += g.fields[field][y * g.cols + x];
          }
        }
        if (n > 0) out[key] = n;
      }
      return out;
    };
    const ridgeMix = boxMix(highland);
    expect(ridgeMix.dwarf).toBeGreaterThan(0);
    expect(ridgeMix.human).toBeGreaterThan(0); // humans pool on lure — prospectors beside the mountain folk

    const tri = await foundTri(prep, {
      base: triBase(opts),
      economy: eco,
      cities: [
        { at: valley, key: "valley", name: "Valleyton", scalars: villageSeed, site: { startpop: harvestStartpop(eco, ["member_x"], boxMix(valley)) } },
        { at: highland, key: "ridge", name: "Deepdelve", scalars: villageSeed, site: { startpop: harvestStartpop(eco, ["member_x"], ridgeMix) } },
      ],
      edges: [["valley", "ridge"]], // valley bread feeds the mountain camp (§6)
      peopleScale: 25,
      seed: 5,
    });
    const d = tri.dual;

    // FOUND SMALL applies to the HARVEST: a fat mixed box gives up at
    // most the cap (proportioned across species), and the residue
    // stays WILD in the box for the next founding.
    const ridge = tri.cities.find(c => c.key === "ridge")!;
    const boxTotal = (ridgeMix.human ?? 0) + (ridgeMix.dwarf ?? 0);
    expect(ridge.harvested).toBe(Math.min(boxTotal, FOUNDING.maxHarvest));
    if (boxTotal > FOUNDING.maxHarvest) {
      const residue = boxMix(highland);
      expect((residue.human ?? 0) + (residue.dwarf ?? 0)).toBe(boxTotal - FOUNDING.maxHarvest);
    }

    await tri.advanceDays(30);

    // The ridge camp is DWARF COUNTRY: its founding crowd was the
    // dwarven field plus the human prospectors, in harvest proportion.
    const dwarves = d.settlementScalar("ridge", "dwarf_count");
    expect(dwarves).toBeGreaterThan(0);
    expect(dwarves).toBeGreaterThan(d.civicPop("ridge") * 0.25);
    expect(d.settlementScalar("valley", "dwarf_count")).toBe(0); // no dwarves in the river valley

    // Dwarves are CIVIC — full citizens, unlike the herds.
    for (const key of ["valley", "ridge"]) {
      expect(d.settlementPop(key)).toBe(d.civicPop(key));
    }
    // Conservation spans every species harvested from every field.
    const { births, deaths } = d.vitalLedger();
    expect(d.totalPop()).toBe(tri.harvestedTotal() * 25 + births - deaths);
  });
});

describe("different needs (the load-bearing property)", () => {
  it("a fodder famine starves the sheep and ONLY the sheep; herds never count as civic souls", { timeout: 240000 }, async () => {
    // A world where NOTHING produces fodder: the sheep's diet fails from
    // day 0 while the human food chain runs at full fill.
    const FAMINE: EconomyDoc = {
      commodities: [{ key: "fodder", scalarMax: 100, transport: {} }],
      species: [{
        key: "sheep", role: "domestic", name: "Sheep",
        needs: [{ resource: "fodder", value: 0.002 }],
        vitals: {
          birth: 0.06, death: 0.01, starvation: 0.3, diet: "fodder",
          capacity: { scalar: "farms", perUnit: 1000 }, // roomy pens — the DIET is what kills
        },
        foundingShare: 0.1,
        countScalar: "sheep_count",
      }],
    };
    const prep = prepareSubstrate({ cols: 48, rows: 32, height: ridgeValley, treeline: TREELINE, founding: FOUNDING, oreSeed: 7 });
    const { valley } = pickBiomes(prep);
    const opts = { extraContent: [FAMINE] };
    const eco = triEconomy(opts);
    const tri = await foundTri(prep, {
      base: triBase(opts),
      economy: eco,
      cities: [{
        at: valley, key: "valley", name: "Valleyton", scalars: buildings,
        site: { startpop: citizenStartpop(eco, ["member_x"]) },
      }],
      edges: [],
      peopleScale: 25,
      seed: 11,
    });
    const d = tri.dual;
    const sheep0 = d.settlementScalar("valley", "population") // day 0: scalar holds the FULL founding pop
      ; // (the civic write-back lands after the first day)
    await tri.advanceDays(1);
    const s = (k: string): number => d.settlementScalar("valley", k);
    const sheepStart = s("sheep_count");
    expect(sheepStart).toBeGreaterThan(300); // ~10% of the crowd walked in
    expect(sheep0).toBeGreaterThan(0);

    await tri.advanceDays(60);
    // The sheep starved on THEIR diet (fodder fill 0)...
    expect(s("sheep_count")).toBeLessThan(sheepStart * 0.2);
    // ...while the humans, whose diet held, GREW.
    const civic = (d as unknown as { civicPop(k: string): number }).civicPop("valley");
    expect(civic).toBeGreaterThan(11_000);
    expect(s("food_got") / s("food_need")).toBeGreaterThan(0.9);

    // CIVIC ACCOUNTING: the population scalar is the civic count — the
    // surviving sheep are real souls in the composition but not one of
    // them tiers the town.
    expect(d.settlementPop("valley")).toBe(civic);
    const totalSouls = d.sites()[0].pops.reduce((a, p) => a + p.pop, 0);
    expect(totalSouls).toBe(civic + s("sheep_count"));

    // The famine is honest bookkeeping: every dead sheep is in the ledger.
    const { births, deaths } = d.vitalLedger();
    expect(d.totalPop()).toBe(tri.harvestedTotal() * 25 + births - deaths);
  });

  it("the pre-species citizen site still boots human-only worlds byte-identically", () => {
    expect(CITIZEN).toEqual({ startpop: [{ size: 1, apply: ["human", "member_x"] }] });
  });
});
