// games/nature-hike/src/wilderness.ts
//
// THE CHUNK OF GROUND THE HIKE IS PLAYED ON — the per-game half of the
// wilderness contract, ported from world-lab's wilderness-boot.ts. These are
// GAME constants, not engine ones: `shared/world-engine` may never import from
// `games/`, so every consumer (the lab, this game, the text harness) declares
// its own chunk side and biome tables and hands them to the engine's session.
//
// PLANTS ARE NOT HERE. The lab pairs this with a world-fixed flora streaming
// field (flora-field.ts); this game has no such layer yet, so the biome mix
// keeps its trees — the scatter IS the vegetation the hiker meets, and there
// is no second population to double up with (the lab filters the field's
// species out of the mix for exactly that reason).

import { orchardPlants } from "@shared/world-engine/products";
import type { WildMixEntry } from "@shared/world-engine/interaction/quest/wilderness";

/** Side of the wilderness chunk (metres of sim manifold). The anchor sits at
 *  the CENTER (the spawn point) — sim coords run 0..WILD_SIDE. */
export const WILD_SIDE = 320;

export interface WildFauna {
  horses: number;
}

/** What the spawn cell's biome grazes (grid.fields.biome: 0 = barren/sea/
 *  ice, then DEFAULT_BIOSPHERE order — 1 tree, 2 grass, 3 horse). */
export function faunaForBiome(biome: number): WildFauna {
  switch (biome) {
    case 2: return { horses: 4 };  // steppe / meadow
    case 3: return { horses: 6 };  // grazer range
    default: return { horses: 0 };
  }
}

/** What the spawn cell's biome SCATTERS as gatherable content. Forest is
 *  oak-dominant; open grazing country is sparse trees but wild flocks (animal
 *  entries scatter as WALKING product bodies — milk/shear/hunt); barren ground
 *  is stone outcrops only. One fruit-bearing plant from the registry's orchard
 *  joins any growing biome — picked deterministically by the spawn seed, so a
 *  live-harvest (regrowing) source stands in every walkable wild. Species come
 *  from the products registry, never named in the engine. */
export function wildMixForBiome(biome: number, seed: number): WildMixEntry[] {
  const orchard = orchardPlants();
  const fruit: WildMixEntry[] = orchard.length
    ? [{ species: orchard[(seed >>> 3) % orchard.length]!.species, count: biome === 1 ? 2 : 1 }]
    : [];
  switch (biome) {
    case 1: // forest
      return [{ species: "oak", count: 10 }, ...fruit, { species: "rock", count: 6 }];
    case 2: // steppe / meadow — open country, wild flocks
      return [
        { species: "oak", count: 3 },
        ...fruit,
        { species: "rock", count: 5 },
        { species: "sheep", count: 2 },
      ];
    case 3: // grazer range — flocks and wild cattle
      return [
        { species: "oak", count: 3 },
        ...fruit,
        { species: "rock", count: 5 },
        { species: "sheep", count: 2 },
        { species: "cow", count: 1 },
      ];
    default: // barren / sea-edge / ice — nothing grows
      return [{ species: "rock", count: 8 }];
  }
}

/** Deterministic scatter RNG (the spawn cell is an address, not a session). */
export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
