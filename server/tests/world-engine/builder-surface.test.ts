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
import { isAnimal, isPlant, propertiesOf } from "@shared/world-engine/interaction/content/properties.js";
import { ITEM_STUBS, PLACE_STUBS } from "@shared/world-engine/interaction/content/words.js";
import { CORE_BOARD_NOUNS, CORE_CONCEPTS } from "@shared/world-engine/object-properties.js";
import { headOf } from "@shared/world-engine/variations.js";
import {
  DEFAULT_ROOM_PROGRAMS,
  DEFAULT_STRUCTURE_PROGRAMS,
  programOverridesOf,
  resolveRoomPrograms,
} from "@shared/world-engine/kernel/town/programs.js";
import { parseSentence, tokenizeSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import { getSpecies } from "@shared/world-engine/creatures/species.js";
import {
  emptyRecency,
  noteUtterance,
  TYPE_CHIPS,
  type RecencyMemory,
} from "@shared/world-engine/interaction/intent/surface-next.js";
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
    const s = builderSurfaceFor("", { nouns: NOUNS, defaults: false });
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
    const s = builderSurfaceFor("i_me + want", { nouns: NOUNS, defaults: false });
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
    const crowd = builderSurfaceFor("i_me + want", { nouns: NOUNS, defaults: false, addressees: ["mara", "papa"] });
    const alone = builderSurfaceFor("i_me + want", { nouns: NOUNS, defaults: false });
    expect(keys(crowd).slice(0, 2).sort()).toEqual(["mara", "papa"]);
    // Without a roster the desire's own actions lead (2026-08-24) and the
    // objects follow — the names displace BOTH.
    expect(keys(alone).slice(0, 2)).toEqual(["get", "give"]);
    expect(keys(alone)).toContain("apple");
  });

  it("⑫ a DYAD changes nothing — nobody to disambiguate from (law ④)", () => {
    expect(builderSurfaceFor("i_me + want", { nouns: NOUNS, defaults: false, addressees: ["mara"] }))
      .toEqual(builderSurfaceFor("i_me + want", { nouns: NOUNS, defaults: false }));
  });

  it("⑫ no roster ⇒ the board is byte-identical to today", () => {
    expect(builderSurfaceFor("i_me + want", { nouns: NOUNS, defaults: false, addressees: [] }))
      .toEqual(builderSurfaceFor("i_me + want", { nouns: NOUNS, defaults: false }));
  });

  it("noun buttons carry kind + the scene-presence flag from the passed nouns", () => {
    const s = builderSurfaceFor("hi", { nouns: NOUNS, defaults: false }); // greeting → addressees
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
    const s = builderSurfaceFor("i_me + want + apple", { nouns: NOUNS, defaults: false });
    expect(s.modifiers).toBeDefined();
    const mods = s.modifiers!.map((m) => m.key);
    expect(mods).toContain("hot"); // food's first axis is temperature
    expect(mods.indexOf("hot")).toBeLessThan(mods.indexOf("my") < 0 ? Infinity : mods.indexOf("my"));
    expect(s.modifiers!.length).toBeLessThanOrEqual(8);
    // A speaker head takes the creature axes ("i_me + hungry" is one press).
    const me = builderSurfaceFor("i_me", { nouns: NOUNS, defaults: false });
    expect(me.modifiers!.map((m) => m.key)).toContain("hungry");
    // A verb head offers no descriptor rail.
    expect(builderSurfaceFor("i_me + want", { nouns: NOUNS, defaults: false }).modifiers).toBeUndefined();
    // An already-applied modifier never re-surfaces.
    const hot = builderSurfaceFor("apple.hot", { nouns: NOUNS, defaults: false });
    expect(hot.modifiers!.map((m) => m.key)).not.toContain("hot");
  });

  it("a category filter lists that tab's full vocabulary (SpeakMenu tabs)", () => {
    const verbs = builderSurfaceFor("", { nouns: NOUNS, defaults: false, category: "verb" });
    const vk = keys(verbs);
    expect(vk).toContain("want");
    expect(vk).toContain("go");
    expect(vk).toContain("eat");
    expect(vk).not.toContain("apple");
    expect(vk).not.toContain("i_me");
    const things = builderSurfaceFor("", { nouns: NOUNS, defaults: false, category: "things" });
    expect(keys(things)).toEqual(["apple", "ball", "mara", "papa", "bed", "home"]);
    // An unknown category falls back to the suggested grid.
    const junk = builderSurfaceFor("", { nouns: NOUNS, defaults: false, category: "nope" });
    expect(keys(junk)).toContain("i_me");
  });

  it("complete flips on a full sentence", () => {
    expect(builderSurfaceFor("", { nouns: NOUNS, defaults: false }).complete).toBe(false);
    expect(builderSurfaceFor("i_me + want", { nouns: NOUNS, defaults: false }).complete).toBe(false);
    expect(builderSurfaceFor("i_me + want + apple", { nouns: NOUNS, defaults: false }).complete).toBe(true);
    expect(builderSurfaceFor("you + go + home", { nouns: NOUNS, defaults: false }).complete).toBe(true);
    // The completeness verdict holds even under a category filter.
    expect(builderSurfaceFor("i_me + want + apple", { nouns: NOUNS, defaults: false, category: "verb" }).complete).toBe(true);
  });

  it("locale localizes the word labels through the lang layer", () => {
    const he = builderSurfaceFor("", { nouns: NOUNS, defaults: false, locale: "he-IL" });
    const en = builderSurfaceFor("", { nouns: NOUNS, defaults: false, locale: "en" });
    const heWant = he.buttons.find((b) => b.key === "want");
    const enWant = en.buttons.find((b) => b.key === "want");
    expect(heWant).toBeDefined();
    expect(enWant).toBeDefined();
    expect(heWant!.label).not.toBe(enWant!.label);
    // A game-supplied noun label survives any locale.
    const things = builderSurfaceFor("", { nouns: NOUNS, defaults: false, locale: "he-IL", category: "things" });
    expect(things.buttons.find((b) => b.key === "mara")!.label).toBe("Mara");
  });

  it("deterministic and plain JSON (survives structuredClone + JSON round-trip)", () => {
    const a = builderSurfaceFor("i_me + want", { nouns: NOUNS, defaults: false });
    const b = builderSurfaceFor("i_me + want", { nouns: NOUNS, defaults: false });
    expect(b).toEqual(a);
    expect(structuredClone(a)).toEqual(a);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });
});

