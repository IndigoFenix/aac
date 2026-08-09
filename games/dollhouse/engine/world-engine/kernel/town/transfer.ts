/**
 * transfer.ts — ONE scope-agnostic TRANSFER/TRADE primitive (city-expansion
 * phase ②): a TRANSFER AGREEMENT between any two STOCK ENDPOINTS, executed by
 * a haul.
 *
 * An ENDPOINT is anything holding a glyph→count STACK MAP — a household
 * box/pantry chest, a market shelf, the town builder's yard (TownDeltas
 * `stock`), a founded site's crate, a creature's pocket. The endpoint's
 * `stack` field ALIASES the real underlying map (the ONE-container law,
 * feedback_items_stack_one_container): reads, takes and puts here mutate the
 * same object the rest of the game reads — never a shadow copy.
 *
 * An AGREEMENT is {from-endpoint, to-endpoint, goods, who executes,
 * recurrence}: a serializable MUTATION row (TownDeltas / task-pool pattern —
 * toJSON round-trip, no RNG, deterministic given the clock). One-shot
 * agreements execute as CREATURE HAULS (the host walks a body from → to,
 * loading and unloading through `takeStock`/`putStock`); standing agreements
 * execute as SCHEDULED ABSTRACT LEGS (`runDueTransfers`) the way goods.ts
 * `haul()` and trade.ts TradeRoute legs run today.
 *
 * VALUATION STAYS OUT: no currency, no prices, no exchange ratios —
 * quantities and flows only (phase ⑤ adds barter ratios at city boundaries).
 *
 * BRIDGES, not rewrites: the shipped dawn-cart flow (goods.ts) and the
 * intercity caravan (trade.ts) remain time-pure closed forms — their clocks
 * ARE their scheduled executors. `tradeRouteAgreementInputs` /
 * `dawnCartAgreementInput` EXPRESS those legs in the agreement vocabulary
 * (the ⑤ seam: caravans between real economies swap the ledger in at the
 * city boundary; `bindPartner()` keeps working — re-derive after binding and
 * the partner endpoint follows).
 *
 * Kernel layering: pure data + arithmetic; imports stay inside kernel/town.
 */

import { FOOD_DAY_SEC } from "./goods.js";
import type { TradeRoute } from "./trade.js";
import { IMPORT_ALLOTMENT } from "./trade.js";
import { headOf } from "../../variations.js";
import { journeyTimeS, priceOf } from "./pricing.js";
import { costTotalS } from "./scope-shape.js";
import { ERRAND_WALK_MPS } from "../../scale.js";

// ---------------------------------------------------------------------------
// Stock endpoints — ONE shape over every stack-map holder
// ---------------------------------------------------------------------------

/**
 * A stock-holding endpoint. `stack` MUST alias the holder's real map
 * (containerStock entry / deltas.stock / site.stock / a pocket) — the
 * endpoint is a VIEW, not a copy. `kind` is a free string (documented
 * conventions: "container", "pocket", "yard", "site", "shelf", "town");
 * nothing switches on it structurally.
 */
export interface StockEndpoint {
  id: string;
  kind: string;
  /** Where a haul walks to reach it (absent = abstract, scheduled-only). */
  at?: { x: number; y: number };
  /** Total-unit cap where one exists (e.g. PANTRY_CAP on a house box).
   *  Absent = uncapped. */
  capacity?: number;
  /** Owner scope (ownership.ts vocabulary), for the caller's social gates. */
  owner?: string | null;
  /** The LIVE stack map — glyph → count. Mutated in place. */
  stack: Record<string, number>;
}

/** The material HEAD of a stack glyph ("wood.wet" → "wood") — the
 *  structures.ts / founding.ts convention: facted variants pay toward and
 *  count toward their head.
 *
 *  🚨 A STORED PIECE IS HEADED BY ITS KIND. Furniture stacks under the prefix
 *  `furn.<kind>`, so the plain head made every piece the same material: a bill
 *  for a bed counted the chairs, and `takeStock` for a bed could take one and
 *  install it as the bed. The kind is the first modifier; anything after it
 *  (a colour) is an ordinary facet and still pays toward its kind. */
