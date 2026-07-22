// ZONE CHARTERS (city-expansion ③), at the pure layer — the exact pieces
// quest-host wires: a charter is a serializable disc + category row in
// TownDeltas (toJSON round-trip, later-wins overlap, clearing charters);
// foundingOptions admits zoned slots only for the zone's category (match-
// first ordering, unzoned ground permissive, blocked ground never
// enumerated — the annexOptions law); and zone-steered auto-expansion
// (foundingGrowthStep) banks town prosperity and founds the most-needed
// admitted structure inside a zone with ground for it, deterministically,
// spending the real yard stock. No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  createTownDeltas,
  foundingOptions,
  type FoundingCandidate,
  type TownDeltas,
} from "@shared/world-engine/kernel/town/construction.js";
import {
  candidateInZone,
  categoriesOfSpec,
  foundingGrowthStep,
  FOUNDING_PROSPERITY_DAILY_CAP,
  FOUNDING_PROSPERITY_THRESHOLD,
  resolveZoneCategory,
  slotZoningFn,
  structureNeedScore,
  zoneAt,
  type FoundingGrowthInput,
  type ZoneCharter,
} from "@shared/world-engine/kernel/town/zoning.js";
import { resolveStructure, type StructureSpec } from "@shared/world-engine/kernel/town/structures.js";
import { foundSite, siteTownConfig } from "@shared/world-engine/interaction/town/founding.js";
import { buildTownPlay, TOWN_PLAY_STRUCTURES } from "@shared/world-engine/interaction/town/town-play.js";

const SEED = 21;
const KEY = "millbrook";

const HOUSE = resolveStructure(TOWN_PLAY_STRUCTURES, "house")!;
const FARM = resolveStructure(TOWN_PLAY_STRUCTURES, "farm")!;

/** TOWN_PLAY district lookup (farm's BuildingDef files under "farm"). */
const districtOf = (key: string): string | null => (key === "farm" ? "farm" : null);

/** Raw (zone-blind) feasible lots for a spec — the geometry oracle the
 *  zone tests position their discs against. */
function rawLots(spec: StructureSpec, max = 3): FoundingCandidate[] {
  return foundingOptions({
    seed: SEED, key: KEY, footprint: spec.footprint, type: spec.type,
    occupied: [], claimedSlots: new Set(), max,
  });
}

const lotCenter = (c: FoundingCandidate): { x: number; y: number } => ({
  x: c.dx + c.w / 2,
  y: c.dy + c.h / 2,
});

