/**
 * GEOLOGY WORKER — a planet's whole bake (sphere tectonics → settled
 * substrate → founding sites) runs OFF the main thread. This is the ~20 s
 * synchronous lump that froze the page ("page unresponsive"): the flight
 * keeps flying while a world grows here, and the main thread only pays the
 * cheap rebuild (deserialize + surface closures) when the bake lands.
 *
 * Pure data across the boundary: the planet-scope `world` params in, the
 * serialized grid + sites + spec out. buildPlanetWorld is DOM/THREE-free
 * (the vitest suites run it headless), so it works here unchanged.
 */
import {
  buildPlanetWorld, rebuiltPlanetWorld, type PlanetWorldSpec,
} from "@shared/world-engine/planet/planet-game";
import { refineRegion, refineHighways, stitchRegions, stitchRegionStreams } from "@shared/world-engine/planet/refine";
import { planetCities } from "@shared/world-engine/planet/cities";
import { planetStates, statePairs } from "@shared/world-engine/planet/states";
import { planetRoutes } from "@shared/world-engine/planet/routes";
import { serializeGrid, type FoundingSite } from "@shared/world-engine/kernel/cells/index";
import { resolveWorldScale, type WorldScale, type WorldScaleSpec } from "@shared/world-engine/scale";
import type { GameSettings } from "@shared/world-engine/kernel/manifest";
import {
  certifyCreatureQuestWorld, type CreatureCertification,
} from "@shared/world-engine/interaction/quest/creature-quests";

export type GeologyBakeRequest =
  | {
      id: number; op: "bake"; world: Record<string, unknown>; label: string;
      /** THE WORLD'S DECLARED SPACE-TIME SCALE (`game.scale`) — the founding
       *  scan's spacing DERIVES from it now (growth phase C §3.1
       *  `planetFoundingOpts`), so a bake that dropped it would found the
       *  real-scale site set on a world that declared a compressed gap. Part
       *  of the bake's identity, and part of its cache key. */
      scale?: Record<string, unknown> | null;
    }
  | {
      id: number; op: "refine";
      spec: unknown; gridJson: string; sites: unknown[];
      regionCell: number;
      /** The world's declared scale — the region tier derives its village
       *  SPACING and its lanes' port EXTENT from it (growth phase C §1.2/
       *  §3.1). Scoped by the bake key, which now carries the same
       *  declaration. */
      scale?: Record<string, unknown> | null;
      /** Bake identity (geo-bake's cache key) — scopes the refined-region
       *  LRU so two worlds' regions never cross. */
      key: string;
    }
  | {
      id: number; op: "stitch";
      spec: unknown; gridJson: string; sites: unknown[];
      cellA: number; cellB: number; key: string;
      /** The declared scale, for the same reason `refine` carries it: a
       *  stitch that arrives before its regions' refines would otherwise
       *  cache them at REAL scale under the scaled key. */
      scale?: Record<string, unknown> | null;
    }
  | { id: number; op: "certifyTown"; game: unknown };

export type GeologyBakeResponse =
  | { id: number; ok: true; op: "bake"; spec: unknown; gridJson: string; sites: unknown[]; ms: number }
  | {
      id: number; ok: true; op: "refine";
      villages: unknown[]; roads: unknown[]; highways: unknown[];
      /** The region's own streams (refine.ts `rivers`) — pure-JSON river
       *  polylines the main thread merges into the terrain's river relief. */
      rivers: unknown[];
      ms: number;
    }
  | {
      id: number; ok: true; op: "stitch"; routes: unknown[];
      /** Cross-border stream JOINS (refine.ts stitchRegionStreams) — river
       *  polylines the main thread merges into the terrain's river relief. */
      streams: unknown[];
      ms: number;
    }
  | { id: number; ok: true; op: "certifyTown"; cert: CreatureCertification; ms: number }
  | { id: number; ok: false; error: string };

// The rebuilt planet is expensive per message — deserializing the whole grid
// AND folding the river relief back in (rebuiltPlanetWorld → attachRiverRelief,
// ~2–7 s at faceN 48). Refine/stitch traffic all targets the same one or two
// planets, so cache the rebuilt world by bake key instead of paying that toll
// on EVERY message (measured: the per-message rebuild was most of the queue
// delay that held a new planet's bake behind old-planet stitches).
const builtLru = new Map<string, ReturnType<typeof rebuiltPlanetWorld>>();
const BUILT_KEEP = 2;
function builtFor(
  key: string, spec: PlanetWorldSpec, gridJson: string, sites: FoundingSite[],
): ReturnType<typeof rebuiltPlanetWorld> {
  const hit = builtLru.get(key);
  if (hit) {
    builtLru.delete(key);
    builtLru.set(key, hit); // refresh LRU order
    return hit;
  }
  const built = rebuiltPlanetWorld(spec, gridJson, sites);
  builtLru.set(key, built);
  while (builtLru.size > BUILT_KEEP) {
    builtLru.delete(builtLru.keys().next().value!);
  }
  return built;
}

