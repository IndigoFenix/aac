/**
 * reservations.ts — the SPOKEN-FOR ledger over abstract stock (construction
 * pipeline ①, planning-docs/games/construction-pipeline.md).
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

import { stackHead, stackUnits, takeStock, type TransferSource } from "./transfer.js";

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
  /** Total units of `glyph`'s head spoken for on `endpoint`, all holders. */
  reservedUnits(endpoint: string, glyph: string): number;
  /** This holder's live rows, creation order (read-only view). */
  holderRows(holder: string): readonly ReservationRow[];
  toJSON(): SerializedReservationLedger;
}

export function createReservationLedger(json?: SerializedReservationLedger): ReservationLedger {
  let serial = json?.serial ?? 0;
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
      for (const r of rows.filter((r) => r.holder === holder)) drop(r);
    },
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
 * Resolve a recipe's costs against real stacks: nearest source first
 * (distance to the work spot, lexicographic-lower id on ties), FREE units
 * only, reserving every draw under `holder` as it goes. Costs merge by
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
    const ranked = [...sources]
      .filter((s) => freeUnits(s.stack, ledger, s.id, head) > 0)
      .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
