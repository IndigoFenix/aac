// shared/world-engine/interaction/quest/wilderness.ts
//
// WILDERNESS CONTENT (city-expansion step 0): the deterministic scatter a
// quest-host session lays over open ground — resource FEATURES (trees that
// hold wood, rocks that hold stone) and free-roaming CREATURES the spirit can
// possess. Everything reuses existing machinery:
//   • a feature is an ordinary openable CONTAINER (the one container
//     abstraction) whose stack map holds material glyphs — gathering IS the
//     container take path, no new verb, no new animation;
//   • a creature is an ordinary quest-host creature (a needless "resident
//     with no house") whose body wanders — talking/possessing rides the
//     one conversation system.
// Pure data — the quest host embodies it (seedWilderness); headless-tested
// in server/tests/symbol-game-wilderness.test.ts.

export interface WildernessFeature {
  id: string;
  kind: "tree" | "rock";
  x: number;
  y: number;
  /** The feature's material stack (glyph → count) — wood for trees, stone
   *  for rocks. */
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
  const CLEAR_R = 6; // keep the spawn clearing open

  const place = (): { x: number; y: number } => {
    for (let tries = 0; tries < 12; tries++) {
      const x = 8 + rng() * (side - 16);
      const y = 8 + rng() * (side - 16);
      if (Math.hypot(x - spawn.x, y - spawn.y) < CLEAR_R) continue;
      return { x, y };
    }
    return { x: 8, y: 8 };
  };

  const features: WildernessFeature[] = [];
  const nTrees = Math.max(0, params.trees ?? 10);
  const nRocks = Math.max(0, params.rocks ?? 6);
  for (let i = 0; i < nTrees; i++) {
    const p = place();
    features.push({
      id: `wild:tree_${i}`,
      kind: "tree",
      x: p.x,
      y: p.y,
      stock: { wood: 2 + Math.floor(rng() * 3) },
    });
  }
  for (let i = 0; i < nRocks; i++) {
    const p = place();
    features.push({
      id: `wild:rock_${i}`,
      kind: "rock",
      x: p.x,
      y: p.y,
      stock: { stone: 1 + Math.floor(rng() * 2) },
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
