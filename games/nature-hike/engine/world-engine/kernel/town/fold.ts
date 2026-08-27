// shared/world-engine/kernel/town/fold.ts
//
// ⚖️ THE ONE FOLD (planning-docs/games/world-engine/fold-round.md, worklist
// ⑨) — `condense(scopeId, ctx) → FoldRecord` / `expand(record, ctx) →
// scopeIds`, dispatching on `ScopeKind` (scope.ts) to a CODEC registered for
// that kind.
//
// ⚖️ F-① FOLDING IS LEGAL; DISRUPTING IS NOT (the LOD law, promoted to
// govern every kind). Ceasing to be simulated folds into a closed-form
// record and unfolds with everything intact — nothing evaporates at a fold.
//
// ⚖️ F-② ONE FOLD. The three existing LOD folds (wild-area.ts, population.ts,
// barter.ts) each grew their own private condense/expand and their own
// conservation story. This module is the seat they migrate into, one stage
// at a time (F1 wild, F2 household, F3 town) — no scope kind ever grows a
// private fold again; it registers a `FoldCodec` here instead.
// `auditScopeTree` (scope.ts) balances across every fold — a codec that
// cannot balance does not ship: `withFoldConservation` below is that check,
// made runnable rather than merely documented.
//
// ⚖️ F-④ PROMISES SURVIVE OR THE FOLD REFUSES. `FoldRecord.commitments` is
// that law's seat, and F4 fills it: `FoldCommitment` below is the ONE
// interface over the three forward books (TaskPool books HANDS,
// TransferLedger books LEGS, ReservationLedger books STOCK — worklist ①),
// `FoldBooks` is the ctx seam a caller hands the fold to reach them, and
// `FoldRefusal` — already the general refusal shape — carries the named
// blockers when a promise cannot ride.
//
// F1 SCOPE (this file): the envelope + the dispatch + the generic accounting
// a per-kind audit hand-add used to duplicate + the conservation harness,
// and nothing else. The codecs live in their own kind's module — wild-area.ts
// registers "wild" at its own bottom — and this file stays free of any
// per-kind import; it only ever sees the small interfaces below.
//
// F4 ADDS: the commitment interface + the PRE-DISPATCH guard (below), which
// is where "tasks and transfers refuse / reservations fold through" is
// written ONCE for every kind. A codec never reimplements it and never sees
// a commitment — the guard runs BEFORE `codec.condense`, which is the whole
// point of putting it here: `condense` MUTATES (the town codec's F-③ mint),
// and a fold that refuses must not have half-happened first. This file still
// knows nothing about any book's internals: it reads `FoldCommitment.book`
// and nothing else, and the three gather functions live next to their own
// ledgers (reservations.ts, task-pool.ts, transfer.ts).
//
// F5 ADDS THE SERVICEABILITY SPLIT (fold-round.md F4's 🔶 finding and its
// recorded answer): F-④ divides promises into the ones the CLOSED FORM CAN
// KEEP and the ones it cannot. A standing trade leg between two towns is
// SERVICED BY the condensed form — stubs trade, and the clock warp proved the
// caravan arithmetic runs books-only — so it neither blocks the fold nor rides
// away from its book; it stays live and the record DISCLOSES it
// (`FoldRecord.serviced`). A live-body promise (a claimed pair of hands, goods
// already moving on a road) still refuses, exactly as F4 shipped. WHICH is
// which is the CODEC's answer (`FoldCodec.services`), because it is a fact
// about that closed form — this file still never reads a payload.

import { parseScopeId, type ScopeId, type ScopeKind } from "./scope.js";

// ── The envelope ─────────────────────────────────────────────────────────

/**
 * ⚖️ F-④'s seat, and worklist ①'s COMMITMENT CONTRACT: ONE shape for a
 * promise touching a scope, over the three forward books of the three organs
 * — TaskPool books HANDS, TransferLedger books LEGS, ReservationLedger books
 * STOCK. The three ledgers are NOT refactored behind a base class (①'s own
 * measurement: ~18% literal overlap, under the stop floor, and their status
 * graphs genuinely differ); what they share is this READING of a row, which
 * is the only thing the fold needs to treat promises uniformly.
 *
 *   · `book`    — which forward book the row lives in. The fold's ONLY switch.
 *   · `id`      — the row's own id in that book (`task_3`, `agr_7`, `res_2`).
 *   · `holder`  — WHO speaks for it: the claimant/executor where the book has
 *                 one, else the issuer (the stock book's `holder` verbatim).
 *   · `against` — WHAT it is booked against, as the id THIS scope answers for:
 *                 the reserved endpoint, the touched transfer endpoint, the
 *                 task's issuer. Always one of the `FoldScope` ids that
 *                 matched, so a refusal can name the seam it blocked.
 *   · `payload` — the book's own residue, spelled and read by THAT book alone
 *                 (the stock book puts `glyph`/`qty` here and re-posts from
 *                 them; the other two put their status word). `fold.ts` never
 *                 looks inside it.
 */
