// shared/world-engine/kernel/town/item-move.ts
//
// THE ITEM LEDGER — the one atomic way an item changes hands, and the one
// definition of where an item may BE.
//
// THE INVARIANT (user law, 2026-07-28): every unit is in exactly ONE place at
// all times. Nothing is ever created by a move, nothing is ever destroyed by
// one, and a move that cannot complete leaves everything exactly where it
// started. "Items should not just disappear, and it shouldn't be possible for
// them to get duplicated either."
//
// WHY THIS MODULE EXISTS. The primitive was already right: `transferStock` is
// atomic and returns refusals to the source ("nothing vanishes"). What went
// wrong is that the busiest path in the game did not use it. The visible haul
// hand-rolled its own two-phase move — take at the source in one errand
// callback, put at the destination in another — and parked the goods in
// between on the transfer agreement's `carried` field. That field is a FIFTH
// location, and it is not one a player could ever point at: `complete`, `fail`
// and `cancel` all `delete a.carried`, so a haul that died after loading
// destroyed its cargo. A resident walked to the kitchen with a piece of wood and
// the wood ceased to exist.
//
// The mirror failure produced duplicates: code that "spawned" a loose prop for a
// glyph rather than MOVING a unit out of a stack, so the stack still held it and
// the ground held it too — one toy carried by two creatures.
//
// So: a move is a transaction between two LOCATIONS, and there is no in-between.
// A carrier's load lives in the carrier's hands. If its errand dies, the goods
// are simply on the creature, and the ordinary hands-empty banking disposes of
// them — the failure mode is "someone is holding a thing", never "the thing is
// gone".
//
// PURE. The host owns the actual maps (container stock, carried stacks, ground
// props) and supplies a `resolve` that views a location as a live `StockEndpoint`
// (its `stack` is ALIASED — mutations land in the real map). This module only
// enforces the algebra, so it stays testable without a world.

import {
  putStock,
  stackHead,
  stackUnits,
  takeGoods,
  transferStock,
  type StockEndpoint,
} from "./transfer.js";

/**
 * WHERE AN ITEM MAY BE. A closed set, deliberately — an item that is not in one
 * of these is lost, and the audit will say so.
 *
 * `building` (an unloaded building's inventory) and giving the town's stock a
 * real place are the declared follow-ups; they become variants here rather than
 * new machinery.
 */
export type ItemLocation =
  /** Loose on the floor at a point — a real prop a body can walk to. */
  | { kind: "ground"; x: number; y: number }
  /** Inside a container (a chest, a cupboard, the town yard). */
  | { kind: "container"; id: string }
  /** In a creature's hands — what it is visibly holding, including mid-haul. */
  | { kind: "hands"; cid: string }
  /** In a creature's hidden inventory (the bag). */
  | { kind: "inventory"; cid: string };

/** A location as a live, aliased stack view. Null = this location does not
 *  exist right now (an unstreamed container, a body that isn't loaded). */
export type ResolveLocation = (loc: ItemLocation) => StockEndpoint | null;

export type MoveFailure =
  /** The source could not be resolved — nothing was touched. */
  | "no-source"
  /** The destination could not be resolved — nothing was touched. */
  | "no-dest"
  /** The source does not hold everything asked for — nothing was moved. */
  | "short"
  /** The destination could not take it all (capacity) — rolled back. */
  | "refused";

export interface MoveResult {
  ok: boolean;
  /** What actually ended up at the destination (empty on any failure). */
  moved: Record<string, number>;
  /** What could not be moved, by glyph. */
  missing: Record<string, number>;
  reason?: MoveFailure;
}

const totalOf = (r: Record<string, number>): number =>
  Object.values(r).reduce((s, n) => s + n, 0);

const isEmpty = (r: Record<string, number>): boolean => totalOf(r) === 0;

/**
 * THE ONE MOVE. All-or-nothing: either every requested unit ends up at `to`, or
 * nothing moves at all and the source is exactly as it was.
 *
 * All-or-nothing rather than best-effort on purpose. A partial move is how a
 * caller ends up believing it has materials it does not have — which is the
 * class of bug that wedged the craft pipeline (gather thought a haul covered the
 * bill, the labor gate found an empty spot, and neither could proceed). A caller
 * that genuinely wants "as much as fits" should ask for the amount it knows fits.
 */
