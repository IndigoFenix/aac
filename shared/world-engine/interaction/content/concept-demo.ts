// shared/world-engine/interaction/content/concept-demo.ts
//
// Maps a ConceptId to a closed, valid DemoCue script — the animation an
// `observe` (WATCH) beat plays to ground the concept before the student labels
// it, and the `onCorrect` payoff a contingency `choose` fires on a correct press
// (planning-docs/symbol-learning-game-plan.md §4.1, §7; cue kinds per goal-tree
// types.ts §6 notes: big→scale, more→spawn, go→move, happy→emote, hot→glow).
//
// Every returned script is non-empty and references the given entity, so it
// certifies. Demo CONTENT quality (which prop, how expressive) is iterative;
// this is the structural mapping that makes the beat real.

import type { DemoCue } from "../../solver/types.js";
import type { ConceptId } from "@shared/world-engine/interaction/types.js";

/**
 * The WATCH demonstration for a concept, acting on `entityId` (the stage prop).
 * Falls back to a neutral happy emote for concepts without a natural animation.
 */
export function demoForConcept(concept: ConceptId, entityId: string): DemoCue[] {
  switch (concept) {
    case "big":
      return [{ kind: "scale", entityId, to: 3, seconds: 1.2 }];
    case "little":
    case "small":
      return [{ kind: "scale", entityId, to: 0.5, seconds: 1.2 }];
    case "more":
    case "again":
      return [{ kind: "spawn", entityId, count: 3 }];
    case "go":
      return [{ kind: "move", entityId, dx: 6, dy: 0, seconds: 1.2 }];
    case "give":
    case "take":
      return [{ kind: "move", entityId, dx: 4, dy: 0, seconds: 1 }];
    case "happy":
      return [{ kind: "emote", entityId, emotion: "happy" }];
    case "sad":
      return [{ kind: "emote", entityId, emotion: "sad" }];
    case "hot":
      return [{ kind: "glow", entityId, tone: "warm" }];
    case "cold":
      return [{ kind: "glow", entityId, tone: "cool" }];
    default:
      // want, finished, and anything unmapped: a friendly neutral beat.
      return [{ kind: "emote", entityId, emotion: "happy" }];
  }
}

/**
 * The `onCorrect` payoff cues for a CONTINGENCY concept (press the action → the
 * world reacts), acting on `entityId`. Returns undefined for concepts that are
 * pure discrimination (no world effect on a correct press).
 */
export function contingencyCue(concept: ConceptId, entityId: string): DemoCue[] | undefined {
  switch (concept) {
    case "more":
    case "again":
      return [{ kind: "spawn", entityId, count: 2 }]; // one more emission
    case "go":
      return [{ kind: "move", entityId, dx: 6, dy: 0, seconds: 1.2 }];
    default:
      return undefined;
  }
}
