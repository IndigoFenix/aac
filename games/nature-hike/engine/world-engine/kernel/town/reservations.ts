/**
 * reservations.ts — the SPOKEN-FOR ledger over abstract stock (construction
 * pipeline ①, planning-docs/games/world-engine/construction-pipeline.md).
 *
 * Task-pool claims lock TASKS and ItemState.ownerId locks materialized
 * items, but nothing locked the UNITS a pending haul or build intends to
 * draw from a stack — two independently-issued orders could both target the
 * same three wood in the yard. A RESERVATION is that missing lock: `holder`
 * (a task / agreement / designation id) speaks for `qty` units of a material
 * HEAD on one endpoint. Free stock = what's actually in the stack minus what
 * is spoken for; material resolution only ever draws free stock.
 *
 * Reservations are INTENTS, not escrow: the stack itself is untouched (the
 * one-container law — the live map stays the single truth), so stock can
 * still shrink underneath a reservation (a fire, a hungry resident). The
 * honest shortfall surfaces at take time, exactly like a partial transfer.
 * Consumers therefore: `reserve` at resolution, `consume` as units actually
 * leave the stack, `release` on completion/failure/cancel — a released or
 * fully-consumed holder leaves no residue.
 *
 * `resolveMaterials` is the ONE "which stacks pay for this" step: costs
 * matched nearest-first to the work spot (distance, lexicographic id ties —
 * the chooseClaimant / planTransferSources law), drawing only free units and
 * reserving every draw under the holder. With an empty ledger it allocates
 * exactly like planTransferSources — reservation is the only difference.
 *
 * Serializable mutation layer (TownDeltas / TransferLedger pattern): rows in
 * creation order, toJSON round-trip, no RNG.
 *
 * Kernel layering: pure data + arithmetic; imports stay inside kernel/town.
 */

import {
  rankPricedSources,
  stackHead,
  stackUnits,
  takeStock,
  type PricedSourceOpts,
  type TransferSource,
} from "./transfer.js";
// ⚖️ F-④ (fold-round.md) — TYPE-ONLY, deliberately: `fold.ts` imports
// `scope.ts` which imports this file's own `transfer.ts`, so a VALUE import
// here would close a runtime cycle. The fold seat needs no values from us
// and we need none from it.
import type { FoldCommitment, FoldScope } from "./fold.js";

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export interface ReservationRow {
  id: string;
  /** WHO speaks for the units — a task / agreement / designation id. */
  holder: string;
  /** The endpoint (StockEndpoint id) whose stack the units sit in. */
  endpoint: string;
  /** The material HEAD ("wood", never "wood.wet" — facted variants pay
   *  toward their head, the spendCosts convention). */
  glyph: string;
  /** Units still spoken for (shrinks via consume, never below 0). */
  qty: number;
}

export interface SerializedReservationLedger {
  serial: number;
  rows: ReservationRow[];
}

export interface ReservationLedger {
  /** Speak for `qty` more units of `glyph`'s head on `endpoint` under
   *  `holder` — merges into the holder's existing row for that endpoint +
   *  head. Bookkeeping only (no stack check here — resolveMaterials or the
   *  caller checks free units first). Returns the row, or null for qty ≤ 0. */
  reserve(holder: string, endpoint: string, glyph: string, qty: number): ReservationRow | null;
  /** Units actually LEFT the stack under this holder — shrink the
   *  reservation to match (clamped; the row vanishes at 0). Returns the
   *  units actually released from the reservation. */
  consume(holder: string, endpoint: string, glyph: string, qty: number): number;
  /** Drop EVERY row this holder speaks for (complete / fail / cancel). */
  release(holder: string): void;
  /**
   * ⏸️ HOW MANY RELEASES HAVE ACTUALLY FREED UNITS — the town rung's second
   * wake signal (scope-behaviors.md §2.5.1: a job park "rides the same
   * `needsStockEpoch` plus the reservation ledger's own version — A RELEASED
   * CLAIM FREES UNITS FOR SOMEBODY ELSE'S JOB, which is precisely the event
   * `resolveMaterials` would find").
   *
   * A pure READ over bookkeeping the ledger already does; the only additive
   * behaviour is the counter itself. It counts releases that DROPPED ROWS,
   * never calls — the sweeps release finished agreement holders every pass and
   * almost all of those are already empty, so an unconditional counter would
   * tick every tick and a park keyed to it would never hold. Monotone;
   * deliberately COARSE (one counter for the whole ledger), exactly like
   * `needsStockEpoch`: it is a GATE, not the predicate.
   *
   * NOT serialized — a reload starts at 0 and every park that reads it is
   * session-lived too, so the pair can only ever agree (the restore-is-safe
   * argument the body-rung parks already make).
   */
  releaseEpoch(): number;
  /** Total units of `glyph`'s head spoken for on `endpoint`, all holders. */
  reservedUnits(endpoint: string, glyph: string): number;
  /** This holder's live rows, creation order (read-only view). */
  holderRows(holder: string): readonly ReservationRow[];
  toJSON(): SerializedReservationLedger;
}

