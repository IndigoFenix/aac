// shared/world-engine/gaze-intent.ts
//
// The gaze INTENT interpreter: the layer between the raw pointer/gaze pixel and
// the engine's single `aim` input. It exists because, under eye-gaze, the eyes are
// BOTH the controller and the camera — so steering directly from the raw gaze
// pixel feeds a spin/lurch feedback loop (see planning-docs/eyegaze-3d-movement.md).
//
// It does three things, all pure (no DOM, no GL — unit-tested headless):
//   1. Fixation gate (velocity / I-VT style): a fast flick (saccade) HOLDS the
//      committed aim instead of chasing it; slow motion (smooth pursuit / a mouse
//      drag) tracks live. Classified in SCREEN px, because gaze noise is constant
//      in pixels but maps to wildly different world distances with camera pitch —
//      so we classify on the pixel and only call screenToWorld AFTER a point holds.
//   2. Weakening: while unsettled (mid-flick), the aim eases back toward the avatar
//      so it gently slows rather than darting to wherever the eyes flicked.
//   3. Auto-sit: after a stretch with no travel intent, latch WATCH/sitting (the
//      avatar parks; the camera settles). Any committed far gaze resumes moving.
//
// The engine is untouched: it still consumes one `aim: Vec2 | null`. All the new
// behaviour lives here and is fed in by the host's per-frame loop.

import type { Vec2 } from "./types.js";
import { DEFAULT_GAZE_TUNABLES, type GazeTunables } from "./world-tunables.js";

/** What the interpreter produces each frame. `aim` is what the engine consumes;
 *  the rest are for the camera director + debug overlay. */
export interface GazeIntent {
  /** Weakened, settled world aim — or null to coast to a stop (pointer absent, off
   *  the ground, or sitting). Fed straight into tickWorld. */
  aim: Vec2 | null;
  /** WATCH mode is latched: the avatar parks and the camera settles to overhead. */
  sitting: boolean;
  /** Avatar → committed aim (world units). 0 when there's no aim. Diagnostic +
   *  the camera director reads it for the turn-rate / mode rules. */
  gazeDistance: number;
  /** 0 settled … 1 mid-saccade. Diagnostic (the weakening factor actually applied
   *  is unsettled × weakenStrength). */
  unsettled: number;
  /** The settled gaze's UNWEAKENED ground point (before the avatar-ward pull), or
   *  null when off-ground / absent. The host picks INTERACT targets against this. */
  committedWorld: Vec2 | null;
}

/** Probe + context the interpreter needs each frame, supplied by the host (which
 *  owns the view's camera-dependent mapping and the world state). */
export interface GazeUpdate {
  /** Latest pointer/gaze pixel (canvas-relative CSS px), or null if off-surface. */
  pointer: { x: number; y: number } | null;
  /** Map a pixel to a world ground point (the view's camera ray), or null. */
  screenToWorld: (px: number, py: number) => Vec2 | null;
  /** The local avatar's world position, or null before it exists. */
  avatar: Vec2 | null;
  /** Frame delta (seconds). */
  dt: number;
  /** Monotonic clock (ms). */
  nowMs: number;
}

