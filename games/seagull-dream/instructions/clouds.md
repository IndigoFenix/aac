# Cloud / Weather System

One weather authority per body, three renderers. The goal: the same
cyclone is visible from orbit, from flight altitude, from the ground, and
as fog when you fly through it — and weather *structures* (fronts,
cyclones, banding, decks, towers) flow into one another continuously
instead of being discrete types.

## Architecture

```
weather-map.ts   SYNOPTIC scale (≥ ~200 km). Pure math, no three.js.
                 2D field on the sphere: cover / vigor / zoneT / storm.
                 Baked progressively into an equirect RGBA Uint8 map.
                      │
cloud-field.ts   LOCAL scale (~1–100 km). Adds vertical structure
                 (vigor-driven cloud tops), 3D detail noise, layer
                 colors. cloudDensityAt() = map sample + detail.
                 deriveCloudField() maps the physics-system Atmosphere
                 to all parameters (continuous, no discrete types).
                      │
cloud-system.ts  Renderers, all reading the SAME map bytes:
                  • shell  — sphere mesh / GLSL, samples the map
                             texture directly (orbit & far view)
                  • sprites — hierarchical cell walk + Gaussian point
                             billboards (flight & ground view)
                  • fog    — fogContribution() at the camera position
```

### Why a baked map

The old system evaluated JS simplex FBM for billboards and a *different*
GLSL value-noise FBM for the orbital shell — the patterns never matched,
so clouds visibly morphed at the LOD crossfade. Baking the synoptic field
once (JS) and having both the GLSL shell and the JS billboard sampler
read the same bytes makes every altitude consistent by construction.
It's also cheaper: the shell shader does one texture fetch instead of
3 octaves of noise per pixel, and the CPU sampler does one bilinear read
(~0.26 µs) instead of re-deriving banding/vortices per cell.

### Map channels (equirect, RGBA8, 256–1024 px wide by body size)

- **R cover** — cloud coverage/opacity. Steep ramp: clouds are mostly
  opaque with clear gaps; the `coverage` param controls areal fraction.
- **G vigor** — convective development. Lifts local cloud tops, raises
  cumuliformity (flat deck → towers), feeds storm darkening. This is the
  channel that lets stratus sheets and cumulus fields coexist on one
  planet and blend into each other.
- **B zoneT** — belt↔zone color blend (banding + vortex identity).
- **A storm** — storminess; darkens cloud color (future: rain/lightning).

### Cluster emission (billboards)

A cell emits a CLOUD, not a sprite. A lone Gaussian circle reads as a
ball, so puff-mode cells emit 3–6 overlapping puffs (hash-deterministic
offsets — stable across frames):

- Puff diameter is capped at ~the layer thickness — a 20 km cell renders
  as a bank of ~5 km puffs, not one 28 km ball (and less GPU fill).
- Puff bottoms clamp to the layer base (flat condensation-level bases) —
  this is what keeps big sprites out of the terrain. Clearance scales
  with puffiness; tangent discs need none. Mountains above cloud base
  still poke through, which is physically correct.
- Tangential spread covers the cell footprint; vertical spread scales
  with cumuliformity, and vigorous cells raise a top puff into a tower.
- Sheet-mode cells (stratus, or anything far enough that the orientation
  blend goes disc) emit tangent discs that tile with neighbors and can't
  clip terrain; an isolated cell gets a small companion disc so deck
  edges don't read as single circles.
- The two regimes blend CONTINUOUSLY: as orientation approaches the
  sheet threshold the cluster collapses — spreads shrink, sizes grow to
  the disc size, surplus puffs fade out one at a time — so there is no
  count/layout pop at the regime boundary, and alpha is conserved via an
  effective-puff-count divisor.

### Synoptic ingredients (all continuous parameters)

- **Banding with meander** — `cos(2N·lat + waviness·noise)`; Earth-likes
  meander (Rossby look), fast-banded giants run straight.
- **Flow-stretched coverage noise** — isotropic noise blended with a
  zonally-stretched chart (periodic in lon by construction); high
  `streakiness` smears clouds along the jets.
