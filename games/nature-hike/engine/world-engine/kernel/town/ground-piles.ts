// shared/world-engine/kernel/town/ground-piles.ts
//
// A PILE IS WHAT A SETTLEMENT HAS BEFORE IT HAS A BOX (piles-not-boxes-round.md).
//
// USER LAW (2026-09-10, verbatim): *"in general, items should be stored in piles
// that are generated spontaneously when needed - boxes help with organization and
// fulfill a need for tidiness but they shouldn't be required for the behavior of
// collection. Very similar to the spontaneous generation of a non-physical
// building on a new site to hold furniture that doesn't have a place yet. These
// loose piles should get moved to boxes when one exists, just as outdoor
// furniture should get moved to a building when the appropriate building exists.
// (Not instantly - they should create tasks to move them to the proper
// locations.)"*
//
// 🚨 NOTHING HERE IS A NEW OBJECT FAMILY. A ground pile is a REGISTERED
// CONTAINER (`registerContainer(session, id, "on", null, stock)`) whose world
// object carries no fixture and no mesh, so its CONTENTS are the visible thing —
// exactly what `relation: "on"` already means everywhere else in the game. Its
// id falls through `parseScopeId` to `{kind:"container"}` and therefore through
// `stockEndpointOf`'s generic registered-container branch, so it is at once
//   • a DEPOSIT destination (`applyNeedStepEffect`'s deposit arm),
//   • a HUNGER source      (`bodyNeedCtx`'s home/storage walks),
//   • a HAUL source        (`stockEndpointOf` → `looseGoodOf` → `decideCollect`)
// with no new branch in any of the three. That triple is the whole reason a bare
// `small:` heap could never be a larder (pull-labor-round.md ITEM 3 / R-D).
//
// This module is the PURE half: the id vocabulary, the deterministic ground slot
// a head's pile stands on, and the pile→box task derivation. No world, no
// session, no clock — every consumer hands in the rows it has already read.

/** The ground-pile id prefix. Deliberately NOT registered in scope.ts: a
 *  `pile:` id must fall through `parseScopeId` to `{kind:"container"}` so the
 *  generic registered-container arm of `stockEndpointOf` answers for it. Giving
 *  it a `ScopeRef` variant would mean writing (and keeping) a second endpoint
 *  derivation for a thing that is an ordinary container in every respect. */
export const GROUND_PILE_PREFIX = "pile:";

/** ONE PILE PER GOOD HEAD PER SETTLEMENT. `head` is the DEPOSITING ROW's own
 *  good key — nothing in this module (or any caller) ever names "food": the row
 *  that deposits says what the pile is a pile of, which is why a world whose
 *  bodies eat something else needs no change here. */
export function groundPileId(head: string): string {
  return `${GROUND_PILE_PREFIX}${head}`;
}

export function isGroundPileId(id: string): boolean {
  return id.startsWith(GROUND_PILE_PREFIX);
}

/** The head a pile id names, or `""` for an id that is not one. */
export function groundPileHead(id: string): string {
  return isGroundPileId(id) ? id.slice(GROUND_PILE_PREFIX.length) : "";
}

/** How far off its anchor a pile stands (metres). Comfortably inside the 4 m
 *  `COLLECT_MIN_TRIP_M` veto, so a pile beside the site crate is put away by
 *  the books rather than by walking somebody 1.3 m — the director's own
 *  co-located law, which the collect rows below restate from the pile's side. */
export const PILE_RING_M = 1.8;

/**
 * WHERE THIS HEAD'S PILE STANDS, relative to the settlement's deposit anchor.
 *
 * Deterministic in the head alone (a string hash → an angle on a ring), so two
 * readers — the mint and every later `containerAnchor` — cannot disagree, a
 * reload puts the pile back where it was, and two heads do not stack on one
 * spot. No RNG, no session, no insertion order.
 */
