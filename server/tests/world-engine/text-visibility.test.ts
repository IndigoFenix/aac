// TEXT MODE §3 — the visibility filter, all four clauses.
//
// A subject is in view iff it is EMBODIED, in the SAME SPACE (or a revealed one),
// IN RANGE, and on the SAME STOREY. The range constant is directions.ts'
// `DEFAULT_DIRECTIONS_TUNING.visibleR` and nothing else — one constant, two
// consumers ("I can see it" and a townsperson's "it's *there*"), so this suite
// asserts against the imported value rather than a copied 45.
//
// Hand-built minimal states, in the shape world-engine-visibility.test.ts uses.

import { describe, it, expect } from "@jest/globals";
import {
  addLocalAvatar,
  addWorldObject,
  createWorldState,
  expandWorldBuildings,
  type WorldState,
} from "@shared/world-engine/engine.js";
import { DEFAULT_DIRECTIONS_TUNING } from "@shared/world-engine/interaction/dialogue/directions.js";
import {
  buildingsWithOpenDoor,
  createSceneIndex,
  indefiniteArticle,
  inViewSet,
  spaceOf,
  visibleSubjects,
  wordFor,
} from "@shared/world-engine/interaction/text/index.js";
import { languageFor } from "@shared/world-engine/interaction/lang/index.js";
import type { BuildingSpec, WorldSpec } from "@shared/world-engine/types.js";

const { visibleR } = DEFAULT_DIRECTIONS_TUNING;

function spec(buildings: BuildingSpec[] = []): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 400, height: 400 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 100, y: 100, facing: 0 }],
    objects: [],
    buildings,
    npcs: [
      { id: "npc_mara", x: 0, y: 0, name: "Mara", species: "human" },
      { id: "npc_bram", x: 0, y: 0, species: "human" },
    ],
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
  };
}

/** Two SEPARATE houses across a yard, each with one exterior doorway facing it.
 *  Nothing shares a wall, so nothing reveals through to the other. */
const HOUSES: BuildingSpec[] = [
  {
    id: "A",
    footprint: { x: 90, y: 90, w: 12, h: 12 },
    floors: 1,
    wallThickness: 0.4,
    color: "#2563EB",
    doorways: [{ edge: "east", offset: 6, width: 2 }],
  },
  {
    id: "B",
    footprint: { x: 110, y: 90, w: 12, h: 12 },
    floors: 1,
    wallThickness: 0.4,
    color: "#DC2626",
    doorways: [{ edge: "west", offset: 6, width: 2 }],
  },
];

function world(buildings: BuildingSpec[] = []): WorldState {
  return createWorldState(expandWorldBuildings(spec(buildings)), "me");
}

function put(s: WorldState, id: string, x: number, y: number, floor = 0): void {
  const a = s.avatars[id] ?? addLocalAvatar(s, id, x, y, 0);
  a.x = x;
  a.y = y;
  a.floor = floor;
}

/** Set the swing/lock of every door whose midpoint x is near `atX`. */
function setDoors(s: WorldState, atX: number, open: number, locked = false): void {
  for (const st of s.spec.structures ?? []) {
    if (st.kind !== "door") continue;
    if (Math.abs((st.a.x + st.b.x) / 2 - atX) > 0.5) continue;
    s.doors[st.id]!.open = open;
    s.doors[st.id]!.locked = locked;
  }
}

describe("text visibility — clause 2, same space or revealed", () => {
  it("a body in the SAME room is in view", () => {
    const s = world(HOUSES);
    put(s, "me", 94, 96);
    put(s, "npc_mara", 98, 96);
    const scene = visibleSubjects(s, "me");
    expect(scene.me?.space).toBe("A");
    expect(scene.subjects.map((x) => x.id)).toEqual(["npc_mara"]);
  });

  it("a body inside a SEALED building is hidden, though it is well within range", () => {
    const s = world(HOUSES);
    setDoors(s, 102, 0); // A's yard door shut
    setDoors(s, 110, 0); // B's yard door shut
    put(s, "me", 94, 96); // inside A
    put(s, "npc_bram", 116, 96); // inside B, 22 m away — inside visibleR
    expect(Math.hypot(116 - 94, 0)).toBeLessThan(visibleR);
    const scene = visibleSubjects(s, "me");
    expect(scene.subjects).toEqual([]);
    expect(scene.revealed.has("B")).toBe(false);
  });

  it("standing in the yard with both doors open reveals both rooms' occupants", () => {
    const s = world(HOUSES);
    setDoors(s, 102, 1);
    setDoors(s, 110, 1);
    put(s, "me", 106, 96); // outdoors, between the two doors
    put(s, "npc_mara", 98, 96); // inside A
    put(s, "npc_bram", 116, 96); // inside B
    const scene = visibleSubjects(s, "me");
    expect([...scene.revealed].sort()).toEqual(["A", "B"]);
    expect(scene.subjects.map((x) => x.id).sort()).toEqual(["npc_bram", "npc_mara"]);
  });

  it("an OUTDOOR body is not seen from inside a room (spaces differ)", () => {
    const s = world(HOUSES);
    setDoors(s, 102, 0);
    put(s, "me", 94, 96); // inside A
    put(s, "npc_mara", 106, 96); // out in the yard, 12 m away
    expect(visibleSubjects(s, "me").subjects).toEqual([]);
  });

  it("spaceOf reports the containing building, or null outdoors", () => {
    const s = world(HOUSES);
    expect(spaceOf(s, { x: 94, y: 96 })).toBe("A");
    expect(spaceOf(s, { x: 116, y: 96 })).toBe("B");
    expect(spaceOf(s, { x: 106, y: 96 })).toBeNull();
  });
});

