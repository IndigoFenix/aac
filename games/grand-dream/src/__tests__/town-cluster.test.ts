/**
 * The walking window (town-cluster.ts): several living towns stream into
 * ONE session — stages translated + merged, ids namespaced, buildings
 * union-cached across full-replacement semantics.
 */
import { describe, it, expect } from "vitest";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play";
import { clusterStages, widenSpecWindow } from "@shared/world-engine/interaction/town/town-cluster";
import { bookUnitsPerStreetUnit, creditDelivery } from "@shared/world-engine/interaction/town/town-quests";

describe("town-cluster — beyond one town", () => {
  const a = buildTownPlay({ seed: 7, days: 160, questCount: 1, key: "alpha", startPop: 80 });
  const b = buildTownPlay({ seed: 108, days: 160, questCount: 1, key: "beta", startPop: 60 });
  const primaryAt = { x: 1400, y: 1400 };
  const betaAt = { x: 2600, y: 1900 };
  const windowSpec = widenSpecWindow(a.stage.spec, a.stage.center, primaryAt, 4000, 4000);
  const cluster = clusterStages(
    windowSpec,
    { stage: a.stage, at: primaryAt, tag: "t0" },
    [{ stage: b.stage, at: betaAt, tag: "n1", houseBase: 1000 }],
  );

  it("widens the spec window and shifts the primary's content", () => {
    expect(windowSpec.manifold.width).toBe(4000);
    const spawn = windowSpec.spawns[0];
    const orig = a.stage.spec.spawns[0];
    expect(spawn.x - orig.x).toBeCloseTo(primaryAt.x - a.stage.center.x, 6);
    // Cast anchors land in window coordinates too.
    for (const [, v] of cluster.castSpawns) {
      expect(v.x).toBeGreaterThan(0);
      expect(v.x).toBeLessThan(4000);
    }
  });

  it("standing in the PRIMARY town streams its buildings at window coords, ids NATIVE", () => {
    const f = cluster.frame({ x: primaryAt.x, y: primaryAt.y }, 1, undefined, 200);
    expect(f.buildings).not.toBeNull();
    const own = f.buildings!.filter(bl => !bl.id.startsWith("n1:"));
    expect(own.length).toBeGreaterThan(0);
    // The primary keeps its NATIVE ids — its residents' dialogue protocol
    // (resident_{house}_{member}) must survive the cluster untouched.
    for (const n of f.add) expect(n.id).not.toMatch(/^t0:/);
    // Footprints sit around the primary's window position, not its town frame.
    for (const bl of own) {
      expect(Math.hypot(
        bl.footprint.x - primaryAt.x, bl.footprint.y - primaryAt.y,
      )).toBeLessThan(600);
    }
  });

  it("walking to the NEIGHBOR streams ITS town — residents PROTOCOL-VALID (talkable)", () => {
    // Arrive at beta: its stage loads around the player…
    const f = cluster.frame({ x: betaAt.x, y: betaAt.y }, 2, undefined, 200);
    expect(f.buildings).not.toBeNull();
    const theirs = f.buildings!.filter(bl => bl.id.startsWith("n1:"));
    expect(theirs.length).toBeGreaterThan(0);
    for (const bl of theirs) {
      expect(Math.hypot(
        bl.footprint.x - betaAt.x, bl.footprint.y - betaAt.y,
      )).toBeLessThan(600);
    }
    // …while the primary, 1.3 km behind, has STREAMED OUT (its own stage's
    // load/unload hysteresis — the window composes streaming, it doesn't
    // defeat it).
    expect(f.buildings!.every(bl => bl.id.startsWith("n1:"))).toBe(true);
    // Neighbor residents arrive PROTOCOL-VALID with houses remapped into the
    // reserved range — the quest host's ensureResidentCreature path gives
    // them REAL MINDS (goods-slot needs; family lookups fall back cleanly).
    const residents = f.add.filter(n => /^resident_\d+_\d+$/.test(n.id));
    expect(residents.length).toBeGreaterThan(0);
    for (const n of residents) {
      const house = Number(n.id.split("_")[1]);
      expect(house).toBeGreaterThanOrEqual(1000);
      expect(house).toBeLessThan(2000);
    }
    // And an unchanged frame reports buildings null (the cached union only
    // re-emits when SOME member replaced its set).
    const still = cluster.frame({ x: betaAt.x, y: betaAt.y }, 2.5, undefined, 200);
    expect(still.buildings).toBeNull();
  });

  it("roads from BOTH towns share the window", () => {
    const near = (p: { x: number; y: number }, at: { x: number; y: number }) =>
      Math.hypot(p.x - at.x, p.y - at.y) < 800;
    expect(cluster.roads.some(r => r.points.some(p => near(p, primaryAt)))).toBe(true);
    expect(cluster.roads.some(r => r.points.some(p => near(p, betaAt)))).toBe(true);
  });
});

