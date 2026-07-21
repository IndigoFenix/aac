# World-engine coordinate modes — migration plan

## The decision

There is **one canonical coordinate**: planet-relative — `(body, localDir, elevation)`,
a unit direction on the body's sphere plus a height in metres. Everything on a
surface (a town, a wilderness patch, a lone feature, a whole one-city planet) is
just *a location on a body*. There is no per-settlement coordinate root.

Two concerns were tangled under "the town anchor"; they split cleanly:

1. **Canonical sim coordinates** → planet-local, carried in **Float64** (JS
   numbers). No realistic body is too big (see precision budget).
2. **Render precision** (Float32 GPU jitter) → solved by a **floating origin
   centred on the camera**, rebasing the drawn scene near 0 each frame. This is a
   *render* concern; it is not a reason to root coordinates on a town. The flight
   `StreamingWorld` already does this rebase.

`shared/world-engine/space/surface-chart.ts` (`createSurfaceChart(body, localDir,
groundH)`) is the primitive that converts between the two modes at any location,
mounted town or not. It matches the streamed town-mesh / city-anchor convention
byte-for-byte (`setFromUnitVectors(up, localDir)` under `body.orientation`), so a
chart's `(x, z)` equal a mounted town's plan coords — it is a drop-in for the
implicit `viz.mesh` / `liveAnchor` transform, usable *before* any town exists.

API: `toWorld(x,z,y)`, `fromWorld(p)`, `headingToWorldQuat(angle)`,
`worldDirToHeading(dir)`, plus `origin` / `east` / `north` / `up`.

## Precision budget (why Float64 canonical + camera rebase)

Float32 value spacing at magnitude *D* ≈ `D × 2⁻²³`; Float64 ≈ `D × 2⁻⁵²`.

| Magnitude | Float32 spacing | Float64 spacing |
|---|---|---|
| 8 km | ~1 mm | ~1e-12 m |
| Earth R (6.37e6 m) | ~0.76 m (visible wobble) | ~1.4 nm |
| Jupiter R (7e7 m) | ~8.5 m | ~16 nm |
| 1 AU (1.5e11 m) | ~18 km | ~33 µm |
| 1 light-year | — | ~2 mm |

Guardrails:
- **Canonical positions in Float64 planet-local** — sub-mm past 1 AU; safe for any planet.
- **Keep render (Float32) coords within a few km of 0** — rebase on the camera
  each frame. Sub-mm holds to ~8 km; ~1 cm to ~84 km from the render origin.
- Do **not** hand planet-magnitude coords to THREE meshes / shaders un-rebased.

## Current state (what to migrate away from)

- Town-focus & the streamed town use the **town centre** as both the sim frame
  and the render anchor (`liveAnchor` at `-stage.center`, under `viz.mesh` on the
  body). Works, but conflates the two concerns.
- **Wilderness** movement mounts a *temporary town* (`mountWildernessAt`) to get a
  ground frame — the hack this plan removes.
- The spirit town→district→building ladder (main.ts `driveCityFocus`) re-derives
  the tangent frame inline (`_cityEast/_cityNorth/_cityUp`) and the pick raycasts a
  tangent plane. These are exactly `SurfaceChart` and should consume it.
