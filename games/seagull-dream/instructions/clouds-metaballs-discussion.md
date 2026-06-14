=====

I'm having a bit of a problem on a conceptual level.
My goal is to be able to render clouds and have them look good at any distance, without obvious "snapping" as the player gets closer or further away, works at any angle, and can have shapes based on the weather patterns on any planet, and runs fast on weak hardware.
They don't have to look "real" - but I want them to look like they are real objects within the context of a low-poly universe, and have them read as clouds.
How would you start to do this?

=====

The snapping is the thing to attack first, conceptually, because it isn't a polish problem — it's a *symptom*. Snapping happens precisely when you switch representations (billboard → mesh → shell texture). So the root fix isn't "blend the LODs better," it's **commit to a single scale-free representation and never switch.** Everything else follows from that decision.

Two constraints immediately prune the option space:

- **"Any angle" + "fly through"** kills billboards/impostors outright. Camera-facing quads are flat from the side and invert when you look down on them from orbit. You need true 3D. Don't even start there.
- **"Weak hardware" + "low-poly"** pushes you away from full volumetric raymarching as the primary renderer (it's the photoreal AAA path and it's heavy).

That leaves a clean fork:

**(A) Meshed implicit field** — a density field, polygonized into chunky flat-shaded blobs. Cheap, low-poly-native, any-angle, fly-through-able. My recommendation for your constraints.

**(B) Raymarched field** — same field, but you march rays through it. Scale-free by construction, no snapping ever, but cost scales with march quality. Keep this in your back pocket for the "look up and it's gorgeous" moments if budget allows; not your baseline.

The important part: **both are driven by the same source of truth**, so the choice is reversible later and the weather system is orthogonal to it.

## Single source of truth: one density field

Define everything as one function over the atmosphere shell. This is what makes snapping *impossible* rather than *managed*.

```
n = p / |p|                       // direction = where on the sphere
h = (|p| - (R+h0)) / (h1 - h0)    // normalized height in shell ∈ [0,1]

C = W(n)                          // coverage from the planet's weather map ∈ [0,1]
P = bump(h)                       // vertical profile: 0 at edges, 1 mid-shell
D = fbm_worley(p * freq + wind*t) // billowy 3D detail

density(p) = saturate( remap( C*P, 1 - D, 1, 0, 1 ) - threshold )
```

`W(n)` is the *only* per-planet input — that's your weather module, fully decoupled. Bands from latitude/Coriolis, cyclones, fronts, whatever your planet generator emits, as a 2D field on the sphere advected by wind. Swap `W` and you've got a different planet's sky with zero renderer changes.

## Why this auto-solves the orbital→local transition

This is the conceptual payoff. From far away, integrating `density` along the view ray collapses to "how much coverage is in this direction" — i.e. it *is* `C = W(n)` shaded onto the atmosphere shell. From inside, the same field is the 3D volume you fly through.

So the orbital view and the local view aren't two representations — they're **the same field at two integration scales.** You don't transition between a texture and meshes. You crossfade two *renderings of one field*, weighted by altitude:

```
w = smoothstep(a, b, altitude)   // a = "blobs only", b = "shell only"
final = lerp(blob_render, shell_render, w)
```

Because both read the same `C`, the patterns align underneath the fade. The crossfade is invisible *by construction* — there's nothing to snap because the silhouettes were never independent.

## Killing snapping within the local (blob) renderer

Don't use discrete mesh LODs — that reintroduces the disease. Two clean options:

1. **Fixed-topology blobs.** Spawn cloud "puffs" at field maxima, each a low-poly rounded mesh (icosphere / few merged spheres). The mesh *never changes topology* with distance, so it can't pop. Distance just changes how many are above the visibility floor, and that handoff is the altitude crossfade above, done with alpha, not geometry.
2. **Geomorphing** if you polygonize the whole field (marching cubes) — vertices interpolate continuously toward the coarser level as a function of screen-space error. Continuous = no pop. Heavier than option 1; only worth it if you want connected cloud sheets rather than discrete puffs.

I'd start with option 1. It's the cheapest thing that satisfies all five of your requirements at once.