export function createReservationLedger(json?: SerializedReservationLedger): ReservationLedger {
  let serial = json?.serial ?? 0;
  /** ⏸️ See `releaseEpoch` — session-lived, never serialized. */
  let releases = 0;
  const rows: ReservationRow[] = (json?.rows ?? []).map((r) => ({ ...r }));
  const drop = (r: ReservationRow) => {
    const i = rows.indexOf(r);
    if (i >= 0) rows.splice(i, 1);
  };
  return {
    reserve(holder, endpoint, glyph, qty) {
      const n = Math.floor(qty);
      if (n <= 0) return null;
      const head = stackHead(glyph);
      const row = rows.find(
        (r) => r.holder === holder && r.endpoint === endpoint && r.glyph === head,
      );
      if (row) {
        row.qty += n;
        return row;
      }
      const fresh: ReservationRow = { id: `res_${serial++}`, holder, endpoint, glyph: head, qty: n };
      rows.push(fresh);
      return fresh;
    },
    consume(holder, endpoint, glyph, qty) {
      const head = stackHead(glyph);
      const row = rows.find(
        (r) => r.holder === holder && r.endpoint === endpoint && r.glyph === head,
      );
      if (!row) return 0;
      const took = Math.min(row.qty, Math.max(0, Math.floor(qty)));
      row.qty -= took;
      if (row.qty <= 0) drop(row);
      return took;
    },
    release(holder) {
      const mine = rows.filter((r) => r.holder === holder);
      if (!mine.length) return; // nothing was freed — no event to report
      for (const r of mine) drop(r);
      releases++;
    },
    releaseEpoch: () => releases,
    reservedUnits(endpoint, glyph) {
      const head = stackHead(glyph);
      return rows
        .filter((r) => r.endpoint === endpoint && r.glyph === head)
        .reduce((s, r) => s + r.qty, 0);
    },
    holderRows: (holder) => rows.filter((r) => r.holder === holder),
    toJSON: () => ({ serial, rows: rows.map((r) => ({ ...r })) }),
  };
}

/**
 * THE HEAD A WHOLE-OBJECT TOOL CLAIM IS SPOKEN UNDER (step ④ ENABLE,
 * scope-behaviors.md §2.4/§2.6) — "the basket by the yard is mine for this
 * trip".
 *
 * A tool is not goods, so it has no glyph to reserve; but a tool IS a thing
 * there is exactly ONE of, and "one unit of it on the endpoint that is the tool
 * itself" is a legal row in this ledger with no new machinery, no new
 * lifecycle, and the same `release(holder)` every other claim already gets. The
 * `@` prefix keeps it out of the goods namespace — no glyph starts with one, so
 * a tool claim can never collide with a material head or be spent as stock.
 */
export const TOOL_CLAIM_GLYPH = "@tool";

/** Has anyone spoken for this whole object as a tool? (`endpoint` = the
 *  object's own id — see `TOOL_CLAIM_GLYPH`.) */
export function toolClaimed(ledger: ReservationLedger, objId: string): boolean {
  return ledger.reservedUnits(objId, TOOL_CLAIM_GLYPH) > 0;
}

/** Units of `glyph`'s head in the stack NOT spoken for — what resolution may
 *  draw. Floored at 0 (a stack that shrank under its reservations reads
 *  empty, not negative — the shortfall surfaces at take time). */
export function freeUnits(
  stack: Readonly<Record<string, number>>,
  ledger: ReservationLedger,
  endpoint: string,
  glyph: string,
): number {
  return Math.max(0, stackUnits(stack, glyph) - ledger.reservedUnits(endpoint, glyph));
}

/**
 * Free units over a count the caller ALREADY HAS, rather than over a stack map
 * — the same subtraction as `freeUnits`, for the two things a stack map cannot
 * express:
 *
 *   · a CATEGORY fold ("food" across apple/banana/cookie) or a derived count
 *     (a market shelf's units are a closed form over the clock, not a map);
 *   · `exceptHolder` — units this holder itself speaks for are NOT subtracted.
 *     A claimant must keep seeing its own reservation or it would re-decide
 *     away from its own plan the instant it made it, which is a spin, not a
 *     lock. (`freeUnits` has no such caller: material resolution asks before
 *     it reserves, never after.)
 *
 * Floored at 0, exactly like `freeUnits` — a count that shrank under its
 * reservations reads empty, and the shortfall surfaces at take time.
 */