describe("builderSurfaceFor — group chips (the SpeakMenu's sub-category hierarchy)", () => {
  it("the default view is RANK-ordered (frequency prior), never category-ordered", () => {
    const s = builderSurfaceFor("", { nouns: NOUNS, defaults: false });
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
    const s = builderSurfaceFor("", { nouns: NOUNS, defaults: false, capacity: 4 });
    const ids = (s.groups ?? []).map((g) => g.id);
    expect(ids).toContain("creatures");
    // PLACES SPLIT (2026-08-25): rooms · buildings · outside, so one chip does
    // not open a second paging problem. This library holds one place of each
    // kind, and a chip needs two members, so no place chip stands here — the
    // rule doing its job, not the split failing.
    expect(ids).not.toContain("places");
    for (const g of s.groups!) {
      expect(g.label.length).toBeGreaterThan(0);
      expect(typeof g.glyph).toBe("string");
    }
  });

  it("a group filter on the ranked view opens that cluster's full ranked expansion", () => {
    const s = builderSurfaceFor("", { nouns: NOUNS, defaults: false, capacity: 4, group: "creatures" });
    expect(keys(s)).toEqual(["mara", "papa"]);
    // The surfacer's resolved noun labels survive the group expansion.
    expect(s.buttons[0]!.label).toBe("Mara");
    // The chips stay offered alongside the expansion (the back-out ladder).
    expect((s.groups ?? []).map((g) => g.id)).toContain("creatures");
    // Unknown/stale group ids fall back to the ranked grid — never an empty board.
    expect(keys(builderSurfaceFor("", { nouns: NOUNS, defaults: false, group: "nope" }))).toContain("want");
  });

  it("the verb's pre-loaded property cluster leads the chips (eat → food)", () => {
    const s = builderSurfaceFor("you + eat", { nouns: defaultBuilderNouns(), capacity: 3 });
    expect(s.groups?.[0]?.id).toBe("food");
  });

  it('the "things" tab sub-groups the FULL noun library; a group filters it', () => {
    const s = builderSurfaceFor("", { nouns: NOUNS, defaults: false, category: "things" });
    const ids = (s.groups ?? []).map((g) => g.id);
    // ≥2-member clusters only (a chip must open a real subset).
    expect(ids).toEqual(["creatures"]); // one place per kind — no chip clears the ≥2 rule
    const creatures = builderSurfaceFor("", { nouns: NOUNS, defaults: false, category: "things", group: "creatures" });
    expect(keys(creatures)).toEqual(["mara", "papa"]);
    const places = builderSurfaceFor("", { nouns: NOUNS, defaults: false, category: "things", group: "building" });
    expect(keys(places)).toEqual(["home"]);
    // A stale group id shows the full listing, never an empty board.
    const stale = builderSurfaceFor("", { nouns: NOUNS, defaults: false, category: "things", group: "gone" });
    expect(keys(stale)).toEqual(NOUNS.map((n) => n.symbol));
  });

  it("the SMALL lexical category tabs stay flat (no sub-groups), like the SpeakMenu", () => {
    // `verb` and `attribute` grew chips of their own (2026-09-04); the tabs that
    // fit one grid page did not — see builder-attribute-verb-chips.test.ts.
    expect(builderSurfaceFor("", { nouns: NOUNS, defaults: false, category: "quantity" }).groups).toBeUndefined();
    expect(builderSurfaceFor("", { nouns: NOUNS, defaults: false, category: "quantity", group: "food" }).buttons.length).toBeGreaterThan(0);
    // A chipped tab still ignores a foreign id and shows its whole category.
    expect(builderSurfaceFor("", { nouns: NOUNS, defaults: false, category: "verb", group: "food" }).buttons.length).toBeGreaterThan(0);
  });

  it("a group chip wears up to three members — the BEST examples, not the alphabet", () => {
    const nouns = defaultBuilderNouns();
    const byId = new Map(
      (builderSurfaceFor("", { nouns, category: "things" }).groups ?? []).map((g) => [g.id, g]),
    );
    const food = byId.get("food")!;
    // Three faces, best first, and `glyph` stays the single-face shorthand.
    // The order is the SPEC's (2026-08-24): the treat pool authors cookie first,
    // and that row is now the one place a food's priority is stated — there is no
    // board-side list left to disagree with it.
    expect(food.glyphs).toEqual(["cookie", "apple", "banana"]);
    expect(food.glyph).toBe(food.glyphs![0]);
    // Purity decides the face before priority does, so a category shows the
    // member that is least ALSO something else — never whatever the alphabet or
    // the noun list put first, and never a box standing in for the furniture.
    expect(byId.get("toy")!.glyphs![0]).toBe("ball");
    expect(byId.get("furniture")!.glyphs).toEqual(["chair", "table", "bed"]);
    // A refrigerator is a container too, and a box is also furniture — the
    // basket is a container and nothing else, so it is the purest example.
    expect(byId.get("container")!.glyphs![0]).toBe("basket");
    // Clothing wears the CATEGORY WORD and then the everyday garments, in the
    // vocabulary's order. The umbrella leads because `clothing` is an
    // OBJECT_PROPERTY and therefore a `CATEGORY_NOUNS` head — vocab-order.ts
    // has always ranked those top ("they are what the group chips are labelled
    // with, and they are sayable in their own right"). It only reached the noun
    // library on 2026-09-06 (ONE WORD BANK: it used to be a word the quest host
    // pushed inside a dollhouse and nowhere else), which is why a chip that was
    // always going to lead with it did not.
    expect(byId.get("clothing")!.glyphs).toEqual(["clothing", "hat", "shirt"]);
  });

  it("the chip's faces are the members' DISPLAY glyphs, so places draw their icon", () => {
    const places = (builderSurfaceFor("", { nouns: defaultBuilderNouns(), category: "things" }).groups ?? [])
      .find((g) => g.id === "building")!;
    // home leads (a place is home outward), and every face is the composed
    // shell+symbol icon — the bare word would render nothing.
    expect(places.glyphs![0]).toBe("building(family)");
    for (const g of places.glyphs!) expect(canResolveGlyph(g)).toBe(true);
  });

  it("group faces never reorder the group's own expansion", () => {
    // `members` answers "what could I say next" and stays in surfacing rank;
    // only the CHIP's face is picked by the prototype prior.
    const s = builderSurfaceFor("", { nouns: NOUNS, defaults: false, category: "things", group: "creatures" });
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
    // DERIVED FROM THE SPEC (2026-08-24), not curated: the count follows the
    // registries, so it is pinned as a range wide enough to be a sanity check
    // and narrow enough to catch a walk that collapsed or ran away.
    expect(items.length).toBeGreaterThanOrEqual(40);
    expect(items.length).toBeLessThanOrEqual(120);
    // Items, places AND people — the library derives creatures too now (the
    // kinship words and the animal friends), which is why "hi + ___" has
    // somebody to greet at last.
    const creatures = nouns.filter((n) => n.kind === "creature");
    expect(creatures.length).toBeGreaterThanOrEqual(5);
    expect(items.length + places.length + creatures.length).toBe(nouns.length);
    for (const n of nouns) {
      expect(n.present).toBeUndefined();
      expect(n.affords!.length).toBeGreaterThan(0);
      expect(n.properties).toEqual(propertiesOf(n.symbol)); // spec-side, never authored
    }
    for (const n of items) {
      // NO INVENTED KEYS (user law: properties from the spec side): every
      // head is one the engine's registries genuinely know — it carries
      // spec-derived properties, or it is a core engine concept (water), or
      // it is a PLANT, whose spec entry is its species row rather than a
      // property (2026-08-27: a rose is not a container, a toy or a food, and
      // giving it a property to satisfy this law would be the invention the
      // law exists to forbid).
      //
      // …or an ITEM STUB (words.ts `ITEM_STUBS`, 2026-09-06): a build material
      // whose defining registry is products.ts, which mints the glyph once per
      // SOURCE (wood grows on the oak AND the apple tree) and tags no object
      // property at all — which is exactly why its words live in the ITEM_WORDS
      // catalog rather than on a row. Registry-known, property-less; giving
      // `wood` a `material` property would mean adding it to `KIND_CATEGORY`,
      // and that map is read by the NEED and QUEST matchers, so it is a spec
      // change with sim consequences rather than a board fix (left open).
      expect({
        head: n.symbol,
        known:
          n.properties!.length > 0 ||
          CORE_CONCEPTS.has(headOf(n.symbol)) ||
          isPlant(n.symbol) ||
          ITEM_STUBS.includes(n.symbol),
      }).toEqual({ head: n.symbol, known: true });
    }
    // A PLACE's key is legitimate for the same reason, one repository over:
    // it IS a room kind or a building character the programs declare.
    const declared = new Set<string>([
      ...DEFAULT_ROOM_PROGRAMS.map((d) => d.word ?? d.kind),
      ...DEFAULT_STRUCTURE_PROGRAMS.map((d) => d.word ?? d.type),
    ]);
    // …or a CORE FRAME PLACE: the yard, the town, a building — core concepts
    // no registry defines by law (`CORE_BOARD_NOUNS`, 2026-09-06). Each used to
    // reach a board only through the quest host's scope-gated push, which is
    // exactly what the ONE WORD BANK rule ended.
    const coreFramePlaces = new Set(
      CORE_BOARD_NOUNS.filter((n) => n.kind === "place").map((n) => n.head),
    );
    for (const n of places) {
      // …or a PLACE STUB: a word for a place no program row carries
      // (words.ts PLACE_STUBS), which is still a place a child goes to.
      expect({
        place: n.symbol,
        known:
          declared.has(n.symbol) ||
          PLACE_STUBS.includes(n.symbol) ||
          coreFramePlaces.has(n.symbol),
      }).toEqual({ place: n.symbol, known: true });
    }
    // The staples the dollhouse teaches.
    const syms = nouns.map((n) => n.symbol);
    for (const s of ["apple", "ball", "shirt"]) expect(syms).toContain(s);
    // `bear.toy` (a composed two-word glyph) was deliberately pulled from the
    // starter set — it isn't a SENTENCE STARTER; a new user reads it as one
    // word rather than a head-plus-modifier the board taught them to build.
    expect(syms).not.toContain("bear.toy");
    expect(new Set(syms).size).toBe(syms.length); // no duplicates
  });

  it('every default noun surfaces under the "things" category filter', () => {
    const nouns = defaultBuilderNouns();
    const s = builderSurfaceFor("", { nouns, category: "things" });
    expect(s.buttons.map((b) => b.key)).toEqual(nouns.map((n) => n.symbol));
    for (const b of s.buttons) {
      expect(b.category).toBe("things");
      expect(["item", "place", "creature"]).toContain(b.kind);
      expect(b.label.length).toBeGreaterThan(0);
    }
  });

  // THE LIVING SPLIT (2026-08-27) — people · animals · plants.
  //
  // `creatures` used to mean "every body": the kinship words and the animal
  // friends in one chip, with the plants nowhere at all. Both halves are read
  // off the SPEC registries the world already keeps (`isAnimal` / `isPlant`,
  // i.e. a species row's `kind`), never off a word list here — which is the
  // whole point: authoring a species row is what puts a word behind a chip.
  describe("animals and plants are their own sub-categories", () => {
    const clusterOf = (id: string) =>
      builderSurfaceFor("", { category: "things", group: id }).buttons.map((b) => b.key);

    it("splits the bodies: [creatures] is people, [animals] is animals", () => {
      const ids = (builderSurfaceFor("", { category: "things" }).groups ?? []).map((g) => g.id);
      expect(ids).toContain("creatures");
      expect(ids).toContain("animals");

      const people = clusterOf("creatures");
      const animals = clusterOf("animals");
      expect(people).toContain("mom");
      expect(animals).toContain("dog");
      expect(animals).toContain("lion");
      // Disjoint, and each side agrees with the predicate the world uses.
      expect(people.filter((k) => animals.includes(k))).toEqual([]);
      expect(people.every((k) => !isAnimal(k))).toBe(true);
      expect(animals.every((k) => isAnimal(k))).toBe(true);
    });

    it("offers a [plants] cluster of exactly the plant species", () => {
      const ids = (builderSurfaceFor("", { category: "things" }).groups ?? []).map((g) => g.id);
      expect(ids).toContain("plants");
      const plants = clusterOf("plants");
      for (const k of ["tree", "flower", "grass", "mushroom"]) expect(plants).toContain(k);
      expect(plants.every((k) => isPlant(k))).toBe(true);
      // A plant is not a person and not a place — it is a thing you SEE and
      // WANT, and (per the species-kind affordance) cut. Never one you are
      // handed: nobody gives you an oak.
      const nouns = defaultBuilderNouns();
      for (const k of plants) {
        const n = nouns.find((x) => x.symbol === k)!;
        expect(n.kind).toBe("item");
        expect(n.affords).not.toContain("give");
      }
    });

    it("labels the chips as CATEGORIES, in the board's own language", () => {
      const groups = (glyphLocale: string) =>
        new Map(
          (builderSurfaceFor("", { category: "things", locale: glyphLocale }).groups ?? []).map(
            (g) => [g.id, g.label] as const,
          ),
        );
      // The KIND chips wear the PLURAL wherever they appear (user, 2026-09-04 —
      // `PLURAL_LABEL_CHIPS`): the label names the set, not the one word the
      // child is about to press.
      expect(groups("en").get("animals")).toBe("animals");
      expect(groups("en").get("plants")).toBe("plants");
      // The [plants] chip must NOT wear the head `plant`: that head is the
      // VERB, so a Hebrew board would have labelled a shelf of nouns "שותל"
      // ("he is planting"). Hence the separate `plants` category head — and its
      // plural, which es/pt gained with the chip (the head is absent from the
      // pre-move snapshot, so nothing pinned it).
      expect(groups("he").get("animals")).toBe("חיות");
      expect(groups("he").get("plants")).toBe("צמחים");
      expect(groups("es").get("plants")).toBe("plantas");
      expect(groups("pt").get("plants")).toBe("plantas");
    });

    it("the new words are spec stubs — a word each, and no body to build", () => {
      const syms = defaultBuilderNouns().map((n) => n.symbol);
      for (const k of ["lion", "penguin", "butterfly", "rose", "cactus"]) expect(syms).toContain(k);
      // A stub is a real species row with no blueprint: nothing may build one.
      expect(getSpecies("lion")!.stub).toBe(true);
      expect(getSpecies("lion")!.blueprint).toEqual({});
      // …and a species that HAS a body plan is untouched by the batch.
      expect(getSpecies("cow")!.stub).toBeUndefined();
    });
  });

  it("drives a working surface: eat → food first, and a full round-trip stays JSON", () => {
    const nouns = defaultBuilderNouns();
    const s = builderSurfaceFor("you + eat", { nouns });
    expect(s.buttons[0]!.key).toBe("cookie"); // food property leads for "eat", in the spec's order
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
      // The icon renders — composed for a program's place (`room(bed)`), and the
      // word's OWN art for a PLACE_STUB, which has no program to compose from
      // (2026-08-24). Either way a place button is never blank.
      expect({ place: p.symbol, draws: canResolveGlyph(p.glyph ?? p.symbol) }).toEqual({
        place: p.symbol,
        draws: true,
      });
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
      // PLACES ONLY (`defaults: false`): the merged library is checked wholesale
      // by `validate-builder-lexicon`, and a true cognate there ("altar" in
      // Spanish) is not the bug this test is looking for.
      const s = builderSurfaceFor("", { nouns, category: "things", locale, defaults: false });
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

  it("groups under the place chips, apart from the objects", () => {
    const s = builderSurfaceFor("", { nouns: defaultBuilderNouns(), category: "things" });
    const ids = (s.groups ?? []).map((g) => g.id);
    // Three of them now (2026-08-25): a room, a building, and somewhere outside
    // both — the `go` board is 22 places and one chip could not navigate it.
    for (const id of ["room", "building", "outside"]) expect(ids).toContain(id);
  });
});

// THE PLATFORM PATH GETS WHAT THE IN-GAME BOARD ALWAYS HAD (§5 seams 3/9).
//
// Three things the wire adapter used to drop on the floor: the student's own
// LEARNED LAYER (`recency`), the caller's GRID BUDGET (`capacity`), and the
// SENTENCE-TYPE chips (`typeChips` out, `seedKind` back in). Each is optional,
// each is pass-through, and none of them may change a board that doesn't use
// them — the AAC is the one surface most students see, so a regression here is
// a regression for everybody.
describe("builderSurfaceFor — the learned layer, the budget and the type chips", () => {
  /** What the memory looks like after the student really said something —
   *  built the way the live path builds it, never hand-authored. */
  const afterSaying = (sentences: string[]): RecencyMemory => {
    let mem = emptyRecency();
    for (const s of sentences) mem = noteUtterance(mem, parseSentence(s));
    return mem;
  };

  it("recency PERSONALIZES: a word the student uses outranks an unused peer", () => {
    // apple and ball are the same kind of thing at the same role tier, so the
    // frequency prior alone decides between them...
    const cold = builderSurfaceFor("i_me + want", { nouns: NOUNS, defaults: false });
    const ck = keys(cold);
    expect(ck.indexOf("apple")).toBeLessThan(ck.indexOf("ball"));
    // ...until this child turns out to be a child who asks for the ball.
    const mem = afterSaying(["i_me + want + ball", "i_me + want + ball"]);
    const warm = builderSurfaceFor("i_me + want", { nouns: NOUNS, defaults: false, recency: mem });
    const wk = keys(warm);
    expect(wk.indexOf("ball")).toBeLessThan(wk.indexOf("apple"));
    // The board is still the same board — personalization RANKS, never filters.
    expect(new Set(wk)).toEqual(new Set(ck));
  });

  it("recency is the SURFACER's own contract — the adapter only carries it", () => {
    // Same memory, same tokens ⇒ the wire answer and a direct surfacer call
    // agree about the order. (Determinism holds with the memory in play.)
    const mem = afterSaying(["i_me + want + ball"]);
    const a = builderSurfaceFor("i_me + want", { nouns: NOUNS, defaults: false, recency: mem });
    const b = builderSurfaceFor("i_me + want", { nouns: NOUNS, defaults: false, recency: mem });
    expect(b).toEqual(a);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a); // still plain JSON
  });

  it("an EMPTY memory costs nothing — the board is byte-identical to no memory", () => {
    // The client always has a memory object (it persists one per student), so
    // a brand-new student must get exactly today's board, not a subtly
    // different one.
    for (const glyph of ["", "i_me + want", "you + go"]) {
      expect(builderSurfaceFor(glyph, { nouns: NOUNS, defaults: false, recency: emptyRecency() }))
        .toEqual(builderSurfaceFor(glyph, { nouns: NOUNS, defaults: false }));
    }
  });

  it("capacity is HONORED — the caller's grid budget, not the surfacer's default", () => {
    // The seam this closes: the bridge sent no capacity, so an in-game board
    // silently got 16 words and could never page while the same sentence
    // out-of-game got 54.
    const small = builderSurfaceFor("", { nouns: defaultBuilderNouns(), capacity: 3 });
    expect(small.buttons.length).toBeLessThanOrEqual(3);
    const dflt = builderSurfaceFor("", { nouns: defaultBuilderNouns() });
    expect(dflt.buttons.length).toBeLessThanOrEqual(16);
    const board = builderSurfaceFor("", { nouns: defaultBuilderNouns(), capacity: 54 });
    expect(board.buttons.length).toBeGreaterThan(dflt.buttons.length);
    expect(board.buttons.length).toBeLessThanOrEqual(54);
    // A bigger budget only ADDS: the ranked head of the board is unchanged, so
    // paging never reshuffles the first page under the student.
    expect(keys(board).slice(0, dflt.buttons.length)).toEqual(keys(dflt));
  });

  it("typeChips ride the wire — on the EMPTY board only, exactly as the surfacer says", () => {
    const empty = builderSurfaceFor("", { nouns: NOUNS, defaults: false });
    expect(empty.typeChips).toBeDefined();
    expect(empty.typeChips!.map((c) => c.kind)).toEqual(TYPE_CHIPS.map((c) => c.kind));
    for (const c of empty.typeChips!) {
      expect(typeof c.kind).toBe("string");
      expect(c.label.length).toBeGreaterThan(0);
    }
    // Composition underway ⇒ the controls are gone, and the KEY is gone with
    // them (a client that never learned about them sees no new field at all).
    for (const glyph of ["i_me", "i_me + want", "i_me + want + apple"]) {
      const s = builderSurfaceFor(glyph, { nouns: NOUNS, defaults: false });
      expect(s.typeChips).toBeUndefined();
      expect(Object.keys(s)).not.toContain("typeChips");
    }
  });

  it("seedKind echoes back and FILTERS the openers to one move", () => {
    const ask = builderSurfaceFor("", { nouns: NOUNS, defaults: false, seedKind: "ask" });
    const ak = keys(ask);
    expect(ak).toContain("who");
    expect(ak).toContain("where");
    // The other moves' openers stand down — that IS the narrowing.
    expect(ak).not.toContain("hi");
    expect(ak).not.toContain("want");
    const greet = builderSurfaceFor("", { nouns: NOUNS, defaults: false, seedKind: "greet" });
    const gk = keys(greet);
    expect(gk).toContain("hi");
    expect(gk).not.toContain("want");
    // A seed changes WHICH words open, never whether the sentence is sayable.
    expect(ask.complete).toBe(false);
  });

  it("seedKind is inert once a word has landed (the empty board owns it)", () => {
    for (const glyph of ["i_me", "i_me + want"]) {
      expect(builderSurfaceFor(glyph, { nouns: NOUNS, defaults: false, seedKind: "ask" }))
        .toEqual(builderSurfaceFor(glyph, { nouns: NOUNS, defaults: false }));
    }
  });

  it("BACKWARD COMPAT: without the new opts every old field is byte-identical", () => {
    // An older client sends none of the three; an older game answers with no
    // typeChips. Both must keep working. Everything the wire carried before is
    // unchanged — the only difference anywhere is the additive `typeChips` key
    // on the empty board.
    for (const glyph of ["", "i_me + want", "i_me + want + apple", "hi"]) {
      for (const opts of [
        { nouns: NOUNS, defaults: false },
        { nouns: NOUNS, defaults: false, category: "things" },
        { nouns: NOUNS, defaults: false, capacity: 4, group: "creatures" },
        { nouns: NOUNS, defaults: false, locale: "he-IL" },
      ]) {
        const s = builderSurfaceFor(glyph, opts) as Record<string, unknown>;
        const { typeChips: _chips, ...legacy } = s;
        const withNew = builderSurfaceFor(glyph, {
          ...opts,
          recency: emptyRecency(),
        }) as Record<string, unknown>;
        const { typeChips: _chips2, ...legacyWithNew } = withNew;
        expect(legacyWithNew).toEqual(legacy);
        // And the legacy half is exactly the fields the contract always had.
        for (const k of Object.keys(legacy)) {
          expect(["buttons", "modifiers", "categories", "groups", "complete"]).toContain(k);
        }
      }
    }
  });
});
