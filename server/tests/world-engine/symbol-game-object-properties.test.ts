// OBJECT PROPERTIES (world-engine-board-organization.md §4): the one tag set
// that files a noun on the sentence board AND says what it does in the world.
//
// THE LAW UNDER TEST (user): concrete-noun properties are IMPORTED FROM THE
// SPEC SIDE — the station registry, the goods kinds, the pools — never
// re-authored by the board. Nouns hard-coded as CORE ENGINE CONCEPTS (room,
// building, animal, water…) are exempt: no spec, no properties, by design.
// The conformance case below is what keeps a newly-spec'd thing from reaching
// the board untagged (i.e. unfileable).

import { describe, it, expect } from "@jest/globals";
import {
  AXES_FOR_PROPERTY,
  AXIS_WORDS,
  CORE_CONCEPTS,
  descriptorsFor,
  OBJECT_PROPERTIES,
  PROPERTY_FOR_VERB,
  type ObjectProperty,
} from "@shared/world-engine/object-properties.js";
import {
  hasProperty,
  propertiesOf,
  unpropertiedNouns,
} from "@shared/world-engine/interaction/content/properties.js";
import { buildConcepts } from "@shared/world-engine/interaction/content/concepts.js";
import { STATION_PROPERTIES } from "@shared/world-engine/kernel/town/stations.js";
import { isLargeGlyph } from "@shared/world-engine/kernel/town/goods-kinds.js";
import { LEXICON } from "@shared/world-engine/interaction/intent/parse-intent.js";
import {
  surfaceNext,
  type SurfaceNoun,
} from "@shared/world-engine/interaction/intent/surface-next.js";

describe("propertiesOf — spec-derived, never board-authored", () => {
  it("reads furniture from the STATION registry", () => {
    // The fridge is the multi-property case the taxonomy exists for.
    expect(propertiesOf("refrigerator").sort()).toEqual(
      ["appliance", "container", "device", "furniture", "openable"].sort(),
    );
    expect(propertiesOf("cupboard").sort()).toEqual(["container", "furniture", "openable"].sort());
    expect(propertiesOf("oven").sort()).toEqual(["appliance", "device", "furniture"].sort());
    expect(propertiesOf("bowl")).toEqual(["tableware"]);
  });

  it("DERIVES `openable` from the station rows' own flag, not a second list", () => {
    // STATION_PROPERTIES deliberately never spells `openable` — so the board
    // and the mechanic that opens the lid cannot disagree.
    for (const props of Object.values(STATION_PROPERTIES)) {
      expect(props).not.toContain("openable");
    }
    expect(hasProperty("chest", "openable")).toBe(true);
    expect(hasProperty("box", "openable")).toBe(true);
    // A tub has no lid — and the registry is what says so.
    expect(hasProperty("bath", "openable")).toBe(false);
    expect(hasProperty("bed", "openable")).toBe(false);
  });

  it("reads food/clothing from the GOODS kinds, through state facets", () => {
    expect(propertiesOf("apple")).toContain("food");
    expect(propertiesOf("apple.hot")).toContain("food"); // a cooked meal is still food
    expect(propertiesOf("shirt")).toContain("clothing");
    expect(propertiesOf("shirt.dirty")).toContain("clothing"); // laundry is clothing
    // The CATEGORY words the stack vocabulary itself uses.
    expect(propertiesOf("food")).toEqual(["food"]);
    expect(propertiesOf("clothing")).toEqual(["clothing"]);
  });

  it("reads the taught vocabulary from the POOLS and the category map", () => {
    expect(propertiesOf("ball")).toContain("toy");
    expect(propertiesOf("lamp")).toContain("device"); // toggleable pool
    expect(propertiesOf("basket").sort()).toEqual(["container", "openable"].sort());
    expect(propertiesOf("book")).toContain("book");
  });

  it("returns properties in a stable board order, deduped", () => {
    const p = propertiesOf("refrigerator");
    const ranks = p.map((x) => OBJECT_PROPERTIES.indexOf(x));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(p).size).toBe(p.length);
    expect(propertiesOf("refrigerator")).toEqual(p); // pure
  });

  it("core engine concepts are EXEMPT — no spec, no properties, by design", () => {
    for (const core of ["room", "building", "animal", "city", "water", "home"]) {
      expect(CORE_CONCEPTS.has(core)).toBe(true);
      expect(propertiesOf(core)).toEqual([]);
    }
  });
});

