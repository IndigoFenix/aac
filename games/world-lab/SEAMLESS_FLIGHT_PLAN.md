# Seamless walk ↔ fly — corrected architecture

## ★★ REDESIGN 2026-07-13 (user correction — supersedes the "handoff" model below)

The town is a **distance-LOD detail layer**, exactly like planets/regions/street
plans: every loadable object has START and FORCE loading boundaries (abstract
pair + details pair). The live town MOUNTS by distance while the player is STILL
FLYING (sim running, residents visible from the air, town walker hidden) and
UNMOUNTS by distance. **Landing = flight-sim's own touchdown (mode→"walking")
near the plaza → a physics/camera owner switch ONLY. Take-off = beginFlight →
the reverse. Neither ever mounts/unmounts anything.**

Implemented in main.ts: `mountLiveTown`/`disposeEmbeddedTown` (hysteresis
TOWN_LIVE_IN_M=1500 / TOWN_LIVE_OUT_M=2600), `maybeLand` (mode==="walking"
within TOWN_RECLAIM_R=900 of plaza), `maybeTakeoff` (gaze ny≥0.85). The town
steps EVERY frame while mounted (airborne: in the flight block; grounded: the
early branch). NO veil on mount (a hitch, not a stop). NO "Back up"
button/ladder anywhere — leaving is a world action (taking flight). Demos
pruned to 6 verified ones (worlds.ts); engine-capability docs moved to FIXTURES
in world-lab.test.ts.

Things that must NEVER happen: mid-air→ground teleports; interface buttons for
world actions; mounting a LOD level changing who owns the avatar/camera.

KNOWN POLISH: camera rig pose snaps between the flight chase rig and the town
chase rig at touchdown/takeoff (both sit near the avatar, but height/back/fov
differ) — a blend over ~0.5s would finish the "nothing else changes" feel.

## The rule (user, verbatim intent)
- Reuse the EXISTING space flight system (`shared/world-engine/space/flight-sim.ts` +
  `flight-camera.ts` + `celestial-body.ts`). It is tuned. Do **not** author a new
  flight controller in the town's 2D frame — that was the wrong turn.
- The old grounded mode (`flight-sim.updateWalking`, a dumb surface-snap walker) is
  REPLACED by the world-engine living-town grounded host (residents, doors, carry,
  dialogue = `quest-host` + `World3DRenderer`).
- ONE camera. While **walking** it must use the CURRENT grounded camera rules
  (`World3DRenderer.placeCamera` chase rig / spirit-orbit). While **flying** it uses
  `flight-camera`. Blended across takeoff/landing. No loading screen, no perspective cut.

## Why this is sound (no hidden coordinate wall)
- `flight-sim`'s whole state machine (walk→takeoff→fly→land→swim) depends ONLY on an
  abstract `dominant` body: `surfaceAt(dir)→Vec3`, `upAt`, `heightAt(dir)`, `seaLevel`,
  `hasOcean`, `walkable`. `state.position` is a 3D world point. Not coupled to the
  celestial renderer.
- The town is authored plan-view 2D, but it is only ever ACTIVE in one local tangent
  patch (you fly for long distance, walk locally). `walk-chart.ts` (gnomonic tangent
  chart) is an exact local 2D↔sphere bridge. Over a ~1km town footprint on a
  planet-radius sphere, curvature is negligible → the town renders as a rigid flat
  patch tangent at the anchor, visually indistinguishable.

## The seam (two pieces)

### A. Physics/coords — CHEAP, do first
Build a `dominant`-body ADAPTER backed by the town's walk-chart + `groundAt`:
- `surfaceAt(dir)` / `heightAt(dir)` / `upAt` derived from the SAME terrain the town
  stands on (walk-chart `groundAt`, `dirAt`, sea = raw `surface.heightAt < 0`).
- So the bird lands EXACTLY on the town ground; takeoff lifts from it.
- Landing: 3D `state.position` → chart `(x,y)` (walk-chart inverse) → hand steering to
  the grounded host at that spot. Takeoff: host avatar chart `(x,y)` → 3D pos + tangent
  forward → `flight-sim.enterFlyingFromGround`.
- While `state.mode==="walking"`: the GROUNDED HOST drives the avatar (its 2D engine).
  Each frame mirror host avatar chart `(x,y)` → 3D into `state.position` so the shared
  camera + the aim-to-top takeoff trigger keep working.

### B. Rendering — one camera, one scene. Backward-COMPATIBLE refactor of render3d.
Make `World3DRenderer` able to render into a HOST-PROVIDED scene/camera/renderer under
an ANCHOR transform, instead of always owning its own. Default (no injection) = current
behavior, byte-identical — render3d is shared by the real AAC symbol game, so this MUST
stay backward compatible and gated behind new optional opts.

Injection contract (new optional `World3DRendererOptions` fields):
- `externalRenderer?`, `externalScene?`, `externalCamera?` — when present, don't create
  own; add all town content under a single root `THREE.Group` (`this.root`) whose matrix
  = the anchor (origin at site 3D point, X/Z axes = chart tangent basis, Y = surface
  normal, minus floating-origin renderAnchor). Don't call `renderer.render` — expose an
  `update(state,dt,...)` the host loop calls.
