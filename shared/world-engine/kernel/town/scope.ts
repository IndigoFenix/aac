// shared/world-engine/kernel/town/scope.ts
//
// THE SCOPE NODE — one shape for a body, a chest, a building, a district, a
// town (planning-docs/games/scope-unification.md, step ①).
//
// User law (2026-08-02): "A creature is the same shape as a structure. A
// building, a district, a town — all of these have inventories. Those
// inventories are DEFINED BY THE ITEMS THAT CONTAIN THEM."
//
// ── WHAT THIS MODULE IS, AND IS NOT ──────────────────────────────────────
// It is the GRAMMAR and the TREE: what a scope id means, what contains what,
// and how to walk it. It holds no stacks and reads no session — the host
// supplies live views through a small context, exactly as `item-move.ts` takes
// a `ResolveLocation`. So this stays testable without a world.
//
// 🚨 A ScopeId IS THE ENDPOINT ID STRING WE ALREADY USE, unchanged.
// Transfer agreements persist `from`/`to` as those strings (`pocket:mara`,
// `orderpile:3`, `furn_2_chest_food`), and a live agreement outlives any
// refactor. So this module PARSES the vocabulary that exists rather than
// inventing one: every prefix already in the wild becomes a typed variant, and
// `scopeIdOf(parseScopeId(x)) === x` for every id the game can produce.
//
// The point of the parse is that `stockEndpointOf` stops being a ten-branch
// string-prefix switch and becomes a dispatch on a closed union — and, more
// importantly, that CONTAINMENT becomes expressible. The ladder itself is not
// new: `ownership.ts` has declared `creature:<cid> ⊂ house:<hi> ⊂ town` since
// round 4, and says extending it is "adding LINKS, not machinery". It governs
// permission. This gives the same ladder to inventory.

import { houseScope, TOWN_SCOPE, type OwnerScope } from "../../interaction/behavior/ownership.js";
import { auditStacks, type ItemLocation } from "./item-move.js";
import type { StockEndpoint } from "./transfer.js";

/** A scope's id — the endpoint id string, unchanged from the wire/save format. */
export type ScopeId = string;

// ── The id grammar ────────────────────────────────────────────────────────
// One place that knows every prefix. Printers already existed scattered across
// four modules (`cohortEndpointId`, `townEndpointId`, `depotEndpointId`,
// `produceEndpointId`, `shelfEndpointId`, `POCKET_EP`, `ORDER_PILE_EP`, …);
// they keep working and now have a parser that agrees with all of them.

export const POCKET_PREFIX = "pocket:";
export const COHORT_PREFIX = "cohort:";
export const TOWN_PREFIX = "town:";
export const DEPOT_PREFIX = "depot:";
export const PRODUCE_PREFIX = "produce:";
export const SHELF_PREFIX = "store:";
export const ORDER_PILE_PREFIX = "orderpile:";
export const SITE_PILE_PREFIX = "sitepile:";
export const ANNEX_PILE_PREFIX = "annexpile:";
export const BUILDING_FURN_PREFIX = "bfurn:";
/** The town's own builder yard. Syntactically a `town:` id and NOT a partner —
 *  it is a registered container object, which is why the resolver has always
 *  had to check the container registry before treating `town:*` as a partner. */
export const TOWN_YARD_ID = "town:yard";
export const SITE_STOCK_ID = "site:stock";
/** A loose prop's object id. Since 2026-08-02 a deconstructed barrel keeps its
 *  water, so a `small:` prop is an ordinary container scope. */
export const LOOSE_PROP_PREFIX = "small:";

/**
 * WHAT A SCOPE ID NAMES. A closed union — an id that parses to nothing is not a
 * place an item may be, and the audit will say so.
 *
 * `container` is the FALLBACK and the most common case: any world object id
 * that the session has registered as a container (a house chest, a work box, a
 * wild source, a barrel lying on its side).
 */
