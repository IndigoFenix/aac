// shared/world-engine/interaction/behavior/mood.ts
//
// DERIVED EMOTION (creature-behavior-brainstorming.md: stress is the "core
// psychological meter" and mood FALLS OUT of needs — it is never authored).
// Deliberately thin, pure data-flow:
//
//   PRESSURE — how far the worst need is held PAST its firing threshold. A
//   need served promptly (the walker reaches the table in half a minute)
//   exerts almost none; a BLOCKED need's meter keeps climbing, so pressure
//   grows the whole time the want goes unmet.
//
//   STRESS — integrates pressure, decays while content. No behavior reads it
//   yet (leaving/lethargy are a later slice); it feeds the HUD, the dialogue
//   condition ("sad") and the model-health invariants: a fully-equipped
//   household must hold stress ~flat; strip its stations and stress must
//   CLIMB. If the first fails, the behavior model is broken somewhere.
//
// PURE — the host ticks it beside the meters; tests drive it directly.

/** How far the WORST need is past firing. `levels` are threshold-normalized
 *  meter values (1 = just firing); 0 = everything below threshold. */
export function needPressure(levels: readonly number[]): number {
  let worst = 0;
  for (const l of levels) worst = Math.max(worst, l - 1);
  return worst;
}

/** Stress rise per second per unit of pressure. */
export const STRESS_RISE = 0.05;
/** Stress decay per second while fully content (no pressure). */
export const STRESS_DECAY = 0.01;
/** The stress level at which distress becomes VISIBLE (HUD 😟, condition). */
export const STRESS_VISIBLE = 0.4;

/** One integration step: pressure pushes stress up, contentment bleeds it off. */
export function stressStep(stress: number, pressure: number, dt: number): number {
  const next = pressure > 0 ? stress + STRESS_RISE * pressure * dt : stress - STRESS_DECAY * dt;
  return Math.max(0, Math.min(1, next));
}
