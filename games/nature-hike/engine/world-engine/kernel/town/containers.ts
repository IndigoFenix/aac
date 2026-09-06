// shared/world-engine/kernel/town/containers.ts
//
// WHAT HOLDS THINGS (scope-unification.md step ②).
//
// User law (2026-08-02): "creatures can carry or be equipped with containers
// (baskets being the prototype for a carried container, satchels for an
// equipped one) and those containers can contain items, which the creature can
// access… Just as a house has a box, a creature may carry a satchel."
//
// A container is a SCOPE, and the only thing that distinguishes a barrel in a
// kitchen from a basket on somebody's arm is where the scope hangs. So this
// module answers one question for both — *is this a container, how much does it
// hold, and how is it held* — and nothing else knows the answer.
//
// ── TWO CAPACITIES, DELIBERATELY ─────────────────────────────────────────
// They are different quantities and conflating them is a real bug waiting:
//   • UNITS      — the stack ledger's cap (`StockEndpoint.capacity`): how much
//                  wheat fits in the barrel. This module's `capacity`.
//   • INSTANCES  — how many whole OBJECTS sit visibly in/on it
//                  (`ObjectSpec.contains[].capacity`): the props a table shows.
// A basket holding eight units of grain still only shows a couple of props.
// `INSTANCE_SLOTS` is the convention every container in the game already uses.

import { blockCosts, furnitureBlocks } from "./block-bill.js";
import { furnitureKindOfGlyph, STATION_PROPERTIES, type StationKind } from "./stations.js";

/** How a body holds a portable container. */
export type HoldMode =
  /** In the hands — it occupies them, so a carried basket is a real cost. */
  | "carry"
  /** On the body — the hands stay free. The satchel's whole point. */
  | "wear";

export interface ContainerDef {
  /** UNITS it holds (the stack cap). */
  capacity: number;
  /** `in` = hidden behind a lid, `on` = shown on a surface. */
  relation: "in" | "on";
  /** Present ⇒ PORTABLE: a body can hold it. Absent ⇒ furniture, it stands. */
  hold?: HoldMode;
}

/**
 * HOW A BAG IS MADE — the same shape `FurnitureItemDef.craft` uses, so
 * `craftRecipeOf` (interaction/content/makeable.ts) reads one recipe kind for
 * furniture, toys and bags alike and the craft job never learns which it got.
 *
 * `at` is the station that ACCELERATES the work, never a gate
 * (`stations.ts craftLaborDaysFor`): a body with no workbench still makes it,
 * slowly, by hand.
 */
export interface PortableCraftDef {
  /** The station that speeds the work. Never required to start it. */
  at?: StationKind;
  /** Materials consumed, head-paid (`craftItems`' atomic consume-and-produce). */
  consumes: Record<string, number>;
}

/**
 * A PORTABLE row — a bag proper. Two fields the furniture branch never has:
 *
 *  • `seeded` — DOES THE WORLD STOCK IT? Baskets and satchels are laid down by
 *    `container-seeds.ts` in every house, market and yard, so a poster may
 *    assume one exists. A cart must be MADE, so it may not be assumed
 *    (see `haulTripUnits`, and ⚖️ C3 of the pull-labor round).
 *  • `craft` — the recipe, HERE beside the capacity rather than in a table of
 *    its own. ⚖️ ONE OWNER FOR "WHAT A BAG IS": capacity, hold mode, whether
 *    the world stocks it and what it costs to make are one row, so a new bag
 *    is one edit and none of the four facts can drift from the other three.
 *    (`PORTABLE_CONTAINER_ITEMS`, the alternative shape, would have been a
 *    second list keyed by the same head — the drift this avoids.)
 */
export interface PortableContainerDef extends ContainerDef {
  hold: HoldMode;
  seeded: boolean;
  craft?: PortableCraftDef;
}

/** A hand cart's half-extent, world metres — the dimension its bill is read
 *  off, exactly as a piece of furniture's is read off its own radius. A cart
 *  you push in front of you is about 1.4 m end to end. */
export const CART_HALF_EXTENT_M = 0.7;

/** Whole objects a container shows in/on itself — the town-stage convention,
 *  unchanged. Not the unit cap; see the header. */
export const INSTANCE_SLOTS = 2;

