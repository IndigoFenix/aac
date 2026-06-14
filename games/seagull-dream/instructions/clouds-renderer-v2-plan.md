# Cloud Renderer v2 — rethinking the near-field primitive

Status: **experiment in progress.** The shipping renderer (`cloud-system.ts`,
billboards) is untouched and remains the default. New renderers live behind a
lab toggle so they can be A/B'd at every scale before anything is promoted.

This doc reconciles the conceptual discussion in
`clouds-metaballs-discussion.md` with what we have actually built, names the
real failure, and scopes the experiments — with the planetary-scale gotchas
the discussion glosses over.

---

## 1. What we already have (and why most of it is right)

The discussion's top recommendation is already our architecture:

| Discussion says | We already do |
|---|---|
| One density field, single source of truth | `weather-map.ts` (baked equirect RGBA) → `cloud-field.ts` `cloudDensityAt()`. Shell GLSL and JS sampler read the **same bytes**. |
| Orbital↔local = one field at two integration scales, crossfaded | Shell mesh (far) + billboards (near), **per-pixel distance crossfade** scaled to billboard reach. |
| Discrete↔connected as one continuous knob (stability `s`) | `cumuliformity` (anchor + synoptic vigor) drives puff↔disc, tower height, detail contrast — continuous, per-region. |
| Cloud entry = feather + near-plane dissolve + fog handoff off one field | Proximity dissolve in the sprite shader + `fogContribution()` envelope, both off `cloudDensityAt`. |
| Weak-hardware machinery | Column culling, two-gen sample cache, fresh-sample cap, radix sort, high-altitude early-out, baked-map texture fetch. |

**None of that is the problem.** The weather authority, the multi-scale
placement, the culling, the shell, and the crossfade are sound and must be
**kept**. They are also the parts that make planetary scale tractable (see §4).

## 2. The actual failure: the near-field primitive is still a billboard

Confirmed by the discussion's re-added turn: *"circular billboards… look great
up close or flying through… but the illusion breaks when changing distance
scales."* The discussion's very first answer predicted this — *"'any angle' +
'fly through' kills billboards/impostors outright."*

Our near primitive is a camera-facing Gaussian quad (with a planet-tangent
disc mode). That is an impostor. Four distinct snap sources, all rooted there:

1. **Zero motion parallax.** A flat quad has no internal depth, so dollying
   in/out reads as *a flat sprite scaling*, not a 3-D object approaching. This
   is the dominant "wrongness" cue when distance changes.
2. **Representation switch keyed on distance.** The puff↔disc `orientation`
   blend (`distFactor`) literally changes the silhouette as a function of
   range. That *is* the "switch representations" the discussion says to never
   do — just done continuously per-sprite instead of as a hard LOD.