// Refined regions are expensive (~1–3 s) and stitching needs TWO of them —
// keep the last few in memory, keyed by (bake key, cell), so a stitch that
// follows its regions' refines pays only the pair matching.
const refinedLru = new Map<string, ReturnType<typeof refineRegion>>();
const REFINED_KEEP = 8;
function refinedFor(
  built: ReturnType<typeof rebuiltPlanetWorld>,
  bakeKey: string,
  cell: number,
  scale?: WorldScale,
): ReturnType<typeof refineRegion> {
  const k = `${bakeKey}:${cell}`;
  const hit = refinedLru.get(k);
  if (hit) {
    refinedLru.delete(k);
    refinedLru.set(k, hit); // refresh LRU order
    return hit;
  }
  const r = refineRegion(built, cell, scale ? { scale } : {});
  refinedLru.set(k, r);
  while (refinedLru.size > REFINED_KEEP) {
    refinedLru.delete(refinedLru.keys().next().value!);
  }
  return r;
}

self.onmessage = (e: MessageEvent<GeologyBakeRequest>) => {
  const req = e.data;
  const t0 = performance.now();
  try {
    if (req.op === "certifyTown") {
      // A town's quest bundle is proved winnable OFF the main thread — the
      // game spec is pure JSON, so the founding's last lump crosses free.
      const cert = certifyCreatureQuestWorld(
        req.game as Parameters<typeof certifyCreatureQuestWorld>[0],
      );
      const res: GeologyBakeResponse = {
        id: req.id, ok: true, op: "certifyTown", cert,
        ms: Math.round(performance.now() - t0),
      };
      (self as unknown as Worker).postMessage(res);
      return;
    }
    if (req.op === "stitch") {
      // CROSS-REGION STITCHING: villages of two adjacent refined regions
      // join hands across their border (planet/refine.ts stitchRegions).
      const built = builtFor(
        req.key, req.spec as PlanetWorldSpec, req.gridJson, req.sites as FoundingSite[],
      );
      const stitchScale = req.scale ? resolveWorldScale(req.scale as WorldScaleSpec) : undefined;
      const a = refinedFor(built, req.key, req.cellA, stitchScale);
      const b = refinedFor(built, req.key, req.cellB, stitchScale);
      const res: GeologyBakeResponse = {
        id: req.id, ok: true, op: "stitch",
        routes: stitchRegions(built, a, b),
        streams: stitchRegionStreams(built, a, b),
        ms: Math.round(performance.now() - t0),
      };
      (self as unknown as Worker).postMessage(res);
      return;
    }
    if (req.op === "refine") {
      // TIER 1: rebuild the cached planet, refine one region, hand back its
      // villages (planet/refine.ts — the hierarchical-cells design).
      const built = builtFor(
        req.key, req.spec as PlanetWorldSpec, req.gridJson, req.sites as FoundingSite[],
      );
      const scale = req.scale ? resolveWorldScale(req.scale as WorldScaleSpec) : undefined;
      const refined = refinedFor(built, req.key, req.regionCell, scale);
      // The interstates crossing this region, re-solved on its child grid
      // (refine.ts). The tier-0 net re-derives here deterministically — the
      // same (built) the main thread's trade-roads sees yields the same
      // routes, so the spans line up without a wire.
      const cities = planetCities(built);
      const states = planetStates(built, cities);
      const pairs = statePairs(states);
      // THE SAME SCALE THE SPANS WILL BE MEASURED AGAINST. `planetRoutes`
      // clips each end at `townExtentM(scale)`; dropping the declaration here
      // ported the parents at the REAL 450 m while `refineHighways` below
      // dropped its port cells at the DERIVED extent, so the two halves of
      // one road disagreed about where the town began.
      const t0Routes = planetRoutes(built, cities, {
        ...(pairs.length ? { pairs } : {}),
        ...(scale ? { scale } : {}),
      });
      const highways = refineHighways(built, refined, t0Routes, scale ? { scale } : {});
      const res: GeologyBakeResponse = {
        id: req.id, ok: true, op: "refine",
        villages: refined.villages,
        roads: refined.roadRoutes,
        highways,
        rivers: refined.rivers,
        ms: Math.round(performance.now() - t0),
      };
      (self as unknown as Worker).postMessage(res);
      return;
    }
    const game: GameSettings = {
      scope: "planet",
      world: req.world,
      initialFocus: null,
      avatar: false,
      avatarSpecies: "human",
      mods: [],
      canFly: false,
      creativeMode: false,
      entities: null,
      scale: (req.scale ?? null) as GameSettings["scale"],
      culture: null,
    };
    const built = buildPlanetWorld(game, req.label);
    const res: GeologyBakeResponse = {
      id: req.id, ok: true, op: "bake",
      spec: built.spec,
      gridJson: serializeGrid(built.grid),
      sites: built.sites,
      ms: Math.round(performance.now() - t0),
    };
    (self as unknown as Worker).postMessage(res);
  } catch (err) {
    const res: GeologyBakeResponse = { id: req.id, ok: false, error: (err as Error).message };
    (self as unknown as Worker).postMessage(res);
  }
};
