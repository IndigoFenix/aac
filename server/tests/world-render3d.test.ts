// Pure aim-mapping tests for the Render3D view. The 3D draw call needs a GPU and
// is device-tested, but the screen→ground RAYCAST is the control contract (the
// avatar's "arrive" steering rides it, exactly as the 2D view rides its
// screenToWorld transform), and it's pure THREE math — testable headless.

import { describe, it, expect } from "@jest/globals";
import * as THREE from "three";
import { screenRayToGround, colorForId } from "@shared/world-engine/render3d.js";

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

describe("Render3D colour palette", () => {
  it("is stable per id and varies across ids", () => {
    const c1 = colorForId("alice");
    const c2 = colorForId("alice");
    const c3 = colorForId("bob");
    expect(c1.getHexString()).toBe(c2.getHexString());
    expect(c1.getHexString()).not.toBe(c3.getHexString());
  });
});
