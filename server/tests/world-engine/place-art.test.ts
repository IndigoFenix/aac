// PLACE ART — the gate between the engine's specs and the glyph layer's table.
//
// A room or a building is ONE SYMBOL drawn from two PNGs: the shell plate and
// the fixture planted on it that says which place it is. The WORD is what
// travels (a sentence token has to stay speakable and parseable), so the
// composition is resolved at DRAW time from `shared/glyph-place-art.ts`.
//
// That table is a second copy of what the specs already say — which is exactly
// the kind of list that drifts. This file is the gate: it derives what every
// room program, structure program and catalogue row SHOULD draw from the specs
// themselves and fails when the table disagrees, or when a new place ships with
// neither art nor a listed exemption. A red test here means: add the row (or
// declare, out loud, that the AAC's everyday word wins).
//
// No DOM / GL — pure data.

import { describe, it, expect, afterEach } from "@jest/globals";
import {
  DEFAULT_ROOM_PROGRAMS,
  DEFAULT_STRUCTURE_PROGRAMS,
  roomDisplayGlyph,
  structureProgramDisplayGlyph,
} from "@shared/world-engine/kernel/town/programs.js";
import { structureDisplayGlyph } from "@shared/world-engine/kernel/town/structures.js";
import { TOWN_PLAY_STRUCTURES } from "@shared/world-engine/interaction/town/town-play.js";
import {
  clearRegisteredPlaceArt,
  defaultPlaceArtWords,
  placeArt,
  placeArtGlyph,
  registerPlaceArt,
} from "@shared/glyph-place-art.js";
import { canResolveGlyph, drawnSlot, parseGlyph } from "@shared/glyph-compositor.js";
import { getVocabularyItem } from "@shared/glyph-registry.js";

/**
 * Words whose art is deliberately NOT the engine's composition, because the
 * AAC's everyday sense of the word is the one a student presses. Each needs its
 * own registry art (asserted below) — an exemption is a curated symbol, never a
 * word left to render as ❓.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  // Already a shell symbol in its own right (`places/building`).
  building: "the generic shell is its own art",
};

/**
 * Words the AAC carries that no engine spec names, so the gate has nothing to
 * derive them from. Each is the AAC's own word for a place the engine words
 * differently — the SENSE SPLITS that let one word draw one picture.
 */
const AAC_ONLY: Readonly<Record<string, string>> = {
  // The AAC says "store" where the engine's structure program says "shop".
  store: "the shop, said the AAC's way",
  // The engine's bath ROOM speaks `bathroom` (its program's `word`); this is the
  // AAC's row for the same floor.
  bathroom: "the bath room, said the AAC's way",
  // The derived kind no program declares (`roomKindOf`'s fallback).
  hall: "a room with nothing in it worth naming",
};

/** What the specs say each place word draws, buildings-first for a word that
 *  names both a room and a building (`workshop`, `masonry`) — the same rule
 *  `placeBuilderNouns` applies when it keeps one entry per word. */
function expectedArt(): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of DEFAULT_ROOM_PROGRAMS) out.set(d.word ?? d.kind, roomDisplayGlyph(d));
  for (const d of DEFAULT_STRUCTURE_PROGRAMS) out.set(d.word ?? d.type, structureProgramDisplayGlyph(d));
  for (const s of TOWN_PLAY_STRUCTURES) out.set(s.glyph, structureDisplayGlyph(s));
  return out;
}

/** What the specs say for one word (undefined when no spec names it). */
function fromSpecWord(word: string): string | undefined {
  return expectedArt().get(word);
}

afterEach(() => {
  clearRegisteredPlaceArt();
});

