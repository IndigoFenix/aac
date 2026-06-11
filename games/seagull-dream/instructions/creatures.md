# Creature Generator

This will be used to generate and animate a wide variety of creatures from a set of templates, both realistic and fantastical.
Think along the lines of Spore, but more simplified and abstract in style. Stretching and thickening parts of existing models rather than creating an excessive number of individually detailed models will do a lot of heavy lifting here.

Use procedural animation when possible

This system will be used to create plausible alien ecosystems later, with distinct evolutionary branches. Think of body plans and "growing" modifications to those body plans, rather than artificially attaching body parts together.

While this specific game will involve procedural evolution, we will also want to be able to use the same system to allow the creation of creatures based on a description.

---

# Plan (agreed 2026-06-10)

Decisions made: creature-lab-first delivery; skinned capsule-loft meshing;
all three locomotion modes (land / air / water) in v1; self-contained
`src/creatures/` module with the pure-math layers kept three.js-free.

## Architecture

Same authority/renderer split as the cloud system: a pure-math layer that
decides WHAT a creature is, and a render layer that builds and animates it.

```
                 ┌─ creatures/genome.ts     PURE MATH. The Genome TYPE:
                 │                          a plain, JSON-serializable,
GENOME PRODUCERS │                          documented set of continuous
                 │                          anatomy parameters — plus
seed pipeline ───┤                          validate()/clamp(). This is
(this game)      │                          the stable interchange format.
                 │
description  ────┤  creatures/phylogeny.ts  PURE MATH. Seed producer:
pipeline (AI,    │                          planet (LifeState, gravity,
later, server-   │                          water, biosphereAgeGyr) →
side)            │                          founders → species = founder
                 │                          + mutation deltas.
                 ▼
creatures/skeleton.ts   PURE MATH. Genome → bone hierarchy + rest
                        pose + per-bone radius/membrane annotations.
                             │
creatures/mesh.ts       three.js. Skeleton → ONE low-poly skinned
                        capsule loft (+ membranes + rigid details).
creatures/animation.ts  three.js. Gait controllers → bone rotations
                        per frame. Continuous mode blending.
creatures/lab.ts        Creature-lab debug mode (v1 deliverable).
(later) creatures/population.ts   spawning/streaming on planets.
```

### Genome as interchange format (description-driven creatures)

Procedural evolution is only ONE producer of genomes. The same renderer
must also accept genomes authored from a description (an AI emitting
genome JSON server-side — the games-bridge pattern), so:

- The Genome is a **plain JSON-serializable object** with documented,
  human-meaningful fields and units — no opaque packed vectors, no
  hidden derivation from seed at render time. Seed → genome happens
  entirely in the producer; downstream layers never see the seed.
- `genome.ts` ships **validate() + clamp()**: any genome from any
  source (including a hallucinating LLM) is clamped into renderable,
  animatable ranges and rejected only on structural impossibility.
  Skeleton/mesh/animation may assume a validated genome.
- Field names and semantics are chosen to be **describable** ("legPairs",
  "neckLength", "membrane") so a description→genome prompt maps
  naturally onto them. When this pipeline is built, consult
  docs/PROMPT_WRITING.md; the lab gets a paste-genome-JSON box for
  testing AI-emitted genomes long before the server pipeline exists.

`physics-system/` is live code (solar-system.ts materializes systems
through it; cloud-field and the readout consume its features). The
creatures module IMPORTS from it (`LifeState`, atmosphere, gravity) but
lives separately so a future folder reorganization stays easy.

## Genome — phase transitions, not parts

Anatomy follows the same core principle as celestial bodies: continuous
regimes, no discrete classes. Everything grows from one structure:

- **Spine** — a metameric chain. Parameters are *profiles along the
  chain* (length, radius, taper, stiffness), so worm → fish → whale →
  long-necked grazer are points in one space, reached by stretching and
  thickening — never by swapping models.
- **Locomotor legs** — capped at **3 distinct TYPES** (`legGroups`). Real
  animals, however many legs they have, don't use more than ~3
  functionally distinct leg types for locomotion. Each type is
  DUPLICATED into `pairs` rows spread across a `stationStart..stationEnd`
  span, with a size gravitation (`sizePeak` 0 front / 0.5 middle / 1 back,
  `sizeContrast`) so a row can grow toward the front, middle, or back.
  Rows of one type share a gait — fewer "silly walks", more real-world
  movement strategies, and simpler animation. All articulation params
  (segments, length, radius, splay, kneeLift, crouch, foot, stance, toes,
  + webbing `membrane`) are shared by every row in the group.