- The dollhouse camera in `render3d.ts` (spiritCamera branch) positions the camera
  in **manifold-local coords with no anchor transform** — correct for a standalone
  quest (town at origin) but wrong when driven in host mode (embedded on a planet).
  The grounded chase rig already applies `host.anchor.matrixWorld`
  (render3d.ts ~1444–1448); the dollhouse branch must do the same. *(A one-block
  fix was prototyped and reverted to keep this review clean; it's step 3 below.)*

## Status (implemented 2026-07-15)

Steps 1–4 are **done and verified** (typecheck + `grand-dream` pins + `world-lab`
bundle build). Step 5 is **partially done**: the coordinate/anchor unification
landed; the fuller ground-host redesign is flagged below. A new test,
`games/grand-dream/src/__tests__/surface-chart.test.ts`, pins the chart↔town-anchor
convention byte-for-byte (the invariant everything rests on).

- **1 ✅ SurfaceChart in `driveCityFocus`** — the town/district/building ladder now
  builds `createSurfaceChart(body, cf.dir, h0)` each frame; `_cityEast/North/Up`
  and the tangent-plane pick read the chart. Byte-identical geometry.
- **2 ✅ `SurfacePoint`** — `{ body, localDir, elevation }` + `chartAtPoint()` in
  `shared/world-engine/space/surface-chart.ts`. `CityViz.point` and the wilderness
  chunk (`wildPoint`) carry it; the anchor group is derived from it.
- **3 ✅ Street-level handoff + render3d fix** — the dollhouse camera branch
  (`render3d.ts`) now lifts its pose through `host.anchor.matrixWorld` (gated on
  `this.host`, standalone unchanged). At `FOCUS=BUILDING` with a live town,
  `driveCityFocus` hands the camera to the town host (`setDriveCamera(true)` +
  `setSpiritFocus(footprint)` + pointer feed + per-frame `host.step`; `spiritTownDriven`
  stops the double-step), parks the hidden walker on the building, and releases on
  bottom-exit. **Browser feel to verify:** a small pose jump on handoff (spirit
  orbit → dollhouse) is expected — see Risks.
- **4 ✅ Camera-centred rebase** — city-focus now rebases the streaming on the
  *camera* (both orbit and handoff), so the eye sits at the render origin. Pure
  translation under the floating origin (the town centre stays near origin frame to
  frame, so `centre + offset` is precise); output is identical, the town no longer
  owns the render origin.
- **5 ◻ Wilderness without a temp town — PARTIAL.** Done: the town anchor and the
  wilderness chunk now share `attachSurfaceAnchor(point)` (one `SurfacePoint`-driven
  convention), so "a ground layer is a chart at a point" is real in code. NOT done:
  collapsing `bootWilderness` and `bootTownEmbedded` into a single ground-host that
  streams whichever content exists at a `SurfacePoint`. That is a content/dispatch
  redesign of a working, hard-to-headless-verify path (walk↔fly), left for a
  browser-in-the-loop session. Exotic cases (tiny one-city planet) still ride the
  town path today.

## Status (physics de-walling, 2026-07-17)

The manifold rect is no longer a physical boundary on planet-mounted worlds.
`FlatManifoldSpec.bounded?: boolean` (default true) marks the rect as CONTENT
extent only when false — procgen footprint, certification bounds, render
framing — while physics ignores it:

- **6 ✅ Engine walls gated** — `clampToManifold`, `bounceOffWalls` and the
  handoff-spawn clamp in `createWorldState` all early-return on
  `bounded: false` (engine.ts). Bounded worlds are byte-identical.
- **6 ✅ NPC aims freed** — `NpcControlCtx.bounded` (world-host → controller):
  unbounded waypoint draws skip the rect clamp; roam range is the behavioral
  tether alone (home + wanderRadius, or `UNBOUNDED_WANDER_RADIUS` for an
  untethered wanderer). `approach_nearest` can aim any distance — a follower
  crosses the town edge on its own legs. Pinned in
  `server/tests/world-engine-unbounded.test.ts`.
- **6 ✅ Wired** — wilderness chunks (`wilderness-boot.ts`) and towns standing
  on REAL planet terrain (`town-play.ts` → `TownStageOpts.onPlanet` when
  `config.terrain === "planet"`) are unbounded. Synthetic-ground worlds
  ("flat"/"hills", 2D quests, the city viewer) stay bounded — there is no
  world beyond their rect.
- **6 ✅ Dollhouse open-ground framing** — `resolveDollhouseBounds` now frames
  a body-scale window at the driven body when there is no frame and no
  building, instead of collapsing to the whole manifold (the wilderness
  camera-misalignment fix).

## Status (sphere-native ground rung, 2026-07-17)

The spirit GROUND rung no longer has a session anchor of any kind. The ladder
runs one rung over two geometry backends (`ladder.ts` `GroundGeom`):

- **Sphere** (planets): `SpiritGroundSession.sphere` (`SphereGroundOps`,
  frame-provider.ts) — a surface location is an opaque rebase-safe `loc`
  (body-local unit dir); the glide/rig/gaze laws run in a ROLLING tangent
  frame developed along the glide's own path (a moving frame, not an anchor
  chart); the gaze terrain-march bisects `heightAbove` in world space; the
  spark sits on `surfaceAt(committedLoc)`. Towns appear only inside
  `buildingAt`/`placeAvatar` content lookups. The in-rung `GROUND_REANCHOR_M`
  session-remount hack is DELETED. Implemented in `planet-provider.ts`
  `openGround().sphere`.