## Making low-poly geometry *read* as cloud

The silhouette and shading do all the work, not the polycount:

- **Banded / toon lighting** (2–3 light steps) — reads as the soft cloud gradient for free, and it's literally cheaper than smooth shading. Fits low-poly perfectly.
- **Rim translucency / fresnel brightening** on the silhouette — this is the single biggest "that's a cloud, not a rock" cue. Backlit edge glow.
- **Billowy outline** — apply Worley/cellular noise to the silhouette (vertex displacement or alpha-erode the edge). Cauliflower edges = cloud; smooth edges = balloon.

Get those three and a flat-shaded blob cluster reads unmistakably as cloud while staying in your low-poly universe.

## Where I'd actually start, concretely

1. Build `W(n)` as a flat debug texture (just bands + a couple of blobs). Ignore weather realism for now.
2. Implement `density(p)` and spawn fixed-topology blobs at its maxima in a patch around the camera. Flat shade them.
3. Add the three cloud cues (banded light, rim, Worley silhouette). Confirm it reads as cloud while flying through at one altitude.
4. *Only then* add the shell render and the altitude crossfade. Verify you can fly surface→orbit with no visible transition.
5. Last, make `W` actually weather-driven from your planet generator.

The ordering matters: nail "reads as cloud + no snap at one scale" before you touch multi-scale, or you'll be debugging two hard problems at once.

One genuine fork I'd want your call on before going deeper: do you want clouds as **discrete puffs** (cumulus-like, clearly separated objects — easiest, most low-poly) or **connected sheets/layers** (stratus, overcast decks — needs the marching-cubes + geomorph path)? That choice changes the local renderer, though not the field or the transition logic.

=====

Okay, sounds like a good start - we've already implemented a continuous density field based on planetary weather patterns. We were trying to use circular billboards, which looks great up close or flying through a dense cloud field (+fog effects), but the illusion breaks when changing distance scales. 

=====

Short version: "interpolate between them" is the billboard mistake in new clothes. The moment you crossfade two *renderers* (puff meshes ↔ marching-cubes sheet) you're back to ghosting and double-cost. The fix is the same as before — find the single parameter that both are limit cases of, and slide *that*.

That parameter exists and it's clean: **the metaball threshold.**

## Discrete and connected are two ends of one implicit-surface knob

Place an implicit primitive at each field maximum and polygonize the *combined* scalar field at an isolevel `T`:

```
F(p) = Σ_i  g(|p - c_i| / r_i)        // g = smooth falloff, e.g. max(0,1-x²)²
surface = { p : F(p) = T }
```

- High `T`, small `r_i` → only the cores breach the level → **separate puffs**.
- Low `T`, large `r_i` → neighboring falloffs sum above the level in the gaps → **merged sheet**.

Same field, same maxima, same mesh pass — one scalar `b ∈ [0,1]` driving `(T, r)` slides you continuously from cumulus to overcast. You're interpolating a *parameter*, not blending two images. Nothing to snap.

## But your own observation says you may not need merging at all in the far field

You're right that dense discrete puffs read as a sheet at distance — and that's not a hack, it's literally **stratocumulus**: a deck *is* a packed field of semi-merged lumps. So the discrete↔connected distinction is only *resolved* in the near field. Far away, statistics give you the sheet for free.

That bounds the cost question. You don't need merged topology everywhere — only near the camera, only where the weather is stratiform.

## The actual tradeoff (this is the decision)

**Pure fixed-topology blobs, sheet via squash + packing.** Keep one primitive forever; make "sheetness" emergent — flatten blobs into lenses (anisotropic `r`) and pack them dense. Stratocumulus falls out naturally.
- Keeps the can't-pop guarantee (topology never changes).
- Cheapest, most low-poly-native.
- Risk: a *smooth* overcast deck directly overhead may look bumpy rather than flat.

**Metaball field + marching cubes, `b` = blend.** True continuous discrete↔smooth.
- Gives you genuinely flat decks.
- But topology now changes as blobs merge/split → you've reintroduced popping → you now *need* geomorphing. And MC is heavier.

