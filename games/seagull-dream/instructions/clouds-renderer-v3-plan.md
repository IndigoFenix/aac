# Cloud Renderer v3 — structure-aware representation dispatch

Status: **planning.** Supersedes the single-universal-primitive goal of
`clouds-renderer-v2-plan.md` (v2's experiments — blobs, billboards, surface
nets, the shell, the culling, the geomorph/coarse-envelope fixes — all stand
and are reused; only the *organizing principle* changes). Grounded in
`clouds-discussion-continued.md`.

---

## 1. The shift in premise

v2 chased one primitive that works at every scale, fed directly from the
density field. After building four of them we concluded that's the wrong
constraint: each representation is excellent in one regime and structurally
incapable in another (blobs → unfeasible for sheets; surface nets / heightmaps
→ can't billow; billboards → no complex structure; shell → no near field).

v3's premise: **don't pick one primitive — let the weather decide the
representation per region, with every representation sampling ONE shared field
so their silhouettes can't disagree.** This is *not* "stitch independent
renderers by region" (that would move the snap from the distance axis to the
spatial/temporal axes). The discipline that keeps it seam-free is the same one
v2 already relies on for the orbital crossfade: **one source of truth → forms
align by construction.**

The physical predicate that drives the dispatch is the **overhang test**: a
stable, flat deck is single-valued in altitude (`z = h(x,y)`) → a **heightmap**
is the efficient representation; a towering, unstable cloud is multivalued in z
→ needs the full **3-D blob**. Overhang is set by aspect ratio, which is set by
the stability scalar — which we already compute.

## 2. What's already built (the reason v1 is render-side only)

Reading `weather-map.ts` + `cloud-field.ts`, most of the hard half is done:

| The discussion argues for | Already in the codebase |
|---|---|
| One density field as sole authority | `weather-map.ts` baked equirect RGBA; shell GLSL + JS sampler read the same bytes. |
| **Structures that form & dissolve over time** | Vortex population with a real **birth→peak→decay lifecycle pulse** (`buildVortexSlots`, `sin(π·cycleT)^0.75`), staggered by phase, advected along their band. For cyclones / ovals / comma clouds this **already exists.** |
| Continuous advection (no stop-motion in the field) | Bake/scroll split: pattern slides east at the local jet + diagonal morph creep. The field moves smoothly — the "stop-motion" is the *renderer* re-sampling fixed cells, not the field. |
| Stability scalar `s` (cumuliform↔stratiform) | `vigor` (G channel) + per-layer `cumuliformity`, blended into `CloudSample.cumuliformity` — **surfaced per-sample to the renderer today.** |
| Banded fractal (synoptic above outer scale, detail below) | Synoptic map (≥200 km) vs local detail noise (1–100 km) split already honors this. |
| Gas-giant differentiation from rotation + depth | `deriveCloudField`: band count from rotation, jet from spin, streak/waviness from banding, vortex size from cell scale. |

**The gap is almost entirely render-side.** `cumuliformity` is computed and
handed to the renderer, but the renderer only uses it to *squash* blobs, never
to *switch representation*. (Note: a maximally squashed, packed blob field *is*
a displaced heightmap — so the blobs already approximate the deck, just
expensively. We're factoring that limit out into a cheap mesh.)

## 3. v1 architecture — compose, don't partition

Factor the isosurface into two parts that **add**, so there is no in-patch
spatial seam between representations:

- **Deck heightmap = the single-valued base.** Everywhere there's low-lying /
  non-overhanging cloud, render ONE displaced mesh whose height is the
  isosurface altitude. A flat overcast deck = just this mesh (zero blobs). This
  is the efficiency swap the discussion calls for and directly kills "blobs
  unfeasible for sheets." Reuses Exp.3 plumbing (tangent patch, floating
  origin, gradient normals, horizontal-distance edge fade) but driven as a
  *single-valued heightmap* (cheaper than surface nets — no multivalued
  extraction needed for the base).
- **Tower blobs = the multivalued excess.** The existing blob walk, but emission
  **gated on cumuliformity** (above the overhang threshold). Blobs become
  *additive towers sitting on the deck*, not a swarm covering the whole sky.
  Low-cumuliformity cells stop emitting — the heightmap covers them.
- **Billboard fuzz = additive overlay.** Proximity-driven soft billboards that
  blur every structure's outline at close range + particles in dense fog. Pure
  overlay, no seam of its own; reuses the existing proximity-feather + fog
  handoff. The one purely-additive, unconditional win.
- **Shell = far field, unchanged.** Already fixed (white-cover threshold + the
  cover-thresh slider). Heightmap ↔ shell crossfade reuses v2's distance
  discipline.

**Why this is seam-safe:** the heightmap top and the blob bases are both the
*same* isosurface of the *same* field, so a tower meets the deck where the field
says it should. A tower popping in/out at the cumuliformity gate fades onto an
*existing* surface (the deck is always under it), not into empty sky — far less
visible than today's cell-pop. Smooth the gate with a crossfade band on
cumuliformity (blobs fade in as it rises through the threshold).

**Side benefits:** the deck mesh translates smoothly under the advecting field
→ the "stop-motion" disappears for decks (the dominant overcast case);
remaining tower-pop is mitigated by fade-onto-deck.

## 4. v1 phases

1. **Deck heightmap base.** Single-valued displaced mesh from the field
   (repurpose `cloud-surfacenets.ts` or a simpler displaced grid). Crossfade to
   shell. Standalone win: overcast-deck cost collapses + deck stop-motion gone.
2. **Cumuliformity gate on blob emission.** Blobs emit only above the overhang
   threshold and sit on the deck; smooth crossfade band to avoid pop. Kills
   cumulus-field cost (mesh base + few towers, not a full blob swarm).
3. **Billboard fuzz overlay.** Edge-blur + in-fog particles. Additive polish.
4. **Dispatcher + debug controls.** Fold steps 1–3 behind the existing
   `cloud-factory` / renderer selector; expose the overhang threshold + fuzz
   amount as debug sliders alongside `cover thresh`.

## 5. Deferred — field-side enhancements (post-v1, independent)

Both are optional, non-blocking, and add to the weather system, not the
renderer:

- **Per-cell convective lifecycle.** Today only *vortices* have a modeled
  birth/build/collapse; ordinary cumulus form/dissolve via noise-morph. If
  individual towers should visibly bubble up and collapse, give convective
  cells their own lifecycle pulse (mirror the vortex mechanism).
- **Hard altitude features.** Anvil spread at the tropopause + fibrous
  glaciation above the freezing level — the biggest cue that makes a small and a
  large cloud read as *different things*. The data to derive freezing level /
  lid exists (atmosphere model has surface temperature + cloud base/thickness);
  `deriveCloudField` just doesn't impose them yet.

## 6. Verification

Reuse the v2 harness: `/cloud-lab.html`, `__labFlicker`, `__labSetCam/Site`,
`shot-*.cjs`, the distance ladder (`fair-weather-ground` → `above-deck` →
`crossfade-climb` → `orbit`), and the giants (`jupiter-close/disc`) for the
float32 / thin-shell stress. v1 win conditions:
- **Overcast deck emits ≈0 blobs** (cost collapses to one mesh) — the headline.
- **Flatter flicker curve** through the cumuliformity gate than today's cell
  churn; decks no longer stop-motion under drift.
- Reads as cloud at every rung, no visible heightmap↔blob or heightmap↔shell
  seam.
