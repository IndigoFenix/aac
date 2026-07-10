# shared/engine — the common game engine kernel

One engine, one JSON document, many games. A world document declares the
capability modules it needs and carries ordered content packs; each game
is a thin **composition root** that imports the kernel plus exactly the
modules it wants and supplies its own renderer. Tree-shaking does the
rest: a game that never imports a module never bundles it.

## Layout

```
shared/engine/
  manifest.ts        the kernel's document gate: EngineModule contract,
                     loadWorldManifest (envelope + capability check +
                     section routing), docsFor
  cells/             the simulation substrate (cell-systems): grid,
                     EntityWorld, day tick, fast-forward, worldgen,
                     idle-safety validators. Zero external imports.
    topology.ts      the lattice seam (GridTopology): adjacency, disks,
                     distances, open sides — the engine's dynamics are
                     topology-blind. SHIPPED: flat cols×rows(+wrap) and
                     CUBE-SPHERE (6 quad faces, geometric-fold seams,
                     equal-angle centers, unfolded-chart disks; closed
                     surface — openSides 0, water pools into seas).
                     PLANNED: icosahedral hex. The lattice is a
                     WORLD-LEVEL choice (quads buy octree/voxel digging
                     + exact window nesting; hexes buy isotropic field
                     dynamics — the game picks its trade). Curved grids
                     boot via createGridOn(spec, topoSpec) and carry
                     their TopologySpec through serialization.
  modules/
    economy/         the first capability module: EconomyDoc →
                     compileEconomy (goods, buildings, chains, species
                     as closed data; the compiler enforces the laws)
  geology/           the Geology→Substrate provider:
    tectonics.ts     FLAT plate tectonics (import-free): torus-translation
                     drift, collision, erosion, ore emplacement —
                     bakeAuthors plugs into prepareSubstrate; keyframes
                     make it scrubbable. Exports the TUNING constants the
                     sphere kernel shares.
    sphere-tectonics.ts  the SAME geology on curved lattices: rigid
                     Euler-pole rotation per plate, crust in plate-frame
                     rasters GATHERED into the world each epoch
                     (topo.cellAt of the inverse-rotated direction —
                     gather keeps plates contiguous where scatter would
                     tear rounding gaps). Same event grammar/constants,
                     bakeCellAuthors (cell-indexed — curved grids have
                     no x,y). Requires pos3 + cellAt (cube-sphere today,
                     hex later). NOTE: tectonics.ts's hash01 has a
                     historical signed-int32 quirk (~half its draws are
                     negative — flat histories are pinned on it); the
                     sphere kernel uses the sign-fixed hash.
  civ/               the civilization spine (settlement graph scale):
    composition.ts   CompositionWorld/CompositionOps — the structural
                     seam a demographic backend satisfies (PopuSim in
                     grand-dream, bound game-side via one cast); which
                     backend a world runs is the game's concern
                     (CompositionBoot is an explicit parameter, like
                     the town layer's compiled economy)
    dual.ts          DualWorld — Settlement (cells EntityWorld) ⇄
                     Composition coupled at the day boundary: driven
                     migration, vitals, civs, conquest, founding/absorb
                     transactions, O(1) rest jump
    tri.ts           TriWorld — Substrate + Settlement + Composition
                     over one map: harvest founding, mining depletion,
                     autoFound/colonize/merge, civ keyframes
    plan.ts          the planned-history provider: whole economic
                     histories through the same CivHistory seam, no
                     composition layer (politically silent)
  town/              the street-scale town layer (popusim-free):
    host.ts          TownHost — the structural seam a world satisfies
                     (grand-dream's TriWorld does, with no adapter)
    streets.ts       the organic street tree (dependency-free)
    plan.ts          townPlan/townBias — one town at real scale from
                     live settlement scalars, prefix-stable
    goods.ts         the household-goods street economy (shopping
                     cycles, boxes, stalls, catchments, traffic)
    districts.ts     neighborhood-market founding (city fractal step 1)
    city-districts.ts tier-B district decomposition + fill allocation
    town-world.ts    a STANDALONE living town: one settlement's books
                     over a compiled economy, no composition layer —
                     demand and Malthusian vitals written at day start
                     where the dual coupling would write them; rest-
                     jumps long absences (worldFastForward)
    residents.ts     WHO EXISTS WHERE, DOING WHAT — the population
                     model every view streams from (households, indoor
                     homebodies, embodiment radii/ranking, the
                     no-blink-out lock, door-bracketed trips). THE
                     PARITY LAW: mechanics live here, in the world
                     model; a top-down map and the 3D view stream the
                     same people to the same places — the camera only
                     decides what gets drawn (visibleR feeds the
                     pop-in rule alone).
```

`shared/world-engine/` (the avatar-scale frame loop, WorldSpec, NPC
bodies) is the kernel's individual-scale counterpart and already shared;
the two meet in the games that host both.

`shared/planet/` is the PLANET-scale renderer (seagull-dream's
cube-sphere quadtree terrain, ported framework-free): a `PlanetSurface`
seam (surface.ts) sampled by chunk.ts + lod.ts, with three.ts as the
only graphics-touching adapter. `substrateSurface` closes the loop with
THIS engine: it reads a cube-sphere cell grid's fields by direction
(topo.cellAt/pos3, continuous kernel interpolation — land never sinks),
so a tectonic/civ world renders as a walkable-scale LOD planet.
`noiseSurface` serves bodies with no simulation underneath.

## Laws

- **The kernel never imports a module; modules never import a game.**
  `shared/` never imports from `games/` (build-enforced: no such alias
  exists here).
