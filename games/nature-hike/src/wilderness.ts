// games/nature-hike/src/wilderness.ts
//
// THE CHUNK OF GROUND THE HIKE IS PLAYED ON — the per-game half of the
// wilderness contract, ported from world-lab's wilderness-boot.ts. What is
// left here is what is genuinely a GAME constant: this game's chunk side and
// its scatter RNG, handed to the engine's session at boot.
//
// 📦 THE BIOME TABLES ARE NOT GAME CONSTANTS AFTER ALL (2026-09-01). What a
// cell's biome grazes (`faunaForBiome`) and what it scatters
// (`wildMixForBiome`) now live ONCE in
// `@shared/world-engine/interaction/quest/wilderness` — the `homesteadWildMix`
// precedent in that same file, applied to its two siblings. This game and the
// lab carried byte-identical copies and the third consumer is the HEADLESS
// text harness, which cannot import from `games/` at all; the duplication is
// exactly how the tables went stale (both copies still called a registry
// export that had been renamed). Re-exported below, so this game's own
// consumers (quest-boot.ts) are unchanged.
//
// PLANTS ARE NOT HERE, AND THIS GAME'S MIX KEEPS ITS TREES. The lab pairs the
// scatter with a world-fixed flora streaming field (flora-field.ts) and so
// FILTERS the field's species out of the mix; this game has no such layer, so
// the scatter IS the vegetation the hiker meets and there is no second
// population to double up with. That is a fact about which species the CALLER
// filters (quest-boot.ts), not about where the table lives — unchanged by the
// move.

/** Side of the wilderness chunk (metres of sim manifold). The anchor sits at
 *  the CENTER (the spawn point) — sim coords run 0..WILD_SIDE. */
export const WILD_SIDE = 320;

/** The biome tables, from the engine (see the header). `wildMixForBiome` takes
 *  an optional third `climate` sample — with the spawn cell's own climate the
 *  fruit it picks is filtered to what grows there; without one it is the
 *  legacy seed-only pick, byte-identical. */
export {
  faunaForBiome,
  wildMixForBiome,
  type WildFauna,
} from "@shared/world-engine/interaction/quest/wilderness";

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
