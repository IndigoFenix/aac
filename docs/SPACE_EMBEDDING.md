# Space generation & puzzle embedding

How a puzzle becomes a place that **feels like it wasn't built around the puzzle** —
a house, and (later) a dungeon, an office, a town errand. The reusable engine.

## Three artifacts, kept separate

The mistake is "puzzle-first vs. layout-first." There are really three things:

1. **The dependency DAG** — the pure puzzle. "Room B is gated behind A," "person
   Y needs item X." No geometry. This is what `certifyGoalTreeGame` validates; the
   certificate is already layout-agnostic (`projectGameLayout` proves it — same
   certified world, village *or* icicle geometry).
2. **The space** — a believable place generated **puzzle-blind** from *function*,
   the way the town grows from *economy*: a living-room core (plaza), hall spine
   (streets), role rooms with needs (districts), furniture — and **surplus** the
   puzzle never touches.
3. **The embedding** — the pass that marries them.

Build 1 and 2 independently, then embed. The DAG is what "builds first" (so gating
is real); the space is what "feels first" (so it reads as a home). They meet only
in step 3, and the certificate — living on the DAG — stays valid however the space
is drawn.

## Why it stops feeling puzzle-shaped

A real place is **already a partial order of accessibility**: foyer → living →
hall → bedroom → ensuite, public to private, front to back. That gradient exists
with or without a puzzle. So we don't *impose* the puzzle's depth on the space — we
**align** the DAG with the space's own accessibility gradient (circulation depth
from the entrance) and drop gates only onto **plausibly-lockable** chokepoints the
place would have anyway (a bedroom door, a cabinet — never the kitchen↔living
opening). The lock reads as "the back bedroom," not "puzzle wall #3."

Three techniques do the selling, all of which the town already embodies:

- **Generate excess, then hide the puzzle in it.** The puzzle is a *subgraph* of a
  richer world, not the whole skeleton. Bathrooms, closets, a second hall.
- **Diegetic gates, sourced from the place.** Not "wall until flag" — a locked
  bedroom whose key the owner hands you, a "someone's asleep" social gate, an
  appliance that needs power. The *removal* is diegetic too.
- **Randomize everything the DAG doesn't constrain.** Room shapes, which side a
  bedroom lands on, how the hall bends — the same organic jitter `streets.ts` uses.

## The module boundary

```
shared/place/
  space.ts   — generic PlaceSpace model + SpaceGenerator interface (place-kind
               agnostic; no goal-tree dependency)
  house.ts   — houseSpaceGenerator: a believable floor plan (living + hall + role
               rooms + furniture), a TREE of rooms rooted at the living room, each
               door tagged with lockability, each room with role/depth/affinity
  embed.ts   — embedPuzzle(world, space, seed): map a goal-tree LogicalWorld (the
               puzzle DAG) onto a PlaceSpace → a Layout2D + one BuildingSpec +
               furniture + per-gate diegetic justification
  index.ts
```

`SpaceGenerator` is the extension point: `house`, then `dungeon`, `office`, …
`embedPuzzle` is shared across all of them — only the generator and the role
vocabulary change.

### The embedding algorithm (seeded CSP)

Nodes = rooms/containers; edges = doors, each carrying a *lockability* cost. Assign
puzzle-DAG nodes → rooms so that:

- every gate lands on a high-lockability door,
- topological order respects circulation depth (later ⇒ deeper/more private),
- **roles match content** — the hungry neighbor's food is in the *kitchen*, the toy
  in the *kid's room* (affinity match; this is what makes placement look
  life-driven, not puzzle-driven).

If no embedding fits (puzzle deeper than the house), the **space** flexes — grow a
wing, add an upstairs, regenerate — never the puzzle.

## Status

- [x] `space.ts` — interfaces
- [x] `house.ts` — the house instance (tested: `server/tests/place-house.test.ts`)
- [x] `embed.ts` — `embedPuzzle` implemented for the STAR puzzle: transforms the
      star world into a house-shaped world (circulation added as free passages,
      completability-equivalent), assigns zones→rooms (gated→deep+lockable,
      free→affinity match), lays content via the projector's own spiral, raises
      one contiguous house, justifies each gate. Tested:
      `server/tests/place-embed.test.ts` (validateLayout2D + a valid world spec).
- [x] Wiring: `makeQuestSession` (quest host) plays the embedded house for
      non-town `layout: "house"` games — it swaps in the embedding's transformed
      world + layout + contiguous buildings (else falls back to the village). The
      interim naive `projectHouse2D` is retired; `projectGameLayout` certifies
      house games on the village layout (topology-only), and the real floor plan
      is the embedder's. Verified in the world-lab "household" scene (spirit
      dollhouse over a real floor plan; 0 errors).

## Next / polish

- Furniture is generated (`space.fixtures`) but not yet raised as world objects,
  and puzzle content lands in the right ROOM but not yet ON a specific fixture
  (kitchen table vs. loose) — fixture-precise placement + openable-container
  hiding is the next refinement.
- Diegetic gate *reasons* are computed (`gates[].reason`) but not yet surfaced in
  dialogue ("it's in the locked bedroom — ask X for the key").
- Second `SpaceGenerator` (dungeon/office) to exercise the boundary.
