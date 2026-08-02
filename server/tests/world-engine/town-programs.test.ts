// ROOM & STRUCTURE PROGRAMS (construction pipeline ④), at the pure layer —
// ONE table read both directions: forward a program NAMES a goal (bedroom =
// a room holding a bed), backward a room's kind DERIVES from the furniture
// standing in it and a building's character from its rooms. Culture defs
// (game.culture.architecture.rooms/buildings) replace same-name defaults in
// place and append new names; unknown station kinds resolve to no-ops.
// Persistent wants: an unmet programmed room outranks the default annex
// differentiation.
//
// PHASE 4 REVERSED THE LAW ABOVE THIS ONE: program rows used to be
// APPEND-ONLY, and the header used to read "so a demolished bedroom
// re-rises". Rows are REMOVABLE now (construction.ts `removeProgram`) and the
// commit of every removal act drops the row the removed thing stood for — a
// house must never re-order what the player deliberately tore out. What
// `nextAnnexWant` does with the rows it is GIVEN is unchanged, and that is
// all this file pins; the drop itself lives in town-construction-phase4.
// No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  buildingKindOf,
  DEFAULT_ROOM_PROGRAMS,
  programOverridesOf,
  resolveRoomPrograms,
  resolveStructurePrograms,
  roomDisplayGlyph,
  roomKindDisplayGlyph,
  roomKindOf,
  roomProgramMet,
  roomProgramOf,
} from "@shared/world-engine/kernel/town/programs.js";
import { structureDisplayGlyph, type StructureSpec } from "@shared/world-engine/kernel/town/structures.js";
import { CLUSTERS, STATION_PROPERTIES } from "@shared/world-engine/kernel/town/stations.js";
import { TOWN_PLAY_STRUCTURES } from "@shared/world-engine/interaction/town/town-play.js";
import { getVocabularyItem } from "@shared/glyph-registry.js";
import { resolveEmoji } from "@shared/emoji-registry.js";
import { canResolveGlyph, parseGlyph } from "@shared/glyph-compositor.js";
import { createTownDeltas, deltaIsEmpty, nextAnnexWant } from "@shared/world-engine/kernel/town/construction.js";
import type { HouseRoomPlan } from "@shared/world-engine/kernel/town/rooms.js";

const planOf = (kinds: string[], bedrooms = 0): HouseRoomPlan =>
  ({
    rooms: kinds.map((kind, i) => ({ id: `r${i}`, kind })),
    bedrooms: Array.from({ length: bedrooms }, (_, i) => `b${i}`),
  }) as unknown as HouseRoomPlan;

describe("roomKindOf — furniture defines function (backward)", () => {
  it("derives each kind from its signature piece", () => {
    expect(roomKindOf(["bed"])).toBe("bedroom");
    expect(roomKindOf(["oven"])).toBe("kitchen");
    expect(roomKindOf(["bath"])).toBe("bath");
    expect(roomKindOf(["toilet"])).toBe("bath");
    expect(roomKindOf(["workbench"])).toBe("workshop");
    expect(roomKindOf(["table", "chair"])).toBe("living");
    expect(roomKindOf(["barrel"])).toBe("store");
  });

  it("an empty (or unmarked) room is a plain hall", () => {
    expect(roomKindOf([])).toBe("hall");
    expect(roomKindOf(["bowl"])).toBe("hall");
  });

  it("precedence order is semantics — the specific outranks the generic", () => {
    // A bed AND a workbench: the workshop def stands earlier in the table.
    expect(roomKindOf(["bed", "workbench"])).toBe("workshop");
    // A bed beside a table: bedroom (earlier) beats living.
    expect(roomKindOf(["bed", "table", "chair"])).toBe("bedroom");
  });
});

describe("roomProgramMet — programs name goals (forward)", () => {
  it("met when ALL required pieces stand in the one room", () => {
    const living = roomProgramOf("living")!;
    expect(roomProgramMet(living, ["table", "chair", "cupboard"])).toBe(true);
    expect(roomProgramMet(living, ["table"])).toBe(false);
    const bedroom = roomProgramOf("bedroom")!;
    expect(roomProgramMet(bedroom, ["bed"])).toBe(true);
    expect(roomProgramMet(bedroom, [])).toBe(false);
  });

  it("both directions read the SAME table — a satisfied program derives its own kind", () => {
    for (const def of DEFAULT_ROOM_PROGRAMS) {
      // Fill a room with exactly the program's requirement: it must derive
      // as that kind or one MORE specific (earlier in precedence).
      const derived = roomKindOf(def.requires);
      const derivedIdx = DEFAULT_ROOM_PROGRAMS.findIndex((d) => d.kind === derived);
      const defIdx = DEFAULT_ROOM_PROGRAMS.findIndex((d) => d.kind === def.kind);
      expect(derivedIdx).toBeGreaterThanOrEqual(0);
      expect(derivedIdx).toBeLessThanOrEqual(defIdx);
      expect(roomProgramMet(def, def.requires)).toBe(true);
    }
  });
});

