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

import { plantBlueprint } from "./blueprint";

export interface CreatureExample {
  name: string;
  blueprint: Record<string, unknown>;
}

const plant = (
  growth: Parameters<typeof plantBlueprint>[0],
  opts?: Parameters<typeof plantBlueprint>[1],
): Record<string, unknown> => plantBlueprint(growth, opts) as unknown as Record<string, unknown>;

export const CREATURE_EXAMPLES: CreatureExample[] = [
  {
    name: "Quadruped (default)",
    blueprint: { version: 1 },
  },
  {
    name: "Snake (limbless)",
    blueprint: {
      version: 1,
      spine: { torsoLengthM: 3.0, girth: 0.05, girthPeak: 0.3, torsoSegments: 11, frontTaper: 0.5, rearTaper: 0.4 },
      neck: { segments: 2, lengthFrac: 0.2, radiusFrac: 0.7, lift: 0.2 },
      tail: { segments: 9, lengthFrac: 1.6, radiusFrac: 0.6, droop: 0.4 },
      head: { sizeFrac: 0.5, beak: 0.15, snoutLengthFrac: 0.4, eyePairs: 1, eyeSizeFrac: 0.18, eyeAngle: 0.9 },
      limbGroups: [],
    },
  },
  {
    name: "Fish (fins + tail)",
    blueprint: {
      version: 1,
      spine: { crossSection: 0.5, girth: 0.2, girthPeak: 0.5, torsoLengthM: 1.0 },
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
    name: "Stingray (flat + stinger)",
    blueprint: {
      version: 1,
      spine: { crossSection: 2.6, girth: 0.26, girthPeak: 0.4, torsoLengthM: 1.4, frontTaper: 0.5, rearTaper: 0.7 },
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
    name: "Dimetrodon (sail)",
    blueprint: {
      version: 1,
      spine: { torsoLengthM: 1.4, girth: 0.16, girthPeak: 0.5 },
      neck: { segments: 2, lengthFrac: 0.25, radiusFrac: 0.5, lift: 0.3 },
      tail: { segments: 5, lengthFrac: 1.0, radiusFrac: 0.4, droop: 0.4 },
      head: { sizeFrac: 0.5, beak: 0.4, snoutLengthFrac: 0.8 },
      posture: { bodyHeight: 0.4 },
      // Sprawled reptilian legs (lateral socket → elbows-out, feet wide).
      limbGroups: [
        { placement: "bilateral", count: 2, stationStart: 0.2, stationEnd: 0.82, attachHeight: 0.42, restProtraction: 0, restLevation: 0.05, restFlexion: 0, radiusFrac: 0.07, lengthFrac: 0.5, stance: 0.4, toeCount: 4, toeSpread: 0.7 },
      ],
      membranes: [{ edge: "dorsal", start: 0.28, end: 0.78, height: 0.7, heightPeak: 0.5, rays: 10 }],
    },
  },
  {
    name: "Crocodile (long jaw)",
    blueprint: {
      version: 1,
      // The head-variety showcase: an elongated flat skull whose face
      // follows the loft axis, a long flat snout with a working jaw, and
      // periscope eyes riding high on the crown.
      spine: { torsoLengthM: 1.5, girth: 0.15, girthPeak: 0.5, crossSection: 1.6 },
      neck: { segments: 1, lengthFrac: 0.15, radiusFrac: 0.75, lift: 0.1 },
      tail: { segments: 6, lengthFrac: 1.2, radiusFrac: 0.6, droop: 0.25 },
      head: {
        // A flat skull roof (low braincaseDome), a long broad snout
        // (crossSection wide), a full-length gape and a slender jaw, with
        // periscope eyes riding high on the crown.
        sizeFrac: 0.55, lengthFrac: 1.7, braincaseDome: 0.6, crossSection: 1.5,
        // Snout leaves near the TOP of the flat skull (foreheadHeight high),
        // straight off the front — no forehead at all.
        foreheadHeight: 0.8, foreheadLength: 0.05, foreheadSlope: -0.1,
        beak: 0.15, snoutLengthFrac: 1.6, snoutRadiusFrac: 0.5, muzzleSquash: 0.35,
        snoutFlatten: 1.8, snoutCurve: -0.1, mouthOpen: 1, jawDepth: 0.12, jawOffset: 0,
        eyePairs: 1, eyeSizeFrac: 0.14, eyeAngle: 0.55, eyeHeight: 0.9, eyeBulge: 0.75,
      },
      posture: { bodyHeight: 0.25 },
      // Sprawled reptilian legs, belly riding low.
      limbGroups: [
        { placement: "bilateral", count: 2, stationStart: 0.18, stationEnd: 0.8, attachHeight: 0.45, restLevation: 0.1, restFlexion: 0, radiusFrac: 0.08, lengthFrac: 0.42, stance: 0.5, toeCount: 4, toeSpread: 0.6 },
      ],
      skin: { baseColor: "#4a5d3a", bellyColor: "#c9c2a0", accentColor: "#2e3a24" },
    },
  },
  {
    name: "Winged biped (raptor)",
    blueprint: {
      version: 1,
      posture: { bodyPitch: 0.85, bodyHeight: 0.95 },
      neck: { segments: 2, lengthFrac: 0.3, radiusFrac: 0.5, lift: 0.7 },
      tail: { segments: 4, lengthFrac: 0.6, radiusFrac: 0.4, droop: 0.4 },
      // Hard hooked beak with a working lower mandible — no hands and no
      // free arms (the wings are membrane), so this is the mouth-pickup
      // creature: the animator grabs with the beak (pose.gape).
      head: { sizeFrac: 0.5, beak: 0.7, snoutLengthFrac: 0.7, snoutRadiusFrac: 0.33, snoutCurve: 0.35, mouthOpen: 0.8, eyePairs: 1, eyeSizeFrac: 0.2, eyeAngle: 0.5 },
      // Long hind legs lead; shorter membranous forelimbs lift off (wings).
      limbGroups: [
        { placement: "bilateral", count: 1, stationStart: 0.78, stationEnd: 0.84, lengthFrac: 0.85, restLevation: -0.3, restFlexion: -0.5, stance: 0.6, toeCount: 3, footLengthFrac: 0.18, radiusFrac: 0.09 },
        { placement: "bilateral", count: 1, stationStart: 0.24, stationEnd: 0.24, membrane: 0.95, lengthFrac: 0.6, radiusFrac: 0.07, attachHeight: 0.85, restProtraction: -0.4, restLevation: 0.7, restFlexion: 0.6, footLengthFrac: 0, toeCount: 1 },
      ],
    },
  },
  {
    name: "Human (biped + hands)",
    blueprint: {
      version: 1,
      // Fully erect (pitch ≈ 86°); bodyHeight leaves a natural knee ease.
      // Hand-tuned in the lab 2026-07-07.
      posture: { bodyPitch: 1.5, bodyHeight: 0.785 },
      // Shaped torso: broad shoulders (front/top), pinched waist, hips.
      // crossSection > 1 = wider than deep, like a real trunk. Near-zero
      // front taper keeps the chest broad instead of tapering to a point.
      spine: {
        torsoLengthM: 0.6, girth: 0.2, girthPeak: 0.51, crossSection: 1.5, frontTaper: 0.02, rearTaper: 0.255,
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
        sizeFrac: 0.9, lengthFrac: 1.05, braincaseDome: 0.95, crossSection: 0.88, faceHeight: -0.45,
        // The snout root sits LOW on the cranium front (foreheadHeight
        // 0.28), so the forehead IS the front of the cranium; a short flat
        // face shelf, straight slope.
        foreheadHeight: 0.28, foreheadLength: 0.15, foreheadSlope: 0.1,
        // Muzzle almost fully squared into the face (full-width tip, tiny
        // projection); a DEEP mandible drops the chin well below the small
        // terminal mouth — that is where the face gets its height.
        beak: 0, snoutLengthFrac: 0.14, snoutSegments: 2, snoutRadiusFrac: 0.42,
        muzzleSquash: 0.9, snoutFlatten: 1.1, snoutCurve: 0, mouthOpen: 0.32,
        jawDepth: 0.38, jawOffset: 0.15, mouthVertical: 0,
        // The nose is its OWN feature: protruding forward off the face with
        // the tip curling down.
        noseLengthFrac: 0.32, noseRadiusFrac: 0.2, noseHeight: 0.18,
        noseSegments: 2, noseDroop: 1.1,
        eyePairs: 1, eyeSizeFrac: 0.15, eyeAngle: 0.45, eyeHeight: 0.3, eyeBulge: 0.35,
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
        { placement: "bilateral", count: 1, stationStart: 0.88, stationEnd: 0.88, lengthFrac: 1.852, radiusFrac: 0.52, taper: 0.45, attachHeight: 0.3, restProtraction: 0.26, restLevation: -0.76, restFlexion: 0.24, flexRange: 0.475, legTwist: 0.72, legBalance: -0.03, stance: 0, ankleRange: 0.705, footLengthFrac: 0.198, toeCount: 5, toeSpread: 0.25, toeLengthFrac: 0.236, toeContrast: 0.3 },
        { placement: "bilateral", count: 1, stationStart: 0, stationEnd: 0, sizePeak: 0.94, lengthFrac: 1.06, radiusFrac: 0.369, taper: 0.5, attachHeight: 0.565, restProtraction: 0.02, restLevation: -0.71, restFlexion: 0.19, flexRange: 0.885, footLengthFrac: 0.132, stance: 0.15, toeCount: 4, opposition: 0.7, toeLengthFrac: 0.624, toeSpread: 0.602, toeContrast: 0.21 },
      ],
    },
  },
  {
    name: "Ungulate (hooves)",
    blueprint: {
      version: 1,
      posture: { bodyHeight: 0.5 },
      neck: { segments: 3, lengthFrac: 0.55, radiusFrac: 0.45, lift: 0.9 },
      tail: { segments: 2, lengthFrac: 0.2, radiusFrac: 0.3, droop: 0.4 },
      // A long DEEP muzzle (snoutFlatten < 1 = taller than wide) with a
      // small front mouth (mouthOpen 0.3 — the cheeks close off the long
      // jaw behind it), lateral eyes, and a roman-nose bridge (snoutCurve).
      head: {
        sizeFrac: 0.5, lengthFrac: 1.2, braincaseDome: 0.95, beak: 0.1, snoutLengthFrac: 1.5,
        foreheadHeight: 0.55, foreheadLength: 0.35, foreheadSlope: 0.05,
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
        { placement: "bilateral", count: 2, stationStart: 0.2, stationEnd: 0.85, attachHeight: 0.32, restProtraction: 0, restLevation: -0.5, restFlexion: -0.5, stance: 0.85, footLengthFrac: 0.28, lengthFrac: 0.66, radiusFrac: 0.11, toeCount: 1, toeContrast: 0 },
      ],
    },
  },
  {
    name: "Elephant (trunk)",
    blueprint: {
      version: 1,
      spine: { torsoLengthM: 2.0, girth: 0.22, girthPeak: 0.5 },
      neck: { segments: 2, lengthFrac: 0.2, radiusFrac: 0.7, lift: 0.5 },
      tail: { segments: 5, lengthFrac: 0.7, radiusFrac: 0.2, droop: 0.7 },
      // The trunk is the NOSE taken long (its own feature, NOT the muzzle):
      // rooted near the front of a short jaw, many segments, drooping down.
      // The actual mouth stays small and separate at the jaw.
      head: {
        // A big high-domed skull (braincaseDome) on a short deep jaw; the
        // trunk is the NOSE taken long (its own feature). The actual mouth
        // stays small and separate at the jaw.
        sizeFrac: 0.8, braincaseDome: 1.2, facePitch: -0.1, beak: 0.05,
        foreheadHeight: 0.5, foreheadLength: 0.2, foreheadSlope: 0.15,
        snoutLengthFrac: 0.5, snoutSegments: 2, snoutRadiusFrac: 0.55, muzzleSquash: 0.7,
        snoutFlatten: 0.9, mouthOpen: 0.25, jawDepth: 0.28, jawOffset: 0.1,
        noseLengthFrac: 4.2, noseRadiusFrac: 0.26, noseHeight: 0.05,
        noseSegments: 7, noseDroop: 0.55,
        eyePairs: 1, eyeSizeFrac: 0.1, eyeAngle: 1.0, eyeHeight: 0.3, eyeBulge: 0.4,
      },
      posture: { bodyHeight: 0.62 },
      // Thick pillar legs, plantigrade, knees barely bent.
      limbGroups: [
        { placement: "bilateral", count: 2, stationStart: 0.2, stationEnd: 0.85, stance: 0.15, lengthFrac: 0.72, radiusFrac: 0.16, toeCount: 4, footLengthFrac: 0.16, attachHeight: 0.3, restProtraction: 0, restLevation: -0.55, restFlexion: -0.25, toeContrast: 0.1 },
      ],
    },
  },
  {
    name: "Plesiosaur (flippers)",
    blueprint: {
      version: 1,
      neck: { segments: 5, lengthFrac: 1.3, radiusFrac: 0.4, lift: 0.5 },
      tail: { segments: 4, lengthFrac: 0.8, radiusFrac: 0.4, droop: 0.3 },
      head: { sizeFrac: 0.45 },
      posture: { bodyHeight: 0.3 },
      // Four membranous flipper-legs, sprawled low.
      limbGroups: [
        { placement: "bilateral", count: 2, stationStart: 0.25, stationEnd: 0.8, membrane: 0.9, lengthFrac: 0.7, radiusFrac: 0.1, attachHeight: 0.5, restProtraction: 0, restLevation: 0.2, restFlexion: 0, footLengthFrac: 0, toeCount: 1 },
      ],
    },
  },
  {
    name: "Hexapod (beetle)",
    blueprint: {
      version: 1,
      spine: { torsoLengthM: 0.9, girth: 0.22, girthPeak: 0.55, profile: [{ at: 0.25, scale: 0.8 }, { at: 0.5, scale: 0.7 }, { at: 0.75, scale: 1.1 }] },
      neck: { segments: 1, lengthFrac: 0.15, radiusFrac: 0.6, lift: 0.3 },
      tail: { segments: 0 },
      head: { sizeFrac: 0.45, beak: 0.3, snoutLengthFrac: 0.4, eyePairs: 1 },
      posture: { bodyHeight: 0.35 },
      limbGroups: [
        { placement: "bilateral", count: 3, stationStart: 0.2, stationEnd: 0.85, attachHeight: 0.44, restProtraction: 0, restLevation: 0.3, restFlexion: 0, radiusFrac: 0.04, lengthFrac: 0.5, stance: 0.7, toeCount: 1 },
      ],
      chains: [
        { attach: "head", count: 2, radial: false, segments: 5, lengthFrac: 0.5, radiusFrac: 0.025, taper: 0.2, aim: 0.6, spread: 0.4, curl: 0.7, tip: "club" },
      ],
    },
  },
  {
    name: "Centipede (many legs)",
    blueprint: {
      version: 1,
      spine: { torsoLengthM: 2.2, girth: 0.06, girthPeak: 0.5, torsoSegments: 10, frontTaper: 0.4, rearTaper: 0.4 },
      neck: { segments: 0 },
      tail: { segments: 2, lengthFrac: 0.3, radiusFrac: 0.6, droop: 0.2 },
      head: { sizeFrac: 0.5, eyePairs: 1, eyeSizeFrac: 0.15 },
      posture: { bodyHeight: 0.3 },
      limbGroups: [
        { placement: "bilateral", count: 8, stationStart: 0.08, stationEnd: 0.95, sizePeak: 0.5, sizeContrast: 0.1, attachHeight: 0.45, restProtraction: 0, restLevation: 0.3, restFlexion: 0, radiusFrac: 0.025, lengthFrac: 0.4, stance: 0.7, toeCount: 1 },
      ],
      chains: [
        { attach: "head", count: 2, radial: false, segments: 5, lengthFrac: 0.5, radiusFrac: 0.025, taper: 0.2, aim: 0.5, spread: 0.5, curl: 0.6, tip: "none" },
      ],
    },
  },
  {
    name: "Spider (waist + abdomen)",
    blueprint: {
      version: 1,
      spine: { crossSection: 1.2, girth: 0.18, girthPeak: 0.25, torsoLengthM: 0.9, frontTaper: 0.4, rearTaper: 0.3, profile: [{ at: 0.2, scale: 1 }, { at: 0.45, scale: 0.4 }, { at: 0.8, scale: 1.55 }] },
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
    name: "Wasp (waist + stinger)",
    blueprint: {
      version: 1,
      spine: { girth: 0.16, girthPeak: 0.3, torsoLengthM: 1.2, frontTaper: 0.3, rearTaper: 0.2, profile: [{ at: 0.3, scale: 1.1 }, { at: 0.45, scale: 0.18 }, { at: 0.62, scale: 1.5 }, { at: 0.95, scale: 0.7 }] },
      neck: { segments: 2, lengthFrac: 0.3, radiusFrac: 0.5, lift: 0.5 },
      tail: { segments: 0 },
      head: { sizeFrac: 0.6, beak: 0.2, snoutLengthFrac: 0.4, eyePairs: 1, eyeSizeFrac: 0.3, eyeAngle: 0.9 },
      posture: { bodyHeight: 0.35 },
      limbGroups: [
        { placement: "bilateral", count: 3, stationStart: 0.32, stationEnd: 0.6, sizePeak: 0.5, sizeContrast: 0.1, attachHeight: 0.44, restProtraction: 0, restLevation: 0.25, restFlexion: 0, radiusFrac: 0.04, lengthFrac: 0.5, stance: 0.7, toeCount: 1 },
      ],
      chains: [
        { attach: "body", station: 0.95, count: 1, radial: false, segments: 3, lengthFrac: 0.25, radiusFrac: 0.04, taper: 0.1, aim: 0, spread: 0, curl: 0.2, tip: "stinger" },
      ],
    },
  },
  {
    name: "Crab (flat + claws)",
    blueprint: {
      version: 1,
      spine: { crossSection: 2.2, girth: 0.32, girthPeak: 0.5, torsoLengthM: 0.6 },
      neck: { segments: 0 },
      tail: { segments: 0 },
      head: { sizeFrac: 0.3, eyePairs: 2, eyeSizeFrac: 0.18 },
      posture: { bodyHeight: 0.4 },
      // Long walking legs lead; shorter front claw-limbs lift and hang,
      // ending in a curled, opposed pincer pair.
      limbGroups: [
        { placement: "bilateral", count: 4, stationStart: 0.25, stationEnd: 0.75, attachHeight: 0.44, restProtraction: 0, restLevation: 0.35, restFlexion: 0, radiusFrac: 0.04, lengthFrac: 0.75, stance: 0.7, toeCount: 1 },
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
    name: "Mantis (raptorial forelegs)",
    blueprint: {
      version: 1,
      spine: { torsoLengthM: 1.0, girth: 0.09, girthPeak: 0.45, frontTaper: 0.4, rearTaper: 0.5, profile: [{ at: 0.3, scale: 0.85 }, { at: 0.6, scale: 1.15 }] },
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
        { placement: "bilateral", count: 2, stationStart: 0.4, stationEnd: 0.9, attachHeight: 0.45, restProtraction: 0, restLevation: 0.25, restFlexion: 0, radiusFrac: 0.03, lengthFrac: 0.6, stance: 0.7, toeCount: 1 },
        { placement: "bilateral", count: 1, stationStart: 0.2, stationEnd: 0.2, attachHeight: 0.45, restProtraction: 0.35, restLevation: 0.9, restFlexion: 0.55, radiusFrac: 0.045, lengthFrac: 0.7, toeCount: 2, opposition: 0.7, toeCurl: 0.6, toeLengthFrac: 0.8, footLengthFrac: 0.05 },
      ],
      chains: [
        { attach: "head", count: 2, radial: false, segments: 5, lengthFrac: 0.4, radiusFrac: 0.02, taper: 0.2, aim: 0.7, spread: 0.4, curl: 0.5, tip: "none" },
      ],
    },
  },
  {
    name: "Octopus (radial arms)",
    blueprint: {
      version: 1,
      spine: { girth: 0.33, girthPeak: 0.3, torsoLengthM: 0.7 },
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
    name: "Jellyfish (radial)",
    blueprint: {
      version: 1,
      spine: { torsoLengthM: 0.5, girth: 0.45, girthPeak: 0.5, crossSection: 2.0, frontTaper: 0.6, rearTaper: 0.6 },
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
    name: "Ram (curled horns)",
    blueprint: {
      version: 1,
      spine: { torsoLengthM: 1.1, girth: 0.22, girthPeak: 0.4, frontTaper: 0.4, rearTaper: 0.5 },
      neck: { segments: 2, lengthFrac: 0.3, radiusFrac: 0.65, lift: 0.6 },
      tail: { segments: 2, lengthFrac: 0.2, radiusFrac: 0.3, droop: 0.8 },
      head: { sizeFrac: 0.55, beak: 0.2, snoutLengthFrac: 0.7, eyePairs: 1, eyeSizeFrac: 0.16, eyeAngle: 1.0 },
      limbGroups: [
        { placement: "bilateral", count: 2, stationStart: 0.15, stationEnd: 0.85, lengthFrac: 0.55, radiusFrac: 0.14, taper: 0.5, attachHeight: 0.35, restLevation: -0.55, restFlexion: -0.3, stance: 0.85, footLengthFrac: 0.18, toeCount: 1 },
      ],
      growths: [
        {
          attach: "head", placement: "bilateral", count: 2, phi: 0.62, spread: 0.9, seed: 11,
          stem: { lengthFrac: 1.3, girth: 0.06, segments: 14, taper: 0.15, lean: -0.45, waviness: 0.05, curl: -6.5, twist: 1.8, gravitropism: 0, hardness: 1, rootFlare: 1.3 },
          branching: { levels: 0 },
          foliage: { leafDensity: 0 },
        },
      ],
      posture: { bodyHeight: 0.75 },
    },
  },
  {
    name: "Deer (branching antlers)",
    blueprint: {
      version: 1,
      spine: { torsoLengthM: 1.3, girth: 0.15, girthPeak: 0.4 },
      neck: { segments: 4, lengthFrac: 0.6, radiusFrac: 0.45, lift: 1.1 },
      tail: { segments: 2, lengthFrac: 0.15, radiusFrac: 0.3, droop: 0.5 },
      head: { sizeFrac: 0.45, beak: 0.25, snoutLengthFrac: 0.9, eyePairs: 1, eyeSizeFrac: 0.18, eyeAngle: 1.0 },
      limbGroups: [
        { placement: "bilateral", count: 2, stationStart: 0.15, stationEnd: 0.85, lengthFrac: 0.85, radiusFrac: 0.09, taper: 0.45, attachHeight: 0.35, restLevation: -0.6, restFlexion: -0.25, stance: 0.9, footLengthFrac: 0.22, toeCount: 1 },
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
      posture: { bodyHeight: 0.85 },
    },
  },
  {
    name: "Cow (straight horns)",
    blueprint: {
      version: 1,
      spine: { torsoLengthM: 1.6, girth: 0.24, girthPeak: 0.55 },
      neck: { segments: 2, lengthFrac: 0.25, radiusFrac: 0.7, lift: 0.4 },
      tail: { segments: 5, lengthFrac: 0.6, radiusFrac: 0.2, droop: 1.0 },
      head: { sizeFrac: 0.5, beak: 0.15, snoutLengthFrac: 0.8, eyePairs: 1, eyeSizeFrac: 0.16, eyeAngle: 1.1 },
      limbGroups: [
        { placement: "bilateral", count: 2, stationStart: 0.15, stationEnd: 0.85, lengthFrac: 0.6, radiusFrac: 0.15, taper: 0.55, attachHeight: 0.35, restLevation: -0.55, restFlexion: -0.3, stance: 0.85, footLengthFrac: 0.18, toeCount: 1 },
      ],
      growths: [
        {
          attach: "head", placement: "bilateral", count: 2, phi: 0.72, spread: 0.85, seed: 2,
          stem: { lengthFrac: 0.4, girth: 0.11, segments: 6, taper: 0.1, lean: 0.25, waviness: 0, curl: 1.8, twist: 0.4, gravitropism: 0.15, hardness: 1, rootFlare: 1.2 },
          branching: { levels: 0 },
          foliage: { leafDensity: 0 },
        },
      ],
      posture: { bodyHeight: 0.7 },
    },
  },
  {
    name: "Sheep (woolly)",
    blueprint: {
      version: 1,
      // Stocky woolly barrel on short legs: girth up, legs down, blunt
      // front/rear tapers so the fleece reads as one rounded mass.
      spine: { torsoLengthM: 1.0, girth: 0.28, girthPeak: 0.5, frontTaper: 0.35, rearTaper: 0.4 },
      neck: { segments: 2, lengthFrac: 0.22, radiusFrac: 0.6, lift: 0.5 },
      tail: { segments: 2, lengthFrac: 0.18, radiusFrac: 0.25, droop: 0.9 },
      // A small bare head poking out of the fleece.
      head: { sizeFrac: 0.38, beak: 0.15, snoutLengthFrac: 0.6, eyePairs: 1, eyeSizeFrac: 0.16, eyeAngle: 1.0 },
      limbGroups: [
        { placement: "bilateral", count: 2, stationStart: 0.18, stationEnd: 0.82, lengthFrac: 0.45, radiusFrac: 0.1, taper: 0.5, attachHeight: 0.35, restLevation: -0.55, restFlexion: -0.3, stance: 0.85, footLengthFrac: 0.16, toeCount: 1 },
      ],
      // Wool: pale cream body over a lighter belly; dark hooves/face accent.
      skin: { baseColor: "#e6dfcd", bellyColor: "#d8d0bc", accentColor: "#4a4038" },
      posture: { bodyHeight: 0.65 },
    },
  },
  // ── Plants — nothing but a growth on a nub. Plant height ≈ 0.1 m
  // (the nub torso) × stem.lengthFrac; skin.baseColor is the stem color.
  {
    name: "Oak (tree)",
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
    name: "Grass tuft",
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
    name: "Mushroom",
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
    name: "Saguaro (cactus)",
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
    name: "Bush (berries)",
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
    name: "Apple tree",
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
    name: "Banana plant",
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
    name: "Grape vine",
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
  // ── Fruit samples & root vegetables (type "fruit" / "root"). Each is
  // ONE determinate fruit body — the shape lives in the profile (bulge /
  // neck / tipTaper), curvature, lobes, and pole crown. These double as
  // the market-item catalogue (buildFruitMesh renders one standalone).
  {
    name: "Apple",
    blueprint: plant(
      { type: "fruit", seed: 1, fruit: { sizeM: 0.085, aspect: 0.95, bulge: 0.48, neck: 0.22, tipTaper: 0.22, stemFrac: 0, color: "#c0392b" } },
      { name: "apple", skin: { baseColor: "#6a5a2e" } },
    ),
  },
  {
    name: "Banana",
    blueprint: plant(
      { type: "fruit", seed: 2, fruit: { sizeM: 0.035, aspect: 5.5, bulge: 0.5, neck: 0.35, tipTaper: 0.45, curvature: 1.4, stemFrac: 0, color: "#e3c018" } },
      { name: "banana", skin: { baseColor: "#6a5a2e" } },
    ),
  },
  {
    name: "Grape",
    blueprint: plant(
      // One berry of the bunch — the market/ground item the grape vine yields.
      { type: "fruit", seed: 9, fruit: { sizeM: 0.025, aspect: 1.2, bulge: 0.5, neck: 0.12, tipTaper: 0.1, stemFrac: 0, color: "#5b2a6e" } },
      { name: "grape", skin: { baseColor: "#3f7a34" } },
    ),
  },
  {
    name: "Pear",
    blueprint: plant(
      // Bulb at the base (bottom), tapering to a neck at the tip (top).
      { type: "fruit", seed: 3, fruit: { sizeM: 0.09, aspect: 1.5, bulge: 0.32, neck: 0, tipTaper: 0.5, curvature: 0.12, stemFrac: 0, color: "#b5c23a" } },
      { name: "pear", skin: { baseColor: "#5f7a2e" } },
    ),
  },
  {
    name: "Strawberry",
    blueprint: plant(
      // Point at the base (bottom), widening to a leafy calyx crown at the
      // top — crownLeaves fan from the tip pole.
      { type: "fruit", seed: 4, fruit: { sizeM: 0.05, aspect: 1.25, bulge: 0.72, neck: 0.85, tipTaper: 0, stemFrac: 0, crownLeaves: 6, crownSize: 0.6, color: "#d8352a" } },
      { name: "strawberry", skin: { baseColor: "#3f7a34" } },
    ),
  },
  {
    name: "Pumpkin",
    blueprint: plant(
      // Squat + ribbed (lobes); sits near the ground on a stub stalk.
      { type: "fruit", seed: 5, stem: { lengthFrac: 0.3, girth: 0.02 }, fruit: { sizeM: 0.3, aspect: 0.72, bulge: 0.5, neck: 0.18, tipTaper: 0.18, lobes: 8, stemFrac: 0, color: "#d1892f" } },
      { name: "pumpkin", skin: { baseColor: "#4f6a2a" } },
    ),
  },
  {
    name: "Pineapple",
    blueprint: plant(
      // Barrel body + a big spray of crown leaves at the top.
      { type: "fruit", seed: 6, fruit: { sizeM: 0.14, aspect: 1.55, bulge: 0.5, neck: 0.12, tipTaper: 0.12, lobes: 6, stemFrac: 0, crownLeaves: 9, crownSize: 1.0, color: "#c69a2e" } },
      { name: "pineapple", skin: { baseColor: "#5f7a2e" } },
    ),
  },
  {
    name: "Carrot (root)",
    blueprint: plant(
      // Downward taper to a point, leafy top at the ground (calyx crown).
      { type: "root", seed: 7, fruit: { sizeM: 0.05, aspect: 3.4, bulge: 0.14, neck: 0, tipTaper: 1, stemFrac: 0, calyxLeaves: 6, crownSize: 1.4, color: "#e07b1a" } },
      { name: "carrot", skin: { baseColor: "#3f7a34" } },
    ),
  },
  {
    name: "Beet (root)",
    blueprint: plant(
      { type: "root", seed: 8, fruit: { sizeM: 0.09, aspect: 1.15, bulge: 0.35, neck: 0, tipTaper: 0.85, stemFrac: 0, calyxLeaves: 5, crownSize: 1.1, color: "#7b1f3a" } },
      { name: "beet", skin: { baseColor: "#3f7a34" } },
    ),
  },
];