- **Flat** (2D worlds): the legacy session contract is UNTOUCHED — the ladder
  wraps it in a 2D adapter (`flatGroundGeom`); on a plane the anchor frame is
  every local frame, so behavior is unchanged (flat providers not edited).

Pinned by `games/grand-dream/src/__tests__/spirit-sphere-ground.test.ts`
(R = 10 km sphere; 3 km glide stays on the surface within 0.5 m where the
entry tangent plane is ~450 m off; the spark lands back on the gaze ray; the
legacy anchor members THROW to prove they are dead code on sphere sessions)
plus the existing ladder/camera/glide suites (flat-path compatibility).

**Ground cursor unified (2026-07-17, supersedes the earlier snap-refinement):**
the overlay HUD spark is a FLIGHT affordance only. On the ground rung there is
ONE cursor rule, town or wild: the spark sits where the POINTER RAY meets the
DRAWN world — `SpiritFrameProvider.groundSpark` (provider-owned) raycasts the
rendered chunk + trade-road meshes (`castDrawnGround`, main.ts →
`PlanetProviderDeps.castGroundRay`); a live town host's engine cursor already
follows the same discipline against its own meshes. The cursor consumes the
gaze MARCH not at all (the march keeps steering/dwell/possession — simulation
truth on the analytic surface). Flat providers omit `groundSpark` and keep the
overlay fallback (on a plane the analytic point IS the drawn ground). Height
model note (traced): there is exactly ONE height field per body — the baked
analytic `surface.heightAt`; region refine ships villages/roads only. Probe
deltas against `chunk_*` meshes are camera-LOD discretization error: metres
under a low camera, ~100 m under a high spirit orbit.

**Walker/physics decoupled from city frames (2026-07-17, second pass):**
- **Floating-origin ground chart (fold of `maybeReanchorWild`):** the
  wilderness is no longer disposed/remounted at its chunk edge. `maybeRebaseWild`
  (main.ts) MOVES the same surface anchor to the walker's `SurfacePoint` and
  re-expresses the LIVE sim in the new chart — `WorldHost.rebase(mapPoint,
  mapVec)` (avatars, velocities, facings, remote-interp targets, objects,
  NPC controller home/waypoint/errand state via `NpcController.rebase`) +
  `WorldView.rebaseLocal(delta)` (render3d follow centre, smoothed heading,
  spark eased positions; `GazeSpark.rebase`). Sim points lift at the OLD
  chart's ground height (a y=0 lift smears sideways by tilt × elevation).
  World poses are unchanged by construction: same world, same bodies, same
  camera, no seam. Samplers swap through mutable indirection (`wildGround`/
  `wildWater` wrappers). Fauna the chart leaves far behind are retired and
  re-scattered (`refreshFauna`). Pinned by
  `server/tests/world-engine-rebase.test.ts` (90° chart rotation: exact pose
  re-expression; an errand in flight converges on the SAME world goal; the
  wander tether follows). NB the polyline is remapped IN PLACE — callers
  passing point objects into `setNpcErrand` must not alias them.
- **Town ↔ open-ground walker handoff (`maybeHandoffGround`):** while
  grounded, the layer that owns the walker is chosen by where the walker
  STANDS — town host inside `TOWN_RECLAIM_R` of the plaza, planet wilderness
  layer outside `TOWN_RECLAIM_R + 80` (hysteresis). Crossing the edge is a
  pose-preserving transfer through WORLD space; walking out of (or into) a
  town never despawns, teleports, or walls the body. Over water the streets
  keep the body (`walkableGroundAt` pre-check).
- **Mount/unmount is LOD, never physics:** the grounded loop now drives the
  SAME `streamGround` as flight/spirit, keyed on the WALKER's world position
  — towns mount/unmount by distance from the walker; the non-owning ground
  layer (town while you roam the fields, wilderness while you walk the
  streets) keeps simulating at the airborne cadence. `disposeEmbeddedTown`
  hands the walker to the wilderness as a safety net if it somehow still owns
  it, and a town one of whose bodies the spirit is RIDING stays mounted
  however far the ride goes (unmounting would destroy the ridden creature).
