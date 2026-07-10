# Thought process

Daniel's working on procedural vertebrate head generation for his eyegaze game, building on his existing three-stage pipeline. He's looking for the key parameters—the main "sliders"—that would let him generate recognizable heads across different vertebrate species, and he communicates in a terse, math-forward style expecting concrete, actionable parameters.

I'm thinking through the morphological axes that actually distinguish vertebrate heads from each other. The fundamental anatomy breaks down into braincase, rostrum, orbits, and jaw, and the major variation comes from how these components scale and shape relative to each other. The biggest axis is snout elongation—how much the rostrum extends compared to the braincase, which separates long-snouted animals like dolphins and crocodiles from short-faced ones like cats and owls. Then there's snout taper, controlling whether the rostrum comes to a point or stays blunt. Cranial width and doming describe the braincase shape—whether it's round and domed or flat. And the jaw itself varies in gape, depth, and how the jawline profiles.

Eyes are crucial too—their size, but more importantly their position along the forward-to-lateral axis, which separates predators with binocular vision from prey animals with panoramic vision. There's also the angle between the braincase and face, which can tuck the face under like in humans or angle it forward or down.

Now I'm thinking about how to organize this into a clean, near-orthogonal slider set that a technical artist would actually use. The head is fundamentally a braincase capsule with a tapering rostrum extending forward, plus paired orbits and a jaw. The master parameter is snout length relative to total head length—that single axis captures the biggest morphological divide between dolichocephalic and brachycephalic forms.

Beyond that, I need the braincase globularity, overall skull width split between braincase and snout, and then the rostrum's taper from base to tip. The snout's dorsoventral profile matters too—whether it's tall and deep like a horse or flattened like a crocodile. The bridge curvature can be convex, straight, or concave. The facial tilt relative to the braincase axis is critical, and there's also the stop or brow prominence—that frontal step you see in dogs. For the eyes, I need orbit size and their position along the forward-lateral spectrum.

The jaw parameters include gape length, depth and robustness, and whether there's an underbite or overbite. Then there's the cross-sectional shape of the whole head—whether it's round, laterally compressed like fish and birds, or dorsoventrally flattened like crocodiles. That's quite a lot of parameters, so I should organize them into a tiered structure with the essential core set that Daniel actually needs.

Looking at what's truly critical for recognizing species, I'd prioritize snout length, taper, and dorsoventral flattening; cranial doming and width; facial angle; eye size and convergence; gape length; jaw robustness; and overall cross-sectional compression. That gives me roughly ten main sliders, which feels like a good balance. I could potentially fold some width parameters into aspect-ratio descriptors to keep things cleaner.

To make these as orthogonal as possible, I'll set up a coordinate frame where x runs anteroposterior along the snout, y is mediolateral width, and z is dorsoventral height. The head is essentially a braincase plus rostrum along that x-axis. I should structure this as a parameter table with names, ranges with example species, and what each slider deforms—keeping it terse and math-forward the way Daniel prefers. The global proportions could be separated into three main categories: elongation, width, and height or doming, treating the braincase and rostrum somewhat independently.

Now I'm refining the decomposition into cleaner groups: master proportions like snout length as a fraction of total skull length; braincase parameters like doming; rostrum features including taper, snout depth, dorsal profile curvature, and facial angle; orbit parameters for eye size, convergence angle, and elevation; jaw parameters for gape position, mandible robustness, and bite alignment; and a whole-head cross-section compression axis ranging from laterally compressed to rounded to dorsoventrally flattened.

That gives me roughly 13 core parameters, with about 6-7 being the highest-leverage primary axes. I'm thinking the clearest approach is to present the full organized parameter set directly since Daniel is math-first and prefers terse, equation-focused answers—a structured list will serve him better than an interactive widget at this scoping stage. I can always offer to prototype a slider demo afterward once the parameterization is locked in.

Running through test cases to validate coverage: horses work (high snout length, deep muzzle, lateral eyes), owls work (flat face, frontal eyes, small beak), crocodiles work (extreme flattening, dorsally-placed eyes—exactly why I need cross-section compression and eye elevation). Dolphins mostly work with the dome parameter handling the melon/forehead bulge. Sharks and rays expose a gap though—they have ventral/subterminal mouths (positioned underneath the snout), which is distinct from gape length. That's probably worth adding as a mouth vertical offset parameter to handle that morphology properly.

Looking at more cases: frogs are wide and flat with bulging eyes, anteaters have extreme tube snouts with minimal gape, pelicans are basically all rostrum with a rounded braincase. These all fit the existing parameters. The secondary parameters I'm considering now are mouth vertical position and possibly eye protrusion as separate from eye size.

I'm settling on a primary set of seven core axes that define species identity—rostrum elongation, snout taper, snout depth, cranial dome, eye size, eye convergence, and gape—then a secondary set of refinements like facial angle and mouth position for finer distinctions within clades.

