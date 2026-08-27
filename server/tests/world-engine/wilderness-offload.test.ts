/**
 * ⚖️ S&D S4 — THE WILDERNESS ENDPOINT: the `wild:` grammar and the offload
 * record (`interaction/quest/wild-area.ts`).
 *
 * The pins that matter here are CONSERVATION pins. A fold that loses a unit
 * per cycle is a forest that evaporates while the player walks away, which is
 * the item-conservation law's own worst case; every other property (the
 * gradient, the size classes, the clocks) is checked around them.
 */
import { describe, expect, it } from "@jest/globals";
import {
  parseScopeId,
  scopeIdOf,
  scopeParentOf,
  scopeReceivesGoods,
  wildAreaId,
} from "@shared/world-engine/kernel/town/scope.js";
import {
  advanceWildArea,
  condenseWildArea,
  dealUnits,
  drawWildArea,
  expandWildArea,
  readWildRecord,
  shiftWildAreaClock,
  WILD_AREA_CODEC,
  wildAreaCenter,
  wildAreaCounts,
  wildAreaPopulation,
  wildAreaQuote,
  wildAreaStock,
  wildDrawSectorOf,
  wildKeepChance,
  wildSourceEndpoint,
  wildSourcePartner,
  type WildAreaRecord,
} from "@shared/world-engine/interaction/quest/wild-area.js";
import {
  putStock,
  stackUnits,
  transferStock,
  type StockEndpoint,
} from "@shared/world-engine/kernel/town/transfer.js";
import { barterLegSeconds, BARTER_LEG_DAY_FRAC } from "@shared/world-engine/kernel/town/barter.js";
import { FOOD_DAY_SEC } from "@shared/world-engine/kernel/town/goods.js";
import {
  DOLLHOUSE_SCALE, dailyTravelM, transactionDayFrac,
} from "@shared/world-engine/scale.js";
import {
  buildWilderness,
  wildFeatureContainerId,
  type WildernessFeature,
} from "@shared/world-engine/interaction/quest/wilderness.js";
import { growthClassYield, naturalSourceOf } from "@shared/world-engine/products.js";

const AREA = { x: 0, y: 0, w: 240, h: 240 };

const sumStocks = (features: readonly WildernessFeature[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const f of features) {
    for (const [g, n] of Object.entries(f.stock)) if (n > 0) out[g] = (out[g] ?? 0) + n;
  }
  return out;
};

const fold = (features: readonly WildernessFeature[], now = 0, prev?: WildAreaRecord) =>
  condenseWildArea({ features, now, area: AREA, seed: 11, key: "home", prev });