- **Specialized appendages** — non-leg limbs (`appendages`), tagged by
  `function` (wing / fin / arm), defined individually with
  function-specific rules. `membrane 0→1` makes a wing/fin airfoil; arms
  hang and don't reach for the ground. "Is it a wing?" is the explicit
  function, NOT a membrane threshold on a leg — so a leg with webbed feet
  never accidentally becomes a wing.
- **Head** — the spine's front taper plus a sensory cluster: eye count /
  size / placement, jaw-vs-beak blend (beak = rigid jaw extreme).
- **Posture** — sprawl→erect, horizontal→vertical body angle.

Locomotion *capability* is derived from morphology + environment, not
declared: wing area vs gravity × air density says whether it can fly,
limb strength says walk, body-wave amplitude says swim. The same genome
walks on land and paddles in water if its numbers allow both.

## Body-plan constructor roadmap (from creatures-list.md)

`instructions/creatures-list.md` is the archetype checklist. It collapses
onto ONE connective idea + a small toolbox, NOT 60 features:

**Connective idea — attachment = `(station, angle, symmetry, count)`.**
Every part attaches to the axis (or another part) at a station along it
and an angle around its cross-section. `angle = ±θ` → bilateral pair;
swept 360° → radial (jellyfish/anemone/urchin); `top` → dorsal midline
(sail/dorsal fin/frill); `bottom` → ventral. Radial body plans are then
the same placement engine over a degenerate (near-zero-length) axis — this
is what makes "no arthropod/vertebrate split" mechanical, not aspirational.

**The ~7 part primitives** (each absorbs a whole column of the list):
1. **Axis / spine** — + cross-section (lateral↔round↔dorsoventral),
   + tagmata profile (waist/bulges), + symmetry flag (bilateral|radial).
2. **Flexible chain** — ONE primitive = tail, scorpion tail, tentacle,
   antenna, proboscis, tongue, trunk, eyestalk, lure, snake/worm body.
   Differs only by length / segments / attach point / terminal feature.
3. **Articulated limb + end-effector** — current `legGroups`, with a
   swappable tip: foot+toes / claw-pincer / hand / hoof / flipper / fin.
   Function isn't exclusive (mantis, gorilla walk AND grasp).
4. **Membrane** — spanned skin, two anchors: limb-spanning (wing/bat/
   pterosaur/web) and midline (dorsal+anal+caudal fin = sail = frill).
5. **Rigid plating / shell** — cap (turtle/beetle/trilobite/crab),
   coil (snail/nautilus), retract (turtle). First genuinely new geometry.
6. **Dermal growths** — horns/antlers/spikes/crests; branching+spiral
   grammar shared with plants. DEFERRED per the list's own note.
7. **Head / mouth cluster** — mouth continuum (sucker→jaw→beak→bill) +
   mouthparts re-homed as other primitives (mandibles=grasp manipulators,
   proboscis/tongue/trunk=flexible chain, teeth/tusks=dermal, eyestalks).
   (Near-cosmetic 8th: fur/feather/fluff covering — last.)

Coverage proof (the hard cases compose, no bespoke code): lobster = axis
(tagmata) + 1 leg group(rows) + 2 claw appendages + swimmeret group +
4 antenna chains + tail→caudal-membrane. jellyfish = radial + near-zero
axis + radial tentacle group. human = erect axis + 1 leg pair + arm/hand
appendages + head. trout = lateral-flat axis + 2 paired fins + 4 midline
membranes.

**Build order (approved):** axis generalization → flexible chains →
limb merge + end-effectors → membranes → plating. Then gaits (phase 2).
The proposed unification under it all: merge `legGroups`+`appendages` into
one `limbGroups` (function-tagged, placement bilateral|radial, pairs/span/
gravitation, manipulator tip, membrane); the ≤3 cap then applies only to
the *locomotor* subset, while wings/fins/antennae/tentacles duplicate freely.

## Phylogeny — plausible alien ecosystems

Per life-bearing planet, a phylogeny seed generates a handful of
**founder** body plans (count and derivedness scale with
`biosphereAgeGyr` and habitability). **Species** are founders plus
accumulated mutation deltas, assigned to biome bands (same biome logic
scatter.ts uses for trees). Children inherit parent genomes with small
mutations, so a planet's fauna shares family resemblance — distinct
evolutionary branches for free. `LifeStage` gates everything: only
`complex`+ planets get visible creatures.

## Mesh — skinned capsule loft

