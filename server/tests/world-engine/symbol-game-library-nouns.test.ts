// THE LIBRARY IS KNOWN BY DEFAULT (language-expansion.md): libraryNouns() is
// the seed quest-host's pushKnownNouns feeds the Speak menu from at boot —
// every pool concept, one entry per symbol, deterministic order. Pure logic.

import { describe, it, expect } from "@jest/globals";
import { POOLS, libraryNouns } from "@shared/world-engine/interaction/content/pools.js";

describe("libraryNouns — the known-by-default concept seed", () => {
  it("covers every pool member symbol", () => {
    const symbols = new Set(libraryNouns().map((n) => n.symbol));
    for (const pool of Object.values(POOLS)) {
      for (const m of pool.members) expect(symbols.has(m.symbol)).toBe(true);
    }
  });

  it("emits one entry per symbol (a car is a toy AND a vehicle — first wins)", () => {
    const nouns = libraryNouns();
    expect(new Set(nouns.map((n) => n.symbol)).size).toBe(nouns.length);
  });

  it("is deterministic", () => {
    expect(libraryNouns()).toEqual(libraryNouns());
  });

  it("lowercases labels for the Speak menu", () => {
    for (const n of libraryNouns()) expect(n.label).toBe(n.label.toLowerCase());
  });
});
