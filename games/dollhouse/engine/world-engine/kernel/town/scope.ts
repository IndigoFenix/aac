// shared/world-engine/kernel/town/scope.ts
//
// THE SCOPE NODE — one shape for a body, a chest, a building, a district, a
// town (planning-docs/games/world-engine/scope-unification.md, step ①).
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
import { countUnits } from "./goods-kinds.js";

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
/** ⚖️ S&D S4 — A NATURAL SOURCE, in its three spellings. `wild:<species>_<tag>`
 *  is a standing feature's own id (the scatter's box form); an EMBODIED plant
 *  and a product ANIMAL key their stock under their BODY id instead
 *  (`flora:<species>:<tag>` / `fauna:<species>:<tag>`), which is why all three
 *  prefixes parse to the same node kind: they are three RENDERERS of one
 *  endpoint, not three kinds of place. */
export const WILD_PREFIX = "wild:";
export const FLORA_BODY_PREFIX = "flora:";
export const FAUNA_BODY_PREFIX = "fauna:";
/** An OFFLOADED wild area — the closed-form record whose features are its
 *  renderer when loaded (`wild-area.ts`). A sub-prefix rather than a fourth
 *  top-level word, so "everything natural is spelled `wild:`" survives the
 *  loaded/unloaded split; no natural source is named `area`. */
export const WILD_AREA_PREFIX = "wild:area:";
/** ⚖️ A MOBILE COLLECTIVE — a band of people or a herd of animals, ONE object
 *  (scope-definitions.md §Mobility: "a band is a herd of people"). The
 *  condensed record of a mobile scatter scope (kernel/civ/bands.ts `Band`),
 *  foldable through the generic dispatch like any other scope kind. */
export const BAND_PREFIX = "band:";
/** ⚖️ A DESIGNATED GROUND LOT (#44 instant lot designation) — partitioned
 *  open ground: the community-ground charter's own patch, a scope BEFORE any
 *  building stands on it. Keyed by the charter ord (stable forever — the
 *  zoning row's own promise), so the id survives paint-overs and saves. */
export const LOT_PREFIX = "lot:";

/** The scope id of a designated ground lot (by its charter ord). */
export function lotScopeId(ord: number): ScopeId {
  return `${LOT_PREFIX}${ord}`;
}

/** The scope id of an offloaded wild area. */
export function wildAreaId(key: string): ScopeId {
  return `${WILD_AREA_PREFIX}${key}`;
}

/** The scope id of a mobile collective (band/herd). */
export function bandScopeId(key: string): ScopeId {
  return `${BAND_PREFIX}${key}`;
}

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
  /**
   * ⚖️ A NATURAL SOURCE — a stand of trees, an outcrop, a grazing animal, or
   * the whole offloaded AREA they render (S&D S4).
   *
   * USER LAW (2026-08-12, verbatim): *"don't create a separate
   * wilderness-surrounding-city rule … treat wilderness areas as a type of
   * RENDERER for a resource's source, treated the same as a storeroom, shop
   * or city."* This variant is that law in the grammar: a forest is one more
   * expression of a resource-source endpoint, with a `form` naming which
   * renderer is standing (`box` — the scatter's placeholder; `flora`/`fauna` —
   * a grown body; `area` — none, the closed-form record itself).
   *
   * 🚨 IT NEEDED A NAME BECAUSE IT HAD NONE. `wild:oak_3` used to fall through
   * to the `container` fallback, so every reader that had to tell standing
   * timber from shelving did it by scanning `session.wilderness.features` —
   * four such scans in construction-director alone. The distinction they
   * actually wanted is `scopeReceivesGoods`, below: a shelf receives, a source
   * only yields.
   */
  | { kind: "wild"; form: "box" | "flora" | "fauna" | "area"; species: string; tag: string }
  /** A MOBILE COLLECTIVE — band of people, herd of animals: one object, one
   *  kind (B-①, band-settlement-round.md). It RECEIVES goods (a band banks a
   *  store — that is Gate A's whole subject), unlike a natural source. */
  | { kind: "band"; key: string }
  /** A DESIGNATED GROUND LOT — the community-ground charter's patch (#44):
   *  a prop set down on it hangs off the LOT, which hangs off the town —
   *  the scope walk's answer to the outdoor-census hole on partitioned
   *  ground. Holds no stack of its own, exactly like a building. */
  | { kind: "lot"; ord: number }
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

