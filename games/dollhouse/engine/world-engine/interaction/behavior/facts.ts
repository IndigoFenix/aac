// shared/world-engine/interaction/behavior/facts.ts
//
// ONE sharable Fact model (creature-knowledge.md): every kind of information a
// creature can hold is a FACT, and every fact travels through ONE channel —
// you learn it by SEEING it or by being TOLD it, and telling writes the exact
// fact a sighting would (the shipped seeItem/tellAbout pattern, generalized).
//
// PHASE 1 IS ADDITIVE (creature-knowledge.md §6): the certified location/want
// paths in creatures.ts stay the single writers — the `location` and `want`
// arms here are ADAPTERS that read through to `knowledge`/`knownWants` and
// delegate writes to them. New arms (itemState/condition/presence) live in the
// one optional `CreatureState.facts` store. Folding the old stores in is a
// deliberate later refactor (step 3) — the puzzle certifier depends on them.
//
// Coverage is monotone (a known axis/subject is never forgotten); the VALUE may
// flip (open → closed replaces, never accumulates). In world-sim mode a told
// fact is a BELIEF — consumers that act on one re-check reality, exactly as
// knownHoldings already does for locations.

import type {
  CreatureEvent,
  CreatureId,
  CreatureWorld,
  ItemId,
  ItemLocation,
} from "./creatures.js";
import { seeItem } from "./creatures.js";

// ---------------------------------------------------------------------------
// State axes — open/closed are POLES of one axis, not two facts
// ---------------------------------------------------------------------------

export type StateAxis = "aperture" | "temperature" | "cleanliness" | "moisture" | "power" | "smell";

/** STATE_TAGS (creatures.ts) → the axis each pole belongs to. A new pole on
 *  the same axis REPLACES the old value (the window that was open is now
 *  closed); different axes coexist (a hot AND dirty pan). */
export const STATE_AXES: Record<string, StateAxis> = {
  open: "aperture",
  closed: "aperture",
  hot: "temperature",
  cold: "temperature",
  clean: "cleanliness",
  dirty: "cleanliness",
  wet: "moisture",
  dry: "moisture",
  on: "power",
  off: "power",
  smelly: "smell",
};

// ---------------------------------------------------------------------------
// The closed Fact union + keys
// ---------------------------------------------------------------------------

export type Fact =
  /** Where an item is — ADAPTER over CreatureState.knowledge (the shipped arm). */
  | { kind: "location"; item: ItemId; where: ItemLocation }
  /** Who wants an item — ADAPTER over CreatureState.knownWants. */
  | { kind: "want"; creature: CreatureId; item: ItemId }
  /** An item's state on one axis ("the window is open", "the apple is hot"). */
  | { kind: "itemState"; item: ItemId; axis: StateAxis; state: string }
  /** A creature's self-condition ("Mara is hungry"); null = fine/none. */
  | { kind: "condition"; creature: CreatureId; condition: string | null }
  /** Where a creature is ("Mara is at work") — a PLACE-FACT subject or room word. */
  | { kind: "presence"; creature: CreatureId; place: string };

export type FactKey = string;

/** One key per SUBJECT+axis — upserting a new value replaces the old belief. */
export function factKey(f: Fact): FactKey {
  switch (f.kind) {
    case "location":
      return `loc:${f.item}`;
    case "want":
      return `want:${f.creature}:${f.item}`;
    case "itemState":
      return `state:${f.item}:${f.axis}`;
    case "condition":
      return `cond:${f.creature}`;
    case "presence":
      return `pres:${f.creature}`;
  }
}

export type FactQuery =
  | { kind: "location"; item: ItemId }
  /** Derived from the location arm: a `held` belief names the holder. */
  | { kind: "whoHas"; item: ItemId }
  | { kind: "itemState"; item: ItemId; axis?: StateAxis }
  | { kind: "condition"; creature: CreatureId }
  | { kind: "presence"; creature: CreatureId }
  | { kind: "want"; creature: CreatureId }
  /** SEARCH by value — "what is hot?": ANY item known to carry this state. */
  | { kind: "stateSearch"; state: string }
  /** SEARCH by value — "who is hungry?": ANY creature known in this condition. */
  | { kind: "conditionSearch"; condition: string };

// ---------------------------------------------------------------------------
// The one channel: perceive = tell
// ---------------------------------------------------------------------------

function sameFact(a: Fact, b: Fact): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "itemState":
      return a.state === (b as Extract<Fact, { kind: "itemState" }>).state;
    case "condition":
      return a.condition === (b as Extract<Fact, { kind: "condition" }>).condition;
    case "presence":
      return a.place === (b as Extract<Fact, { kind: "presence" }>).place;
    default:
      return false; // location/want never reach the generic store
  }
}

