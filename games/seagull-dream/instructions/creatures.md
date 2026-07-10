# Creature Generator

This will be used to generate and animate a wide variety of creatures from a set of templates, both realistic and fantastical.
Think along the lines of Spore, but more simplified and abstract in style. Stretching and thickening parts of existing models rather than creating an excessive number of individually detailed models will do a lot of heavy lifting here.

Use procedural animation when possible

This system will be used to create plausible alien ecosystems later, with distinct branching families. Think of body plans and "growing" modifications to those body plans, rather than artificially attaching body parts together.

While this specific game will involve procedural generation of branching families, we will also want to be able to use the same system to allow the creation of creatures based on a description.

---

# Plan (agreed 2026-06-10)

Decisions made: creature-lab-first delivery; skinned capsule-loft meshing;
all three locomotion modes (land / air / water) in v1; self-contained
`src/creatures/` module with the pure-math layers kept three.js-free.

## Architecture

Same authority/renderer split as the cloud system: a pure-math layer that
decides WHAT a creature is, and a render layer that builds and animates it.

```
                 ┌─ creatures/blueprint.ts     PURE MATH. The Blueprint TYPE:
                 │                          a plain, JSON-serializable,
BLUEPRINT PRODUCERS │                          documented set of continuous
                 │                          anatomy parameters — plus
seed pipeline ───┤                          validate()/clamp(). This is
(this game)      │                          the stable interchange format.
                 │
description  ────┤  creatures/archetype.ts  PURE MATH. Seed producer:
pipeline (AI,    │                          planet (LifeState, gravity,
later, server-   │                          water, biosphereAgeGyr) →
side)            │                          roots → kind = root
                 │                          + variation deltas.
                 ▼
creatures/skeleton.ts   PURE MATH. Blueprint → bone hierarchy + rest
                        pose + per-bone radius/membrane annotations.
                             │
creatures/mesh.ts       three.js. Skeleton → ONE low-poly skinned
                        capsule loft (+ membranes + rigid details).
creatures/animation.ts  three.js. Gait controllers → bone rotations
                        per frame. Continuous mode blending.
creatures/lab.ts        Creature-lab debug mode (v1 deliverable).
(later) creatures/population.ts   spawning/streaming on planets.
```

### Blueprint as interchange format (description-driven creatures)

Procedural generation is only ONE producer of blueprints. The same renderer
must also accept blueprints authored from a description (an AI emitting
blueprint JSON server-side — the games-bridge pattern), so:

- The Blueprint is a **plain JSON-serializable object** with documented,
  human-meaningful fields and units — no opaque packed vectors, no
  hidden derivation from seed at render time. Seed → blueprint happens
  entirely in the producer; downstream layers never see the seed.
- `blueprint.ts` ships **validate() + clamp()**: any blueprint from any
  source (including a hallucinating LLM) is clamped into renderable,
  animatable ranges and rejected only on structural impossibility.
  Skeleton/mesh/animation may assume a validated blueprint.
- Field names and semantics are chosen to be **describable** ("legPairs",
  "neckLength", "membrane") so a description→blueprint prompt maps
  naturally onto them. When this pipeline is built, consult
  docs/PROMPT_WRITING.md; the lab gets a paste-blueprint-JSON box for
  testing AI-emitted blueprints long before the server pipeline exists.

`physics-system/` is live code (solar-system.ts materializes systems
through it; cloud-field and the readout consume its features). The
creatures module IMPORTS from it (`LifeState`, atmosphere, gravity) but
lives separately so a future folder reorganization stays easy.

## Blueprint — phase transitions, not parts

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
limb strength says walk, body-wave amplitude says swim. The same blueprint
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
   grammar shared with plants. **DONE 2026-07-07** — see "Growths &
   plants" below.
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

## Growths & plants (agreed + built 2026-07-07)

The branching + spiral grammar shared by PLANTS and DERMAL GROWTHS:
a ram horn is a curled unbranched growth on a head, an antler a branched
one, and **a plant is just a creature that has no body except a growth**
(`plantBlueprint()` wraps a growth in a near-invisible 0.1 m grounded nub;
plant height ≈ 0.1 × `stem.lengthFrac`; `skin.baseColor` is the stem
color). Covers trees, grasses, mushrooms, cactuses, bushes, horns.

