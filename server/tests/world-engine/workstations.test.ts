// THE WORKSTATION REGISTRY (shared/world-engine/kernel/town/workstations.ts):
// the single runtime access point that sits over the default station arrays.
// P0's contract is PARITY — the default registry must reproduce the authored
// HOUSE_STATIONS / WORK_STATIONS rows byte-for-byte (only adding the inert
// `role`/`placement` labels), so every consumer that now reads the registry
// furnishes exactly as it did when it read the arrays directly. These tests
// are the gate on that guarantee. Pure — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  HOUSE_STATIONS,
  WORK_STATIONS,
  FURNITURE_ITEMS,
} from "@shared/world-engine/kernel/town/stations.js";
import {
  DEFAULT_WORKSTATION_REGISTRY,
  buildWorkstationRegistry,
  workExtraStationDefs,
  type WorkstationDef,
  type PlacementMode,
} from "@shared/world-engine/kernel/town/workstations.js";
import { houseFurniture, workFurniture } from "@shared/world-engine/kernel/town/furniture.js";
import { workProgram } from "@shared/world-engine/kernel/town/stations.js";
import type { WorkShape } from "@shared/world-engine/kernel/town/rooms.js";
import type { TownHouse } from "@shared/world-engine/kernel/town/plan.js";

const center = { x: 100, y: 100 };
const mkHouse = (index: number, w: number, h: number, door: TownHouse["door"]): TownHouse =>
  ({ index, dx: -w / 2, dy: -h / 2, w, h, door, color: "#a8875f", floors: 1 }) as TownHouse;

/** A WorkstationDef stripped back to the StationDef the geometry driver reads
 *  (the registry only ADDS `role`/`placement`/`capability`). */
const asStationDef = ({ role, placement, capability, ...station }: WorkstationDef) => station;

describe("workstation registry — parity with the default station arrays", () => {
  it("registry.house is HOUSE_STATIONS byte-for-byte (only role/placement added)", () => {
    expect(DEFAULT_WORKSTATION_REGISTRY.house.map(asStationDef)).toEqual([...HOUSE_STATIONS]);
    for (const d of DEFAULT_WORKSTATION_REGISTRY.house) expect(d.role).toBe("house");
  });

  it("registry.work is WORK_STATIONS byte-for-byte (only role/placement added)", () => {
    expect(DEFAULT_WORKSTATION_REGISTRY.work.map(asStationDef)).toEqual([...WORK_STATIONS]);
    for (const d of DEFAULT_WORKSTATION_REGISTRY.work) expect(d.role).toBe("work");
  });

  it("all = house ++ work, order preserved", () => {
    expect(DEFAULT_WORKSTATION_REGISTRY.all.map(asStationDef)).toEqual([
      ...HOUSE_STATIONS,
      ...WORK_STATIONS,
    ]);
  });
});

describe("workstation registry — the placement mode derives as specified", () => {
  it("work rows are own_building; communal house rows are in_room; the rest own_room", () => {
    const modeOf = (kindKey: string): PlacementMode | undefined =>
      DEFAULT_WORKSTATION_REGISTRY.all.find((d) => d.key === kindKey)?.placement;
    // work role → own_building
    for (const d of DEFAULT_WORKSTATION_REGISTRY.work) expect(d.placement).toBe("own_building");
    // shared communal cell → in_room
    expect(modeOf("table")).toBe("in_room");
    expect(modeOf("chair")).toBe("in_room");
    expect(modeOf("bin")).toBe("in_room");
    // a cluster that seeks its own cell → own_room
    expect(modeOf("oven")).toBe("own_room"); // kitchen
    expect(modeOf("bath")).toBe("own_room"); // wet
    expect(modeOf("bed_0")).toBe("own_room"); // sleep
    expect(modeOf("workbench")).toBe("own_room"); // workshop annex
  });

  it("every house row's placement matches its cluster (communal ⇒ in_room, else own_room)", () => {
    for (const d of DEFAULT_WORKSTATION_REGISTRY.house) {
      expect(d.placement).toBe(d.cluster === "communal" ? "in_room" : "own_room");
    }
  });
});

