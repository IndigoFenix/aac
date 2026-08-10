// shared/world-engine/kernel/town/scope-shape.ts
//
// THE UNIVERSAL SHAPE — the organs every scope has, and the BODY's binding of
// them (planning-docs/games/world-engine/scope-unification.md §2–§4, step ③).
//
// User law (2026-08-02): "Creatures no longer have abstract inventory.
// Instead, creatures can carry or be equipped with containers (baskets being
// the prototype for a carried container, satchels for an equipped one) and
// those containers can contain items, which the creature can access. A
// creature is the same shape as a structure."
//
// ── WHAT THIS MODULE IS ───────────────────────────────────────────────────
// scope.ts is the GRAMMAR and the TREE: what an id means, what contains what.
// This module is the ANATOMY: the organs a scope has regardless of its rung —
// extent, hands, legs, fixtures, containers — and the pure rules that bind
// them for a BODY, the first scope to live fully under the law. A town's and
// a caravan's bindings arrive with steps ⑤–⑥ of the chapter; the organ docs
// say what each will bind to so the types don't drift toward "creature".
//
// 🚨 INVENTORY IS NEVER A FIELD. A scope's stock is the sum of its
// containers' stacks, one level down (§3.5). The fold here
// (`sumContainerStacks`, `bodyCarryView`) is a READ-ONLY merge for display
// and deciding; mutations go to the ONE container that holds the units,
// because `StockEndpoint.stack` is an alias of a live map and a merged copy
// could never be. That constraint is why a body has an ACTIVE BAG rather
// than a pooled inventory: one writable stack at a time keeps the alias law.

import type { ScopeId } from "./scope.js";
import { totalStackUnits } from "./goods-kinds.js";

// ── The organs (§3) ───────────────────────────────────────────────────────

export interface ScopeExtent {
  at?: { x: number; y: number };
  /** The radius inside which this scope can act without the journey being its
   *  own decision (§3.1). Five existing names for this one quantity: a body's
   *  reach, a building's footprint, a district's `serviceRadiusM`, a town's
   *  `civicRecruitRadius`, a region's freight reach. */
  reachM: number;
}

/** §3.2 — the concurrency limit. A body's graspers (or jaw), a household's
 *  free members, a building's nearby idle hands, a town's labour pool, a
 *  caravan's porters. The count generalizes; its SOURCE does not (a body's
 *  is anatomical and cannot be hired — chapter §7). */
export interface ScopeHands {
  total: number;
  free: number;
}

/**
 * ⚖️ THE TOWN'S HANDS, COUNTED (economy arc batch 2, L3) — the first
 * non-body producer of {@link ScopeHands}, and the reason the organ stopped
 * being inert.
 *
 * A town's labour pool is not a decree, it is a CENSUS of the roster's own
 * rows: every employable resident, minus the ones another schedule already
 * owns. `total` is what the town could field if nothing else were happening
 * to it; `free` is what it can field RIGHT NOW.
 *
 * ⚠️ SHOP DUTIES ARE SUBTRACTED WHOLE, not by trip phase. `assignTownJobs`
 * already refuses to hire a member that holds one ("v1 keeps duties disjoint
 * — the shop clock and a shift can't contest one body"), so the goods clock
 * owns that body all day whether or not it happens to be walking right now.
 * Counting mid-trip shoppers instead would mean routing every household's
 * errand every sweep, which is a pathfinding sweep, not a reading.
 */
export interface TownHandCensus {
  /** Employable residents the roster deals duties to. */
  employable: number;
  /** Members holding a SHOP duty (the goods clock owns them). */
  shopDuty: number;
  /** Members inside a JOB shift window right now. */
  onShift: number;
  /** Bodies a pooled claim or the live-need loop has taken over. */
  committed: number;
}

export function townHandPool(c: TownHandCensus): ScopeHands {
  const total = Math.max(0, c.employable - Math.max(0, c.shopDuty) - Math.max(0, c.onShift));
  return { total, free: Math.max(0, total - Math.max(0, c.committed)) };
}

/**
 * ⚖️ ONE POOL, N CLAIMS — the conserving split (economy arc batch 2, L4).
 *
 * `allocateDistrictFill`'s shape (city-districts.ts) at the hands rung: an
 * even FLOOR first so no claim is starved by being late in the order, then
 * the remainder poured in the caller's own deterministic order (founding
 * order, for building sites), every claim capped, and Σ EXACTLY the supply
 * when the supply is the binding constraint.
 *
 * The property that matters: `free ≥ Σ caps` returns `caps` verbatim, so a
 * town with one site and hands to spare allocates exactly what the old
 * per-site constant did — the whole point being that ten sites can no longer
 * each mint a full crew out of twelve residents.
 */
export function allocateHands(caps: readonly number[], free: number): number[] {
  const n = caps.length;
  if (n === 0) return [];
  const want = caps.map((c) => Math.max(0, c));
  const supply = Math.max(0, free);
  const demand = want.reduce((a, b) => a + b, 0);
  if (supply >= demand) return want;
  const even = supply / n;
  const out = want.map((c) => Math.min(c, even));
  let remaining = supply - out.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n && remaining > 1e-12; i++) {
    const take = Math.min(want[i]! - out[i]!, remaining);
    if (take > 0) {
      out[i]! += take;
      remaining -= take;
    }
  }
  return out;
}

/** §3.3 — present ⇒ the scope can move. A caravan is a house with legs; a
 *  house is a caravan that stopped (`bands.ts`: settling when
 *  store > carryCapacity is the master transition). */