export interface FoldCommitment {
  readonly book: "task" | "transfer" | "reservation";
  readonly id: string;
  readonly holder: string;
  readonly against: string;
  readonly payload?: FoldCommitmentPayload;
}

/** A commitment's book-specific residue — flat and serializable, because a
 *  folded promise rides a `FoldRecord` and a record is saved. Owned by the
 *  book that writes it; `fold.ts` passes it through untouched. */
export type FoldCommitmentPayload = Readonly<Record<string, string | number>>;

/**
 * WHAT A GATHER IS ASKED ABOUT: the folding scope, plus every endpoint id it
 * answers for. Both are needed because a scope id and a `StockEndpoint` id
 * are different vocabularies — the stock and leg books speak endpoints (a
 * house box, a market shelf, `town:<key>`), the hands book speaks creature
 * ids — and only the host standing the fold up knows the mapping. A gather
 * matches a row against `{id} ∪ endpoints` and nothing else.
 */
export interface FoldScope {
  readonly id: ScopeId;
  readonly endpoints: readonly string[];
}

/**
 * ⚖️ F-④'s CTX SEAM — the three books, reachable from the fold without
 * `fold.ts` importing one of them (`gather` is composed by the caller from
 * the three modules' own gather functions, which is why this is a callback
 * and not a ledger triple). ABSENT ⇒ this call site has no books to ask:
 * nothing refuses and nothing folds through, which is exactly the pre-F4
 * behavior every existing caller keeps.
 *
 * `release`/`repost` are the two halves of "the promise MOVED": a row that
 * rode into `record.commitments` must leave its live book at condense (or it
 * is double-booked — the fold leaked) and come back at expand. Optional only
 * for a caller that wants the refusal guard alone; `expand` REFUSES rather
 * than drop commitments it has no `repost` for.
 */
export interface FoldBooks {
  /** Every IN-FLIGHT promise held BY or AGAINST this scope, any book. */
  gather(scope: FoldScope): readonly FoldCommitment[];
  /** condense: these rode into the record — drop them from the live book. */
  release?(commitments: readonly FoldCommitment[]): void;
  /** expand: put them back, verbatim. */
  repost?(commitments: readonly FoldCommitment[]): void;
}

/** How many blocker ids a refusal SPELLS OUT before "and N more" — the
 *  clock-warp's `WARP_BLOCKERS_SHOWN` at the scope rung, same number and same
 *  reason (a refusal is read by a person; forty ids is not an answer). The
 *  full count rides `FoldRefusal.blocked`. */
export const FOLD_BLOCKERS_SHOWN = 4;

/**
 * A SCOPE, FOLDED. `kind`/`id` name what folded (the same `ScopeKind`/
 * `ScopeId` the live tree already speaks — scope.ts); `at` is the clock
 * (absolute taskClock seconds) the payload is quoted at; `payload` is the
 * kind's own closed-form shape — opaque here, read/written only by that
 * kind's own codec; `commitments` is F-④'s seat — the promises that RODE
 * THROUGH (v1: the stock book's rows; the other two refused the fold before
 * the record was ever built).
 */
export interface FoldRecord<Payload = unknown> {
  kind: ScopeKind;
  id: ScopeId;
  at: number;
  payload: Payload;
  /** Mutable, like every other field here: a holder may consume or release a
   *  folded reservation MID-FOLD, and that arithmetic runs over this array
   *  (reservations.ts `consumeFoldedReservation`/`releaseFoldedReservations`
   *  — the record IS the book while the scope is condensed). */
  commitments: FoldCommitment[];
  /**
   * ⚖️ F5 — THE PROMISES THIS CLOSED FORM KEEPS SERVICING, and therefore the
   * ones that did NOT ride: they are still in their own live book, where the
   * arms that service them read (a standing trade leg between two towns runs
   * against the condensed partner's shelf every leg, whether or not anybody is
   * simulating that town). Listed here as a DISCLOSURE — what the fold made
   * itself answerable for — never as something to re-post: a row that is both
   * here and in its book is not double-booked, because this is a view of the
   * book and not a copy of it. Absent when nothing was serviceable, so a fold
   * with no such promises is byte-identical to the F4 record.
   */
  serviced?: FoldCommitment[];
}

