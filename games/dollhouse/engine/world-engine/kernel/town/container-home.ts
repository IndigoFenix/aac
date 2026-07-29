// shared/world-engine/kernel/town/container-home.ts
//
// THE OBJECT'S DESIGNATED CONTAINER — where a glyph BELONGS, and so where
// tidying returns it, where a give-up banks it and where a fetch looks first.
// ONE ladder, consulted by every one of those paths, so eviction and the
// happy path can never disagree about an item's home. Extracted from
// quest-host (which stays the only mutator of stacks) so the pure rule is
// importable without the 3D host, exactly like goods-kinds.

import { headOf } from "../../variations.js";
import { CLOTHING_HEADS, goodKeyOfGlyph } from "./goods-kinds.js";
import { HOUSEHOLD } from "./stations.js";

/** The session facts the ladder reads — quest-host wires these from the live
 *  QuestSession; a test hands in literals. */
export interface ContainerHomeCtx {
  /** Bare HEADS of the house's provisioned goods (street goods' kinds,
   *  treats, water) — quest-host's provisionedHeads(session, houseIndex). */
  provisionedHeads: ReadonlySet<string>;
  /** creature-world ownerId of the glyph, if someone owns it. */
  ownerId?: string | null;
  /** cid of the body doing the stowing, if any. */
  selfId?: string;
  /** Is this furniture id a registered container in the session? */
  exists: (id: string) => boolean;
}

/**
 * The ladder:
 *
 *   1. water            → the barrel
 *   2. a provisioned good → that good's chest (food's is the refrigerator)
 *   3. CLOTHING          → the cupboard (the cabinet) — clothes hang in a
 *                          cabinet, not a box; reached only when clothing
 *                          isn't provisioned (then rung 2's wardrobe chest
 *                          is their home)
 *   4. an OWNED object   → its owner's own box
 *   5. anything else     → the stower's own box, else any member's box
 *   6. no box at all     → the cupboard (every house has one)
 *
 * Deliberately NOT one communal "toy box": a box is a box, and what makes one
 * a toy box is only what happens to be inside it.
 */
export function designatedContainerId(
  glyph: string,
  houseIndex: number,
  ctx: ContainerHomeCtx,
): string {
  const head = headOf(glyph);
  if (head === "water") return `furn_${houseIndex}_barrel`;
  if (ctx.provisionedHeads.has(head)) {
    return `furn_${houseIndex}_chest_${goodKeyOfGlyph(glyph)}`;
  }
  const boxOf = (m: number) => `furn_${houseIndex}_box_${m}`;
  // A garment — clean or dirty; the HEAD routes, like every clothing rule —
  // belongs in the cabinet, never a member's box.
  if (CLOTHING_HEADS.includes(head) && ctx.exists(`furn_${houseIndex}_cupboard`)) {
    return `furn_${houseIndex}_cupboard`;
  }
  // An owned thing goes back to ITS owner's box, whoever is carrying it.
  const owned = ctx.ownerId ? /resident_\d+_(\d+)$/.exec(ctx.ownerId) : null;
  if (owned && ctx.exists(boxOf(Number(owned[1])))) return boxOf(Number(owned[1]));
  // Else the stower's own box — you put things away in your own.
  const self = ctx.selfId ? /resident_\d+_(\d+)$/.exec(ctx.selfId) : null;
  if (self && ctx.exists(boxOf(Number(self[1])))) return boxOf(Number(self[1]));
  for (let m = 0; m < HOUSEHOLD; m++) if (ctx.exists(boxOf(m))) return boxOf(m);
  return `furn_${houseIndex}_cupboard`;
}
