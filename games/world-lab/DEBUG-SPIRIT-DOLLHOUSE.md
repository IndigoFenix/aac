# DEBUG HANDOFF: planet-descended dollhouse — sealed box over the live house

**Status 2026-07-16 (session 2): ROOT CAUSE FOUND + FIXED. Awaiting browser
confirmation.** History kept below — it explains why this took two sessions.

## THE BUG: the sky stomped the town's materials flat, every frame

`space-sky.ts` `setBodyMeshOpacity()` force-opaques a body's shell meshes by
apparent size. It did so with a **blanket `body.group.traverse()`**, setting
every material to `opacity = 1; depthWrite = true; transparent = false`.

Every ground layer hangs **planet-LOCAL, INSIDE `body.group`** (the planet's
spin has to carry it) — so the traverse swept up the whole live town. Each
frame it reset every dollhouse wall/roof fade back to opacity 1 before the
fade could finish.

**The fix:** `forceBodyMeshesOpaque()` — a manual walk that PRUNES any subtree
flagged `OWNS_MATERIAL_STATE` (exported from `space-sky.ts`).
`attachSurfaceAnchor()` (main.ts) sets that flag: it is documented as THE one
way every ground layer sits on a body, so one flag covers town, live town and
wilderness. Pinned by `games/grand-dream/src/__tests__/sky-force-opaque.test.ts`
(4 tests; verified to FAIL without the prune, stomping 0.66 → 1).

### How the readout proved it — the arithmetic that cracked it

```
vis:5/65 blk:0 cut:0/356 door:87/96 roofOpen:0
hideW:24 built:0 rev:5 minOp:0.66 dt:0.0500  ← the decisive line
```

- `hideW:24` — 24 walls DECIDED to cut. `rev:5` — 5 roofs asked to open. The
  cutaway logic was always RIGHT.
- `built:0` — no rebuild thrash (the session-2 favourite theory: DEAD).
- `dt:0.0500` — real dt. Not a frozen clock.
- **`minOp:0.66` was the key.** With dt=0.05 and FADE_RATE=9,
  `k = 1-exp(-0.45) = 0.362`, so ONE step from opacity exactly 1.0 gives
  `1 + (0.07-1)×0.362 = 0.663`. Two steps would give 0.45. Pinned at 0.66
  ⇒ **opacity was exactly 1.0 at the start of every frame** ⇒ something
  RESET it after the sync. That is the whole bug in one number.
- Walls never crossed the `opacity > 0.02` threshold ⇒ `tall.visible` stayed
  true ⇒ `cut:0/356` forever ⇒ **sealed box**.

### Why doors worked and walls didn't (the clue that located it)

| what | how it reveals | result |
|---|---|---|
| door | `entry.object.visible = !hide` — instant BOOLEAN | ✅ hid fine |
| wall | ease `mat.opacity`→0, then `tall.visible = opacity > 0.02` | ❌ stomped |
| roof | `fadeToward(roof.material, revealed, dt)` | ❌ stomped |

The sky's walk only touched **materials**, never `.visible`. So everything
boolean worked and everything that faded died — and "door invisible" was the
cutaway working correctly all along.

### Also explained by the same line

- **Creature "invisible rectangles" hiding buildings** — `transparent = false`
  + `depthWrite = true` forced onto meshes that must blend ⇒ opaque
  depth-writing quads. Should be gone; re-check.
- **Why only the planet-embedded town broke.** Standalone structure scope /
  village spirit have no planet body group, so nothing stomped them. This is
  the fact the old doc could never explain — it is not about streaming at all.

## READ THIS FIRST — the "headless mystery" was a TEST ARTIFACT

The pin test's √3 failure was **not** a product bug. `live-handoff.test.ts`
measured instance scale with `Matrix4.decompose`, and **three r184 guards
degenerate matrices: decomposing the zero-scale HIDE matrix returns scale
(1, 1, 1)** — indistinguishable from identity. The raw instance matrix at
instance 0 was the zero matrix all along (proved by dumping `m.elements`
inside the verbatim pin-test flow), exactly as the debug test reported.

Fixed by reading scale off the matrix columns instead of `decompose`
(`scaleOf` in `live-handoff.test.ts`). **The test is now green (2/2).**
`live-handoff-debug.test.ts` + `handoff-debug-out.txt` are deleted.

⚠️ **`decompose` cannot detect a zero-scale matrix in this three version.**
If any product code (not just tests) leans on decompose to test for hidden
instances, it has the same false read.

### Consequences — do NOT re-chase these

- **The static↔live handoff WORKS.** `loadedLots()` → `setLiveLots` hides
  exactly the right static instances on a real generated town
  (`statHid:17/70`, streets off). Data path and instance mapping are correct.
