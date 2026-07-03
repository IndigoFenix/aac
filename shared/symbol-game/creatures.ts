// shared/symbol-game/creatures.ts
//
// The need-based creature rules — PUZZLE MODE scope (creature-needs.md §0–§6).
// Pure and deterministic: no coordinates, no rendering, no randomness. The world
// layer decides WHO CAN SEE WHAT and WHERE BODIES GO; this module owns the
// social logic — value, debts, ownership, knowledge — so that behavior (and the
// dialogue projected from it) is consistent for every creature instead of
// authored per vendor.
//
// Design invariants (the doc's load-bearing rules):
//   • RETENTION — fulfilling a need BINDS the item (value := need value,
//     bound := true); bound items are never given away. "Give the bear its
//     cookie then ask for it back" fails structurally, not numerically.
//   • CONSERVATION — a give/take round-trip of a liked item is debt-neutral,
//     so debts can't be farmed by cycling an item.
//   • MONOTONE KNOWLEDGE — facts are never forgotten (certification stays a
//     bounded, decisive simulation).
//   • REACTIVE SETTLEMENT — creatures give only when asked, never push items.

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type CreatureId = string;
/** Item instances are keyed by their goal-tree ENTITY id (puzzle mode: each
 *  item instance is its own entity, as the generator already guarantees). */
export type ItemId = string;

export interface CreatureNeed {
  itemId: ItemId;
  /** Worth of fulfilling this need (> BASELINE_LIKE_VALUE). */
  value: number;
  /** Set once, never cleared (puzzle mode: needs don't renew). */
  fulfilled?: boolean;
  /**
   * A STATE need (Task b): fulfilled when the item is physically PLACED in/on
   * this entity (notePlacement), NOT when the creature receives the item —
   * handing it over is politely redirected ("in the box"). Absent = the
   * ordinary possession need.
   */
  placedAt?: string;
  /**
   * An ON-BEHALF need (Task c): fulfilled when THIS creature (the recipient)
   * has the item — "I want Bear to have the ball". The wanter never takes the
   * item itself (handing it over is redirected "ball to bear"); the debt goes
   * to whoever caused the recipient to have it.
   */
  forCreature?: CreatureId;
  /**
   * A TRANSFORMED-state requirement (Item Transformations b): the need only
   * accepts the item while it carries this STATE_TAGS entry ("hot") — the
   * untransformed offer is declined with "{item} + {state}.not". Stations
   * (applyTransform) put the state on.
   */
  requiresState?: string;
}

export interface CreatureState {
  id: CreatureId;
  /** Item ids this creature values at baseline (receiving one creates debt). */
  likes: ItemId[];
  needs: CreatureNeed[];
  /** What THIS creature owes each other creature, in value units. */
  debts: Record<CreatureId, number>;
  /** Gratitude personality multiplier on debts gained. 1 for now (puzzle mode). */
  gratitude?: number;
  /** Monotone knowledge: item id → where it was last known to be. */
  knowledge: Record<ItemId, ItemLocation>;
  /**
   * WANT-facts: item id → who this creature knows wants it. Learned when
   * someone ASKS for the item. Drives obligation settling: once the debt to
   * that creature covers the item, this creature gives it over unprompted.
   */
  knownWants: Record<ItemId, CreatureId>;
}

/** Where an item is, as far as a creature knows. */
export type ItemLocation =
  | { kind: "held"; by: CreatureId }
  | { kind: "loose" };

export interface ItemState {
  id: ItemId;
  /** Current claimant; null = unclaimed/loose. */
  ownerId: CreatureId | null;
  /** Who last put it down / handed it over (provenance for inferred gifts). */
  placerId: CreatureId | null;
  /** Value the OWNER assigns it (baseline until a need binds it higher). */
  value: number;
  /** Bound by a fulfilled need — never given away, never lent. */
  bound: boolean;
  /** On a display (table/counter): visible to anyone who sees the owner's spot. */
  displayed: boolean;
  /**
   * An ACCEPTED request: the owner agreed to hand this over to `pendingTransferTo`.
   * Ownership and the debt move only when the recipient physically TAKES it
   * (concludeTransfer). Handing it within reach is behavior, not a transfer.
   */
  pendingTransferTo?: CreatureId | null;
  /** Current STATE_TAGS on the item (a hot apple: ["hot"]). Stations swap
   *  them (applyTransform); needs may require one (requiresState). */
  states: string[];
}

