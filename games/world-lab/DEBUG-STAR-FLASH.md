# DEBUG: single-frame star flashes

**Symptom.** In any scope that includes space-scale generation, an unpredictable
bright flash lasting exactly one frame. It reads as a **blooming circle taking up
a fair chunk of the screen**, like a star seen at close range, and it comes in
different tints — blue, yellow, red, sometimes **purple**. Most frequent when
moving fast in space; also seen near the ground. Happens under both the standard
and toon shaders, and predates the seagull-dream renderer port, so the cause is
in a system that already existed there.

## Why it needs a trap

One frame is too short to see, screenshot, or breakpoint — by the time you react
it is many frames gone. So the detector runs inside the frame loop.

## Running it

```
npx vite --config games/world-lab/vite.config.ts
```

Open <http://localhost:5189/?flashwatch=1>. A HUD appears bottom-right. Then, in
the console:

| call | what it does |
|---|---|
| `__flash.arm()` | reset the baseline once you are settled and flying |
| `__flash.clean()` | strip the scene — no city beacons, no point lights, no terrain, no lab fill — so anything that flashes must be the starfield |
| `__flash.flashes()` | the **confirmed** one-frame flashes |
| `__flash.report()` | every hit, including the sustained ones it rejected |
| `__flash.hdrStats()` | peak raw radiance over the run, and how many frames overflowed |
| `__flash.probeAt(u, v)` | interrogate the live frame at a uv: raycast it, and download the raw pre-bloom image around it. Omit `u`/`v` to use this frame's peak |
| `__flash.hide({...})` | bisect the emitter. Keys: `beacons`, `atmosphere`, `starfield`, `halos`, `terrain`. Hide one, `arm()`, fly. Whichever removal stops the flashes owns the texel |
| `__flash.save()` | download the captured PNGs + `flash-dossier.json` |

`save()` writes three images per confirmed flash: the final composite, `-RAW`
(the pre-bloom scene, log-mapped) and `-RAWCROP` (6x around the peak).

Headless equivalent (SwiftShader, ~1 fps — see the caveat below):

```
node games/world-lab/shot-flash.cjs [seconds] [outDir]
```

A **reliable repro** is parking the cursor in the **upper-left corner** of the
Solar System demo: past `ROT_EDGE` horizontally is a fast lateral sweep and above
`ASC_START` is a climb, and both pan rates scale with altitude — so climbing
compounds into runaway outward speed.

## How it works

1. **Detect** (`src/flash-watch.ts`). Right after the present — in the *same
   task* as the draw, because the context has no `preserveDrawingBuffer` — the
   drawing buffer is downsampled to 96×54 and its mean/peak luminance taken.
2. **Two triggers.** A *screen* spike (relatively **and** absolutely brighter
   than the previous frame — the conjunction rejects the slow ramp of a sunrise)
   and a *radiance* spike from the HDR probe, which catches the cause even on a
   frame whose bloom landed off-screen.
3. **Confirm.** On the *next* frame it records whether the luminance fell back.
   A true one-frame flash spikes and returns (`transient: true`); a planet
   swinging into view stays bright and is discarded. **This is the filter that
   makes the output usable** — most raw hits are sustained, not the bug.
4. **Capture.** On a hit it grabs the canvas as a PNG immediately (same-task
   rule again) and dissects the starfield buffers the projector filled for that
   exact frame, ranking points by the radiance they can actually deposit
   (colour × footprint²) so an 800 px aggregate outranks a 3 px star.
5. **Attribute** (`shared/world-engine/space/galaxy.ts`). With the probe on, the
   projector records per-point provenance — tier, source cell key, distance,
   fade weight, `k`, sprite size — index-aligned with the buffers. So a flagged
   frame names the exact cell, not just "something was bright".
6. **Measure the raw radiance** (`src/hdr-probe.ts`). A `Pass` with
   `needsSwap = false`, inserted between `RenderPass` and the sanitize clamp, that
   never writes the composer's buffers — the presented image is identical with it
   in or out. It does an **exact** power-of-two max-reduction (2×2 blocks, all
   taps, down to 1×1) into `FloatType` targets, so a single hot texel cannot be
   stepped over and a value that overflows half-float is not itself saturated by
   the measurement. It reports the peak, the uv it came from, and whether
   anything was NaN or at half-float saturation.

