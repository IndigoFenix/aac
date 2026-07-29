// THE TOY SYSTEM (planning-docs/games/toys-and-song-expansion.md) — the authored
// toys, the DOLL rule, and the joins that make a doll a real makeable thing.
//
// The load-bearing claim under test: a doll is NOT its own kind. It is the same
// head word as the thing it depicts wearing the `toy` FORM facet, so one rule
// covers every creature and vehicle the world contains — and every layer that
// asks "what is this glyph" has to answer from the facet, not the head, or a toy
// rabbit reads as a live rabbit.
//
// Pure — no DB, no THREE. Safe in test:engine / test:unit.

import { describe, it, expect } from "@jest/globals";
import {
  DOLL_RECIPE,
  dollGlyph,
  dollHeadOf,
  isDollableHead,
  isDollGlyph,
  isToyGlyph,
  materialFacetOf,
  toyCraftRecipe,
  toyItemOf,
  toyMaterialOf,
  toyMaterialsOf,
  TOY_HEADS,
  TOY_ITEMS,
  TOY_MATERIALS,
} from "@shared/world-engine/toys.js";
import {
  appearanceOf,
  composeGlyph,
  facetsOf,
  FORM_DIMENSION,
  VARIATION_DIMENSIONS,
} from "@shared/world-engine/variations.js";
import {
  craftRecipeOf,
  depictableHeads,
  drawnMakeable,
  isMakeable,
  makeableGlyph,
  spokenMakeable,
} from "@shared/world-engine/interaction/content/makeable.js";
import { FURNITURE_ITEMS } from "@shared/world-engine/kernel/town/stations.js";
import { POOLS } from "@shared/world-engine/interaction/content/pools.js";
import { isLivingThing, propertiesOf } from "@shared/world-engine/interaction/content/properties.js";
import { foodGlyphs } from "@shared/world-engine/products.js";
import { getVocabularyItem } from "@shared/glyph-registry.js";

describe("the `toy` form facet", () => {
  it("is a registered variation dimension, sorted FIRST so it sits next to the head", () => {
    expect(VARIATION_DIMENSIONS.form).toBe(FORM_DIMENSION);
    // Canonical glyph order comes from the dimension key order.
    expect(Object.keys(VARIATION_DIMENSIONS)[0]).toBe("form");
    expect(composeGlyph("rabbit", ["material_cloth", "toy", "color_red"]))
      .toBe("rabbit.toy.color_red.material_cloth");
  });

  it("miniaturises: the SAME recipe renders small when it wears the facet", () => {
    const real = appearanceOf("car");
    const toy = appearanceOf("car.toy");
    // Loose item props spawn at a uniform ~0.35 m radius, so without a scale
    // here a "toy" car would be built life-size by the very recipe that makes it
    // recognisable. The PROPERTY is what matters — smaller than the real thing,
    // but not so small it reads as a speck on the floor. The exact figure is a
    // legibility judgement that has already moved once (0.4 → 0.75), so pin the
    // band rather than the number.
    expect(toy.scale[0]).toBeLessThan(real.scale[0]);
    expect(toy.scale[0]).toBeGreaterThan(real.scale[0] * 0.5);
    expect(new Set(toy.scale).size).toBe(1); // uniform — a doll is not squashed
  });

  it("is a VARIATION, never a state — a doll is what a thing IS, not a condition", () => {
    expect(facetsOf("rabbit.toy").variations).toContain("toy");
    expect(facetsOf("rabbit.toy").states).toEqual([]);
  });

  it("composes with a material, and the material reads back off the glyph", () => {
    const g = dollGlyph("rabbit", "cloth");
    expect(g).toBe("rabbit.toy.material_cloth");
    expect(toyMaterialOf(g)).toBe("cloth");
    expect(toyMaterialOf("rabbit.toy")).toBeNull();
  });
});

describe("dolls — the same head word, wearing the descriptor", () => {
  it("a doll heads to what it DEPICTS, which is the whole point", () => {
    expect(dollHeadOf("rabbit.toy")).toBe("rabbit");
    expect(dollHeadOf("car.toy.material_wood")).toBe("car");
    expect(dollHeadOf("rabbit")).toBeNull(); // a live rabbit is not a doll
  });

  it("distinguishes a doll from an authored toy — a ball depicts nothing", () => {
    expect(isDollGlyph("ball")).toBe(false);
    expect(isToyGlyph("ball")).toBe(true); // …but it IS a toy
    expect(isDollGlyph("rabbit.toy")).toBe(true);
    expect(isToyGlyph("rabbit.toy")).toBe(true);
    expect(isToyGlyph("rabbit")).toBe(false);
  });

  it("there is no toy of a toy", () => {
    for (const head of TOY_HEADS) {
      expect(isDollableHead(head, depictableHeads())).toBe(false);
    }
  });

  it("depictable heads are the world's creatures and vehicles, from the pools", () => {
    const heads = depictableHeads();
    for (const m of POOLS.vehicle!.members) expect(heads).toContain(m.symbol);
    expect(heads).toContain("rabbit"); // a creature species
    expect(heads).not.toContain("apple"); // food depicts nothing
  });
});

