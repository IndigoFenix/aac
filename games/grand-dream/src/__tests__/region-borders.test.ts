/**
 * Region borders — the founding OWNERSHIP MASK and the EDGE PASS.
 *
 * The bug this suite pins down: a region's chart is a SQUARE gnomonic
 * window over a hex-ish substrate cell, so it sees slivers of land owned by
 * its neighbours; both neighbours' founding scans used to find the same
 * fertile spot in a shared sliver and both founded a village there —
 * overlapping towns at region borders. The fix, in three pieces:
 *
 *   1. OWNERSHIP MASK — a region founds only on child cells it owns
 *      (FoundingOpts.eligible, applied INSIDE the candidate scan).
 *   2. HALF-SPACING SETBACK — interior villages stay minSpacing/2 from
 *      non-owned land; enforced symmetrically, so two regions' interior
 *      villages are ~minSpacing apart globally with zero cross-region reads.
 *   3. EDGE PASS (planet/border.ts) — the setback band belongs to border
 *      towns founded per tier-0 edge, deterministically and symmetrically
 *      in the canonical pair, keyed in a NEGATIVE namespace that can never
 *      collide with capitals (≥ 0) or villages (regionCell·16384 + child).
 */
import { describe, it, expect } from "vitest";
import { buildPlanetWorld } from "@shared/world-engine/planet/planet-game";
import { refineRegion, villageKey, type RefinedRegion } from "@shared/world-engine/planet/refine";
import { borderTowns, BAND_KEY_STRIDE, isBorderTownKey } from "@shared/world-engine/planet/border";
import type { GameSettings } from "@shared/world-engine/kernel/manifest";

const game: GameSettings = {
  scope: "planet",
  world: {
    topology: { kind: "cube-sphere", faceN: 24 },
    geology: { seed: 7, epochs: 350, continentR: 0.38 },
    settle: true,
    radius: 6_371_000,
    founding: { threshold: 60, radius: 2, minSpacing: 2, maxHarvest: 600 },
  },
  initialFocus: null, avatar: false, avatarSpecies: "human", mods: [], canFly: false, creativeMode: false, entities: null, scale: null,
};

const arcM = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  R: number,
): number => {
  const dp = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(dp) * R;
};

/** The canonical pair a border key was minted for (border.ts key space). */
const pairIndexOf = (key: number): number => Math.floor((-key - 1) / BAND_KEY_STRIDE);