export function freeUnitsOver(
  units: number,
  ledger: ReservationLedger,
  endpoint: string,
  glyph: string,
  exceptHolder?: string,
): number {
  const head = stackHead(glyph);
  let spoken = ledger.reservedUnits(endpoint, head);
  if (exceptHolder !== undefined) {
    for (const r of ledger.holderRows(exceptHolder)) {
      if (r.endpoint === endpoint && r.glyph === head) spoken -= r.qty;
    }
  }
  return Math.max(0, units - Math.max(0, spoken));
}

/** A COPY of the stack with every reservation on this endpoint taken out
 *  (per head, plain-stack-first — the takeStock order): what spendCosts /
 *  costsMet may honestly see. The live stack is untouched — spend from the
 *  REAL map only after the free copy covers the bill (free = real − reserved,
 *  so covering costs from free leaves the reserved units intact). */
export function unreservedStock(
  stack: Readonly<Record<string, number>>,
  ledger: ReservationLedger,
  endpoint: string,
): Record<string, number> {
  const out: Record<string, number> = { ...stack };
  const heads = new Set(Object.keys(stack).map(stackHead));
  for (const head of heads) {
    const r = ledger.reservedUnits(endpoint, head);
    if (r > 0) takeStock(out, head, r);
  }
  return out;
}

/**
 * ⚖️ A COPY of the stack with the COMMONS RESERVE taken out of every head that
 * has one — `unreservedStock`'s move, one floor further down (surplus control,
 * user addendum 2026-08-12).
 *
 * Two different subtractions, deliberately separate: `unreservedStock` removes
 * what SOMEBODY ELSE has spoken for (a fact about other orders), this removes
 * what the settlement KEEPS BACK from its own automated appetite (a policy
 * about this one). Compose them — spare ⊆ free ⊆ real — and a bill covered
 * from spare leaves both the reservations and the floor standing.
 *
 * `floorOf` answers per material HEAD; 0 (the usual answer) leaves the head
 * untouched, so a map with no reserved heads round-trips as a plain copy. The
 * live stack is never mutated.
 */