- **`creatures/growth.ts` — PURE MATH.** `GrowthBlueprint`: continuous
  parametric grammar (no symbolic L-system, no per-level arrays),
  sub-sections each with their own RANGES + nested clamp (the
  spine.profile pattern): attachment (attach head|body, station, phi,
  placement bilateral|radial, count, spread, seed) / stem (lengthFrac,
  girth, taper, lean ±, waviness, flatten 0 round..1 blade-ribbon,
  lobes = cactus ribs, curl + twist, gravitropism, hardness, rootFlare) /
  branching (levels, branchStart, nodes, whorl, phyllotaxis, branchAngle,
  length/radius ratios, jitter) / foliage / flowers (petal-card
  clusters) / fruit (see below). Blueprint carries `growths: GrowthBlueprint[]`
  (validate treats MISSING as valid — older stored blueprints; clamp always
  emits the array).
- **Growth types & fruit bodies (added 2026-07-08).** `GrowthType` =
  `shoot | fruit | root` (shared field templates; sets orientation +
  determinacy): shoot = the tree/shrub/horn above; **fruit** = ONE
  determinate fruit body on a stub pedicel (market items, ground fruit);
  **root** = a downward storage body with a leafy top (carrot/beet). The
  botanical unification: **stem, root, and fruit are one profiled axis** —
  a fruit renders through the SAME `loftGrowthRun` as a stem. `GrowthFruit`
  is now a fruit BODY: `sizeM` (ABSOLUTE equatorial diameter in meters —
  decoupled from stem length, so a big fruit on a stub stem works and
  market items carry a real size), `aspect`, a radius profile (`bulge`
  station, `neck` = base taper, `tipTaper` = tip point → pear/strawberry),
  `curvature` (banana — transported frame, like a stem's curl), `lobes`
  (pumpkin ribs), `stemFrac` hang dial, `crownLeaves` (pineapple crown)
  / `calyxLeaves` (strawberry hull / a root's leafy top) — pole leaves
  reuse the leaf-card primitive. A **mushroom cap = a terminal oblate
  fruit** — no cap enum. Structure emits `fruits: { rings, axis, lobes }[]`
  (a ring list, not a point); the mesh lofts it + rounds both poles with a
  SHALLOW dome (`FRUIT_POLE_ROUND`, so aspect reads true) and uses
  lobe-aware side counts (else ribs alias). `buildFruitMesh(fruitBlueprint)`
  renders one standalone (the market-item path). `towardDown()` gives the
  hang direction (angular, never degenerate at stemFrac ≈ 0.5). The lab
  shows a translucent soil disc when a `root` growth is present.
- **Spirals** integrate a **transported frame** (curl bends around the
  binormal, twist rolls the normal around the dir): ram = curl only
  (planar coil), kudu = curl+twist (helix), cow ≈ straight. The fixed-
  curlAxis approach used by flexible chains cannot make helixes.
- **Determinism + the LOD trick.** Every jitter is
  `hash(seed, nodePath, channel)` (scatter.ts hashCell pattern), NEVER a
  sequential RNG stream; expansion is a priority queue (level asc,
  radius desc, path asc) stopping at a segment budget. So
  `generateGrowth(g, N).segments` is a **structural prefix** of any
  larger budget — LOD tiers of one kind are literal truncations of
  each other, bit-identical where they overlap. Budget is per-blueprint
  (MAX_GROWTH_SEGMENTS = 240 shared across growths & instances),
  enforced at generation, NOT in clamp. Leaves clothe the outer TWO
  levels (deep trees rarely fit their terminal level in budget).
- **skeleton.ts pass 8.5**: growths are **rigid geometry welded to ONE
  bone** (head or torso station) — NO new bones; horns ride the head.
  One cached structure per blueprint entry (the lab rebuilds every animated
  frame); instances are basis transforms — the bilateral L copy uses a
  REFLECTED basis, flipping spiral chirality so paired horns mirror.
  Growth extents fold into `skel.bounds` (a 9 m oak on a 0.1 m nub must
  frame the camera).
- **mesh.ts**: own ring emitter (per-level sides 6/5/4/3, root rings
  sunk into the parent, `lobes` scalloping); `flatten ≥ 0.7` emits
  two-sided RIBBONS (grass blades) instead of tubes; leaves/petals =
  double-faced diamond cards (separate verts per face); fruits =
  ellipsoids. Stem color = base→accent by hardness (the beak rule).
  `buildFruitMesh()` emits one fruit as a standalone static item.
- **`creatures/plant-lod.ts` — the distant-plants answer.** Plants are
  STATIC (bind == rest), so a kind is a non-skinned BufferGeometry to
  be instanced per chunk (scatter.ts pattern): **LOD0** full budget +
  leaf cards; **LOD1** budget-60 prefix with leaves replaced by canopy
  BLOB ellipsoids (voxel-clustered from the full canopy); **LOD2** a
  crossed-plane impostor whose texture is baked ONCE per kind from
  the LOD1 mesh — UNLIT MeshBasicMaterial + vertexColors bake (live
  lighting comes from the scatter material; baking light would
  double-light), NoToneMapping during bake, clear = foliage color at
  alpha 0 (no dark fringes), single view on all 3 planes (3-view atlas
  deferred). Impostor planes are emitted twice with opposed winding
  (NOT DoubleSide — the lit backface normal flip blacks them out).
  Geometries carry a per-vertex `sway` attribute (height², written at
  build) so the wind vertex shader is data-ready. Lab: "LOD preview"
  select (off / lod1 / impostor) in the growths section.
- **Fruit-body LOD (added 2026-07-08).** The tree-shaped LOD (cut segments,
  blob leaves) ignored fruit BODIES — every fruit/vegetable/market item was
  meshed at full detail in every tier, and for a fruit/root SAMPLE LOD1 ==
  LOD0. Now `emitFruitProfile(..., detail)` is the fruit LOD dial:
  `detail<0.75` drops the ribs (`lobes`) and thins sides, `<0.6` subsamples
  the body rings (keeping endpoints) + flattens the pole domes — a coarse
  fruit is a smooth few-ring blob, same silhouette, ~⅓ the geometry.
  `buildCreatureMesh(opts.fruitDetail)` / `buildFruitMesh(fruit, scale,
  detail)` thread it; `buildStaticGeometry` sets it per tier
  (`PLANT_LOD_FRUIT_DETAIL` 1 / 0.4). Two blob bugs fixed at the same time:
  the canopy-blob merge used `toNonIndexed()` (tripled verts → LOD1 came out
  BIGGER than LOD0); it's now an INDEXED merge. And blobbing now only fires
  on DENSE foliage (`CANOPY_BLOB_MIN_LEAVES` ~30) so a fruit's few crown/
  calyx leaves stay crisp cards (a pineapple crown was being blobbed). After:
  every LOD1 verts+tris ≤ LOD0 (pumpkin 346→107, bush 13626→2383 verts).
- Examples: Ram / Deer (near-planar antler phyllotaxis) / Cow; Oak /
  Grass tuft (blades = flattened level-1 branches) / Mushroom / Saguaro
  (lobes + gravitropism arms + tip flowers) / Berry bush. Tests in
  `server/tests/seagull-growth.test.ts` (25): clamp round-trips,
  determinism, budget-prefix, spiral planarity, mirroring, bounds.
- **DEFERRED**: planet scatter integration (per-chunk InstancedMesh +
  baked impostors replacing the hand-drawn makeTreeTexture); wind sway
  shader (attribute already written); fruit pickup via the animator
  (buildFruitMesh output is crate-shaped for the limbTip flow); 3-view
  impostor atlas; root spokes (rootFlare buttress only).

## Archetypes — plausible alien ecosystems

Per life-bearing planet, an archetype seed generates a handful of
**root** body plans (count and derivedness scale with
`biosphereAgeGyr` and habitability). **Kinds** are roots plus
accumulated variation deltas, assigned to biome bands (same biome logic
scatter.ts uses for trees). Children derive from parent blueprints with small
variations, so a planet's fauna shares family resemblance — distinct
branching families for free. `LifeStage` gates everything: only
`complex`+ planets get visible creatures.

## Mesh — skinned capsule loft

Build-time: walk the skeleton, place low-poly rings (6–10 sides) along
each chain using the radius profile, stitch into ONE continuous skin,
weight each vertex to 1–2 bones. Membrane params fan skin between
chains for wings/fins. Rigid details (beak, eyes, horns) are tiny
meshes merged into the same geometry with single-bone weights.

- One draw call and ~300–600 verts per creature; GPU skinning.
- Built once per kind, cloned per individual (scale/color variation).
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
  wavelength, frequency from blueprint); the identical mechanism does
  snakes/worms on land.
- **Idle** — breathing (radius pulse), head look-at, weight shifts.

Environment decides the blend (depth, altitude, slope); morphology
decides the parameters; nothing pops between modes.

## Creature Lab (v1 deliverable)

A debug mode reachable from the debug menu: flat test pad, one creature.

- Seed field + re-roll; full blueprint slider set; environment toggles
  (gravity, air density, water level) to exercise gait blending.
- Gait playback: a movable target the creature walks/flies/swims to.
- Archetype browser later: pick planet seed → list kind → inspect.
- ALL tuneables go in config.ts + the debug menu, per main.md.

## Performance budget

- Steady state near fauna: ≤ ~30 animated creatures, 1 draw call each.
- Behavior LOD: far = culled, mid = cheap wander (no IK), near = full.
- CPU per frame: bone quats only (a few dozen per near creature); IK
  raycasts share the terrain `heightAt` sampler.
- Build cost amortized: kind meshes generated lazily, never in the
  same frame as a fade-in.

## Phasing

1. **Blueprint + skeleton + loft + lab viewer** — static rest pose,
   sliders, seed, paste-blueprint-JSON box. Node tests for blueprint/skeleton
   determinism + validate()/clamp() round-trips
   (precedent: `server/tests/seagull-weather-map.test.ts`).
   **DONE 2026-06-10** — `src/creatures/{blueprint,skeleton,mesh,lab}.ts`,
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
   - Flexible chains **DONE 2026-06-11**: `blueprint.chains: FlexChainBlueprint[]`
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
     `appendages` merged into ONE `limbGroups: LimbGroupBlueprint[]`,
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
   - Midline membranes **DONE 2026-06-11**: `blueprint.membranes:
     MembraneBlueprint[]` — ONE primitive for the dorsal fin, anal fin,
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
     wave) feeds foot-target offsets into `buildSkeleton(blueprint, gait?)` —
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
     don't shift (CoM already inside). Tests 59.
   - **Gait selection + animator + pick-up/put-down DONE 2026-07-07**
     (prompted by the human rework — see below):
     - `gait.ts locomotionGait(speed01, legLenM)`: ONE speed dial picks
       every cycle parameter on a continuum — walk (duty > 0.5, short
       strides) → run (duty < 0.5 = flight phases, long strides, high lift);
       cadence follows leg length (pendulum scaling). `bodyBob` bounces
       harder as duty drops (the ballistic hop).
     - `skeleton.ts PoseOverrides` — the animation layer's handle: (1)
       `limbTargets` steers an UN-RECRUITED limb's tip to an explicit IK
       target (2-bone IK along the reach line, elbow-down↔elbow-back pole
       blend, digits curl by `grip`); (2) `armSwing` pendulum-pitches
       hanging (depressed, leggy, bilateral) limbs at the leg phase their
       (station, side) would get — a biped's counter-swinging arms fall out
       of the same pattern machinery as the feet. Plus `limbChainName` /
       `limbTip` helpers for locating a limb's bones from outside.
     - NEW `animation.ts CreatureAnimator` (pure math): emits per-frame
       INPUTS (gait, posture, pose overrides) that buildSkeleton consumes —
       it never poses bones itself. Speed dial with easing; idle sway when
       standing; run lean (bodyPitch). Actions: reach → grasp → lift →
       carry → lower → release → return, driven by a hand IK target plus a
       posture crouch; a `pickUp` CROUCH runs on FEEDBACK — the caller
       builds the skeleton and calls `observe(skel)`, and while the hand
       isn't closing on the object the controller keeps crouching (and
       bends the trunk forward, scaled by how erect the creature stands) —
       no closed-form reachability math to drift out of sync with the
       strain solver. The hand group = bilateral non-membranous limbs with
       `opposition ≥ 0.3` ("has a thumb"); carrying composes with walking.
     - Lab: "animator" section (enable, speed slider, pick up / put down of
       a crate prop, object rides the hand via `limbTip`), plus
       `window.__creatureLab` hooks (loadExample / orbit / setGait / anim)
       for `shot-creature.cjs`, a puppeteer capture script → caps-creatures/.
     - Skeleton fixes found on the way: head details + body-attached chains
       now shift by the FULL bodyShift (bob + balance lean), not just the
       lift — eyes used to detach mid-gait; the FACE direction is separate
       from the head bulb's loft axis (face levels hard toward horizontal,
       capped; bulb only halfway) with eyes placed in the face's local
       frame — an erect biped keeps an upright head with eyes on its front
       surface; `posture.bodyPitch` range extended to 1.5 (erect humans).
     - Human example re-authored (erect pitch 1.5, near-straight legs
       0.92, real limb girth, forward-folding knees, crossSection 1.5
       torso, arms lengthFrac 1.0 with opposed hands). Tests 73.
   - **Gait polish + two-handed carry DONE 2026-07-07** (feedback round):
     - Planted-foot azimuth is now solved entirely in the UNSHIFTED rest
       frame (rest plant vs unshifted hip) — mixing the balance-shifted hip
       with the unshifted plant twisted feet outward at each stride start.
     - Balance uses the REST support polygon (every recruited foot at its
       rest plant), deliberately ignoring instantaneous stance/swing:
       re-centering on whichever feet happened to be planted lurched the
       body fore/aft + sideways every step. A walker carries transient
       imbalance with momentum; the dynamic part is the constant duty-
       scaled forward lean.
     - `pickUp(target, sizeM)` picks one OR two hands: one hand needs an
       opposable digit (`pickHandGroup`); TWO hands need none — the palms
       bracket the object from opposite sides and act as the pincer
       (`pickArmGroup`: a bilateral non-membranous pair clearly shorter
       than the longest such group = free arms). Any kind goes
       two-handed past ~1.5 palm-widths; thumbless kind always do.
       Grip targets offset ±size/2 along the perpendicular of the
       body→object line; lift/lower durations stretch with bulk; the lab
       gets an object-size slider and draws the crate between the palms.
       Tests 78.
   - **Head system: one loft + one frame + one joint DONE 2026-07-08**
     The head stopped being sphere + beak-cone + eye-dots. Rules:
     - ONE LOFT: skull bulb ellipsoid (`sizeFrac` × `lengthFrac`
       elongation × `crossSection` width:height) flowing into a snout of
       two loft bones (chain "snout": `beakLengthFrac`, `snoutFlatten`
       cross-section, `snoutCurve` hook/upturn). `beak` hardness picks
       the material (skin→accent keratin) and how sharply it tapers to
       the tip. The beak RigidDetail is gone (stinger-tip cones remain).
     - ONE FRAME: the face axis levels hard toward the horizon (erect
       bipeds keep faces forward) but blends back to the bulb's loft
       axis as the skull elongates — a crocodile's snout IS its head
       axis. Eyes place spherically in this frame (`eyeAngle` azimuth,
       `eyeHeight` elevation, extra pairs stack up), seat on the
       ellipsoid surface, and `eyeBulge` slides them flush→proud.
     - ONE JOINT: `jawFrac` grows a mandible (chain "jaw") hinged at its
       base; `PoseOverrides.gape` (0..1) is an ANIMATION input like grip,
       never blueprint. Ears/horns/crests/antennae are NOT head fields —
       they stay chains + growths attached to the head.
     - MOUTH PICKUP: a kind with no thumbs and no free arms but a jaw
       (raptor, crocodile) grasps with its mouth — `pickUp` falls back to
       the beak: the crouch feedback pitches the trunk nose-down PAST
       horizontal (a bird pecking over its feet; hands only need ~0.3 of
       that lean because they hang below the shoulders), the jaw gapes
       wide → clamps, the object rides the "snout" tip (`handChains:
       ["snout"]`). Positioning the BODY near the object stays the host's
       job (locomotion) — the lab stands in by placing the crate on the
       midline under the beak's dive arc. Tests 87; croc example added.
   - **Face cluster + the human head DONE 2026-07-08** (feedback round —
     "human heads are extreme: big cranium, face ⟂ body, receded jaw
     with protruding nose + chin"). Three GENERAL dials, no special
     cases, and two rule fixes:
     - Face leveling rule simplified: a round skull holds its face
       EXACTLY at the horizon (the old 0.45 rad cap left erect bipeds
       gazing 26° skyward); elongated skulls still blend to the loft
       axis. `facePitch` is deliberate carriage on top (vulture
       down-face, stargazer up-face) — the human's perpendicular face
       is the rule's 0 default, not a setting.
     - `faceHeight` slides the whole face CLUSTER (snout root, jaw
       root, eye reference) up/down the skull's front surface as one
       latitude. Low face → the dome above reads as cranium (human,
       owl); high → crocodile-nostril territory. Eyes' `eyeHeight` is
       relative to the cluster so the set moves together.
     - `snoutRadiusFrac` frees muzzle girth from `beak` hardness
       (was hard-derived 0.5−0.25·beak): bulldog 0.6, heron 0.3, human
       nose 0.14. A nose IS a thin short soft snout rooted low; a chin
       is a short receded jaw (its girth floors at 0.18·headR so a
       mandible stays visible under a needle nose).
     - Mesh fixes: the crown cap closes exactly at the head bone tail
       (radius-scaled extension coned the crown of erect creatures);
       snouts root ON the surface (0.92) instead of buried (0.7) so
       thin noses keep their length — all muzzles read ~0.2·headR
       longer, beakLengthFrac is truer to visible length.
     - `__creatureLab.frameHead(distMult)` + `shot-head.cjs` capture
       head close-ups for face iteration. Tests 91.
   - **Head v2: ONE structure, real mouth seam DONE 2026-07-08**
     (feedback round — the jaw poked THROUGH the skull sphere; neck lift
     / head length / face pitch interacted; horse face was intractable).
     The head is no longer a sphere with a snout + jaw stabbed into it —
     it is ONE continuous loft (cranium → muzzle → tip, colinear along
     the face axis) and the MOUTH is a SEAM in that surface:
     - `skeleton.ts` emits a `MouthSpec` (hinge, axis, faceUp, cut,
       gapeAngle, jawBone). `mesh.ts` lofts head+snout as one tube and,
       for rings forward of the hinge, splits each ring at the mouth
       line (`cut`) and swings the LOWER arc open about the hinge by
       `gapeAngle` (loftChain's `mouth` hook). At gape 0 the arcs
       coincide → a closed mouth is an INVISIBLE seam, so morphing a
       blueprint never slides a fake line. The jaw bone stays as the
       hinge/bind/grab reference but is NOT lofted separately.
     - DIALS NOW INDEPENDENT: the head holds the HORIZON and `facePitch`
       tips it (world-referenced, `faceAxis = (0,sin,cos)`); it does NOT
       follow the neck (a human/horse/giraffe carry a level head off a
       raised neck). Neck lift ONLY sets headBase (position). `lengthFrac`
       is the pure longitudinal scale. No more headElev/elongBlend
       cross-coupling — this is what fixed the horse.
     - NEW BLUEPRINT DIALS: `snoutSegments` (N muzzle bones — a long one
       bends smoothly = the elephant trunk, now the snout, NOT a growth
       chain; beakLengthFrac range raised to 5), `muzzleSquash` (0 point
       → 1 flat blunt wall: pug / human / cow pad), `snoutRadiusFrac`
       (muzzle girth, freed from beak hardness earlier). `faceHeight` now
       only sets the EYE latitude (was also moving the snout root).
     - Removed the beak RigidDetail + separate snout/jaw lofts entirely.
       `__creatureLab.setGape(v)` + `shot-head.cjs @file.json#i gape`
       capture open mouths. Human/horse/dog/croc/raptor/elephant all
       re-verified; Elephant example is now a segmented-snout trunk.
       Tests 94.
   - **Head v3: nose / mouth-opening / jawline are THREE things DONE
     2026-07-08** (feedback round — v2's "mouth" was the whole lower jaw
     stretching with no real opening, the nose was stuck to the muzzle
     tip so the elephant read as a beak and the human nose couldn't
     protrude, and eyes sank inside the head). Decoupled into three
     independent systems:
     - MUZZLE / jaws (the jawline SHAPE): beakLengthFrac, snoutRadiusFrac,
       muzzleSquash, snoutFlatten, snoutCurve, snoutSegments. Unchanged.
     - MOUTH OPENING = a bounded COMMISSURE, separate from the jawline:
       `mouthOpen` (0..1) slides the hinge between the muzzle tip and the
       jaw joint. Only the front `mouthOpen` fraction parts; behind it the
       jaw stays fused (the cheek). So a horse (long jaw, small mouthOpen)
       gets a tiny front mouth, a croc (mouthOpen 1) opens the whole jaw.
       Replaces jawFrac. Fixes the "whole jaw stretches" bug.
     - NOSE = its OWN positioned protrusion (chain "nose", lofted like a
       small limb): `noseLengthFrac` (bump → elephant trunk), `noseRadius
       Frac`, `nosePosition` (0 base near eyes → 1 muzzle tip), `noseHeight`
       (0 front face → 1 crown/blowhole), `noseSegments`, `noseDroop`.
       Dog = tip, human = base-protruding, elephant = long droop, whale =
       top. Elephant example is now a short jaw + long nose (not a snout).
     - EYES re-seated on the ACTUAL loft cross-section (headSurf's ellipsoid
       pinched to a point at the front and buried them): pick the axial
       slice from the eye's forward-ness, push out by the local radius;
       eyeBulge 0 = flush/showing. `muzzleSquash` also now blunts the
       CRANIUM front (frontK) so a flat human/ape face isn't a pinched egg.
     - LESSON: verify heads in WIREFRAME (`WIRE=1 node shot-head.cjs`,
       `__creatureLab.setWireframe`) — solid shots hid that eyes were
       buried and the "mouth" was cosmetic. Tests 96.
     NEXT: forward locomotion across the pad (still treadmill); fly +
     swim/slither; spine sway; heavy-load posture (lean-back carry);
     ANIMATE the long nose as a tentacle (trunk sway — segments exist, the
     bend animation doesn't yet); a mouth INTERIOR/floor so a wide gape
     isn't see-through; a static mouth-LINE crease/color so a closed mouth
     reads; thicker elephant trunk (reads anteater-thin); mouth-carry
     object offset by size/2 along the snout axis.
   - **Head v4: rebuilt as a SKULL (braincase + rostrum + mandible) on the
     doc's axes DONE 2026-07-08** (design source: `instructions/
     creatures-heads.md` — a 27-slider vertebrate-head model; we adopted
     its skull layer now, soft tissue next, appendages later). v3's face
     was still one egg; the axes were reorganized into a real skull so the
     coming soft-tissue layer has something to sit on. STEP 1 of a 2-step
     plan (skull now → continuous tissue field next).
     - BRAINCASE = a capsule holding the horizon; neck lift only POSITIONS
       it. `lengthFrac` = its length, NEW `braincaseDome` (#4) = its height
       (0.5 flat croc roof ↔ 1.4 human dome). `crossSection` redefined as a
       WIDTH multiplier (#10), composing with dome/depth instead of fighting.
     - ROSTRUM = a wedge rooted at the braincase FRONT, hinged off it by
       `facePitch` (#8, now rostrum-vs-braincase, NOT whole-head) — a
       raptor's hook / grazer's droop no longer drags the cranium. Reuses
       beakLengthFrac (#1 length), muzzleSquash (#2 taper), snoutFlatten
       (#3 depth), snoutCurve (#9 dorsal profile), snoutRadiusFrac.
     - MANDIBLE: NEW `jawDepth` (#11 robustness, slender ↔ massive) +
       `jawOffset` (#12 under/overbite). Mouth commissure unchanged
       (`mouthOpen` #7) plus NEW `mouthVertical` (#14) sliding the mouth
       line down (subterminal shark) / up (superior).
     - ORBITS seated on the BRAINCASE ELLIPSOID analytically (half-axes =
       real skull dims) via eyeAngle (#6 convergence) + faceHeight/eyeHeight
       (#13 elevation) + eyeSizeFrac (#5) + eyeBulge — no more frontK hack,
       eyes never sink into a long snout. `skel.head` now carries a
       LANDMARK set + frame (center/rostrumBase/rostrumTip/crown/chin +
       axes) for the soft-tissue layer to anchor to.
     - NOSE stays the v3 appendage chain (deferred), re-anchored to the
       braincase axis so elephant/human don't regress.
     - VERIFIED IN WIREFRAME: croc = flat skull + periscope eyes on the
       crown; horse = long deep muzzle + lateral surface eye (the user's
       hardest case, now reads); human = domed cranium + separate nose +
       surface eye (boxy at 3/4 — the low-poly facet + no eyelid; the
       soft-tissue step fixes both). Tests 102 (added dome / jaw / mouth-
       vertical / decoupled-pitch / convergence / landmark cases).
   - **Head v5: cranium + lower-front rostrum + hinged mandible DONE
     2026-07-08** (feedback: v4 was still "a sphere with parts on the
     front"; skull-diagram.png shows the real anatomy). Three pieces:
     - CRANIUM: the ONLY spherical part — a stretchable DOME (upper-rear),
       lofted as a rounded ball closing the axial loft. `lengthFrac`
       stretches it back, `braincaseDome` up, `crossSection` wide.
     - ROSTRUM: a SEPARATE loft rooting at the cranium's LOWER-FRONT
       (`craniumFront − faceUp·domeHalf·0.4`), projecting forward, curving
       (`snoutCurve` = dorsal profile) with an extra DROP at the tip
       (premaxilla). `facePitch` tilts the whole muzzle off the cranium.
     - MANDIBLE: a SEPARATE hinged BLOCK loft (chain "jaw") that HUGS the
       rostrum's underside (the bite line) — each point dropped by its own
       half-height so the TOP rides the bite → a closed mouth is a thin
       line even on a curved/deep snout; `jawDepth` hangs it lower; a back
       RAMUS reaches the hinge under the cranium; gape swings the whole
       block (baked per frame in the skeleton — the mesh just lofts it, the
       old ring-seam hook is gone). `mouthOpen` now scales HOW WIDE it
       swings (horse barely, croc fully), not a commissure. `mouthVertical`
       raises/lowers the bite line, `jawOffset` the bite fore/aft.
     - The two convex tubes touch along a line, leaving a V-void on the
       sides; the mandible is SEATED up ~0.35·halfHeight into the rostrum
       (`seat`) so they interpenetrate and the void is hidden.
     - WIREFRAME + coord-DUMP verified (`__creatureLab.skeleton()`): horse
       (long deep muzzle, dropped tip, jaw closes to a mouth line) and dog
       read as real skulls; human = tall dome + minimal rostrum + jaw + nose
       (extreme, user hand-tunes). Tests 102.
   - **Head STEP 2: soft-tissue layer + toggle DONE 2026-07-08.** A
     continuous flesh layer over the v5 skull that rounds it out so it stops
     reading as a skull. HeadBlueprint dials (0 = bare bone): `padding` (even
     inflation), `cheek` (masseter/side), `jowl` (under the jaw), `brow`
     (over the eyes), `muzzlePad` (fills the cranium→muzzle STOP so the face
     flows in), `lips` (mouth line). Implemented in `mesh.ts` as an outward
     per-vertex displacement of the CRANIUM/ROSTRUM/MANDIBLE loft verts
     (`RingSpec.tissue` → `loftChain` hook): `pad·radius` + Gaussian
     `bulges` anchored to `skel.head` landmarks. Eyes are pushed out by
     `tissuePushAt()` so padding doesn't bury them. TOGGLE: mesh
     `opts.bareSkull` + `__creatureLab.setTissue(on)` (and `BARE=1 node
     shot-head.cjs`) to work on the bone. Default examples now flesh via
     clamp defaults. Tests 102.
   - **KEEP IN MIND (next skull pass, user-flagged):** the CRANIUM should be
     rounder + further BACK — v5's was a forward wedge tapering to a point
     at the neck. Partially fixed (back-weighted egg profile, `headRings`
     6, rostrum roots on the lower-front surface with a slope to the snout),
     but the NECK→CRANIUM junction still needs its own pass (a thin neck
     into a spherical occiput, not a blend). The cranium→snout SLOPE matters.
     NEXT: that neck/cranium pass, cleaner mouth mating (flatten bite
     surfaces / lips vs the interpenetration trick), THEN appendages (ears,
     nostril, dewlap).
   - **Head v6: sphere cranium + red-dot forehead + split-muzzle mouth DONE
     2026-07-08.** Rebuilt per `skull-diagram.png` (Cow/Lizard/Bird/Human) as
     SIMPLE shapes: (1) CRANIUM = just a ball (ellipsoid, mesh profile
     `sqrt(max(1-((s-0.5)/0.54)²,0.16))` rounds BOTH poles — the wedge-point is
     gone). (2) A "RED DOT" snout root on the lower-front, placed by NEW dials
     `foreheadHeight` (low=tall forehead/human, high=flat/croc), `foreheadLength`
     (forward reach), `foreheadSlope` (convex/concave, via tissue). (3) SNOUT =
     a rounded muzzle tube with its top on the red dot; the MOUTH is a SPLIT of
     that tube (loftChain `ring.mouth` swings the arc below `cut` about the jaw
     joint), with a dark double-sided MEMBRANE lining the open cavity — replaced
     a hard-clip attempt that rendered flat dark palate/floor slabs. (4) RAMUS
     tube links the jaw to the cranium base (never floats); cheeks fill it.
     `nosePosition` REMOVED — the nose is stuck on the snout tip. Verified
     dog/croc/human/horse (fleshed + bare). Rough edges: jawOffset inert in the
     split model; human crown egg-pointy at extreme dome; open lower jaw a touch
     boxy. Still pending: NECK→cranium junction, lip/bite polish, appendages.
3. **Archetypes** — roots, kind variation, lab archetype browser.
4. **Planet integration** — spawning/streaming (scatter-style stable
   anchors), behavior LOD, population caps. Planned separately when
   phases 1–3 are proven in the lab.
