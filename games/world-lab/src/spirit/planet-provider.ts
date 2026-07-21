/**
 * planet-provider.ts — the SpiritFrameProvider over the flight STREAMING
 * WORLD (the planet-anchored case). The spirit ladder's level handlers get:
 *
 *   • FLIGHT: the invisible drone over the focus body (terrain-height ground
 *     anchor, floating-origin streaming, gaze→tangent-chart mapping);
 *   • TOWN: SurfaceChart tangent frames at the focused city + dwell picks
 *     read straight from the town PLAN (chart coords ARE plan coords — the
 *     surface-chart convention matches the streamed town mesh byte-for-byte);
 *   • STRUCTURE: the embedded live town's dollhouse host (pose only — the
 *     ladder owns the camera);
 *
 * plus the post-camera world work (sky, ground/content streaming, bake/region
 * force gates) injected from main.ts, whose mutable globals own those systems.
 */
import * as THREE from "three";
import type { GazeSpark } from "@shared/world-engine/render3d";
import type { CelestialBody } from "@shared/world-engine/space/body";
import { createSurfaceChart } from "@shared/world-engine/space/surface-chart";
import type { DroneCamera } from "@shared/world-engine/spirit/drone-camera";
import type {
  SpiritChartFrame, SpiritFocusTarget, SpiritFrameProvider, SpiritGroundSession,
  SpiritNearTown, SpiritPostFrame, SpiritStructureHost, SpiritTownSession,
} from "@shared/world-engine/spirit/frame-provider";
import type { SpaceFlight, FlightCity } from "../space-fly";

export interface PlanetTownPlanLots {
  radius: number;
  houses: readonly { dx: number; dy: number; w: number; h: number }[];
  works: readonly { dx: number; dy: number; w: number; h: number }[];
}

export interface PlanetProviderDeps {
  camera: THREE.PerspectiveCamera;
  viewEl: { clientWidth: number; clientHeight: number };
  flight: SpaceFlight;
  /** The body the spirit flies over (the home planet). */
  body: CelestialBody;
  drone: DroneCamera;
  minAlt: number;
  maxAlt: number;
  spark: GazeSpark;
  /** The founded town's plan lots + radius (null until the founding lands). */
  townPlan(fc: FlightCity): PlanetTownPlanLots | null;
  cityLabel(fc: FlightCity): string;
  /** The live town's dollhouse host, when mounted UNDER this city (else null).
   *  main.ts owns the embed lifecycle; the wrapper maps sim coords + marks the
   *  host stepped so streamGround doesn't double-step it. */
  structureHost(fc: FlightCity): SpiritStructureHost | null;
  /** A building plan lot → its SIM-coords dollhouse frame (needs the mounted
   *  live town's plaza), or null when not mounted. */
  buildingFrame(lot: { dx: number; dy: number; w: number; h: number }): { x: number; y: number; w: number; h: number } | null;
  /** PLAN → SIM offset of the mounted live town under this city (the plaza
   *  registration), or null when not mounted — the ground glide parks the
   *  gaze walker through it. */
  townSimOffset(fc: FlightCity): { x: number; y: number } | null;
  /** The BODY THE SPARK DRIVES in the live town under this city — SIM coords +
   *  unit facing — or null when the spark has claimed nothing, or no town is
   *  mounted here. The ground rung polls it through the session (see
   *  SpiritGroundSession.drivenBody) to follow a claimed avatar. */
  drivenBody(fc: FlightCity): { x: number; y: number; fx: number; fy: number } | null;
  /** Shared ground/content streaming keyed on the camera (streamGround). */
  streamGround(camPos: THREE.Vector3, dt: number, now: number): { near: { entry: FlightCity; distM: number } | null };
  /** Bake/region force gates — a veil message while terrain loads, else null. */
  forceGates(camPos: THREE.Vector3): string | null;
  /** Raycast the DRAWN world (streamed terrain chunks + road ribbons) along
   *  an arbitrary ray, or null when nothing is hit within `far` metres. The
   *  ground-mode cursor rides this: the spark must sit on the pixel the
   *  pointer is on, i.e. on the RENDERED ground — the analytic surface and
   *  the LOD mesh can disagree by metres. */
  castGroundRay?(origin: THREE.Vector3, dir: THREE.Vector3, far: number): THREE.Vector3 | null;
}

