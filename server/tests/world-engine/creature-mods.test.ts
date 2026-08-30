// CREATURE MODS — the pin for the world-template modifiers that reshape the
// species registry (creatures/mods.ts + mod-library.ts + world-mods.ts).
//
// Three things are being held still here, and each one has a way of failing
// SILENTLY, which is why they are pinned rather than eyeballed in the lab:
//
//   1. THE GRAVITATION VOCABULARY. "No rule = keep" is the whole design — the
//      animal head, the coat, the horns and the limb thickness survive an
//      animal person because nobody wrote a rule for them. A rule added by
//      accident (or a path typo that silently matches nothing) looks fine in
//      one screenshot and is wrong for every other species.
//   2. THE `human_cute` RETIREMENT. That row was `human` with girth 0.45 and
//      nothing else; the `cute` mod replaces it. If the transform stops
//      landing exactly on 0.45, every shipped world quietly re-proportions.
//   3. THE AUTHORED-WINS LAW. A generated `dog_person` must never displace the
//      hand-drawn one. A registry `set` is silent when it clobbers.
import { describe, it, expect, afterEach } from "@jest/globals";
import {
  parseCreatureMod,
  applyAppearanceMods,
  appearanceModTag,
  deriveModSpecies,
  activeCreatureMods,
  type CreatureMod,
} from "@shared/world-engine/creatures/mods.js";
import { getCreatureMod, listCreatureMods } from "@shared/world-engine/creatures/mod-library.js";
import { applyWorldCreatureMods, previewModSpecies } from "@shared/world-engine/creatures/world-mods.js";
import {
  getSpecies,
  listSpecies,
  requireSpecies,
  speciesBlueprint,
  speciesCanSpeak,
  type Species,
} from "@shared/world-engine/creatures/species.js";
import { parseGameSettings } from "@shared/world-engine/kernel/manifest.js";
import type { Blueprint } from "@shared/world-engine/creatures/blueprint.js";

const cute = getCreatureMod("cute")!;
const animalPeople = getCreatureMod("animal_people")!;

/** Every mod test that INSTALLS must put the registry back — the species
 *  registry is module state shared by every suite in the worker. */
afterEach(() => applyWorldCreatureMods([]));

const bp = (id: string): Blueprint => speciesBlueprint(id);
const cuteOf = (id: string): Blueprint => applyAppearanceMods(requireSpecies(id), bp(id), [cute]);

describe("the mod document gate", () => {
  it("refuses an unknown field by its exact path", () => {
    expect(() => parseCreatureMod({ id: "x", name: "X", description: "d", apearance: {} }, "m"))
      .toThrow(/^m\.apearance: unknown field/);
  });

  it("refuses a mod that does nothing", () => {
    expect(() => parseCreatureMod({ id: "x", name: "X", description: "d" }, "m"))
      .toThrow(/must declare `appearance`, `derive`, or both/);
  });

  it("refuses a gravitation target with no `by`, and a `by` with no target", () => {
    const mk = (rule: unknown) => parseCreatureMod(
      { id: "x", name: "X", description: "d", appearance: { applyTo: {}, gravitate: { "spine.girth": rule } } },
      "m",
    );
    expect(() => mk({ to: 0.4 })).toThrow(/gravitate\.spine\.girth\.by: required alongside `to`/);
    expect(() => mk({ by: 0.5 })).toThrow(/gravitate\.spine\.girth\.by: means nothing without `to`/);
    expect(() => mk({ to: 0.4, by: 2 })).toThrow(/must be between 0 and 1/);
  });

  it("refuses a derived id that isn't unique per base", () => {
    expect(() => parseCreatureMod({
      id: "x", name: "X", description: "d",
      derive: { from: {}, id: "person", name: "n", template: "human", gravitate: {} },
    }, "m")).toThrow(/derive\.id: must contain \{base\}/);
  });

  it("refuses a word pattern in a locale with no ruleset", () => {
    expect(() => parseCreatureMod({
      id: "x", name: "X", description: "d",
      derive: {
        from: {}, id: "{base}_p", name: "n", template: "human", gravitate: {},
        words: { de: { w: "{base}mensch" } },
      },
    }, "m")).toThrow(/derive\.words\.de: unknown locale/);
  });

  it("every shipped mod passes the gate it declares", () => {
    expect(listCreatureMods().map((m) => m.id)).toEqual(["animal_people", "cute"]);
  });
});