## What the first real capture established

Five confirmed one-frame flashes, measured **before** tone mapping and bloom:

| frame | baseline peak | flash peak | uv |
|---|---|---|---|
| 774 | 1.51 | 207 | (0.67, 0.75) |
| 778 | 1.51 | **4016** | (0.77, 0.50) |
| 794 | 1.51 | 367 | (0.28, 0.70) |
| 825 | 3.50 | **16376** | (0.31, 0.26) |
| 891 | 2.34 | 629 | (0.75, 0.63) |

Scene radiance idles at **1.5-3.5** — that is the sun disc, whose `hdrBoost` is
`4.0 * (1 + 0.3*log10(L))` ≈ 4 for a sun-analog (`celestial-body.ts:335`). The
spikes run to **~4000x the brightest legitimate thing in the scene**, at a
different screen position every time, for exactly one frame. Flash *size* tracks
magnitude — 207 gives a small blob, 16376 a big one — because bloom spread scales
with how far over threshold the texel is.

### Ruled out by measurement

- **The starfield.** The `top` array is byte-identical across all five flash
  frames — same indices, same colours, same sprite sizes. Nothing in the
  starfield changes on a flash frame. Not the aggregate blobs, not the stars.
- **A floating-origin rebase glitch.** `galacticStepLy` is ~3e-10 on every flash
  frame. The camera is not jumping.
- **Half-float overflow / NaN.** `bad: false` everywhere. The values are finite
  and below the 65504 saturation point. Whatever this is, it is *computing* a
  real number in the thousands.

### Ruled out by reading the source

- **Specular.** `WATER_SAFETY` (`planet/terrain-shading.ts:148-152`) is real and
  enforced as a clamp: `minRoughness 0.35`, `maxMetalness 0.15`. `terrainMaterial`
  defaults roughness **1**, metalness **0**; gas giants 0.95. Nothing in the
  engine is near mirror-smooth, and there is no hand-written GGX or
  `pow(dot, n)` anywhere in engine GLSL.
- **Atmosphere shells.** The limb terms are bounded by `1-exp(-x)` and guarded
  with `max(mu, 0.08)` (`atmosphere.ts:96-97, 186`); they write alpha only.
- **The star's PointLight.** `decay 0, distance 0` means no falloff, but also no
  divergence — attenuation is exactly 1. Intensity is computed once at
  materialize, not per frame.
- **Every GLSL division** in `shared/world-engine/` and `games/world-lab/` is
  guarded by a `max(...)`.

## What the pre-bloom capture established

**The firefly is ONE TEXEL.** The `-RAWCROP` images (6x around the peak) show a
single pixel, sitting just inside the planet's limb, while the entire rest of
the frame is near-black. The post-bloom composite shows that one texel as a
screen-filling glow.

**It is a PURE SINGLE CHANNEL.** Pure green in one capture, pure blue in
another. Under the log map that is roughly `(0, 16400, 0)` and `(0, 0, 2120)`.
One channel at ~10⁴ with the other two at zero is not a physical colour — but it
IS the signature of the pure-hue palette on screen: the planet is covered in
polity-ink city beacons in exactly those hues, which matches the reported flash
colours (blue, yellow, red, purple).

**The raycast named `atmosphere_veil` / `atmosphere_halo` at the peak uv on
every capture** — but that is the limb, where those shells cover everything, so
it is a location fingerprint more than an accusation.

### Cleared by reading the source

- **`setCityColor`** (`space-fly.ts:314-335`) does NOT accumulate — it copies a
  fresh `new THREE.Color(hex).multiplyScalar(2.6)` each call and is idempotent.
  Beacon radiance maxes at ~2.6. Same pure-hue signature as the firefly, but
  ~6000x too dim to be it directly.
- **Both atmosphere shaders** (`atmosphere.ts:76-106`, `166-189`) are bounded:
  `a` is a product of `exp(-x)` / `1-exp(-x)` and smoothsteps, all ≤ 1, and the
  colour uniforms are ordinary sky colours ≤ 1. One additive draw each. They
  cannot author 10⁴.

### A probe bug this exposed