That gives me fourteen total, which feels complete without being unwieldy. I'm noting potential overlaps where taper and cross-section both touch width characteristics, and between snout depth and cross-section compression, but they're measuring different gradients so I'll keep both and flag the relationship for clarity.

I should anchor everything to a consistent normalization frame using head length as the scale reference, and I'm thinking a compact table format will serve Daniel best here since he wants both completeness and concrete structure. I'll pair that with brief notes on how these parameters compose and interact orthogonally.

Now I'm laying out the primary parameters with their ranges and biological exemplars — rostrum fraction from flat-faced to long-snouted forms, snout taper from pointed to blunt, snout depth from depressed to deep, cranial dome from flat to globular, orbit size from tiny to enormous, orbit convergence as an angle from frontal to fully lateral, and gape fraction from short to extremely long. For the secondary parameters, I'm adding facial pitch as a dorsoventral flexion angle to capture how the rostrum tilts relative to the braincase.

Continuing with the remaining secondary dimensions: dorsal profile curvature ranging from concave to convex, cross-sectional compression capturing whether the head is flattened dorsoventrally, laterally compressed, or round, jaw robustness as a ratio of mandible height to skull length, jaw offset to account for under- and overbites, orbit elevation to place the eyes vertically on the skull, and mouth position from subterminal to superior. I'm also noting that all measurements should be normalized by skull length to make them scale-invariant, and flagging that some parameters interact — particularly the dorsoventral flattening which can be driven by both snout depth and cross-section compression, so I need to be careful not to double-count those effects.

I'm recognizing that soft-tissue features like the dolphin melon, elephant trunk, pelican pouch, and ears aren't captured in this skull-based framework — they're similar to horns in being surface protrusions. Ears especially are critical for recognizability in animals like elephants and rabbits, but they fall outside the scope since they're excluded as protrusions. I should flag this limitation if needed.

For the response itself, I'm keeping it concise with two compact tables, a framing note, a few key observations, and a brief offer to build an interactive slider prototype. The density of information calls for terseness, and since he asked a definitional question and prefers compact answers, I'll skip the visualizer and just mention the interactive demo as a natural next step.

# Response

Frame: x = anteroposterior (+ forward), y = mediolateral, z = dorsoventral (+ up). Normalize every length by head length L so sliders are scale-invariant. Head = braincase capsule + rostrum wedge along x, paired orbits, mandible.

**Primary axes** (these carry species identity):

| # | Slider | Definition | Range | Endpoints |
|---|--------|-----------|-------|-----------|
| 1 | Rostrum fraction | f = L_snout/L | 0.15–0.75 | flat-faced (owl, human) ↔ long (gharial, dolphin) |
| 2 | Snout taper | t = w_tip/w_base | 0.1–1.0 | pointed (fox) ↔ square (hippo, bear) |
| 3 | Snout depth | d = h_snout/w_snout | 0.3–2.0 | depressed bill (platypus, croc) ↔ deep muzzle (horse) |
| 4 | Cranial dome | g = h_brain/w_brain | 0.4–1.2 | flat (croc, fish) ↔ globular (cat, primate) |
| 5 | Orbit size | s = d_orbit/L | 0.05–0.35 | tiny (whale) ↔ huge (tarsier, owl) |
| 6 | Orbit convergence | φ (half-angle between eye axes) | 0°–90° | frontal/binocular (owl, cat) ↔ lateral/panoramic (horse, rabbit) |
| 7 | Gape | m = x_commissure/L | 0.2–0.9 | short (cat) ↔ long (shark, frog, snake) |

**Secondary axes** (fit specific clades):

| # | Slider | Definition | Range | Endpoints |
|---|--------|-----------|-------|-----------|
| 8 | Facial pitch | θ, rostrum vs braincase axis | −30°–+30° | ventral-flexed/tucked (human) ↔ dorsal-extended |
| 9 | Dorsal profile | κ, curvature of bridge | −1–+1 | dished/concave (arabian) ↔ roman/convex (sheep) |
| 10 | Cross-section | c, section aspect | −1–+1 | dorsoventral-flat (ray, croc) ↔ round (0) ↔ lateral-compressed (fish, birds) |
| 11 | Jaw robustness | j = h_mandible/L | 0.03–0.25 | slender (anteater) ↔ massive (hyena) |
| 12 | Jaw offset | Δ | −1–+1 | underbite (bulldog) ↔ overbite |
| 13 | Orbit elevation | e_z on skull | 0–1 | lateral-mid (cat) ↔ dorsal/top (croc, frog) |
| 14 | Mouth vertical | o, rostral overhang | −1–+1 | inferior/subterminal (shark, sturgeon) ↔ terminal (0) ↔ superior/upturned |

Orthogonality caveats:
- **3 and 10 both act dorsoventrally on the rostrum.** Make c global (section aspect anywhere along x) and d a rostrum-local override; compose, don't let both independently drive croc flattening or you double-count.
- **2 and 10 compose cleanly** — t is the longitudinal width gradient, c is the local section ratio. Independent.
- **6, 8, 13 together place the orbit.** Near-orthogonal, but the extreme corner (φ→90°, e_z→1) is the croc "eyes on top" configuration — check that interaction rather than treating them as fully separable.

