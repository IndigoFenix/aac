/**
 * Tier-1 region refinement (planning-docs/games/hierarchical-cells.md):
 * one planet cell refines into a flat region grid whose terrain IS the
 * planet's render sampler, whose crowds respect the parent budget, whose
 * capitals stay fixed, and whose villages found at day's-walk spacing —
 * deterministically, because a region is an address.
 */
import { describe, it, expect } from "vitest";
import { buildPlanetWorld } from "@shared/world-engine/planet/planet-game";
import {
  refineRegion, refineHighways, stitchRegions, regionFrame, regionDir, villageKey,
  type RefinedRegion,
} from "@shared/world-engine/planet/refine";
import { planetCities } from "@shared/world-engine/planet/cities";
import { planetStates, statePairs } from "@shared/world-engine/planet/states";
import { planetRoutes, routePointAt } from "@shared/world-engine/planet/routes";
import type { GameSettings } from "@shared/world-engine/kernel/manifest";
import { SEA_HEIGHT } from "@shared/world-engine/kernel/geology/tectonics";

const game: GameSettings = {
  scope: "planet",
  world: {
    topology: { kind: "cube-sphere", faceN: 24 },
    geology: { seed: 7, epochs: 350, continentR: 0.38 },
    settle: true,
    radius: 6_371_000,
    founding: { threshold: 60, radius: 2, minSpacing: 2, maxHarvest: 600 },
  },
  initialFocus: null, avatar: false, avatarSpecies: "human", canFly: false, creativeMode: false, entities: null, scale: null,
};