describe("buildingKindOf — rooms define the building", () => {
  it("a shell with living+bedroom+kitchen+bath IS a house", () => {
    expect(buildingKindOf(["living", "bedroom", "kitchen", "bath"])).toBe("house");
    expect(buildingKindOf(["living", "bedroom", "kitchen", "bath", "store"])).toBe("house");
  });

  it("an empty box is just a building (null)", () => {
    expect(buildingKindOf([])).toBeNull();
    expect(buildingKindOf(["living", "bedroom"])).toBeNull(); // not yet a house
  });

  it("single-room characters derive too", () => {
    expect(buildingKindOf(["workshop"])).toBe("workshop");
    expect(buildingKindOf(["store"])).toBe("shop");
  });
});

describe("culture overrides — defaults ⊕ authored, kernel-validated", () => {
  it("an authored def REPLACES its default in place (precedence kept)", () => {
    const over = programOverridesOf({
      rooms: [{ kind: "bedroom", requires: ["bed", "chest"] }],
    });
    const defs = resolveRoomPrograms(over);
    const i = defs.findIndex((d) => d.kind === "bedroom");
    expect(i).toBe(DEFAULT_ROOM_PROGRAMS.findIndex((d) => d.kind === "bedroom"));
    expect(defs[i]!.requires).toEqual(["bed", "chest"]);
    // This culture's bedroom now wants a chest too.
    expect(roomProgramMet(defs[i]!, ["bed"])).toBe(false);
    expect(roomProgramMet(defs[i]!, ["bed", "chest"])).toBe(true);
  });

  it("a NEW kind appends after the defaults and derives last", () => {
    // `parlour` deliberately isn't a default kind — `shrine` used to serve as
    // the example here and became one when the place-making rooms shipped.
    const defs = resolveRoomPrograms(
      programOverridesOf({ rooms: [{ kind: "parlour", requires: ["table"], signature: ["table"] }] }),
    );
    expect(defs[defs.length - 1]!.kind).toBe("parlour");
    // living's signature (earlier) still claims a table room first.
    expect(roomKindOf(["table"], defs)).toBe("living");
  });

  it("unknown station kinds are NO-OPS; a def left empty is dropped whole", () => {
    // `throne` is the stand-in for a kind the registry has never heard of;
    // `altar` played this part until it became a real station.
    const over = programOverridesOf({
      rooms: [
        { kind: "bedroom", requires: ["bed", "throne"] }, // throne dropped, bed kept
        { kind: "void", requires: ["throne"] }, // dropped whole
      ],
    });
    expect(over.rooms).toHaveLength(1);
    expect(over.rooms![0]!.requires).toEqual(["bed"]);
    expect(over.rooms![0]!.signature).toEqual(["bed"]); // defaults to requires
  });

  it("structure programs override the same way", () => {
    const defs = resolveStructurePrograms(
      programOverridesOf({ buildings: [{ type: "house", rooms: ["bedroom"] }] }),
    );
    expect(buildingKindOf(["bedroom"], defs)).toBe("house"); // a one-room culture
  });

  it("icon marks ride through the resolve unvalidated", () => {
    const over = programOverridesOf({
      rooms: [{ kind: "bath", requires: ["toilet"], symbol: "bath", frame: "building" }],
    });
    expect(over.rooms![0]!.symbol).toBe("bath");
    expect(over.rooms![0]!.frame).toBe("building");
  });
});