export interface CreatureWorld {
  creatures: Record<CreatureId, CreatureState>;
  items: Record<ItemId, ItemState>;
}

export const BASELINE_LIKE_VALUE = 1;

/**
 * Item STATE tags (Item Transformations b) — the glyph modifiers that describe
 * a transformable condition rather than an identity (a hot apple is still the
 * apple; a big ball is a different ball). Stations swap them; needs may
 * require them. Aligned with the village-systems axes (fire = heat/cook/dry,
 * water = cool/clean/wet); only the registry-shipped pair is active today.
 */
export const STATE_TAGS: ReadonlySet<string> = new Set([
  "hot",
  "cold",
  "clean",
  "dirty",
  "wet",
  "dry",
]);

// ---------------------------------------------------------------------------
// Events (the observer stream — the game layer narrates/animates these)
// ---------------------------------------------------------------------------

export type CreatureEvent =
  | { type: "item-transferred"; itemId: ItemId; from: CreatureId | null; to: CreatureId | null }
  | { type: "debt-gained"; debtor: CreatureId; creditor: CreatureId; amount: number }
  | { type: "debt-settled"; debtor: CreatureId; creditor: CreatureId; amount: number }
  | { type: "need-fulfilled"; creatureId: CreatureId; itemId: ItemId; value: number }
  | { type: "transfer-pending"; itemId: ItemId; from: CreatureId; to: CreatureId }
  | { type: "knowledge-gained"; creatureId: CreatureId; itemId: ItemId; where: ItemLocation }
  | { type: "item-transformed"; itemId: ItemId; applied: string; removed?: string };

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface CreatureSeed {
  id: CreatureId;
  likes?: ItemId[];
  needs?: { itemId: ItemId; value: number; placedAt?: string; forCreature?: CreatureId }[];
  /** Initial debts (the rental vendor's "you may borrow one"). */
  debts?: Record<CreatureId, number>;
  gratitude?: number;
}

export interface ItemSeed {
  id: ItemId;
  ownerId?: CreatureId;
  displayed?: boolean;
  /** Initial STATE_TAGS (e.g. ["cold"] for the not-yet-heated quest item). */
  states?: string[];
  /** Bound from the start — a KEEPSAKE the owner never parts with (Request-c
   *  evidence: the sad bear's beloved apple on display). */
  bound?: boolean;
}

export function createCreatureWorld(creatures: CreatureSeed[], items: ItemSeed[]): CreatureWorld {
  const world: CreatureWorld = { creatures: {}, items: {} };
  for (const seed of creatures) {
    world.creatures[seed.id] = {
      id: seed.id,
      likes: [...(seed.likes ?? [])],
      needs: (seed.needs ?? []).map((n) => ({ ...n })),
      debts: { ...(seed.debts ?? {}) },
      gratitude: seed.gratitude ?? 1,
      knowledge: {},
      knownWants: {},
    };
  }
  for (const seed of items) {
    world.items[seed.id] = {
      id: seed.id,
      ownerId: seed.ownerId ?? null,
      placerId: null,
      value: BASELINE_LIKE_VALUE,
      bound: seed.bound ?? false,
      displayed: seed.displayed ?? false,
      pendingTransferTo: null,
      states: [...(seed.states ?? [])],
    };
    // An owner knows its own possessions.
    if (seed.ownerId) {
      const owner = world.creatures[seed.ownerId];
      if (owner) owner.knowledge[seed.id] = { kind: "held", by: seed.ownerId };
    }
  }
  return world;
}

// ---------------------------------------------------------------------------
// Value
// ---------------------------------------------------------------------------

/** Does the item's current state satisfy this need's requirement? */
export function needStateOk(
  need: Pick<CreatureNeed, "requiresState">,
  states: readonly string[],
): boolean {
  return !need.requiresState || states.includes(need.requiresState);
}

