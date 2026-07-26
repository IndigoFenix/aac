// CULTURE ARCHITECTURE (P2): `game.culture.architecture` declares how a town
// BUILDS — per-station placement overrides that decide where a dwelling puts
// its workstations (an open-hearth culture cooks in the shared hall; a formal
// one gives the oven its own kitchen). Parsed/gated like `dress` (unknown
// fields rejected, bounded map, placement ∈ the three modes), resolved into the
// workstation registry the town furnishes from. This pins the spec gate, the
// resolve, and the concrete furnishing effect (the oven actually moves).

import { describe, expect, it } from "@jest/globals";
import {
  parseWorldCultureSpec,
  parseWorldArchitectureSpec,
  resolveWorldCulture,
  OPEN_CULTURE,
} from "@shared/world-engine/culture.js";
import {
  resolveWorkstationRegistry,
  DEFAULT_WORKSTATION_REGISTRY,
} from "@shared/world-engine/kernel/town/workstations.js";
import { houseFurniture } from "@shared/world-engine/kernel/town/furniture.js";
import type { TownHouse } from "@shared/world-engine/kernel/town/plan.js";

const center = { x: 100, y: 100 };
const mkHouse = (index: number, w: number, h: number, door: TownHouse["door"]): TownHouse =>
  ({ index, dx: -w / 2, dy: -h / 2, w, h, door, color: "#a8875f", floors: 1 }) as TownHouse;
const goods = [{ key: "food", slot: 0 }, { key: "tools", slot: 1 }];

describe("game.culture.architecture — parse + gate", () => {
  it("accepts a workstations block alongside absolutes + dress", () => {
    const spec = parseWorldCultureSpec(
      {
        absolutes: ["fight"],
        dress: { palette: ["color_red"] },
        architecture: { workstations: { oven: { placement: "in_room" } } },
      },
      "game.culture",
    );
    expect(spec.architecture).toEqual({ workstations: { oven: { placement: "in_room" } } });
  });

  it("accepts a room retarget on own_room", () => {
    const a = parseWorldArchitectureSpec(
      { workstations: { bath: { placement: "own_room", room: "wet" } } },
      "a",
    );
    expect(a.workstations!.bath).toEqual({ placement: "own_room", room: "wet" });
  });

  it("accepts room + building PROGRAM defs (pipeline ④ — the reserved blocks made real)", () => {
    const a = parseWorldArchitectureSpec(
      {
        rooms: [{ kind: "bedroom", requires: ["bed", "chest"], signature: ["bed"] }],
        buildings: [{ type: "house", rooms: ["bedroom", "living"] }],
      },
      "a",
    );
    expect(a.rooms).toEqual([{ kind: "bedroom", requires: ["bed", "chest"], signature: ["bed"] }]);
    expect(a.buildings).toEqual([{ type: "house", rooms: ["bedroom", "living"] }]);
  });

  it("rejects unknown fields, bad placement, junk shape — path-exact", () => {
    expect(() => parseWorldCultureSpec({ architecture: { rooms: {} } }, "game.culture")).toThrow(
      /game\.culture\.architecture\.rooms: expected an array/,
    );
    expect(() => parseWorldArchitectureSpec({ rooms: [{ kind: "x" }] }, "a")).toThrow(
      /a\.rooms\[0\]\.requires: expected an array of words/,
    );
    expect(() => parseWorldArchitectureSpec({ buildings: [{ type: "x", rooms: ["y"], extra: 1 }] }, "a")).toThrow(
      /a\.buildings\[0\]\.extra: unknown field/,
    );
    expect(() => parseWorldArchitectureSpec({ workstations: { oven: { placement: "attic" } } }, "a")).toThrow(
      /a\.workstations\.oven\.placement: expected one of in_room \| own_room \| own_building/,
    );
    expect(() => parseWorldArchitectureSpec({ workstations: { oven: { color: "red" } } }, "a")).toThrow(
      /a\.workstations\.oven\.color: unknown field/,
    );
    expect(() => parseWorldArchitectureSpec({ workstations: "oven" }, "a")).toThrow(
      /a\.workstations: expected an object/,
    );
    expect(() => parseWorldArchitectureSpec({ workstations: { oven: 3 } }, "a")).toThrow(
      /a\.workstations\.oven: expected an object/,
    );
  });
});