- **"cityViz built from a different `play`" is RULED OUT** (session-2
  reading): `cityTowns.approach()` caches one entry object per cell and sets
  `entry.play` once; `main.ts:1263` builds the viz from `entry(cell).play` and
  `main.ts:1278` mounts `approach().play` — the same object.
- **So "the static box still stands over the live house" has lost its
  supporting evidence.** It was inferred from the headless failure, which was
  fake. The covering geometry is probably NOT the static plan.

## THE BUG IS IN THE LIVE RENDERER'S FADE — fresh readout (session 2)

```
SPIRIT ladder-v1 · FOCUS=BUILDING (Galmont) ‖ host 764x647 sp:f(894,305,11x10)
vis:6/67 blk:0 cut:0/358 door:79/90 roofOpen:0 me:900,310@h_264_rh
| sess:spirit ptr:- gz:- hov:- | statHid:36/287 streets:off lots:34h/2w
```

- `statHid:36/287` + `lots:34h/2w` — **the runtime handoff is CORRECT** (36
  hidden = 34 houses + 2 works, streets off). The static box is INNOCENT,
  matching the headless pin. Stop looking at `city-visuals.ts`.
- `vis:6/67` — the 6 rooms of the focused house ARE revealed. The decision is
  computed.
- `cut:0/358` + `roofOpen:0` — **nothing is APPLIED.** Not one tall wall cut,
  not one roof opened. This is the sealed box.

### The decisive asymmetry: doors work, walls and roofs don't

`door:79/90` = **11 doors ARE hidden** — and doors take the SAME
`hide = wallHidden(state, s, fade.visible)` decision as walls, off the same
`visible` set (11 doors ≈ 6 rooms; this is the "door invisible" symptom).
So `wallHidden` is RIGHT and `fade.visible` is populated in `syncStructures`.
The split is purely in APPLICATION (render3d `syncStructures` ~2346):

| what | how it reveals | result |
|---|---|---|
| door | `entry.object.visible = !hide` — instant boolean | ✅ 11 hidden |
| wall | ease `mat.opacity`→0 via `kk = 1-exp(-FADE_RATE*dt)`, then `tall.visible = opacity > 0.02` | ❌ 0/358 |
| roof | `fadeToward(roof.material, revealed, dt)` | ❌ roofOpen:0 |

**Walls and roofs are the only two things that reveal by FADING OVER TIME,
and both are frozen at exactly zero effect while every instant boolean in the
same pass works.** One frame at dt≈0.016 with FADE_RATE=9 should drop a
revealed roof to ~0.88 (roofOpen counts <0.9) — `roofOpen:0` across all 67
means not one ever moved. So `hide`/`revealed` are almost certainly TRUE and
the fade never accumulates.

Two candidates, not separable by reading:
1. **`dt` never reaches the fade** (0 or near-0 in this path).
2. **Mesh REBUILD thrash** — entries reconstructed every frame reset
   `opacity` to 1, so a multi-frame fade can never finish while instant
   booleans are unaffected. ⭐ This is the favourite: it is the only theory
   that explains why ONLY the streamed planet-embedded town breaks while the
   standalone structure scope (stable spec) works — a stable spec accumulates
   fade; a re-staged one restarts at 1 forever.

### Probe fields ADDED this session (built, `npm run build:games` clean)

`debugCutaway` now also emits — read these next:
`hideW:<walls hide==true> built:<meshes constructed that frame>
 rev:<roofs asked to open> minOp:<lowest revealed-roof opacity> dt:<seconds>`

Decision table for the next readout:
- `built:` > 0 EVERY frame ⇒ **rebuild thrash** (candidate 2). Find who churns
  `state.spec.structures` / `spec.buildings` ids under the streamer
  (town-stage) — the parked dollhouse avatar doesn't move, so the staged set
  should be STABLE and `built` should be 0 in steady state.
- `dt:0.0000` ⇒ candidate 1; the fade can never advance. Walk back
  ladder.ts:724 `host.step(dt, now)` → quest-host `step` → world-host
  `view.render(state, dt, …)`.
- `hideW:~11 built:0 dt:0.016 minOp:1.00` ⇒ decision right, real dt, no
  rebuild — something else RESETS opacity each frame; hunt that writer.
- `hideW:0` ⇒ genuinely surprising (doors cut but walls don't from the same
  test); would put `wallHidden`'s geometry sampling for wall segments in
  frame.

### The evidence gap this fresh readout CLOSED

⚠️ **Lesson for this doc's readers.** The session-1 readout (kept below) was
STALE — taken before the `cut:`/`door:`/`roofOpen:` fields existed, it showed
only `vis:`/`blk:`. The doc read that as "the live renderer computes the
correct cutaway" and went hunting the static box for a whole session. It only
ever proved the visibility SET was computed — never that it was APPLIED. The
applied state was the entire bug. **When a probe field is absent, that is not
evidence the thing is healthy.**

