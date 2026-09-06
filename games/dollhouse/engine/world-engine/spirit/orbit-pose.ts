/**
 * 🎥 THE HELD ORBIT'S POSE — one tunable record (user ruling C1, 2026-09-06).
 *
 * THE PROBLEM IT SOLVES. *"I want to do some tests to see what angle and
 * distance actually look good."* (user, 2026-09-05). The district orbit's
 * framing was four numbers spelled inline in `spirit/ladder.ts` — a pitch, a
 * frame factor, a look-at lift and an implicit ring-to-frame ratio of 1 — so
 * "try a different angle" meant editing the engine and rebuilding the lab. The
 * numbers are a DESIGN value the user picks by eye; the code's job is to make
 * them one record, let a debug panel move them live, and then bake whatever the
 * eye chose as the defaults. No painted guess ships as "the answer".
 *
 * ⚖️ THE DEFAULTS ARE TODAY'S VALUES, EXACTLY. With no override stored, every
 * expression in the ladder evaluates on the same literals it always did — the
 * `builder-hold` / `orbit-ring-frame` byte-identity pins are what says so.
 *
 * WHERE THIS LIVES AND WHY — deliberately the SHAPE of `lag-comp.ts`: one
 * module the engine imports (so every world-engine game inherits the setting
 * with zero per-game wiring) plus `localStorage` persistence. All games are
 * served from one origin under `/games/<id>/`, so a single key IS a cross-game
 * global. Every storage access is guarded: `localStorage` does not exist in
 * node (jest, text mode) or a worker, where this reads the DEFAULTS — which is
 * the reason the headless transcripts are untouched by this seam.
 *
 * Console ergonomics, matching `__lagComp` / `__perfProbes`:
 *   globalThis.__orbitPose = { pitchRad: 0.7 }   // this tab only, not persisted
 *   globalThis.__orbitPose = undefined           // back to the stored/default pose
 */

/** THE FOUR NUMBERS THAT MAKE THE HELD DISTRICT ORBIT.
 *
 *  The ladder poses the camera from a FRAME RADIUS `r` (under the builder hold
 *  that is the sim's relevance disc — the ring the lab draws — scaled by
 *  `ringFrameFactor`; off the hold it is the district the gaze picked):
 *
 *    dist = r / tan(fov/2) × frameFactor
 *    camera = focus + up·(dist·sin(pitchRad)) − horizontal·(dist·cos(pitchRad))
 *    look-at = focus + up·(r × liftFrac)
 *
 *  So `frameFactor` is HOW FAR (1 = the frame exactly fills the vertical fov),
 *  `pitchRad` is HOW HIGH the same distance is spent (0 = level with the
 *  ground, π/2 = straight down — it moves the camera along an arc and never
 *  changes its distance to a body at the focus), `liftFrac` tilts the shot by
 *  raising what it looks AT, and `ringFrameFactor` says how much bigger than
 *  the relevance ring the frame is (1 = the ring is exactly the outer bound,
 *  which is the 2026-09-05 ruling: *"the circle should really be close to the
 *  outer camera bounds, since that's the point of it"*). */
export interface OrbitPose {
  /** Radians above the horizon the camera stands, seen from the focus. */
  pitchRad: number;
  /** Stand-off multiplier on the frame's own fov-fitting distance. */
  frameFactor: number;
  /** Look-at height above the focus, as a fraction of the frame radius. */
  liftFrac: number;
  /** Frame radius ÷ the relevance ring's radius (builder hold only). */
  ringFrameFactor: number;
}

/** ⚖️ TODAY'S SHIPPED POSE. `pitchRad`/`frameFactor`/`liftFrac` are the former
 *  `CITY_PITCH` / `CITY_FRAME` / the `t.radius * 0.35` look-at lift, verbatim;
 *  `ringFrameFactor` is the 1 the disc read was multiplying by implicitly.
 *  When the user's GL tests pick a pose, THESE are the four lines to change —
 *  the panel's "print constants" button emits exactly this block. */
