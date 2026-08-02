// shared/world-engine/interaction/content/item-prop.ts
//
// THE ONE APPEARANCE OF A THING THAT IS NOT INSTALLED.
//
// User law (2026-08-02): "there should really only be one rendering method for
// furniture items, the 3D model on its side, because it's always the same
// object… The multiple rendering methods suggest a deeper problem if they're all
// being treated differently."
//
// They were. Six places built an ObjectSpec for the same item and disagreed
// about all of it — the loose-prop spawn (a 0.35 m sphere), the carried-goods
// display prop (0.28 m), the mirror prop shown on a table (0.3 m, no carry), the
// take-off-a-shelf conversion (0.3 m, carry), the standing fixture, and the
// deconstructed piece. So one apple had four sizes and one chair three
// appearances, depending on which code path last touched it.
//
// A chair taken apart, a chair being carried across the room and a chair
// delivered but not yet assembled are ONE THING IN THREE SITUATIONS. This module
// is the only place that answers what it looks like.
//
// THE TWO ANSWERS
//   • furniture  → its real archetype model at its real radius, lying on its
//                  side (`setUp: false` — the pose the renderer already has for
//                  furniture that is not in place), and NOT SOLID, because a
//                  piece is on the floor precisely because it was in somebody's
//                  way and a fixture's default solidity would keep it there.
//   • everything else → its own glyph at one radius. An apple keeps its icon.
//
// Nothing here knows why the item is loose. That is the point: the spec is a
// fact about the OBJECT, never about the errand that produced it.

import { containerDefOfGlyph, INSTANCE_SLOTS } from "../../kernel/town/containers.js";
import { furnitureItemOf, furnitureKindOfGlyph } from "../../kernel/town/stations.js";
import type { ObjectInteraction, ObjectSpec } from "../../types.js";
import { drawnMakeable } from "./makeable.js";

/** The radius a loose, non-furniture item stands at. ONE number, because it is
 *  the same apple whether it is on a table, in a hand or on the floor — the
 *  three former numbers (0.28 / 0.3 / 0.35) encoded nothing but which function
 *  had written it. Furniture ignores this and uses its own registry radius. */
export const LOOSE_ITEM_R = 0.3;

export interface ItemPropOpts {
  /**
   * May hands take it? A MIRROR prop — one drawn on a table to show a single
   * unit of the container's stack — says NO: lifting it would take the unit out
   * from under the count and the props and the ledger would drift apart. Every
   * other loose item says yes. Default true.
   */
  carry?: boolean;
}

/**
 * The world object for one unit of `glyph` sitting at `at`.
 *
 * The caller owns the LEDGER (item-move.ts) and the id; this owns the
 * appearance and the affordances, and nothing else.
 */
export function itemObjectSpec(
  glyph: string,
  id: string,
  at: { x: number; y: number },
  opts?: ItemPropOpts,
): ObjectSpec {
  const interactions: ObjectInteraction[] = opts?.carry === false ? [] : ["carry"];
  // A CONTAINER IS A CONTAINER WHEREVER IT IS (step ②). A barrel on its side
  // still holds its water and a basket on the floor can still be filled, so the
  // containment slot travels with the object rather than being a privilege of
  // standing furniture. `INSTANCE_SLOTS` is whole objects shown, never units.
  const cdef = containerDefOfGlyph(glyph);
  const contains = cdef
    ? { contains: [{ relation: cdef.relation, capacity: INSTANCE_SLOTS }] }
    : {};
  const kind = furnitureKindOfGlyph(glyph);
  const fdef = kind ? furnitureItemOf(kind) : undefined;
  if (kind && fdef) {
    return {
      id,
      x: at.x,
      y: at.y,
      shape: "box",
      radius: fdef.radius,
      // The archetype the STANDING piece uses, so a carried chair and an
      // installed chair are visibly the same chair.
      fixture: kind,
      solid: false,
      setUp: false,
      facing: 0,
      interactions,
      ...contains,
    };
  }
  // `drawnMakeable` is the identity for everything that reaches here (a stack
  // whose head needs redrawing is furniture, handled above) — it stays because
  // the DRAWING RULE belongs in one place, not because this branch bends it.
  return {
    id,
    x: at.x,
    y: at.y,
    shape: "sphere",
    radius: LOOSE_ITEM_R,
    glyph: drawnMakeable(glyph),
    interactions,
    ...contains,
  };
}
