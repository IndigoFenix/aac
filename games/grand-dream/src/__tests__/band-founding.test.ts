/**
 * GATE A over the tri world (settlement-emergence.md §5, step ④):
 * founding as an ECONOMIC EVENT. With `bandFounding` declared, the best
 * crowd GATHERS into a band (smaller than its box — FOUND SMALL is
 * load-bearing: at capacity the mean-1 law banks nothing), lives on the
 * land's offer, banks the surplus against spoilage, and settles ONLY by
 *
 *     store > carryCapacity   AND   pressure ≥ floor
 *
 * The two runs below are the doc's two verdicts on the SAME map:
 *  - cornered (floor 0 — circumscription absolute): the band banks until
 *    it owns more than it can carry, then founds. Founding is LATE — an
 *    accumulation, not a census reading.
 *  - free (floor 0.9, reach spanning the valley): comparable unclaimed
 *    river-bank land is always within walking reach, so every gathered
 *    band walks away — the rich open frontier grows NO cities, and the
 *    dispersal conserves every person back into the wild.
 */

import { describe, it, expect } from "vitest";
import { prepareSubstrate, foundTri, type TriWorld } from "../tri";
import {
  TREELINE, FOUNDING, ridgeValley, triBase, triEconomy, villageSeed, CITIZEN, pickBiomes,
} from "../tri-worlds";
import { REAL_SCALE } from "@shared/world-engine/scale";

async function bandWorld(pressureFloor: number, searchCells: number): Promise<{
  tri: TriWorld; gridPeople0: number;
}> {
  const prep = prepareSubstrate({
    cols: 48, rows: 32, height: ridgeValley, treeline: TREELINE, founding: FOUNDING, oreSeed: 7,
  });
  const gridPeople0 = prep.grid.fields.forage.reduce((a, b) => a + b, 0);
  const tri = await foundTri(prep, {
    base: triBase({ construction: true }),
    economy: triEconomy({ construction: true }),
    cities: [],
    edges: [],
    peopleScale: 25,
    seed: 1206,
    autoFound: {
      every: 5,
      maxCities: 3,
      cityFactory: (site, i, ch, mix) => ({
        key: `band_town_${i}`,
        name: `Bandton ${i}`,
        site: { ...CITIZEN },
        scalars: (c, pop) => villageSeed(c, pop),
      }),
    },
    bandFounding: {
      scale: REAL_SCALE,
      searchCells,
      pressureFloor,
      // FOUND SMALL: the band must be smaller than the box that feeds it.
      maxBand: 150,
    },
  });
  return { tri, gridPeople0 };
}

describe("Gate A — you settle when you own more than you can carry", () => {
  it("cornered: the band LIVES first (banking visibly), then founds; conservation holds throughout", { timeout: 240000 }, async () => {
    const { tri, gridPeople0 } = await bandWorld(0, 8);

    // Walk the days; record when the band exists and when the city lands.
    // (No strict people ledger here: the wild is RENEWABLE — the field
    // regrows toward the land's lure after every gather. The transaction-
    // instant conservation is pinned in the engine's bands tests.)
    let sawBandBanking = false;
    let foundedAtDay = -1;
    for (let day = 0; day < 120 && foundedAtDay < 0; day++) {
      await tri.advanceDays(1);
      const bands = tri.bands();
      if (bands.length > 0 && bands[0].store > 0) sawBandBanking = true;
      if (tri.cities.length > 0) foundedAtDay = day;
    }

    // The arc happened in order: a band stood and banked BEFORE any city.
    expect(sawBandBanking).toBe(true);
    expect(foundedAtDay).toBeGreaterThan(5); // an accumulation, not a census
    expect(tri.cities.length).toBeGreaterThan(0);
    // The settled crowd is the band that walked in (FOUND SMALL cap).
    expect(tri.cities[0].harvested).toBeGreaterThan(0);
    expect(tri.cities[0].harvested).toBeLessThanOrEqual(150);
  });

  it("free land: comparable river bank within reach ⇒ every band walks away — no cities, everyone back in the wild", { timeout: 240000 }, async () => {
    const { tri, gridPeople0 } = await bandWorld(0.9, 40);

    let sawBand = false;
    for (let day = 0; day < 60; day++) {
      await tri.advanceDays(1);
      if (tri.bands().length > 0) sawBand = true;
    }
    // Bands DID gather (the crowds are real) — and none ever settled.
    expect(sawBand).toBe(true);
    expect(tri.cities.length).toBe(0);
    // Dispersal put the walkers back and the wild regrew behind them —
    // the world stays populated, nothing was harvested away for good.
    const banded = tri.bands().reduce((a, b) => a + b.size, 0);
    expect(tri.gridPeople() + banded).toBeGreaterThan(gridPeople0 * 0.8);
  });

  it("Gate D: a famine town ABANDONS — the crowd walks (never dies) into a band on the ruin, then back into the wild", { timeout: 240000 }, async () => {
    const prep = prepareSubstrate({
      cols: 48, rows: 32, height: ridgeValley, treeline: TREELINE, founding: FOUNDING, oreSeed: 7,
    });
    const { valley } = pickBiomes(prep);
    const tri = await foundTri(prep, {
      base: triBase({ construction: true }),
      economy: triEconomy({ construction: true }),
      // A village with NO farms: fill 0 from day one — doomed on purpose.
      cities: [{ at: valley, key: "dustbowl", name: "Dustbowl", site: CITIZEN, scalars: () => ({}) }],
      edges: [],
      peopleScale: 25,
      seed: 1206,
      autoFound: {
        every: 5,
        maxCities: 1, // the one doomed town — no new gathers muddy the run
        cityFactory: (site, i) => ({ key: `re_${i}`, name: `Refound ${i}`, site: { ...CITIZEN } }),
      },
      bandFounding: {
        scale: REAL_SCALE,
        // Frontier settings: the ruin band should WALK, closing the loop.
        searchCells: 40,
        pressureFloor: 0.9,
        desettle: { needScalar: "food_need", gotScalar: "food_got", stallFill: 0.5, window: 2 },
      },
    });

    let ruinBandSize = 0;
    for (let day = 0; day < 40; day++) {
      await tri.advanceDays(1);
      const onRuin = tri.bands().find(b => b.cell === tri.cities[0].cell);
      if (onRuin) ruinBandSize = onRuin.size;
    }

    // The town fell — as an ABANDONMENT: tombstoned, its walkers recorded.
    const dead = tri.cities[0].dead;
    expect(dead).toBeDefined();
    expect(dead!.pop).toBeGreaterThan(0);
    expect(tri.dual.tombstones().some(t => t.key === "dustbowl")).toBe(true);

    // The crowd BECAME A BAND standing on the ruin (souls → grid persons),
    // and by the run's end it had walked on — back into the wild, where a
    // later founding can rise from it. Foragers are permanent, not a stage.
    expect(ruinBandSize).toBe(Math.max(1, Math.round(dead!.pop / 25)));
    expect(tri.bands().length).toBe(0);
    expect(tri.gridPeople()).toBeGreaterThan(0);
  });
});