describe("place art matches the specs it copies", () => {
  it("every room program, structure program and catalogue row is covered", () => {
    const missing: string[] = [];
    for (const word of expectedArt().keys()) {
      if (!placeArtGlyph(word) && !(word in EXEMPT)) missing.push(word);
    }
    // Add the word to DEFAULT_PLACE_ART (glyph-place-art.ts), or to EXEMPT here
    // with the reason the AAC's own symbol wins.
    expect(missing).toEqual([]);
  });

  it("no row drifts from the spec that authors it", () => {
    for (const [word, art] of expectedArt()) {
      const have = placeArtGlyph(word);
      // A word drawn as itself (`building`) carries no art; that is the
      // exemption path, checked above.
      if (!have) continue;
      expect({ word, art: have }).toEqual({ word, art });
    }
  });

  it("a word that names both a room and a building draws the BUILDING", () => {
    expect(placeArtGlyph("workshop")).toBe("building(workbench)");
    expect(placeArtGlyph("masonry")).toBe("building(stonecutter)");
  });

  it("every table row is a place word one of the two vocabularies names", () => {
    // The other direction: nothing may be invented here. A row is either derived
    // from a spec or an AAC word listed above with its reason.
    const fromSpec = expectedArt();
    const stray = defaultPlaceArtWords().filter((w) => !fromSpec.has(w) && !(w in AAC_ONLY));
    expect(stray).toEqual([]);
  });

  it("the split senses each draw their own picture", () => {
    // The user's rule: a SHOP shows trade, STORAGE shows a box. One word could
    // never do both, so the storage sense took its own word.
    expect(placeArtGlyph("store")).toBe("building(trade)");
    expect(placeArtGlyph("shop")).toBe("building(trade)");
    expect(placeArtGlyph("storeroom")).toBe("room(box)");
    expect(fromSpecWord("store")).toBe(undefined);      // no longer a spec word
    expect(fromSpecWord("storeroom")).toBe("room(box)"); // …this is
    // The bathroom reads by its toilet; `bath` stays the tub, and is not a place.
    expect(placeArtGlyph("bathroom")).toBe("room(toilet)");
    expect(placeArtGlyph("bath")).toBeUndefined();
    expect(fromSpecWord("bathroom")).toBe("room(toilet)");
    // A dwelling is drawn by who lives in it, under either of its two words.
    expect(placeArtGlyph("home")).toBe("building(family)");
    expect(placeArtGlyph("house")).toBe("building(family)");
    // A library is a building of BOOKS; the shelf still derives the study.
    expect(placeArtGlyph("library")).toBe("building(book)");
    expect(placeArtGlyph("study")).toBe("room(shelf)");
  });

  it("a place word the AAC also carries is exposed to the AI by KEY", () => {
    // Otherwise the AI is steered to the item's emoji (prompts/shared.ts) — and
    // for these the emoji is the FIXTURE, so a board button for the kitchen came
    // back as a frying pan. Exposing the key is what makes an AI-minted button
    // draw the same composed room the student's own board draws.
    for (const word of defaultPlaceArtWords()) {
      const item = getVocabularyItem(word);
      if (!item) continue; // engine-only word — the AI can't name it anyway
      expect({ word, exposed: item.exposeToAi === true })
        .toEqual({ word, exposed: true });
    }
  });

  it("every exemption has its own registry art, so nothing renders as ❓", () => {
    for (const word of Object.keys(EXEMPT)) {
      const item = getVocabularyItem(word);
      expect({ word, drawable: !!(item?.imagePath || item?.emoji) })
        .toEqual({ word, drawable: true });
      expect(canResolveGlyph(word)).toBe(true);
    }
  });
});

describe("every place word actually renders", () => {
  it("resolves as a bare word — the form that travels in speech and sentences", () => {
    // `structureDoneLine(spec.glyph)` speaks "smithy"; a board button carries
    // "bedroom". These are the tokens that used to draw ❓.
    for (const word of [...defaultPlaceArtWords(), ...Object.keys(EXEMPT)]) {
      expect({ word, ok: canResolveGlyph(word) }).toEqual({ word, ok: true });
    }
  });

  it("draws a shell with a fixture in it (or a bare shell)", () => {
    for (const word of defaultPlaceArtWords()) {
      const slot = drawnSlot(parseGlyph(word).slots[0]!);
      const frame = getVocabularyItem(slot.key);
      // The frame is a real symbol; when the art nests a fixture, the frame has
      // to be a container that can hold it (the `-bg` plate swap).
      expect({ word, frame: !!frame }).toEqual({ word, frame: true });
      if (slot.payload) {
        expect({ word, composable: !!frame?.composable?.filledImagePath })
          .toEqual({ word, composable: true });
        expect({ word, fixture: !!getVocabularyItem(slot.payload) })
          .toEqual({ word, fixture: true });
      }
    }
  });
});

describe("the session overlay (swapped catalogue / authored culture)", () => {
  it("a culture that bathes together flips the shell, not the program", () => {
    // One unchanged program, a different shell. `bath` has no default art (the
    // AAC's `bath` is the tub), so this is also the shape of a culture-authored
    // kind reaching the glyph layer for the first time.
    expect(placeArt("bath")).toBeUndefined();
    registerPlaceArt("bath", "building(bath)");
    expect(placeArt("bath")).toEqual({ key: "building", payload: "bath" });
  });

  it("a registration overrides a default row for that session", () => {
    // The communal cookhouse — same oven, different shell.
    expect(placeArt("kitchen")).toEqual({ key: "room", payload: "oven" });
    registerPlaceArt("kitchen", "building(oven)");
    expect(placeArt("kitchen")).toEqual({ key: "building", payload: "oven" });
    clearRegisteredPlaceArt();
    expect(placeArt("kitchen")).toEqual({ key: "room", payload: "oven" });
  });

  it("a catalogue row registers its own art from its own spec", () => {
    const farm = TOWN_PLAY_STRUCTURES.find((s) => s.glyph === "farm")!;
    registerPlaceArt(farm.glyph, structureDisplayGlyph({ ...farm, symbol: "tree" }));
    expect(placeArtGlyph("farm")).toBe("building(tree)");
    clearRegisteredPlaceArt();
    expect(placeArtGlyph("farm")).toBe("building(grain)");
  });
});