describe("conformance — every concrete noun is filable", () => {
  it("no spec'd thing reaches the board untagged", () => {
    const symbols = [
      ...Object.keys(STATION_PROPERTIES),
      ...[...buildConcepts().keys()],
    ];
    // Anything listed here is a thing the board can SAY but cannot FILE —
    // meaning its spec is missing a property, not that a tab is missing.
    expect(unpropertiedNouns(symbols)).toEqual([]);
  });

  it("every FURNITURE kind is too large for a pocket (the size registries agree)", () => {
    // goods-kinds.ts names LARGE_KINDS by hand to stay at the bottom of the
    // kernel; this is the pin its comment promises. A `furniture` property and
    // a pocketable glyph are a contradiction — you carry a chair, you do not
    // pocket it.
    const furniture = Object.keys(STATION_PROPERTIES).filter((k) => propertiesOf(k).includes("furniture"));
    expect(furniture.filter((k) => !isLargeGlyph(k))).toEqual([]);
    // A STORED piece stacks under `furn.<kind>` — the bookkeeping prefix must
    // not smuggle it past the size rule (a boxed chair is still a chair).
    expect(furniture.filter((k) => !isLargeGlyph(`furn.${k}`))).toEqual([]);
  });

  it("every station kind declares what it is", () => {
    for (const [kind, props] of Object.entries(STATION_PROPERTIES)) {
      expect({ kind, empty: props.length === 0 }).toEqual({ kind, empty: false });
    }
  });

  it("ConceptDef carries the same properties the joiner derives", () => {
    const concepts = buildConcepts();
    const ball = concepts.get("ball")!;
    expect(ball.properties).toEqual(propertiesOf("ball"));
    // Concepts with no properties omit the field rather than carrying [].
    expect(concepts.get("rabbit")?.properties).toBeUndefined();
  });
});

describe("PROPERTY_FOR_VERB — the §3.1 sub-tab pre-load", () => {
  it("maps real LEXICON verbs onto real properties", () => {
    for (const [verb, property] of Object.entries(PROPERTY_FOR_VERB)) {
      expect({ verb, known: !!LEXICON[verb] }).toEqual({ verb, known: true });
      expect(OBJECT_PROPERTIES).toContain(property);
    }
  });

  it("every pre-loaded property actually has members (no empty sub-tab)", () => {
    const concepts = buildConcepts();
    const all = new Set<ObjectProperty>();
    for (const c of concepts.values()) for (const p of c.properties ?? []) all.add(p);
    for (const kind of Object.keys(STATION_PROPERTIES)) {
      for (const p of propertiesOf(kind)) all.add(p);
    }
    for (const property of Object.values(PROPERTY_FOR_VERB)) {
      // `structure` comes from the build catalog at runtime, not the static
      // library — every OTHER pre-load must land on something speakable.
      if (property === "structure") continue;
      expect({ property, has: all.has(property) }).toEqual({ property, has: true });
    }
  });
});