/**
 * A FOLD REFUSED — law F-④'s general shape (the precedent is the clock-warp
 * refusal, `clock-warp.ts` law ③: "refusal is an answer", the SAME shape a
 * success comes back in). Two blocker families raise it: `condense`/`expand`
 * asked for a scope `kind` with no registered codec (F1), and a promise that
 * cannot ride the fold (F4 — `blockers` are the commitment ids, capped at
 * `FOLD_BLOCKERS_SHOWN` with the full count in `blocked`). A codec may also
 * refuse from inside with its own reasons.
 */
export interface FoldRefusal {
  readonly refused: true;
  readonly kind: ScopeKind;
  readonly id: ScopeId;
  readonly blockers: readonly string[];
  /** How many blockers there really were, when `blockers` is a capped view of
   *  a longer list. Absent for the refusals whose list is complete. */
  readonly blocked?: number;
  readonly note: string;
}

/** Type guard — `condense`/`expand` return a union, and this is how a caller
 *  tells the two branches apart. */
export function isFoldRefusal(x: unknown): x is FoldRefusal {
  return !!x && typeof x === "object" && (x as { refused?: unknown }).refused === true;
}

function refuse(kind: ScopeKind, id: ScopeId, blockers: readonly string[], note: string): FoldRefusal {
  return { refused: true, kind, id, blockers, note };
}

// ── The codec interface ──────────────────────────────────────────────────

/**
 * The base context every codec's `condense`/`expand` gets — just the clock
 * the fold is taken/replayed at. A kind's own codec module extends this with
 * whatever ELSE it needs from the live host (wild-area.ts's `WildFoldCtx`:
 * the standing features, a live-stock reader, the ground, a placer for what
 * `expand` lays back out) — `fold.ts` itself never needs to know that shape,
 * which is what keeps this file free of every kind's own import.
 */
export interface FoldCtx {
  /** Clock (absolute taskClock seconds) this fold reads/writes at. */
  now: number;
  /** ⚖️ F-④ — every `StockEndpoint`/creature id this scope answers for, for
   *  the books to match their rows against (see `FoldScope`). Absent ⇒ the
   *  scope id alone. */
  endpoints?: readonly string[];
  /** ⚖️ F-④ — the three forward books. Absent ⇒ this call site cannot reach
   *  them, so no promise is found, none refuses and none rides: the pre-F4
   *  behavior, unchanged. */
  books?: FoldBooks;
}

/**
 * ONE KIND'S FOLD, registered. `condense`/`expand` own only kind-specific
 * detail (F-②: "which numbers survive"); `stockOf` is what makes a folded
 * payload countable — by the conservation harness below, and by a host's own
 * audit (`foldedStock`) — WITHOUT that caller ever reading the payload's
 * shape.
 */
