/**
 * ground-glide.ts — the spirit's GROUND body: a non-physical point that
 * moves along the ground EXACTLY like the avatar walker steers (same turn
 * law, same arrive behaviour), but faster, and through anything — no walls,
 * no slope gates, no water refusal. Pure chart-local math; the ladder lifts
 * it through a chart and drives the chase rig from it.
 *
 * Laws, kin to the real walker's but NOT identical — the spirit is a ghost, and
 * a ghost that outruns its own turning circle reads as broken:
 *   • turn: max(comfort law, the authority needed to curve onto the aim) —
 *     min(comfort.maxYawSpeed, camera.yawDistGain / max(d, yawDistMin)) floored
 *     by speed/d × TURN_AUTHORITY, so a far gaze can't outrun the yaw cap;
 *   • move: speed is a FUNCTION OF DISTANCE — a WALKER PLUS A FAR-RANGE BOOST:
 *     max(the avatar's proportional law, maxSpeed × (dStop/FULL_SPEED_D)^2),
 *     capped by the engine's arrive term √(2·a·dStop) so it always brakes to
 *     rest by the aim and stops inside aimDeadRadius. Fast only when the gaze is
 *     far, walker-paced through the middle distance, proportional at the aim.
 */
import {
  DEFAULT_CAMERA_TUNABLES, DEFAULT_COMFORT_TUNABLES,
} from "../world-tunables.js";

/** Glide speed = the walker's steerMaxSpeed × this. */
export const GROUND_SPEED_MULT = 2.5;
/** The walker's engine constants (engine.ts WorldEngineConfig defaults). */
const WALKER_MAX_SPEED = 5;
const WALKER_ACCEL = 18;
const WALKER_APPROACH_GAIN = 2;
const AIM_DEAD_RADIUS = 0.8;
/** Distance (m) at which the glide runs FLAT OUT. Set below the ladder's
 *  GROUND_AIM_MAX (30) so the top of the gaze range actually saturates. */
export const GROUND_FULL_SPEED_D = 22;
/** Speed curve exponent over `dStop / GROUND_FULL_SPEED_D`. >1 on purpose: the
 *  spirit should be FAST only for a genuinely far gaze and noticeably slower at
 *  middle distance, where a linear ramp still feels like a runaway barge.
 *  At 2: half the range → a QUARTER of the speed. */
export const GROUND_SPEED_CURVE = 2;
/** Turn authority: the glide's yaw cap is raised, if needed, to `speed/d × this`
 *  — i.e. a turning radius of at most `d / TURN_AUTHORITY`, so it can always
 *  curve ONTO the aim. Without it the 1/d comfort yaw law (yawDistGain/d) caps
 *  turning at ~0.18 rad/s for a 22 m gaze while the speed law holds 12.5 m/s:
 *  radius = v/ω ≈ 69 m ≫ 22 m, so the glide sails past the aim and circles it —
 *  the "moves too fast and sometimes ends up going BACKWARDS" bug. */
const TURN_AUTHORITY = 2;

export interface GroundGlide {
  x: number;
  z: number;
  /** Unit heading (chart-local). */
  readonly fx: number;
  readonly fz: number;
  /** Steer + advance toward a chart-local aim (null = coast to rest). */
  update(aim: { x: number; z: number } | null, dt: number): void;
  /** FOLLOW a real body — the spark claimed a creature, so the glide stops
   *  being a walker and just rides along. The steering laws above are SKIPPED
   *  entirely: a claimed creature walks on its own legs (the host steers it),
   *  and a fake body racing the real one to the same aim would only fight it.
   *  Speed is measured from the step so a release resumes the glide at the pace
   *  the body was actually moving rather than snapping to rest. */
  follow(x: number, z: number, fx: number, fz: number, dt: number): void;
  /** Re-zero onto a new chart (re-anchor): keep the world heading by passing
   *  it re-expressed in the new chart's basis. */
  reset(x: number, z: number, fx: number, fz: number): void;
  readonly speed: number;
}