describe("surfaceNext — the verb pre-loads its property group", () => {
  const NOUNS: SurfaceNoun[] = [
    { symbol: "apple", kind: "item", affords: ["want", "get"], properties: ["food"] },
    { symbol: "teddy", kind: "item", affords: ["want", "get"], properties: ["toy"] },
    { symbol: "chest", kind: "place", affords: ["go", "open"], properties: ["furniture", "container", "openable"] },
    { symbol: "bed", kind: "place", affords: ["go", "sleep"], properties: ["furniture"] },
  ];

  it("names the sub-tab the verb wants", () => {
    expect(surfaceNext(["you", "eat"], { nouns: NOUNS }).subTab).toBe("food");
    expect(surfaceNext(["you", "play"], { nouns: NOUNS }).subTab).toBe("toy");
    expect(surfaceNext(["you", "open"], { nouns: NOUNS }).subTab).toBe("openable");
    // A verb with no property group leaves the tab alone.
    expect(surfaceNext(["you", "sleep"], { nouns: NOUNS }).subTab).toBeUndefined();
  });

  it("ranks the property group ABOVE the noun's own affordance list", () => {
    // The apple's affords here deliberately omit `eat` — the PROPERTY is what
    // surfaces it, which is the whole point of tagging from the spec side.
    const s = surfaceNext(["you", "eat"], { nouns: NOUNS });
    expect(s.buttons[0]?.symbol).toBe("apple");
    const play = surfaceNext(["you", "play"], { nouns: NOUNS });
    expect(play.buttons[0]?.symbol).toBe("teddy");
  });

  it("a destination slot pre-loads containers ('put the ball in …')", () => {
    const s = surfaceNext(["you", "put", "apple"], { nouns: NOUNS });
    expect(s.subTab).toBe("container");
    const ranked = s.buttons.filter((b) => b.role === "destination").map((b) => b.symbol);
    expect(ranked[0]).toBe("chest");
  });

  it("stays context-blind — the same tokens give the same board, always", () => {
    const a = surfaceNext(["you", "eat"], { nouns: NOUNS });
    const b = surfaceNext(["you", "eat"], { nouns: [...NOUNS].reverse() });
    expect(b.buttons.map((x) => x.symbol)).toEqual(a.buttons.map((x) => x.symbol));
  });
});

// ── Descriptor axes: the words that fit the THING (object-properties.ts) ─────

describe("descriptor axes — typed, never one flat adjective list", () => {
  it("food talks temperature before possession; buildings the reverse", () => {
    const food = descriptorsFor("item", ["food"]);
    expect(food.indexOf("hot")).toBeGreaterThanOrEqual(0);
    expect(food.indexOf("hot")).toBeLessThan(food.indexOf("my"));
    const building = descriptorsFor("place", ["structure"]);
    expect(building[0]).toBe("my");
    expect(building).not.toContain("hot");
  });

  it("SCOPE-BREADTH LAW: places possess at every scale and settlements FEEL", () => {
    // town/city/area are CORE CONCEPTS — no spec properties — so the kind tier
    // alone must yield "my city" (territory) and "city hungry" (the city HUD's
    // famine face): in-game–common combinations surface even where real-life
    // usage would call them odd. The family↔civilization analogy is data here.
    const settlement = descriptorsFor("place", []);
    expect(settlement[0]).toBe("my");
    expect(settlement).toContain("hungry");
    expect(settlement).toContain("sad");
  });

  it("creatures lead with the need axes (hungry before big)", () => {
    const creature = descriptorsFor("creature", []);
    expect(creature.indexOf("hungry")).toBeLessThan(creature.indexOf("big"));
  });

  it("every property binds ≥1 axis and every axis names ≥1 word", () => {
    for (const p of OBJECT_PROPERTIES) {
      expect({ p, bound: AXES_FOR_PROPERTY[p].length > 0 }).toEqual({ p, bound: true });
    }
    for (const [axis, words] of Object.entries(AXIS_WORDS)) {
      expect({ axis, named: words.length > 0 }).toEqual({ axis, named: true });
    }
  });

  it("the speakable axis words really are LEXICON attributes", () => {
    // (my/your and the dimension words live only in the glyph registry's
    // modifier store — the rail's vocabulary — and that is by design.)
    for (const w of ["hungry", "hot", "big", "broken", "full", "happy", "dirty"]) {
      expect({ w, cat: (LEXICON[w] as { cat?: string } | undefined)?.cat }).toEqual({ w, cat: "attribute" });
    }
  });
});
