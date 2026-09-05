// client-shared/src/builder/contacts.test.ts
//
// The [contacts] grid's join, pinned once for BOTH hosts. Before this module
// the AAC and the clinician each carried their own copy of it and had already
// drifted: only one ordered by camera presence, and neither de-duplicated.

import { describe, it, expect } from "@jest/globals";
import {
  CONTACT_CHIP_FACES,
  contactChipGlyphs,
  mergeContactTiles,
  orderDirectoryPeople,
} from "./contacts";

const p = (id: string, name: string, hasPhoto = true) => ({ id, name, hasPhoto });
const w = (key: string, label?: string, present?: boolean) => ({ key, label, present });

const label = (tile: ReturnType<typeof mergeContactTiles>[number]) =>
  tile.type === "person" ? tile.person.id : `e:${tile.word.key}`;

describe("orderDirectoryPeople", () => {
  it("puts the people seen on camera first, then the alphabet", () => {
    const people = [p("c", "Cara"), p("a", "Ana"), p("b", "Bo")];
    expect(orderDirectoryPeople(people, ["b"]).map((x) => x.id)).toEqual(["b", "a", "c"]);
  });

  it("is alphabetical when nobody is present (the clinician has no camera)", () => {
    expect(orderDirectoryPeople([p("c", "Cara"), p("a", "Ana")]).map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("does not mutate the caller's list", () => {
    const people = [p("c", "Cara"), p("a", "Ana")];
    orderDirectoryPeople(people);
    expect(people.map((x) => x.id)).toEqual(["c", "a"]);
  });
});

describe("mergeContactTiles", () => {
  it("orders present-engine · present-people · rest-engine · rest-people", () => {
    const tiles = mergeContactTiles({
      people: [p("c", "Cara"), p("a", "Ana")],
      engine: [w("mara", "Mara"), w("bess", "Bess", true)],
      presentPersonIds: ["c"],
    });
    expect(tiles.map(label)).toEqual(["e:bess", "c", "e:mara", "a"]);
  });

  it("is the directory alone out of game (the engine cluster is empty there)", () => {
    const tiles = mergeContactTiles({ people: [p("a", "Ana"), p("b", "Bo")], engine: [] });
    expect(tiles.map(label)).toEqual(["a", "b"]);
  });

  it("drops an engine member the directory already answers for — by face key", () => {
    // A game pushing a real contact in as a character pushes it as its face
    // slot; drawn twice, the two cells are literally the same photo.
    const tiles = mergeContactTiles({
      people: [p("a", "Ana")],
      engine: [w("face:a", "Ana"), w("mara", "Mara")],
    });
    expect(tiles.map(label)).toEqual(["e:mara", "a"]);
  });

  it("drops an engine member the directory already answers for — by name", () => {
    const tiles = mergeContactTiles({
      people: [p("a", "Ana")],
      engine: [w("char1", "  ana  ")],
    });
    expect(tiles.map(label)).toEqual(["a"]);
  });

  it("keeps an unlabelled engine member (there is nothing to match it against)", () => {
    const tiles = mergeContactTiles({ people: [p("a", "Ana")], engine: [w("mara")] });
    expect(tiles.map(label)).toEqual(["e:mara", "a"]);
  });

  it("is deterministic — same input, same order (eyegaze + the call mirror)", () => {
    const input = {
      people: [p("c", "Cara"), p("a", "Ana"), p("b", "Bo")],
      engine: [w("mara", "Mara", true), w("bess", "Bess")],
      presentPersonIds: ["b"],
    };
    expect(mergeContactTiles(input).map(label)).toEqual(mergeContactTiles(input).map(label));
  });
});

describe("contactChipGlyphs — the chip's own face", () => {
  it("takes up to three contacts, present first, as face slots", () => {
    const people = [p("a", "Ana"), p("b", "Bo"), p("c", "Cara"), p("d", "Dov")];
    expect(contactChipGlyphs(people, ["d"])).toEqual(["face:d", "face:a", "face:b"]);
    expect(contactChipGlyphs(people)).toHaveLength(CONTACT_CHIP_FACES);
  });

  it("uses only people who HAVE a photo — three silhouettes say nothing", () => {
    const people = [p("a", "Ana", false), p("b", "Bo", true)];
    expect(contactChipGlyphs(people)).toEqual(["face:b"]);
  });

  it("is empty with no photographed contacts, so the host keeps the engine's art", () => {
    expect(contactChipGlyphs([])).toEqual([]);
    expect(contactChipGlyphs([p("a", "Ana", false)])).toEqual([]);
  });
});