export function stackHead(glyph: string): string {
  if (glyph.startsWith("furn.")) {
    const kind = glyph.split(".")[1];
    return kind ? `furn.${kind}` : glyph;
  }
  return headOf(glyph);
}

/** Units in a stack matching `glyph`'s head (facted variants included). */
export function stackUnits(stack: Readonly<Record<string, number>>, glyph: string): number {
  const head = stackHead(glyph);
  let n = 0;
  for (const [g, c] of Object.entries(stack)) {
    if (stackHead(g) === head) n += Math.max(0, c);
  }
  return n;
}

/** Total units across the whole stack. */
export function stackTotal(stack: Readonly<Record<string, number>>): number {
  return Object.values(stack).reduce((s, n) => s + Math.max(0, n), 0);
}

/**
 * TAKE up to `n` units of `glyph`'s head out of a stack (mutates it) — the
 * plain stack first, then facted variants in stable key order (the spendCosts
 * convention). Returns exactly what left the stack, by concrete glyph.
 */
export function takeStock(
  stack: Record<string, number>,
  glyph: string,
  n: number,
): Record<string, number> {
  const head = stackHead(glyph);
  const taken: Record<string, number> = {};
  let left = Math.max(0, Math.floor(n));
  const keys = Object.keys(stack)
    .filter((k) => stackHead(k) === head)
    .sort((a, b) => (a === head ? -1 : b === head ? 1 : a < b ? -1 : 1));
  for (const k of keys) {
    if (left <= 0) break;
    const take = Math.min(left, stack[k] ?? 0);
    if (take <= 0) continue;
    stack[k]! -= take;
    left -= take;
    taken[k] = (taken[k] ?? 0) + take;
    if (stack[k]! <= 0) delete stack[k];
  }
  return taken;
}

/** Take a whole GOODS map (glyph → qty) out of a stack. Partial when the
 *  stack runs short — the return is what actually left. */
export function takeGoods(
  stack: Record<string, number>,
  goods: Readonly<Record<string, number>>,
): Record<string, number> {
  const taken: Record<string, number> = {};
  for (const [glyph, qty] of Object.entries(goods)) {
    for (const [g, c] of Object.entries(takeStock(stack, glyph, qty))) {
      taken[g] = (taken[g] ?? 0) + c;
    }
  }
  return taken;
}

/**
 * PUT a goods map into an endpoint, honoring its capacity (total units).
 * Returns what was accepted and what was refused (the caller decides where
 * refused units land — back in the source, spilled as loose piles… nothing
 * ever silently vanishes).
 */
export function putStock(
  ep: Pick<StockEndpoint, "stack" | "capacity">,
  goods: Readonly<Record<string, number>>,
): { accepted: Record<string, number>; refused: Record<string, number> } {
  const accepted: Record<string, number> = {};
  const refused: Record<string, number> = {};
  let room = ep.capacity !== undefined ? Math.max(0, ep.capacity - stackTotal(ep.stack)) : Infinity;
  for (const [glyph, qty] of Object.entries(goods)) {
    const put = Math.min(qty, room);
    if (put > 0) {
      ep.stack[glyph] = (ep.stack[glyph] ?? 0) + put;
      accepted[glyph] = put;
      room -= put;
    }
    if (qty - put > 0) refused[glyph] = qty - put;
  }
  return { accepted, refused };
}

/**
 * ONE atomic endpoint-to-endpoint move: take `goods` from `from` (up to what
 * it holds), put into `to` (up to its capacity), and return anything the
 * destination refused TO THE SOURCE — conservation holds whatever happens.
 */
export function transferStock(
  from: StockEndpoint,
  to: StockEndpoint,
  goods: Readonly<Record<string, number>>,
): { moved: Record<string, number>; missing: Record<string, number> } {
  const taken = takeGoods(from.stack, goods);
  const { accepted, refused } = putStock(to, taken);
  for (const [g, n] of Object.entries(refused)) {
    from.stack[g] = (from.stack[g] ?? 0) + n; // nothing vanishes
  }
  const missing: Record<string, number> = {};
  for (const [glyph, qty] of Object.entries(goods)) {
    const got = Object.entries(accepted)
      .filter(([g]) => stackHead(g) === stackHead(glyph))
      .reduce((s, [, n]) => s + n, 0);
    if (qty - got > 0) missing[glyph] = qty - got;
  }
  return { moved: accepted, missing };
}

