// server/tests/world-engine/builder-person-chips.test.ts
//
// THE WHO TAB'S SUB-CHIPS — contacts · people · animals, in that order.
//
// THE BUG THIS PINS. The engine's `person` category used to be FLAT: eight
// deixis words (I, you, we, they, this, that, here, there) and no chips at all.
// Every host that wanted the child's own contacts on that tab therefore pinned
// a chip of its OWN and, to fill it, asked the engine for the "things" tab and
// sifted persons/creatures out of the whole noun library. Both hosts did it,
// independently, and both got the same result: three pages of rabbits, bears
// and frogs in front of the child's mother, because the animal species
// outnumber the people by an order of magnitude.
//
// So the chips are the ENGINE's now. The tab still opens on the deixis words
// ("All"), and the chips open the three LIVING clusters over the full noun
// library — the same clustering the things tab sub-groups by
// (`content/noun-clusters.ts`, one rule, several readers).
//
// ⚖️ THE ONE ASYMMETRY, and it is deliberate: `individuals` is advertised even
// when it is EMPTY. Every other chip must open a real subset (the ≥2 rule),
// but out of game the engine's noun library holds no specific people at all —
// a child's contacts are platform data and `defaultBuilderNouns()` is derived
// from the game spec. The chip's content is the HOST's people directory, so
// hiding the chip because the engine's half is empty would hide the whole
// list. It ships empty on the wire and the host fills it.

import { describe, it, expect } from "@jest/globals";
import {
  builderSurfaceFor,
  type BuilderNounEntry,
} from "@shared/world-engine/interaction/intent/builder-surface";
import { en, he, es, pt } from "@shared/world-engine/interaction/lang/index.js";

const ids = (groups: Array<{ id: string }> | undefined) => (groups ?? []).map((g) => g.id);
const keys = (buttons: Array<{ key: string }>) => buttons.map((b) => b.key);

/** A roster the way a host pushes one: named people, no spec row, flagged
 *  `individual` so they cluster as contacts rather than as "somebody". */
const ROSTER: BuilderNounEntry[] = [
  { symbol: "liat", label: "Liat", kind: "creature", individual: true, present: true },
  { symbol: "ofek", label: "Ofek", kind: "creature", individual: true },
];

describe("the person tab advertises three chips, contacts first", () => {
  it("orders them contacts · people · animals", () => {
    const s = builderSurfaceFor("", { category: "person" });
    expect(ids(s.groups)).toEqual(["individuals", "creatures", "animals"]);
  });

  it("keeps the deixis words as the tab's own 'All' listing", () => {
    const s = builderSurfaceFor("", { category: "person" });
    // The lexical category, unchanged — a chip is a filter, not a replacement.
    expect(keys(s.buttons)).toEqual(["i_me", "you", "we", "they", "this", "that", "here", "there"]);
  });

  it("still offers the chips while one of them is open", () => {
    // A child who opened [animals] has to be able to get back to [contacts]
    // without going through the tab.
    const s = builderSurfaceFor("", { category: "person", group: "animals" });
    expect(ids(s.groups)).toEqual(["individuals", "creatures", "animals"]);
  });

  it("leaves the SMALL lexical tabs flat", () => {
    // `verb` and `attribute` gained chips of their own (2026-09-04 — see
    // builder-attribute-verb-chips.test.ts); these five each fit one grid page,
    // so a chip there would cost a press and buy nothing.
    for (const cat of ["quantity", "relation", "question", "connective", "social"]) {
      expect(builderSurfaceFor("", { category: cat }).groups).toBeUndefined();
    }
  });
});

describe("what each chip opens", () => {
  it("[people] is the role and kinship words — somebody in general", () => {
    const s = builderSurfaceFor("", { category: "person", group: "creatures" });
    expect(keys(s.buttons)).toEqual(["mom", "dad", "teacher", "friend", "baby", "girl", "boy"]);
  });

  it("[animals] is the species — not people, but an answer to 'who'", () => {
    const s = builderSurfaceFor("", { category: "person", group: "animals" });
    expect(keys(s.buttons)).toEqual(expect.arrayContaining(["dog", "cat", "horse"]));
    // The whole reason the chip exists: the animals dwarf the people, so they
    // must not share a list with them.
    expect(s.buttons.length).toBeGreaterThan(20);
    expect(keys(s.buttons)).not.toContain("mom");
  });

  it("[contacts] is the host's named individuals, present ones flagged", () => {
    const s = builderSurfaceFor("", { nouns: ROSTER, category: "person", group: "individuals" });
    expect(keys(s.buttons)).toEqual(["liat", "ofek"]);
    expect(s.buttons[0]!.present).toBe(true);
    // A name has no lexeme, so the host's label survives (see `wordJson`).
    expect(s.buttons.map((b) => b.label)).toEqual(["Liat", "Ofek"]);
  });

  it("answers [contacts] EMPTY out of game rather than falling back to the deixis words", () => {
    // The trap: `clusters.get("individuals")` is undefined with the default
    // library, and an `undefined` group is the "stale id" case, which shows the
    // whole tab. That would put "I / you / we" under a chip promising the
    // child's family. The empty answer is the correct one — the host fills it.
    const s = builderSurfaceFor("", { category: "person", group: "individuals" });
    expect(s.buttons).toEqual([]);
  });

  it("ignores a chip id belonging to another tab", () => {
    const s = builderSurfaceFor("", { category: "person", group: "food" });
    expect(keys(s.buttons)).toEqual(["i_me", "you", "we", "they", "this", "that", "here", "there"]);
  });
});

