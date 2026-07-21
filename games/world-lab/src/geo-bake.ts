/**
 * The main-thread half of the geology worker: a `bakeGeography` service the
 * flight stack calls instead of the synchronous buildPlanetGeography. One
 * worker, FIFO — bakes are long and rare (one per approached rocky body).
 */
import {
  geographyParamsFromFeatures, type PlanetGeography,
} from "@shared/world-engine/space/planet-geography";
import { rebuiltPlanetWorld, type PlanetWorldSpec } from "@shared/world-engine/planet/planet-game";
import type { FoundingSite } from "@shared/world-engine/kernel/cells/index";
import type { PlanetCity } from "@shared/world-engine/planet/cities";
import type { PlanetRoute } from "@shared/world-engine/planet/routes";
import type { HighwayRefinement } from "@shared/world-engine/planet/refine";
import type { ResolvedBody } from "@shared/world-engine/space/physics/index";
import type { CreatureCertification } from "@shared/world-engine/interaction/quest/creature-quests";
import type { GeologyBakeResponse } from "./geology-worker";

export type BakeGeographyFn = (
  resolved: ResolvedBody,
  systemSeed: number,
  faceN: number,
) => Promise<PlanetGeography>;

/** What a region refine hands the flight: the villages, their local road
 *  net as draped sphere polylines, and the interstates' crossings of this
 *  region re-solved on the child grid (render-only overrides). */
export interface RegionRefinement {
  villages: PlanetCity[];
  roads: PlanetRoute[];
  highways: HighwayRefinement[];
}

export interface GeologyBaker {
  bake: BakeGeographyFn;
  /** TIER 1: refine one region of an already-baked body into its villages
   *  and local roads (planet/refine.ts, in the same worker; IndexedDB-cached
   *  like the bake). Requires that body's bake to have completed. */
  refine(bodyId: string, regionCell: number): Promise<RegionRefinement>;
  /** CROSS-REGION STITCHING: the roads joining two adjacent regions'
   *  villages across their border (planet/refine.ts stitchRegions —
   *  deterministic in the pair, so call once per unordered pair when both
   *  regions are loaded; IndexedDB-cached per pair). */
  stitch(bodyId: string, cellA: number, cellB: number): Promise<PlanetRoute[]>;
  /** Prove a founded town's quest bundle winnable OFF the main thread (the
   *  game spec is pure JSON) — the founding pipeline's last frame-lump. */
  certifyTown(game: unknown): Promise<CreatureCertification>;
  dispose(): void;
}

// ── Persistent bake cache ───────────────────────────────────────────────
// A planet's bake is DETERMINISTIC in its params, so the result is worth
// keeping: the first visit to a world pays the worker's tens of seconds,
// every later session gets it back in milliseconds from IndexedDB.
const CACHE_DB = "world-lab-geology";
const CACHE_STORE = "bakes";
interface CachedBake {
  spec: unknown;
  gridJson: string;
  sites: unknown[];
  roads?: unknown[];
  highways?: unknown[];
}

