# Planet-first entities — ownership migration plan

## The decision (user law, 2026-07-17)

The town is an **abstraction layer**: population, building layout, common
knowledge, economy — stored as seed + mutations, loaded into an interactive
state **in the planet's frame** when needed. From that follows:

1. **All loaded, interactive objects belong to the PLANET.** Everything has a
   planet position (`SurfacePoint` — `(body, localDir, elevation)`) first and
   foremost. Town-plaza coordinates are a derived view, never the source of
   truth for a loaded entity.
2. **A creature does not need a town to exist, and its mind is not provided by
   the town.** At most a creature holds a *resident link* to a town, granting
   access to that town's common knowledge (directions, jobs, stock, gossip).
   Minds, needs, dialogue, carrying, claiming all run townless.
3. **Ambient residents unload with their town** — that part of today's design
   is CORRECT. Seed + mutations re-derives them on return. What must change is
   the *dependency direction*, not the lifecycle: while loaded, a resident is a
   planet entity that happens to carry a resident link.
4. **The player never belongs to a town.** Interaction (hover, dwell, pick,
   converse, carry, possess) is a capability of the player's ground presence
   and works on any nearby loaded entity, in a town, at its border, or in open
   wilderness. The gaze spark is the player's cursor; a town drawing it is a
   leak (`ladder.ts` `hostHere` fork — the bug that opened this).
5. Towns must never leak into physics or the camera. The one exception stands:
   the town-view camera (district orbit) *above* the ground rung.

### Future constraint: migration between planets

Creatures may eventually migrate **between planets**. This involves little or
no physical interaction — Float64 or not, there is no neat shared 3D space
across bodies without generating a local reference frame anyway. Plan
consequences, cheap to honour now:

- An entity's canonical address is **`(bodyId, SurfacePoint)`**, never a bare
  chart coordinate and never a global position. Every API below takes the body
  from the address, not from a module-level singleton.
- The entity store is **per body**. A migration is an *abstract* transition:
  the entity leaves body A's store (becoming an abstraction: a histfig record /
  caravan manifest / ship passenger), travels in abstract time, and is
  instantiated into body B's store on arrival. There is never a loaded entity
  "between" planets.
- Nothing in the loaded-state design may assume "the planet" is unique — but
  nothing needs cross-body queries either. One store, one streamer, one ground
  host **per body**; the abstraction layer above them is where bodies meet.

## Current state (what the 2026-07-17 survey found)

Root cause, single sentence: **`bootTownEmbedded` and `bootWilderness` each
construct a private `LogicalWorld`; there is no planet-level entity store**, so
whichever host spawned an entity owns its existence, coordinates, mind, and
death. Everything below is a symptom of that.

Severity-ranked (file:line as of the survey; navigate by symbol, lines drift):

- **S1 — existence.** `mountLiveTown`/`disposeEmbeddedTown` (main.ts ~1630,
  ~788): every minded creature is created and annihilated by the camera's
  distance to a town (`TOWN_LIVE_OUT_M`). Wilderness (`wilderness-boot.ts:128`)
  has only bare `horse_N` wanderers — no session, no minds. NPCs cannot walk
  town→town; the two worlds never see each other. The `!spiritRiding()` mount
  pin exists only because a ridden creature has no planet-side existence to
  fall back on.
- **S1 — the master switch.** `session.town` (quest-host.ts:769) gates ~80
  call sites: board nouns, jobs, economy, resident minds, even which clock
  runs (`session.town ? session.townClock : session.taskClock`). Founding is
  `!session.town` — two mutually exclusive world-kinds.
- **S1 — lossy handoff.** `maybeHandoffGround` transfers `{x, y, fx, fy}`
  only; pocket, followers, quest state, small props stay behind and die with
  the town host. Only the *player* is ever handed off.
- **S2 — cursor/camera leaks.** The `hostHere` fork (ladder.ts ~1066) hands
  the player's cursor to the town host. `townRef` is frozen at `enterGround`
  and never re-evaluated as the glide moves (stale in both directions). The
  ground rung's `buildingAt`/`placeAvatar`/`drivenBody` are all
  `if (townRef === null) return null` (planet-provider.ts) — no possession or
  building entry anywhere townless. Bottom-dwell destination is
  `townRef !== null ? "town" : "flight"`.
- **S3 — coordinate rooting.** Live residents' authoritative coords are flat
  town-plaza-local (`liveAnchor` at `-stage.center`); the town anchor has **no
  floating-origin rebase** (wilderness does — `maybeRebaseWild`), so an
  entity following the player out of town walks an infinite flat plane in
  plaza coordinates, diverging from the sphere. `PLANET_TOWN_CENTER = 500` is
  a duplicated magic origin.