// The ICON MARKS: a room kind's picture is the shell it draws on plus the
// symbol planted over it. The SAME program is a private room or a communal
// building depending only on `frame` — one function, two social arrangements,
// which is how a bath is a bathroom in a house and a bathhouse in a town that
// bathes together.
describe("roomDisplayGlyph — the icon marks", () => {
  it("nests each default kind's symbol in the room shell", () => {
    expect(roomKindDisplayGlyph("bedroom")).toBe("room(bed)");
    expect(roomKindDisplayGlyph("kitchen")).toBe("room(oven)");
    expect(roomKindDisplayGlyph("bath")).toBe("room(bath)");
    expect(roomKindDisplayGlyph("workshop")).toBe("room(workbench)");
    expect(roomKindDisplayGlyph("living")).toBe("room(table)");
    expect(roomKindDisplayGlyph("store")).toBe("room(box)");
  });

  it("every default kind's symbol is a symbol the lexicon can DRAW", () => {
    // The guard that keeps a plate from framing a ❓ — the failure the marks
    // exist to prevent. A kind whose word happens to be drawable may go
    // unmarked; one whose word isn't MUST name its symbol.
    for (const def of DEFAULT_ROOM_PROGRAMS) {
      const symbol = def.symbol ?? def.kind;
      const item = getVocabularyItem(symbol);
      expect(!!item?.imagePath || !!item?.emoji || !!resolveEmoji(symbol)).toBe(true);
    }
  });

  it("the frame carries the private/communal split over one unchanged program", () => {
    const communal = resolveRoomPrograms(
      programOverridesOf({
        rooms: [{ kind: "bath", requires: ["toilet"], signature: ["bath", "toilet"], symbol: "bath", frame: "building" }],
      }),
    );
    const def = roomProgramOf("bath", communal)!;
    expect(roomDisplayGlyph(def)).toBe("building(bath)"); // the bathhouse
    // The RULE is untouched — same furniture still derives the same kind.
    expect(roomKindOf(["bath"], communal)).toBe("bath");
    expect(roomProgramMet(def, ["toilet"])).toBe(true);
  });

  it("frame `none` drops the shell (the well pattern)", () => {
    const defs = resolveRoomPrograms(
      programOverridesOf({ rooms: [{ kind: "yard", requires: ["barrel"], symbol: "outside", frame: "none" }] }),
    );
    expect(roomDisplayGlyph(roomProgramOf("yard", defs)!)).toBe("outside");
  });

  it("an unmarked kind falls back to its own word, and an unknown kind to itself", () => {
    expect(roomDisplayGlyph({ kind: "kitchen", requires: ["oven"], signature: ["oven"] })).toBe("room(kitchen)");
    expect(roomKindDisplayGlyph("hall")).toBe("hall"); // no program declares it
  });
});

// THE PLACE-MAKING SET: four stations, four room kinds, four buildings. The
// whole chain has to close in BOTH directions or the new places are decoration
// — a fixture that derives no kind, or a kind no building can reach.
describe("the place-making stations make places", () => {
  const PAIRS = [
    { station: "anvil", room: "forge", building: "smithy" },
    { station: "altar", room: "shrine", building: "temple" },
    { station: "loom", room: "weaving", building: "weaver" },
    { station: "shelf", room: "study", building: "library" },
  ] as const;

  it.each(PAIRS)("a standing $station derives a $room, which derives a $building", (p) => {
    // BACKWARD, both levels: furniture defines the room, rooms define the
    // building. Nothing declares "this is a smithy" — it is one because of
    // what stands in it.
    expect(roomKindOf([p.station])).toBe(p.room);
    expect(buildingKindOf([p.room])).toBe(p.building);
  });

  it.each(PAIRS)("$station claims its floor even in a FURNISHED hall", (p) => {
    // THE REAL CASE, and the reason these rows outrank `living`: every work
    // building's hall already holds a counter (a table) and usually a barrel
    // — WORK_STATIONS puts them there. Filed below `living`, the table would
    // claim the room and the building would never derive as itself.
    expect(roomKindOf(["table", "chair", "barrel", p.station])).toBe(p.room);
    expect(buildingKindOf([roomKindOf(["table", "chair", "barrel", p.station])])).toBe(p.building);
  });

  it.each(PAIRS)("$room's program is MET by its own station (forward)", (p) => {
    expect(roomProgramMet(roomProgramOf(p.room)!, [p.station])).toBe(true);
    expect(roomProgramMet(roomProgramOf(p.room)!, [])).toBe(false);
  });

  it.each(PAIRS)("$building's catalog row raises the $station that defines it", (p) => {
    const spec = TOWN_PLAY_STRUCTURES.find((s) => s.type === p.building)!;
    expect(spec.stations).toContain(p.station);
    // And the row's icon frames that same station — picture and mechanic agree.
    expect(structureDisplayGlyph(spec)).toBe(`building(${p.station})`);
  });

  it("the new kinds never steal a household room", () => {
    // Precedence is semantics: adding four kinds must not change what the
    // existing furniture derives. This is the regression that would silently
    // re-label every house.
    expect(roomKindOf(["bed"])).toBe("bedroom");
    expect(roomKindOf(["oven"])).toBe("kitchen");
    expect(roomKindOf(["table", "chair"])).toBe("living");
    expect(roomKindOf(["chest"])).toBe("store");
    expect(roomKindOf(["workbench"])).toBe("workshop");
    expect(buildingKindOf(["living", "bedroom", "kitchen", "bath"])).toBe("house");
  });

  it("a shelf is a CONTAINER that never opens, an altar holds nothing", () => {
    // The properties are what earn each station its use contract, so they are
    // the load-bearing claim, not decoration.
    expect(STATION_PROPERTIES.shelf).toEqual(["furniture", "container"]);
    expect(STATION_PROPERTIES.altar).toEqual(["furniture"]);
    expect(STATION_PROPERTIES.anvil).toContain("appliance");
    expect(STATION_PROPERTIES.loom).toContain("appliance");
  });

  it("every place-making cluster declares a floor a body can work in", () => {
    for (const key of ["forge", "shrine", "weaving", "study"]) {
      const c = CLUSTERS[key]!;
      expect(c.privacy).toBe(1);
      expect(c.minW ?? 0).toBeGreaterThan(2);
      expect(c.minD ?? 0).toBeGreaterThan(2);
    }
  });
});