export const ORBIT_POSE_DEFAULTS: Readonly<OrbitPose> = {
  pitchRad: 0.5,
  frameFactor: 1.35,
  liftFrac: 0.35,
  ringFrameFactor: 1,
};

/** The persisted key. One origin serves every `/games/<id>/`, so this is global
 *  across the world-engine games by construction. */
export const ORBIT_POSE_STORAGE_KEY = "world-engine-orbit-pose";

type OrbitGlobal = { __orbitPose?: Partial<OrbitPose> };

/** Persisted value, read once and then cached (the getter runs every frame,
 *  twice — `stepTown` and `stepStructure` both pose from it). */
let stored: Partial<OrbitPose> | null | undefined;

/** Only the four known keys, only finite numbers: a hand-edited storage value
 *  (or a console typo) must never be able to NaN the camera out of the world. */
function sanitize(raw: unknown): Partial<OrbitPose> | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const out: Partial<OrbitPose> = {};
  let any = false;
  for (const k of ["pitchRad", "frameFactor", "liftFrac", "ringFrameFactor"] as const) {
    const v = src[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : null;
}

function readStored(): Partial<OrbitPose> | null {
  try {
    const ls = (globalThis as unknown as { localStorage?: Storage }).localStorage;
    const raw = ls?.getItem(ORBIT_POSE_STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : null;
  } catch {
    return null; // private mode / node / worker / bad JSON — the defaults stand
  }
}

/**
 * THE POSE THE LADDER RUNS ON. A console override (`globalThis.__orbitPose`)
 * wins field-by-field; otherwise the persisted choice; otherwise the defaults.
 * Returns a fresh object, so a caller can never mutate the shipped constants.
 */
export function orbitPose(): OrbitPose {
  if (stored === undefined) stored = readStored();
  const g = sanitize((globalThis as unknown as OrbitGlobal).__orbitPose);
  return { ...ORBIT_POSE_DEFAULTS, ...(stored ?? {}), ...(g ?? {}) };
}

/** Is anything overriding the shipped pose right now? (The debug panel says so
 *  on screen; nothing in the play path reads it.) */
export function orbitPoseOverridden(): boolean {
  const p = orbitPose();
  return (
    p.pitchRad !== ORBIT_POSE_DEFAULTS.pitchRad ||
    p.frameFactor !== ORBIT_POSE_DEFAULTS.frameFactor ||
    p.liftFrac !== ORBIT_POSE_DEFAULTS.liftFrac ||
    p.ringFrameFactor !== ORBIT_POSE_DEFAULTS.ringFrameFactor
  );
}

/** Move one or more fields and persist. Takes effect on the next frame of every
 *  running ladder (both pose calls read the record live). */
export function setOrbitPose(patch: Partial<OrbitPose>): void {
  const clean = sanitize(patch) ?? {};
  const next = { ...(stored ?? {}), ...clean };
  stored = next;
  (globalThis as unknown as OrbitGlobal).__orbitPose = next;
  try {
    const ls = (globalThis as unknown as { localStorage?: Storage }).localStorage;
    ls?.setItem(ORBIT_POSE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* not persistable here — the session-level override above still holds */
  }
}

/** Drop every override — the shipped defaults, this tab and the next. */
export function resetOrbitPose(): void {
  stored = null;
  delete (globalThis as unknown as OrbitGlobal).__orbitPose;
  try {
    const ls = (globalThis as unknown as { localStorage?: Storage }).localStorage;
    ls?.removeItem(ORBIT_POSE_STORAGE_KEY);
  } catch {
    /* nothing persisted here to clear */
  }
}

/** TEST SEAM: forget the cached read (and any console override) so a suite can
 *  exercise both sides of the switch in one process — without touching storage. */
export function resetOrbitPoseForTests(): void {
  stored = undefined;
  delete (globalThis as unknown as OrbitGlobal).__orbitPose;
}
