// shared/world-engine/creatures/mod-library.ts
//
// THE BUILT-IN CREATURE MODS — the shipped mod documents a world template may
// name in `game.mods`. Authored as plain JSON literals (the root tsconfig has
// no resolveJsonModule and `shared` is bundler-agnostic — the same reason
// animals-people.ts inlines its JSON), parsed through the same
// `parseCreatureMod` gate a third-party pack would pass, so nothing here gets
// a shape the format doesn't allow.
//
// Adding a mod is adding a document to `MOD_DOCS`. Nothing else in the engine
// learns its name.

import { parseCreatureMod, type CreatureMod } from "./mods";

/** Limb-group fields that carry POSTURE — where the limb attaches, how long it
 *  is, how it rests, and what the end of it does. Taking these from the
 *  template's leg is the whole of "stand it up"; taking them from the
 *  template's arm is the whole of "give it hands".
 *
 *  Deliberately NOT here: `radiusFrac`, `taper`, `membrane`, `count`,
 *  `placement`. Those are the limb's SUBSTANCE, and the design keeps them
 *  from the animal — a bear person's arms are a bear's arms in thickness. */
const POSTURE_FIELDS = [
  "stationStart", "stationEnd", "attachHeight", "lengthFrac",
  "restProtraction", "restLevation", "restFlexion", "flexRange",
  "legTwist", "legBalance", "stance", "ankleRange",
  "footLengthFrac", "toeCount", "toeLengthFrac", "toeSpread", "toeContrast",
  "toeCurl", "opposition", "sizePeak", "sizeContrast",
];

