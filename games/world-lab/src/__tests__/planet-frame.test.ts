/**
 * planet-frame.test.ts — THE ENGINE'S TANGENT FRAME **IS** THE RENDERER'S.
 *
 * `shared/world-engine/interaction/town/planet-scope.ts` must stay THREE-free:
 * it is the headless boot, and text mode has no renderer. So the tangent frame
 * every town on the planet is anchored, planned and projected in — the
 * quaternion `setFromUnitVectors(+Y, dir)` applied to `(1,0,0)` and `(0,0,1)`
 * (`main.ts townFrameOf`, `attachSurfaceAnchor`) — is written out by hand
 * there, in the half-angle form.
 *
 * A hand-written copy of somebody else's math is exactly the drift this round
 * exists to close, so this suite holds the two against each other: the engine's
 * `tangentFrameAt` / `sphereMetric.offsetM` against REAL THREE and the app's
 * own `at` arithmetic, on the frontier planet's actual founding direction and
 * its three nearest capitals (the near-parallel regime the partner scan lives
 * in), plus 20 pseudo-random unit directions and the degenerate poles.
 *
 * It lives here, in the world-lab's VITEST suite, because this is the side of
 * the house that may import THREE (C-8). Run: `npm run test:world-lab`.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  tangentFrameAt, sphereMetric,
} from "@shared/world-engine/interaction/town/planet-scope";
import type { GridTopology } from "@shared/world-engine/kernel/cells/topology";

type Vec3 = readonly [number, number, number];

/** The frontier planet's founding direction (cell 12755) and the three
 *  capitals its partner scan names — recorded off the real bake. */
const SELF: Vec3 = [-0.36713294723022294, 0.045641203990156205, -0.9290480501870607];
const NEAREST: Vec3[] = [
  [-0.3966276825733212, 0.07501827606937596, -0.9149091428508601],   // Tarastead  12804
  [-0.33684987394997157, 0.015405525345866193, -0.9414323301271876], // Pelodale   12706
  [-0.3977036529784886, 0.015012116620808588, -0.9173911056698387],  // Galridge76 12708
];
const RADIUS_M = 6384755.564817732;

/** Deterministic unit directions (mulberry32 over a fixed seed). */
function randomDirs(n: number, seed: number): Vec3[] {
  let a = seed >>> 0;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: Vec3[] = [];
  while (out.length < n) {
    const x = rnd() * 2 - 1, y = rnd() * 2 - 1, z = rnd() * 2 - 1;
    const l = Math.hypot(x, y, z);
    if (l < 1e-6) continue;
    out.push([x / l, y / l, z / l]);
  }
  return out;
}

const UP_Y = new THREE.Vector3(0, 1, 0);

/** THE REFERENCE: the app's own frame, through real THREE. */
function threeFrame(dir: Vec3): { east: THREE.Vector3; north: THREE.Vector3 } {
  const d = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(UP_Y, d);
  return {
    east: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
    north: new THREE.Vector3(0, 0, 1).applyQuaternion(q),
  };
}

/** THE REFERENCE: `nearbyCityPartners`' own `at` arithmetic, through real
 *  THREE (main.ts:3243-3258) — self excluded, simCenter at the origin. */
function threeOffset(selfDir: Vec3, otherDir: Vec3): { x: number; y: number } | null {
  const self = new THREE.Vector3(selfDir[0], selfDir[1], selfDir[2]);
  const other = new THREE.Vector3(otherDir[0], otherDir[1], otherDir[2]);
  const { east, north } = threeFrame(selfDir);
  const ang = self.angleTo(other);
  if (ang < 1e-9) return null;
  const toward = other.addScaledVector(self, -other.dot(self));
  if (toward.lengthSq() < 1e-12) return null;
  toward.normalize();
  const distM = ang * RADIUS_M;
  return { x: toward.dot(east) * distM, y: toward.dot(north) * distM };
}