describe("region refinement — tier 1 of the hierarchical substrate", () => {
  const built = buildPlanetWorld(game);
  // Refine the most fertile capital's region (the demo's approach target).
  const capital = built.sites[0];
  const refined = refineRegion(built, capital.cell);

  it("is deterministic — a region is an address", { timeout: 240000 }, () => {
    const again = refineRegion(built, capital.cell);
    expect(again.villages.length).toBe(refined.villages.length);
    expect(JSON.stringify(again.villages)).toBe(JSON.stringify(refined.villages));
    expect(Array.from(again.prep.grid.fields.height)).toEqual(Array.from(refined.prep.grid.fields.height));
    // The traffic field and road net are part of the address too.
    expect(Array.from(again.prep.grid.fields.traffic)).toEqual(Array.from(refined.prep.grid.fields.traffic));
    expect(again.roads).toEqual(refined.roads);
    expect(JSON.stringify(again.roadRoutes)).toBe(JSON.stringify(refined.roadRoutes));
  });

  // NOTE: traffic reweights the founding ranking (score = density +
  // 3 × traffic box-sum), so village SETS differ from the pre-traffic
  // build — by design; no exact counts are pinned here.
  it("chokepoint traffic: routes between hubs, a traffic field, a route town", () => {
    const { grid, founding } = refined.prep;
    const traffic = grid.fields.traffic;
    expect(traffic).toBeDefined();
    expect(traffic.length).toBe(refined.frame.cols * refined.frame.rows);
    let total = 0;
    let max = 0;
    for (let i = 0; i < traffic.length; i++) { total += traffic[i]; max = Math.max(max, traffic[i]); }
    expect(total).toBeGreaterThan(0); // ≥ 2 hubs in a fertile capital region → routes exist
    // Routes are sparse: the region median traffic is 0, and a route town
    // is a site whose founding box rises above it.
    const sorted = Array.from(traffic).sort((a, b) => a - b);
    const median = sorted[(sorted.length / 2) | 0];
    expect(max).toBeGreaterThan(median);
    const routeTown = refined.prep.sites.some(site => {
      let above = false;
      grid.topo.disk(site.cell, founding.radius, c => { if (traffic[c] > median) above = true; });
      return above;
    });
    expect(routeTown).toBe(true);
  });

  it("the road net is committed as data: field written, segments classified", () => {
    const { grid } = refined.prep;
    const road = grid.fields.road;
    expect(road).toBeDefined();
    expect(refined.roads.length).toBeGreaterThan(0);
    for (const seg of refined.roads) {
      expect(road[seg.cell]).toBe(1);
      expect(["road", "bridge", "tunnel"]).toContain(seg.kind);
      // A bridge stands on water; a plain road cell does not sit in the deep.
      if (seg.kind !== "bridge") {
        expect(grid.fields.height[seg.cell]).toBeGreaterThanOrEqual(SEA_HEIGHT - 1);
      }
    }
    // Every committed cell carries traffic — roads follow the routes.
    const traffic = grid.fields.traffic;
    for (const seg of refined.roads) expect(traffic[seg.cell]).toBeGreaterThan(0);
  });

  it("every founded village sits ON the road net (roads end at towns)", () => {
    const endpoints = new Set<number>();
    for (const r of refined.roadRoutes) { endpoints.add(r.a); endpoints.add(r.b); }
    let joined = 0;
    for (const v of refined.villages) if (endpoints.has(v.cell)) joined++;
    // Every reachable village is a hub of its own net (hubRoutes gives each
    // hub its K nearest); only a village isolated by water may drop out.
    expect(joined).toBeGreaterThanOrEqual(Math.ceil(refined.villages.length * 0.8));
    expect(joined).toBeGreaterThan(0);
  });

  it("the road net also ships as sphere polylines — pure JSON, composite-keyed", () => {
    expect(refined.roadRoutes.length).toBeGreaterThan(0);
    // Pure JSON: the worker boundary must carry it without loss.
    expect(JSON.parse(JSON.stringify(refined.roadRoutes))).toEqual(refined.roadRoutes);
    const borderKeys = new Set(refined.borderTowns.map(t => t.cell));
    for (const r of refined.roadRoutes) {
      // Endpoint identities are composite village keys — no collision with
      // tier-0 cells or other regions' roads (caravan phase hashing). A
      // BORDER-TOWN endpoint carries its (negative) border key instead, so
      // both adjacent regions hash the same caravan identity for it.
      if (r.a < 0) expect(borderKeys.has(r.a)).toBe(true);
      else expect(r.a).toBe(villageKey(capital.cell, r.a % 16384));
      if (r.b < 0) expect(borderKeys.has(r.b)).toBe(true);
      else expect(r.b).toBe(villageKey(capital.cell, r.b % 16384));
      expect(r.dirs.length).toBeGreaterThanOrEqual(2);
      expect(r.cum.length).toBe(r.dirs.length);
      expect(r.cum[0]).toBe(0);
      for (let i = 1; i < r.cum.length; i++) {
        expect(r.cum[i]).toBeGreaterThanOrEqual(r.cum[i - 1]!);
      }
      expect(r.lengthM).toBeGreaterThan(0);
      // A village road lives inside its region chart.
      expect(r.lengthM).toBeLessThan(refined.frame.widthM * 2);
      for (const d of r.dirs) {
        expect(Math.abs(Math.hypot(d[0], d[1], d[2]) - 1)).toBeLessThan(1e-6);
      }
    }
  });

  it("child terrain IS the planet's MACRO sampler (units round-trip at cell centers)", () => {
    const { frame } = refined;
    const R = built.spec.radius;
    const maxElevation = built.spec.relief * R;
    const unitElev = maxElevation / (63 - SEA_HEIGHT);
    // macroHeightAt, NOT heightAt: the child's `height` is the child's own
    // drainage potential, so it must be seeded from the parent's uncarved
    // macro field. Seeding it from the carved `ground` would solve the
    // child's rivers over the parent's riverbeds and cut a valley into a
    // valley at every tier — see kernel/cells/worldgen.carveValleys.
    const macroAt = built.surface.macroHeightAt ?? built.surface.heightAt;
    let checked = 0;
    for (let y = 8; y < frame.rows; y += 16) {
      for (let x = 8; x < frame.cols; x += 16) {
        const dir = regionDir(frame, R, x, y);
        const elev = macroAt(dir);
        const expected = Math.max(0, Math.min(63, Math.round(
          elev >= 0 ? SEA_HEIGHT + elev / unitElev : SEA_HEIGHT + (elev / (maxElevation * 1.3)) * SEA_HEIGHT,
        )));
        expect(refined.prep.grid.fields.height[y * frame.cols + x]).toBe(expected);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("refinement does not compound valleys: the child carves from its own solve", () => {
    const { frame } = refined;
    const R = built.spec.radius;
    // The layering rule, asserted at the tier seam. Wherever the parent has
    // cut a valley, its carved ground sits BELOW its macro height — and the
    // child's height must track macro, never the cut. If a future edit points
    // refine.ts back at `heightAt`, the child inherits the parent's riverbeds
    // as terrain and re-carves them, and this fires.
    const macroAt = built.surface.macroHeightAt ?? built.surface.heightAt;
    let carved = 0;
    for (let y = 4; y < frame.rows; y += 8) {
      for (let x = 4; x < frame.cols; x += 8) {
        const dir = regionDir(frame, R, x, y);
        if (macroAt(dir) > built.surface.heightAt(dir) + 1e-9) carved++;
        expect(macroAt(dir)).toBeGreaterThanOrEqual(built.surface.heightAt(dir) - 1e-9);
      }
    }
    // The fixture must actually contain carved ground, or the check above is
    // vacuous.
    expect(carved).toBeGreaterThan(0);
  });

  it("the capital is a fixed point — no village re-founds it", () => {
    expect(refined.capitalCells).toContain(capital.cell);
    // The capital sits at the chart center; the founding spacing keeps
    // every village at least minSpacing child cells away from it.
    const minSpacing = refined.prep.founding.minSpacing;
    const cx = (refined.frame.cols - 1) / 2;
    const cy = (refined.frame.rows - 1) / 2;
    for (const site of refined.prep.sites) {
      const d = Math.hypot(site.x - cx, site.y - cy);
      expect(d).toBeGreaterThanOrEqual(minSpacing - 1); // occupied rounds to a tile
    }
  });

  it("crowd budget (density semantics): a parent slice's MEAN people matches the parent", () => {
    const { frame } = refined;
    const R = built.spec.radius;
    const childPeople = refined.prep.grid.fields.people;
    const parentPeople = built.grid.fields.people;
    // Group child cells by containing parent; each slice's mean should be
    // the parent's per-cell value (the parent decides how crowded its land
    // is; the child's river solve decides where the crowds pool).
    const sums = new Map<number, { sum: number; n: number }>();
    for (let y = 0; y < frame.rows; y++) {
      for (let x = 0; x < frame.cols; x++) {
        const parent = built.topo.cellAt!(regionDir(frame, R, x, y));
        const s = sums.get(parent) ?? { sum: 0, n: 0 };
        s.sum += childPeople[y * frame.cols + x];
        s.n++;
        sums.set(parent, s);
      }
    }
    let checked = 0;
    for (const [parent, s] of sums) {
      const target = parentPeople[parent];
      if (target < 1 || s.sum <= 0) continue; // barren stays barren
      expect(Math.abs(s.sum / s.n - target)).toBeLessThan(Math.max(0.5, target * 0.01));
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("villages found at day's-walk spacing — dozens where a capital had none", { timeout: 240000 }, () => {
    expect(refined.villages.length).toBeGreaterThan(5); // a fertile region fills in
    // Composite keys never collide with tier-0 cells or other regions.
    // Border towns (the edge pass) ride along with NEGATIVE keys — the
    // disjoint namespace border.ts documents.
    for (const v of refined.villages) {
      if (v.cell >= 0) {
        expect(v.cell).toBe(villageKey(capital.cell, v.cell % 16384));
        expect(v.cell).toBeGreaterThanOrEqual(16384);
      } else {
        expect(built.topo.cellAt!(v.dir)).toBe(capital.cell); // owned border town
      }
      const [x, y, z] = v.dir;
      expect(Math.abs(Math.hypot(x, y, z) - 1)).toBeLessThan(1e-6);
      expect(v.charter.farmland).toBeGreaterThanOrEqual(25);
    }
    // Day's-walk spacing on the ground: no two villages closer than
    // minSpacing × cellSize (chart metric).
    const minM = refined.prep.founding.minSpacing * refined.frame.cellSizeM;
    for (let i = 0; i < refined.prep.sites.length; i++) {
      for (let j = i + 1; j < refined.prep.sites.length; j++) {
        const a = refined.prep.sites[i];
        const b = refined.prep.sites[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y) * refined.frame.cellSizeM;
        expect(d).toBeGreaterThanOrEqual(minM * 0.99);
      }
    }
  });

  describe("cross-region stitching — villages join hands across the border", () => {
    // Refine neighbours until one yields stitches (a fertile capital region
    // has settled neighbours; a sea border is deterministically empty).
    let other: RefinedRegion | null = null;
    let stitches: ReturnType<typeof stitchRegions> = [];
    const nbs: number[] = new Array(built.topo.maxDegree).fill(0);
    const kNbs = built.topo.neighbours(capital.cell, nbs);
    for (let j = 0; j < kNbs && !stitches.length; j++) {
      const candidate = refineRegion(built, nbs[j]!);
      const routes = stitchRegions(built, refined, candidate);
      if (routes.length) { other = candidate; stitches = routes; }
    }

    it("some border carries stitches, symmetric in the pair and deterministic", { timeout: 240000 }, () => {
      expect(other).not.toBeNull();
      // Argument order must not matter — load order is render timing, not data.
      expect(JSON.stringify(stitchRegions(built, other!, refined))).toBe(JSON.stringify(stitches));
      expect(JSON.stringify(stitchRegions(built, refined, other!))).toBe(JSON.stringify(stitches));
      // Pure JSON for the worker boundary.
      expect(JSON.parse(JSON.stringify(stitches))).toEqual(stitches);
    });

    it("each stitch is ONE continuous road: village here → across the border → village there", () => {
      const lowFirst = capital.cell < other!.frame.regionCell;
      const villagesA = new Set((lowFirst ? refined : other!).villages.map(v => v.cell));
      const villagesB = new Set((lowFirst ? other! : refined).villages.map(v => v.cell));
      for (const r of stitches) {
        // Endpoints are REAL villages of each side (composite keys).
        expect(villagesA.has(r.a)).toBe(true);
        expect(villagesB.has(r.b)).toBe(true);
        // Well-formed drape shape.
        expect(r.dirs.length).toBeGreaterThanOrEqual(2);
        expect(r.cum.length).toBe(r.dirs.length);
        for (let i = 1; i < r.cum.length; i++) {
          expect(r.cum[i]).toBeGreaterThanOrEqual(r.cum[i - 1]!);
        }
        expect(r.lengthM).toBeGreaterThan(0);
        for (const d of r.dirs) {
          expect(Math.abs(Math.hypot(d[0], d[1], d[2]) - 1)).toBeLessThan(1e-6);
        }
        // It genuinely CROSSES: the ends sit in different tier-0 cells.
        const cellStart = built.topo.cellAt!(r.dirs[0]!);
        const cellEnd = built.topo.cellAt!(r.dirs[r.dirs.length - 1]!);
        expect(cellStart).not.toBe(cellEnd);
        expect([capital.cell, other!.frame.regionCell]).toContain(cellStart);
        expect([capital.cell, other!.frame.regionCell]).toContain(cellEnd);
      }
      // No village is double-stitched to two partners on the same border.
      const usedA = stitches.map(r => r.a);
      expect(new Set(usedA).size).toBe(usedA.length);
    });
  });

  describe("highway refinement — the interstates crossing this region get physical", () => {
    // The worker's exact derivation: the tier-0 net re-derives from the same
    // built planet, so spans line up with the renderer without a wire.
    const cities = planetCities(built);
    const states = planetStates(built, cities);
    const pairs = statePairs(states);
    const routes = planetRoutes(built, cities, pairs.length ? { pairs } : {});
    const highways = refineHighways(built, refined, routes);

    it("refines at least the capital's own approaches, deterministically", () => {
      // Interstates END at this capital, so its region always has crossings.
      expect(highways.length).toBeGreaterThan(0);
      expect(JSON.stringify(refineHighways(built, refined, routes)))
        .toBe(JSON.stringify(highways));
      // Pure JSON — the worker boundary carries it whole.
      expect(JSON.parse(JSON.stringify(highways))).toEqual(highways);
    });

    it("every span is a well-formed re-draw of a real parent", () => {
      const parentByKey = new Map(routes.map(r => [`${r.a}:${r.b}`, r]));
      for (const hw of highways) {
        const parent = parentByKey.get(`${hw.a}:${hw.b}`)!;
        expect(parent).toBeDefined();
        expect(hw.s0).toBeGreaterThanOrEqual(0);
        expect(hw.s1).toBeGreaterThan(hw.s0);
        expect(hw.s1).toBeLessThanOrEqual(parent.lengthM);
        // Seam continuity: the refined ribbon's endpoints ARE the parent's
        // entry/exit points (pinned before smoothing).
        expect(hw.route.dirs[0]).toEqual(routePointAt(parent, hw.s0));
        expect(hw.route.dirs[hw.route.dirs.length - 1]).toEqual(routePointAt(parent, hw.s1));
        // Well-formed route shape.
        expect(hw.route.cum.length).toBe(hw.route.dirs.length);
        for (let i = 1; i < hw.route.cum.length; i++) {
          expect(hw.route.cum[i]).toBeGreaterThanOrEqual(hw.route.cum[i - 1]!);
        }
        expect(hw.route.lengthM).toBeGreaterThan(0);
        // The physical road may wind, but never absurdly (child-grid least
        // cost between pinned endpoints of the same span).
        expect(hw.route.lengthM).toBeLessThan((hw.s1 - hw.s0) * 4 + refined.frame.cellSizeM * 8);
        for (const d of hw.route.dirs) {
          expect(Math.abs(Math.hypot(d[0], d[1], d[2]) - 1)).toBeLessThan(1e-6);
        }
      }
    });

    it("spans of one parent never overlap (the ownership rule, in one region)", () => {
      const byParent = new Map<string, Array<[number, number]>>();
      for (const hw of highways) {
        const k = `${hw.a}:${hw.b}`;
        const list = byParent.get(k) ?? [];
        list.push([hw.s0, hw.s1]);
        byParent.set(k, list);
      }
      for (const list of byParent.values()) {
        list.sort((p, q) => p[0] - q[0]);
        for (let i = 1; i < list.length; i++) {
          expect(list[i]![0]).toBeGreaterThanOrEqual(list[i - 1]![1]);
        }
      }
    });
  });

  it("the frame chart is honest: pitch-sized, tangent, unit axes", () => {
    const f = regionFrame(built, capital.cell);
    expect(f.widthM).toBeGreaterThan(100_000); // a faceN-24 Earth cell ~400 km
    expect(f.widthM).toBeLessThan(1_000_000);
    const dot = f.east[0] * f.north[0] + f.east[1] * f.north[1] + f.east[2] * f.north[2];
    expect(Math.abs(dot)).toBeLessThan(1e-9);
    const dirDot = f.east[0] * f.dir0[0] + f.east[1] * f.dir0[1] + f.east[2] * f.dir0[2];
    expect(Math.abs(dirDot)).toBeLessThan(1e-9);
  });
});