describe("game.culture.architecture — resolve", () => {
  it("carries the architecture onto the resolved culture", () => {
    const culture = resolveWorldCulture({ architecture: { workstations: { oven: { placement: "in_room" } } } });
    expect(culture.architecture).toEqual({ workstations: { oven: { placement: "in_room" } } });
    expect(culture.absolutes.size).toBe(0);
  });

  it("an architecture-only declaration is NOT the shared open-culture singleton", () => {
    expect(resolveWorldCulture({}).architecture).toBeUndefined();
    expect(resolveWorldCulture(null)).toBe(OPEN_CULTURE);
    expect(resolveWorldCulture({ architecture: { workstations: {} } })).not.toBe(OPEN_CULTURE);
  });
});

describe("resolveWorkstationRegistry — the override remaps the station's placement", () => {
  it("no overrides ⇒ the shared default registry (identity)", () => {
    expect(resolveWorkstationRegistry(undefined)).toBe(DEFAULT_WORKSTATION_REGISTRY);
    expect(resolveWorkstationRegistry({})).toBe(DEFAULT_WORKSTATION_REGISTRY);
  });

  it("oven → in_room flattens the kitchen cluster into the communal hearth", () => {
    const reg = resolveWorkstationRegistry({ oven: { placement: "in_room" } });
    const oven = reg.house.find((d) => d.kind === "oven")!;
    expect(oven.cluster).toBe("communal"); // was "kitchen"
    expect(oven.cell).toEqual({ cell: "communal" });
    expect(oven.placement).toBe("in_room"); // the derived label agrees
    // and only the oven moved — the bath keeps its own wet room.
    expect(reg.house.find((d) => d.kind === "bath")!.cluster).toBe("wet");
    // WORK rows are untouched (a culture statement never leaks onto a shop floor).
    expect(reg.work).toEqual(DEFAULT_WORKSTATION_REGISTRY.work);
  });

  it("own_room can retarget a communal station to a named cluster", () => {
    const reg = resolveWorkstationRegistry({ bin: { placement: "own_room", room: "store" } });
    const bin = reg.house.find((d) => d.kind === "bin")!;
    expect(bin.cluster).toBe("store");
    expect(bin.cell).toEqual({ cell: "store" });
    expect(bin.placement).toBe("own_room");
  });
});

describe("culture architecture — furnishing actually follows the override", () => {
  const inRoomReg = resolveWorkstationRegistry({ oven: { placement: "in_room" } });

  it("oven→in_room relocates the stove wherever a house DOES split a kitchen", () => {
    // Scan a range of footprints. Where a house earns a dedicated kitchen cell
    // by default, the open-hearth override pulls the oven back into the
    // communal hall — a visibly different position for the same house (or, in a
    // packed hall, honestly goes without: the fit rule, not a bug). The
    // mechanism is proven by the moves that DO happen; the default oven is
    // always placed (its kitchen cell, or the communal fallback).
    let moves = 0;
    for (const door of ["south", "east"] as const) {
      for (let w = 10; w <= 16; w++) {
        for (let d = 9; d <= 13; d++) {
          const house = mkHouse(w * 101 + d, w, d, door);
          const ovenDef = houseFurniture(center, house, goods).find((p) => p.kind === "oven");
          const ovenIn = houseFurniture(center, house, goods, "", undefined, inRoomReg)
            .find((p) => p.kind === "oven");
          expect(ovenDef).toBeDefined(); // default: kitchen cell or communal fallback
          if (!ovenIn || ovenIn.x !== ovenDef!.x || ovenIn.y !== ovenDef!.y) moves++;
        }
      }
    }
    expect(moves).toBeGreaterThan(0);
  });

  it("no override ⇒ furnishing is byte-identical to the default registry", () => {
    for (let w = 8; w <= 16; w++) {
      for (let d = 8; d <= 13; d++) {
        const house = mkHouse(w * 7 + d, w, d, "east");
        expect(houseFurniture(center, house, goods, "", undefined, resolveWorkstationRegistry({})))
          .toEqual(houseFurniture(center, house, goods));
      }
    }
  });
});
