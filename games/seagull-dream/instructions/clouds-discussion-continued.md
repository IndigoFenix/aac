=====
Let me ask a different question.
*Why* do clouds look the way they do - forming dense, visible clumps instead of a continuous density field?
=====

Because a cloud is a *smooth* field run through a hard threshold and then organized by an instability. Four compounding mechanisms, in order of importance:

**1. Condensation is a phase transition — the field is rectified.** Vapor doesn't gradually become visible. Below saturation there is *zero* liquid water no matter how humid; cross the dew point and condensation switches on:

```
LWC = max(0, q − q_sat(T,p))
```

The humidity field `q` can be perfectly smooth and continuous — the *visible* cloud is its clipped positive part. This is exactly the `saturate(remap(...))` in your rendering field, except here it's real physics. It's also why cloud bases are flat: the base is the altitude where rising air first hits the dew point (the lifting condensation level) — a literal temperature isosurface.

**2. Convection discretizes the updrafts — this is the clumping proper.** A layer heated from below is gravitationally unstable (Rayleigh–Bénard). The instability does *not* lift the layer uniformly; it organizes into discrete cells — concentrated buoyant plumes separated by compensating subsidence. Rising air cools → condenses → cloud. Sinking air warms → clear → gap. The clumps *are* the convection cells, with spacing set by the layer depth (cell aspect ratio ~1).

**3. Latent heat is a positive feedback — cores self-amplify.** Once a parcel condenses, it releases latent heat, gaining buoyancy, accelerating the updraft, lifting and condensing more. Autocatalytic, winner-take-all. The active cores tower while neighbors subside — this is why cumulus have crisp cauliflower boundaries instead of soft gradients. A cloud feeds its own updraft.

**4. Entrainment depletes the in-between — edges are actively maintained.** At margins, dry environmental air mixes in and evaporates droplets (evaporative cooling → downdrafts). Partially-cloudy air tends to resolve to *fully* condensed (core) or *fully* clear (edge). The density distribution goes bimodal, not continuous — sharp boundaries, hollow gaps.

So: smooth fields (T, q, w) → threshold (1) → instability-organized into discrete cells (2) → cores amplified (3) → margins evaporated (4) = dense visible clumps with empty gaps.

**Two things this hands back to your model:**

Your **stability scalar `s` is exactly mechanism 2's strength.** Clumpiness vs. sheetness *is* the convective-instability axis — that's not an analogy, it's the same variable. Unstable → strong discrete plumes → cumulus. Stable → broad gentle ascent, no cellular instability, condensation across a wide region → stratus (still flat-based, from threshold (1), but not clumped). Stratocumulus is the weakly-unstable middle: capped cellular convection → lumpy-but-packed. The cumuliform↔stratiform axis you parameterized is literally "how much does mechanism 2 fire."

Your **Worley/cellular noise is a cheap proxy for convection-cell packing** — Voronoi cells mimic Rayleigh–Bénard cell tessellation, so using it for placement isn't arbitrary decoration, it's standing in for the real spatial organizer. Which suggests a refinement: scale the Worley cell size to your (notional) convective layer depth, and let `s` modulate cell *contrast* — high `s` (stable) washes the cellularity toward a sheet, low `s` sharpens it into separated cores. One field, physically grounded, drives both placement and the discrete↔connected axis.

=====
Is this behavior size-dependent? I've been trying to treat the noise as a kind of fractal, with large clumps and small clumps behaving in essentially the same way, which feels elegant, but in practice it rarely comes out looking right, largely because it's problematic to "predict" what a given structure will look like up-close at the distance it needs to be viewed - complex shapes can't really be approximated with giant, uniform blobs.

Some rendering strategies are good for handling stratus-type structures (topographical maps) while others are good at handling cumuliform structures (blobs). Maybe the best strategy would be to shift from one to the other as needed.
=====

Self-similarity is real in clouds — but it's **banded**, and you've been applying it outside the band. That's the whole problem.

## The fractal is only valid in the inertial subrange

Turbulence is statistically self-similar, but only between two cutoffs: an **outer scale** (where energy is injected) and an **inner scale** (where it dissipates). Cloud perimeters do measure as fractal — but over a bounded range, not forever. Outside that range, three different things happen:

- **Below the inner scale:** diffusion smooths everything. No structure.
- **Within the band:** genuine fractal billow. Your noise is correct *here*.
- **Above the outer scale:** structure is no longer random self-similar noise — it's the deterministic convective organization. A bigger clump is *not* a scaled-up small clump.