export interface ScopeLegs {
  speedMps: number;
}

export interface ScopeOrgans {
  extent: ScopeExtent;
  hands: ScopeHands;
  legs: ScopeLegs | null;
  /** Installed children that grant affordances (§3.4): garments and a worn
   *  satchel on a body, furniture in a room, buildings on a lot. */
  fixtures: ScopeId[];
  /** The containers whose stacks ARE this scope's inventory (§3.5). */
  containers: ScopeId[];
}

// ── The verbs (§4) ────────────────────────────────────────────────────────

/** One vocabulary at every rung. `get` = move something outside this scope's
 *  control into its inventory — pick it up / buy it / import it. Four of the
 *  eight are already written once each (`moveItems`, `craftItems`, the
 *  construction pipeline); the vocabulary exists so the planner can carry a
 *  cost per verb instead of a behavior per scope. */
export type ScopeVerb =
  | "get"
  | "put"
  | "give"
  | "make"
  | "install"
  | "remove"
  | "move"
  | "condense"
  | "expand";

/** The cost shape every verb shares (§6) — the planner's seat. Step ④ fills
 *  in the comparison; this fixes the TERMS so operators can start carrying
 *  them. Everything is priced in seconds of a hand's time, so "fetch the
 *  basket first" and "send the caravan" are the same arithmetic at different
 *  constants. */
export interface VerbCost {
  /** Walking/hauling time the plan's legs must spend. */
  journeyS: number;
  /** Hand-seconds occupied executing (loading, crafting, installing). */
  handsS: number;
  /** Hand-seconds' worth expected to rot away en route (freight.ts
   *  `storedFraction` is the top-rung source of this term). */
  spoilageS: number;
  /** What those hands would otherwise have produced (opportunity). */
  forgoneS: number;
}

export const costTotalS = (c: VerbCost): number => c.journeyS + c.handsS + c.spoilageS + c.forgoneS;

// ── The body's binding (step ③) ───────────────────────────────────────────
//
// A body's inventory is what it is PHYSICALLY holding:
//   · the hands (or jaw): AT MOST ONE whole object, through the one door
//     (takeIntoHands / setDownFromHands). A container held in hand doubles as
//     a bag the body can stack into.
//   · a worn container (satchel): hands stay free.
// `needCarried` and `pocket` — the abstract bags — are what this deletes.

export interface BagRef {
  objId: string;
  glyph: string;
  /** The container's LIVE stock map — the alias law: the same object
   *  `session.containerStock` holds, never a copy. */
  stock: Record<string, number>;
  /** Unit capacity (containers.ts `ContainerDef.capacity`). */
  capacity: number;
}

export interface BodyCarry {
  /** What the hands hold: at most ONE object. When that object is a portable
   *  container, `bag` is set and the body can stack into it. */
  inHand: { objId: string; glyph: string; bag?: BagRef } | null;
  /** An equipped container. Wearing is an `install` at body scope — the
   *  satchel is a FIXTURE of the body, exactly as a chest is of a house. */
  worn: BagRef | null;
}

/**
 * THE ACTIVE BAG — the one container this body's stack operations route to.
 * A carried basket wins over a worn satchel: it was brought deliberately, and
 * it is the bigger one. ONE writable stack at a time is what lets
 * `StockEndpoint.stack` stay a live alias — a body with both still shows both
 * in the merged view, but units land in the basket until it is set down.
 */
export function activeBag(carry: BodyCarry): BagRef | null {
  return carry.inHand?.bag ?? carry.worn ?? null;
}

/** Can the hands take one more whole object through the one door? */
export function handsFree(carry: BodyCarry): boolean {
  return carry.inHand === null;
}

/**
 * UNITS this body can still take into stacks. No bag → the hands slot (one
 * unit fetched as a real instance), if it is free. This number is what makes
 * "bring a basket to market" a real decision: without one, every trip moves
 * one unit, and the difference is priced by step ④ rather than scripted.
 */
export function stackRoom(carry: BodyCarry): number {
  const bag = activeBag(carry);
  if (bag) return Math.max(0, bag.capacity - totalStackUnits(bag.stock));
  return handsFree(carry) ? 1 : 0;
}

// ── The fold (§3.5) ───────────────────────────────────────────────────────

/**
 * THE LAW AS A FOLD — a scope's inventory is the sum of its containers'
 * stacks, one level down. READ-ONLY merged copy, for display and deciding
 * (the pocket strip, "what does this house hold, all in"). There is
 * deliberately no writable merged view; writers pick a container.
 */
export function sumContainerStacks(
  stacks: Iterable<Readonly<Record<string, number>>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of stacks) {
    for (const [g, n] of Object.entries(s)) {
      if (n > 0) out[g] = (out[g] ?? 0) + n;
    }
  }
  return out;
}

/**
 * Everything the body has on it, merged for DISPLAY (the inventory strip,
 * dialogue's "what are you carrying?"): the hands instance counts as one unit
 * of its glyph; bags contribute their stacks. The bag OBJECT itself is not a
 * row — it is the shelf, not the goods; the world already shows it riding the
 * body. Read-only.
 */
export function bodyCarryView(carry: BodyCarry): Record<string, number> {
  const stacks: Record<string, number>[] = [];
  if (carry.inHand && !carry.inHand.bag) stacks.push({ [carry.inHand.glyph]: 1 });
  if (carry.inHand?.bag) stacks.push(carry.inHand.bag.stock);
  if (carry.worn) stacks.push(carry.worn.stock);
  return sumContainerStacks(stacks);
}