/** A topology stub: `sphereMetric` reads nothing but `pos3`. */
function topoOf(dirs: readonly Vec3[]): GridTopology {
  return { pos3: (i: number) => dirs[i]! } as unknown as GridTopology;
}

const DIRS = [SELF, ...NEAREST, ...randomDirs(20, 0x5eed)];

/** 1e-9 RELATIVE. The frame vectors are unit-length and compare absolutely;
 *  offsets and distances are METRES on a 6,384 km planet (up to ~2×10⁷), where
 *  an absolute 1e-9 is a sub-nanometre demand no double can meet — one ULP at
 *  that magnitude is already 4×10⁻⁹ m. The claim being made is that the two
 *  arms are the SAME arithmetic, and relative agreement is how that is said. */
function closeRel(got: number, want: number, rel = 1e-9): void {
  expect(Math.abs(got - want)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(want)));
}

describe("the engine's tangent frame is THREE's, to 1e-9", () => {
  it("east and north agree on every direction the partner scan meets", () => {
    for (const d of DIRS) {
      const mine = tangentFrameAt(d);
      const ref = threeFrame(d);
      expect(mine.east[0]).toBeCloseTo(ref.east.x, 9);
      expect(mine.east[1]).toBeCloseTo(ref.east.y, 9);
      expect(mine.east[2]).toBeCloseTo(ref.east.z, 9);
      expect(mine.north[0]).toBeCloseTo(ref.north.x, 9);
      expect(mine.north[1]).toBeCloseTo(ref.north.y, 9);
      expect(mine.north[2]).toBeCloseTo(ref.north.z, 9);
    }
  });

  it("agrees at the poles, INCLUDING the antiparallel branch", () => {
    // `dir ≈ −Y` never occurs on a founding cell, but a frame that quietly
    // disagreed with the renderer at one input would be a defect nobody could
    // see until a town was founded at the south pole.
    for (const d of [[0, 1, 0], [0, -1, 0]] as Vec3[]) {
      const mine = tangentFrameAt(d);
      const ref = threeFrame(d);
      expect(mine.east[0]).toBeCloseTo(ref.east.x, 9);
      expect(mine.east[1]).toBeCloseTo(ref.east.y, 9);
      expect(mine.east[2]).toBeCloseTo(ref.east.z, 9);
      expect(mine.north[0]).toBeCloseTo(ref.north.x, 9);
      expect(mine.north[1]).toBeCloseTo(ref.north.y, 9);
      expect(mine.north[2]).toBeCloseTo(ref.north.z, 9);
    }
  });
});

describe("sphereMetric reproduces the app's partner projection", () => {
  const metric = sphereMetric(topoOf(DIRS), RADIUS_M);

  it("distM is `angleTo × radius`", () => {
    for (let i = 0; i < DIRS.length; i++) {
      for (let j = 0; j < DIRS.length; j++) {
        const a = new THREE.Vector3(...DIRS[i]!);
        const b = new THREE.Vector3(...DIRS[j]!);
        closeRel(metric.distM(DIRS[i]!, DIRS[j]!), a.angleTo(b) * RADIUS_M);
      }
    }
  });

  it("offsetM is the app's `at`, on the three nearest and 20 random dirs", () => {
    for (const self of DIRS) {
      for (const other of DIRS) {
        const ref = threeOffset(self, other);
        const mine = metric.offsetM(self, other);
        if (ref === null) { expect(mine).toBeNull(); continue; }
        expect(mine).not.toBeNull();
        closeRel(mine!.x, ref.x);
        closeRel(mine!.y, ref.y);
      }
    }
  });

  it("posOf indexes the lattice, and a co-located city drops out", () => {
    expect(metric.posOf(0)).toEqual(SELF);
    // The homestead and the capital that shares its cell: no bearing at all.
    expect(metric.offsetM(SELF, SELF)).toBeNull();
    // …and neither is there one to the antipode.
    expect(metric.offsetM(SELF, [-SELF[0], -SELF[1], -SELF[2]])).toBeNull();
  });
});
