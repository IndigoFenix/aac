// The builder-surface adapter (builder-surface.ts): the engine's surfacer
// rendered as the plain-JSON `builder_surface` wire shape the games-bridge
// carries. Pure + deterministic; structurally matches the bridge contract
// without importing it.

import { describe, it, expect } from "@jest/globals";
import {
  BUILDER_CATEGORIES,
  builderSurfaceFor,
  defaultBuilderNouns,
  placeBuilderNouns,
  type BuilderNounEntry,
} from "@shared/world-engine/interaction/intent/builder-surface.js";
import { propertiesOf } from "@shared/world-engine/interaction/content/properties.js";
import { CORE_CONCEPTS } from "@shared/world-engine/object-properties.js";
import { headOf } from "@shared/world-engine/variations.js";
import {
  DEFAULT_ROOM_PROGRAMS,
  DEFAULT_STRUCTURE_PROGRAMS,
  programOverridesOf,
  resolveRoomPrograms,
} from "@shared/world-engine/kernel/town/programs.js";
import { tokenizeSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import { canResolveGlyph, parseGlyph } from "@shared/glyph-compositor.js";

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

  // ⑫ (conversation-in-motion.md law ②) — the roster reaches the BOARD through
  // the same bridge the nouns take, so a request built in a crowd can name whom
  // it is for. The bridge's whole job here is to pass it through unchanged.
  it("⑫ a 3+ roster puts the NAMES first — asking in a crowd starts with whom", () => {
    // The names were always on the board (a creature is wantable — "i_me + want
    // + mara" is wanting her company). What the roster changes is RANK: as
    // addressees they outrank the objects, so the first thing offered to a child
    // asking for something in a crowd is the person to ask.
    const crowd = builderSurfaceFor("i_me + want", { nouns: NOUNS, addressees: ["mara", "papa"] });
    const alone = builderSurfaceFor("i_me + want", { nouns: NOUNS });
    expect(keys(crowd).slice(0, 2).sort()).toEqual(["mara", "papa"]);
    expect(keys(alone).slice(0, 2).sort()).toEqual(["apple", "ball"]);
  });

  it("⑫ a DYAD changes nothing — nobody to disambiguate from (law ④)", () => {
    expect(builderSurfaceFor("i_me + want", { nouns: NOUNS, addressees: ["mara"] }))
      .toEqual(builderSurfaceFor("i_me + want", { nouns: NOUNS }));
  });

  it("⑫ no roster ⇒ the board is byte-identical to today", () => {
    expect(builderSurfaceFor("i_me + want", { nouns: NOUNS, addressees: [] }))
      .toEqual(builderSurfaceFor("i_me + want", { nouns: NOUNS }));
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

  it("a group chip wears up to three members — the BEST examples, not the alphabet", () => {
    const nouns = defaultBuilderNouns();
    const byId = new Map(
      (builderSurfaceFor("", { nouns, category: "things" }).groups ?? []).map((g) => [g.id, g]),
    );
    const food = byId.get("food")!;
    // Three faces, best first, and `glyph` stays the single-face shorthand.
    expect(food.glyphs).toEqual(["apple", "banana", "cookie"]);
    expect(food.glyph).toBe(food.glyphs![0]);
    // The prototype prior decides the face, so a category shows its most
    // ordinary member — never whatever the alphabet or the noun list put first.
    expect(byId.get("toy")!.glyphs![0]).toBe("ball");
    expect(byId.get("furniture")!.glyphs).toEqual(["bed", "chair", "table"]);
    // A refrigerator is a container too, but a box says "container" plainly.
    expect(byId.get("container")!.glyphs![0]).toBe("box");
    // Fewer than three members → fewer faces (the chip draws what it has).
    expect(byId.get("clothing")!.glyphs).toEqual(["shirt", "dress"]);
  });

  it("the chip's faces are the members' DISPLAY glyphs, so places draw their icon", () => {
    const places = (builderSurfaceFor("", { nouns: defaultBuilderNouns(), category: "things" }).groups ?? [])
      .find((g) => g.id === "places")!;
    // home leads (a place is home outward), and every face is the composed
    // shell+symbol icon — the bare word would render nothing.
    expect(places.glyphs![0]).toBe("building(family)");
    for (const g of places.glyphs!) expect(canResolveGlyph(g)).toBe(true);
  });

  it("group faces never reorder the group's own expansion", () => {
    // `members` answers "what could I say next" and stays in surfacing rank;
    // only the CHIP's face is picked by the prototype prior.
    const s = builderSurfaceFor("", { nouns: NOUNS, category: "things", group: "creatures" });
    expect(keys(s)).toEqual(["mara", "papa"]);
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
  it("non-empty, deterministic, items and places, no presence, no invented keys", () => {
    const nouns = defaultBuilderNouns();
    expect(nouns.length).toBeGreaterThanOrEqual(15);
    expect(defaultBuilderNouns()).toEqual(nouns); // same list every call
    // Two kinds now: the curated OBJECTS, and every PLACE the programs know.
    const items = nouns.filter((n) => n.kind === "item");
    const places = nouns.filter((n) => n.kind === "place");
    expect(items.length).toBeGreaterThanOrEqual(15);
    expect(items.length).toBeLessThanOrEqual(25);
    expect(items.length + places.length).toBe(nouns.length);
    for (const n of nouns) {
      expect(n.present).toBeUndefined();
      expect(n.affords!.length).toBeGreaterThan(0);
      expect(n.properties).toEqual(propertiesOf(n.symbol)); // spec-side, never authored
    }
    for (const n of items) {
      // NO INVENTED KEYS (user law: properties from the spec side): every
      // head is one the engine's registries genuinely know — it carries
      // spec-derived properties, or it is a core engine concept (water).
      expect(
        n.properties!.length > 0 || CORE_CONCEPTS.has(headOf(n.symbol)),
      ).toBe(true);
    }
    // A PLACE's key is legitimate for the same reason, one repository over:
    // it IS a room kind or a building character the programs declare.
    const declared = new Set<string>([
      ...DEFAULT_ROOM_PROGRAMS.map((d) => d.word ?? d.kind),
      ...DEFAULT_STRUCTURE_PROGRAMS.map((d) => d.word ?? d.type),
    ]);
    for (const n of places) expect(declared.has(n.symbol)).toBe(true);
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
      expect(["item", "place"]).toContain(b.kind);
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

// PLACES ARE SINGLE WORDS THAT RENDER AS COMPOSED ICONS.
//
// The rule, stated by the user and pinned here: a room or a building is ONE
// WORD in the sentence — `bedroom`, `smithy` — and the compositor is used only
// to DRAW it (`room(bed)`, `building(anvil)`). If the composition ever leaked
// into the key, the builder would be emitting parentheses into glyph strings it
// deliberately never emits and `tokenizeSentence` cannot parse.
describe("placeBuilderNouns — every room and building the spec knows", () => {
  it("offers one entry per room kind and building character", () => {
    const places = placeBuilderNouns();
    const syms = places.map((p) => p.symbol);
    // Buildings first (you name a building more often than a room of it).
    for (const t of ["home", "workshop", "shop", "smithy", "temple", "weaver", "library"]) {
      expect(syms).toContain(t);
    }
    for (const k of ["bedroom", "kitchen", "bathroom", "living", "storeroom", "forge", "shrine", "weaving", "study"]) {
      expect(syms).toContain(k);
    }
    expect(new Set(syms).size).toBe(syms.length);
    expect(places.every((p) => p.kind === "place")).toBe(true);
    expect(placeBuilderNouns()).toEqual(places); // deterministic
  });

  it("the KEY is a single word and the GLYPH is the composed icon", () => {
    const places = placeBuilderNouns();
    for (const p of places) {
      // The word: no parentheses, no "+", no ".", ever.
      expect(p.symbol).toMatch(/^[a-z_]+$/);
      // The icon: composed, and it renders.
      expect(canResolveGlyph(p.glyph!)).toBe(true);
    }
    const bedroom = places.find((p) => p.symbol === "bedroom")!;
    expect(bedroom.glyph).toBe("room(bed)");
    const smithy = places.find((p) => p.symbol === "smithy")!;
    expect(smithy.glyph).toBe("building(anvil)");
  });

  it("the surface carries the word as key and the composition as glyph", () => {
    // THE WHOLE POINT, end to end: what the client presses vs what it draws.
    const s = builderSurfaceFor("", { nouns: placeBuilderNouns(), category: "things" });
    const smithy = s.buttons.find((b) => b.key === "smithy")!;
    expect(smithy.key).toBe("smithy");
    expect(smithy.glyph).toBe("building(anvil)");
    // And a pressed key composes into a parseable one-slot sentence.
    expect(parseGlyph(smithy.key).slots).toHaveLength(1);
    expect(tokenizeSentence(smithy.key)).toEqual(["smithy"]);
  });

  it("every place word has a LOCALIZED label, never the raw English key", () => {
    // `baseWord` falls back to the raw key for anything the lexicon misses —
    // the untranslated-button bug. Hebrew is the check that catches it.
    const nouns = placeBuilderNouns();
    for (const locale of ["en", "he", "es", "pt"]) {
      const s = builderSurfaceFor("", { nouns, category: "things", locale });
      for (const b of s.buttons) {
        expect(b.label.length).toBeGreaterThan(0);
        if (locale !== "en") {
          expect({ locale, key: b.key, label: b.label }).not.toEqual({ locale, key: b.key, label: b.key });
        }
      }
    }
  });

  it("reads the RESOLVED programs, so a culture's own rooms surface too", () => {
    // The repositories are the vocabulary: author a room kind and it becomes a
    // button, with no list to keep in step.
    const rooms = resolveRoomPrograms(
      programOverridesOf({
        rooms: [{ kind: "bath", requires: ["toilet"], symbol: "bath", frame: "building" }],
      }),
    );
    const places = placeBuilderNouns(rooms);
    const bath = places.find((p) => p.symbol === "bath")!;
    // The communal culture's bathhouse — same word, different shell.
    expect(bath.glyph).toBe("building(bath)");
  });

  it("groups under the `places` chip, apart from the objects", () => {
    const s = builderSurfaceFor("", { nouns: defaultBuilderNouns(), category: "things" });
    const ids = (s.groups ?? []).map((g) => g.id);
    expect(ids).toContain("places");
  });
});
