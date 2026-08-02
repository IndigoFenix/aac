/**
 * blueprint.ts — THE BLUEPRINT AND THE HOUSE ARE TWO DIFFERENT THINGS.
 *
 * THE BLUEPRINT is where everything SHOULD be. It is a pure function of the
 * floor plan as it stands right now: add a room, empty one, tear one down, and
 * the blueprint re-draws itself as if it had always been that way — furniture
 * clear of the doorways, clear of the walking lanes, kitchen things in the
 * kitchen once there IS a kitchen. It owes nothing to history.
 *
 * THE HOUSE is where everything actually IS. Bodies collide with it, routes are
 * planned around it, a bed you can see is a bed you can lie in.
 *
 * The two are ALLOWED to disagree, and the disagreement is the whole point: it
 * is the WORK LIST. A blueprint slot with nothing standing on it is a want; a
 * piece standing off every slot is either the thing that want is waiting for
 * (carry it over) or homeless (take it apart). Nothing in this module moves
 * anything — it states the difference, and the director turns each row into an
 * errand somebody walks.
 *
 * A PLACE IS NOT A POSSESSION. Each planned position LINKS to the piece
 * standing on it, and the link is re-derived every pass rather than stored —
 * so a piece removed by any means at all, expected or not, simply fails to
 * link, and its place goes straight back to asking for one.
 *
 * WHY THIS EXISTS. The two used to be ONE derivation: `houseFurniture` was read
 * both as "the ideal" and as "the truth", so the moment a room was added every
 * piece in the house JUMPED to its new ideal spot in a single frame. The fix at
 * the time pinned displaced pieces where they stood, which stopped the jumping
 * by stopping the rearranging — the household could never tidy up again. Both
 * halves were right about one thing: furniture IS supposed to be rearranged; it
 * is just not supposed to rearrange ITSELF. Splitting the two makes that
 * expressible — the blueprint changes instantly (it is a drawing), the house
 * changes at walking pace (it is furniture).
 *
 * Kernel layering: pure geometry + arithmetic over the delta rows. No session,
 * no clock, no renderer.
 */

import type { BuildingDelta, PlacedPiece } from "./construction.js";
import type { FurniturePiece } from "./placement.js";
import type { HouseRoom } from "./rooms.js";
import type { StationKind } from "./stations.js";

/**
 * A row the blueprint reads as a DECISION rather than a fact — one it keeps
 * exactly as written and arranges everything else around.
 *
 * Only two kinds qualify. The player's own placement (`pinned`), because an
 * order IS a change to the drawing. And a hung door (`doorway`), which is not
 * floor furniture at all — it lives inside a wall, and the wall is the plan's
 * business.
 *
 * EVERYTHING ELSE IS A FACT: every materialized piece, standing wherever it
 * has ended up. Reading those as decisions is what would freeze a house's
 * arrangement to its own history — the oven that landed in the main room
 * because there was no kitchen would keep the main room as its rightful place
 * forever.
 */
function isDrawn(p: PlacedPiece): boolean {
  return !!p.pinned || p.doorway !== undefined;
}

/**
 * THE DELTA AS THE BLUEPRINT READS IT.
 *
 * ONE LINE CARRIES THE WHOLE SPLIT: `materialized: false`. The station
 * generator is the only thing in the engine that knows where a bed belongs in a
 * house shaped like this, and it must keep answering that question for as long
 * as the house keeps changing shape. What must stop is reading its answer as
 * the furniture. So the house stops generating (materialized) and the drawing
 * never does — same function, same rules, two different questions.
 *
 * Everything recording where a piece merely HAPPENS to be is stripped with it,
 * leaving the plan and the player's own decisions and nothing else. A stripped
 * row takes any `removedPieces` twin with it, so the generator re-emits that
 * piece at the spot it BELONGS at — and that spot is what somebody carries it
 * to.
 *
 * Returns the delta UNCHANGED (same reference) when there is nothing to strip:
 * an untouched building has no placed rows and has never materialized, so its
 * drawing and its furniture are literally the same derivation and no sweep
 * anywhere can find work to do. Memos keyed on identity keep hitting, too.
 */
