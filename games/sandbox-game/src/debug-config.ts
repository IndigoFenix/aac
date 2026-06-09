// Sandbox Game — in-game tuning overrides (for the debug panel).
//
// The ecology/brush tuning lives in plain mutable objects in config.ts. This
// module persists per-key overrides to localStorage and re-applies them onto
// those live objects at startup, so you can adjust the simulation from the debug
// panel and have it stick across reloads. Applying mutates the live objects; the
// caller re-settles the world (wakeAll) so the new values take effect.
//
// Safety: the engine clamps the stability-critical rates (STABLE_REDIST_RATE,
// advection ≤ 1) and bounds/floors sources & sinks, so NO value typed here can
// break the termination guarantee — a number only changes feel/speed.

import { ECO, FERT, BRUSH, POUR, SHADE } from './config';

const STORAGE_KEY = 'sandbox_config_overrides';

/** All-numeric tuning objects exposed to the panel, in display order. */
const GROUPS: Record<string, Record<string, number>> = { BRUSH, POUR, ECO, FERT, SHADE };
export const GROUP_ORDER = ['SHADE', 'BRUSH', 'POUR', 'ECO', 'FERT'] as const;

/** Keys that must NOT be tuned from the panel (used as integer box radii — a
 *  fractional value would index between cells). SHADE.promRadius IS allowed (the
 *  renderer floors it). Edit ECO.promRadius in config.ts instead. */
const DENY = new Set(['ECO.promRadius']);

/** One-line "what does this do" for each knob, shown in the panel. */
const DESCRIPTIONS: Record<string, string> = {
  // Shading (render-only)
  'SHADE.promStrength': 'Brightness per unit of prominence (how far a cell stands above its surroundings).',
  'SHADE.promRadius': "Radius of the 'surroundings' box for prominence. 1 = crisp per-feature relief, ~6 = broad rain-shadow.",
  'SHADE.heightStrength': 'Brightness per unit of absolute height above baseline (valleys dark → peaks bright).',
  'SHADE.min': 'Darkest a tile can be shaded (lowest brightness multiplier).',
  'SHADE.max': 'Brightest a tile can be shaded (highest brightness multiplier).',
  // Brush
  'BRUSH.radius': 'Sculpt brush radius, in cells.',
  'BRUSH.restSpeed': 'Gaze speed below which the brush does nothing (jitter deadzone).',
  'BRUSH.rampWidth': 'Speed band over which the brush eases from off to full.',
  'BRUSH.pushRate': "Fraction of a cell's height pushed per frame. Lower = more sweeps to build a mountain.",
  'BRUSH.talus': 'Steepest height gap two neighbours hold before sand slumps. Higher = taller, steeper peaks.',
  'BRUSH.reposeRate': 'How fast over-steep slopes slump back toward the talus.',
  'BRUSH.minHeight': 'Floor height a cell can be dug down to.',
  'BRUSH.waterPush': "Fraction of a cell's surface water the brush shoves along per pass (dig drags water).",
  'BRUSH.fertMix': 'How much of dug sand’s fertility travels with it (1 = proportional).',
  'BRUSH.wetGain': 'Fertility the sand gains per unit of water it absorbs when it fills standing water.',
  'BRUSH.plantArmor': "Plant density above which a cell's sand is rooted and can't be dug until cleared.",
  'BRUSH.plantDamage': 'Plant density stripped per brush pass over vegetation.',
  'BRUSH.buryRate': 'Plant density destroyed per unit of sand dumped on top of it.',
  // Water bucket
  'POUR.rate': 'Surface water added per frame while the bucket dwells on a spot.',
  'POUR.radius': 'Radius the water bucket wets, in cells.',
  'POUR.rampFrames': "Dwell frames before pouring ramps to full (so a glance doesn't flood).",
  // Ecology
  'ECO.promThreshold': 'Prominence below which ground catches no rain.',
  'ECO.promCap': 'Prominence is capped here before driving rain (bounds rainfall per area).',
  'ECO.moistGain': 'Hidden water table gained per step per unit of (capped) prominence.',
  'ECO.moistDecay': 'Water table lost everywhere each step (flattened hills slowly dry out).',
  'ECO.moistMax': 'Ceiling on the hidden water table. Must exceed baseline·springBreach or springs can never breach.',
  'ECO.moistDiffuseRate': "Fraction of a cell's water table that flows downhill underground each step.",
  'ECO.springBreach': 'A spring forms where water table > height × this. Higher = needs a deeper table (springs rarer).',
  'ECO.springRate': 'Max water a spring emits per step. Must exceed evap or it can’t even wet its own cell.',
  'ECO.waterFilm': "Shallow water at/below this depth sticks and won't flow, so poured puddles persist.",
  'ECO.evap': 'Surface water lost to evaporation each step — the master flood brake.',
  'ECO.waterMin': 'Water shallower than this is cleared to 0 (counts as dry).',
  'ECO.edgeDrainLevel': "Open-boundary 'sea level': water past the map edge drains off above this. (Ignored when Wrap is on.)",
  'ECO.erodeRate': "Fraction of a flowing cell's excess water turned into bed incision.",
  'ECO.erodeMax': "Hard cap on how far a cell's bed lowers per step.",
  'ECO.erodeWaterMin': 'Only water deeper than this erodes (carves real channels, not a damp ring).',
  'ECO.erodeMinSlope': "Only incise where the water surface drops at least this downstream (flat pools don't self-dig a pit).",
  'ECO.plantWaterMax': 'Open water deeper than this is a lake surface — no land plants grow on it.',
  // Fertility & plants
  'FERT.waterTarget': 'Fertility a cell directly under surface water is pinned to.',
  'FERT.dampTableRatio': 'How high the hidden water table must be (vs height) before damp ground greens.',
  'FERT.dampGain': 'Fertility gained per unit of high water table at a damp spring base.',
  'FERT.dampMax': 'Cap on fertility coming from a high water table alone (no surface water).',
  'FERT.diffuseRate': 'How fast fertility spreads into neighbouring soil — sets the oasis halo width.',
  'FERT.decay': 'Fertility lost each step — the halo fades back to desert away from water.',
  'FERT.plantMin': 'Soil fertility needed to support plants (sets how much of the halo greens).',
  'FERT.plantGrow': 'Plant density gained per step in fertile soil.',
  'FERT.plantDecay': 'Plant density lost per step once soil is no longer fertile (drought tolerance).',
};