- **S4 — building models.** Static town meshes hang off `attachSurfaceAnchor`
  (fine — that is the sanctioned planet convention), but the *live* twins hang
  off the plaza-shifted `liveAnchor` and die with the town.

Already clean (do not touch): `npc-controller.ts` has zero town references;
`attachSurfaceAnchor`/`SurfacePoint` are shared by town and wilderness; the
town host's gaze pick already casts the drawn planet (`castDrawnGround`);
engine walls are gated off on `bounded: false` (COORDINATE_MODES_PLAN step 6).

## Target architecture

```
CelestialBody
 └─ PlanetEntityStore (per body)          ← NEW: owns every LOADED entity
     entity: { id, address: SurfacePoint, body-frame pose,
               kind, mind-state, inventory, residentLink? }
 └─ GroundHost (ONE per body, singleton)  ← collapses bootWilderness +
     streams content by player SurfacePoint  bootTownEmbedded
     ├─ terrain/water samplers (already planet-first)
     ├─ TownContentLayer(s)               ← towns MOUNT CONTENT INTO the host:
     │    seed+mutations → building meshes, ambient residents,
     │    stations, stock — all registered in the PlanetEntityStore
     └─ WildContentLayer — fauna, flora props, lone features

Town (abstraction, always resident in memory as seed+mutations)
 ├─ plan, population roster, economy, common knowledge, clock
 └─ residentLink registry — which loaded entities are "of" this town

Player
 └─ ground presence (glide or walker) + interaction capability
     — hover/dwell/pick/converse/carry/possess against the
       PlanetEntityStore by proximity. No town in the loop.
```

**The town's remaining jobs** (all legitimate): procgen (plan, layout),
population abstraction (who exists here when unloaded), scheduling content
(jobs, meals, shops) for entities holding its resident link, common knowledge
for dialogue, the town clock as *shared local time* those entities consult.

**Lifecycle rules:**
- Load/abstract is keyed on **distance from the player** (and spirit focus),
  not on which host spawned the entity.
