// ROOM & STRUCTURE PROGRAMS (construction pipeline ④), at the pure layer —
// ONE table read both directions: forward a program NAMES a goal (bedroom =
// a room holding a bed), backward a room's kind DERIVES from the furniture
// standing in it and a building's character from its rooms. Culture defs
// (game.culture.architecture.rooms/buildings) replace same-name defaults in
// place and append new names; unknown station kinds resolve to no-ops.
// Persistent wants: an unmet programmed room outranks the default annex
// differentiation, so a demolished bedroom re-rises. No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  buildingKindOf,
  DEFAULT_ROOM_PROGRAMS,
  programOverridesOf,
  resolveRoomPrograms,
  resolveStructurePrograms,
  roomKindOf,
  roomProgramMet,
  roomProgramOf,
} from "@shared/world-engine/kernel/town/programs.js";
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
    expect(roomKindOf(["privy"])).toBe("bath");
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
    const defs = resolveRoomPrograms(
      programOverridesOf({ rooms: [{ kind: "shrine", requires: ["table"], signature: ["table"] }] }),
    );
    expect(defs[defs.length - 1]!.kind).toBe("shrine");
    // living's signature (earlier) still claims a table room first.
    expect(roomKindOf(["table"], defs)).toBe("living");
  });

  it("unknown station kinds are NO-OPS; a def left empty is dropped whole", () => {
    const over = programOverridesOf({
      rooms: [
        { kind: "bedroom", requires: ["bed", "altar"] }, // altar dropped, bed kept
        { kind: "void", requires: ["altar"] }, // dropped whole
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
});

describe("persistent wants — nextAnnexWant reads programs first", () => {
  it("an unmet programmed room outranks the default differentiation", () => {
    // Default order would say "sleep" (no bedrooms); the standing store
    // program wins — this is how a demolished programmed room re-rises.
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