// ---------------------------------------------------------------------------
// Source planning (deterministic — the "which chest do I take it from" step)
// ---------------------------------------------------------------------------

export interface TransferSource {
  /** Endpoint id. */
  id: string;
  /** LIVE stack (aliased, like every endpoint). */
  stack: Readonly<Record<string, number>>;
  /** Distance rank (meters to the destination / the hauler — caller's pick). */
  d: number;
}

// ── ⚖️ THE ONE PRICED SOURCE WALK (scope-behaviors.md §2.2 SOURCE) ─────────
//
// The chapter's indictment: SOURCE had "four disagreeing answers", and the
// town's own was "nearest-first with lexicographic ties, IMPLEMENTED THREE
// TIMES (`planTransferSources`, `resolveMaterials`, `requestPiece`) — and
// inconsistently: construction uses crow-flies `hypot` while shopping
// (`sourceOf`) and district deficits use `roadDistance`."
//
// The verdict, applied here: "GENERALIZE into ONE priced walk. The sort key
// changes from `d` to `costTotalS(verbCost(source))`; NEAREST-FIRST IS THE
// SPECIAL CASE WHERE VALUE AND HANDS ARE EQUAL."
//
// 🔒 THE COMPAT PROOF, stated so it can be read off the code: with one speed
// and one dwell across the candidates, `cost = d / speed + hands` is STRICTLY
// MONOTONE INCREASING in `d`, so ordering by cost is ordering by distance, and
// the id tie-break is the same lexicographic one. Every shipped caller passes
// equal terms, so every shipped ordering is byte-identical — the pricing only
// starts to BITE when a caller has a reason to price two sources differently
// (a slower cart, a deeper chest, a bag already at one of them).
//
// VALUE stays out of the key this pass, deliberately: every shipped caller
// draws ONE good in ONE unit size from every candidate, so `value(units)` is
// equal across the walk and subtracting it would move nothing. The moment a
// caller has differing values (mixed heads, mixed grades) it belongs in
// `PricedSourceOpts` as a per-source term — the seat is here, empty on purpose.

/** What the walk charges a candidate. All shipped callers take the defaults,
 *  which is why the priced order IS the old nearest-first order. */
export interface PricedSourceOpts {
  /** Hauler pace for the journey leg (m/s). Default: the villager errand
   *  pace — the same one `haulBagLeg` prices a body's trip at. */
  speedMps?: number;
  /** Hand-seconds one draw costs AT the source (opening the box, loading).
   *  Equal across a walk ⇒ it cancels; it is here so a caller with real
   *  per-source dwells can spend it. Default 0. */
  loadDwellS?: number;
  /** Per-source overrides where a caller genuinely has them. Absent (or
   *  returning nothing) ⇒ the walk-level defaults above. */
  perSource?(s: TransferSource): { speedMps?: number; loadDwellS?: number } | undefined;
}

/** THE SORT KEY: this source's `VerbCost`, totalled in hand-seconds. */
export function sourceCostS(s: TransferSource, opts: PricedSourceOpts = {}): number {
  const per = opts.perSource?.(s);
  const speed = per?.speedMps ?? opts.speedMps ?? ERRAND_WALK_MPS;
  const handsS = per?.loadDwellS ?? opts.loadDwellS ?? 0;
  return costTotalS(priceOf({ journeyS: journeyTimeS(s.d, speed), handsS }));
}

/**
 * THE WALK: candidates holding units, cheapest first, LEXICOGRAPHIC-lower id
 * on ties (the chooseClaimant law — no RNG, replays identically).
 *
 * `unitsOf` is the caller's own "does this source offer anything" test, which
 * is the ONLY thing the three copies legitimately disagreed about: plain stack
 * units for a spoken order, FREE units for a reservation-aware resolve, one
 * exact glyph for a furniture request. Everything else — the metric, the
 * ordering, the tie-break — is now written once.
 *
 * Compared with `<`/`>` rather than subtraction so an UNREACHABLE candidate
 * (speed 0 ⇒ `journeyTimeS` = ∞) ties instead of poisoning the comparator with
 * `∞ − ∞ = NaN`, which the old `a.d − b.d` would have done.
 */
