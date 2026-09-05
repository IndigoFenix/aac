/**
 * frame-provider.ts — the SEAM between the spirit ladder and the world it
 * flies over (types only).
 *
 * The ladder (ladder.ts) is ONE level state machine —
 *
 *   FLIGHT  >  TOWN (town/district focus depths)  >  GROUND  >  STRUCTURE
 *
 * — whose handlers never touch a concrete world directly: charts, ground,
 * streaming, dwell picks, the dollhouse host and the spark all come through
 * a SpiritFrameProvider. Two providers exist:
 *
 *   • the PLANET provider (games/world-lab/src/spirit/planet-provider.ts:
 *     the flight streaming world — SurfaceChart tangent frames, city plans,
 *     the embedded live town, floating-origin rebases);
 *   • the FLAT provider (a standalone quest-host town/structure: identity
 *     charts — chart coords ARE plan/sim coords — and no streaming).
 *
 * Same handlers, either provider ⇒ moving around a focus behaves
 * IDENTICALLY whether the focus is the whole generated world or nested
 * inside a larger scope (the reorganization's core requirement).
 *
 * GROUND sits ABOVE structure on the ladder (user decision, 2026-07-16):
 * bottom-dwell in the dollhouse ascends INTO ground glide; gliding into a
 * building descends into its dollhouse. A structure-scope game's ceiling is
 * "structure", so ground is unreachable there by the ceiling rule alone.
 */
import type * as THREE from "three";
import type { DroneCamera } from "./drone-camera.js";
import type { SpiritPose } from "./pose.js";

export type SpiritLevel = "flight" | "town" | "ground" | "structure";

/** Ladder rank — ascent to rank r is allowed iff r ≤ rank(ceiling). */
export const LEVEL_RANK: Record<SpiritLevel, number> = {
  flight: 3,
  town: 2,
  ground: 1,
  structure: 0,
};

/** A tangent frame standing at a chart point — world-frame basis + origin in
 *  the CURRENT rebase frame. Planet providers rebuild it per call (the body
 *  spins/orbits and the origin rebases); flat providers return a constant
 *  identity frame at (x, 0, z). */
export interface SpiritChartFrame {
  origin: THREE.Vector3;
  east: THREE.Vector3;
  north: THREE.Vector3;
  up: THREE.Vector3;
}

/** What a dwell pick resolved to — the next focus down the ladder, in
 *  chart-local metres FROM THE TOWN CENTRE. */
export interface SpiritFocusTarget {
  kind: "district" | "building";
  x: number;
  z: number;
  /** Framing radius (orbit distance derives from it). */
  radius: number;
  /** Building footprint in SIM coords (the dollhouse frame) — building picks. */
  frame?: { x: number; y: number; w: number; h: number } | null;
}

/** The nearest enterable town this frame (the FLIGHT→TOWN gate's data). */
export interface SpiritNearTown {
  /** Opaque provider handle (a FlightCity on planets). */
  ref: unknown;
  label: string;
  distM: number;
  /** The town's own plan radius (a fallback until the plan loads). */
  radius: number;
}

/** THE ENTITY ENGINE that resolves the ground cursor — a session whose gaze
 *  pipeline picks the drawn world (walls stop the ray, the hit is the drawn
 *  skin) and snaps to the entity under the pixel. It reports; someone else
 *  draws. Implemented by every quest host (town or wilderness); the ladder
 *  never cares which, only that one is standing where the player is. */
export interface SpiritCursorHost {
  /** Opt the host's OWN spark off — it reports through `cursorWorld` and the
   *  provider's one spark draws it. A host that draws AND reports would put
   *  two cursors on screen. Flat standalone hosts omit both (they draw). */
  setExternalCursor?(on: boolean): void;
  /** The host's computed cursor target (WORLD coords into `out`) + display
   *  state, or null when the pointer rests on nothing. */
  cursorWorld?(out: THREE.Vector3): { hovering: boolean; select: number } | null;
}

/** The structure rung's host — a World3DRenderer-backed session (embedded
 *  live town, or the standalone quest host). POSE ONLY: the ladder owns the
 *  camera; the host must never write it. */
