/**
 * Traveler bands — groups on the roads between villages, handled as their
 * own MOBILE SITE in miniature (the §8 caravan slot, simplified):
 * movement is a formula, not a simulation, and a band only materializes
 * into world-engine bodies when the player is nearby.
 *
 * Where they come from: the settlement layer's steady-state flow field
 * (§4c). A route that carries goods or holds a worn road gets bands
 * cycling along it — the same "drawn FROM state" philosophy as the lab
 * map's marching-dash caravans, now embodied at eye level. The world can
 * be at REST while they keep walking, because their position is
 * `f(route, wall-clock)`: deterministic, storage-free, idle-safe.
 *
 * Who they are: sampled individuals from the ORIGIN site (the §6 zoom-in
 * sampler, index-offset above the resident range so a traveler is never
 * also standing in their village square).
 *
 * What this is NOT yet: a true §8 caravan — no stockpiles, no illness
 * spreading inside the band, and no population transfer (real migration
 * stays on the day-boundary channel). When §8 lands, a caravan becomes a
 * PopuSim Site attached to this same moving position, and these bands
 * are its render/embodiment layer.
 */

import type { NpcSpec } from "@shared/world-engine/index";
import type { HistfigSample } from "@popusim/controller/World";
import type { TriWorld } from "./tri";
import { worldPos } from "./zoom";

/** Walking pace of a band, meters/sec — a touch under the player's
 *  speed so travelers can be caught up with on the road. */
export const BAND_SPEED = 3.5;

/** Embody a band (spawn its members as NPCs) when the player is this
 *  close (meters), release past the larger radius (hysteresis). Bands
 *  render as road-dots at ANY distance, so crossing this line only swaps
 *  a dot for bodies — there is no popping into existence. */
export const BAND_LOAD_R = 400;
export const BAND_UNLOAD_R = 520;

/** Sampled-villager index base for travelers — residents draw house
 *  indices (0..thousands), so travelers sample far above that range: a
 *  traveler is never also standing at a doorstep back home. */
const TRAVELER_INDEX_BASE = 1_000_000;

export interface TravelerBand {
  id: string;
  routeIndex: number;
  /** Travel direction: origin → destination city keys. */
  from: string;
  to: string;
  members: HistfigSample[];
}

export interface BandSnapshot {
  band: TravelerBand;
  x: number;
  y: number;
  /** Unit heading along the road. */
  hx: number;
  hy: number;
  /** True while the band exists as world-engine bodies (near player). */
  embodied: boolean;
}

export interface BandUpdate {
  /** Members to spawn, each with the road destination their errand walks
   *  toward (`host.addNpc` + `host.setNpcErrand`). */
  spawn: Array<{ npc: NpcSpec; walkTo: { x: number; y: number } }>;
  despawn: string[];
}

export interface BandWorld {
  /** All live bands with their formula positions at `nowSec`. */
  bands(nowSec: number): BandSnapshot[];
  /** Reconcile embodiment against the player's position. */
  update(p: { x: number; y: number }, nowSec: number): BandUpdate;
  /** Embodied traveler bodies currently on the host (budget sharing). */
  active(): number;
}