These aren't co-equal. On your constraints (weak hardware, low-poly, "needn't look real") I'd default to **pure blobs with emergent sheets**, and escalate to metaball-MC *only in the near patch, only where it's needed* — driven by the same scalar. That keeps the expensive path small and optional instead of global.

## Ground the knob in the weather field you already have

Don't hand-author `b`. The discrete↔connected axis is physically the **stability / cumuliform–stratiform axis**: convective instability → buoyant updrafts → heaped, separated cumulus; stable stratified ascent → layered sheets. Derive a stability scalar `s(n)` from the same weather module and let it drive everything:

```
s ∈ [0,1]               // 0 = convective/unstable, 1 = stable/stratified
b      = s              // metaball blend  (discrete → merged)
squash = lerp(1.0, 0.2, s)   // round puff → flat lens
pack   = lerp(sparse, dense, s)
```

Now a single physical field decides, *per region*, where you sit on cumulus → stratocumulus → stratus — and a scene can hold both at once with continuous spatial transitions, because it's all one field and one extraction.

So: don't pick one of the two and don't crossfade them. Make the blob your only primitive, make sheetness a parameter of placement+shape (cheap path) or of metaball threshold (smooth path), and wire that parameter to atmospheric stability.

One thing worth separating out before you build: flying *through* a cloud is a different regime from looking *at* one — inside the volume you want your fog/billboard interior, not a surface. Keep that as its own thing; the blob/sheet axis here is only about the exterior silhouette. Do you actually need smooth overhead decks, or is stratocumulus-style lumpiness acceptable in your art style? That answer alone tells you whether you ever touch marching cubes.

=====

Concerning fixed-topology blobs vs geomorphing - there are times when either would be ideal, depending on the shape of the weather structure. From a great distance, even discrete clouds at a high enough density can look like a flat sheet.  Is it better to stick to one of the two options or is there a simple way of interpolating between them?

=====

Short version: "interpolate between them" is the billboard mistake in new clothes. The moment you crossfade two *renderers* (puff meshes ↔ marching-cubes sheet) you're back to ghosting and double-cost. The fix is the same as before — find the single parameter that both are limit cases of, and slide *that*.

That parameter exists and it's clean: **the metaball threshold.**

## Discrete and connected are two ends of one implicit-surface knob

Place an implicit primitive at each field maximum and polygonize the *combined* scalar field at an isolevel `T`:

```
F(p) = Σ_i  g(|p - c_i| / r_i)        // g = smooth falloff, e.g. max(0,1-x²)²
surface = { p : F(p) = T }
```

- High `T`, small `r_i` → only the cores breach the level → **separate puffs**.
- Low `T`, large `r_i` → neighboring falloffs sum above the level in the gaps → **merged sheet**.

Same field, same maxima, same mesh pass — one scalar `b ∈ [0,1]` driving `(T, r)` slides you continuously from cumulus to overcast. You're interpolating a *parameter*, not blending two images. Nothing to snap.

## But your own observation says you may not need merging at all in the far field

You're right that dense discrete puffs read as a sheet at distance — and that's not a hack, it's literally **stratocumulus**: a deck *is* a packed field of semi-merged lumps. So the discrete↔connected distinction is only *resolved* in the near field. Far away, statistics give you the sheet for free.

That bounds the cost question. You don't need merged topology everywhere — only near the camera, only where the weather is stratiform.

## The actual tradeoff (this is the decision)

**Pure fixed-topology blobs, sheet via squash + packing.** Keep one primitive forever; make "sheetness" emergent — flatten blobs into lenses (anisotropic `r`) and pack them dense. Stratocumulus falls out naturally.
- Keeps the can't-pop guarantee (topology never changes).
- Cheapest, most low-poly-native.
- Risk: a *smooth* overcast deck directly overhead may look bumpy rather than flat.

**Metaball field + marching cubes, `b` = blend.** True continuous discrete↔smooth.
- Gives you genuinely flat decks.
- But topology now changes as blobs merge/split → you've reintroduced popping → you now *need* geomorphing. And MC is heavier.

These aren't co-equal. On your constraints (weak hardware, low-poly, "needn't look real") I'd default to **pure blobs with emergent sheets**, and escalate to metaball-MC *only in the near patch, only where it's needed* — driven by the same scalar. That keeps the expensive path small and optional instead of global.

