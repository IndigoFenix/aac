/**
 * The spirit drone camera — great-circle motion (no pole/limb singularity)
 * and a top-down chase whose placement invariant the streaming relies on
 * (camera sits at `cameraOffset` from the ground point, which rebases to the
 * origin). Pure vector math — no scene. (The dormant proportional `steer`
 * died with the move to shared/world-engine/spirit/ — the ladder's flight
 * regimes drive rotate/pan/climb instead.)
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { createDroneCamera } from "@shared/world-engine/spirit/drone-camera";

const R = 6_000_000;

describe("spirit drone — body & motion", () => {
  it("normalises pos, tangentialises heading, and exposes an orthonormal basis", () => {
    const d = createDroneCamera(new THREE.Vector3(2, 0, 0), new THREE.Vector3(0, 3, 0), 1000);
    expect(d.pos.length()).toBeCloseTo(1, 6);
    expect(d.heading.length()).toBeCloseTo(1, 6);
    expect(d.heading.dot(d.pos)).toBeCloseTo(0, 6); // heading is tangent
    const e = new THREE.Vector3(), n = new THREE.Vector3(), u = new THREE.Vector3();
    d.basis(e, n, u);
    expect(u.dot(d.pos)).toBeCloseTo(1, 6); // up = radial
    expect(e.dot(n)).toBeCloseTo(0, 6);
    expect(e.dot(u)).toBeCloseTo(0, 6);
    expect(e.length()).toBeCloseTo(1, 6);
  });

  it("the ground point is bodyCentre + pos·R", () => {
    const d = createDroneCamera(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), 1000);
    const gp = d.groundPoint(new THREE.Vector3(10, 0, -4), R, new THREE.Vector3());
    expect(gp.x).toBeCloseTo(10, 3);
    expect(gp.y).toBeCloseTo(R, 0);
    expect(gp.z).toBeCloseTo(-4, 3);
  });

  it("panForward advances along the great circle, keeping pos on the sphere", () => {
    const d = createDroneCamera(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), 100_000);
    const start = d.pos.clone();
    // A second of forward pan at 60 km/s, stepped at 60fps.
    for (let i = 0; i < 60; i++) d.panForward(60_000 / 60, R);
    expect(d.pos.length()).toBeCloseTo(1, 5); // still on the unit sphere
    expect(d.pos.distanceTo(start)).toBeGreaterThan(0); // it moved
    // Moved along the great circle by ≈ distance / R.
    const ang = d.pos.angleTo(start);
    expect(ang).toBeCloseTo(60_000 / R, 5);
    expect(d.heading.dot(d.pos)).toBeCloseTo(0, 6); // heading re-tangentialised
  });

  it("climb multiplies altitude and clamps to [min, max]", () => {
    const d = createDroneCamera(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), 1000);
    d.climb(-1, 1, 100, 5000); // dive for a second
    expect(d.altitude).toBeLessThan(1000);
    expect(d.altitude).toBeGreaterThanOrEqual(100);
    d.climb(-100, 1, 100, 5000); // would blow past the floor
    expect(d.altitude).toBe(100);
    d.climb(100, 1, 100, 5000); // would blow past the ceiling
    expect(d.altitude).toBe(5000);
  });
});

describe("spirit drone — the co-rotation regime", () => {
  // Mirror body.ts's spin step EXACTLY: orientation accumulates a local-frame
  // delta by RIGHT multiplication. A body-local direction `d` lives at world
  // `orientation · d`, so these tests can ask the question that matters —
  // does the drone stay over the same patch of ground?
  const AXIS = new THREE.Vector3(0.2, 1, -0.1).normalize();
  const RATE = (2 * Math.PI) / (24 * 3600); // an Earth-ish day
  const DT = 1 / 60;
  /** An HOUR of sim at 60fps — 15° of planet, far more than any drift gate. */
  const HOUR_STEPS = 60 * 60 * 60;

  const spin = (orientation: THREE.Quaternion): void => {
    orientation.multiply(new THREE.Quaternion().setFromAxisAngle(AXIS, RATE * DT));
  };
  /** Where the drone sits in BODY-LOCAL terms — what the terrain is sampled in. */
  const localDir = (d: { pos: THREE.Vector3 }, orientation: THREE.Quaternion): THREE.Vector3 =>
    d.pos.clone().applyQuaternion(orientation.clone().invert());

  it("w=1 holds the drone over a FIXED body-local point as the body spins", () => {
    const d = createDroneCamera(new THREE.Vector3(0.35, 0.5, 0.79), new THREE.Vector3(0, 1, 0), 1000);
    const orientation = new THREE.Quaternion();
    const startLocal = localDir(d, orientation);
    for (let i = 0; i < HOUR_STEPS; i++) {
      spin(orientation);
      d.precess(AXIS, RATE * DT * 1);
    }
    // The planet really did turn (~15°)...
    expect(new THREE.Quaternion().angleTo(orientation)).toBeGreaterThan(0.2);
    // ...and the drone's local footprint did not budge: no drift at all.
    expect(localDir(d, orientation).angleTo(startLocal)).toBeLessThan(1e-6);
  });

  it("w=0 leaves the drone inertial — world-fixed while the body turns beneath", () => {
    const d = createDroneCamera(new THREE.Vector3(0.35, 0.5, 0.79), new THREE.Vector3(0, 1, 0), 1000);
    const orientation = new THREE.Quaternion();
    const startWorld = d.pos.clone();
    const startLocal = localDir(d, orientation);
    for (let i = 0; i < HOUR_STEPS; i++) {
      spin(orientation);
      d.precess(AXIS, RATE * DT * 0);
    }
    expect(d.pos.angleTo(startWorld)).toBeLessThan(1e-9);       // world-fixed
    expect(localDir(d, orientation).angleTo(startLocal)).toBeGreaterThan(0.2); // ground slid by
  });

  it("precess is rigid — altitude and the ground-relative heading survive", () => {
    const d = createDroneCamera(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), 1000);
    const e0 = new THREE.Vector3(), n0 = new THREE.Vector3(), u0 = new THREE.Vector3();
    d.basis(e0, n0, u0);
    for (let i = 0; i < 600; i++) d.precess(AXIS, RATE * DT);
    expect(d.altitude).toBe(1000);            // not steering: no climb
    expect(d.pos.length()).toBeCloseTo(1, 9); // still on the unit sphere
    expect(d.heading.dot(d.pos)).toBeCloseTo(0, 9); // still tangent
    // The heading turned with the ground rather than relative to it: the angle
    // between heading and the (also-precessed) east axis is unchanged.
    const e1 = new THREE.Vector3(), n1 = new THREE.Vector3(), u1 = new THREE.Vector3();
    d.basis(e1, n1, u1);
    expect(n1.dot(e1)).toBeCloseTo(n0.dot(e0), 6);
  });

  it("tracks under a NON-IDENTITY starting orientation (world axis = orientation·axis)", () => {
    // Today axial tilt lives in `rotation.axis` while `orientation` starts at
    // identity, which makes the world spin axis coincidentally equal to
    // `rotation.axis`. Seed a turned body to pin the GENERAL law instead.
    const d = createDroneCamera(new THREE.Vector3(0.35, 0.5, 0.79), new THREE.Vector3(0, 1, 0), 1000);
    const orientation = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(1, 0, 0).normalize(), 0.9);
    const startLocal = localDir(d, orientation);
    const worldAxis = new THREE.Vector3();
    for (let i = 0; i < HOUR_STEPS; i++) {
      spin(orientation);
      worldAxis.copy(AXIS).applyQuaternion(orientation);
      d.precess(worldAxis, RATE * DT);
    }
    expect(localDir(d, orientation).angleTo(startLocal)).toBeLessThan(1e-6);
  });

  it("the (R/r)^N weight locks near the ground and releases in space", () => {
    const R_B = 6_371_000;
    const w = (alt: number): number => Math.pow(R_B / (R_B + alt), 2);
    // Where the old bug lived: spin drift is ~463 m/s at the surface, and the
    // steering law gives 0.55·alt — they crossed near 840 m. Residual drift
    // there is now sub-metre-per-second against 550 m/s commanded.
    const spinSurface = RATE * R_B;
    expect((1 - w(1000)) * spinSurface).toBeLessThan(1);
    expect(w(30)).toBeGreaterThan(0.999);   // ground handoff: locked
    expect(w(R_B)).toBeCloseTo(0.25, 6);    // r = 2R
    expect(w(R_B * 2.5)).toBeLessThan(0.1); // maxAlt: near-inertial
    // Monotone release with altitude — no regime reversal on the way up.
    for (const [lo, hi] of [[30, 1000], [1000, 100_000], [100_000, R_B]] as const) {
      expect(w(hi)).toBeLessThan(w(lo));
    }
  });
});

describe("spirit drone — the chase camera", () => {
  it("sits above the ground point (origin) and looks down at it", () => {
    const d = createDroneCamera(new THREE.Vector3(0.2, 0.7, 0.3), new THREE.Vector3(0, 0, 1), 800);
    const off = d.cameraOffset(new THREE.Vector3());
    const camera = new THREE.PerspectiveCamera();
    d.place(camera);
    // The ground point is the scene origin → camera.position === cameraOffset.
    expect(camera.position.distanceTo(off)).toBeLessThan(1e-6);
    // Camera is above the drone (positive radial height)...
    const e = new THREE.Vector3(), n = new THREE.Vector3(), u = new THREE.Vector3();
    d.basis(e, n, u);
    expect(camera.position.dot(u)).toBeGreaterThan(0);
    // ...and looks downward (its view direction has a negative radial component).
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    expect(fwd.dot(u)).toBeLessThan(0);
  });
});