export function blueprintDelta(delta: BuildingDelta | undefined): BuildingDelta | undefined {
  if (!delta) return delta;
  const drift = delta.placed.filter((p) => !isDrawn(p));
  if (!drift.length && !delta.materialized) return delta;
  const ids = new Set(drift.map((p) => p.id));
  return {
    ...delta,
    materialized: false,
    placed: delta.placed.filter(isDrawn),
    removedPieces: delta.removedPieces.filter((id) => !ids.has(id)),
  };
}

/** Could this building's furniture possibly disagree with its drawing? The
 *  cheap gate the reconciling sweeps ask of every building they pass, BEFORE
 *  paying for a room plan and a furnish pass. False = the two are the same
 *  derivation and the difference is empty by construction. */
export function hasDrift(delta: BuildingDelta | undefined): boolean {
  return !!delta && (!!delta.materialized || delta.placed.some((p) => !isDrawn(p)));
}

/** One place in the drawing: a piece of `kind`, standing HERE, in this room.
 *  Geometrically a FurniturePiece — it is the very thing `furnishPlan` would
 *  emit — plus the room it falls in, which the tasks need and containment
 *  would otherwise have to re-derive at every reader. */
export interface BlueprintSlot extends FurniturePiece {
  roomId: string;
}

/** Tag each ideal piece with the room it stands in. A piece outside every room
 *  (should not happen — the fit rule searches inside zones) is dropped rather
 *  than guessed at. */
export function blueprintSlots(
  pieces: readonly FurniturePiece[],
  rooms: readonly HouseRoom[],
): BlueprintSlot[] {
  const out: BlueprintSlot[] = [];
  for (const p of pieces) {
    const room = rooms.find(
      (r) =>
        p.x >= r.rect.x && p.x <= r.rect.x + r.rect.w &&
        p.y >= r.rect.y && p.y <= r.rect.y + r.rect.h,
    );
    if (room) out.push({ ...p, roomId: room.id });
  }
  return out;
}

/**
 * HOW CLOSE COUNTS AS "THERE", in metres. A piece within this of its slot is
 * standing in its place — nobody carries a bed 4 cm across a room. The same
 * epsilon the displacement record uses to decide a piece moved at all, so the
 * two can never disagree about whether a piece is home.
 */
export const AT_SLOT_M = 0.05;

/** What the house owes the blueprint, or the blueprint owes the house. */
export type FurnishAct =
  /** A piece of this kind is standing in the wrong place — carry it over. */
  | "move"
  /** One is in a storage box — take it out and stand it up. */
  | "install"
  /** There isn't one anywhere — make it. */
  | "make"
  /**
   * NO PLACE FOR THIS UNDER THE NEW PLANS — take it apart where it stands.
   * The re-draw produces this as readily as it produces a want: a chest whose
   * room came down, a fourth chair around a table that seats three. Taking it
   * apart rather than shoving it into a cupboard is the honest end, and it puts
   * the piece back into circulation as the item it is made of — which the very
   * next pass may well carry to a place that IS asking for one.
   */
  | "deconstruct";

export interface FurnishTask {
  act: FurnishAct;
  kind: StationKind;
  /**
   * Where it goes. Absent for a `deconstruct` (there is no destination — the
   * piece stops being furniture where it stands), and absent for a `make`
   * answering a room that HAS NOT RISEN YET — the drawing
   * knows the bedroom will want a bed long before there is a floor to put one
   * on, and waiting for the walls to make it would idle the whole build.
   */
  slot?: BlueprintSlot;
  /** What to act on. Present for `move` and `deconstruct`; absent for the two acts
   *  that start from nothing standing (`install`, `make`). */
  from?: FurniturePiece;
}

/**
 * THE DIFFERENCE, as a work list — in three passes, in this order, because the
 * order is what makes the answers cheap and obvious:
 *
 *   1. LINK. Every planned position asks whether the furniture it calls for is
 *      already standing on it, and binds to that piece if so.
 *   2. SURPLUS. Everything left unlinked is, by definition, furniture that has
 *      no place under the new plans — the removal set. It is worked out BEFORE
 *      any want is answered, because it is the pool every want draws from.
 *   3. FILL. Each unfilled position takes the nearest piece out of the surplus
 *      (a household carries the bed closest to the empty bedroom, not the one
 *      at the far end); failing that, a unit out of storage; failing that, the
 *      position keeps a STANDING ORDER to buy or build one.
 *
 * Whatever is still in the surplus when every position has been answered is
 * genuinely spare, and comes apart.
 *
 * Doing it this way is what stops a house commissioning a second bed while the
 * first stands in the hall: a piece out of place is not missing, it is
 * AVAILABLE, and it is available before anything asks.
 *
 * THE STREET-GOOD BOXES ARE IN IT NOW. They used to be exempt from every
 * furniture-editing path, because the generator re-emitted them unconditionally
 * and touching one duplicated a unit. A materialized box is an ordinary row, so
 * that trap is gone — and it has to be, because the corner rule moves a
 * refrigerator into the kitchen the day a kitchen appears, and THAT is a carry
 * like any other. A box is matched to its own good rather than merely to its
 * kind (two chests are not interchangeable if one of them is the pantry), and
 * it is never taken apart: a household without its pantry has nowhere to shop into.
 */