## Ground the knob in the weather field you already have

Don't hand-author `b`. The discrete↔connected axis is physically the **stability / cumuliform–stratiform axis**: convective instability → buoyant updrafts → heaped, separated cumulus; stable stratified ascent → layered sheets. Derive a stability scalar `s(n)` from the same weather module and let it drive everything:

```
s ∈ [0,1]               // 0 = convective/unstable, 1 = stable/stratified
b      = s              // metaball blend  (discrete → merged)
squash = lerp(1.0, 0.2, s)   // round puff → flat lens
pack   = lerp(sparse, dense, s)
```

Now a single physical field decides, *per region*, where you sit on cumulus → stratocumulus → stratus — and a scene can hold both at once with continuous spatial transitions, because it's all one field and one extraction.

So: don't pick one of the two and don't crossfade them. Make the blob your only primitive, make sheetness a parameter of placement+shape (cheap path) or of metaball threshold (smooth path), and wire that parameter to atmospheric stability.

One thing worth separating out before you build: flying *through* a cloud is a different regime from looking *at* one — inside the volume you want your fog/billboard interior, not a surface. Keep that as its own thing; the blob/sheet axis here is only about the exterior silhouette. Do you actually need smooth overhead decks, or is stratocumulus-style lumpiness acceptable in your art style? That answer alone tells you whether you ever touch marching cubes.

=====

Lumpiness is fine.
Another issue that I've often had issue with - what is the best way of "entering" a cloud visually? I don't want to have the camera fly through a flat, polygonal boundary - clouds look wispy up close, not solid. Is this handled already by the metaball approach? Reducing visibility threshold as the camera gets close and the fog fades in?

=====

No — metaballs don't solve this, and it's worth being precise about why, because the failure is the one you're already seeing. A metaball isosurface is still a **hard wall**. You polygonized `F(p) = T`, so the camera punches through a flat triangle cross-section at the near plane. Lower polycount, same disease as the billboard.

And one correction on the proposed lever: **lowering the isolevel `T` near the camera relocates the wall, it doesn't dissolve it.** Drop `T` and the surface just grows outward to a new position — still a crisp boundary, now closer or further. The thing you want to fade isn't *where* the surface is, it's *whether it's opaque*. The lever is **opacity**, not isolevel.

The fog-fade-in half of your instinct is right. It just needs to be one of three coupled pieces, all reading the density field you already have:

**1. Feathered silhouette that widens with proximity.** You already erode the edge with Worley for billowiness. Make the erosion band's *width* a function of camera distance:

```
edge_softness = lerp(thin, thick, 1 - saturate(dist_to_surface / d0))
alpha = saturate( (F(p) - T) / edge_softness )   // soft isolevel, not hard cut
```

Far away the cloud has a crisp-ish lumpy edge; as you close in, that edge blooms into tendrils. The cloud *opens up* into wisps exactly where you're about to enter it. This is the "wispy up close" cue, and it's just the silhouette noise you already have, scaled by range.

**2. Near-plane soft dissolve — this is the single trick that kills the hard cross-section.** Standard soft-particle math, applied to the surface: fade fragment alpha as it approaches the camera near plane.

```
alpha *= saturate( (depth_fragment - near) / fade_band )
```

The face you'd otherwise clip into never reaches full opacity — it's already gone to zero before it intersects the near plane. You literally cannot see a flat polygon boundary because the polygon nearest you is transparent. Cheap, no marching, runs on anything.

**3. Interior fog handoff, same field.** As the surface dissolves out, screen-space fog rises in, with extinction keyed to local density:

```
σ = k · density(p_camera)         // sample the field AT the camera
fog = 1 - exp(-σ · view_dist)     // cheap exponential, no volume march
```

Because the surface alpha (1+2) falls and the fog (3) rises off the *same* `density`, they hand off aligned — there's nothing to snap, same source-of-truth argument as the orbital→local transition. Entering a cloud *is* that crossfade, just at the surface scale: exterior shell → interior volume, invisible by construction.