export type ScopeRef =
  /** A body's own carry — what it is holding, in the containers it holds. */
  | { kind: "creature"; cid: string }
  /** A pooled district's inventory (population.ts cohort row). */
  | { kind: "district"; district: number }
  /** A TOWN's own stack: `town:yard` is ours, `town:<key>` is a partner's. */
  | { kind: "town"; key: string }
  | { kind: "depot"; townKey: string }
  | { kind: "produce"; goodKey: string; workIdx: number }
  | { kind: "shelf"; goodKey: string; srcIdx: number }
  /** A construction order's material pile, and its two legacy spellings. */
  | { kind: "orderPile"; ord: number }
  | { kind: "sitePile"; ord: number }
  | { kind: "annexPile"; ord: number }
  /** A building's furniture-delivery pile. */
  | { kind: "buildingFurnPile"; buildingKey: string }
  /** A founded site's stockpile crate. */
  | { kind: "siteStock" }
  /** A BUILDING — a house or a work shell, by its delta key (`h_3`, `w_1`).
   *  It holds no stack of its own; its inventory is the sum of the containers
   *  standing in it, which is the law in one node. */
  | { kind: "building"; buildingKey: string }
  /** Any registered container object — the fallback. */
  | { kind: "container"; objectId: string };

export type ScopeKind = ScopeRef["kind"];

const afterPrefix = (id: string, prefix: string): string => id.slice(prefix.length);

/**
 * PARSE a scope id. TOTAL — every string parses, because the fallback is
 * "a container object with this id", which is what an unrecognised endpoint has
 * always been treated as. Purely SYNTACTIC on purpose: whether a given
 * `town:<key>` is our yard or a partner's shelf is a fact about the session's
 * container registry, and the resolver keeps that precedence rather than this
 * module guessing at it.
 */
/** A building's own delta key IS its scope id (`h_3`, `w_1`). No prefix of its
 *  own because that key is already the vocabulary every delta, order and
 *  furnish task speaks; giving it a second spelling would be a third name for
 *  the same building. */
const BUILDING_KEY = /^[hw]_\d+$/;

export function parseScopeId(id: ScopeId): ScopeRef {
  if (id === SITE_STOCK_ID) return { kind: "siteStock" };
  // THE LOCAL TOWN, spelled as ownership.ts already spells it (`TOWN_SCOPE`),
  // so the inventory ladder and the permission ladder name the root the same.
  if (id === TOWN_SCOPE) return { kind: "town", key: "" };
  if (BUILDING_KEY.test(id)) return { kind: "building", buildingKey: id };
  if (id.startsWith(POCKET_PREFIX)) return { kind: "creature", cid: afterPrefix(id, POCKET_PREFIX) };
  if (id.startsWith(COHORT_PREFIX)) {
    const district = Number(afterPrefix(id, COHORT_PREFIX));
    if (Number.isFinite(district)) return { kind: "district", district };
  }
  if (id.startsWith(DEPOT_PREFIX)) return { kind: "depot", townKey: afterPrefix(id, DEPOT_PREFIX) };
  if (id.startsWith(PRODUCE_PREFIX)) {
    const [goodKey, idx] = afterPrefix(id, PRODUCE_PREFIX).split(":");
    if (goodKey !== undefined && idx !== undefined && Number.isFinite(Number(idx))) {
      return { kind: "produce", goodKey, workIdx: Number(idx) };
    }
  }
  if (id.startsWith(SHELF_PREFIX)) {
    const [goodKey, idx] = afterPrefix(id, SHELF_PREFIX).split(":");
    if (goodKey !== undefined && idx !== undefined && Number.isFinite(Number(idx))) {
      return { kind: "shelf", goodKey, srcIdx: Number(idx) };
    }
  }
  if (id.startsWith(ORDER_PILE_PREFIX)) {
    const ord = Number(afterPrefix(id, ORDER_PILE_PREFIX));
    if (Number.isFinite(ord)) return { kind: "orderPile", ord };
  }
  if (id.startsWith(SITE_PILE_PREFIX)) {
    const ord = Number(afterPrefix(id, SITE_PILE_PREFIX));
    if (Number.isFinite(ord)) return { kind: "sitePile", ord };
  }
  if (id.startsWith(ANNEX_PILE_PREFIX)) {
    const ord = Number(afterPrefix(id, ANNEX_PILE_PREFIX));
    if (Number.isFinite(ord)) return { kind: "annexPile", ord };
  }
  if (id.startsWith(BUILDING_FURN_PREFIX)) {
    return { kind: "buildingFurnPile", buildingKey: afterPrefix(id, BUILDING_FURN_PREFIX) };
  }
  if (id.startsWith(TOWN_PREFIX)) return { kind: "town", key: afterPrefix(id, TOWN_PREFIX) };
  return { kind: "container", objectId: id };
}

