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
import { makeRelation, type Relation } from "./relations.js";

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
  | { kind: "presence"; creature: CreatureId; place: string }
  /**
   * ⚖️ HOW ONE CREATURE REGARDS ANOTHER, AS A THING THAT CAN BE TOLD (M3,
   * interpersonal-politics.md §2e) — "Mara likes Pip", "Orrin is scared of the
   * bear", "everyone respects the chief".
   *
   * 🚨 THIS IS A BELIEF ABOUT A RELATION, NOT THE RELATION. The relation lives
   * in the host's directed book and is the observer's own private attitude; this
   * is what SOMEBODY SAID about it, held by a third party, and it travels the
   * one knowledge channel like every other fact — you learn it by seeing the
   * regard acted out or by being told. That is the whole of reputation: there is
   * no `reputation: number` anywhere, only these facts plus the book, and "what
   * do people think of X" is a QUERY over them.
   */
  | { kind: "regard"; observer: CreatureId; subject: CreatureId; sentiment: RegardSentiment };

/**
 * THE FOUR WORDS a regard can be told IN. Deliberately four and not a number:
 * a scalar is not sayable, and the whole point of the fact is that a child (and
 * an NPC with a nine-word vocabulary) can utter it. Each maps to one axis of
 * `Relation` — like/dislike to affinity, fear to fear, respect to authority —
 * so `regardSentimentOf` can name a relation and `priorFromRegard` can turn a
 * naming back into an attitude.
 */
export type RegardSentiment = "like" | "dislike" | "fear" | "respect";

/** A `regard` fact, narrowed — the shape `priorFromRegard` folds. */
export type RegardFact = Extract<Fact, { kind: "regard" }>;

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
    case "regard":
      // ONE belief per OBSERVER/SUBJECT pair — the observer is part of the key
      // because "Mara likes Pip" and "Orrin fears Pip" are two different facts
      // about the same subject, and a shared `regard:<subject>` key would let
      // the second silently erase the first. Within a pair the channel's
      // latest-wins rule holds: Mara's feeling about Pip CHANGED.
      return `regard:${f.observer}:${f.subject}`;
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
  | { kind: "conditionSearch"; condition: string }
  /**
   * "What do I know about how people regard each other?" — every field is
   * OPTIONAL and they AND together, so the one arm answers all four questions
   * the board can ask: "who leader?" (`{ sentiment: "respect" }`), "what do
   * people think of Pip?" (`{ subject }`), "what does Mara think of Pip?"
   * (both), and the bare enumeration.
   */
  | {
      kind: "regard";
      subject?: CreatureId;
      observer?: CreatureId;
      sentiment?: RegardSentiment;
    };

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
    case "regard":
      // Observer and subject are already IN the key, so only the sentiment can
      // differ between two facts that collide there.
      return a.sentiment === (b as RegardFact).sentiment;
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
    case "regard": {
      // NO TRUTH SHORTCUT HERE, unlike `condition`/`itemState`. A creature's own
      // attitude is not in this store — it is in the host's directed relation
      // book, which this pure module has no access to and must not grow one.
      // What a body can ANSWER from here is what it was told or saw; the host
      // answers "how do *I* feel about X" from the book directly. Sorted keys ⇒
      // deterministic pick when several beliefs match.
      const key = Object.keys(c.facts ?? {})
        .sort()
        .find((k) => {
          const f = c.facts![k];
          if (f?.kind !== "regard") return false;
          if (q.subject !== undefined && f.subject !== q.subject) return false;
          if (q.observer !== undefined && f.observer !== q.observer) return false;
          if (q.sentiment !== undefined && f.sentiment !== q.sentiment) return false;
          return true;
        });
      const f = key ? c.facts![key] : undefined;
      return f?.kind === "regard" ? f : null;
    }
  }
}

