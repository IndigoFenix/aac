/**
 * ⚖️ #49 — THE NEIGHBOURING STANDS (neighboring-stands-round.md, Stage 1).
 *
 * THE ROUND'S REASON, in one sentence: the abstract tier (`wild:area:`
 * records) existed only for ground that was once LOADED, so a site's supply
 * enumeration could see nothing beyond its own near-stand disc and a
 * sparsely-forested founding deadlocked — "it needs 400 wood and everything
 * within reach comes to 12" was a true statement about a world with a forest
 * three hundred metres away. This file pins the MINT that closes it, and the
 * seams the mint newly exposes.
 *
 * WHAT IS PINNED (and why each one is here rather than assumed):
 *
 *   ① THE GRID — tile (0,0) is never minted (that ground is the site's own),
 *      the reach ring is exactly the tiles whose CENTRE is in range, and the
 *      key grammar round-trips through a negative index.
 *   ② 🚨 THE NO-DOUBLE-COUNT INVARIANT — the near stand's hard cap (96 m) is
 *      strictly less than half a tile (100 m), so the disc can never grow into
 *      ring-1 ground and represent a tree twice.
 *   ③ THE MINT — deterministic in the seed, sized by the ONE density law
 *      (`perHa × 4 ha`, rounded), built through the SAME condense path a fold
 *      runs (mature, standing, no clocks, no harvest direction).
 *   ④ 🔒 A COUNT MIX MINTS NOTHING — the bench-safety law, by construction:
 *      dollhouse/preset/harness worlds get no tile records at all.
 *   ⑤ CONSERVATION + REGROW — a draw's `taken` equals the record's stock drop,
 *      and a drawn-down tile ripens back toward cap.
 *   ⑥ THE COORDINATE LAW — distance is measured to the RECT (so ring 1 and
 *      ring 2 rank differently), feet walk to a point clamped INTO the
 *      walkable manifold.
 *   ⑦ NEVER UNFOLDED — three independent guards, each pinned.
 *   ⑧ ⚖️ FIELD RECORD ONLY (#48) — a minted wild record bears food and must
 *      still never reach the town books.
 *   ⑨ 🎁 THE ACCEPTANCE TEST — a bill that reads IMPOSSIBLE against the disc
 *      alone becomes feasible once the tiles are enumerated.
 *   ⑩ THE ORDERED DRAW — a scheduled leg against a tile key ships real units.
 *
 * DB-free / GL-free — `npm run test:engine -- neighbor-stands`.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import {
  isNeighborTileKey,
  mintNeighborStands,
  neighborTileIndex,
  neighborTileKey,
  neighborTileOffsets,
  neighborTileRect,
  NEIGHBOR_REACH_M,
  NEIGHBOR_TILE_M,
} from "@shared/world-engine/interaction/quest/neighbor-stands.js";
import {
  homesteadWildMix,
  nearStandRadiusM,
  wildMixForBiome,
} from "@shared/world-engine/interaction/quest/wilderness.js";
import {
  drawWildArea,
  farmAreaKey,
  farmAreaRecord,
  localDailyUnitsForGood,
  ripenWildArea,
  wildAreaPopulation,
  wildAreaQuote,
  wildAreaStock,
  restWildRecord,
  shiftWildAreaClock,
  wakeAreaRecords,
  wakeWildRecord,
  wildRectPointToward,
  wildSourcePartner,
  wildKeepChance,
  wildKeepMean,
  wildSourceFullStock,
  wildStandStockOf,
  wildThinField,
  wildThinFraction,
  wildThinHidden,
  wildThinRoll,
  WILD_THIN_STEPS,
  type WildAreaRecord,
  type WildThinInstance,
} from "@shared/world-engine/interaction/quest/wild-area.js";
import {
  createConstructionDirector,
  type ConstructionDirectorCtx,
} from "@shared/world-engine/interaction/quest/construction-director.js";
import {
  createFoundedSite,
  foundedSiteToJSON,
  foundSite,
  siteTownConfig,
} from "@shared/world-engine/interaction/town/founding.js";
import { wildAreaId } from "@shared/world-engine/kernel/town/scope.js";
import {
  createTownDeltas,
  TOWN_YARD_EP,
  type SerializedTownDeltas,
} from "@shared/world-engine/kernel/town/construction.js";
import { FOOD_DAY_SEC } from "@shared/world-engine/kernel/town/goods.js";
import { stackUnits } from "@shared/world-engine/kernel/town/transfer.js";
import { REAL_SCALE, resolveWorldScale, serviceRadiusM } from "@shared/world-engine/scale.js";

// ── The fixtures ──────────────────────────────────────────────────────────

const specPath = join(process.cwd(), "scripts", "worlds", "frontier.spec.json");
const doc = JSON.parse(readFileSync(specPath, "utf8")) as Record<string, unknown>;

/** The measured forest founding cell — biome 1, `eco.tree` 0.35 ⇒ 15.05 oak/ha
 *  (near-stand.test.ts ⑥ holds the numbers this shares). */
const FOREST_ECO = { tree: 0.35, grass: 0.02, horse: 0 } as const;
/** A COUNTRYSIDE mix: per-HECTARE densities off a cell's baked ecology. */
const countryMix = (seed: number) =>
  wildMixForBiome(1, seed, undefined, FOREST_ECO as never);
/** An AUTHORED mix: absolute counts, the charter arm every bench world uses. */
const countMix = (seed: number) => homesteadWildMix("farmland", seed);

const SEED = 12;
const CENTER = { x: 95, y: 95 };
const mintAt = (seed = SEED, center = CENTER, now = 0): WildAreaRecord[] =>
  mintNeighborStands({ mix: countryMix(seed), center, seed, now });

// ═══════════════════════════════════════════════════════════════════════════
// ① THE GRID
// ═══════════════════════════════════════════════════════════════════════════

