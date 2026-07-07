# Plate Tectonics: the Geology Provider

The first real provider behind the Geology→Substrate seam (timescales.md §4/§8
named it MISSING; it no longer is). A deterministic, path-dependent stepper
whose baked output is exactly the field schema the substrate already reads —
`height` (0..63) and `ore` (0..15, finite) — so the civ layers consume it
through the ordinary `prepareSubstrate` path and cannot tell a tectonic world
from an authored one. Provenance-independence (timescales.md §1), made
concrete and tested.

**Landmarks:** `grand-dream/src/tectonics.ts` (the stepper + bake);
`PrepareOpts.ore` in `tri.ts` (the seam socket — an ore author replaces
`seedOreAboveTreeline`, cheat and simulator as alternatives behind one
interface); `buildTectonicTri` in `tri-worlds.ts`; the lab's "TRI — tectonic
(continents made this)" scenario; tests
`src/__tests__/tectonics.test.ts` (8, `npm run test:grand-dream`).

---

## 1. What it simulates

Per epoch (`tectonicEpoch`), all keyed hashes + fixed scan orders — same opts
⇒ bit-identical history:

- **Drift.** Plates are Voronoi blobs on a torus, each carrying an irregular
  continental cap (thick, buoyant) on oceanic floor (thin). Fractional
  velocities accumulate; whole-tile shifts move the crust rasters themselves.
  Continents genuinely travel — the keyframes show it.
- **Convergence.** Every cell claims its destination; claims resolve by
  buoyancy (continental beats oceanic), then thickness, then plate id.
  The loser's crust is consumed: ocean-under-anything **subducts** (modest
  uplift + volcanic-arc ore chance), continent-on-continent **collides**
  (heavy thickening + deep suture ore chance).
- **Collisional damping.** Each orogeny event damps both plates' velocities
  (×0.995): colliding continents slow, suture, and stop. Without this the
  fixed velocities grind the continents away cell by cell (observed: half
  the continental crust consumed in one 350-epoch history).
- **Rifting.** Cells vacated behind a drifting plate become fresh ocean
  floor welded to the old owner (seafloor spreading), with a rare shallow
  rift lode (surface evaporites).
- **Hotspots.** Fixed mantle-frame plumes build volcanoes through whatever
  crust drifts over — chains on a moving plate — rarely leaving deep ore.
- **Erosion.** Subaerial cells shed slope excess above a talus angle to
  their lowest neighbour (snapshot → deltas, order-free), with **sea level
  as base level** — relief is measured against max(neighbour, sea), or
  coastal cells keep cutting until they match the OCEAN FLOOR and the
  continents dissolve (they did; the clamp is the fix). Erosion builds
  foothills and coastal shelves, and it is the exhumation mechanism (§2).

Elevation is isostasy: `elev = (thick − 24) × 1.6`, sea below height 3.

## 2. Ore is caused, not painted

The cheat (`seedOreAboveTreeline`) paints ore above the treeline by fiat. The
provider emplaces every deposit at a geologic **event**, at a **depth**:

| event | trigger | richness | burial |
|---|---|---|---|
| arc | ocean subducts | moderate | mid (3) |
| suture | continents collide | rich | deep (8) |
| rift | new ocean floor | poor | surface (0) |
| hotspot | plume strike | rich | mid-deep (5) |

Deposits ride their crust column (they drift with the plate). A lode is
mining-visible only once erosion has stripped its rock `cover` to zero — so
**young sharp ranges hide their lodes; old worn ranges are mining country**,
and the ore–fertility anti-correlation that world-content.md §1 got *by
construction* now *emerges*: orogeny puts ore where mountains are, drainage
puts fertility where rivers run, and the occasional overlap (an old eroded
range at farmable height) is a legitimately interesting mixed town, not a
bug. Undersea lodes bake to 0 (invisible until the land rises). Tests hold
all of this: exposed < emplaced (some lodes stay buried), a spiked peak
exhumes while the same lode on a plain never does, and high ground stands
measurably nearer collision events than average ground.

## 3. Watchability (timescales.md §5, real now)

`runTectonics` records **keyframes** (`TectonicFrame`: baked height, plate
map, exposed ore) every K epochs — the scrub-through-history data the
timescales doc asked for. `buildTectonicTri` returns them alongside the
world.

✅ **Scrubber SHIPPED (2026-07-06):** `grand-dream/src/geo-scrub.ts` +
the lab's "Geologic history" slider (visible on tectonic worlds). A
position across the recorded history picks its two straddling keyframes;
the SHOWN terrain eases toward their blend (`easeToward` — §5b pointed
backward), so dragging morphs the continents through their drift instead
of snapping frame to frame. Deep time hides the settlement graph and
gates the sculpt brush (the brush edits the PRESENT); scrub back to
"now" and the live view resumes untouched. Renders sea/land/ore plus
plate seams (darkened boundaries) so the drift reads as plates. Tests:
`src/__tests__/geo-scrub.test.ts` (3).

## 4. What the tuning taught us (engine-relevant)

- **Erosion needs a base level.** See §1 — the single most important line in
  the module.