const MOD_DOCS: unknown[] = [
  // ── Animal People ────────────────────────────────────────────────────────
  {
    id: "animal_people",
    name: "Animal People",
    description:
      "Every non-speaking creature gains a bipedal, handed, speaking counterpart " +
      "with the same animal head, coat and horns. They live where their animal " +
      "lives, and are rarer than it.",
    derive: {
      // EVERY non-speaking creature — including the vocabulary stubs, which
      // derive stub people (a word ahead of a body, exactly as the base row
      // is). `human` and the authored `*_person` rows are excluded for free:
      // they already speak.
      from: { kinds: ["creature"], canSpeak: false },
      id: "{base}_person",
      name: "{base} person",
      template: "human",
      // PROPORTIONAL, not the template's: an elephant person is a person, but
      // it is not a person-sized one, and its collision radius (and the
      // rooms its own town would build) has to follow the body it got.
      grants: { canSpeak: true, bodyRadiusM: "proportional" },
      // SAME HABITAT, RARER (the design's two worldgen facts). Carried on the
      // derived row; the spawn pass that reads them is a later round.
      habitat: "base",
      rarity: 0.25,
      words: {
        en: { w: "{base} person", plw: "{base} people" },
        // Hebrew construct: the definite ה lands on the SECOND word
        // ("איש הכלב", not "האיש כלב") — hence `defw`.
        he: { w: "איש {base}", g: "m", plw: "אנשי {base}", defw: "איש ה{base}" },
        es: { w: "hombre {base}", g: "m", plw: "hombres {base}" },
        pt: { w: "homem {base}", g: "m", plw: "homens {base}" },
      },
      bipedalize: { legsFrom: POSTURE_FIELDS, armsFrom: POSTURE_FIELDS },
      gravitate: {
        // ── Overwritten outright: what makes it a PERSON ──────────────────
        // Upright, with a neck that holds a head up and the human chest/
        // waist/hip profile a standing torso needs.
        posture: { from: "template" },
        neck: { from: "template" },
        "spine.profile": { from: "template" },
        "spine.torsoSegments": { to: "template", by: 1 },

        // ── Gravitated: a person's build, still the animal's ──────────────
        // OVERALL SIZE stays partly the animal's, so a bear person towers
        // over a rabbit person instead of every species arriving human-sized.
        "spine.torsoLengthM": { to: "template", by: 0.65 },
        "spine.girth": { to: "template", by: 0.8 },
        "spine.girthPeak": { to: "template", by: 0.8 },
        "spine.frontTaper": { to: "template", by: 0.8 },
        "spine.rearTaper": { to: "template", by: 0.8 },
        "spine.crossSection": { to: "template", by: 0.7 },

        // ── The head: ANIMAL, on a braincase that can hold a mind ─────────
        // Muzzle, nose, jaw, lips, cheeks, brow and every soft-tissue dial
        // have NO RULE and survive untouched — that is what makes it a dog's
        // face. Only the cranium and the eye placement are pulled toward a
        // person's, so it reads as looking AT you rather than past you.
        "head.sizeFrac": { to: "template", by: 0.45 },
        "head.braincaseDome": { to: "template", by: 0.5 },
        "head.crossSection": { to: "template", by: 0.4 },
        "head.foreheadHeight": { to: "template", by: 0.5 },
        "head.foreheadLength": { to: "template", by: 0.4 },
        "head.facePitch": { to: "template", by: 0.6 },
        "head.eyeHeight": { to: "template", by: 0.4 },
        "head.eyeAngle": { to: "template", by: 0.5 },
        // Shortened, never removed: a muzzle is the point.
        "head.snoutLengthFrac": { scale: 0.7 },

        // ── Kept, trimmed: a tail a standing body can carry ───────────────
        "tail.segments": { scale: 0.5 },
        "tail.lengthFrac": { scale: 0.6 },
      },
    },
  },

  // ── Cute art style ───────────────────────────────────────────────────────
  {
    id: "cute",
    name: "Cute art style",
    description:
      "Chunkier bodies, rounder skulls and bigger eyes on every creature. A " +
      "renderer option — it adds no species and changes no id, so the same " +
      "world with it off is the same world.",
    appearance: {
      // Creatures only. A plant has a body plan too, and scaling a tree's
      // "girth" by two would make an oak a barrel.
      applyTo: { kinds: ["creature"] },
      gravitate: {
        // THE HUMAN_CUTE PIN. `human` ships girth 0.2 and the retired
        // `human_cute` row was that body with girth 0.45 — the engine's
        // ceiling — and nothing else changed. ×2.25 lands human exactly on
        // it, which is what makes this mod the REPLACEMENT for that row
        // rather than a new look for the people. Everything already stouter
        // than 0.2 rides the same ceiling (a cute cow IS round); everything
        // slighter stays proportionally slighter (a cute snake is a chunkier
        // snake, not a sausage).
        "spine.girth": { scale: 2.25, max: 0.45 },
        // ⚖️ THE HEAD IS NOT ENLARGED (user, 2026-08-30: *"the cute modifier
        // shouldn't actually make the head bigger, it looks better without the
        // increase"*). `head.sizeFrac` deliberately has NO RULE — the chunky
        // body already shifts the head:body ratio, and scaling the head on top
        // of that overshot. What stays is the SHAPE of the head, not its size:
        // a rounder cranium and bigger eyes.
        "head.braincaseDome": { to: 1.25, by: 0.35 },
        "head.eyeSizeFrac": { scale: 1.2 },
        // Shorter, thicker limbs under a rounder body.
        "limbGroups.*.lengthFrac": { scale: 0.85 },
        "limbGroups.*.radiusFrac": { scale: 1.2 },
      },
    },
  },
];

/** The shipped mods, parsed through the public gate. Module-load time, so a
 *  malformed built-in fails the build rather than the world. */
export const BUILTIN_CREATURE_MODS: readonly CreatureMod[] =
  MOD_DOCS.map((d, i) => parseCreatureMod(d, `builtin-mod[${i}]`));

const BY_ID = new Map(BUILTIN_CREATURE_MODS.map((m) => [m.id, m] as const));

/** Every built-in mod (the creature lab's list, the manifest's allowed set). */
export function listCreatureMods(): readonly CreatureMod[] {
  return BUILTIN_CREATURE_MODS;
}

/** A built-in mod by id, or undefined. */
export function getCreatureMod(id: string): CreatureMod | undefined {
  return BY_ID.get(id);
}

/** Resolve declared mod ids to mods; throws naming the unknown id and what IS
 *  available (the manifest's refusal law — a world can never half-load). */
export function resolveCreatureMods(ids: readonly string[]): CreatureMod[] {
  return ids.map((id) => {
    const m = BY_ID.get(id);
    if (!m) {
      throw new Error(
        `creature mod "${id}" is not registered (available: ${[...BY_ID.keys()].join(", ")})`,
      );
    }
    return m;
  });
}
