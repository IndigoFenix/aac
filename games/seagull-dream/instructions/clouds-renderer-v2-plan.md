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

### Experiment 1b — Billboard variant (same walk, sprite instead of icosphere)
`createBillboardCloudSystem` reuses the ENTIRE blob pipeline (walk, sizing,
geomorph, coarse envelope, cull, cache) and only swaps the icosphere for a
camera-facing quad — to test whether the old billboards' failure was the
billboards or the (now-fixed) sizing. Lab mode `blob-billboard`. Findings:
- **Angle-stretch ellipse, face camera.** The quad squashes its up-axis to the
  ellipse the ellipsoid projects to (occupies the blob's screen area; lies flat
  so large near sprites don't bulge into terrain). GOTCHA: building the ellipse
  from a reconstructed `majorDir/minorDir` screen basis produced **degenerate
  quads** (rendered nothing). The robust form is to take the round offset
  `q*R` and squash only its component along the screen-projected up —
  identical to round at `minorScale=1`, so it can never collapse. A small floor
  (`BILLBOARD_MIN_MINOR`) keeps flat decks from thinning to nothing (a flat
  sprite at the center plane can't fill a deck-from-below the way the 3-D blob's
  volume does).
- **Alpha-blended, not opaque+hashed.** Billboards want smooth soft edges;
  hashed-alpha grains them AND misbehaves on sub-pixel-thin edge-on ellipses.
  So the billboard material is `transparent`, `depthWrite:false`.
- **Solid albedo + alpha edge + SUN light/shadow mask.** One albedo color
  (`vColor`); the edge is alpha (an earlier rim brighten made a hard white
  boundary ring). Shading is a world-anchored **light/shadow mask keyed on the
  SUN** — `frontLit = dot(viewDir, sunW)` (bright when you see the front-lit
  side, dark when back-lit) plus a gradient toward the sun's screen projection.
  A first attempt used a sphere-IMPOSTOR normal (reconstructed from the sprite
  UV), but that normal is **camera-relative** so the shade *swam* as you looked
  around — e.g. looking horizontally at lit cloud tops showed them in shadow.
  Keying on the sun fixes it (tracks the sun, stays pinned to the cloud).
  Captures sun azimuth + elevation; a flat sprite still can't resolve the full
  3-D form — the icosphere blobs do.
- **Coverage / placement threshold.** `minDensity` (live "cover thresh" slider)
  gates BOTH the fine puffs and the coarse envelope, so one control thins the
  whole sky (0.05 = full field → 0.30 = sparse scattered). The direct lever for
  "too many clouds." Blob size is already density-driven (coarse `√cover`, fine
  `fill`), so a size-from-density slider is a trivial add if wanted.
  **`fogContribution` matches it:** the interior fog now applies the SAME
  threshold (returns 0 below `minDensity`, remapped 0→1 above), so raising the
  cover slider doesn't leave "invisible fog" in gaps where a cloud was culled —
  fog fades in exactly as you enter a drawn cloud and thickens with depth.
- **Sorted far-to-near** (`sortBillboards`) every frame, including off-frames
  (camera moves between rebuilds). Distance quantized to 2 m + STABLE iSeed
  tie-break — the proven fix for the original system's coarse-bucket blend-order
  flicker. Opaque blob variant never sorts.
- **Result:** soft, fluffy, smooth clouds — a genuinely different aesthetic from
  the chunky faceted opaque blobs, and it reads well at every altitude. So the
  answer to "was it the billboards or the size?" is: **mostly the size** — with
  the corrected walk, billboards look good; the remaining blob-vs-billboard gap
  is aesthetic (chunky/low-poly vs soft/fluffy) plus the deck-from-below volume
  cue, not a sizing failure.

### Experiment 3 — Surface Nets (isosurface mesh) — `cloud-surfacenets.ts`
Built to kill the dense-field LAG: the blob/billboard renderers draw one opaque
primitive per field maximum and rely on OVERLAP, so a dense field draws many
layers deep and fill cost scales with TOTAL coverage (worse: the dithered
`discard` defeats early-Z). Surface Nets samples density on a local tangent grid
around the camera, places one vertex per boundary cell (avg of edge crossings),
and stitches quads — rendering ONLY the cloud surface. Lab mode `surfacenets`.
- **Geometry verified correct** (a solid-color debug fills the view; the camera
  at 8 km sits *between* deck top and cirrus, engulfed in surface).
- **Normals from the density gradient** (free — uses the 8 corners already
  gathered; winding-independent) → real world-anchored toon shading.
- **Deck-only (layer 0).** A thin smooth cirrus veil on top caps the stack flat
  and doubles the grid; restricting to layer 0 shows the deck and halves cost.
- **Edge fade by HORIZONTAL distance** from the camera column (the patch is
  centred under the camera), not 3-D distance — else a deck viewed from altitude
  fades just for being far below.
- **Floating origin:** mesh anchored at the ground point, vertices stored
  RELATIVE to it, so float32 stays precise at planetary radius.

**v1 findings / open issues:**
1. **The field is SMOOTH at 600 m.** Surface Nets is honest to the density
   field, and the deck top has little 600-m-scale relief — the blobs' lumpiness
   was largely billow displacement + clustering, NOT the field. So the surface
   reads flat from above. Bumpy cumulus needs added field detail OR vertex
   displacement (billow) on the extracted surface.
2. **CPU sampling is the new bottleneck** (~7 ms deck-only; ~10 k corner samples)
   — it trades GPU overdraw for CPU. Needs a corner cache (snap the grid to a
   world lattice so corners persist as the camera moves) before it beats the
   blobs on cost.
3. **Patch boundary / shell crossfade** is visible (the dither arc at the patch
   edge); the surface fades by horizontal distance but the shell still fades by
   3-D distance, so they don't meet cleanly. Multi-resolution (fine near, coarse
   out) or a matched crossfade is the fix.