- **Fixed plate velocities are wrong for continents.** Real plates
  reorganize; the damping term is the minimum viable version. A future
  refinement is per-pair damping or full velocity re-rolls (Wilson cycles).
- **Integer terrain drowns drainage.** Two general fixes landed OUTSIDE this
  module, benefitting every world:
  - `computeFlow` (cell-systems `grid.ts`) now resolves **flats** — a
    deterministic BFS from each flat's outlets adds an ε·distance tilt so
    water crosses plateaus toward where they drain instead of dying on
    them. Outlet-less flats stay sinks (lakes), as before.
  - The bake **pit-fills** (Planchon–Darboux, ε=0): every land cell is
    raised to its spill level toward the sea, so the flow field finds a
    path everywhere despite micro-relief. The resulting exact-tie flats
    are what the flat-routing resolves. All-land worlds skip the fill.
- **The substrate gained a sea line**: `worldgenSubstrate` fertility is 0
  below height 3 (submarine), keeping crowds off the seafloor. Authored
  worlds floor land at 3, so they are bit-unchanged (checks stayed green).
- Mountain height is talus-limited (peak ≈ base + talus × range half-width),
  so treeline-crossing ranges need either sustained convergence feeding one
  front or a steep talus. Current constants: talus 8, erode 0.025,
  orogeny-keep 0.75, subduct-uplift 0.3.

Second round, from the first real look at the rendered map (2026-07-06,
same day — playtest report: "no vegetation, dry oceans"):

- **The sea must render from HEIGHT, not flow accumulation.** A flat ocean
  basin has no accumulation — every seafloor cell is its own sink — so the
  lab's water paint (river > 10) left the oceans bone dry. The rasterizer
  (`substrate-render.ts`) now reads the substrate's own sea semantic
  (height < 3) for computed-river worlds; rivers still paint from
  accumulation and now visibly pour into the sea they feed.
- **Vegetation was invisible EVERYWHERE, by construction.** Fertile tiles
  are river tiles (the fertility guards demand river > 15), and the
  renderer paints river tiles as water — grass grew only under the water
  paint. Fix in the substrate, not the renderer: `plant` now targets a
  NEIGHBOURHOOD fertility sensor (mean, radius 1) — a riparian HALO whose
  green banks flank the blue stream, which is also the honest ecology.
  Grid check #22's plant⊆fertile invariant became plant-near-fertile.
- **Pit-fill must run on the INTEGER surface.** Filling the float surface
  and rounding after re-creates pits at the rounding step — observed as
  scattered one-tile "lakes" swallowing whole catchments.
- **Coasts need despeckling.** Erosion deposits into single
  lowest-neighbour cells, piling one-tile islets (up to talus height)
  along the shelf — salt-and-pepper coastlines. The bake sinks islets
  with 3+ sea neighbours and silts coves with 3+ land neighbours (three
  fixed-order passes, deterministic).
- **Size beats climate knobs.** On 72×32, catchments were too small for
  real rivers, and it took a doubled-rain crutch to green the map. At
  144×64 (the shipped world), normal rain grows 440–660 fertile tiles
  (9–11% of land) and 50–70 founding sites across seeds. The `rain`
  multiplier on `PrepareOpts` stays as a legitimate climate profile, but
  the default world doesn't need it. Drift speed and hotspot count now
  scale with map size (calibrated at 32 rows), so any size lives the same
  relative history; cost is ~linear (144×64: ~0.2 s tectonics + ~0.6 s
  settle; 192×96: ~0.4 s + ~1.1 s). This is the planet-sized trajectory:
  the dial is already there, and nothing in the stack is worse than
  O(n log n) per rebuild.

## 5. Provider modes (timescales.md §2 mapping)

- **Simulate / coarse-simulate** — this stepper; step size is epochs, and
  350 epochs at 144×64 runs in ~0.2 s (it is *always* cheap enough to be
  the default at civ-map sizes, and stays ~linear on the way to
  planet-sized maps).
- **Generate (cheat)** — the shipped pair (`height` author +
  `seedOreAboveTreeline`) remains, untouched, behind the same
  `prepareSubstrate` sockets. Both providers were validated against the
  same consumer expectations (founding sites in both biomes, fertile
  valleys, exposed ore) — the §1 agreement clause, in tests.

## 6. Open questions

- **Sea as a first-class substrate field** — today the sea is "height < 3"
  (fertility, vegetation, and the renderer all read that line), which
  works, but ports/naval trade will want a real `sea` mask and coast
  detection.
- **Planet-sized maps** — the immediate path is the size dial (drift and
  hotspots already scale; costs are ~linear, verified to 192×96). The real
  frontiers are downstream: the settle pass and flow recompute at millions
  of tiles, region-windowed rendering (the seamless world already streams
  at house granularity — the map view would need the same), and the sphere
  topology below.
- **Wilson cycles**: velocity re-rolls / plate splitting so supercontinents
  break up again; currently a damped history converges to stasis (which the
  civ layers are perfectly happy with).
- **Climate**: latitude/rain-shadow writing the fertility target — the next
  candidate provider behind the same seam (it would modulate what rivers
  already do, not replace them).
- **Sphere**: the stepper is torus-native; a geodesic-grid variant follows
  the same "topology is a renderer concern" rule as everything else.