describe("cluster resolver — a neighbor resident's OWN town", () => {
  // DIFFERENT book states: the same economy lived for different spans.
  const a = buildTownPlay({ seed: 11, days: 120, questCount: 1, key: "prime", startPop: 80 });
  const b = buildTownPlay({ seed: 12, days: 300, questCount: 1, key: "hamlet", startPop: 60 });
  const primaryAt = { x: 1400, y: 1400 };
  const at = { x: 2500, y: 2000 };
  const windowSpec = widenSpecWindow(a.stage.spec, a.stage.center, primaryAt, 4000, 4000);
  const cluster = clusterStages(
    windowSpec,
    { stage: a.stage, at: primaryAt, tag: "t0" },
    [{ stage: b.stage, at, tag: "n1", houseBase: 1000, play: b }],
  );

  it("resolves a reserved-range house to the NEIGHBOR's books + geometry", () => {
    const h = b.plan.houses[1]!.index;
    const ctx = cluster.cluster!.resolveHouse(1000 + h);
    expect(ctx).not.toBeNull();
    // The neighbor's OWN goods — fill() reads ITS ledgers, not the primary's.
    expect(ctx!.goods.map(g => g.fill())).toEqual(b.stage.goods.map(g => g.fill()));
    expect(ctx!.plan).toBe(b.plan);
    expect(ctx!.town).toBe(b.town);
    expect(ctx!.eco).toBe(b.eco);
    expect(ctx!.localHouse).toBe(h);
    expect(ctx!.offset).toEqual({ x: at.x - b.stage.center.x, y: at.y - b.stage.center.y });
    expect(ctx!.center).toEqual(at);
  });

  it("primary houses (<1000) and unclaimed ranges resolve to null", () => {
    expect(cluster.cluster!.resolveHouse(0)).toBeNull();
    expect(cluster.cluster!.resolveHouse(4)).toBeNull();
    expect(cluster.cluster!.resolveHouse(2004)).toBeNull(); // nobody owns the 2000s
  });

  it("a member WITHOUT live context stays bodies-only (resolves null)", () => {
    const bare = clusterStages(
      windowSpec,
      { stage: a.stage, at: primaryAt, tag: "t0" },
      [{ stage: b.stage, at, tag: "n1", houseBase: 1000 }],
    );
    expect(bare.cluster!.resolveHouse(1004)).toBeNull();
  });

  it("crediting a delivery through the resolved context lands in the NEIGHBOR's books", () => {
    const ctx = cluster.cluster!.resolveHouse(1000)!;
    const drift = ctx.eco.flownets.find(f => f.source === "food_out")?.drift;
    expect(drift).toBeTruthy();
    ctx.town.inject(drift!, -2); // headroom below the stockpile cap
    const before = b.town.scalar(drift!);
    const beforePrimary = a.town.scalar(drift!);
    expect(creditDelivery(ctx.town, ctx.eco, "food")).toBe(drift);
    // ONE STREET UNIT credits one street unit's WORTH OF BOOKS, not one book
    // unit. The `+ 1` this pin used to carry predates the batch-3 B1 grounding
    // (economy-arc-opening.md §BATCH 3 B1): food's book rate is the caloric
    // anchor `FOOD_PER_PERSON_DAILY` = 0.001, so a delivery moves the ledger by
    // 0.001, and `creditDelivery` has been doing exactly that ever since.
    // Reading the rate from the same function the code uses keeps this pin
    // about the ROUTING (whose books were touched) — which is what the test is
    // named for — instead of re-freezing a magnitude that lives elsewhere.
    const perUnit = bookUnitsPerStreetUnit(ctx.eco, "food");
    expect(perUnit).toBeCloseTo(0.001, 9);
    expect(b.town.scalar(drift!)).toBeCloseTo(before + perUnit, 6);
    expect(a.town.scalar(drift!)).toBeCloseTo(beforePrimary, 6); // primary untouched
  });
});