/** What acquiring `itemId` would be worth to this creature right now. State
 *  needs are NOT possession-worth — a placement need wants the item in the
 *  box, an on-behalf need wants it in SOMEONE ELSE'S hands; neither is
 *  fulfilled by this creature receiving it. `states` = the item's current
 *  STATE_TAGS: a need requiring "hot" puts no worth on the cold one. */
export function valueTo(creature: CreatureState, itemId: ItemId, states: readonly string[] = []): number {
  const need = creature.needs.find(
    (n) =>
      n.itemId === itemId && !n.fulfilled && !n.placedAt && !n.forCreature && needStateOk(n, states),
  );
  if (need) return need.value;
  return creature.likes.includes(itemId) ? BASELINE_LIKE_VALUE : 0;
}

/** The creature's unfulfilled needs, in declaration order (deterministic). */
export function openNeeds(creature: CreatureState): CreatureNeed[] {
  return creature.needs.filter((n) => !n.fulfilled);
}

// ---------------------------------------------------------------------------
// Knowledge (monotone)
// ---------------------------------------------------------------------------

/** A creature sees an item (held by someone, on a display, or loose). */
export function seeItem(
  world: CreatureWorld,
  viewerId: CreatureId,
  itemId: ItemId,
  where: ItemLocation,
): CreatureEvent[] {
  const viewer = world.creatures[viewerId];
  if (!viewer) return [];
  const prior = viewer.knowledge[itemId];
  viewer.knowledge[itemId] = where;
  if (prior && prior.kind === where.kind && (prior.kind !== "held" || (prior as { by: string }).by === (where as { by: string }).by)) {
    return []; // nothing new
  }
  return [{ type: "knowledge-gained", creatureId: viewerId, itemId, where }];
}

/** A clue: `tellerId` tells `listenerId` where an item is (same fact a sighting
 *  writes — dialogue is just another knowledge channel). */
export function tellAbout(
  world: CreatureWorld,
  listenerId: CreatureId,
  itemId: ItemId,
  where: ItemLocation,
): CreatureEvent[] {
  return seeItem(world, listenerId, itemId, where);
}

