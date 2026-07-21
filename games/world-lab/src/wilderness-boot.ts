/**
 * WILDERNESS GROUND — "ground should be ground": touching down ANYWHERE (not
 * just at a city) mounts a chunk of living ground through the SAME machinery
 * a town uses — the world-engine walker (gaze steering, chase-camera rules,
 * spark, terrain-conformed bodies) rendered INTO the flight scene under an
 * anchor at the landing point. No canvas swap, no separate mode.
 *
 * PLANTS ARE NOT HERE: trees/grass are the WORLD-FIXED flora streaming layer
 * (flora-field.ts — positions a pure function of the world seed + planet
 * position, visible from the air, impostors resolving to real geometry).
 * This boot carries the WALKER and the FAUNA: the biome's animals as NPC
 * bodies (grazing ungulates on the steppe). The response board stays visible
 * and blank — nothing to press in the wild yet.
 */
import * as THREE from "three";
import type { WorldSpec } from "@shared/world-engine/types";
import { runWorldHost, type WorldHost } from "@shared/world-engine/world-host";
import { createWorld3DView, type RenderHost } from "@shared/world-engine/render3d";
import { createCreatureAvatarFactory } from "@shared/world-engine/creatures/creature-model";

/** Side of the wilderness chunk (metres of sim manifold). The anchor sits at
 *  the CENTER (the landing point) — sim coords run 0..WILD_SIDE. */
export const WILD_SIDE = 320;

const PLAYER_ID = "player";

export interface WildFauna {
  horses: number;
}

/** What the landing cell's biome grazes (grid.fields.biome: 0 = barren/sea/
 *  ice, then DEFAULT_BIOSPHERE order — 1 tree, 2 grass, 3 horse). */
export function faunaForBiome(biome: number): WildFauna {
  switch (biome) {
    case 2: return { horses: 4 };  // steppe / meadow
    case 3: return { horses: 6 };  // grazer range
    default: return { horses: 0 };
  }
}

/** The mounted wilderness chunk — structurally the same surface main.ts's
 *  walk↔fly coordinator drives for a town (step / pointer / camera handoff /
 *  walker pose), so landing in the wild IS landing in a town, minus people. */
export interface WildernessGround {
  host: {
    step(dt: number, now: number): void;
    setPointer(clientX: number, clientY: number): void;
    clearPointer(): void;
    setDriveCamera(on: boolean): void;
    setLocalAvatarHidden(hidden: boolean): void;
  };
  playerPose(): { x: number; y: number; fx: number; fy: number } | null;
  placePlayer(x: number, y: number, fx?: number, fy?: number): void;
  /** FLOATING-ORIGIN RE-ANCHOR: the coordinator moved this chunk's surface
   *  anchor to a new chart (world poses preserved) — re-express the whole sim
   *  (WorldHost.rebase) and the view's eased local caches (rebaseLocal) in the
   *  new frame. `delta` = newAnchorWorld⁻¹ · oldAnchorWorld; the point/vector
   *  maps are the coordinator's exact sim-coordinate re-expressions. */
  rebase(
    delta: THREE.Matrix4,
    mapPoint: (p: { x: number; y: number }) => { x: number; y: number },
    mapVec: (v: { x: number; y: number }) => { x: number; y: number },
  ): void;
  /** After a re-anchor: retire fauna the chart left far behind and scatter
   *  replacements in the fresh ground around the new centre — the walker keeps
   *  meeting the biome's animals however far they roam. */
  refreshFauna(): void;
  dispose(): void;
}

/** Deterministic scatter RNG (the landing cell is an address, not a session). */
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