/**
 * THE PORTABLE CONTAINERS — a creature's own storage, and the reason a body
 * will ever be able to haul more than it can hold in two hands.
 *
 * The basket and the satchel differ in exactly one field, and that field is the
 * whole point: you hold a basket, so it costs you a hand; you WEAR a satchel,
 * so it does not. When carry becomes bounded (step ③) that is the difference
 * between being able to fetch something while already carrying something, and
 * not.
 *
 * A satchel holds less than a basket for the same reason — it is on your body,
 * not swinging from your arm.
 *
 * 🛒 THE CART (user ruling 2026-09-05: *"there is no path to creating baskets…
 * carts would be a good addition as a basic object — more associated with
 * carrying large numbers of heavy objects, were one of the earliest
 * technologies, can be made from wood and are still in use today. They can be
 * made from blocks."*).
 *
 * It is a third row of this table and nothing else — every capacity hook in the
 * game already reads here (`haulTripUnits`, `bagFetchGoal`, `haulBagLeg`,
 * `idleBagsFor`, the `@tool` claim, the floor put-down, `mayDissolveToStack`),
 * so a bag that holds three times as much needs no new machinery, only an
 * honest row.
 *   • 24 units — 3× the basket ("large numbers of heavy objects"), and it
 *     divides the frontier cottage's 120-block bill exactly (5 loads).
 *   • `hold: "carry"` — a cart takes your hands, the same trade a basket makes.
 *     (A TOWED cart, following its holder, would be a fifth item location and
 *     the conservation law has a closed set of four. Refused, deliberately.)
 *   • `seeded: false` — nothing lays a cart down. It is MADE, which is the
 *     user's whole complaint answered, and the reason `seeded` exists.
 *   • The bill is DERIVED, not painted: a 0.7 m half-extent through the rule
 *     furniture already bills by (`furnitureBlocks`) = 4 blocks = 8 wood ≈ half
 *     a felled oak. A bigger cart would cost more without anybody guessing.
 */
export const PORTABLE_CONTAINERS: Readonly<Record<string, PortableContainerDef>> = {
  basket: { capacity: 8, relation: "in", hold: "carry", seeded: true },
  satchel: { capacity: 5, relation: "in", hold: "wear", seeded: true },
  cart: {
    capacity: 24,
    relation: "in",
    hold: "carry",
    seeded: false,
    craft: { at: "workbench", consumes: blockCosts(furnitureBlocks(CART_HALF_EXTENT_M)) },
  },
};

/**
 * UNITS ONE BODY CAN MOVE IN ONE TRIP — the biggest portable container the
 * world may be ASSUMED to have (a basket today), or the one whole thing a
 * bagless body carries in its hands when it declares no portable container at
 * all.
 *
 * ⚖️ WHY A POSTER NEEDS THIS (#50 ①). A haul is posted long before anybody
 * claims it, so the poster cannot ask a body what IT can hold
 * (`stackRoom`/`carryCapacityOf`, which are net-of-contents and per-body).
 * What it can honestly ask is the CEILING: no single trip will ever move more
 * than the largest bag in the world holds, because `haulBagLeg` fetches at
 * most one bag and `giveUnitsToBody` refuses the rest. A 24-wood agreement
 * against an 8-unit basket was three serial trips behind one 20 s retry gate
 * — and completed announcing "bring 24 wood — delivered" over 8 delivered
 * units. Sizing the row to this number makes N porters work in parallel and
 * every delivery toast true.
 *
 * 🚨 SEEDED ROWS ONLY — A HAUL IS NEVER SIZED TO A BAG THE WORLD MAY NOT HAVE
 * (⚖️ C3, pull-labor round). This docblock used to end "so adding a cart moves
 * this number with it". That is exactly what it must NOT do. A cart is `seeded:
 * false`: it exists only where somebody made one, so a global max over the
 * whole table would cut every posted pile-haul row at 24 in every world — and a
 * basket porter handed a 24-unit agreement delivers 8 of it, which is the lie
 * #50 fixed, restored. So the ceiling is the max over rows the world STOCKS
 * (`container-seeds.ts`), and it stays 8 the day the cart lands.
 *
 * A cart still pays, on the PULL path: `decideContribution` sizes each slice to
 * the body's OWN bag (`bagCeilingOf`), so a cart standing in the yard raises
 * that puller's slice to 24 the sweep after it exists — no catalogue optimism
 * needed. The push path under-uses a cart until it retires; accepted.
 *
 * DERIVED, never a literal: the capacity lives on the container definitions and
 * nowhere else, so a new SEEDED bag moves this number with it.
 */