describe("workstation registry — the derived accessors match the old array reads", () => {
  it("byKind returns the FIRST house row of a kind (was HOUSE_STATIONS.find)", () => {
    for (const kind of new Set(HOUSE_STATIONS.map((d) => d.kind))) {
      expect(asStationDef(DEFAULT_WORKSTATION_REGISTRY.byKind(kind)!)).toEqual(
        HOUSE_STATIONS.find((d) => d.kind === kind),
      );
    }
    // a kind no house row covers resolves to nothing (the scorer supplies its
    // own wall-scan default around this).
    expect(DEFAULT_WORKSTATION_REGISTRY.byKind("bowl" as never)).toBeDefined();
  });

  it("byKey returns the house anchor rows besideAnchor looks up", () => {
    expect(DEFAULT_WORKSTATION_REGISTRY.byKey("table")!.kind).toBe("table");
    expect(DEFAULT_WORKSTATION_REGISTRY.byKey("nonexistent")).toBeUndefined();
  });

  it("openableKinds unions house + work openable rows and their kindByGood models", () => {
    const kinds = DEFAULT_WORKSTATION_REGISTRY.openableKinds;
    expect(kinds.has("chest")).toBe(true); // openable row
    expect(kinds.has("refrigerator")).toBe(true); // food chest's kindByGood model
    expect(kinds.has("bath")).toBe(false); // a bath does not open
    // it is exactly the union the old OPENABLE_KINDS derivation computed.
    const expected = new Set<string>();
    for (const s of [...HOUSE_STATIONS, ...WORK_STATIONS]) {
      if (!s.openable) continue;
      expected.add(s.kind);
      for (const m of Object.values(s.kindByGood ?? {})) expected.add(m);
    }
    expect([...kinds].sort()).toEqual([...expected].sort());
  });
});

describe("workstation registry — furnishing is byte-identical through the registry", () => {
  const goods = [{ key: "food", slot: 0 }, { key: "tools", slot: 1 }];

  it("houseFurniture through the default registry == through an explicit rebuild", () => {
    const rebuilt = buildWorkstationRegistry(HOUSE_STATIONS, WORK_STATIONS);
    for (const door of ["north", "south", "east", "west"] as const) {
      for (let w = 7; w <= 13; w++) {
        for (let d = 7; d <= 10; d++) {
          const h = mkHouse(w * 31 + d, w, d, door);
          const viaDefault = houseFurniture(center, h, goods);
          const viaRebuilt = houseFurniture(center, h, goods, "", undefined, rebuilt);
          expect(viaRebuilt).toEqual(viaDefault);
        }
      }
    }
  });

  it("FURNITURE_ITEMS still round-trips (untouched by the registry split)", () => {
    expect(FURNITURE_ITEMS.some((f) => f.kind === "workbench")).toBe(true);
  });
});

describe("P1 — a work building furnishes its OWN declared stations (StructureSpec.stations)", () => {
  const mkWork = (w: number, h: number, door: WorkShape["door"], stations?: WorkShape["stations"]): WorkShape =>
    ({ dx: -w / 2, dy: -h / 2, w, h, door, ...(stations ? { stations } : {}) });

  it("workExtraStationDefs synthesizes a floor row for a novel kind, skips a base one", () => {
    const defs = workExtraStationDefs(["workbench", "barrel"], DEFAULT_WORKSTATION_REGISTRY);
    // workbench is NOT in the base work set → synthesized; barrel IS → skipped.
    expect(defs.map((d) => d.kind)).toEqual(["workbench"]);
    const bench = defs[0]!;
    expect(bench.role).toBe("work");
    expect(bench.placement).toBe("own_building");
    expect(bench.cell).toEqual({ cell: "communal" });
    // radius reuses the kind's house row (0.7), not the 0.6 fallback.
    expect(bench.radius).toBe(0.7);
  });

  it("de-dupes repeated declarations and ignores empties", () => {
    expect(workExtraStationDefs(["workbench", "workbench"], DEFAULT_WORKSTATION_REGISTRY)).toHaveLength(1);
    expect(workExtraStationDefs(undefined, DEFAULT_WORKSTATION_REGISTRY)).toHaveLength(0);
    expect(workExtraStationDefs([], DEFAULT_WORKSTATION_REGISTRY)).toHaveLength(0);
  });

  it("workFurniture appends the extra fixture; a building WITHOUT stations is unchanged", () => {
    const base = workFurniture(center, 0, mkWork(16, 12, "south"), workProgram("weaver"));
    const withBench = workFurniture(center, 0, mkWork(16, 12, "south", ["workbench"]), workProgram("weaver"));
    // The base storefront never carried a workbench...
    expect(base.some((p) => p.kind === "workbench")).toBe(false);
    // ...and declaring one adds exactly it, leaving the rest byte-identical.
    expect(withBench.some((p) => p.kind === "workbench")).toBe(true);
    expect(withBench.filter((p) => p.kind !== "workbench")).toEqual(base);
  });
});