export function reconcileFurnishing(opts: {
  slots: readonly BlueprintSlot[];
  standing: readonly FurniturePiece[];
  /** Units of this kind sitting in the building's own storage. */
  stored: (kind: StationKind) => number;
  /**
   * KINDS AN ORDERED ROOM WILL WANT, whose room has not risen yet — there is no
   * slot to name because there is no floor. They are answered here anyway, for
   * the reason a builder orders the doors before the walls are up: a bed takes
   * as long to make as the room takes to build, and making them in sequence
   * doubles the wait for nothing.
   *
   * A pending want RESERVES a spare piece exactly the way a real slot does, so
   * a bed left over from a demolished room is HELD for the bedroom being built
   * rather than stowed and then commissioned again.
   */
  pending?: readonly StationKind[];
}): FurnishTask[] {
  // A HUNG LEAF never reaches either list — `furnishPlan` drops doorway-pinned
  // rows before anything enumerates furniture, because a door is part of the
  // wall. So "the drawing has no place for this door" cannot arise.
  const slots = opts.slots;
  const at = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
    Math.hypot(a.x - b.x, a.y - b.y) <= AT_SLOT_M;
  /** Would this piece SATISFY this position? Kind, and — for a street-good box —
   *  the good itself: the pantry and a plain chest are both chests, and only
   *  one of them can stand in the pantry's corner. */
  const fits = (p: FurniturePiece, s: BlueprintSlot): boolean =>
    p.kind === s.kind && p.good === s.good;

  // ── 1. LINK. Own id first (a piece keeps its id across a re-draw, so this is
  // the identity case and worth being exact about), then anything that fits and
  // is standing on the mark. The link is re-derived here on every pass and is
  // never stored on the position — which is precisely what makes the drawing
  // self-correcting: a piece removed unexpectedly (broken to clear a doorway,
  // carried off, lost with its room) simply fails to link next pass, and its
  // place goes back to asking for one. A place is not a possession.
  const linked = new Map<string, FurniturePiece>();
  const claimed = new Set<string>();
  for (const pass of [0, 1] as const) {
    for (const s of slots) {
      if (linked.has(s.id)) continue;
      const hit = opts.standing.find(
        (p) => !claimed.has(p.id) && fits(p, s) && at(p, s) && (pass === 1 || p.id === s.id),
      );
      if (!hit) continue;
      claimed.add(hit.id);
      linked.set(s.id, hit);
    }
  }

  // ── 2. SURPLUS: everything the drawing did not just account for. Worked out
  // in full before a single want is answered, because this is the pool.
  const surplus = opts.standing.filter((p) => !claimed.has(p.id));
  const taken = new Set<string>();

  // ── 3. FILL, in blueprint order (the station registry's own order, which is
  // deterministic and already semantics: the table claims the middle before the
  // chairs look for its sides). A stored budget is spent as it is promised, so
  // two empty bedrooms and one stored bed produce one install and one standing
  // order, never two installs of the same unit.
  const budget = new Map<StationKind, number>();
  const out: FurnishTask[] = [];
  const fromSurplus = (want: BlueprintSlot | { kind: StationKind; good?: string }) => {
    let best: FurniturePiece | null = null;
    let bestD = Infinity;
    for (const p of surplus) {
      if (taken.has(p.id) || p.kind !== want.kind || p.good !== want.good) continue;
      const d = "x" in want ? Math.hypot(p.x - want.x, p.y - want.y) : 0;
      if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && best && p.id < best.id)) {
        best = p;
        bestD = d;
      }
    }
    return best;
  };
  const fromStore = (kind: StationKind): boolean => {
    if (!budget.has(kind)) budget.set(kind, opts.stored(kind));
    const have = budget.get(kind)!;
    if (have <= 0) return false;
    budget.set(kind, have - 1);
    return true;
  };

  for (const s of slots) {
    if (linked.has(s.id)) continue;
    const spare = fromSurplus(s);
    if (spare) {
      taken.add(spare.id);
      out.push({ act: "move", kind: s.kind, slot: s, from: spare });
      continue;
    }
    // A GOODS BOX HAS NO SUBSTITUTE. Nothing in a store cupboard can become the
    // pantry, and nothing should be built to replace one — a good's box comes
    // with the good. If its own box is nowhere in the house, the place waits.
    if (s.good) continue;
    if (fromStore(s.kind)) {
      out.push({ act: "install", kind: s.kind, slot: s });
      continue;
    }
    out.push({ act: "make", kind: s.kind, slot: s }); // the standing order
  }

  // ── THE ROOMS STILL BEING BUILT. Same ladder, one rung shorter: there is
  // nowhere to carry a piece TO yet, so a surplus piece and a unit in a box both
  // simply wait — the install happens when the floor exists. Only "we haven't
  // got one at all" is actionable this early, and it is the one worth acting on
  // early: a bed takes about as long to make as a room takes to raise.
  for (const kind of opts.pending ?? []) {
    const spare = fromSurplus({ kind });
    if (spare) {
      taken.add(spare.id); // HELD for the room going up — not spare after all
      continue;
    }
    if (fromStore(kind)) continue; // waiting in a box
    out.push({ act: "make", kind });
  }

  // ── WHAT IS GENUINELY SPARE comes apart where it stands and goes back to
  // being the item it is made of. Never a street-good box: a household without
  // its pantry has nowhere to shop into, and the drawing always has a corner for
  // one — a goods box with no place means the drawing is momentarily confused,
  // not that the box is spare.
  for (const p of surplus) {
    if (taken.has(p.id) || p.good) continue;
    out.push({ act: "deconstruct", kind: p.kind, from: p });
  }
  return out;
}