export function haulTripUnits(): number {
  let best = 1; // no bag at all ⇒ one whole thing in the hands (scope-shape.ts)
  for (const def of Object.values(PORTABLE_CONTAINERS)) {
    if (!def.seeded) continue;
    best = Math.max(best, def.capacity);
  }
  return best;
}

/**
 * THE RECIPE FOR A BAG, or null when nothing makes one (a basket is woven, not
 * carpentered — a fibre craft, when the world has a weaver). Takes a glyph or a
 * bare symbol: a red cart is still a cart.
 *
 * The single reader is `craftRecipeOf` (interaction/content/makeable.ts), which
 * is where the three — soon four — makeable families meet.
 */
export function portableCraftOf(glyph: string): PortableCraftDef | null {
  const head = glyph.split(".")[0] ?? glyph;
  return PORTABLE_CONTAINERS[head]?.craft ?? null;
}

/** Portable containers a body WEARS — they leave the hands free, so a body may
 *  hold something else at the same time. (`carry` mode occupies a hand.) */
export function isWornContainer(glyph: string): boolean {
  return containerDefOfGlyph(glyph)?.hold === "wear";
}

/** Furniture container kinds hold this many units when nothing else says
 *  otherwise. A goods box overrides it from the good's own `boxCap` — the
 *  economy sizes a pantry, not this table. */
export const FURNITURE_CONTAINER_CAP = 12;

/** Is this station kind a container at all? The spec-side authority
 *  (STATION_PROPERTIES) answers, so the board and the sim cannot disagree. */
export function isContainerKind(kind: StationKind): boolean {
  return STATION_PROPERTIES[kind]?.includes("container") ?? false;
}

/**
 * The container a glyph names, or null for anything that holds nothing.
 *
 * Covers both rungs: a furniture stack (`furn.barrel`) and a portable item
 * (`basket`). A LOOSE barrel is as much a container as a standing one — the
 * water does not pour out because somebody tipped it over — which is the whole
 * point of the shape.
 */
export function containerDefOfGlyph(glyph: string): ContainerDef | null {
  const kind = furnitureKindOfGlyph(glyph);
  if (kind) {
    if (!isContainerKind(kind)) return null;
    // A shelf and a table SHOW their contents; a lidded piece hides them. The
    // openable flag is the mechanic's own answer (properties.ts derives the
    // board's word from the same place).
    const shown = kind === "shelf" || kind === "table" || kind === "bowl";
    return { capacity: FURNITURE_CONTAINER_CAP, relation: shown ? "on" : "in" };
  }
  const head = glyph.split(".")[0] ?? glyph;
  return PORTABLE_CONTAINERS[head] ?? null;
}

/** Does this glyph name something a body can pick up AND put things inside? */
export function isPortableContainer(glyph: string): boolean {
  return !!containerDefOfGlyph(glyph)?.hold;
}

/**
 * 🚨 MAY THIS BECOME A COUNTABLE UNIT?
 *
 * A scope cannot be a number. Putting a barrel into a chest used to dissolve it
 * into one `furn.barrel` tally in the chest's stack — and the barrel's own
 * stock, keyed by the object id that just stopped existing, was orphaned. That
 * is the reported bug: water visible in a deconstructed barrel, gone once the
 * barrel had been put in a box and stood up again. The refrigerator kept its
 * food only because nobody ever boxed it.
 *
 * So: an EMPTY container stacks like any other item (a flat-packed barrel is
 * just a barrel), and a FULL one stays a whole object wherever it goes.
 */
export function mayDissolveToStack(
  glyph: string,
  contents: Readonly<Record<string, number>> | undefined,
): boolean {
  if (!containerDefOfGlyph(glyph)) return true; // not a container: always a unit
  if (!contents) return true;
  return Object.values(contents).every((n) => (n ?? 0) <= 0);
}