describe("cute — the appearance half", () => {
  it("lands `human` exactly on the retired human_cute build", () => {
    // THE PIN. human_cute was human + girth 0.45 and nothing else; if this
    // drifts, every world that declares `cute` re-proportions its people.
    expect(bp("human").spine.girth).toBeCloseTo(0.2, 6);
    expect(cuteOf("human").spine.girth).toBeCloseTo(0.45, 6);
  });

  it("rounds the skull and enlarges the EYES, never the head itself", () => {
    const before = bp("human");
    const after = cuteOf("human");
    // 📕 USER RULING 2026-08-30: the cute look does NOT scale the head. The
    // chunky body already shifts the head:body ratio, and scaling the head on
    // top of that overshot. A rule re-added here would be that regression.
    expect(after.head.sizeFrac).toBeCloseTo(before.head.sizeFrac, 6);
    expect(after.head.braincaseDome).toBeGreaterThan(before.head.braincaseDome);
    expect(after.head.eyeSizeFrac).toBeGreaterThan(before.head.eyeSizeFrac);
    // Shorter, thicker limbs — the other half of the chunky read.
    expect(after.limbGroups[0]!.lengthFrac).toBeLessThan(before.limbGroups[0]!.lengthFrac);
    expect(after.limbGroups[0]!.radiusFrac).toBeGreaterThan(before.limbGroups[0]!.radiusFrac);
  });

  it("is PROPORTIONAL, so a slighter species stays slighter", () => {
    // A `scale` rule preserves the ordering below the ceiling: a cute sheep is
    // a chunkier SHEEP. (Anything already at 0.2+ rides the engine's 0.45 cap,
    // which IS the art style.)
    const sheep = cuteOf("sheep").spine.girth;
    expect(sheep).toBeGreaterThanOrEqual(bp("sheep").spine.girth);
  });

  it("leaves plants and fruit alone", () => {
    for (const id of ["oak", "apple"]) {
      const sp = requireSpecies(id);
      const before = bp(id);
      // The SAME OBJECT back: an unmatched species is not cloned, not
      // re-clamped, not touched.
      expect(applyAppearanceMods(sp, before, [cute])).toBe(before);
    }
  });

  it("never invents a body for a species that has none", () => {
    // A stub's blueprint clamps to a full DEFAULT quadruped, so a transform
    // over it would hand back a real body plan for a word nobody has drawn.
    const stub = listSpecies().find((s) => s.stub)!;
    const empty = { version: 1 } as unknown as Blueprint;
    expect(applyAppearanceMods(stub, empty, [cute])).toBe(empty);
    const spark = requireSpecies("spark");
    expect(applyAppearanceMods(spark, empty, [cute])).toBe(empty);
  });

  it("tags the asset cache, and only when a mod touches appearance", () => {
    expect(appearanceModTag([])).toBe("");
    expect(appearanceModTag([animalPeople])).toBe("");
    expect(appearanceModTag([cute])).toBe("|m:cute");
  });
});

