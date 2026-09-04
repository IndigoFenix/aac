/**
 * ═══ ⚖️ RELEVANCE AND VISIBILITY ARE TWO DIFFERENT RADII ═══
 *
 * User ruling, 2026-09-02, verbatim:
 *
 *   "generally speaking, only the near stand should be relevant. The only
 *    exception is for rendering purposes at levels of detail where more distant
 *    objects SHOULD be visible; we shouldn't stop *rendering* trees that should
 *    be on-camera just because they're not technically part of the site or its
 *    sources, but they shouldn't be selectable. (This means that viewing
 *    distance is relevant to whether or not a region needs to be expanded.) A
 *    border around the focused area might help."
 *
 * The sibling of `arrival-untouched.test.ts`: that one pins that a founding
 * DESTROYS nothing; this one pins that a founding OWNS only its own ground.
 *
 * What is pinned here:
 *
 *   ① THE LADDER. `nearStandRadiusM` is an integer-stepped function of a
 *      monotone counter (`charterReachCells`' shape), so relevance moves at
 *      building events and never per tick or per frame. A radius that drifted
 *      would move the source list, the selection and the drawn border under a
 *      player mid-harvest.
 *   ② THE DISC IS A HOLE, NOT A RE-ROLL — `keep` is the inverse of `clears`
 *      and rides the same post-filter, so the near stand is a strict SUBSET of
 *      the unbounded scatter at identical ids and identical coordinates. That
 *      is what makes the stand able to GROW without re-rolling the countryside,
 *      and it is why "same seed ⇒ same world" survives.
 *   ③ FEATURES ONLY. Walking bodies are the streamer's business (the fold's
 *      own law: "a body with a mind"), so a herd is never bounded by a stand.
 *   ④ 🎁 THE ACCEPTANCE CRITERION: the boundary is INVISIBLE IN DENSITY TERMS.
 *      Both tree authorities resolve through `ecology.ts standDensityPerHa`, so
 *      crossing the border changes what is SELECTABLE, never what the forest
 *      looks like.
 *   ⑤ ABSENT ⇒ byte-identical, for every caller that bounds no stand.
 */
import { describe, expect, it } from "@jest/globals";
import {
  buildWilderness,
  homesteadWildMix,
  nearStandRadiusM,
  wildMixForBiome,
  NEAR_STAND_BASE_M,
  NEAR_STAND_STEP_M,
} from "@shared/world-engine/interaction/quest/wilderness.js";
import { standDensityPerHa } from "@shared/world-engine/planet/ecology.js";
import { resolveWorldScale, serviceRadiusM, REAL_SCALE } from "@shared/world-engine/scale.js";

/** The shipped frontier homestead's world (worlds.ts `frontier-planet`). */
const STREET_CLOCK = resolveWorldScale({
  rotation: 360,
  sleep_fraction: 0.05,
  construction: 720,
  gap_compression: 10,
  resource_compression: 7.5,
} as never);

/** Its age-0 town: `plan.radius` 55 ⇒ `plan.radius * 2 + 80` (town-stage.ts). */
const SIDE = 190;
const CENTER = { x: SIDE / 2, y: SIDE / 2 };
/** The measured forest founding cell — biome 1, `eco.tree` 0.35 ⇒ 15.05 oak/ha. */
const FOREST_ECO = { tree: 0.35, grass: 0.02, horse: 0 } as const;
const SEEDS = [1, 7, 42, 1337, 4242, 90210];

const forestMix = (seed: number) => wildMixForBiome(1, seed, undefined, FOREST_ECO);
const lay = (seed: number, r?: number) =>
  buildWilderness({
    seed,
    side: SIDE,
    mix: forestMix(seed),
    ...(r === undefined ? {} : { keep: { ...CENTER, r } }),
  });
const at = (f: { x: number; y: number }): string => `${f.x}|${f.y}`;
const dist = (f: { x: number; y: number }): number =>
  Math.hypot(f.x - CENTER.x, f.y - CENTER.y);

