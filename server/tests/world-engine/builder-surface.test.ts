// The builder-surface adapter (builder-surface.ts): the engine's surfacer
// rendered as the plain-JSON `builder_surface` wire shape the games-bridge
// carries. Pure + deterministic; structurally matches the bridge contract
// without importing it.

import { describe, it, expect } from "@jest/globals";
import {
  BUILDER_CATEGORIES,
  builderSurfaceFor,
  defaultBuilderNouns,
  type BuilderNounEntry,
} from "@shared/world-engine/interaction/intent/builder-surface.js";
import { propertiesOf } from "@shared/world-engine/interaction/content/properties.js";
import { CORE_CONCEPTS } from "@shared/world-engine/object-properties.js";
import { headOf } from "@shared/world-engine/variations.js";

const NOUNS: BuilderNounEntry[] = [
  { symbol: "apple", label: "apple", kind: "item", affords: ["eat", "want", "get", "give"], properties: ["food"] },
  { symbol: "ball", label: "ball", kind: "item", affords: ["get", "give", "play", "throw", "want"], properties: ["toy"] },
  { symbol: "mara", label: "Mara", kind: "creature", affords: ["talk", "help", "hug", "give", "follow"], present: true },
  { symbol: "papa", label: "Papa", kind: "creature", affords: ["talk", "help", "hug", "give", "follow"], present: false },
  { symbol: "bed", kind: "place", affords: ["go", "sleep"], properties: ["furniture"] },
  { symbol: "home", kind: "place", affords: ["go"] },
];

const keys = (s: ReturnType<typeof builderSurfaceFor>) => s.buttons.map((b) => b.key);

describe("builderSurfaceFor — the bridge surface", () => {
  it("empty sentence: starter words plus the category-chip ladder", () => {
    const s = builderSurfaceFor("", { nouns: NOUNS });
    const k = keys(s);
    expect(k).toContain("i_me");
    expect(k).toContain("want");
    expect(k).toContain("you");
    expect(s.categories).toEqual([...BUILDER_CATEGORIES]);
    expect(s.categories).toContain("things");
    expect(s.categories).toContain("verb");
    expect(s.complete).toBe(false);
    // Every button is a self-contained wire word: key + label + glyph + category.
    for (const b of s.buttons) {
      expect(typeof b.key).toBe("string");
      expect(b.key.length).toBeGreaterThan(0);
      expect(typeof b.label).toBe("string");
      expect(b.label.length).toBeGreaterThan(0);
      expect(typeof b.glyph).toBe("string");
      expect(typeof b.category).toBe("string");
    }
  });

  it('partial "i_me + want" surfaces the objects (the nouns)', () => {
    const s = builderSurfaceFor("i_me + want", { nouns: NOUNS });
    const k = keys(s);
    expect(k).toContain("apple");
    expect(k).toContain("ball");
    expect(s.complete).toBe(false); // "i_me want" has no object yet
  });

  it("noun buttons carry kind + the scene-presence flag from the passed nouns", () => {
    const s = builderSurfaceFor("hi", { nouns: NOUNS }); // greeting → addressees
    const mara = s.buttons.find((b) => b.key === "mara");
    expect(mara).toBeDefined();
    expect(mara!.kind).toBe("creature");
    expect(mara!.present).toBe(true);
    expect(mara!.label).toBe("Mara");
    const papa = s.buttons.find((b) => b.key === "papa");
    expect(papa).toBeDefined();
    expect(papa!.present).toBe(false);
    // Lexicon function words carry a category but never kind/present.
    const you = s.buttons.find((b) => b.key === "you");
    expect(you?.category).toBe("person");
    expect(you?.kind).toBeUndefined();
    expect(you?.present).toBeUndefined();
  });

  it("modifiers appear for a modifiable head (food → temperature first)", () => {
    const s = builderSurfaceFor("i_me + want + apple", { nouns: NOUNS });
    expect(s.modifiers).toBeDefined();
    const mods = s.modifiers!.map((m) => m.key);
    expect(mods).toContain("hot"); // food's first axis is temperature
    expect(mods.indexOf("hot")).toBeLessThan(mods.indexOf("my") < 0 ? Infinity : mods.indexOf("my"));
    expect(s.modifiers!.length).toBeLessThanOrEqual(8);
    // A speaker head takes the creature axes ("i_me + hungry" is one press).
    const me = builderSurfaceFor("i_me", { nouns: NOUNS });
    expect(me.modifiers!.map((m) => m.key)).toContain("hungry");
    // A verb head offers no descriptor rail.
    expect(builderSurfaceFor("i_me + want", { nouns: NOUNS }).modifiers).toBeUndefined();
    // An already-applied modifier never re-surfaces.
    const hot = builderSurfaceFor("apple.hot", { nouns: NOUNS });
    expect(hot.modifiers!.map((m) => m.key)).not.toContain("hot");
  });

  it("a category filter lists that tab's full vocabulary (SpeakMenu tabs)", () => {
    const verbs = builderSurfaceFor("", { nouns: NOUNS, category: "verb" });
    const vk = keys(verbs);
    expect(vk).toContain("want");
    expect(vk).toContain("go");
    expect(vk).toContain("eat");
    expect(vk).not.toContain("apple");
    expect(vk).not.toContain("i_me");
    const things = builderSurfaceFor("", { nouns: NOUNS, category: "things" });
    expect(keys(things)).toEqual(["apple", "ball", "mara", "papa", "bed", "home"]);
    // An unknown category falls back to the suggested grid.
    const junk = builderSurfaceFor("", { nouns: NOUNS, category: "nope" });
    expect(keys(junk)).toContain("i_me");
  });

  it("complete flips on a full sentence", () => {
    expect(builderSurfaceFor("", { nouns: NOUNS }).complete).toBe(false);
    expect(builderSurfaceFor("i_me + want", { nouns: NOUNS }).complete).toBe(false);
    expect(builderSurfaceFor("i_me + want + apple", { nouns: NOUNS }).complete).toBe(true);
    expect(builderSurfaceFor("you + go + home", { nouns: NOUNS }).complete).toBe(true);
    // The completeness verdict holds even under a category filter.
    expect(builderSurfaceFor("i_me + want + apple", { nouns: NOUNS, category: "verb" }).complete).toBe(true);
  });

  it("locale localizes the word labels through the lang layer", () => {
    const he = builderSurfaceFor("", { nouns: NOUNS, locale: "he-IL" });
    const en = builderSurfaceFor("", { nouns: NOUNS, locale: "en" });
    const heWant = he.buttons.find((b) => b.key === "want");
    const enWant = en.buttons.find((b) => b.key === "want");
    expect(heWant).toBeDefined();
    expect(enWant).toBeDefined();
    expect(heWant!.label).not.toBe(enWant!.label);
    // A game-supplied noun label survives any locale.
    const things = builderSurfaceFor("", { nouns: NOUNS, locale: "he-IL", category: "things" });
    expect(things.buttons.find((b) => b.key === "mara")!.label).toBe("Mara");
  });

  it("deterministic and plain JSON (survives structuredClone + JSON round-trip)", () => {
    const a = builderSurfaceFor("i_me + want", { nouns: NOUNS });
    const b = builderSurfaceFor("i_me + want", { nouns: NOUNS });
    expect(b).toEqual(a);
    expect(structuredClone(a)).toEqual(a);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });
});