- **Vortex population** — deterministic slots advected by the local jet,
  growing/decaying on a lifecycle (`vortexLifetimeDays`: days on
  Earth-likes, ~persistent ovals on giants). Each vortex spiral-warps the
  noise around it (comma/spiral arms), boosts vigor + storm, can develop
  a clear eye, and tints zoneT (GRS-style identity).
- **ITCZ vigor band** — equatorial convection on water-cycle worlds.

### Drift model (the no-snap-back invariant)

`synopticAt()` evaluates the pattern advected to absolute time t (noise
coordinates slide east at the latitude's jet speed; vortices ride along).
Renderers add only the *residual* drift since the texel's bake epoch:
`sample(lon − drift·(now − epoch))`. When a row re-bakes, the new bytes
already contain the drift the residual was covering — motion is
continuous across sweeps and the scroll offset stays bounded. The GLSL
shell mirrors `zonalSpeedMs`/`zonalDriftRadPerSec` exactly — if you
change one, change the other. Covered by tests
(`server/tests/seagull-weather-map.test.ts`).

### Weather evolution

The map re-bakes continuously, a few rows per frame inside a ms budget
(`cloudBakeMs` slider; deficit-accumulator pacing with a measured
per-row cost EMA). A full sweep ≈ 5–15 s; vortex lifecycles and slow
noise morphing happen at `weatherDaysPerSecond` so storms are born and
die within a play session. Until the FIRST sweep completes the budget is
elevated (~4 ms/frame) so weather exists by the time the body finishes
its fade-in; no synchronous prebake hitch.

## Performance machinery (weak-hardware priorities)

- **Column culling** — clouds live in a thin spherical shell; for each
  (x,z) column the valid y-cells are solved analytically (two mirrored
  bands), so the walk is O(reach² × shellThickness) not O(reach³).
- **Cell-sample cache** — a cell's field sample is camera-independent;
  cached with a staggered ~0.7 s TTL in a two-generation map (swap every
  2.5 s evicts left-behind cells). Steady flight re-samples only a few
  dozen cells per frame; empty-sky cells cache as zero too.
- **Fresh-sample cap** — cold-cache moments (teleport/warp) sample at
  most ~700 cells per rebuild; the rest condense in over the next few
  rebuilds instead of hitching one frame.
- **Rebuild cadence** — billboards rebuild every `cloudUpdateEvery`
  frames (default 2); sprites are planet-anchored so off-frames stay
  coherent.
- **Counting sort** — far-to-near ordering via 256 distance buckets;
  O(n), allocation-free (replaces comparator Array.sort).
- **High-altitude early-out** — above billboard reach the walk is
  skipped entirely; the shell alone represents the planet from space.
- **Perf counters** — `cloudSystemStats` (bake/walk/sort ms, cells) and
  `cloudFieldStats.samples` are exported for the debug readout.

Measured (dev machine, node): inside a dense deck ≈ 2.7 ms/frame
(~3.5 k sprites), above the deck ≈ 1.2 ms, orbit ≈ 0.5 ms.

## Lighting

Sun shading is CPU-side per sprite (terminator smoothstep + diffuse on
the planet-local up vector, night ambient 0.12) and per-pixel on the
shell (same formula in GLSL). Cluster puffs darken toward the layer base
and brighten toward their tops. The sun position is pushed per frame
from world.ts (`setSunWorldPos`); no star → unlit (deep space).

## Layers

`deriveCloudField` emits the main deck plus, on water worlds, a thin
high cirrus veil (decorrelated by a map longitude offset, no vigor
response, streaky detail). Layer count is open-ended; each layer gets
its own shell mesh and its own detail scales.

## Tuning

GFX sliders (debug menu → Clouds): opacity, sprite size, min density,
wind mult, fog boost, detail, vigor, bake ms, update every. Per-body
structure comes from `deriveCloudField` — anchor values per cloud
chemistry live in `CLOUD_TYPE_ANCHORS` (synoptic/detail scales,
cumuliformity, vigor, vortex activity/lifetime, cirrus flag).