describe("text visibility — clause 3, the range cutoff IS directions.ts' visibleR", () => {
  it("admits a body at exactly visibleR and drops the one just past it", () => {
    const s = world();
    put(s, "me", 100, 100);
    put(s, "npc_mara", 100 + visibleR, 100);
    put(s, "npc_bram", 100 + visibleR + 0.5, 100);
    const ids = visibleSubjects(s, "me").subjects.map((x) => x.id);
    expect(ids).toEqual(["npc_mara"]);
  });

  it("bands come from directions.ts' vocabulary — here inside hereR, there beyond it", () => {
    const s = world();
    put(s, "me", 100, 100);
    put(s, "npc_mara", 102, 100); // 2 m — inside hereR (4)
    put(s, "npc_bram", 100, 120); // 20 m — "there"
    const byId = new Map(visibleSubjects(s, "me").subjects.map((x) => [x.id, x]));
    expect(byId.get("npc_mara")).toMatchObject({ band: "here", cardinal: "east" });
    expect(byId.get("npc_bram")).toMatchObject({ band: "there", cardinal: "south" });
  });
});

describe("text visibility — clause 4, same storey", () => {
  it("a body one floor up is hidden even standing right over you", () => {
    const s = world();
    put(s, "me", 100, 100);
    put(s, "npc_mara", 101, 100, 1);
    expect(visibleSubjects(s, "me").subjects).toEqual([]);
  });

  it("a FRACTIONAL floor rounds — mid-stair still reads as the storey it is nearest", () => {
    const s = world();
    put(s, "me", 100, 100);
    put(s, "npc_mara", 101, 100, 0.4); // rounds to 0 — still with you
    put(s, "npc_bram", 102, 100, 0.6); // rounds to 1 — up the stairs, gone
    expect(visibleSubjects(s, "me").subjects.map((x) => x.id)).toEqual(["npc_mara"]);
  });
});

describe("text visibility — clause 1, embodiment (law ①)", () => {
  it("narrates only bodies that exist in state — nothing is materialized to be seen", () => {
    const s = world();
    put(s, "me", 100, 100);
    // spec.npcs lists npc_mara and npc_bram, but only one has a BODY.
    put(s, "npc_mara", 103, 100);
    const scene = visibleSubjects(s, "me");
    expect(scene.subjects.map((x) => x.id)).toEqual(["npc_mara"]);
    expect(inViewSet(scene)).toEqual(new Set(["me", "npc_mara"]));
  });
});

