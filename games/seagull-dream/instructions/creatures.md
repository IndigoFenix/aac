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
- **Limbs — ONE kind: a leg** (`limbGroups`). There is NO
  function/end-effector enum (removed 2026-06-12). A limb's ROLE emerges
  from shape + **attachment** + **strain**: a **wing/flipper** is a leg
  with high `membrane`; an **arm** is a leg that can't plant a foot cheaply
  at the current `bodyHeight` (too short, or socketed too high), so it
  lifts off and hangs; a **hoof/hand/claw** is digit variation (`toeCount`
  + `toeContrast` gravitation + `opposition` thumb + `toeCurl`). Each type
  is DUPLICATED by `count` into bilateral rows or radial spokes across
  `stationStart..stationEnd`, with size gravitation
  (`sizePeak`/`sizeContrast`). Few types by design (`MAX_LIMB_GROUPS`).
- **A limb is a 3-section chain (femur / tibia / foot) posed by 3 DOF**
  (rebuilt 2026-06-12 — replaces `attachAngle`/`kneeBend`/`segments`/
  `jointZigzag`; arthropods don't get more DOF, just a render subdivision).
  `attachHeight` is now ONLY the MOUNT position (where on the cross-section
  the limb roots, and whether it can bear weight at all — a dorsal mount is
  a wing). Where the limb AIMS is the three NEUTRAL degrees of freedom:
  `restProtraction` (fore/aft swing), `restLevation` (carried down / out /
  up), `restFlexion` (signed knee fold). This split is what the mantis
  needs: it mounts low (so it *can* reach the ground) yet rests raised.
  `legBalance` (−1 long femur .. +1 long shank) sets the femur:tibia split
  (moves the knee; doesn't change reach).
- **Joints have a REST and a RANGE** (reworked 2026-06-12). Each joint sits
  at its rest angle when relaxed and may travel up to its range limit under
  load — the two are distinct (a knee can rest extended yet flex deeply).
  The **foot is the 3rd joint (ankle)**: `stance` is now its REST pitch, not
  an outcome — the actual stance EMERGES, a body held high (`bodyHeight`
  near 1) rising up onto the tip (unguligrade), a low one settling flat
  (plantigrade). `flexRange`/`ankleRange` cap knee/ankle travel; stiffness
  comes from girth. The grounded pose is a STRAIN-MINIMIZING equilibrium:
  the ankle pitch is the limb's one free DOF and settles where total strain
  is least — the joint springs (toward rest) plus the effort to bear the
  load with a bent knee. A heavy body on STRONG legs straightens them into
  pillars (graviportal/elephant), a light one relaxes into its springy rest
  crouch (cursorial), a heavy body on WEAK legs sags (stand-height cap) —
  three regimes from girth + weight. `legTwist` (long-axis pronation)
  rotates each joint's bend plane down the limb, so a claw curls out →
  forward → in in 3D.
  (NOTE: because high `bodyHeight` now means "on the toes," example
  bodyHeights were re-tuned down where they should stand flat.)
  - A **recruited** (weight-bearing) limb depresses + extends away from
    neutral until its foot reaches the strain-solved contact (2-bone IK);
    the knee arches by `restLevation`, folds the way `restFlexion` signs,
    and the foot now lies in the LIMB'S OWN PLANE — a sprawled leg's foot
    points outward, a tucked leg's forward, never forced to +Z.
  - An **un-recruited** limb just holds its neutral three angles by forward
    kinematics: a dorsal+levated+folded limb is a folded wing; a depressed
    extended one is a hanging arm; a protracted extended one is a crab claw
    held forward; a levated folded one is a mantis forearm.
  - **Load recruitment** (added 2026-06-12) decides which *capable* limbs
    actually bear weight: candidates (mount low, leggy, in reach) are ranked
    by a `recruitCost` read off their neutral aim — a limb reaching forward
    (protraction) and carried high (levation) is a manipulator, costly to
    recruit. Natural standers are always recruited; a manipulator only if
    the body is still under-supported AND its foot pulls the support base
    under the center of mass (a cheap axis-aligned proxy for "CoM inside the
    support polygon"). So a crab's claws stay forward and a mantis's
    forearms stay raised while the other legs hold the body — but strip those
    legs and the manipulators DEPLOY to the ground to keep balance.
  - **Stability sprawl:** stance WIDTH grows with `restLevation` — a levated
    limb plants wide (stable base, knee arches up); a depressed one stands
    narrow under the body.
- **Girth → weight & strength.** Body girth → trunk weight; limb girth →
  support capacity. A heavy trunk on thin legs can't stand as tall — it sags
  toward belly-rest (the `bodyHeight` ceiling drops). Membranous or
  thread-thin limbs can't bear weight at all.
- **Posture drives the body** — `bodyPitch` + `bodyHeight`. Leg length is
  FIXED; `bodyHeight` picks the hip height over the SUPPORT legs' reach
  envelope (dorsal non-support limbs never set the height). The tallest
  support leg leads; the body floors at belly-rest when legs are too short
  (or too weak) to lift it clear. The strain solve is RE-RUN whenever the
  torso target moves — the lab's "animate posture" toggle drives `bodyHeight`
  + `bodyPitch` from a clock and you watch limbs plant/lift live (the seam
  where this morphology starts to blend into the animation layer). The tail
  doesn't hold itself up — it
  drags on the ground if it droops.
- **Head** — the spine's front taper plus a sensory cluster: eye count /
  size / placement, jaw-vs-beak blend (beak = rigid jaw extreme).

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
  body bob + spine sway. **First pass DONE 2026-06-12** (`gait.ts`): the
  gait does NOT re-pose limbs itself — it produces per-leg foot-target
  OFFSETS (stance slides the planted foot back; swing lifts and carries it
  forward) + a body bob, fed into the SAME strain IK that builds the rest
  pose (the rest pose is the gait at zero stride). Patterns (trot/pace/
  bound/wave) fall out of each leg's (side, station) — no per-creature
  tables. STILL OPEN: forward locomotion across the pad (treadmill only so
  far); spine sway; and **whole-body load/balance** — needed to keep the
  CoM over the support polygon, which is what makes dynamic gaits (bipeds,
  running with flight phases) and gait *selection* work rather than the
  hand-picked statically-stable patterns used now.
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
   - **Leg rethink** **DONE 2026-06-12** (per creatures-list.md "Update
     Plan"): collapsed the function/end-effector zoo into ONE leg type;
     role is emergent (membrane→wing, short-reach→arm, digits→hoof/hand/
     claw). Posture split into `bodyPitch` + `bodyHeight`; leg length is
     fixed and the posture engine (tallest-leg-leads) folds/lifts legs to
     match. Digits differentiate like leg rows; feet sized to the limb-tip
     girth. Tail drags. The body-segmentation (tagmata) editor is now in
     the lab. All 17 examples + 39 tests migrated.
   - **Attachment + strain model** **DONE 2026-06-12** (the next step on
     legs): replaced the `kneeLift`/`splay` pose knobs with `attachHeight`
     (socket position around the cross-section) + `attachAngle` (fore/aft
     tilt). A socket swing-cone + a girth-derived strength budget decide,
     per limb, whether a foot can be planted at low strain (it bears
     weight) or must lift and fold (a wing folds up/back along its normal;
     a shoulder arm hangs). Knee elevation/sprawl is now emergent from the
     socket; only `kneeBend` (fore/aft) stays authored. `skeleton.ts`:
     `canSupport`/`solveFoot`, socket normal + cone, lift floored at
     belly-rest.
   - **Stability + weight + torso-driven motion** **DONE 2026-06-12** (the
     follow-ups): (1) `stanceFrac(attachHeight)` gives each socket a natural
     stance WIDTH — flank sockets plant feet wide and the knee arches up
     into the arthropod/reptile sprawl (the above-the-back arch the strain-
     only first test had suppressed); `solveFoot` targets that width.
     (2) `bodyMass` (trunk volume) vs leg `capacity` (Σ girth²) → a gentle
     `heightFactor` so a heavy body on thin legs sags toward belly-rest
     (girth now drives weight AND strength). (3) Grounding gate simplified
     to robust `isLeggy` (membrane < 0.55 + slenderness) + reach, instead of
     a brittle absolute-strain calc that broke thin-legged arthropods.
     (4) Lab "animate posture" toggle drives `bodyHeight`/`bodyPitch` from a
     clock and re-solves the skeleton each frame (`rebuildGeometry`) — limbs
     plant/lift live as the torso moves; the bridge into the animation layer.
     Verified in lab (humanoid now reads right, hexapod arches over its back,
     quadruped clean). Tests 41 (added stance-width + heavy-body-sags). KNOWN
     GAPS: spider still droops (heavy abdomen, camera-dependent); per-limb
     load is independent, not a whole-body distribution.
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
   - **Walk gait (first pass) DONE 2026-06-12**: pure-math `gait.ts`
     (`legPhaseOffset`/`footCycle`/`bodyBob`, patterns trot/pace/bound/
     wave) feeds foot-target offsets into `buildSkeleton(genome, gait?)` —
     reuses the strain IK, no re-pose path. Lab "walk gait" section (toggle
     + pattern + cadence/stride/step-height/duty). Verified: quadruped
     trots, hexapod alternating-tripod waves. Tests 49 (+8 gait).
   - **3-DOF / 3-section limb rebuild DONE 2026-06-12** (crab/mantis prompted
     it): the limb is now a femur/tibia/foot chain posed by `restProtraction`
     / `restLevation` / `restFlexion`, with `attachHeight` demoted to pure
     mount position (removed `attachAngle`/`kneeBend`/`segments`/
     `jointZigzag`). Recruited limbs IK to the ground; un-recruited ones hold
     their neutral angles by FK (wing fold / arm hang / crab-claw forward /
     mantis pray all from the same three numbers). The foot lies in the
     limb's plane (sprawled feet point outward — fixes "feet always +Z").
     All 17 examples re-authored.
   - **Load recruitment + balance (first pass) DONE 2026-06-12**: a capable
     limb bears weight only if NEEDED — candidates ranked by `recruitCost`
     (forward/raised aim = manipulator); natural standers always recruited, a
     manipulator only while the body is under-supported and its foot pulls
     the base under the CoM (axis-aligned support-polygon proxy). Crab claws
     now stay forward and a new Mantis example holds its forearms in a pray
     with NO mount cheat (claws/forearms mount low, recruitment keeps them
     up); strip the walking legs and they deploy. 18 examples; tests 50.
   - **Whole-body / dynamic balance DONE 2026-06-12**: pure-math `balance.ts`
     (convex hull of the planted feet, `supportMargin` = signed CoM-inside-
     hull distance, `balanceShift`). The body now SHIFTS horizontally so its
     CoM rides over the support polygon — a creature leans over its feet when
     the stance is asymmetric (a biped over its two-foot line, a sprawl). A
     fast (low-`dutyFactor`) gait adds a forward lean (momentum), letting the
     CoM ride ahead of the support — the dynamic part. Symmetric quadrupeds
     don't shift (CoM already inside). Tests 59. NEXT: gait selection (pick
     walk/run from speed) + true flight-phase timing; fly + swim/slither;
     forward locomotion; spine sway.
3. **Phylogeny** — founders, species mutation, lab phylogeny browser.
4. **Planet integration** — spawning/streaming (scatter-style stable
   anchors), behavior LOD, population caps. Planned separately when
   phases 1–3 are proven in the lab.