export function rankPricedSources<T extends TransferSource>(
  sources: readonly T[],
  unitsOf: (s: T) => number,
  opts: PricedSourceOpts = {},
): T[] {
  return sources
    .filter((s) => unitsOf(s) > 0)
    .map((s) => ({ s, c: sourceCostS(s, opts) }))
    .sort((a, b) =>
      a.c < b.c ? -1 : a.c > b.c ? 1 : a.s.id < b.s.id ? -1 : a.s.id > b.s.id ? 1 : 0,
    )
    .map((r) => r.s);
}

/**
 * Deterministic source allocation for `qty` units of `glyph`: CHEAPEST source
 * first (`rankPricedSources` — nearest-first while the terms are equal, which
 * is every shipped caller), distance ties toward the LEXICOGRAPHIC lower id.
 * Returns one draw per source touched plus the shortfall the sources can't
 * cover (the caller's honest refusal: "we don't have 3 wood").
 */
export function planTransferSources(
  sources: readonly TransferSource[],
  glyph: string,
  qty: number,
  price?: PricedSourceOpts,
): { draws: Array<{ id: string; take: number }>; shortfall: number } {
  const ranked = rankPricedSources(sources, (s) => stackUnits(s.stack, glyph), price);
  const draws: Array<{ id: string; take: number }> = [];
  let left = Math.max(0, Math.floor(qty));
  for (const s of ranked) {
    if (left <= 0) break;
    const take = Math.min(left, stackUnits(s.stack, glyph));
    draws.push({ id: s.id, take });
    left -= take;
  }
  return { draws, shortfall: left };
}

/** The spoken quantity word → transfer units. `all` reads Infinity (the
 *  caller clamps to what's actually there). */
export function orderQuantity(q?: string): number {
  switch (q) {
    case "two": return 2;
    case "three": return 3;
    case "many": return 3;
    case "all": return Infinity;
    default: return 1;
  }
}

// ---------------------------------------------------------------------------
// Transfer agreements — the serializable mutation layer
// ---------------------------------------------------------------------------

export type TransferStatus = "pending" | "moving" | "done" | "failed";
export type TransferFailReason =
  | "missing"
  | "no-endpoint"
  | "no-executor"
  /** The destination could not take the load (capacity). The goods stay in the
   *  carrier's HANDS — a refused delivery is a creature still holding something,
   *  never units scattered or dropped from the books. */
  | "refused";

/**
 * BARTER TERMS (city-expansion ⑤) — the exchange half of a two-way agreement.
 * An agreement carrying `barter` is a PAIRED flow: the row's own `goods` are
 * the GIVE side (from us to `town:<partnerKey>`), and `take` comes BACK in
 * the same shipment at the quoted ratio. Ratios are computed at agreement
 * time and RE-DERIVED per shipment by the barter executor (barter.ts
 * runDueBarters) — shifting scarcities shift the terms over time. NO
 * CURRENCY anywhere: a quote is goods-for-goods ("3 wood for 2 food").
 * Barter rows are the barter executor's alone — runDueTransfers skips them.
 */
export interface BarterTerms {
  /** What comes BACK per shipment (glyph → qty), at the quoted ratio. */
  take: Record<string, number>;
  /** The two goods the quote prices (heads — one give, one take good). */
  giveGood: string;
  takeGood: string;
  /** The spoken integer quote: `give` units of giveGood for `take` units
   *  of takeGood (both 1..3 — the speakable quantity words). */
  quote: { give: number; take: number };
  /** The partner town key (`town:<partnerKey>` is the far endpoint). */
  partnerKey: string;
  /** Standing routes: paused by the partner's own famine/willingness —
   *  VISIBLE, never silent; the executor resumes it when terms clear. */
  suspended?: boolean;
}