Your uniform fractal treats the whole range as one regime. So it generates self-similar mush at every scale, and the coherent *shape* — which only lives at and above the outer scale — never emerges. That's exactly why "complex shapes can't be approximated with giant uniform blobs": the giant scale isn't supposed to be blobs *or* noise. It's supposed to be weather.

## Why scale-invariance breaks: clouds live against *fixed* altitudes

This is the part the fractal can't capture. A cloud's appearance depends on its **absolute** size, because as it grows it crosses fixed atmospheric layers:

```
LCL          → flat base        (dew point altitude)
freezing lvl → glaciation, fibrous anvil character (ice, not droplets)
inversion /
tropopause   → flat capped top, spreading anvil
```

A fair-weather cumulus sits entirely below the freezing level — all liquid, cauliflower all over. A cumulonimbus spans *all* of these: liquid base, glaciated fibrous top, flat anvil where the tropopause stops it. It is qualitatively different, not 10× bigger. **Absolute altitude breaks self-similarity by construction** — the cloud knows how big it is because it knows which thresholds it has crossed.

So the elegant fractal isn't wrong, it's incomplete: it's the *detail* layer inside the band. The *identity* of a structure comes from where it sits against absolute layers, and that's what makes a small cloud and a large cloud look right *as different things*.

## What this means for the representation question

Now your stratus-vs-cumulus instinct. You're right that they want different representations — but the variable isn't "cloud type" and the switch isn't a hack. Both are isosurfaces of one density field; the difference is **overhangs**:

- **Stratus:** thin, wide, vertically degenerate. The isosurface is single-valued in z — a graph `z = h(x,y)`. A **heightmap is the efficient representation** precisely because there are no overhangs to represent.
- **Cumulus:** towers and overhangs. The isosurface is genuinely multivalued in z → you need the full 3D blob/metaball field.

So "topographic for stratus, blobs for cumulus" is really one question: **does the field's isosurface overhang?** And overhang is set by aspect ratio, which is set by — your stability scalar again. Stable → flat, no overhang → heightmap suffices. Unstable → towering, overhangs → blobs required.

And note the continuity I flagged earlier closes the loop here: a maximally squashed, densely packed blob field **is** a displaced shell — a heightmap. The blob representation already *contains* the heightmap as its anisotropic limit. So conceptually you never switch; you slide aspect ratio.

The honest engineering caveat: rendering a smooth overcast deck as ten thousand squashed blobs is wasteful when one displaced shell would do. So you *may* swap to a cheaper heightmap representation for efficiency — but the rule for swapping is the **overhang test** (a physical predicate from `s`), not a distance/LOD threshold, and both representations read the **same density field** underneath, so they align exactly. Same source-of-truth argument as the orbital crossfade and the cloud entry: nothing snaps because the silhouettes were never independent.

## Concretely, how to fix the fractal

1. **Anchor the outer scale to layer depth.** `L_outer ≈ cloud_depth` (cell aspect ratio ~1 for convection). Above `L_outer`, *stop using noise* — drive structure from the weather field and the fixed layers.
2. **Run fractal only below `L_outer`, clamped at an inner scale.** Bounded band, not infinite cascade.
3. **Impose the absolute layers as hard features**, not noise: flat base at LCL, capped/spreading top at the inversion, fibrous character above the freezing level. These are what make scale read correctly without prediction.
4. **Parent fine detail to its cell.** Up-close billow should be a *child* of the outer-scale updraft it belongs to — inheriting the cell's orientation and towering — with fractal adding only fine surface. That's why you can't predict the close-up from scaled noise: the close-up's coherence comes from its parent structure, not from descending the cascade.

The shift in mental model: not one fractal at all scales, but a **hierarchy** — weather field (deterministic) → convective cells (outer scale, sized by depth) → fractal billow (inside the band) → smooth (below inner scale), with fixed atmospheric altitudes overriding the lot. Self-similar in the middle, physically pinned at the top and bottom.

The thing worth deciding before building: do your planets have a meaningful **freezing level and tropopause** in the model, or just an LCL? If you have all three, you get cumulus→cumulonimbus→anvil differentiation for free from absolute altitude — which is the single biggest cue that sells "small vs large cloud" without any per-cloud authoring. If you only have the condensation base, you'll get correct flat bases but every cloud will read as the same *kind* regardless of size.

=====
Yes, we have a planetary atmospheric model used to approximate different height levels. Which raises another question - on very large, gas planets, do cloud structures tend to be more structurally complex, or just bigger? Does Jupiter have hurricanes within hurricanes and anvils on top of anvils, or just really big weather?
=====

