// shared/world-engine/interact.ts
//
// INTERACT intent (P3): when a settled gaze rests ON something — a toy, an NPC, or
// another player — the aim should mean "engage that", not "walk to the ground point
// behind it". This module turns a gaze ground-point into (a) which entity (if any)
// it's resting on and (b) the aim that engages it, TYPE-AWARE:
//   • a toy (the soccer ball) → aim AT its centre, so you walk INTO it and dribble
//     (the ball's whole interaction is "move into it"; stopping short would break it),
//   • a person (NPC or peer) → approach to a comfortable conversation distance and
//     stop there FACING them (you don't walk through someone to talk to them).
//
// Pure + headless-testable. Picking is WORLD-SPACE proximity to the gaze's ground
// point — deliberately renderer-agnostic. That's exact in the overhead "home" view
// (steep camera ⇒ a gaze on an entity maps to ~its base), which is where local
// interaction happens; in the shallow travel view it's approximate, but there you're
// heading to a far destination, not engaging what's next to you, so it doesn't bite.

import type { Vec2 } from "./types.js";
import type { WorldState } from "./engine.js";
import { WORLD_ENGINE_DEFAULTS } from "./engine.js";
import { DEFAULT_INTERACT_TUNABLES, type InteractTunables } from "./world-tunables.js";

export type InteractKind = "object" | "avatar";

export interface PickedEntity {
  id: string;
  kind: InteractKind;
  /** The entity's current world position. */
  x: number;
  y: number;
}

/**
 * The entity a gaze ground-point is resting on, or null. Nearest wins; the local
 * avatar is excluded (you can't interact with yourself — that's the WATCH/sit path).
 */
export function pickEntity(
  point: Vec2,
  state: WorldState,
  localId: string,
  cfg: InteractTunables = DEFAULT_INTERACT_TUNABLES,
): PickedEntity | null {
  // ITEM PRIORITY: an object and a creature can occupy the same spot (an item on a
  // creature's tile). A gaze dwelling there should engage the ITEM — so an object
  // within pick range always wins over a co-located creature. The carried item is
  // excluded (you can't re-target what you're already holding — picking it as the
  // fixation feeds a placement loop).
  //
  // This is the fallback for a view with NO screen pick. The real 3D view
  // raycasts (render3d `pickScreen`), where depth answers the same question far
  // more precisely: whichever surface the ray strikes first is the one being
  // looked at, and only a near-exact tie falls back to preferring the item.
  let bestObj: PickedEntity | null = null;
  let bestObjD = Infinity;
  for (const obj of Object.values(state.objects)) {
    if (obj.carriedBy) continue;
    const spec = state.spec.objects.find((o) => o.id === obj.id);
    const pickR = Math.max(cfg.toyPickRadius, spec?.push?.touchRadius ?? 0);
    const d = Math.hypot(obj.x - point.x, obj.y - point.y);
    if (d <= pickR && d < bestObjD) {
      bestObj = { id: obj.id, kind: "object", x: obj.x, y: obj.y };
      bestObjD = d;
    }
  }
  if (bestObj) return bestObj;

  let bestAv: PickedEntity | null = null;
  let bestAvD = Infinity;
  for (const a of Object.values(state.avatars)) {
    if (a.id === localId) continue;
    const d = Math.hypot(a.x - point.x, a.y - point.y);
    if (d <= cfg.avatarPickRadius && d < bestAvD) {
      bestAv = { id: a.id, kind: "avatar", x: a.x, y: a.y };
      bestAvD = d;
    }
  }
  return bestAv;
}

/**
 * The aim that engages a picked entity from the avatar's current position.
 *   • toy → the toy centre (walk in / dribble — the existing soccer behaviour),
 *   • avatar → a point `npcStopDistance` short of them along the approach line, so
 *     the engine's arrive-steer stops there facing them. When already within that
 *     distance, aim a hair toward them (inside aimDeadRadius ⇒ brake + face) so you
 *     hold position turned toward them instead of backing away.
 */
export function approachAim(
  avatar: Vec2,
  target: Vec2,
  kind: InteractKind,
  cfg: InteractTunables = DEFAULT_INTERACT_TUNABLES,
): Vec2 {
  if (kind === "object") return { x: target.x, y: target.y };

  const dx = target.x - avatar.x;
  const dy = target.y - avatar.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-4) return { x: avatar.x, y: avatar.y };
  const ux = dx / d;
  const uy = dy / d;

  if (d > cfg.npcStopDistance) {
    return { x: target.x - ux * cfg.npcStopDistance, y: target.y - uy * cfg.npcStopDistance };
  }
  // Already in range: aim a hair toward them so we brake + turn to face (the engine
  // treats an aim within aimDeadRadius as "stop here, face the aim").
  const eps = Math.min(0.05, WORLD_ENGINE_DEFAULTS.aimDeadRadius * 0.5);
  return { x: avatar.x + ux * eps, y: avatar.y + uy * eps };
}