// The BUILDING half of the same marks (structures.ts): a structure's NAME and
// its PICTURE are separate jobs, so the catalog names both.
describe("structureDisplayGlyph — name vs picture", () => {
  const spec = (over: Partial<StructureSpec>): StructureSpec =>
    ({
      type: "x", glyph: "x", label: "x", role: "work",
      footprint: { w: 4, d: 4 }, program: {}, jobs: 0, costs: {},
      buildDays: 1, color: "#000", default: true,
      ...over,
    }) as StructureSpec;

  it("frames the declared symbol, not the spoken word", () => {
    expect(structureDisplayGlyph(spec({ glyph: "farm", frame: "building", symbol: "grain" })))
      .toBe("building(grain)");
  });

  it("falls back to the word when the word is the picture", () => {
    expect(structureDisplayGlyph(spec({ glyph: "workshop", frame: "building" })))
      .toBe("building(workshop)");
    expect(structureDisplayGlyph(spec({ glyph: "building" }))).toBe("building");
  });

  it("every default catalog row frames a DRAWABLE symbol", () => {
    // `building(farm)` used to render a plate around a ❓ — this is the guard.
    for (const s of TOWN_PLAY_STRUCTURES) {
      const symbol = s.symbol ?? s.glyph;
      const item = getVocabularyItem(symbol);
      expect(!!item?.imagePath || !!item?.emoji || !!resolveEmoji(symbol)).toBe(true);
    }
  });
});

// THE AAC END OF THE CHAIN: a display glyph is a STRING that has to survive the
// compositor's own parser and resolver. The drawable-symbol guards above check
// the payload word in isolation; this checks the composed string the way a
// button actually receives it — shell key, payload key and parse together.
describe("every display glyph the repositories emit is renderable", () => {
  it("parses to a single slot carrying its payload", () => {
    const parsed = parseGlyph(roomKindDisplayGlyph("bedroom"));
    expect(parsed.slots).toHaveLength(1);
    expect(parsed.slots[0]!.key).toBe("room");
    expect(parsed.slots[0]!.payload).toBe("bed");
  });

  it("resolves for every room program", () => {
    for (const def of DEFAULT_ROOM_PROGRAMS) {
      expect({ kind: def.kind, ok: canResolveGlyph(roomDisplayGlyph(def)) })
        .toEqual({ kind: def.kind, ok: true });
    }
  });

  it("resolves for every catalog structure", () => {
    for (const s of TOWN_PLAY_STRUCTURES) {
      expect({ type: s.type, ok: canResolveGlyph(structureDisplayGlyph(s)) })
        .toEqual({ type: s.type, ok: true });
    }
  });
});

describe("persistent wants — nextAnnexWant reads programs first", () => {
  it("an unmet programmed room outranks the default differentiation", () => {
    // Default order would say "sleep" (no bedrooms); the standing store
    // program wins — an ORDERED room is built before any default one.
    // (Phase 4: this used to be justified as "how a demolished programmed
    // room re-rises". It no longer does — the commit DROPS the row with the
    // room. The precedence itself is untouched: a want that still stands is
    // still first.)
    expect(nextAnnexWant(planOf(["living"]), [{ room: "store" }])).toBe("store");
  });

  it("a satisfied program falls through to the default order", () => {
    expect(nextAnnexWant(planOf(["living", "store"]), [{ room: "store" }])).toBe("sleep");
  });

  it("a non-annexable programmed kind is skipped (waits for ⑤)", () => {
    expect(nextAnnexWant(planOf(["living"]), [{ room: "shrine" }])).toBe("sleep");
  });

  it("program rows ride the deltas round-trip and count as non-empty", () => {
    const deltas = createTownDeltas();
    deltas.mutate("h_0", (d) => {
      d.programs = [{ ord: 0, room: "bedroom" }];
    });
    expect(deltaIsEmpty(deltas.get("h_0"))).toBe(false);
    const back = createTownDeltas(deltas.toJSON());
    expect(back.get("h_0")?.programs).toEqual([{ ord: 0, room: "bedroom" }]);
  });
});
