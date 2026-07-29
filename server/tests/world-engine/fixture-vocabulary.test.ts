// EVERY FIXTURE MUST BE SAYABLE — the board names furniture by word, and the
// word is looked up as a glyph key. A kind whose word the vocabulary never
// heard of is a button with a label and NO ICON, which is exactly how these
// shipped: the fridge announced itself as "chest" (its id says `chest_food`
// while its kind is `refrigerator`), and `chest`, `cupboard`, `bath`, `toilet`
// and `workbench` had no glyph entry at all.
//
// Also pins the dwell bubble's content — the toilet used to announce itself
// with a COUCH, because a pelvis-contact station poses `sit` and `sit` was
// hard-wired to 🛋️ rather than the project's own sit artwork.
//
// Pure — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import { getVocabularyItem } from "@shared/glyph-registry.js";
import { fixtureKindForWord, fixtureWord, type FixtureKind } from "@shared/world-engine/types.js";
import { useContractFor } from "@shared/world-engine/furniture-use.js";
import { dwellBubble, restDoneBubble } from "@shared/world-engine/interaction/quest/activity-bubble.js";
import { en, es, he, pt, parseSentence } from "@shared/world-engine/interaction/lang/index.js";
import { baseWord } from "@shared/world-engine/interaction/lang/core.js";
import { propertiesOf } from "@shared/world-engine/interaction/content/properties.js";
import { makeableGlyph, spokenMakeable } from "@shared/world-engine/interaction/content/makeable.js";

/** Every fixture the world can stand in a room. */
const ALL_FIXTURES = [
  "chest", "cupboard", "table", "bed", "chair", "box",
  "barrel", "bath", "toilet", "bin", "bowl",
  "oven", "workbench", "refrigerator",
] as const;

// COMPILE-TIME EXHAUSTIVENESS: adding a FixtureKind without listing it here is
// a type error, so this guard can't silently stop covering the new kind.
type Unlisted = Exclude<FixtureKind, (typeof ALL_FIXTURES)[number]>;
const _everyKindListed: Unlisted extends never ? true : never = true;

describe("every fixture kind speaks a word the vocabulary carries", () => {
  it.each(ALL_FIXTURES)("%s resolves to a registered glyph", (kind) => {
    const word = fixtureWord(kind);
    expect(getVocabularyItem(word)).toBeDefined();
  });

  it("folds the kinds the vocabulary draws no distinction between", () => {
    // The sim keeps a goods chest and the toy box apart; the words don't.
    expect(fixtureWord("chest")).toBe("box");
    expect(fixtureWord("cupboard")).toBe("cabinet");
  });

  it("leaves every other kind speaking its own name", () => {
    for (const kind of ALL_FIXTURES) {
      if (kind === "chest" || kind === "cupboard") continue;
      expect(fixtureWord(kind)).toBe(kind);
    }
  });

  it("passes an unknown word through untouched (a wild source, a loose prop)", () => {
    expect(fixtureWord("oak")).toBe("oak");
  });

  it("the fridge is NOT called a chest — the id lies, the kind doesn't", () => {
    expect(fixtureWord("refrigerator")).toBe("refrigerator");
    expect(getVocabularyItem("refrigerator")?.imagePath).toBe("things/furniture/refrigerator");
  });
});

// THE FOLD IS TWO-WAY OR IT IS A TRAP: the board offers the vocabulary's word,
// so every machine that only knows KINDS (station properties, craft recipes,
// the `furn_<n>_cupboard` id tokens the resolver matches) has to be able to
// walk that word back — otherwise the button says "cabinet" and nothing in the
// house answers to it.
describe("the vocabulary word walks back to its fixture kind", () => {
  it("cabinet IS the cupboard", () => {
    expect(fixtureKindForWord("cabinet")).toBe("cupboard");
  });

  it("a word that is ALREADY a kind stays itself — `box` is the toy box", () => {
    // `chest` also speaks "box", but the toy box owns the word: folding it the
    // other way would hand the box the chest's lid.
    expect(fixtureKindForWord("box")).toBe("box");
    for (const k of ALL_FIXTURES) {
      if (fixtureWord(k) === k) expect(fixtureKindForWord(k)).toBe(k);
    }
  });

  it("the cabinet keeps the cupboard's SPEC properties, not an empty set", () => {
    expect(propertiesOf("cabinet")).toEqual(propertiesOf("cupboard"));
    expect(propertiesOf("cabinet")).toEqual(expect.arrayContaining(["furniture", "container", "openable"]));
  });

  it("`make + cabinet` reaches the cupboard recipe", () => {
    expect(makeableGlyph("cabinet")).toBe(makeableGlyph("cupboard"));
    expect(spokenMakeable(makeableGlyph("cabinet")!)).toBe("cabinet");
  });
});