describe("charter lifecycle + serialization (the TownDeltas pattern)", () => {
  it("addZone assigns monotone ords, bumps the version, survives toJSON round-trip", () => {
    const deltas = createTownDeltas();
    const v0 = deltas.version;
    const a = deltas.addZone({ x: 0, y: 0, r: 20, category: "farm", issuer: "p" });
    const b = deltas.addZone({ x: 10, y: 0, r: 15, category: "house", issuer: "p" });
    expect(a.ord).toBe(0);
    expect(b.ord).toBe(1);
    expect(deltas.version).toBe(v0 + 2);
    deltas.civic.prosperity = 3.5;

    const restored = createTownDeltas(deltas.toJSON());
    expect(restored.zones()).toEqual(deltas.zones());
    expect(restored.civic.prosperity).toBe(3.5);
    // The restored store keeps minting PAST the old ords (stable forever —
    // the ④ district seed).
    expect(restored.addZone({ x: 0, y: 0, r: 5, category: null, issuer: "p" }).ord).toBe(2);
  });

  it("overlap rule: the LATEST charter covering a point wins; clearing (null) reads unzoned", () => {
    const zones: ZoneCharter[] = [
      { ord: 0, x: 0, y: 0, r: 20, category: "farm", issuer: "p" },
      { ord: 1, x: 10, y: 0, r: 8, category: "house", issuer: "p" },
    ];
    expect(zoneAt(zones, -15, 0)?.category).toBe("farm"); // only the old disc
    expect(zoneAt(zones, 10, 0)?.category).toBe("house"); // overlap → later wins
    expect(zoneAt(zones, 100, 100)).toBeNull(); // virgin ground
    // A clearing charter painted over the middle: that ground is unzoned
    // again; the rest of the farm disc still holds.
    const cleared = [...zones, { ord: 2, x: 10, y: 0, r: 8, category: null, issuer: "p" }];
    expect(zoneAt(cleared, 10, 0)).toBeNull();
    expect(zoneAt(cleared, -15, 0)?.category).toBe("farm");
  });

  it("category vocabulary: a spec answers to its type AND its economy district", () => {
    expect([...categoriesOfSpec(FARM, districtOf)].sort()).toEqual(["farm"]);
    expect([...categoriesOfSpec(HOUSE, districtOf)]).toEqual(["house"]);
    // Spoken words resolve through the catalog (type/glyph/label), else a
    // district class; unknown words are NULL — the caller names the can't.
    expect(resolveZoneCategory(TOWN_PLAY_STRUCTURES, districtOf, "farm")).toBe("farm");
    expect(resolveZoneCategory(TOWN_PLAY_STRUCTURES, districtOf, "Market")).toBe("market");
    expect(resolveZoneCategory(TOWN_PLAY_STRUCTURES, districtOf, "palace")).toBeNull();
  });

  it("charters ride the founding seam (siteTownConfig → buildTownPlay replay)", () => {
    const site = foundSite({ seed: 77, at: { x: 100, y: 100 }, key: "outpost" });
    site.deltas.addZone({ x: 4, y: -6, r: 18, category: "farm", issuer: "p" });
    const play = buildTownPlay(siteTownConfig(site));
    expect(play.deltas.zones()).toEqual(site.deltas.zones());
  });
});

describe("the founding filter (foundingOptions × charters)", () => {
  it("unzoned ground stays permissive: no charters ⇒ byte-identical enumeration", () => {
    const raw = rawLots(HOUSE);
    const withEmpty = foundingOptions({
      seed: SEED, key: KEY, footprint: HOUSE.footprint, type: HOUSE.type,
      occupied: [], claimedSlots: new Set(),
      zoning: slotZoningFn([], categoriesOfSpec(HOUSE, districtOf)),
    });
    expect(withEmpty).toEqual(raw);
  });

  it("a slot inside a zone only admits the zone's category (blocked ground never enumerates)", () => {
    // One farm charter over the WHOLE town: houses have nowhere; farms do.
    const zones: ZoneCharter[] = [{ ord: 0, x: 0, y: 0, r: 10_000, category: "farm", issuer: "p" }];
    const houseLots = foundingOptions({
      seed: SEED, key: KEY, footprint: HOUSE.footprint, type: HOUSE.type,
      occupied: [], claimedSlots: new Set(),
      zoning: slotZoningFn(zones, categoriesOfSpec(HOUSE, districtOf)),
    });
    expect(houseLots).toEqual([]);
    const farmLots = foundingOptions({
      seed: SEED, key: KEY, footprint: FARM.footprint, type: FARM.type,
      occupied: [], claimedSlots: new Set(),
      zoning: slotZoningFn(zones, categoriesOfSpec(FARM, districtOf)),
    });
    expect(farmLots.length).toBeGreaterThan(0);
  });

  it("zone-compatible slots are PREFERRED (match-first) over open ground", () => {
    const raw = rawLots(HOUSE, 3);
    expect(raw.length).toBeGreaterThan(1);
    // Charter a small house zone over the SECOND raw slot only.
    const at = lotCenter(raw[1]!);
    const zones: ZoneCharter[] = [{ ord: 0, x: at.x, y: at.y, r: 3, category: "house", issuer: "p" }];
    const lots = foundingOptions({
      seed: SEED, key: KEY, footprint: HOUSE.footprint, type: HOUSE.type,
      occupied: [], claimedSlots: new Set(),
      zoning: slotZoningFn(zones, categoriesOfSpec(HOUSE, districtOf)),
    });
    // The zoned slot leads even though slot order put it second.
    expect(lots[0]!.slot).toBe(raw[1]!.slot);
  });

  it("the manual-override refusal is NAMEABLE: zoned-out ground identifies its category", () => {
    // Everything zoned farmland ⇒ a house order finds nothing zone-aware,
    // but the RAW probe still finds ground — and the charter over it names
    // the reason ("that's farmland"), the quest-host refusal path.
    const zones: ZoneCharter[] = [{ ord: 0, x: 0, y: 0, r: 10_000, category: "farm", issuer: "p" }];
    const zoneAware = foundingOptions({
      seed: SEED, key: KEY, footprint: HOUSE.footprint, type: HOUSE.type,
      occupied: [], claimedSlots: new Set(),
      zoning: slotZoningFn(zones, categoriesOfSpec(HOUSE, districtOf)),
    });
    expect(zoneAware).toEqual([]);
    const raw = rawLots(HOUSE);
    expect(raw.length).toBeGreaterThan(0);
    const at = lotCenter(raw[0]!);
    expect(zoneAt(zones, at.x, at.y)?.category).toBe("farm");
  });

  it("candidateInZone follows the overlap rule (a painted-over zone governs no ground)", () => {
    const raw = rawLots(FARM, 1);
    const at = lotCenter(raw[0]!);
    const older: ZoneCharter = { ord: 0, x: at.x, y: at.y, r: 6, category: "farm", issuer: "p" };
    const newer: ZoneCharter = { ord: 1, x: at.x, y: at.y, r: 6, category: "house", issuer: "p" };
    expect(candidateInZone([older], older, raw[0]!)).toBe(true);
    expect(candidateInZone([older, newer], older, raw[0]!)).toBe(false); // painted over
    expect(candidateInZone([older, newer], newer, raw[0]!)).toBe(true);
  });
});

