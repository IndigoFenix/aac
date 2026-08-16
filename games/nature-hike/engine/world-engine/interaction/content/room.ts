// shared/world-engine/interaction/content/room.ts
//
// The HYBRID ROOM model (planning-docs/symbol-learning-game-plan.md §6.4, the
// committed v1 room scope): a predefined world-engine SHELL (hand-authored
// staging — manifold, terrain, spawns, walls/buildings) plus procedural
// FILL-SLOTS the binder drops pool-bound props/NPCs into. It is the room-level
// analog of quote placeholder-binding (§6.2): authors control staging, the pool
// binder supplies the varying vocabulary under test.
//
// Design (Option A): the hybrid concept lives HERE, in the content layer, and
// lowers to an ordinary `content.kind:"sandbox"` WorldSpec that the EXISTING
// certifyWorldSpec validates — the world-engine stays a pure runtime. A
// content-layer "room" certification stage runs the fill-slot pre-checks
// (resolve / in-bounds / unique id / caps) before lowering, so authoring errors
// fail fast with clear messages; promoting fill-slots into the WorldSpec schema
// itself remains a future option.

import type { NpcMovement, NpcSpec, ObjectSpec, Vec2, WorldSpec } from "../../types.js";
import { WORLD_MAX_NPCS, WORLD_MAX_OBJECTS } from "../../types.js";
import { certifyWorldSpec } from "../../index.js";
import type { PoolDef, PoolId, PoolMember } from "@shared/world-engine/interaction/types.js";
import { materializesAsNpc, objectConfigForAffordance } from "@shared/world-engine/interaction/content/affordance.js";
import { randomMemberPicker, type MemberPicker } from "@shared/world-engine/interaction/content/quote.js";

const ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** A procedural fill-slot: a place in the shell a pool-bound prop/NPC drops into. */
export interface RoomSlot {
  /** Becomes the generated object/NPC id — must be a valid, unique world id. */
  id: string;
  /** Which pool fills it. */
  pool: PoolId;
  /** Placement anchor, world units (must be inside the shell manifold). */
  at: Vec2;
  /** Materialization override. Defaults: receptive-npc → "npc", else "object". */
  as?: "object" | "npc";
  /** NPC movement when materialized as an NPC. Defaults to "stationary". */
  movement?: NpcMovement;
}

/** A predefined shell + the fill-slots that complete it. */
export interface HybridRoomSpec {
  id: string;
  /** The hand-authored static scene; its own objects/npcs (if any) are kept. */
  shell: WorldSpec;
  slots: RoomSlot[];
}

export type RoomCertification =
  | { ok: true; spec: WorldSpec }
  | { ok: false; stage: "room" | "schema"; errors: string[] };

/** Per-slot member override (align a room prop to a quote's bound referent). */
export type RoomAlignment = Record<string, PoolMember>;

function slotMaterialization(slot: RoomSlot, pool: PoolDef): "object" | "npc" {
  return slot.as ?? (materializesAsNpc(pool.affordance) ? "npc" : "object");
}

/**
 * Bind + lower a hybrid room into a concrete WorldSpec (assumes pre-checks have
 * passed — call certifyHybridRoom for the validated path). Each slot draws a pool
 * member (an `align` override wins, else `pick`), materialized as an object or NPC
 * per its affordance, and appended to the shell.
 */
export function lowerHybridRoom(
  room: HybridRoomSpec,
  pools: Record<string, PoolDef>,
  pick: MemberPicker = randomMemberPicker,
  align: RoomAlignment = {},
): WorldSpec {
  const objects: ObjectSpec[] = [...room.shell.objects];
  const npcs: NpcSpec[] = [...(room.shell.npcs ?? [])];

  for (const slot of room.slots) {
    const pool = pools[slot.pool];
    if (!pool) throw new Error(`room "${room.id}" slot "${slot.id}" references unknown pool "${slot.pool}"`);
    const member = align[slot.id] ?? pick(pool);

    if (slotMaterialization(slot, pool) === "npc") {
      npcs.push({
        id: slot.id,
        x: slot.at.x,
        y: slot.at.y,
        name: member.label,
        persona: { genderHint: "any" },
        behavior: { movement: slot.movement ?? "stationary" },
      });
    } else {
      objects.push({ id: slot.id, x: slot.at.x, y: slot.at.y, ...objectConfigForAffordance(pool.affordance) });
    }
  }

  return { ...room.shell, objects, npcs };
}