The first captures reported peaks in the thousands next to an `hdr.rgb` under
1.3 — a contradiction. Cause: the readback used `Math.round(u * w)` on a uv that
is a texel CENTRE `(i + 0.5) / w`, so it read `i + 1` — one texel to the right.
For a single-texel firefly that samples a normal neighbour. Now `Math.floor`.
The contradiction was itself evidence: it is what a one-texel spike looks like
when you sample beside it.

### CONFIRMED: the emitter is the city beacons

Hiding beacons stops the planet-limb flashes.

That creates a precise puzzle, and the puzzle is the useful part. A beacon is a
`MeshBasicMaterial` with no map, no vertex colours and `fog: false` — it writes
**literally its uniform**, `gl_FragColor = vec4(diffuse, opacity)`. Beacon
radiance is `ink × 2.6`, and there is no code path by which a beacon fragment
emits anything else. Yet the resolved HDR texture holds ~1.6e4 in that beacon's
exact hue, and removing beacons removes it.

Both cannot be true, so the amplification happens **between "the fragment shader
writes 2.6" and "the resolved texture holds 1.6e4"** — i.e. in rasterization or
the multisample resolve, not in shading. Supporting evidence:

- The ratio is not a constant: 80x, 141x, 815x, 1545x, 2230x, 3327x, 6300x
  across captures. It varies continuously — like sub-pixel coverage does.
- Beacons genuinely DO go sub-pixel. `refreshCities` (`space-fly.ts:179`) caps
  size at `body.radius * 0.012` ≈ 76 km for an Earth-sized world, which is only
  ~3.5 px at the ~2e7 m range these were caught at, and shrinks with distance.
- The `-RAWCROP` came from `rgbCopy`, an independent copy path from the reduction
  chain, and shows the bright texel too. This is not a probe artifact.

### A/B results

| knob | result |
|---|---|
| `?flashmsaa=0` | **STOPS the flashes.** MSAA is necessary |
| `?flashlogdepth=0` | no effect (and degrades other graphics — not a usable setting) |
| `__flash.fatBeacons(8)` | does NOT stop them; possibly less frequent |

So it is **not sub-pixel size** — 8x-wider beacons still flash. It is MSAA.

### Which forces the conclusion: NOTHING IN THE SCENE AUTHORS THIS VALUE

An MSAA resolve averages samples, so a resolved texel at 1.6e4 requires some
SAMPLE to hold ~1.6e4. Enumerate every shader that can write the colour buffer
and the most each can emit:

| source | max radiance |
|---|---|
| city beacon (`MeshBasicMaterial`, uniform only) | `ink × 2.6` ≈ 2.6 |
| sun disc `lum_disc` (`hdrBoost = 4·(1+0.3·log10 L)`) | ~4; ~11 for a supergiant |
| starfield leaf star (`pow(a,0.7)·2.5`, `intrinsic` clamped to [0.05, 6]) | ~8.95 |
| starfield aggregate | ~0.4 |
| body halos (`HALO_PLANET_BOOST`) | ~4 |
| atmosphere shells (`a ≤ 1`, colour ≤ 1) | ~1 |

**Nothing can emit more than about 11.** So the value is not authored by any
shader — it is produced by the rasterization / multisample-resolve stage itself.
That fits every observation: MSAA-dependent, exactly one texel, a continuously
varying ratio, and a hue borrowed from whichever bright primitive was there.

### THE FIX: a RELATIVE firefly clamp

A fixed ceiling would also be a permanent ceiling on the whole engine — a
supernova, a warp flash, anything meant to be genuinely blinding would be capped
at the same number. So `sanitizePass` clamps on the RATIO instead, which is what
actually separates the two cases:

- **A firefly is ONE texel whose neighbours are normal.** Measured directly: the
  captures read ~0.5-1.2 immediately beside a 1.6e4 texel.
- **A supernova is a coherent bright REGION.** Its neighbours are bright too, so
  it raises its own limit and passes through untouched — at any brightness.

A texel is pulled down only if it exceeds BOTH `FIREFLY_ABS_FLOOR` (4 — nothing
below the bloom threshold can bloom, so leave it alone) AND `FIREFLY_REL_MAX`
(8) times the brightest of its 8 neighbours. The whole colour is scaled, not
each channel — per-channel clamping is exactly what gave these flashes their
arbitrary hues.