function openCache(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    if (typeof indexedDB === "undefined") { resolve(null); return; }
    const req = indexedDB.open(CACHE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(CACHE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null); // no cache is fine — just slower
  });
}
function cacheGet(db: IDBDatabase | null, key: string): Promise<CachedBake | null> {
  return new Promise(resolve => {
    if (!db) { resolve(null); return; }
    const req = db.transaction(CACHE_STORE).objectStore(CACHE_STORE).get(key);
    req.onsuccess = () => resolve((req.result as CachedBake | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}
function cachePut(db: IDBDatabase | null, key: string, value: CachedBake): void {
  if (!db) return;
  try {
    const tx = db.transaction(CACHE_STORE, "readwrite");
    tx.objectStore(CACHE_STORE).put(value, key);
    tx.onabort = () =>
      console.warn("geology cache write aborted:", tx.error?.message ?? "unknown");
  } catch (e) {
    // Quota/private-mode — just slower next time, but say so.
    console.warn("geology cache write failed:", (e as Error).message);
  }
}

export function createGeologyBaker(): GeologyBaker {
  const worker = new Worker(new URL("./geology-worker.ts", import.meta.url), { type: "module" });
  let nextId = 1;
  const waiting = new Map<number, { resolve: (r: GeologyBakeResponse) => void }>();
  worker.onmessage = (e: MessageEvent<GeologyBakeResponse>) => {
    const w = waiting.get(e.data.id);
    if (w) { waiting.delete(e.data.id); w.resolve(e.data); }
  };
  const dbPromise = openCache();
  const ask = (req: Record<string, unknown>): Promise<GeologyBakeResponse> => {
    const id = nextId++;
    return new Promise(resolve => {
      waiting.set(id, { resolve });
      worker.postMessage({ ...req, id });
    });
  };
  // The baked payload per body — what a refine posts back to the worker.
  const bakedByBody = new Map<string, { key: string; payload: CachedBake }>();

  return {
    async bake(resolved, systemSeed, faceN, compression) {
      // Cheap, main-thread: physics character → planet-world params. The
      // params (including the compressed radius) fully determine the bake,
      // so a miniature world caches separately from its real-scale twin.
      const { world, radiusM, hasOcean } = geographyParamsFromFeatures(resolved, systemSeed, { faceN, compression });
      // The params fully determine the bake — they ARE the cache key.
      const key = JSON.stringify(world);
      const db = await dbPromise;
      const hit = await cacheGet(db, key);
      console.info(`geology cache ${hit ? "HIT" : "miss"} for ${resolved.body.id} (db ${db ? "open" : "unavailable"})`);
      if (hit) {
        bakedByBody.set(resolved.body.id, { key, payload: hit });
        const built = rebuiltPlanetWorld(hit.spec as PlanetWorldSpec, hit.gridJson, hit.sites as FoundingSite[]);
        return { built, radiusM, hasOcean };
      }
      const res = await ask({ op: "bake", world, label: `body:${resolved.body.id}` });
      if (!res.ok) throw new Error(`geology bake for ${resolved.body.id} failed: ${res.error}`);
      if (res.op !== "bake") throw new Error("geology worker answered the wrong op");
      console.info(`geology cache PUT for ${resolved.body.id} (${res.gridJson.length} chars, bake ${res.ms}ms)`);
      const payload: CachedBake = { spec: res.spec, gridJson: res.gridJson, sites: res.sites };
      cachePut(db, key, payload);
      bakedByBody.set(resolved.body.id, { key, payload });
      const built = rebuiltPlanetWorld(res.spec as PlanetWorldSpec, res.gridJson, res.sites as FoundingSite[]);
      return { built, radiusM, hasOcean };
    },
    async refine(bodyId, regionCell) {
      const baked = bakedByBody.get(bodyId);
      if (!baked) throw new Error(`refine: ${bodyId} has no completed bake`);
      const db = await dbPromise;
      // Version the key with the refine ALGORITHM, not just the payload
      // shape: "refine5" = highway crossings ride along (cross-region
      // stitching lives in its own pair-keyed entries, not here).
      const cacheKey = `refine5:${baked.key}:${regionCell}`;
      const hit = await cacheGet(db, cacheKey);
      if (hit) {
        // Villages ride the sites slot; roads/highways ride their own.
        return {
          villages: hit.sites as PlanetCity[],
          roads: (hit.roads ?? []) as PlanetRoute[],
          highways: (hit.highways ?? []) as HighwayRefinement[],
        };
      }
      const res = await ask({
        op: "refine",
        spec: baked.payload.spec,
        gridJson: baked.payload.gridJson,
        sites: baked.payload.sites,
        regionCell,
        key: baked.key,
      });
      if (!res.ok) throw new Error(`region refine for ${bodyId}:${regionCell} failed: ${res.error}`);
      if (res.op !== "refine") throw new Error("geology worker answered the wrong op");
      console.info(`region ${bodyId}:${regionCell} refined — ${res.villages.length} villages, ${res.roads.length} roads, ${res.highways.length} highway spans (${res.ms}ms)`);
      cachePut(db, cacheKey, {
        spec: null, gridJson: "", sites: res.villages,
        roads: res.roads, highways: res.highways,
      });
      return {
        villages: res.villages as PlanetCity[],
        roads: res.roads as PlanetRoute[],
        highways: res.highways as HighwayRefinement[],
      };
    },
    async stitch(bodyId, cellA, cellB) {
      const baked = bakedByBody.get(bodyId);
      if (!baked) throw new Error(`stitch: ${bodyId} has no completed bake`);
      const db = await dbPromise;
      const lo = Math.min(cellA, cellB);
      const hi = Math.max(cellA, cellB);
      // Pair-keyed: a stitch is a pure function of the pair, so it caches
      // independently of either region's entry (and of load order).
      const cacheKey = `stitch5:${baked.key}:${lo}:${hi}`;
      const hit = await cacheGet(db, cacheKey);
      if (hit) return (hit.roads ?? []) as PlanetRoute[];
      const res = await ask({
        op: "stitch",
        spec: baked.payload.spec,
        gridJson: baked.payload.gridJson,
        sites: baked.payload.sites,
        cellA: lo,
        cellB: hi,
        key: baked.key,
      });
      if (!res.ok) throw new Error(`stitch for ${bodyId}:${lo}:${hi} failed: ${res.error}`);
      if (res.op !== "stitch") throw new Error("geology worker answered the wrong op");
      console.info(`stitch ${bodyId}:${lo}:${hi} — ${res.routes.length} border roads (${res.ms}ms)`);
      cachePut(db, cacheKey, { spec: null, gridJson: "", sites: [], roads: res.routes });
      return res.routes as PlanetRoute[];
    },
    async certifyTown(game) {
      const res = await ask({ op: "certifyTown", game });
      if (!res.ok) throw new Error(`town certification failed to run: ${res.error}`);
      if (res.op !== "certifyTown") throw new Error("geology worker answered the wrong op");
      return res.cert;
    },
    dispose() {
      worker.terminate();
      waiting.clear();
      bakedByBody.clear();
    },
  };
}
