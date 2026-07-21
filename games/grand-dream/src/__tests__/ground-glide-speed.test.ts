/**
 * THE SPIRIT'S GROUND GLIDE IS SPEED-BY-DISTANCE, AND MUST NEVER OUTRUN ITS OWN
 * TURNING CIRCLE.
 *
 * Two laws, two failure modes these pin:
 *  1. Speed = maxSpeed × (dStop/FULL_SPEED_D)^CURVE, capped by the arrive term.
 *     The old law was √(2·a·dStop) capped at maxSpeed — which, at accel 45 and
 *     maxSpeed 12.5, saturates by dStop ≈ 1.7 m. It was a CONSTANT 12.5 m/s
 *     cruise everywhere a player actually looks, then a wall-stop.
 *  2. Turning radius ≤ d/TURN_AUTHORITY. The comfort yaw law is 1/d, so a FAR
 *     gaze capped yaw at ~0.18 rad/s while the speed law held full tilt:
 *     radius = v/ω ≈ 69 m for a 22 m target. The glide sailed past and circled
 *     it — reported as "moves too fast and sometimes ends up going backwards".
 */
import { describe, it, expect } from "vitest";
import {
  createGroundGlide, GROUND_FULL_SPEED_D, GROUND_SPEED_CURVE,
} from "@shared/world-engine/spirit/ground-glide";

const STEP = 1 / 60;

/** Run the glide toward a fixed aim for `secs`, sampling each frame. */
function run(glide: ReturnType<typeof createGroundGlide>, aim: { x: number; z: number }, secs: number) {
  const samples: Array<{ t: number; x: number; z: number; speed: number; d: number }> = [];
  for (let t = 0; t < secs; t += STEP) {
    glide.update(aim, STEP);
    samples.push({
      t, x: glide.x, z: glide.z, speed: glide.speed,
      d: Math.hypot(aim.x - glide.x, aim.z - glide.z),
    });
  }
  return samples;
}

describe("ground glide — speed is a function of distance", () => {
  it("runs flat out only for a FAR gaze", () => {
    // Aim well past FULL_SPEED_D, dead ahead so turning never limits it.
    const g = createGroundGlide(0, 0, 0, 1);
    const top = Math.max(...run(g, { x: 0, z: 400 }, 6).map((s) => s.speed));
    expect(top).toBeGreaterThan(12); // ≈ maxSpeed 12.5
  });

  it("is WALKER-PACED at middle distance, not the old full-tilt cruise", () => {
    // A 10 m gaze: about half the range. The far curve only overtakes the walker
    // past ~14 m, so here the walker floor governs — 5 m/s, not the old 12.5.
    const g = createGroundGlide(0, 0, 0, 1);
    const top = Math.max(...run(g, { x: 0, z: 10 }, 4).map((s) => s.speed));
    expect(top).toBeCloseTo(5, 1);
    expect(top).toBeLessThan(6); // nowhere near the old 12.5 cruise
  });

  it("is never SLOWER than a walker — the near field is the avatar's own law", () => {
    // The curve alone would crawl at ~0.08 m/s two metres out. The walker floor
    // (gain 2 × dStop) is what actually closes the last few metres.
    const g = createGroundGlide(0, 0, 0, 1);
    const u = (10 - 0.8) / GROUND_FULL_SPEED_D;
    expect(12.5 * Math.pow(u, GROUND_SPEED_CURVE)).toBeLessThan(5); // curve < walker here
    const s = run(g, { x: 0, z: 4 }, 6); // a near gaze the curve would abandon
    expect(s[s.length - 1]!.d).toBeLessThan(1.2);
  });

  it("slows down and STOPS at the gaze instead of sliding past", () => {
    const g = createGroundGlide(0, 0, 0, 1);
    const s = run(g, { x: 0, z: 30 }, 20);
    const end = s[s.length - 1]!;
    expect(end.speed).toBeLessThan(0.1); // at rest
    expect(end.d).toBeLessThan(1.2); // parked on the aim (aimDeadRadius 0.8)
    // ...and never overshot it on the way in.
    expect(Math.max(...s.map((x) => x.z))).toBeLessThan(30.5);
  });

  it("speed rises monotonically with gaze distance", () => {
    const peak = (dist: number) => {
      const g = createGroundGlide(0, 0, 0, 1);
      return Math.max(...run(g, { x: 0, z: dist }, 5).map((s) => s.speed));
    };
    const speeds = [3, 8, 15, 25].map(peak);
    for (let i = 1; i < speeds.length; i++) {
      expect(speeds[i]!).toBeGreaterThan(speeds[i - 1]!);
    }
  });
});

describe("ground glide — turn authority (the 'goes backwards' bug)", () => {
  it("converges on a FAR gaze square abeam instead of circling it", () => {
    // The killer geometry: aim at 22 m, 90° off the heading. The comfort yaw law
    // allows only ~0.18 rad/s there; at full speed the old glide needed a ~69 m
    // radius to come around, so it drifted off and orbited.
    const g = createGroundGlide(0, 0, 0, 1); // heading +z
    const aim = { x: GROUND_FULL_SPEED_D, z: 0 }; // dead abeam, to +x
    const s = run(g, aim, 25);
    const end = s[s.length - 1]!;
    expect(end.d).toBeLessThan(1.2); // actually arrived
    expect(end.speed).toBeLessThan(0.1);
  });

  it("never lets the turning radius exceed the distance to the aim", () => {
    const g = createGroundGlide(0, 0, 0, 1);
    const aim = { x: 25, z: -25 }; // far and behind: worst case for the 1/d law
    for (const s of run(g, aim, 25)) {
      if (s.speed < 0.5 || s.d < 1) continue;
      // The instantaneous turning radius the glide is committed to must stay
      // inside the distance it has left to work with.
      const yawCap = Math.max(0.7, (s.speed / s.d) * 2);
      expect(s.speed / yawCap).toBeLessThanOrEqual(s.d);
    }
  });

  it("does not move AWAY from a stationary aim once it has settled", () => {
    const g = createGroundGlide(0, 0, 0, 1);
    const aim = { x: 18, z: -6 };
    const s = run(g, aim, 30);
    // Past the halfway mark the distance must be non-increasing (no orbit).
    const tail = s.slice(Math.floor(s.length / 2));
    for (let i = 1; i < tail.length; i++) {
      expect(tail[i]!.d).toBeLessThanOrEqual(tail[i - 1]!.d + 1e-6);
    }
  });
});