export interface SpiritStructureHost extends SpiritCursorHost {
  /** Flip the dollhouse cutaway (null = off). */
  setSpiritFocus(frame: SpiritFocusTarget["frame"]): void;
  /** The dollhouse rig pose for `frame` at orbit azimuth `spiritAz`, WORLD
   *  coords in the CURRENT rebase frame. Fills the pose; never writes the
   *  camera (render3d.dollhousePose). */
  dollhousePose(frame: SpiritFocusTarget["frame"], spiritAz: number, out: SpiritPose): void;
  /** Park the hidden gaze walker on the focused lot (SIM coords) so
   *  interaction/streaming target it. */
  placeGazeAvatar(x: number, y: number): void;
  setPointer(clientX: number, clientY: number): void;
  clearPointer(): void;
  /** Step the session one frame (no-op when the host self-loops). */
  step(dt: number, now: number): void;
}

/** An OPEN town — the TOWN/STRUCTURE rungs' world access. */
export interface SpiritTownSession {
  label: string;
  /** Live plan radius (grows once the plan loads). */
  radius(): number;
  /** Tangent chart standing at chart-local (x,z) from the town centre. */
  chartAt(x: number, z: number): SpiritChartFrame;
  /** Dwell picks from a gaze NDC (reads the provider camera's CURRENT
   *  matrixWorld — post-rebase). Null = nothing there. */
  pickDistrict(ndcX: number, ndcY: number): SpiritFocusTarget | null;
  pickBuilding(ndcX: number, ndcY: number): SpiritFocusTarget | null;
  /** The dollhouse host once mounted (null until the live town streams in;
   *  always set on flat providers). */
  structureHost(): SpiritStructureHost | null;
  /** The sim's RELEVANCE DISC — the near stand (quest-host `nearStand`): what
   *  the site HAS and what is selectable, chart-local centre + radius. Null
   *  when nothing is mounted or the session bounds no stand. Under the builder
   *  hold this disc IS the district orbit's outer bound (user 2026-09-05: "the
   *  circle should really be close to the outer camera bounds, since that's
   *  the point of it"). Optional: flat providers and city visits leave it out. */
  relevanceDisc?(): { x: number; z: number; radius: number } | null;
}

/** The FLIGHT rung's seam — planet+ scopes only (a flat town has no flight). */
export interface SpiritFlightSeam {
  drone: DroneCamera;
  /** Body radius, metres. */
  radius: number;
  minAlt: number;
  maxAlt: number;
  /** Gaze pixel → the drone's tangent chart (east/north metres), or null
   *  when the ray misses the body. */
  screenToChart(px: number, py: number): { x: number; y: number } | null;
  /** World ground point under the drone at TERRAIN height (pre-rebase). */
  groundPoint(out: THREE.Vector3): THREE.Vector3;
  /** Streaming anchored on `anchor` (MUTATED to the origin); `camWorld` is
   *  the LOD eye. Returns the depth range. */
  stepStreaming(anchor: THREE.Vector3, camWorld: THREE.Vector3): { near: number; far: number };
  /** Place the provider camera from the drone (top-down chase). */
  placeCamera(): void;
}

/** What the provider reports after the camera is placed each frame. */
export interface SpiritPostFrame {
  nearTown: SpiritNearTown | null;
  /** Force-gate veil message (a bake/founding is loading — hold the dive). */
  waiting: string | null;
}

/** A building the glide walked into — the GROUND→STRUCTURE gate's data. */
export interface SpiritGroundBuildingHit {
  /** The town ref owning the building (opens a town session for the
   *  structure rung's context). */
  town: unknown;
  target: SpiritFocusTarget;
}

/** The GROUND rung's world access — a chart anchored where the glide
 *  entered. The ladder re-anchors (a fresh openGround) when the glide
 *  strays far from the anchor. */
/**
 * SPHERE ground ops — the CURVED-SURFACE backend of the ground rung. A
 * location is an opaque, REBASE-SAFE `loc` (THREE.Vector3 carrier): on a
 * planet, the BODY-LOCAL UNIT DIRECTION of the surface point (invariant under
 * the floating-origin rebase). The ladder never interprets a loc — it only
 * round-trips it through these queries, and does its 2D law-math
 * (steer/arrive/dwell) in a rolling tangent frame carried along the glide's
 * own path. There is NO anchor: towns appear only inside buildingAt /
 * placeAvatar content lookups, never as a coordinate root. Flat worlds do NOT
 * implement this — they keep the plain 2D session contract below, and the
 * ladder wraps it in a 2D adapter (a plane is its own tangent frame).
 */
