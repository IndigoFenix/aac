# Creature behavior — movement, sitting, hauling

Status doc for the world-engine's resident bodies: why they spun at tables, why
they faced the wrong way, why they carried things forever. Written after a
debug pass driven by the lab's **🧭 Paths** overlay; the hauling (§4) and
chairs-at-meals (§3.3) fixes landed in a follow-up pass — their sections keep
the failure analysis as history.

Line numbers have drifted — navigate by the named symbols.

---

## How to see any of this

Load a **town**-scope world in world-lab and press **🧭 Paths** in the header.
Per body:

| Colour | Line | Means |
|---|---|---|
| 🔵 cyan | remaining errand waypoints | the door-routed PLAN (`doorRouteErrand`) |
| 🟡 yellow | body → live waypoint | the leg being walked now |
| 🔴 red | body → detour-bent aim | `detourAim` bent the aim around an obstacle |
| ⚪ grey | body → wander aim | no errand; idle roam |

Reading it:

- Yellow and red agreeing → the body walks straight at its waypoint. Healthy.
- **Red swinging while cyan sits still** → the detour is thrashing. The body is
  bouncing off something the planner can't see.
- **A cyan hop crossing a wall** → `doorRouteErrand` mis-routed.
- Grey pointing through a wall → an unreachable roam target (see §1.2).