// ═══════════════════════════════════════════════════════════════════════
// ⑤ THE CONTAINER RECORD (worklist ⑤ — one container record) — replaces
// five independently-keyed Maps that used to live on QuestSession
// (`containers`, `containerStock`, `containerOwner`, `smallProps`,
// `wornBags`) and carried one object's state across up to four of them at
// once — a container that was also lying loose (a dropped basket) needed a
// row in `containers` + `containerStock` + `containerOwner` + `smallProps`,
// kept in lock-step by hand at every call site.
//
// Lives HERE (kernel, not quest-host.ts) so construction-director.ts can
// reach it too: quest-host.ts imports FROM construction-director.ts, and
// the reverse is a forbidden cycle (quest-host.ts's own header law) — but
// both may import a lower kernel module. `ContainerRegistry` is the narrow
// structural slice of `QuestSession` these helpers need; `QuestSession`
// (interaction/quest/quest-host.ts) satisfies it without saying so.
//
// Every registered id gets exactly one row in `registry.containerRecords`.
// Which fields are populated depends on `mount`:
//  - `"standing"` — a fixed container with no concrete world instance: most
//    furniture (a cupboard, a barrel), the town yard, a founded site's
//    pile. `relation`/`stock`/`owner` are set; `glyph`/`entityId`/`at` are
//    not — the old stores never carried a glyph for these either (only
//    `smallProps`/`wornBags` did).
//  - `"loose"` — a concrete instance lying in the world, registered exactly
//    as `smallProps` used to (`glyph`, `entityId`, `at` — the tidy-grace
//    timestamp). `relation`/`stock`/`owner` are ALSO set when the glyph is
//    itself a container kind (a dropped basket is still a container); a
//    plain prop (an apple) leaves them unset.
//  - `"worn"` — an equipped container: `glyph` + `wearer` (the creature id,
//    mirroring `registry.wornBagIndex`) plus `relation`/`stock`/`owner`. No
//    world instance while worn, so no `entityId`/`at` — `doffWornBag`
//    (quest-host.ts, which alone touches live world objects) mints a fresh
//    entityId on the way back out, exactly as before.
//
// 🚨 `"held"` (a container in a body's HAND) is deliberately NOT a stored
// mount: which loose object a body is holding is live world state
// (`object.carriedBy`), read fresh by `bodyCarryOf` exactly as it always
// was — storing it here would be a second place that fact could go stale.
//
// `owner` is USUALLY set together with `relation` (a container's owner),
// but not always — a bed is not a container (no `contains` slots) yet
// still has one, so a row can carry `owner` alone on an otherwise-bare
// `"standing"` record.
export type ContainerMount = "standing" | "loose" | "worn";

export interface ContainerRecord {
  /** mount:"loose" | "worn" — the concrete instance's stack glyph. */
  glyph?: string;
  /** Set only when this id IS a container (had a `containers` row before). */
  relation?: "in" | "on";
  /** The container's live stock — the alias law: callers hold onto this same
   *  object, never a copy. Set together with `relation`, usually. */
  stock?: Record<string, number>;
  /** The owner scope (ownership.ts), or null for communal/nobody's. */
  owner?: string | null;
  mount: ContainerMount;
  /** mount:"loose" — the materialized world-item id backing the prop. */
  entityId?: string;
  /** mount:"loose" — townClock when the prop hit the floor (tidy grace). */
  at?: number;
  /** mount:"worn" — the creature wearing it (mirrors `wornBagIndex`). */
  wearer?: string;
  /** mount:"loose", containedIn set — the prop is a MIRROR: a visible shell
   *  of ONE unit that is banked on the CONTAINING box's stack (a table
   *  rendering its contents). The loose census must skip it or that unit
   *  counts twice; a prop stowed as a WHOLE object (a full basket in a
   *  crate) carries no flag and counts as itself. `setLooseProp` clears it —
   *  re-registering IS the conversion back into a real thing. */
  mirror?: boolean;
}

/** The narrow structural slice of `QuestSession` these helpers need — a
 *  `QuestSession` satisfies this without importing it (see header). */
export interface ContainerRegistry {
  containerRecords: Map<string, ContainerRecord>;
  wornBagIndex: Map<string, string>;
}

// ── accessor helpers — the ONLY mutation seam for `containerRecords` /
// `wornBagIndex`. Never `.set`/`.delete` either map directly outside this
// file, or the wearer index can drift out of step with its record. ────────

/** Get-or-create a row. A bare id nobody has registered yet starts life as
 *  an empty `"standing"` record — the default for "no loose/worn state" —
 *  and the caller fills in whichever fields its own registration means. */
export function recordOf(registry: ContainerRegistry, id: string): ContainerRecord {
  let rec = registry.containerRecords.get(id);
  if (!rec) {
    rec = { mount: "standing" };
    registry.containerRecords.set(id, rec);
  }
  return rec;
}