describe("① the near-stand ladder — discrete, monotone, capped", () => {
  it("is the town's own units: a founding clearing plus a lot's frontage per doubling", () => {
    expect(NEAR_STAND_BASE_M).toBe(30); // TOWN_DIMS.plazaR
    expect(NEAR_STAND_STEP_M).toBe(15); // TOWN_DIMS.lotPitch
    expect(nearStandRadiusM(STREET_CLOCK, 0)).toBe(30);
  });

  it("steps ONLY at 1/3/7/15/31 buildings — never between them", () => {
    const r = (n: number) => nearStandRadiusM(STREET_CLOCK, n);
    // The plateaus: nothing inside a doubling band moves the answer.
    for (const [lo, hi] of [[0, 0], [1, 2], [3, 6], [7, 14], [15, 30], [31, 62]] as const) {
      for (let n = lo; n <= hi; n++) expect(r(n)).toBe(r(lo));
    }
    // …and each band really is one step above the last (until the cap bites).
    expect(r(1)).toBe(r(0) + NEAR_STAND_STEP_M);
    expect(r(3)).toBe(r(1) + NEAR_STAND_STEP_M);
    expect(r(7)).toBe(r(3) + NEAR_STAND_STEP_M);
  });

  it("never contracts, and a fractional/negative count cannot make it jitter", () => {
    let prev = -Infinity;
    for (let n = 0; n <= 200; n++) {
      const r = nearStandRadiusM(STREET_CLOCK, n);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
    expect(nearStandRadiusM(STREET_CLOCK, -5)).toBe(nearStandRadiusM(STREET_CLOCK, 0));
    expect(nearStandRadiusM(STREET_CLOCK, 2.9)).toBe(nearStandRadiusM(STREET_CLOCK, 2));
  });

  it("is CAPPED by a need cycle's walk — `serviceRadiusM` is the ceiling", () => {
    const cap = serviceRadiusM(STREET_CLOCK, "hunger");
    expect(cap).toBeCloseTo(96, 6);
    for (let n = 0; n <= 4096; n++) {
      expect(nearStandRadiusM(STREET_CLOCK, n)).toBeLessThanOrEqual(cap);
    }
    expect(nearStandRadiusM(STREET_CLOCK, 1 << 20)).toBe(cap);
  });

  it("🚧 …and the ceiling does NOT bind at real scale — the stopgap's own note", () => {
    // The walk budgets are right and land at neither scale that consumes them:
    // at REAL_SCALE `serviceRadiusM` is tens of kilometres, so the ladder (and
    // the caller's extent clamp) is the whole answer. Reported, not smuggled.
    expect(serviceRadiusM(REAL_SCALE, "hunger")).toBeGreaterThan(10_000);
    expect(nearStandRadiusM(REAL_SCALE, 0)).toBe(NEAR_STAND_BASE_M);
  });
});

describe("② the relevance disc is a HOLE, not a re-roll", () => {
  it("keeps a strict SUBSET of the unbounded scatter at identical ids and spots", () => {
    for (const seed of SEEDS) {
      const full = lay(seed);
      const near = lay(seed, nearStandRadiusM(STREET_CLOCK, 0));
      const byId = new Map(full.features.map((f) => [f.id, f]));
      expect(near.features.length).toBeLessThan(full.features.length);
      for (const f of near.features) {
        const twin = byId.get(f.id);
        expect(twin).toBeDefined();
        expect(at(f)).toBe(at(twin!));
        expect(f.stock).toEqual(twin!.stock);
      }
    }
  });

  it("holds exactly the features inside the disc — nothing else is laid", () => {
    const r = nearStandRadiusM(STREET_CLOCK, 3);
    for (const seed of SEEDS) {
      const full = lay(seed);
      const near = lay(seed, r);
      expect(new Set(near.features.map((f) => f.id))).toEqual(
        new Set(full.features.filter((f) => dist(f) <= r).map((f) => f.id)),
      );
      for (const f of near.features) expect(dist(f)).toBeLessThanOrEqual(r);
    }
  });

  it("GROWS by revealing, never by re-rolling: each rung's stand contains the last", () => {
    // The property `growNearStand` rests on — a step deals the annulus and the
    // trees already standing are untouched (which is also how a felled tree
    // cannot walk back in: the annulus is strictly outside the old radius).
    for (const seed of SEEDS) {
      let prevIds = new Set<string>();
      for (const built of [0, 1, 3, 7, 15, 31]) {
        const ids = new Set(
          lay(seed, nearStandRadiusM(STREET_CLOCK, built)).features.map((f) => f.id),
        );
        for (const id of prevIds) expect(ids.has(id)).toBe(true);
        prevIds = ids;
      }
    }
  });

  it("is deterministic in the seed", () => {
    const r = nearStandRadiusM(STREET_CLOCK, 0);
    for (const seed of SEEDS) expect(lay(seed, r)).toEqual(lay(seed, r));
  });
});

describe("③ a herd is not a stand — walking bodies are exempt", () => {
  it("bounds FEATURES only; creatures come through untouched", () => {
    for (const seed of SEEDS) {
      const full = buildWilderness({ seed, side: SIDE, mix: homesteadWildMix("farmland", seed) });
      const near = buildWilderness({
        seed,
        side: SIDE,
        mix: homesteadWildMix("farmland", seed),
        keep: { ...CENTER, r: nearStandRadiusM(STREET_CLOCK, 0) },
      });
      expect(near.creatures).toEqual(full.creatures);
      expect(near.features.length).toBeLessThanOrEqual(full.features.length);
    }
  });
});

describe("④ 🎁 the boundary is invisible in DENSITY terms (the acceptance criterion)", () => {
  it("the near stand's realised oak density equals the unbounded scatter's", () => {
    // ONE seed is noise (a 0.28 ha disc holds ~5 trees); the LAW is the mean.
    const r = nearStandRadiusM(STREET_CLOCK, 0);
    const discHa = (Math.PI * r * r) / 10_000;
    // The scatter draws into [8, side-8] — its own margin, unchanged by this
    // round and the reason both figures sit ~19% above the field's law.
    const rectHa = ((SIDE - 16) * (SIDE - 16)) / 10_000;
    let inside = 0;
    let whole = 0;
    const N = 400;
    for (let s = 0; s < N; s++) {
      const mix = forestMix(s);
      inside += buildWilderness({ seed: s, side: SIDE, mix, keep: { ...CENTER, r } })
        .features.filter((f) => f.species === "oak").length;
      whole += buildWilderness({ seed: s, side: SIDE, mix })
        .features.filter((f) => f.species === "oak").length;
    }
    const insidePerHa = inside / (N * discHa);
    const wholePerHa = whole / (N * rectHa);
    // Within 10%: the disc and the rect describe the SAME countryside, so the
    // relevance boundary can never read as a forest edge.
    expect(Math.abs(insidePerHa - wholePerHa) / wholePerHa).toBeLessThan(0.1);
  });

  it("…and both authorities read the ONE density law", () => {
    // The scatter's per-hectare line and the streamed flora field's per-tile
    // count are the same function of the same cell (`standDensityPerHa`) — the
    // 5.4× seam that made two countrysides is closed and must stay closed.
    const oakPerHa = standDensityPerHa("oak", FOREST_ECO);
    expect(oakPerHa).toBeCloseTo(15.05, 2);
    const oakLine = forestMix(1337).find((m) => m.species === "oak");
    expect(oakLine?.perHa).toBeCloseTo(oakPerHa, 6);
  });
});

// ── ⑥ THE MEASURED STAND — WHAT AN AGE-0 SITE ACTUALLY OWNS ────────────────
//
// 🚨 A COMMENT IS A CLAIM, AND THIS ONE DID NOT RECONCILE. The founding mount's
// note read *"the disc an age-0 site buys stands 13"* against a stated
// 15.05 oaks/ha: r=30 m is 0.283 ha, which is ~4–5 oaks, not 13 (13 needs
// r≈52 m — a site with 3–6 buildings up). The 13 was seed 1337's own draw. At
// ~5 trees a disc, single-seed counts run 2..13, so no reader may size the
// ladder against one of them; the numbers in that comment are these.

describe("⑥ the age-0 stand, measured", () => {
  const N = 400;
  const oaksIn = (r?: number): number[] => {
    const out: number[] = [];
    for (let s = 0; s < N; s++) {
      out.push(
        buildWilderness({
          seed: s,
          side: SIDE,
          mix: forestMix(s),
          ...(r === undefined ? {} : { keep: { ...CENTER, r } }),
        }).features.filter((f) => f.species === "oak").length,
      );
    }
    return out;
  };
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

  it("the 190 m rect stands 54 oaks on EVERY seed — a perHa count is rounded, not rolled", () => {
    // 3.61 ha × 15.05 oaks/ha = 54.3 ⇒ 54. Deterministic in the extent, which
    // is what makes the rect figure quotable at all.
    for (const n of oaksIn()) expect(n).toBe(54);
  });

  it("the age-0 disc stands ~5 — NOT 13, and 13 is one seed's draw", () => {
    const r = nearStandRadiusM(STREET_CLOCK, 0);
    expect(r).toBe(30);
    const counts = oaksIn(r);
    // The mean lands where the density says it must: 0.283 ha of a countryside
    // realised at 54 oaks / 3.03 ha (the scatter's own 8 m draw margin).
    expect(mean(counts)).toBeGreaterThan(4.5);
    expect(mean(counts)).toBeLessThan(5.6);
    // …and the spread is why a single seed proves nothing about the stand:
    // seed 1337 — the draw the retired "13" was read off — is 2.5× the mean,
    // and seed 1 is under half of it.
    const oaksAt = (seed: number) =>
      buildWilderness({ seed, side: SIDE, mix: forestMix(seed), keep: { ...CENTER, r } })
        .features.filter((f) => f.species === "oak").length;
    expect(oaksAt(1337)).toBe(13);
    expect(oaksAt(1)).toBe(2);
    expect(Math.max(...counts) - Math.min(...counts)).toBeGreaterThan(5);
  });

  it("13 is where r≈52 m lands — i.e. a site with buildings up, not a founding", () => {
    // The rung the retired comment actually described. `built` 3..6 buys 60 m.
    expect(nearStandRadiusM(STREET_CLOCK, 3)).toBe(60);
    expect(mean(oaksIn(52))).toBeGreaterThan(13);
    expect(mean(oaksIn(30))).toBeLessThan(13);
  });

  it("…and the timber that comes with it", () => {
    // The other half of the mount's note: ~867 wood on the rect (seven houses'
    // worth on untouched ground), ~81 inside the age-0 disc.
    const woodIn = (r?: number): number => {
      let total = 0;
      for (let s = 0; s < N; s++) {
        total += buildWilderness({
          seed: s,
          side: SIDE,
          mix: forestMix(s),
          ...(r === undefined ? {} : { keep: { ...CENTER, r } }),
        }).features.reduce((n, f) => n + (f.stock?.["wood"] ?? 0), 0);
      }
      return total / N;
    };
    expect(woodIn()).toBeGreaterThan(820);
    expect(woodIn()).toBeLessThan(910);
    expect(woodIn(nearStandRadiusM(STREET_CLOCK, 0))).toBeGreaterThan(70);
    expect(woodIn(nearStandRadiusM(STREET_CLOCK, 0))).toBeLessThan(95);
  });
});

describe("⑤ absent ⇒ byte-identical", () => {
  it("a scatter with no `keep` is exactly the scatter it always was", () => {
    for (const seed of SEEDS) {
      const mix = homesteadWildMix("farmland", seed);
      expect(buildWilderness({ seed, side: SIDE, mix })).toEqual(
        buildWilderness({ seed, side: SIDE, mix, keep: undefined }),
      );
    }
  });

  it("a `keep` wider than the ground changes nothing", () => {
    for (const seed of SEEDS) {
      const mix = forestMix(seed);
      expect(buildWilderness({ seed, side: SIDE, mix, keep: { ...CENTER, r: 10_000 } })).toEqual(
        buildWilderness({ seed, side: SIDE, mix }),
      );
    }
  });
});