/**
 * IS THIS PIECE WHERE IT BELONGS? The single-piece question the bump rule asks:
 * a body pressed against furniture wants to know whether the thing in its way
 * is part of the house or part of the mess, and only the second may be taken
 * apart to get past.
 */
export function pieceAtItsSlot(
  piece: { id: string; kind: StationKind; x: number; y: number },
  slots: readonly BlueprintSlot[],
): boolean {
  return slots.some(
    (s) => s.kind === piece.kind && Math.hypot(s.x - piece.x, s.y - piece.y) <= AT_SLOT_M,
  );
}

/**
 * MAKE THE FURNITURE REAL: the derived pieces of a building, as the delta rows
 * that from now on ARE that building's contents.
 *
 * Same ids as the generated pieces they stand in for, so container stock maps,
 * use-anchors, goods bindings and every other id-keyed thing survive the change
 * of custody without noticing it happened. A piece already recorded (the player
 * placed it, a delivery stood it up) keeps its existing row untouched.
 *
 * Pure — the caller writes the rows and sets the flag together, because a
 * building observed materialized with an empty `placed` list would be a house
 * whose furniture vanished.
 */
export function materializedRows(
  pieces: readonly FurniturePiece[],
  rooms: readonly HouseRoom[],
  existing: readonly PlacedPiece[],
): PlacedPiece[] {
  const have = new Set(existing.map((p) => p.id));
  const out: PlacedPiece[] = [];
  for (const p of pieces) {
    if (have.has(p.id)) continue;
    const room = rooms.find(
      (r) =>
        p.x >= r.rect.x && p.x <= r.rect.x + r.rect.w &&
        p.y >= r.rect.y && p.y <= r.rect.y + r.rect.h,
    );
    out.push({
      id: p.id,
      kind: p.kind,
      x: p.x,
      y: p.y,
      radius: p.radius,
      facing: p.facing,
      openable: p.openable,
      // A piece standing outside every room (it happens on the frame a room
      // comes down) is still furniture and still has to be recorded, or
      // materializing would quietly destroy it. It files under the first room
      // and the work list carries it somewhere sensible.
      roomId: room?.id ?? rooms[0]?.id ?? "",
      ...(p.setUp !== undefined ? { setUp: p.setUp } : {}),
      ...(p.good !== undefined ? { good: p.good } : {}),
    });
  }
  return out;
}
