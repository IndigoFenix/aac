// Curated showcase blueprints for the creature lab. Each exercises parts of
// the body-plan constructor (instructions/creatures.md) and doubles as a
// worked example of the blueprint interchange format. They are intentionally
// partial — loaded through clampBlueprint, which fills every unset field —
// so they read as "just the parts that matter for this creature".
//
// Note the unified limb model: there is no function/end-effector. A wing
// is a membranous leg; an arm is a shorter forelimb that can't reach the
// ground at the body's `bodyHeight` and so lifts off and hangs; a hoof is
// one digit, a hand is digits with `opposition`, a claw is a curled pair.
//
// PURE DATA, no three.js. The lab offers these in a dropdown.
//
// Plants live here too: a plant is a creature that has no body except a
// growth (plantBlueprint wraps a growth in a near-invisible grounded nub).
//
// ONE LIST, NOT TWO (2026-08-30). This file and the species registry
// (species.ts) used to be parallel catalogues kept in step by hand: a row named
// its example by DISPLAY TITLE ("Crocodile (long jaw)"), so a body could sit
// here fully authored while the word a child already had stayed a stub, and
// nothing said so. Every entry now carries the SPECIES `id` it backs, the
// registry resolves blueprints by that id, and the invariant runs both ways —
// a species row whose id names no example is a stub, and an example whose id
// names no species row is a hard error at module load (species.ts). Adding a
// creature is ONE entry here plus ONE row there; neither can drift alone.

import { plantBlueprint } from "./blueprint";

export interface CreatureExample {
  /** THE SPECIES ID this blueprint backs (species.ts `CATALOGUE`). The join
   *  key — not decoration: `speciesBlueprint("crocodile")` finds its body by
   *  matching this, and a value naming no registry row fails the load. */
  id: string;
  /** The human-readable label the creature lab shows in its dropdown
   *  ("Crocodile (long jaw)"). A TITLE, never a word a sentence can carry —
   *  the child-facing word is the species row's `words`. */
  title: string;
  blueprint: Record<string, unknown>;
}

const plant = (
  growth: Parameters<typeof plantBlueprint>[0],
  opts?: Parameters<typeof plantBlueprint>[1],
): Record<string, unknown> => plantBlueprint(growth, opts) as unknown as Record<string, unknown>;