describe("zone-steered auto-expansion (foundingGrowthStep)", () => {
  /** A growth harness over real street geometry: one town-shaped input
   *  with injectable signals; charters land where the geometry says a lot
   *  fits (the raw oracle). */
  function makeInput(deltas: TownDeltas, over: Partial<FoundingGrowthInput> = {}): FoundingGrowthInput {
    const zones = () => deltas.zones();
    return {
      deltas,
      catalog: TOWN_PLAY_STRUCTURES,
      gain: FOUNDING_PROSPERITY_DAILY_CAP, // a healthy day, capped
      day: 1,
      signals: { crowding: 0, shortage: () => 0 },
      economyOf: (k) =>
        k === "farm" ? { cap: { by: "farmland", rate: 1 / 60 }, sells: ["food"], district: "farm" } : null,
      capValueOf: (by) => (by === "farmland" ? 420 : 200),
      countOf: () => 0,
      candidatesFor: (spec, zone) => {
        const cands = foundingOptions({
          seed: SEED, key: KEY, footprint: spec.footprint, type: spec.type,
          occupied: deltas.founded().map((b) => ({ x: b.dx, y: b.dy, w: b.w, h: b.h })),
          claimedSlots: new Set(deltas.founded().map((b) => b.slot)),
          zoning: slotZoningFn(zones(), categoriesOfSpec(spec, districtOf)),
        });
        // zone null = OPEN GROUND (no charter constrains this town).
        return zone === null ? cands : cands.filter((c) => candidateInZone(zones(), zone, c));
      },
      ...over,
    };
  }

  it("prosperity banks (capped) and a crossed threshold founds INSIDE the zone, spending yard stock", () => {
    const deltas = createTownDeltas();
    deltas.stock.wood = 40;
    deltas.stock.stone = 10;
    const zone = deltas.addZone({ x: 0, y: 0, r: 10_000, category: "farm", issuer: "p" });

    const days = Math.ceil(FOUNDING_PROSPERITY_THRESHOLD / FOUNDING_PROSPERITY_DAILY_CAP);
    let order = null;
    for (let d = 1; d <= days && !order; d++) {
      order = foundingGrowthStep(makeInput(deltas, { day: d, gain: 99 })); // cap holds accrual honest
    }
    expect(order).not.toBeNull();
    expect(order!.spec.type).toBe("farm");
    expect(order!.zoneOrd).toBe(zone.ord);
    // Written through the SAME FoundedBuilding path the player uses.
    expect(deltas.founded()).toHaveLength(1);
    expect(deltas.founded()[0]!.type).toBe("farm");
    expect(zoneAt(deltas.zones(), deltas.founded()[0]!.dx + deltas.founded()[0]!.w / 2,
      deltas.founded()[0]!.dy + deltas.founded()[0]!.h / 2)?.ord).toBe(zone.ord);
    // Real materials spent; the bank paid its threshold.
    expect(deltas.stock.wood).toBe(40 - FARM.costs.wood!);
    expect(deltas.civic.prosperity).toBeLessThan(FOUNDING_PROSPERITY_THRESHOLD);
  });

  it("an unzoned CONTENT town never auto-founds — need is the license, open ground never sprawls at rest", () => {
    const deltas = createTownDeltas();
    deltas.stock.wood = 100;
    for (let d = 1; d <= 20; d++) {
      expect(foundingGrowthStep(makeInput(deltas, { day: d }))).toBeNull();
    }
    expect(deltas.founded()).toHaveLength(0);
    expect(deltas.civic.prosperity).toBeGreaterThan(0); // banked, not lost
  });

  it("URGENT need founds WITHOUT charters or a banked threshold — a homeless camp raises a house on open ground (city-founding)", () => {
    const deltas = createTownDeltas();
    deltas.stock.wood = 40;
    deltas.stock.stone = 10;
    const order = foundingGrowthStep(makeInput(deltas, {
      gain: 0,
      signals: { crowding: 2, shortage: () => 0 },
    }));
    expect(order).not.toBeNull();
    expect(order!.spec.type).toBe("house");
    expect(order!.zoneOrd).toBe(-1); // open ground, no charter
    expect(deltas.founded()).toHaveLength(1);
    // Survival is materials-paid — the (empty) bank was never charged.
    expect(deltas.civic.prosperity).toBe(0);
  });

  it("a REAL shortage founds the producer on open ground; real-but-calm need waits for the bank", () => {
    const hungry = createTownDeltas();
    hungry.stock.wood = 40;
    const order = foundingGrowthStep(makeInput(hungry, {
      gain: 0,
      signals: { crowding: 0, shortage: (g) => (g === "food" ? 0.9 : 0) },
    }));
    expect(order?.spec.type).toBe("farm");
    // Crowding 1.0 (houses exactly full) is real need but not urgent:
    // open-ground growth then waits for the banked threshold.
    const calm = createTownDeltas();
    calm.stock.wood = 100;
    calm.stock.stone = 20;
    const sig = { crowding: 1.0, shortage: () => 0 };
    expect(foundingGrowthStep(makeInput(calm, { gain: 0, signals: sig }))).toBeNull();
    calm.civic.prosperity = FOUNDING_PROSPERITY_THRESHOLD;
    expect(foundingGrowthStep(makeInput(calm, { gain: 0, signals: sig }))?.spec.type).toBe("house");
  });

  it("structure choice is NEED-DRIVEN: crowding raises houses, food shortage raises farms", () => {
    // Two zones — one house, one farm — and enough banked prosperity.
    const build = (signals: { crowding: number; food: number }) => {
      const deltas = createTownDeltas();
      deltas.stock.wood = 100;
      deltas.stock.stone = 20;
      deltas.civic.prosperity = FOUNDING_PROSPERITY_THRESHOLD;
      deltas.addZone({ x: 0, y: 0, r: 10_000, category: "house", issuer: "p" });
      deltas.addZone({ x: 0, y: 0, r: 10_000, category: "farm", issuer: "p" });
      // NB the farm zone painted over the house zone — zone the house side
      // back over HALF the ground so both categories keep real ground.
      const raw = rawLots(HOUSE, 1);
      const at = lotCenter(raw[0]!);
      deltas.addZone({ x: at.x, y: at.y, r: 6, category: "house", issuer: "p" });
      const order = foundingGrowthStep(makeInput(deltas, {
        gain: 0,
        signals: { crowding: signals.crowding, shortage: (g) => (g === "food" ? signals.food : 0) },
      }));
      return order?.spec.type ?? null;
    };
    expect(build({ crowding: 1.8, food: 0.2 })).toBe("house"); // crowded → housing first
    expect(build({ crowding: 0.1, food: 0.9 })).toBe("farm"); // hungry → farmland first
  });

  it("the economy cap gates (the pasture-charter pattern: count < by × rate)", () => {
    const deltas = createTownDeltas();
    deltas.stock.wood = 100;
    deltas.civic.prosperity = FOUNDING_PROSPERITY_THRESHOLD;
    deltas.addZone({ x: 0, y: 0, r: 10_000, category: "farm", issuer: "p" });
    // farmland 30 × 1/60 = 0.5 ⇒ not even one farm is chartered.
    const order = foundingGrowthStep(makeInput(deltas, {
      gain: 0,
      capValueOf: (by) => (by === "farmland" ? 30 : 200),
    }));
    expect(order).toBeNull();
    expect(deltas.founded()).toHaveLength(0);
  });

  it("missing yard stock halts growth honestly (banking continues)", () => {
    const deltas = createTownDeltas(); // empty yard
    deltas.civic.prosperity = FOUNDING_PROSPERITY_THRESHOLD;
    deltas.addZone({ x: 0, y: 0, r: 10_000, category: "farm", issuer: "p" });
    expect(foundingGrowthStep(makeInput(deltas, { gain: 0 }))).toBeNull();
    expect(deltas.civic.prosperity).toBe(FOUNDING_PROSPERITY_THRESHOLD); // not spent
  });

  it("deterministic replay: the same serialized store grows the same building", () => {
    const grow = () => {
      const deltas = createTownDeltas();
      deltas.stock.wood = 60;
      deltas.stock.stone = 12;
      deltas.addZone({ x: 0, y: 0, r: 10_000, category: "farm", issuer: "p" });
      let order = null;
      for (let d = 1; d <= 10 && !order; d++) {
        order = foundingGrowthStep(makeInput(deltas, { day: d }));
      }
      return deltas.toJSON();
    };
    const a = grow();
    const b = grow();
    expect(a.founded).toEqual(b.founded);
    expect(a.stock).toEqual(b.stock);
    expect(a.civicProsperity).toBe(b.civicProsperity);
    // And a store RESTORED from the serialization keeps growing identically.
    const restored = createTownDeltas(a);
    const order = foundingGrowthStep(makeInput(restored, { day: 11 }));
    const restored2 = createTownDeltas(b);
    const order2 = foundingGrowthStep(makeInput(restored2, { day: 11 }));
    expect(order?.building ?? null).toEqual(order2?.building ?? null);
  });
});

describe("need scoring stays data-driven off the catalog + economy rows", () => {
  it("houses score crowding; sellers score their commodity's shortage; the rest the flat default", () => {
    const farmEco = { cap: { by: "farmland", rate: 1 / 60 }, sells: ["food"], district: "farm" };
    const signals = { crowding: 1.4, shortage: (g: string) => (g === "food" ? 0.7 : 0) };
    expect(structureNeedScore(HOUSE, null, signals)).toBeCloseTo(1.4);
    expect(structureNeedScore(FARM, farmEco, signals)).toBeCloseTo(0.7);
    const market = resolveStructure(TOWN_PLAY_STRUCTURES, "market")!;
    expect(structureNeedScore(market, null, signals)).toBeCloseTo(0.2);
  });
});
