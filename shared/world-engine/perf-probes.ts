/**
 * PERF-PROBE MASTER SWITCH (view-distance-lod-tiers.md investigation).
 *
 * The world-engine carries a set of dormant performance probes from the
 * 2026-07 descend/dollhouse lag hunt — rolling per-block cost reporters and
 * causal-chain logs, each tagged TEMP at its site:
 *   [sim-blocks]     quest-host onFrame per-block costs (stream/needs/…)
 *   [frame-phase]    world-host tick/npc(aim,det,steer)/sim/render + probe counts
 *   [render-blocks]  render3d per-sync costs + fresh-mesh counts
 *   [descent-probe]  town-mount start() phases + first-300-frame stream deltas
 *   [stage-errands]  town-stage errand emissions by source (spawn/trips/hauler)
 *   [trip-emit]      residents cycle-gate diagnostics
 *   [ghost-spawn]    quest-host rejected addNpc diagnostics
 *   [errand-sample]  quest-host emitted errand ids
 *   [bake-probe]     creature-model species-asset cache misses
 * plus `scripts/tmp-profile-errands.ts`, a headless town harness (moving
 * viewer, churn + routing cost).
 *
 * All are OFF by default. Enable at RUNTIME — no rebuild — from the console:
 *   globalThis.__perfProbes = true
 * (and back off with `= false`). Timing accumulation that feeds them is
 * micro-cost and stays live; only recording/reporting is gated.
 */
export const probesOn = (): boolean =>
  (globalThis as unknown as { __perfProbes?: boolean }).__perfProbes === true;
