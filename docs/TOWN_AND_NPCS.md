# Towns & NPCs — the canonical model

> Read this before touching anything under `shared/engine/town`,
> `shared/symbol-game` (town/quest code), `shared/world-engine` (NPCs), or the
> town paths in `games/world-lab` and `client-aac`. It exists because parallel
> work kept diverging here.

## The one-sentence rule

**A town is always a living town.** There is no "living-town" world type. Every
`scope: "town"` game — however you reach it (loaded directly, or descended
galaxy → planet → site → settlement) — is the same walkable place populated by
regular residents you can approach and talk to. The puzzle/symbol game is an
**optional overlay** on that town, not a different kind of town.

## Vocabulary (use these words)

- **Town** — a `createTownWorld` economy simulation laid out at real scale by
  `townPlan`, streamed as a walkable 3D stage. Always living.
- **Resident** — an NPC. A person with **needs/state** that evolve on the town
  clock (pantry runs dry → shopping errand). Bodies are streamed into the world
  by the town stage; they walk real errand paths.
- **Puzzle NPC** — **NOT a separate object.** It is a resident **with a flag
  that freezes its needs** (so its behaviour is deterministic and the puzzle can
  rely on it) plus a quest binding. Everyone else in the same town is a regular
  resident.
- **Puzzle** — optional content layered onto a living town: it adds frozen-needs
  residents and objectives. Requested by a field on the town spec, never by a
  world "kind".
- **Interaction** — dwell-to-talk works on **any** resident; what they say/do is
  driven by their needs/state. Quest NPCs are the branch where the state is
  frozen and bound to a quest node.

## Architecture: one BODY, several MINDS, one town kernel

**One NPC body system** — `shared/world-engine/npc-controller.ts` +
`world-host.ts`. `runWorldHost({ hostNpcs: true })`, `addNpc` / `removeNpc` /
`setNpcErrand`. NPCs are locally-owned steering bodies driven by the *same*
`steerAvatar` a player uses, so they can never diverge the sim
(`world-host.ts:296-318`). Behaviours are tiny: `stationary | wander |
approach_nearest` + `home/wanderRadius/speed` (`types.ts:306-340`). **The
world-engine layer has no built-in dynamic-needs model** — needs live in the
town kernel above it.

**Minds stacked on that one body system:**
1. **Town-resident mind** — needs/schedule + errands. The town kernel
   (`shared/engine/town`: `createTownManager`, `residents.ts`, `host.ts`,
   `town-world.ts`) is the canonical, *shared* implementation, consumed by BOTH
   grand-dream (`games/grand-dream/src/main.ts:39-41`) and the symbol game
   (`shared/symbol-game/town-stage.ts`). This is the "regular people" mind.
2. **Symbol-game scripted mind** — canned, language-keyed lines
   (`shared/world-engine/npc-dialogue.ts` + `npc-voice.ts`) used by quest NPCs.
3. **Social-call LLM mind** — a social-trainer `DirectedSession` over
   `/ws/social-bot`, owner-elected per NPC (`shared/social-world/…`). **This is
   the only call-coupled mind**; a town scope does not attach it.

The town kernel is already shared and unified — that was never the problem.

## What was wrong (the mis-fork)

The **town scope builder** `shared/engine/town/town-game.ts` (`buildTownGame`)
produces only the *aggregate* town: a `population` scalar + a street plan, with
no residents, no stage, no interaction (a spectator map). Rather than making the
town scope assemble the living town from the shared kernel, an earlier change
**bolted the living town on as a separate world kind** —
`world.kind: "living-town"` → `shared/symbol-game/town-play-game.ts`
(`parseLivingTownWorld` / `buildLivingTownGame` / `isLivingTownWorld`) →
`buildTownPlay`. The world-lab dispatch then chose between them
(`games/world-lab/src/main.ts`: `if (isLivingTownWorld(world)) bootTownPlay else
bootTown`).

Result: "plain" towns and every **descended** settlement render peopleless
static overviews, while the real town hides behind a special kind. That fork is
the whole misalignment.

Note `buildTownPlay` (`shared/symbol-game/town-play.ts`) is **client-facing**
(SymbolGameSandbox, GoalTreeQuestPlayer, goal-tree-player, via the
`engine:"town-play"` bridge payload). Its config-only signature is load-bearing
— generalize it only by **adding optional fields with defaults**, never by
changing what existing callers pass.

## Target & migration steps

1. **Fold the living assembly into the town scope.** `scope:"town"` always
   builds the living town (residents + walkable stage). Achieved by generalizing
   `buildTownPlay` to accept the document's economy (defaulting to the symbol
   village so client callers are unchanged) and routing the town scope through
   it.
