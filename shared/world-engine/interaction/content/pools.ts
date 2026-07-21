// shared/world-engine/interaction/content/pools.ts
//
// The working shared pools (§5.2 / §6.2). Each pool is doubly constrained: an
// AffordanceTag AND glyphed members. "Glyphed" means "has a SYMBOL or a queued
// one" — members whose symbol isn't in the registry yet carry glyphStatus
// "queued" and land on the §6.5 worklist; they don't block authoring (pillar 5).
//
// Member `symbol` keys are verified against shared/glyph-registry.ts at the time
// of writing: cookie/apple/banana/ball/car/train/boat/rabbit/bear/frog all ship;
// the rest are queued. The binder is registry-authoritative regardless, so a
// glyphStatus that drifts from reality is corrected at bind time, not trusted.

import type { PoolDef } from "@shared/world-engine/interaction/types.js";

export const POOLS: Record<string, PoolDef> = {
  treat: {
    id: "treat",
    affordance: "repeatable-edible",
    members: [
      { id: "cookie", label: "Cookie", iconRef: "🍪", symbol: "cookie" },
      { id: "apple", label: "Apple", iconRef: "🍎", symbol: "apple" },
      { id: "banana", label: "Banana", iconRef: "🍌", symbol: "banana" },
      { id: "grape", label: "Grape", iconRef: "🍇", symbol: "grape", glyphStatus: "queued" },
    ],
  },
  toy: {
    id: "toy",
    affordance: "graspable",
    members: [
      { id: "ball", label: "Ball", iconRef: "⚽", symbol: "ball" },
      { id: "car", label: "Toy car", iconRef: "🚗", symbol: "car" },
      { id: "train", label: "Toy train", iconRef: "🚂", symbol: "train" },
      { id: "blocks", label: "Blocks", iconRef: "🧱", symbol: "blocks", glyphStatus: "queued" },
      { id: "teddy", label: "Teddy", iconRef: "🧸", symbol: "teddy", glyphStatus: "queued" },
    ],
  },
  friend: {
    id: "friend",
    affordance: "receptive-npc",
    members: [
      { id: "rabbit", label: "Rabbit", iconRef: "🐰", symbol: "rabbit" },
      { id: "bear", label: "Bear", iconRef: "🐻", symbol: "bear" },
      { id: "frog", label: "Frog", iconRef: "🐸", symbol: "frog" },
      { id: "dog", label: "Dog", iconRef: "🐶", symbol: "dog", glyphStatus: "queued" },
    ],
  },
  container: {
    id: "container",
    affordance: "openable",
    members: [
      { id: "box", label: "Box", iconRef: "📦", symbol: "box", glyphStatus: "queued" },
      { id: "basket", label: "Basket", iconRef: "🧺", symbol: "basket", glyphStatus: "queued" },
    ],
  },
  emit: {
    id: "emit",
    affordance: "repeatable-effect",
    members: [
      { id: "bubbles", label: "Bubbles", iconRef: "🫧", symbol: "bubbles", glyphStatus: "queued" },
      { id: "sparks", label: "Sparks", iconRef: "✨", symbol: "sparks", glyphStatus: "queued" },
    ],
  },
  vehicle: {
    id: "vehicle",
    affordance: "startable-movable",
    members: [
      { id: "car", label: "Car", iconRef: "🚗", symbol: "car" },
      { id: "train", label: "Train", iconRef: "🚂", symbol: "train" },
      { id: "boat", label: "Boat", iconRef: "⛵", symbol: "boat" },
    ],
  },
  reject: {
    id: "reject",
    affordance: "unwanted",
    members: [
      { id: "broccoli", label: "Broccoli", iconRef: "🥦", symbol: "broccoli", glyphStatus: "queued" },
      { id: "sock", label: "Sock", iconRef: "🧦", symbol: "sock", glyphStatus: "queued" },
    ],
  },
  device: {
    id: "device",
    affordance: "toggleable",
    members: [
      { id: "lamp", label: "Lamp", iconRef: "💡", symbol: "lamp", glyphStatus: "queued" },
      { id: "window", label: "Window", iconRef: "🪟", symbol: "window", glyphStatus: "queued" },
      { id: "heater", label: "Heater", iconRef: "🔥", symbol: "heater", glyphStatus: "queued" },
    ],
  },
  powerSource: {
    id: "powerSource",
    affordance: "toggleable",
    members: [
      { id: "generator", label: "Generator", iconRef: "🔋", symbol: "generator", glyphStatus: "queued" },
      { id: "switch", label: "Switch", iconRef: "🎚️", symbol: "switch", glyphStatus: "queued" },
    ],
  },
  // -- motive-batch pools (motive-driven-needs.md follow-ups) ------------------
  instrument: {
    id: "instrument",
    affordance: "repeatable-effect",
    members: [
      { id: "drum", label: "Drum", iconRef: "🥁", symbol: "drum", glyphStatus: "queued" },
      { id: "guitar", label: "Guitar", iconRef: "🎸", symbol: "guitar", glyphStatus: "queued" },
    ],
  },
  reading: {
    id: "reading",
    affordance: "graspable",
    members: [{ id: "book", label: "Book", iconRef: "📖", symbol: "book", glyphStatus: "queued" }],
  },
  clothing: {
    id: "clothing",
    affordance: "graspable",
    members: [
      { id: "hat", label: "Hat", iconRef: "🧢", symbol: "hat", glyphStatus: "queued" },
      { id: "shirt", label: "Shirt", iconRef: "👕", symbol: "shirt", glyphStatus: "queued" },
      { id: "scarf", label: "Scarf", iconRef: "🧣", symbol: "scarf", glyphStatus: "queued" },
    ],
  },
  disposal: {
    id: "disposal",
    affordance: "container",
    // The bin IS the disposal can (its model is a lidded trash can). One word,
    // not a redundant "garbage" twin — see glyph-registry `bin`.
    members: [{ id: "bin", label: "Bin", iconRef: "🗑️", symbol: "bin" }],
  },
};

