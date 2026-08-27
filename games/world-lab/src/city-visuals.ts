/**
 * CITY VISUALS — the town's SHAPE made visible from the sky. Once the
 * approach loader has fast-forwarded a city's town (city-towns.ts), its
 * street plan is real data — so the flight scene shows the actual town:
 * street ribbons, every house (with storeys and a door) and workplace at
 * its planned footprint, fields around the edge.
 *
 * The town PLAN is flat (streets/lots are planar meters — same manifold
 * Riverside plays on; sphere curvature over a town radius is centimetres),
 * but the TERRAIN is not: every building, road vertex and field slab is
 * CONFORMED to the planet surface through the `TownGround` sampler — bases
 * sink into the real ground instead of the whole town floating on a disc
 * (the old ground apron z-fought the terrain LOD and read as a coin from
 * orbit; it's gone).
 *
 * Instanced boxes — one draw call per category — parented planet-local so
 * the planet's spin carries the town.
 */
import * as THREE from "three";
import type { TownPlan } from "@shared/world-engine/kernel/town/plan";
import type { RoadPath } from "@shared/world-engine/types";
import { litMaterial, roadMaterial } from "@shared/world-engine/materials";

const WALL_H = 3.2;   // metres per storey — matches the walkable town's read
const SINK = 0.6;     // how far a base sinks below the sampled ground
const ROAD_LIFT = 0.22;

/** Terrain height in TOWN-LOCAL y at a local (x, z), relative to the town
 *  origin (the city-center ground point). Provided by the host, which owns
 *  the planet surface and the tangent frame. */
export type TownGround = (x: number, z: number) => number;

interface BoxSpec {
  cx: number; cz: number; w: number; d: number; h: number;
  yaw?: number; color: string;
}