// The two kinds the vocabulary folds away must not survive as WORDS anywhere a
// speaker can reach: not in a lexicon, not as a spoken head. `chest` shipped as
// an iconless board button and `cupboard` as an untranslated one (no lexicon
// carried `cabinet`, so Hebrew read the raw English glyph).
describe("`chest` and `cupboard` are kinds, never words", () => {
  const LANGS = { en, es, he, pt };

  it("no ruleset's lexicon carries either one", () => {
    for (const [tag, lang] of Object.entries(LANGS)) {
      expect({ tag, chest: "chest" in lang.lexicon, cupboard: "cupboard" in lang.lexicon })
        .toEqual({ tag, chest: false, cupboard: false });
    }
  });

  it("every ruleset says the words that REPLACED them", () => {
    for (const [tag, lang] of Object.entries(LANGS)) {
      for (const word of ["box", "cabinet"]) {
        // A missing entry doesn't throw — `baseWord` falls back to the raw
        // English key, which is the untranslated-button bug itself.
        expect({ tag, word, listed: word in lang.lexicon }).toEqual({ tag, word, listed: true });
        expect(baseWord(lang, word).length).toBeGreaterThan(0);
      }
    }
  });

  it("a stored piece is SPOKEN as its vocabulary word (`furn.cupboard` → cabinet)", () => {
    // canonicalToken strips the `furn.` bookkeeping head; the kind it uncovers
    // must arrive as the word, or the lexicon lookup misses and speech spells
    // the raw English glyph inside a Hebrew sentence.
    expect(parseSentence("furn.cupboard")[0]?.head).toBe("cabinet");
    expect(parseSentence("furn.chest")[0]?.head).toBe("box");
    expect(parseSentence("furn.chair")[0]?.head).toBe("chair");
  });
});

describe("`get` is a button, not a bare label", () => {
  it("it has artwork — the acquisition family's canonical head had none", () => {
    // The surfacer offers `get` (CANONICAL_VERBS folds take/fetch onto it), so
    // this is the one the child actually presses.
    expect(getVocabularyItem("get")?.imagePath).toBe("actions/hands/take");
  });

  it("it shares `take`'s art on purpose — one act, two words", () => {
    expect(getVocabularyItem("get")?.imagePath).toBe(getVocabularyItem("take")?.imagePath);
  });
});

// `activityBubbleContent` emits a GLYPH only for a key with bundled art, and
// that key's own emoji otherwise — deliberate for this surface. So the contract
// to pin is: the right key is always chosen (art or not), which both fixes what
// is shown today and auto-upgrades the moment art lands.
describe("the dwell bubble says what is happening", () => {
  /** The key `dwellBubble` picked, whichever form it came back in. */
  const shown = (out: { text: string; glyph?: string }) => out.glyph ?? out.text;

  it("at the toilet it is a TOILET, never a couch", () => {
    // The station names the act even though the pose is `sit`.
    expect(shown(dwellBubble("toilet", "sit"))).toBe("🚽");
    expect(getVocabularyItem("toilet")).toBeDefined(); // registered ⇒ art upgrades it
  });

  it("at the tub it is a WASH", () => {
    expect(shown(dwellBubble("bath", "sit"))).toBe("🫧");
    expect(getVocabularyItem("wash")).toBeDefined();
  });

  it("with no station the POSE speaks — through the project's own sit art", () => {
    // THE COUCH FIX: `sit` has bundled artwork and was never being asked for.
    expect(dwellBubble(undefined, "sit")).toEqual({ text: "", glyph: "sit" });
    expect(getVocabularyItem("sit")?.imagePath).toBe("actions/body/sit");
  });

  it("sleep and play keep their own content", () => {
    expect(dwellBubble("box", "play")).toEqual({ text: "", glyph: "play" });
    expect(shown(dwellBubble(undefined, "sleep"))).toBe("😴");
    expect(shown(dwellBubble("bed", "sleep"))).toBe("😴");
  });

  it("NOTHING it can emit is a couch — the whole point", () => {
    const stations = [undefined, "toilet", "bath", "bed", "box", "chair"];
    const poses = ["sleep", "eat", "sit", "play"] as const;
    for (const s of stations) {
      for (const p of poses) expect(shown(dwellBubble(s, p))).not.toBe("🛋️");
    }
  });

  it("every key it reaches for is a REGISTERED one, art or not", () => {
    for (const pose of ["sleep", "eat", "sit", "play"] as const) {
      for (const station of [undefined, "toilet", "bath"]) {
        const out = dwellBubble(station, pose);
        if (out.glyph) expect(getVocabularyItem(out.glyph)).toBeDefined();
      }
    }
  });

  it("the COMPLETED-motive bubbles reach for registered keys too", () => {
    for (const tpl of ["fun", "hygiene", "waste", "energy"]) {
      const out = restDoneBubble(tpl);
      if (out.glyph) expect(getVocabularyItem(out.glyph)).toBeDefined();
    }
    expect(restDoneBubble("fun")).toEqual({ text: "", glyph: "play" });
  });
});

describe("you get IN the bath", () => {
  it("the tub is an on-fixture use — the bather settles inside it", () => {
    const c = useContractFor("bath");
    expect(c.onFixture).toBe(true);
    expect(c.contactPart).toBe("pelvis");
  });

  it("its use point is the BASIN, below the rim", () => {
    // Deep enough to sit in, above the shell's own base (its feet, at 0.2r).
    const up = useContractFor("bath").usePoint.up;
    expect(up).toBeGreaterThan(0.2);
    expect(up).toBeLessThan(1);
  });

  it("it can be entered from more than one side, unlike a front-only seat", () => {
    expect(useContractFor("bath").useDirections.length).toBeGreaterThan(1);
    expect(useContractFor("toilet").useDirections).toEqual([0]);
  });

  it("the pieces you merely work AT still keep the body outside them", () => {
    for (const k of ["table", "oven", "chest", "workbench", "barrel"] as FixtureKind[]) {
      expect(useContractFor(k).onFixture).toBe(false);
    }
  });
});
