/**
 * B-③'s EXPAND DOOR (band-settlement-round.md S3): a city with a condensed
 * TownRecord delivers its shelf into the town it materializes — through the
 * fold dispatch's `expand`, conserving. These pins cover the placer's two
 * laws (the lane pick and the good→glyph split) and the loader wiring
 * (approach consumes the record exactly once, draining it in place, which
 * is what makes a cache-drop rebuild safe against double-minting).
 *
 * The shipped producer is deliberately absent (the closed-form founding
 * larder is a pacing judgment recorded for the user), so the record hook is
 * exercised here with a hand-minted record — the door pinned, the writer
 * pending (region layer / user call).
 */
import { describe, it, expect } from "vitest";
import { condenseTown } from "@shared/world-engine/kernel/town/barter";
import { FOOD_KINDS } from "@shared/world-engine/kernel/town/goods-kinds";
import type { TownPlayConfig } from "@shared/world-engine/interaction/town/town-play";
import { createTownDeltas } from "@shared/world-engine/kernel/town/construction";
import { consumeTownRecord, createCityTownLoader } from "../city-towns";
import type { FlightCity } from "../space-fly";

const record = (stack: Record<string, number>) =>
  condenseTown({ key: "city:42", stack });

describe("consumeTownRecord — the placer's two laws", () => {
  it("a CATEGORY good deals whole units across its kinds, largest remainder; crumbs stay on the record", () => {
    const rec = record({ food: 7.5 });
    const config: TownPlayConfig = { seed: 1, key: "t", days: 1, questCount: 0, startPop: 0, charter: { farmland: 60, ore_access: 0 } };
    expect(consumeTownRecord(rec, config)).toBe(true);

    const placed = config.stock!;
    const total = Object.values(placed).reduce((a, b) => a + b, 0);
    expect(total).toBe(7); // Σ exact — the whole units, nothing minted
    for (const g of Object.keys(placed)) expect(FOOD_KINDS).toContain(g);
    // Largest remainder over equal shares: first kinds carry the extra.
    const shares = FOOD_KINDS.map(g => placed[g] ?? 0);
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
    // The fractional crumb STAYS on the record — nothing evaporates.
    expect(rec.stack.food).toBeCloseTo(0.5, 9);
  });

  it("a CONCRETE glyph lands directly under its own row", () => {
    const rec = record({ wood: 4 });
    const config: TownPlayConfig = { seed: 1, key: "t", days: 1, questCount: 0, startPop: 0, charter: { farmland: 60, ore_access: 0 } };
    consumeTownRecord(rec, config);
    expect(config.stock).toEqual({ wood: 4 });
    expect(rec.stack.wood).toBeUndefined(); // drained whole
  });

  it("⚖️ the lane pick: with deltas present the goods fold into deltas.stock, never config.stock", () => {
    const rec = record({ wood: 3 });
    const config: TownPlayConfig = {
      seed: 1, key: "t", days: 1, questCount: 0, startPop: 0,
      charter: { farmland: 60, ore_access: 0 },
      deltas: createTownDeltas().toJSON(),
    };
    consumeTownRecord(rec, config);
    expect(config.deltas!.stock).toEqual({ wood: 3 });
    expect(config.stock).toBeUndefined(); // the ignored lane stays untouched
  });

  it("consuming twice adds nothing — the drain is the double-mint guard", () => {
    const rec = record({ wood: 2 });
    const config: TownPlayConfig = { seed: 1, key: "t", days: 1, questCount: 0, startPop: 0, charter: { farmland: 60, ore_access: 0 } };
    consumeTownRecord(rec, config);
    consumeTownRecord(rec, config);
    expect(config.stock).toEqual({ wood: 2 });
  });
});

describe("the loader wiring — approach consumes the record once", () => {
  it("a city with a record materializes with its shelf drained; a recordless city is untouched", async () => {
    const rec = record({ food: 5.25 });
    const fc = {
      city: {
        cell: 42, name: "Recordville", dir: [0, 0, 1],
        density: 40, charter: { farmland: 60, ore_access: 0, timberland: 10 },
        startPop: 30,
      },
    } as unknown as FlightCity;

    const loader = createCityTownLoader({ record: f => (f.city.cell === 42 ? rec : null) });
    const entry = loader.approach(fc);
    for (let i = 0; i < 600 && entry.state === "founding"; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    expect(entry.state).toBe("ready");
    // The record was consumed through the real path, exactly once: whole
    // units gone, the crumb still on the shelf.
    expect(rec.stack.food).toBeCloseTo(0.25, 9);
  }, 120000);
});