/**
 * Certify a hybrid room: fill-slot pre-checks (the content-layer "room" stage)
 * then lower + certifyWorldSpec (the world-engine schema stage). Returns the
 * lowered, certified WorldSpec or staged errors.
 */
export function certifyHybridRoom(
  room: HybridRoomSpec,
  pools: Record<string, PoolDef>,
  pick: MemberPicker = randomMemberPicker,
  align: RoomAlignment = {},
): RoomCertification {
  const { width, height } = room.shell.manifold;
  const errors: string[] = [];

  // Reserve every id the shell already uses, so fills can't collide.
  const taken = new Set<string>();
  for (const s of room.shell.spawns) taken.add(s.id);
  for (const o of room.shell.objects) taken.add(o.id);
  for (const s of room.shell.structures ?? []) taken.add(s.id);
  for (const b of room.shell.buildings ?? []) taken.add(b.id);
  for (const n of room.shell.npcs ?? []) taken.add(n.id);

  let addedObjects = 0;
  let addedNpcs = 0;
  for (const slot of room.slots) {
    const pool = pools[slot.pool];
    if (!pool) {
      errors.push(`slot "${slot.id}" references unknown pool "${slot.pool}"`);
      continue;
    }
    if (!ID_RE.test(slot.id)) errors.push(`slot id "${slot.id}" is not a valid world id`);
    if (taken.has(slot.id)) errors.push(`slot id "${slot.id}" collides with an existing id`);
    taken.add(slot.id);
    if (slot.at.x < 0 || slot.at.x > width || slot.at.y < 0 || slot.at.y > height) {
      errors.push(`slot "${slot.id}" at (${slot.at.x}, ${slot.at.y}) is outside the manifold`);
    }
    if (slotMaterialization(slot, pool) === "npc") addedNpcs += 1;
    else addedObjects += 1;
  }

  if (room.shell.objects.length + addedObjects > WORLD_MAX_OBJECTS) {
    errors.push(`room would have ${room.shell.objects.length + addedObjects} objects — max is ${WORLD_MAX_OBJECTS}`);
  }
  if ((room.shell.npcs?.length ?? 0) + addedNpcs > WORLD_MAX_NPCS) {
    errors.push(`room would have ${(room.shell.npcs?.length ?? 0) + addedNpcs} npcs — max is ${WORLD_MAX_NPCS}`);
  }

  if (errors.length) return { ok: false, stage: "room", errors };

  const cert = certifyWorldSpec(lowerHybridRoom(room, pools, pick, align));
  if (!cert.ok) return { ok: false, stage: "schema", errors: cert.errors };
  return { ok: true, spec: cert.spec };
}

// ---------------------------------------------------------------------------
// A default predefined shell + playroom (the staged space the beats sit in).
// ---------------------------------------------------------------------------

/** A simple walled playroom: a flat 24×18 manifold inside a one-storey building. */
export const PLAYROOM_SHELL: WorldSpec = {
  engine: "world",
  engineVersion: 1,
  meta: { title: "Playroom", locale: "en", theme: "bright learning playroom" },
  manifold: { kind: "flat", width: 24, height: 18 },
  terrain: { kind: "flat", groundColor: "#f2e9d8" },
  spawns: [{ id: "spawn_main", x: 12, y: 4 }],
  objects: [],
  buildings: [
    {
      id: "room_walls",
      footprint: { x: 2, y: 2, w: 20, h: 14 },
      floors: 1,
      wallThickness: 0.4,
      doorways: [{ edge: "south", offset: 10, width: 3 }],
    },
  ],
  npcs: [],
  multiplayer: { maxPlayers: 4, authority: "distributed" },
  content: { kind: "sandbox" },
};

/** The default hybrid playroom: a toy, a treat, and a friend the binder fills. */
export const DEFAULT_PLAYROOM: HybridRoomSpec = {
  id: "default_playroom",
  shell: PLAYROOM_SHELL,
  slots: [
    { id: "fill_toy", pool: "toy", at: { x: 7, y: 9 } },
    { id: "fill_treat", pool: "treat", at: { x: 17, y: 9 } },
    { id: "fill_friend", pool: "friend", at: { x: 12, y: 12 } },
  ],
};
