// shared/aac/energy-meter.ts
//
// Pure regenerating "energy" model for the AAC cost-saving system (Phase 4).
// Energy is a soft, advisory signal exposed to the Observer so it can govern
// its own observation cost — observe in full detail when energy is high, lean
// on cheap text and rest sooner when it's low. It is NOT a hard gate: safety
// and escalation frames always flow regardless (the Observer is told never to
// let low energy suppress them).
//
// Model: a regenerating DRAIN (deficit, in credits). Each LLM/TTS charge adds
// to the drain; the drain regenerates at a fixed credits/hour. Energy =
// ceiling - drain, as a 0..100%. So heavy observation outpaces regen and energy
// falls; quiet stretches let it recover. Lives in shared/ (pure, no deps) so the
// coordinator uses it and server tests cover the math.
// See planning-docs/aac-cost-saving-spec.md §4.

export interface EnergyState {
  /** Regenerating deficit in credits. 0 = full energy. */
  drain: number;
  /** Epoch ms when `drain` was last updated. */
  asOf: number;
}

export interface EnergyConfig {
  /** Drain (credits) at which energy hits 0. */
  ceiling: number;
  /** Regeneration rate, credits/hour. */
  perHour: number;
}

export type EnergyBand = "high" | "moderate" | "low";

export function initEnergy(now: number): EnergyState {
  return { drain: 0, asOf: now };
}

/** Apply elapsed-time regeneration up to `now`. Monotonic in time: a `now`
 *  in the past is treated as no elapsed time (clamped), never adding drain. */
export function regenerate(state: EnergyState, now: number, perHour: number): EnergyState {
  const elapsed = Math.max(0, now - state.asOf);
  const regen = (elapsed * perHour) / 3_600_000;
  return { drain: Math.max(0, state.drain - regen), asOf: Math.max(state.asOf, now) };
}

/** Regenerate to `now`, then add a credit charge to the drain. */
export function applyCharge(state: EnergyState, credits: number, now: number, perHour: number): EnergyState {
  const r = regenerate(state, now, perHour);
  if (!(credits > 0)) return r;
  return { drain: r.drain + credits, asOf: r.asOf };
}

/** Current energy as a 0..100 integer percentage (100 = full). */
export function energyPercent(state: EnergyState, now: number, cfg: EnergyConfig): number {
  if (!(cfg.ceiling > 0)) return 100;
  const r = regenerate(state, now, cfg.perHour);
  const energy = Math.max(0, cfg.ceiling - r.drain);
  return Math.round(Math.min(100, (energy / cfg.ceiling) * 100));
}

/** Coarse band for prompt guidance. */
export function energyBand(percent: number): EnergyBand {
  if (percent >= 67) return "high";
  if (percent >= 25) return "moderate";
  return "low";
}