Plumbing: `WorldHost.setPathDebug()`/`npcPaths()` (`world-host.ts:268-272`) →
`PathDebugOverlay3D` (`shared/world-engine/path-debug-3d.ts`) →
`QuestHost3D.setPathDebug()`. Capture is **off by default** — it allocates per
NPC per frame and a town hosts hundreds. The overlay composes with
`GoalTreeOverlay3D` inside quest-host (the renderer's `overlay` slot is single).

---

## 1. Movement — FIXED, but verify on screen

### 1.1 The table spin — detour shoulder had no commitment

**Symptom.** A creature next to a table orbits it, spinning, taking forever to
eat.

**Not the cause:** creature rotation. Steering is **holonomic** —
`advanceAvatar` (`engine.ts:642-651`) applies acceleration straight at the aim
regardless of facing, and facing is read *back* from velocity
(`FACE_SPEED_MIN`, `engine.ts:595`). Rotation is downstream. The spin is what a
flipping aim looks like, not what causes it.

**Actual cause.** The hysteresis feeding `detourAim`'s `prefer` was destroyed on
any single clear frame, and reset to a hardcoded `+1`:

```ts
if (bent !== aim) { detourSides.set(id, cross >= 0 ? 1 : -1); }
else              { detourSides.delete(id); }   // ← the bug
```

A bypass is a **maneuver, not a frame**. Halfway around a table the straight
line to the target clears briefly; the memory died there, so the next blocked
frame restarted from the default — possibly the *opposite* shoulder. Reverse,
re-block, flip back, orbit. Facing follows velocity ⇒ spin.

The player's walk aim had the identical bug (`playerDetourSide = 1` on clear).

**Fix, part 1 — the memory.** `createDetourMemory` (`npc-controller.ts`): the
commitment **expires on a timer** (`DETOUR_HOLD_S = 2`, renewed on every bent
frame) and is **never cleared on a straight frame**. Both the NPC loop and the
player path in world-host use it.

**Fix, part 2 — the memory wasn't enough (field regression).** Playtesting
showed the flip SURVIVED part 1. Root: `detourAim`'s candidate loop probed
widths OUTERMOST — `for w { for s of [prefer, -prefer] }` — so `prefer` only
broke ties at equal width. Arcing around a table, whichever shoulder cleared
at the NARROWEST width won; each flip was then `record()`ed over the memory
(it stores what *happened*), and the body dithered exactly as if there were
no memory at all. Now the loop is `for s of [prefer, -prefer] { for w }`: the
committed shoulder is tried at EVERY width before the other side gets a look,
so a commitment beats a narrower gap on the fresh side and flips only when
its whole side is walled. Pinned by the width-priority regression test in
`detour-commitment.test.ts`.

Why the round-trip is sound: `detourAim` offsets along ±perp(aim-dir), so the
cross product reduces to `len·w·prefer` — i.e. `sideOfBend(self, aim, bent)`
provably returns the `prefer` that produced the bend. The stored side is
faithful. **If you change `detourAim`'s bypass geometry, re-check that
identity** or the memory will commit to the wrong shoulder.

### 1.1b The errand walk, rebuilt (the fix that finally held)

The width-priority fix above stopped `detourAim` itself from dithering, but a
headless simulation of the FULL walk (real rooms + real furniture + doors +
the real follower — now pinned as `town-errand-walk.test.ts`) showed the
visible "flipping" was the tip of a stack of compounding failures. Each layer,
in the order the sim exposed them:

1. **Tangency-blocked stand points** — the furnishing fit rule packs pieces at
   EXACT wall clearance, so `standClear` at the full body radius read
   generator-legal spots as blocked by float error; `standPointFor` exhausted
   its candidates and fell back to an unreachable point, and the body ground
   at a wall while the detour force-flipped every frame. Fix: planning probes
   carry slack (`PLAN_SLACK`, stand-points.ts THE TANGENCY RULE).
2. **Corner-cut door wedges** — the 0.9 arrival radius advanced door transits
   from a wide angle; the straight to the next transit crossed the jamb, every
   detour probe landed in wall bands, permanent wedge. Fix: transit points are
   PASS-THROUGH flow vertices the follower passes by PROJECTION (see 5).
3. **Furniture-blind transits** — `routeThroughDoors` put transit points
   inside a table's no-stand box beside the door. Fix: `adjustTransitPair`
   (floor-route.ts) shrinks/slides the pair onto standable ground.
4. **The mid-room U-trap** — a table parked mid-room needs a DOGLEG bypass no
   single `detourAim` bend can produce ("slides on walls, never re-paths"
   ends at furniture). Fix: `refineIndoorLeg` (floor-route.ts) — a coarse
   grid BFS per blocked same-room leg, string-pulled at a fatter radius so
   the follower's corner cuts stay walkable. Assembled once per errand in
   `routeIndoorAware`, the ONE leg planner quest-host and the tests share.
5. **The follower itself** — the original per-waypoint follower (aim at the
   vertex, arrive by radius) fundamentally fights the locomotion: speed is
   PROPORTIONAL TO AIM DISTANCE (`gain × (d − deadRadius)`), so close aims
   brake-stall, and discrete waypoint switching vibrates/overshoots. Interim
   patches (tight arrivals, plane-pass bounds, walkable carrot ladders) each
   fixed one wedge and created the next. Final fix: `errandAim` is **PURE
   PURSUIT** over the planned polyline — project the body onto the path
   (monotone), aim along the carrot's DIRECTION extended to `AIM_REACH` 2.4
   (full speed), pass FLOW vertices by projection, clamp the carrot at STOP
   vertices (dwell points, the final target) so the brake lands them, and one
   progress watchdog (best-arc stalls 5 s → force-pass) guarantees
   termination. Overshoot self-corrects by construction — the carrot is
   always ahead of the projection, never behind the body.
6. **The detour hijack** — with a verified plan, the local detour DEVIATED
   from it (bending around the table's wrong side, then fighting the carrot).
   Fix: world-host skips `detourAim` on tight routed legs
   (`ctrl.errandLegTight()`); the detour remains for unplanned aims (wander,
   approach, outdoor building slides).
7. **Door-pinching furniture** — a legally-placed table could leave 0.1 m in
   front of an interior door (the corridor rect only forbids overlap).
   Fix: `ROOM_DOOR_DEPTH` 1.1 → 1.5 (placement.ts) — a 0.5 m lane survives
   any legal furnishing. Kernel suites confirm beds still fit.
8. **The anchor teleport** — a give-up that "arrived" an errand from meters
   away still fired the sit/sleep ACTIVITY, and `resolveActivityAnchor` slid
   the model onto the named bed/chair for the show and snapped it back after
   (read as "teleports to the destination and back"). First fix — a flat
   per-frame 2 m gate — caused TWO field regressions: honest arrivals stand
   1.5–2.4 m from a double bed's CENTER (stand ring + brake), so sleepers
   dropped to the floor IN FRONT of the bed; and bodies pinned near the
   boundary FLAPPED the gate, restarting the slide-on every few frames (the
   "jerking up and down"). Real fix: the anchor decision is **sticky per step
   episode** (`needStep.anchorId`, resolved ONCE on the first show frame,
   edge-relative cap `radius + 2.2`); a stall **give-up fixes it to `null`**
   explicitly — the semantic case the distance gate was approximating. The
   eat show's seat is likewise gated ONCE at show creation. NEVER re-gate an
   anchor per frame by distance.
9. **Corner-cut thrash past a waypoint** — a body that cut a corner and
   landed beside a LATER segment kept pursuing the earlier vertex: the carrot
   sat BEHIND it and it oscillated between returning and continuing. Fix:
   SKIP-AHEAD RECOVERY in `errandAim` — each frame, find the farthest
   upcoming segment (never scanning past a dwell STOP) the body already
   stands within 0.8 m of, and resume from there, passing the skipped flow
   vertices properly. Pinned in `path-debug.test.ts`.
10. **Walking through the animation / the wind-down snap** — three seams let
   a body MOVE while its sit/sleep/eat show played, each ending in a visible
   teleport when the anchor finally broke:
   - the instant-consume path deleted the step and the NEXT need decided the
     same frame, issuing a fresh errand mid-show → `stepNeeds` now DEFERS the
     decide while a `needEatShow`/`needPoseShow` is live (the dwell waypoint
     already holds the body; both maps tick in the same frame block, so no
     stall);
   - a give-up left the STALE errand aiming at the unreachable spot, dragging
     the "dozing" body → the give-up now PINS with a dwell waypoint at the
     body (and a commanded no-chair sit pins the same way);
   - render side (`creature-model.ts`): the root slide used the raw
     `activityLevel`, so a body dragged off anyway stayed GLUED to the
     fixture while its pose dissolved, then teleported to the sim body — and
     when a dwell ended, the anchor vanished a full blend before the pose
     did, snapping the root off the bed in one frame. Fix: `anchorSlideLevel`
     (movement dissolves the slide with the same `speed/0.2` dial the pose
     uses) + `createAnchorLatch` (the last anchor survives the wind-down
     until the blend reaches zero). Pinned in `anchor-slide.test.ts`.

End state, swept over every furniture errand in 24 generated houses: zero
detour thrash, zero permanent wedges, ~1.5% stuck + ~2% slow — all graceful
give-ups in genuinely walled-in furniture clusters, which the needs stall
watch terminates by design (retry → give-up → apply in place).

### 1.2 Aimless wandering walks into walls

**Symptom.** Idle creatures get stuck against walls. Cosmetic, but it reads badly.

**Cause.** `pickWaypoint` checked the **endpoint** only
(`npc-controller.ts:374`). Open ground behind a wall passes the check, and
wander has **no router** — errands get `doorRouteErrand`, a roam gets nothing.
The body grinds until `STUCK_SEC` (3s, `:293`) fires and repicks.

**Fix.** `corridorClear` (`npc-controller.ts:391`) samples the straight line at
0.75m at the body's own radius; a waypoint must be reachable, not merely open.

**Behavior change:** idle roaming is now **line-of-sight** — through a doorway
when the line passes the gap, else within the current room. That is the honest
range for a walker that can't route.

**Superseded for residents by IDLE PADS.** Even line-of-sight roaming
struggled in furnished interiors, so home idling no longer free-roams at all:
each house gets a designated clear rectangle — `idlePadOf` (floor-route.ts),
the largest furniture-free rect of the living room's walkable grid, probed
fat (0.5) so pacing keeps margin; a long clear LANE counts. Residents are
**pathed** to the pad (`walkResidentHome` targets a per-member spot inside
it, door/furniture-routed) and their wander is CONFINED to it
(`setNpcWanderRect` → `NpcController.setWanderRect`): waypoints are drawn
only inside the pad — where every straight line is walkable by construction
— and a body outside its pad stands still until the host routes it there,
never a blind roam. Pads are cached per house + construction rev. Non-house
NPCs (street walkers, pets) keep the line-of-sight roam.

---

## 2. Fixture facing — FIXED

**Symptom.** Chairs backed onto their tables; wardrobes and toilets nosed into
the wall they stand against.

**Cause.** `facing` is a **game angle** (`atan2` over game x/y) naming where a
piece's front looks; every producer agrees (`frameDirAngle`, `faceInto`, the
chair's `atan2(table − chair)`). Recipes are **+X-forward**
(`object-models.ts`). But the renderer laid game `y` onto THREE `+z`
**positively** and then assigned `rotation.y = facing` **raw** — mirroring every
fixture about the X axis.

Invisible at `facing ≈ 0` or `±π`; a full **180° at ±π/2**. On the real
`village` town: 326 chairs, 188 of them (58%) at ±π/2 and therefore backwards,
138 looking fine. Hence "a lot of it looks wrong" rather than all of it.

**Fix.** `fixtureYaw` / `bedSleeperYaw` / `rigYawTo` (`render3d.ts`).

> **LAW: never write `rotation.y = <a game angle>`.** Negate, or call the
> helpers. Pinned by `games/grand-dream/src/__tests__/fixture-facing.test.ts`,
> which rotates real THREE objects and reads directions back rather than
> restating the formula.

The bed's sleeper yaw was self-consistent *with the mirrored bed*, which hid
this for a long time — flip one without the other and the head leaves the
pillow. They are paired by construction.

---

## 3. Eating and sitting — FIXED (poses still crouch-rig, §3.4)

### 3.1 Diners drifted away mid-meal — FIXED

A `consumeAt` leg got **no dwell**, unlike rest/take/deposit. The errand
completed on arrival and `wanderAim` grabbed the body on the very next frame, so
the diner wandered off while the 2s eat rig played. Now
`dwell = EAT_SHOW_S + 1` (`quest-host.ts:2825-2834`), padded like the rest legs
because the needs loop counts arrival at **1.3** while the controller only
reaches its point at `ERRAND_ARRIVE` **0.9** (`npc-controller.ts:229`).

### 3.2 Sitting on chairs and toilets — FIXED

`resolveActivityAnchor` was hard-filtered to `kind === "sleep"` on a bed;
everything else kept whatever yaw the walk controller left. It now also anchors
`kind: "sit"`, which both cases already emit — the toilet/bath via the rest
branch of `syncNeedActivities` (`quest-host.ts:2873`), chairs via `commandSit`'s
pose.

- `SEAT_TOP_FRAC` (`object-models.ts`) = `{ chair: 2.2, toilet: 1.01 }`, derived
  from each recipe's own geometry.
- Kinds **absent** from it (tub, workbench) still return null and crouch in
  place — deliberate, not an oversight.
- `ANCHORED_ACTIVITIES` in `creature-model.ts` gates the slide-on;
  `eat` is excluded on purpose (a diner stands at the table's edge).

### 3.3 Chairs at meals — FIXED

The eat path used to take its stand point from the **table**, so diners stood
at its edge and chairs stayed decorative at mealtimes.

**Fix.** A `consumeAt` step at a `table` station now asks `freeSeatAt`
(`quest-host.ts`) for an unclaimed chair pulled up to that table and uses the
chair's own center as the stand point (chairs are `PASSTHROUGH_FIXTURES`, so
the center is standable). **Seat claiming** is derived, not stored: the step
records its chair in `needStep.seatId`, and `freeSeatAt` reads every other
body's active `seatId` plus physical occupancy (any body within 0.5 m of the
seat — covers commanded sitters and diners dwelling out a finished meal).
Steps are issued in cid order within a frame, so two same-frame diners can't
race for one chair. No free chair → the old table-edge stand point.

During the meal the eat show carries the seat along (`needEatShow.seatId`) and
`syncNeedActivities` emits **`sit` anchored on the chair** instead of the
standing `eat` — the body slides onto the seat facing the table (chairs face
their tables by construction, §2) while the food bubble shows the meal. The
hand-to-mouth eat rig still plays for standing meals (bowls, no chair free); a
seated-eat rig would need an anchored eat pose in the animator — future work.

The stall watch releases a stuck seat claim (`delete step.seatId`) before
re-picking the stand spot — a wedged chair approach falls back to the table's
edge rather than grinding.

### 3.4 Toilet/chair poses use the crouch rig

Known and accepted for now — a generic "use device" pose is future work. The
toilet will now at least be *facing* the right way, which may make the crouch
read as more obviously wrong, not less.

---

## 4. Hauling: creatures carry things forever — FIXED

### The structural root (was)

There was **exactly one** path that guaranteed a creature's hands get emptied:
the evicted-body branch, which banks every carried glyph into its home box and
calls `needCarried.delete(cid)`. It only ran when the body was *un-embodied*.
**Every other interruption left the stack in place.** That asymmetry caused
both symptoms below.

### Symptom A — "carries it around forever" (history; see the fix set below)

1. Body takes units → `needCarried` written (`applyNeedStepEffect`, `take`).
2. Something interrupts, or nothing fires:
   - party/spoken command exit (`:2478-2483`) — drops step + live, keeps carry;
   - the deposit target is full → `decideNeed` returns **`idle`**
     (`needs.ts:299`), silently dropped by `decideNeeds`;
   - the good has **no deposit row** for this member (`provisionTemplate` is
     pushed only for the member's roster duty);
   - the unit is a **treat**: `TREAT_KINDS` (`:331`) is not in `FOOD_KINDS`
     (`:311`), so `kindsOf("food")` (`:322`) excludes it and
     `provision:food`'s `ctx.carried` reads 0. `provisionedHeads` (`:3140`)
     *includes* treats, so `carriedClutter` excludes them and `tidy` reads 0
     too. **A gifted cookie matches no deposit row in the game.**
3. `decideNeeds` → null → **DEMOTE** (`:2686-2694`): treats "nothing fires" as
   "nothing to finish". But a full hand *is* a thing to finish. It also calls
   `reanchorHouseGoods`, which re-anchors the goods clock from **chest counts
   only** — so the haul is **erased from the economy's books while still
   physically in hand**.
4. Body is now `!live`. Next tick the shift-window branch `continue`s past all
   decision logic for the rest of the window.
5. `needCarried` is only read again by `syncNeedCarryProps` — which
   **deliberately hides the prop for commanded bodies** (`:2925`). So a
   recruited hauler holds something *invisible*. This is very likely why it
   reads as "wandering aimlessly, lost" rather than an obvious carry bug.

The design intent is actually sound — `needFires` (`needs.ts:174-175`) returns
true whenever `ctx.carried > 0` for a deposit/transform template, so a carrying
creature *should* re-derive a deposit. The bug is that `ctx.carried` is a
per-template projection through an exact key list, so a full hand projects to 0
for every template the creature owns.

### Symptom B — "keeps trying to put it somewhere but can't" (history)

1. The good *does* have a live deposit row → `needFires` true every frame.
2. `decideNeed` returns `deposit`.
3. Then either:
   - `standPointFor`/`needObjectPos` yields no `pos` → `continue` with **no step
     and no demote** → re-decide next frame, forever, while the body wanders; or
   - the step is issued, walked, arrived, and the deposit effect transfers
     `put === 0` and returns **silently** (`:3498-3519`: `if (put > 0) {…}` — no
     else). The step was already deleted before the effect ran, so there is **no
     retry counter and no give-up**. Walk → reach rig → deposit nothing →
     repeat.

Contrast: the *walking* stall watch does have a give-up (3 re-issues → arrive in
place). The *deposit* has none.

### The fix set (all landed)

1. **The carry projection** — the design-intent bug. `ctx.carried` was a
   per-template projection through the exact `kindsOf` list, so a carried
   TREAT projected to 0 for every food row. Now everything that reads a HAND
   projects through **`carryKindsOf`** (= `kindsOf` + treats for food):
   `residentNeedCtx`'s `carried`/`carriedOf`, the deposit effect's kind list,
   `kindOrder`, the carry prop's `repGlyph`, and the dialogue's holds-a-unit
   checks (which had also been indexing `carried["food"]` — a key that never
   exists; stacks key by kind glyph). A gifted cookie now fires hunger (gets
   eaten) or provision (gets banked) like any apple. The treats question is
   thereby decided: treats join food's **carry** list, NOT `FOOD_KINDS` —
   pantry counts and market baskets keep the strict list, so treats are still
   never dealt into mixes or counted toward provisioning. The whole kind
   vocabulary moved to **`kernel/town/goods-kinds.ts`** (pure, importable
   without the 3D host).

2. **Hands empty on every exit** — `bankCarried(session, cid, houseIndex)` is
   THE completion. It routes through `designatedContainerFor` — the ONE ladder
   that also serves tidying and fetch, so an item's home is decided in exactly
   one place: kind glyphs into their good's chest (food's is the refrigerator),
   water to the barrel, an owned thing to ITS owner's box, else the tidier's
   own box, else the cupboard. Eviction uses it (unchanged behavior);
   **DEMOTE banks before re-anchoring** — a full hand is a thing to finish, and
   banking first stops `reanchorHouseGoods` erasing live hauls from the books.
   The party/command exit, `joinParty`, and possession now **keep the LIVE
   flag** instead of deleting it (the "keep the body live until it's disposed
   of" option): the episode resumes when the interruption ends — a dismissed
   mid-haul recruit deposits or demote-banks; a possessed body (removed from
   the world) completes through the eviction branch that frame.

3. **`blocked`, not `idle`, when `room === 0`** (`needs.ts`, the deposit
   branch). A full pantry is now distinguishable from contentment: a carrying
   body with nowhere to put it surfaces (`blockedNeeds` entry, beg bubble, the
   one-shot diagnostic) and keeps the stack in hand — deliberate: a blocked
   exit is the one place carrying on is honest, and the row un-blocks the
   moment space frees.

4. **Deposit give-up.** A `put === 0` deposit now counts consecutive strikes
   (`needDepositFail`, keyed `cid|tplKey`, cleared on any successful deposit);
   the third banks the hands via `bankCarried` and logs — the same
   guaranteed-termination shape as the walking stall watch.

### Honest residue

- A treat banked in `chest_food` is invisible to the STRICT pantry count, so
  planning never draws a chest-only cookie back out (acquire reads
  `stackTotalOf`). Deliberate — treats don't provision — but it means a banked
  cookie is effectively archived until eaten by a taker's `kindOrder` reaching
  past real food.
- The blocked exit (fix 3) intentionally does NOT bank — the beg shows what
  the body cannot put away. If a container stays full forever, the body
  carries forever *visibly, surfaced*, which is the honest version of the old
  bug.

---

## 5. Landmines

- **`fixturesWalkable` is a Chebyshev BOX, not radial**
  (`engine.ts`), despite the field being named `radius`. For a table (r 0.8) +
  avatar (0.4) the blocked square has half-extent **1.2**, whose corner is at
  Euclidean **1.7**. A "safe" radial stand-off of 1.42 is walkable on the
  cardinals and *inside the box* on the diagonals. Two mitigations landed:
  `standClear` now **delegates to `fixturesWalkable` itself** (no restated box
  to drift) and takes a planning-girth `radius` param (default 0.4 — the
  per-NPC "big pet" seam; nothing passes a bigger one yet). And
  `standPointFor`'s fallback sweeps the **diagonals + a wider ring** before
  conceding — the old unchecked `dirs[0]` return could hand back a point
  inside another fixture's box. The final fallback is still unchecked (a body
  fully walled in has no clear point); the leg's stall watch copes.
- **A stand candidate must share the fixture's ROOM, not merely be locally
  clear.** Field regression from the wider ring above: a chest hugging the
  rear wall, crowded on every interior side, got its stand point probed PAST
  the wall — open ground BEHIND THE HOUSE, which `standClear` (a purely local
  test) happily accepted. The body then walked out the front door and ground
  against the back wall forever, its plan line slicing through the house
  (`bugged-path.png`). Every candidate in `standPointFor` and
  `nearestClearSpot` is now gated by `sameRoomAs` (same `buildingAt` node as
  the fixture — same room, or both outdoors). The stand-point family moved to
  **`interaction/quest/stand-points.ts`** (pure, importable without the 3D
  host), pinned by `town-stand-points.test.ts` — which also routes every room
  pair of real generated houses and asserts no polyline sample lands in a
  wall (`routeThroughDoors` itself proved correct; the through-wall lines
  were all downstream of bad endpoints).
- Three different arrival radii are in play on one walk: needs **1.3**
  (quest-host), errand **0.9** (`ERRAND_ARRIVE`), wander **1.5**, and
  `aimDeadRadius` **0.8**. They are not reconciled. The rest/consume legs pad
  their dwell to paper over the gap.
- `PASSTHROUGH_FIXTURES` = `{chair, bowl}` — chairs have **no collision**, so
  `standPointFor` returns a chair's exact centre. Intentional (a solid chair
  would wall off the table's own use).

---

## 6. Verification gaps — read before trusting anything above

- **The MOVEMENT half of the harness now exists**: `town-errand-walk.test.ts`
  walks real furnished houses end-to-end with the real follower, leg planner,
  detour block and engine locomotion — the sim that found every layer in
  §1.1b. It was made possible by extracting `stand-points.ts` and
  `floor-route.ts` out of quest-host. **The NEEDS loop itself is still
  un-harnessed** — `stepNeeds` lives inside `createQuestHost3D` (WebGL + TSX
  imports; jest can't import it). The pure halves are unit-tested
  (`symbol-game-needs`, `symbol-game-carry-projection` via
  `kernel/town/goods-kinds.ts`); the host-side pieces (`bankCarried`, the
  deposit give-up, seat claiming, the live-flag rule) still need on-screen
  verification (gift a treat, recruit a mid-haul shopper, overfill a pantry,
  watch a dinner). Keep extracting pure slices.
- The Paths overlay's geometry is tested (`path-debug.test.ts` — `THREE.Scene`
  needs no WebGL) but **its visibility on screen is not** (camera, material,
  render order). If lines don't appear, look there first.
- The overlay caps at `MAX_SEGMENTS = 12000` and sets an `overflowed` flag
  rather than truncating silently — but nothing surfaces the flag in the UI yet.

## Tests

| File | Covers |
|---|---|
| `games/grand-dream/src/__tests__/fixture-facing.test.ts` | facing law, sitter yaw, seat heights |
| `games/grand-dream/src/__tests__/detour-commitment.test.ts` | detour side contract, shoulder memory, wander corridors |
| `games/grand-dream/src/__tests__/path-debug.test.ts` | `errandPath()`, overlay buffer writing, skip-ahead recovery, idle-pad wander confinement |
| `games/grand-dream/src/__tests__/anchor-slide.test.ts` | §1.1b item 10's render half: movement dissolves the fixture slide, the anchor latch survives the pose wind-down |
| `server/tests/symbol-game-needs.test.ts` | the pure walker — incl. §4's blocked-on-full deposit rule |
| `server/tests/symbol-game-carry-projection.test.ts` | §4's carry projection (`goods-kinds.ts` — treats count under food) |
| `server/tests/town-stand-points.test.ts` | §5's same-room gate (the behind-the-house stand point), door routes over real generated houses, `idlePadOf` over furnished living rooms |
| `server/tests/town-errand-walk.test.ts` | §1.1b end-to-end: every furniture errand in real furnished houses arrives, no flip-thrash (the headless movement harness) |

The grand-dream ones are vitest: `npx vitest run --root games/grand-dream`.
The server ones are jest: `NODE_OPTIONS='--experimental-vm-modules' npx jest
--testPathPatterns="symbol-game-needs|symbol-game-carry-projection"`.