- An entity leaving its town's band while loaded STAYS loaded (it is planet
  content); when it unloads far from any town it becomes a **histfig-style
  mutation** (the promotion quest-boot.ts's TODO already sketches): position +
  state snapshot, resumed or walked-forward in abstract time on reload.
- An entity whose resident link's town unloads while the entity is *inside*
  the town band unloads with it (today's correct behaviour, kept).
- Migration (town→town or planet→planet) is the abstract layer moving a
  roster/histfig record; loaded walking between towns is just rule 1.

## Steps

Ordered so each lands green on its own; the 80-gate de-gating is LAST because
it is wide but mechanical once ownership is right.

- **1 ✅ Cursor ownership (2026-07-17 — SHIPPED, browser-verify pending).**
  The `hostHere` fork is gone: on the planet path (any provider with
  `groundSpark`) the PLANET's spark draws the ground cursor always. The host
  is opted out via `setExternalCursor(true)` (render3d stashes the computed
  target instead of driving its own spark — anchor-local, lifted to world at
  read time) and REPORTS content through `cursorWorld(out)` → hover snap
  (heads / `localTopY`), select progress. Seam: render3d →
  `WorldView.setExternalCursor?/externalCursorWorld?` → `QuestHost3D` →
  main.ts wrapper → `SpiritStructureHost` optionals. `provider.spark(pos,
  hovering?, select?)` displays it (dart-on-hover + bloom on the planet
  spark). The dollhouse (structure rung) re-asserts `setExternalCursor(false)`
  per frame — the sanctioned town-view exception. main.ts also asserts the
  opt-out for the MOUNTED host at the ground rung regardless of attach radius
  (the mount band is wider — a pointer-fed host in the ring between them drew
  a second cursor). `townRef` is refreshed per frame from `post.nearTown`
  (`TOWN_GROUND_ATTACH` 1.25, same as the entry gate) with two opt-outs:
  sessions without `setTown` (flat standalone — their postFrame reports no
  nearTown, a refresh would strip a live ref; caught by an existing pin) and
  while the spark rides a body (the ride outranks the radius).
  FLAT standalone worlds keep their host cursor unchanged — the law is about
  towns ON a planet. Pins: spirit-ladder.test.ts "the PLANET owns the cursor"
  ×3 (host reports/never draws; flat keeps host cursor; townRef re-evaluated
  both directions). 41/41 ladder+sphere+pose; full grand-dream 567/567.
  NOT YET: browser readout (probes `cur:/cast:/spk:` stay in until then).
  BROWSER ROUND 1 (same day): the wilderness spark WAS being drawn all along —
  z-buried under the drawn terrain (revealed when another session's edit hid
  the ground textures). Root cause at the CAST, not depth: `drawnGroundMeshes`
  pushed `chunk_*` meshes with NO visibility gate (the flora/roads branch had
  one), so the cursor ray could hit an INVISIBLE superseded LOD chunk below
  the drawn surface. Fixed (ancestor-chain visibility gate). DEPTH LAW (user):
  the spark is a 3D BEING — genuinely occluded by terrain/walls on ground/
  structure rungs (depth ON); HUD (depth off) in flight only. Gaze-on-wall
  rule: the spark rests against a gazed wall until the gaze crosses to the
  wall's far side — REGRESSED on the planet path, re-check once visible; may
  need the host's wall hits fed through `cursorWorld` or the single ground
  host (step 3). Trace probe: `__spirit.trace` ring (~30 s) + `pm/pl/tgt`
  pointer-feed counters — the status tooltip can't capture travel frames
  (copying parks the mouse off-view; the first three readouts were all
  observer artifacts). STILL OPEN: screen blacks out when walking out of a
  city (predates the cursor work; veil vs blackout-cube vs renderer death
  undiagnosed — get console errors at the moment it happens).
  BROWSER ROUND 2 — the real "hidden spark" was a DART STORM: the trace
  showed `spk:on/a1.00` at the correct pixel but the phase column cycling
  shrink→dart→grow with core size 0 (single-frame idle windows = the border
  "flicker"; hover glow visible because halo/light are not the core). Cause:
  camera-parented group ⇒ the camera-LOCAL jump detector aliases camera yaw
  into target jumps (0.01 rad × 50 m ≈ the dart threshold). Fix: darts now
  need a PLANET-frame verdict too — `GazeSpark.setTarget(..., worldJumped?)`
  ANDs the caller's body-local Float64 comparison (`cursorWorldJump` in the
  planet provider, reset on hides) with the internal one. LESSON for step 3+:
  easing may ride the camera; STATE-MACHINE TRIGGERS must read the planet
  frame. Also left visible in the trace, unchased: the embedded host's engine
  cast (`cast:`) reports `miss` on most frames (its cursor still resolves via
  the plane fallback) — worth a look when the host pick path is next open.
  ROUND 3 — PAUSED BY USER DIRECTIVE (2026-07-17: "stop trying to fix the
  spark bug; move the towns into the planet frame"). State at pause: dart
  storm fixed (worldJumped), invisible-LOD cast fixed, but the provider spark
  still only renders in HOUSE mode (host spark, depth OFF). Verified before
  pausing: terrain = patched MeshStandardMaterial (logdepthbuf intact), three
  r184 sprite shader carries logdepthbuf, so shader depth agreement is fine.
  NEXT LEAD when resumed: the scene renders through an EffectComposer
  (RenderPass → UnrealBloom → OutputPass, HalfFloat MSAA `hdrTarget`,
  main.ts~174) on EVERY path, not just space — depth-OFF sprites survive it,
  depth-ON sprites vs terrain die in it. Suspect the composer target's depth
  handling (MSAA resolve / depth attachment), not the shaders. A 5-minute
  discriminator: render one frame with `renderer.render(scene, camera)`
  bypassing the composer and see if the depth-ON spark appears.
- **2 ◻ Live-anchor rebase parity.** Give the embedded town the same
  floating-origin/rebase treatment the wilderness has (`WorldHost.rebase` +
  `rebaseLocal` already exist — wire them on the town path), so a loaded
  entity's chart never silently diverges from the sphere. This is a
  prerequisite for entities that wander: their coords must survive a chart
  move before they are allowed to leave it.
- **3 ◻ Single ground host.** Collapse `bootWilderness`/`bootTownEmbedded`
  into one host per body streaming content at the player's `SurfacePoint`
  (COORDINATE_MODES_PLAN step 5's open half). Town mount/unmount becomes an
  internal *content* transition — the renderer, session, and walker survive
  it. `maybeHandoffGround`, `handWalkerToWild`, `groundedIn`, and the
  pose-only transfer all dissolve; `TOWN_RECLAIM_R` becomes a content-band
  radius, not an ownership boundary. Browser-in-the-loop work (walk↔fly is
  hard to verify headless) — schedule it as its own session.
  **SLICE 1 (2026-07-17 — SHIPPED, browser loop pending).** Both sides of a
  town border are now the SAME HOST CLASS: the wilderness side of the planet
  ground path boots a QuestHost3D wilderness session
  (`quest-boot.ts bootWildernessQuest` → `host.start(game, null,
  { wilderness })` on the questless `buildCreatureQuestWorld` bundle the
  standalone wilderness scope already plays) — minded, talkable, possessable
  scatter creatures + resource features in open country; the biome's horse
  herds ride on top as plain wander NPCs (ungulate bodies via
  `ANIMAL_SPECIES_BY_ICON`), retired/rescattered on rebase exactly like the
  sandbox boot. Dispatch flag `UNIFIED_GROUND` (main.ts, ground constants) —
  false keeps the legacy `bootWilderness` compiling; delete both after the
  browser walk-out/walk-in/fly-away loop passes. Supporting seams:
  `WildernessParams.bounded` (planet chunks pass false — the rect is content
  extent, never a wall), `QuestHost3D.rebaseLocal` (floating-origin parity
  with the sandbox handle), `QuestHost3D.pocketSnapshot/restorePocket` — the
  POCKET now carries across the town↔wild walker handoff both directions
  (glyph→count stacks are portable; followers/party still die with their host
  — TODO(step4-entity-store)). The shared lab board is last-wins chrome: the
  layer GAINING the walker re-claims (`claimBoard` on both embedded handles,
  called at `maybeLand`/`maybeHandoffGround`/`mountLiveTown`). NOT slice 1:
  towns as mountable content into one host (the host swap, `groundedIn`, and
  the pose transfer all still exist — slice 2), presenter pushes from the
  non-owning session (both sessions share the board island; event-driven, so
  contention is rare — dissolves with the single host).
- **4 ◻ PlanetEntityStore + resident link.** Entities register in the
  per-body store with `(bodyId, SurfacePoint)` addresses; town layers spawn
  their residents INTO it with `residentLink = townKey`. Interaction queries
  (hover, pick, converse range) run against the store by proximity. Departure
  promotion: leaving the town band flips ownership to the store outright
  (histfig mutation on far unload). The spirit-riding mount pin and the
  engine's "town unload releases the claimed spark" path both retire.
- **5 ◻ Mind de-gating.** The wide one: convert `session.town` gates to
  capability checks — `mindOf(entity)` runs for any loaded creature;
  town-flavoured content (jobs, stock, shortage signals, board nouns, common
  knowledge, town clock) resolves through `residentLink?.town`, absent →
  townless defaults (`taskClock`, personal knowledge only). Founding stops
  being `!session.town` and becomes "no town claims this ground". Mechanical
  but ~80 sites; land it behind the store so each gate has an obvious
  rewrite target.
- **6 ◻ Cross-planet readiness audit.** Grep for module-level `body`
  singletons in the new seams; assert every new API takes the body from the
  entity address. No feature work — just make sure nothing landed that a
  second planet would break.

## Risks

- **Step 3 is the load-bearing wall.** It reshapes a working, hard-to-test
  path. Mitigate: keep both boots compiling behind a dispatch flag until the
  single host passes the browser walk-out/walk-in/fly-away loop, then delete.
- **Step 5's blast radius.** 80 gates touched mechanically invites subtle
  behaviour drift (a gate that *should* be town-only, e.g. plaza festivals).
  Rule: content gates move to `residentLink`; *capability* gates die. When
  unclear, ask — do not guess a gate's category from its neighbour.
- **Perf.** Minds for wilderness creatures = more live sessions. The budget
  tiers/idle-recycle machinery (AAC side) does not apply here, but the
  existing airborne-cadence stepping generalises: step entities by distance
  band, not by host kind.
- **Save/certification.** Histfig mutations enter the seed+mutations layer —
  multiplayer-safe by construction (mutations are the owned layer), but the
  world-lab certification tests must learn that a town roster can have
  members "abroad".

## Tests

| Pin | Where |
|---|---|
| Cursor owner never `host` at ground rung; border crossing keeps one spark | `spirit-ladder.test.ts` (extend) |
| `townRef` re-evaluated per frame (enter + leave) | `spirit-ladder.test.ts` |
| Town-path rebase: entity world pos invariant under chart move | `world-engine-rebase.test.ts` (extend) |
| Single host survives town mount/unmount (renderer + session identity) | new, step 3 |
| Entity walks out of town band and stays loaded/interactive | new, step 4 |
| Resident link: dialogue knowledge with/without link | new, step 5 |
| Founding permitted on unclaimed ground near a mounted town | new, step 5 |
| Store APIs take body from address (two-body smoke) | new, step 6 |

Runner: vitest via `npx vitest run --root games/grand-dream` for ladder/world
pins; jest `server/tests` for engine/rebase pins.

## Relation to other plans

- Extends **COORDINATE_MODES_PLAN.md** (steps 5–6 there are steps 2–3 here);
  the coordinate doctrine (Float64 planet-local, camera rebase) is unchanged
  and is what makes planet-first entity coords safe.
- Subsumes the histfig TODO in `quest-boot.ts` and the "ground-host
  unification OPEN" note.
- The probe kit from the 2026-07-17 session (`cur:/cast:/spk:` status-line
  fields, `GazeSpark.debugPose`, `provider.debugCursor`, `ladder.debugGround`)
  stays in until step 1 is browser-verified, then gets flag-gated or stripped
  per house rule.
