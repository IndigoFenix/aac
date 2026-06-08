// Sandbox Game — Tuning constants & color palette
//
// This is the SINGLE tuning surface for the whole game. The gaze-sweep "feel"
// (BRUSH_*) and the ecology pacing (everything per-step) are expected to need
// playtest iteration — change numbers here, nowhere else.

// --- Grid ---------------------------------------------------------------------

export const GRID_COLS = 32;
export const GRID_ROWS = 32;

/** Starting sand height everywhere. High enough to dig valleys *down* into and
 *  still pile tall hills *up* from. Absolute value is arbitrary — moisture is
 *  driven by RELATIVE prominence, not absolute height. */
export const BASELINE_HEIGHT = 8;

// --- World clock --------------------------------------------------------------

/** One ecology tick. The sculpt brush runs every animation frame regardless;
 *  this only paces moisture/water/plants. ~1s ⇒ a left-alone hill springs in
 *  roughly half a minute (accelerated, in-session). Idle time on reload is
 *  resolved by running missed steps (see engine.catchUp). */
export const WORLD_STEP_MS = 1000;

/** Hard cap on catch-up steps after a long absence. The field sim settles to a
 *  near-equilibrium well before this, so capping costs nothing visible. */
export const MAX_CATCHUP_STEPS = 2000;

// --- Gaze sculpt brush (conserves total sand) ---------------------------------

export const BRUSH = {
  /** Brush radius in cells. */
  radius: 2.6,
  /** Gaze speed (cells/frame) above which we SWEEP (push sand along motion)
   *  rather than GATHER (pile sand toward focus). */
  sweepSpeed: 0.18,
  /** Fraction of a cell's height pushed downstream per frame while sweeping. */
  sweepRate: 0.22,
  /** Fraction of ring height pulled toward the focus per frame while gathering. */
  gatherRate: 0.05,
  /** Heights never go below this (a dug-out basin floor). */
  minHeight: 0,
};

// --- Water bucket -------------------------------------------------------------

export const POUR = {
  /** Surface water added per frame at the focus while the bucket dwells. */
  rate: 0.18,
  /** Radius (cells) the pour wets. */
  radius: 1.6,
  /** Frames of dwell before pouring ramps to full (so a glance doesn't flood). */
  rampFrames: 18,
};

// --- Ecology (per world step) -------------------------------------------------

export const ECO = {
  /** Box radius used to compute a cell's local mean height (its "prominence"). */
  promRadius: 2,
  /** Prominence (height above local mean) below which a cell catches no rain. */
  promThreshold: 0.5,
  /** Hidden moisture gained per step per unit of prominence (taller ⇒ faster). */
  moistGain: 1.2,
  /** Moisture lost everywhere each step. Flatten the hill ⇒ moisture bleeds out
   *  ⇒ springs eventually dry up (Rule 5). */
  moistDecay: 0.005,
  /** Ceiling on the hidden water table. Bounds the field and sets how long a
   *  flattened hill takes to dry: from the cap, spring emission drains it to the
   *  breach in ~(moistMax-breach)/springRate steps. */
  moistMax: 25,
  /** Diffusion passes per step moving moisture toward lower-GROUND neighbours
   *  (the hidden "flows downhill underground" — concentrates it at the base). */
  moistDiffusePasses: 4,
  /** Fraction of the moisture gradient moved per diffusion pass. */
  moistDiffuseRate: 0.4,

  /** A spring forms where the water table breaches the surface: moisture >
   *  height * springBreach. Output is moved from moisture to surface water. */
  springBreach: 0.6,
  springRate: 0.5,

  /** Surface-water relaxation passes per step (flow toward lowest height+water
   *  neighbour ⇒ rivers + lakes). */
  waterFlowPasses: 3,
  waterFlowRate: 0.4,
  /** Water at or below this depth is "stuck" (a retained film) and won't flow —
   *  so a poured puddle persists on flat ground instead of spreading to nothing.
   *  Only the excess above the film runs downhill as rivers. */
  waterFilm: 0.15,
  /** Surface water lost to evaporation each step. Bounds river length and dries
   *  unfed water. */
  evap: 0.04,
  /** Below this depth water is considered "dry" (cleared to 0). */
  waterMin: 0.02,

  /** Plants grow on ground that is damp or has SHALLOW water. */
  plantWaterMin: 0.03,
  plantWaterMax: 1.4,         // deeper than this is open lake — no plants
  plantMoistureRatio: 0.8,    // moisture >= height*ratio counts as damp ground
  plantGrowAfter: 8,          // wet steps before a plant appears
  plantGrow: 0.05,            // density gain per wet step (cap 1)
  plantDecay: 0.1,            // density lost per dry step
  wetDryDecay: 2,             // wetTime lost per dry step (dries faster than wets)
};

// --- Palette (colored boxes, no icons) ---------------------------------------

export type RGB = [number, number, number];

const SAND: RGB = [214, 184, 124];     // bare desert tan
const FERTILE: RGB = [97, 71, 38];     // damp, fertile soil — dark brown
const WATER_SHALLOW: RGB = [99, 178, 220];
const WATER_DEEP: RGB = [17, 64, 122];
const PLANT_SPARSE: RGB = [120, 176, 74];
const PLANT_DENSE: RGB = [28, 110, 46];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}
function lerpRGB(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/**
 * Base material color for a cell, BEFORE height-relief shading (applied by the
 * renderer, which has neighbour context). Precedence: open water → vegetation →
 * damp/fertile soil → bare sand.
 */
export function materialColor(
  height: number,
  moisture: number,
  water: number,
  plant: number,
): RGB {
  if (water >= ECO.waterMin) {
    const t = Math.min(1, water / 3);
    return lerpRGB(WATER_SHALLOW, WATER_DEEP, t);
  }
  if (plant > 0.05) {
    return lerpRGB(PLANT_SPARSE, PLANT_DENSE, plant);
  }
  // Bare → fertile as the hidden water table approaches the surface.
  const damp = height > 0 ? moisture / height : 0;
  return lerpRGB(SAND, FERTILE, damp);
}
