// shared/world-engine/interaction/quest/wilderness.ts
//
// WILDERNESS CONTENT (city-expansion step 0): the deterministic scatter a
// quest-host session lays over open ground — resource FEATURES (natural
// sources: trees, rock outcrops) and free-roaming CREATURES the spirit can
// possess. Everything reuses existing machinery:
//   • a feature is an ordinary openable CONTAINER (the one container
//     abstraction) whose stack map holds material glyphs — gathering IS the
//     container take path, no new verb, no new animation;
//   • a creature is an ordinary quest-host creature (a needless "resident
//     with no house") whose body wanders — talking/possessing rides the
//     one conversation system.
// A feature names its SPECIES; what it holds comes from the natural-sources
// registry (products.ts killStockOf) — the same definition the abstract
// economy reads, never a name-keyed table here. Pure data — the quest host
// embodies it (seedWilderness); headless-tested in
// server/tests/symbol-game-wilderness.test.ts.

import { killStockOf } from "../../products.js";

export interface WildernessFeature {
  id: string;
  /** Natural-source species (products.ts) — "oak", "rock". Decides both the
   *  feature's presentation and its yield. */
  species: string;
  x: number;
  y: number;
  /** The feature's material stack (glyph → count) — the source's rolled
   *  kill products (the tree IS its wood). */
  stock: Record<string, number>;
}

export interface WildernessCreature {
  /** Creature id (`wild_<n>`) — its body is `npc_wild_<n>`. */
  id: string;
  /** Emoji face — doubles as the species pick (animal-person models). */
  icon: string;
  x: number;
  y: number;
}

export interface WildernessContent {
  /** The square manifold side, metres. */
  side: number;
  /** Where the spirit's parked walker starts (the centre clearing). */
  spawn: { x: number; y: number };
  features: WildernessFeature[];
  creatures: WildernessCreature[];
}

export interface WildernessParams {
  seed: number;
  /** Square side, metres. Default 240. */
  side?: number;
  /** Manifold walls: false = the rect is CONTENT extent only (a chunk mounted
   *  on a real planet, whose ground sampler answers everywhere — the edge must
   *  never be a wall). Default true (standalone scope: nothing beyond the rect). */
  bounded?: boolean;
  trees?: number;
  rocks?: number;
  creatures?: number;
  /** Keep-clear disc override (city-founding: a town session scatters AROUND
   *  its plaza/site, not through it). Default: the centre spawn clearing. */
  clearAt?: { x: number; y: number };
  clearR?: number;
}

/** Deterministic scatter RNG (mulberry32 — the landing-cell convention). */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The possessable locals — icons the puzzle-character factory maps to real
 *  animal-person creature bodies (quest-host ANIMAL_SPECIES_BY_ICON). */
const CREATURE_ICONS = ["🐰", "🐻", "🐸", "🐶"] as const;

/** Build the wilderness scatter for a seed. Same seed ⇒ identical content. */
export function buildWilderness(params: WildernessParams): WildernessContent {
  const side = Math.max(60, params.side ?? 240);
  const rng = mulberry(params.seed);
  const spawn = { x: side / 2, y: side / 2 };
  const clearAt = params.clearAt ?? spawn;
  const clearR = Math.max(0, params.clearR ?? 6); // keep the clearing open

  const place = (): { x: number; y: number } => {
    for (let tries = 0; tries < 12; tries++) {
      const x = 8 + rng() * (side - 16);
      const y = 8 + rng() * (side - 16);
      if (Math.hypot(x - clearAt.x, y - clearAt.y) < clearR) continue;
      return { x, y };
    }
    return { x: 8, y: 8 };
  };

  const features: WildernessFeature[] = [];
  const nTrees = Math.max(0, params.trees ?? 10);
  const nRocks = Math.max(0, params.rocks ?? 6);
  // Biome-driven species selection is the harvesting rework's job (step ④);
  // today's wilderness is oak forest over rocky ground. Stocks come from the
  // registry's kill products (one roll per product — deterministic).
  for (let i = 0; i < nTrees; i++) {
    const p = place();
    features.push({
      id: `wild:oak_${i}`,
      species: "oak",
      x: p.x,
      y: p.y,
      stock: killStockOf("oak", rng),
    });
  }
  for (let i = 0; i < nRocks; i++) {
    const p = place();
    features.push({
      id: `wild:rock_${i}`,
      species: "rock",
      x: p.x,
      y: p.y,
      stock: killStockOf("rock", rng),
    });
  }

  const creatures: WildernessCreature[] = [];
  const nCreatures = Math.max(0, params.creatures ?? 3);
  for (let i = 0; i < nCreatures; i++) {
    const p = place();
    creatures.push({
      id: `wild_${i}`,
      icon: CREATURE_ICONS[Math.floor(rng() * CREATURE_ICONS.length)]!,
      x: p.x,
      y: p.y,
    });
  }

  return { side, spawn, features, creatures };
}