Soft tissue = displacement field over the skull envelope + a set of appendages parented to skull landmarks. Two things must hold: the field is applied along skull normals (so it tracks bone when skull sliders move), and every appendage anchors to a *parametric* landmark, not a world coordinate.

**Layering model:**
```
S_soft(u,v) = S_skull(u,v) + n(u,v)·T(u,v)
T(u,v) = A·[ base + Σ_k w_k·G(dist to landmark_k) ]   // low-pass filtered
cutoff(T) = f(conformity)                              // high-freq bone show-through
```
Landmarks (all parametric on the skull sliders): nasion, rostrum tip/nostril, commissure, orbit rim, temporal (caudo-dorsal to orbit, near jaw hinge), ventral mandible.

**A — Continuous tissue field**

| # | Slider | Definition | Range | Endpoints |
|---|--------|-----------|-------|-----------|
| 15 | Padding | A, global normal-offset magnitude | 0–1 | gaunt/skull-visible (greyhound, camel) ↔ padded (seal, infant) |
| 16 | Conformity | low-pass cutoff on T | 0–1 | smoothed (whale, seal) ↔ bony, sutures/zygomatic read through (greyhound) |
| 17 | Cheek fill | masseter-region bulge weight | 0–1 | flat (bird, no lips) ↔ slab-cheeked (big cat, human) |
| 18 | Lid aperture | palpebral fissure vs orbit size | 0–1 | narrow/almond ↔ wide/round exposed globe (owl, primate) |

15 and 16 are magnitude vs frequency — orthogonal. The off-diagonal (gaunt+smooth) = scaled reptile with no adipose; (padded+bony) is rare, fine to allow.

**B — Anchored appendages** (presence gates shape sliders — when size→0 the rest collapse, same pattern as horns)

| # | Slider | Definition | Range | Endpoints |
|---|--------|-----------|-------|-----------|
| 19 | Mouth covering | fleshy↔keratin blend | −1–+1 | thick mobile lips (horse, camel) ↔ lips (0) ↔ beak/rhamphotheca (bird, turtle) |
| 20 | Beak curvature | active only when 19>0 | −1–+1 | up-curved (avocet) ↔ straight ↔ hooked (raptor) |
| 21 | Proboscis extension | fleshy snout length past nostril landmark | 0–1 | flat rhinarium (dog) ↔ disc/mobile (pig, tapir, saiga) ↔ trunk (elephant) |
| 22 | Nostril orient | rotation of naris | −1–+1 | ventral ↔ lateral ↔ dorsal/upturned |
| 23 | Pinna size | d_pinna/L | 0–0.6 | absent (bird, whale, seal) ↔ huge (fennec, rabbit) |
| 24 | Pinna carriage | erect↔pendulous | 0–1 | pricked (cat, fox) ↔ drooping/lop (hound, rabbit) |
| 25 | Pinna shape | tip form | −1–+1 | pointed/tufted (lynx) ↔ round (mouse, bear) |
| 26 | Pinna placement | (x behind orbit, z on braincase) | 0–1 each | mid-lateral (cat) ↔ high/dorsal (rabbit) |
| 27 | Throat mass | dewlap/pouch under mandible | 0–1 | none ↔ dewlap (moose, zebu) / pouch (pelican) |

**Gating & coupling** (the corners that break):

- **19↔20 is one blend, not two axes.** Structure as a signed 1D interpolation so "fleshy beak" is unreachable. Lips at 0 = bare mouth line (many reptiles).
- **21 must decouple from skull rostrum (#1).** Elephant has a short facial skeleton + huge trunk; tapir short nasals + mobile snout. If proboscis rides on bony snout length you'll conflate the two — anchor it at the nostril landmark and drive its length independently. Its root must C0-blend with the rostrum tip; watch discontinuity when snout depth (#3) and 21 are both high.
- **Pinna (23–26) anchors to the temporal landmark**, which sits caudo-dorsal to the orbit and moves with cranial dome (#4) and orbit convergence (#6). Drooping carriage (24 high) + large size (23) clips the base into the braincase — clamp base insertion to the skull surface.
- **27 tracks jaw robustness (#11) and gape** since it hangs off the ventral mandible line.

**Failure modes:** tissue self-intersection at (huge orbit #5 + high convergence #6 + wide lids #18); proboscis root crease; pinna-base clip on droop. All resolve by re-projecting soft verts to the skull surface after skull-slider edits and clamping negative penetration.

Still out (hair-class, not surface tissue): vibrissae, eyelashes, fur tufts, manes — those want a follicle/strand layer, not this displacement field. Flag if you want it.

Want the 2D profile+top prototype now, driven by the full 27 so you can watch the soft layer deform as the skull sliders move?