/** PRINT a scope id. `scopeIdOf(parseScopeId(x)) === x` for every id the game
 *  produces — the round trip is what makes the parse safe to put on the
 *  persisted agreement vocabulary. */
export function scopeIdOf(ref: ScopeRef): ScopeId {
  switch (ref.kind) {
    case "creature": return `${POCKET_PREFIX}${ref.cid}`;
    case "district": return `${COHORT_PREFIX}${ref.district}`;
    case "town": return ref.key === "" ? TOWN_SCOPE : `${TOWN_PREFIX}${ref.key}`;
    case "building": return ref.buildingKey;
    case "depot": return `${DEPOT_PREFIX}${ref.townKey}`;
    case "produce": return `${PRODUCE_PREFIX}${ref.goodKey}:${ref.workIdx}`;
    case "shelf": return `${SHELF_PREFIX}${ref.goodKey}:${ref.srcIdx}`;
    case "orderPile": return `${ORDER_PILE_PREFIX}${ref.ord}`;
    case "sitePile": return `${SITE_PILE_PREFIX}${ref.ord}`;
    case "annexPile": return `${ANNEX_PILE_PREFIX}${ref.ord}`;
    case "buildingFurnPile": return `${BUILDING_FURN_PREFIX}${ref.buildingKey}`;
    case "siteStock": return SITE_STOCK_ID;
    case "container": return ref.objectId;
  }
}

/** Is this the town's OWN yard rather than a trade partner's stack? */
export function isTownYard(ref: ScopeRef): boolean {
  return ref.kind === "town" && ref.key === "yard";
}

// ── Containment ───────────────────────────────────────────────────────────

/**
 * What the host must tell the tree about the world. Deliberately tiny: three
 * questions nothing else in this module could answer, each one already
 * answerable by the session today.
 */
export interface ScopeContext {
  /** The house a creature belongs to, or null (a wanderer, a pet, the player). */
  houseOfCreature?(cid: string): number | null;
  /** The building key a container object stands in ("h_3", "w_1"), or null for
   *  one on open ground. A `small:` prop on a house floor answers its house. */
  buildingOfContainer?(objectId: string): string | null;
  /** The building/site an order's pile belongs to, or null. */
  buildingOfOrder?(ord: number): string | null;
  /** This session's own town id, if it has one. */
  townId?(): ScopeId | null;
}

/** The town every local scope ultimately hangs off, when the session has one. */
const localTown = (ctx: ScopeContext): ScopeId | null => ctx.townId?.() ?? null;

/**
 * WHAT CONTAINS THIS. The single containment rule, replacing the ambient
 * assumption that every endpoint is a sibling of every other.
 *
 * Null means "nothing in this session contains it" — a trade partner's town, or
 * a local scope in a session with no town (a founded site before it is one).
 * That is a real answer, not a failure: a partner IS outside our tree, which is
 * exactly why shipments to one are scheduled rather than walked.
 */
export function scopeParentOf(ref: ScopeRef, ctx: ScopeContext = {}): ScopeId | null {
  switch (ref.kind) {
    case "creature": {
      // The ownership ladder, made structural: a body belongs to its household
      // when it has one, and to the town otherwise.
      const hi = ctx.houseOfCreature?.(ref.cid) ?? null;
      return hi !== null ? `h_${hi}` : localTown(ctx);
    }
    case "container": {
      // A container belongs to the building it stands in — and a house chest
      // says so in its own id (`furn_<hi>_…`), which is the fallback when the
      // host cannot place it.
      const b = ctx.buildingOfContainer?.(ref.objectId) ?? null;
      if (b) return b;
      const m = /^furn_(\d+)_/.exec(ref.objectId);
      return m ? `h_${m[1]}` : localTown(ctx);
    }
    case "district":
    case "building":
      return localTown(ctx);
    case "town":
      // OUR yard hangs off our town; the town itself and a PARTNER's town hang
      // off nothing we model yet (the region tier `condense` would feed).
      return isTownYard(ref) ? localTown(ctx) : null;
    case "depot":
    case "produce":
    case "shelf":
      return localTown(ctx);
    case "orderPile":
    case "sitePile":
    case "annexPile":
      return ctx.buildingOfOrder?.(ref.ord) ?? localTown(ctx);
    case "buildingFurnPile":
      return ref.buildingKey;
    case "siteStock":
      return localTown(ctx);
  }
}

