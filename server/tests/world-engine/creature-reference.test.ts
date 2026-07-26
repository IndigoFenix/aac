// CREATURE REFERENCE resolution (talk-to vocalization fix): how a speaker names
// a target creature in a spoken line — its NAME (same group), a gendered PRONOUN
// (same species), or its SPECIES word (otherwise). The old code fell back to the
// deictic "there", so "i_me + talk + <target>" rendered "I talk to the there".
// Pure logic — safe in the DB-free `test:engine` slice.

import { describe, it, expect } from "@jest/globals";
import {
  creatureReferenceGlyph,
  goalIntentLine,
  type CreatureRef,
  type IntentLineSyms,
} from "@shared/world-engine/interaction/dialogue/intent-lines.js";
import { translateGlyph } from "@shared/world-engine/interaction/lang/index.js";
import type { Gender } from "@shared/world-engine/interaction/lang/core.js";

const ref = (over: Partial<CreatureRef>): CreatureRef => ({
  species: "human_cute",
  gender: "m",
  speciesWord: "person",
  ...over,
});

describe("creatureReferenceGlyph — name / pronoun / species", () => {
  const spirit = ref({ species: "spark", speciesWord: "spark" });

  it("1. a named member of the speaker's group → the NAME", () => {
    const target = ref({ name: "mara", inGroup: true, species: "human_cute", gender: "f" });
    expect(creatureReferenceGlyph(spirit, target)).toBe("mara");
  });

  it("2. the SAME SPECIES as the speaker → a gendered pronoun (he / she)", () => {
    const frog = ref({ species: "frog", speciesWord: "frog" });
    expect(creatureReferenceGlyph(frog, ref({ species: "frog", speciesWord: "frog", gender: "m" }))).toBe("he");
    expect(creatureReferenceGlyph(frog, ref({ species: "frog", speciesWord: "frog", gender: "f" }))).toBe("she");
  });

  it("3. a DIFFERENT species → the species word", () => {
    const target = ref({ species: "frog", speciesWord: "frog", gender: "f" });
    // The spirit is a spark — never a creature's species, so never a pronoun.
    expect(creatureReferenceGlyph(spirit, target)).toBe("frog");
  });

  it("a name only wins when it's the speaker's OWN group (else species word)", () => {
    const target = ref({ name: "stranger", inGroup: false, species: "bear", speciesWord: "bear" });
    expect(creatureReferenceGlyph(spirit, target)).toBe("bear");
  });

  it("never yields the deictic 'there' — a creature is always speakable", () => {
    for (const t of [
      ref({ name: "mara", inGroup: true, gender: "f" }),
      ref({ species: "cow", speciesWord: "cow" }),
      ref({ species: "spark", speciesWord: "spark" }), // same as the spark speaker → pronoun
    ]) {
      expect(creatureReferenceGlyph(spirit, t)).not.toBe("there");
    }
  });
});

describe("the talk-to line renders each reference properly (no 'the there')", () => {
  // The spirit's talk order → the goalIntentLine converse shape, with the target
  // pre-resolved to its reference glyph (as the quest host now does).
  const syms = (who: string): IntentLineSyms => ({
    item: (r) => ("id" in r ? r.id : (r.match.kind ?? "thing")),
    place: (p) => (p.kind === "named" ? p.id : "there"),
    creature: () => who,
  });

  const talkLine = (who: string) => goalIntentLine({ kind: "converse", target: "t" }, syms(who))!.c;

  it("NAME: 'I talk to Mara.'", () => {
    const names = new Map<string, Gender>([["mara", "f"]]);
    expect(translateGlyph(talkLine("mara"), "en", { firstPerson: true, names })).toBe("I talk to Mara.");
  });

  it("PRONOUN: 'I talk to him/her.' in every ruleset", () => {
    expect(translateGlyph(talkLine("she"), "en", { firstPerson: true })).toBe("I talk to her.");
    expect(translateGlyph(talkLine("he"), "en", { firstPerson: true })).toBe("I talk to him.");
    expect(translateGlyph(talkLine("she"), "he", { firstPerson: true, speaker: "f" })).toBe("אני מדברת איתה.");
    expect(translateGlyph(talkLine("he"), "he", { firstPerson: true })).toBe("אני מדבר איתו.");
    expect(translateGlyph(talkLine("she"), "es", { firstPerson: true })).toBe("Hablo con ella.");
    expect(translateGlyph(talkLine("he"), "pt", { firstPerson: true })).toBe("Eu falo com ele.");
  });

  it("SPECIES: 'I talk to the {species}.' — including newly-worded species", () => {
    expect(translateGlyph(talkLine("frog"), "en", { firstPerson: true })).toBe("I talk to the frog.");
    expect(translateGlyph(talkLine("person"), "en", { firstPerson: true })).toBe("I talk to the person.");
    expect(translateGlyph(talkLine("cow"), "en", { firstPerson: true })).toBe("I talk to the cow.");
    expect(translateGlyph(talkLine("person"), "he", { firstPerson: true })).toBe("אני מדבר עם האדם.");
    expect(translateGlyph(talkLine("frog"), "es", { firstPerson: true })).toBe("Hablo con la rana.");
    expect(translateGlyph(talkLine("cow"), "pt", { firstPerson: true })).toBe("Eu falo com a vaca.");
  });

  it("the pronoun/species reference also carries other verbs (help / follow)", () => {
    expect(translateGlyph("i_me + help + she", "en", { firstPerson: true })).toBe("I help her.");
    expect(translateGlyph("i_me + follow + he", "en", { firstPerson: true })).toBe("I follow him.");
  });
});