describe("which chips are advertised", () => {
  it("advertises [contacts] with no members at all", () => {
    expect(ids(builderSurfaceFor("", { category: "person" }).groups)).toContain("individuals");
  });

  it("advertises [contacts] with a SINGLE member — the ≥2 rule does not apply to it", () => {
    const one: BuilderNounEntry[] = [{ symbol: "liat", kind: "creature", individual: true }];
    const s = builderSurfaceFor("", { nouns: one, defaults: false, category: "person" });
    expect(ids(s.groups)).toEqual(["individuals"]);
  });

  it("drops [people] and [animals] when they cannot open a real subset", () => {
    // One creature and one animal, nothing else: neither clears ≥2, and a chip
    // that opens one word is a wasted press.
    const thin: BuilderNounEntry[] = [
      { symbol: "mom", kind: "creature" },
      { symbol: "dog", kind: "creature" },
    ];
    const s = builderSurfaceFor("", { nouns: thin, defaults: false, category: "person" });
    expect(ids(s.groups)).toEqual(["individuals"]);
  });
});

describe("the chips' faces and labels", () => {
  it("[contacts] wears its own members when the engine has any", () => {
    const s = builderSurfaceFor("", { nouns: ROSTER, category: "person" });
    const contacts = s.groups!.find((g) => g.id === "individuals")!;
    expect(contacts.glyphs).toEqual(["liat", "ofek"]);
    expect(contacts.glyph).toBe("liat");
    // Empty out of game — the HOST overrides the face with `face:<id>` glyphs
    // for the first few real contacts (client-shared `contactChipGlyphs`).
    expect(builderSurfaceFor("", { category: "person" }).groups![0]!.glyphs).toBeUndefined();
  });

  it("[people] and [animals] wear three of their members", () => {
    const s = builderSurfaceFor("", { category: "person" });
    const byId = new Map(s.groups!.map((g) => [g.id, g]));
    expect(byId.get("creatures")!.glyphs).toHaveLength(3);
    expect(byId.get("animals")!.glyphs).toHaveLength(3);
  });

  it("labels the three chips in every SHIPPED ruleset — never the raw head", () => {
    // `baseWord` returns the HEAD when a lexeme is missing, and a head is an
    // English word, so this fails silently in exactly the three languages a
    // reviewer reading English cannot see. Pinned per locale.
    //
    // ⚖️ THE KIND CHIPS WEAR THE PLURAL (user, 2026-09-04). "person" and
    // "animal" on a chip that opens forty species read as the single word about
    // to be pressed — which is what a button means everywhere else on the board.
    // `contacts` is already plural in every ruleset and is left as it was.
    const labels = (locale: string) =>
      new Map(
        (builderSurfaceFor("", { category: "person", locale }).groups ?? []).map((g) => [g.id, g.label]),
      );
    expect(labels("en")).toEqual(
      new Map([["individuals", "contacts"], ["creatures", "people"], ["animals", "animals"]]),
    );
    expect(labels("he")).toEqual(
      new Map([["individuals", "אנשי קשר"], ["creatures", "אנשים"], ["animals", "חיות"]]),
    );
    expect(labels("es")).toEqual(
      new Map([["individuals", "contactos"], ["creatures", "personas"], ["animals", "animales"]]),
    );
    expect(labels("pt")).toEqual(
      new Map([["individuals", "contatos"], ["creatures", "pessoas"], ["animals", "animais"]]),
    );
  });

  it("reads the plural off the ruleset, never off an -s of the surfacer's own", () => {
    // The ladder is `plw` (the irregular list) → the ruleset's own regular rule
    // (`pluralize`, which English alone has) → the singular. A ruleset with
    // neither must keep the SINGULAR: an -s synthesised here would be English
    // grammar on a Hebrew board, which is the whole failure this layer exists to
    // avoid. The singular heads themselves are untouched — a chip asks for the
    // plural, it does not redefine the word.
    for (const [id, head] of [["creatures", "person"], ["animals", "animal"]] as const) {
      for (const lang of [en, he, es, pt]) {
        const chip = builderSurfaceFor("", { category: "person", locale: lang.id }).groups!
          .find((g) => g.id === id)!;
        const expected = lang.lexicon[head]!.plw ?? lang.pluralize!(lang.lexicon[head]!.w);
        expect({ id, lang: lang.id, label: chip.label }).toEqual({ id, lang: lang.id, label: expected });
      }
    }
    // `animal` is REGULAR in English, so it carries no `plw` — the ruleset's own
    // rule supplies "animals" (the `plw` field is documented as the irregular
    // list). he/es/pt have no such rule and therefore do carry one.
    expect(en.lexicon.animal!.plw).toBeUndefined();
    expect([he, es, pt].map((l) => l.lexicon.animal!.plw)).toEqual(["חיות", "animales", "animais"]);
  });
});
