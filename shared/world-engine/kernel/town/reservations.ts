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
