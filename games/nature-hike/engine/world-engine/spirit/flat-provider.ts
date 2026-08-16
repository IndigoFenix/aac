/**
 * flat-provider.ts — the SpiritFrameProvider over a STANDALONE quest-host
 * world (scope = town or structure): one identity chart — chart coordinates
 * ARE the town-SIM coordinates — no streaming, no flight seam. The host
 * keeps its own canvas, loop and simulation; the ladder (stepped from the
 * host's onFrame) owns only the camera, via setExternalCamera(true).
 *
 * The point of this provider: the SAME ladder handlers that orbit a town on
 * a planet drive the standalone town — a focus behaves identically whether
 * it is the whole generated world or nested in a larger scope.
 */
import * as THREE from "three";
import type {
  SpiritChartFrame, SpiritFocusTarget, SpiritFrameProvider, SpiritStructureHost,
} from "./frame-provider.js";

/** The seams the flat provider needs from a quest host (QuestHost3D
 *  satisfies this structurally; kept local so spirit/ stays DOM-free). */
export interface FlatSpiritHostSeams {
  readonly camera: THREE.PerspectiveCamera | null;
  setSpiritFocus(frame: { x: number; y: number; w: number; h: number } | null): void;
  dollhousePose(
    frame: { x: number; y: number; w: number; h: number } | null,
    spiritAz: number,
    out: { pos: THREE.Vector3; look: THREE.Vector3; up: THREE.Vector3; fov: number },
  ): void;
  setPointer(clientX: number, clientY: number): void;
  clearPointer(): void;
}

export interface FlatProviderOpts {
  scopeLevel: "town" | "structure";
  label: string;
  host: FlatSpiritHostSeams;
  /** Park the hidden gaze walker (SIM coords) — quest-boot moves the host's
   *  player avatar (the streaming window + interactions key on it). */
  placeGazeAvatar(x: number, y: number): void;
  viewSize(): { w: number; h: number };
  /** The town-SIM centre the orbit frames (the stage plaza / the structure
   *  bounds centre). */
  centre: { x: number; z: number };
  /** Framing radius, metres (a closure so a loading plan can grow it). */
  radius: () => number;
  /** Terrain height at SIM (x,z). Omit = flat 0. */
  ground?: (x: number, z: number) => number;
  /** Building footprints, SIM coords (dollhouse frames ARE these). */
  lots: () => readonly { x: number; y: number; w: number; h: number }[];
}

/** The one town ref a flat world has (ladder compares refs by identity). */
export const FLAT_TOWN_REF = Symbol("flat-town");

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _hit = new THREE.Vector3();