export const CREATURE_EXAMPLES: CreatureExample[] = [
  {
    id: "quadruped",
    title: "Quadruped (default)",
    blueprint: {
      version: 1,
      // 🐾 GENERIC MID-SIZE MAMMAL, 40 kg (a goat / a small deer / a big dog —
      // the neutral quadruped the lab opens with). Spelled out here rather
      // than inherited from `defaultBlueprint()`, which stays untouched: it is
      // the source of every OMITTED field on every other body, so re-sizing it
      // would silently re-size the whole registry.
      // 1.2 → 0.7 m trunk, girth 0.18 → 0.1678, legs 0.1584/0.18 →
      // 0.492/0.559. Reads 40.1 kg, σ 0.60, ema 2.38, r/line 1.00.
      spine: { torsoLengthM: 0.7, girth: 0.1678 },
      // Spelled out rather than inherited: `defaultBlueprint()` still carries
      // ONE leg group (it doubles as the per-field default source), and one
      // group cannot fold a fore and a hind knee opposite ways.
      limbGroups: [
        // FORE — elbow folds BACK. lengthFrac/radiusFrac carry the 0.88 the
        // default's size gravitation used to apply to the front copy.
        { placement: "bilateral", count: 1, stationStart: 0.18, stationEnd: 0.18, sizeContrast: 0, lengthFrac: 0.5104, radiusFrac: 0.492, restFlexion: -0.3, taper: 0.55, membrane: 0, attachHeight: 0.38, restProtraction: 0, restLevation: -0.45, flexRange: 1, legTwist: 0, legBalance: 0, footLengthFrac: 0.22, stance: 0.4, ankleRange: 1, toeCount: 3, toeLengthFrac: 0.5, toeSpread: 0.5, toeContrast: 0.2, opposition: 0, toeCurl: 0.1 },
        // HIND — knee folds FORWARD.
        { placement: "bilateral", count: 1, stationStart: 0.85, stationEnd: 0.85, sizeContrast: 0, lengthFrac: 0.58, radiusFrac: 0.559, restFlexion: 0.3, taper: 0.55, membrane: 0, attachHeight: 0.38, restProtraction: 0, restLevation: -0.45, flexRange: 1, legTwist: 0, legBalance: 0, footLengthFrac: 0.22, stance: 0.4, ankleRange: 1, toeCount: 3, toeLengthFrac: 0.5, toeSpread: 0.5, toeContrast: 0.2, opposition: 0, toeCurl: 0.1 },
      ],
    },
  },
  {
    id: "snake",
    title: "Snake (limbless)",
    blueprint: {
      version: 1,
      // 🌊 NO STANDING LEGS, SO NO LEG LEDGER — rescaled to real dimensions
      // only. These bodies were never in the impossible state the standers
      // were; they were just enormous.
      // 🐍 A ~1.5 m colubrid: 1.2 m of trunk plus 1.6× that in tail.
      spine: { torsoLengthM: 1.2, girth: 0.05, girthPeak: 0.3, torsoSegments: 11, frontTaper: 0.5, rearTaper: 0.4 },
      neck: { segments: 2, lengthFrac: 0.2, radiusFrac: 0.7, lift: 0.2 },
      tail: { segments: 9, lengthFrac: 1.6, radiusFrac: 0.6, droop: 0.4 },
      head: { sizeFrac: 0.5, beak: 0.15, snoutLengthFrac: 0.4, eyePairs: 1, eyeSizeFrac: 0.18, eyeAngle: 0.9 },
      limbGroups: [],
    },
  },
  {
    id: "fish",
    title: "Fish (fins + tail)",
    blueprint: {
      version: 1,
      // 🌊 NO STANDING LEGS, SO NO LEG LEDGER — rescaled to real dimensions
      // only. These bodies were never in the impossible state the standers
      // were; they were just enormous.
      // 🐟 A 30 cm pan fish (0.25 m body + tail fin).
      spine: { crossSection: 0.5, girth: 0.2, girthPeak: 0.5, torsoLengthM: 0.25 },
      neck: { segments: 0 },
      tail: { segments: 5, lengthFrac: 0.7, radiusFrac: 0.45, droop: 0 },
      head: { sizeFrac: 0.5, beak: 0.1, snoutLengthFrac: 0.25, eyePairs: 1, eyeSizeFrac: 0.2 },
      posture: { bodyHeight: 0.15 },
      // Pectoral fins: short, splayed, membranous legs.
      limbGroups: [
        { placement: "bilateral", count: 1, stationStart: 0.35, stationEnd: 0.35, membrane: 0.85, lengthFrac: 0.35, radiusFrac: 0.08, attachHeight: 0.5, restProtraction: 0, restLevation: 0.15, restFlexion: 0, footLengthFrac: 0, toeCount: 1 },
      ],
      membranes: [
        { edge: "dorsal", start: 0.4, end: 0.72, height: 0.28, heightPeak: 0.6, rays: 6 },
        { edge: "ventral", start: 0.34, end: 0.5, height: 0.16, heightPeak: 0.5, rays: 4 },
        { edge: "dorsal", start: 0.0, end: 0.16, height: 0.32, heightPeak: 0.3, rays: 6 },
        { edge: "ventral", start: 0.0, end: 0.16, height: 0.32, heightPeak: 0.3, rays: 6 },
      ],
    },
  },
  {
    id: "stingray",
    title: "Stingray (flat + stinger)",
    blueprint: {
      version: 1,
      // 🌊 NO STANDING LEGS, SO NO LEG LEDGER — rescaled to real dimensions
      // only. These bodies were never in the impossible state the standers
      // were; they were just enormous.
      // 🥏 A small ray: 60 cm disc, whip tail 1.7× that.
      spine: { crossSection: 2.6, girth: 0.26, girthPeak: 0.4, torsoLengthM: 0.6, frontTaper: 0.5, rearTaper: 0.7 },
      neck: { segments: 0 },
      tail: { segments: 6, lengthFrac: 1.7, radiusFrac: 0.2, droop: 0.05 },
      head: { sizeFrac: 0.4, beak: 0.1, snoutLengthFrac: 0.3, eyePairs: 1 },
      limbGroups: [],
      chains: [
        { attach: "body", station: 0.95, count: 1, radial: false, segments: 4, lengthFrac: 0.5, radiusFrac: 0.04, taper: 0.1, aim: 0.3, spread: 0, curl: 0.2, tip: "stinger" },
      ],
    },
  },
  {
    id: "crocodile",
    title: "Crocodile (long jaw)",
    blueprint: {
      version: 1,
      // The head-variety showcase: an elongated flat skull whose face
      // follows the loft axis, a long flat snout with a working jaw, and
      // periscope eyes riding high on the crown.
      // 🐊 NILE CROCODILE, 3 m nose to tail tip, 300 kg. A croc is mostly
      // TAIL — roughly half its length — so the trunk is only 0.95 m and the
      // tail went 1.2 → 1.6 × that, which is what puts the total at ~3 m.
      // girth 0.15 → 0.3005 for 300 kg (a real 3 m croc is ~50 cm across the
      // belly), legs 0.0704/0.08 → 0.421/0.479 to the line.
      // ⚠️ THE SPRAWL IS HONEST AND IT IS EXPENSIVE. A crocodile plants its
      // feet outside its hips, so the ground reaction acts far off the joint
      // axes: even at bodyHeight 0.35 (up from 0.25 — a low "high walk", not a
      // belly slide) this reads ema 1.82 where the columnar cow reads 1.54,
      // and σ 0.78 against the cow's 0.79 at less than half the mass. That
      // ratio IS the cost of sprawling, and the ledger is right to charge it.
      spine: { torsoLengthM: 0.95, girth: 0.3005, girthPeak: 0.5, crossSection: 1.6 },
      neck: { segments: 1, lengthFrac: 0.15, radiusFrac: 0.75, lift: 0.1 },
      tail: { segments: 6, lengthFrac: 1.6, radiusFrac: 0.55, droop: 0.25 },
      head: {
        // A flat skull roof (low braincaseDome), a long broad snout
        // (crossSection wide), a full-length gape and a slender jaw, with
        // periscope eyes riding high on the crown.
        sizeFrac: 0.55, lengthFrac: 1.7, braincaseDome: 0.6, crossSection: 1.5,
        // Snout leaves near the TOP of the flat skull (foreheadHeight high),
        // straight off the front — no forehead at all.
        foreheadHeight: 0.4647, foreheadLength: 0, foreheadSlope: -0.1,
        beak: 0.15, snoutLengthFrac: 1.6, snoutRadiusFrac: 0.5, muzzleSquash: 0.35,
        snoutFlatten: 1.8, snoutCurve: -0.1, mouthOpen: 1, jawDepth: 0.12, jawOffset: 0,
        eyePairs: 1, eyeSizeFrac: 0.14, eyeAngle: 0.55, eyeHeight: 0.9, eyeBulge: 0.75,
      },
      posture: { bodyHeight: 0.35 },
      // Sprawled reptilian legs, belly riding low.
      limbGroups: [
        // FORE — elbow folds BACK.
      // 🦎 FOOT (foot-function round): stance 0.3, padFrac 0 — PLANTIGRADE
      // SPRAWL. Its sole has to keep lying flat: the flat-sole rule is what
      // centres this animal's pressure mid-sole instead of at the toe, and it
      // is the same rule that once caught the human at a phantom ema 6.6. No
      // pad — a crocodile walks on scaly toes, not on fat. σ 0.78 → 0.70.
        { placement: "bilateral", count: 1, stationStart: 0.18, stationEnd: 0.18, attachHeight: 0.45, restLevation: 0.1, restFlexion: -0.15, radiusFrac: 0.421, lengthFrac: 0.3696, stance: 0.3, padFrac: 0, toeCount: 4, toeSpread: 0.6, sizeContrast: 0 },
        // HIND — knee folds FORWARD.
        { placement: "bilateral", count: 1, stationStart: 0.8, stationEnd: 0.8, attachHeight: 0.45, restLevation: 0.1, restFlexion: 0.15, radiusFrac: 0.479, lengthFrac: 0.42, stance: 0.3, padFrac: 0, toeCount: 4, toeSpread: 0.6, sizeContrast: 0 },
      ],
      skin: { baseColor: "#4a5d3a", bellyColor: "#c9c2a0", accentColor: "#2e3a24" },
    },
  },
  // SUPERSEDED AT RUNTIME, on purpose. `animals-people.ts` authors the real
  // `human` and overrides this row in the registry (species.ts, override chain:
  // examples < animals-people < lab). This stays under the same id so the
  // creature lab can still load the plain worked biped — edit it for the
  // teaching example, never expecting the world to build it.
  {
    id: "human",
    title: "Human (biped + hands)",
    blueprint: {
      version: 1,
      // Fully erect (pitch ≈ 86°); bodyHeight leaves a natural knee ease.
      // Hand-tuned in the lab 2026-07-07.
      // 🚶 70 kg, 1.72 m. ⚠️ THIS ROW IS THE TEACHING COPY — the body the world
      // actually builds is `animals-people.ts`, which overrides it. Kept in
      // step by hand so the lab's plain worked biped is the same animal.
      // bodyHeight 0.785 → 0.85 and legs lengthFrac 1.852 → 1.70 straighten
      // the standing knee 145° → 164° (ema 4.88 → 2.40, σ 2.42 → 1.17).
      posture: { bodyPitch: 1.5, bodyHeight: 0.85 },
      // Shaped torso: broad shoulders (front/top), pinched waist, hips.
      // crossSection > 1 = wider than deep, like a real trunk. Near-zero
      // front taper keeps the chest broad instead of tapering to a point.
      spine: {
        torsoLengthM: 0.6, girth: 0.2167, girthPeak: 0.51, crossSection: 1.5, frontTaper: 0.02, rearTaper: 0.255,
        profile: [{ at: 0.18, scale: 1.15 }, { at: 0.52, scale: 0.88 }, { at: 0.85, scale: 1.0 }],
      },
      neck: { segments: 2, lengthFrac: 0.2, radiusFrac: 0.38, lift: 0.1 },
      tail: { segments: 0 },
      // The human face is all general dials, no special cases: the cranium
      // is LONGER than it is tall (the vault runs front-to-back — the
      // face's height comes from the MANDIBLE, not the cranium), the eyes
      // ride LOW on it, a short thin flat-fronted "nose" (muzzleSquash),
      // and the mouth is the seam just below. The head holds the horizon
      // off the vertical neck by rule — facePitch 0.
      head: {
        sizeFrac: 0.9, lengthFrac: 1.05, braincaseDome: 0.95, crossSection: 0.88,
        // The snout root sits LOW on the cranium front (foreheadHeight
        // 0.28), so the forehead IS the front of the cranium; a short flat
        // face shelf, straight slope.
        foreheadHeight: 0.0709, foreheadLength: 0.0548, foreheadSlope: 0.1,
        // Muzzle almost fully squared into the face (full-width tip, tiny
        // projection); a DEEP mandible drops the chin well below the small
        // terminal mouth — that is where the face gets its height.
        beak: 0, snoutLengthFrac: 0.14, snoutSegments: 2, snoutRadiusFrac: 0.42,
        muzzleSquash: 0.9, snoutFlatten: 1.1, snoutCurve: 0, mouthOpen: 0.32,
        jawDepth: 0.38, jawOffset: 0.15, mouthVertical: 0,
        // The nose is its OWN feature: protruding forward off the face with
        // the tip curling down.
        noseLengthFrac: 0.32, noseRadiusFrac: 0.445, nosePosition: 0.18,
        noseTaper: 0.45, noseFlatten: 1,
        noseSegments: 2, noseDroop: 1.1,
        eyePairs: 1, eyeSizeFrac: 0.15, eyeAngle: 0.45, eyeHeight: 0.03, eyeBulge: 0.35,
        // What separates this face from a chimp's: a small mouth (the
        // commissure sits far forward), a strong CHIN, a light brow, and
        // full everted lips — plus the flat midface + projecting nose above.
        padding: 0.35, cheek: 0.5, jowl: 0.1, brow: 0.12, muzzlePad: 0.5,
        lips: 0.5, chin: 0.75,
      },
      // Long plantigrade legs socket low (narrow stance, straight under the
      // body), knees folding FORWARD (+restFlexion), slight protraction +
      // legTwist orienting the knees/feet. The shorter arms socket high on
      // the shoulders so they can't reach the ground — they hang at the
      // sides, ending in opposed hands (the foot section is the palm).
      limbGroups: [
      // 🚶 FOOT (foot-function round): stance 0 / padFrac 0.15 — a human heel
      // pad. The pad is REAL and it is deliberately INERT here: a flat sole is
      // already bearing at both ends, so `max(flat, padFrac)` takes the flat
      // term and the pressure centre does not move. σ 1.06 → 1.06, unchanged
      // to nine decimals, which is the point — a pad must never make a foot
      // worse, and a plantigrade foot has nothing for one to fix.
        { placement: "bilateral", count: 1, stationStart: 0.88, stationEnd: 0.88, lengthFrac: 1.7, radiusFrac: 0.6, taper: 0.45, attachHeight: 0.3, restProtraction: 0.26, restLevation: -0.76, restFlexion: 0.24, flexRange: 0.475, legTwist: 0.72, legBalance: -0.03, stance: 0, padFrac: 0.15, ankleRange: 0.705, footLengthFrac: 0.198, toeCount: 5, toeSpread: 0.25, toeLengthFrac: 0.236, toeContrast: 0.3 },
        { placement: "bilateral", count: 1, stationStart: 0, stationEnd: 0, sizePeak: 0.94, lengthFrac: 1.06, radiusFrac: 0.369, taper: 0.5, attachHeight: 0.565, restProtraction: 0.02, restLevation: -0.71, restFlexion: 0.19, flexRange: 0.885, footLengthFrac: 0.132, stance: 0.15, toeCount: 4, opposition: 0.7, toeLengthFrac: 0.624, toeSpread: 0.602, toeContrast: 0.21 },
      ],
    },
  },
  {
    id: "ungulate",
    title: "Ungulate (hooves)",
    blueprint: {
      version: 1,
      // 🐃 WILDEBEEST, 200 kg — the generic hoofed grazer. The row carried NO
      // spine block at all, so it silently inherited the default quadruped's
      // 1.2 m / girth 0.18 and read 152 kg on legs 4.5× too thin. Spelled out
      // now: 1.25 m trunk, girth 0.1514 for 200 kg. bodyHeight 0.5 → 1.0 is
      // the big one (ema 6.24 → 1.82 — this was the most crouched body in the
      // registry), and the cannon bone shortened (footLengthFrac 0.28 → 0.18)
      // because an unguligrade foot's whole length was being charged to the
      // knee as a lever. Reads 200.2 kg, σ 0.78, ema 1.82, r/line 1.00.
      spine: { torsoLengthM: 1.25, girth: 0.1514, girthPeak: 0.45 },
      posture: { bodyHeight: 1 },
      neck: { segments: 3, lengthFrac: 0.55, radiusFrac: 0.45, lift: 0.9 },
      tail: { segments: 2, lengthFrac: 0.2, radiusFrac: 0.3, droop: 0.4 },
      // A long DEEP muzzle (snoutFlatten < 1 = taller than wide) with a
      // small front mouth (mouthOpen 0.3 — the cheeks close off the long
      // jaw behind it), lateral eyes, and a roman-nose bridge (snoutCurve).
      head: {
        sizeFrac: 0.5, lengthFrac: 1.2, braincaseDome: 0.95, beak: 0.1, snoutLengthFrac: 1.5,
        foreheadHeight: 0.1965, foreheadLength: 0.35, foreheadSlope: 0.05,
        snoutSegments: 3, snoutRadiusFrac: 0.5, muzzleSquash: 0.7, snoutFlatten: 0.7,
        snoutCurve: 0.12, mouthOpen: 0.3, jawDepth: 0.2, jawOffset: 0.1,
        eyePairs: 1, eyeSizeFrac: 0.16, eyeAngle: 1.1, eyeHeight: 0.45,
        // Horse mouth: lips part only at the muzzle tip — the long jaw
        // behind the commissure is closed off by cheek.
        cheek: 0.45, jowl: 0.3, lips: 0.5, chin: 0.05,
      },
      // One thick digit (hoof); the high stance rest + raised posture keeps
      // it up on the tip (unguligrade), the long foot as the cannon bone.
      limbGroups: [
        // FORE — elbow folds BACK.
      // 🐐 FOOT (foot-function round): stance 1 / padFrac 0 — UNGULIGRADE.
      // The foot stands as a vertical column and the single toe continues it,
      // so the body stands on the toe TIP and a keratin cap is derived there.
      // No pad: a hoof stands on keratin, not on fat. σ 0.89 → 0.81.
        { placement: "bilateral", count: 1, stationStart: 0.2, stationEnd: 0.2, attachHeight: 0.32, restProtraction: 0, restLevation: -0.5, restFlexion: -0.5, stance: 1, padFrac: 0, footLengthFrac: 0.18, lengthFrac: 0.5808, radiusFrac: 0.548, toeCount: 1, toeContrast: 0, sizeContrast: 0 },
        // HIND — knee folds FORWARD.
        { placement: "bilateral", count: 1, stationStart: 0.85, stationEnd: 0.85, attachHeight: 0.32, restProtraction: 0, restLevation: -0.5, restFlexion: 0.5, stance: 1, padFrac: 0, footLengthFrac: 0.18, lengthFrac: 0.66, radiusFrac: 0.6, toeCount: 1, toeContrast: 0, sizeContrast: 0 },
      ],
    },
  },
  // ── LAB-TUNED BODIES ────────────────────────────────────────────────────
  // The four below were shaped in the creature lab and exported whole, so
  // unlike the hand-authored examples above they carry every field rather than
  // "just the parts that matter". That is deliberate: they are TUNED — the
  // numbers are the result of moving sliders until the animal read right — so
  // trimming them back to a partial would quietly re-open each dropped field to
  // whatever clampBlueprint's default happens to be.
  //
  // The trunk is the NOSE taken long (its own feature, NOT the muzzle): rooted
  // near the front of a short jaw, many segments, drooping down. The actual
  // mouth stays small and separate at the jaw.
  {
    id: "elephant",
    title: "Elephant (trunk)",
    blueprint: {
      version: 1,
      // 🐘 AFRICAN ELEPHANT, 4 t (a mature cow; bulls run 6). The shipped
      // body was a FIVE-METRE trunk reading 126 057 kg — 21× a real elephant —
      // on legs 37% under the line. Trunk 5 → 1.8 m, girth 0.45 → 0.3983.
      // Head sizeFrac 0.851 → 0.70: the solid head bulb was 33% of body mass
      // and put 80% of the weight on the forefeet; a real elephant carries
      // ~60% there, and this lands 67%. ⚠️ 0.60 landed the split dead on 61%
      // and was REJECTED ON LOOKS — it left an elephant with a small head and
      // a trunk hanging off it like a tentacle. 0.70 is the compromise: the
      // silhouette back, σ 0.81 → 0.89, still under capacity. The toes also
      // came in (toeSpread 1.4 → 0.7) — at the real size the old spread read
      // as a spiky fan rather than a foot (toeLengthFrac 0.64 → 0.26 with it).
      // ⚠️ r/line 1.15, NOT 1.00, and that is the one deliberate thickening in
      // this round. At 4 t the line alone cannot get σ under 1: bone
      // circumference goes as M^0.364 so stress still climbs as M^0.272, and
      // the ema credit that pays for it bottoms out at 1 (a columnar limb).
      // A graviportal elephant really is more robust than the line's average
      // quadruped — 1.15 buys σ 1.44 → 0.81 and is the honest reading of what
      // "elephantine" means.
      spine: { torsoSegments: 6, torsoLengthM: 1.8, girth: 0.378, girthPeak: 0.62, frontTaper: 0.255, rearTaper: 0.33, crossSection: 1 },
      neck: { segments: 2, lengthFrac: 0, radiusFrac: 0.756, lift: -0.005 },
      tail: { segments: 5, lengthFrac: 0.7, radiusFrac: 0.18775, droop: -1.2 },
      head: {
        sizeFrac: 0.7, lengthFrac: 0.96, braincaseDome: 1, crossSection: 1, facePitch: -0.063,
        foreheadHeight: 0.2742, foreheadLength: 0.1238, foreheadSlope: 0.41, beak: 0, snoutLengthFrac: 0.225, snoutSegments: 2,
        snoutRadiusFrac: 0.4244, muzzleSquash: 0, snoutFlatten: 1.34975, snoutCurve: 0.83, mouthOpen: 0.5, jawDepth: 0.365,
        jawOffset: -0.27, mouthVertical: 0, noseLengthFrac: 2.19, noseRadiusFrac: 0.6326, nosePosition: 0.285,
        noseTaper: 0.45, noseFlatten: 1, noseSegments: 5,
        noseDroop: 1.5, eyePairs: 1, eyeSizeFrac: 0.12, eyeAngle: 1, eyeHeight: 0.41, eyeBulge: 0.35,
        padding: 0.3, cheek: 0.3, jowl: 0, brow: 0.25, muzzlePad: 0.45, lips: 0.3,
        chin: 0,
      },
      posture: { bodyPitch: 0.0655, bodyHeight: 0.95 },
      skin: { baseColor: "#82807d", bellyColor: "#cbcac8", accentColor: "#545454" },
      // Thick pillar legs, plantigrade, knees barely bent.
      limbGroups: [
        // FORE — elbow folds BACK.
      // 🐘 FOOT (foot-function round): stance 0.85 / padFrac 1 — THE PADDED
      // COLUMN, and the body the `padFrac` dial exists for. The wedge under a
      // raised ankle is packed solid, so the load runs straight down through it
      // and the toes derive SHORT: 6.4 cm nails on the pad's face, where the
      // floor used to draw 35 cm toes on a 25 cm foot (×5.6 its own dial).
      //
      // ⚠️ DEVIATION FROM THE ROUND'S STARTING VALUE, ON THE LEDGER'S SAY-SO.
      // The design opened at stance ~0.5; measured, that slants the foot so far
      // forward that the plant lands 13 cm ahead of the hip and the HIP binds:
      // σ 1.005, over the line, on a body that was viable at 0.94. Elephants
      // are semi-digitigrade — near-vertical foot bones over a fibro-fatty pad
      // — so the honest reading is the high stance it already had. Measured:
      // 0.5 → σ 1.005 · 0.72 → 0.935 · 0.85 → 0.89 (shipped).
        { placement: "bilateral", count: 1, stationStart: 0.065, stationEnd: 0.065, sizePeak: 0.915, sizeContrast: 0, lengthFrac: 0.424, radiusFrac: 0.521, taper: 0.7075, membrane: 0, attachHeight: 0.165, restProtraction: -1, restLevation: -1, restFlexion: -0.15, flexRange: 0.365, legTwist: 0.06, legBalance: 0, footLengthFrac: 0.324, stance: 0.85, padFrac: 1, ankleRange: 0.54, toeCount: 4, toeLengthFrac: 0.26, toeSpread: 0.45, toeContrast: 0, opposition: 0, toeCurl: 0.055 },
        // HIND — knee folds FORWARD.
        { placement: "bilateral", count: 1, stationStart: 0.85, stationEnd: 0.85, sizePeak: 0.915, sizeContrast: 0, lengthFrac: 0.424, radiusFrac: 0.521, taper: 0.7075, membrane: 0, attachHeight: 0.165, restProtraction: -1, restLevation: -1, restFlexion: 0.15, flexRange: 0.365, legTwist: 0.06, legBalance: 0, footLengthFrac: 0.324, stance: 0.85, padFrac: 1, ankleRange: 0.54, toeCount: 4, toeLengthFrac: 0.26, toeSpread: 0.45, toeContrast: 0, opposition: 0, toeCurl: 0.055 },
      ],
    },
  },
  {
    id: "horse",
    title: "Horse",
    blueprint: {
      version: 1,
      // 🐴 RIDING HORSE, 500 kg. The shipped body read 894 kg on a 1.2 m trunk
      // AND put 82% of its weight on the forefeet — a horse standing on its
      // hands. Three separate fixes, all measured:
      //   • trunk 1.2 → 1.35 m (withers-to-hip on a 15-hand horse) and girth
      //     0.36 → 0.2256, which lands 500 kg with a ~1.9 m heart girth;
      //   • THE FORE/HIND SPLIT — girthPeak 0.33 → 0.7 (the barrel's mass
      //     belongs over the loin, not the chest), head sizeFrac 0.543 → 0.52,
      //     neck radiusFrac 0.45 → 0.40, a proper long tail (lengthFrac 0.855
      //     → 1.2, radiusFrac 0.3 → 0.4) putting real mass BEHIND the hips,
      //     and the feet moved to the trunk's ends (stations 0.145/0.85 →
      //     0.05/1.0). 82/18 → 65/35, against a real ~58/42.
      //     ⚠️ THE HEAD WAS THE OBVIOUS FIX AND IT IS THE WRONG ONE. Taking
      //     sizeFrac to 0.45 does land the split at 65% on its own — and draws
      //     a horse with a llama's head. Rejected on looks; the tail buys the
      //     same 4 points and a horse HAS a long tail. What is left of the
      //     gap is the model's solid-bulb skull, which no proportion dial can
      //     make hollow.
      //   • bodyHeight 0.805 → 1.0: a standing horse's leg is a COLUMN. ema
      //     2.73 → 1.80, and posture is the half of the law thickness cannot do.
      // Reads 500 kg, σ 0.91, ema 1.80, r/line 1.00, crush, 4/4 grounded.
      spine: { torsoSegments: 6, torsoLengthM: 1.35, girth: 0.2256, girthPeak: 0.7, frontTaper: 0.275, rearTaper: 0.44, crossSection: 1 },
      neck: { segments: 4, lengthFrac: 0.3625, radiusFrac: 0.4, lift: 0.895 },
      tail: { segments: 7, lengthFrac: 1.2, radiusFrac: 0.4, droop: -1.2 },
      head: {
        sizeFrac: 0.52, lengthFrac: 1.14, braincaseDome: 1, crossSection: 0.814, facePitch: -0.585,
        foreheadHeight: 0, foreheadLength: 0.6426, foreheadSlope: 0.19, beak: 0, snoutLengthFrac: 0.875, snoutSegments: 2,
        snoutRadiusFrac: 0.613, muzzleSquash: 0.4, snoutFlatten: 1.11325, snoutCurve: -0.09, mouthOpen: 0.285, jawDepth: 0,
        jawOffset: 0.1, mouthVertical: 0, noseLengthFrac: 0, noseRadiusFrac: 0.24945, nosePosition: 0.0825,
        noseTaper: 0.45, noseFlatten: 1, noseSegments: 2,
        noseDroop: 1.02, eyePairs: 1, eyeSizeFrac: 0.222, eyeAngle: 1.06125, eyeHeight: 0.39, eyeBulge: 0,
        padding: 0.3, cheek: 0.3, jowl: 0.2, brow: 0.25, muzzlePad: 0.45, lips: 0.3,
        chin: 0,
      },
      posture: { bodyPitch: 0.0845, bodyHeight: 1 },
      skin: { baseColor: "#8a7456", bellyColor: "#cdbfa3", accentColor: "#3d3528" },
      // ONE toe — the hoof. Long legs, deep flex range, a standing runner.
      limbGroups: [
        // FORE — elbow folds BACK.
      // 🐎 FOOT (foot-function round): stance 1 / padFrac 0 — THE ROUND'S
      // HEADLINE. Its whole posture cost was the last 15° of ankle pitch: at
      // the old stance-1 endpoint of 1.3 rad the foot still slanted 12 cm
      // forward of the ankle, putting the ground push 7.1 cm ahead of the knee
      // against a 6.5 cm muscle arm — ema 2.08, σ 1.06, over the line.
      // Unguligrade alignment stands the same foot as a column (83°, 5.4 cm of
      // slant) with the hoof continuing its line: ema 2.08 → 1.58, σ 1.06 →
      // 0.81, and it gains 8 cm of standing height off its own hooves.
      // ⚠️ `footLengthFrac` IS STILL 0.6 — the 0.6 → 0.5 patch was deliberately
      // NOT applied. The horse came back under the line on the mechanism, not
      // on a dial, which is the whole test of whether the mechanism is real.
        { placement: "bilateral", count: 1, stationStart: 0.05, stationEnd: 0.05, sizePeak: 1, sizeContrast: 0, lengthFrac: 0.556, radiusFrac: 0.475, taper: 0.19, membrane: 0, attachHeight: 0.135, restProtraction: -0.47, restLevation: -0.73, restFlexion: -0.15, flexRange: 0.55, legTwist: -0.78, legBalance: 0, footLengthFrac: 0.6, stance: 1, padFrac: 0, ankleRange: 1, toeCount: 1, toeLengthFrac: 0.2, toeSpread: 0.399, toeContrast: 0, opposition: 0, toeCurl: 0.1 },
        // HIND — knee folds FORWARD.
        { placement: "bilateral", count: 1, stationStart: 1, stationEnd: 1, sizePeak: 1, sizeContrast: 0, lengthFrac: 0.556, radiusFrac: 0.475, taper: 0.19, membrane: 0, attachHeight: 0.135, restProtraction: -0.47, restLevation: -0.73, restFlexion: 0.15, flexRange: 0.55, legTwist: -0.78, legBalance: 0, footLengthFrac: 0.6, stance: 1, padFrac: 0, ankleRange: 1, toeCount: 1, toeLengthFrac: 0.2, toeSpread: 0.399, toeContrast: 0, opposition: 0, toeCurl: 0.1 },
      ],
    },
  },
  {
    id: "cat",
    title: "Cat",
    blueprint: {
      version: 1,
      // 🐈 HOUSECAT, 4.5 kg. Also pure scale — 0.40 → 0.32 m chest-to-hip, the
      // length of a real domestic cat's trunk. Reads 4.4 kg, σ 0.29, ema 2.26,
      // r/line 1.06: a cat is a crouched small mammal and the high-ish ema is
      // Biewener's own point about small animals, not a fault.
      spine: { torsoSegments: 6, torsoLengthM: 0.32, girth: 0.2, girthPeak: 0.44, frontTaper: 0.465, rearTaper: 0.44, crossSection: 1.28 },
      neck: { segments: 4, lengthFrac: 0.05, radiusFrac: 0.45, lift: 0.1 },
      tail: { segments: 10, lengthFrac: 1.56, radiusFrac: 0.3, droop: -0.168 },
      head: {
        sizeFrac: 0.683, lengthFrac: 1.14, braincaseDome: 1, crossSection: 1, facePitch: -0.027,
        foreheadHeight: 0.2345, foreheadLength: 0.233, foreheadSlope: -0.12, beak: 0, snoutLengthFrac: 0.3875, snoutSegments: 2,
        snoutRadiusFrac: 0.7319, muzzleSquash: 0, snoutFlatten: 1.21, snoutCurve: -0.14, mouthOpen: 0.2325, jawDepth: 0.05,
        jawOffset: -0.03, mouthVertical: 0, noseLengthFrac: 0.21, noseRadiusFrac: 0.306, nosePosition: 0.1125,
        noseTaper: 0.45, noseFlatten: 1, noseSegments: 2,
        noseDroop: 0, eyePairs: 1, eyeSizeFrac: 0.18, eyeAngle: 0.42, eyeHeight: 0.597, eyeBulge: 0.54,
        padding: 0.3, cheek: 0.3, jowl: 0.2, brow: 0.25, muzzlePad: 0.45, lips: 0.3,
        chin: 0,
      },
      posture: { bodyPitch: 0.0655, bodyHeight: 0.82 },
      skin: { baseColor: "#8a7456", bellyColor: "#cdbfa3", accentColor: "#3d3528" },
      limbGroups: [
        // FORE — elbow folds BACK.
      // 🐈 FOOT (foot-function round): stance 0.6 / padFrac 0.3 — DIGITIGRADE
      // WITH A HEEL PAD, the carnivoran foot. Below `TOE_ALIGN_START`, so its
      // toes stay flat and hinged at the ball — a cat walks on its digits, it
      // does not stand on their tips — and the pad is what a raised ankle
      // actually rests on. σ 0.38 → 0.34.
        { placement: "bilateral", count: 1, stationStart: 0.145, stationEnd: 0.145, sizePeak: 1, sizeContrast: 0, lengthFrac: 0.424, radiusFrac: 0.43185, taper: 0.19, membrane: 0, attachHeight: 0.175, restProtraction: -0.47, restLevation: -0.73, restFlexion: -0.15, flexRange: 0.55, legTwist: -0.78, legBalance: 0, footLengthFrac: 0.378, stance: 0.6, padFrac: 0.3, ankleRange: 1, toeCount: 4, toeLengthFrac: 0.508, toeSpread: 0.77, toeContrast: 0.035, opposition: 0, toeCurl: 0.02 },
        // HIND — knee folds FORWARD.
        { placement: "bilateral", count: 1, stationStart: 0.85, stationEnd: 0.85, sizePeak: 1, sizeContrast: 0, lengthFrac: 0.424, radiusFrac: 0.43185, taper: 0.19, membrane: 0, attachHeight: 0.175, restProtraction: -0.47, restLevation: -0.73, restFlexion: 0.15, flexRange: 0.55, legTwist: -0.78, legBalance: 0, footLengthFrac: 0.378, stance: 0.6, padFrac: 0.3, ankleRange: 1, toeCount: 4, toeLengthFrac: 0.508, toeSpread: 0.77, toeContrast: 0.035, opposition: 0, toeCurl: 0.02 },
      ],
    },
  },
  {
    id: "dog",
    title: "Dog",
    blueprint: {
      version: 1,
      // 🐕 LABRADOR, 30 kg — the module's own anchor animal (physio.ts pins
      // MUSCLE_STRENGTH on a 30 kg quadruped). PURE SCALE: torsoLengthM 1.7 →
      // 0.55 m, which is a labrador's shoulder-to-hip, and NOTHING else moved.
      // The shipped body was a 873 kg dog — the proportions were always right,
      // only the metre was wrong. Reads 29.6 kg, σ 0.30, ema 1.80, r/line 1.18.
      spine: { torsoSegments: 6, torsoLengthM: 0.55, girth: 0.258, girthPeak: 0.44, frontTaper: 0.465, rearTaper: 0.75, crossSection: 1.28 },
      neck: { segments: 4, lengthFrac: 0.1125, radiusFrac: 0.45, lift: 0.1 },
      tail: { segments: 10, lengthFrac: 0.495, radiusFrac: 0.3, droop: 0.528 },
      head: {
        sizeFrac: 0.543, lengthFrac: 0.915, braincaseDome: 1, crossSection: 1, facePitch: -0.342,
        foreheadHeight: 0.2907, foreheadLength: 0.3758, foreheadSlope: -0.05, beak: 0, snoutLengthFrac: 0.45, snoutSegments: 2,
        snoutRadiusFrac: 0.6581, muzzleSquash: 0.495, snoutFlatten: 1.468, snoutCurve: -0.12, mouthOpen: 1.14, jawDepth: 0.11,
        jawOffset: 0.1, mouthVertical: 0, noseLengthFrac: 0.27, noseRadiusFrac: 1.09, nosePosition: 0.0525,
        noseTaper: 0.45, noseFlatten: 1, noseSegments: 2,
        noseDroop: 1.5, eyePairs: 1, eyeSizeFrac: 0.18, eyeAngle: 0.582, eyeHeight: 0.699, eyeBulge: 0.54,
        padding: 0.3, cheek: 0.3, jowl: 0.2, brow: 0.25, muzzlePad: 0.45, lips: 0.3,
        chin: 0,
      },
      posture: { bodyPitch: 0.0655, bodyHeight: 0.805 },
      skin: { baseColor: "#8a7456", bellyColor: "#cdbfa3", accentColor: "#3d3528" },
      limbGroups: [
        // FORE — elbow folds BACK.
      // 🐕 FOOT (foot-function round): stance 0.6 / padFrac 0.3 — the same
      // digitigrade-plus-heel-pad foot as the cat. σ 0.37 → 0.34.
        { placement: "bilateral", count: 1, stationStart: 0.145, stationEnd: 0.145, sizePeak: 1, sizeContrast: 0, lengthFrac: 0.388, radiusFrac: 0.43185, taper: 0.298, membrane: 0, attachHeight: 0.175, restProtraction: -0.47, restLevation: -0.73, restFlexion: -0.15, flexRange: 0.55, legTwist: -0.78, legBalance: 0, footLengthFrac: 0.378, stance: 0.6, padFrac: 0.3, ankleRange: 1, toeCount: 4, toeLengthFrac: 0.508, toeSpread: 0.77, toeContrast: 0.035, opposition: 0, toeCurl: 0.02 },
        // HIND — knee folds FORWARD.
        { placement: "bilateral", count: 1, stationStart: 0.61, stationEnd: 0.61, sizePeak: 1, sizeContrast: 0, lengthFrac: 0.388, radiusFrac: 0.43185, taper: 0.298, membrane: 0, attachHeight: 0.175, restProtraction: -0.47, restLevation: -0.73, restFlexion: 0.15, flexRange: 0.55, legTwist: -0.78, legBalance: 0, footLengthFrac: 0.378, stance: 0.6, padFrac: 0.3, ankleRange: 1, toeCount: 4, toeLengthFrac: 0.508, toeSpread: 0.77, toeContrast: 0.035, opposition: 0, toeCurl: 0.02 },
      ],
    },
  },
  {
    id: "beetle",
    title: "Hexapod (beetle)",
    blueprint: {
      version: 1,
      // 🪲 GROUND BEETLE, 3 cm, ~2 g. 0.9 → 0.03 m, legs 0.04 → 0.06 to the
      // line. Reads σ 0.05 — the least loaded body in the registry, which is
      // what "an insect is trivially safe at its own scale" should look like.
      spine: { torsoLengthM: 0.03, girth: 0.22, girthPeak: 0.55, skeleton: "exo", profile: [{ at: 0.25, scale: 0.8 }, { at: 0.5, scale: 0.7 }, { at: 0.75, scale: 1.1 }] },
      neck: { segments: 1, lengthFrac: 0.15, radiusFrac: 0.6, lift: 0.3 },
      tail: { segments: 0 },
      head: { sizeFrac: 0.45, beak: 0.3, snoutLengthFrac: 0.4, eyePairs: 1 },
      posture: { bodyHeight: 0.35 },
      limbGroups: [
        { placement: "bilateral", count: 3, stationStart: 0.2, stationEnd: 0.85, attachHeight: 0.44, restProtraction: 0, restLevation: 0.3, restFlexion: 0, radiusFrac: 0.06, lengthFrac: 0.5, stance: 0.7, toeCount: 1 },
      ],
      chains: [
        { attach: "head", count: 2, radial: false, segments: 5, lengthFrac: 0.5, radiusFrac: 0.025, taper: 0.2, aim: 0.6, spread: 0.4, curl: 0.7, tip: "club" },
      ],
    },
  },
  {
    id: "centipede",
    title: "Centipede (many legs)",
    blueprint: {
      version: 1,
      // 🐛 GIANT TROPICAL CENTIPEDE (Scolopendra), 15 cm, ~30 g. 2.2 → 0.15 m
      // — the shipped body was a TWO-METRE centipede. Legs 0.025 → 0.113 to
      // the line, which on this body is a 1 mm leg under an 18 mm trunk.
      // Reads σ 0.07 over sixteen grounded legs.
      spine: { torsoLengthM: 0.15, girth: 0.06, girthPeak: 0.5, skeleton: "exo", torsoSegments: 10, frontTaper: 0.4, rearTaper: 0.4 },
      neck: { segments: 0 },
      tail: { segments: 2, lengthFrac: 0.3, radiusFrac: 0.6, droop: 0.2 },
      head: { sizeFrac: 0.5, eyePairs: 1, eyeSizeFrac: 0.15 },
      posture: { bodyHeight: 0.3 },
      limbGroups: [
        { placement: "bilateral", count: 8, stationStart: 0.08, stationEnd: 0.95, sizePeak: 0.5, sizeContrast: 0.1, attachHeight: 0.45, restProtraction: 0, restLevation: 0.3, restFlexion: 0, radiusFrac: 0.113, lengthFrac: 0.4, stance: 0.7, toeCount: 1 },
      ],
      chains: [
        { attach: "head", count: 2, radial: false, segments: 5, lengthFrac: 0.5, radiusFrac: 0.025, taper: 0.2, aim: 0.5, spread: 0.5, curl: 0.6, tip: "none" },
      ],
    },
  },
  {
    id: "spider",
    title: "Spider (waist + abdomen)",
    blueprint: {
      version: 1,
      // 🕷️ A BIG HOUSE/WOLF SPIDER, 3 cm body, ~2 g. 0.9 → 0.03 m and the leg
      // radii are UNTOUCHED — at real scale they already sit at r/line 1.06,
      // which is the cleanest evidence in the round that the arthropods'
      // drawn proportions were never the problem. Reads σ 0.41; the ema of 35
      // is a genuinely sprawled eight-legged body and the exoskeleton is what
      // pays for it.
      spine: { crossSection: 1.2, girth: 0.18, girthPeak: 0.25, torsoLengthM: 0.03, skeleton: "exo", frontTaper: 0.4, rearTaper: 0.3, profile: [{ at: 0.2, scale: 1 }, { at: 0.45, scale: 0.4 }, { at: 0.8, scale: 1.55 }] },
      neck: { segments: 0 },
      tail: { segments: 0 },
      head: { sizeFrac: 0.4, beak: 0, snoutLengthFrac: 0.1, eyePairs: 2, eyeSizeFrac: 0.2, eyeAngle: 0.6 },
      posture: { bodyHeight: 0.55 },
      limbGroups: [
        { placement: "bilateral", count: 4, stationStart: 0.12, stationEnd: 0.4, sizePeak: 0, sizeContrast: 0.15, attachHeight: 0.45, restProtraction: 0, restLevation: 0.4, restFlexion: 0, radiusFrac: 0.08, lengthFrac: 0.72, stance: 0.8, toeCount: 1 },
      ],
    },
  },
  {
    id: "wasp",
    title: "Wasp (waist + stinger)",
    blueprint: {
      version: 1,
      // 🐝 WASP, 2 cm thorax+abdomen, ~0.6 g. 1.2 → 0.02 m — which is BELOW
      // the old `torsoLengthM` floor of 0.05, and lowering that floor to 0.01
      // (blueprint.ts) is the only reason this body can be authored at its own
      // size at all. Legs to the line (0.04 → 0.077). Reads σ 0.16.
      spine: { girth: 0.16, girthPeak: 0.3, torsoLengthM: 0.02, skeleton: "exo", frontTaper: 0.3, rearTaper: 0.2, profile: [{ at: 0.3, scale: 1.1 }, { at: 0.45, scale: 0.18 }, { at: 0.62, scale: 1.5 }, { at: 0.95, scale: 0.7 }] },
      neck: { segments: 2, lengthFrac: 0.3, radiusFrac: 0.5, lift: 0.5 },
      tail: { segments: 0 },
      head: { sizeFrac: 0.6, beak: 0.2, snoutLengthFrac: 0.4, eyePairs: 1, eyeSizeFrac: 0.3, eyeAngle: 0.9 },
      posture: { bodyHeight: 0.35 },
      limbGroups: [
        { placement: "bilateral", count: 3, stationStart: 0.32, stationEnd: 0.6, sizePeak: 0.5, sizeContrast: 0.1, attachHeight: 0.44, restProtraction: 0, restLevation: 0.25, restFlexion: 0, radiusFrac: 0.077, lengthFrac: 0.5, stance: 0.7, toeCount: 1 },
      ],
      chains: [
        { attach: "body", station: 0.95, count: 1, radial: false, segments: 3, lengthFrac: 0.25, radiusFrac: 0.04, taper: 0.1, aim: 0, spread: 0, curl: 0.2, tip: "stinger" },
      ],
    },
  },
  {
    id: "crab",
    title: "Crab (flat + claws)",
    blueprint: {
      version: 1,
      // 🦀 SHORE CRAB, 15 cm carapace, ~0.7 kg. 0.6 → 0.15 m; walking legs
      // 0.04 → 0.067 to the line, the claw-arms left alone (manipulators).
      // Reads σ 0.13, and its ema binds at the HIP, not the knee — the only
      // body in the registry that does, and exactly right for a crab: the legs
      // are straight-ish rods planted far outside a wide flat body.
      spine: { crossSection: 2.2, girth: 0.32, girthPeak: 0.5, torsoLengthM: 0.15, skeleton: "exo" },
      neck: { segments: 0 },
      tail: { segments: 0 },
      head: { sizeFrac: 0.3, eyePairs: 2, eyeSizeFrac: 0.18 },
      posture: { bodyHeight: 0.4 },
      // Long walking legs lead; shorter front claw-limbs lift and hang,
      // ending in a curled, opposed pincer pair.
      limbGroups: [
        { placement: "bilateral", count: 4, stationStart: 0.25, stationEnd: 0.75, attachHeight: 0.44, restProtraction: 0, restLevation: 0.35, restFlexion: 0, radiusFrac: 0.067, lengthFrac: 0.75, stance: 0.7, toeCount: 1 },
        // Claw-arms: mounted low like the walking legs (so they COULD reach
        // the ground), but held forward and folded — load recruitment leaves
        // them raised because the eight walking legs already hold the body up.
        { placement: "bilateral", count: 1, stationStart: 0.12, stationEnd: 0.12, lengthFrac: 0.5, radiusFrac: 0.1, attachHeight: 0.45, restProtraction: 0.45, restLevation: 0.1, restFlexion: 0.5, legTwist: 0.9, toeCount: 2, toeCurl: 0.7, opposition: 0.8, toeLengthFrac: 0.9, footLengthFrac: 0.42 },
      ],
      chains: [
        { attach: "head", count: 2, radial: false, segments: 4, lengthFrac: 0.4, radiusFrac: 0.03, taper: 0.2, aim: 0.7, spread: 0.5, curl: 0.3, tip: "eye" },
      ],
    },
  },
  {
    id: "mantis",
    title: "Mantis (raptorial forelegs)",
    blueprint: {
      version: 1,
      // 🚨 THE ARTHROPODS ARE `skeleton: "exo"`, AND THAT IS THE WHOLE FIX.
      // Every one of them shipped as a metre-long monster reading σ in the
      // thousands, and BOTH halves of that were real bugs: they were authored
      // an order of magnitude too big, and they were being measured with
      // K_BONE = 6.1, a MAMMAL's flesh-capsule-to-bone ratio. An insect wears
      // its skeleton on the outside (k ≈ 1.3), which is ~22× the load-bearing
      // area and ~484× the buckling stiffness at the same drawn thickness.
      // Same body, same numbers, `"endo"` vs `"exo"`: the spider reads σ 34.9
      // vs 0.41.
      // 🦗 EUROPEAN MANTIS, 7 cm body, ~6 g. 1.0 → 0.07 m.
      // Walking legs to the line (0.03 → 0.093) and held a little under the
      // body rather than splayed (restLevation 0.25 → -0.2): the sprawl was
      // costing ema 32, and a mantis at rest stands ON its four walkers.
      // Reads 6 g, σ 0.46. The raptorial forelegs are untouched — they are
      // manipulators and never recruit.
      spine: { torsoLengthM: 0.07, girth: 0.09, girthPeak: 0.45, skeleton: "exo", frontTaper: 0.4, rearTaper: 0.5, profile: [{ at: 0.3, scale: 0.85 }, { at: 0.6, scale: 1.15 }] },
      neck: { segments: 2, lengthFrac: 0.22, radiusFrac: 0.5, lift: 0.4 },
      tail: { segments: 0 },
      head: { sizeFrac: 0.4, beak: 0.2, snoutLengthFrac: 0.3, eyePairs: 1, eyeSizeFrac: 0.36, eyeAngle: 1.1 },
      posture: { bodyPitch: 0.3, bodyHeight: 0.45 },
      // Four walking legs (mid + rear) — natural standers, sprawled.
      // Two raptorial forelegs are CAPABLE (mounted low like the walkers) but
      // held up and folded in the "prayer": recruitment leaves them raised
      // because the four walkers already support the body. Drop a walker's
      // count to 1 and the forelegs deploy to the ground to keep balance.
      limbGroups: [
        { placement: "bilateral", count: 2, stationStart: 0.4, stationEnd: 0.9, attachHeight: 0.45, restProtraction: 0, restLevation: -0.2, restFlexion: 0, radiusFrac: 0.093, lengthFrac: 0.6, stance: 0.7, toeCount: 1 },
        { placement: "bilateral", count: 1, stationStart: 0.2, stationEnd: 0.2, attachHeight: 0.45, restProtraction: 0.35, restLevation: 0.9, restFlexion: 0.55, radiusFrac: 0.045, lengthFrac: 0.7, toeCount: 2, opposition: 0.7, toeCurl: 0.6, toeLengthFrac: 0.8, footLengthFrac: 0.05 },
      ],
      chains: [
        { attach: "head", count: 2, radial: false, segments: 5, lengthFrac: 0.4, radiusFrac: 0.02, taper: 0.2, aim: 0.7, spread: 0.4, curl: 0.5, tip: "none" },
      ],
    },
  },
  {
    id: "octopus",
    title: "Octopus (radial arms)",
    blueprint: {
      version: 1,
      // 🌊 NO STANDING LEGS, SO NO LEG LEDGER — rescaled to real dimensions
      // only. These bodies were never in the impossible state the standers
      // were; they were just enormous.
      // 🐙 A common octopus: 15 cm mantle, arms 1.2× that.
      spine: { girth: 0.33, girthPeak: 0.3, torsoLengthM: 0.15 },
      neck: { segments: 0 },
      tail: { segments: 0 },
      head: { sizeFrac: 0.7, beak: 0, snoutLengthFrac: 0, eyePairs: 1, eyeSizeFrac: 0.28 },
      limbGroups: [],
      chains: [
        { attach: "head", station: 0.5, count: 8, radial: true, segments: 7, lengthFrac: 1.2, radiusFrac: 0.07, taper: 0.1, aim: -0.4, spread: 0.5, curl: 0.8, tip: "none" },
      ],
    },
  },
  {
    id: "jellyfish",
    title: "Jellyfish (radial)",
    blueprint: {
      version: 1,
      // 🌊 NO STANDING LEGS, SO NO LEG LEDGER — rescaled to real dimensions
      // only. These bodies were never in the impossible state the standers
      // were; they were just enormous.
      // 🪼 A moon jelly: 25 cm bell, tentacles trailing 1.4× that.
      spine: { torsoLengthM: 0.25, girth: 0.45, girthPeak: 0.5, crossSection: 2.0, frontTaper: 0.6, rearTaper: 0.6 },
      neck: { segments: 0 },
      tail: { segments: 0 },
      head: { sizeFrac: 0.3, beak: 0, snoutLengthFrac: 0, eyePairs: 0 },
      limbGroups: [],
      chains: [
        { attach: "body", station: 0.5, count: 10, radial: true, segments: 7, lengthFrac: 1.4, radiusFrac: 0.03, taper: 0.1, aim: -0.9, spread: 0.3, curl: 0.4, tip: "none" },
      ],
    },
  },
  // ── Growths (growth.ts): horns/antlers are unbranched or branched
  // growths welded to the head; foliage is explicitly zeroed (the growth
  // defaults are a leafy shrub for the lab's "add growth" button).
  {
    id: "ram",
    title: "Ram (curled horns)",
    blueprint: {
      version: 1,
      // 🐏 RAM, 100 kg — a ewe's heavier, horned counterpart. Trunk 1.1 →
      // 0.95 m, girth 0.22 → 0.1748, bodyHeight 0.75 → 0.9 (ema 3.05 → 1.60),
      // legs to the line. Reads 100.2 kg, σ 0.53, ema 1.60, r/line 1.00. The
      // horns ride along as a growth and are already in the mass.
      spine: { torsoLengthM: 0.95, girth: 0.1748, girthPeak: 0.4, frontTaper: 0.4, rearTaper: 0.5 },
      neck: { segments: 2, lengthFrac: 0.3, radiusFrac: 0.65, lift: 0.6 },
      tail: { segments: 2, lengthFrac: 0.2, radiusFrac: 0.3, droop: 0.8 },
      head: { sizeFrac: 0.55, beak: 0.2, snoutLengthFrac: 0.7, eyePairs: 1, eyeSizeFrac: 0.16, eyeAngle: 1.0 },
      limbGroups: [
        // FORE — elbow folds BACK.
      // 🐏 FOOT (foot-function round): stance 1 / padFrac 0 — unguligrade,
      // hoof derived from the stance. σ 0.62 → 0.57.
        { placement: "bilateral", count: 1, stationStart: 0.15, stationEnd: 0.15, lengthFrac: 0.484, radiusFrac: 0.485, taper: 0.5, attachHeight: 0.35, restLevation: -0.55, restFlexion: -0.3, stance: 1, padFrac: 0, footLengthFrac: 0.18, toeCount: 1, sizeContrast: 0 },
        // HIND — knee folds FORWARD.
        { placement: "bilateral", count: 1, stationStart: 0.85, stationEnd: 0.85, lengthFrac: 0.55, radiusFrac: 0.552, taper: 0.5, attachHeight: 0.35, restLevation: -0.55, restFlexion: 0.3, stance: 1, padFrac: 0, footLengthFrac: 0.18, toeCount: 1, sizeContrast: 0 },
      ],
      growths: [
        {
          attach: "head", placement: "bilateral", count: 2, phi: 0.62, spread: 0.9, seed: 11,
          stem: { lengthFrac: 1.3, girth: 0.06, segments: 14, taper: 0.15, lean: -0.45, waviness: 0.05, curl: -6.5, twist: 1.8, gravitropism: 0, hardness: 1, rootFlare: 1.3 },
          branching: { levels: 0 },
          foliage: { leafDensity: 0 },
        },
      ],
      posture: { bodyHeight: 0.9 },
    },
  },
  {
    id: "deer",
    title: "Deer (branching antlers)",
    blueprint: {
      version: 1,
      // 🦌 WHITE-TAILED DEER, 90 kg. Trunk 1.3 → 0.95 m; girth barely moved
      // (0.15 → 0.1523) because the shipped deer's SHAPE was already a deer —
      // it was the metre and the leg thickness that were wrong. bodyHeight
      // 0.85 → 0.95 (ema 2.26 → 1.99), legs 0.0792/0.09 → 0.536/0.600.
      // ⚠️ THE HIND radiusFrac IS AT ITS CLAMP (0.6 = LIMB_GROUP_RANGES max),
      // so this body is as thick-legged as the format allows; the honest read
      // is σ 0.60, the highest of the re-proportioned mammals. A deer really
      // is a heavy body on slim legs, and the upright ema credit is what makes
      // one work — it is NOT ballooned to hit a prettier number.
      // Reads 90.3 kg, σ 0.60, ema 1.99, r/line 1.00, fore 61%.
      spine: { torsoLengthM: 0.95, girth: 0.1523, girthPeak: 0.4 },
      neck: { segments: 4, lengthFrac: 0.6, radiusFrac: 0.45, lift: 1.1 },
      tail: { segments: 2, lengthFrac: 0.15, radiusFrac: 0.3, droop: 0.5 },
      head: { sizeFrac: 0.45, beak: 0.25, snoutLengthFrac: 0.9, eyePairs: 1, eyeSizeFrac: 0.18, eyeAngle: 1.0 },
      limbGroups: [
        // FORE — elbow folds BACK.
      // 🦌 FOOT (foot-function round): stance 1 / padFrac 0 — unguligrade,
      // hoof derived from the stance. σ 0.74 → 0.68.
        { placement: "bilateral", count: 1, stationStart: 0.15, stationEnd: 0.15, lengthFrac: 0.748, radiusFrac: 0.536, taper: 0.45, attachHeight: 0.35, restLevation: -0.6, restFlexion: -0.25, stance: 1, padFrac: 0, footLengthFrac: 0.22, toeCount: 1, sizeContrast: 0 },
        // HIND — knee folds FORWARD.
        { placement: "bilateral", count: 1, stationStart: 0.85, stationEnd: 0.85, lengthFrac: 0.85, radiusFrac: 0.6, taper: 0.45, attachHeight: 0.35, restLevation: -0.6, restFlexion: 0.25, stance: 1, padFrac: 0, footLengthFrac: 0.22, toeCount: 1, sizeContrast: 0 },
      ],
      growths: [
        {
          attach: "head", placement: "bilateral", count: 2, phi: 0.88, spread: 0.5, seed: 4,
          // Antlers: a branched growth with near-planar branching
          // (phyllotaxis ~0 keeps the tines in one sweeping plane).
          stem: { lengthFrac: 0.6, girth: 0.05, segments: 6, taper: 0.35, lean: 0.55, waviness: 0.15, curl: -1.6, twist: 0, gravitropism: 0.25, hardness: 1, rootFlare: 1.25 },
          branching: { levels: 2, branchStart: 0.25, nodes: 3, whorl: 1, phyllotaxis: 0.25, branchAngle: 0.8, lengthRatio: 0.55, radiusRatio: 0.62, jitter: 0.3 },
          foliage: { leafDensity: 0 },
        },
      ],
      posture: { bodyHeight: 0.95 },
    },
  },
  {
    id: "cow",
    title: "Cow (straight horns)",
    blueprint: {
      version: 1,
      // 🐄 HOLSTEIN, 700 kg. Trunk length was already right (1.6 m); girth
      // 0.24 → 0.2091 lands the real live weight, and bodyHeight 0.7 → 0.95
      // stands the cow up on the near-columnar legs a bovine actually has
      // (ema 3.04 → 1.54). Legs to the line: radiusFrac 0.132/0.15 →
      // 0.489/0.555. Reads 702 kg, σ 0.79, ema 1.54, r/line 1.00, fore 60%.
      spine: { torsoLengthM: 1.6, girth: 0.2091, girthPeak: 0.55 },
      neck: { segments: 2, lengthFrac: 0.25, radiusFrac: 0.7, lift: 0.4 },
      tail: { segments: 5, lengthFrac: 0.6, radiusFrac: 0.2, droop: 1.0 },
      head: { sizeFrac: 0.5, beak: 0.15, snoutLengthFrac: 0.8, eyePairs: 1, eyeSizeFrac: 0.16, eyeAngle: 1.1 },
      limbGroups: [
        // FORE — elbow folds BACK.
      // 🐄 FOOT (foot-function round): stance 1 / padFrac 0 — unguligrade,
      // hoof derived from the stance. Its single hoof used to be DRAWN at ×3.0
      // of its authored length by the digit floor; it is now exactly the dial.
      // σ 0.92 → 0.84.
        { placement: "bilateral", count: 1, stationStart: 0.15, stationEnd: 0.15, lengthFrac: 0.528, radiusFrac: 0.489, taper: 0.55, attachHeight: 0.35, restLevation: -0.55, restFlexion: -0.3, stance: 1, padFrac: 0, footLengthFrac: 0.18, toeCount: 1, sizeContrast: 0 },
        // HIND — knee folds FORWARD.
        { placement: "bilateral", count: 1, stationStart: 0.85, stationEnd: 0.85, lengthFrac: 0.6, radiusFrac: 0.555, taper: 0.55, attachHeight: 0.35, restLevation: -0.55, restFlexion: 0.3, stance: 1, padFrac: 0, footLengthFrac: 0.18, toeCount: 1, sizeContrast: 0 },
      ],
      growths: [
        {
          attach: "head", placement: "bilateral", count: 2, phi: 0.72, spread: 0.85, seed: 2,
          stem: { lengthFrac: 0.4, girth: 0.11, segments: 6, taper: 0.1, lean: 0.25, waviness: 0, curl: 1.8, twist: 0.4, gravitropism: 0.15, hardness: 1, rootFlare: 1.2 },
          branching: { levels: 0 },
          foliage: { leafDensity: 0 },
        },
      ],
      posture: { bodyHeight: 0.95 },
    },
  },
  {
    id: "sheep",
    title: "Sheep (woolly)",
    blueprint: {
      version: 1,
      // Stocky woolly barrel on short legs: girth up, legs down, blunt
      // front/rear tapers so the fleece reads as one rounded mass.
      // 🐑 EWE, 80 kg. Trunk 1.0 → 0.85 m, girth 0.28 → 0.1968. ⚠️ WOOL IS
      // TISSUE HERE, by the user's ruling: the fleece is not modelled
      // separately, so the girth that lands 80 kg is the SHORN animal's, and
      // the barrel reads a little slimmer than a fleeced sheep looks.
      // bodyHeight 0.65 → 0.95 (ema 3.41 → 1.43); legs to the line.
      // Reads 80.1 kg, σ 0.40, ema 1.43, r/line 1.00.
      spine: { torsoLengthM: 0.85, girth: 0.1968, girthPeak: 0.5, frontTaper: 0.35, rearTaper: 0.4 },
      neck: { segments: 2, lengthFrac: 0.22, radiusFrac: 0.6, lift: 0.5 },
      tail: { segments: 2, lengthFrac: 0.18, radiusFrac: 0.25, droop: 0.9 },
      // A small bare head poking out of the fleece.
      head: { sizeFrac: 0.38, beak: 0.15, snoutLengthFrac: 0.6, eyePairs: 1, eyeSizeFrac: 0.16, eyeAngle: 1.0 },
      limbGroups: [
        // FORE — elbow folds BACK.
      // 🐑 FOOT (foot-function round): stance 1 / padFrac 0 — unguligrade.
      // σ 0.46 → 0.45. ⚠️ ITS HIND ANKLE DOES NOT REACH THE COLUMN: the pitch
      // is SOLVED, not dialled, and on a leg this short the strain minimum sits
      // at 63° rather than 83°, which leaves the knee 7.9 cm ahead of the ball
      // and prices the hind pair at ema 3.06 (fore 1.53). That is a body
      // PROPORTION cost, not a foot cost — σ is untouched because the leg is
      // thick — and it belongs to whoever next re-proportions this animal.
        { placement: "bilateral", count: 1, stationStart: 0.18, stationEnd: 0.18, lengthFrac: 0.396, radiusFrac: 0.444, taper: 0.5, attachHeight: 0.35, restLevation: -0.55, restFlexion: -0.3, stance: 1, padFrac: 0, footLengthFrac: 0.16, toeCount: 1, sizeContrast: 0 },
        // HIND — knee folds FORWARD.
        { placement: "bilateral", count: 1, stationStart: 0.82, stationEnd: 0.82, lengthFrac: 0.45, radiusFrac: 0.505, taper: 0.5, attachHeight: 0.35, restLevation: -0.55, restFlexion: 0.3, stance: 1, padFrac: 0, footLengthFrac: 0.16, toeCount: 1, sizeContrast: 0 },
      ],
      // Wool: pale cream body over a lighter belly; dark hooves/face accent.
      skin: { baseColor: "#e6dfcd", bellyColor: "#d8d0bc", accentColor: "#4a4038" },
      posture: { bodyHeight: 0.95 },
    },
  },
  // ── THE TWO DINOSAURS ───────────────────────────────────────────────────
  // Added 2026-09-03 as the stress ledger's STRESS TESTS, at the user's ask.
  // Everything else in this file is an animal somebody has held; these two are
  // the extremes the physics is supposed to survive — a seven-tonne biped whose
  // whole balance problem is a tail, and a twenty-five-tonne quadruped that can
  // only work if its legs are columns. If the ledger is right about anything it
  // has to be right about these.
  //
  // 🚨 BOTH ARE PNEUMATISED (`spine.density` < 1) and that is anatomy, not a
  // dial to make the numbers pass: saurischian dinosaurs had air sacs invading
  // the vertebrae, the same system a modern bird has. Theropod ≈ 0.85,
  // sauropod ≈ 0.8. Density is MASS-ONLY (physio.ts) — it makes them lighter,
  // it does not make their legs stronger.
  {
    id: "tyrannosaur",
    title: "Tyrannosaur (biped stress test)",
    blueprint: {
      version: 1,
      // 🦖 ~7 t, ~10 m nose to tail tip — but on a trunk of only 2.6 m.
      // 🚨 A THEROPOD'S TRUNK IS SHORT AND DEEP, and getting that right is
      // worth more than any leg dial: at the 3.7 m first draft the same 7 t
      // needed girth 0.18, which capped the leg at radiusFrac 0.6 × a small
      // trunk radius and read σ 4.5. Packing the same mass into a 2.6 m trunk
      // makes the body 1.6 m deep (which is a T. rex) and the SAME clamped
      // radiusFrac then draws a leg at r/line 1.20 — σ 1.88. Nothing about the
      // legs changed; the ribcage did.
      // Laterally narrow (crossSection 0.85) — slab-sided, not a barrel.
      spine: { torsoSegments: 6, torsoLengthM: 2.6, girth: 0.2895, girthPeak: 0.45, density: 0.85, frontTaper: 0.4, rearTaper: 0.3, crossSection: 0.85 },
      // Short and thick, like a theropod's — and the shorter it is, the less
      // of the skull's weight hangs in front of the hips (see the balance note
      // under `posture`).
      neck: { segments: 3, lengthFrac: 0.22, radiusFrac: 0.62, lift: 0.55 },
      // 🚨 THE COUNTERWEIGHT. This is not decoration: the CoM solve has to
      // balance a 1.5 m skull cantilevered off the front over feet that sit
      // under the HIPS, and the only thing on the other side of the fulcrum is
      // the tail. Long (1.5× the trunk), thick at the root (radiusFrac 0.7),
      // and held out level rather than drooping (negative droop).
      tail: { segments: 8, lengthFrac: 2.1, radiusFrac: 0.7, droop: -0.2 },
      head: {
        sizeFrac: 0.55, lengthFrac: 1.55, braincaseDome: 0.7, crossSection: 0.78,
        foreheadHeight: 0.38, foreheadLength: 0.12, foreheadSlope: 0.1,
        beak: 0.1, snoutLengthFrac: 1.1, snoutSegments: 2, snoutRadiusFrac: 0.62,
        muzzleSquash: 0.25, snoutFlatten: 0.85, snoutCurve: 0.05,
        mouthOpen: 0.55, jawDepth: 0.34, jawOffset: 0.05,
        eyePairs: 1, eyeSizeFrac: 0.1, eyeAngle: 0.5, eyeHeight: 0.72, eyeBulge: 0.3,
        brow: 0.4, cheek: 0.25, jowl: 0.1, chin: 0.1,
      },
      // Trunk held HORIZONTAL (bodyPitch 0) — the tail-balanced theropod pose,
      // not the tripod the old museum mounts used.
      // MEASURED, at rest, gravity 1: 6980 kg, σ 1.88, ema 1.68, r/line 1.20,
      // 2/2 grounded, arms `role: "manipulator"` with force 0, neck σ 1.01,
      // 4.0 m to the top of the head.
      //
      // 🚨 THE BALANCE TEST FAILED, AND IT FOUND A REAL BUG — IN THE POSE
      // LAYER, NOT IN THIS BODY. `support.body.tipping` reads 0.52 m: the
      // whole-body CoM sits half a metre in front of the feet. It cannot be
      // fixed from this file, and the reason is worth writing down, because
      // this is the first body ever built that could expose it:
      //   • `skeleton.ts` leans the body over its feet using a LEGACY CoM that
      //     sums TORSO + TAIL ONLY (its own comment: "head, neck and limbs are
      //     invisible to it … the stress ledger supersedes this in a later
      //     phase"). The ledger's `body.com` is the WHOLE body.
      //   • On a quadruped the two agree closely enough to hide. On a
      //     horizontal-trunked biped with a skull worth 11% of the mass hanging
      //     3.5 m forward they differ by half a metre.
      //   • And leaning cannot close it: the lean TRANSLATES the trunk, the
      //     hips ride on the trunk, so the feet re-plant under the shifted hips
      //     and the CoM↔CoP gap is invariant under the shift.
      // Which is why making the tail HEAVIER makes it worse, not better — a
      // heavier tail drags the legacy CoM backward and the lean answers by
      // pushing the body further forward. Everything that did help (a shorter
      // neck, a slightly smaller skull, a touch of trunk pitch) is here; the
      // rest waits for the pose layer to move onto the ledger's CoM.
      //
      // ⚠️ σ 1.88 IS OVER 1 AND IT IS REPORTED, NOT TUNED AWAY. Decomposed:
      // 0.364 (a real quadruped's resting read) × 2 (a BIPED's leg carries
      // W/2, not W/4) × 0.83 (ema/2) × 4.41 ((7000/30)^0.272, the allometric
      // residual physio.ts documents — bone circumference rises as M^0.364 so
      // stress still climbs as M^0.272, and the ema credit that pays for it
      // bottoms out at a column). Two of those three are the model saying
      // exactly what palaeontology says: T. rex sat at the upper size limit
      // for a bipedal walker. See the round report for the third.
      posture: { bodyPitch: 0.15, bodyHeight: 1 },
      limbGroups: [
        // FORE — the famous two-fingered arms. Short (12% of the trunk),
        // socketed HIGH on the chest, and opposed-fingered, so they can never
        // reach the ground: the ledger must report them `role: "manipulator"`
        // and they must never take a newton. Elbow folds BACK, like every
        // tetrapod forelimb.
        { placement: "bilateral", count: 1, stationStart: 0.24, stationEnd: 0.24, lengthFrac: 0.17, radiusFrac: 0.06, taper: 0.5, attachHeight: 0.62, restProtraction: 0.35, restLevation: -0.2, restFlexion: -0.6, flexRange: 0.6, footLengthFrac: 0.18, stance: 0, toeCount: 2, toeLengthFrac: 0.9, toeCurl: 0.6, opposition: 0.4, sizeContrast: 0 },
        // HIND — the two pillars that carry everything.
        // 🚨 THE KNEE POINTS FORWARD (restFlexion > 0). What everyone pictures
        // as a dinosaur's "backward knee" is the ANKLE: a theropod is
        // digitigrade on a long metatarsus, so the joint at mid-leg height
        // bending backward is the heel. That is `footLengthFrac` + `stance` +
        // `ankleRange` here, NOT a negative flexion — a negative flexion would
        // be a mammal's elbow on a hind leg, which no archosaur has.
        // 🦖 FOOT (foot-function round): stance 0.7 / padFrac 0, toes lengthened
        // 0.55 → 0.8 — A BIRD'S FOOT. High stance carries the ankle up the long
        // metatarsus (which is the joint everyone misreads as a backward knee),
        // but 0.7 is deliberately BELOW `TOE_ALIGN_START`: a theropod stands on
        // long FLAT toes, not on their tips, so it gets no hoof. σ 1.61,
        // unchanged — its overrun is the missing graviportal bone fraction,
        // which is not this round's.
        { placement: "bilateral", count: 1, stationStart: 0.88, stationEnd: 0.88, sizeContrast: 0, lengthFrac: 0.85, radiusFrac: 0.6, taper: 0.5, attachHeight: 0.3, restProtraction: 0, restLevation: -0.75, restFlexion: 0.25, flexRange: 0.7, legTwist: 0, footLengthFrac: 0.16, stance: 0.7, padFrac: 0, ankleRange: 1, toeCount: 3, toeLengthFrac: 0.8, toeSpread: 0.5, toeContrast: 0.15, opposition: 0, toeCurl: 0.15 },
      ],
      skin: { baseColor: "#6b6a55", bellyColor: "#b8b394", accentColor: "#3e3d30" },
    },
  },
  {
    id: "sauropod",
    title: "Sauropod (columnar stress test)",
    blueprint: {
      version: 1,
      // 🦕 ~25 t on a 6.5 m trunk — a mid-size sauropod (an adult Diplodocus,
      // a young Brachiosaurus), not the 60 t record-holders.
      spine: { torsoSegments: 7, torsoLengthM: 6.5, girth: 0.1491, girthPeak: 0.5, density: 0.8, frontTaper: 0.35, rearTaper: 0.35, crossSection: 1 },
      // The neck: eight segments, longer than the trunk, carried up.
      neck: { segments: 8, lengthFrac: 1.05, radiusFrac: 0.3, lift: 0.85 },
      tail: { segments: 10, lengthFrac: 1.5, radiusFrac: 0.5, droop: -0.15 },
      // A famously tiny head on a body this size.
      head: { sizeFrac: 0.16, lengthFrac: 1.3, braincaseDome: 0.8, beak: 0.15, snoutLengthFrac: 0.8, snoutRadiusFrac: 0.6, mouthOpen: 0.25, jawDepth: 0.12, eyePairs: 1, eyeSizeFrac: 0.22, eyeAngle: 1.0, eyeHeight: 0.6 },
      // 🚨 COLUMNAR IS THE WHOLE POINT. bodyHeight 1 and restFlexion ±0.08 —
      // as close to a straight pillar as the fore/hind knee law allows, which
      // is Biewener's endpoint: EMA rises with size until the limb is a
      // column carrying nothing but the weight. The falsifiability pin bends
      // these knees and watches the number get worse.
      // The foot is SHORT and FLAT (footLengthFrac 0.1, stance 0): a sauropod
      // stands on a broad pad, not on its toes, and a raised sole pushes at
      // its TIP — which charged the knee the whole foot as a lever and was the
      // single largest ema cost on this body (2.10 → 1.41).
      //
      // MEASURED, at rest, gravity 1: 25 000 kg, σ 2.01, ema 1.41 AT THE HIP
      // (the only quadruped in the registry whose knee is straight enough for
      // the hip to bind — knee angle 179°), 4/4 grounded, r/line 0.97, fore
      // 59%. The ema is the win: the columnar-limb endpoint, reached.
      // ⚠️ NECK σ 3.94, AND THAT NUMBER IS NOT ON THE ANATOMICAL SCALE. It is
      // measured against BEND_STRENGTH = 3, which physio.ts flags as the one
      // remaining FITTED constant — deriving it the way the crushing side was
      // derived would give ≈ 0.20, i.e. fifteen times stricter, and would
      // re-decide every carry refusal in `canBear` at the same time. Left
      // alone deliberately this round. Read it as "the longest cantilever in
      // the registry, on a scale that has not been calibrated yet".
      posture: { bodyPitch: 0, bodyHeight: 1 },
      limbGroups: [
        // FORE — elbow folds BACK.
      // 🦕 FOOT (foot-function round): stance 0.6 / padFrac 1 / footLengthFrac
      // 0.2. THE HACK IS RETIRED. `footLengthFrac: 0.1` was never a fact about
      // a sauropod — it was a 25-tonne animal given a stub for a foot because a
      // raised sole pushed at its TIP and charged the knee the whole foot as a
      // lever. A sauropod stands on a broad fibro-fatty PAD, so the pad now
      // runs the load straight down and the foot is back to a believable 0.2.
      // Measured, rest, gravity 1: foot 0.1 + no pad → 25 843 kg, σ 2.251, ema
      // 2.29 (knee); foot 0.2 + pad 1 → 25 877 kg, σ 2.145, ema 1.48 (hip).
      // Both the foot and the pad ADD mass and it still comes out ahead on
      // every number. (σ is still over 1: that is the missing graviportal bone
      // fraction, which is not this round's.)
        { placement: "bilateral", count: 1, stationStart: 0.12, stationEnd: 0.12, sizeContrast: 0, lengthFrac: 0.42, radiusFrac: 0.6, taper: 0.72, attachHeight: 0.25, restProtraction: 0, restLevation: -1, restFlexion: -0.08, flexRange: 0.3, footLengthFrac: 0.2, stance: 0.6, padFrac: 1, ankleRange: 0.5, toeCount: 5, toeLengthFrac: 0.18, toeSpread: 0.5, toeContrast: 0, toeCurl: 0.05 },
        // HIND — knee folds FORWARD.
        { placement: "bilateral", count: 1, stationStart: 0.88, stationEnd: 0.88, sizeContrast: 0, lengthFrac: 0.46, radiusFrac: 0.6, taper: 0.72, attachHeight: 0.25, restProtraction: 0, restLevation: -1, restFlexion: 0.08, flexRange: 0.3, footLengthFrac: 0.2, stance: 0.6, padFrac: 1, ankleRange: 0.5, toeCount: 5, toeLengthFrac: 0.18, toeSpread: 0.5, toeContrast: 0, toeCurl: 0.05 },
      ],
      skin: { baseColor: "#7a7466", bellyColor: "#c2bca8", accentColor: "#4a4638" },
    },
  },
  // ── Plants — nothing but a growth on a nub. Plant height ≈ 0.1 m
  // (the nub torso) × stem.lengthFrac; skin.baseColor is the stem color.
  {
    id: "oak",
    title: "Oak (tree)",
    blueprint: plant(
      {
        seed: 12,
        stem: { lengthFrac: 300, girth: 0.035, segments: 6, taper: 0.6, lean: 0, waviness: 0.35, flatten: 0, lobes: 0, curl: 0, twist: 0, gravitropism: 0.35, hardness: 0.55, rootFlare: 1.8 },
        branching: { levels: 3, branchStart: 0.45, nodes: 3, whorl: 3, phyllotaxis: 2.4, branchAngle: 0.85, lengthRatio: 0.55, radiusRatio: 0.55, jitter: 0.55 },
        foliage: { leafDensity: 2.5, leafSizeFrac: 1.1, leafAspect: 0.6, leafDroop: 0.15, leafColor: "#3f6d2e" },
      },
      { name: "oak", skin: { baseColor: "#6b5236", accentColor: "#463521" } },
    ),
  },
  {
    id: "grass",
    title: "Grass tuft",
    blueprint: plant(
      {
        seed: 5,
        // A tuft = one tiny hidden stem that immediately fans into blades
        // (level-1 branches with spiral phyllotaxis azimuths). Blades ARE
        // flattened stems: flatten 1 → two-sided ribbons, no leaf cards.
        stem: { lengthFrac: 0.8, girth: 0.09, segments: 2, taper: 0.9, lean: 0, waviness: 0, flatten: 0.75, lobes: 0, curl: 0, twist: 0, gravitropism: 0, hardness: 0, rootFlare: 1 },
        branching: { levels: 1, branchStart: 0, nodes: 4, whorl: 3, phyllotaxis: 2.4, branchAngle: 0.55, lengthRatio: 0.9, radiusRatio: 0.7, jitter: 0.7 },
        foliage: { leafDensity: 0 },
      },
      { name: "grass tuft", skin: { baseColor: "#5a8a3c", bellyColor: "#4a7431", accentColor: "#7aa04a" } },
    ),
  },
  {
    id: "mushroom",
    title: "Mushroom",
    blueprint: plant(
      {
        seed: 3,
        stem: { lengthFrac: 2.8, girth: 0.15, segments: 3, taper: 0.8, lean: 0.15, waviness: 0.25, flatten: 0, lobes: 0, curl: 0, twist: 0, gravitropism: 0.4, hardness: 0, rootFlare: 1.5 },
        branching: { levels: 0 },
        foliage: { leafDensity: 0 },
        // The cap is a terminal oblate fruit, sessile (stemFrac 0) so it
        // sits ON the stem tip aligned with it instead of dangling.
        fruit: { sizeM: 0.2, aspect: 0.4, bulge: 0.6, neck: 0.4, stemFrac: 0, color: "#b5402f" },
        fruitDensity: 1,
        fruitPlacement: "terminal",
      },
      { name: "mushroom", skin: { baseColor: "#d8cbb2", accentColor: "#b3a488" } },
    ),
  },
  {
    id: "saguaro",
    title: "Saguaro (cactus)",
    blueprint: plant(
      {
        seed: 9,
        // Ribbed column (lobes); arms curve skyward via gravitropism.
        stem: { lengthFrac: 40, girth: 0.055, segments: 7, taper: 0.75, lean: 0, waviness: 0.12, flatten: 0, lobes: 9, curl: 0, twist: 0, gravitropism: 0.95, hardness: 0.15, rootFlare: 1.1 },
        branching: { levels: 1, branchStart: 0.3, nodes: 2, whorl: 1, phyllotaxis: 2.4, branchAngle: 1.25, lengthRatio: 0.45, radiusRatio: 0.75, jitter: 0.45 },
        foliage: { leafDensity: 0 },
        flowers: { flowerDensity: 0.7, petalCount: 8, flowerSizeFrac: 0.35, flowerColor: "#f2e8c9" },
      },
      { name: "saguaro", skin: { baseColor: "#4f7a42", accentColor: "#3c5f33" } },
    ),
  },
  {
    id: "bush",
    title: "Bush (berries)",
    blueprint: plant(
      {
        seed: 21,
        stem: { lengthFrac: 12, girth: 0.03, segments: 4, taper: 0.55, lean: 0.2, waviness: 0.5, flatten: 0, lobes: 0, curl: 0, twist: 0, gravitropism: 0.25, hardness: 0.5, rootFlare: 1.2 },
        // Branches from the very base — no bare trunk.
        branching: { levels: 2, branchStart: 0.05, nodes: 3, whorl: 3, phyllotaxis: 2.4, branchAngle: 0.95, lengthRatio: 0.6, radiusRatio: 0.6, jitter: 0.6 },
        foliage: { leafDensity: 3.5, leafSizeFrac: 1.3, leafAspect: 0.55, leafDroop: 0, leafColor: "#2f5c2b" },
        fruit: { sizeM: 0.02, aspect: 1, stemFrac: 0.6, color: "#a93226" },
        fruitDensity: 0.5,
        fruitPlacement: "along",
      },
      { name: "berry bush", skin: { baseColor: "#5c4630", accentColor: "#41321f" } },
    ),
  },
  // ── Orchard plants — shoot growths whose terminal twigs BEAR fruit
  // (fruitDensity > 0), so towns can plant orchards that visibly carry the
  // fruit kinds the market items above/below use. Visual plausibility at
  // town-scenery distance is the bar, not botany.
  {
    id: "apple_tree",
    title: "Apple tree",
    blueprint: plant(
      {
        seed: 17,
        // A smaller, rounder oak habit with red fruit dangling off the twigs.
        stem: { lengthFrac: 40, girth: 0.04, segments: 5, taper: 0.55, lean: 0, waviness: 0.3, flatten: 0, lobes: 0, curl: 0, twist: 0, gravitropism: 0.3, hardness: 0.6, rootFlare: 1.6 },
        branching: { levels: 3, branchStart: 0.35, nodes: 3, whorl: 3, phyllotaxis: 2.4, branchAngle: 0.9, lengthRatio: 0.6, radiusRatio: 0.55, jitter: 0.5 },
        foliage: { leafDensity: 2.2, leafSizeFrac: 1.0, leafAspect: 0.6, leafDroop: 0.1, leafColor: "#4a7a33" },
        fruit: { sizeM: 0.11, aspect: 0.95, bulge: 0.48, neck: 0.22, tipTaper: 0.22, stemFrac: 0.4, color: "#c0392b" },
        fruitDensity: 0.6,
        fruitPlacement: "along",
      },
      { name: "apple tree", skin: { baseColor: "#6b5236", accentColor: "#463521" } },
    ),
  },
  {
    id: "banana_plant",
    title: "Banana plant",
    blueprint: plant(
      {
        seed: 23,
        // Palm-ish habit: a bare green trunk that only fronds at the crown
        // (branchStart high), long drooping leaves, curved yellow fruit
        // hanging among them.
        stem: { lengthFrac: 28, girth: 0.06, segments: 5, taper: 0.75, lean: 0.1, waviness: 0.15, flatten: 0, lobes: 0, curl: 0, twist: 0, gravitropism: 0.5, hardness: 0.45, rootFlare: 1.4 },
        branching: { levels: 1, branchStart: 0.85, nodes: 2, whorl: 4, phyllotaxis: 2.4, branchAngle: 1.15, lengthRatio: 0.4, radiusRatio: 0.45, jitter: 0.35 },
        foliage: { leafDensity: 4, leafSizeFrac: 2, leafAspect: 0.3, leafDroop: -0.5, leafColor: "#3f7a34" },
        fruit: { sizeM: 0.05, aspect: 5, bulge: 0.5, neck: 0.35, tipTaper: 0.45, curvature: 1.3, stemFrac: 0.3, color: "#e3c018" },
        fruitDensity: 1.2,
        fruitPlacement: "along",
      },
      { name: "banana plant", skin: { baseColor: "#7a8a4a", accentColor: "#5c6b36" } },
    ),
  },
  {
    id: "grape_vine",
    title: "Grape vine",
    blueprint: plant(
      {
        seed: 29,
        // A leafy trellis bush hung with small purple berries — dense
        // fruitDensity so they read as clusters at a distance.
        stem: { lengthFrac: 15, girth: 0.03, segments: 4, taper: 0.5, lean: 0.25, waviness: 0.55, flatten: 0, lobes: 0, curl: 0, twist: 0, gravitropism: 0.2, hardness: 0.55, rootFlare: 1.2 },
        branching: { levels: 2, branchStart: 0.1, nodes: 3, whorl: 3, phyllotaxis: 2.4, branchAngle: 1.0, lengthRatio: 0.65, radiusRatio: 0.6, jitter: 0.6 },
        foliage: { leafDensity: 3.5, leafSizeFrac: 1.4, leafAspect: 0.8, leafDroop: 0, leafColor: "#3f6d2e" },
        fruit: { sizeM: 0.035, aspect: 1.15, bulge: 0.5, neck: 0.1, tipTaper: 0.1, stemFrac: 0.5, color: "#5b2a6e" },
        fruitDensity: 2,
        fruitPlacement: "along",
      },
      { name: "grape vine", skin: { baseColor: "#5c4630", accentColor: "#41321f" } },
    ),
  },
  {
    id: "carrot_plant",
    title: "Carrot plant",
    blueprint: plant(
      {
        seed: 31,
        // Feathery rosette over a buried root: many near-ground stems fanned
        // wide, narrow ferny leaves, and the "fruit" is the orange crown
        // showing at the soil line — the harvest reads without unearthing
        // geometry (the pulled root itself is the standalone `carrot` body).
        stem: { lengthFrac: 6, girth: 0.02, segments: 3, taper: 0.6, lean: 0.3, waviness: 0.3, flatten: 0, lobes: 0, curl: 0, twist: 0, gravitropism: 0.1, hardness: 0.3, rootFlare: 1.1 },
        branching: { levels: 1, branchStart: 0.05, nodes: 2, whorl: 6, phyllotaxis: 2.4, branchAngle: 1.2, lengthRatio: 0.8, radiusRatio: 0.6, jitter: 0.4 },
        foliage: { leafDensity: 6, leafSizeFrac: 2.2, leafAspect: 0.15, leafDroop: 0.15, leafColor: "#4c8a3a" },
        fruit: { sizeM: 0.055, aspect: 2.6, bulge: 0.35, neck: 0.05, tipTaper: 0.8, stemFrac: 0, color: "#e2762d" },
        fruitDensity: 0.5,
        fruitPlacement: "along",
      },
      { name: "carrot plant", skin: { baseColor: "#4c8a3a", accentColor: "#3a6b2c" } },
    ),
  },
  // ── Fruit samples & root vegetables (type "fruit" / "root"). Each is
  // ONE determinate fruit body — the shape lives in the profile (bulge /
  // neck / tipTaper), curvature, lobes, and pole crown. These double as
  // the market-item catalogue (buildFruitMesh renders one standalone).
  {
    id: "apple",
    title: "Apple",
    blueprint: plant(
      { type: "fruit", seed: 1, fruit: { sizeM: 0.085, aspect: 0.95, bulge: 0.48, neck: 0.22, tipTaper: 0.22, stemFrac: 0, color: "#c0392b" } },
      { name: "apple", skin: { baseColor: "#6a5a2e" } },
    ),
  },
  {
    id: "banana",
    title: "Banana",
    blueprint: plant(
      { type: "fruit", seed: 2, fruit: { sizeM: 0.035, aspect: 5.5, bulge: 0.5, neck: 0.35, tipTaper: 0.45, curvature: 1.4, stemFrac: 0, color: "#e3c018" } },
      { name: "banana", skin: { baseColor: "#6a5a2e" } },
    ),
  },
  {
    id: "grape",
    title: "Grape",
    blueprint: plant(
      // One berry of the bunch — the market/ground item the grape vine yields.
      { type: "fruit", seed: 9, fruit: { sizeM: 0.025, aspect: 1.2, bulge: 0.5, neck: 0.12, tipTaper: 0.1, stemFrac: 0, color: "#5b2a6e" } },
      { name: "grape", skin: { baseColor: "#3f7a34" } },
    ),
  },
  {
    id: "pear",
    title: "Pear",
    blueprint: plant(
      // Bulb at the base (bottom), tapering to a neck at the tip (top).
      { type: "fruit", seed: 3, fruit: { sizeM: 0.09, aspect: 1.5, bulge: 0.32, neck: 0, tipTaper: 0.5, curvature: 0.12, stemFrac: 0, color: "#b5c23a" } },
      { name: "pear", skin: { baseColor: "#5f7a2e" } },
    ),
  },
  {
    id: "strawberry",
    title: "Strawberry",
    blueprint: plant(
      // Point at the base (bottom), widening to a leafy calyx crown at the
      // top — crownLeaves fan from the tip pole.
      { type: "fruit", seed: 4, fruit: { sizeM: 0.05, aspect: 1.25, bulge: 0.72, neck: 0.85, tipTaper: 0, stemFrac: 0, crownLeaves: 6, crownSize: 0.6, color: "#d8352a" } },
      { name: "strawberry", skin: { baseColor: "#3f7a34" } },
    ),
  },
  {
    id: "pumpkin",
    title: "Pumpkin",
    blueprint: plant(
      // Squat + ribbed (lobes); sits near the ground on a stub stalk.
      { type: "fruit", seed: 5, stem: { lengthFrac: 0.3, girth: 0.02 }, fruit: { sizeM: 0.3, aspect: 0.72, bulge: 0.5, neck: 0.18, tipTaper: 0.18, lobes: 8, stemFrac: 0, color: "#d1892f" } },
      { name: "pumpkin", skin: { baseColor: "#4f6a2a" } },
    ),
  },
  {
    id: "pineapple",
    title: "Pineapple",
    blueprint: plant(
      // Barrel body + a big spray of crown leaves at the top.
      { type: "fruit", seed: 6, fruit: { sizeM: 0.14, aspect: 1.55, bulge: 0.5, neck: 0.12, tipTaper: 0.12, lobes: 6, stemFrac: 0, crownLeaves: 9, crownSize: 1.0, color: "#c69a2e" } },
      { name: "pineapple", skin: { baseColor: "#5f7a2e" } },
    ),
  },
  {
    id: "carrot",
    title: "Carrot (root)",
    blueprint: plant(
      // Downward taper to a point, leafy top at the ground (calyx crown).
      { type: "root", seed: 7, fruit: { sizeM: 0.05, aspect: 3.4, bulge: 0.14, neck: 0, tipTaper: 1, stemFrac: 0, calyxLeaves: 6, crownSize: 1.4, color: "#e07b1a" } },
      { name: "carrot", skin: { baseColor: "#3f7a34" } },
    ),
  },
  {
    id: "beet",
    title: "Beet (root)",
    blueprint: plant(
      { type: "root", seed: 8, fruit: { sizeM: 0.09, aspect: 1.15, bulge: 0.35, neck: 0, tipTaper: 0.85, stemFrac: 0, calyxLeaves: 5, crownSize: 1.1, color: "#7b1f3a" } },
      { name: "beet", skin: { baseColor: "#3f7a34" } },
    ),
  },
];
