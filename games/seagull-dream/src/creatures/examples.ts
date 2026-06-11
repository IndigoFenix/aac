// Curated showcase genomes for the creature lab. Each exercises parts of
// the body-plan constructor (instructions/creatures.md) and doubles as a
// worked example of the genome interchange format. They are intentionally
// partial — loaded through clampGenome, which fills every unset field —
// so they read as "just the parts that matter for this creature".
//
// PURE DATA, no three.js. The lab offers these in a dropdown; the same
// objects are handy as fixtures/documentation elsewhere.

export interface CreatureExample {
  name: string;
  genome: Record<string, unknown>;
}

export const CREATURE_EXAMPLES: CreatureExample[] = [
  {
    name: "Quadruped (default)",
    genome: { version: 1 },
  },
  {
    name: "Snake (limbless)",
    genome: {
      version: 1,
      spine: { torsoLengthM: 3.0, girth: 0.05, girthPeak: 0.3, torsoSegments: 11, frontTaper: 0.5, rearTaper: 0.4 },
      neck: { segments: 2, lengthFrac: 0.2, radiusFrac: 0.7, lift: 0.2 },
      tail: { segments: 9, lengthFrac: 1.6, radiusFrac: 0.6, droop: 0.05 },
      head: { sizeFrac: 0.5, beak: 0.15, beakLengthFrac: 0.4, eyePairs: 1, eyeSizeFrac: 0.18, eyeAngle: 0.9 },
      limbGroups: [],
    },
  },
  {
    name: "Fish (fins + tail)",
    genome: {
      version: 1,
      spine: { crossSection: 0.5, girth: 0.2, girthPeak: 0.5, torsoLengthM: 1.0 },
      neck: { segments: 0 },
      tail: { segments: 5, lengthFrac: 0.7, radiusFrac: 0.45, droop: 0 },
      head: { sizeFrac: 0.5, beak: 0.1, beakLengthFrac: 0.25, eyePairs: 1, eyeSizeFrac: 0.2 },
      limbGroups: [
        { function: "fin", placement: "bilateral", endEffector: "paddle", count: 1, stationStart: 0.35, stationEnd: 0.35, membrane: 0.85, lengthFrac: 0.45, radiusFrac: 0.08, splay: 0.8 },
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
    genome: {
      version: 1,
      spine: { crossSection: 2.6, girth: 0.26, girthPeak: 0.4, torsoLengthM: 1.4, frontTaper: 0.5, rearTaper: 0.7 },
      neck: { segments: 0 },
      tail: { segments: 6, lengthFrac: 1.7, radiusFrac: 0.2, droop: 0.05 },
      head: { sizeFrac: 0.4, beak: 0.1, beakLengthFrac: 0.3, eyePairs: 1 },
      limbGroups: [],
      chains: [
        { attach: "body", station: 0.95, count: 1, radial: false, segments: 4, lengthFrac: 0.5, radiusFrac: 0.04, taper: 0.1, aim: 0.3, spread: 0, curl: 0.2, tip: "stinger" },
      ],
    },
  },
  {
    name: "Dimetrodon (sail)",
    genome: {
      version: 1,
      spine: { torsoLengthM: 1.4, girth: 0.16, girthPeak: 0.5 },
      neck: { segments: 2, lengthFrac: 0.25, radiusFrac: 0.5, lift: 0.3 },
      tail: { segments: 5, lengthFrac: 1.0, radiusFrac: 0.4, droop: 0.2 },
      head: { sizeFrac: 0.5, beak: 0.4, beakLengthFrac: 0.8 },
      limbGroups: [
        { function: "leg", count: 2, stationStart: 0.2, stationEnd: 0.82, kneeLift: 0.5, splay: 0.6, radiusFrac: 0.07, lengthFrac: 0.45, stance: 0.5, toeCount: 3, endEffector: "foot" },
      ],
      membranes: [{ edge: "dorsal", start: 0.28, end: 0.78, height: 0.7, heightPeak: 0.5, rays: 10 }],
    },
  },
  {
    name: "Winged biped (raptor)",
    genome: {
      version: 1,
      posture: { bodyPitch: 0.8 },
      neck: { segments: 2, lengthFrac: 0.3, radiusFrac: 0.5, lift: 0.7 },
      tail: { segments: 4, lengthFrac: 0.6, radiusFrac: 0.4, droop: 0.3 },
      head: { sizeFrac: 0.5, beak: 0.7, beakLengthFrac: 0.7, eyePairs: 1, eyeSizeFrac: 0.2, eyeAngle: 0.5 },
      limbGroups: [
        { function: "leg", count: 1, stationStart: 0.78, stationEnd: 0.84, endEffector: "foot", lengthFrac: 0.7, stance: 0.6, toeCount: 3, footLengthFrac: 0.18 },
        { function: "wing", endEffector: "none", membrane: 0.95, stationStart: 0.25, stationEnd: 0.25, lengthFrac: 1.5, radiusFrac: 0.08, splay: 0.85 },
      ],
    },
  },
  {
    name: "Human (biped + hands)",
    genome: {
      version: 1,
      posture: { bodyPitch: 1.05 },
      neck: { segments: 2, lengthFrac: 0.3, radiusFrac: 0.55, lift: 0.4 },
      tail: { segments: 0 },
      head: { sizeFrac: 0.5, beak: 0, beakLengthFrac: 0.1, eyePairs: 1, eyeSizeFrac: 0.22, eyeAngle: 0.5 },
      limbGroups: [
        { function: "leg", count: 1, stationStart: 0.82, stationEnd: 0.86, endEffector: "foot", lengthFrac: 0.85, stance: 0.2, toeCount: 4, footLengthFrac: 0.22, radiusFrac: 0.1 },
        { function: "arm", endEffector: "hand", count: 1, stationStart: 0.2, stationEnd: 0.2, lengthFrac: 0.75, radiusFrac: 0.06, toeCount: 4, taper: 0.6 },
      ],
    },
  },
  {
    name: "Ungulate (hooves)",
    genome: {
      version: 1,
      neck: { segments: 3, lengthFrac: 0.55, radiusFrac: 0.45, lift: 0.9 },
      tail: { segments: 2, lengthFrac: 0.2, radiusFrac: 0.3, droop: 0.4 },
      head: { sizeFrac: 0.5, beak: 0.3, beakLengthFrac: 0.7, eyePairs: 1, eyeSizeFrac: 0.18, eyeAngle: 1.0 },
      limbGroups: [
        { function: "leg", count: 2, stationStart: 0.2, stationEnd: 0.85, endEffector: "hoof", stance: 0.9, footLengthFrac: 0.32, lengthFrac: 0.75, radiusFrac: 0.08, toeCount: 2, kneeLift: 0.15 },
      ],
    },
  },
  {
    name: "Elephant (trunk)",
    genome: {
      version: 1,
      spine: { torsoLengthM: 2.0, girth: 0.22, girthPeak: 0.5 },
      neck: { segments: 2, lengthFrac: 0.2, radiusFrac: 0.7, lift: 0.5 },
      tail: { segments: 5, lengthFrac: 0.7, radiusFrac: 0.2, droop: 0.6 },
      head: { sizeFrac: 0.8, beak: 0.1, beakLengthFrac: 0.2, eyePairs: 1, eyeSizeFrac: 0.12, eyeAngle: 1.0 },
      limbGroups: [
        { function: "leg", count: 2, stationStart: 0.2, stationEnd: 0.85, endEffector: "foot", stance: 0.2, lengthFrac: 0.7, radiusFrac: 0.16, toeCount: 4, footLengthFrac: 0.18, kneeLift: 0.1, splay: 0.1 },
      ],
      chains: [
        { attach: "head", station: 0.5, count: 1, radial: false, segments: 8, lengthFrac: 1.0, radiusFrac: 0.09, taper: 0.3, aim: -0.5, spread: 0, curl: 1.0, tip: "none" },
      ],
    },
  },
  {
    name: "Plesiosaur (flippers)",
    genome: {
      version: 1,
      neck: { segments: 5, lengthFrac: 1.3, radiusFrac: 0.4, lift: 0.5 },
      tail: { segments: 4, lengthFrac: 0.8, radiusFrac: 0.4, droop: 0.2 },
      head: { sizeFrac: 0.45 },
      limbGroups: [
        { function: "leg", count: 2, stationStart: 0.25, stationEnd: 0.8, endEffector: "paddle", membrane: 0.9, lengthFrac: 0.75, radiusFrac: 0.1, splay: 0.7, kneeLift: 0.2 },
      ],
    },
  },
  {
    name: "Hexapod (beetle)",
    genome: {
      version: 1,
      spine: { torsoLengthM: 0.9, girth: 0.22, girthPeak: 0.55, profile: [{ at: 0.25, scale: 0.8 }, { at: 0.5, scale: 0.7 }, { at: 0.75, scale: 1.1 }] },
      neck: { segments: 1, lengthFrac: 0.15, radiusFrac: 0.6, lift: 0.3 },
      tail: { segments: 0 },
      head: { sizeFrac: 0.45, beak: 0.3, beakLengthFrac: 0.4, eyePairs: 1 },
      limbGroups: [
        { function: "leg", count: 3, stationStart: 0.2, stationEnd: 0.85, kneeLift: 0.8, splay: 0.9, radiusFrac: 0.04, lengthFrac: 0.5, stance: 0.7, toeCount: 1, endEffector: "foot", segments: 3 },
      ],
      chains: [
        { attach: "head", count: 2, radial: false, segments: 5, lengthFrac: 0.5, radiusFrac: 0.025, taper: 0.2, aim: 0.6, spread: 0.4, curl: 0.7, tip: "club" },
      ],
    },
  },
  {
    name: "Centipede (many legs)",
    genome: {
      version: 1,
      spine: { torsoLengthM: 2.2, girth: 0.06, girthPeak: 0.5, torsoSegments: 10, frontTaper: 0.4, rearTaper: 0.4 },
      neck: { segments: 0 },
      tail: { segments: 2, lengthFrac: 0.3, radiusFrac: 0.6, droop: 0.1 },
      head: { sizeFrac: 0.5, eyePairs: 1, eyeSizeFrac: 0.15 },
      limbGroups: [
        { function: "leg", placement: "bilateral", count: 8, stationStart: 0.08, stationEnd: 0.95, sizePeak: 0.5, sizeContrast: 0.1, kneeLift: 0.9, splay: 0.95, radiusFrac: 0.025, lengthFrac: 0.4, stance: 0.7, toeCount: 1, endEffector: "foot", segments: 3 },
      ],
      chains: [
        { attach: "head", count: 2, radial: false, segments: 5, lengthFrac: 0.5, radiusFrac: 0.025, taper: 0.2, aim: 0.5, spread: 0.5, curl: 0.6, tip: "none" },
      ],
    },
  },
  {
    name: "Spider (waist + abdomen)",
    genome: {
      version: 1,
      spine: { crossSection: 1.2, girth: 0.18, girthPeak: 0.25, torsoLengthM: 0.9, frontTaper: 0.4, rearTaper: 0.3, profile: [{ at: 0.2, scale: 1 }, { at: 0.45, scale: 0.4 }, { at: 0.8, scale: 1.9 }] },
      neck: { segments: 0 },
      tail: { segments: 0 },
      head: { sizeFrac: 0.4, beak: 0, beakLengthFrac: 0.1, eyePairs: 2, eyeSizeFrac: 0.2, eyeAngle: 0.6 },
      limbGroups: [
        { function: "leg", count: 4, stationStart: 0.12, stationEnd: 0.4, sizePeak: 0, sizeContrast: 0.15, kneeLift: 0.85, splay: 0.95, radiusFrac: 0.05, lengthFrac: 0.85, stance: 0.8, toeCount: 1, endEffector: "foot", segments: 3 },
      ],
    },
  },
  {
    name: "Wasp (waist + stinger)",
    genome: {
      version: 1,
      spine: { girth: 0.16, girthPeak: 0.3, torsoLengthM: 1.2, frontTaper: 0.3, rearTaper: 0.2, profile: [{ at: 0.3, scale: 1.1 }, { at: 0.45, scale: 0.18 }, { at: 0.62, scale: 1.5 }, { at: 0.95, scale: 0.7 }] },
      neck: { segments: 2, lengthFrac: 0.3, radiusFrac: 0.5, lift: 0.5 },
      tail: { segments: 0 },
      head: { sizeFrac: 0.6, beak: 0.2, beakLengthFrac: 0.4, eyePairs: 1, eyeSizeFrac: 0.3, eyeAngle: 0.9 },
      limbGroups: [
        { function: "leg", count: 3, stationStart: 0.32, stationEnd: 0.6, sizePeak: 0.5, sizeContrast: 0.1, kneeLift: 0.7, splay: 0.8, radiusFrac: 0.04, lengthFrac: 0.5, stance: 0.7, toeCount: 1, endEffector: "foot", segments: 3 },
      ],
      chains: [
        { attach: "body", station: 0.95, count: 1, radial: false, segments: 3, lengthFrac: 0.25, radiusFrac: 0.04, taper: 0.1, aim: 0, spread: 0, curl: 0.2, tip: "stinger" },
      ],
    },
  },
  {
    name: "Crab (flat + claws)",
    genome: {
      version: 1,
      spine: { crossSection: 2.2, girth: 0.32, girthPeak: 0.5, torsoLengthM: 0.6 },
      neck: { segments: 0 },
      tail: { segments: 0 },
      head: { sizeFrac: 0.3, eyePairs: 2, eyeSizeFrac: 0.18 },
      limbGroups: [
        { function: "leg", count: 4, stationStart: 0.25, stationEnd: 0.75, kneeLift: 0.85, splay: 0.95, radiusFrac: 0.04, lengthFrac: 0.7, stance: 0.7, toeCount: 1, endEffector: "foot" },
        { function: "arm", endEffector: "claw", count: 1, stationStart: 0.12, stationEnd: 0.12, lengthFrac: 0.6, radiusFrac: 0.1, toeCount: 2 },
      ],
      chains: [
        { attach: "head", count: 2, radial: false, segments: 4, lengthFrac: 0.4, radiusFrac: 0.03, taper: 0.2, aim: 0.7, spread: 0.5, curl: 0.3, tip: "eye" },
      ],
    },
  },
  {
    name: "Octopus (radial arms)",
    genome: {
      version: 1,
      spine: { girth: 0.33, girthPeak: 0.3, torsoLengthM: 0.7 },
      neck: { segments: 0 },
      tail: { segments: 0 },
      head: { sizeFrac: 0.7, beak: 0, beakLengthFrac: 0, eyePairs: 1, eyeSizeFrac: 0.28 },
      limbGroups: [],
      chains: [
        { attach: "head", station: 0.5, count: 8, radial: true, segments: 7, lengthFrac: 1.2, radiusFrac: 0.07, taper: 0.1, aim: -0.4, spread: 0.5, curl: 0.8, tip: "none" },
      ],
    },
  },
  {
    name: "Jellyfish (radial)",
    genome: {
      version: 1,
      spine: { torsoLengthM: 0.5, girth: 0.45, girthPeak: 0.5, crossSection: 2.0, frontTaper: 0.6, rearTaper: 0.6 },
      neck: { segments: 0 },
      tail: { segments: 0 },
      head: { sizeFrac: 0.3, beak: 0, beakLengthFrac: 0, eyePairs: 0 },
      limbGroups: [],
      chains: [
        { attach: "body", station: 0.5, count: 10, radial: true, segments: 7, lengthFrac: 1.4, radiusFrac: 0.03, taper: 0.1, aim: -0.9, spread: 0.3, curl: 0.4, tip: "none" },
      ],
    },
  },
];