describe("region borders — ownership mask, setback, and the edge pass", () => {
  const built = buildPlanetWorld(game);
  const R = built.spec.radius;
  const topo = built.topo;
  const capital = built.sites[0];

  // The refined neighbourhood: the most fertile capital's region plus every
  // lattice neighbour — all the adjacent pairs the invariants quantify over.
  const refined = refineRegion(built, capital.cell);
  const nbs: number[] = new Array(topo.maxDegree).fill(0);
  const kNbs = topo.neighbours(capital.cell, nbs);
  const neighbours: RefinedRegion[] = [];
  for (let j = 0; j < kNbs; j++) neighbours.push(refineRegion(built, nbs[j]!));
  const all = [refined, ...neighbours];

  const interiorOf = (r: RefinedRegion) => r.villages.filter(v => v.cell >= 0);

  it("(a) ownership: every interior village's dir maps to its own region cell", { timeout: 240000 }, () => {
    for (const r of all) {
      for (const v of interiorOf(r)) {
        expect(topo.cellAt!(v.dir)).toBe(r.frame.regionCell);
      }
      // And every border town rode into exactly its OWNER's villages.
      for (const t of r.borderTowns) {
        expect(topo.cellAt!(t.dir)).toBe(t.owner);
        const here = r.villages.some(v => v.cell === t.cell);
        expect(here).toBe(t.owner === r.frame.regionCell);
      }
    }
  });

  it("(b) cross-region spacing: adjacent regions' villages keep their distance", { timeout: 240000 }, () => {
    // The guaranteed bound, stated exactly: an interior village sits at
    // chebyshev ≥ setback = ceil(minSpacing/2) chart tiles from the nearest
    // NON-OWNED tile center (chebyshev ≤ euclidean, so euclidean too); the
    // continuous ownership border can wiggle up to ~0.71 tiles past a
    // sampled center, and gnomonic chart metres exceed arc metres by < 1%
    // inside a region chart — so each side contributes
    // ≥ (setback − 1) · cellSize arc metres to any crossing, and two
    // interior villages of adjacent regions are at least
    //   ((setbackA − 1)·szA + (setbackB − 1)·szB) · 0.98
    // apart (≈ minSpacing·cellSize − 2 tiles; the discretization slack).
    let pairsChecked = 0;
    for (const other of neighbours) {
      const szA = refined.frame.cellSizeM;
      const szB = other.frame.cellSizeM;
      const setA = Math.ceil(refined.prep.founding.minSpacing / 2);
      const setB = Math.ceil(other.prep.founding.minSpacing / 2);
      const interiorBound = ((setA - 1) * szA + (setB - 1) * szB) * 0.98;
      for (const va of interiorOf(refined)) {
        for (const vb of interiorOf(other)) {
          expect(arcM(va.dir, vb.dir, R)).toBeGreaterThanOrEqual(interiorBound);
          pairsChecked++;
        }
      }
      // All cross-region pairs INCLUDING border towns: a looser floor.
      // Border towns keep half-setback from third-party land and full
      // spacing (via `occupied` projection) from interior scans; the
      // weakest geometry is two towns of DIFFERENT edges near a shared
      // corner, which the third-cell setback still holds apart.
      const floor = 0.3 * Math.min(
        refined.prep.founding.minSpacing * szA,
        other.prep.founding.minSpacing * szB,
      );
      for (const va of refined.villages) {
        for (const vb of other.villages) {
          if (va.cell === vb.cell) continue; // impossible by ownership — checked in (a)
          expect(arcM(va.dir, vb.dir, R)).toBeGreaterThanOrEqual(floor);
        }
      }
    }
    expect(pairsChecked).toBeGreaterThan(0);
  });

  it("(c) edge-pass symmetry: both regions compute identical border towns", { timeout: 240000 }, () => {
    for (let j = 0; j < kNbs; j++) {
      const nb = nbs[j]!;
      // The function itself is symmetric in the argument order…
      const ab = borderTowns(built, capital.cell, nb);
      const ba = borderTowns(built, nb, capital.cell);
      expect(JSON.stringify(ba)).toBe(JSON.stringify(ab));
      // …and both refines carry exactly that set for their shared pair.
      const lo = Math.min(capital.cell, nb);
      const hi = Math.max(capital.cell, nb);
      const pairIndex = lo * topo.n + hi;
      const fromA = refined.borderTowns.filter(t => pairIndexOf(t.cell) === pairIndex);
      const fromB = neighbours[j]!.borderTowns.filter(t => pairIndexOf(t.cell) === pairIndex);
      expect(JSON.stringify(fromA)).toBe(JSON.stringify(ab));
      expect(JSON.stringify(fromB)).toBe(JSON.stringify(ab));
      // Owners are members of the pair — exactly one region owns each town.
      for (const t of ab) expect([capital.cell, nb]).toContain(t.owner);
    }
    // The fixture is only meaningful if SOME border actually founds.
    const total = all.reduce((s, r) => s + r.borderTowns.length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("(d) key spaces never collide across the refined neighbourhood", { timeout: 240000 }, () => {
    const seen = new Map<number, string>();
    const claim = (key: number, who: string): void => {
      const prev = seen.get(key);
      // The same border town may be reported by both its regions — that is
      // agreement, not collision.
      if (prev !== undefined) expect(prev).toBe(who);
      seen.set(key, who);
    };
    for (const site of built.sites) claim(site.cell, `capital:${site.cell}`);
    for (const r of all) {
      const unique = new Set(r.villages.map(v => v.cell));
      expect(unique.size).toBe(r.villages.length);
      for (const v of interiorOf(r)) {
        expect(v.cell).toBe(villageKey(r.frame.regionCell, v.cell % 16384));
        claim(v.cell, `village:${v.cell}`);
      }
      for (const t of r.borderTowns) {
        expect(isBorderTownKey(t.cell)).toBe(true);
        expect(Number.isSafeInteger(t.cell)).toBe(true);
        claim(t.cell, `border:${pairIndexOf(t.cell)}:${t.cell}`);
      }
    }
  });

  it("(e) the edge pass is deterministic — an edge is an address", { timeout: 240000 }, () => {
    const nb = nbs[0]!;
    const once = borderTowns(built, capital.cell, nb);
    const twice = borderTowns(built, capital.cell, nb);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    // And a re-refine reproduces villages INCLUDING the appended border
    // towns byte-for-byte (the wider determinism law lives in
    // region-refine.test.ts; this pins the new outputs).
    const again = refineRegion(built, capital.cell);
    expect(JSON.stringify(again.villages)).toBe(JSON.stringify(refined.villages));
    expect(JSON.stringify(again.borderTowns)).toBe(JSON.stringify(refined.borderTowns));
  });
});
