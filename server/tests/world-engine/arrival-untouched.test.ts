/**
 * ═══ ⚖️ ARRIVAL IS NOT AN EVENT IN THE WORLD ═══
 *
 * User ruling, 2026-09-02, verbatim:
 *
 *   "In the full game, players will be able to gather a party and resources,
 *    and set out to a wild location to begin a new town. Logically, when they
 *    arrive, their presence should have no physical impact on the resources in
 *    the area - that happens only after they start harvesting. The 'town clears
 *    the surrounding area when generated' is meant to be a *logical* outcome,
 *    not an intrinsic property of site definitions. The land should still be
 *    untouched."
 *
 * This is item conservation reached from the worldbuilding side: a mount-time
 * clear destroys standing resources with NO ACTOR and NO EVENT. The felling
 * prerequisite (`lot-clearing.test.ts`) is the other half — it is what lets a
 * town clear its own ground the only way a town may, by acting.
 *
 * Three things are pinned here, and the FIRST is the one nobody saw:
 *
 *   ① A KEEP-CLEAR DISC IS A HOLE, NOT A RE-ROLL. `buildWilderness` used to
 *      test the disc INSIDE its draw loop, so a rejected candidate burned its
 *      draws and every later feature shifted. Measured before the fix at
 *      (seed 4242, side 240, the farmland mix): `clearR=61` against
 *      `clearR=0` left 0 of 14 features in the same place — a clear silently
 *      regenerated the whole countryside, which is why the file's own
 *      "absent ⇒ byte-identical" comments were true only for the absent case.
 *   ② A CLEARING MUST BE ASKED FOR — `clearR` defaults to 0.
 *   ③ The unfold (`expandWildArea`) carries the same law, with the extra
 *      constraint that it may never DROP a source: its stock is already dealt,
 *      so an excluded source is nudged, never deleted.
 */
import { describe, expect, it } from "@jest/globals";
import {
  buildWilderness,
  homesteadWildMix,
  wildMixForBiome,
  type WildernessFeature,
} from "@shared/world-engine/interaction/quest/wilderness.js";
import {
  condenseWildArea,
  expandWildArea,
  type WildAreaRecord,
} from "@shared/world-engine/interaction/quest/wild-area.js";

const SIDE = 240;
const CENTER = { x: SIDE / 2, y: SIDE / 2 };
const SEEDS = [1, 7, 42, 4242, 90210, 12345];

const at = (f: { x: number; y: number }): string => `${f.x}|${f.y}`;
const dist = (f: { x: number; y: number }, c: { x: number; y: number }): number =>
  Math.hypot(f.x - c.x, f.y - c.y);

const lay = (seed: number, clearR?: number) =>
  buildWilderness({
    seed,
    side: SIDE,
    mix: homesteadWildMix("farmland", seed),
    ...(clearR === undefined ? {} : { clearAt: CENTER, clearR }),
  });

// ── ① THE CLEAR IS A POST-FILTER ───────────────────────────────────────────

describe("⚖️ a keep-clear disc is a HOLE, never a re-roll", () => {
  it("leaves every surviving feature at the IDENTICAL id and spot", () => {
    for (const seed of SEEDS) {
      const open = lay(seed);
      for (const r of [6, 30, 61]) {
        const cut = lay(seed, r);
        const byId = new Map(open.features.map((f) => [f.id, f]));
        for (const f of cut.features) {
          const before = byId.get(f.id);
          expect(before).toBeDefined();
          expect(at(f)).toBe(at(before!));
        }
        // …and the survivors are EXACTLY the ones outside the disc: a hole
        // removes what it covers and nothing else.
        expect(cut.features.map((f) => f.id).sort()).toEqual(
          open.features.filter((f) => dist(f, CENTER) >= r).map((f) => f.id).sort(),
        );
      }
    }
  });

  it("holds for the WALKING half too (product animals, wandering locals)", () => {
    let anyThinned = false;
    for (const seed of SEEDS) {
      const open = lay(seed);
      const cut = lay(seed, 61);
      const byId = new Map(open.creatures.map((c) => [c.id, c]));
      expect(cut.creatures.length).toBeLessThanOrEqual(open.creatures.length);
      if (cut.creatures.length < open.creatures.length) anyThinned = true;
      for (const c of cut.creatures) {
        expect(at(c)).toBe(at(byId.get(c.id)!));
      }
    }
    expect(anyThinned).toBe(true); // the disc really is being applied to them
  });

  it("never leaves anything standing INSIDE the disc it was asked to clear", () => {
    for (const seed of SEEDS) {
      for (const r of [6, 30, 61]) {
        for (const f of lay(seed, r).features) expect(dist(f, CENTER)).toBeGreaterThanOrEqual(r);
      }
    }
  });

  it("is still deterministic — same params, same scatter", () => {
    expect(lay(4242, 61)).toEqual(lay(4242, 61));
    expect(lay(4242)).toEqual(lay(4242));
  });

  it("composes with the settlement `clears` list the same way", () => {
    const seed = 4242;
    const open = lay(seed);
    const hole = { x: 60, y: 60, r: 40 };
    const cut = buildWilderness({
      seed, side: SIDE, mix: homesteadWildMix("farmland", seed), clears: [hole],
    });
    expect(cut.features.map((f) => f.id)).toEqual(
      open.features.filter((f) => dist(f, hole) >= hole.r).map((f) => f.id),
    );
  });
});