describe("animal_people — the derive half", () => {
  const derived = previewModSpecies(["animal_people"]);
  const byId = new Map(derived.map((d) => [d.id, d] as const));

  it("derives from every non-speaking creature, and from nothing else", () => {
    const speaking = listSpecies().filter((s) => s.canSpeak).map((s) => s.id);
    expect(speaking).toEqual(expect.arrayContaining(["human", "bear_person", "dog_person"]));
    for (const d of derived) {
      const base = requireSpecies(d.derivedFrom);
      expect(base.kind).toBe("creature");
      expect(base.canSpeak).not.toBe(true);
    }
    // Plants and the spark are creatures to nobody.
    expect(derived.some((d) => d.derivedFrom === "oak" || d.derivedFrom === "spark")).toBe(false);
    expect(byId.has("cow_person")).toBe(true);
  });

  it("NEVER displaces an authored animal person", () => {
    for (const id of ["dog_person", "bear_person", "frog_person", "rabbit_person"]) {
      expect(byId.has(id)).toBe(false);
      expect(requireSpecies(id).blueprint).not.toEqual({});
    }
  });

  it("grants speech — the one tag that makes it a person", () => {
    expect(byId.get("cow_person")!.canSpeak).toBe(true);
    expect(requireSpecies("cow").canSpeak).toBeUndefined();
  });

  it("stands the body up and hands it, conserving limb count", () => {
    const cow = bp("cow");
    const person = byId.get("cow_person")!.blueprint as unknown as Blueprint;
    // A cow is two bilateral groups of ONE pair each (fore and hind fold
    // opposite ways — creature-limbs.test.ts). The person is two groups too —
    // legs at the rear station, arms at the front — and still 4 limbs.
    expect(cow.limbGroups).toHaveLength(2);
    expect(person.limbGroups).toHaveLength(2);
    const total = (b: Blueprint) => b.limbGroups.reduce((n, g) => n + g.count, 0);
    expect(total(person)).toBe(total(cow));

    // Found by WHAT THEY ARE, not by index: `bipedalize` rewrites each source
    // group in place, so with a two-group tetrapod the arms come first (the
    // FORE group) and the legs second.
    const arms = person.limbGroups.find((g) => g.opposition > 0)!;
    const legs = person.limbGroups.find((g) => g !== arms)!;
    expect(legs!.stationStart).toBeGreaterThan(arms!.stationStart);
    expect(arms!.opposition).toBeGreaterThan(0); // a hand, not a hoof
    expect(cow.limbGroups[0]!.opposition).toBe(0);

    // LIMB THICKNESS IS THE ANIMAL'S — no rule names radiusFrac, and that is
    // deliberate ("limb thickness similar to the normal animal species").
    // Each derived limb keeps ITS OWN source group's thickness: the person's
    // legs come from the cow's HIND pair and its arms from the FORE pair, and
    // a tetrapod's two pairs are not the same size.
    const [cowFore, cowHind] = cow.limbGroups;
    expect(legs!.radiusFrac).toBeCloseTo(cowHind!.radiusFrac, 6);
    expect(arms!.radiusFrac).toBeCloseTo(cowFore!.radiusFrac, 6);
  });

  it("takes the template's upright posture outright", () => {
    const human = bp("human");
    const person = byId.get("cow_person")!.blueprint as unknown as Blueprint;
    expect(person.posture.bodyPitch).toBeCloseTo(human.posture.bodyPitch, 6);
    expect(bp("cow").posture.bodyPitch).not.toBeCloseTo(human.posture.bodyPitch, 2);
  });

  it("KEEPS the animal head — every dial with no rule survives", () => {
    const cow = bp("cow");
    const person = byId.get("cow_person")!.blueprint as unknown as Blueprint;
    // Untouched: the muzzle's substance, the jaw, the soft tissue, the coat,
    // and the horns. These are what make it a cow and not a person in a mask.
    for (const k of ["muzzleSquash", "snoutFlatten", "jawDepth", "mouthOpen", "cheek", "jowl", "brow", "lips"] as const) {
      expect(person.head[k]).toBeCloseTo(cow.head[k], 6);
    }
    expect(person.skin).toEqual(cow.skin);
    expect(person.growths).toEqual(cow.growths);
    // Shortened but never removed — a muzzle is the point.
    expect(person.head.snoutLengthFrac).toBeGreaterThan(0);
    expect(person.head.snoutLengthFrac).toBeLessThan(cow.head.snoutLengthFrac);
    // Pulled toward a person: the braincase and where the eyes sit.
    expect(person.head.sizeFrac).toBeGreaterThan(cow.head.sizeFrac);
  });

  it("keeps overall size the animal's — a cat person is not an elephant person", () => {
    const size = (id: string) => (byId.get(id)!.blueprint as unknown as Blueprint).spine.torsoLengthM;
    expect(size("elephant_person")).toBeGreaterThan(size("cow_person"));
    expect(size("cow_person")).toBeGreaterThan(size("cat_person"));
    // …and the collision radius follows the body it actually got.
    expect(byId.get("elephant_person")!.bodyRadiusM!).toBeGreaterThan(byId.get("cat_person")!.bodyRadiusM!);
  });

  it("carries the two worldgen facts the design states", () => {
    const d = byId.get("cow_person")!;
    expect(d.derivedFrom).toBe("cow"); // same habitat: it lives where the cow lives
    expect(d.rarity).toBe(0.25); // rarer than the natural species
  });

  it("a stub base derives a STUB person — a word ahead of a body", () => {
    const lion = byId.get("lion_person");
    expect(lion).toBeDefined();
    expect(requireSpecies("lion").stub).toBe(true);
    expect(lion!.stub).toBe(true);
    expect(lion!.blueprint).toEqual({});
    expect(lion!.words?.en?.w).toBe("lion person");
  });

  it("composes each locale's word from that locale's own lexeme", () => {
    const cowP = byId.get("cow_person")!.words!;
    expect(cowP.en!.w).toBe("cow person");
    expect(cowP.he!.w).toBe("איש פרה"); // base lexeme פרה, not the English word
    expect(cowP.es!.w).toBe("hombre vaca");
    expect(cowP.pt!.w).toBe("homem vaca");
    // The silent failure this guards: an English word on a Hebrew board.
    for (const d of derived) {
      for (const loc of ["he", "es", "pt"] as const) {
        const w = d.words?.[loc]?.w;
        if (!w) continue;
        expect(w).not.toBe(d.words!.en?.w);
      }
    }
  });

  it("derives NO word for a locale the base has no word for", () => {
    // `quadruped` is a body plan, not a vocabulary item.
    expect(requireSpecies("quadruped").words).toBeUndefined();
    expect(byId.get("quadruped_person")!.words).toBeUndefined();
  });

  it("is pure — previewing derives nothing into the registry", () => {
    expect(getSpecies("cow_person")).toBeUndefined();
  });
});