export interface SphereGroundOps {
  /** WORLD point → surface loc (writes and returns `out`). */
  locFromWorld(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  /** TRUE world surface point at `loc` (current render frame — refetch after
   *  any rebase; never cache across frames). Writes and returns `out`. */
  surfaceAt(loc: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  /** Tangent frame standing ON the surface at `loc` (origin = surfaceAt). */
  frameAt(loc: THREE.Vector3): SpiritChartFrame;
  /** Transport `loc` east/north metres ALONG the surface (great-circle
   *  walk). Writes/returns `out` (aliasing `loc` as `out` is allowed). */
  move(loc: THREE.Vector3, east: number, north: number, out: THREE.Vector3): THREE.Vector3;
  /** Signed height of a WORLD point above the surface beneath it — the one
   *  frame-free primitive the gaze terrain-march bisects on. */
  heightAbove(p: THREE.Vector3): number;
  /** The building whose footprint contains `loc` (see the session's
   *  buildingAt) — loc-native so no anchor coordinates are involved. */
  buildingAt(loc: THREE.Vector3): SpiritGroundBuildingHit | null;
  /** Park the town's hidden gaze walker at `loc` (see the session's
   *  placeAvatar). */
  placeAvatar?(loc: THREE.Vector3): void;
  /** The body the spark drives — loc + unit heading in frameAt(loc) axes
   *  (see the session's drivenBody). */
  drivenBody?(): { loc: THREE.Vector3; fx: number; fz: number } | null;
}

export interface SpiritGroundSession {
  /** Tangent chart at session-local (x,z) from the anchor — the FLAT (2D)
   *  contract; on a plane the anchor frame is every frame, so this is exact.
   *  Planet sessions implement it too (legacy consumers), but the ladder
   *  prefers `sphere` when present. */
  chartAt(x: number, z: number): SpiritChartFrame;
  /** TRUE terrain height (chart-y metres) under session-local (x,z) — the
   *  glide and its chase rig ride this. Exact on a flat world; on a planet
   *  the y is measured along the ANCHOR chart's up, which tilts away from
   *  the local surface normal (~distance/R) far from the anchor — planet
   *  sessions must provide `sphere` so the ground rung never leans on this
   *  at range. */
  groundY(x: number, z: number): number;
  /** CURVED-SURFACE backend (planets). Present ⇒ the ground rung runs
   *  sphere-native (moving local frame, no anchor); absent ⇒ the flat 2D
   *  adapter wraps the members above. */
  sphere?: SphereGroundOps;
  /** TOWN = CONTENT under the glide, never a session constant: the ladder
   *  refreshes the town ref every frame as the glide moves (entry froze it —
   *  stale in BOTH directions: gliding out kept the old town's content over
   *  open country, gliding in from wilderness never acquired any). Providers
   *  whose content lookups (buildingAt / placeAvatar / drivenBody) key on a
   *  town implement this; flat standalone sessions omit it (their town IS the
   *  world and never changes). */
  setTown?(ref: unknown | null): void;
  /** The building whose footprint contains session-local (x,z), if the
   *  session knows a town here (else null — open ground). */
  buildingAt(x: number, z: number): SpiritGroundBuildingHit | null;
  /** Park the town's hidden gaze walker at session-local (x,z) — the glide
   *  IS the invisible avatar, so structure streaming, the static↔live
   *  handoff and the door-open interior reveal follow it. Absent on open
   *  ground (no town session under the glide). */
  placeAvatar?(x: number, z: number): void;
  /** THE BODY THE SPARK DRIVES, session-local + unit heading — or null when the
   *  spark has claimed nothing (the ordinary spirit case), which is also what
   *  an absent implementation means.
   *
   *  THE PLAYER IS THE SPARK; THE AVATAR IS JUST A BODY. A claimed creature
   *  walks on its OWN legs (the host steers it to the gaze), so the glide — the
   *  fake body that exists only because a sparkless spirit has none — must stop
   *  steering itself and FOLLOW it, or the camera glides away from the avatar it
   *  is supposed to be riding.
   *
   *  POLLED per frame, deliberately: a pushed claim EVENT is exactly what broke
   *  here — `onPossession` had one listener (the standalone boot), so the planet
   *  path never learned a claim had happened. A rung that asks every frame
   *  cannot miss a claim it never subscribed to. */
  drivenBody?(): { x: number; z: number; fx: number; fz: number } | null;
}

export interface SpiritFrameProvider {
  /** The absolute ceiling — the scope's own rung. */
  readonly scopeLevel: SpiritLevel;
  readonly camera: THREE.PerspectiveCamera;
  viewSize(): { w: number; h: number };
  /** Advance the world clock (flight.advanceWorld + avatar hide / no-op). */
  advance(dt: number, now: number): void;
  /** Rebase the render origin onto `camWorldAbs`. Floating-origin worlds
   *  mutate the scene and put the camera at the origin (camAtOrigin true);
   *  flat worlds no-op (the camera is written at camWorldAbs). */
  rebaseOnCamera(camWorldAbs: THREE.Vector3): { near: number; far: number; camAtOrigin: boolean };
  /** Sky + ground/content streaming + force gates — runs AFTER the camera
   *  is placed, keyed on the provider camera. */
  postFrame(dt: number, now: number): SpiritPostFrame;
  /** Open (idempotently) the town session behind a SpiritNearTown ref. */
  openTown(ref: unknown): SpiritTownSession;
  /** Open a GROUND session anchored at a world point; `town` (when known)
   *  lets the session resolve building entries. */
  openGround(worldPos: THREE.Vector3, town?: unknown): SpiritGroundSession;
  /** The FLIGHT seam — absent on flat providers. */
  readonly flight?: SpiritFlightSeam;
  /** Move the gaze spark (null hides it). FLIGHT-rung HUD cursor, the ground
   *  fallback for providers without `groundSpark`, and — on the ground rung
   *  with a mounted town — the display for the HOST-REPORTED cursor target:
   *  `hovering` snaps/darts the spark the way a hover does, `select` drives
   *  the dwell bloom. Both optional (default flat ground point). */
  spark(pos: THREE.Vector3 | null, hovering?: boolean, select?: number): void;
  /** ILLUSORY MOTION for the FLIGHT-rung HUD spark: `vel` is the apparent
   *  velocity of the world past the spark, expressed in the CAMERA's local
   *  axes (+x right, +y up-screen, +z toward the viewer), units/sec. The spark
   *  trails embers along it, so the view reads as moving.
   *
   *  It is camera-LOCAL, and that is the whole point: the HUD spark is parented
   *  to the camera, so it and its embers ride along and the drone's real
   *  hundreds-of-m/s across the planet produce no screen motion whatsoever.
   *  The ladder therefore synthesises a screen-scaled velocity from its own
   *  steering rates — see `slipDrift` in ladder.ts, which is also where the
   *  reason a RATE (not a speed) is the honest signal is written down. Null
   *  clears. Optional: providers without a HUD spark ignore it. */
  sparkDrift?(vel: THREE.Vector3 | null): void;
  /** GROUND-mode cursor, provider-owned: put the cursor where the POINTER RAY
   *  meets the DRAWN world (rendered terrain/roads/town ground), lifted a
   *  little — an ordinary object standing on the ground, which is why the world
   *  occludes it without anything clever. `null` pointer hides it.
   *  `select` is the entity engine's dwell progress (0..1) for whatever the
   *  cursor rests on. `at` is that engine's SNAP POINT (a creature's head, an
   *  object's top) in WORLD coords — supplied instead of the ray hit when the
   *  gaze rests on something a raycast alone could not identify.
   *  Returns true when the provider owns the ground cursor (the ladder then
   *  never drives the overlay spark on the ground rung). Providers without
   *  a drawn world to raycast (flat quest worlds) omit it — the ladder falls
   *  back to the overlay spark at the analytic gaze point, which on a flat
   *  world coincides with the drawn ground. */
  groundSpark?(
    pointer: { x: number; y: number } | null,
    select?: number,
    at?: THREE.Vector3,
  ): boolean;
  /** THE ENTITY ENGINE STANDING WHERE THE PLAYER IS — the ground rung's cursor
   *  reporter, asked fresh every frame. A town host when the glide is in a
   *  town, the wilderness host in open country: the ladder must not care which,
   *  because the player doesn't — the same gaze pick, wall stop, entity snap
   *  and dwell apply on both sides of a town's edge. Omitted (or null) ⇒ the
   *  ladder falls back to the town session's `structureHost()`, then to the
   *  provider's bare drawn-world ray. */
  cursorHost?(): SpiritCursorHost | null;
  /** DIAGNOSTICS: what the provider's cursor did on the LAST frame — which
   *  exit `groundSpark` took (no pointer / drawn-world miss / hit) and, on a
   *  hit, how far out it landed. String only; no behaviour. */
  debugCursor?(): string;
}