const _local = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _e = new THREE.Vector3();
const _n = new THREE.Vector3();
const _u = new THREE.Vector3();
const _pickLocal = new THREE.Vector3();
const _sparkLocal = new THREE.Vector3();
const _sphDir = new THREE.Vector3();
const _spinAxis = new THREE.Vector3();
const _sphWorld = new THREE.Vector3();
/** Ground-cursor ray reach (m) — far enough for a horizon-ish gaze from the
 *  chase camera, short enough to prune the raycast via bounding spheres. */
const GROUND_CURSOR_FAR = 600;

/** CO-ROTATION regime exponent: the drone tracks the spinning surface with
 *  weight `w = (R/r)^N`, r = R + altitude. The same body-proximity idiom the
 *  flight sim uses for warp inhibition (flight-config WARP_INHIBITION_POWER),
 *  chosen over the two neighbouring curves on purpose: gravity `influence` is
 *  a HILL-SPHERE ramp (still ~0.99 at the drone's max altitude — it would
 *  never release), and atmospheric density is identically 0 on airless bodies,
 *  which spin just the same. N=2 gives w≈0.9997 at 1 km, 0.25 at r=2R, ≈0.08
 *  at the max altitude — surface-locked where you read terrain, near-inertial
 *  where you read the planet as an object. */
const CO_ROT_POWER = 2;

/** Terrain radius (sea-level radius + ground height) under a WORLD direction. */
function terrainRadiusAt(body: CelestialBody, worldDir: THREE.Vector3): number {
  _local.copy(worldDir).applyQuaternion(body.inverseOrientation).normalize();
  const gh = Math.max(0, body.geography?.surface.heightAt([_local.x, _local.y, _local.z]) ?? 0);
  return body.radius + gh;
}

