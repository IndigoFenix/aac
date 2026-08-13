// Kernel pins migrated OUT of games/grand-dream/src/__tests__ (2026-08-12).
// Grand-dream was the world-engine's PROTOTYPE and is retiring; its vitest
// suite accumulated the canonical street-kernel pins through shims. The
// load-bearing ones move here so the engine gates stop depending on a
// retiring directory (and on the solo-run ritual its load artifacts forced).
// Source of truth: roads.test.ts:17-33 (the prefix contract every growth
// phase has had to keep green). Redundant vitest pins NOT ported: the
// delivery-credit pin (jest town-quests already pins the bridge), refine
// determinism (jest refine slice), regrow idempotence (town-baseline,
// town-loops). Paint idempotency/replaceRoutes stay vitest-side until the
// directory is deleted (planet-render builds real planets).

import { growStreets } from "@shared/world-engine/kernel/town/streets.js";

describe("street kernel prefix stability (the grand-dream canonical pin)", () => {
  const SEED = 7;
  const KEY = "riverton";

  it("a bigger town runs the SAME event stream further — slots are a byte-identical prefix", () => {
    const small = growStreets(SEED, KEY, 120);
    const big = growStreets(SEED, KEY, 500);
    expect(big.slots.length).toBeGreaterThan(small.slots.length);
    expect(JSON.stringify(big.slots.slice(0, small.slots.length))).toBe(
      JSON.stringify(small.slots),
    );
  });

  it("every small street survives verbatim: same id order, same parent, pts a prefix", () => {
    const small = growStreets(SEED, KEY, 120);
    const big = growStreets(SEED, KEY, 500);
    for (const s of small.streets) {
      const b = big.streets[s.id]!;
      expect(b).toBeDefined();
      expect(b.parent).toBe(s.parent);
      expect(JSON.stringify(b.pts.slice(0, s.pts.length))).toBe(JSON.stringify(s.pts));
    }
  });

  it("links grow as a superset in event order (the loops overlay inherits the contract)", () => {
    const small = growStreets(SEED, KEY, 120);
    const big = growStreets(SEED, KEY, 500);
    const smallLinks = small.links ?? [];
    expect(JSON.stringify((big.links ?? []).slice(0, smallLinks.length))).toBe(
      JSON.stringify(smallLinks),
    );
  });

  it("same inputs are byte-identical across independent calls", () => {
    const a = growStreets(SEED, KEY, 300);
    const b = growStreets(SEED, KEY, 300);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