describe("① the tile grid", () => {
  it("never mints tile (0,0) — that ground is the site's own stand", () => {
    expect(neighborTileOffsets().some((t) => t.i === 0 && t.j === 0)).toBe(false);
    expect(mintAt().some((r) => r.key === neighborTileKey(0, 0))).toBe(false);
  });

  it("is exactly the tiles whose CENTRE lies within the reach", () => {
    const tiles = neighborTileOffsets();
    for (const { i, j } of tiles) {
      expect(Math.hypot(i * NEIGHBOR_TILE_M, j * NEIGHBOR_TILE_M)).toBeLessThanOrEqual(
        NEIGHBOR_REACH_M,
      );
    }
    // At the shipped 200 m / 500 m that is two rings minus the diagonal
    // corners: 4 + 4 + 4 + 8 = 20. (±2,±2) is 566 m out and is NOT in.
    expect(tiles).toHaveLength(20);
    expect(tiles.some((t) => Math.abs(t.i) === 2 && Math.abs(t.j) === 2)).toBe(false);
    expect(tiles.filter((t) => Math.abs(t.i) === 2 || Math.abs(t.j) === 2)).toHaveLength(12);
  });

  it("puts the rect at its TRUE session offset, tile (0,0) centred on the site", () => {
    // Tile 0's rect is the 200 m square around the town: the near stand lives
    // inside it, which is what ② is about.
    expect(neighborTileRect(CENTER, 0, 0)).toEqual({ x: -5, y: -5, w: 200, h: 200 });
    expect(neighborTileRect(CENTER, 1, 0)).toEqual({ x: 195, y: -5, w: 200, h: 200 });
    expect(neighborTileRect(CENTER, -2, 1)).toEqual({ x: -405, y: 195, w: 200, h: 200 });
    // …and the tiles TILE the plane: neighbours share an edge, never overlap.
    const a = neighborTileRect(CENTER, 1, 0);
    const b = neighborTileRect(CENTER, 2, 0);
    expect(a.x + a.w).toBe(b.x);
  });

  it("key grammar round-trips, negative indices included", () => {
    for (const [i, j] of [[1, 0], [-1, 0], [0, -2], [-2, -1], [2, 2]] as const) {
      const key = neighborTileKey(i, j);
      expect(isNeighborTileKey(key)).toBe(true);
      expect(neighborTileIndex(key)).toEqual({ i, j });
      // The FROZEN half of the grammar — the tail is free, the prefix is not.
      expect(wildAreaId(key)).toBe(`wild:area:${key}`);
    }
    // …and it does not claim the OTHER tails the record map holds.
    expect(isNeighborTileKey("home")).toBe(false);
    expect(isNeighborTileKey(farmAreaKey("frontier"))).toBe(false);
    expect(neighborTileIndex("home")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 🚨 THE NO-DOUBLE-COUNT INVARIANT
// ═══════════════════════════════════════════════════════════════════════════

describe("② the near stand can never grow into a minted tile", () => {
  it("96 m (the hard cap) < 100 m (half a tile) — so no tree is represented twice", () => {
    const STREET_CLOCK = resolveWorldScale({
      rotation: 360,
      sleep_fraction: 0.05,
      construction: 720,
      gap_compression: 10,
      resource_compression: 7.5,
    } as never);
    // The ladder's ceiling is a need cycle's walk, and it saturates there.
    const cap = serviceRadiusM(STREET_CLOCK, "hunger");
    expect(cap).toBeCloseTo(96, 6);
    expect(nearStandRadiusM(STREET_CLOCK, 1 << 20)).toBe(cap);
    // 🚨 THE INEQUALITY. Everything the disc can ever own lies inside tile
    // (0,0)'s own 200 m square, which is the one tile that is never minted.
    expect(cap).toBeLessThan(NEIGHBOR_TILE_M / 2);
    for (let built = 0; built <= 4096; built++) {
      expect(nearStandRadiusM(STREET_CLOCK, built)).toBeLessThan(NEIGHBOR_TILE_M / 2);
    }
    // …read as geometry: the widest disc is strictly inside tile 0's rect.
    const t0 = neighborTileRect(CENTER, 0, 0);
    expect(CENTER.x - cap).toBeGreaterThan(t0.x);
    expect(CENTER.x + cap).toBeLessThan(t0.x + t0.w);
  });

  it("🚧 …and the ladder is NOT self-limiting at every scale — hence the belt", () => {
    // The honest half. `serviceRadiusM` is tens of kilometres at REAL_SCALE
    // (near-stand.test.ts ① states this as the stopgap's own note), so there
    // the ladder climbs free — 30 + 15·floor(log₂(1+built)) passes 100 m at 31
    // buildings — and the invariant above would hold only by luck. That is why
    // `refreshNearStand` clamps to `NEIGHBOR_TILE_M / 2` as well as to the
    // extent: the partition between "what the site owns" and "what it reaches
    // for" is enforced, not observed.
    expect(serviceRadiusM(REAL_SCALE, "hunger")).toBeGreaterThan(10_000);
    expect(nearStandRadiusM(REAL_SCALE, 31)).toBeGreaterThan(NEIGHBOR_TILE_M / 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ THE MINT
// ═══════════════════════════════════════════════════════════════════════════

describe("③ the mint", () => {
  it("is deterministic in the seed, to the byte", () => {
    expect(mintAt(SEED)).toEqual(mintAt(SEED));
    // …and a DIFFERENT seed is a different countryside (so the determinism
    // above is not the trivial "it always returns the same thing").
    expect(JSON.stringify(mintAt(SEED))).not.toBe(JSON.stringify(mintAt(SEED + 1)));
  });

  it("sizes each stand by the ONE density law: round(perHa × 4 ha)", () => {
    const mix = countryMix(SEED);
    const recs = mintAt();
    const areaHa = (NEIGHBOR_TILE_M * NEIGHBOR_TILE_M) / 10_000;
    expect(areaHa).toBe(4);
    for (const rec of recs) {
      for (const line of mix) {
        if (line.perHa === undefined) continue;
        const stand = rec.stands.find((s) => s.species === line.species);
        const want = Math.round(line.perHa * areaHa);
        // Animals are dealt as CREATURES and are never folded (the recorded
        // residual) — only feature species get a stand.
        if (!stand) continue;
        expect(wildAreaPopulation({ ...rec, stands: [stand] })).toBe(want);
      }
    }
    // A `perHa` count is ROUNDED, not rolled — so every tile stands the same
    // number of oaks and the countryside is uniform at this radius (the v1
    // residual, stated as a fact rather than left to be discovered).
    const oaks = recs.map((r) => r.stands.find((s) => s.species === "oak")!.byClass[0]);
    expect(new Set(oaks).size).toBe(1);
  });

  it("builds the record through the CONDENSE path — fresh, mature, standing", () => {
    for (const rec of mintAt()) {
      for (const st of rec.stands) {
        // Mature: a fresh feature leaves `sizeClass` unset, so `classOf` puts
        // the whole population in the catalogue's LAST class.
        expect(st.byClass.slice(0, -1).every((n) => n === 0)).toBe(true);
        expect(st.byClass[st.byClass.length - 1]).toBeGreaterThan(0);
        // No clocks: nothing is climbing and nothing is refilling.
        expect(st.climbAt).toEqual([]);
        expect(st.regrowAt).toEqual({});
      }
      // An untouched forest declares NO harvest direction — the condenser's
      // depletion inference finds every roll at or above its own floor.
      expect(rec.draw.every((n) => n === 0)).toBe(true);
      // The record names its own ground, and its stands hold real units.
      expect(rec.area.w).toBe(NEIGHBOR_TILE_M);
      expect(wildAreaStock(rec).wood ?? 0).toBeGreaterThan(0);
      // …and it is plain, serializable data (the render quote's contract).
      expect(() => JSON.stringify(wildAreaQuote(rec))).not.toThrow();
    }
  });

  it("mints NOTHING from an absolute COUNT mix — the bench-safety law", () => {
    expect(mintNeighborStands({
      mix: countMix(SEED), center: CENTER, seed: SEED, now: 0,
    })).toEqual([]);
    // …and the gate really is `perHa`, not the biome or the caller: one
    // density line anywhere in the mix is enough to make it a countryside.
    expect(mintNeighborStands({
      mix: [{ species: "oak", count: 10 }, { species: "rock", count: 6, perHa: 1 }],
      center: CENTER, seed: SEED, now: 0,
    }).length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ CONSERVATION AND REGROWTH (the record is an ordinary source)
// ═══════════════════════════════════════════════════════════════════════════

describe("⑤ a minted tile is an ordinary source: it conserves, and it regrows", () => {
  it("a draw's `taken` equals the record's stock drop, to the unit", () => {
    const rec = mintAt()[0]!;
    const before = wildAreaStock(rec);
    const out = drawWildArea(rec, { glyph: "wood", units: 40, from: CENTER, now: 100 });
    const after = wildAreaStock(out.rec);
    const glyphs = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const g of glyphs) {
      expect((before[g] ?? 0) - (after[g] ?? 0)).toBe(out.taken[g] ?? 0);
    }
    // A KILL draw FELLS, so the answer may exceed the ask — and the population
    // follows the timber out (the felled-tree law, read through the record).
    expect(out.taken.wood ?? 0).toBeGreaterThanOrEqual(40);
    expect(wildAreaPopulation(out.rec)).toBeLessThan(wildAreaPopulation(rec));
    // …and the draw books the direction it came from.
    expect(out.rec.draw.some((n) => n > 0)).toBe(true);
  });

  it("a drawn-down tile ripens back toward cap on the field pulse", () => {
    // Its BANANA stand is a harvest source (a picked plant keeps standing), so
    // the regrow half of the felled-oak law is legible on it.
    const rec = mintAt().find((r) => r.stands.some((s) => (s.cap.banana ?? 0) > 0))!;
    const cap = rec.stands.find((s) => (s.cap.banana ?? 0) > 0)!.cap.banana!;
    const picked = drawWildArea(rec, { glyph: "banana", units: cap, now: 0 }).rec;
    expect(wildAreaStock(picked).banana ?? 0).toBe(0);
    // HEAL arms the clock on the first pulse; the next one refills to cap.
    const armed = ripenWildArea(picked, 0, () => FOOD_DAY_SEC);
    const refilled = ripenWildArea(armed, FOOD_DAY_SEC * 2, () => FOOD_DAY_SEC);
    expect(wildAreaStock(refilled).banana ?? 0).toBe(cap);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ THE COORDINATE LAW (the pure half — the booted half is ⑦ below)
// ═══════════════════════════════════════════════════════════════════════════

describe("⑥ distance is measured to the RECT", () => {
  it("ring 1 and ring 2 in the same direction rank differently", () => {
    const recs = new Map(mintAt().map((r) => [r.key, r]));
    const r1 = recs.get(neighborTileKey(1, 0))!;
    const r2 = recs.get(neighborTileKey(2, 0))!;
    // The RANKING point (the director's `regionShelfPoint`): the rect edge
    // toward the gate, unclamped.
    const p1 = wildRectPointToward(r1, CENTER);
    const p2 = wildRectPointToward(r2, CENTER);
    expect(p1.x).toBeCloseTo(CENTER.x + 100, 6);
    expect(p2.x).toBeCloseTo(CENTER.x + 300, 6);
    expect(Math.hypot(p1.x - CENTER.x, p1.y - CENTER.y)).toBeLessThan(
      Math.hypot(p2.x - CENTER.x, p2.y - CENTER.y),
    );
    // …and so does the LEG price's own input (the partner's road).
    const d1 = wildSourcePartner(r1, CENTER).distanceM!;
    const d2 = wildSourcePartner(r2, CENTER).distanceM!;
    expect(d1).toBeCloseTo(NEIGHBOR_TILE_M, 6);
    expect(d2).toBeCloseTo(NEIGHBOR_TILE_M * 2, 6);
  });

  it("an origin inside the rect degenerates to the origin (the home-area law)", () => {
    const rec = mintAt()[0]!;
    const inside = { x: rec.area.x + 3, y: rec.area.y + 7 };
    expect(wildRectPointToward(rec, inside)).toEqual(inside);
    // …and no origin at all falls back to the rect's own centre.
    expect(wildRectPointToward(rec, null)).toEqual({
      x: rec.area.x + rec.area.w / 2,
      y: rec.area.y + rec.area.h / 2,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE BOOTED HALF — one countryside founding, many phases
// ═══════════════════════════════════════════════════════════════════════════
//
// `wildMix` is the headless seat this round added: without it a text boot
// always scattered the CHARTER arm (absolute counts), so the countryside
// premise — the very shape `frontier-planet` mounts — was unreachable here and
// every headless measurement of it was taken in an authored-count world.

describe("the booted countryside founding", () => {
  let run: TextQuestRun;
  /** The minted keys, snapshotted at boot (phases mutate the map). */
  let tileKeys: string[];
  let mintedByKey: Map<string, WildAreaRecord>;

  beforeAll(() => {
    run = bootTextQuest({ world: doc, seed: SEED, dt: 1 / 10, wildMix: countryMix(SEED) });
    tileKeys = [...run.session.areaRecords.keys()].filter(isNeighborTileKey).sort();
    mintedByKey = new Map(
      tileKeys.map((k) => [k, structuredClone(run.session.areaRecords.get(k)!)]),
    );
  }, 600_000);

  afterAll(() => run?.dispose());

  it("④ the mount mints the whole neighbourhood, once, at the true offsets", () => {
    expect(tileKeys).toHaveLength(20);
    const center = run.session.town!.stage.center;
    for (const key of tileKeys) {
      const { i, j } = neighborTileIndex(key)!;
      expect(run.session.areaRecords.get(key)!.area).toEqual(
        neighborTileRect(center, i, j),
      );
    }
    // The near stand still stands as REAL features — an area is loaded or
    // condensed, never both, and tile (0,0) is the ground it stands on.
    expect(run.session.wilderness!.features.length).toBeGreaterThan(0);
    expect(run.session.areaRecords.has("home")).toBe(false);
  });

  it("⑥ the WALK point is inside the manifold while the RANKING point is not", () => {
    const s = run.session;
    const m = s.embedding.spec.manifold as { width: number; height: number };
    const quotes = run.host.areaQuotes();
    // THE SHELF IS WHERE FEET GO. Put a cut unit on every tile's boundary
    // shelf; the build overlay then renders each as a `site_shelf_<key>` pile
    // AT THE WALK POINT — the same `wildShelfPointOf` the transfer endpoint's
    // `at` resolves to, read off the render payload rather than a private
    // function (text-mode law ①).
    for (const key of tileKeys) s.partnerStock[wildAreaId(key)] = { wood: 1 };
    try {
      run.advance(2);
      const overlay = run.view.probe().build;
      expect(overlay).not.toBeNull();
      for (const key of tileKeys) {
        const row = overlay!.sites.find((r) => r.id === `site_shelf_${key}`);
        expect(row).toBeDefined();
        const walk = { x: row!.x + 1, y: row!.y + 1 }; // the row is a 2 m mark
        // ⚖️ FEET WALK TO THE CLAMPED SHELF — inside the ground this session
        // can path on, with the scatter's own 8 m margin.
        expect(walk.x).toBeGreaterThanOrEqual(8);
        expect(walk.y).toBeGreaterThanOrEqual(8);
        expect(walk.x).toBeLessThanOrEqual(m.width - 8);
        expect(walk.y).toBeLessThanOrEqual(m.height - 8);
        // …while the RECORD keeps the true geometry (the quote a renderer
        // reads is the rect, unclamped).
        expect(quotes.find((q) => q.key === key)!.area).toEqual(s.areaRecords.get(key)!.area);
      }
      // 🚨 AND THE TWO REALLY DIFFER — a ring-2 rect lies wholly outside the
      // manifold, so a reader that used the walk point to RANK would put it at
      // the same distance as its ring-1 neighbour.
      const far = s.areaRecords.get(neighborTileKey(2, 0))!;
      expect(far.area.x).toBeGreaterThan(m.width);
      const farRow = overlay!.sites.find((r) => r.id === `site_shelf_${far.key}`)!;
      expect(wildRectPointToward(far, s.town!.stage.center).x).toBeGreaterThan(farRow.x + 1);
      // …and the walk points COMPRESS toward the manifold edge: ring 1 and
      // ring 2 stand a full tile apart in truth and less than that in the
      // walk, which is exactly why the ranking must not read this answer.
      const near = s.areaRecords.get(neighborTileKey(1, 0))!;
      const nearRow = overlay!.sites.find((r) => r.id === `site_shelf_${near.key}`)!;
      const trueGap =
        wildRectPointToward(far, s.town!.stage.center).x -
        wildRectPointToward(near, s.town!.stage.center).x;
      expect(trueGap).toBeCloseTo(NEIGHBOR_TILE_M, 6);
      expect(farRow.x - nearRow.x).toBeLessThan(trueGap);
    } finally {
      for (const key of tileKeys) delete s.partnerStock[wildAreaId(key)];
    }
  });

  it("⑦ a minted tile is NEVER unfolded — three guards, all of them", () => {
    const s = run.session;
    const key = tileKeys[0]!;
    const featuresBefore = s.wilderness!.features.length;
    const before = structuredClone(s.areaRecords.get(key)!);
    // ① the record is still there after the LOD driver has had many sweeps at
    //    it (the driver unfolds only what the DRIVER folded — a mint never
    //    enters `wildLodFolded`);
    run.advance(60);
    expect(s.areaRecords.has(key)).toBe(true);
    // ② the direct call — `/wild load <key>`'s own door — REFUSES, and changes
    //    nothing: this is the fence on the `rec.area` re-lay hole.
    expect(run.host.wildProbe(`load ${key}`)).toContain("refused to load");
    expect(s.areaRecords.get(key)).toEqual(before);
    // ③ …and no forest was dealt onto the local ground (the hole's symptom:
    //    a second stand on top of the session's own, doubling the audit).
    expect(s.wilderness!.features.length).toBe(featuresBefore);
    // …while the session's OWN ground still unfolds, so the fence is a fence
    // and not a padlock.
    expect(run.host.wildProbe("fold")).toContain("folded");
    expect(s.areaRecords.has("home")).toBe(true);
    expect(run.host.wildProbe("load")).toContain("loaded the stand back");
  });

  it("⑨ 🎁 THE ACCEPTANCE TEST — an impossible bill becomes feasible", () => {
    const s = run.session;
    // A director over the REAL booted session: `siteMaterialSources` and
    // `infeasibleBillHeads` are the two functions the whole refusal family
    // reads through, and this is the pair the round exists to move.
    const director = createConstructionDirector({
      familyOf: () => null,
      containerAnchor: () => s.town!.stage.center,
    } as unknown as ConstructionDirectorCtx);
    const spot = s.town!.stage.center;
    const woodIn = (srcs: ReturnType<typeof director.siteMaterialSources>): number =>
      srcs.reduce((n, src) => n + stackUnits(src.stack, "wood"), 0);

    // WITHOUT the neighbourhood: everything within reach is the near stand.
    const saved = new Map(tileKeys.map((k) => [k, s.areaRecords.get(k)!]));
    for (const k of tileKeys) s.areaRecords.delete(k);
    const near = woodIn(director.siteMaterialSources(s, spot));
    // …WITH it: the same enumerator, twenty more sources, no new arm.
    for (const [k, r] of saved) s.areaRecords.set(k, r);
    const withRegion = woodIn(director.siteMaterialSources(s, spot));
    expect(withRegion).toBeGreaterThan(near);

    // A bill the disc cannot meet and the countryside can — the exact shape of
    // the transcript line this round was opened on ("🪵 the site still needs
    // 400 wood — and there is none to fetch").
    const bill = { wood: near + 50 };
    for (const k of tileKeys) s.areaRecords.delete(k);
    const refused = director.infeasibleBillHeads(s, bill, director.siteMaterialSources(s, spot));
    expect(refused.wood).toBeDefined();
    expect(refused.wood!.have).toBe(near);
    for (const [k, r] of saved) s.areaRecords.set(k, r);
    const allowed = director.infeasibleBillHeads(s, bill, director.siteMaterialSources(s, spot));
    expect(allowed.wood).toBeUndefined();
    expect(allowed).toEqual({});

    // …and the tiles rank BEHIND the site's own stacks and AMONG THEMSELVES by
    // true distance: ring 1 before ring 2 in the same direction.
    const ranked = director.siteMaterialSources(s, spot).filter((src) =>
      isNeighborTileKey(src.id.slice("wild:area:".length)),
    );
    const dOf = (i: number, j: number): number =>
      ranked.find((src) => src.id === wildAreaId(neighborTileKey(i, j)))!.d;
    expect(dOf(1, 0)).toBeLessThan(dOf(2, 0));
    expect(dOf(0, 1)).toBeLessThan(dOf(0, 2));
  });

  it("⑧ ⚖️ FIELD RECORD ONLY — a tile bears food and still never reaches the books", () => {
    const s = run.session;
    // The law has TEETH here: the forest mix carries a food plant, so a books
    // sweep over every record would credit twenty tiles' worth of bananas to
    // the granary.
    const bearing = tileKeys
      .map((k) => localDailyUnitsForGood([s.areaRecords.get(k)!], "food"))
      .filter((n) => n > 0);
    expect(bearing.length).toBeGreaterThan(0);
    // …and the books' own seat reads ONE record, the town field's, so the
    // town's food supply is exactly what it was before the mint existed.
    const key = farmAreaKey(s.town!.plan.key);
    expect(isNeighborTileKey(key)).toBe(false);
    const fieldOnly = localDailyUnitsForGood(
      [...s.areaRecords.entries()].filter(([k]) => k === key).map(([, r]) => r),
      "food",
    );
    const everything = localDailyUnitsForGood(s.areaRecords.values(), "food");
    expect(everything).toBeGreaterThan(fieldOnly);
    // The barter lane is likewise unparked: no agreement was ever posted
    // against a wild source by the books.
    for (const a of s.transfers.active()) {
      if (a.from.startsWith("wild:area:")) expect(a.barter).toBeUndefined();
    }
  });

  it("⑩ a scheduled draw against a tile key ships real units and conserves", () => {
    const s = run.session;
    const key = tileKeys.find((k) => (wildAreaStock(s.areaRecords.get(k)!).wood ?? 0) > 0)!;
    const id = wildAreaId(key);
    const held = (): number =>
      (wildAreaStock(s.areaRecords.get(key)!).wood ?? 0) +
      stackUnits(s.partnerStock[id] ?? {}, "wood");
    const yardWood = (): number => stackUnits(s.town!.deltas.stock, "wood");
    const held0 = held();
    const yard0 = yardWood();
    s.transfers.post({
      from: id,
      to: TOWN_YARD_EP,
      goods: { wood: 3 },
      issuer: "player",
      mode: "scheduled",
      now: s.taskClock,
      every: FOOD_DAY_SEC,
      dueAt: s.taskClock,
      sourceGlyph: `draw wood from ${id}`,
    });
    const warp = run.warpDays(1);
    expect(warp.ok).toBe(true);
    // The yard gained, and the source's own books gave AT LEAST as much (a
    // kill draw fells a whole tree, so the remainder waits on the shelf).
    expect(yardWood()).toBeGreaterThan(yard0);
    expect(held0 - held()).toBeGreaterThanOrEqual(yardWood() - yard0);
    // Nothing was minted: the shelf holds exactly what the record lost, less
    // whatever has already shipped.
    expect(stackUnits(s.partnerStock[id] ?? {}, "wood")).toBeGreaterThanOrEqual(0);
  });

  it("the mint NEVER re-runs: a drawn tile stays drawn, an untouched one stays put", () => {
    // ⚖️ ITEM CONSERVATION, read from the mint's side. The mint derives a FRESH
    // stand from the seed, so a second run over a harvested tile would put the
    // felled trees back — a world fact overwriting session state. The installer
    // is idempotent by key, and a whole booted day (⑩'s warp, plus the frames
    // above) is what proves nothing quietly re-ran it.
    const s = run.session;
    expect([...s.areaRecords.keys()].filter(isNeighborTileKey)).toHaveLength(20);
    let drawn = 0;
    let untouched = 0;
    for (const key of tileKeys) {
      const now = s.areaRecords.get(key)!;
      const then = mintedByKey.get(key)!;
      const a = wildAreaStock(now).wood ?? 0;
      const b = wildAreaStock(then).wood ?? 0;
      if (a < b) drawn++;
      else if (a === b) untouched++;
      // 🚨 NOTHING GREW BACK ABOVE THE MINT. Timber is a KILL product: only a
      // class climb makes more of it, and a mature stand has no climb queue —
      // so a tile with MORE wood than it was minted with is a re-mint.
      expect(a).toBeLessThanOrEqual(b);
    }
    expect(drawn).toBe(1); // exactly the tile ⑩ ordered from
    expect(untouched).toBe(19);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE `areaQuotes()` CONSUMERS — a tile record must not paint crops
// ═══════════════════════════════════════════════════════════════════════════
//
// `areaQuotes()` is the host's plain-data READ of EVERY record (forests and
// farms alike, sorted by key), and the world-lab's live crop layer reads it at
// ~1 Hz. Twenty new keys arrive in that list this round, so the farm-only
// reader's filter stops being a formality. It is EXACT-KEY today — stronger
// than the `farm-` prefix the brief allowed for — and this pin is what keeps
// it that way, since the failure mode (carrot tufts sprouting over a forest
// four hundred metres out) is invisible to every engine test.

describe("the render consumers tolerate the new keys", () => {
  it("world-lab's crop layer matches ONE record by exact farm key", () => {
    const src = readFileSync(
      join(process.cwd(), "games", "world-lab", "src", "farm-crops.ts"),
      "utf8",
    );
    expect(src).toContain("const key = farmAreaKey(plan.key);");
    expect(src).toContain("quotes.find((q) => q.key === key)");
    // …and it is the ONLY `areaQuotes` consumer (a second one would need its
    // own filter and its own pin).
    const main = readFileSync(
      join(process.cwd(), "games", "world-lab", "src", "main.ts"),
      "utf8",
    );
    // Still exactly ONE read of the host — Stage 3 added a SECOND consumer,
    // not a second read: the quote is deep-copied plain data and both
    // renderers share the one copy off the one 1 Hz beat.
    expect(main.match(/areaQuotes\(\)/g) ?? []).toHaveLength(1);
    expect(main).toContain("const quotes = embedTown.host.areaQuotes();");
    expect(main).toContain("farmCrops?.update(quotes);");
    expect(main).toContain("floraDepletion?.update(quotes);");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑫ STAGE 3 — THE RENDER BRIDGE: the countryside THINS where it was logged
// ═══════════════════════════════════════════════════════════════════════════
//
// THE DEFECT THE STAGE CLOSES: Stages 1-2 let a site log a neighbouring stand
// flat and keep it durable, and not one tree left the rendered horizon — the
// same wood in the yard AND in the picture, which is the double count the
// record tier exists to prevent, moved from the books to the eye.
//
// 🚨 THE ONE-GRADIENT LAW IS THE POINT. `wildKeepChance` has declared since
// #41 that *"any scenery renderer that thins for depletion must thin by it
// too — a second gradient story must never exist"*, and had ZERO callers
// outside its own file. These pins are its first consumer's, and they are
// written so that a renderer which quietly grew its OWN falloff would fail
// them: every number below comes out of the shipped law, and the world-lab
// consumer is read as SOURCE and checked for the absence of a second one.
//
// WHAT IS PINNED, and why each is here rather than assumed:
//
//   ⓐ THE LAW — a fresh record thins NOTHING (the whole feature is invisible
//     until somebody harvests); a drawn record thins the DRAWN SECTOR FIRST
//     (the histogram is really doing the work, not a flat ratio); the mean
//     keep over the ground IS the standing share (the amount half is honest);
//     and it all works off the QUOTE, which is what a renderer actually holds.
//   ⓑ DETERMINISM + REGROW — same record ⇒ same survivors; a regrown record
//     returns EXACTLY the trees it lost, because the per-instance roll is a
//     hash of the instance's own key and never a random draw.
//   ⓒ QUANTIZATION — the rendered set is a pure function of the STAMP, the
//     step moves exactly on a bucket crossing, and a histogram that TURNS
//     repaints even at an unchanged bucket.
//   ⓓ THE CONSUMER — world-lab thins through the law, owns no gradient, and
//     joins the flora field's ONE per-instance mask at its one seat.
//
// GL is not verifiable headlessly; these pin the PURE MATH the GL reads.

/** A deterministic spread of scenery instances over a record's ground — a
 *  golden-ratio lattice, never `Math.random`, so a survivor set is a fact. */
const gridInstances = (
  area: { x: number; y: number; w: number; h: number },
  n: number,
): WildThinInstance[] => {
  const out: WildThinInstance[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      key: `inst:${i}`,
      x: area.x + ((i * 0.6180339887498949) % 1) * area.w,
      y: area.y + ((i * 0.7548776662466927) % 1) * area.h,
    });
  }
  return out;
};

/** The species-`sp` population a fresh record stands — what a field agreeing
 *  with the record's own density law would DRAW on that ground. */
const standPop = (rec: WildAreaRecord, sp: string): number =>
  (rec.stands.find((s) => s.species === sp)?.byClass ?? []).reduce((a, b) => a + b, 0);

describe("⑫ⓐ the one gradient, amount half", () => {
  it("a FRESH record thins NOTHING — the feature is invisible until somebody harvests", () => {
    for (const rec of mintAt()) {
      const n = standPop(rec, "oak");
      const f = wildThinField(rec, "oak", n);
      // The stand holds what N mature oaks hold (± the per-feature roll), so
      // the fraction reads full and the top bucket is reached.
      expect(f.step).toBe(WILD_THIN_STEPS);
      expect(f.quantized).toBe(1);
      const insts = gridInstances(rec.area, n);
      for (const i of insts) expect(f.keepAt(i.x, i.y)).toBe(1);
      expect([...wildThinHidden(f, insts)]).toEqual([]);
    }
  });

  it("a species the record does not stand is not this renderer's business", () => {
    const rec = mintAt()[0]!;
    expect(rec.stands.some((s) => s.species === "pine")).toBe(false);
    expect(wildThinFraction(rec, "pine", 40)).toBe(1);
    // …and neither is ground the renderer draws nothing on (the denominator
    // is the RENDERER's own count — no scenery, no question to answer).
    expect(wildThinFraction(rec, "oak", 0)).toBe(1);
    expect([...wildThinHidden(wildThinField(rec, "oak", 0), gridInstances(rec.area, 10))])
      .toEqual([]);
  });

  it("🚨 the DRAWN SECTOR thins first — the histogram, not a flat ratio", () => {
    // Tile (1, 0) sits due +x of the site, so a draw booked from the site's
    // own gate loads the −x sector: the near edge is the cut edge.
    const rec = mintAt().find((r) => r.key === neighborTileKey(1, 0))!;
    const drawn = drawWildArea(rec, {
      glyph: "wood", units: 300, from: CENTER, now: 100,
    }).rec;
    expect(drawn.draw[4]).toBeGreaterThan(0);          // −x, toward the town
    expect(drawn.draw.filter((n) => n > 0)).toHaveLength(1);
    const f = wildThinField(drawn, "oak", standPop(rec, "oak"));
    expect(f.quantized).toBeLessThan(1);               // it really is depleted
    const cx = drawn.area.x + drawn.area.w / 2;
    const cy = drawn.area.y + drawn.area.h / 2;
    const near = f.keepAt(drawn.area.x + 4, cy);       // the cut side
    const far = f.keepAt(drawn.area.x + drawn.area.w - 4, cy); // the far side
    expect(near).toBeLessThan(far);
    // …and the gradient is the SHIPPED one, not a look-alike: the ratio of
    // the two keeps is the ratio the density law itself answers.
    const shapeNear = wildKeepChance(drawn, drawn.area.x + 4, cy);
    const shapeFar = wildKeepChance(drawn, drawn.area.x + drawn.area.w - 4, cy);
    expect(near / far).toBeCloseTo(shapeNear / shapeFar, 6);
    expect(cx).toBeCloseTo(CENTER.x + NEIGHBOR_TILE_M, 6);
  });

  it("the MEAN keep over the record's ground IS the standing share", () => {
    const rec = mintAt().find((r) => r.key === neighborTileKey(1, 0))!;
    const drawn = drawWildArea(rec, {
      glyph: "wood", units: 400, from: CENTER, now: 100,
    }).rec;
    const f = wildThinField(drawn, "oak", standPop(rec, "oak"));
    // A fine independent sweep (the law's own normalizer is 8×8 midpoints —
    // this one is 41×41, so agreement is a fact about the law, not about
    // re-running the same quadrature).
    let sum = 0;
    let n = 0;
    for (let i = 0; i <= 40; i++) {
      for (let j = 0; j <= 40; j++) {
        sum += f.keepAt(drawn.area.x + (i / 40) * drawn.area.w, drawn.area.y + (j / 40) * drawn.area.h);
        n++;
      }
    }
    expect(Math.abs(sum / n - f.quantized)).toBeLessThan(0.04);
    // …and the normalizer really is the shape's own mean (1 for a record
    // nobody has drawn on, so an untouched stand normalizes by nothing).
    expect(wildKeepMean(rec)).toBe(1);
    expect(wildKeepMean(drawn)).toBeLessThan(1);
  });

  it("reads the RENDER QUOTE — the shape a remote client actually holds", () => {
    const rec = mintAt()[0]!;
    const drawn = drawWildArea(rec, { glyph: "wood", units: 250, from: CENTER, now: 50 }).rec;
    const n = standPop(rec, "oak");
    const insts = gridInstances(drawn.area, n);
    const viaRecord = wildThinField(drawn, "oak", n);
    const viaQuote = wildThinField(wildAreaQuote(drawn), "oak", n);
    expect(viaQuote.stamp).toBe(viaRecord.stamp);
    expect([...wildThinHidden(viaQuote, insts)]).toEqual([...wildThinHidden(viaRecord, insts)]);
    // The quote survives the wire (it is the multiplayer rider's shape).
    const wired = JSON.parse(JSON.stringify(wildAreaQuote(drawn)));
    expect(wildThinField(wired, "oak", n).stamp).toBe(viaRecord.stamp);
  });

  it("one untouched mature source's worth is the catalogue's own midpoint", () => {
    // 12–20 timber, mature yieldMul 1 (products.ts oak) — the same number
    // `advanceWildArea` re-derives a stand's stock from.
    expect(wildSourceFullStock("oak")).toBe(16);
    expect(wildSourceFullStock("no_such_species")).toBe(0);
  });
});

describe("⑫ⓑ determinism, and the regrow arm", () => {
  it("same record ⇒ same survivors, and the roll is a HASH not a draw", () => {
    const rec = mintAt()[0]!;
    const drawn = drawWildArea(rec, { glyph: "wood", units: 300, from: CENTER, now: 10 }).rec;
    const n = standPop(rec, "oak");
    const insts = gridInstances(drawn.area, n);
    const a = [...wildThinHidden(wildThinField(drawn, "oak", n), insts)].sort();
    const b = [...wildThinHidden(wildThinField(drawn, "oak", n), insts)].sort();
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0); // there is a survivor set to be stable
    // The roll itself is a pure function of the instance's own identity.
    expect(wildThinRoll("inst:7")).toBe(wildThinRoll("inst:7"));
    expect(wildThinRoll("inst:7")).not.toBe(wildThinRoll("inst:8"));
    expect(wildThinRoll("inst:7")).toBeGreaterThanOrEqual(0);
    expect(wildThinRoll("inst:7")).toBeLessThan(1);
  });

  it("a deeper draw thins a SUPERSET — the wood empties, it never re-rolls", () => {
    // Successive fell draws with no `from`: no direction is booked, so the
    // SHAPE is untouched and the whole movement is the AMOUNT. That is what
    // makes nesting a fact about the roll rather than a coincidence.
    const rec = mintAt()[0]!;
    const n = standPop(rec, "oak");
    const insts = gridInstances(rec.area, n);
    const light = drawWildArea(rec, { glyph: "wood", units: 300, now: 0 }).rec;
    const heavy = drawWildArea(light, { glyph: "wood", units: 300, now: 0 }).rec;
    const fLight = wildThinField(light, "oak", n);
    const fHeavy = wildThinField(heavy, "oak", n);
    expect(fHeavy.step).toBeLessThan(fLight.step);
    const hLight = wildThinHidden(fLight, insts);
    const hHeavy = wildThinHidden(fHeavy, insts);
    expect(hLight.size).toBeGreaterThan(0);
    expect(hHeavy.size).toBeGreaterThan(hLight.size);
    for (const k of hLight) expect(hHeavy.has(k)).toBe(true); // strictly nested
  });

  it("a REGROWN record puts back exactly the plants it lost", () => {
    // ⚖️ Told on a FARM record, deliberately. A forest record has no reseed
    // arm — `drawWildArea` fells and nothing plants — so the only shipped
    // record whose stock genuinely comes BACK is the cultivated one, and its
    // refill is the very `ripenWildArea` field pulse this stage must answer
    // to. Same law, same call, same quote shape.
    const per = wildSourceFullStock("carrot_plant");
    const plants = 40;
    const rec = farmAreaRecord({
      key: farmAreaKey("t"), area: { x: 0, y: 0, w: 200, h: 200 }, seed: 7,
      species: "carrot_plant", capUnits: { carrot: per * plants }, now: 0,
    });
    const insts = gridInstances(rec.area, plants);
    const full = wildThinField(rec, "carrot_plant", plants);
    expect(full.step).toBe(WILD_THIN_STEPS);          // a full field thins nothing
    expect([...wildThinHidden(full, insts)]).toEqual([]);
    const picked = drawWildArea(rec, {
      glyph: "carrot", units: Math.round(per * plants * 0.7), now: 0,
    }).rec;
    const thin = wildThinField(picked, "carrot_plant", plants);
    expect(thin.fraction).toBeCloseTo(0.3, 6);        // exact — no roll noise here
    const hThin = wildThinHidden(thin, insts);
    expect(hThin.size).toBeGreaterThan(0);
    // THE FIELD PULSE: HEAL arms the clock, the next pulse refills to cap —
    // and every hidden plant returns, because the keep rose past each one's
    // own fixed roll rather than a fresh draw landing somewhere else.
    const armed = ripenWildArea(picked, 0, () => FOOD_DAY_SEC);
    const refilled = ripenWildArea(armed, FOOD_DAY_SEC * 2, () => FOOD_DAY_SEC);
    const back = wildThinField(refilled, "carrot_plant", plants);
    expect(back.step).toBeGreaterThan(thin.step);
    expect(back.step).toBe(WILD_THIN_STEPS);
    expect([...wildThinHidden(back, insts)]).toEqual([]);
    // …and a HALF-refilled state hides a strict SUBSET of the drawn-down one
    // (the return is ordered by the same rolls, in reverse).
    const half = wildThinField(
      drawWildArea(rec, { glyph: "carrot", units: Math.round(per * plants * 0.35), now: 0 }).rec,
      "carrot_plant", plants,
    );
    const hHalf = wildThinHidden(half, insts);
    expect(hHalf.size).toBeLessThan(hThin.size);
    for (const k of hHalf) expect(hThin.has(k)).toBe(true);
  });
});

describe("⑫ⓒ quantization — the rebuild trigger", () => {
  const rec = () => mintAt().find((r) => r.key === neighborTileKey(1, 0))!;

  it("the rendered set is a PURE FUNCTION OF THE STAMP", () => {
    const base = rec();
    const n = standPop(base, "oak");
    const insts = gridInstances(base.area, n);
    // Two records in the same bucket: a scenery count either side of a
    // fraction that does not cross a step boundary.
    const drawn = drawWildArea(base, { glyph: "wood", units: 400, from: CENTER, now: 5 }).rec;
    const f0 = wildThinField(drawn, "oak", n);
    // Nudge the record's CLOCK — a change no keep reads.
    const ticked = { ...drawn, at: drawn.at + 999 };
    const f1 = wildThinField(ticked, "oak", n);
    expect(f1.stamp).toBe(f0.stamp);
    expect([...wildThinHidden(f1, insts)]).toEqual([...wildThinHidden(f0, insts)]);
  });

  it("the step moves EXACTLY on a bucket crossing", () => {
    const base = rec();
    const per = wildSourceFullStock("oak");
    // 🚨 THE OAK STAND'S OWN WOOD, never the record's `wood` TOTAL (2026-09-04).
    // Those were the same number for as long as the oak was the only
    // wood-bearing thing a forest mix stood; the wild larder puts crab apples in
    // the wood, and an apple tree bears timber too. `wildThinFraction` has
    // always measured PER SPECIES (`wildStandStockOf`) — it was this line that
    // was measuring per GLYPH, so the count it derived stopped being the count
    // that produces the fraction it names. The engine was right; the fixture
    // was reading a total.
    const stock = wildStandStockOf(base, "oak");
    // fraction = stock / (per × count) — so the count picks the fraction.
    const countFor = (frac: number): number => stock / (per * frac);
    for (let k = 1; k < WILD_THIN_STEPS; k++) {
      const cross = (k + 0.5) / WILD_THIN_STEPS;         // round() flips here
      const justUnder = wildThinField(base, "oak", countFor(cross - 1e-6));
      const justOver = wildThinField(base, "oak", countFor(cross + 1e-6));
      expect(justUnder.step).toBe(k);
      expect(justOver.step).toBe(k + 1);
      expect(justUnder.stamp).not.toBe(justOver.stamp);
      // …and NOTHING moves for a change strictly inside a bucket: a millionth
      // of a unit either side of the crossing repaints, a whole 2% inside it
      // does not. That is the property that keeps a slowly-drained stand off
      // the rebuild path.
      const inside = wildThinField(base, "oak", countFor(cross - 0.02));
      expect(inside.stamp).toBe(justUnder.stamp);
      expect(inside.quantized).toBe(justUnder.quantized);
    }
  });

  it("a histogram that TURNS repaints, even at an unchanged bucket", () => {
    const base = rec();
    const n = standPop(base, "oak");
    const centre = { x: base.area.x + base.area.w / 2, y: base.area.y + base.area.h / 2 };
    // The same units taken, from opposite sides: identical amount, opposite
    // shape. A stamp that carried only the bucket would call these equal and
    // the field would keep drawing the wrong side thin.
    const west = drawWildArea(base, {
      glyph: "wood", units: 300, from: { x: centre.x - 500, y: centre.y }, now: 5,
    }).rec;
    const east = drawWildArea(base, {
      glyph: "wood", units: 300, from: { x: centre.x + 500, y: centre.y }, now: 5,
    }).rec;
    const fW = wildThinField(west, "oak", n);
    const fE = wildThinField(east, "oak", n);
    expect(fW.step).toBe(fE.step);           // same amount…
    expect(fW.stamp).not.toBe(fE.stamp);     // …different picture
    const insts = gridInstances(base.area, n);
    expect([...wildThinHidden(fW, insts)]).not.toEqual([...wildThinHidden(fE, insts)]);
  });
});

describe("⑫ⓓ the world-lab consumer", () => {
  const read = (...p: string[]): string =>
    readFileSync(join(process.cwd(), "games", "world-lab", "src", ...p), "utf8");

  it("thins through the ONE law and owns no gradient of its own", () => {
    const src = read("flora-depletion.ts");
    expect(src).toContain("wildThinField");
    expect(src).toContain("wildThinHidden");
    // 🚨 THE ANTI-FORK PIN. A renderer that grew its own falloff would need
    // trigonometry, a distance or a random draw; none of the three may appear.
    expect(src).not.toMatch(/Math\.(atan2|hypot|sqrt|cos|sin|random)/);
    // …and it never writes to the sim.
    expect(src).not.toMatch(/\.host\.|drawWildArea|addWildFeature/);
  });

  it("joins the flora field's ONE per-instance mask, at both of its seats", () => {
    const main = read("main.ts");
    // syncFloraTwins has two branches — no session, and a live one — and the
    // depletion has to reach the field down BOTH (the homestead premise never
    // stands a wilderness session at all, so the first branch IS the shipped
    // frontier path).
    expect(main.match(/for \(const k of depletedHidden\(\)\) hidden\.add\(k\);/g) ?? [])
      .toHaveLength(2);
    expect(main).toContain("createFloraDepletion({");
    expect(main).toContain("floraDepletion?.reset();"); // dies with the mount
  });

  it("maps frames through the ONE town-anchor transform", () => {
    const main = read("main.ts");
    expect(main).toContain("function townSessionToWorld(");
    expect(main).toContain("function townWorldToSession(");
    // The near-stand disc and the depletion sweep read the SAME transform —
    // a second one written out at a call site is how the border and the
    // thinning would come to disagree about where a forest is.
    expect(main).toContain("townSessionToWorld(ns.at.x, ns.at.y, _nsWorld)");
    expect(main).toContain("const p = townWorldToSession(t.world);");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 🔒 THE BENCH-SAFETY PIN — the shipped worlds, booted
// ═══════════════════════════════════════════════════════════════════════════

describe("🔒 a COUNT-mix session has no tile keys at all", () => {
  it("the shipped frontier boot is untouched by this round", () => {
    const run = bootTextQuest({ world: doc, seed: SEED, dt: 1 / 10 });
    try {
      run.advance(20);
      expect([...run.session.areaRecords.keys()].filter(isNeighborTileKey)).toEqual([]);
      // …and the FARM record still turns up, so the absence above is the mint
      // declining rather than the record map being empty.
      expect([...run.session.areaRecords.keys()].some((k) => k.startsWith("farm-"))).toBe(true);
    } finally {
      run.dispose();
    }
  }, 600_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑪ PERSISTENCE — A DEPLETED NEIGHBOURING STAND SURVIVES SAVE/LOAD (Stage 2)
// ═══════════════════════════════════════════════════════════════════════════
//
// Stage 1 minted a record tier for never-loaded ground and said so in its own
// header: *"a re-mint restores the FRESH stand, not the drawn-down one"*. This
// section is the half that makes the tier real. Three laws, in the order they
// have to hold:
//
//   ⓐ THE SHAPE — `SerializedTownDeltas.areaRecords`, beside the boundary
//     shelf it must never be separated from, emitted only when non-empty so
//     every save written before the field existed round-trips byte-identically.
//   ⓑ THE CLOCK — a durable record is AT REST (every deadline relative), and
//     the rest INTERVAL is spent by waking at `now − restS`. No free regrowth
//     across a reload; no frozen clocks either.
//   ⓒ THE INTERPLAY — restore runs BEFORE the mint, so a drawn-down tile stays
//     drawn down and a missing key is still filled. Mint fills gaps, never
//     overwrites.

describe("⑪ⓐ the serialized shape", () => {
  /** Every key a virgin overlay writes — the BYTE-HOLD pin. A save written by
   *  the build before this round must round-trip through the build after it
   *  with not one field added, so this list is deliberately spelled out rather
   *  than derived: adding a key here is a save-format change and has to be a
   *  deliberate edit somebody reviews. */
  const BASE_KEYS = [
    "buildings", "civicProsperity", "cohorts", "craftJobs", "craftQueue",
    "driftBank", "laws", "ordSeq", "orders", "partnerStock", "reservations",
    "seeds", "services", "shellFurnPiles", "stock", "transfers", "version",
    "zones",
  ].sort();

  it("is UNCHANGED until a record exists — an old save round-trips byte-identically", () => {
    const virgin = createTownDeltas().toJSON();
    expect(Object.keys(virgin).sort()).toEqual(BASE_KEYS);
    expect("areaRecords" in virgin).toBe(false);
    // …and the round trip is byte-for-byte, not merely equal: a reader that
    // materialized an empty `areaRecords: {}` would fail exactly here.
    expect(JSON.stringify(createTownDeltas(virgin).toJSON())).toBe(JSON.stringify(virgin));
  });

  it("gains EXACTLY one key when a record is held, and round-trips deep-copied", () => {
    const deltas = createTownDeltas();
    const rec = mintAt()[0]!;
    deltas.areaRecords.rows.set(rec.key, rec);
    deltas.areaRecords.at = 900;
    const json = deltas.toJSON();
    expect(Object.keys(json).sort()).toEqual([...BASE_KEYS, "areaRecords"].sort());
    // 🚨 THE ANCHOR RIDES WITH THE ROWS, in one field — a reader physically
    // cannot take the deadlines without the clock they are absolute in.
    expect(Object.keys(json.areaRecords!).sort()).toEqual(["at", "records"]);
    expect(json.areaRecords!.at).toBe(900);
    expect(json.areaRecords!.records[rec.key]).toEqual(rec);
    // Deep copies BOTH directions — the store owns its rows and the payload
    // must never alias the live record (`partnerStock`'s own discipline).
    expect(json.areaRecords!.records[rec.key]).not.toBe(deltas.areaRecords.rows.get(rec.key));
    const back = createTownDeltas(json);
    expect(back.areaRecords.at).toBe(900);
    expect(back.areaRecords.rows.get(rec.key)).toEqual(rec);
    expect(back.areaRecords.rows.get(rec.key)).not.toBe(json.areaRecords!.records[rec.key]);
    // …and the second trip is byte-stable (the autosave writes the same bytes
    // forever if nothing played).
    expect(JSON.stringify(back.toJSON())).toBe(JSON.stringify(json));
  });

  it("carries ALL KINDS with no per-key casing — home, farm and tile alike", () => {
    // The index is scope-agnostic by ruling ⑦ of the persistence round; a save
    // path that knew the word "tile" would be the shape defect that ruling
    // exists to forbid. Three unrelated key families, one table.
    const deltas = createTownDeltas();
    const tile = mintAt()[0]!;
    for (const key of ["home", farmAreaKey("t1"), tile.key]) {
      deltas.areaRecords.rows.set(key, { ...tile, key });
    }
    const json = createTownDeltas(deltas.toJSON()).toJSON();
    expect(Object.keys(json.areaRecords!.records).sort()).toEqual(
      ["farm-t1", "home", tile.key].sort(),
    );
  });
});

describe("⑪ⓑ the clock at rest", () => {
  /** A tile with a LIVE REGROW QUEUE: pick its bananas clean and let one ripen
   *  pulse arm the refill (⑤'s own shape). A fresh mint has no clocks at all,
   *  so a persistence pin taken on one would pass vacuously. */
  const armedTile = (): WildAreaRecord => {
    const rec = mintAt().find((r) => r.stands.some((s) => (s.cap.banana ?? 0) > 0))!;
    const cap = rec.stands.find((s) => (s.cap.banana ?? 0) > 0)!.cap.banana!;
    const picked = drawWildArea(rec, { glyph: "banana", units: cap, now: 0 }).rec;
    return ripenWildArea(picked, 0, () => FOOD_DAY_SEC);
  };
  /** Every clock the record holds, flattened — the thing the shift must move
   *  and the ONLY thing it may move. */
  const clocksOf = (r: WildAreaRecord): number[] => [
    r.at,
    ...r.stands.flatMap((s) => [
      ...s.climbAt.map((c) => c.at),
      ...Object.values(s.regrowAt).flat(),
    ]),
  ];

  it("has a queue to lose in the first place", () => {
    const armed = armedTile();
    expect(clocksOf(armed).length).toBeGreaterThan(1);
    expect(armed.stands.some((s) => (s.regrowAt.banana?.length ?? 0) > 0)).toBe(true);
  });

  it("rest ∘ wake ≡ id, byte for byte, and a ZERO shift returns the SAME object", () => {
    const armed = armedTile();
    const rested = restWildRecord(armed, 1234.5);
    expect(wakeWildRecord(rested, 1234.5)).toEqual(armed);
    // The zero case is the one the byte-hold rests on: a session is born at
    // clock 0, so waking a save with no rest interval must not even allocate.
    expect(wakeWildRecord(rested, 0)).toBe(rested);
    expect(shiftWildAreaClock(armed, 0)).toBe(armed);
  });

  it("moves EVERY clock by the rest interval and NOTHING else", () => {
    const armed = armedTile();
    const saveClock = 900;
    const rested = restWildRecord(armed, saveClock);
    const REST_S = 4321;
    // A session is born at 0; the absence gap is spent by waking at −restS.
    const woke = wakeWildRecord(rested, 0 - REST_S);
    const before = clocksOf(armed);
    const after = clocksOf(woke);
    expect(after).toHaveLength(before.length);
    after.forEach((t, i) => expect(t).toBeCloseTo(before[i]! - saveClock - REST_S, 6));
    // 🚨 CONSERVATION IS UNTOUCHED BY TIME TRAVEL — stocks, caps, class counts
    // and the depletion gradient are exactly what they were.
    expect(wildAreaStock(woke)).toEqual(wildAreaStock(armed));
    expect(woke.stands.map((s) => [s.species, s.byClass, s.cap])).toEqual(
      armed.stands.map((s) => [s.species, s.byClass, s.cap]),
    );
    expect(woke.draw).toEqual(armed.draw);
    expect(woke.area).toEqual(armed.area);
  });

  it("wakes a whole INDEX through the codec's read arm — a bad row is a MISS", () => {
    const armed = armedTile();
    const rested = new Map<string, WildAreaRecord>([
      ["good", restWildRecord(armed, 100)],
      ["bad", { ...armed, stands: "not a stand list" } as unknown as WildAreaRecord],
    ]);
    const woke = wakeAreaRecords(rested, 0);
    expect([...woke.keys()]).toEqual(["good"]);
    expect(woke.get("good")).toEqual(rested.get("good"));
    // A read is a deep COPY, never an alias (the read arm's law).
    expect(woke.get("good")).not.toBe(rested.get("good"));
    expect(wakeAreaRecords(null, 0).size).toBe(0);
  });

  it("the SITE door spends the interval once — and 0 is byte-identical", () => {
    const site = foundSite({ seed: 7, at: { x: 20, y: 20 } });
    const armed = armedTile();
    site.deltas.areaRecords.rows.set(armed.key, armed);
    site.deltas.areaRecords.at = 500;
    const json = foundedSiteToJSON(site);
    const REST_S = 60 * 60 * 24 * 7; // a week with the tab closed
    const still = createFoundedSite(json);
    const aged = createFoundedSite(json, { restS: REST_S });
    expect(JSON.stringify(foundedSiteToJSON(still))).toBe(JSON.stringify(json));
    // The RECORDS never move — the whole table ages by its one anchor…
    expect(aged.deltas.areaRecords.rows.get(armed.key)).toEqual(armed);
    expect(aged.deltas.areaRecords.at).toBe(500 + REST_S);
    // …and read at a fresh session's clock 0 that is exactly `REST_S` closer
    // to due on every deadline the record holds.
    const a = clocksOf(wakeAreaRecords(still.deltas.areaRecords.rows, -still.deltas.areaRecords.at).get(armed.key)!);
    const b = clocksOf(wakeAreaRecords(aged.deltas.areaRecords.rows, -aged.deltas.areaRecords.at).get(armed.key)!);
    b.forEach((t, i) => expect(t).toBeCloseTo(a[i]! - REST_S, 6));
    // …and the site's town carries the pair onward UNSHIFTED — the gap is
    // spent at the disk door and nowhere else, so it cannot be applied twice.
    const config = siteTownConfig(aged);
    expect(config.deltas!.areaRecords!.at).toBe(500 + REST_S);
    expect(config.deltas!.areaRecords!.records[armed.key]).toEqual(armed);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑪ⓒ THE ACCEPTANCE TEST — booted, drawn down, saved, booted again
// ═══════════════════════════════════════════════════════════════════════════

describe("⑪ⓒ a drawn-down tile stays drawn down across the door", () => {
  let runA: TextQuestRun;
  let runB: TextQuestRun;
  /** The tile run A actually drew from. */
  let drawnKey: string;
  let tileKeys: string[];
  /** What the mint dealt at boot — the CONTROL a restore must not revert to. */
  let fresh: Map<string, WildAreaRecord>;
  /** The save. */
  let saved: SerializedTownDeltas;
  /** Wood in the record + on the shelf, per tile, at the moment of the save. */
  let heldAtSave: Map<string, number>;
  let shelfAtSave: Record<string, number>;
  /** Every record run B woke up holding, before it played a single frame. */
  let wokeAtBoot: Map<string, WildAreaRecord>;
  /** ...and the same two readings taken the instant run B woke up. */
  let heldAtWake: Map<string, number>;
  let shelfAtWake: Record<string, number>;
  /** Run A's session clock at the save - the anchor the store must carry. */
  let savedClock: number;

  const woodIn = (r: WildAreaRecord | undefined): number =>
    r ? wildAreaStock(r).wood ?? 0 : 0;

  beforeAll(() => {
    runA = bootTextQuest({ world: doc, seed: SEED, dt: 1 / 10, wildMix: countryMix(SEED) });
    const s = runA.session;
    tileKeys = [...s.areaRecords.keys()].filter(isNeighborTileKey).sort();
    fresh = new Map(tileKeys.map((k) => [k, structuredClone(s.areaRecords.get(k)!)]));
    runA.advance(20);
    // DRAW IT DOWN through the real lane — a scheduled leg against the tile's
    // own endpoint, serviced by `drawSourceShelf` out of the record (⑩'s shape).
    drawnKey = tileKeys.find((k) => woodIn(s.areaRecords.get(k)) > 0)!;
    const id = wildAreaId(drawnKey);
    s.transfers.post({
      from: id,
      to: TOWN_YARD_EP,
      goods: { wood: 3 },
      issuer: "player",
      mode: "scheduled",
      now: s.taskClock,
      every: FOOD_DAY_SEC,
      dueAt: s.taskClock,
      sourceGlyph: `draw wood from ${id}`,
    });
    expect(runA.warpDays(1).ok).toBe(true);
    heldAtSave = new Map(
      tileKeys.map((k) => [
        k,
        woodIn(s.areaRecords.get(k)) + stackUnits(s.partnerStock[wildAreaId(k)] ?? {}, "wood"),
      ]),
    );
    shelfAtSave = { ...(s.partnerStock[id] ?? {}) };
    savedClock = s.taskClock;
    // THE SAVE — the very object a mid-play autosave writes (`toJSON()` on the
    // deltas that ride `foundedSiteToJSON` / `siteTownConfig`).
    saved = s.town!.deltas.toJSON();
    // …and the RELOAD: the same document, the same seed, the same countryside,
    // plus the save.
    runB = bootTextQuest({
      world: doc, seed: SEED, dt: 1 / 10, wildMix: countryMix(SEED), deltas: saved,
    });
    // READ THE RELOAD BEFORE IT PLAYS. The deltas carry the STANDING TRADE
    // ROUTE too (that is the point of the store), so run B's own first sweeps
    // ship wood off the shelf exactly as run A's did — the reload is where
    // conservation is measured, not twenty frames into the next session.
    wokeAtBoot = new Map(
      [...runB.session.areaRecords].map(([k, r]) => [k, structuredClone(r)]),
    );
    shelfAtWake = { ...(runB.session.partnerStock[wildAreaId(drawnKey)] ?? {}) };
    heldAtWake = new Map(
      tileKeys.map((k) => [
        k,
        woodIn(runB.session.areaRecords.get(k))
          + stackUnits(runB.session.partnerStock[wildAreaId(k)] ?? {}, "wood"),
      ]),
    );
    runB.advance(20);
  }, 600_000);

  afterAll(() => {
    runA?.dispose();
    runB?.dispose();
  });

  it("the save actually carries the records — every kind, at rest", () => {
    // The MIRROR: the durable store holds exactly what the session holds,
    // shifted to the at-rest form by the session's own clock.
    const store = runA.session.town!.deltas.areaRecords;
    expect([...store.rows.keys()].sort()).toEqual([...runA.session.areaRecords.keys()].sort());
    for (const [key, live] of runA.session.areaRecords) {
      expect(store.rows.get(key)).toBe(live); // records are values - no copy, no drift
    }
    // 🚨 …AND THE ANCHOR IS THE SESSION'S OWN CLOCK, not the clock of the last
    // record that happened to change. This is the pin that catches the frozen
    // queue: a store anchored at WRITE time would still sit at the mint clock
    // here, and every armed regrow deadline would restore with the whole
    // period still to wait.
    expect(store.at).toBe(savedClock);
    expect(saved.areaRecords!.at).toBe(savedClock);
    expect(savedClock).toBeGreaterThan(0);
    // …and the serialized form names all twenty tiles AND the town's own field
    // (the no-per-key-casing law, read off a real session).
    expect(Object.keys(saved.areaRecords!.records).filter(isNeighborTileKey).sort())
      .toEqual(tileKeys);
    expect(Object.keys(saved.areaRecords!.records))
      .toContain(farmAreaKey(runA.session.town!.plan.key));
  });

  it("🎁 THE ACCEPTANCE TEST — the drawn tile is still drawn after the reload", () => {
    const before = woodIn(runA.session.areaRecords.get(drawnKey));
    const after = woodIn(runB.session.areaRecords.get(drawnKey));
    // The pin is not vacuous: the mint really would have put the trees back.
    expect(before).toBeLessThan(woodIn(fresh.get(drawnKey)));
    expect(after).toBe(before);
    expect(after).toBeLessThan(woodIn(fresh.get(drawnKey)));
    // …and the nineteen tiles nobody touched came back exactly as they were.
    for (const key of tileKeys) {
      if (key === drawnKey) continue;
      expect(woodIn(runB.session.areaRecords.get(key))).toBe(
        woodIn(runA.session.areaRecords.get(key)),
      );
    }
  });

  it("the mint FILLS GAPS and never overwrites — a save missing keys is completed", () => {
    // A world whose neighbourhood now reaches further than the save's did (or
    // a save hand-trimmed, or written by a build with a smaller reach): the
    // restore keeps what it has and the mint deals ONLY what is missing.
    const trimmed: SerializedTownDeltas = {
      ...saved,
      areaRecords: {
        at: saved.areaRecords!.at,
        records: Object.fromEntries(
          Object.entries(saved.areaRecords!.records).filter(
            ([k]) => k === drawnKey || !isNeighborTileKey(k),
          ),
        ),
      },
    };
    const run = bootTextQuest({
      world: doc, seed: SEED, dt: 1 / 10, wildMix: countryMix(SEED), deltas: trimmed,
    });
    try {
      run.advance(2);
      const keys = [...run.session.areaRecords.keys()].filter(isNeighborTileKey).sort();
      expect(keys).toEqual(tileKeys); // the whole neighbourhood is back
      // The one that survived the trim is still drawn down…
      expect(woodIn(run.session.areaRecords.get(drawnKey))).toBe(
        woodIn(runA.session.areaRecords.get(drawnKey)),
      );
      // …and the ones that did not are FRESH, which is the mint doing its job
      // rather than the restore silently succeeding.
      for (const key of tileKeys) {
        if (key === drawnKey) continue;
        expect(woodIn(run.session.areaRecords.get(key))).toBe(woodIn(fresh.get(key)));
      }
    } finally {
      run.dispose();
    }
  }, 600_000);

  it("CONSERVATION HOLDS ACROSS THE DOOR — shelf and record agree, both sides", () => {
    const s = runB.session;
    const id = wildAreaId(drawnKey);
    // The boundary shelf rode the SAME envelope the stand did — the whole
    // reason the field lives beside `partnerStock` rather than anywhere else.
    expect(shelfAtWake).toEqual(shelfAtSave);
    expect(stackUnits(shelfAtSave, "wood")).toBeGreaterThan(0); // not vacuous
    // Record + shelf, per tile, is what it was at the save. Nothing was minted
    // by the reload and nothing evaporated in it.
    for (const key of tileKeys) {
      expect(heldAtWake.get(key)).toBe(heldAtSave.get(key));
      // …and the running total never exceeds what the mint dealt: a draw
      // before the save plus a draw after it still sum to ≤ the standing wood.
      expect(heldAtWake.get(key)!).toBeLessThanOrEqual(woodIn(fresh.get(key)));
    }
    // DRAW AGAIN on the far side of the door: the second draw comes out of the
    // SAME depleted record, not a replenished one.
    s.transfers.post({
      from: id,
      to: TOWN_YARD_EP,
      goods: { wood: 3 },
      issuer: "player",
      mode: "scheduled",
      now: s.taskClock,
      every: FOOD_DAY_SEC,
      dueAt: s.taskClock,
      sourceGlyph: `draw wood from ${id}`,
    });
    expect(runB.warpDays(1).ok).toBe(true);
    const heldAfter = woodIn(s.areaRecords.get(drawnKey))
      + stackUnits(s.partnerStock[id] ?? {}, "wood");
    expect(heldAfter).toBeLessThanOrEqual(heldAtSave.get(drawnKey)!);
    expect(heldAfter).toBeLessThanOrEqual(woodIn(fresh.get(drawnKey)));
  }, 600_000);

  it("no clock is frozen and no regrowth is free — the queue is EXACTLY rest-shifted", () => {
    // 🚨 THE CLOCK PIN, taken at the instant of the wake (before run B played
    // a frame — a fired-and-re-armed deadline is a legitimate cycle, not a
    // frozen one, and reading later could not tell the two apart).
    //
    // The save holds deadlines ABSOLUTE in run A's dead clock plus the anchor
    // they are absolute in; run B is born at clock 0. So every deadline must
    // land at exactly `deadline − at` — the honest REMAINING time. Too small
    // and the reload handed out free regrowth; too large (the failure this
    // round exists to kill) and the queue is frozen by however long run A
    // played after the deadline was armed.
    const anchor = saved.areaRecords!.at;
    let queues = 0;
    for (const [key, absolute] of Object.entries(saved.areaRecords!.records)) {
      const woke = wokeAtBoot.get(key);
      if (!woke) continue; // the session's own ground retires (pinned below)
      expect(woke).toEqual(wakeWildRecord(absolute, -anchor));
      queues += woke.stands.reduce(
        (n, st) => n + Object.values(st.regrowAt).reduce((m, l) => m + l.length, 0)
          + st.climbAt.length,
        0,
      );
    }
    // …and the pin is NOT VACUOUS: something in this save really did carry a
    // pending deadline (the town's own field, drawn down by a day's haul).
    expect(queues).toBeGreaterThan(0);
    // …nor is the anchor a rounding error — run A played a real span, so a
    // store that had frozen at the mint clock would be a whole day out.
    expect(anchor).toBeGreaterThan(FOOD_DAY_SEC / 2);
  });

  it("the SESSION'S OWN GROUND folds durably and RETIRES when it stands again", () => {
    // A save can easily catch the home scatter FOLDED (the LOD sweep folds it
    // whenever nobody is looking), so the record is durable exactly like every
    // other kind — the index has no per-key casing anywhere.
    const s = runB.session;
    const store = s.town!.deltas.areaRecords;
    expect(runB.host.wildProbe("fold")).toContain("folded");
    expect(s.areaRecords.has("home")).toBe(true);
    expect(store.rows.has("home")).toBe(true);
    expect(store.rows.get("home")).toBe(s.areaRecords.get("home"));
    expect(store.at).toBe(s.taskClock);
    // …and the instant those trees stand again, the record stops being durable
    // in the SAME instant. An area is loaded or condensed, never both — a save
    // holding the record while the features stand would double the audit on the
    // next boot.
    expect(runB.host.wildProbe("load")).toContain("loaded the stand back");
    // ⚖️ THE INVARIANT IS AGREEMENT, not absence: an unfold may leave a
    // RESIDUAL record when a spawn is refused (the body budget), and whatever
    // the session ends up holding is exactly what the store must hold.
    expect(store.rows.has("home")).toBe(s.areaRecords.has("home"));
    expect("home" in (s.town!.deltas.toJSON().areaRecords?.records ?? {})).toBe(
      s.areaRecords.has("home"),
    );
  });

  it("a restored record over THIS session's ground retires at the mount", () => {
    // The belt, forged deliberately: a save whose `home` row names the ground
    // this session is about to deal as live features. `start()` retires it by
    // RECT (`isSessionGroundRecord`), not by key name — the same predicate the
    // clock sweep and the LOD gate ask. Without it a reload would stand the
    // forest twice and double the audit.
    //
    // The rect comes from the ENGINE, never a literal: fold once and read the
    // record's own ground back off it.
    runB.host.wildProbe("fold");
    const groundArea = { ...runB.session.areaRecords.get("home")!.area };
    runB.host.wildProbe("load");
    const forged: SerializedTownDeltas = {
      ...saved,
      areaRecords: {
        at: saved.areaRecords!.at,
        records: {
          ...saved.areaRecords!.records,
          home: { ...fresh.get(drawnKey)!, key: "home", area: groundArea },
        },
      },
    };
    const run = bootTextQuest({
      world: doc, seed: SEED, dt: 1 / 10, wildMix: countryMix(SEED), deltas: forged,
    });
    try {
      run.advance(2);
      // The forged record is GONE and the trees are standing — one form, not two.
      expect(run.session.areaRecords.has("home")).toBe(false);
      expect(run.session.town!.deltas.areaRecords.rows.has("home")).toBe(false);
      expect(run.session.wilderness!.features.length).toBeGreaterThan(0);
      // …and everything that was NOT this session's ground survived the same
      // pass untouched, so the retire is a rect test and not a purge.
      expect([...run.session.areaRecords.keys()].filter(isNeighborTileKey).sort())
        .toEqual(tileKeys);
    } finally {
      run.dispose();
    }
  }, 600_000);
});