describe("S4 — `wild:` in the scope grammar", () => {
  it("round-trips every spelling a natural source has", () => {
    for (const id of [
      "wild:oak_3",
      "wild:rock_10",
      "wild:apple_tree_0", // a species key with an underscore of its own
      "wild:oak_face:3:5:2", // a flora twin's instance-key tag
      "flora:oak:wild:oak_3", // an embodied plant's BODY id
      "fauna:sheep:wild_sheep_0", // a product animal's BODY id
      "wild:area:home", // the offloaded area itself
    ]) {
      expect(scopeIdOf(parseScopeId(id))).toBe(id);
      expect(parseScopeId(id).kind).toBe("wild");
    }
  });

  it("names the species and the form", () => {
    expect(parseScopeId("wild:oak_3")).toEqual({
      kind: "wild", form: "box", species: "oak", tag: "3",
    });
    expect(parseScopeId("wild:apple_tree_0")).toEqual({
      kind: "wild", form: "box", species: "apple_tree", tag: "0",
    });
    expect(parseScopeId("flora:oak:wild:oak_3")).toEqual({
      kind: "wild", form: "flora", species: "oak", tag: "wild:oak_3",
    });
    expect(parseScopeId("fauna:cow:wild_cow_0")).toEqual({
      kind: "wild", form: "fauna", species: "cow", tag: "wild_cow_0",
    });
    expect(parseScopeId(wildAreaId("home"))).toEqual({
      kind: "wild", form: "area", species: "", tag: "home",
    });
  });

  it("🚨 moves no other id — every shipped prefix parses as before", () => {
    expect(parseScopeId("town:yard")).toEqual({ kind: "town", key: "yard" });
    expect(parseScopeId("store:food:0")).toEqual({ kind: "shelf", goodKey: "food", srcIdx: 0 });
    expect(parseScopeId("produce:food:2")).toEqual({ kind: "produce", goodKey: "food", workIdx: 2 });
    expect(parseScopeId("furn_3_chest_food")).toEqual({
      kind: "container", objectId: "furn_3_chest_food",
    });
    expect(parseScopeId("small:mat_2")).toEqual({ kind: "container", objectId: "small:mat_2" });
    expect(parseScopeId("h_3")).toEqual({ kind: "building", buildingKey: "h_3" });
  });

  it("⚖️ a source YIELDS, a shelf RECEIVES — the test that replaced four wilderness scans", () => {
    for (const id of ["wild:oak_3", "flora:oak:wild:oak_3", "fauna:cow:wild_cow_0", "wild:area:home"]) {
      expect(scopeReceivesGoods(parseScopeId(id))).toBe(false);
    }
    for (const id of ["town:yard", "site:stock", "furn_3_chest_food", "h_3", "orderpile:2"]) {
      expect(scopeReceivesGoods(parseScopeId(id))).toBe(true);
    }
  });

  it("hangs a standing source where it stands, and an offloaded area nowhere", () => {
    const ctx = { townId: () => "town", buildingOfContainer: () => null };
    expect(scopeParentOf(parseScopeId("wild:oak_3"), ctx)).toBe("town");
    // The renamed node did not MOVE: the old container reading answered the
    // same parent for the same id.
    expect(scopeParentOf({ kind: "container", objectId: "wild:oak_3" }, ctx)).toBe("town");
    expect(scopeParentOf(parseScopeId(wildAreaId("home")), ctx)).toBeNull();
  });
});