export interface TransferAgreement {
  id: string;
  /** Endpoint ids (the host's registry resolves them to live endpoints). */
  from: string;
  to: string;
  /** Goods per EXECUTION (glyph → qty). */
  goods: Record<string, number>;
  /** WHO asked — a creature id (the player is one creature among many). */
  issuer: string;
  /** The claimed hauler (haul mode), once one exists. */
  executor?: string;
  /** `haul` = a body walks it; `scheduled` = an abstract leg on the clock. */
  mode: "haul" | "scheduled";
  /** Standing recurrence, in ledger-clock seconds. Absent = one-shot. */
  every?: number;
  createdAt: number;
  /** Next execution time (scheduled mode). */
  nextDueAt?: number;
  status: TransferStatus;
  /** Goods in the hauler's hands mid-haul (serialized — a reload never
   *  loses a load). */
  carried?: Record<string, number>;
  failReason?: TransferFailReason;
  /** The spoken sentence that created it (report surface). */
  sourceGlyph?: string;
  /** BARTER flavor (⑤): the return flow + the quoted ratio. Rows carrying
   *  this are executed by barter.ts runDueBarters, never runDueTransfers. */
  barter?: BarterTerms;
}

export interface SerializedTransferLedger {
  serial: number;
  agreements: TransferAgreement[];
}

export interface PostTransferInput {
  from: string;
  to: string;
  goods: Record<string, number>;
  issuer: string;
  mode: "haul" | "scheduled";
  now: number;
  every?: number;
  /** Explicit first-due time (scheduled mode) — a shipment that takes
   *  TRAVEL TIME lands later than `now` (default: now + every). */
  dueAt?: number;
  sourceGlyph?: string;
  /** BARTER flavor (⑤) — see BarterTerms. */
  barter?: BarterTerms;
}

export interface TransferLedger {
  post(input: PostTransferInput): TransferAgreement;
  get(id: string): TransferAgreement | undefined;
  /** pending + moving, in creation order (deterministic processing order). */
  active(): TransferAgreement[];
  /** EVERY agreement, terminal ones included, creation order — the audit
   *  view (pipeline ② staging sweeps read dead sitepile hauls off it). */
  all(): readonly TransferAgreement[];
  /** Scheduled agreements due at `now`, creation order. */
  due(now: number): TransferAgreement[];
  /** pending → moving: a hauler took the job. */
  begin(id: string, executor: string): boolean;
  /** The hauler loaded — record what's in its hands. */
  load(id: string, carried: Record<string, number>): void;
  /** moving/pending → done. */
  complete(id: string): void;
  /** → failed, with the reason NAMED (never a silent rot). */
  fail(id: string, reason: TransferFailReason): void;
  /** A standing agreement's leg ran — advance its clock (status returns to
   *  pending; one-shots use complete()). */
  advance(id: string, now: number): void;
  /** The agreement a hauler is executing, if any (one haul per body). */
  executing(executor: string): TransferAgreement | undefined;
  toJSON(): SerializedTransferLedger;
}

export function createTransferLedger(json?: SerializedTransferLedger): TransferLedger {
  let serial = json?.serial ?? 0;
  const rows: TransferAgreement[] = (json?.agreements ?? []).map(
    (a) => JSON.parse(JSON.stringify(a)) as TransferAgreement,
  );
  const byId = new Map<string, TransferAgreement>(rows.map((a) => [a.id, a]));
  return {
    post(input) {
      const a: TransferAgreement = {
        id: `agr_${serial++}`,
        from: input.from,
        to: input.to,
        goods: { ...input.goods },
        issuer: input.issuer,
        mode: input.mode,
        ...(input.every !== undefined ? { every: input.every } : {}),
        createdAt: input.now,
        ...(input.mode === "scheduled"
          ? { nextDueAt: input.dueAt ?? input.now + (input.every ?? 0) }
          : {}),
        status: "pending",
        ...(input.sourceGlyph !== undefined ? { sourceGlyph: input.sourceGlyph } : {}),
        ...(input.barter !== undefined
          ? { barter: JSON.parse(JSON.stringify(input.barter)) as BarterTerms }
          : {}),
      };
      rows.push(a);
      byId.set(a.id, a);
      return a;
    },
    get: (id) => byId.get(id),
    active: () => rows.filter((a) => a.status === "pending" || a.status === "moving"),
    all: () => rows,
    due: (now) =>
      rows.filter(
        (a) => a.mode === "scheduled" && a.status === "pending" && (a.nextDueAt ?? 0) <= now,
      ),
    begin(id, executor) {
      const a = byId.get(id);
      if (!a || a.status !== "pending") return false;
      a.status = "moving";
      a.executor = executor;
      return true;
    },
    load(id, carried) {
      const a = byId.get(id);
      if (a) a.carried = { ...carried };
    },
    complete(id) {
      const a = byId.get(id);
      if (!a || (a.status !== "moving" && a.status !== "pending")) return;
      a.status = "done";
      delete a.carried;
    },
    fail(id, reason) {
      const a = byId.get(id);
      if (!a || a.status === "done") return;
      a.status = "failed";
      a.failReason = reason;
      delete a.carried;
    },
    advance(id, now) {
      const a = byId.get(id);
      if (!a || a.mode !== "scheduled") return;
      a.status = "pending";
      delete a.executor;
      delete a.carried;
      a.nextDueAt = now + (a.every ?? 0);
    },
    executing: (executor) =>
      rows.find((a) => a.status === "moving" && a.executor === executor),
    toJSON: () => ({
      serial,
      agreements: rows.map((a) => JSON.parse(JSON.stringify(a)) as TransferAgreement),
    }),
  };
}

