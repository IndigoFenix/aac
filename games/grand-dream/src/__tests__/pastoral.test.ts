/**
 * PASTORAL — horses as content (substrate-civilization-rules.md): a
 * domestic herd that breeds only into stable headroom, stables anchored
 * on the PASTURE charter (the biosphere's grass), and `horsepower`
 * mustered from the actual herd — the scalar a composition feeds to the
 * travel rules as `mount`. The aggregate half is the calibration probe
 * (pasture → stables → herd → horsepower actually grows inside the
 * fed-transient economy); the compile half pins the coupling shapes.
 */

import { describe, expect, it } from "vitest";
import { foundTri, prepareSubstrate } from "../tri";
import {
  FOUNDING, TIERS, TREELINE, pickBiomes, ridgeValley,
  triBase, triEconomy, villageSeed,
} from "../tri-worlds";
import { citizenStartpop } from "../economy";
import { MOUNT_PER_CAPITA, PASTORAL, mountLevel } from "../economy-pastoral";

const OPTS = { construction: true, goods2: true, extraContent: [PASTORAL] };

describe("pastoral: the grazing economy compiles", () => {
  it("stables anchor on pasture and muster horsepower from the herd", () => {
    const eco = triEconomy(OPTS);
    const muster = eco.processes.find(p => p.id === "muster")!;
    expect(muster.input).toBe("horse_count");
    expect(muster.output).toBe("horsepower");
    expect(muster.capacityBy).toBe("stables");
    // The capacity anchor is the pasture charter, not farmland.
    expect(eco.processes.find(p => p.id === "stable-cap")).toEqual({
      id: "stable-cap", input: "pasture", output: "stable_cap", efficiency: 1 / 60,
    });
    // Funding stagger appends to the industry tier: sawmill 25 → smithy 55 → stable 85.
    const stable = eco.rules.find(r => r.id === "build-stable")!;
    const all = (stable.when as { all: Array<{ left?: { scalar?: string }; right?: { const?: number } }> }).all;
    expect(all.find(c => c.left?.scalar === "granary")?.right?.const).toBe(85);
  });

  it("horses are a diet-free pens-capped herd that founds with the crowd", () => {
    const eco = triEconomy(OPTS);
    const horse = eco.species.find(s => s.key === "horse")!;
    expect(horse.role).toBe("domestic");
    expect(horse.vitals?.diet).toBeUndefined(); // grazes the commons, eats no commodity
    expect(horse.vitals?.capacity).toEqual({ scalar: "stables", perUnit: 6 });
    // No demand rows ride the horse trait (contrast sheep's fodder).
    expect(eco.speciesTraits.find(t => t.key === "horse")?.demand).toEqual([]);
    // 3% of a founding crowd is the horse string.
    expect(citizenStartpop(eco)).toContainEqual({ size: 300, apply: ["horse"] });
  });

  it("mountLevel saturates at one working mount per 50 souls", () => {
    expect(mountLevel(0, 1000)).toBe(0);
    expect(mountLevel(10, 1000)).toBeCloseTo(0.5, 10);
    expect(mountLevel(1000 * MOUNT_PER_CAPITA, 1000)).toBe(1);
    expect(mountLevel(500, 1000)).toBe(1); // clamped
    expect(mountLevel(5, 0)).toBe(0);
  });
});

describe("pastoral: the calibration probe", () => {
  it("pasture grows stables, the herd fills them, horsepower musters", { timeout: 240000 }, async () => {
    const prep = prepareSubstrate({ cols: 48, rows: 32, height: ridgeValley, treeline: TREELINE, founding: FOUNDING, oreSeed: 7 });
    const { valley } = pickBiomes(prep);
    const eco = triEconomy(OPTS);
    const tri = await foundTri(prep, {
      base: triBase(OPTS),
      economy: eco,
      cities: [{
        at: valley, key: "valley", name: "Valleyton",
        // The bare test substrate carries no ecology — hand the founding
        // the grassland charter an applied biosphere would have sampled.
        scalars: (ch, pop) => ({ ...villageSeed(ch, pop), pasture: 150 }),
        site: { startpop: citizenStartpop(eco, ["member_x"]) },
      }],
      edges: [],
      peopleScale: 25,
      seed: 11,
      tiers: TIERS,
      mining: { oreOutScalar: "ore_out", rate: 0.3 },
    });
    const scal = (s: string): number => tri.dual.settlementScalar("valley", s);

    for (let day = 0; day < 600 && scal("stables") === 0; day += 10) {
      await tri.advanceDays(10);
    }
    await tri.advanceDays(60); // let the herd breed into the headroom

    // Industry after subsistence: the stable came after the base stack.
    expect(scal("farms")).toBeGreaterThanOrEqual(scal("farm_cap") - 0.01);
    // Grass carried the anchor: stables stand on the pasture charter.
    expect(scal("stables")).toBeGreaterThan(0);
    expect(scal("stable_cap")).toBeCloseTo(150 / 60, 5);
    // The founding string survived and bred into the stalls.
    expect(scal("horse_count")).toBeGreaterThan(0);
    // The muster is live — and it is what travel reads as `mount`.
    expect(scal("horsepower")).toBeGreaterThan(0);
    expect(mountLevel(scal("horsepower"), scal("population"))).toBeGreaterThan(0);
  });
});