- Camera: `placeCamera` computes the chase pose in the LOCAL flat frame; when external,
  transform that pose THROUGH the anchor matrix to drive the shared sphere-frame camera.
  Keep roof-fade / `screenToWorld` / bubble-facing math in LOCAL frame by mapping the
  shared camera's world pos back through the INVERSE anchor.
- Host owns ONE loop: draw celestial/sky (floating origin) → `autoClear=false` → town
  `update` (already sets autoClear=false + does a 2-scene draw, idiomatic here). While
  walking, `World3DRenderer` drives the camera; while flying, `flight-camera` does;
  blend on `takeoffPhase`/land.

## Staging (verify each before next)
1. **A — dominant adapter + walk-chart inverse** (pure, unit-tested). No render. ✅ safest.
2. **B1 — render3d injection seam** (optional opts, default unchanged). Prove the real
   AAC game still renders identically (existing render tests green).
3. **B2 — anchor transform + camera-through-anchor** while walking only (no flight yet):
   town renders inside a sphere-frame scene, camera identical to today.
4. **Wire flight**: takeoff/land handoff, camera blend. Browser-verify walk→lift→fly→land.
5. Tests + `npm run build:games -- world-lab`.

## ★ CONFIRMED DIRECTION (user chose "full living town in one scene")

Flight scene is MASTER. `createSpaceFlight` already gives seamless walk+fly+cities+
approach; flight-sim's avatar already walks the planet in-scene. The ONLY break is the
canvas swap at `main.ts:1091–1120` (veil → hide flight canvas → mount `bootTownFromPlay`
on a 2nd canvas). Kill it by running the LIVING town IN the flight scene.

Co-registration is ALREADY solved: `main.ts:1057–1080` builds an anchored group `g`
(at `dir*(radius+h0)`, +Y→dir) and adds `buildTownMesh` through it, with `makeTownGround`
as the ground sampler. Reuse that exact anchor for the living layer.

### The model: town host owns WALKING, flight-sim owns FLYING, ONE scene/camera
- `flight-sim.mode==="walking"` → the QUEST HOST is live: it runs the town sim (residents,
  player walk, dialogue, board, collision) AND drives the shared camera with ITS rules
  (`World3DRenderer.placeCamera` chase/overhead/shoulder — the "same rules when walking"
  the user asked for). flight-sim is dormant.
- Aim-to-top → HANDOFF to flight-sim: town player `(x,y)` → `chart.dirAt` → 3D pos +
  tangent forward → `flight-sim` public `beginFlight(pos, forward, speed)`. flight-sim now
  owns avatar + camera (`flight-camera`) through the airborne arc.
- flight-sim lands (mode→walking) → 3D `state.position` → `chart.chartXY` → town `(x,y)`;
  hand back to the quest host at that spot.

### Piece 1 — render3d injection (the big one; #30 resurrected)
`World3DRendererOptions` gains optional `host?: { scene; camera; anchor: THREE.Object3D }`.
When present: don't create own renderer/camera; add all WORLD content to `host.anchor`
(not `this.scene`); `render()` updates meshes + drives `host.camera` via `placeCamera`,
but does NOT call `renderer.render` (the flight composer draws the shared scene). Keep the
overlay/vignette OFF in host mode (or route to an existing overlay). Roof-fade / screenToWorld
compute in the anchor's LOCAL frame: map the shared camera world pose through `anchor.matrixWorld⁻¹`.
Default (no host) = today's behavior. User OK'd breaking the AAC symbol game short-term, so
correctness of the default path can be restored at the end rather than preserved every step.

### Piece 2 — flight-sim public handoff API
Add `Player.beginFlight(position: Vec3, forward: Vec3, speed?: number)` (wraps internal
`enterFlyingFromGround` after seeding `state.position/forward`) + ensure `state.mode` and a
just-landed readout are public. Build a MINIMAL single-body `PlayerWorld` from the town's
`createCelestialBody(surface)` — OR reuse the flight's existing `world`/home body directly
(the flight already flies this planet), which is simpler: the handoff planet IS the flight's
current dominant body. Prefer reusing the flight's live body over a synthetic PlayerWorld.

### Piece 3 — quest host as an EMBEDDED layer
`createQuestHost3D` / `runWorldHost` gain a mode where (a) they render through the injected
host, (b) the PLAYER avatar is EXTERNALLY driven (position set by the coordinator from
flight-sim while airborne; by the town walker while grounded), (c) `resize`/pointer/DPR come
from the flight canvas. The dialogue board (`mountBoardIsland`) is a DOM overlay — mount it
over the flight canvas (it already renders over any canvas).

### Piece 4 — main.ts: replace the canvas-swap handoff
Delete the `display="none"` + `bootTownFromPlay`-on-2nd-canvas block (1099–1117). Instead,
when a city's town is `ready` and near, START the embedded quest host anchored at the city
(reuse the `cityViz` group as `host.anchor`), and route walk↔fly through the coordinator.
"⬆ Back up" no longer unmounts a canvas — you just fly away.

