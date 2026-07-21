// Rivers as TERRAIN — the carved `ground` layer, and the water mask that
// keeps towns out of the channel.
//
// The invariant under test is the layering: `height` is the drainage
// potential, `river` is a pure function of it, and `ground = height − valley`
// is a one-way derivative that NOTHING upstream reads back. If a future edit
// ever feeds `ground` into the flow solve, "macro height survives carving"
// below is the assertion that fires.

import { describe, it, expect } from "vitest";
import { prepareSubstrate } from "../tri";
import { carveValleys, findFoundingSites } from "@cells/index";

const TREELINE = 40;

/** A world with a guaranteed trunk river: a floodplain floor that every slope
 *  drains into, tilted north so the drainage thread never breaks on a flat.
 *
 *  The floor is THREE cells wide (x = 15..17) on purpose. `density` is a BOX
 *  sum, so a one-cell channel scores an identical plateau across every cell
 *  within `radius` of it — the ranking ties and the `a.cell - b.cell`
 *  tiebreak silently lands on a dry cell, hiding the very bug this file
 *  exists to pin down. A channel wider than the box's reach makes the sum
 *  genuinely peak on the water, which is what real meandering rivers do. */
function riverWorld() {
  return prepareSubstrate({
    cols: 32, rows: 32,
    height: (x, y) =>
      Math.max(3, Math.min(63, 8 + Math.max(0, Math.abs(x - 16) - 1) * 2 + (31 - y) * 0.8)),
    treeline: TREELINE,
    founding: { threshold: 40, radius: 2, minSpacing: 5 },
    oreSeed: 7,
  });
}

describe("river valleys (worldgen.carveValleys)", () => {
  it("cuts ground below the macro height along rivers, and nowhere else", { timeout: 120000 }, () => {
    const { grid } = riverWorld();
    const { river, height, ground, valley } = grid.fields;

    const wet = [...river.keys()].filter(c => river[c] > 16);
    expect(wet.length).toBeGreaterThan(5); // the fixture must actually have a river

    // Every channel cell sits below its own macro height...
    expect(wet.every(c => ground[c] < height[c])).toBe(true);
    // ...and the cut is bounded by maxDepth (default 2) everywhere — a `max`
    // over the bank disk, never a sum, so confluences don't dig double.
    expect([...valley.keys()].every(c => valley[c] <= 2 + 1e-9)).toBe(true);
    // Ground never rises above macro: carving only ever removes rock.
    expect([...ground.keys()].every(c => ground[c] <= height[c] + 1e-9)).toBe(true);

    // Far from any water, ground IS macro height — no cut, no drift.
    const dry = [...river.keys()].filter(c => {
      let near = 0;
      grid.topo.disk(c, 2, cell => { if (river[cell] > 16) near++; });
      return near === 0;
    });
    expect(dry.length).toBeGreaterThan(50);
    expect(dry.every(c => Math.abs(ground[c] - height[c]) < 1e-9)).toBe(true);
  });

  it("carries a sub-unit profile the integer macro field cannot", { timeout: 120000 }, () => {
    const { grid } = riverWorld();
    const { height, ground } = grid.fields;
    // `height` is an int var; `ground` is float precisely so banks grade
    // instead of stepping. If ground ever quantises, valleys become stairs.
    expect([...height.keys()].every(c => Number.isInteger(height[c]))).toBe(true);
    const fractional = [...ground.keys()].filter(c => !Number.isInteger(ground[c]));
    expect(fractional.length).toBeGreaterThan(0);
  });

  it("macro height survives carving — the drainage potential is never written", { timeout: 120000 }, () => {
    const { grid } = riverWorld();
    const before = Float64Array.from(grid.fields.height);
    const riverBefore = Float64Array.from(grid.fields.river);

    carveValleys(grid); // a second pass, on top of the one prepareSubstrate ran

    // THE LAYERING INVARIANT: carving reads height and river, writes neither.
    // Were `ground` ever fed back into the flow potential, the world would
    // re-route on every recompute and never reach rest.
    expect(Array.from(grid.fields.height)).toEqual(Array.from(before));
    expect(Array.from(grid.fields.river)).toEqual(Array.from(riverBefore));
  });

  it("is idempotent: re-carving an unchanged world changes nothing", { timeout: 120000 }, () => {
    const { grid } = riverWorld();
    const once = Float64Array.from(grid.fields.ground);
    carveValleys(grid);
    expect(Array.from(grid.fields.ground)).toEqual(Array.from(once));
  });

  it("leaves a relict valley when the river dries up", { timeout: 120000 }, () => {
    const { grid } = riverWorld();
    const { river, height, ground, valley } = grid.fields;

    const bed = [...river.keys()].find(c => river[c] > 40);
    expect(bed).toBeDefined();
    const cutWhenWet = valley[bed!];
    expect(cutWhenWet).toBeGreaterThan(0);

    // Dry the whole network — the river re-routed elsewhere, or the rain
    // stopped. (Assigning the field directly stands in for a re-solve; the
    // point is what carveValleys does with a bed that has no water in it.)
    river.fill(0);
    carveValleys(grid);

    // Erosion is one-way: the rock does not grow back. The bed stays a bed.
    expect(valley[bed!]).toBe(cutWhenWet);
    expect(ground[bed!]).toBeLessThan(height[bed!]);
  });

  it("a valley rides on live height: raising the land keeps the gorge", { timeout: 120000 }, () => {
    const { grid } = riverWorld();
    const { river, height, ground } = grid.fields;
    const bed = [...river.keys()].find(c => river[c] > 40)!;
    const groundBefore = ground[bed];

    // Sculpt the land up under the river. Because the persistent state is the
    // CUT and not the resulting ground, the surface must rise with it —
    // storing `ground` directly would pin the bed to its old low value and the
    // mountain would never appear.
    height[bed] += 5;
    carveValleys(grid);

    expect(ground[bed]).toBeCloseTo(groundBefore + 5, 6);
    expect(ground[bed]).toBeLessThan(height[bed]); // still a valley
  });
});

