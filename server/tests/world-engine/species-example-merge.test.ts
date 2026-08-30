// THE ONE-LIST INVARIANT: `creatures/examples.ts` and `creatures/species.ts`
// are a single catalogue joined by species id.
//
// They used to be two lists joined by DISPLAY TITLE ("Crocodile (long jaw)"),
// kept in step by hand — and they weren't. Six fully authored bodies (snake,
// fish, crocodile, spider, crab, octopus) sat in examples.ts with nothing able
// to reach them, while the same six words were `stub` rows on a child's board.
// Nothing failed, because nothing was checking in that direction.
//
// So this suite pins BOTH directions:
//   • a species row with no example under its id is a stub (legitimate — the
//     word ships ahead of the body plan), and
//   • an example with no species row is an ERROR, which species.ts throws at
//     module load. Adding a creature is one entry in each file, or neither.
//
// Also pins the override chain (examples < animals-people < lab), which is
// load-bearing for `human` and would otherwise be a silent behaviour change the
// day someone reorders the loops.
//
// PURE DATA — no THREE, no quest-host, so it stays cheap.

import { describe, it, expect } from "@jest/globals";
import { CREATURE_EXAMPLES } from "@shared/world-engine/creatures/examples.js";
import {
  getSpecies,
  listSpecies,
  speciesBlueprint,
} from "@shared/world-engine/creatures/species.js";
import { ANIMAL_PEOPLE_BLUEPRINTS } from "@shared/world-engine/creatures/animals-people.js";
import { listAllVocabulary } from "@shared/glyph-registry.js";

describe("species ↔ worked-example merge", () => {
  it("gives every worked example a species row (the invariant that keeps one list)", () => {
    const orphans = CREATURE_EXAMPLES.filter((ex) => !getSpecies(ex.id)).map(
      (ex) => `${ex.id} ("${ex.title}")`,
    );
    expect(orphans).toEqual([]);
  });

  it("lets no two examples claim the same id", () => {
    const ids = CREATURE_EXAMPLES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keys examples by id, not by display title", () => {
    for (const ex of CREATURE_EXAMPLES) {
      // The id is a lookup key: lower snake_case, never a prose title.
      expect(ex.id).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(ex.title.trim().length).toBeGreaterThan(0);
    }
  });

  it("derives `stub` from the join: an example means a body, none means a stub", () => {
    const exampleIds = new Set(CREATURE_EXAMPLES.map((e) => e.id));
    for (const sp of listSpecies()) {
      if (sp.bodiless) continue; // the spark has no body BY NATURE, not yet
      if (exampleIds.has(sp.id)) {
        expect(`${sp.id}:stub=${!!sp.stub}`).toBe(`${sp.id}:stub=false`);
        expect(Object.keys(sp.blueprint).length).toBeGreaterThan(0);
      } else if (sp.stub) {
        // A stub must never carry a body anything could clamp into a default.
        expect(sp.blueprint).toEqual({});
      }
    }
  });

  it("graduated the six words whose bodies were already authored", () => {
    // These had a body in examples.ts and a `stub` row here at the same time —
    // the exact drift the title-keyed join hid. They must keep their words.
    for (const id of ["snake", "fish", "crocodile", "spider", "crab", "octopus"]) {
      const sp = getSpecies(id);
      expect(sp).toBeDefined();
      expect(sp!.stub).toBeFalsy();
      expect(sp!.words?.he?.w).toBeTruthy();
      expect(speciesBlueprint(id).version).toBe(1);
    }
  });

  it("registered the nine examples that had no row at all", () => {
    for (const id of [
      "beetle", "jellyfish", "stingray", "centipede", "wasp", "mantis",
      "raptor", "dimetrodon", "plesiosaur",
    ]) {
      const sp = getSpecies(id);
      expect(sp).toBeDefined();
      expect(sp!.kind).toBe("creature");
      expect(sp!.stub).toBeFalsy();
      expect(speciesBlueprint(id).version).toBe(1);
    }
  });
});

describe("blueprint override chain", () => {
  it("lets the lab-authored people body beat the worked example (examples < animals-people)", () => {
    const authored = ANIMAL_PEOPLE_BLUEPRINTS.find((bp) => bp.name === "human");
    expect(authored).toBeDefined();
    // The registry's `human` IS the animals-people blueprint object, not the
    // "Human (biped + hands)" example. Ordering, not coincidence.
    expect(getSpecies("human")!.blueprint).toBe(authored);
    const example = CREATURE_EXAMPLES.find((e) => e.id === "human");
    expect(example).toBeDefined();
    expect(getSpecies("human")!.blueprint).not.toBe(example!.blueprint);
  });

  it("still builds the superseded example's id (nothing was orphaned by the override)", () => {
    expect(speciesBlueprint("human").limbGroups.length).toBe(2);
  });
});

describe("a worded species is board vocabulary", () => {
  it("gives every species that carries `words` a glyph item to draw", () => {
    // `words` is what puts a species on the sentence builder's [animals] /
    // [plants] chip. Without a `shared/glyph-registry.ts` item the button has no
    // picture and no eleven translations — it renders the raw key. A species row
    // without `words` is a body the world builds, not a word, and is exempt.
    const glyphKeys = new Set(listAllVocabulary().map((v) => v.key));
    const missing = listSpecies()
      .filter((sp) => sp.words && !glyphKeys.has(sp.id))
      .map((sp) => sp.id);
    expect(missing).toEqual([]);
  });
});
