// shared/symbol-game/pools.ts
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

import type { PoolDef } from "./types.js";

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
      { id: "puppy", label: "Puppy", iconRef: "🐶", symbol: "puppy", glyphStatus: "queued" },
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
};

/** Look up a pool by id (slot name). */
export function getPool(id: string): PoolDef | undefined {
  return POOLS[id];
}