2. **Delete the fork.** Remove `kind:"living-town"`, `isLivingTownWorld`,
   `parseLivingTownWorld`, `buildLivingTownGame`, and the world-lab dual
   dispatch. One `bootTown` that runs the living runtime. Merge the `village` +
   `living-town` test worlds into one town world.
3. **Puzzle as an optional field**, gated by presence (e.g. `questCount: 0` = a
   pure living town, no puzzle), never by a world kind.
4. **One NPC object type + a `needsFrozen` flag** *(in progress)*.
   - **`needsFrozen`** is now a first-class NPC property (`NpcSpec.needsFrozen`,
     `shared/world-engine/types.ts` + `schema.ts` — `.strict()`, so it had to be
     added there), set on the quest-giver bodies (`quest-host.ts`
     `planEmbodiedNpcs`, `town-stage.ts` cast). It is THE marker: a quest-giver
     is a resident whose needs don't drift; a regular townsperson's do. Both are
     the same kind of NPC (they were already the same `NpcController` body type —
     the "separate objects" were an id/spawn-path/mind distinction, not a type
     one).
   - **Dialogue strategy (per product owner):** regular residents don't have
     dialogue yet, so **port the quest-giver dialogue path to them and default to
     "a quest-giver with no quest."** DONE: the conversation loop (`quest-host.ts`
     ~1798) now also considers streamed `resident_*` bodies; the nearest resident
     shows an approach greeting and speaks a `SAMPLE_NPC_DIALOGUE` "greet" line on
     dwell (no board, no camera lock — the seam to grow fuller resident dialogue).
     A quest poser still wins when it's closer.
   - **Unification is at the TYPE + FLAG level, NOT the spawn source.**
     Quest-givers and residents are the same object type (both `NpcController`
     bodies via `runWorldHost`); `needsFrozen` names the distinction and the
     conversation loop treats both uniformly. But **puzzle units must stay
     independently authorable by the puzzle layer** — an area may be *all* puzzle
     units, they may bring unique buildings/items, or have rules relating to each
     other. So do NOT force quest-givers to be drawn from the ambient
     `residents.ts` population. Pulling a puzzle unit from the population is an
     *option* that needs additional consideration (which resident? does it stop
     running errands? does it own its house?), never the default. (It would also
     ripple across the ~10 `npc_<nodeId>`-keyed mechanics — `deliverStock`,
     `handOverItem`, the carry veto, thought bubbles, …) The puzzle layer already
     authors its own units/items/anchors (`town-quests.ts` /
     `creature-quests.ts`); that independence is the right shape.
5. **Descent lands in the living town.** Descent is the spirit ladder now
   (`shared/world-engine/spirit/ladder.ts`): it descends scope rungs by gaze —
   flight → town orbit → ground glide → structure dollhouse — over the flight
   streaming world, where an approached settlement founds itself and mounts as
   the living town (streamed creature-body residents replace the static plan
   building by building). The manual descend module
   (`games/world-lab/src/descend.ts`, `descendToSite`) was deleted.

Steps 1–3 are the structural **de-fork** (done first). Steps 4–5 are the deeper
follow-ups.

## Do / don't

- **Don't** add a `living-town` world kind, or any "is this town the interactive
  one?" branch. The town scope is always interactive.
- **Don't** model puzzle-givers as a separate entity class. They are residents
  with frozen needs.
- **Do** put resident needs/schedule logic in the shared town kernel
  (`shared/engine/town`), not per-game.
- **Do** keep the call-coupled LLM mind confined to `shared/social-world`; a
  town never imports it.

## File map

| Concern | Location |
| --- | --- |
| NPC body / steering / errands | `shared/world-engine/npc-controller.ts`, `world-host.ts` |
| NPC spec/behaviour types | `shared/world-engine/types.ts` (`NpcSpec`/`NpcBehaviorSpec`) |
| Scripted NPC speech (quest mind) | `shared/world-engine/npc-dialogue.ts`, `npc-voice.ts` |
| LLM NPC brain (call-only) | `shared/social-world/…`, `/ws/social-bot` |
| Town kernel (economy, residents, plan) | `shared/engine/town/` (`town-world.ts`, `residents.ts`, `host.ts`, `plan.ts`) |
| Town scope builder (aggregate — being folded in) | `shared/engine/town/town-game.ts` |
| Living town assembly + quests + stage | `shared/symbol-game/town-play.ts`, `town-quests.ts`, `town-stage.ts` |
| Playable town runtime (host, dwell-to-talk) | `shared/symbol-game/quest-host.ts` |
| World-lab town dispatch | `games/world-lab/src/main.ts`, `quest-boot.ts`, `worlds.ts` |
| Client symbol game (bridge payload) | `client-aac/.../GoalTreeQuestPlayer.tsx`, `SymbolGameSandbox.tsx`, `games/goal-tree-player/…` |