/** Was `id` ever registered as a container (an old `containers.has`)? */
export function isContainerId(registry: ContainerRegistry, id: string): boolean {
  return registry.containerRecords.get(id)?.relation !== undefined;
}

/** Register/update `id` as a CONTAINER — the old `containers` +
 *  `containerOwner` pair, plus `containerStock` ONLY when a stock object is
 *  given. Leaves `mount`/`glyph`/`entityId`/`at` untouched when the row
 *  already exists (a loose prop that is ALSO a container keeps its loose
 *  fields — the barrel sitting on the floor is still `mount:"loose"`); a
 *  fresh id defaults to `"standing"` via `recordOf`.
 *
 *  🚨 STOCK IS DELIBERATELY LEFT UNSET WHEN OMITTED, never defaulted to
 *  `{}` here — the old stores left plenty of containers (a cupboard, a
 *  table, a member's box) with a `containers`/`containerOwner` row and NO
 *  `containerStock` entry at all until the first real write
 *  (`ensureContainerStock` is that lazy door). At least one caller reads
 *  that absence as its own signal (construction-director.ts's workbench
 *  search: "an untouched non-openable surface is not a candidate box"), so
 *  eagerly creating `{}` here would be an observable behavior change, not
 *  just an internal bookkeeping nicety. */
export function registerContainer(
  registry: ContainerRegistry,
  id: string,
  relation: "in" | "on",
  owner: string | null,
  stock?: Record<string, number>,
): ContainerRecord {
  const rec = recordOf(registry, id);
  rec.relation = relation;
  rec.owner = owner;
  if (stock) rec.stock = stock;
  return rec;
}

/** Update just the owner of an already (or about to be) registered
 *  container — the old standalone `containerOwner.set`. */
export function setContainerOwner(registry: ContainerRegistry, id: string, owner: string | null): void {
  recordOf(registry, id).owner = owner;
}

/** Attach/replace a container's live stock object — the old standalone
 *  `containerStock.set`. */
export function setContainerStock(registry: ContainerRegistry, id: string, stock: Record<string, number>): void {
  recordOf(registry, id).stock = stock;
}

/** The live stock map for a container, CREATING an empty one (and
 *  registering `id`, mount `"standing"` by default) the first time anyone
 *  writes to it — the old unconditional `if (!stock) { stock = {}; ...set }`
 *  ensure. The alias law: callers keep this exact object, never a copy. */
export function ensureContainerStock(registry: ContainerRegistry, id: string): Record<string, number> {
  const rec = recordOf(registry, id);
  if (!rec.stock) rec.stock = {};
  return rec.stock;
}

/** Container ids and their rows — the old `containers` (+ `containerStock`,
 *  since the tree's `ids()` used to enumerate both to catch a stocked-but-
 *  unstaged container; one map now answers both — every container gets a
 *  `relation`, whether or not it has ever been written to). */
export function* containerEntries(registry: ContainerRegistry): IterableIterator<[string, ContainerRecord]> {
  for (const [id, rec] of registry.containerRecords) if (rec.relation !== undefined) yield [id, rec];
}
/** Container ids only — the old `containers.keys()`. */
export function* containerIds(registry: ContainerRegistry): IterableIterator<string> {
  for (const [id, rec] of registry.containerRecords) if (rec.relation !== undefined) yield id;
}

/** Rows that have EVER been written to — the old `containerStock`
 *  Map/its `.keys()`/`.values()`/iteration. NOT the same set as
 *  `containerEntries`: `registerContainer` leaves `stock` unset until a
 *  caller actually puts something in (a fresh cupboard is a container from
 *  the moment it's registered, but has no `containerStock` row until the
 *  first deposit) — this iterates only the rows that DO have one. */
export function* stockedEntries(registry: ContainerRegistry): IterableIterator<[string, ContainerRecord]> {
  for (const [id, rec] of registry.containerRecords) if (rec.stock !== undefined) yield [id, rec];
}
export function* stockedIds(registry: ContainerRegistry): IterableIterator<string> {
  for (const [id, rec] of registry.containerRecords) if (rec.stock !== undefined) yield id;
}
/** Is there a `containerStock` row for `id` — the old `containerStock.has`. */
export function hasStock(registry: ContainerRegistry, id: string): boolean {
  return registry.containerRecords.get(id)?.stock !== undefined;
}