/** Pristine defaults, captured at module load BEFORE any override is applied. */
const DEFAULTS: Record<string, Record<string, number>> = {};
for (const [g, obj] of Object.entries(GROUPS)) DEFAULTS[g] = { ...obj };

function readSaved(): Record<string, number> {
  if (typeof localStorage === 'undefined') return {};
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
}

function splitFlat(flat: string): [string, string] {
  const dot = flat.indexOf('.');
  return [flat.slice(0, dot), flat.slice(dot + 1)];
}

function settable(flat: string, v: unknown): v is number {
  if (DENY.has(flat) || typeof v !== 'number' || !Number.isFinite(v)) return false;
  const [g, k] = splitFlat(flat);
  return !!GROUPS[g] && k in GROUPS[g];
}

/** Apply persisted overrides onto the live config objects. Call once at startup,
 *  before the engine reads any tuning value. */
export function loadOverrides(): void {
  for (const [flat, v] of Object.entries(readSaved())) {
    if (settable(flat, v)) { const [g, k] = splitFlat(flat); GROUPS[g][k] = v; }
  }
}

export interface Tunable {
  group: string;
  key: string;
  flat: string;
  value: number;
  def: number;
  step: number;
  desc: string;
}

function stepFor(v: number): number {
  const a = Math.abs(v);
  if (a >= 4) return 0.5;
  if (a >= 1) return 0.1;
  if (a >= 0.1) return 0.01;
  return 0.001;
}

/** Current tunables (live values + defaults), in GROUP_ORDER. */
export function getTunables(): Tunable[] {
  const out: Tunable[] = [];
  for (const g of GROUP_ORDER) {
    for (const k of Object.keys(GROUPS[g])) {
      const flat = `${g}.${k}`;
      if (DENY.has(flat)) continue;
      out.push({ group: g, key: k, flat, value: GROUPS[g][k], def: DEFAULTS[g][k], step: stepFor(DEFAULTS[g][k]), desc: DESCRIPTIONS[flat] ?? '' });
    }
  }
  return out;
}

/** Mutate the live config from a flat draft map, then persist only the values
 *  that differ from their built-in default (keeps storage tidy). */
export function applyOverrides(draft: Record<string, number>): void {
  for (const [flat, v] of Object.entries(draft)) {
    if (settable(flat, v)) { const [g, k] = splitFlat(flat); GROUPS[g][k] = v; }
  }
  const saved: Record<string, number> = {};
  for (const g of GROUP_ORDER) {
    for (const k of Object.keys(GROUPS[g])) {
      const flat = `${g}.${k}`;
      if (!DENY.has(flat) && GROUPS[g][k] !== DEFAULTS[g][k]) saved[flat] = GROUPS[g][k];
    }
  }
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
}

/** Restore every tunable to its built-in default and clear storage. */
export function resetOverrides(): void {
  for (const g of GROUP_ORDER) Object.assign(GROUPS[g], DEFAULTS[g]);
  if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
}
