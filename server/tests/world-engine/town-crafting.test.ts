// FURNITURE CRAFTING (construction pipeline ③), at the pure layer — the
// workbench ACCELERATES, never gates: every craftable piece can be made by
// hand at the slow rate, working at the recipe's station cuts the labor to
// a third, and the automated crafter's FIRST piece is the workbench itself
// (hand-made by necessity — the tool that speeds everything after). No
// DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  CRAFT_HAND_DAYS,
  CRAFT_STATION_FACTOR,
  craftLaborDays,
  craftLaborDaysFor,
  FURNITURE_ITEMS,
  furnitureGlyph,
  furnitureItemOf,
  isCraftStation,
  nextCraftKind,
  stationRoomKind,
} from "@shared/world-engine/kernel/town/stations.js";
import { buildingChainGlyphs } from "@shared/world-engine/products.js";

const BENCH = furnitureItemOf("workbench")!;

describe("the workbench bootstrap", () => {
  it("the workbench is CRAFTABLE — by hand, like everything else", () => {
    expect(BENCH.craft).toBeDefined();
    expect(Object.keys(BENCH.craft!.consumes).length).toBeGreaterThan(0);
  });

  it("every recipe consumes only glyphs the building CHAIN can supply", () => {
    // Since phase 3 furniture consumes BLOCKS — not a natural product, but
    // the chain's refined target (wood/stone mill into it), so the supply
    // closure is the chain vocabulary, raws AND refined heads.
    const supplies = new Set(buildingChainGlyphs());
    for (const f of FURNITURE_ITEMS) {
      if (!f.craft) continue;
      for (const g of Object.keys(f.craft.consumes)) expect(supplies.has(g)).toBe(true);
    }
  });
});

describe("craftLaborDays — the station speeds, never gates", () => {
  it("hand labor runs the full rate; the bench cuts it to the factor", () => {
    const chair = furnitureItemOf("chair")!;
    expect(craftLaborDays(chair, false)).toBe(CRAFT_HAND_DAYS);
    expect(craftLaborDays(chair, true)).toBe(CRAFT_HAND_DAYS * CRAFT_STATION_FACTOR);
    expect(craftLaborDays(chair, true)).toBeLessThan(craftLaborDays(chair, false));
  });

  it("a recipe naming no station is hand-rate regardless of where you stand", () => {
    const def = { kind: "chair" as const, radius: 0.2, openable: false, craft: { consumes: { wood: 1 } } };
    expect(craftLaborDays(def, true)).toBe(CRAFT_HAND_DAYS);
  });

  // The labor rule was never about WHAT is being made — furniture is no longer
  // the only thing the pipeline makes (toys ride the same clock), so the rate is
  // a function of the accelerating station alone. `craftLaborDays` is the
  // furniture-shaped wrapper over it.
  it("reads from the STATION alone, so a toy recipe gets the same rule", () => {
    expect(craftLaborDaysFor("workbench", false)).toBe(CRAFT_HAND_DAYS);
    expect(craftLaborDaysFor("workbench", true)).toBe(CRAFT_HAND_DAYS * CRAFT_STATION_FACTOR);
    expect(craftLaborDaysFor(undefined, true)).toBe(CRAFT_HAND_DAYS);
    // …and the furniture wrapper is exactly that call.
    const chair = furnitureItemOf("chair")!;
    expect(craftLaborDays(chair, true)).toBe(craftLaborDaysFor(chair.craft!.at, true));
  });
});

describe("nextCraftKind — bench-first automation", () => {
  const none = () => 0;

  it("with no standing bench and none stored, the WORKBENCH comes first", () => {
    expect(nextCraftKind({ day: 3, salt: 1, hasBench: false, stored: none })?.kind).toBe("workbench");
    // Whatever day it is — the bootstrap outranks the rotation.
    for (let d = 0; d < 12; d++) {
      expect(nextCraftKind({ day: d, salt: 5, hasBench: false, stored: none })?.kind).toBe("workbench");
    }
  });

  it("a standing bench (or one stored, awaiting placement) yields the rotation", () => {
    const benchStored = (g: string) => (g === furnitureGlyph("workbench") ? 1 : 0);
    const a = nextCraftKind({ day: 3, salt: 1, hasBench: false, stored: benchStored });
    const b = nextCraftKind({ day: 3, salt: 1, hasBench: true, stored: none });
    expect(a).toEqual(b); // same rotation pick either way — no double bootstrap
  });

  it("the rotation caps at 2 stored per kind (null = nothing to make today)", () => {
    const pick = nextCraftKind({ day: 4, salt: 2, hasBench: true, stored: none })!;
    const full = (g: string) => (g === furnitureGlyph(pick.kind) ? 2 : 0);
    expect(nextCraftKind({ day: 4, salt: 2, hasBench: true, stored: full })).toBeNull();
  });

  it("is deterministic in (day, salt)", () => {
    const a = nextCraftKind({ day: 7, salt: 3, hasBench: true, stored: none });
    const b = nextCraftKind({ day: 7, salt: 3, hasBench: true, stored: none });
    expect(a).toEqual(b);
    expect(a).not.toBeNull();
  });
});

describe("the ENABLER rule — which pieces the drawing owes a place", () => {
  // Layer 3 of the blueprint draws a place for a TOOL the household owns and
  // has nowhere to stand. The set is asked from the spec side (`craft.at`)
  // rather than named, so a forge recipe would enrol its forge with no edit —
  // and, just as importantly, so that "a place for everything we own" can never
  // widen into the blanket auto-place the user removed in 2026-07-28.
  it("a station is a piece other things are MADE AT — never a chair", () => {
    expect(isCraftStation("workbench")).toBe(true);
    for (const kind of ["chair", "bed", "table", "chest", "box", "barrel", "bin"] as const) {
      expect([kind, isCraftStation(kind)]).toEqual([kind, false]);
    }
  });

  it("every recipe's station IS one, by construction", () => {
    // The two directions of `craft.at` must agree, or a recipe could name a
    // station the enabler test does not recognise and the tool it needs would
    // never be drawn a home.
    for (const f of FURNITURE_ITEMS) {
      if (!f.craft?.at) continue;
      expect([f.kind, isCraftStation(f.craft.at)]).toEqual([f.kind, true]);
    }
  });

  it("names the room a station belongs in, from the placement rows", () => {
    // The hard-coded "workshop, else store, else living" search that used to
    // live in the install sweep is now a fact about the piece, read from the
    // registry row that places it.
    expect(stationRoomKind("workbench")).toBe("workshop");
    expect(stationRoomKind("bed")).toBe("bedroom");
    expect(stationRoomKind("oven")).toBe("kitchen");
    expect(stationRoomKind("table")).toBe("living"); // the communal cluster
  });
});