/** Items `viewerId` knows `ownerId` currently has (drives the request menu). */
export function knownHoldings(
  world: CreatureWorld,
  viewerId: CreatureId,
  ownerId: CreatureId,
): ItemId[] {
  const viewer = world.creatures[viewerId];
  if (!viewer) return [];
  const out: ItemId[] = [];
  for (const [itemId, where] of Object.entries(viewer.knowledge)) {
    // Knowledge can go stale (the item moved); requests are validated against
    // the real owner at selection, but the MENU shows what the viewer believes
    // AND is still true — stale beliefs would make a confusing button.
    if (where.kind === "held" && where.by === ownerId && world.items[itemId]?.ownerId === ownerId) {
      out.push(itemId);
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

/**
 * `giverId` hands `itemId` to `receiverId` (or the receiver takes it with
 * consent — same rule). Returns whether the receiver ACCEPTS (a creature takes
 * only what it values; the player accepts anything), plus the events.
 *
 * On acceptance: ownership transfers; the receiver's matching need (if any)
 * fulfills and BINDS the item; the receiver gains a debt to the giver equal to
 * the item's value-to-them × gratitude.
 */
export function giveItem(
  world: CreatureWorld,
  giverId: CreatureId | null,
  receiverId: CreatureId,
  itemId: ItemId,
  opts: { receiverAcceptsAnything?: boolean } = {},
): { accepted: boolean; events: CreatureEvent[] } {
  const receiver = world.creatures[receiverId];
  const item = world.items[itemId];
  if (!receiver || !item) return { accepted: false, events: [] };

  const worth = valueTo(receiver, itemId, item.states);
  if (worth <= 0 && !opts.receiverAcceptsAnything) {
    return { accepted: false, events: [] }; // polite decline — not wanted
  }

  const events: CreatureEvent[] = [];
  const from = item.ownerId;
  item.ownerId = receiverId;
  item.placerId = giverId;
  item.pendingTransferTo = null;
  events.push({ type: "item-transferred", itemId, from, to: receiverId });
  events.push(...seeItem(world, receiverId, itemId, { kind: "held", by: receiverId }));
  // The giver watched the handover — its knowledge follows the item (this is
  // what lets a lender later ask for the borrowed item BACK).
  if (giverId && world.creatures[giverId]) {
    events.push(...seeItem(world, giverId, itemId, { kind: "held", by: receiverId }));
  }

  // Need fulfillment binds the item (retention rule). State needs never
  // fulfill by receiving — the item has to LAND in the right place / with the
  // right creature — and a transformed-state requirement must be MET.
  const need = receiver.needs.find(
    (n) =>
      n.itemId === itemId &&
      !n.fulfilled &&
      !n.placedAt &&
      !n.forCreature &&
      needStateOk(n, item.states),
  );
  if (need) {
    need.fulfilled = true;
    item.value = need.value;
    item.bound = true;
    events.push({ type: "need-fulfilled", creatureId: receiverId, itemId, value: need.value });
  } else if (worth > 0) {
    item.value = worth;
    item.bound = false;
  }

  // Debt to the giver (no self-debts; no debt for a shrugging "fine, I'll hold it").
  if (giverId && giverId !== receiverId && worth > 0) {
    const amount = worth * (receiver.gratitude ?? 1);
    receiver.debts[giverId] = (receiver.debts[giverId] ?? 0) + amount;
    events.push({ type: "debt-gained", debtor: receiverId, creditor: giverId, amount });
  }
  // On-behalf needs elsewhere ("I want Bear to have the ball") fulfill the
  // moment the recipient actually has it.
  events.push(...settleOnBehalfNeeds(world, giverId, itemId, receiverId));
  return { accepted: true, events };
}

/**
 * Item Transformations b: a STATION transforms the item — `applies` goes on,
 * `removes` (the opposite state, e.g. hot↔cold) comes off. Idempotent; state
 * only, never ownership. The world layer decides WHEN (the physical drop on
 * the station); the sim certifier calls it directly.
 */
export function applyTransform(
  world: CreatureWorld,
  itemId: ItemId,
  applies: string,
  removes?: string,
): CreatureEvent[] {
  const item = world.items[itemId];
  if (!item || item.states.includes(applies)) return [];
  item.states = [...item.states.filter((s) => s !== removes), applies];
  return [{ type: "item-transformed", itemId, applied: applies, ...(removes ? { removed: removes } : {}) }];
}

/**
 * Task-c ON-BEHALF needs: `holderId` now HAS `itemId` (it was handed over,
 * claimed, or landed via a placement). Every creature whose open need was
 * exactly that — this item, in that creature's hands — fulfills, with the
 * debt going to `actorId` (whoever caused it; provenance for loose pickups).
 * The wanter's own state never touches the item.
 */
export function settleOnBehalfNeeds(
  world: CreatureWorld,
  actorId: CreatureId | null,
  itemId: ItemId,
  holderId: CreatureId,
): CreatureEvent[] {
  const item = world.items[itemId];
  const events: CreatureEvent[] = [];
  for (const cid of Object.keys(world.creatures).sort()) {
    const creature = world.creatures[cid]!;
    const need = creature.needs.find(
      (n) =>
        !n.fulfilled &&
        n.itemId === itemId &&
        n.forCreature === holderId &&
        needStateOk(n, item?.states ?? []),
    );
    if (!need) continue;
    need.fulfilled = true;
    events.push({ type: "need-fulfilled", creatureId: cid, itemId, value: need.value });
    if (actorId && actorId !== cid) {
      const amount = need.value * (creature.gratitude ?? 1);
      creature.debts[actorId] = (creature.debts[actorId] ?? 0) + amount;
      events.push({ type: "debt-gained", debtor: cid, creditor: actorId, amount });
    }
  }
  return events;
}

/**
 * Put an item down (relinquish the claim, keep provenance): it becomes loose
 * with `placerId` = the putter, so a creature later taking it to fulfill a
 * need/like owes the debt to the putter — the "inferred transfer" rule. This is
 * how leaving a cookie in reach of the bear IS giving it to the bear.
 */
export function putDownItem(
  world: CreatureWorld,
  putterId: CreatureId,
  itemId: ItemId,
): CreatureEvent[] {
  const item = world.items[itemId];
  if (!item || item.ownerId !== putterId) return [];
  item.ownerId = null;
  item.placerId = putterId;
  return [{ type: "item-transferred", itemId, from: putterId, to: null }];
}

/**
 * Task-b STATE needs: `actorId` physically placed `itemId` in/on `destId`. The
 * (deterministically first) creature with an open placement need on exactly
 * that (item, dest) pair fulfills it: the arranged scene is what it wanted, so
 * the item becomes the creature's and BINDS (retention — the take-veto now
 * protects the arrangement), and the debt goes to the actor, exactly as if a
 * possession need had been fulfilled by hand.
 */
export function notePlacement(
  world: CreatureWorld,
  actorId: CreatureId | null,
  itemId: ItemId,
  destId: string,
): CreatureEvent[] {
  const item = world.items[itemId];
  if (!item) return [];
  for (const cid of Object.keys(world.creatures).sort()) {
    const creature = world.creatures[cid]!;
    const need = creature.needs.find(
      (n) =>
        !n.fulfilled && n.itemId === itemId && n.placedAt === destId && needStateOk(n, item.states),
    );
    if (!need) continue;
    const events: CreatureEvent[] = [];
    need.fulfilled = true;
    const from = item.ownerId;
    item.ownerId = cid;
    item.placerId = actorId;
    item.pendingTransferTo = null;
    item.value = need.value;
    item.bound = true;
    events.push({ type: "item-transferred", itemId, from, to: cid });
    events.push(...seeItem(world, cid, itemId, { kind: "held", by: cid }));
    events.push({ type: "need-fulfilled", creatureId: cid, itemId, value: need.value });
    if (actorId && actorId !== cid) {
      const amount = need.value * (creature.gratitude ?? 1);
      creature.debts[actorId] = (creature.debts[actorId] ?? 0) + amount;
      events.push({ type: "debt-gained", debtor: cid, creditor: actorId, amount });
    }
    // The box's owner now HAS the item — on-behalf needs elsewhere settle too.
    events.push(...settleOnBehalfNeeds(world, actorId, itemId, cid));
    return events; // one placement fulfills one need (lowest creature id)
  }
  return [];
}

/**
 * A creature picks up a LOOSE item (claiming it). Provenance applies: if
 * someone placed it, the pickup counts as a gift from the placer (debt et al).
 * Claimed items are never taken this way — that's dialogue territory (§3).
 */
export function claimItem(
  world: CreatureWorld,
  takerId: CreatureId,
  itemId: ItemId,
  opts: { takerAcceptsAnything?: boolean } = {},
): { accepted: boolean; events: CreatureEvent[] } {
  const item = world.items[itemId];
  if (!item || item.ownerId !== null) return { accepted: false, events: [] };
  return giveItem(world, item.placerId, takerId, itemId, {
    receiverAcceptsAnything: opts.takerAcceptsAnything,
  });
}

/** Possessions `ownerId` COULD hand over right now (unbound, actually theirs). */
export function grantablePossessions(world: CreatureWorld, ownerId: CreatureId): ItemState[] {
  return Object.values(world.items)
    .filter((i) => i.ownerId === ownerId && !i.bound)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** What settles a shortfall: an unfulfilled need first, else a liked item the
 *  requester is known to hold (the rental "give it back first"). */
function priceFor(
  world: CreatureWorld,
  owner: CreatureState,
  requesterId: CreatureId,
): { kind: "need"; itemId: ItemId } | { kind: "return"; itemId: ItemId } | null {
  // A state need (placement / on-behalf) can't be paid by handing the item
  // over — never a price.
  const need = openNeeds(owner).find((n) => !n.placedAt && !n.forCreature);
  if (need) return { kind: "need", itemId: need.itemId };
  for (const [itemId, where] of Object.entries(owner.knowledge).sort()) {
    if (where.kind !== "held" || where.by !== requesterId) continue;
    if (world.items[itemId]?.ownerId !== requesterId) continue;
    if (valueTo(owner, itemId) > 0) return { kind: "return", itemId };
  }
  return null;
}

export type RequestOutcome =
  /** The owner AGREES — the item is now pending transfer; take it to conclude. */
  | { kind: "accept"; events: CreatureEvent[] }
  /** The owner states what it wants first. */
  | { kind: "price"; price: { kind: "need" | "return"; itemId: ItemId } }
  /** Nothing to ask for and no debt — a plain no. */
  | { kind: "decline" };

/**
 * `requesterId` asks `ownerId` for `itemId`. The owner grants iff it owes the
 * requester at least the item's value-to-itself and the item is unbound —
 * settlement is consent (creature-needs.md §3). Otherwise it states its price
 * (its own open need, or the liked item it wants BACK), else declines.
 */
export function requestItem(
  world: CreatureWorld,
  requesterId: CreatureId,
  ownerId: CreatureId,
  itemId: ItemId,
): RequestOutcome {
  const owner = world.creatures[ownerId];
  const item = world.items[itemId];
  if (!owner || !item || item.ownerId !== ownerId) return { kind: "decline" };
  // Asking TEACHES: the owner now knows the requester wants this item, and
  // will hand it over unprompted the moment a covering debt exists
  // (settleObligations) — even if the answer right now is a price or a no.
  owner.knownWants[itemId] = requesterId;
  if (item.bound) {
    // In use — never granted; the owner can still name a price for the FUTURE?
    // No (puzzle mode): bound means bound. Plain decline keeps it legible.
    return { kind: "decline" };
  }

  const debt = owner.debts[requesterId] ?? 0;
  if (debt >= item.value || item.pendingTransferTo === requesterId) {
    // AGREEMENT, not transfer: the item becomes pending; ownership + the debt
    // move when the requester TAKES it (concludeTransfer).
    item.pendingTransferTo = requesterId;
    return {
      kind: "accept",
      events: [{ type: "transfer-pending", itemId, from: ownerId, to: requesterId }],
    };
  }

  const price = priceFor(world, owner, requesterId);
  return price ? { kind: "price", price } : { kind: "decline" };
}

/**
 * The recipient physically TAKES an item pending transfer to them — the moment
 * ownership moves and the covering debt clears (creature-needs.md pending rule).
 */
export function concludeTransfer(
  world: CreatureWorld,
  takerId: CreatureId,
  itemId: ItemId,
): CreatureEvent[] {
  const item = world.items[itemId];
  const owner = item?.ownerId ? world.creatures[item.ownerId] : undefined;
  if (!item || !owner || item.pendingTransferTo !== takerId) return [];
  const events: CreatureEvent[] = [
    { type: "debt-settled", debtor: owner.id, creditor: takerId, amount: item.value },
  ];
  owner.debts[takerId] = Math.max(0, (owner.debts[takerId] ?? 0) - item.value);
  item.pendingTransferTo = null;
  delete owner.knownWants[itemId]; // the want is satisfied
  const give = giveItem(world, owner.id, takerId, itemId, { receiverAcceptsAnything: true });
  // Taking what you were owed isn't a gift — no counter-debt.
  events.push(
    ...give.events.filter(
      (e) => !(e.type === "debt-gained" && e.debtor === takerId && e.creditor === owner.id),
    ),
  );
  return events;
}

/** Items this creature has agreed to hand over (drives the hand-over BEHAVIOR). */
export function pendingTransfers(world: CreatureWorld, ownerId: CreatureId): ItemState[] {
  return Object.values(world.items)
    .filter((i) => i.ownerId === ownerId && !!i.pendingTransferTo)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Obligation settling — the "why would they hand it over" rule: a creature that
 * KNOWS someone wants an item it holds (they asked), and OWES that someone a
 * covering debt, gives it over UNPROMPTED. Call after anything that changes
 * debts (typically right after a gift is accepted). Deterministic order;
 * repeats until nothing more settles this call.
 */
export function settleObligations(world: CreatureWorld, ownerId: CreatureId): CreatureEvent[] {
  const owner = world.creatures[ownerId];
  if (!owner) return [];
  const events: CreatureEvent[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const itemId of Object.keys(owner.knownWants).sort()) {
      const wanter = owner.knownWants[itemId]!;
      const item = world.items[itemId];
      if (!item || item.ownerId !== ownerId || item.bound || item.pendingTransferTo) continue;
      if ((owner.debts[wanter] ?? 0) < item.value) continue;
      // Agree to hand it over — the debt clears when the wanter TAKES it.
      item.pendingTransferTo = wanter;
      events.push({ type: "transfer-pending", itemId, from: ownerId, to: wanter });
      changed = true;
    }
  }
  return events;
}