/** `<species><sep><tag>`, split at the first/last separator. The two natural-
 *  source spellings split DIFFERENTLY and both are forced:
 *   • `wild:<species>_<tag>` splits at the LAST underscore, because species
 *     keys carry underscores (`apple_tree`, `banana_plant`) and tags do not
 *     (a scatter index, or a flora twin's `face:tx:ty:i` instance key);
 *   • `flora:<species>:<tag>` splits at the FIRST colon, because the tag is a
 *     whole feature id (`flora:oak:wild:oak_3`) and carries colons of its own.
 *  Either way the print is `species + sep + tag`, so the round trip is exact
 *  even where the division itself is a guess. */
const splitAt = (s: string, sep: string, last: boolean): [string, string] => {
  const i = last ? s.lastIndexOf(sep) : s.indexOf(sep);
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + sep.length)];
};

export function parseScopeId(id: ScopeId): ScopeRef {
  if (id === SITE_STOCK_ID) return { kind: "siteStock" };
  // ⚖️ NATURAL SOURCES, before every other prefix: `wild:` would otherwise be
  // read as a bare container and `flora:`/`fauna:` bodies as anonymous objects.
  if (id.startsWith(WILD_AREA_PREFIX)) {
    return { kind: "wild", form: "area", species: "", tag: afterPrefix(id, WILD_AREA_PREFIX) };
  }
  if (id.startsWith(WILD_PREFIX)) {
    const [species, tag] = splitAt(afterPrefix(id, WILD_PREFIX), "_", true);
    return { kind: "wild", form: "box", species, tag };
  }
  if (id.startsWith(FLORA_BODY_PREFIX) || id.startsWith(FAUNA_BODY_PREFIX)) {
    const flora = id.startsWith(FLORA_BODY_PREFIX);
    const [species, tag] = splitAt(
      afterPrefix(id, flora ? FLORA_BODY_PREFIX : FAUNA_BODY_PREFIX),
      ":",
      false,
    );
    return { kind: "wild", form: flora ? "flora" : "fauna", species, tag };
  }
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
  if (id.startsWith(BAND_PREFIX)) return { kind: "band", key: afterPrefix(id, BAND_PREFIX) };
  if (id.startsWith(LOT_PREFIX)) {
    const ord = Number(afterPrefix(id, LOT_PREFIX));
    if (Number.isFinite(ord)) return { kind: "lot", ord };
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
    case "wild":
      switch (ref.form) {
        case "area": return `${WILD_AREA_PREFIX}${ref.tag}`;
        case "flora": return `${FLORA_BODY_PREFIX}${ref.species}:${ref.tag}`;
        case "fauna": return `${FAUNA_BODY_PREFIX}${ref.species}:${ref.tag}`;
        // A tagless source (`wild:oak`) round-trips without the separator the
        // split never found.
        case "box": return ref.tag === ""
          ? `${WILD_PREFIX}${ref.species}`
          : `${WILD_PREFIX}${ref.species}_${ref.tag}`;
      }
    // eslint-disable-next-line no-fallthrough -- every `form` returns above
    case "depot": return `${DEPOT_PREFIX}${ref.townKey}`;
    case "produce": return `${PRODUCE_PREFIX}${ref.goodKey}:${ref.workIdx}`;
    case "shelf": return `${SHELF_PREFIX}${ref.goodKey}:${ref.srcIdx}`;
    case "orderPile": return `${ORDER_PILE_PREFIX}${ref.ord}`;
    case "sitePile": return `${SITE_PILE_PREFIX}${ref.ord}`;
    case "annexPile": return `${ANNEX_PILE_PREFIX}${ref.ord}`;
    case "buildingFurnPile": return `${BUILDING_FURN_PREFIX}${ref.buildingKey}`;
    case "band": return `${BAND_PREFIX}${ref.key}`;
    case "lot": return `${LOT_PREFIX}${ref.ord}`;
    case "siteStock": return SITE_STOCK_ID;
    case "container": return ref.objectId;
  }
}

