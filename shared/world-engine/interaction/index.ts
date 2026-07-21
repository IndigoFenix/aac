// shared/world-engine/interaction/index.ts
// dialogue, conversation, and the non-LLM intent decoder (the "beta sentence builder").
//
// Runs entirely locally on top of the solver (../solver) and the sim core (../). The
// CONTENT unit is the QUOTE (the endpoint) + POOLS that fill its blanks + the
// binder/worklist; a bound quote compiles down to goal-tree nodes that the solver
// certifies. Originally authored as a standalone "symbol-game", this is really the
// core of how world-engine NPCs talk. See planning-docs/symbol-learning-game-plan.md.

export * from "./types.js";
export * from "./content/pools.js";
export * from "./content/quote.js";
export * from "./content/concept-demo.js";
export * from "./content/compile.js";
export * from "./content/affordance.js";
export * from "./content/room.js";
export * from "./content/scene.js";
export * from "./dialogue/dialogue-gen.js";
export * from "./content/world-gen.js";
export * from "./behavior/creatures.js";
export * from "./behavior/facts.js";
export * from "./dialogue/creature-dialogue.js";
export * from "./dialogue/creature-converse.js";
export * from "./quest/creature-quests.js";
export * from "./town/village.js";
// Deterministic goal/rule/personality system + the concept parser (world-sim).
export * from "./behavior/relations.js";
export * from "./behavior/personality.js";
export * from "./behavior/willingness.js";
export * from "./behavior/needs.js";
export * from "./behavior/mood.js";
export * from "./behavior/rules.js";
export * from "./behavior/goal-selection.js";
export * from "./behavior/task-pool.js";
export * from "./dialogue/intent-lines.js";
export * from "./intent/parse-intent.js";
export * from "./intent/intent-compile.js";
export * from "./behavior/creature-goal-runtime.js";
export { REQUESTING_EXCHANGES } from "./catalog/requesting.js";