export function groundPileSlot(head: string): { dx: number; dy: number } {
  let h = 2166136261 >>> 0; // FNV-1a, the engine's ordinary string hash shape
  for (let i = 0; i < head.length; i++) {
    h ^= head.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const a = (h / 4294967296) * Math.PI * 2;
  return { dx: Math.cos(a) * PILE_RING_M, dy: Math.sin(a) * PILE_RING_M };
}

// ── OUTDOOR FURNITURE → BUILDING (ruling 5) ─────────────────────────────────
//
// The user's SECOND example of the same law: *"outdoor furniture should get
// moved to a building when the appropriate building exists"*. The move is
// already a task (`stepBlueprintReflow`: lift → carry → land); what was missing
// is that the furnish sweep could not SEE a piece standing outside a room rect.
// The pure half of the widening is "whose doorstep is this?", below.

/** Distance from a point to a RECT — 0 for a point inside it. */
export function pointRectDistance(
  p: { x: number; y: number },
  r: { x: number; y: number; w: number; h: number },
): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/**
 * WHICH BUILDING A PIECE OF OPEN GROUND BELONGS TO — the nearest by
 * point-to-FOOTPRINT distance, ties broken on the key.
 *
 * 🚨 MEASURING TO THE RECT RATHER THAN TO THE CENTRE IS WHAT MAKES IT SAFE. A
 * piece standing in building B's bedroom is at distance 0 from B and can be
 * claimed by nobody else, so the outdoor arm can never steal a piece the
 * existing indoor arm already owns — the two rules cannot double-book one chair.
 */
export function nearestRectKey(
  p: { x: number; y: number },
  rects: readonly { key: string; rect: { x: number; y: number; w: number; h: number } }[],
): string | null {
  let bestKey: string | null = null;
  let bestD = Infinity;
  for (const r of rects) {
    const d = pointRectDistance(p, r.rect);
    if (bestKey === null || d < bestD || (d === bestD && r.key < bestKey)) {
      bestKey = r.key;
      bestD = d;
    }
  }
  return bestKey;
}

// ── PILE → BOX IS A TASK (ruling 4) ─────────────────────────────────────────

/** A stocked pile standing on the ground, as the caller already read it. */
export interface PileStanding {
  id: string;
  head: string;
  /** FREE units — what no reservation has already spoken for. */
  units: number;
  at: { x: number; y: number };
}

/** A registered container that could hold this head, as the caller read it. */
export interface AcceptingBox {
  id: string;
  at: { x: number; y: number };
  /** Units of room left; `Infinity` for an UNCAPPED destination (the yard, the
   *  site crate — `containerUnitCap` answers null for both). `<= 0` ⇒ it
   *  accepts nothing right now and is not a destination. */
  room: number;
  /** Does this box take that head at all? (A site crate takes building
   *  materials and nothing else — `isSiteMaterial`, "a builder's yard, not a
   *  pantry"; a house's `furn_<hi>_chest_<head>` takes exactly its own head.) */
  accepts(head: string): boolean;
  /** The place word a haul to it ANNOUNCES ("yard", "house", "storehouse") —
   *  the caller's own `collectDestOf` word, carried rather than re-derived so
   *  a self-issued row and the gaze's bill say the same thing out loud. */
  word: string;
}

/** ONE `collect:<dest>` link's worth of facts — priced by the caller exactly as
 *  `decideCollect` prices the gaze's own bill, so a self-issued row and a
 *  pointed-at one are the SAME bill from two provenances. */
export interface CollectRow {
  fromId: string;
  toId: string;
  head: string;
  units: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** The destination's spoken word — `AcceptingBox.word`, carried through. */
  destWord: string;
  /**
   * THE MESS, 0..1 — HOW MUCH OF THIS HEAP THIS TRIP PUTS AWAY
   * (`min(units, room) / units`).
   *
   * ⚖️ DEVIATION FROM THE ROUND'S LITERAL WORDING, and the reason is arithmetic:
   * the ruling said *"pile units ÷ box room, clamped"*, which is 0 for an
   * UNCAPPED destination (`room = Infinity` — the yard, the site crate) and
   * would therefore make the settlement's own shelf the one place a pile can
   * never be taken, the exact opposite of the ruling's intent. Read the other
   * way round it says the same thing about a chest (a nearly-full chest barely
   * dents the heap ⇒ a weak row) and the right thing about a yard (it takes the
   * lot ⇒ a whole chore). Still bounded, still only the two facts the ruling
   * names, and still WEAK by construction: the decider must beat the body's own
   * dinner before any of it happens.
   */
  urgency: number;
}

/**
 * EVERY PILE THAT HAS SOMEWHERE TO GO.
 *
 * ⚖️ THE WORTHWHILE GATE DECIDES *WHEN*, NOT THIS. These rows are offers; the
 * decider ranks them against the body's own dinner in the body's own currency
 * (`decideContribution`'s `bodyNetS > beatS`), so a hungry camp forages first
 * and tidies when idle — which is what "tidiness is a WEAK need" means once the
 * chore is a bill rather than a schedule.
 *
 * ⚖️ AND ON THE FRONTIER BEFORE THE HOUSE THERE ARE NONE: nothing accepts food,
 * so the larder pile simply stands, which is the user's law working rather than
 * a case handled.
 *
 * `minTripM` is the caller's `COLLECT_MIN_TRIP_M` — one definition of "this is a
 * trip, not bookkeeping", read from the puller's side.
 *
 * Deterministic: piles and boxes are visited in the order handed in, and for one
 * pile the NEAREST accepting box with room wins (ties by id).
 */
export function collectRowsFrom(
  piles: readonly PileStanding[],
  boxes: readonly AcceptingBox[],
  minTripM: number,
): CollectRow[] {
  const out: CollectRow[] = [];
  for (const pile of piles) {
    if (!(pile.units > 0)) continue;
    let best: { box: AcceptingBox; d: number } | null = null;
    for (const box of boxes) {
      if (box.id === pile.id) continue;
      if (!(box.room > 0)) continue;
      if (!box.accepts(pile.head)) continue;
      const d = Math.hypot(box.at.x - pile.at.x, box.at.y - pile.at.y);
      // 🚨 NEVER WALK A CO-LOCATED LEG — the same veto `decideCollect` applies,
      // stated here so a self-issued row cannot post what the gaze refuses.
      if (d <= minTripM) continue;
      if (!best || d < best.d || (d === best.d && box.id < best.box.id)) best = { box, d };
    }
    if (!best) continue;
    const units = Math.min(pile.units, best.box.room);
    if (!(units > 0)) continue;
    out.push({
      fromId: pile.id,
      toId: best.box.id,
      head: pile.head,
      units,
      from: { x: pile.at.x, y: pile.at.y },
      to: { x: best.box.at.x, y: best.box.at.y },
      destWord: best.box.word,
      urgency: Math.min(1, Math.max(0, units / pile.units)),
    });
  }
  return out;
}
