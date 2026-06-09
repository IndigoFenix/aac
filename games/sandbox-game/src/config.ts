// Sandbox Game — Tuning constants & color palette
//
// This is the SINGLE tuning surface for the whole game. The gaze-sweep "feel"
// (BRUSH_*) and the ecology pacing (everything per-step) are expected to need
// playtest iteration — change numbers here, nowhere else.

// --- Grid ---------------------------------------------------------------------

export const GRID_COLS = 32;
export const GRID_ROWS = 32;

/** Starting sand height everywhere — and the master ELEVATION SCALE of the game.
 *  Bigger ⇒ deeper valleys to dig and more sand to gather, so a proper mountain
 *  takes several sweeps to raise (paired with a low BRUSH.pushRate). Moisture
 *  ACCUMULATION is driven by relative prominence, but the SPRING breach is tied to
 *  absolute height (moisture > height·springBreach), so this scale sets where the
 *  water table can surface — raise ECO.moistMax with it (a foot spring at ≈baseline
 *  needs moistMax > baseline·springBreach) or springs can never breach. */
export const BASELINE_HEIGHT = 16;

// --- World clock --------------------------------------------------------------

/** One ecology tick. The sculpt brush runs every animation frame regardless;
 *  this only paces moisture/water/plants. ~1s ⇒ a left-alone hill springs in
 *  roughly half a minute (accelerated, in-session). Idle time on reload is
 *  resolved by running missed steps (see engine.catchUp). */
export const WORLD_STEP_MS = 1000;

/** Hard cap on catch-up steps after a long absence. The field sim settles to a
 *  near-equilibrium well before this, so capping costs nothing visible. */
export const MAX_CATCHUP_STEPS = 2000;

/** Below this, a per-step field change is treated as zero: the process snaps to
 *  its fixed point and does no transfer. This is what turns "asymptotically
 *  approaching rest" into "reaches exact rest in finite steps, then sleeps" — the
 *  basis of the termination guarantee and (later) of quiescence. Per-field scale
 *  differs, but all fields here are O(0.01–10), so one small epsilon serves. */
export const SETTLE_EPS = 1e-4;

/** Sleep/wake hysteresis threshold for the scheduler: a cell whose fields move by
 *  less than this in a step is treated as AT REST and allowed to sleep. It sits an
 *  order of magnitude ABOVE SETTLE_EPS so that a marginal sub-SETTLE_EPS chatter
 *  (e.g. two cells trading a sliver of fertility across the diffuse snap boundary)
 *  doesn't keep the world awake forever — yet still far BELOW any real dynamics
 *  (plant growth, evaporation, flow are all ≥1e-2/step), so nothing genuinely
 *  moving is ever mistaken for settled. Without this the world can quiesce to a
 *  tiny limit cycle instead of true rest. */
export const SLEEP_EPS = 1e-3;

/** Monotonicity bound for the EQUALISING redistributions (surface water flow,
 *  fertility spread). On a 4-neighbour grid an explicit diffusion is monotone
 *  (no overshoot, no new extrema ⇒ guaranteed to converge) only while the rate
 *  ≤ 1/(degree+1) = 1/5. We CLAMP every redistribution rate to this, so a
 *  mis-tuned rate in the blocks below can only change settling SPEED, never
 *  stability — the engine can't be made to oscillate by changing a number. */
export const STABLE_REDIST_RATE = 0.2;

// --- Gaze sculpt brush (conserves total sand) ---------------------------------