describe("what a toy is MADE of", () => {
  it("wood and cloth only — both have real natural sources", () => {
    expect([...TOY_MATERIALS].sort()).toEqual(["cloth", "wood"]);
    // PLASTIC is deliberately absent: nothing on the planet produces it, and a
    // material that appears from nowhere breaks the rule products.ts enforces.
    expect(TOY_MATERIALS).not.toContain("plastic");
  });

  it("every authored toy names materials drawn from that set", () => {
    for (const t of TOY_ITEMS) {
      expect(t.materials.length).toBeGreaterThan(0);
      for (const m of t.materials) expect(TOY_MATERIALS).toContain(m);
    }
  });

  it("a doll can be either material — a rag doll or a carved figure", () => {
    expect(toyMaterialsOf("rabbit", depictableHeads())).toEqual(DOLL_RECIPE.materials);
    expect(toyMaterialsOf("apple", depictableHeads())).toEqual([]);
  });

  it("a recipe consumes the named material and produces the finished glyph", () => {
    const doll = toyCraftRecipe("rabbit", "cloth", depictableHeads());
    expect(doll).toMatchObject({ consumes: { cloth: 1 }, produces: "rabbit.toy.material_cloth" });
    const ball = toyCraftRecipe("ball", "cloth", depictableHeads());
    expect(ball).toMatchObject({ consumes: { cloth: 1 }, produces: "ball.material_cloth" });
  });

  it("refuses a material the toy can't be made from, rather than guessing", () => {
    // Blocks are cut from wood; there is no such thing as a cloth block.
    expect(toyItemOf("blocks")!.materials).toEqual(["wood"]);
    expect(toyCraftRecipe("blocks", "cloth", depictableHeads())).toBeNull();
  });

  it("the bench SPEEDS every toy and gates none (the craft law)", () => {
    for (const t of TOY_ITEMS) expect(t.at).toBe("workbench");
    expect(DOLL_RECIPE.at).toBe("workbench");
  });
});

describe("the makeable join — what `make <word>` produces", () => {
  it("an authored toy, in its default material", () => {
    // DERIVED from the row, not hard-coded: which material a toy defaults to is
    // a supply decision that moves (ball was cloth until the town turned out to
    // produce none), and a test that pins the answer just breaks when it does.
    // What must hold is that the default is the row's FIRST material.
    for (const t of TOY_ITEMS) {
      expect(makeableGlyph(t.head)).toBe(`${t.head}.${materialFacetOf(t.materials[0]!)}`);
    }
    expect(makeableGlyph("blocks")).toBe("blocks.material_wood");
  });

  it("every default material is one a town can actually supply", () => {
    // The failure this pins: a recipe whose material nothing produces can be
    // ordered and can NEVER finish — the craft job waits on it forever. `wood`
    // is the one toy material with a live supply today.
    for (const t of TOY_ITEMS) expect(t.materials[0]).toBe("wood");
    expect(DOLL_RECIPE.materials[0]).toBe("wood");
  });

  it("make + ANIMAL is a toy of that animal (the plan's rule)", () => {
    expect(makeableGlyph("rabbit")).toBe("rabbit.toy.material_wood");
    expect(dollHeadOf(makeableGlyph("bear")!)).toBe("bear");
  });

  it("make + VEHICLE is a toy of that vehicle", () => {
    expect(makeableGlyph("car")).toBe("car.toy.material_wood");
  });

  it("furniture stays furniture — an unplaced stack, not a doll of a chair", () => {
    expect(makeableGlyph("chair")).toBe("furn.chair");
  });

  it("nothing makeable for words that name neither", () => {
    for (const food of foodGlyphs()) expect(makeableGlyph(food)).toBeNull();
    expect(makeableGlyph("house")).toBeNull(); // a house is BUILT, not made
    expect(isMakeable("water")).toBe(false);
  });

  it("speaks a made glyph as its bare word — never the bookkeeping prefix", () => {
    expect(spokenMakeable("furn.chair")).toBe("chair"); // NOT "furn"
    expect(spokenMakeable("rabbit.toy.material_cloth")).toBe("rabbit");
    expect(spokenMakeable("ball.material_cloth")).toBe("ball");
  });

  it("a stored piece speaks the VOCABULARY's word for its kind, like a standing one", () => {
    // types.ts FIXTURE_WORD — the sim keeps chest/box and cupboard/cabinet
    // apart, the board does not.
    expect(spokenMakeable("furn.chest")).toBe("box");
    expect(spokenMakeable("furn.cupboard")).toBe("cabinet");
  });

  it("draws a furniture stack as its own word, and everything else as ITSELF", () => {
    // The container/inventory icon: `furn.` has no artwork behind it, so a
    // stored piece draws as the piece; a coloured garment keeps its colour.
    expect(drawnMakeable("furn.chair")).toBe("chair");
    expect(drawnMakeable("furn.chest")).toBe("box");
    expect(drawnMakeable("shirt.color_red")).toBe("shirt.color_red");
    expect(drawnMakeable("apple.hot")).toBe("apple.hot");
    expect(drawnMakeable("rabbit.toy.material_cloth")).toBe("rabbit.toy.material_cloth");
  });

  it("every craftable piece draws a glyph the registry has artwork for", () => {
    // The `chest`/`cupboard` bug: a label with no icon is a kind speaking a
    // word the vocabulary never heard of.
    const iconless = FURNITURE_ITEMS.filter((f) => f.craft)
      .map((f) => drawnMakeable(`furn.${f.kind}`))
      .filter((drawn) => !getVocabularyItem(drawn));
    expect(iconless).toEqual([]);
  });
});