function hash32(seed: number, key: string): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createTravelerBands(tri: TriWorld, seed: number, npcBudget: () => number): BandWorld {
  /** npc ids per embodied band id. */
  const embodied = new Map<string, string[]>();

  interface LiveBand extends TravelerBand {
    a: { x: number; y: number };
    b: { x: number; y: number };
    length: number;
    phase: number; // seconds of head start, deterministic per band
  }

  // Bands derive from the CURRENT routes + flow field — recomputed on
  // demand so mid-run foundings (new roads) grow new traffic.
  const liveBands = (): LiveBand[] => {
    const out: LiveBand[] = [];
    const routes = tri.dual.routes();
    for (let e = 0; e < routes.length; e++) {
      const r = routes[e];
      const aKey = r.site_a?.key;
      const bKey = r.site_b?.key;
      if (!aKey || !bKey) continue;
      const ca = tri.cities.find(c => c.key === aKey);
      const cb = tri.cities.find(c => c.key === bKey);
      if (!ca || !cb) continue;
      const flow = tri.dual.settlementFlow(e);
      // Traffic mirrors the economy: goods flowing → a band each way
      // (goods out, people back); a worn but quiet road → one band.
      const directions = Math.abs(flow) > 0.5 ? 2 : r.strength > 0.3 ? 1 : 0;
      for (let k = 0; k < directions; k++) {
        const [oc, dc] = k === 0 ? [ca, cb] : [cb, ca];
        const a = worldPos(oc.x, oc.y);
        const b = worldPos(dc.x, dc.y);
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (length < 200) continue; // degenerate road
        const id = `band_${e}_${k}`;
        const h = hash32(seed, id);
        const memberCount = 2 + (h % 2);
        const members: HistfigSample[] = [];
        for (let j = 0; j < memberCount; j++) {
          const s = tri.dual.sampleVillager(oc.key, TRAVELER_INDEX_BASE + k * 8 + j);
          if (s) members.push(s);
        }
        if (!members.length) continue;
        out.push({
          id, routeIndex: e, from: oc.key, to: dc.key, members,
          a, b, length,
          phase: ((h >>> 8) % 1000) / 1000 * (length / BAND_SPEED),
        });
      }
    }
    return out;
  };

  const posOf = (band: LiveBand, nowSec: number): { x: number; y: number; hx: number; hy: number } => {
    const period = band.length / BAND_SPEED;
    const t = ((nowSec + band.phase) % period) / period;
    return {
      x: band.a.x + (band.b.x - band.a.x) * t,
      y: band.a.y + (band.b.y - band.a.y) * t,
      hx: (band.b.x - band.a.x) / band.length,
      hy: (band.b.y - band.a.y) / band.length,
    };
  };

  const memberNpcId = (bandId: string, j: number): string => `traveler_${bandId}_${j}`;

  return {
    bands(nowSec) {
      return liveBands().map(band => ({
        band,
        ...posOf(band, nowSec),
        embodied: embodied.has(band.id),
      }));
    },
    update(p, nowSec) {
      const spawn: BandUpdate["spawn"] = [];
      const despawn: string[] = [];
      const live = liveBands();
      const liveIds = new Set(live.map(b => b.id));

      // Release bands the player left behind (or whose route died).
      for (const [id, ids] of embodied) {
        const band = live.find(b => b.id === id);
        const d = band ? Math.hypot(posOf(band, nowSec).x - p.x, posOf(band, nowSec).y - p.y) : Infinity;
        if (!liveIds.has(id) || d > BAND_UNLOAD_R) {
          despawn.push(...ids);
          embodied.delete(id);
        }
      }

      // Embody nearby bands, nearest first, inside the leftover budget.
      let used = this.active();
      const near = live
        .filter(b => !embodied.has(b.id))
        .map(b => ({ b, pos: posOf(b, nowSec) }))
        .map(x => ({ ...x, d: Math.hypot(x.pos.x - p.x, x.pos.y - p.y) }))
        .filter(x => x.d < BAND_LOAD_R)
        .sort((a, b) => a.d - b.d);
      for (const { b, pos } of near) {
        if (used + b.members.length > Math.max(0, npcBudget())) continue;
        used += b.members.length;
        const ids: string[] = [];
        for (const [j, m] of b.members.entries()) {
          const id = memberNpcId(b.id, j);
          ids.push(id);
          spawn.push({
            npc: {
              id,
              x: pos.x - pos.hx * j * 1.4 + pos.hy * (j % 2 ? 1 : -1),
              y: pos.y - pos.hy * j * 1.4 - pos.hx * (j % 2 ? 1 : -1),
              name: m.name,
              // Bodies pace the band's canonical dot, so an embodied band
              // doesn't outrun its own map position.
              behavior: { movement: "wander", conversationRadius: 5, wanderRadius: 2, speed: BAND_SPEED },
            },
            walkTo: { x: b.b.x, y: b.b.y },
          });
        }
        embodied.set(b.id, ids);
      }

      return { spawn, despawn };
    },
    active() {
      let n = 0;
      for (const ids of embodied.values()) n += ids.length;
      return n;
    },
  };
}