export function spareStock(
  stack: Readonly<Record<string, number>>,
  floorOf: (head: string) => number,
): Record<string, number> {
  const out: Record<string, number> = { ...stack };
  for (const head of new Set(Object.keys(stack).map(stackHead))) {
    const floor = floorOf(head);
    if (floor > 0) takeStock(out, head, floor);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Material resolution — the "which stacks pay for this" step
// ---------------------------------------------------------------------------

/** One planned draw: take `take` units of head `glyph` from `endpoint`. */
export interface MaterialDraw {
  endpoint: string;
  glyph: string;
  take: number;
}

/**
 * Resolve a recipe's costs against real stacks: CHEAPEST source first
 * (`rankPricedSources` — scope-behaviors.md §2.2's one priced walk, which is
 * nearest-first while every candidate prices the same, i.e. always, today),
 * FREE units only, reserving every draw under `holder` as it goes. Costs merge by
 * material head (a "wood.wet" cost pays toward "wood") in first-appearance
 * order. Partial resolution is honest: what exists is reserved, `shortfall`
 * names what no free stack covers (the recursion seam — post the tasks that
 * would produce it, or wait as a staked plot). A caller that wants
 * all-or-nothing checks `shortfall` and `release(holder)`s.
 */
export function resolveMaterials(opts: {
  holder: string;
  costs: Readonly<Record<string, number>>;
  sources: readonly TransferSource[];
  ledger: ReservationLedger;
  /** ⚖️ Pricing terms for the source walk (§2.2). Absent = the walk's own
   *  defaults, which reproduce the shipped nearest-first order exactly. The
   *  RESERVATION LIFECYCLE is untouched by this: ordering is the only thing
   *  the priced walk decides here. */
  price?: PricedSourceOpts;
}): { draws: MaterialDraw[]; shortfall: Record<string, number> } {
  const { holder, sources, ledger } = opts;
  // Merge costs by head, first-appearance order.
  const heads: string[] = [];
  const need: Record<string, number> = {};
  for (const [glyph, qty] of Object.entries(opts.costs)) {
    const head = stackHead(glyph);
    if (!(head in need)) heads.push(head);
    need[head] = (need[head] ?? 0) + Math.max(0, Math.floor(qty));
  }
  const draws: MaterialDraw[] = [];
  const shortfall: Record<string, number> = {};
  for (const head of heads) {
    let left = need[head] ?? 0;
    const ranked = rankPricedSources(
      sources,
      (s) => freeUnits(s.stack, ledger, s.id, head),
      opts.price,
    );
    for (const s of ranked) {
      if (left <= 0) break;
      const take = Math.min(left, freeUnits(s.stack, ledger, s.id, head));
      if (take <= 0) continue;
      ledger.reserve(holder, s.id, head, take);
      draws.push({ endpoint: s.id, glyph: head, take });
      left -= take;
    }
    if (left > 0) shortfall[head] = left;
  }
  return { draws, shortfall };
}

// ---------------------------------------------------------------------------
// ⚖️ F-④ — THE STOCK BOOK AT THE FOLD (fold-round.md stage F4)
// ---------------------------------------------------------------------------
//
// *"A commitment held by or against a folding scope either rides the record
// through (conserving, with the holder still able to consume/release it) or
// the fold REFUSES with the blockers named."*
//
// The stock book is the one of the three that RIDES. Why it can, stated so it
// can be checked rather than believed: a reservation is **pure bookkeeping
// over an endpoint id** — this module's own header, *"reservations are
// INTENTS, not escrow: the stack itself is untouched"*. `reserve`, `consume`
// and `release` never read or write a stack; they only move a number between
// "spoken for" and "not". So the same arithmetic runs verbatim over rows
// parked in a `FoldRecord`, and nothing about the folded scope's stock has to
// be consulted to keep a promise honest. The hands and legs books cannot say
// that (a claimed task is a body mid-errand; a moving transfer is goods on a
// road), which is exactly why F4 has them refuse instead.
//
// THE ROUND TRIP, and what "verbatim" does and does not cover: holder,
// endpoint, glyph and qty come back exactly, so `reservedUnits` before a fold
// equals `reservedUnits` after a full cycle (the conservation pin). The ROW ID
// does not — `reserve` mints a fresh `res_<serial>` — because the ledger has
// no re-post-with-id door and inventing one to preserve a string nobody keys
// off would be a wider change than the law asks for. Row ids are already
// session-scoped and unstable across a reload (`serial` restarts from the save
// value, holders are the stable name), so nothing reads them.

/** Every reservation row in creation order — the ledger's own audit view,
 *  which `toJSON` already answers (copies, so a reader cannot mutate the
 *  book by accident). Local: the gather below is the only caller. */
function allRows(ledger: ReservationLedger): readonly ReservationRow[] {
  return ledger.toJSON().rows;
}

/**
 * ⚖️ F-④ GATHER — every in-flight STOCK promise held BY or AGAINST `scope`,
 * as `FoldCommitment`s. READ-ONLY: the ledger is untouched (dropping the rows
 * is `releaseReservationCommitments`, which the fold calls only once the
 * record actually exists).
 *
 * A row matches when its ENDPOINT is one of the scope's ids (the usual case —
 * "these three wood in that yard are spoken for") or when its HOLDER is
 * (rarer: the stock book's holders are ROW IDS FROM THE OTHER BOOKS — `agr_7`,
 * `need:<cid>`, `craftspot:3` — so a scope is a holder only where a scope id
 * is spoken as one, e.g. a tool claim). `against` is the endpoint either way:
 * that is what the promise is booked against, however it was found.
 *
 * There is no "in-flight" test to make: a reservation row EXISTS only while it
 * is live (consume shrinks it, release drops it, and a fully-consumed row
 * vanishes — this module's own lifecycle), so every row is in flight.
 */
export function gatherReservationCommitments(
  ledger: ReservationLedger,
  scope: FoldScope,
): FoldCommitment[] {
  const ids = new Set<string>([scope.id, ...scope.endpoints]);
  const out: FoldCommitment[] = [];
  for (const r of allRows(ledger)) {
    if (!ids.has(r.endpoint) && !ids.has(r.holder)) continue;
    out.push({
      book: "reservation",
      id: r.id,
      holder: r.holder,
      against: r.endpoint,
      payload: { glyph: r.glyph, qty: r.qty },
    });
  }
  return out;
}

/** The glyph+qty a stock commitment carries, or null for a row of another
 *  book / a malformed payload. The spelling written by `gather` above and
 *  read by the two functions below — one place, so the two can never drift. */
function stockPayload(c: FoldCommitment): { glyph: string; qty: number } | null {
  if (c.book !== "reservation") return null;
  const glyph = c.payload?.["glyph"];
  const qty = c.payload?.["qty"];
  if (typeof glyph !== "string" || typeof qty !== "number" || qty <= 0) return null;
  return { glyph, qty };
}

/**
 * ⚖️ F-④ — THE ROWS RODE AWAY: drop exactly what a fold took, and nothing
 * else. Returns the units that left the book.
 *
 * `consume`, not `release(holder)`, and the difference is load-bearing twice
 * over. (a) SURGICAL: a holder may speak on endpoints OUTSIDE the folding
 * scope, and `release` would drop those too — a promise silently destroyed by
 * an unrelated fold is precisely what F-④ forbids. (b) NO WAKE: `release`
 * bumps `releaseEpoch`, the town's "a freed claim opened units for somebody
 * else's job" signal — and a fold frees nothing, since the units folded away
 * with the scope. `consume` is also the honest word: the units DID leave the
 * live stack, into the record.
 */
export function releaseReservationCommitments(
  ledger: ReservationLedger,
  commitments: readonly FoldCommitment[],
): number {
  let units = 0;
  for (const c of commitments) {
    const p = stockPayload(c);
    if (!p) continue;
    units += ledger.consume(c.holder, c.against, p.glyph, p.qty);
  }
  return units;
}

/**
 * ⚖️ F-④ — AND BACK: re-post folded stock promises into a live ledger,
 * verbatim (see the section header on what "verbatim" covers). Returns the
 * units re-spoken-for. The merge is `reserve`'s own: a holder that already
 * speaks for the same endpoint+head grows that row instead of gaining a
 * second, exactly as it would have if the fold had never happened.
 */
export function repostReservationCommitments(
  ledger: ReservationLedger,
  commitments: readonly FoldCommitment[],
): number {
  let units = 0;
  for (const c of commitments) {
    const p = stockPayload(c);
    if (!p) continue;
    if (ledger.reserve(c.holder, c.against, p.glyph, p.qty)) units += p.qty;
  }
  return units;
}

/**
 * ⚖️ F-④ — CONSUME AGAINST A CONDENSED SCOPE. *"…with the holder still able
 * to consume/release it"*: while the scope is folded its rows are not in the
 * ledger (condense released them), so the holder asks the RECORD, which is
 * the book for as long as the fold lasts. Same signature as
 * `ReservationLedger.consume` minus the ledger, same return (units actually
 * released from the reservation), same clamping, and the commitment vanishes
 * at 0 exactly as a row does.
 *
 * ⚖️ WHY RECORD-BACKED ARITHMETIC AND NOT A REFUSAL. `consume` never touches
 * a stack — it only shrinks a number — so there is nothing about the folded
 * scope's stock to consult and no fiction to invent: the operation means
 * bit-for-bit what it means against a live ledger. Refusing it would be the
 * strictly worse answer, because a holder that cancels while its endpoint is
 * folded would have no way to give the units back and the reservation would
 * ride out of the fold as a permanent lie.
 */
export function consumeFoldedReservation(
  record: { commitments: FoldCommitment[] },
  holder: string,
  endpoint: string,
  glyph: string,
  qty: number,
): number {
  const head = stackHead(glyph);
  const i = record.commitments.findIndex(
    (c) =>
      c.book === "reservation" &&
      c.holder === holder &&
      c.against === endpoint &&
      c.payload?.["glyph"] === head,
  );
  if (i < 0) return 0;
  const c = record.commitments[i]!;
  const p = stockPayload(c);
  if (!p) return 0;
  const took = Math.min(p.qty, Math.max(0, Math.floor(qty)));
  const left = p.qty - took;
  if (left <= 0) record.commitments.splice(i, 1);
  else record.commitments[i] = { ...c, payload: { ...c.payload, qty: left } };
  return took;
}

/**
 * ⚖️ F-④ — RELEASE AGAINST A CONDENSED SCOPE (complete / fail / cancel while
 * folded). Drops every stock commitment this holder speaks for on the record;
 * returns the units freed. `ReservationLedger.release`'s counterpart, and the
 * reason `consumeFoldedReservation` above exists at all: a holder must be able
 * to let go mid-fold, or the fold would hand back promises their owners
 * abandoned days ago.
 *
 * NO EPOCH BUMP, deliberately — the ledger's `releaseEpoch` is the town's "a
 * freed claim opened units for somebody else's job" wake, and units inside a
 * condensed scope are not available to anybody's job until it expands.
 */
export function releaseFoldedReservations(
  record: { commitments: FoldCommitment[] },
  holder: string,
): number {
  let units = 0;
  for (let i = record.commitments.length - 1; i >= 0; i--) {
    const c = record.commitments[i]!;
    if (c.holder !== holder) continue;
    const p = stockPayload(c);
    if (!p) continue;
    units += p.qty;
    record.commitments.splice(i, 1);
  }
  return units;
}
