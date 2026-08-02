/**
 * SEASONALITY over the tri world (settlement-emergence.md §6, step ②):
 * the orbital phase modulates the growth charters each day (farmland =
 * charter × seasonYield), so farm output swells through the fat season and
 * dies through the lean one — while the substrate's fertility keeps
 * resting. Paired with the food net's `driftFeeds` granary, a village
 * founded with winter stores EATS WHOLE through the lean window; without
 * the feedback, the same granary drains while the town starves anyway
 * (the pre-seasonal inconsistency, demonstrated on purpose).
 *
 * Runs under SEASONAL_SCALE (a 12-day year, leanFraction 0.4 ⇒ a 4.8-day
 * winter costing ~72 rations at this village's size). Only the phase
 * math reaches this layer — `metabolism` still can't bite at street
 * scope (the goods.ts blocker), and nothing here depends on it.
 */

import { describe, it, expect } from "vitest";
import { prepareSubstrate, foundTri, type TriCharter } from "../tri";
import {
  TREELINE, FOUNDING, ridgeValley, triBase, triEconomy, villageSeed, CITIZEN, pickBiomes,
} from "../tri-worlds";
import { CORE_BASE } from "../economy-core";
import type { EconomyDoc } from "../economy";
import { SEASONAL_SCALE } from "@shared/world-engine/scale";
import { seasonPhaseAtDay, seasonYieldAt, SPRING_PHASE } from "@shared/world-engine/seasons";

/** CORE_BASE's food commodity with the granary FEEDBACK switched on —
 *  the cross-doc override seam (same key ⇒ replaces in place). */
const FOOD = CORE_BASE.commodities!.find((c) => c.key === "food")!;
const SEASONAL_FOOD: EconomyDoc = {
  commodities: [{ ...FOOD, transport: { ...FOOD.transport!, driftFeeds: true } }],
};

/** Winter stores at founding — the granary the lean window is survived on. */
const WINTER_STORES = 150;

interface DayRow {
  day: number;
  yieldNow: number;
  farmland: number;
  granary: number;
  need: number;
  got: number;
}

async function runSeasonalVillage(driftFeeds: boolean, days: number): Promise<{
  charter: TriCharter; rows: DayRow[]; deaths: number;
}> {
  const eco = { construction: true, ...(driftFeeds ? { extraContent: [SEASONAL_FOOD] } : {}) };
  const prep = prepareSubstrate({
    cols: 48, rows: 32, height: ridgeValley, treeline: TREELINE, founding: FOUNDING, oreSeed: 7,
  });
  const { valley } = pickBiomes(prep);
  const tri = await foundTri(prep, {
    base: triBase(eco),
    economy: triEconomy(eco),
    cities: [{
      at: valley, key: "riverton", name: "Riverton", site: CITIZEN,
      scalars: (ch, pop) => ({ ...villageSeed(ch, pop), granary: WINTER_STORES }),
    }],
    edges: [],
    peopleScale: 25,
    seed: 1206,
    seasons: { scale: SEASONAL_SCALE },
  });

  const ew = tri.dual.entityWorld;
  const rows: DayRow[] = [];
  for (let day = 0; day < days; day++) {
    await tri.advanceDays(1);
    rows.push({
      day,
      yieldNow: seasonYieldAt(
        seasonPhaseAtDay(SEASONAL_SCALE, day, SPRING_PHASE),
        SEASONAL_SCALE.leanFraction,
      ),
      farmland: ew.scalars.farmland[0],
      granary: ew.scalars.granary[0],
      need: ew.scalars.food_need[0],
      got: ew.scalars.food_got[0],
    });
  }
  return { charter: tri.charterOf("riverton"), rows, deaths: tri.dual.vitalLedger().deaths };
}

const YEAR = 12; // SEASONAL_SCALE: yearGameDays = 12

describe("tri seasonality — the draw cycles, the fields rest", () => {
  it("a fed granary carries the village through its first winter; without the feedback it starves beside its own stores", { timeout: 240000 }, async () => {
    const fed = await runSeasonalVillage(true, 2 * YEAR);
    const starved = await runSeasonalVillage(false, 2 * YEAR);

    // The charter breathes: summer farmland swells past the resting charter,
    // winter farmland is ZERO — while the substrate value itself is intact
    // (charterOf reads the resting fertility box, unchanged all year).
    const summer = fed.rows.filter((r) => r.yieldNow > 1.5);
    const winter = fed.rows.filter((r) => r.yieldNow === 0);
    expect(summer.length).toBeGreaterThan(0);
    expect(winter.length).toBeGreaterThanOrEqual(8); // ~4.8 lean days per year × 2
    for (const r of summer) expect(r.farmland).toBeGreaterThan(fed.charter.farmland * 1.4);
    for (const r of winter) expect(r.farmland).toBe(0);
    expect(fed.charter.farmland).toBeGreaterThan(0);

    // THE PAYOFF — the first winter, fed: while the granary holds a day's
    // need, the town eats WHOLE (fill ≈ 1) and the stock visibly drains.
    const firstWinter = (rows: DayRow[]) => rows.filter((r) => r.yieldNow === 0 && r.day < YEAR);
    const fedWinter = firstWinter(fed.rows);
    expect(fedWinter.length).toBeGreaterThanOrEqual(4);
    for (const r of fedWinter) {
      if (r.granary >= r.need && r.need > 0) {
        expect(r.got / r.need).toBeGreaterThan(0.99);
      }
    }
    expect(fedWinter[fedWinter.length - 1].granary).toBeLessThan(fedWinter[0].granary);

    // The control demonstrates the inconsistency the feedback fixes: stores
    // in the granary, nothing on the table.
    const starvedWinter = firstWinter(starved.rows);
    const besideStores = starvedWinter.find((r) => r.granary > 0 && r.need > 0);
    expect(besideStores).toBeDefined();
    expect(besideStores!.got).toBe(0);

    // And the ledger agrees: the unfed village buries more of its people.
    expect(starved.deaths).toBeGreaterThan(fed.deaths);
  });
});
