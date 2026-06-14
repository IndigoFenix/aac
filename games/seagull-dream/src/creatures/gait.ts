// Procedural walk/run gaits — see instructions/creatures.md "Animation".
//
// PURE MATH. No three.js — node-testable, server-importable, like the rest
// of the creature core.
//
// The gait does NOT re-pose limbs itself. It produces, per supporting leg,
// a foot-target OFFSET (slide the planted foot back, lift and swing it
// forward) plus a small body bob; skeleton.ts feeds those into the SAME
// 2-bone IK that builds the grounded rest pose. So the strain solve still
// decides which limbs bear weight and where they plant — the gait only
// cycles the bearing feet through stance and swing. The rest pose is just
// this gait at zero stride.
//
// Coordinates match skeleton.ts: +Z forward (the creature's facing), +Y up.
// A leg's phase comes from its place on the body (which row, which side),
// so any leg count produces a coordinated pattern without per-creature
// authoring — the same idea as one limb-row sharing one gait.

/** How foot phases distribute across the legs. */
export type GaitPattern =
  | "trot" // diagonal pairs together — the default quadruped
  | "pace" // same-side legs together (camel/giraffe roll)
  | "bound" // front pair vs rear pair (rabbit/galloper)
  | "wave"; // metachronal wave down the body (insects → tripod, centipedes)

export const GAIT_PATTERNS: readonly GaitPattern[] = ["trot", "pace", "bound", "wave"];

export interface GaitParams {
  /** Global cycle phase, 0..1 — advance this with time to animate. */
  phase: number;
  /** Stride length as a fraction of leg length (fore-aft foot travel). */
  strideFrac: number;
  /** Swing-foot lift as a fraction of leg length. */
  stepHeight: number;
  /** Fraction of the cycle a foot stays planted. > 0.5 = walk (always a
   *  foot down), < 0.5 = run (flight phases). */
  dutyFactor: number;
  /** How the per-leg phases are arranged across the body. */
  pattern: GaitPattern;
}

export const DEFAULT_GAIT: GaitParams = {
  phase: 0,
  strideFrac: 0.5,
  stepHeight: 0.22,
  dutyFactor: 0.6,
  pattern: "trot",
};

/** A leg's identity on the body — all the gait needs to phase it. */
export interface LegId {
  /** 0 front .. 1 rear along the body (the leg's station). */
  stationFrac: number;
  /** +1 right, -1 left (skeleton's sideSign). */
  side: 1 | -1;
}

const frac = (x: number): number => x - Math.floor(x);

/** Phase offset [0,1) for one leg under a pattern. Diagonal/lateral/etc.
 *  fall out of (which side, how far back) — no per-creature tables. */
export function legPhaseOffset(id: LegId, pattern: GaitPattern): number {
  const right = id.side > 0 ? 1 : 0;
  const rear = id.stationFrac >= 0.5 ? 1 : 0;
  switch (pattern) {
    case "pace":
      // Same-side legs swing together (the two left legs vs the two right).
      return right * 0.5;
    case "bound":
      // Front pair vs rear pair (a galloping rabbit).
      return rear * 0.5;
    case "wave":
      // A metachronal wave travelling rear → front, left/right in
      // antiphase — gives a centipede its ripple and a hexapod its
      // alternating tripod.
      return frac((1 - id.stationFrac) * 0.5 + right * 0.5);
    case "trot":
    default:
      // Diagonal legs share a phase (front-left with rear-right): the
      // stable, symmetric quadruped trot.
      return ((rear + right) % 2) * 0.5;
  }
}

/** One leg's foot state at the current global phase. `advance` is fore-aft
 *  in [-0.5, 0.5] (×stride), `lift` is 0..1 (×stepHeight); both are zero at
 *  the stance↔swing seam so the foot never jumps. */
export interface FootCycle {
  advance: number;
  lift: number;
  planted: boolean;
}

export function footCycle(phaseOffset: number, p: GaitParams): FootCycle {
  const u = frac(p.phase + phaseOffset);
  const duty = Math.max(0.05, Math.min(0.95, p.dutyFactor));
  if (u < duty) {
    // STANCE — planted, sliding from front (+0.5) to back (-0.5) on the
    // ground (the body advancing over a fixed foot, treadmill-style).
    const s = u / duty;
    return { advance: 0.5 - s, lift: 0, planted: true };
  }
  // SWING — lifts in a half-sine arc and carries from back to front.
  const s = (u - duty) / (1 - duty);
  return { advance: -0.5 + s, lift: Math.sin(Math.PI * s), planted: false };
}

/** Whole-body bob: a vertical lilt as the legs push, biggest for few-legged
 *  creatures (a biped lurches; a centipede glides). `dy` is a fraction of
 *  torso length. Returned separately so the caller scales it. */
export interface BodyBob {
  dy: number;
}

export function bodyBob(p: GaitParams, legCount: number): BodyBob {
  // Two pushes per cycle (left then right), amplitude falling off with more
  // legs sharing the support.
  const amp = 0.03 / Math.max(1, legCount * 0.5);
  return { dy: amp * (0.5 - 0.5 * Math.cos(p.phase * Math.PI * 4)) };
}