Build-time: walk the skeleton, place low-poly rings (6–10 sides) along
each chain using the radius profile, stitch into ONE continuous skin,
weight each vertex to 1–2 bones. Membrane params fan skin between
chains for wings/fins. Rigid details (beak, eyes, horns) are tiny
meshes merged into the same geometry with single-bone weights.

- One draw call and ~300–600 verts per creature; GPU skinning.
- Built once per species, cloned per individual (scale/color variation).
- LOD: same skeleton lofted with fewer rings/sides at distance; bones
  frozen beyond a range. Fade in/out per the no-snapping rule.

## Animation — procedural gaits, continuous blends

Per-creature gait controller outputs bone rotations. Modes blend
continuously (exactly like the player's wing/rocket/warp split):

- **Walk/run** — phase-offset stepping across N leg pairs (gait pattern
  from leg count + speed), 2-bone IK per foot against `heightAt`,
  body bob + spine sway.
- **Fly** — reuse the player's flight-strain concept: flap rate/amplitude
  from how hard the creature must work against gravity, air density,
  and speed; glide when lift suffices; fold in dives.
- **Swim/slither** — traveling sine wave down the spine (amplitude,
  wavelength, frequency from genome); the identical mechanism does
  snakes/worms on land.
- **Idle** — breathing (radius pulse), head look-at, weight shifts.

Environment decides the blend (depth, altitude, slope); morphology
decides the parameters; nothing pops between modes.

## Creature Lab (v1 deliverable)

A debug mode reachable from the debug menu: flat test pad, one creature.

- Seed field + re-roll; full genome slider set; environment toggles
  (gravity, air density, water level) to exercise gait blending.
- Gait playback: a movable target the creature walks/flies/swims to.
- Phylogeny browser later: pick planet seed → list species → inspect.
- ALL tuneables go in config.ts + the debug menu, per main.md.

## Performance budget

- Steady state near fauna: ≤ ~30 animated creatures, 1 draw call each.
- Behavior LOD: far = culled, mid = cheap wander (no IK), near = full.
- CPU per frame: bone quats only (a few dozen per near creature); IK
  raycasts share the terrain `heightAt` sampler.
- Build cost amortized: species meshes generated lazily, never in the
  same frame as a fade-in.

## Phasing

1. **Genome + skeleton + loft + lab viewer** — static rest pose,
   sliders, seed, paste-genome-JSON box. Node tests for genome/skeleton
   determinism + validate()/clamp() round-trips
   (precedent: `server/tests/seagull-weather-map.test.ts`).
   **DONE 2026-06-10** — `src/creatures/{genome,skeleton,mesh,lab}.ts`,
   lab at `/lab.html` (own Vite entry), tests in
   `server/tests/seagull-creatures.test.ts`. Typical creature:
   ~350 verts / ~650 tris / ~25 bones, builds in a few ms.

1.5. **Limb articulation + feet (pre-locomotion)** — **DONE 2026-06-11.**
   Per-limb continuous params added so gaits have real anatomy to drive:
   - `kneeLift` — IK pole-direction continuum: 0 sagittal fold under
     the body (mammal; front pairs fold backward like elbows, rear
     forward like knees), ~0.5 lateral elbow-out (reptile sprawl),
     1 arched ABOVE the torso (arthropod — also slings the body low
     between the high knees).
   - `crouch` — rest fold (0 column … 1 frog sit); zigzags interior
     joints of 3–4 segment legs so they read segmented.
   - Feet: `footLengthFrac` + `stance` continuum (0 plantigrade flat
     foot → 0.5 digitigrade raised heel → 1 unguligrade toe-tip,
     raising the ankle and steepening the foot bone), plus
     `toeCount`/`toeLengthFrac`/`toeSpread` fanned toe chains.
   Contact convention: ball/toe centerlines sit at 0.85 × radius so the
   skin visibly bears weight. Still missing, deliberately deferred:
   non-beak mouthparts, grasping arms/hands — less relevant to
   locomotion.

1.6. **Leg-type / appendage split** — **DONE 2026-06-11.** Replaced the
   flat per-pair limb list with the empirical "≤3 leg types" model:
   `legGroups[]` (≤3, each duplicated into `pairs` rows with size
   gravitation) + `appendages[]` (function-tagged wing/fin/arm).
   `skeleton.ts` gains `resolveLimbs()` which unfolds groups into
   per-row resolved legs (feeding the existing IK/loft unchanged) and
   appendages by function. mesh.ts untouched (lofts any `limb*` chain).
   Animation payoff: a row of one type moves with one coordinated gait
   (metachronal waves, quadruped diagonals) instead of N independent
   procedural walks.
1.7. **Body-plan constructor (axis generalization)** — **IN PROGRESS.**
   Building out creatures-list.md coverage before gaits.
   - Cross-section **DONE 2026-06-11**: `spine.crossSection` width:height
     ratio (1 round, >1 dorsoventrally flat ray/crab/trilobite, <1
     laterally compressed fish). Carried on `CreatureBone.aspect`, eased
     to round across the neck, head stays a bulb; hips reseat on the
     flattened surface; mesh scales rings area-preservingly.
   - Tagmata **DONE 2026-06-11**: `spine.profile` = control points
     `{at, scale}` multiplying the taper to carve waists/bulges (wasp
     petiole, spider/ant abdomen, insect thorax, lobster cephalothorax).
     `profileFactorAt` in skeleton.ts; clamp caps (≤8) + sorts + ranges;
     limbs stationed on a tagma naturally avoid the waist.
   - Flexible chains **DONE 2026-06-11**: `genome.chains: FlexChainGenome[]`
     — ONE primitive for antennae / tentacles / trunk / proboscis / tongue
     / eyestalks / lures. Fields: `attach` (head|body), `station`, `count`,
     `radial` (crown vs bilateral pairs; count 1 = single midline), segments,
     lengthFrac, radiusFrac, taper, `aim` (-1 down..+1 up), `spread`, `curl`,
     `tip` (none|club|eye|stinger). Built in skeleton.ts step 7.5 as
     `chain*` bone chains (kind `"chain"`) post-lift — never ground-solved,
     never lift the body; mesh.ts lofts any `chain*` like a limb. Tips →
     eye/stinger become details, club swells the last bone. `MAX_CHAINS`=4,
     `MAX_CHAIN_COUNT`=12; clamp coerces enums/bools + floors taper so tips
     stay solid. Lab gets a "flexible chains" section (attach/tip selects +
     radial checkbox + sliders). Verified: trunk, antennae, eyestalks
     (eye tips), octopus radial crown. Tests now 31.
   - Limb merge + end-effectors **DONE 2026-06-11**: `legGroups` +
     `appendages` merged into ONE `limbGroups: LimbGroupGenome[]`,
     function-tagged (`leg`/`arm`/`wing`/`fin`), with `placement`
     (`bilateral` | `radial`), `count` copies + station span + size
     gravitation, and a swappable `endEffector`
     (`none`/`foot`/`hoof`/`hand`/`claw`/`paddle`). The ≤3 cap now applies
     only to the LOCOMOTOR (`function: "leg"`) subset (`MAX_LOCOMOTOR_GROUPS`);
     `MAX_LIMB_GROUPS`=6 total. `resolveLimbs` returns one flat
     `ResolvedLimb[]`; the skeleton builds every limb through ONE path that
     ground-solves legs (generalized from ±X `side` to a horizontal
     `outDir`, so radial spokes ground-solve too) and folds arms/wings/fins
     statically. A shared `addDigits()` fans the end-effector's digits
     (toes/fingers/pincers) for both grounded feet and hanging hands.
     Verified in lab: quadruped (no regression), hexapod, winged biped,
     radial 6-leg star, hoofed ungulate, bipedal human with grasping hands,
     flat crab with claw-arms, plesiosaur flippers. Tests now 35.
   - **Radial BODY plans** (jellyfish/anemone/urchin) now reachable via
     `placement: "radial"` on a near-zero axis.
   - Midline membranes **DONE 2026-06-11**: `genome.membranes:
     MembraneGenome[]` — ONE primitive for the dorsal fin, anal fin,
     dimetrodon sail, and (a dorsal + ventral panel over the tail) a
     caudal fin. Fields: `edge` (dorsal|ventral), body-arc `start`/`end`
     (0 = tail tip .. 1 = chest), `height`, `heightPeak`, `rays` (scallop
     the outer edge). skeleton.ts samples the axial centerline (tail→torso)
     into `MembranePanel[]` (ribs welded to axial bones); mesh.ts stitches
     a thin two-sided sheet (base→accent color). `MAX_MEMBRANES`=4. The
     OTHER membrane topology (limb-spanning wing/web) already lives on a
     limb's `membrane`. Tests now 38. Still to do: plating/shell. THEN
     gaits (phase 2).
2. **Procedural animation** — three gaits + continuous blending, IK.
3. **Phylogeny** — founders, species mutation, lab phylogeny browser.
4. **Planet integration** — spawning/streaming (scatter-style stable
   anchors), behavior LOD, population caps. Planned separately when
   phases 1–3 are proven in the lab.