function instancedBoxes(specs: BoxSpec[], ground: TownGround, roughness: number): THREE.InstancedMesh | null {
  if (!specs.length) return null;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  // No colour here — the InstancedMesh drives per-instance colour below.
  const mat = litMaterial({ roughness });
  const mesh = new THREE.InstancedMesh(geo, mat, specs.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  specs.forEach((s, i) => {
    q.setFromAxisAngle(up, s.yaw ?? 0);
    const gy = ground(s.cx, s.cz);
    m.compose(
      new THREE.Vector3(s.cx, gy - SINK + s.h / 2, s.cz),
      q,
      new THREE.Vector3(s.w, s.h, s.d),
    );
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, col.set(s.color));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

/** Door position + facing on a footprint edge (plan convention: door edge
 *  names the street-facing side; +y plan → +z local). */
function doorSpec(
  b: { dx: number; dy: number; w: number; h: number; door: "north" | "south" | "east" | "west" },
): BoxSpec {
  const DOOR = { w: 1.6, h: 2.3, d: 0.3, color: "#3b2f24" };
  let cx = b.dx + b.w / 2;
  let cz = b.dy + b.h / 2;
  let yaw = 0;
  switch (b.door) {
    case "north": cz = b.dy; yaw = 0; break;
    case "south": cz = b.dy + b.h; yaw = 0; break;
    case "east": cx = b.dx + b.w; yaw = Math.PI / 2; break;
    case "west": cx = b.dx; yaw = Math.PI / 2; break;
  }
  return { cx, cz, w: DOOR.w, d: DOOR.d, h: DOOR.h, yaw, color: DOOR.color };
}

/** Street ribbons conformed to the terrain — the same organic street tree
 *  the walkable town paints, as flat quads hugging the ground. */
function roadMesh(roads: RoadPath[], center: { x: number; y: number }, ground: TownGround): THREE.Mesh | null {
  const positions: number[] = [];
  const indices: number[] = [];
  const SEG = 14; // max metres between conformed samples
  for (const road of roads) {
    for (let i = 0; i + 1 < road.points.length; i++) {
      const a = road.points[i];
      const b = road.points[i + 1];
      const ax = a.x - center.x, az = a.y - center.y;
      const bx = b.x - center.x, bz = b.y - center.y;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-3) continue;
      const nx = -(bz - az) / len, nz = (bx - ax) / len; // left normal
      const hw = road.width / 2;
      const steps = Math.max(1, Math.ceil(len / SEG));
      let prevL = -1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = ax + (bx - ax) * t;
        const pz = az + (bz - az) * t;
        const y = ground(px, pz) + ROAD_LIFT;
        const base = positions.length / 3;
        positions.push(px + nx * hw, y, pz + nz * hw, px - nx * hw, y, pz - nz * hw);
        if (prevL >= 0) indices.push(prevL, base, prevL + 1, base, base + 1, prevL + 1);
        prevL = base;
      }
    }
  }
  if (!positions.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, roadMaterial(0x9a8a6e));
  mesh.name = "roads";
  return mesh;
}

/** The static town's handle: the mesh group + the LIVE-HANDOFF control.
 *  The live town streams REAL buildings in a ~100 m window around the walker
 *  (town-stage STRUCT_LOAD_R/UNLOAD_R); everything outside that window has NO
 *  live body — so the static plan must hand off BUILDING BY BUILDING, hiding
 *  exactly the instances the live layer has materialized and keeping the rest
 *  standing. (Hiding the whole plan at once left a town of nothing but the
 *  few live buildings near the player.) */
export interface TownMeshView {
  group: THREE.Group;
  /** Live handoff, driven by THE STREAMER'S OWN LOADED SET (town-stage
   *  loadedLots) — one variable per building decides which of the two
   *  rendering modes shows: a lot in the set hides its static instance (its
   *  live twin is materialized); a lot outside it stands static. Never both
   *  (z-fighting doors), never neither (holes) — the old distance-window
   *  mirror kept separate hysteresis state and drifted. Static STREETS hide
   *  whenever the live town is mounted (it paints its whole road network at
   *  once). `null` = no live town: everything static returns. */
  setLiveLots(loaded: { houses: ReadonlySet<number>; works: ReadonlySet<number> } | null): void;
  /** DIAGNOSTICS: how many static instances are currently hidden. */
  debugHandoff(): string;
}

const HIDE_M = new THREE.Matrix4().makeScale(0, 0, 0);

/** Build a town's visible shape in LOCAL coords: +Y up (outward), plan
 *  x → +X, plan y → +Z, origin at the town center on the ground. */
export function buildTownMesh(
  plan: TownPlan,
  roads: RoadPath[],
  center: { x: number; y: number },
  ground: TownGround,
): TownMeshView {
  const group = new THREE.Group();
  group.name = `town:${plan.key}`;

  const streets = roadMesh(roads, center, ground);
  if (streets) group.add(streets);

  // Fields draw NOTHING here any more (bridge round R1a): they are TERRAIN
  // VERTEX PAINT now — main.ts paintTownFields sets the plan's rects on the
  // body's field-paint index (planet/field-paint.ts, the route-paint family)
  // and repaints the standing chunks. The old instanced slab z-hovered the
  // ground and read as a green coin from the approach.

  const buildings = instancedBoxes(
    [
      ...plan.houses.map(h => ({
        cx: h.dx + h.w / 2, cz: h.dy + h.h / 2,
        w: h.w, d: h.h, h: SINK + WALL_H * Math.max(1, h.floors), color: h.color,
      })),
      ...plan.works.map(w => ({
        cx: w.dx + w.w / 2, cz: w.dy + w.h / 2,
        w: w.w, d: w.h, h: SINK + WALL_H * 1.4, color: w.color,
      })),
    ],
    ground,
    0.85,
  );
  if (buildings) group.add(buildings);

  // Doors — a dark inset on each street-facing wall (Riverside's renderer
  // cuts real doorway gaps; a flight-scene town reads right with the mark).
  // SAME ORDER as `buildings` (houses then works) — instance i is building i's
  // door, so the live handoff hides them as one.
  const doors = instancedBoxes(
    [...plan.houses, ...plan.works].map(b => {
      const d = doorSpec(b);
      return { ...d, h: SINK + d.h };
    }),
    ground,
    0.9,
  );
  if (doors) group.add(doors);

  // ── Live handoff state: per-instance lot identity + base matrices ────────
  // Instance order mirrors the mesh build above: houses (by array order,
  // identified by their plan `index`) then works (by array position).
  const lotCount = plan.houses.length + plan.works.length;
  const hidden: boolean[] = new Array(lotCount).fill(false);
  const baseB: THREE.Matrix4[] = [];
  const baseD: THREE.Matrix4[] = [];
  for (let i = 0; i < lotCount; i++) {
    const mb = new THREE.Matrix4();
    if (buildings) buildings.getMatrixAt(i, mb);
    baseB.push(mb);
    const md = new THREE.Matrix4();
    if (doors) doors.getMatrixAt(i, md);
    baseD.push(md);
  }

  const setLiveLots: TownMeshView["setLiveLots"] = (loaded) => {
    if (streets) streets.visible = loaded === null;
    let changed = false;
    for (let i = 0; i < lotCount; i++) {
      const wantHidden = loaded !== null && (
        i < plan.houses.length
          ? loaded.houses.has(plan.houses[i]!.index)
          : loaded.works.has(i - plan.houses.length)
      );
      if (wantHidden === hidden[i]) continue;
      hidden[i] = wantHidden;
      if (buildings) buildings.setMatrixAt(i, wantHidden ? HIDE_M : baseB[i]);
      if (doors) doors.setMatrixAt(i, wantHidden ? HIDE_M : baseD[i]);
      changed = true;
    }
    if (changed) {
      if (buildings) buildings.instanceMatrix.needsUpdate = true;
      if (doors) doors.instanceMatrix.needsUpdate = true;
    }
  };

  return {
    group,
    setLiveLots,
    debugHandoff: () =>
      `statHid:${hidden.filter(Boolean).length}/${lotCount} streets:${streets ? (streets.visible ? "on" : "off") : "none"}`,
  };
}

/** Free the town mesh's GPU resources (instanced geometries + materials). */
export function disposeTownMesh(group: THREE.Group): void {
  group.traverse(o => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach(x => x.dispose());
  });
  group.removeFromParent();
}