describe("depression filling — drainage is a network, not confetti", () => {
  // Rounding a smooth surface onto the integer height field manufactures
  // spurious one-cell pits. Raw steepest-descent routes water into each and
  // stops, so the drainage came out as hundreds of terminal puddles: measured
  // on a refined region, ~120 disconnected components averaging 3 cells, of
  // which ~5 reached the border. Filling (grid.fillDepressions) raises each pit
  // to its spill level so water routes THROUGH — components fell to ~23, the
  // largest grew from ~50 cells to ~550.

  /** A bounded chart with a pitted V-valley: terrain that SHOULD drain as one
   *  trunk (converging to the valley floor, exiting north), peppered with the
   *  one-cell dips integer rounding leaves behind.
   *
   *  `chart` doubles as the fill switch here: with no sea inside this fixture,
   *  the edge is its only possible outlet, so `chart: false` leaves the fill
   *  with nowhere to drain toward and it correctly declines to run. That makes
   *  the pair below an exact A/B of filling on identical terrain. */
  function pittedChart(chart: boolean) {
    return prepareSubstrate({
      cols: 48, rows: 48,
      height: (x, y) => {
        const base = 4 + (47 - y) * 0.6 + Math.abs(x - 24) * 0.5;
        const pit = ((x * 7 + y * 13) % 11 === 0) ? -1 : 0;
        return Math.max(3, Math.min(63, base + pit));
      },
      treeline: TREELINE,
      founding: { threshold: 40, radius: 2, minSpacing: 5 },
      oreSeed: 3,
      chart,
    });
  }

  /** Connected components of wet cells, and how many reach the chart edge. */
  function components(grid: ReturnType<typeof pittedChart>["grid"], cols: number, rows: number) {
    const river = grid.fields.river;
    const n = cols * rows;
    const seen = new Uint8Array(n);
    let comps = 0, biggest = 0, atEdge = 0, wet = 0;
    const stack: number[] = [];
    for (let s = 0; s < n; s++) {
      if (river[s] <= 16 || seen[s]) continue;
      comps++;
      let size = 0, edge = false;
      stack.push(s); seen[s] = 1;
      while (stack.length) {
        const c = stack.pop()!;
        size++; wet++;
        const x = c % cols, y = (c / cols) | 0;
        if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) edge = true;
        for (const m of [x > 0 ? c - 1 : -1, x < cols - 1 ? c + 1 : -1, y > 0 ? c - cols : -1, y < rows - 1 ? c + cols : -1]) {
          if (m >= 0 && !seen[m] && river[m] > 16) { seen[m] = 1; stack.push(m); }
        }
      }
      if (size > biggest) biggest = size;
      if (edge) atEdge++;
    }
    return { comps, biggest, atEdge, wet };
  }

  it("filling consolidates the network and sends it off the edge", { timeout: 120000 }, () => {
    const filled = components(pittedChart(true).grid, 48, 48);
    const unfilled = components(pittedChart(false).grid, 48, 48);

    expect(filled.wet).toBeGreaterThan(20); // the fixture must actually be wet
    // THE CLAIM, measured rather than asserted against a magic fraction:
    // identical terrain, and filling merges the pit-shattered fragments into
    // fewer, larger trees.
    expect(filled.comps).toBeLessThan(unfilled.comps);
    expect(filled.biggest).toBeGreaterThan(unfilled.biggest);
    // And the water LEAVES: a chart hands its drainage to the world outside.
    expect(filled.atEdge).toBeGreaterThan(0);
  });

  it("`chart` is OPT-IN and defaults off — an authored world keeps its water", { timeout: 120000 }, () => {
    // The default matters: an authored world is not a window on anything, and
    // draining its rim would quietly re-plumb terrain someone designed — it
    // silently rewrote the canyon-sculpting world's hydrology when this was on
    // by default. So: omitting the flag must behave exactly like `false`, and
    // must differ from `true`, or the opt-in is decorative.
    const dflt = prepareSubstrate({
      cols: 48, rows: 48,
      height: (x, y) => {
        const base = 4 + (47 - y) * 0.6 + Math.abs(x - 24) * 0.5;
        const pit = ((x * 7 + y * 13) % 11 === 0) ? -1 : 0;
        return Math.max(3, Math.min(63, base + pit));
      },
      treeline: TREELINE,
      founding: { threshold: 40, radius: 2, minSpacing: 5 },
      oreSeed: 3,
    });
    const off = components(pittedChart(false).grid, 48, 48);
    const on = components(pittedChart(true).grid, 48, 48);
    const d = components(dflt.grid, 48, 48);
    expect(d.comps).toBe(off.comps);
    expect(d.biggest).toBe(off.biggest);
    expect(d.biggest).not.toBe(on.biggest);
  });
});