/**
 * KIND → CATEGORY (motive-driven-needs.md parameter matching): the shared tag a
 * category-target need matches against ("I want food" ← any treat). One flat
 * map, read by the derivation when it builds item facets — pool membership and
 * category deliberately stay separate (a sock is reject-pool but clothing).
 */
export const KIND_CATEGORY: Record<string, string> = {
  cookie: "food",
  apple: "food",
  banana: "food",
  grape: "food",
  broccoli: "food",
  ball: "toy",
  car: "toy",
  train: "toy",
  blocks: "toy",
  teddy: "toy",
  boat: "toy",
  drum: "instrument",
  guitar: "instrument",
  book: "book",
  hat: "clothing",
  shirt: "clothing",
  scarf: "clothing",
  sock: "clothing",
};

/** Look up a pool by id (slot name). */
export function getPool(id: string): PoolDef | undefined {
  return POOLS[id];
}

/**
 * THE LIBRARY IS KNOWN BY DEFAULT (language-expansion.md): every pool CONCEPT
 * is a speakable noun from frame 1 — knowing the word for "apple" is not
 * hidden information; only specific CHARACTERS stay encounter-added. One
 * symbol per concept (a car is a toy AND a vehicle — first pool wins),
 * deterministic order (authoring order of POOLS, then members).
 */
export function libraryNouns(): { symbol: string; label: string }[] {
  const seen = new Set<string>();
  const out: { symbol: string; label: string }[] = [];
  for (const pool of Object.values(POOLS)) {
    for (const m of pool.members) {
      if (seen.has(m.symbol)) continue;
      seen.add(m.symbol);
      out.push({ symbol: m.symbol, label: m.label.toLowerCase() });
    }
  }
  return out;
}