// ── ② A CLEARING MUST BE ASKED FOR ─────────────────────────────────────────

describe("⚖️ `clearR` defaults to 0 — the ground is untouched until a caller asks", () => {
  it("an unasked scatter is exactly a clearR:0 scatter", () => {
    for (const seed of SEEDS) {
      expect(buildWilderness({ seed, side: SIDE, mix: homesteadWildMix("farmland", seed) }))
        .toEqual(lay(seed, 0));
    }
  });

  it("the spawn point is no longer a hole nobody dug", () => {
    // With the old default (6 m around the centre spawn) this was impossible
    // by construction. It has to be possible now, or "untouched" is a word
    // with no consequence — some seed, somewhere, stands a tree on the spot.
    // The disc is ~0.7 % of a 240 m square and the mix stands ~14 sources, so
    // a handful of seeds is not a sample; scan a few hundred.
    let hits = 0;
    for (let seed = 1; seed <= 400; seed++) {
      if (
        buildWilderness({ seed, side: SIDE, mix: homesteadWildMix("farmland", seed) })
          .features.some((f) => dist(f, CENTER) < 6)
      ) hits++;
    }
    expect(hits).toBeGreaterThan(0);
  });
});

// ── ③ THE UNFOLD CARRIES THE SAME LAW, AND STILL CONSERVES ─────────────────

const AREA = { x: 0, y: 0, w: SIDE, h: SIDE };
const sumStocks = (fs: readonly WildernessFeature[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const f of fs) for (const [g, n] of Object.entries(f.stock)) if (n > 0) out[g] = (out[g] ?? 0) + n;
  return out;
};
const recordFor = (seed: number): WildAreaRecord =>
  condenseWildArea({
    features: lay(seed).features,
    now: 0,
    area: AREA,
    seed,
    key: "home",
    prev: null,
  });

describe("⚖️ the FOLDED half — an exclusion moves only what it excludes", () => {
  it("leaves every unexcluded source exactly where it was", () => {
    for (const seed of SEEDS) {
      const rec = recordFor(seed);
      const open = expandWildArea({ rec });
      const box = { x: 90, y: 90, w: 60, h: 60 };
      const inBox = (x: number, y: number) =>
        x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
      const cut = expandWildArea({ rec, blocked: inBox });
      const byId = new Map(open.map((f) => [f.id, f]));
      for (const f of cut) {
        const before = byId.get(f.id)!;
        // A source the exclusion never touched must be untouched.
        if (!inBox(before.x, before.y)) expect(at(f)).toBe(at(before));
      }
      // …and the moved ones really moved OFF the excluded ground.
      for (const f of cut) expect(inBox(f.x, f.y)).toBe(false);
    }
  });

  it("🚨 NEVER DROPS A SOURCE — its stock is already dealt (item conservation)", () => {
    for (const seed of SEEDS) {
      const rec = recordFor(seed);
      const open = expandWildArea({ rec });
      const cut = expandWildArea({
        rec,
        clearAt: { x: 120, y: 120 },
        clearR: 61,
        blocked: (x, y) => x < 30,
      });
      expect(cut.length).toBe(open.length);
      expect(sumStocks(cut)).toEqual(sumStocks(open));
    }
  });

  it("stays deterministic in the record alone, exclusions included", () => {
    const rec = recordFor(4242);
    const opts = { rec, clearAt: { x: 120, y: 120 }, clearR: 50 };
    expect(expandWildArea(opts)).toEqual(expandWildArea(opts));
  });
});

// ── ④ THE ECOLOGICAL BIOME IS A DIFFERENT QUESTION FROM THE CHARTER ────────

describe("⚖️ the mix a founding wakes up in", () => {
  it("a FOREST cell stands a forest — which the charter label never could", () => {
    // `plan.biome` is a LAND-USE label and a founded site's charter is
    // hardcoded farmland (founding.ts siteTownConfig), so the charter arm
    // answers the same livestock mix on every cell in the world. The
    // ecological arm is what makes founding on a forest mean anything.
    const charter = homesteadWildMix("farmland", 4242);
    const forest = wildMixForBiome(1, 4242);
    expect(charter.find((e) => e.species === "oak")!.count).toBe(8);
    expect(forest.find((e) => e.species === "oak")!.count).toBe(10);
    expect(charter.some((e) => e.species === "sheep")).toBe(true);
    expect(forest.some((e) => e.species === "sheep")).toBe(false);
  });
});