/** Is this the town's OWN yard rather than a trade partner's stack? */
export function isTownYard(ref: ScopeRef): boolean {
  return ref.kind === "town" && ref.key === "yard";
}

/**
 * ⚖️ DOES THIS SCOPE RECEIVE GOODS, or does it only YIELD them? (S&D S4.)
 *
 * A shelf, a yard, a crate, a pile, a body, a town — every one of them is
 * somewhere you may PUT something. A natural source is not: you take wood out
 * of a tree, and you cannot stock one. That single fact is what four separate
 * wilderness scans in `construction-director` were really testing —
 * *"a tree is not shelving"* — and stating it here means the readers ask a
 * question about the ENDPOINT rather than about the world's scenery.
 *
 * It is deliberately not "is it wild": a future source rendered as a mine
 * shaft, a fishery or an offloaded region source answers the same way, and an
 * OWNED source (a tamed cow, an orchard the town planted) still only yields.
 * Who may draw from it is `mayUse`'s question, not this one.
 */
export function scopeReceivesGoods(ref: ScopeRef): boolean {
  return ref.kind !== "wild";
}

/** The same question of a raw id — the one-liner every call site wants. */
export function scopeIdReceivesGoods(id: ScopeId): boolean {
  return scopeReceivesGoods(parseScopeId(id));
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
    case "wild": {
      // ⚖️ A STANDING SOURCE HANGS WHERE IT STANDS, exactly as it did while it
      // was parsed as a plain container (`buildingOfContainer` → the ground
      // scope under it) — this variant renamed the node, it did not move it.
      // An offloaded AREA hangs off NOTHING we model: its parent is the region,
      // the same honest null a trade partner's town answers. (Whether standing
      // timber should count in the town's roll-up at all is the world-size
      // round's question — recorded in the S4 landing notes, not decided here.)
      if (ref.form === "area") return null;
      return ctx.buildingOfContainer?.(scopeIdOf(ref)) ?? localTown(ctx);
    }
    case "district":
    case "building":
      return localTown(ctx);
    case "town":
      // OUR yard hangs off our town; the town itself and a PARTNER's town hang
      // off nothing we model yet (the region tier `condense` would feed).
      return isTownYard(ref) ? localTown(ctx) : null;
    case "band":
      // A mobile collective hangs off the REGION it walks — nothing this
      // session models: the same honest null a partner's town answers.
      return null;
    case "lot":
      // Partitioned ground hangs off the settlement that partitioned it —
      // prop → lot → town, the walk the community charter buys (#44).
      return localTown(ctx);
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
 *
 * Counts LOOSE units too when the host supplies the census (`looseIn`) — a
 * chair on the floor is a chair the session owns, and a probe blind to it
 * reports a craft that produced one as an item destroyed.
 */
export function auditScopeTree(input: ScopeTreeInput | ScopeStockInput): Record<string, number> {
  const nodes = walkScopeTree(input);
  const totals = auditStacks(nodes.map((n) => n.endpoint));
  const looseIn = (input as ScopeStockInput).looseIn;
  if (!looseIn) return totals;
  for (const n of nodes) addStack(totals, looseIn(n.id), true);
  return totals;
}

// ── Inventory ─────────────────────────────────────────────────────────────
//
// THE LAW, MADE ANSWERABLE (scope-unification.md): "A scope's inventory is not
// a field on the scope. It is the sum of its containers."
//
// Everything above this line is structure — what contains what. This is the one
// question the structure exists to answer, and until it existed every caller
// asked a NARROWER one of its own devising. The house asked "is there a
// `furn.workbench` unit in a stack whose id starts `furn_<hi>_`", which sees the
// bolted-down boxes and nothing else: not the bench lying on the floor of the
// very room, not the one in a resident's hands, not the one in the building's
// delivery pile. So a household that owned three workbenches went on making a
// fourth, because none of them was in a box. (Observed live 2026-08-05.)

/**
 * The tree, plus the units that are LYING IN a scope rather than stacked in one
 * of its containers.
 *
 * A loose prop IS one unit of its own glyph — that is the whole of item-prop.ts
 * ("a chair taken apart, a chair being carried and a chair delivered but not yet
 * assembled are ONE THING IN THREE SITUATIONS"). What it has never been is
 * COUNTABLE, because the ledger's unit of account is the stack and a prop has
 * no stack; its `containerStock` row is what it CONTAINS (a barrel's water),
 * never what it IS.
 *
 * 🚨 A CENSUS, NEVER AN ENDPOINT. You set a thing down onto a floor; you do not
 * ship into one. Giving the floor a `StockEndpoint` would hand callers a stack
 * that is not aliased to any real map, and `transferStock` would move units into
 * a temporary object — the exact shape of the vanishing-cargo bug item-move.ts
 * was written to end. So this stays a read-only view and the ONE way onto a
 * floor is still `setDownFromHands`.
 */
export interface ScopeStockInput extends ScopeTreeInput {
  /** Units lying loose in this scope, by glyph — a building's floor props, a
   *  body's hands. Absent/empty for a scope that cannot hold anything loosely
   *  (a chest's inside is its stack, not its floor). */
  looseIn?(id: ScopeId): Readonly<Record<string, number>> | null | undefined;
}

/** Merge a stack into an accumulator. `positiveOnly` drops the zero rows a
 *  drained stack leaves behind, so an empty box never reads as a holding. */
function addStack(
  into: Record<string, number>,
  from: Readonly<Record<string, number>> | null | undefined,
  positiveOnly = true,
): void {
  if (!from) return;
  for (const [glyph, n] of Object.entries(from)) {
    if (positiveOnly && !(n > 0)) continue;
    into[glyph] = (into[glyph] ?? 0) + n;
  }
}

/**
 * EVERY SCOPE CONTAINED BY `root`, at any depth — the containment closure, and
 * therefore the exact set a scope's inventory sums over. `root` itself is NOT
 * included: a caller that also wants the root's own stack adds it, and being
 * explicit about that is what keeps a container from counting itself twice when
 * it is both the root and a descendant of an enclosing walk.
 *
 * Pure and endpoint-free on purpose — the closure is a fact about the tree, so
 * a caller can compute it once and cache it while stacks churn underneath.
 * Input order is preserved (deterministic), and a cycle in a malformed context
 * terminates rather than hanging, exactly as `walkScopeTree` does.
 */
export function descendantScopeIds(
  root: ScopeId,
  ids: Iterable<ScopeId>,
  ctx: ScopeContext = {},
): ScopeId[] {
  const all = [...new Set(ids)];
  const parent = new Map<ScopeId, ScopeId | null>();
  for (const id of all) parent.set(id, scopeParentOf(parseScopeId(id), ctx));
  const out: ScopeId[] = [];
  for (const id of all) {
    if (id === root) continue;
    let cur = parent.get(id) ?? null;
    // Depth-bounded rather than visited-set: the ladder is five rungs deep
    // (hand → container → building → district → town) and a bound is cheaper
    // than a set per id, while still making a cyclic context terminate.
    for (let depth = 0; cur !== null && depth < 16; depth++) {
      if (cur === root) {
        out.push(id);
        break;
      }
      cur = parent.get(cur) ?? null;
    }
  }
  return out;
}

/**
 * WHAT EVERY SCOPE HOLDS, in one pass — each id mapped to its own stack plus
 * everything beneath it.
 *
 * THE FOLD the walk order was built for ("a parent must be visited knowing its
 * children"). Rolling up once and reading many is not an optimisation detail: a
 * town of 200 households asking "have we got a bench" one at a time is 200 walks
 * of the same few thousand ids every tick, and a gate that expensive gets
 * written as a regex over id strings instead — which is exactly the shortcut
 * that made a building's inventory unaskable in the first place.
 *
 * Cost is O(ids × depth); the ladder is five rungs.
 */
export function scopeStockIndex(input: ScopeStockInput): Map<ScopeId, Record<string, number>> {
  const ids = [...new Set(input.ids())];
  const parent = new Map<ScopeId, ScopeId | null>();
  for (const id of ids) parent.set(id, scopeParentOf(parseScopeId(id), input));
  const out = new Map<ScopeId, Record<string, number>>();
  const bucket = (id: ScopeId): Record<string, number> => {
    let b = out.get(id);
    if (!b) {
      b = {};
      out.set(id, b);
    }
    return b;
  };
  for (const id of ids) {
    const own: Record<string, number> = {};
    addStack(own, input.endpointOf(id)?.stack);
    addStack(own, input.looseIn?.(id));
    // Credit the scope itself and every ancestor — the roll-up. Depth-bounded
    // so a malformed (cyclic) context terminates instead of hanging, the same
    // guarantee `walkScopeTree` gives.
    let at: ScopeId | null = id;
    for (let depth = 0; at !== null && depth < 16; depth++) {
      addStack(bucket(at), own);
      at = parent.get(at) ?? null;
    }
  }
  return out;
}

/**
 * WHAT THIS SCOPE HOLDS, by glyph — its own stack (a chest has one; a building
 * and a body do not), plus every scope it contains, plus what lies loose in any
 * of them.
 *
 * This is the answer to "does this house have a bed", "is there wood in this
 * town", "is this body carrying an apple" — one question at every rung, which is
 * the point of the ladder. Glyphs are kept whole (facets and all); ask
 * `scopeUnits` when you want a head-matched count.
 */
export function scopeStock(root: ScopeId, input: ScopeStockInput): Record<string, number> {
  return scopeStockIndex(input).get(root) ?? {};
}

/**
 * Units of `glyph` this scope holds, anywhere inside it. The one call a gate
 * should make when it means "do we have one of these".
 *
 * MATCHING: a row counts when it IS the asked-for glyph or EXTENDS it with a
 * further facet — `apple` counts `apple.hot`, `block` counts
 * `block.material_stone`, and `furn.workbench` counts a red one but never a
 * chair.
 *
 * 🚨 Deliberately not `stackUnits` (head-matching). Furniture is spelled
 * `furn.<kind>` with the SAME dot the facet grammar uses, so every piece of
 * furniture in the game shares the head `furn` — head-matching a bench query
 * would answer yes for a stored chair, and the bench-first bootstrap would stop
 * on the first chair the household owned. The prefix rule degrades to exactly
 * head-matching for an ordinary undotted glyph, so nothing else changes.
 */
export function scopeUnits(root: ScopeId, glyph: string, input: ScopeStockInput): number {
  return unitsOf(scopeStock(root, input), glyph);
}

/** `scopeUnits`' matching rule over one stack — exported because a caller that
 *  already holds a rolled-up stack (the host's per-tick index) must count it the
 *  same way, and two spellings of "have we got one" is how this class of bug
 *  started. The PREFIX selector of goods-kinds.ts's `countUnits` core — see
 *  the 🚨 note above `scopeUnits` for why this is deliberately not a head
 *  match, and `UnitSelector`'s own docstring for the same warning carried
 *  into the shared vocabulary. */
export function unitsOf(stack: Readonly<Record<string, number>>, glyph: string): number {
  return countUnits(stack, { prefix: glyph });
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