export function bootWilderness(
  hostCanvas: HTMLCanvasElement,
  renderHost: RenderHost,
  groundAt: (x: number, y: number) => number,
  waterAt: (x: number, y: number) => boolean,
  fauna: WildFauna,
  seed: number,
): WildernessGround {
  const spec: WorldSpec = {
    engine: "world",
    engineVersion: 1,
    meta: { title: "Wilderness", locale: "en", theme: "wilderness" },
    // Unbounded: the chunk rect is content extent only — the walker stands on
    // a real planet whose ground sampler answers everywhere, so the edge of
    // the streamed chunk must never be a wall (bodies keep walking; the
    // re-anchor streams fresh content around them).
    manifold: { kind: "flat", width: WILD_SIDE, height: WILD_SIDE, bounded: false },
    terrain: { kind: "flat" },
    spawns: [{ id: "landing", x: WILD_SIDE / 2, y: WILD_SIDE / 2 }],
    objects: [],
    multiplayer: { maxPlayers: 1, authority: "distributed" },
    content: { kind: "sandbox" },
  };

  // The ecology's grazer body plan (SpeciesDef.model "ungulate") + the same
  // walker body a town gives the player. Plants live in flora-field.ts.
  const grazer = createCreatureAvatarFactory({ speciesFor: () => "ungulate", heightM: 1.5 });
  const walker = createCreatureAvatarFactory({ speciesFor: () => "human_cute", heightM: 1.7 });

  const view = createWorld3DView(
    {
      canvas: hostCanvas,
      localId: PLAYER_ID,
      faceFor: () => null,
      labelFor: () => "",
    },
    spec,
    {
      host: renderHost,
      modelFactory: (id, isLocal) =>
        id.startsWith("horse_") ? grazer(id, isLocal) : walker(id, isLocal),
    },
  );

  const rng = mulberry(seed);
  const world: WorldHost = runWorldHost({
    view,
    spec,
    localId: PLAYER_ID,
    spawnIndex: 0,
    groundAt,
    waterAt,
    hostNpcs: true,
    maxNpcs: fauna.horses + 4,
    npcRng: rng,
    // Driven externally (the flight loop calls step) — never start()ed.
    scheduleFrame: () => () => {},
    now: () => performance.now(),
  });
  world.resize(hostCanvas.clientWidth || 1, hostCanvas.clientHeight || 1, window.devicePixelRatio || 1);

  // ── Scatter the biome's fauna (deterministic in the landing seed) ─────────
  const place = (): { x: number; y: number } | null => {
    for (let tries = 0; tries < 8; tries++) {
      const x = 12 + rng() * (WILD_SIDE - 24);
      const y = 12 + rng() * (WILD_SIDE - 24);
      const dc = Math.hypot(x - WILD_SIDE / 2, y - WILD_SIDE / 2);
      if (dc < 8) continue; // keep the touchdown clear
      if (waterAt(x, y)) continue;
      return { x, y };
    }
    return null;
  };
  let horseSeq = 0;
  const spawnHorse = (): void => {
    const p = place();
    if (p) {
      world.addNpc({
        id: `horse_${horseSeq++}`,
        x: p.x,
        y: p.y,
        behavior: { movement: "wander", wanderRadius: 30, home: { x: p.x, y: p.y }, speed: 1.4, conversationRadius: 3 },
      });
    }
  };
  for (let i = 0; i < fauna.horses; i++) spawnHorse();

  const player = () => world.state.avatars[PLAYER_ID] ?? null;

  return {
    host: {
      step: (dt, now) => world.step(dt, now),
      setPointer(clientX, clientY) {
        const r = hostCanvas.getBoundingClientRect();
        world.setPointer(clientX - r.left, clientY - r.top);
      },
      clearPointer: () => world.clearPointer(),
      setDriveCamera: (on) => view.setDriveCamera?.(on),
      setLocalAvatarHidden: (hidden) => view.setAvatarHidden?.(PLAYER_ID, hidden),
    },
    playerPose() {
      const p = player();
      return p ? { x: p.x, y: p.y, fx: p.fx, fy: p.fy } : null;
    },
    placePlayer(x, y, fx, fy) {
      const p = player();
      if (!p) return;
      p.x = x;
      p.y = y;
      p.vx = 0;
      p.vy = 0;
      if (fx !== undefined && fy !== undefined) {
        const l = Math.hypot(fx, fy);
        if (l > 1e-6) { p.fx = fx / l; p.fy = fy / l; }
      }
    },
    rebase(delta, mapPoint, mapVec) {
      world.rebase(mapPoint, mapVec);
      view.rebaseLocal?.(delta);
    },
    refreshFauna() {
      // A rebased herd whose mapped position fell far outside the fresh chunk
      // is out of the walker's world — retire it and let a new one graze here.
      // (A CLAIMED body is never retired: the spark may be riding it.)
      const cx = WILD_SIDE / 2;
      let alive = 0;
      for (const a of Object.values(world.state.avatars)) {
        if (!a.id.startsWith("horse_")) continue;
        if (a.id === world.state.drivenId) { alive++; continue; }
        if (Math.hypot(a.x - cx, a.y - cx) > WILD_SIDE) world.removeNpc(a.id);
        else alive++;
      }
      for (let i = alive; i < fauna.horses; i++) spawnHorse();
    },
    dispose() {
      world.stop(); // stops + disposes the injected view (detaches from the anchor)
    },
  };
}
