// shared/symbol-game/index.ts — public surface for the symbol-game content layer.
//
// The CONTENT layer above the goal-tree engine: QUOTES (the endpoint unit) +
// POOLS that fill their blanks + the binder/worklist. A bound quote compiles
// down to goal-tree nodes (a follow-up module) that the existing solver
// certifies. See planning-docs/symbol-learning-game-plan.md.

export * from "./types.js";
export * from "./pools.js";
export * from "./quote.js";
export * from "./concept-demo.js";
export * from "./compile.js";
export * from "./affordance.js";
export * from "./room.js";
export * from "./scene.js";
export * from "./dialogue-gen.js";
export * from "./world-gen.js";
export * from "./creatures.js";
export * from "./creature-dialogue.js";
export * from "./creature-quests.js";
export * from "./village.js";
// Deterministic goal/rule/personality system + the concept parser (world-sim).
export * from "./relations.js";
export * from "./personality.js";
export * from "./rules.js";
export * from "./goal-selection.js";
export * from "./parse-intent.js";
export * from "./intent-compile.js";
export * from "./creature-goal-runtime.js";
export { REQUESTING_EXCHANGES } from "./catalog/requesting.js";