4. Entry (near-plane dissolve) + fog reused as-is.
The architecture is proven (overdraw gone); it needs detail + a corner cache +
crossfade polish to be a clear win.

**Billow added (`billow3` / `SURF_BILLOW_AMP`), but it doesn't rescue the look.**
High-frequency 3-D value noise (above the grid Nyquist) is added to density
before extraction, gated by density (no spurious puffs in clear sky), so the
isosurface AND its gradient normals get lumps. Geometrically correct, but the
surface STILL reads as a smooth grey mass from every realistic angle: deck tops
and cumulus bases are inherently flat, the camera is often engulfed, and at
viewing distance with high sun the gentle relief barely shades. **Conclusion:
the bottleneck is now SHADING/READABILITY, not geometry.** To look like cloud it
needs the cues the blobs/billboards have — ambient occlusion in the valleys,
fresnel rim translucency, fragment-scale normal perturbation, and a darker base
→ bright top gradient — i.e. a real shading pass, plus the corner cache for cost.
That's a meaningful amount of work; meanwhile the blobs already read as cloud.
**Pragmatic alternative for the LAG specifically:** the early-Z two-pass split on
the blobs (solid pass without `discard` → early-Z on; fading/edge pass with
`discard`) should cut dense-field fill cost without the surface-nets readability
and CPU tradeoffs. Recommended next step unless committing to surface-nets
shading.

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