- **Order is semantic.** Packs compose later-over-earlier (cross-pack
  key override); process arrays chain same-step in array order. Module
  registration is an ordered list at the composition root — nothing
  iterates an unordered map over content.
- **Reject, never skip.** A document that `uses` an unregistered module,
  or carries a section nothing claims, fails at load with an exact path
  and the list of what IS registered. Unknown fields inside a section
  are the owning module's to reject (the `parseEconomyDoc` pattern).
- **Compiling is typed and per-module.** The kernel routes parsed docs;
  each game calls its modules' compilers (`compileEconomy(docs, opts)`)
  directly. A uniform compile/boot contract joins the kernel when a
  second module actually needs one — not before.

## Consumers today

- `games/grand-dream` — the civilization lab: composes economy content
  packs (core, goods2, clothing, wildlife, dwarves) over this module and
  runs the four-layer world. Its `src/economy*.ts` are re-export shims
  kept so internal imports and content files stay put. The engine's
  tests currently ride grand-dream's vitest suite
  (`src/__tests__/engine-manifest.test.ts`, `economy-*.test.ts`,
  `species.test.ts`), since that is where the proving-ground worlds live.
- `games/sandbox-game` — the cell-systems editor UI over `cells/`.

## A world document

```jsonc
{
  "engine": "aivota-world",
  "engineVersion": 1,
  "uses": ["economy"],                       // refused if not registered
  "game": {                                  // the game-maker's session shape (optional)
    "scope": "planet",                       // structure | town | region | planet | solar_system | galaxy
    "world": { /* the scope-typed world definition */ },
    "initial_focus": "town:riverton",        // or a parameter set { … } (first match wins), or null
    "avatar": true,                          // spawn an avatar in the focus; null = whole-area view
    "creative_mode": false                   // true = the focused object is player-modifiable
  },
  "packs": [                                 // ORDER IS COMPOSITION
    { "name": "core",     "economy": { /* stockpiles, commodities, buildings, species */ } },
    { "name": "clothing", "economy": { /* overrides farm, adds sheep/wool/cloth */ } }
  ]
}
```

The `game` field is the template seam: `scope` limits the world to ONE
object of that type on the nesting ladder; `world` defines it; the
generation always covers the whole scope while `initial_focus` frames
what the player sees first. The kernel gates the shape (`GameSettings`,
path-exact refusals — see `parseGameSettings`); deep validation of
`world` belongs to the scope's builder, exactly as pack sections belong
to their modules. Runtime semantics (resolving a focus, spawning the
avatar, creative editing) are the composition root's job per scope.

## The content/machinery split (the town carve's law)

The shared town layer takes the compiled-economy registry as an
EXPLICIT parameter — which registry a world uses (and any fallback) is
the game's concern. Grand-dream's `zoom.ts`/`food.ts` keep the pre-carve
signatures as thin wrappers resolving `tri.economy ?? DEFAULT_ECONOMY`,
plus the content that stays game-side: FOOD_GOOD/TOOLS_GOOD, the
DEFAULT_ECONOMY classifier, founding seeds (villageSeed). Towns are
byte-identical across the carve (the suite pins it).

What stays in grand-dream's `zoom.ts` on purpose: vignettes, the town
manager, embodied villagers and parties — everything that reads NAMED
residents (popusim histfigs). That is the demography module's territory.

## Roadmap (see games/grand-dream/civilization-emergence.md §7+)

- ✅ The needs projector / effect applier / session quests SHIPPED as
  `shared/symbol-game/town-quests.ts` (the town⇄creature JOIN: body =
  errand clock, mind = creature sim; SNAPSHOT / DELIVERY / GENEROSITY
  contracts documented in its header). Remaining for the symbol game:
  town → world-engine WorldSpec at avatar scale (proximity-streamed
  NPCs under WORLD_MAX_NPCS) and the goal-tree player hosting a
  TownWorld + TownQuestBundle (cast anchors → real houses/counters).
- Demography module: the headless popusim controller slice (named
  residents, migration, herds, politics), extracted only when a game
  needs full composition-layer worlds. The civ spine is already shared
  (`civ/` — dual/tri/plan over the `CompositionWorld` seam), so this
  carve is purely a popusim extraction: a shared backend satisfying
  `civ/composition.ts`, replacing the game-side `bootLab` binding.
- Runtime hooks on `EngineModule` (boot/onDay/board-projection) when the
  first module with a runtime lands; the AAC board projection is a
  KERNEL extension point, not a module.
- Spherical topologies (decided: BOTH, a game-level choice). The seam is
  `cells/topology.ts`; flat and cube-sphere ship (cube-topology.test.ts
  pins the lattice + the engine running on it), icosahedral hex follows.
  Geodesic tectonics SHIPPED (`geology/sphere-tectonics.ts`,
  sphere-tectonics.test.ts pins determinism / caused-not-painted /
  continent survival). CIV-ON-SPHERE SHIPPED: the civ layer is
  lattice-generic — `prepareSubstrateOn(topology, cell-authors)` is the
  substrate twin, charters/harvest/mining read topo.disk, distances
  read topo.dist2, cities carry `cell` (x/y stay as flat-chart
  presentation coords). sphere-civ.test.ts runs the full tri arc on a
  tectonic planet (harvest conservation, tectonic charters, PopuSim
  coupling, mining depletion, deterministic); flat worlds are
  bit-identical across the port (disk/dist2 replay the old scans
  exactly). Still ahead: the finite-volume upgrade (per-cell areas +
  per-edge weights in transport; flat stays bit-identical at weight 1)
  and the icosahedral-hex lattice.