// ---------------------------------------------------------------------------
// Scheduled execution — the abstract leg (standing agreements)
// ---------------------------------------------------------------------------

export interface TransferLegReport {
  id: string;
  moved: Record<string, number>;
  missing: Record<string, number>;
}

/**
 * Run every DUE standing agreement once (creation order — deterministic given
 * the clock and the mutation record): move the goods between the LIVE
 * endpoints, advance each agreement's clock. An endpoint the resolver can't
 * produce fails the agreement NAMED ("no-endpoint"), never silently. Partial
 * moves are honest — the report says what moved and what was missing.
 */
export function runDueTransfers(
  ledger: TransferLedger,
  resolve: (id: string) => StockEndpoint | null,
  now: number,
): TransferLegReport[] {
  const out: TransferLegReport[] = [];
  for (const a of ledger.due(now)) {
    if (a.barter) continue; // barter rows (⑤) run through runDueBarters alone
    const from = resolve(a.from);
    const to = resolve(a.to);
    if (!from || !to) {
      ledger.fail(a.id, "no-endpoint");
      continue;
    }
    const { moved, missing } = transferStock(from, to, a.goods);
    out.push({ id: a.id, moved, missing });
    ledger.advance(a.id, now);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bridges — the SHIPPED flows expressed in the agreement vocabulary
// ---------------------------------------------------------------------------
// goods.ts dawn carts and trade.ts caravans stay time-pure closed forms (their
// clocks ARE their scheduled executors — stability of the shipped economy
// over purity). These adapters EXPRESS those legs as standing-agreement
// inputs, so every flow in the game reads in ONE vocabulary and phase ⑤ can
// swap the ledger in at the city boundary without a new shape.

/** Town-scale endpoint id conventions the bridges use. */
export function townEndpointId(townKey: string): string {
  return `town:${townKey}`;
}
export function depotEndpointId(townKey: string): string {
  return `depot:${townKey}`;
}
/** A producer work's pile (goods.ts produceAt) as an endpoint id. */
export function produceEndpointId(goodKey: string, workIdx: number): string {
  return `produce:${goodKey}:${workIdx}`;
}
/** A market shelf (goods.ts stockOf source) as an endpoint id. */
export function shelfEndpointId(goodKey: string, srcIdx: number): string {
  return `store:${goodKey}:${srcIdx}`;
}

/** The narrow view of a `TownGoods` this rule reads — declared structurally so a
 *  test can answer it without standing up a town. */
export interface GoodSourceBook {
  good: { key: string; shelved: ReadonlyArray<string> };
  sources: ReadonlyArray<{ kind: string; work?: number }>;
  producerWorks(): number[];
}

/**
 * WHERE A SHOPPER DRAWS THIS GOOD, at the source the goods clock bound them to
 * (`TownGoods.sourceOf(house)` → its index here). ONE rule, read by BOTH the
 * world seeding that mints the endpoints and the live needs loop that shops at
 * them — which is the whole of stocking-offload-and-carry.md §1.2's law: *"the
 * logic determining household member shopping trips should be the same as the
 * logic determining shop stocking"*.
 *
 * Two closed forms, both the economy's own, chosen by what the economy actually
 * puts at that source:
 *  · a SHELVED source has a dawn-carted shelf (`stockOf` > 0 only there) — a
 *    market stall, `store:<good>:<srcIdx>`, this file's own ledger spelling;
 *  · an UNSHELVED PRODUCER GATE sells from the field: its stock is the pile the
 *    dawn cart comes for (`produceAt`), which already stands there as
 *    `produce:<good>:<work>`. No second box at the same doorstep.
 *
 * The fall-through (unshelved, not a producer — the hall of a town with no
 * seller at all) keeps a shelf id whose `stockOf` is 0: an empty shelf, which is
 * what such a town has, and never an ABSENT one (the §2.5 DEFER distinction).
 * Total: null only for an index that names no source.
 */
export function goodSourceEndpointId(g: GoodSourceBook, srcIdx: number): string | null {
  const src = g.sources[srcIdx];
  if (!src) return null;
  if (!g.good.shelved.includes(src.kind) && src.work !== undefined && g.producerWorks().includes(src.work)) {
    return produceEndpointId(g.good.key, src.work);
  }
  return shelfEndpointId(g.good.key, srcIdx);
}

/**
 * ONE dawn-cart supply leg (goods.ts `haul()`: producer pile → market shelf,
 * every street day) as a standing-agreement input. Descriptive today — the
 * closed form still animates the cart; the row is the shared vocabulary.
 */
export function dawnCartAgreementInput(opts: {
  goodKey: string;
  producerWork: number;
  sourceIdx: number;
  dailyUnits: number;
  issuer?: string;
  now?: number;
}): PostTransferInput {
  return {
    from: produceEndpointId(opts.goodKey, opts.producerWork),
    to: shelfEndpointId(opts.goodKey, opts.sourceIdx),
    goods: { [opts.goodKey]: Math.max(0, Math.round(opts.dailyUnits)) },
    issuer: opts.issuer ?? "town",
    mode: "scheduled",
    every: FOOD_DAY_SEC,
    now: opts.now ?? 0,
    sourceGlyph: "dawn-cart",
  };
}

/**
 * The intercity line's two legs (trade.ts TradeRoute) as standing-agreement
 * inputs: imports partner → depot, exports depot → partner, one visit per
 * street day. PURE IN THE ROUTE — call again after `bindPartner()` and the
 * partner endpoint follows the new key (the bindPartner seam keeps working;
 * this is the ⑤ caravan on-ramp, not a rewrite).
 */
export function tradeRouteAgreementInputs(
  route: Pick<TradeRoute, "partnerKey" | "imports" | "exports" | "rare">,
  townKey: string,
  opts?: { exportDaily?: number; issuer?: string; now?: number },
): PostTransferInput[] {
  // ⚖️ The allotment splits across the kinds THIS ROUTE carries — the authored
  // list is only what an unbound line brings (R&T ⑤ T2), so reading its length
  // here would mis-split a derived cargo. Identical for the authored list.
  const per = Math.floor(IMPORT_ALLOTMENT / Math.max(1, route.imports.length));
  const imports: Record<string, number> = {};
  for (const k of route.imports) imports[k] = per;
  imports[route.rare.kind] = (imports[route.rare.kind] ?? 0) + route.rare.perVisit;
  const exports: Record<string, number> = {};
  for (const k of route.exports) exports[k] = Math.max(0, Math.round(opts?.exportDaily ?? 0));
  const base = {
    issuer: opts?.issuer ?? townKey,
    mode: "scheduled" as const,
    every: FOOD_DAY_SEC,
    now: opts?.now ?? 0,
  };
  return [
    {
      ...base,
      from: townEndpointId(route.partnerKey),
      to: depotEndpointId(townKey),
      goods: imports,
      sourceGlyph: "caravan-imports",
    },
    {
      ...base,
      from: depotEndpointId(townKey),
      to: townEndpointId(route.partnerKey),
      goods: exports,
      sourceGlyph: "caravan-exports",
    },
  ];
}
