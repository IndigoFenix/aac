// shared/world-engine/creatures/animals-people.ts
//
// Creature-builder blueprint for the PEOPLE species — `human`, and only
// `human` — authored in the seagull-dream lab (animals-people.json) and
// inlined here as a TS module (the root tsconfig has no resolveJsonModule, and
// shared is bundler-agnostic). PURE DATA; species.ts registers it by `name`.
//
// ⚰️ THE AUTHORED ANIMAL PEOPLE WERE HERE (bear/frog/dog/rabbit, retired
// 2026-09-01, user: *"we'll also want to remove the current animal people from
// the list, since they'll be handled by the creature variation system"*). They
// are DERIVED now, by the `animal_people` creature mod (mod-library.ts), which
// builds an animal person for EVERY non-speaking creature rather than the four
// somebody happened to draw. That also retires the mod's "an authored row
// always wins" carve-out — there is no authored row left to lose to.
// ⚠️ Their ids therefore exist ONLY in a world that installs that mod, which
// is why `animalSpeciesForIcon` (quest-host.ts) now checks the registry instead
// of demanding a species that may not be there.
//
// ⚰️ `human_cute` WAS HERE (retired 2026-08-29). It was `human` with
// spine.girth 0.2 → 0.45 and NOTHING else, which is a re-skin, not a species:
// it is now the `cute` creature mod (mod-library.ts), a world-level renderer
// option that lands any species on that same chunkier build. `getSpecies
// ("human_cute")" still resolves — to `human` — so stored documents load.
// 🚶 RE-PROPORTIONED 2026-09-03 to a real 70 kg, 1.72 m adult. Four numbers
// moved and nothing else:
//   • spine.girth 0.2 → 0.2167 — the chest that lands 70 kg on a 0.6 m trunk
//     (the shipped body read 56 kg, which is a small teenager);
//   • limbGroups[0] (THE LEGS — group 0 is the station-0.88 pair; group 1 at
//     station 0 is the ARMS) lengthFrac 1.852 → 1.7 and radiusFrac 0.52 → 0.6;
//   • posture.bodyHeight 0.785 → 0.85.
// The last three together STRAIGHTEN THE STANDING KNEE, 145° → 164°, which is
// what the ledger was really complaining about: ema 4.88 → 2.40 and σ 2.42 →
// 1.17. Real is ~172°, and the pose solver's contact clamp will not give the
// last 8° — raising bodyHeight past 0.85 makes the knee WORSE, not better,
// because the foot re-plants and the sole stops counting as flat.
//
// ⚠️ σ 1.17 IS THE HONEST RESIDUAL, AND IT IS THE BIPED SHARE. Two legs carry
// what the Campione line was fitted on four carrying, and Campione et al.
// (2014) needed a SEPARATE equation for bipeds for exactly this reason. This
// body's thigh is r/line 0.97 against the QUADRUPED line and is a real human
// thigh (~15.5 cm across); it is the denominator that is wrong, not the leg.
// Fixing it properly means a biped branch in physio.ts, which is a bigger
// decision than a re-proportioning round should make on its own.
//
// The face, the hands and every head dial are UNTOUCHED — those were tuned by
// eye and this round has no opinion about them.
export const ANIMAL_PEOPLE_BLUEPRINTS: Array<Record<string, unknown>> =
[{
  "name": "human",
  "version": 1,
  "spine": {
    "torsoSegments": 6,
    "torsoLengthM": 0.6,
    "girth": 0.2167,
    "girthPeak": 0.51,
    "frontTaper": 0.02,
    "rearTaper": 0.255,
    "crossSection": 1.5,
    "profile": [
      {
        "at": 0.18,
        "scale": 1.15
      },
      {
        "at": 0.52,
        "scale": 0.88
      },
      {
        "at": 0.85,
        "scale": 1
      }
    ]
  },
  "neck": {
    "segments": 2,
    "lengthFrac": 0.2,
    "radiusFrac": 0.38,
    "lift": 0.1
  },
  "tail": {
    "segments": 0,
    "lengthFrac": 0.8,
    "radiusFrac": 0.5,
    "droop": 0.5
  },
  "head": {
    "sizeFrac": 1.019,
    "lengthFrac": 1.05,
    "braincaseDome": 0.95,
    "crossSection": 0.88,
    "facePitch": -0.0449999999999999,
    "foreheadHeight": 0.1654,
    "foreheadLength": 0.1248,
    "foreheadSlope": 0.1,
    "beak": 0,
    "snoutLengthFrac": 0.01,
    "snoutSegments": 1,
    "snoutRadiusFrac": 0.2522,
    "muzzleSquash": 0,
    "snoutFlatten": 1.1,
    "snoutCurve": -0.31,
    "mouthOpen": 0.135,
    "jawDepth": 0,
    "jawOffset": -0.03,
    "mouthVertical": 0,
    "noseLengthFrac": 0.27,
    "noseRadiusFrac": 0.4084,
    "nosePosition": 0.315,
    "noseTaper": 0.45,
    "noseFlatten": 1,
    "noseSegments": 2,
    "noseDroop": 0.36,
    "eyePairs": 1,
    "eyeSizeFrac": 0.138,
    "eyeAngle": 0.45,
    "eyeHeight": 0.03,
    "eyeBulge": 0,
    "padding": 0.35,
    "cheek": 0.5,
    "jowl": 0.1,
    "brow": 0.12,
    "muzzlePad": 0,
    "lips": 0.805,
    "chin": 0
  },
  "limbGroups": [
    {
      "placement": "bilateral",
      "count": 1,
      "stationStart": 0.88,
      "stationEnd": 0.88,
      "sizePeak": 1,
      "sizeContrast": 0.12,
      "lengthFrac": 1.7,
      "radiusFrac": 0.6,
      "taper": 0.45,
      "membrane": 0,
      "attachHeight": 0.3,
      "restProtraction": 0.26,
      "restLevation": -0.76,
      "restFlexion": 0.24,
      "flexRange": 0.475,
      "legTwist": 0.72,
      "legBalance": -0.03,
      "footLengthFrac": 0.198,
      "stance": 0,
      "ankleRange": 0.705,
      "toeCount": 5,
      "toeLengthFrac": 0.236,
      "toeSpread": 0.25,
      "toeContrast": 0.3,
      "opposition": 0,
      "toeCurl": 0.1
    },
    {
      "placement": "bilateral",
      "count": 1,
      "stationStart": 0,
      "stationEnd": 0,
      "sizePeak": 0.94,
      "sizeContrast": 0.12,
      "lengthFrac": 1.06,
      "radiusFrac": 0.369,
      "taper": 0.5,
      "membrane": 0,
      "attachHeight": 0.565,
      "restProtraction": 0.02,
      "restLevation": -0.71,
      "restFlexion": 0.19,
      "flexRange": 0.885,
      "legTwist": 0,
      "legBalance": 0,
      "footLengthFrac": 0.132,
      "stance": 0.15,
      "ankleRange": 1,
      "toeCount": 4,
      "toeLengthFrac": 0.624,
      "toeSpread": 0.602,
      "toeContrast": 0.21,
      "opposition": 0.7,
      "toeCurl": 0.1
    }
  ],
  "chains": [],
  "membranes": [],
  "growths": [],
  "skin": {
    "baseColor": "#ffffff",
    "bellyColor": "#ffffff",
    "accentColor": "#ffffff"
  },
  "posture": {
    "bodyPitch": 1.362872800004023,
    "bodyHeight": 0.85
  }
}];