/** The OWNERSHIP scope (ownership.ts vocabulary) a scope id sits under — the
 *  same ladder, spoken in the string form `mayUse` already understands. */
export function ownerScopeOf(ref: ScopeRef, ctx: ScopeContext = {}): OwnerScope | null {
  const parent = scopeParentOf(ref, ctx);
  if (!parent) return null;
  const m = /^h_(\d+)$/.exec(parent);
  if (m) return houseScope(Number(m[1]));
  return TOWN_SCOPE;
}

// ── The tree ──────────────────────────────────────────────────────────────

/** One node as the walk reports it. `endpoint` is absent for a scope that has
 *  no live stack right now (an unstreamed container, a body that is not
 *  loaded) — the same "does not exist at the moment" `stockEndpointOf` has
 *  always answered with null. */
export interface ScopeNode {
  id: ScopeId;
  ref: ScopeRef;
  parent: ScopeId | null;
  endpoint: StockEndpoint | null;
}

export interface ScopeTreeInput extends ScopeContext {
  /** Every scope id this session knows about, in any order. */
  ids(): Iterable<ScopeId>;
  /** The live endpoint view of one id — the host's `stockEndpointOf`. */
  endpointOf(id: ScopeId): StockEndpoint | null;
}

/**
 * WALK THE WHOLE TREE, parents before children where both are present.
 *
 * Ordering matters for the fold `condense`/`expand` will be (a parent must be
 * visited knowing its children), so it is established here while the tree is
 * still only being read. Nodes whose parent is absent from the id set sort as
 * roots — a session is allowed to know about a chest without modelling the
 * house it sits in.
 */
export function walkScopeTree(input: ScopeTreeInput): ScopeNode[] {
  const ids = [...new Set(input.ids())];
  const nodes = new Map<ScopeId, ScopeNode>();
  for (const id of ids) {
    const ref = parseScopeId(id);
    nodes.set(id, { id, ref, parent: scopeParentOf(ref, input), endpoint: input.endpointOf(id) });
  }
  const out: ScopeNode[] = [];
  const done = new Set<ScopeId>();
  const emit = (node: ScopeNode, guard: Set<ScopeId>): void => {
    if (done.has(node.id) || guard.has(node.id)) return; // a cycle is not a tree; stop
    guard.add(node.id);
    const p = node.parent ? nodes.get(node.parent) : undefined;
    if (p) emit(p, guard);
    if (!done.has(node.id)) {
      done.add(node.id);
      out.push(node);
    }
  };
  // Deterministic: id order in, id order out (modulo parents hoisted ahead).
  for (const id of [...ids].sort()) emit(nodes.get(id)!, new Set());
  return out;
}

/** Every scope id that reports a live stack right now. */
export function liveScopes(input: ScopeTreeInput): ScopeNode[] {
  return walkScopeTree(input).filter((n) => !!n.endpoint);
}

/**
 * THE CONSERVATION PROBE, over the whole tree.
 *
 * `auditStacks` (item-move.ts) already sums a set of endpoints; this decides
 * WHICH set, which is the part that was missing — there was no way to ask "how
 * many apples exist in this session" because there was no enumeration of the
 * places an apple could be. Two totals that differ across a `condense`/`expand`
 * are the bug that model is most likely to introduce, so the probe lands with
 * the tree rather than after it.
 */
export function auditScopeTree(input: ScopeTreeInput): Record<string, number> {
  return auditStacks(walkScopeTree(input).map((n) => n.endpoint));
}

/**
 * The `ItemLocation` (item-move.ts) a scope id names — the bridge between the
 * tree and the atomic ledger, so a caller that has walked to a node can move
 * items in or out of it without re-deriving anything.
 *
 * `hands` stays the creature spelling for now: under the full model a body's
 * carry IS its containers and this variant disappears, but step ① changes no
 * behaviour and that is a step ③ demolition.
 */
export function itemLocationOf(ref: ScopeRef): ItemLocation {
  if (ref.kind === "creature") return { kind: "hands", cid: ref.cid };
  return { kind: "container", id: scopeIdOf(ref) };
}