/** How many rows are registered containers right now — the old
 *  `containers.size` (a change-detection heuristic). Named apart from
 *  quest-host's own `containerCount(session, objId)` (total ITEMS in one
 *  container) — same word, a different question. */
export function registeredContainerCount(registry: ContainerRegistry): number {
  let n = 0;
  for (const rec of registry.containerRecords.values()) if (rec.relation !== undefined) n++;
  return n;
}

/** How many rows have a `containerStock` entry — the old `containerStock.size`
 *  (a DIFFERENT, usually smaller count than `registeredContainerCount`: see
 *  `stockedIds`). */
export function stockedCount(registry: ContainerRegistry): number {
  let n = 0;
  for (const rec of registry.containerRecords.values()) if (rec.stock !== undefined) n++;
  return n;
}

/** Fully unregister `id` — the old `containers`+`containerStock`+
 *  `containerOwner`(+`smallProps` when it was also loose) delete-together. */
export function deleteContainerRecord(registry: ContainerRegistry, id: string): void {
  registry.containerRecords.delete(id);
}

/** Is `id` currently a LOOSE prop (an old `smallProps.has`)? Mount-gated,
 *  not a bare map hit — an id that is presently `"worn"` or `"standing"`
 *  answers false exactly as a `smallProps` miss would have. */
export function isLooseProp(registry: ContainerRegistry, id: string): boolean {
  return registry.containerRecords.get(id)?.mount === "loose";
}

/** The loose-prop row for `id` (an old `smallProps.get`) — undefined
 *  unless it is CURRENTLY loose (mount-gated, see `isLooseProp`). */
export function loosePropOf(registry: ContainerRegistry, id: string): ContainerRecord | undefined {
  const rec = registry.containerRecords.get(id);
  return rec?.mount === "loose" ? rec : undefined;
}

/** Register a fresh loose prop row — the old `smallProps.set`. Preserves
 *  any container fields the row already carried (re-registering a prop
 *  that is also a container, e.g. `doffWornBag`, must not blank them). */
export function setLooseProp(
  registry: ContainerRegistry,
  id: string,
  fields: { entityId: string; glyph: string; at?: number },
): ContainerRecord {
  const rec = recordOf(registry, id);
  rec.mount = "loose";
  rec.entityId = fields.entityId;
  rec.glyph = fields.glyph;
  if (fields.at !== undefined) rec.at = fields.at;
  else delete rec.at;
  delete rec.mirror; // a fresh loose registration is a REAL prop, not a shell
  return rec;
}

/** Clear ONLY the loose-prop aspect of a row — the old bare
 *  `smallProps.delete`, which never touched `containers`/`containerStock`/
 *  `containerOwner`. A row that is ALSO a container (rare — a mirror prop
 *  never is; a dropped basket is the real case) keeps its container fields
 *  and falls back to `"standing"`; a plain prop's row disappears entirely. */
export function clearLooseProp(registry: ContainerRegistry, id: string): void {
  const rec = loosePropOf(registry, id);
  if (!rec) return;
  if (rec.relation === undefined) {
    registry.containerRecords.delete(id);
  } else {
    rec.mount = "standing";
    delete rec.entityId;
    delete rec.at;
    delete rec.mirror; // the shell aspect dies with the loose aspect
  }
}

/** Loose rows and their ids — the old `smallProps` Map/its `.keys()`. */
export function* looseEntries(registry: ContainerRegistry): IterableIterator<[string, ContainerRecord]> {
  for (const [id, rec] of registry.containerRecords) if (rec.mount === "loose") yield [id, rec];
}
export function* looseIds(registry: ContainerRegistry): IterableIterator<string> {
  for (const [id, rec] of registry.containerRecords) if (rec.mount === "loose") yield id;
}
/** How many rows are loose right now — the old `smallProps.size`. */
export function looseCount(registry: ContainerRegistry): number {
  let n = 0;
  for (const rec of registry.containerRecords.values()) if (rec.mount === "loose") n++;
  return n;
}

/** The worn-bag row for `cid` (an old `wornBags.get`), shaped exactly as
 *  `wornBags` used to hand back — `wornBagIndex` only stores the objId,
 *  the glyph lives on the container's own row. */
export function wornBagOf(registry: ContainerRegistry, cid: string): { objId: string; glyph: string } | undefined {
  const objId = registry.wornBagIndex.get(cid);
  if (!objId) return undefined;
  const glyph = registry.containerRecords.get(objId)?.glyph ?? "";
  return { objId, glyph };
}