Two cheap-hardware notes:
- Use **alpha-to-coverage / dithered erosion** for the edge rather than alpha blending, so you skip back-to-front sorting entirely. Wispy fringe for free, order-independent.
- Keep interior fog **screen-space exponential**, not marched. You don't need a volume integral inside — you need extinction and a color, both from one field sample.

So the entry isn't a special-case effect you bolt on. It's the same exterior↔interior regime split I flagged last time, resolved by never letting the boundary be opaque where the camera is close: feather the edge by range, dissolve at the near plane, raise fog off the identical density. The wall stops existing precisely where you'd hit it.

The one thing to tune by hand is `fade_band` and `d0` relative to your puff radius — too small and you still glimpse a hard edge for a frame on fast entry; too large and clouds look perpetually foggy from outside. Want me to sketch how those two scale with puff size and camera speed so fast fly-throughs don't flash the boundary?

=====

Sure.

=====

Two distances, two different jobs, and they scale off different things. Let me separate them.

**`fade_band` is bounded by frame count, not by looks.** The failure on a fast entry is that the camera crosses the whole band in one frame, so alpha jumps 1→0 in a single step and you flash the near-opaque face for that frame. So the real constraint is "alpha must change by at most ~1/N per frame." Head-on at speed `v`, the clipping fragment's depth shrinks at rate `v`, so:

```
dα/dt = v / fade_band
Δα_per_frame = v·Δt / fade_band        // Δt = frame time
cap Δα ≤ 1/N  →  fade_band ≥ N·v·Δt
```

`N ≈ 3–4` frames is enough to read as a dissolve rather than a pop. So `fade_band` scales **linearly with camera speed**, not with puff size.

**But a fat band makes stationary clouds look foggy from outside.** The band only matters when you're inside it, so a large constant band dissolves surfaces while you're still far away. Resolve the tension by making it speed-adaptive — you can't perceive edge crispness at speed anyway:

```
fade_band = max(band_min, N·v·Δt)
```

`band_min` is your slow-approach soft-particle look; the speed term only inflates it when you're moving fast enough that it's invisible.

**`d0` (feather onset) scales with puff size, not speed.** Wisps want to be comparable to the puff to read as cloud structure rather than edge noise, so start feathering a few radii out:

```
d0 ≈ 2–4 · r
```

This is the *exterior* "opening into tendrils" cue and it's independent of the near-plane dissolve.

**The conflict — and the actual answer to "fast fly-throughs."** `fade_band` also can't exceed the puff's thickness, or you dissolve the entire puff before reaching it and a small puff just vanishes. Cap it at `~r`. Now the two `fade_band` constraints collide:

```
N·v·Δt ≤ fade_band ≤ r   →   feasible only if   v ≤ r / (N·Δt) ≡ v_crit
```

Below `v_crit`, the surface dissolve handles entry over `N` frames. **Above `v_crit` you physically cross a whole puff in under `N` frames — no `fade_band` can save the surface, and you shouldn't try.** That's the regime where you hand off to the interior fog (piece 3 from before): fog extinction is sampled at the camera and updates per-frame regardless of geometry, so it has no polygon to flash. Fast entry isn't a surface problem at all — it's the surface gracefully giving up and letting screen-space fog carry it, both reading the same density so the handoff stays aligned.

So the speed knob isn't "make the band bigger forever" — it's a crossover:

```
v < v_crit:  surface dissolve owns the entry   (band = N·v·Δt)
v ≥ v_crit:  fog owns the entry                (surface contributes ~nothing)
```

**One refinement, since your puffs are anisotropic (squashed lenses for stratus):** the relevant size isn't `r`, it's the puff's extent **projected onto the velocity vector**. A flat deck entered face-on is thin → low `v_crit` → fog takes over almost immediately (correct — you want to be "in the soup," not see a wall). The same deck skimmed edge-on presents its long axis → surface dissolve works fine. So:

```
r_eff = |extent · v̂|        // puff half-extent along travel direction
v_crit = r_eff / (N·Δt)
```

That single substitution makes entry behave correctly for both cumulus blobs and flat stratus without branching on cloud type — it falls out of the geometry.