describe("installing a world's mods", () => {
  it("registers the derived rows and activates the appearance transform", () => {
    const { derived } = applyWorldCreatureMods(["animal_people", "cute"]);
    expect(derived.length).toBeGreaterThan(0);
    expect(speciesCanSpeak("cow_person")).toBe(true);
    expect(activeCreatureMods().map((m) => m.id)).toEqual(["animal_people", "cute"]);
  });

  it("retracts exactly what it installed when the mods go away", () => {
    applyWorldCreatureMods(["animal_people"]);
    expect(getSpecies("cow_person")).toBeDefined();
    applyWorldCreatureMods([]);
    expect(getSpecies("cow_person")).toBeUndefined();
    // …and never an authored row.
    expect(getSpecies("dog_person")).toBeDefined();
    expect(activeCreatureMods()).toEqual([]);
  });

  it("re-deriving is stable — a second install produces the same rows", () => {
    const a = applyWorldCreatureMods(["animal_people"]).derived.map((d) => d.id);
    const b = applyWorldCreatureMods(["animal_people"]).derived.map((d) => d.id);
    expect(b).toEqual(a);
    expect(b.length).toBeGreaterThan(0);
  });

  it("refuses an unknown mod id by name, listing what IS available", () => {
    expect(() => applyWorldCreatureMods(["cuute"]))
      .toThrow(/creature mod "cuute" is not registered \(available: animal_people, cute\)/);
  });

  it("derives against the AUTHORED registry, so a rerun can't derive off itself", () => {
    applyWorldCreatureMods(["animal_people"]);
    applyWorldCreatureMods(["animal_people"]);
    expect(getSpecies("cow_person_person")).toBeUndefined();
  });
});

describe("the human_cute retirement", () => {
  it("is gone from the registry", () => {
    expect(listSpecies().some((s) => s.id === "human_cute")).toBe(false);
  });

  it("still RESOLVES, so stored documents keep loading", () => {
    expect(getSpecies("human_cute")).toBe(getSpecies("human"));
    expect(requireSpecies("human_cute").id).toBe("human");
  });

  it("`human` is the people species and it speaks", () => {
    expect(speciesCanSpeak("human")).toBe(true);
    expect(speciesCanSpeak("cow")).toBe(false);
    expect(speciesCanSpeak(undefined)).toBe(false);
    expect(speciesCanSpeak("not-a-species")).toBe(false);
  });
});

describe("the world document's `mods` field", () => {
  const settings = (extra: Record<string, unknown> = {}) =>
    parseGameSettings({ scope: "town", world: { seed: 1 }, ...extra }, "g");

  it("defaults to none, and defaults the avatar species to human", () => {
    expect(settings().mods).toEqual([]);
    expect(settings().avatarSpecies).toBe("human");
  });

  it("takes a list of ids in declaration order", () => {
    expect(settings({ mods: ["animal_people", "cute"] }).mods).toEqual(["animal_people", "cute"]);
  });

  it("refuses a non-list, an empty id, and a repeat", () => {
    expect(() => settings({ mods: "cute" })).toThrow(/g\.mods: must be an array/);
    expect(() => settings({ mods: [""] })).toThrow(/g\.mods\[0\]: must be a non-empty mod id string/);
    expect(() => settings({ mods: ["cute", "cute"] })).toThrow(/g\.mods\[1\]: "cute" is declared twice/);
  });

  it("gates SHAPE only — an unknown id is the installer's refusal, not the kernel's", () => {
    // The module law: the kernel routes, owners validate. Same split as
    // `avatar_species`, which it also never resolves against the registry.
    expect(settings({ mods: ["not_a_mod"] }).mods).toEqual(["not_a_mod"]);
  });
});

// A guard for the shape of the library itself: mods are DATA, and a mod that
// names a template species the registry doesn't hold would fail at world load
// rather than at build time.
describe("the shipped library is internally consistent", () => {
  it("every derive names a template the registry holds", () => {
    for (const mod of listCreatureMods()) {
      if (!mod.derive) continue;
      expect(getSpecies(mod.derive.template)).toBeDefined();
    }
  });

  it("a mod set that derives nothing still installs cleanly", () => {
    const noop: CreatureMod = parseCreatureMod({
      id: "noop", name: "n", description: "d",
      appearance: { applyTo: { except: ["human"] }, gravitate: {} },
    }, "m");
    const human = requireSpecies("human") as Species;
    const before = bp("human");
    expect(applyAppearanceMods(human, before, [noop])).toBe(before);
    expect(deriveModSpecies([noop], listSpecies())).toEqual([]);
  });
});