export interface FoldCodec<Payload = unknown, Ctx extends FoldCtx = FoldCtx> {
  readonly kind: ScopeKind;
  /** Fold the live scope `id` into a payload, or refuse. */
  condense(id: ScopeId, ctx: Ctx): Payload | FoldRefusal;
  /** Unfold `record`'s payload back into the live scope, answering the scope
   *  ids that exist again — or refuse. */
  expand(record: FoldRecord<Payload>, ctx: Ctx): ScopeId[] | FoldRefusal;
  /** Every unit this payload holds, by glyph. */
  stockOf(payload: Payload): Record<string, number>;
  /**
   * ⚖️ F5 — CAN THIS CLOSED FORM KEEP THIS PROMISE? True ⇒ the commitment
   * does NOT block the fold and does NOT ride it: it stays in its own live
   * book, because the arms that service it go on servicing it against the
   * condensed scope (`FoldRecord.serviced` discloses what those are).
   *
   * It is the CODEC's question, not this file's, for the same reason
   * `stockOf` is: whether a promise survives depends on what the closed form
   * can still do — a condensed TOWN keeps trading (barter.ts
   * `condensedTownServices`), a condensed cohort keeps nothing. The scope is
   * passed because "serviced" is a claim about a promise booked against the
   * SCOPE ITSELF, never about one that merely mentions a body inside it.
   *
   * ABSENT ⇒ nothing is serviceable, which is F4's shipped floor: hands and
   * legs refuse, stock rides.
   */
  services?(commitment: FoldCommitment, scope: FoldScope): boolean;
  /**
   * ⚖️ PERSISTENCE ARMS (record-persistence round P0, rulings ⑥/⑦ —
   * scope-agnostic INDEX, kind-owned shape). A kind whose payload carries
   * sim-clock-ABSOLUTE stamps declares how to put it TO REST and how to
   * WAKE it: `rest(payload, now)` rebases every stamp RELATIVE to `now`
   * (the fingerprint's own armed-timer idiom — a rested record is
   * portable across boots because it no longer references a clock that
   * dies), and `wake(payload, now)` re-adds the new clock. Both pure;
   * both return the SAME object when nothing moves (`advanceWildArea`'s
   * convention). The identity law every implementation must hold:
   * `wake(rest(p, t), t) ≡ p`, byte for byte — and stocks never move
   * through either (conservation is untouched by time travel).
   * ABSENT ⇒ the kind's payloads are clock-free.
   */
  rest?(payload: Payload, now: number): Payload;
  wake?(payload: Payload, now: number): Payload;
  /**
   * Validate + DEEP-COPY a payload arriving from a save or a wire, or null
   * when it is not this kind's shape (readWildRecord's law, generalized:
   * the same function copies OUT and validates IN, so a shape the sender
   * cannot express is a shape the receiver must not accept). ABSENT ⇒ the
   * kind has no untrusted sources yet.
   */
  read?(payload: unknown): Payload | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a registry of
// codecs over DIFFERENT payload/ctx types is necessarily type-erased at the
// boundary; each codec module stays fully typed internally (see wild-area.ts).
const CODECS = new Map<ScopeKind, FoldCodec<any, any>>();

/**
 * Register a kind's codec — called once, at the codec module's own top level
 * (see wild-area.ts's bottom: importing it, which the game already does for
 * `condenseWildArea`/`expandWildArea` themselves, is enough to make `kind:
 * "wild"` foldable through the dispatch below). Registering the same kind
 * twice is a programming error — two codecs racing to own one kind — so the
 * later call wins loudly in review rather than silently in production: last
 * write replaces, the same convention every other registry in this codebase
 * uses (`registerSpecies`, `registerNaturalSource`, `registerFreight`).
 */
export function registerFoldCodec<Payload, Ctx extends FoldCtx>(
  codec: FoldCodec<Payload, Ctx>,
): void {
  CODECS.set(codec.kind, codec as FoldCodec<any, any>);
}

/** The codec registered for `kind`, or undefined — exported for a caller (a
 *  host's own audit, a test) that wants `stockOf` without going through
 *  `condense`/`expand`. */
export function foldCodecFor(kind: ScopeKind): FoldCodec<any, any> | undefined {
  return CODECS.get(kind);
}

// ── Plain-data reading (every codec's `read` arm builds on these) ─────────
// Moved VERBATIM from quest-host's handover validator (P0): the record
// layer owns "how untrusted plain data is read", so a codec's read arm and
// a host's payload validator go through one set of gates.

/** A finite number, or null — the one numeric gate every field below goes
 *  through, so a NaN can never enter a record from the wire. */
export function finiteOrNull(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/** A plain glyph→count map, COPIED, or null when it is not one. */
export function readNumMap(x: unknown): Record<string, number> | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    const n = finiteOrNull(v);
    if (n === null) return null;
    out[k] = n;
  }
  return out;
}