describe("founding never places a town in the water", () => {
  it("no site stands where a creature could not walk", { timeout: 120000 }, () => {
    const { grid, sites } = riverWorld();
    expect(sites.length).toBeGreaterThan(0);
    // The regression this guards: `river > 45` → fertility 15 → lure 15 →
    // people 30 is the global maximum of the very field the picker ranks on,
    // AND is exactly the cell zoom.ts's BLOCK_RIVER calls unwalkable. Left
    // unmasked, the best site in the world is one a resident can't stand on.
    for (const s of sites) expect(grid.fields.river[s.cell]).toBeLessThanOrEqual(45);
  });

  it("still founds ON THE WATER'S EDGE — the mask moves towns aside, it doesn't repel them", { timeout: 120000 }, () => {
    const { grid, sites } = riverWorld();
    // Rejecting the channel must not cost the river its pull: `density` is a
    // box-sum over `radius`, so a bankside cell still counts the whole
    // watercourse's crowds and still outranks dry land. Rivers stay the
    // strongest founding signal in the world — they just stop being the site.
    const riverside = sites.filter(s => {
      let near = 0;
      grid.topo.disk(s.cell, 2, cell => { if (grid.fields.river[cell] > 16) near++; });
      return near > 0;
    });
    expect(riverside.length).toBeGreaterThan(0);
  });

  it("keeps the fordable band habitable — a creek is not a moat", { timeout: 120000 }, () => {
    const { grid, sites } = riverWorld();
    // The mask must NOT reach down to travel.ts's fording line (16): that
    // would mask the whole 15 < river <= 45 fertility band, push foundings to
    // the dry rim of the floodplain, and starve their charter box of
    // farmland. Towns are expected to sit on watered ground.
    const watered = sites.filter(s => grid.fields.fertility[s.cell] > 0);
    expect(watered.length).toBeGreaterThan(0);
  });

  it("the mask is what does it (a wide-open threshold founds mid-river)", { timeout: 120000 }, () => {
    const { grid, founding } = riverWorld();
    // Disable the mask and the old behaviour returns — proof the assertions
    // above test the fix and not the fixture's shape.
    const unmasked = findFoundingSites(grid, { ...founding, wetOver: Infinity });
    expect(unmasked.some(s => grid.fields.river[s.cell] > 45)).toBe(true);
  });
});