### 4.5 Tier reorganization — SOLVED by geomorph refinement
Originally the tiers cross-faded membership (each tier's maxima independent), so
crossing a LOD band dissolved one set into an unrelated one — a tier "faded as
if it contained" the next. Fixed in `cloud-blobs.ts`: tiers now **tile by
distance** and each fine blob **geomorphs onto its coarse parent** in the outer
band — at `r→0` the siblings share the parent's center+size, and because we
render opaque, N coincident parent-size blobs *are* one parent blob. The coarser
tier resumes at exactly that shape (shared `computeBlob` cache → identical
geometry). So a coarse blob is literally its fine children merged; approaching
splits it back into them. Mass-preserving refinement, no dissolve.

Verified via `__labFlicker` (forward dolly, weather frozen): `above-deck`
~0.9 %/step smooth, `crossfade-climb` 0.17 % — the tier-handoff churn is gone.
**Caveat on the metric:** it measures *all* inter-frame pixel change, so for a
parallax-correct 3-D renderer it conflates desired parallax with pops — it is no
longer a clean pop-detector (billboards scored ~0 % precisely *because* they're
flat). Residual pops now live in the **cloud-entry** regime (`broken-flight`
showed a single ~40 % spike on fly-through), which is §3's near-plane-dissolve /
fog-handoff work, NOT the tier system. Dithered transparency also **crawls**
under motion (screen-space hash) — follow-up: blue-noise / temporal dither.

### 4.6b Coarse tier = synoptic envelope, not carved detail (fixed)
Two distance pops were reported: a stratus deck showed a big hole at 26 km that
filled at 20 km; a fair-weather cloud vanished over a 190 m altitude change. Both
were the **coarse tier point-sampling the detail-carved density**: a 20 km cell's
center (or 5 sub-samples) lands in the gaps between sub-cell puffs in a *broken*
region, so it renders empty where the fine grid renders cloud. Sub-sampling +
`√frac` sizing made it worse (shrank partial cells → wider hole). Fix in
`computeBlob`: a cell wider than the layer's detail scale reads the **smooth
synoptic cover envelope** (`map.sample`) instead of `cloudDensityAt` — coarse =
large-scale cloud fraction (no spurious gaps), fine = carved puffs + real gaps.
Size ∝ √cover, so a near-solid deck fills in while a scattered field stays
scattered (verified: `crossfade-climb` keeps blue gaps; `stratus-underside` 26 km
is now solid like 20 km). This is "coarse is the low-pass of the field, fine adds
detail" — the same source-of-truth discipline as the shell crossfade.

### 4.8 Cloud entry (implemented) + the stochastic-transparency limit
Entry is three coupled cues off camera distance, all in `cloud-blobs.ts`:
- **Near-plane soft dissolve** — `nearFade = smoothstep(0, band, fragDist)`; the
  face you'd clip into fades before the camera reaches it. `band =
  max(NEAR_BAND_MIN, N × per-frame camera move)`, so a fast fly-through can't
  cross it in one frame and flash a hard cross-section.
- **Proximity silhouette feather** — erodes the rim into wisps, kept to a SMALL
  absolute band (× the dissolve band, NOT radius-relative — radius-relative
  erodes km-wide blobs from km away and grains the whole screen).
- **Interior fog handoff** — unchanged (`fogContribution` → world/lab fog;
  ~100 m visibility inside dense cloud at full boost). Feather is suppressed by
  `uInside` (camera cloud density) so the fog, not grain, owns the soup.

Stochastic transparency (world-anchored **hashed alpha**, Wyman & McGuire —
replaced the screen-space dither, which crawled under motion) means fades are
order-independent with no sort, but partial-alpha edges are **grainy**, not
smooth. Approach/normal views read clean; *deep inside a dense deck* (camera
embedded, fog visibility > the dissolve band) still shows grain. Mitigations:
denser interior fog, full resolution (960 px swiftshader stills exaggerate it),
or — the only true fix — TAA / a sorted alpha pass (both off-budget). Acceptable
for now; the approach (the actual "don't punch a polygon wall" goal) works.

### 4.9 Culling & perf
**DONE — view-cone cull + cross-frame cache** (the two biggest wins):
- **View-cone cull.** `update()` takes an optional `cameraLocalForward`; the walk
  drops blobs whose center is >72° off forward (rear hemisphere + far sides),
  with a `dist < 3×radius` exemption so big near blobs aren't wrongly culled.
  ~50 % fewer emitted/uploaded/vertex-shaded blobs (above-deck 2301→943,
  stratus 2857→1367), view identical. Billboard renderer ignores the new arg.
- **Cross-frame blob cache.** `blobCache` was cleared every rebuild (re-sampling
  the whole field, ~30 ms cold). Now a two-generation TTL cache (0.7 s staggered
  TTL, gen swap every 2.5 s) — a cell's geometry depends only on (cell,
  weather-time), so it survives many frames. Warm-frame walk dropped ~8×
  (above-deck 29.6→3.7 ms; stratus 5.9 ms; fair-weather 1.8 ms on swiftshader).
  Cache is shared with the geomorph parent lookups, so collapse targets stay
  identical across frames.

**Overdraw / early-Z — early-Z is UNAVAILABLE here.** The cloud shaders run with
`logarithmicDepthBuffer` (required so clouds depth-test correctly against the
log-depth planet/terrain), which makes every fragment **write `gl_FragDepth`** —
and that alone forces **late-Z** regardless of `discard`. So a no-`discard` pass
would NOT regain early-Z; occluded opaque fragments shade no matter what. (The
two-pass split idea is moot here.)

**DONE — CPU containment cull** (`cullContainedBlobs`, mesh variant): achieves
what early-Z would, on the CPU — a blob whose VOLUME is fully inside a larger
opaque blob is never visible, so it's dropped before submit (spatial hash at the
mean radius; conservative margin 0.82 + 3-D distance so a partly-visible blob is
never culled). Measured: **53 % culled** on a solid stratus deck, **55 %**
above-deck, **26 %** inside a broken deck, **3 %** on a sparse field — i.e. it
removes ~half the overdraw exactly where dense fields lag, and ~nothing where
there's nothing to cull, with NO visual change (the deck stays solid). Cheap
(sub-ms hash). LIMITATION: only removes CONTAINED blobs, not all OCCLUDED ones
(a blob *behind* another, not inside it, still shades then fails late-Z). For the
rest, the surface-extraction architecture (Exp. 3) is the only full fix, or fewer
/cheaper blobs (lower `BLOB_ICO_DETAIL`, sooner far-fade).

### 4.7 Cel / flat-shaded art direction (recommended, game-wide)
The blob shader already uses banded (cel) diffuse + flat per-face normals from
screen-space derivatives — that's *why* a 162-vert icosphere reads as cloud. Cel
shading is the right house style for the whole low-poly universe: it hides
faceting (so polycount can stay low everywhere — terrain, creatures, clouds),
unifies the look, and is cheaper than PBR. If adopted game-wide, fold the
clouds' banding/rim into a shared toon-shading helper so cloud, terrain, and
creature lighting share one ramp. Tradeoff: cel shading flattens form cues, so
silhouette + rim do the heavy lifting (already true for the blobs).

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
