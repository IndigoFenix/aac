// shared/symbol-game/affordance.ts
//
// Affordance ↔ world-engine capability mapping (planning-docs/symbol-learning-
// game-plan.md §6.1). A pool's AffordanceTag determines how a filled object
// materializes in a world-engine room: its shape, interactions (push/carry),
// push tuning, and containment slots — or whether it materializes as an NPC.
//
// This is the "derive where possible" direction made concrete: the AffordanceTag
// enum is the curriculum-facing concept, and these functions project it onto the
// closed world-engine ObjectSpec/NpcSpec capability surface so a generated room
// always certifies (interactions are valid, push objects carry push tuning, etc.).

import type {
  ContainmentSlot,
  ObjectInteraction,
  ObjectShape,
  PushSpec,
} from "../world-engine/types.js";
import type { AffordanceTag } from "./types.js";

/** The world-engine object shape an affordance lowers to (minus position/id). */
export interface WorldObjectConfig {
  shape: ObjectShape;
  radius: number;
  interactions: ObjectInteraction[];
  push?: PushSpec;
  contains?: ContainmentSlot[];
}

/** Conservative default push tuning (all within the schema's clamps). */
const DEFAULT_PUSH: PushSpec = {
  dribbleDistance: 1,
  friction: 0.5,
  releaseSpeed: 1,
  touchRadius: 1,
};

/** True when the affordance is best embodied as an NPC rather than an object. */
export function materializesAsNpc(affordance: AffordanceTag): boolean {
  return affordance === "receptive-npc";
}

/**
 * Project an affordance onto a world-engine object configuration. Every branch
 * yields a spec that satisfies validateWorldStructure: a "push" object always
 * carries `push` tuning, and a no-interaction object always carries `contains`.
 */
export function objectConfigForAffordance(affordance: AffordanceTag): WorldObjectConfig {
  switch (affordance) {
    case "container":
    case "openable":
      // A container you place things into — no push/carry, but holds objects.
      return {
        shape: "box",
        radius: 1,
        interactions: [],
        contains: [{ relation: "in" }, { relation: "on" }],
      };
    case "startable-movable":
      // A vehicle you push around.
      return { shape: "sphere", radius: 0.7, interactions: ["push"], push: DEFAULT_PUSH };
    case "goal-blocked":
    case "goal-blocked-heavy":
      // A heavy load you shove.
      return { shape: "box", radius: 1, interactions: ["push"], push: DEFAULT_PUSH };
    case "graspable":
    case "transferable":
    case "repeatable-edible":
    case "repeatable-effect":
    case "repeatable":
    case "unwanted":
    case "attention-worthy":
    case "rotatable":
    case "requestable":
    case "ongoing-process":
    case "toggleable":
    case "vertical-movable":
    case "causative":
    default:
      // Everything else: a small carryable prop (the safe, always-valid default).
      return { shape: "sphere", radius: 0.6, interactions: ["carry"] };
  }
}