describe("text visibility — objects, holding, and places", () => {
  it("a carried object reports through its holder rather than as loose scenery", () => {
    const s = world();
    put(s, "me", 100, 100);
    put(s, "npc_mara", 102, 100);
    addWorldObject(s, {
      id: "apple1",
      x: 102,
      y: 100,
      shape: "sphere",
      radius: 0.2,
      glyph: "apple",
      interactions: ["carry"],
    });
    s.objects.apple1!.carriedBy = "npc_mara";
    const scene = visibleSubjects(s, "me");
    expect(scene.subjects.map((x) => x.id)).toEqual(["npc_mara"]);
    expect(scene.subjects[0]!.holding).toEqual(["apple1"]);
  });

  it("names an object by its glyph head, in the locale's word", () => {
    const s = world();
    put(s, "me", 100, 100);
    addWorldObject(s, {
      id: "chair1",
      x: 103,
      y: 100,
      shape: "box",
      radius: 0.4,
      fixture: "chair",
      interactions: [],
    });
    const scene = visibleSubjects(s, "me");
    expect(scene.subjects[0]).toMatchObject({ id: "chair1", kind: "object", word: "chair" });
  });

  it("places report as LANDMARKS out to closeR, with whether you can see inside", () => {
    const s = world(HOUSES);
    setDoors(s, 102, 0);
    setDoors(s, 110, 0);
    put(s, "me", 94, 96); // inside A
    const scene = visibleSubjects(s, "me");
    const byId = new Map(scene.places.map((p) => [p.id, p]));
    expect(byId.get("A")).toMatchObject({ kind: "place", word: "house", color: "blue", revealed: true });
    expect(byId.get("B")).toMatchObject({ color: "red", revealed: false });
  });

  it("reports a place's DOOR state — one of the four things that earn it a line", () => {
    const s = world(HOUSES);
    setDoors(s, 102, 0); // A's door shut
    setDoors(s, 110, 1); // B's door swung open
    put(s, "me", 94, 96);
    const byId = new Map(visibleSubjects(s, "me").places.map((p) => [p.id, p]));
    expect(byId.get("A")!.doorOpen).toBe(false);
    expect(byId.get("B")!.doorOpen).toBe(true);
    expect([...buildingsWithOpenDoor(s)]).toEqual(["B"]);
  });

  it("a LOCKED door is not an open one, however far it has swung", () => {
    const s = world(HOUSES);
    setDoors(s, 110, 1, true);
    put(s, "me", 94, 96);
    expect(buildingsWithOpenDoor(s).size).toBe(0);
  });
});

describe("text visibility — YOU are never a bystander", () => {
  it("excludes the spark's own body", () => {
    const s = world();
    put(s, "me", 100, 100);
    put(s, "npc_mara", 102, 100);
    expect(visibleSubjects(s, "me").subjects.map((x) => x.id)).toEqual(["npc_mara"]);
  });

  it("excludes the body the spark DRIVES — a claimed creature is you, not a stranger", () => {
    const s = world();
    put(s, "me", 100, 100);
    put(s, "npc_mara", 102, 100);
    put(s, "npc_bram", 103, 100);
    s.drivenId = "npc_mara"; // the spark claimed Mara's body
    expect(visibleSubjects(s, "me").subjects.map((x) => x.id)).toEqual(["npc_bram"]);
  });

  it("carries the lexicon HEAD beside the word, so a bucket can ask for the plural", () => {
    const s = world();
    put(s, "me", 100, 100);
    put(s, "npc_mara", 102, 100);
    const [mara] = visibleSubjects(s, "me").subjects;
    expect(mara).toMatchObject({ head: "person", word: "person" });
    expect(wordFor(languageFor("en"), "person", 3)).toBe("people");
    expect(wordFor(languageFor("en"), "house", 2)).toBe("houses");
    // No ruleset gets an English "s" bolted on: a missing plural stays singular.
    expect(wordFor(languageFor("es"), "house", 2)).toBe("casa");
    expect(indefiniteArticle(languageFor("en"), "apple")).toBe("an");
    expect(indefiniteArticle(languageFor("he"), "chair")).toBe("");
  });
});

describe("text ids latch (§4)", () => {
  it("keeps a body's ordinal for the session, and gives a known name the bare id", () => {
    const s = world();
    put(s, "me", 100, 100);
    put(s, "npc_bram", 105, 100);
    put(s, "npc_mara", 103, 100); // nearer, but has a NAME

    const index = createSceneIndex();
    const first = index.assign(visibleSubjects(s, "me").subjects);
    const idOf = (id: string): string => first.find((x) => x.id === id)!.textId;
    expect(idOf("npc_mara")).toBe("mara"); // spec name → bare id
    expect(idOf("npc_bram")).toBe("person-1"); // anonymous → species word + ordinal

    // Walk them past each other; the ids do NOT renumber.
    put(s, "npc_bram", 101, 100);
    put(s, "npc_mara", 108, 100);
    const second = index.assign(visibleSubjects(s, "me").subjects);
    expect(second.find((x) => x.id === "npc_bram")!.textId).toBe("person-1");
    expect(index.simIdOf("mara")).toBe("npc_mara");
    expect(index.resolve("person").kind).toBe("one");
  });

  it("asks rather than guesses when a bare stem matches several bodies", () => {
    const s = world();
    put(s, "me", 100, 100);
    addLocalAvatar(s, "extra_a", 103, 100);
    addLocalAvatar(s, "extra_b", 104, 100);
    const index = createSceneIndex();
    index.assign(visibleSubjects(s, "me").subjects);
    const hit = index.resolve("person");
    expect(hit.kind).toBe("many");
    if (hit.kind === "many") expect(hit.ids.sort()).toEqual(["extra_a", "extra_b"]);
    // …and the shorthand form resolves the individual.
    expect(index.resolve("person-1").kind).toBe("one");
  });
});