export const BRUSH = {
  /** Brush radius in cells. */
  radius: 2.6,
  /** Below this gaze speed (cells/frame) the pointer is "resting": no effect.
   *  Also a deadzone that absorbs eye-tracker jitter so a still gaze does nothing. */
  restSpeed: 0.12,
  /** Speed band (cells/frame) above restSpeed over which engagement ramps 0→1
   *  (a soft start so the brush doesn't pop on as the gaze begins to move). */
  rampWidth: 0.3,
  /** Fraction of a brushed cell's height pushed one step in the motion direction
   *  per engaged frame. Two consequences make the brush feel physical:
   *   • fraction-of-height ⇒ a tall hill shoves a LOT of sand, so slowly dragging
   *     over a hill pushes the whole hill along (the "gathering" feel);
   *   • it's a per-frame CAP, and a moving brush touches each cell for ~1/speed
   *     frames — so slow deliberate motion piles up a deep channel while a fast
   *     pass barely marks the sand (and a fast flick skips cells entirely).
   *  Kept LOW so a proper mountain takes SEVERAL sweeps to raise (stronger,
   *  more deliberate structural control) rather than appearing in one drag. */
  pushRate: 0.15,
  /** Angle of repose: the largest height difference two neighbours can sustain.
   *  Steeper slopes in the brushed area slump — this spreads pushed sand to the
   *  SIDES of a cut, smooths back-and-forth agitation, and turns circling into a
   *  clean hole with a raised rim. High enough that a normal hill survives being
   *  dragged over (so you push the whole hill rather than smearing it flat); only
   *  the over-steep walls a cut/pile creates slump. Scaled up with BASELINE_HEIGHT
   *  so peaks can stand TALLER and more vertical (a cone's peak ≈ footprint·talus). */
  talus: 4,
  /** How fast over-steep slopes relax toward the talus, per engaged frame. */
  reposeRate: 0.25,
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
  /** Box radius used to compute a cell's local mean height (its "prominence").
   *  Larger ⇒ prominence reflects BROAD elevation (a real mountain) rather than
   *  local jaggedness; with a small radius every sculpting bump reads as a peak
   *  and rough terrain spawns springs everywhere. Wide enough that only a broad
   *  massif catches rain — a bump ON a massif isn't prominent vs the massif. */
  promRadius: 6,
  /** Prominence (height above local mean) below which a cell catches no rain. */
  promThreshold: 2.5,
  /** Prominence is CAPPED here before it drives accumulation, so a tall spike
   *  produces no more "rain" than a normal hill (rainfall is bounded per area,
   *  not proportional to how jagged the peak is). */
  promCap: 6,
  /** Hidden moisture gained per step per unit of (capped) prominence. */
  moistGain: 0.6,
  /** Moisture lost everywhere each step. Flatten the hill ⇒ moisture bleeds out
   *  ⇒ springs eventually dry up (Rule 5). */
  moistDecay: 0.005,
  /** Ceiling on the hidden water table. Bounds the field and sets how long a
   *  flattened hill takes to dry: from the cap, spring emission drains it to the
   *  breach in ~(moistMax-breach)/springRate steps. MUST clear baseline·springBreach
   *  (≈16·0.85≈13.6) or a spring at a mountain's foot can never breach — scaled up
   *  with BASELINE_HEIGHT. */
  moistMax: 20,
  /** SINGLE-PASS advection of the hidden water table toward lower-GROUND
   *  neighbours ("flows downhill underground" — concentrates it at the base).
   *  This is a one-directional flow of a FRACTION of a cell's own moisture down
   *  a fixed height potential, so it cannot oscillate and cannot go negative for
   *  any rate ≤ 1 (clamped below); it relaxes over successive worldsteps, then
   *  quiesces. Raised from the old multi-pass value to keep base-concentration
   *  pace now that it runs once per step: the old 4×0.4 passes left ~0.6⁴≈13% of a
   *  cell's moisture in place per step, so a single pass needs ~0.87 to move the
   *  same amount downhill and keep springs CONCENTRATED at the massif foot (a
   *  weaker rate leaves the table spread across the whole massif → springs
   *  everywhere → the map floods). */
  moistDiffuseRate: 0.87,

  /** A spring forms where the water table genuinely breaches the surface:
   *  moisture > height * springBreach (>1 ⇒ the table must exceed the ground,
   *  so only well-fed lows spring — keeps springs rare). Output moves from the
   *  moisture layer to surface water at springRate (low ⇒ a trickle, not a flood). */
  springBreach: 0.85,
  springRate: 0.15,

  /** SINGLE-PASS surface-water relaxation: move toward lower (height+water)
   *  neighbours ⇒ rivers + lakes. Each lower neighbour is sent waterFlow ×
   *  (surface drop), but the per-pair amount is structurally bounded so it can
   *  never push a cell below the neighbour it feeds (no overshoot ⇒ no two-tile
   *  ping-pong), and the total is capped by the cell's movable (above-film)
   *  water. The effective rate is clamped to STABLE_REDIST_RATE, so this value
   *  only sets SPEED — stability holds for any number you put here. */
  waterFlow: 0.2,
  /** Water at or below this depth is "stuck" (a retained film) and won't flow,
   *  so a poured puddle persists on flat ground instead of spreading to nothing
   *  (only the excess above the film runs downhill). MUST exceed evap+waterMin,
   *  or even a fed puddle evaporates to nothing each step. The wet FOOTPRINT is
   *  set by production÷evap, not by this — so keep floods down via springRate /
   *  thresholds / edge drainage, not by starving the film. */
  waterFilm: 0.15,
  /** Surface water lost to evaporation each step. Bounds river length and the
   *  wet footprint, and dries unfed water. The main brake on flooding rough
   *  terrain: must outpace production over most cells so water stays in thin
   *  streams/small lakes instead of filling every hollow. */
  evap: 0.1,
  /** Below this depth water is considered "dry" (cleared to 0). */
  waterMin: 0.03,
  /** Open boundary: water reaching the grid edge drains off-map toward "sea"
   *  whenever its surface exceeds this level. Kept LOW (≈the dig floor) so the
   *  edge is a true open outlet — NOT a sea level that floods every dug hollow.
   *  (Earlier this was the baseline height, which made everything dug below the
   *  starting ground fill to the brim — the whole map drowned.) */
  edgeDrainLevel: 0,

  /** Erosion: flowing water incises its bed, which deepens channels and (because
   *  only wet, flowing cells erode while dry banks don't) confines water into
   *  rivers instead of letting it sheet across the whole low area. Sand is
   *  CONSERVED — eroded bed material is carried one cell downstream (carving
   *  upstream, building deltas where water slows). */
  erodeRate: 0.06,      // fraction of a cell's flowing-water excess turned into incision
  erodeMax: 0.04,       // hard cap on bed lowered per cell per step
  erodeWaterMin: 0.15,  // only water deeper than the film erodes (real channels, not damp ring)
  erodeMinSlope: 0.1,   // and only where the surface actually drops downstream —
                        // so standing pools/lakes (flat surface) don't self-dig a pit

  /** Open water deeper than this is a lake surface — no land plants on it. */
  plantWaterMax: 1.4,
};

