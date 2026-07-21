/**
 * SPHERE-NATIVE ground rung — the ladder's GROUND glide over a curved
 * surface (frame-provider `SphereGroundOps`). Pins the planet-frame law:
 * ground movement, the gaze terrain-march and the spark are computed against
 * the TRUE sphere in a MOVING local frame — there is no session anchor, so
 * nothing drifts with distance from a town or a landing point.
 *
 * The mock planet is small (R = 10 km) so curvature is vicious: 3 km of
 * travel puts the entry point's tangent plane ~450 m above the surface. The
 * legacy (anchor-chart) session members THROW — if any ground-rung code path
 * still leaned on the anchor contract, these tests would explode, not drift.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { createSpiritLadder } from "@shared/world-engine/spirit/ladder";
import type {
  SphereGroundOps, SpiritFrameProvider, SpiritGroundSession,
} from "@shared/world-engine/spirit/frame-provider";

const DT = 1 / 60;
const R = 10_000;

/** Tangent frame on the unit sphere at `dir` (terrain ≡ 0, centre at origin). */
function frameAtDir(dir: THREE.Vector3) {
  const up = dir.clone();
  const ref = Math.abs(up.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const east = new THREE.Vector3().crossVectors(ref, up).normalize();
  const north = new THREE.Vector3().crossVectors(up, east);
  return { origin: up.clone().multiplyScalar(R), east, north, up };
}

function mockSphereWorld() {
  const camera = new THREE.PerspectiveCamera(60, 800 / 600);
  let driven: { loc: THREE.Vector3; fx: number; fz: number } | null = null;
  let spark: THREE.Vector3 | null = null;

  const sphere: SphereGroundOps = {
    locFromWorld: (p, out) => out.copy(p).normalize(),
    surfaceAt: (loc, out) => out.copy(loc).multiplyScalar(R),
    frameAt: (loc) => frameAtDir(loc),
    move(loc, e, n, out) {
      const f = frameAtDir(loc);
      const p = f.origin.addScaledVector(f.east, e).addScaledVector(f.north, n);
      return out.copy(p).normalize();
    },
    heightAbove: (p) => p.length() - R,
    buildingAt: () => null,
    placeAvatar: () => { /* open ground */ },
    drivenBody: () => driven,
  };

  const session: SpiritGroundSession = {
    // The ANCHOR contract must be dead code on a sphere session.
    chartAt: () => { throw new Error("anchor chartAt used on a sphere session"); },
    groundY: () => { throw new Error("anchor groundY used on a sphere session"); },
    buildingAt: () => { throw new Error("anchor buildingAt used on a sphere session"); },
    sphere,
  };

  const provider: SpiritFrameProvider = {
    scopeLevel: "flight",
    camera,
    viewSize: () => ({ w: 800, h: 600 }),
    advance() { /* noop */ },
    rebaseOnCamera: () => ({ near: 0.5, far: 1e9, camAtOrigin: false }),
    postFrame: () => ({ nearTown: null, waiting: null }),
    openTown: () => { throw new Error("no towns on the mock sphere"); },
    openGround: () => session,
    spark(p) { spark = p ? (spark ?? new THREE.Vector3()).copy(p) : null; },
  };

  return {
    provider,
    camera,
    setDriven(b: { loc: THREE.Vector3; fx: number; fz: number } | null) { driven = b; },
    sparkAt: () => spark,
  };
}

/** Body-local dir at arc-angle θ along the equator walk from (1,0,0). */
const dirAt = (theta: number): THREE.Vector3 =>
  new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta));

describe("GROUND on a sphere — moving local frame, no anchor", () => {
  it("the glide's surface address rides the sphere for kilometres (no tangent-plane drift)", () => {
    const w = mockSphereWorld();
    const ladder = createSpiritLadder({ provider: w.provider, ceiling: "flight" });
    w.camera.position.set(R + 20, 0, 0);
    w.camera.lookAt(R, 0, 60);
    ladder.dropToGround(new THREE.Vector3(R, 0, 0));
    expect(ladder.level).toBe("ground");

    // A claimed body walks the equator at 2 m/frame for 1500 frames — 3 km of
    // arc. The ENTRY point's tangent plane is ~R(1−cos 0.3) ≈ 448 m above the
    // surface out here; an anchor-lifted glide would be sky-high.
    const focus = new THREE.Vector3();
    let now = 0;
    for (let i = 1; i <= 1500; i++) {
      w.setDriven({ loc: dirAt((i * 2) / R), fx: -1, fz: 0 });
      now += DT * 1000;
      ladder.step(null, DT, now);
      if (i % 100 === 0) {
        expect(ladder.focusWorld(focus)).toBe(true);
        expect(Math.abs(focus.length() - R)).toBeLessThan(0.5);
      }
    }
    // Arrived: the address matches the body's true position on the sphere.
    ladder.focusWorld(focus);
    expect(focus.distanceTo(dirAt(3000 / R).multiplyScalar(R))).toBeLessThan(5);
    // The camera rides the surface too — never buried, never stratospheric.
    const camAlt = w.camera.position.length() - R;
    expect(camAlt).toBeGreaterThan(0.5);
    expect(camAlt).toBeLessThan(60);
  });

  it("the spark lands ON the gaze ray's true surface hit, far from the entry point", () => {
    const w = mockSphereWorld();
    const ladder = createSpiritLadder({ provider: w.provider, ceiling: "flight" });
    w.camera.position.set(R + 20, 0, 0);
    w.camera.lookAt(R, 0, 60);
    ladder.dropToGround(new THREE.Vector3(R, 0, 0));

    // Walk 500 m out (entry tangent-plane error there: ~12.5 m), then release.
    let now = 0;
    for (let i = 1; i <= 250; i++) {
      w.setDriven({ loc: dirAt((i * 2) / R), fx: -1, fz: 0 });
      now += DT * 1000;
      ladder.step(null, DT, now);
    }
    w.setDriven(null);

    // Hold a steady gaze a little below screen centre until it commits.
    const P = { x: 400, y: 380, clientX: 400, clientY: 380 };
    for (let i = 0; i < 300; i++) {
      now += DT * 1000;
      ladder.step(P, DT, now);
    }
    const spark = w.sparkAt();
    expect(spark).not.toBeNull();
    // ON the surface (floated 0.4 m up the local vertical) …
    expect(spark!.length() - R).toBeGreaterThan(0.2);
    expect(spark!.length() - R).toBeLessThan(0.7);
    // … and ON the gaze ray — the cursor and the spark agree again.
    w.camera.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((P.x / 800) * 2 - 1, -((P.y / 600) * 2 - 1)), w.camera);
    expect(ray.ray.distanceToPoint(spark!)).toBeLessThan(0.7);
  });
});
