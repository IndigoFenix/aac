/**
 * chase-rig.ts — the AVATAR'S chase-camera laws as a PURE module.
 *
 * A faithful port of render3d.ts's walker camera (updateCamera non-spirit
 * branch + placeCamera), driven by the SAME tunables objects
 * (DEFAULT_CAMERA_TUNABLES / DEFAULT_COMFORT_TUNABLES) so anything steered
 * by this rig turns, eases and frames EXACTLY like the walking avatar —
 * the spirit GROUND GLIDE's requirement ("controls exactly like the
 * avatar"). render3d keeps its own copy untouched (the AAC product path);
 * this module exists for hosts that have no World3DRenderer at all (the
 * flight scene's wilderness glide).
 *
 * Everything is CHART-LOCAL 2D (x = east, z = north, y = up at the chart
 * origin); the caller lifts the emitted pose through its chart/anchor into
 * world space.
 */
import type { CameraRigPose, CameraTunables, ComfortTunables } from "../world-tunables.js";
import type { SpiritPose } from "./pose.js";

export interface ChaseRigInput {
  /** Followed body, chart metres. */
  x: number;
  z: number;
  /** Ground height at the followed body (the rig rides the terrain). */
  groundY: number;
  /** Extra height channel (flight altitude; 0 on the ground). */
  altitude?: number;
  /** Gaze fixation on the chart (null = no gaze — heading holds). */
  gaze: { x: number; z: number } | null;
  /** Face-this-point override (conversation) — beats the gaze. */
  faceTarget?: { x: number; z: number } | null;
  /** Explicit shoulder request (speech bubble) — always wins. */
  shoulder?: boolean;
  dt: number;
}

export interface ChaseRig {
  /** Advance the rig state one frame. */
  update(input: ChaseRigInput): void;
  /** Fill `out` with the CHART-LOCAL pose (pos/look/up/fov). */
  pose(out: SpiritPose): void;
  /** Snap the rig onto a body (fresh grab — no easing from stale state). */
  snap(x: number, z: number, fx: number, fz: number): void;
  /** |yaw| applied last frame (rad/s) — the comfort vignette's input. */
  readonly lastYawSpeed: number;
  /** The eased chart-local camera forward (unit 2D). */
  readonly forward: { x: number; z: number };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function createChaseRig(cam: CameraTunables, comfort: ComfortTunables): ChaseRig {
  let cx = 0;
  let cz = 0;
  let haveCenter = false;
  let fx = 0;
  let fz = 1;
  let travelTarget = 1;
  let travelCommit = 1;
  let lastYawSpeed = 0;
  let groundY = 0;
  let altitude = 0;
  const rig: CameraRigPose = { ...cam.shoulder };

  return {
    get lastYawSpeed() { return lastYawSpeed; },
    get forward() { return { x: fx, z: fz }; },

    snap(x, z, nfx, nfz) {
      cx = x;
      cz = z;
      haveCenter = true;
      const l = Math.hypot(nfx, nfz);
      if (l > 1e-3) { fx = nfx / l; fz = nfz / l; }
    },

    update(input) {
      const step = Math.max(0, input.dt);
      groundY = input.groundY;
      altitude = input.altitude ?? 0;

      // Position: ease the followed centre toward the body.
      if (!haveCenter) {
        cx = input.x;
        cz = input.z;
        haveCenter = true;
      } else {
        const k = 1 - Math.exp(-cam.follow * step);
        cx += (input.x - cx) * k;
        cz += (input.z - cz) * k;
      }

      // Travel direction + gaze distance from the aim.
      let gazeDistance = 0;
      let aimx = 0;
      let aimz = 0;
      let haveDir = false;
      if (input.gaze) {
        const dx = input.gaze.x - input.x;
        const dz = input.gaze.z - input.z;
        gazeDistance = Math.hypot(dx, dz);
        if (gazeDistance > 1e-3) {
          aimx = dx / gazeDistance;
          aimz = dz / gazeDistance;
          haveDir = true;
        }
      }
      const ahead = haveDir ? aimx * fx + aimz * fz : -1;

      // Heading: ease toward the gaze direction — the avatar's yaw law
      // (yawStiffness ease, capped by the gaze-distance rule AND the
      // comfort ceiling; deadband kills glance wobble). faceTarget wins.
      const faceTarget = input.faceTarget ?? null;
      let tgtAngle: number | null = null;
      let facing = false;
      if (faceTarget) {
        const dx = faceTarget.x - cx;
        const dz = faceTarget.z - cz;
        if (Math.hypot(dx, dz) > 1e-3) { tgtAngle = Math.atan2(dx, dz); facing = true; }
      } else if (haveDir && gazeDistance > cam.moveThreshold) {
        tgtAngle = Math.atan2(aimx, aimz);
      }
      let appliedYaw = 0;
      if (tgtAngle !== null) {
        const cur = Math.atan2(fx, fz);
        let delta = Math.atan2(Math.sin(tgtAngle - cur), Math.cos(tgtAngle - cur));
        if (Math.abs(delta) < comfort.yawDeadband) delta = 0;
        let stepAngle = delta * (1 - Math.exp(-cam.yawStiffness * step));
        const effMax = facing
          ? comfort.maxYawSpeed
          : Math.min(comfort.maxYawSpeed, cam.yawDistGain / Math.max(gazeDistance, cam.yawDistMin));
        const maxStep = effMax * step;
        if (stepAngle > maxStep) stepAngle = maxStep;
        else if (stepAngle < -maxStep) stepAngle = -maxStep;
        const next = cur + stepAngle;
        fx = Math.sin(next);
        fz = Math.cos(next);
        appliedYaw = stepAngle;
      }
      lastYawSpeed = step > 0 ? Math.abs(appliedYaw) / step : 0;

      // Overhead ↔ shoulder: shoulder is the default; only a clearly-behind
      // gaze lifts to overhead (hysteresis band holds in between).
      const gazeBehind = haveDir && ahead < cam.travelAheadExit;
      const gazeAhead = !haveDir || ahead > cam.travelAheadEnter;
      if (input.shoulder || gazeAhead) travelTarget = 1;
      else if (gazeBehind) travelTarget = 0;
      travelCommit += (travelTarget - travelCommit) * (1 - Math.exp(-cam.travelEase * step));

      const t = travelCommit;
      const o = cam.overhead;
      const s = cam.shoulder;
      rig.height = lerp(o.height, s.height, t);
      rig.back = lerp(o.back, s.back, t);
      rig.lookAhead = lerp(o.lookAhead, s.lookAhead, t);
      rig.lookHeight = lerp(o.lookHeight, s.lookHeight, t);
      rig.fov = lerp(o.fov, s.fov, t);
    },

    pose(out) {
      // placeCamera's formula, chart-local: behind the followed point along
      // the smoothed heading, riding the terrain (+ the altitude channel).
      const gy = groundY + altitude;
      out.pos.set(cx - fx * rig.back, gy + rig.height, cz - fz * rig.back);
      out.look.set(cx + fx * rig.lookAhead, gy + rig.lookHeight, cz + fz * rig.lookAhead);
      out.up.set(0, 1, 0);
      out.fov = rig.fov;
    },
  };
}