describe("craftRecipeOf — one pipeline job shape for furniture and toys alike", () => {
  it("resolves a doll to real inputs at the bench", () => {
    const r = craftRecipeOf("rabbit.toy.material_cloth");
    expect(r).toMatchObject({
      produces: "rabbit.toy.material_cloth",
      consumes: { cloth: 1 },
      at: "workbench",
      label: "rabbit",
    });
  });

  it("resolves furniture through its own row", () => {
    expect(craftRecipeOf("furn.chair")).toMatchObject({
      produces: "furn.chair",
      consumes: { wood: 1 },
      label: "chair",
    });
  });

  it("PRODUCES the ordered glyph, so a named colour survives the craft", () => {
    const r = craftRecipeOf("rabbit.toy.color_red.material_cloth");
    expect(r?.produces).toBe("rabbit.toy.color_red.material_cloth");
  });

  it("returns null for anything uncraftable — the host's honest 'I can't make that'", () => {
    expect(craftRecipeOf("apple")).toBeNull();
    expect(craftRecipeOf("water")).toBeNull();
  });

  it("round-trips: what `make <word>` yields is a recipe the pipeline can run", () => {
    for (const word of ["ball", "blocks", "puzzle", "rabbit", "car", "chair"]) {
      const glyph = makeableGlyph(word);
      expect(glyph).not.toBeNull();
      expect(craftRecipeOf(glyph!)).not.toBeNull();
    }
  });
});

describe("a doll reads as a TOY everywhere, never as its head", () => {
  it("carries the `toy` object property — which is what the fun need selects on", () => {
    expect(propertiesOf("rabbit.toy")).toContain("toy");
    expect(propertiesOf("car.toy")).toContain("toy");
    // The head alone must NOT: a live rabbit is not a plaything.
    expect(propertiesOf("rabbit")).not.toContain("toy");
  });

  it("is NOT a living thing, however alive its head word is", () => {
    expect(isLivingThing("rabbit")).toBe(true);
    expect(isLivingThing("rabbit.toy")).toBe(false);
  });

  it("the authored toys carry it too", () => {
    for (const head of TOY_HEADS) expect(propertiesOf(head)).toContain("toy");
  });
});

describe("the speakable side and the craftable side stay in sync", () => {
  it("every authored toy is a pool member, and every toy pool member is authored", () => {
    const pool = (POOLS.toy?.members ?? []).map((m) => m.symbol).sort();
    expect(pool).toEqual([...TOY_HEADS].sort());
    // A toy that is makeable but unaskable (or askable but unmakeable) is the
    // failure this pins: the pool is the SPEAKABLE side, toys.ts the craftable.
  });

  it("dolls are NOT pool members — that would mean re-listing the species registry", () => {
    const pool = (POOLS.toy?.members ?? []).map((m) => m.symbol);
    for (const head of depictableHeads()) expect(pool).not.toContain(head);
  });
});

describe("the board can DRAW a doll", () => {
  it("`toy` is a registered MODIFIER, or a composed doll renders as a plain head", () => {
    const toy = getVocabularyItem("toy");
    expect(toy).toBeDefined();
    // The compositor's badge stack takes the canonical path only for a registry
    // item that HAS a modifier facet with a badge-family transform; its
    // emoji-fallback arm fires only for keys it can't find at all. So an item
    // that is registered but NOT a modifier draws NOTHING — `rabbit.toy` would
    // silently render as an ordinary rabbit, with no sign it is a toy.
    expect(toy!.modifier).toBeDefined();
    expect(toy!.modifier!.transform).toBe("badge");
    expect(toy!.modifier!.appliesTo).toEqual(expect.arrayContaining(["noun", "animal"]));
  });

  it("every authored toy and the doll word are speakable board vocabulary", () => {
    for (const key of [...TOY_HEADS, "toy", "doll"]) {
      expect(getVocabularyItem(key)).toBeDefined();
    }
  });
});

describe("material facet naming", () => {
  it("matches the MATERIAL_DIMENSION value convention, so a toy renders its material", () => {
    for (const m of TOY_MATERIALS) {
      const facet = materialFacetOf(m);
      expect(VARIATION_DIMENSIONS.material!.values).toContain(facet);
      expect(appearanceOf(`ball.${facet}`).hex).toBeDefined();
    }
  });
});