export function createFlatSpiritProvider(opts: FlatProviderOpts): SpiritFrameProvider {
  const camera = opts.host.camera;
  if (!camera) throw new Error("flat spirit provider needs a started host (no camera yet)");
  const ground = opts.ground ?? (() => 0);

  const chartFrame = (sx: number, sz: number): SpiritChartFrame => ({
    origin: new THREE.Vector3(sx, ground(sx, sz), sz),
    east: new THREE.Vector3(1, 0, 0),
    north: new THREE.Vector3(0, 0, 1),
    up: new THREE.Vector3(0, 1, 0),
  });

  /** Gaze NDC → a SIM-coords hit on the ground plane at the town centre. */
  const groundHit = (ndcX: number, ndcY: number, maxDist: number): { x: number; z: number } | null => {
    _ray.setFromCamera(_ndc.set(ndcX, ndcY), camera);
    const o = _ray.ray.origin;
    const d = _ray.ray.direction;
    if (d.y > -1e-6) return null;
    const planeY = ground(opts.centre.x, opts.centre.z);
    const t = (planeY - o.y) / d.y;
    if (t <= 0) return null;
    _hit.copy(d).multiplyScalar(t).add(o);
    if (Math.hypot(_hit.x - opts.centre.x, _hit.z - opts.centre.z) > maxDist) return null;
    return { x: _hit.x, z: _hit.z };
  };

  const structureHost: SpiritStructureHost = {
    setSpiritFocus: f => opts.host.setSpiritFocus(f ?? null),
    dollhousePose: (f, az, out) => opts.host.dollhousePose(f ?? null, az, out),
    placeGazeAvatar: (x, y) => opts.placeGazeAvatar(x, y),
    setPointer: (cx, cy) => opts.host.setPointer(cx, cy),
    clearPointer: () => opts.host.clearPointer(),
    step() { /* the host self-loops — the ladder is a guest of its frame */ },
  };

  const session = {
    label: opts.label,
    radius: opts.radius,
    chartAt: (x: number, z: number) => chartFrame(opts.centre.x + x, opts.centre.z + z),
    pickDistrict(ndcX: number, ndcY: number): SpiritFocusTarget | null {
      const hit = groundHit(ndcX, ndcY, opts.radius() * 1.25);
      if (!hit) return null;
      return {
        kind: "district",
        x: hit.x - opts.centre.x,
        z: hit.z - opts.centre.z,
        radius: THREE.MathUtils.clamp(opts.radius() * 0.33, 30, 160),
      };
    },
    pickBuilding(ndcX: number, ndcY: number): SpiritFocusTarget | null {
      const hit = groundHit(ndcX, ndcY, opts.radius() * 1.25);
      if (!hit) return null;
      let bestD = Infinity;
      let bestHalf = 0;
      let best: { x: number; y: number; w: number; h: number } | null = null;
      for (const lot of opts.lots()) {
        const cx = lot.x + lot.w / 2;
        const cz = lot.y + lot.h / 2;
        const dd = (cx - hit.x) ** 2 + (cz - hit.z) ** 2;
        if (dd < bestD) {
          bestD = dd;
          bestHalf = Math.max(lot.w, lot.h) / 2;
          best = lot;
        }
      }
      if (!best) return null;
      if (Math.sqrt(bestD) > bestHalf + 14) return null; // streets / gaps
      const lot = best as { x: number; y: number; w: number; h: number };
      return {
        kind: "building",
        x: lot.x + lot.w / 2 - opts.centre.x,
        z: lot.y + lot.h / 2 - opts.centre.z,
        radius: THREE.MathUtils.clamp(bestHalf * 1.8, 6, 22),
        frame: lot,
      };
    },
    structureHost: () => structureHost,
  };

  return {
    scopeLevel: opts.scopeLevel,
    camera,
    viewSize: opts.viewSize,
    advance() { /* the host's own loop already ticked the sim */ },
    rebaseOnCamera: () => ({ near: camera.near, far: camera.far, camAtOrigin: false }),
    postFrame: () => ({ nearTown: null, waiting: null }),
    openTown: () => session,
    openGround(worldPos, town) {
      const ax = worldPos.x;
      const az = worldPos.z;
      const ay = ground(ax, az);
      return {
        chartAt: (x, z) => chartFrame(ax + x, az + z),
        groundY: (x, z) => ground(ax + x, az + z) - ay,
        buildingAt(x, z) {
          if (town === undefined || town === null) return null;
          const px = ax + x;
          const pz = az + z;
          const MARGIN = 0.5;
          for (const lot of opts.lots()) {
            if (px < lot.x + MARGIN || px > lot.x + lot.w - MARGIN) continue;
            if (pz < lot.y + MARGIN || pz > lot.y + lot.h - MARGIN) continue;
            const half = Math.max(lot.w, lot.h) / 2;
            return {
              town,
              target: {
                kind: "building",
                x: lot.x + lot.w / 2 - opts.centre.x,
                z: lot.y + lot.h / 2 - opts.centre.z,
                radius: THREE.MathUtils.clamp(half * 1.8, 6, 22),
                frame: lot,
              },
            };
          }
          return null;
        },
        placeAvatar(x, z) {
          // The glide IS the invisible avatar (SIM coords are chart coords).
          opts.placeGazeAvatar(ax + x, az + z);
        },
      };
    },
    spark() { /* the host renderer's own spark tracks its pointer feed */ },
  };
}
