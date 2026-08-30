/**
 * The substrate surface (planet/surface.ts) must be CONTINUOUS — it is the
 * single height authority for the planet render (chunk vertices), the city
 * anchors, the town terrain (walk-chart / makeTownGround), and the flight's
 * landing physics. A discontinuity anywhere shows up as a cliff-line seam in
 * the landscape and a "floating" town (content conformed to one side of the
 * jump standing over a mesh drawn on the other).
 *
 * The historical failure mode (documented in surface.ts): kernel STENCIL
 * MEMBERSHIP changing as the sample crosses a cell border — a contributing
 * cell reachable in 2 hops from one side but 3 from the other pops in/out,
 * and the deep-sea elevation scaling amplifies the jump ~22×. Hop distance
 * diverges from metric distance exactly at cube-sphere face edges/corners,
 * so the seams draw as long straight cliffs.
 *
 * SCALE MATTERS: faceN-24 cells are ~417 km wide — a march must be LONGER
 * than a cell to cross any border at all, and must be CENTERED on a face
 * edge to test the seam line. Each march here spans multiple cells.
 */
import { describe, it, expect } from "vitest";
import { buildPlanetWorld } from "@shared/world-engine/planet/planet-game";

const R_EARTH = 6_371_000;

function buildEarth() {
  return buildPlanetWorld({
    scope: "planet",
    world: {
      topology: { kind: "cube-sphere", faceN: 24 },
      geology: { seed: 1337, epochs: 350, continentR: 0.38 },
      settle: true,
      radius: R_EARTH,
    },
    initialFocus: null,
    avatar: false,
    avatarSpecies: "human", mods: [],
    canFly: false,
    creativeMode: false,
    entities: null,
  });
}

type V3 = [number, number, number];
const norm = (v: V3): V3 => {
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / m, v[1] / m, v[2] / m];
};
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * March a great circle CENTERED on `center`, heading along `toward`
 * (projected tangent), covering `spanM` metres in `stepM` steps. Returns the
 * worst single-step height jump. Centered, so a discontinuity line through
 * `center` is guaranteed to be crossed.
 */
function worstStep(
  surface: { heightAt(dir: V3): number },
  center: V3,
  toward: V3,
  spanM: number,
  stepM: number,
): { jump: number; at: V3 } {
  const u = norm(center);
  const dotUT = toward[0] * u[0] + toward[1] * u[1] + toward[2] * u[2];
  const v = norm([toward[0] - u[0] * dotUT, toward[1] - u[1] * dotUT, toward[2] - u[2] * dotUT]);
  const halfArc = spanM / 2 / R_EARTH;
  const dTheta = stepM / R_EARTH;
  const steps = Math.floor(spanM / stepM);
  let prev: number | null = null;
  let jump = 0;
  let at: V3 = u;
  for (let s = 0; s <= steps; s++) {
    const t = -halfArc + s * dTheta;
    const dir: V3 = [
      u[0] * Math.cos(t) + v[0] * Math.sin(t),
      u[1] * Math.cos(t) + v[1] * Math.sin(t),
      u[2] * Math.cos(t) + v[2] * Math.sin(t),
    ];
    const h = surface.heightAt(dir);
    if (prev !== null) {
      const dh = Math.abs(h - prev);
      if (dh > jump) { jump = dh; at = dir; }
    }
    prev = h;
  }
  return { jump, at };
}

describe("planet surface continuity — no cliff-line seams", { timeout: 480_000 }, () => {
  const built = buildEarth();
  const surface = built.surface;
  // TRUE-SLOPE BOUND per 20 m step: the smooth field varies over ~417 km
  // cells (tens of km of relief ⇒ metres per 20 m); the detail noise adds a
  // bounded, gentle slope. 25 m/step (slope > 1) is far beyond anything the
  // continuous field produces and far below membership-pop cliffs (tens to
  // hundreds of metres in ONE step, deep-sea amplified).
  const STEP_M = 20;
  const LIMIT_M = 25;
  const SPAN_M = 500_000; // ±250 km around each center — multiple cells deep

  it("across cube-face EDGES and the CORNER (where hop ≠ metric distance)", () => {
    // March lines CENTERED on face-boundary points, crossing perpendicular.
    const cases: Array<{ center: V3; toward: V3; label: string }> = [
      { center: norm([1, 0.02, 1]), toward: [-1, 0, 1], label: "+X|+Z edge (equatorish)" },
      { center: norm([1, 0.6, 1]), toward: [-1, 0, 1], label: "+X|+Z edge (north)" },
      { center: norm([1, 1, 0.02]), toward: [-1, 1, 0], label: "+X|+Y edge" },
      { center: norm([0.02, 1, 1]), toward: [0, -1, 1], label: "+Y|+Z edge" },
      { center: norm([1, 1, 1]), toward: [-1, 1, 0], label: "+X+Y+Z corner, sweep A" },
      { center: norm([1, 1, 1]), toward: [-1, 0, 1], label: "+X+Y+Z corner, sweep B" },
      { center: norm([-1, 0.02, 1]), toward: [1, 0, 1], label: "-X|+Z edge" },
      { center: norm([-1, -1, -1]), toward: [1, -1, 0], label: "-X-Y-Z corner" },
    ];
    for (const c of cases) {
      const res = worstStep(surface, c.center, c.toward, SPAN_M, STEP_M);
      expect(
        res.jump,
        `${c.label}: jumped ${res.jump.toFixed(1)} m in one ${STEP_M} m step at [${res.at.map(x => x.toFixed(4))}]`,
      ).toBeLessThan(LIMIT_M);
    }
  });

  it("across the founding sites (where towns anchor)", () => {
    const sites = built.sites.slice(0, 3);
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      const dir = built.topo.pos3!(site.cell) as V3;
      const east = norm([-dir[2], 0, dir[0]]);
      const north = norm(cross(dir, east));
      for (const t of [east, north]) {
        const res = worstStep(surface, dir, t, SPAN_M, STEP_M);
        expect(res.jump, `site ${site.cell}: jumped ${res.jump.toFixed(1)} m in one step`).toBeLessThan(LIMIT_M);
      }
    }
  });

  it("random long marches (whole-sphere net for interior cell borders)", () => {
    let s = 42;
    const rnd = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32 - 0.5;
    };
    for (let k = 0; k < 6; k++) {
      const center = norm([rnd(), rnd(), rnd()]);
      const toward = norm([rnd(), rnd(), rnd()]);
      const res = worstStep(surface, center, toward, 2_000_000, 50);
      expect(res.jump, `random march ${k}: jumped ${res.jump.toFixed(1)} m in one 50 m step`).toBeLessThan(LIMIT_M * 2.5);
    }
  });
});