### Staging (verify each; keep it compiling)
1. ✅ SHIPPED — flight-sim `beginFlight` + `state.mode` readout (unit-tested, `flight-sim.test.ts`).
2. ✅ SHIPPED — render3d `host` injection: `World3DRendererOptions.host?: RenderHost`
   ({scene,camera,anchor}). Host mode shares the flight camera, hangs content under
   `host.anchor`, updates meshes but does NOT draw (flight composer draws), fade/blackout
   pulled into anchor-local via `worldToLocal`. New `setDriveCamera(on)` + `setAvatarHidden`.
   Default (no host) path byte-identical, gated on `this.host`. tsc-clean, world-lab builds.
3. ✅ SHIPPED — embeddable engine seams: `WorldHost.step(dt,now)` (external clock);
   `WorldView.setDriveCamera?/setAvatarHidden?`; `createWorld3DView({host})`; quest-host
   `QuestHostDeps.host?` → forwarded to view, skips internal rAF, exposes
   `QuestHost3D.step/setDriveCamera/setLocalAvatarHidden`. Adds ZERO new tsc errors
   (stash-proven; only PRE-EXISTING `quest-host:2849/2886 o.glyph` + goods.ts remain).
4. ⏳ NEXT — main.ts coordinator (browser-verified). See recipe below. Do ADDITIVELY —
   keep the canvas-swap path as a fallback (guard the embedded path) so nothing breaks
   until the embedded cycle is proven in the browser.
5. `npm run build:games -- world-lab`; browser-verify walk→lift→fly→land; restore/verify
   the default (non-host) render3d path.

### Piece 4 recipe (main.ts flight tick @ `games/world-lab/src/main.ts:1082–1120`)
The canvas-swap to kill: `renderer.domElement.style.display="none"` + `bootTownFromPlay(viewEl,…)`
on a 2nd canvas (1101–1108). Replace with an EMBEDDED boot:
- **Anchor already built**: the per-city group `g` at `main.ts:1057–1080` (pos `dir*(radius+h0)`,
  +Y→dir, holds `buildTownMesh` + `makeTownGround`) IS `host.anchor`. Reuse `cityViz.get(cell).mesh`.
- **host** = `{ scene, camera, anchor: viz.mesh }` (the flight `scene`/`camera` from bootSolarFlight).
- **Embedded boot** (new fn in quest-boot.ts, e.g. `bootTownEmbedded(container, play, setStatus, {host, groundAt, waterAt})`):
  fork `bootQuestGame` — pass `host` to `createQuestHost3D`, DON'T create a quest-canvas (pass the
  FLIGHT `renderer.domElement` as `deps.canvas` for size/pointer mapping), mount ONLY the DOM overlays
  (board panel + objectives/toast/win) over `viewEl`, and RETURN the `QuestHost3D` handle (not just dispose).
- **One loop**: in the flight tick, after `flight.update` + `composer.render`, call `questHost.step(dt, now)`
  (town renders under the anchor into the shared scene). Keep flight rendering; town step just updates meshes.
- **Pointer**: route `viewEl` pointermove → `questHost.setPointer` while grounded (walking uses the gaze).
- **WALK→FLY** (aim-to-top, reuse flight's own top-edge trigger OR a walking `intent` check): town player
  `(x,y)` → `chart.dirAt` → 3D `dir*(radius+groundH)` + tangent-forward (`chart` basis) →
  `flight.player.beginFlight(pos, forward, speed)`; then `questHost.setDriveCamera(false)` +
  `setLocalAvatarHidden(true)` + `setPaused(true)`. Need the town's `chart` here — `planetSiteGround`
  builds one internally; EXPOSE it (return `chart` from the ground builder) so main.ts can map both ways.
- **FLY→LAND** (`flight.player.state.mode` flips to `"walking"`): 3D `state.position` → `chart.chartXY`
  → town `(x,y)` (+`PLANET_TOWN_CENTER`); teleport `questHost.world.state.avatars[PLAYER_ID]`; then
  `setPaused(false)` + `setDriveCamera(true)` + `setLocalAvatarHidden(false)`.
- **screenToWorld** in host mode still needs anchor-mapping for the WALKING gaze pick (fade/blackout are
  done; the raycast pick + ground-plane + returned point are NOT). Add: raycast in world space (three
  already uses matrixWorld), then map the hit point through `anchor.worldToLocal`; the ground plane must be
  the anchor-transformed plane. Do this when wiring walking, else the walk aim will be wrong.

## DO NOT
- Do NOT create a new flight controller / new physics. Reuse flight-sim.
- Do NOT touch `kernel/town/goods.ts` (pre-existing errors, unrelated).
- Do NOT break the default (non-injected) render3d path — the AAC game depends on it.
- Do NOT do the full ascent-to-orbit (galaxy handoff) here — separate later step.