- **One cursor rule in towns too:** the embedded town host now receives
  `castGroundRay: castDrawnGround`, so its engine cursor lands on the DRAWN
  world (streamed chunks, road ribbons, trees) exactly like the wilderness
  host and the spirit glide — no more analytic-plane drift inside the
  1.5 km town mount band.

Still OPEN (the rest of step 5's redesign, browser-in-the-loop):
- **One ground-host** streaming whichever content exists at a `SurfacePoint`
  (collapse `bootWilderness`/`bootTownEmbedded` into a single host whose
  content set includes "a town's streets" — the walker handoff above then
  becomes an internal content transition instead of a host swap).
- **Ownership when a creature leaves its town (the histfig rule, agreed
  2026-07-17):** a creature a player pulls out of a live town is REMOVED from
  that town's population and promoted to a HISTORICAL FIGURE — an entity in
  the session's mutation layer that, when released, paths toward the nearest
  town. On merging into a town's population, check whether it can simply
  resume a normal schedule (delete the mutation + histfig) or must be
  retained. v1 can be dead simple (a follower that persists across the town
  host's dispose); the full histfig lifecycle is its own scope. Interim
  guard: `streamGround` refuses to unmount a town while the spirit rides one
  of its bodies.
- **`PLANET_TOWN_CENTER = 500`** (quest-boot.ts) survives only in the
  STANDALONE town scope (`bootLivingTown`, the thin city viewer — allowed to
  be town-framed); nothing on the planet path reads it.

## Migration steps (original plan, for reference)

1. **Adopt `SurfaceChart` in `driveCityFocus`** (no behaviour change): replace the
   inline `_cityEast/_cityNorth/_cityUp` basis and the tangent-plane pick math with
   a chart built each frame at `cf.dir` (rebased frame). Pure refactor; verify the
   town/district/building ladder is unchanged.
2. **Canonical location type**: introduce `SurfacePoint = { body, localDir,
   elevation }` as the address for towns, wilderness, features. `cityViz` /
   `cityTowns` entries expose their `SurfacePoint`; `SurfaceChart` is derived from
   it on demand. No temp-town needed to *have* a ground frame.
3. **Street-level handoff (the first real consumer)**: at `FOCUS=BUILDING`, once
   the live town is mounted, hand the camera to the town host's dollhouse:
   `setDriveCamera(true)` + `setSpiritFocus(footprint)` + feed the pointer + step
   the host per-frame; skip the spirit camera write; release on exit. Requires the
   render3d dollhouse anchor-transform fix (step in "Current state"). The camera
   pose can equivalently be built from a `SurfaceChart` at the building's
   `localDir`, independent of the town — which is what makes it work for
   wilderness / one-city planets too.
4. **Camera-centred render rebase**: pass the *camera* (not the town centre) as the
   `stepStreaming` anchor in city-focus, so the render origin tracks the viewer.
   Town-centre currently stays within ~km of the camera so precision is fine today;
   this makes it principled and removes the town's render role.
5. **Wilderness without a temp town**: a ground view at any `SurfacePoint` = a
   `SurfaceChart` + whatever local content streams there (terrain, flora, a town if
   one exists). Retire `mountWildernessAt`'s fake-town; the walker/spirit ground
   frame is just a chart. Exotic cases (tiny one-city planet) then need no special
   path.

## Risks

- **Convention drift**: `SurfaceChart` must stay byte-identical to the town mesh's
  placement (`setFromUnitVectors(up, dir)` under `body.orientation`, lifted to
  `radius + h`). If the mesh convention ever changes, the chart must track it — add
  a test asserting chart↔mesh agreement when step 1 lands.
- **Rebase timing**: picks/camera math must run in the *current* rebased frame
  (the `advanceWorld`-moves-the-planet / stale-matrixWorld bug already fixed in
  `driveCityFocus` — the reorder + `camera.updateMatrixWorld(true)` before the
  pick). Any new consumer must respect that ordering.
- **render3d is shared** with the shipping AAC quest/town — the dollhouse fix must
  not change standalone (owner-mode, no host) behaviour. Gate the anchor transform
  on `this.host`.