/** EVERY regard belief this creature holds that matches `q` — the plural of
 *  `knowsFact`'s regard arm, for the callers that must FOLD beliefs rather than
 *  answer with one (`priorFromRegard`, and the host's "what do people think of
 *  X" walk). Sorted by key so a fold is replay-stable. */
export function regardFacts(
  world: CreatureWorld,
  creatureId: CreatureId,
  q: Omit<Extract<FactQuery, { kind: "regard" }>, "kind"> = {},
): RegardFact[] {
  const c = world.creatures[creatureId];
  if (!c) return [];
  const out: RegardFact[] = [];
  for (const k of Object.keys(c.facts ?? {}).sort()) {
    const f = c.facts![k];
    if (f?.kind !== "regard") continue;
    if (q.subject !== undefined && f.subject !== q.subject) continue;
    if (q.observer !== undefined && f.observer !== q.observer) continue;
    if (q.sentiment !== undefined && f.sentiment !== q.sentiment) continue;
    out.push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Regard ↔ relation — the two directions of M3
// ---------------------------------------------------------------------------

/**
 * ⚖️ HOW STRONG A FEELING HAS TO BE BEFORE IT IS WORTH SAYING (owner's ruling
 * ⑤'s minimum slice; the shape constant of the regard channel). Below 0.3 on
 * every axis a relation is ORDINARY — you do not tell people you mildly
 * tolerate someone — and `regardSentimentOf` answers null, which is what keeps
 * the channel quiet by default: a world where every body gossips about every
 * other body's neutral opinion is noise, not politics.
 */
export const REGARD_TELL_AT = 0.3;

/**
 * NAME A RELATION IN ONE WORD, or null if there is nothing worth telling.
 *
 * The order is the order of NEWSWORTHINESS, not of magnitude: being afraid of
 * someone is the thing you say first, recognizing their standing second, and
 * liking/disliking last — which is also the order in which the four sentiments
 * change what a hearer should DO about the subject. One word out, never a
 * blend: the fact is meant to be SAID.
 */
export function regardSentimentOf(rel: Relation): RegardSentiment | null {
  if (rel.fear >= REGARD_TELL_AT) return "fear";
  if (rel.authority >= REGARD_TELL_AT) return "respect";
  if (rel.affinity >= REGARD_TELL_AT) return "like";
  if (rel.affinity <= -REGARD_TELL_AT) return "dislike";
  return null;
}

/**
 * THE M3 PRIOR — what to feel about someone you have NEVER MET, from what you
 * have been told about them. The other direction of `regardSentimentOf`.
 *
 * Each belief is damped by the hearer's trust IN THE OBSERVER who holds it, so
 * a stranger's opinion barely moves anything and a trusted friend's moves a
 * lot; beliefs SUM (three people warning you about the same body is worse than
 * one) and the total clamps through `makeRelation`.
 *
 * 🚨 HEARSAY NEVER MOVES `authority` (the round's law). A "respect" belief
 * raises TRUST instead — hearing that people follow someone is a reason to
 * believe their judgment is sound, and it is emphatically NOT a reason to obey
 * them: the right to direct you is earned by an ACT or given by an APPOINTMENT,
 * never by rumour. Get this wrong and a chief can be manufactured by gossip.
 */
export function priorFromRegard(
  base: Relation,
  facts: readonly RegardFact[],
  trustIn: (observer: CreatureId) => number,
): Relation {
  let affinity = base.affinity;
  let trust = base.trust;
  let fear = base.fear;
  for (const f of facts) {
    const t = Math.min(1, Math.max(0, trustIn(f.observer)));
    if (t <= 0) continue;
    switch (f.sentiment) {
      case "like":
        affinity += 0.3 * t;
        break;
      case "dislike":
        affinity -= 0.3 * t;
        break;
      case "fear":
        fear += 0.2 * t;
        break;
      case "respect":
        trust += 0.15 * t;
        break;
    }
  }
  return makeRelation({ affinity, trust, authority: base.authority, fear });
}