Mostly the latter — but with two specific exceptions where the answer is "more complex," and they're physically interesting enough to be worth stealing for your model.

The headline: Jupiter's dominant structures are **bigger, not deeper in the recursive sense.** No anvils on anvils. Here's why, and it ties straight back to the layer argument.

**Bands, not cells, are the top-level organizer.** On a rapidly rotating planet, the controlling parameter is the Coriolis force relative to the flow — small Rossby number. Earth is a slow, small rotator with weak banding; Jupiter rotates in ~10 hours and is huge, so rotation utterly dominates. The result is that convection gets **stretched into zonal bands** (the belts and zones) rather than organizing into the roughly isotropic cells you get on Earth. So the outer-scale organization isn't "giant version of a thunderstorm cluster" — it's a *different geometry*: east-west striping set by rotation, not tessellated convective cells. The top of your hierarchy changes shape with rotation rate.

**The Great Red Spot is one vortex, not nested hurricanes.** It's a single coherent anticyclone, ~1.3 Earth-diameters wide, stable for centuries precisely *because* it's coherent — not a fractal of storms-within-storms. It's also fundamentally unlike a hurricane: a hurricane is a warm-core engine driven by condensation and surface heat flux, with a hard size limit (more on that below). The GRS is a cold-core vortex stabilized by the banded shear around it. Big and simple, not recursive.

**Why no anvils-on-anvils — the vertical argument is the same one we just used.** Anvils form because the troposphere has a *lid*: the tropopause stops rising air and forces it to spread horizontally. There's exactly one such lid. You can't stack anvils because there's only one altitude where the spreading happens. Jupiter has the same structure — a deep convective layer capped by a stable stratosphere — so its updrafts also spread out at a ceiling. One lid, one anvil level. Depth doesn't add vertical recursion; it just moves the ceiling and fattens the layer. This is exactly your "absolute altitude breaks self-similarity" principle operating on a gas giant: bigger planet, deeper layer, *but still one set of fixed levels*, so still no recursion in z.

Now the two real exceptions, both worth taking:

**1. Hurricanes have a hard size cap; Jupiter's vortices don't — and that's a clean physical knob.** A terrestrial hurricane's size is limited by the Rossby deformation radius — the scale beyond which rotation tears a coherent vortex apart. That radius scales with atmospheric depth and inversely with rotation+latitude. So "why isn't there a hurricane the size of a continent" has a real answer: the deformation radius caps it. On Jupiter the deformation radius is much larger (deeper atmosphere) *and* the banded shear actively re-stabilizes big vortices, so coherent storms can vastly exceed anything Earth allows. **For your model:** vortex max size isn't an art choice, it's `L_def ∝ depth / rotation` — the same atmospheric depth you already track, plus rotation rate, sets how big a coherent storm can get before it must break up or band.

**2. The *only* place Jupiter genuinely goes recursive is turbulent stirring at vortex edges — and there the fractal is more valid than on Earth, not less.** The famous filamentary curls, the von Kármán-style swirls peeling off the GRS, the turbulent wakes — that's 2D turbulence, and 2D turbulence has an *inverse* energy cascade (small eddies merge into big ones) plus a forward enstrophy cascade that produces long-range, sharply filamented self-similar structure. So on a gas giant the **inertial subrange is enormous** — the band where your fractal noise is legitimately self-similar spans a far wider range of scales than on a terrestrial planet. The eddies-within-eddies you were hoping for *do* exist on Jupiter, but they live specifically in the **horizontal turbulent shear between bands and around vortices**, not in vertical convective stacking.

So the corrected mental model for gas giants, in your hierarchy's terms:

- **Top scale:** bands (rotation-dominated), not isotropic cells. Geometry changes with Rossby number.
- **Embedded coherent vortices:** big, simple, single — size-capped by deformation radius, which grows with depth.
- **Vertical:** still one lid, one anvil level — no recursion, same as Earth, just deeper.
- **Horizontal turbulence:** *wider* valid fractal band than Earth (2D inverse cascade) — this is where the genuine self-similar complexity lives.

Which lands on a nice unification with what you already built: the thing that differs between a terrestrial planet and a gas giant isn't "add recursion." It's **two scalars you can already source** — rotation rate (sets band-vs-cell geometry at the top, via Rossby number) and atmospheric depth (sets vortex size cap, via deformation radius). Feed those into the outer-scale organizer and the same hierarchy produces Earth weather at one setting and Jovian banding at another, with the fractal detail layer simply given a wider scale range to play in. No new representation — just the top of the tree reshaped by rotation, and the inertial band widened.