describe("builderSurfaceFor — group chips (the SpeakMenu's sub-category hierarchy)", () => {
  it("the default view is RANK-ordered (frequency prior), never category-ordered", () => {
    const s = builderSurfaceFor("", { nouns: NOUNS });
    // The 54-weight opener band resolves by the AAC frequency prior:
    // want (rank 0) before i_me (15) before you (16).
    expect(keys(s).slice(0, 3)).toEqual(["want", "i_me", "you"]);
    // Categories interleave by rank — a question word ("where") outranks a
    // plain opener verb ("go"), so the grid is NOT grouped by category.
    const k = keys(s);
    expect(k.indexOf("where")).toBeGreaterThan(-1);
    expect(k.indexOf("go")).toBeGreaterThan(-1);
    expect(k.indexOf("where")).toBeLessThan(k.indexOf("go"));
  });

  it("the ranked view carries the surfacer's own group chips (clusters that open something new)", () => {
    // Small capacity forces the creature/place nouns off the grid — their
    // clusters must then surface as chips (the SpeakMenu's group cells).
    const s = builderSurfaceFor("", { nouns: NOUNS, capacity: 4 });
    const ids = (s.groups ?? []).map((g) => g.id);
    expect(ids).toContain("creatures");
    expect(ids).toContain("places");
    for (const g of s.groups!) {
      expect(g.label.length).toBeGreaterThan(0);
      expect(typeof g.glyph).toBe("string");
    }
  });

  it("a group filter on the ranked view opens that cluster's full ranked expansion", () => {
    const s = builderSurfaceFor("", { nouns: NOUNS, capacity: 4, group: "creatures" });
    expect(keys(s)).toEqual(["mara", "papa"]);
    // The surfacer's resolved noun labels survive the group expansion.
    expect(s.buttons[0]!.label).toBe("Mara");
    // The chips stay offered alongside the expansion (the back-out ladder).
    expect((s.groups ?? []).map((g) => g.id)).toContain("creatures");
    // Unknown/stale group ids fall back to the ranked grid — never an empty board.
    expect(keys(builderSurfaceFor("", { nouns: NOUNS, group: "nope" }))).toContain("want");
  });

  it("the verb's pre-loaded property cluster leads the chips (eat → food)", () => {
    const s = builderSurfaceFor("you + eat", { nouns: defaultBuilderNouns(), capacity: 3 });
    expect(s.groups?.[0]?.id).toBe("food");
  });

  it('the "things" tab sub-groups the FULL noun library; a group filters it', () => {
    const s = builderSurfaceFor("", { nouns: NOUNS, category: "things" });
    const ids = (s.groups ?? []).map((g) => g.id);
    // ≥2-member clusters only (a chip must open a real subset).
    expect(ids).toEqual(["creatures", "places"]);
    const creatures = builderSurfaceFor("", { nouns: NOUNS, category: "things", group: "creatures" });
    expect(keys(creatures)).toEqual(["mara", "papa"]);
    const places = builderSurfaceFor("", { nouns: NOUNS, category: "things", group: "places" });
    expect(keys(places)).toEqual(["bed", "home"]);
    // A stale group id shows the full listing, never an empty board.
    const stale = builderSurfaceFor("", { nouns: NOUNS, category: "things", group: "gone" });
    expect(keys(stale)).toEqual(NOUNS.map((n) => n.symbol));
  });

  it("lexical category tabs stay flat (no sub-groups), like the SpeakMenu", () => {
    expect(builderSurfaceFor("", { nouns: NOUNS, category: "verb" }).groups).toBeUndefined();
    expect(builderSurfaceFor("", { nouns: NOUNS, category: "verb", group: "food" }).buttons.length).toBeGreaterThan(0);
  });

  it("group labels localize through the lang layer", () => {
    const nouns = defaultBuilderNouns();
    const en = builderSurfaceFor("", { nouns, category: "things" });
    const he = builderSurfaceFor("", { nouns, category: "things", locale: "he-IL" });
    const enFood = en.groups?.find((g) => g.id === "food");
    const heFood = he.groups?.find((g) => g.id === "food");
    expect(enFood).toBeDefined();
    expect(heFood).toBeDefined();
    expect(enFood!.label).toBe("food");
    expect(heFood!.label).not.toBe(enFood!.label);
  });
});