Tunable live: `?flashrel=N` (ratio), `?flashclamp=N` (the Inf backstop).
`?flashrel=1000000` makes the clamp inert, which is the A/B control.

**Corollary for content:** anything meant to read as bright at a distance must be
drawn with a FOOTPRINT — a sprite with falloff, as the starfield already does —
not a lone texel. A real bright point source has a spread through any lens, so
this is not a concession. A one-texel supernova would be clamped; a sprite-based
one of any brightness is not.

### Why a clamp is the right fix here at all

Earlier notes called the `HDR_CLAMP` firefly clamp "treating the symptom".
**That was wrong, and the table above is why.** When no shader authors the value
there is no author to fix; a firefly clamp is the standard and correct mitigation
for rasterization-level fireflies. The defect in the old code was that the clamp
sat at **10 000** — ~4500x the bloom threshold — which is what turned one stray
texel into a screen-wide wash.

MSAA is deliberately left ON. `?flashmsaa=0` also removes the flashes but costs
antialiasing across the whole engine, and the relative clamp handles it without
that.

### Verified

- Shader compiles, no GL errors, scene renders (`screenMean` 47.2 clamp-active
  vs 44.6 inert — frame-to-frame variation on a moving camera, no visible
  change to the look).
- world-lab 10/10, grand-dream `world-lab.test.ts` 38/38.

**Verification gotcha:** do not read the canvas from `page.evaluate` to check the
frame — the context has no `preserveDrawingBuffer`, so a read in a later task
returns a blank buffer and every frame looks black. Use
`__flash.hdrStats().screenMean`, which samples inside the render loop.

### Open: is it one bug or two?

Flashes have been seen both at planet limbs and in deep space with no planet
near. Rather than two coincidentally-similar bugs, note what those cases share:
**a tiny, very bright primitive** — a beacon sphere near a planet, a starfield
point in deep space. That is the axis `__flash.hide()` bisects.

## Leading hypothesis

The **shape** is settled. A single blown-out texel pushed through
`UnrealBloomPass`'s 5-level mip pyramid renders as exactly a soft blooming
circle — *a star's glow with no star at its centre*. That is why it reads as "a
star at close range" and why the size varies with brightness.

The **amplifier** is settled too, and `?flashclamp=8` confirms it empirically:
the sanitize guard in `main.ts` clamps to `HDR_CLAMP` (10 000), ~4500x the bloom
threshold of 2.2. The comment there reasons that 10 000 is "far above the bloom
threshold, so the look is unchanged" — true for a pixel you look at directly,
false for one you *blur across the whole frame*.

That also explains the **arbitrary tints, including purple**, which no star and
no aggregate palette can produce: the clamp is **per channel**. A spike with
R and B in the thousands and G in the hundreds comes out magenta after clamping
and tone mapping. Hue is a readout of *which channels* spiked, not of any
object's colour.

The **source** is still open. Lowering the clamp is a legitimate firefly clamp
and a defensible fix on its own — nothing in this scene is meant to be 4500x the
bloom threshold — but it treats the symptom. Something is computing a finite
number in the thousands, once, at a wandering screen position.

### Next probes, in order

1. `culprit` — the raycast at the peak uv, on the flagged frame. Names the object
   and its material. This is the direct answer if the spike comes from geometry.
2. `hdr.rgb` — full linear RGB at the peak texel. The hue narrows *which*
   contribution blew up.
3. `-RAW` / `-RAWCROP` PNGs — the pre-bloom scene, log-mapped. Shows the culprit
   at **true size and shape**: one texel, a sliver, a whole triangle, a sphere.
   The post-bloom PNG cannot show this, because the glow hides its own source.

`__flash.probeAt(u, v)` runs 1-3 on demand against the live frame.

## Caveat on the headless driver

`shot-flash.cjs` runs under SwiftShader at roughly **1 fps**, and the drone
barely moves (galactic step ~4e-10 ly/frame). It has **not** reproduced the bug,
and a negative result there means nothing. Its value is that the machinery is
verified end-to-end: it captures frames, the probe reports sane radiance, and the
starfield dissection correctly names cells. Use a real browser and a real GPU to
actually hunt.