## The symptom (current, after all fixes this session)

In a SPIRIT-scope planet game, descend flight → town → building (or glide into one):

- The house shows as a sealed box — "walls always visible", **door invisible**,
  the interior/cutaway never appears.
- Dwell interaction on creatures/objects looks dead (but see probe: the gaze
  pipeline is actually ALIVE — hover resolves, the spark's POINT LIGHT blooms).
- The moving spark sprites are invisible (fix shipped, unverified: host-mode
  render3d now sets `spark.setDepthTest(false)` — the flight composer's
  log-depth buffer z-buries sprites; the light showed because lights don't
  depth-test).
- Creatures on the streets show an "invisible rectangle" that hides buildings
  behind them, exposing terrain — some draw-order/depth artifact, only seen
  when this rendering state is broken.

**The standalone paths all WORK** (structure scope at start, village spirit,
walking on the planet). Only the planet-embedded town under the spirit ladder
is broken.

## What the live probe proved (user's readout)

Status line in structure mode (probe instrumentation is in place — see below):

```
host 764x647 sp:f(509,796,10x8) vis:4/108 blk:0 me:514,800@h_292_rh | sess:spirit ptr:- gz:- hov:-
```
(ptr/gz fill in when the mouse moves; hover resolves objects; hover-light blooms.)

Interpretation — ALL of this is HEALTHY:
- view sized correctly (764x647), host mode;
- `sp:f(…)` — the dollhouse focus frame reaches the renderer, correct rect;
- `vis:4/108` — the visibility pass reveals 4 rooms of the focused house out
  of 108 staged live buildings; `blk:0` — no blackout cubes;
- `me:514,800@h_292_rh` — the parked invisible avatar IS inside the house.

The visibility SET is computed correctly (see the evidence-gap note above:
this readout does not show whether the reveal was ever APPLIED).

## The headless reproduction — RESOLVED (test artifact, see top)

`live-handoff.test.ts` is now GREEN and stays as the pin: the streamer's
`loadedLots()` drives `setLiveLots` correctly on a real generated town. The
√3 "identity" read was `Matrix4.decompose`'s degenerate-matrix guard, not an
object-identity mismatch — the mesh the test reads IS the mesh the closures
write (verified by uuid).

## Everything ruled out this session (with evidence)

1. ~~Gaze aim unbounded~~ — real but secondary; clamp added (steering only).
2. ~~Spark eased in rebasing world coords~~ — real, FIXED (camera-parented
   spark, camera added to scene; bobbing + spark-jumping gone per user).
3. ~~Stale camera (1-frame gaze latency violations)~~ — real, FIXED: the world
   ADVANCES (planets orbit/spin) + rebases on the camera point each frame, so
   anything reading last frame's camera matrix is a full frame of planetary
   sweep off the surface. stepGround now steers from last frame's aim and
   shoots the gaze ray only after the pose write; stepStructure steps the host
   AFTER the pose write. This fixed the camera jerk and ground steering.
4. ~~Interior rule / town-wide reveal~~ — implemented (spiritFrame restricts
   visible/blackout; town/district/ground seal). Probe confirms correct sets.
5. ~~Embedded host session type~~ — real gap, FIXED (mountLiveTown starts the
   embed with `spirit: true` when a spirit run is active: dwell-at-range
   affordances gate on `spiritNow()`, and non-spirit sessions let the
   forwarded pointer steer the parked walker). Did NOT fix the visuals.
6. ~~View never resized in host mode~~ — false: quest-host resizes once at
   world start from the canvas (probe shows real size).
7. ~~Cluster stage lacks loadedLots~~ — TRUE but NOT this bug: `clusterStages`
   (town-cluster.ts) omits `loadedLots` → `syncLiveHandoff` falls back to
   full-static; but clusters are only used by the FLAT town scope with
   `cluster: N` config, not the planet path. (Fix eventually: aggregate
   member `loadedLots` with house-index offsets. Also: user considers
   clustering a retirement candidate now that the planet streams towns.)

## Where the handoff seam lives (all round-2 work, believed correct)

- `shared/world-engine/interaction/town/town-stage.ts` → `loadedLots()`
  (houses = `houseMode` keys = `h.index`; works = `solid.has("w_"+i)` by
  array position). CONFIRMED returning correct sets.
- `games/world-lab/src/city-visuals.ts` → `TownMeshView.setLiveLots(loaded)`
  (instance order: `plan.houses` array order then `plan.works`; houses match
  by `plan.houses[i].index`, works by `i - houses.length`; HIDE_M zero-scale
  matrix; `hidden[]` change detector; streets hidden while loaded ≠ null).
  Also `debugHandoff()` → `statHid:N/M streets:on|off`.
- `games/world-lab/src/main.ts` → `liveStage` (set in `mountLiveTown`),
  `syncLiveHandoff()` = `liveViz?.view.setLiveLots(liveStage?.loadedLots?.() ?? null)`,
  called at mount + after every host step (airborne 20 Hz block, the spirit
  structure-rung wrapper step, the grounded walk block).

## Live instrumentation ALREADY IN PLACE (build is current)

Status line at ground/structure rungs shows:

```
… ‖ <render3d debugCutaway> | sess:… ptr:… gz:… hov:… | statHid:H/N streets:… lots:Xh/Yw
```

- `debugCutaway` (render3d): `host|own WxH sp:… vis:V/B blk:K cut:C/T door:D/E roofOpen:R me:…`
  — `cut` = tall walls currently invisible / total; `door` = door groups
  visible / total; `roofOpen` = roofs open or fading. These distinguish
  "reveal computed but not applied" from "applied but covered".
- `statHid:H/N` (city-visuals debugHandoff) — static instances hidden now.
  **THE KEY FIELD**: if the box covers the live house and `statHid` is 0 (or
  `lots:ABSENT`), the runtime handoff is broken (match the headless mystery);
  if `statHid` > 0 and correct, the covering geometry is something else.
- `lots:Xh/Yw` — `loadedLots()` sizes from `liveStage`.

Probe wiring: `main.ts` stepSpirit (planet path), `quest-boot.ts` onFrame
(flat path), `QuestHost3D.debugProbe()`, `WorldView.debugCutaway?()`.

## Shipped this session and CONFIRMED by the user

- Ground steering + camera bobbing fixed (stale-camera reorder + aim clamp).
- Spark no longer jumps (camera-parented, camera-local easing).
- Facing continuity across every rung change; structure exit spawns the glide
  OUTSIDE the footprint; building possession = glide AND settled gaze in the
  SAME footprint for 0.45 s (`GROUND_POSSESS_DWELL_S`), armed only after one
  frame outside all footprints.
- questCount 0 defaults, ladder law, one-ladder architecture (earlier stages).

## Shipped but NOT yet verified in browser

- Host-mode spark `setDepthTest(false)` (render3d constructor) — should
  restore the moving cursor in embedded ground/structure.
- One-cursor rule: the ladder's provider spark hides wherever a live host
  receives the pointer (structure rung; ground with a mounted town); the
  host's own spark is the cursor there. Flight keeps the HUD spark
  (depth-test off); open-wilderness glide keeps the provider spark with depth
  test ON (toggled per rung in stepSpirit).
- Structure rung re-asserts `setSpiritFocus(s.frame)` EVERY frame
  (self-healing); ground rung re-seals (`setSpiritFocus(null)`) every frame.
- Embed spirit session + planet ground-rung pointer forwarding (stepSpirit).

## Suggested plan for the fixer

1. ~~Make the two headless tests agree~~ — DONE (test artifact; see top).
2. ~~Get a fresh browser readout~~ — DONE. It says: handoff CORRECT
   (`statHid:36/287`), reveal COMPUTED (`vis:6/67`), reveal NOT APPLIED
   (`cut:0/358 roofOpen:0`), doors DO cut (`door:79/90`). See the fade
   section above.
3. **Read the next readout's `hideW`/`built`/`rev`/`minOp`/`dt`** and follow
   the decision table above. Prime suspect: rebuild thrash resetting fade
   opacity (`built` > 0 every frame). ~~static box~~, ~~cityViz from a
   different play~~ — both RULED OUT.
4. The creature "invisible rectangle" artifact is likely the same family
   (draw order / depth) — re-check after the box is explained; it may vanish.
5. Clean up when done: ~~delete `live-handoff-debug.test.ts` +
   `handoff-debug-out.txt`~~ (DONE), keep (green) `live-handoff.test.ts` as
   the pin, and strip the status-line probes (`debugProbe` appendices in
   main.ts stepSpirit + quest-boot onFrame) or gate them behind a flag —
   **the probes are still needed until the runtime bug is closed.**

## Test/build state

Root + world-lab `tsc` clean. `npm run build:games` clean.
`live-handoff.test.ts` = **2 green** (was the "open bug"; it was the test).
spirit-ladder.test.ts = 17 green (arming, gaze+glide possession dwell,
seal-on-exit, facing pins).

Pre-existing `tsc` errors unrelated to this work: `questless-worlds.test.ts`
(`GoalNode.via`), `popusim` covid.test.ts (missing scenario JSON).
