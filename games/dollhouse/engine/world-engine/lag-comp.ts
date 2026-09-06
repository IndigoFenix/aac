/**
 * ⏩ AUTOMATIC LAG COMPENSATION — the global toggle (user ruling 2026-09-05).
 *
 * THE PROBLEM. The world host re-derives its frame dt from its own clock and
 * clamps it at `FRAME_DT_CAP_S` (0.05 s, world-host.ts). On a machine that
 * renders a frame in 0.5 s, the sim is told 0.05 s elapsed — 0.45 s of world
 * time is destroyed EVERY FRAME. Headless, the frontier house finishes in ~560
 * sim seconds; in GL under lag the same arc took ~45 real minutes. The sim was
 * never slow; it was being starved of its own clock.
 *
 * THE FIX (world-host.ts `admitFrameDt`): with this flag on, a frame admits the
 * REAL elapsed time — capped at `LAG_COMP_MAX_FACTOR` × the nominal frame step
 * — and spends it through the EXISTING wide tick: motion in fixed substeps at
 * the engine's normal physics step, the decision pass once with the whole dt.
 *
 * ⚖️ IT IS NOT A FAST-FORWARD. It never advances the sim faster than the wall
 * clock; it stops LOSING wall-clock seconds. At 60 fps it does nothing at all.
 *
 * WHERE THIS LIVES AND WHY. Nothing in the tree was both GLOBAL across the
 * world-engine games and PERSISTED: `perf-probes.ts` is global but console-only,
 * the world-lab toolbar and `lab-locale` are persisted but world-lab only,
 * `world-tunables.ts` is a per-host gaze/camera FEEL contract, and `GameSettings`
 * (kernel/manifest.ts) is a field of a WORLD DOCUMENT — scope, focus, avatar —
 * so it travels with the spec, not with the player's machine, which is the thing
 * that lags. So this is deliberately the SHAPE of `perf-probes.ts` (one module the
 * engine imports, so every game inherits the setting with zero per-game wiring)
 * plus persistence: all games are served from one origin under `/games/<id>/`,
 * so a single `localStorage` key IS a cross-game global.
 *
 * Every storage access is guarded: `localStorage` does not exist in node (jest,
 * text mode) or a worker, where this reads FALSE — the default, and the reason
 * the headless transcripts are untouched by this seam.
 *
 * Console ergonomics, matching `__perfProbes`:
 *   globalThis.__lagComp = true      // this tab only, not persisted
 *   globalThis.__lagProbe            // the live readout while compensating
 */

/** ⚖️ THE CAP. The admitted dt is at most this many nominal frame steps
 *  (nominal = the host's own `FRAME_DT_CAP_S`, 0.05 s ⇒ 0.5 s per frame, which
 *  is also `WIDE_TICK_MAX_FRAME_S`, the widest frame the wide-tick round
 *  calibrated). Surplus beyond the cap is DROPPED, never banked — see the
 *  anti-spiral law at `admitFrameDt`. */
export const LAG_COMP_MAX_FACTOR = 10;

/** The persisted key. One origin serves every `/games/<id>/`, so this is global
 *  across the world-engine games by construction. */
export const LAG_COMP_STORAGE_KEY = "world-engine-lag-comp";

/** Per-frame readout (world-host publishes it; the world-lab status line and
 *  `globalThis.__lagProbe` read it). All seconds. */
export interface LagCompProbe {
  /** Was the compensator active on the last frame? */
  on: boolean;
  /** True wall-clock seconds the last frame took. */
  realS: number;
  /** Sim seconds the frame actually admitted (≤ cap). */
  admittedS: number;
  /** Sim seconds thrown away because the cap bit (0 when it did not). */
  droppedS: number;
  /** admitted ÷ what today's clamp would have admitted. 1 … LAG_COMP_MAX_FACTOR. */
  factor: number;
  /** Motion substeps the frame ran (1 when nothing was widened). */
  substeps: number;
}

type LagGlobal = { __lagComp?: boolean; __lagProbe?: LagCompProbe };

/** Persisted value, read once and then cached (the getter runs every frame). */
let stored: boolean | null = null;

function readStored(): boolean {
  try {
    const ls = (globalThis as unknown as { localStorage?: Storage }).localStorage;
    return ls?.getItem(LAG_COMP_STORAGE_KEY) === "1";
  } catch {
    return false; // private mode / node / worker — the default is OFF
  }
}

/**
 * Is automatic lag compensation on? A console override (`globalThis.__lagComp`)
 * wins; otherwise the persisted choice; otherwise OFF.
 */
export function lagCompOn(): boolean {
  const g = (globalThis as unknown as LagGlobal).__lagComp;
  if (typeof g === "boolean") return g;
  if (stored === null) stored = readStored();
  return stored;
}

/** Flip it and persist. Takes effect on the next frame of every running host. */
export function setLagComp(on: boolean): void {
  stored = on;
  (globalThis as unknown as LagGlobal).__lagComp = on;
  try {
    const ls = (globalThis as unknown as { localStorage?: Storage }).localStorage;
    if (on) ls?.setItem(LAG_COMP_STORAGE_KEY, "1");
    else ls?.removeItem(LAG_COMP_STORAGE_KEY);
  } catch {
    /* not persistable here — the session-level override above still holds */
  }
}

/** TEST SEAM: forget the cached read (and any console override) so a suite can
 *  exercise both sides of the switch in one process. */
export function resetLagCompForTests(): void {
  stored = null;
  delete (globalThis as unknown as LagGlobal).__lagComp;
}

/** The last frame's readout, or null if nothing has compensated yet. */
export function lagProbeGlobal(): LagCompProbe | null {
  return (globalThis as unknown as LagGlobal).__lagProbe ?? null;
}
