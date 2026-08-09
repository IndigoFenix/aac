// shared/aac/budget-meter.ts
//
// Persistent, multi-window cost budget for the AAC. Where energy-meter.ts is a
// SINGLE per-session regenerating bucket (advisory, resets each session), this
// runs SEVERAL such buckets in parallel over DIFFERENT time windows (e.g. 3h /
// 3d / 14d) and survives across sessions. Each window is exactly an
// energy-meter `EnergyConfig` — `ceiling` is the window's spend cap, `perHour`
// the regen that approximates a rolling window of `ceiling / perHour` hours.
//
// The whole point of multiple windows is that the BINDING constraint is the
// tightest one right now: a long window with headroom permits a periodic long
// session, while a short window throttles a binge first (into the near-free
// passive mode — presence continues, only paid LLM is rationed). Charges feed
// every window; `bindingEnergy` reports the lowest, and its band drives the
// throttle ladder (idle→sleep scaling, compression, mode downgrade).
//
// Pure (no deps beyond energy-meter.ts) so the coordinator uses it, the state
// serializes straight to a JSONB column, and server tests cover the math.
// See planning-docs/aac-budget-tiers-spec.md §2.

import {
  initEnergy,
  regenerate,
  applyCharge,
  energyPercent,
  energyBand,
  type EnergyState,
  type EnergyConfig,
  type EnergyBand,
} from "./energy-meter.js";

/** One budget window: a named regenerating bucket. */
export interface BudgetWindow {
  /** Stable key, also the JSONB key for this window's state (e.g. "3h"). */
  key: string;
  cfg: EnergyConfig;
}

/** Per-window drain state, keyed by `BudgetWindow.key`. JSONB-serializable —
 *  this is exactly the shape persisted on `students.budget_meters`. */
export type BudgetState = Record<string, EnergyState>;

/** Initialize every window full (zero drain) as of `now`. */
export function initBudget(windows: BudgetWindow[], now: number): BudgetState {
  const state: BudgetState = {};
  for (const w of windows) state[w.key] = initEnergy(now);
  return state;
}

/** A window's stored state, or a fresh full bucket if the persisted state has
 *  no entry for it yet (tier change added a window, first run, etc.). */
function windowState(state: BudgetState, w: BudgetWindow, now: number): EnergyState {
  return state[w.key] ?? initEnergy(now);
}

/** Regenerate every window to `now`, then add `credits` to every window's
 *  drain. Returns a NEW state object (the old one is untouched). Windows absent
 *  from `state` start full before the charge. */
export function applyBudgetCharge(
  state: BudgetState,
  windows: BudgetWindow[],
  credits: number,
  now: number,
): BudgetState {
  const next: BudgetState = { ...state };
  for (const w of windows) {
    next[w.key] = applyCharge(windowState(state, w, now), credits, now, w.cfg.perHour);
  }
  return next;
}

/**
 * Merge two budget states into the most-complete record: per window, both
 * sides are regenerated to `now` and the one with the HIGHER remaining drain
 * wins. Drain only ever decays (by regen) — it never spontaneously drops — so
 * the higher normalized drain is always the fuller accounting of real spend.
 * This makes concurrent or stale writers safe by construction: a coordinator
 * saving from a stale base can no longer erase drain another one accumulated
 * (last-writer-wins clobbering was how the meter lost ~86% of real spend and
 * read 94% instead of 62%). Windows present on only one side carry over
 * unchanged; a key with no config in `windows` (left over from an old tier)
 * can't be regen-normalized, so raw drain compares directly.
 */
export function mergeBudgetState(
  a: BudgetState | null | undefined,
  b: BudgetState | null | undefined,
  windows: BudgetWindow[],
  now: number,
): BudgetState {
  const perHourByKey = new Map(windows.map(w => [w.key, w.cfg.perHour]));
  const out: BudgetState = {};
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const key of keys) {
    const sa = a?.[key];
    const sb = b?.[key];
    if (!sa || !sb) {
      out[key] = (sa ?? sb)!;
      continue;
    }
    const perHour = perHourByKey.get(key);
    if (perHour === undefined) {
      out[key] = sa.drain >= sb.drain ? sa : sb;
      continue;
    }
    const ra = regenerate(sa, now, perHour);
    const rb = regenerate(sb, now, perHour);
    out[key] = ra.drain >= rb.drain ? ra : rb;
  }
  return out;
}

export interface WindowReading {
  key: string;
  percent: number;
  band: EnergyBand;
  /** Minutes until this window is fully refilled at its regen rate, 0 when
   *  already full. (= current drain ÷ perHour, in minutes.) For the clinician
   *  dashboard's "full in ~2h" readout. */
  refillMinutes: number;
}

/** Per-window energy %, in the order the windows were given. For surfacing the
 *  full picture to a clinician dashboard / debug. */
export function budgetReadings(state: BudgetState, windows: BudgetWindow[], now: number): WindowReading[] {
  return windows.map(w => {
    const regened = regenerate(windowState(state, w, now), now, w.cfg.perHour);
    const energy = Math.max(0, w.cfg.ceiling - regened.drain);
    const percent = w.cfg.ceiling > 0 ? Math.round(Math.min(100, (energy / w.cfg.ceiling) * 100)) : 100;
    const refillMinutes = w.cfg.perHour > 0 ? Math.ceil((regened.drain / w.cfg.perHour) * 60) : 0;
    return { key: w.key, percent, band: energyBand(percent), refillMinutes };
  });
}

export interface BindingReading {
  /** Lowest energy % across all windows. 100 when there are no windows. */
  percent: number;
  /** Band of that lowest window — the governing throttle band. */
  band: EnergyBand;
  /** Key of the binding (tightest) window, or null when there are no windows. */
  window: string | null;
}

/** The WORSE (lower) of two bands, ranking low < moderate < high. Used to fold
 *  the per-session energy band and the persistent budget's binding band into a
 *  single governing throttle band — whichever signal is more constrained wins. */
export function worseBand(a: EnergyBand, b: EnergyBand): EnergyBand {
  const rank = (x: EnergyBand): number => (x === "low" ? 0 : x === "moderate" ? 1 : 2);
  return rank(a) <= rank(b) ? a : b;
}

/** The tightest window right now: the lowest energy % and its band. This is the
 *  constraint that governs throttling — a long session is allowed only while
 *  EVERY window has headroom, and the first to run low binds. Ties resolve to
 *  the earliest window in `windows` (declare shortest-first for intuitive
 *  attribution). */
export function bindingEnergy(state: BudgetState, windows: BudgetWindow[], now: number): BindingReading {
  let binding: BindingReading = { percent: 100, band: "high", window: null };
  for (const w of windows) {
    const percent = energyPercent(windowState(state, w, now), now, w.cfg);
    if (binding.window === null || percent < binding.percent) {
      binding = { percent, band: energyBand(percent), window: w.key };
    }
  }
  return binding;
}