export interface GazeInterpreter {
  update(u: GazeUpdate): GazeIntent;
  setTunables(t: GazeTunables): void;
  /** Reset transient state (e.g. on a teleport or respawn). */
  reset(): void;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Exponential-smoothing blend factor for a given rate (1/sec) over `dt` sec. */
const easeRate = (rate: number, dt: number): number =>
  dt > 0 && rate > 0 ? 1 - Math.exp(-rate * dt) : 0;

export function createGazeInterpreter(initial: GazeTunables = DEFAULT_GAZE_TUNABLES): GazeInterpreter {
  let cfg = initial;

  // Screen-space fixation state.
  let prev: { x: number; y: number } | null = null; // last raw pixel (for velocity)
  let committed: { x: number; y: number } | null = null; // the settled aim pixel
  let unsettled = 1; // 0 settled … 1 mid-saccade
  let sinceSlowMs = 0; // time since pointer speed dropped below the saccade gate

  // Sitting latch.
  let lastActiveMs = 0; // last time the player showed travel intent
  let sitting = false;
  let seededClock = false;

  const reset = (): void => {
    prev = null;
    committed = null;
    unsettled = 1;
    sinceSlowMs = 0;
    sitting = false;
    seededClock = false;
  };

  const update = (u: GazeUpdate): GazeIntent => {
    const { pointer, screenToWorld, avatar, dt, nowMs } = u;
    if (!seededClock) {
      lastActiveMs = nowMs;
      seededClock = true;
    }

    if (!pointer) {
      // Gaze left the surface: hard-coast (aim null), let unsettled drift up, and
      // accrue idle toward auto-sit. Keep `committed` so a quick return resumes.
      prev = null;
      unsettled = lerp(unsettled, 1, easeRate(cfg.unsettleEase, dt));
      const idleSit = nowMs - lastActiveMs >= cfg.idleSitMs;
      if (idleSit) sitting = true;
      return { aim: null, sitting, gazeDistance: 0, unsettled, committedWorld: null };
    }

    // --- Velocity gate (I-VT): is this a fast flick or settled/pursuit? ---------
    let speed = 0;
    if (prev) speed = Math.hypot(pointer.x - prev.x, pointer.y - prev.y) / Math.max(dt, 1e-3);
    prev = { x: pointer.x, y: pointer.y };
    if (committed === null) committed = { x: pointer.x, y: pointer.y };

    const saccading = speed > cfg.saccadeSpeedPx;
    if (saccading) sinceSlowMs = 0;
    else sinceSlowMs += dt * 1000;
    const settled = !saccading && sinceSlowMs >= cfg.settleMs;

    if (settled) {
      // Track the live point (fast ease ⇒ responsive); fully settled.
      const k = easeRate(cfg.commitEase, dt);
      committed.x = lerp(committed.x, pointer.x, k);
      committed.y = lerp(committed.y, pointer.y, k);
      unsettled = lerp(unsettled, 0, easeRate(cfg.unsettleEase, dt));
    } else {
      // Mid-flick / settling: HOLD the committed pixel, raise unsettled.
      unsettled = lerp(unsettled, 1, easeRate(cfg.unsettleEase, dt));
    }

    // --- Map the committed pixel to the world (AFTER the screen-space gate) ------
    const world = screenToWorld(committed.x, committed.y);
    if (!world) {
      // Committed point isn't on the ground (e.g. above the 3D horizon): coast.
      const idleSit = nowMs - lastActiveMs >= cfg.idleSitMs;
      if (idleSit) sitting = true;
      return { aim: null, sitting, gazeDistance: 0, unsettled, committedWorld: null };
    }

    // Distance gates speed AND turn rate downstream; compute before weakening so it
    // reflects where the eyes actually rest.
    const gazeDistance = avatar ? Math.hypot(world.x - avatar.x, world.y - avatar.y) : 0;

    // --- Weakening: ease the aim toward the avatar by unsettled×weakenStrength ---
    let aim: Vec2 = world;
    if (avatar && unsettled > 1e-3 && cfg.weakenStrength > 0) {
      const w = Math.min(1, unsettled * cfg.weakenStrength);
      aim = { x: lerp(world.x, avatar.x, w), y: lerp(world.y, avatar.y, w) };
    }

    // --- Sitting latch ----------------------------------------------------------
    // "Active" = a settled gaze placed out beyond the sit radius (a real travel
    // command). That resets the idle timer and breaks a sit; otherwise, after
    // idleSitMs of only-near / unsettled gaze, latch sitting.
    const traveling = settled && gazeDistance > cfg.sitGazeRadius;
    if (traveling) {
      lastActiveMs = nowMs;
      sitting = false;
    } else if (nowMs - lastActiveMs >= cfg.idleSitMs) {
      sitting = true;
    }

    // While sitting, the avatar idles (aim null) until the player issues a fresh
    // far gaze — which flips `traveling` true above on the SAME frame, so the null
    // only holds during genuine rest.
    if (sitting) return { aim: null, sitting, gazeDistance, unsettled, committedWorld: world };

    return { aim, sitting, gazeDistance, unsettled, committedWorld: world };
  };

  return {
    update,
    setTunables(t) {
      cfg = t;
    },
    reset,
  };
}
