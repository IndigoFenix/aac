/**
 * CONSTRAINT CEILINGS over the tri world (resources-and-trade.md §④):
 * the anchor stops being hand-authored. With `ceilings` declared, every
 * living city's `pop_ceiling` scalar is written daily as the MIN of its
 * declared constraints over its supply zone — and the existing pens
 * machinery (`vitals.capacity`) makes it LOAD-BEARING: bind the human
 * policy's capacity to the scalar and births taper as a town approaches
 * what its land can feed. No new dynamics anywhere — a derived number
 * flowing into anchors that always existed.
 *
 * Two scenarios:
 *  1. the READING — valley vs highland on ridgeValley: the fertile
 *     valley out-ceilings the ore country, the scalar equals the
 *     report's derivation, and an over-ceiling town prints the parasite
 *     sentence.
 *  2. the ANCHOR IS LOAD-BEARING — a village whose ceiling sits far
 *     below its founding crowd DECLINES while its food fill stays fine:
 *     with headroom 0 the births stop, and the Malthusian death rate
 *     does the rest. Without the gate the same village grows.
 */

import { describe, it, expect } from "vitest";
import { prepareSubstrate, foundTri } from "../tri";
import {
  TREELINE, FOUNDING, ridgeValley, triBase, triEconomy, villageSeed, CITIZEN, pickBiomes,
} from "../tri-worlds";
import { REAL_SCALE } from "@shared/world-engine/scale";
import { carryReachM } from "@shared/world-engine/freight";
import type { ConstraintDef } from "@shared/world-engine/kernel/cells/index.js";
import type { EconomyDoc } from "@shared/world-engine/kernel/modules/economy/economy";

// Pitch: the caloric anchor reaches 6 cells on this chart.
const cellM = carryReachM(REAL_SCALE, { valueDensity: 1, transit: "selfConsuming" }) / 6;
const CONSTRAINTS: ConstraintDef[] = [
  { key: "food", field: "fertility", headsPerUnit: 10 },
  { key: "fuel", field: "plant", headsPerUnit: 40, good: "wood" },
];

const prep = () => prepareSubstrate({
  cols: 48, rows: 32, height: ridgeValley, treeline: TREELINE, founding: FOUNDING, oreSeed: 7,
});

describe("ceilings — the derived anchor, live over the tri world", () => {
  it("valley out-ceilings ore country; the scalar IS the derivation; parasites print", { timeout: 120000 }, async () => {
    const p = prep();
    const { valley, highland } = pickBiomes(p);
    const eco = { construction: true };
    const tri = await foundTri(p, {
      base: triBase(eco),
      economy: triEconomy(eco),
      cities: [
        { at: valley, key: "dale", name: "Dale", site: { ...CITIZEN }, scalars: (c, pop) => villageSeed(c, pop) },
        { at: highland, key: "crag", name: "Crag", site: { ...CITIZEN }, scalars: (c, pop) => villageSeed(c, pop) },
      ],
      edges: [["dale", "crag"]],
      peopleScale: 25,
      seed: 1206,
      ceilings: { scale: REAL_SCALE, cellM, constraints: CONSTRAINTS },
    });
    await tri.advanceDays(1);

    const arr = tri.dual.entityWorld.scalars.pop_ceiling;
    const report = tri.ceilingReport();
    const dale = report.find(r => r.city === "dale")!;
    const crag = report.find(r => r.city === "crag")!;

    // The scalar the vitals would read IS the report's derivation.
    expect(arr[0]).toBe(dale.reading.ceiling);
    expect(arr[1]).toBe(crag.reading.ceiling);
    // Fertile valley over ore ridge — geography orders the anchors. The
    // ridge above the treeline grows NOTHING: its honest ceiling can be
    // zero, which is the point — a mining camp's crowd lives on ore lure,
    // and every soul of it is above what the rock can feed.
    expect(dale.reading.ceiling).toBeGreaterThan(crag.reading.ceiling);
    expect(dale.reading.ceiling).toBeGreaterThan(0);
    expect(dale.sentence).toMatch(/capped at \d+ souls by/);
    expect(crag.pop).toBeGreaterThan(crag.reading.ceiling);
    expect(crag.parasite).toBe(true);
    expect(crag.sentence).toMatch(/a parasite: legal only while a partner covers the gap/);
    expect(crag.sentence).toMatch(/leaves, not riots/);
  });

  it("the anchor is LOAD-BEARING: bind vitals capacity and an over-ceiling town declines, not grows", { timeout: 240000 }, async () => {
    // The human policy, capacity-bound to the derived anchor — content,
    // via the sanctioned species override (merge replaces "human").
    const HUMAN_CAPPED: EconomyDoc = {
      species: [{
        key: "human", role: "sapient", name: "Human", color: "150,150,150,1", civic: true,
        vitals: {
          birth: 0.02, death: 0.01, starvation: 0.05, diet: "food",
          capacity: { scalar: "pop_ceiling", perUnit: 1 },
        },
        wild: { field: "forage", habitat: "lure", scale: 2 },
      }],
    };
    // Rates so tiny the valley's own ceiling sits far under its crowd.
    const TIGHT: ConstraintDef[] = [{ key: "food", field: "fertility", headsPerUnit: 0.01 }];

    const run = async (capped: boolean): Promise<{ pop0: number; pop40: number }> => {
      const p = prep();
      const { valley } = pickBiomes(p);
      const eco = { construction: true, ...(capped ? { extraContent: [HUMAN_CAPPED] } : {}) };
      const tri = await foundTri(p, {
        base: triBase(eco),
        economy: triEconomy(eco),
        cities: [{ at: valley, key: "dale", name: "Dale", site: { ...CITIZEN }, scalars: (c, pop) => villageSeed(c, pop) }],
        edges: [],
        peopleScale: 25,
        seed: 1206,
        ceilings: { scale: REAL_SCALE, cellM, constraints: TIGHT },
      });
      const pop0 = tri.dual.settlementPop("dale");
      await tri.advanceDays(40);
      return { pop0, pop40: tri.dual.settlementPop("dale") };
    };

    const gated = await run(true);
    const free = await run(false);
    expect(gated.pop0).toBe(free.pop0); // same founding, same crowd
    // Headroom 0 ⇒ no births ⇒ the death rate alone bends the curve down…
    expect(gated.pop40).toBeLessThan(gated.pop0);
    // …while the unbound twin, eating the same fields, grows past it.
    expect(free.pop40).toBeGreaterThan(free.pop0);
  });
});
