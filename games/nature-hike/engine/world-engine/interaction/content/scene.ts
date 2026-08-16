// shared/world-engine/interaction/content/scene.ts
//
// Scene assembly — the single entry point that turns ONE quote-exchange into a
// fully playable, co-certified scene (planning-docs/symbol-learning-game-plan.md
// step 3 / §0): the goal-tree BEATS plus the WORLD they happen in, sharing one
// frozen binding so the lesson's bound objects are physically present.
//
// Architecture (respecting shared/goal-tree/space3d.ts): the goal-tree game's
// own layout is the authoritative navigable SPACE — embedLayoutInWorld derives a
// WorldSpec sized to it, and quest figures/items/doors ride on top as the Space
// layer (walls are a MoveConstraint, not WorldSpec geometry). This bundler then
// ENRICHES that world with the exchange's bound pool members as physical props
// (the same affordance→capability projection the hybrid room uses), so the
// "want the COOKIE" lesson has an actual cookie in the world, aligned to the
// binding. Both halves pass their own certification gauntlet.
//
// A fully room-AUTHORITATIVE backdrop (running the quest inside an authored
// HybridRoomSpec shell, reconciling its walls with the quest's passage gating)
// is the heavier next step — see §6.4; this delivers the playable scene now.

import { certifyGoalTreeGame } from "../../solver/index.js";
import type { GoalTreeGame } from "../../solver/types.js";
import type { Layout2D } from "../../solver/layout2d.js";
import {
  buildTransportObjects,
  embedLayoutInWorld,
  type TransportPlacement,
} from "../../solver/space3d.js";
import { certifyWorldSpec } from "../../index.js";
import type { NpcSpec, ObjectSpec, WorldSpec } from "../../types.js";
import { materializesAsNpc, objectConfigForAffordance } from "@shared/world-engine/interaction/content/affordance.js";
import { compileExchange, type CompileOptions } from "@shared/world-engine/interaction/content/compile.js";
import { bindExchange, randomMemberPicker, type MemberPicker } from "@shared/world-engine/interaction/content/quote.js";
import type { PoolDef, QuoteExchange, SlotBinding } from "@shared/world-engine/interaction/types.js";

export interface SymbolGameScene {
  /** The frozen binding shared by the beats and the world props. */
  binding: SlotBinding;
  /** The teach-then-test beats (certified goal-tree game). */
  game: GoalTreeGame;
  /** The world the avatar plays in (certified WorldSpec). */
  world: WorldSpec;
  /** The quest layout in world coordinates (avatar + content share it). */
  layout: Layout2D;
  /** Transport puzzle handles (empty for pure TELL beats). */
  transport: TransportPlacement[];
}

export type SceneResult =
  | { ok: true; scene: SymbolGameScene }
  | { ok: false; stage: "compile" | "goal-tree" | "world"; errors: string[] };

export interface SceneOptions {
  /** Forwarded to compileExchange (poser name/icon, withWatch). */
  compile?: CompileOptions;
  /** Place the exchange's bound members as physical props in the world. Default true. */
  ambientProps?: boolean;
}

/** Clamp a value into [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Materialize the frozen binding's pool members as physical props placed near the
 * spawn, using the same affordance→capability projection as the hybrid room. Ids
 * are `amb_<slot>` so they can't collide with the embedded spawn or transport
 * objects.
 */
function materializeBindingProps(
  binding: SlotBinding,
  pools: Record<string, PoolDef>,
  spec: WorldSpec,
): { objects: ObjectSpec[]; npcs: NpcSpec[] } {
  const objects: ObjectSpec[] = [];
  const npcs: NpcSpec[] = [];
  const { width, height } = spec.manifold;
  const spawn = spec.spawns[0] ?? { x: width / 2, y: height / 2 };
  const slots = Object.keys(binding);

  slots.forEach((slot, i) => {
    const pool = pools[slot];
    const member = binding[slot];
    if (!pool || !member) return;
    // A short row just below the spawn, clamped inside the manifold.
    const x = clamp(spawn.x + (i - (slots.length - 1) / 2) * 1.5, 0.5, width - 0.5);
    const y = clamp(spawn.y + 2, 0.5, height - 0.5);
    const id = `amb_${slot}`;

    if (materializesAsNpc(pool.affordance)) {
      npcs.push({
        id,
        x,
        y,
        name: member.label,
        persona: { genderHint: "any" },
        behavior: { movement: "stationary" },
      });
    } else {
      objects.push({
        id,
        x,
        y,
        ...objectConfigForAffordance(pool.affordance),
        ...(member.iconRef ? { iconRef: member.iconRef } : {}),
      });
    }
  });

  return { objects, npcs };
}

/**
 * Build a complete, co-certified scene from one quote-exchange: bind once →
 * compile the beats → certify them → embed their layout into a world → enrich it
 * with the bound props → certify the world. Returns staged errors on any failure
 * (compile rejects DO beats; either gauntlet can reject).
 */
export function buildScene(
  exchange: QuoteExchange,
  pools: Record<string, PoolDef>,
  pick: MemberPicker = randomMemberPicker,
  opts: SceneOptions = {},
): SceneResult {
  const bound = bindExchange(exchange, pools, pick);

  let game: GoalTreeGame;
  try {
    // Pools flow through so DO `collect` beats can draw their distractors.
    game = compileExchange(bound, { ...opts.compile, pools });
  } catch (err) {
    return { ok: false, stage: "compile", errors: [err instanceof Error ? err.message : String(err)] };
  }

  const gameCert = certifyGoalTreeGame(game);
  if (!gameCert.ok) return { ok: false, stage: "goal-tree", errors: gameCert.errors };

  const embedding = embedLayoutInWorld(gameCert.layout);
  const transport = buildTransportObjects(game, gameCert.world, embedding.layout);
  // Ambient props give a TELL beat's empty world the lesson's object as context.
  // A DO beat already materializes the real objects (carryables / collect items),
  // so ambient props would just duplicate them — default them off for DO.
  const wantAmbient = opts.ambientProps ?? !exchange.action;
  const ambient = wantAmbient
    ? materializeBindingProps(bound.binding, pools, embedding.spec)
    : { objects: [], npcs: [] };

  const world: WorldSpec = {
    ...embedding.spec,
    objects: [...embedding.spec.objects, ...transport.objects, ...ambient.objects],
    npcs: [...(embedding.spec.npcs ?? []), ...ambient.npcs],
  };

  const worldCert = certifyWorldSpec(world);
  if (!worldCert.ok) return { ok: false, stage: "world", errors: worldCert.errors };

  return {
    ok: true,
    scene: {
      binding: bound.binding,
      game,
      world: worldCert.spec,
      layout: embedding.layout,
      transport: transport.placements,
    },
  };
}