/**
 * SIGHT writes the fact; an event fires only on new/changed knowledge (the
 * seeItem convention). Location facts delegate to the certified `seeItem`
 * path; want facts to the `knownWants` store; everything else upserts the
 * generic store by key.
 */
export function perceiveFact(world: CreatureWorld, viewerId: CreatureId, fact: Fact): CreatureEvent[] {
  const viewer = world.creatures[viewerId];
  if (!viewer) return [];
  if (fact.kind === "location") return seeItem(world, viewerId, fact.item, fact.where);
  if (fact.kind === "want") {
    if (viewer.knownWants[fact.item] === fact.creature) return [];
    viewer.knownWants[fact.item] = fact.creature;
    return [{ type: "fact-learned", creatureId: viewerId, fact }];
  }
  const store = (viewer.facts ??= {});
  const key = factKey(fact);
  const prior = store[key];
  if (prior && sameFact(prior, fact)) return [];
  store[key] = fact;
  return [{ type: "fact-learned", creatureId: viewerId, fact }];
}

/** TELLING writes the same fact a sighting would — dialogue is just another
 *  knowledge channel (the tellAbout law, generalized). */
export const tellFact: typeof perceiveFact = perceiveFact;

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

/**
 * What this creature can answer about `q` — a Fact or null (the honest
 * "I don't know"). Beliefs, with two truth shortcuts that follow from "sight
 * is knowledge": a creature always knows its OWN condition, and the live
 * states of items it currently HOLDS.
 */
export function knowsFact(world: CreatureWorld, creatureId: CreatureId, q: FactQuery): Fact | null {
  const c = world.creatures[creatureId];
  if (!c) return null;
  switch (q.kind) {
    case "location": {
      const where = c.knowledge[q.item];
      return where ? { kind: "location", item: q.item, where } : null;
    }
    case "whoHas": {
      const where = c.knowledge[q.item];
      return where?.kind === "held" ? { kind: "location", item: q.item, where } : null;
    }
    case "want": {
      const item = Object.keys(c.knownWants)
        .sort()
        .find((i) => c.knownWants[i] === q.creature);
      return item ? { kind: "want", creature: q.creature, item } : null;
    }
    case "itemState": {
      const item = world.items[q.item];
      if (item?.ownerId === creatureId) {
        // Holding it = seeing it: answer from the live states.
        const state = q.axis
          ? item.states.find((s) => STATE_AXES[s] === q.axis)
          : [...item.states].sort().find((s) => STATE_AXES[s]);
        return state ? { kind: "itemState", item: q.item, axis: STATE_AXES[state]!, state } : null;
      }
      if (q.axis) {
        const f = c.facts?.[`state:${q.item}:${q.axis}`];
        return f?.kind === "itemState" ? f : null;
      }
      const key = Object.keys(c.facts ?? {})
        .filter((k) => k.startsWith(`state:${q.item}:`))
        .sort()[0];
      const f = key ? c.facts![key] : undefined;
      return f?.kind === "itemState" ? f : null;
    }
    case "condition": {
      if (q.creature === creatureId) {
        return { kind: "condition", creature: creatureId, condition: c.condition ?? null };
      }
      const f = c.facts?.[`cond:${q.creature}`];
      return f?.kind === "condition" ? f : null;
    }
    case "presence": {
      const f = c.facts?.[`pres:${q.creature}`];
      return f?.kind === "presence" ? f : null;
    }
    case "stateSearch": {
      // Truth first: an item the creature HOLDS carrying the state (holding is
      // seeing), then any recorded belief with that value. Sorted = deterministic.
      const axis = STATE_AXES[q.state];
      if (axis) {
        const held = Object.keys(world.items)
          .sort()
          .find((id) => {
            const it = world.items[id];
            return it?.ownerId === creatureId && it.states.includes(q.state);
          });
        if (held) return { kind: "itemState", item: held, axis, state: q.state };
      }
      const key = Object.keys(c.facts ?? {})
        .sort()
        .find((k) => {
          const f = c.facts![k];
          return f?.kind === "itemState" && f.state === q.state;
        });
      const f = key ? c.facts![key] : undefined;
      return f?.kind === "itemState" ? f : null;
    }
    case "conditionSearch": {
      // Its OWN condition is always known truth; then any heard/seen belief.
      if (c.condition === q.condition) {
        return { kind: "condition", creature: creatureId, condition: q.condition };
      }
      const key = Object.keys(c.facts ?? {})
        .sort()
        .find((k) => {
          const f = c.facts![k];
          return f?.kind === "condition" && f.condition === q.condition;
        });
      const f = key ? c.facts![key] : undefined;
      return f?.kind === "condition" ? f : null;
    }
  }
}