export function moveItems(
  resolve: ResolveLocation,
  from: ItemLocation,
  to: ItemLocation,
  goods: Readonly<Record<string, number>>,
): MoveResult {
  const src = resolve(from);
  if (!src) return { ok: false, moved: {}, missing: { ...goods }, reason: "no-source" };
  const dst = resolve(to);
  if (!dst) return { ok: false, moved: {}, missing: { ...goods }, reason: "no-dest" };
  // Same place — a no-op, never a round trip that could round-off.
  if (src.stack === dst.stack) return { ok: true, moved: {}, missing: {} };

  // CHECK BEFORE TAKING: a source that cannot cover the whole bill is not
  // touched at all, so a shortfall can never leave a half-moved pile behind.
  const short: Record<string, number> = {};
  for (const [glyph, qty] of Object.entries(goods)) {
    const have = stackUnits(src.stack, glyph);
    if (have < qty) short[glyph] = qty - have;
  }
  if (!isEmpty(short)) return { ok: false, moved: {}, missing: short, reason: "short" };

  const { moved, missing } = transferStock(src, dst, goods);
  if (isEmpty(missing)) return { ok: true, moved, missing: {} };

  // THE DESTINATION REFUSED SOME (capacity). `transferStock` already returned
  // the refused units to the source; roll the ACCEPTED ones back too, so the
  // move is all-or-nothing rather than a silent partial.
  const back = takeGoods(dst.stack, moved);
  for (const [g, n] of Object.entries(back)) {
    src.stack[g] = (src.stack[g] ?? 0) + n;
  }
  return { ok: false, moved: {}, missing, reason: "refused" };
}

/**
 * A CRAFT IS ONE TRANSACTION: the inputs stop existing at the same instant the
 * product starts existing (user law). Never "consume, then hope the product
 * lands" — that is how a craft can eat its materials and produce nothing.
 *
 * Inputs are drawn from `at`, the product appears at `at`. A caller that wants
 * the product somewhere else moves it afterwards, through `moveItems`, which is
 * itself atomic.
 */
export function craftItems(
  resolve: ResolveLocation,
  at: ItemLocation,
  consumes: Readonly<Record<string, number>>,
  produces: string,
  count = 1,
): MoveResult {
  const ep = resolve(at);
  if (!ep) return { ok: false, moved: {}, missing: { ...consumes }, reason: "no-source" };

  const short: Record<string, number> = {};
  for (const [glyph, qty] of Object.entries(consumes)) {
    const have = stackUnits(ep.stack, glyph);
    if (have < qty) short[glyph] = qty - have;
  }
  if (!isEmpty(short)) return { ok: false, moved: {}, missing: short, reason: "short" };

  const taken = takeGoods(ep.stack, consumes);
  const { accepted, refused } = putStock(ep, { [produces]: count });
  if (!isEmpty(refused)) {
    // No room for what we just made — put the ingredients back and report. The
    // craft did NOT happen; nothing was consumed.
    for (const [g, n] of Object.entries(taken)) ep.stack[g] = (ep.stack[g] ?? 0) + n;
    for (const [g, n] of Object.entries(accepted)) {
      const put = takeGoods(ep.stack, { [g]: n });
      void put;
    }
    return { ok: false, moved: {}, missing: refused, reason: "refused" };
  }
  return { ok: true, moved: accepted, missing: {} };
}

/**
 * TOTAL UNITS PER GLYPH HEAD across a set of locations — the conservation audit.
 * Take it before an operation and after; any difference is an item created or
 * destroyed, which is a bug by definition. Heads rather than full glyphs so a
 * legitimate facet change (a craft's `wood` → `blocks.material_wood`, a wash's
 * `.dirty` drop) is not read as a leak — those are transformations, and a caller
 * comparing them should audit the specific heads it expects to change.
 */
export function auditStacks(endpoints: Iterable<StockEndpoint | null>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ep of endpoints) {
    if (!ep) continue;
    for (const [glyph, n] of Object.entries(ep.stack)) {
      if (!n) continue;
      const head = stackHead(glyph);
      out[head] = (out[head] ?? 0) + n;
    }
  }
  return out;
}

/** Difference between two audits — empty when conservation held. Positive =
 *  units appeared, negative = units vanished. */
export function auditDelta(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const head of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[head] ?? 0) - (before[head] ?? 0);
    if (d !== 0) out[head] = d;
  }
  return out;
}