export function createGroundGlide(x0: number, z0: number, fx0 = 0, fz0 = 1): GroundGlide {
  let x = x0;
  let z = z0;
  let fx = fx0;
  let fz = fz0;
  let speed = 0;
  const norm = (): void => {
    const l = Math.hypot(fx, fz);
    if (l > 1e-6) { fx /= l; fz /= l; } else { fx = 0; fz = 1; }
  };
  norm();

  const cam = DEFAULT_CAMERA_TUNABLES;
  const comfort = DEFAULT_COMFORT_TUNABLES;
  const maxSpeed = WALKER_MAX_SPEED * GROUND_SPEED_MULT;
  const accel = WALKER_ACCEL * GROUND_SPEED_MULT;

  return {
    get x() { return x; },
    set x(v) { x = v; },
    get z() { return z; },
    set z(v) { z = v; },
    get fx() { return fx; },
    get fz() { return fz; },
    get speed() { return speed; },

    reset(nx, nz, nfx, nfz) {
      x = nx;
      z = nz;
      fx = nfx;
      fz = nfz;
      norm();
      speed = 0;
    },

    follow(nx, nz, nfx, nfz, dt) {
      // Measured, then CAPPED at the glide's own top speed: a re-anchor or a
      // teleport moves the body an arbitrary distance in one frame, and an
      // unbounded reading would hand a nonsense speed to the turn-authority law
      // on the first frame after release.
      speed = Math.min(maxSpeed, Math.hypot(nx - x, nz - z) / Math.max(1e-6, dt));
      x = nx;
      z = nz;
      fx = nfx;
      fz = nfz;
      norm();
    },

    update(aim, dt) {
      const step = Math.max(0, dt);
      if (!aim) {
        speed = Math.max(0, speed - accel * step);
      } else {
        const dx = aim.x - x;
        const dz = aim.z - z;
        const d = Math.hypot(dx, dz);
        const dStop = d - AIM_DEAD_RADIUS;
        if (dStop <= 0) {
          speed = Math.max(0, speed - accel * step);
        } else {
          // Turn toward the aim — the avatar's comfort yaw law, FLOORED by the
          // authority needed to curve onto the aim at the current speed.
          const tgt = Math.atan2(dx, dz);
          const cur = Math.atan2(fx, fz);
          let delta = Math.atan2(Math.sin(tgt - cur), Math.cos(tgt - cur));
          const comfortMax = Math.min(comfort.maxYawSpeed, cam.yawDistGain / Math.max(d, cam.yawDistMin));
          const need = (speed / Math.max(d, 1e-3)) * TURN_AUTHORITY;
          const effMax = Math.max(comfortMax, need);
          const maxStep = effMax * step;
          if (delta > maxStep) delta = maxStep;
          else if (delta < -maxStep) delta = -maxStep;
          const next = cur + delta;
          fx = Math.sin(next);
          fz = Math.cos(next);
          // Speed is a function of DISTANCE: the glide is A WALKER PLUS A
          // FAR-RANGE BOOST — the greater of
          //   • the avatar's own proportional law (gain × dStop, capped at the
          //     walker's max), which owns the near field and eases onto the aim
          //     exactly like a creature does — the spirit is never SLOWER than
          //     something with legs; and
          //   • a >1 power curve over the full range, which only overtakes the
          //     walker past ~14 m and reaches full tilt at GROUND_FULL_SPEED_D.
          // So: fast only when the gaze is far, walker-paced through the middle
          // distance, proportional (and stopping) at the aim.
          //
          // The curve ALONE cannot own the near field: (dStop/22)^2 is ~0.08 m/s
          // two metres out, so the glide crawls at the aim forever instead of
          // arriving. The arrive term (√(2·a·dStop)) stays as a hard cap so the
          // glide can always brake to rest by the aim.
          const u = Math.min(1, dStop / GROUND_FULL_SPEED_D);
          const walker = Math.min(WALKER_MAX_SPEED, WALKER_APPROACH_GAIN * dStop);
          const far = maxSpeed * Math.pow(u, GROUND_SPEED_CURVE);
          const desired = Math.min(
            Math.max(walker, far),
            Math.sqrt(2 * accel * dStop),
          );
          const dv = desired - speed;
          const cap = accel * step;
          speed += Math.max(-cap, Math.min(cap, dv));
        }
      }
      if (speed > 1e-4) {
        x += fx * speed * step;
        z += fz * speed * step;
      }
    },
  };
}
