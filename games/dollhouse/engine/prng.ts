// shared/prng.ts
//
// A tiny seedable PRNG for reproducible procedural generation. Every generator
// that takes an `rng: () => number` (symbol-game world builders, the village
// projector, building colors) can be driven from one uint32 seed, so the SAME
// seed rebuilds the SAME world — generator draws, layout, buildings, colors.
// Not cryptographic; just stable, fast, and dependency-free.

/** mulberry32 — a solid 32-bit PRNG. Returns a Math.random-shaped function. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fold strings/numbers into a uint32 seed (FNV-1a) — for deriving stable
 *  sub-seeds ("same world seed, different subsystem stream"). */
export function hashSeed(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    for (const ch of String(part)) {
      h ^= ch.codePointAt(0)!;
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x2e; // separator, so ("ab","c") ≠ ("a","bc")
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A fresh random uint32 seed (for "no seed given" defaults — record it so the
 *  world stays reproducible after the fact). */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}
