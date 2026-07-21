/**
 * plan.ts — SHIM. The planned-history provider moved into the shared
 * engine's civ layer (shared/engine/civ/plan.ts) in the engine carve; it
 * never touched the composition layer (the planner is politically
 * silent), so it moved whole.
 */
export * from "@shared/world-engine/kernel/civ/plan";
