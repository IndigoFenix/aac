// Pure aim-mapping tests for the Render3D view. The 3D draw call needs a GPU and
// is device-tested, but the screen→ground RAYCAST is the control contract (the
// avatar's "arrive" steering rides it, exactly as the 2D view rides its
// screenToWorld transform), and it's pure THREE math — testable headless.

import { describe, it, expect } from "@jest/globals";
import * as THREE from "three";
import { screenRayToGround, colorForId, buildRoadRibbon } from "@shared/world-engine/render3d.js";

/** Build a camera posed like the renderer's follow rig over a ground centre,
 *  heading north (-Z) — the default before any movement swings it. */
function rigCamera(cx: number, cz: number): THREE.PerspectiveCamera {
  // Mirror the CAMERA tunables in render3d.ts (heading = -Z → back is +Z, ahead is -Z).
  const HEIGHT = 15;
  const BACK = 13;
  const LOOK_AHEAD = 8;
  const LOOK_HEIGHT = 1.2;
  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1000);
  cam.position.set(cx, HEIGHT, cz + BACK);
  cam.lookAt(cx, LOOK_HEIGHT, cz - LOOK_AHEAD);
  cam.updateMatrixWorld(true);
  return cam;
}

describe("Render3D screen→ground raycast", () => {
  it("maps screen centre to the ground in front of the avatar", () => {
    const cam = rigCamera(40, 30);
    const hit = screenRayToGround(cam, 0, 0);
    expect(hit).not.toBeNull();
    // Centred horizontally on the followed point…
    expect(hit!.x).toBeCloseTo(40, 1);
    // …and on the ground ahead of the camera (smaller world-y than the camera's z).
    expect(hit!.y).toBeLessThan(45);
    expect(hit!.y).toBeGreaterThan(0);
  });

  it("is monotonic vertically: higher on screen → further ahead (-z / smaller y)", () => {
    const cam = rigCamera(40, 30);
    const up = screenRayToGround(cam, 0, 0.5); // upper screen
    const down = screenRayToGround(cam, 0, -0.5); // lower screen
    expect(up).not.toBeNull();
    expect(down).not.toBeNull();
    expect(up!.y).toBeLessThan(down!.y);
  });

  it("is monotonic horizontally: right on screen → larger world-x", () => {
    const cam = rigCamera(40, 30);
    const left = screenRayToGround(cam, -0.5, 0);
    const right = screenRayToGround(cam, 0.5, 0);
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(right!.x).toBeGreaterThan(left!.x);
  });

  it("follows the camera: the same screen pixel maps relative to where it's centred", () => {
    const a = screenRayToGround(rigCamera(40, 30), 0, 0)!;
    const b = screenRayToGround(rigCamera(50, 30), 0, 0)!;
    // Move the rig +10 in x → the centre-screen ground hit shifts +10 in x too.
    expect(b.x - a.x).toBeCloseTo(10, 1);
    expect(b.y).toBeCloseTo(a.y, 1);
  });
});

describe("Render3D road ribbons", () => {
  /** The two half-width offset points at centerline index `i` (world x,z). */
  const edgesAt = (geom: THREE.BufferGeometry, i: number) => {
    const p = geom.getAttribute("position");
    return {
      left: { x: p.getX(2 * i), y: p.getY(2 * i), z: p.getZ(2 * i) },
      right: { x: p.getX(2 * i + 1), y: p.getY(2 * i + 1), z: p.getZ(2 * i + 1) },
    };
  };

  it("sweeps a straight segment to a flat ribbon of the given width", () => {
    const geom = buildRoadRibbon([{ x: 0, y: 0 }, { x: 10, y: 0 }], 2);
    const pos = geom.getAttribute("position");
    expect(pos.count).toBe(4); // two edge points per centerline point
    expect(geom.getIndex()!.count).toBe(6); // one quad = two triangles
    // A segment along +x offsets in ±z by half the width; the ribbon is flat.
    const { left, right } = edgesAt(geom, 0);
    expect(Math.hypot(left.x - right.x, left.z - right.z)).toBeCloseTo(2, 5);
    expect(left.y).toBeCloseTo(right.y, 6);
    expect(left.y).toBeGreaterThan(0);
    expect(left.y).toBeLessThan(0.1);
  });

  it("keeps the width across a bend via mitred joins", () => {
    const geom = buildRoadRibbon([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 2);
    expect(geom.getAttribute("position").count).toBe(6); // 3 points × 2 edges
    expect(geom.getIndex()!.count).toBe(12); // 2 quads
    // The corner vertex mitres outward but stays bounded (no infinite spike).
    for (let i = 0; i < 3; i++) {
      const { left, right } = edgesAt(geom, i);
      const w = Math.hypot(left.x - right.x, left.z - right.z);
      expect(w).toBeGreaterThanOrEqual(2 - 1e-6);
      expect(w).toBeLessThanOrEqual(2 * 3 + 1e-6); // clamped miter
    }
  });

  it("drops duplicate points and yields nothing for a degenerate path", () => {
    expect(buildRoadRibbon([{ x: 3, y: 3 }], 2).getIndex()).toBeNull();
    // Two coincident points collapse to one → still degenerate.
    expect(buildRoadRibbon([{ x: 3, y: 3 }, { x: 3, y: 3 }], 2).getIndex()).toBeNull();
    expect(buildRoadRibbon([], 2).getAttribute("position")).toBeUndefined();
  });
});

describe("Render3D colour palette", () => {
  it("is stable per id and varies across ids", () => {
    const c1 = colorForId("alice");
    const c2 = colorForId("alice");
    const c3 = colorForId("bob");
    expect(c1.getHexString()).toBe(c2.getHexString());
    expect(c1.getHexString()).not.toBe(c3.getHexString());
  });
});