describe("defaultBuilderNouns — the out-of-game object set", () => {
  it("non-empty, deterministic, all items, no presence, no invented keys", () => {
    const nouns = defaultBuilderNouns();
    expect(nouns.length).toBeGreaterThanOrEqual(15);
    expect(nouns.length).toBeLessThanOrEqual(25);
    expect(defaultBuilderNouns()).toEqual(nouns); // same list every call
    for (const n of nouns) {
      expect(n.kind).toBe("item");
      expect(n.present).toBeUndefined();
      expect(n.affords!.length).toBeGreaterThan(0);
      // NO INVENTED KEYS (user law: properties from the spec side): every
      // head is one the engine's registries genuinely know — it carries
      // spec-derived properties, or it is a core engine concept (water).
      expect(
        n.properties!.length > 0 || CORE_CONCEPTS.has(headOf(n.symbol)),
      ).toBe(true);
      expect(n.properties).toEqual(propertiesOf(n.symbol)); // spec-side, never authored
    }
    // The staples the dollhouse teaches (teddy = the doll facet, `bear.toy`).
    const syms = nouns.map((n) => n.symbol);
    for (const s of ["apple", "ball", "bear.toy", "shirt"]) expect(syms).toContain(s);
    expect(new Set(syms).size).toBe(syms.length); // no duplicates
  });

  it('every default noun surfaces under the "things" category filter', () => {
    const nouns = defaultBuilderNouns();
    const s = builderSurfaceFor("", { nouns, category: "things" });
    expect(s.buttons.map((b) => b.key)).toEqual(nouns.map((n) => n.symbol));
    for (const b of s.buttons) {
      expect(b.category).toBe("things");
      expect(b.kind).toBe("item");
      expect(b.label.length).toBeGreaterThan(0);
    }
  });

  it("drives a working surface: eat → food first, and a full round-trip stays JSON", () => {
    const nouns = defaultBuilderNouns();
    const s = builderSurfaceFor("you + eat", { nouns });
    expect(s.buttons[0]!.key).toBe("apple"); // food property leads for "eat"
    expect(builderSurfaceFor("you + eat + apple", { nouns }).complete).toBe(true);
    const whole = builderSurfaceFor("i_me + want", { nouns });
    expect(structuredClone(whole)).toEqual(whole);
    expect(JSON.parse(JSON.stringify(whole))).toEqual(whole);
    expect(JSON.parse(JSON.stringify(nouns))).toEqual(nouns);
  });
});