export function createPlanetSpiritProvider(deps: PlanetProviderDeps): SpiritFrameProvider {
  const { camera, flight, body, drone } = deps;
  const sessions = new Map<number, SpiritTownSession>();
  /** DIAGNOSTICS: last frame's `groundSpark` exit — see `debugCursor`. */
  let cursorDbg = "-";

  // WORLD-frame dart verdict for the cursor. The spark group rides the CAMERA
  // (easing survives the floating-origin rebase), but that makes the internal
  // camera-local jump detector alias CAMERA MOTION into "the target jumped" —
  // at 50 m a 0.01 rad/frame yaw is half a metre of camera-local displacement,
  // so steering dart-stormed the core to size 0 (the border flicker; the
  // "hidden" ground spark). Consecutive targets are compared in BODY-LOCAL
  // coords instead (spin-fixed, rebase-stable — the planet frame, where the
  // cursor actually lives) and setTarget requires BOTH verdicts to dart.
  const _cursorNowLocal = new THREE.Vector3();
  const _cursorPrevLocal = new THREE.Vector3();
  let cursorPrevHas = false;
  // A DART MEANS A SACCADE — the gaze jumped to something new — never the
  // ordinary sweep of a moving pointer. This used to be a flat 0.5 m in world
  // space, which at a ~20 m viewing distance is under 1.5° of view: every
  // frame of normal mouse movement cleared it, so the spark dart-STORMED —
  // shrink→dart→grow forever, core pinned near 0, which reads on screen as a
  // cursor glued to the pointer rather than a light flying through the world.
  // Judge it ANGULARLY at the eye instead: half a metre means something very
  // different 2 m away than 20 m away, and the player's sense of "it jumped"
  // is angular. Keep a small absolute floor so tiny nudges never dart.
  const CURSOR_JUMP_RAD = 0.14; // ≈8° of view crossed in ONE frame = a jump
  const CURSOR_JUMP_MIN_M = 0.5;
  function cursorWorldJump(worldPos: THREE.Vector3): boolean {
    _cursorNowLocal.copy(worldPos).sub(body.worldPosition).applyQuaternion(body.inverseOrientation);
    let jumped = false;
    if (cursorPrevHas) {
      const step = Math.sqrt(_cursorNowLocal.distanceToSquared(_cursorPrevLocal));
      const eye = Math.max(1, camera.position.distanceTo(worldPos));
      jumped = step > CURSOR_JUMP_MIN_M && step / eye > CURSOR_JUMP_RAD; // small-angle
    }
    _cursorPrevLocal.copy(_cursorNowLocal);
    cursorPrevHas = true;
    return jumped;
  }

  /** DEBUG SEAT LIFT (`__spark.nudge(m)`): extra metres along the local up
   *  under the cursor. The decisive A/B for "buried by a thin margin" versus
   *  "depth comparison is broken" — if lifting the seat a few metres makes the
   *  spark appear with depth ON, the seat offset is the bug. */
  const dbgLift = (): number =>
    (globalThis as unknown as { __sparkLift?: number }).__sparkLift ?? 0;
  /** How far above the drawn hit the cursor sits. Thin by design so the spark
   *  reads as resting ON the ground — but see the LOD-skin caveat. */
  const SPARK_SEAT_M = 0.4;

  const groundHAt = (localDir: THREE.Vector3): number =>
    Math.max(0, body.geography?.surface.heightAt([localDir.x, localDir.y, localDir.z]) ?? 0);

  /** Gaze NDC → a world hit on the tangent plane at `centre` (normal `up`),
   *  within `townR·1.25` — the town-scale pick plane (the planet-radius sphere
   *  grazes wildly from the tilted orbit camera). Camera matrixWorld must be
   *  CURRENT (post-rebase). */
  function tangentHit(ndcX: number, ndcY: number, centre: THREE.Vector3, up: THREE.Vector3, townR: number): THREE.Vector3 | null {
    _ray.setFromCamera(_ndc.set(ndcX, ndcY), camera);
    const o = _ray.ray.origin;
    const d = _ray.ray.direction;
    const denom = d.dot(up);
    if (denom > -1e-6) return null;
    const t = _hit.copy(centre).sub(o).dot(up) / denom;
    if (t <= 0) return null;
    _hit.copy(d).multiplyScalar(t).add(o);
    if (_hit.distanceTo(centre) > townR * 1.25) return null;
    return _hit;
  }

  function makeSession(fc: FlightCity): SpiritTownSession {
    const centreDir = new THREE.Vector3(fc.city.dir[0], fc.city.dir[1], fc.city.dir[2]).normalize();

    const centreChart = () => createSurfaceChart(body, centreDir, groundHAt(centreDir));

    const chartAt = (x: number, z: number): SpiritChartFrame => {
      if (Math.abs(x) < 1e-6 && Math.abs(z) < 1e-6) return centreChart();
      // Walk the chart offset in WORLD, drop back to a body-local dir, and
      // stand a fresh chart there (exact — no small-angle assumption).
      const c0 = centreChart();
      c0.toWorld(x, z, 0, _hit);
      _pickLocal.copy(_hit).sub(body.worldPosition).applyQuaternion(body.inverseOrientation).normalize();
      const dir = _pickLocal.clone();
      return createSurfaceChart(body, dir, groundHAt(dir));
    };

    const townR = (): number => {
      const plan = deps.townPlan(fc);
      return plan ? Math.max(200, plan.radius) : 800;
    };

    const pick = (ndcX: number, ndcY: number, kind: "district" | "building"): SpiritFocusTarget | null => {
      const chart = centreChart();
      const hit = tangentHit(ndcX, ndcY, chart.origin, chart.up, townR());
      if (!hit) return null;
      const local = chart.fromWorld(hit, _pickLocal); // (x = east, z = north) = PLAN coords
      if (kind === "district") {
        return {
          kind, x: local.x, z: local.z,
          radius: THREE.MathUtils.clamp(townR() * 0.33, 30, 160),
        };
      }
      const plan = deps.townPlan(fc);
      if (!plan) return null;
      let bestD = Infinity;
      let bestHalf = 0;
      let bestLot: { dx: number; dy: number; w: number; h: number } | null = null;
      const consider = (lot: { dx: number; dy: number; w: number; h: number }): void => {
        const cx = lot.dx + lot.w / 2;
        const cz = lot.dy + lot.h / 2;
        const dd = (cx - local.x) ** 2 + (cz - local.z) ** 2;
        if (dd < bestD) {
          bestD = dd;
          bestHalf = Math.max(lot.w, lot.h) / 2;
          bestLot = lot;
        }
      };
      for (const ho of plan.houses) consider(ho);
      for (const wk of plan.works) consider(wk);
      if (!bestLot) return null;
      // Reject a gaze that isn't actually near a lot (streets / gaps).
      if (Math.sqrt(bestD) > bestHalf + 14) return null;
      const lot = bestLot as { dx: number; dy: number; w: number; h: number };
      return {
        kind, x: lot.dx + lot.w / 2, z: lot.dy + lot.h / 2,
        radius: THREE.MathUtils.clamp(bestHalf * 1.8, 6, 22),
        frame: deps.buildingFrame(lot),
      };
    };

    return {
      label: deps.cityLabel(fc),
      radius: townR,
      chartAt,
      pickDistrict: (x, y) => pick(x, y, "district"),
      pickBuilding: (x, y) => pick(x, y, "building"),
      structureHost: () => deps.structureHost(fc),
    };
  }

  let lastNear: { entry: FlightCity; distM: number } | null = null;

  return {
    scopeLevel: "flight",
    camera,
    viewSize: () => ({ w: deps.viewEl.clientWidth || 1, h: deps.viewEl.clientHeight || 1 }),

    advance(dt) {
      flight.advanceWorld(dt);
      // CO-ROTATION. `advanceWorld` just turned body.orientation, and the
      // drone rides a WORLD direction while the terrain under it is sampled
      // planet-LOCAL (terrainRadiusAt) — so without this the ground slides
      // beneath the drone at ωR, a CONSTANT m/s that the altitude-linear
      // steering law (FWD_SPEED·alt) merely outruns while high. The two cross
      // at ~840 m on an Earth-sized body: below that the spin won, and the
      // controls felt like they ran away.
      //
      // A body-local point `d` sits at world `orientation·d`, so holding one
      // across the spin step means rotating the drone's world direction about
      // `orientation·axis` by +rate·dt. Weighting that by `w` blends between a
      // surface-locked frame (w=1) and a fully inertial one (w=0).
      if (body.rotation.rate !== 0 && dt > 0) {
        const w = Math.pow(body.radius / (body.radius + drone.altitude), CO_ROT_POWER);
        _spinAxis.copy(body.rotation.axis).applyQuaternion(body.orientation);
        drone.precess(_spinAxis, body.rotation.rate * dt * w);
      }
      // The spirit has NO body — force the flight walker hidden every frame.
      flight.avatarObject.visible = false;
      deps.spark.update(dt);
    },

    rebaseOnCamera(camWorldAbs) {
      const h = deps.viewEl.clientHeight || 1;
      const fovRad = (camera.fov * Math.PI) / 180;
      const nf = flight.stepStreaming(camWorldAbs, camWorldAbs, h, fovRad);
      return { near: nf.near, far: nf.far, camAtOrigin: true };
    },

    postFrame(dt, now): SpiritPostFrame {
      const h = deps.viewEl.clientHeight || 1;
      const fovRad = (camera.fov * Math.PI) / 180;
      flight.stepSky(camera, dt, h, fovRad);
      const { near } = deps.streamGround(camera.position, dt, now);
      lastNear = near;
      const waiting = deps.forceGates(camera.position);
      let nearTown: SpiritNearTown | null = null;
      if (near) {
        const plan = deps.townPlan(near.entry);
        nearTown = {
          ref: near.entry,
          label: deps.cityLabel(near.entry),
          distM: near.distM,
          radius: plan ? Math.max(200, plan.radius) : 800,
        };
      }
      return { nearTown, waiting };
    },

    openTown(ref) {
      const fc = ref as FlightCity;
      let s = sessions.get(fc.city.cell);
      if (!s) {
        s = makeSession(fc);
        sessions.set(fc.city.cell, s);
      }
      return s;
    },

    openGround(worldPos, townRef): SpiritGroundSession {
      // TOWN = CONTENT, refreshed by the ladder as the glide moves (setTown).
      // Every content lookup below reads townNow — never the entry parameter,
      // which is only the initial value.
      let townNow: FlightCity | null = (townRef as FlightCity | undefined) ?? null;
      const dir0 = worldPos.clone().sub(body.worldPosition)
        .applyQuaternion(body.inverseOrientation).normalize();
      const h0 = groundHAt(dir0);
      const anchor = () => createSurfaceChart(body, dir0, h0);
      const dirAt = (x: number, z: number): THREE.Vector3 => {
        const c0 = anchor();
        const p = c0.toWorld(x, z, 0, new THREE.Vector3());
        return p.sub(body.worldPosition).applyQuaternion(body.inverseOrientation).normalize();
      };
      return {
        chartAt(x, z) {
          if (Math.abs(x) < 1e-6 && Math.abs(z) < 1e-6) return anchor();
          const dir = dirAt(x, z);
          return createSurfaceChart(body, dir, groundHAt(dir));
        },
        groundY(x, z) {
          // The TRUE terrain point under (x,z), expressed in the anchor
          // chart's y (curvature included — the glide rides real ground).
          const c0 = anchor();
          const dir = dirAt(x, z);
          const q = dir.clone().multiplyScalar(body.radius + groundHAt(dir))
            .applyQuaternion(body.orientation).add(body.worldPosition);
          return c0.fromWorld(q, new THREE.Vector3()).y;
        },
        setTown(ref) {
          townNow = (ref as FlightCity | null) ?? null;
        },
        // SPHERE OPS — the ground rung's curved-surface backend. loc = the
        // BODY-LOCAL UNIT DIRECTION of the surface point: rebase-safe, and
        // rooted on the PLANET, never on a town or a landing anchor. The
        // legacy chartAt/groundY members above stay for town-scale consumers;
        // the ladder prefers these.
        sphere: {
          locFromWorld: (p, out) =>
            out.copy(p).sub(body.worldPosition)
              .applyQuaternion(body.inverseOrientation).normalize(),
          surfaceAt: (loc, out) =>
            out.copy(loc).multiplyScalar(body.radius + groundHAt(loc))
              .applyQuaternion(body.orientation).add(body.worldPosition),
          frameAt: (loc) => createSurfaceChart(body, loc.clone(), groundHAt(loc)),
          move(loc, e, n, out) {
            // Walk the LOCAL tangent frame, then drop back to the sphere —
            // exact great-circle transport for the small per-frame steps the
            // glide takes (and fine for the ≤ gaze-range hops).
            const c = createSurfaceChart(body, loc.clone(), groundHAt(loc));
            const p = c.toWorld(e, n, 0, new THREE.Vector3());
            return out.copy(p).sub(body.worldPosition)
              .applyQuaternion(body.inverseOrientation).normalize();
          },
          heightAbove(p) {
            _sphDir.copy(p).sub(body.worldPosition)
              .applyQuaternion(body.inverseOrientation).normalize();
            return p.distanceTo(body.worldPosition) - (body.radius + groundHAt(_sphDir));
          },
          buildingAt(loc) {
            const fc = townNow;
            if (!fc) return null;
            const plan = deps.townPlan(fc);
            if (!plan) return null;
            const p = _sphWorld.copy(loc).multiplyScalar(body.radius + groundHAt(loc))
              .applyQuaternion(body.orientation).add(body.worldPosition);
            const centreDir = new THREE.Vector3(fc.city.dir[0], fc.city.dir[1], fc.city.dir[2]).normalize();
            const tc = createSurfaceChart(body, centreDir, groundHAt(centreDir));
            const local = tc.fromWorld(p, new THREE.Vector3()); // PLAN coords
            const MARGIN = 0.5;
            const test = (lot: { dx: number; dy: number; w: number; h: number }): boolean =>
              local.x >= lot.dx + MARGIN && local.x <= lot.dx + lot.w - MARGIN &&
              local.z >= lot.dy + MARGIN && local.z <= lot.dy + lot.h - MARGIN;
            for (const lot of [...plan.houses, ...plan.works]) {
              if (!test(lot)) continue;
              const half = Math.max(lot.w, lot.h) / 2;
              return {
                town: fc,
                target: {
                  kind: "building",
                  x: lot.dx + lot.w / 2,
                  z: lot.dy + lot.h / 2,
                  radius: THREE.MathUtils.clamp(half * 1.8, 6, 22),
                  frame: deps.buildingFrame(lot),
                },
              };
            }
            return null;
          },
          placeAvatar(loc) {
            // loc → world → PLAN (town-centre chart) → SIM (plaza
            // registration) → the live town's hidden gaze walker. The TOWN
            // does the converting at its own boundary — content, not frame.
            const fc = townNow;
            if (!fc) return;
            const host = deps.structureHost(fc);
            const off = deps.townSimOffset(fc);
            if (!host || !off) return;
            const p = _sphWorld.copy(loc).multiplyScalar(body.radius + groundHAt(loc))
              .applyQuaternion(body.orientation).add(body.worldPosition);
            const centreDir = new THREE.Vector3(fc.city.dir[0], fc.city.dir[1], fc.city.dir[2]).normalize();
            const tc = createSurfaceChart(body, centreDir, groundHAt(centreDir));
            const local = tc.fromWorld(p, new THREE.Vector3());
            host.placeGazeAvatar(local.x + off.x, local.z + off.y);
          },
          drivenBody() {
            // SIM → PLAN → world → loc; the heading crosses charts through a
            // short world-space step (two tangent frames differ by the
            // curvature between them — components must not be copied raw).
            const fc = townNow;
            if (!fc) return null;
            const b = deps.drivenBody(fc);
            const off = deps.townSimOffset(fc);
            if (!b || !off) return null;
            const centreDir = new THREE.Vector3(fc.city.dir[0], fc.city.dir[1], fc.city.dir[2]).normalize();
            const tc = createSurfaceChart(body, centreDir, groundHAt(centreDir));
            const px = b.x - off.x;
            const pz = b.y - off.y;
            const q = tc.toWorld(px, pz, 0, new THREE.Vector3());
            const loc = q.clone().sub(body.worldPosition)
              .applyQuaternion(body.inverseOrientation).normalize();
            const EPS = 0.5;
            const ahead = tc.toWorld(px + b.fx * EPS, pz + b.fy * EPS, 0, new THREE.Vector3());
            const f = createSurfaceChart(body, loc.clone(), groundHAt(loc));
            ahead.sub(q);
            let fx = ahead.dot(f.east);
            let fz = ahead.dot(f.north);
            const l = Math.hypot(fx, fz);
            if (l > 1e-6) { fx /= l; fz /= l; } else { fx = 0; fz = 1; }
            return { loc, fx, fz };
          },
        },
        buildingAt(x, z) {
          const fc = townNow;
          if (!fc) return null;
          const plan = deps.townPlan(fc);
          if (!plan) return null;
          const c0 = anchor();
          const p = c0.toWorld(x, z, 0, new THREE.Vector3());
          const centreDir = new THREE.Vector3(fc.city.dir[0], fc.city.dir[1], fc.city.dir[2]).normalize();
          const tc = createSurfaceChart(body, centreDir, groundHAt(centreDir));
          const local = tc.fromWorld(p, new THREE.Vector3()); // PLAN coords
          const MARGIN = 0.5; // stepping through a wall counts once truly inside
          const test = (lot: { dx: number; dy: number; w: number; h: number }): boolean =>
            local.x >= lot.dx + MARGIN && local.x <= lot.dx + lot.w - MARGIN &&
            local.z >= lot.dy + MARGIN && local.z <= lot.dy + lot.h - MARGIN;
          for (const lot of [...plan.houses, ...plan.works]) {
            if (!test(lot)) continue;
            const half = Math.max(lot.w, lot.h) / 2;
            return {
              town: fc,
              target: {
                kind: "building",
                x: lot.dx + lot.w / 2,
                z: lot.dy + lot.h / 2,
                radius: THREE.MathUtils.clamp(half * 1.8, 6, 22),
                frame: deps.buildingFrame(lot),
              },
            };
          }
          return null;
        },
        placeAvatar(x, z) {
          // The glide IS the invisible avatar: session-local → world → PLAN
          // (town-centre chart) → SIM (plaza registration) → the live town's
          // hidden gaze walker. No live town mounted yet ⇒ nothing to park.
          const fc = townNow;
          if (!fc) return;
          const host = deps.structureHost(fc);
          const off = deps.townSimOffset(fc);
          if (!host || !off) return;
          const c0 = anchor();
          const p = c0.toWorld(x, z, 0, new THREE.Vector3());
          const centreDir = new THREE.Vector3(fc.city.dir[0], fc.city.dir[1], fc.city.dir[2]).normalize();
          const tc = createSurfaceChart(body, centreDir, groundHAt(centreDir));
          const local = tc.fromWorld(p, new THREE.Vector3());
          host.placeGazeAvatar(local.x + off.x, local.z + off.y);
        },
        drivenBody() {
          // The inverse of placeAvatar's mapping: SIM → PLAN (drop the plaza
          // registration) → world → session-local.
          const fc = townNow;
          if (!fc) return null;
          const b = deps.drivenBody(fc);
          const off = deps.townSimOffset(fc);
          if (!b || !off) return null;
          const c0 = anchor();
          const centreDir = new THREE.Vector3(fc.city.dir[0], fc.city.dir[1], fc.city.dir[2]).normalize();
          const tc = createSurfaceChart(body, centreDir, groundHAt(centreDir));
          const px = b.x - off.x;
          const pz = b.y - off.y;
          const at = c0.fromWorld(tc.toWorld(px, pz, 0, new THREE.Vector3()), new THREE.Vector3());
          // FACING goes through a short step on the PLAN chart rather than
          // straight across: the two charts are tangent planes at different
          // points on a sphere, so their bases differ by the curvature between
          // them — a heading copied component-wise would slowly skew.
          const EPS = 0.5;
          const ahead = c0.fromWorld(
            tc.toWorld(px + b.fx * EPS, pz + b.fy * EPS, 0, new THREE.Vector3()),
            new THREE.Vector3(),
          );
          let dx = ahead.x - at.x;
          let dz = ahead.z - at.z;
          const l = Math.hypot(dx, dz);
          if (l > 1e-6) { dx /= l; dz /= l; } else { dx = 0; dz = 1; }
          return { x: at.x, z: at.z, fx: dx, fz: dz };
        },
      };
    },

    flight: {
      drone,
      radius: body.radius,
      minAlt: deps.minAlt,
      maxAlt: deps.maxAlt,
      screenToChart(px, py) {
        const w = deps.viewEl.clientWidth || 1;
        const h = deps.viewEl.clientHeight || 1;
        const ndcx = (px / w) * 2 - 1;
        const ndcy = -((py / h) * 2 - 1);
        _ray.setFromCamera(_ndc.set(ndcx, ndcy), camera);
        const o = _ray.ray.origin;
        const d = _ray.ray.direction;
        _hit.copy(o).sub(body.worldPosition);
        const b = _hit.dot(d);
        const c = _hit.dot(_hit) - body.radius * body.radius;
        const disc = b * b - c;
        if (disc < 0) return null;
        const t = -b - Math.sqrt(disc);
        if (t < 0) return null;
        drone.basis(_e, _n, _u);
        _hit.copy(d).multiplyScalar(t).add(o).sub(body.worldPosition).normalize();
        return { x: body.radius * _hit.dot(_e), y: body.radius * _hit.dot(_n) };
      },
      groundPoint(out) {
        return drone.groundPoint(body.worldPosition, terrainRadiusAt(body, drone.pos), out);
      },
      stepStreaming(anchor, camWorld) {
        const h = deps.viewEl.clientHeight || 1;
        const fovRad = (camera.fov * Math.PI) / 180;
        return flight.stepStreaming(anchor, camWorld, h, fovRad);
      },
      placeCamera() {
        drone.place(camera);
      },
    },

    spark(pos, hovering = false, select = 0) {
      // CAMERA-FRAME spark: the spark group rides the camera (main.ts parents
      // it there), so its dart/follow easing happens in camera-local space —
      // the floating-origin rebase (and flight speed) can't leave last
      // frame's eased position kilometres behind (the "darts into the sky").
      // Dart decisions come from the PLANET frame (cursorWorldJump).
      deps.spark.setSelect(select);
      if (pos) {
        const jumped = cursorWorldJump(pos);
        camera.updateMatrixWorld(true);
        _sparkLocal.copy(pos);
        // Debug seat lift applies to the HOST-REPORTED cursor too (the town
        // path), which is where the burial question actually lives.
        const lift = dbgLift();
        if (lift !== 0) {
          _sphDir.copy(pos).sub(body.worldPosition).normalize();
          _sparkLocal.addScaledVector(_sphDir, lift);
        }
        camera.worldToLocal(_sparkLocal);
        deps.spark.setTarget(_sparkLocal.x, _sparkLocal.y, _sparkLocal.z, hovering, jumped);
      } else {
        cursorPrevHas = false; // a re-show must appear in place, never dart in
        deps.spark.hide();
      }
    },

    sparkDrift(vel) {
      // Straight through: the ladder already speaks this spark's frame. The
      // group rides the camera (see `spark` above), so a camera-local velocity
      // IS a group-local one — no conversion, and none would be right anyway,
      // since the vector is an invented screen-scaled fiction rather than any
      // world velocity (the real one is hundreds of m/s and invisible).
      deps.spark.setDrift(vel);
    },

    groundSpark(pointer) {
      // GROUND cursor = the pointer ray's hit on the DRAWN world — identical
      // discipline to a live town host's engine cursor, so ground mode reads
      // the same with or without a town. By construction the spark cannot
      // leave the pixel the player is gazing at: it does not consume the
      // analytic gaze march at all (that keeps steering the glide).
      if (!deps.castGroundRay) {
        cursorDbg = "nocast";
        return false;
      }
      if (!pointer) {
        // NO POINTER this frame — the ladder passed null. In the wilderness
        // this is the difference between "the cursor missed" and "nothing ever
        // asked for a cursor"; they look identical on screen (no spark).
        cursorDbg = "noptr";
        cursorPrevHas = false;
        deps.spark.hide();
        return true;
      }
      const w = deps.viewEl.clientWidth || 1;
      const h = deps.viewEl.clientHeight || 1;
      camera.updateMatrixWorld(true);
      _ray.setFromCamera(
        _ndc.set((pointer.x / w) * 2 - 1, -((pointer.y / h) * 2 - 1)),
        camera,
      );
      const hit = deps.castGroundRay(_ray.ray.origin, _ray.ray.direction, GROUND_CURSOR_FAR);
      if (!hit) {
        // Horizon/sky gaze: nothing drawn under the pointer — hide rather
        // than float a cursor in the air. In OPEN WILDERNESS this is the prime
        // suspect: a miss here is indistinguishable on screen from the spark
        // never being placed, and the cast targets a mesh list that streaming
        // mounts/unmounts under the glide (see castDrawnGround's cache).
        cursorDbg = "MISS";
        cursorPrevHas = false;
        deps.spark.hide();
        return true;
      }
      _sphDir.copy(hit).sub(body.worldPosition).normalize();
      _sparkLocal.copy(hit).addScaledVector(_sphDir, SPARK_SEAT_M + dbgLift());
      const jumped = cursorWorldJump(_sparkLocal);
      camera.worldToLocal(_sparkLocal);
      // No dwell bloom yet on the ground rung. It used to be fed by the town
      // host, which is the same frame leak as taking the position from it: a
      // dwell is progress toward selecting a PLANET object, so it must come
      // from the planet's own interaction over the entity under the ray.
      // TODO(planet-entity-store): drive select from the planet-side dwell
      // once loaded entities are addressed on the body (PLANET_ENTITY_PLAN
      // step 4) — NOT by reaching back into a town host.
      deps.spark.setSelect(0);
      deps.spark.setTarget(_sparkLocal.x, _sparkLocal.y, _sparkLocal.z, false, jumped);
      // Hit distance from the eye: a plausible ground cursor is metres-to-tens
      // away. A huge value means the ray skimmed to a far chunk (grazing gaze).
      cursorDbg = `hit d${_sparkLocal.length().toFixed(1)}`;
      return true;
    },

    debugCursor() {
      return cursorDbg;
    },
  };
}