/** An array of finite numbers, COPIED, or null. */
export function readNumList(x: unknown): number[] | null {
  if (!Array.isArray(x)) return null;
  const out: number[] = [];
  for (const v of x) {
    const n = finiteOrNull(v);
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

// ── The dispatch (F-②) + the promise guard (F-④) ─────────────────────────

/**
 * ⚖️ F-④ — A PROMISE-BLOCKED REFUSAL, warp-shaped: the blocker ids spelled
 * out up to `FOLD_BLOCKERS_SHOWN`, the full count in `blocked`, and the
 * reason in words. `clock-warp.ts`'s own refusal is the sentence pattern.
 */
function refusePromises(
  kind: ScopeKind,
  id: ScopeId,
  blocking: readonly FoldCommitment[],
): FoldRefusal {
  const shown = blocking.slice(0, FOLD_BLOCKERS_SHOWN);
  const more = blocking.length - shown.length;
  const books = [...new Set(blocking.map((c) => c.book))].join("/");
  return {
    refused: true,
    kind,
    id,
    blockers: shown.map((c) => c.id),
    blocked: blocking.length,
    note:
      `fold refused — ${blocking.length} ${books} commitment(s) in flight against "${id}" ` +
      `(${shown.map((c) => `${c.id} ${c.holder}→${c.against}`).join(", ")}` +
      `${more > 0 ? ` and ${more} more` : ""}). A promise is never dropped at a fold.`,
  };
}

/**
 * ⚖️ F-② — CONDENSE. Dispatches on `parseScopeId(id).kind` to that kind's
 * registered codec. No codec registered for the kind ⇒ a typed refusal
 * naming it — every OTHER refusal reason belongs either to the codec itself
 * (which may refuse from inside `condense`) or to the promise guard below.
 *
 * ⚖️ F-④ PROMISES SURVIVE OR THE FOLD REFUSES — the guard, written ONCE for
 * every kind and run BEFORE the codec, because `codec.condense` mutates (the
 * town codec mints its F-③ integral into the live shelf) and a refused fold
 * must not have half-happened. v1's honest floor:
 *
 *   · HANDS (task) and LEGS (transfer) in flight ⇒ REFUSE, blockers named,
 *     UNLESS the codec says the closed form keeps servicing it (F5, below).
 *     A promise the record cannot answer for is not expressible as closed-form
 *     arithmetic — a claimed task is a body mid-errand and a moving transfer
 *     is goods on a road — so the fold declines rather than pretend.
 *   · STOCK (reservation) ⇒ FOLDS THROUGH: the rows move into
 *     `record.commitments` and leave the live ledger (`books.release`), to be
 *     re-posted verbatim at `expand`. A reservation is pure bookkeeping over
 *     an endpoint id (reservations.ts: "INTENTS, not escrow — the stack
 *     itself is untouched"), so the record can carry it with nothing lost.
 *   · ⚖️ F5 SERVICED (`codec.services`) ⇒ NEITHER: the promise stays exactly
 *     where it is. A standing scheduled leg between two towns is run BY the
 *     condensed form every leg (the caravan arms mint the folded partner's
 *     shelf and ship against it), so moving it onto the record would stop the
 *     very thing that keeps it — and refusing the fold over it would mean no
 *     trading partner could ever be folded. `record.serviced` names them.
 *
 * With no `ctx.books` there is nothing to gather and this whole paragraph is
 * inert — which is how every pre-F4 caller keeps its exact behavior.
 */
export function condense<Payload = unknown>(
  id: ScopeId,
  ctx: FoldCtx,
): FoldRecord<Payload> | FoldRefusal {
  const kind = parseScopeId(id).kind;
  const codec = CODECS.get(kind) as FoldCodec<Payload> | undefined;
  if (!codec) return refuse(kind, id, [], `no fold codec registered for scope kind "${kind}"`);
  const scope: FoldScope = { id, endpoints: ctx.endpoints ?? [] };
  const promises = ctx.books?.gather(scope) ?? [];
  // THE THREE FATES, decided BEFORE the codec runs (`condense` mutates):
  // stock RIDES, a serviced promise STAYS, everything else BLOCKS.
  const riding: FoldCommitment[] = [];
  const serviced: FoldCommitment[] = [];
  const blocking: FoldCommitment[] = [];
  for (const c of promises) {
    if (c.book === "reservation") riding.push(c);
    else if (codec.services?.(c, scope)) serviced.push(c);
    else blocking.push(c);
  }
  if (blocking.length) return refusePromises(kind, id, blocking);
  const payload = codec.condense(id, ctx);
  if (isFoldRefusal(payload)) return payload;
  // Only the RIDERS leave their book — a serviced row is still being run out
  // of it, and releasing it would be the silent drop the law forbids.
  if (riding.length) ctx.books?.release?.(riding);
  return {
    kind,
    id,
    at: ctx.now,
    payload,
    commitments: riding,
    ...(serviced.length ? { serviced } : {}),
  };
}

/**
 * ⚖️ F-② — EXPAND. The inverse dispatch, by the record's own `kind`.
 *
 * ⚖️ F-④ — and the inverse of the guard: the promises the record carried go
 * BACK to their books (`books.repost`) once the codec has put the scope back.
 * A record holding commitments that this ctx has no `repost` for REFUSES,
 * naming them: expanding them into nothing is exactly the silent drop the law
 * forbids, and it is a wiring mistake (condensed with books, expanded
 * without), not a state a caller should be able to reach quietly.
 *
 * ⚖️ F5 — `record.serviced` has NO inverse and needs none: those promises
 * never left their books, so there is nothing to put back. What changes at
 * expand is only WHO answers them — the running scope instead of the record —
 * and the row itself never noticed.
 */
export function expand<Payload = unknown>(
  record: FoldRecord<Payload>,
  ctx: FoldCtx,
): ScopeId[] | FoldRefusal {
  const codec = CODECS.get(record.kind) as FoldCodec<Payload> | undefined;
  if (!codec) {
    return refuse(record.kind, record.id, [], `no fold codec registered for scope kind "${record.kind}"`);
  }
  if (record.commitments.length && !ctx.books?.repost) {
    const shown = record.commitments.slice(0, FOLD_BLOCKERS_SHOWN);
    return {
      refused: true,
      kind: record.kind,
      id: record.id,
      blockers: shown.map((c) => c.id),
      blocked: record.commitments.length,
      note:
        `expand refused — ${record.commitments.length} folded commitment(s) on "${record.id}" ` +
        `and no book to re-post them to (${shown.map((c) => c.id).join(", ")}). ` +
        `A promise is never dropped at a fold.`,
    };
  }
  const ids = codec.expand(record, ctx);
  if (isFoldRefusal(ids)) return ids;
  if (record.commitments.length) ctx.books?.repost?.(record.commitments);
  return ids;
}

// ── Generic accounting (dissolves the per-kind audit hand-add) ──────────

/**
 * EVERY UNIT a set of folded payloads of ONE kind holds, by glyph. The
 * generic replacement for a per-kind audit hand-add (quest-host's old
 * wild-only loop straight over `wildAreaStock`): look the kind's codec up
 * once, sum its `stockOf` over every payload. A session's own per-kind
 * collection (today `session.areaRecords`; F2/F3 add their own) plugs into
 * this SAME accounting instead of writing a second copy of the loop — "no
 * kind needs a hand-add again" (fold-round.md F1).
 */
export function foldedStock<Payload>(
  kind: ScopeKind,
  payloads: Iterable<Payload>,
): Record<string, number> {
  const codec = CODECS.get(kind) as FoldCodec<Payload> | undefined;
  const out: Record<string, number> = {};
  if (!codec) return out;
  for (const payload of payloads) {
    for (const [glyph, n] of Object.entries(codec.stockOf(payload))) {
      if (n > 0) out[glyph] = (out[glyph] ?? 0) + n;
    }
  }
  return out;
}

// ── The conservation harness (F-②: "the probe is the contract") ─────────

/**
 * The signed drift between two stock totals, by glyph — empty when they
 * balance. Exported alongside the harness because a caller sometimes wants
 * the diff itself (a failing test's message, a debug log) rather than a
 * thrown assertion.
 */
export function foldDrift(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): Record<string, number> {
  const drift: Record<string, number> = {};
  for (const glyph of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[glyph] ?? 0) - (before[glyph] ?? 0);
    if (d !== 0) drift[glyph] = d;
  }
  return drift;
}

/**
 * ⚖️ F-② — THE CONSERVATION HARNESS: *"`auditScopeTree` balances across every
 * fold — a codec that cannot balance does not ship (the probe is the
 * contract, not the docs)."* Snapshots `audit()` BEFORE `run()`, runs it,
 * snapshots `audit()` AFTER, and throws with the exact glyph drift if they
 * differ — a fold that leaks a unit is exactly the item-conservation law's
 * worst case, so this fails loudly rather than returning a bool a caller
 * could forget to check.
 *
 * `audit` is the CALLER's own stock reader — `auditScopeTree` (scope.ts)
 * plus `foldedStock` over whatever is currently folded, the shape
 * quest-host's `sessionStockAudit` already has. This module holds no session
 * and reads none, so it never needs to know what a "session" is to police
 * the law.
 */
export function withFoldConservation<T>(
  audit: () => Readonly<Record<string, number>>,
  run: () => T,
  label = "fold",
): T {
  const before = audit();
  const result = run();
  const after = audit();
  const drift = foldDrift(before, after);
  const glyphs = Object.keys(drift);
  if (glyphs.length) {
    const parts = glyphs.map((g) => `${g}: Δ${drift[g]! > 0 ? "+" : ""}${drift[g]}`);
    throw new Error(`${label} did not conserve — ${parts.join(", ")}`);
  }
  return result;
}
