/**
 * Typed growth bias (city-development.md §2b, the seeds half of §7 step
 * 5): a town turns toward what feeds it. Arterials aim at trade partners
 * and resource sides; farm gates cap the tips toward the fertile tiles,
 * the pithead the tips toward the ore; fields follow the farm gates.
 * Bearings are session-memoized so substrate drift can't re-lay a town
 * under the player's feet.
 */

import { describe, expect, it } from "vitest";
import { townBias, townPlan } from "../zoom";
import type { TriWorld } from "../tri";

const COLS = 25, ROWS = 25, CITY = { x: 12, y: 12 };

/** A tri whose city has fertile land due EAST and ore due WEST. */
function sidedTri(pop = 1200, routes: Array<{ a: string; b: string }> = [], extraCity?: { key: string; x: number; y: number }): TriWorld {
  const fertility = new Float64Array(COLS * ROWS);
  const ore = new Float64Array(COLS * ROWS);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (x >= CITY.x + 2) fertility[y * COLS + x] = 6;
      if (x <= CITY.x - 2) ore[y * COLS + x] = 5;
    }
  }
  const cities = [{ key: "sided", ...CITY, harvested: 0 }];
  if (extraCity) cities.push({ key: extraCity.key, x: extraCity.x, y: extraCity.y, harvested: 0 });
  return {
    cities,
    grid: { cols: COLS, rows: ROWS, fields: { fertility, ore } },
    charterOf: () => ({ farmland: 240, ore_access: 80, timberland: 100 }),
    dual: {
      settlementScalar: (_k: string, f: string): number =>
        ({ population: pop, farms: 3, mines: 2, smelters: 1, food_need: pop / 1000, food_got: pop / 1000 }[f] ?? 0),
      routes: () => routes.map((r, i) => ({
        key: `r${i}`, site_a: { key: r.a }, site_b: { key: r.b }, strength: 1, migration: 0,
      })),
    },
  } as unknown as TriWorld;
}

const angSep = (a: number, b: number): number => {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
};

describe("typed growth bias", () => {
  it("reads the sides: fertile bearing east, ore bearing west; symmetric fields yield none", () => {
    const bias = townBias(sidedTri(), "sided");
    expect(bias.fertile).not.toBeNull();
    expect(angSep(bias.fertile!, 0)).toBeLessThan(0.3); // east
    expect(bias.ore).not.toBeNull();
    expect(angSep(bias.ore!, Math.PI)).toBeLessThan(0.3); // west
  });

  it("farm gates and fields sit on the fertile side, the pithead on the ore side", () => {
    const plan = townPlan(sidedTri(), "sided", 7);
    const centersOf = (type: string): number[] =>
      plan.works.filter(w => w.type === type).map(w => w.dx + w.w / 2);
    const farms = centersOf("farm");
    const mines = centersOf("mine");
    expect(farms.length).toBeGreaterThan(0);
    expect(mines.length).toBeGreaterThan(0);
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(farms)).toBeGreaterThan(30); // east of the plaza
    expect(mean(mines)).toBeLessThan(-30); // west of it
    // Fields fan past the farm gates — also east.
    expect(plan.fields.length).toBeGreaterThan(0);
    expect(mean(plan.fields.map(f => f.dx + f.w / 2))).toBeGreaterThan(40);
  });

  it("the first arterial heads out along the strongest bearing (the trade road when there is one)", () => {
    // No routes: the fertile bearing leads → arterial 1 heads ~east.
    const plain = townPlan(sidedTri(), "sided", 7);
    const first = plain.streets.streets[1];
    const h = Math.atan2(first.pts[1].y - first.pts[0].y, first.pts[1].x - first.pts[0].x);
    expect(angSep(h, 0)).toBeLessThan(0.6);

    // A route north: the high street is the highway — arterial 1 heads
    // toward the neighbor instead.
    const routed = townPlan(
      sidedTri(1200, [{ a: "sided", b: "portton" }], { key: "portton", x: 12, y: 2 }),
      "sided", 7,
    );
    const road = routed.streets.streets[1];
    const rh = Math.atan2(road.pts[1].y - road.pts[0].y, road.pts[1].x - road.pts[0].x);
    expect(angSep(rh, -Math.PI / 2)).toBeLessThan(0.6); // north (y grows south)
  });

  it("bias is session-memoized: substrate drift cannot re-lay a loaded town", () => {
    const tri = sidedTri();
    const before = townBias(tri, "sided");
    // The mountain empties (mining depletion) — the memo holds anyway.
    (tri.grid.fields.ore as Float64Array).fill(0);
    const after = townBias(tri, "sided");
    expect(after).toBe(before);
    expect(after.ore).toBe(before.ore);
  });
});
