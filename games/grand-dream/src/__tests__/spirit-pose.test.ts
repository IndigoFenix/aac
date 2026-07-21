/**
 * Spirit pose plumbing — the pure pieces the ladder blends between:
 *   • dollhousePoseMath / resolveDollhouseBounds (render3d): a GOLDEN pin of
 *     the dollhouse rig formula, guarding the updateCamera extraction (the
 *     spirit branch and the public dollhousePose must stay one formula);
 *   • pose blending (spirit/pose.ts);
 *   • the chase rig (spirit/chase-rig.ts) — the avatar's camera laws as a
 *     pure module, driven by the SAME tunables objects.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  dollhousePoseMath, resolveDollhouseBounds, DOLLHOUSE_FOV, FLOOR_HEIGHT,
  DOLLHOUSE_OPEN_GROUND_SPAN,
} from "@shared/world-engine/render3d";
import {
  createSpiritPose, blendPose, smoothstep01, applyPose,
} from "@shared/world-engine/spirit/pose";
import { createChaseRig } from "@shared/world-engine/spirit/chase-rig";
import {
  DEFAULT_CAMERA_TUNABLES, DEFAULT_COMFORT_TUNABLES,
} from "@shared/world-engine/world-tunables";

describe("dollhouse pose math — the GOLDEN pin of the rig formula", () => {
  it("frames a known bounds exactly as the historical updateCamera branch", () => {
    // A 10×20 frame at (5,5) → centre (10,15), span 20·1.2 = 24.
    const bounds = resolveDollhouseBounds({ x: 5, y: 5, w: 10, h: 20 }, [], 100, 100);
    expect(bounds).toEqual({ cx: 10, cz: 15, span: 24 });

    const out = createSpiritPose();
    dollhousePoseMath(bounds, 2, 0, out);
    // Independent re-derivation, written out long-hand: fov 40, pitch 0.5,
    // az = PI/2 (spiritAz 0 → the +Z front side), lookY = 3·0.55 = 1.65.
    const dist = 24 / (2 * Math.tan((40 * Math.PI) / 360));
    expect(out.fov).toBe(DOLLHOUSE_FOV);
    expect(out.pos.x).toBeCloseTo(10 + Math.cos(Math.PI / 2) * dist * Math.cos(0.5), 10);
    expect(out.pos.y).toBeCloseTo(dist * Math.sin(0.5) + FLOOR_HEIGHT * 0.55 + 2, 10);
    expect(out.pos.z).toBeCloseTo(15 + Math.sin(Math.PI / 2) * dist * Math.cos(0.5), 10);
    expect(out.look.x).toBeCloseTo(10, 10);
    expect(out.look.y).toBeCloseTo(1.65 + 2, 10);
    expect(out.look.z).toBeCloseTo(15, 10);
    expect(out.up.y).toBe(1);
    // Hard numeric pins (catch silent constant drift): dist ≈ 32.9697,
    // pos.y ≈ 32.9697·sin(.5)+3.65 ≈ 19.4574.
    expect(dist).toBeCloseTo(32.96973, 4);
    expect(out.pos.y).toBeCloseTo(19.45653, 4);
  });

  it("no frame: scans building footprints; none: focus window, else the whole manifold", () => {
    const scan = resolveDollhouseBounds(null, [
      { footprint: { x: 0, y: 0, w: 4, h: 4 } },
      { footprint: { x: 8, y: 2, w: 4, h: 6 } },
    ], 100, 100);
    expect(scan).toEqual({ cx: 6, cz: 4, span: 12 * 1.2 });
    // Open ground with a focus body: a body-scale window rides the body —
    // NOT the manifold rect (a wilderness chunk framed whole parks the
    // camera hundreds of metres up: the misalignment this tier fixes).
    const wild = resolveDollhouseBounds(null, [], 320, 320, { x: 200, y: 40 });
    expect(wild).toEqual({ cx: 200, cz: 40, span: DOLLHOUSE_OPEN_GROUND_SPAN * 1.2 });
    // Buildings still beat the focus window (a town is a subject; a body is
    // only the fallback subject of LAST resort before the bare rect).
    const town = resolveDollhouseBounds(null, [
      { footprint: { x: 0, y: 0, w: 4, h: 4 } },
    ], 100, 100, { x: 90, y: 90 });
    expect(town).toEqual({ cx: 2, cz: 2, span: 4 * 1.2 });
    const bare = resolveDollhouseBounds(null, [], 60, 40);
    expect(bare).toEqual({ cx: 30, cz: 20, span: 60 * 1.2 });
  });

  it("azimuth orbits the pose around the framed centre at constant radius", () => {
    const bounds = resolveDollhouseBounds({ x: 0, y: 0, w: 10, h: 10 }, [], 50, 50);
    const a = createSpiritPose();
    const b = createSpiritPose();
    dollhousePoseMath(bounds, 0, 0, a);
    dollhousePoseMath(bounds, 0, Math.PI / 3, b);
    const centre = new THREE.Vector3(bounds.cx, 0, bounds.cz);
    const ra = a.pos.clone().sub(centre).setY(0).length();
    const rb = b.pos.clone().sub(centre).setY(0).length();
    expect(ra).toBeCloseTo(rb, 10);
    expect(a.pos.y).toBeCloseTo(b.pos.y, 10);
    expect(a.look.distanceTo(b.look)).toBeLessThan(1e-10);
  });
});

describe("pose blending", () => {
  it("smoothstep is monotone, clamped, and hits its endpoints", () => {
    expect(smoothstep01(-1)).toBe(0);
    expect(smoothstep01(0)).toBe(0);
    expect(smoothstep01(0.5)).toBeCloseTo(0.5, 10);
    expect(smoothstep01(1)).toBe(1);
    expect(smoothstep01(2)).toBe(1);
    let prev = 0;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const v = smoothstep01(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("t=0 → a, t=1 → b, fov lerps, up stays unit", () => {
    const a = createSpiritPose();
    a.pos.set(0, 10, 0);
    a.look.set(0, 0, 0);
    a.up.set(0, 1, 0);
    a.fov = 60;
    const b = createSpiritPose();
    b.pos.set(20, 4, 0);
    b.look.set(20, 0, 10);
    b.up.set(1, 0, 0);
    b.fov = 40;
    const out = createSpiritPose();
    blendPose(a, b, 0, out);
    expect(out.pos.distanceTo(a.pos)).toBeLessThan(1e-10);
    expect(out.fov).toBe(60);
    blendPose(a, b, 1, out);
    expect(out.pos.distanceTo(b.pos)).toBeLessThan(1e-10);
    expect(out.fov).toBe(40);
    blendPose(a, b, 0.5, out);
    expect(out.up.length()).toBeCloseTo(1, 10);
    expect(out.fov).toBeCloseTo(50, 10);
  });

  it("applyPose writes position/up/fov and aims the camera at look", () => {
    const p = createSpiritPose();
    p.pos.set(5, 8, 5);
    p.look.set(5, 0, 5);
    p.fov = 42;
    const cam = new THREE.PerspectiveCamera(60, 1);
    applyPose(p, cam);
    expect(cam.position.x).toBe(5);
    expect(cam.fov).toBe(42);
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    expect(fwd.y).toBeLessThan(-0.99); // looking straight down
  });
});

describe("chase rig — the avatar's camera laws, pure", () => {
  const mk = () => createChaseRig(DEFAULT_CAMERA_TUNABLES, DEFAULT_COMFORT_TUNABLES);

  it("yaw is capped by the gaze-distance rule AND the comfort ceiling", () => {
    const rig = mk();
    rig.snap(0, 0, 0, 1);
    // Near gaze (distance 3, straight right): effMax = min(0.7, 4/max(3,2)) = 4/3 → cap 0.7.
    rig.update({ x: 0, z: 0, groundY: 0, gaze: { x: 3, z: 0 }, dt: 1 / 60 });
    expect(rig.lastYawSpeed).toBeLessThanOrEqual(DEFAULT_COMFORT_TUNABLES.maxYawSpeed + 1e-9);
    // Far gaze (distance 40): effMax = 4/40 = 0.1 rad/s.
    const rig2 = mk();
    rig2.snap(0, 0, 0, 1);
    rig2.update({ x: 0, z: 0, groundY: 0, gaze: { x: 40, z: 0 }, dt: 1 / 60 });
    expect(rig2.lastYawSpeed).toBeLessThanOrEqual(4 / 40 + 1e-9);
    expect(rig2.lastYawSpeed).toBeGreaterThan(0);
  });

  it("a gaze on the avatar (inside moveThreshold) holds the heading", () => {
    const rig = mk();
    rig.snap(0, 0, 0, 1);
    rig.update({ x: 0, z: 0, groundY: 0, gaze: { x: 0.2, z: 0 }, dt: 1 / 60 });
    expect(rig.lastYawSpeed).toBe(0);
    expect(rig.forward.z).toBeCloseTo(1, 10);
  });

  it("the pose is placeCamera's formula: behind along the heading, riding the terrain", () => {
    const rig = mk();
    rig.snap(10, 20, 0, 1);
    // Long forward settle → shoulder rig (travelCommit → 1).
    for (let i = 0; i < 600; i++) {
      rig.update({ x: 10, z: 20, groundY: 3, gaze: { x: 10, z: 60 }, dt: 1 / 60 });
    }
    const pose = createSpiritPose();
    rig.pose(pose);
    const s = DEFAULT_CAMERA_TUNABLES.shoulder;
    expect(pose.pos.x).toBeCloseTo(10, 4);
    expect(pose.pos.y).toBeCloseTo(3 + s.height, 3);
    expect(pose.pos.z).toBeCloseTo(20 - s.back, 3);
    expect(pose.look.z).toBeCloseTo(20 + s.lookAhead, 3);
    expect(pose.look.y).toBeCloseTo(3 + s.lookHeight, 3);
    expect(pose.fov).toBeCloseTo(s.fov, 5);
  });

  it("a clearly-behind gaze lifts to overhead; the altitude channel raises the rig", () => {
    const rig = mk();
    rig.snap(0, 0, 0, 1);
    for (let i = 0; i < 600; i++) {
      rig.update({ x: 0, z: 0, groundY: 0, gaze: { x: 0, z: -50 }, dt: 1 / 60 });
    }
    const pose = createSpiritPose();
    rig.pose(pose);
    // Overhead rig: much higher, much nearer than shoulder... but the heading
    // also eased around. Just pin the rig HEIGHT band (overhead 24 vs shoulder 11).
    expect(pose.pos.y).toBeGreaterThan(20);
    const rigAlt = mk();
    rigAlt.snap(0, 0, 0, 1);
    rigAlt.update({ x: 0, z: 0, groundY: 0, altitude: 100, gaze: null, dt: 1 / 60 });
    const poseAlt = createSpiritPose();
    rigAlt.pose(poseAlt);
    expect(poseAlt.pos.y).toBeGreaterThan(100);
  });
});