// --- Fertility & vegetation ---------------------------------------------------
// Greenery does NOT require a wet tile. Water (surface, or a high water table)
// recharges a soil-FERTILITY field that spreads a couple tiles and slowly decays
// back to desert. Plants sprout at water and SPREAD outward through the fertile
// zone, persisting through short dry spells — so a little water grows a green
// oasis, while the map stays desert away from water. Tune the oasis SIZE with
// fertDiffuse* vs fertDecay (halo extent) and fertPlantMin (how much of the halo
// greens); tune how fast it grows/recedes with plantGrow / plantDecay.
export const FERT = {
  /** A cell UNDER surface water pins its fertility up to this each step. */
  waterTarget: 1,
  /** A high hidden water table pins fertility too (greens damp spring-bases that
   *  never pool): target = min(dampMax, dampGain × (moisture − height·dampTableRatio)). */
  dampTableRatio: 0.55,
  dampGain: 0.8,
  dampMax: 0.85,
  /** SINGLE-PASS spread of fertility into neighbouring soil (the halo) AFTER
   *  pinning sources. Equalising diffusion, effective rate clamped to
   *  STABLE_REDIST_RATE (monotone, can't overshoot). Halo radius is set by this
   *  rate vs `decay`; raised from the old multi-pass value to keep the oasis a
   *  couple tiles wide now that it spreads once per step. */
  diffuseRate: 0.25,
  /** Fertility lost each step — away from water the halo fades back to desert,
   *  and removing a water source lets an oasis recede. */
  decay: 0.06,
  /** Soil at/above this fertility can support plants (sets the green extent
   *  within the fertile halo). */
  plantMin: 0.18,
  /** Plant density gained per step in fertile soil (capped by fertility). */
  plantGrow: 0.04,
  /** Plant density lost per step once the soil is no longer fertile (slow ⇒
   *  drought-tolerant: survives brief dry spells, recedes if water is removed). */
  plantDecay: 0.03,
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
  fertility: number,
  plant: number,
): RGB {
  if (water >= ECO.waterMin) {
    const t = Math.min(1, water / 3);
    return lerpRGB(WATER_SHALLOW, WATER_DEEP, t);
  }
  if (plant > 0.05) {
    return lerpRGB(PLANT_SPARSE, PLANT_DENSE, plant);
  }
  // Bare → fertile brown: whichever is wetter, the hidden water table or the
  // fertility halo, so the oasis ground reads damp even before it greens.
  const damp = Math.max(fertility, height > 0 ? moisture / height : 0);
  return lerpRGB(SAND, FERTILE, damp);
}