describe("S4 — dealUnits (the exactness the fold rests on)", () => {
  it("splits by weight and loses nothing", () => {
    expect(dealUnits(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(dealUnits(7, [0, 1, 3])).toEqual([0, 2, 5]);
    expect(dealUnits(5, [0, 0, 0])).toEqual([2, 2, 1]); // no weight ⇒ even
    expect(dealUnits(0, [1, 2])).toEqual([0, 0]);
    for (const total of [1, 3, 16, 97, 1000]) {
      const parts = dealUnits(total, [0, 0.25, 1, 1, 0.25]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});

describe("S4 — the offload record conserves", () => {
  const content = buildWilderness({
    seed: 11,
    side: 240,
    mix: [
      { species: "oak", count: 8 },
      { species: "rock", count: 4 },
      { species: "apple_tree", count: 2 },
    ],
  });

  it("🚨 FOLD conserves every unit", () => {
    const rec = fold(content.features);
    expect(wildAreaStock(rec)).toEqual(sumStocks(content.features));
    expect(wildAreaPopulation(rec)).toBe(content.features.length);
  });

  it("🚨 EXPAND conserves every unit", () => {
    const rec = fold(content.features);
    const back = expandWildArea({ rec });
    expect(sumStocks(back)).toEqual(wildAreaStock(rec));
    expect(back.length).toBe(content.features.length);
  });

  it("🚨 a whole CYCLE conserves, and settles (fold ∘ expand is idempotent)", () => {
    const rec = fold(content.features);
    const once = expandWildArea({ rec });
    const rec2 = fold(once);
    const twice = expandWildArea({ rec: rec2 });
    expect(sumStocks(twice)).toEqual(sumStocks(content.features));
    expect(wildAreaCounts(rec2)).toEqual(wildAreaCounts(rec));
    // The SECOND cycle changes nothing at all — positions and clocks included.
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("conserves a HARVESTED stand — the live stack, not the initial roll", () => {
    // Somebody felled two oaks and half-quarried a rock.
    const live = new Map<string, Record<string, number>>();
    for (const f of content.features) live.set(wildFeatureContainerId(f), { ...f.stock });
    const oaks = content.features.filter((f) => f.species === "oak");
    live.set(wildFeatureContainerId(oaks[0]!), { wood: 0 });
    live.set(wildFeatureContainerId(oaks[1]!), { wood: 3 });
    const rocks = content.features.filter((f) => f.species === "rock");
    live.set(wildFeatureContainerId(rocks[0]!), { stone: 1 });
    const before: Record<string, number> = {};
    for (const s of live.values()) {
      for (const [g, n] of Object.entries(s)) if (n > 0) before[g] = (before[g] ?? 0) + n;
    }
    const rec = condenseWildArea({
      features: content.features,
      liveStock: (id) => live.get(id),
      now: 100,
      area: AREA,
      seed: 11,
      key: "home",
    });
    expect(wildAreaStock(rec)).toEqual(before);
    expect(sumStocks(expandWildArea({ rec }))).toEqual(before);
  });

  it("is DETERMINISTIC — the same record deals the same stand twice", () => {
    const rec = fold(content.features);
    expect(JSON.stringify(expandWildArea({ rec }))).toBe(JSON.stringify(expandWildArea({ rec })));
  });

  it("keeps the size classes and the clocks", () => {
    const felled: WildernessFeature[] = content.features.map((f, i) =>
      f.species === "oak" && i % 3 === 0
        ? { ...f, stock: { wood: 0 }, sizeClass: 0, growAt: 500 + i }
        : f,
    );
    const rec = fold(felled, 100);
    const oak = rec.stands.find((s) => s.species === "oak")!;
    const saplings = felled.filter((f) => f.species === "oak" && f.sizeClass === 0).length;
    expect(oak.byClass[0]).toBe(saplings);
    expect(oak.climbAt.length).toBe(saplings);
    const back = expandWildArea({ rec });
    expect(back.filter((f) => f.sizeClass === 0).length).toBe(saplings);
    expect(back.filter((f) => f.growAt !== undefined).length).toBe(saplings);
    // A sapling holds no wood (yieldMul 0) — the stand's whole timber went to
    // the trees that still stand, and the total is untouched.
    for (const f of back.filter((g) => g.sizeClass === 0)) expect(f.stock.wood ?? 0).toBe(0);
    expect(sumStocks(back)).toEqual(wildAreaStock(rec));
  });

  it("keeps a bearing source's harvest cap and regrow ledger", () => {
    const bearing = content.features.filter((f) => f.harvestCap);
    expect(bearing.length).toBeGreaterThan(0);
    const picked = bearing.map((f, i) =>
      i === 0 ? { ...f, stock: { ...f.stock, apple: 0 }, regrowAt: { apple: 900 } } : f,
    );
    const rec = fold(picked, 100);
    const back = expandWildArea({ rec });
    expect(sumStocks(back)).toEqual(wildAreaStock(rec));
    const caps = back.filter((f) => f.harvestCap);
    expect(caps.length).toBe(bearing.length);
    expect(back.some((f) => f.regrowAt?.apple === 900)).toBe(true);
  });
});

describe("S4 — the harvest-direction gradient", () => {
  const content = buildWilderness({ seed: 7, side: 240, mix: [{ species: "oak", count: 24 }] });

  /** Trees standing on the +x half (the sector the harvest came from). */
  const eastCount = (features: readonly WildernessFeature[]): number =>
    features.filter((f) => f.x > AREA.x + AREA.w / 2).length;

  it("⚖️ reloads THINNER toward the harvesters", () => {
    // Everything east of centre was logged; the west stands untouched.
    const live = new Map<string, Record<string, number>>();
    for (const f of content.features) {
      live.set(wildFeatureContainerId(f), f.x > 120 ? { wood: 0 } : { ...f.stock });
    }
    const rec = condenseWildArea({
      features: content.features,
      liveStock: (id) => live.get(id),
      now: 10,
      area: AREA,
      seed: 11,
      key: "home",
    });
    expect(rec.draw.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    const back = expandWildArea({ rec });
    const flat = expandWildArea({ rec: { ...rec, draw: rec.draw.map(() => 0) } });
    // The same trees, the same wood — laid out with fewer of them on the
    // harvested side than a gradient-free deal-out puts there.
    expect(back.length).toBe(flat.length);
    expect(sumStocks(back)).toEqual(sumStocks(flat));
    expect(eastCount(back)).toBeLessThan(eastCount(flat));
  });

  it("carries a previous record's direction forward", () => {
    const prev = fold(content.features);
    prev.draw[0] = 40;
    const rec = fold(content.features, 50, prev);
    expect(rec.draw[0]).toBeGreaterThanOrEqual(40);
  });

  it("sectors a direction the way the compass does", () => {
    expect(wildDrawSectorOf(1, 0)).toBe(0);
    expect(wildDrawSectorOf(0, 1)).toBe(2);
    expect(wildDrawSectorOf(-1, 0)).toBe(4);
    expect(wildDrawSectorOf(0, -1)).toBe(6);
  });
});

describe("bridge R0 — the density law, one exported definition", () => {
  // An east-harvested record: sector 0 (+x) carries all the weight.
  const rec = {
    area: AREA,
    draw: [100, 0, 0, 0, 0, 0, 0, 0],
  };

  it("an untouched record keeps everything; a harvested edge thins to the floor", () => {
    const flat = { area: AREA, draw: new Array<number>(8).fill(0) };
    expect(wildKeepChance(flat, 10, 10)).toBe(1);
    expect(wildKeepChance(rec, 120, 120)).toBe(1); // dead centre names nothing
    // Deep in the harvested sector the keep chance drops; the far (west)
    // edge stands untouched.
    expect(wildKeepChance(rec, 230, 120)).toBeLessThan(wildKeepChance(rec, 10, 120));
    expect(wildKeepChance(rec, 10, 120)).toBe(1);
    // Floored, never a hard-edged clearing.
    expect(wildKeepChance(rec, 239, 120)).toBeGreaterThanOrEqual(0.05);
  });

  it("⚖️ the difficulty seam: hard-to-reach ground keeps its trees", () => {
    // Cost climbs toward the east edge (a slope the harvesters won't climb).
    const reach = { cost: (x: number) => Math.max(0, x - 120), ref: 120 };
    const east = { x: 220, y: 120 };
    expect(wildKeepChance(rec, east.x, east.y, reach))
      .toBeGreaterThan(wildKeepChance(rec, east.x, east.y));
    // Fully shielded at cost ≥ ref: the gradient cannot bite at all.
    expect(wildKeepChance(rec, 240, 120, reach)).toBe(1);
    // A zero-cost spot is byte-identical to the plain law.
    expect(wildKeepChance(rec, 60, 120, reach)).toBe(wildKeepChance(rec, 60, 120));
  });

  it("expand with a reach field stays deterministic and conserving", () => {
    const content = buildWilderness({ seed: 7, side: 240, mix: [{ species: "oak", count: 24 }] });
    const live = new Map<string, Record<string, number>>();
    for (const f of content.features) {
      live.set(wildFeatureContainerId(f), f.x > 120 ? { wood: 0 } : { ...f.stock });
    }
    const harvested = condenseWildArea({
      features: content.features,
      liveStock: (id) => live.get(id),
      now: 10, area: AREA, seed: 11, key: "home",
    });
    const reach = { cost: (x: number) => Math.max(0, x - 120), ref: 60 };
    const a = expandWildArea({ rec: harvested, reach });
    const b = expandWildArea({ rec: harvested, reach });
    expect(b).toEqual(a);
    expect(sumStocks(a)).toEqual(sumStocks(expandWildArea({ rec: harvested })));
  });
});

describe("persistence P0 — rest/wake (the clock shift) and the read arm", () => {
  /** A record with every stamp kind armed: quote clock, climbs, regrows. */
  const stamped = (): WildAreaRecord => {
    const content = buildWilderness({ seed: 5, side: 240, mix: [{ species: "oak", count: 8 }] });
    const rec = fold(content.features, 730);
    rec.stands[0]!.climbAt.push({ cls: 0, at: 900 });
    rec.stands[0]!.regrowAt["apple"] = [850, 1200];
    return rec;
  };

  it("⚖️ shift∘shift⁻¹ ≡ id, byte for byte; zero shift returns the SAME object", () => {
    const rec = stamped();
    expect(shiftWildAreaClock(rec, 0)).toBe(rec);
    const away = shiftWildAreaClock(rec, -730);   // rest at the fold clock
    const back = shiftWildAreaClock(away, 730);   // wake at the same clock
    expect(back).toEqual(rec);
    // Every stamp moved by exactly the shift; nothing else did.
    expect(away.at).toBe(0);
    expect(away.stands[0]!.climbAt.at(-1)!.at).toBe(170);
    expect(away.stands[0]!.regrowAt["apple"]).toEqual([120, 470]);
    expect(wildAreaStock(away)).toEqual(wildAreaStock(rec)); // conservation
    expect(wildAreaCounts(away)).toEqual(wildAreaCounts(rec));
    expect(away.draw).toEqual(rec.draw);
  });

  it("the codec's rest/wake arms ARE the shift, and compose to identity", () => {
    const rec = stamped();
    const rested = WILD_AREA_CODEC.rest!(rec, 730);
    expect(rested).toEqual(shiftWildAreaClock(rec, -730));
    // Wake on a LATER boot's clock: every deadline sits the same distance
    // ahead of the new clock as it sat ahead of the old one.
    const woken = WILD_AREA_CODEC.wake!(rested, 50);
    expect(woken.stands[0]!.climbAt.at(-1)!.at).toBe(220);
    expect(WILD_AREA_CODEC.wake!(rested, 730)).toEqual(rec);
  });

  it("the read arm accepts a JSON round-trip as a deep copy, and refuses non-shapes", () => {
    const rec = stamped();
    const wire = JSON.parse(JSON.stringify(rec)) as unknown;
    const got = readWildRecord(wire);
    expect(got).toEqual(rec);
    expect(got).not.toBe(wire); // a copy, never a reference into the wire
    got!.stands[0]!.stock["wood"] = 0;
    expect((wire as WildAreaRecord).stands[0]!.stock["wood"]).not.toBe(0);
    // Refusals: not-an-object, missing key, NaN smuggled into a stamp.
    expect(readWildRecord(null)).toBeNull();
    expect(readWildRecord({ ...rec, key: 7 })).toBeNull();
    expect(readWildRecord({ ...rec, at: Number.NaN })).toBeNull();
    expect(WILD_AREA_CODEC.read).toBe(readWildRecord); // the codec's own arm
  });
});

describe("bridge Ⓓ — the render quote", () => {
  it("quotes populations, harvest state, gradient, seed — deep-copied and serializable", () => {
    const content = buildWilderness({ seed: 9, side: 240, mix: [{ species: "oak", count: 6 }] });
    const rec = fold(content.features, 25);
    rec.draw[3] = 17;
    rec.stands[0]!.regrowAt["apple"] = [400, 900];
    const q = wildAreaQuote(rec);
    expect(q.key).toBe("home");
    expect(q.at).toBe(25);
    expect(q.seed).toBe(rec.seed);
    expect(q.area).toEqual(AREA);
    expect(q.draw[3]).toBe(17);
    expect(q.stands[0]!.byClass).toEqual(rec.stands[0]!.byClass);
    expect(q.stands[0]!.stock).toEqual(rec.stands[0]!.stock);
    expect(q.stands[0]!.nextRegrowAt["apple"]).toBe(400); // earliest deadline only
    // Deep copies: mutating the quote never reaches the record.
    q.draw[0] = 999;
    q.stands[0]!.stock["wood"] = 0;
    q.area.x = -1;
    expect(rec.draw[0]).not.toBe(999);
    expect(rec.area.x).toBe(0);
    expect(wildAreaStock(rec)["wood"] ?? 0).toBeGreaterThan(0);
    // Serializable whole: a JSON round-trip is identity.
    expect(JSON.parse(JSON.stringify(q))).toEqual(q);
  });
});

describe("S4 — an unloaded stand still grows", () => {
  it("climbs its classes on the clock and re-derives the timber", () => {
    const content = buildWilderness({ seed: 3, side: 120, mix: [{ species: "oak", count: 4 }] });
    const saplings = content.features.map((f) => ({
      ...f, stock: { wood: 0 }, sizeClass: 0, growAt: 100,
    }));
    const rec = fold(saplings, 0);
    expect(wildAreaStock(rec).wood ?? 0).toBe(0);
    const grown = advanceWildArea(rec, 250, () => 100);
    // Two periods: sapling → young → mature, and the stand is worth timber.
    expect(grown.stands[0]!.byClass).toEqual([0, 0, 4]);
    expect(grown.stands[0]!.climbAt).toEqual([]);
    expect(wildAreaStock(grown).wood).toBeGreaterThan(0);
    // Growth is production; the FOLD/EXPAND pair around it still conserves.
    expect(sumStocks(expandWildArea({ rec: grown }))).toEqual(wildAreaStock(grown));
  });

  it("does nothing before the clock, and nothing at all to a growth-less stand", () => {
    const rocks = buildWilderness({ seed: 3, side: 120, mix: [{ species: "rock", count: 3 }] });
    const rec = fold(rocks.features, 0);
    expect(advanceWildArea(rec, 1e9, () => 10)).toBe(rec); // same object: untouched
  });
});

/**
 * ⚖️ F5 (fold-round.md) — THE REGION SHED AS A TRADE ENDPOINT: *"a town draws
 * on the region exactly as it trades with a stub town, price and legs
 * included"* — with the one difference the whole design turns on.
 *
 * A CONDENSED TOWN'S SHELF IS MINTED (closed-form production nobody is
 * simulating); A SOURCE'S IS DRAWN. Every unit it sells was already standing in
 * the record and leaves it — so these are conservation pins first: what the
 * draw hands out equals what the record lost, to the unit, and the stand's
 * POPULATION follows the timber out of the wood (or the next class climb would
 * grow the sold trees straight back).
 *
 * And it is ONE-WAY, structurally: the endpoint is the source's own `wild:` scope
 * id, which `scopeReceivesGoods` reads FALSE off, carrying capacity 0 so
 * `putStock` cannot find room for a single unit.
 */
describe("F5 — the region source yields, and never receives", () => {
  const OAK = naturalSourceOf("oak")!;
  const WOOD = OAK.products.find((p) => p.method === "kill")!;
  const MATURE = OAK.growth!.classes.length - 1;
  /** One mature oak's timber, off the catalogue's own class yield — the very
   *  number `advanceWildArea` re-derives a stand's stock from. */
  const PER_TREE = growthClassYield(WOOD, OAK.growth!.classes[MATURE]!.yieldMul);

  const oak = (
    i: number, x: number, y: number, over: Partial<WildernessFeature> = {},
  ): WildernessFeature => ({
    id: `wild:oak_${i}`, species: "oak", x, y, stock: { wood: PER_TREE }, ...over,
  });

  /** Four mature oaks, two east of centre and two west. */
  const grove = (): WildernessFeature[] => [
    oak(0, 200, 120), oak(1, 190, 130), oak(2, 40, 120), oak(3, 30, 110),
  ];

  const total = (m: Readonly<Record<string, number>>): number =>
    Object.values(m).reduce((a, b) => a + b, 0);

  it("🚨 A DRAW CONSERVES — what leaves the record is exactly what the drawer is handed", () => {
    const rec = fold(grove());
    const before = wildAreaStock(rec);
    const out = drawWildArea(rec, { glyph: "wood", units: 1, from: { x: 400, y: 120 } });
    const after = wildAreaStock(out.rec);
    for (const g of new Set([
      ...Object.keys(before), ...Object.keys(after), ...Object.keys(out.taken),
    ])) {
      expect((before[g] ?? 0) - (after[g] ?? 0)).toBe(out.taken[g] ?? 0);
    }
    expect(out.taken).toEqual({ wood: PER_TREE }); // one tree, whole
    // …and the input record is UNTOUCHED: the draw is pure, exactly as
    // `advanceWildArea` is.
    expect(wildAreaStock(rec)).toEqual(before);
    expect(wildAreaPopulation(rec)).toBe(4);
    // The stand it came out of is one tree lighter, and the expand of the new
    // record still balances to the unit.
    expect(wildAreaPopulation(out.rec)).toBe(3);
    expect(sumStocks(expandWildArea({ rec: out.rec }))).toEqual(wildAreaStock(out.rec));
  });

  it("🚨 A KILL DRAW FELLS — and the sold timber does NOT grow back at the next class climb", () => {
    // Two mature oaks and two saplings still climbing: the case where the
    // record's own growth arm RE-DERIVES a stand's timber from its classes.
    const stand = [
      oak(0, 200, 120), oak(1, 190, 130),
      oak(2, 40, 120, { stock: { wood: 0 }, sizeClass: 0, growAt: 100 }),
      oak(3, 30, 110, { stock: { wood: 0 }, sizeClass: 0, growAt: 100 }),
    ];
    const rec = fold(stand, 0);
    expect(wildAreaStock(rec).wood).toBe(2 * PER_TREE);
    const out = drawWildArea(rec, { glyph: "wood", units: 1, from: { x: 400, y: 120 }, now: 10 });
    expect(out.taken).toEqual({ wood: PER_TREE });
    // The POPULATION moved with the timber — one mature oak fewer.
    expect(wildAreaCounts(out.rec).oak).toEqual([2, 0, 1]);
    // Both saplings climb to mature. Untouched, the stand would be worth four
    // trees; sold from, it is worth three. THAT is the pin: a stock debit with
    // no felling would have grown the drawn tree straight back.
    const grownUntouched = advanceWildArea(rec, 250, () => 100);
    const grownAfterDraw = advanceWildArea(out.rec, 250, () => 100);
    expect(wildAreaStock(grownUntouched).wood).toBe(4 * PER_TREE);
    expect(wildAreaStock(grownAfterDraw).wood).toBe(3 * PER_TREE);
    // …and the clock came down with the tree it belonged to: two saplings
    // climbing, never three.
    expect(wildAreaCounts(grownAfterDraw).oak).toEqual([0, 0, 3]);
  });

  it("a PICK does not fell — harvest stock comes off the bough and the tree stands", () => {
    const orchard = buildWilderness({
      seed: 9, side: 240, mix: [{ species: "apple_tree", count: 3 }],
    }).features;
    const rec = fold(orchard);
    const apples = wildAreaStock(rec).apple ?? 0;
    expect(apples).toBeGreaterThan(1);
    const out = drawWildArea(rec, { glyph: "apple", units: 2, from: { x: 400, y: 120 } });
    expect(out.taken).toEqual({ apple: 2 });
    expect(wildAreaStock(out.rec).apple).toBe(apples - 2);
    expect(wildAreaPopulation(out.rec)).toBe(3); // every tree still standing
    expect(wildAreaCounts(out.rec)).toEqual(wildAreaCounts(rec));
  });

  it("🚨 THE LAST SOURCE CARRIES THE REMAINDER — a stand with nothing standing holds nothing", () => {
    // `expandWildArea` deals no features for a population of 0, so a record
    // left listing stock under an empty stand would lose it at the next load.
    const rec = fold([oak(0, 200, 120, { stock: { wood: PER_TREE, apple: 3 } })]);
    const out = drawWildArea(rec, { glyph: "wood", units: 999, from: { x: 400, y: 120 } });
    expect(out.taken).toEqual({ wood: PER_TREE, apple: 3 });
    expect(wildAreaStock(out.rec)).toEqual({});
    expect(wildAreaPopulation(out.rec)).toBe(0);
    expect(sumStocks(expandWildArea({ rec: out.rec }))).toEqual({});
    // An honest partial: asking for more than the wood holds takes what there
    // is and says so, never inventing a unit.
    expect(total(out.taken)).toBeLessThan(999);
  });

  it("🚨 THE DIRECTION IS BOOKED — the draw's own sector, through the fold's own histogram", () => {
    const rec = fold(grove());
    const from = { x: 400, y: 120 }; // due east of the area's centre
    const centre = wildAreaCenter(rec);
    const east = wildDrawSectorOf(from.x - centre.x, from.y - centre.y);
    const out = drawWildArea(rec, { glyph: "wood", units: 1, from });
    expect(out.rec.draw[east]! - rec.draw[east]!).toBe(total(out.taken));
    expect(total(out.rec.draw) - total(rec.draw)).toBe(total(out.taken)); // and nowhere else
    // The stand re-expands THINNER on the side that bought — the same gradient
    // the fold's own inference feeds.
    const eastCount = (fs: readonly WildernessFeature[]) => fs.filter((f) => f.x > 120).length;
    const back = expandWildArea({ rec: out.rec });
    const flat = expandWildArea({ rec: { ...out.rec, draw: out.rec.draw.map(() => 0) } });
    expect(sumStocks(back)).toEqual(sumStocks(flat));
    expect(eastCount(back)).toBeLessThanOrEqual(eastCount(flat));
    // A draw nobody says where from books no direction at all (the honest
    // silence a place-less partner keeps).
    expect(drawWildArea(rec, { glyph: "wood", units: 1 }).rec.draw).toEqual(rec.draw);
  });

  it("🚨 ONE-WAY: the source endpoint cannot RECEIVE, and the units bounce back to the sender", () => {
    const rec = fold(grove());
    const source = wildSourcePartner(rec, { x: 400, y: 120 });
    // The law is read off the ID, everywhere and by everyone (scope.ts).
    expect(source.id).toBe(wildAreaId("home"));
    expect(scopeReceivesGoods(parseScopeId(source.id))).toBe(false);
    const shelf: Record<string, number> = {};
    // KEYED, not recorded: the shelf outlives the stand it was cut from.
    const ep = wildSourceEndpoint(source.key, shelf);
    expect(ep.id).toBe(source.id);
    expect(ep.capacity).toBe(0);
    expect(ep.stack).toBe(shelf); // the live shelf, never a copy
    // …and it is not merely unused: `putStock` finds no room for a unit.
    expect(putStock(ep, { wood: 3 })).toEqual({ accepted: {}, refused: { wood: 3 } });
    const yard: StockEndpoint = { id: "town:yard", kind: "yard", stack: { wood: 5 }, owner: null };
    const sale = transferStock(yard, ep, { wood: 3 });
    expect(sale.moved).toEqual({});
    expect(yard.stack).toEqual({ wood: 5 }); // nothing lost in the refusal
    expect(shelf).toEqual({});
    // The BUY leg is ordinary: a drawn shelf ships out of the same endpoint.
    const out = drawWildArea(rec, { glyph: "wood", units: 1, from: { x: 400, y: 120 } });
    for (const [g, n] of Object.entries(out.taken)) shelf[g] = (shelf[g] ?? 0) + n;
    const buy = transferStock(ep, yard, { wood: 2 });
    expect(buy.moved).toEqual({ wood: 2 });
    expect(stackUnits(yard.stack, "wood")).toBe(7);
    expect(stackUnits(shelf, "wood")).toBe(PER_TREE - 2);
  });

  it("🚨 PRICED THROUGH THE ONE LEG SEAT — the source's road, not a second formula", () => {
    const rec = fold(grove());
    const home = { x: 3000, y: 120 };
    const source = wildSourcePartner(rec, home);
    const centre = wildAreaCenter(rec);
    expect(centre).toEqual({ x: 120, y: 120 });
    expect(source.distanceM).toBeCloseTo(Math.hypot(centre.x - home.x, centre.y - home.y), 9);
    expect(source.yields).toEqual(wildAreaStock(rec)); // what it has to sell IS the record
    // The SAME seat a stub town three kilometres out is priced by — no forest
    // special case, and `transactionDayFrac`'s floor underneath both.
    const leg = barterLegSeconds(DOLLHOUSE_SCALE, source.distanceM);
    expect(leg).toBeCloseTo(
      (source.distanceM! / dailyTravelM(DOLLHOUSE_SCALE)) * DOLLHOUSE_SCALE.dayLengthS, 9,
    );
    expect(leg).toBeGreaterThan(barterLegSeconds(DOLLHOUSE_SCALE, null));
    // A source nobody measured from takes the flat leg — the same honest null a
    // place-less stub takes, and the same anchored fraction of a day.
    const placeless = wildSourcePartner(rec, null);
    expect(placeless.distanceM).toBeNull();
    expect(barterLegSeconds(DOLLHOUSE_SCALE, placeless.distanceM)).toBeCloseTo(
      FOOD_DAY_SEC * transactionDayFrac({ kind: "shipment-leg" }), 9,
    );
    expect(BARTER_LEG_DAY_FRAC).toBe(transactionDayFrac({ kind: "shipment-leg" }));
  });
});