3. **Overlap-composite drift.** Translucent Gaussians re-sort and re-overlap
   as range changes; the composite shimmers (the radix sort tames the worst of
   it but can't make flat sprites read as volume).
4. **Tier reorganization.** Cells at 200 m / 2 km / 20 km place maxima
   independently; crossing a tier fade reshuffles the sprite set.

What **true 3-D fixed-topology blobs** fix for free: parallax (1), no
distance-keyed silhouette switch (2 — the mesh is the same mesh from every
range), order-independent if rendered opaque/dithered (3), and no per-blob pop
(fixed topology). Tier reorganization (4) is softened, not eliminated — see §4.

## 3. The experiments

All implement the existing `CloudSystem` interface so the lab `loadScenario`
can swap them with one factory call. The weather map, field sampler, shell, and
distance crossfade are **reused unchanged**; only the near primitive differs.

### Experiment 1 — Instanced 3-D blob meshes (the discussion's option A) ← building first

- One primitive forever: a low-poly icosphere, **instanced**, placed at the
  same field maxima the current walk already finds.
- **Fixed topology** (icosphere subdiv never changes with distance) → can't pop.
- Cloud read comes from shading, not polycount (all three cues):
  - **Banded / toon** light (2–3 steps) off the real per-vertex normal.
  - **Fresnel rim** brightening on the silhouette — the single biggest
    "cloud not rock" cue.
  - **Billowy silhouette** via per-vertex hash/Worley displacement along the
    normal (cauliflower edge).
- **Sheetness is emergent**, not a second renderer: squash the icosphere along
  planet-up by `lerp(1, ~0.2, stratiformity)` and pack denser → stratocumulus
  falls out, cumulus stays round. One knob = `cumuliformity`, already in the
  field.
- **Render opaque first** (depthWrite on, no blend, no sort — weak-hardware
  ideal, order-independent). Transparency is reserved for the two places it's
  actually needed: LOD/crossfade fade and cloud-entry near-plane dissolve, both
  via **dithered (screen-door) discard** so we still never sort.
- Entry: near-plane soft dissolve in the fragment shader + hand off to the
  existing `fogContribution` envelope. `fade_band = max(band_min, N·v·Δt)`,
  crossover to fog at `v_crit = r_eff/(N·Δt)` (discussion's final turn).

Lowest risk, highest reuse, most low-poly-native. This is the baseline.

### Experiment 2 — Analytic raymarched shell (the discussion's option B)

A single shell sphere whose fragment shader marches the **thin** atmosphere
shell (analytic sphere entry/exit bounds the march — it does NOT march free
space), sampling `density(p)`. Truly scale-free, **zero** LOD transitions —
the cleanest possible answer to distance-shift snap. Heavier; weak-hardware
viability is the open question. Keep in the back pocket; prototype only if
Experiment 1's tier reorganization (§4.5) proves visible.

Deliberately **not** pursuing: metaball + marching cubes. §4.2 explains why it
does not survive planetary scale.

## 4. Planetary-scale issues the discussion under-addresses

The discussion reasons at "a planet" abstraction. Real radii (6.4e6 m Earth →
7e7 m Jupiter) with 200 m puffs break things the toy model never sees.

### 4.1 Float32 precision → floating origin is mandatory
A vertex authored at absolute radius 6.4e6 m has ~0.5 m of float32 quantization;
at Jupiter's 7e7 m, ~8 m. Geometry built in planet-centered coords **shimmers**
per frame. Solution (already used): iterate in **planet-local** coords with the
planet group translated so the camera site ≈ world origin. The blob shader must
transform the **instance center first** (`centerW = modelMatrix·iCenter`, the
big cancellation happens once), then add the radius-scale vertex displacement in
the small camera-relative frame — never author `center + vertex` at full radius.

### 4.2 The shell is thin → no 3-D voxel/marching-cubes grid is viable
Shell thickness is 5–50 km on a 6 371 km radius — a uniform Cartesian voxel grid
over the visible volume is absurd. Any implicit extraction must be
shell-parameterized (lat, lon, height) or a curved **cell walk with analytic
column culling** — which is exactly what we have (`O(reach²·thickness)`). This
is the concrete reason metaball + marching cubes is off the table at this scale,
and why "blobs at field maxima, culled to a camera patch" is the only tractable
extraction.

### 4.3 Blob-count explosion → the shell crossfade is NOT optional
A hemisphere of deck from orbit is millions of would-be blobs; you cannot
instance them. The near renderer **must** be bounded to a camera patch and the
far field **must** be the integrated shell. So the discussion's "single
representation, never switch" ideal is unreachable in pure form at planetary
scale — a shell↔blob handoff is forced. The escape (which the discussion itself
provides) is that both read the same coverage `C`, so the crossfade is
invisible *by construction*. We already do per-pixel distance crossfade. **Keep
it; change only the near primitive.**

### 4.4 Horizon curvature
At flight altitude the deck curves to a horizon hundreds of km out; far blobs
are edge-on. 3-D blobs have real thickness so they don't collapse like tangent
discs, but they must hand to the shell *before* they shrink sub-pixel — the
reach-scaled crossfade already governs this.

### 4.5 Tier reorganization is the residual snap (open risk for Exp. 1)
Fixed topology kills per-blob pop, but the blob **set** still changes across the
200 m / 2 km / 20 km tiers (each tier's maxima are independent). Hash-stable
placement keeps frame-to-frame coherence; the LOD band cross-fades the
membership. This softens but doesn't fully erase distance-shift reorganization.
If it reads as visible "churn," that is the signal to escalate to Experiment 2
(raymarch has no tiers). The dominant cue the user is missing — parallax — is
fixed regardless.

### 4.6 Unbounded detail-noise advection (pre-existing, minor)
`cloud-field` advects detail noise by `wind·timeSeconds`; over a long session
the sample coords grow large and simplex precision degrades (puff shimmer). The
synoptic map already dodges this via epoch-residual drift; the local detail does
not. Note for later — not a v2 blocker.

## 5. Verification

Use the cloud lab (`/cloud-lab.html`) + `shot-clouds.cjs` + `__labFlicker`:
- A/B the same scenarios across the distance ladder: `fair-weather-ground`
  (30 m) → `above-deck` (12 km) → `crossfade-climb` (35 km) → `orbit` (500 km).
- `__labFlicker(steps, strideM)` is the objective distance-shift metric: step
  the camera forward with weather frozen and pixel-diff frames. Healthy ≤0.5 %.
  Billboards spike here on dolly; the win condition for Exp. 1 is a **flatter
  flicker curve under forward motion** than billboards, at equal or better
  "reads as cloud."
- Giants (`jupiter-close`, `jupiter-disc`) are the float32 / thin-shell stress.
