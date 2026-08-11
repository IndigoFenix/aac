// HOMESTEAD LANES, CLUSTERING, AND THE CIVIC RECORD
// (planning-docs/games/world-engine/growth-phase-c-founding-loops.md §1
// stage 3, items 3.2 and 3.3; growth-unification.md §3 "seeds, not centers"
// and §4 "FOUNDING IS SETTLING").
//
// Three things are pinned here:
//   • a founded site records the ACCESS LANE it was reached by, and that lane
//     is the `spine` seed kind's first production feeder — the town it grows
//     into lays its baseline along the track its settler actually walked;
//   • N homesteads inside one camp's reach become ONE town by RE-PARENTING,
//     conserving every plank and carrying every construction record; and
//   • 🔴 a town's founded service points are HISTORY, not a re-derivation —
//     the durable fix for the founding prefix-stability that phase C's loops
//     weakened (see the `ServicePoint` doc in construction.ts).
//
// Pure logic — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  foundSite, siteLanes, siteObstacles, siteTownConfig,
  clusterSites, clusterRadiusM, mergeSites, foundingOrder, CLUSTER_MIN_SITES,
  type FoundedSite,
} from "@shared/world-engine/interaction/town/founding.js";
import {
  createTownDeltas, groundObstacles, type FoundingCandidate,
} from "@shared/world-engine/kernel/town/construction.js";
import { growStreets, type GrowSeed } from "@shared/world-engine/kernel/town/streets.js";
import { compileEconomy, type EconomyDoc } from "@shared/world-engine/kernel/modules/economy/index.js";
import { createTownWorld } from "@shared/world-engine/kernel/town/town-world.js";
import { townPlan } from "@shared/world-engine/kernel/town/plan.js";
import { DOLLHOUSE_SCALE, REAL_SCALE, forageRadiusM } from "@shared/world-engine/scale.js";

// ───────────────────────────────────────────── 3.2 the access lane

const at = (x: number, y: number): { x: number; y: number } => ({ x, y });

describe("a founded site records the lane it was reached by", () => {
  it("door → the nearest network point, town-local, as a SPINE seed", () => {
    const site = foundSite({
      seed: 3, at: at(100, 40), door: at(104, 40), network: [at(60, 40), at(300, 300)],
    });
    const lanes = siteLanes(site);
    expect(lanes).toHaveLength(1);
    // Town-local: the site IS its town's origin.
    expect(lanes[0]).toEqual([{ x: 4, y: 0 }, { x: -40, y: 0 }]);
    const seeds = site.deltas.seeds();
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.kind).toBe("spine");
  });

  it("a lone founder in trackless wilderness records nothing", () => {
    const site = foundSite({ seed: 3, at: at(0, 0) });
    expect(site.deltas.seeds()).toHaveLength(0);
    expect(siteLanes(site)).toHaveLength(0);
  });

  it("a door ALREADY on the network is not a lane", () => {
    const site = foundSite({ seed: 3, at: at(0, 0), door: at(1, 0), network: [at(3, 4)] });
    expect(site.deltas.seeds()).toHaveLength(0); // 5 m < one growth step
  });

  it("the lane rides the SHIPPED pipe: deltas → siteTownConfig → growStreets", () => {
    const site = foundSite({
      seed: 9, at: at(0, 0), door: at(0, 0), network: [at(0, -90)],
    });
    const cfg = siteTownConfig(site);
    // `deltas.toJSON()` carries the seed the way a save does.
    expect(cfg.deltas?.seeds).toHaveLength(1);
    const seeds = (cfg.deltas!.seeds ?? [])
      .slice().sort((a, b) => a.ord - b.ord)
      .map(({ ord: _o, ...s }) => s as GrowSeed);
    const net = growStreets(site.seed, site.key, 40, { seeds });
    // THE SPINE IS THE BASELINE: street 0 runs along the lane, not along an
    // invented bearing (the `spine` kind's first real producer).
    const base = net.streets[0]!;
    expect(base.baseline).toBe(true);
    const span = Math.hypot(
      base.pts[base.pts.length - 1]!.x - base.pts[0]!.x,
      base.pts[base.pts.length - 1]!.y - base.pts[0]!.y,
    );
    expect(span).toBeCloseTo(90, 6);
    expect(Math.abs(base.pts[0]!.x)).toBeLessThan(1e-9);
    // And the echo is honest: a spine town declares no bare bearings.
    expect(net.seeds.map(s => s.kind)).toEqual(["spine"]);
  });

  it("is deterministic in its options", () => {
    const a = foundSite({ seed: 3, at: at(10, 10), door: at(14, 10), network: [at(-30, 10)] });
    const b = foundSite({ seed: 3, at: at(10, 10), door: at(14, 10), network: [at(-30, 10)] });
    expect(JSON.stringify(a.deltas.toJSON())).toBe(JSON.stringify(b.deltas.toJSON()));
  });
});

// ───────────────────────────────────────────── 3.3 clustering

const mkSite = (
  key: string, x: number, y: number, day: number, opts?: { network?: Array<{ x: number; y: number }> },
): FoundedSite => foundSite({
  seed: key.charCodeAt(0), key, at: at(x, y), day,
  ...(opts?.network ? { network: opts.network } : {}),
});

/** A standing homestead: one completed founded building on the site's own
 *  ground, plus a plank in its yard. */
function raise(site: FoundedSite, type = "house"): FoundedSite {
  const c: FoundingCandidate = {
    type, slot: 0, dx: -6, dy: -5, w: 12, h: 10, door: "south",
  };
  const b = site.deltas.foundBuilding(c, 0, 1);
  site.deltas.completeFounding(b.ord);
  site.buildings += 1;
  site.stock.wood = (site.stock.wood ?? 0) + 7;
  site.deltas.stock.stone = (site.deltas.stock.stone ?? 0) + 3;
  return site;
}

describe("clusterRadiusM — the shared reach a cluster is measured at", () => {
  it("IS forageRadiusM: two homesteads inside one camp's reach work the same land", () => {
    expect(clusterRadiusM(REAL_SCALE)).toBe(forageRadiusM(REAL_SCALE));
    // The street clock's day is short, so its camp reach is a village's:
    expect(clusterRadiusM(DOLLHOUSE_SCALE)).toBeCloseTo(forageRadiusM(DOLLHOUSE_SCALE), 9);
    expect(clusterRadiusM(DOLLHOUSE_SCALE)).toBeGreaterThan(100);
    expect(clusterRadiusM(DOLLHOUSE_SCALE)).toBeLessThan(400);
  });

  it("clamps to a small manifold, the siteAbandonRadius way", () => {
    expect(clusterRadiusM(REAL_SCALE, 200)).toBe(90);
    expect(clusterRadiusM(REAL_SCALE, 1)).toBe(24);
  });
});

describe("clusterSites — who is a village", () => {
  const sites = [
    mkSite("c", 0, 0, 3), mkSite("a", 60, 0, 1), mkSite("b", 120, 0, 2),
    mkSite("far", 900, 0, 4), mkSite("far2", 940, 0, 5),
  ];

  it("groups transitively — a chain of homesteads a reach apart is one street", () => {
    const groups = clusterSites(sites, 70);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map(s => s.key)).toEqual(["a", "b", "c"]); // founding order
  });

  it("a pair is not a town below the bar", () => {
    expect(CLUSTER_MIN_SITES).toBe(3);
    expect(clusterSites(sites.slice(3), 70)).toHaveLength(0);
    expect(clusterSites(sites.slice(3), 70, 2)).toHaveLength(1);
  });

  it("is deterministic however the host stored them", () => {
    const shuffled = [sites[4]!, sites[0]!, sites[3]!, sites[2]!, sites[1]!];
    expect(JSON.stringify(clusterSites(shuffled, 70).map(g => g.map(s => s.key))))
      .toBe(JSON.stringify(clusterSites(sites, 70).map(g => g.map(s => s.key))));
  });

  it("founding order is (day, key) — total and stable", () => {
    expect([...sites].sort(foundingOrder).map(s => s.key)).toEqual(["a", "b", "c", "far", "far2"]);
  });
});

describe("mergeSites — a town founded OVER the homesteads", () => {
  // Three farmsteads a short walk apart — well inside the street clock's
  // camp reach (~148 m), and far enough apart that the land between them is
  // real open ground rather than one shared yard.
  const build = (): FoundedSite[] => [
    raise(mkSite("a", 0, 0, 1)),
    raise(mkSite("b", 140, 0, 2, { network: [at(0, 0)] })),
    raise(mkSite("c", 70, 120, 3)), // no lane recorded: a lone founder
  ];

  it("keeps the ELDEST's identity — a re-parenting, not a new address", () => {
    const m = mergeSites(build());
    expect(m.key).toBe("a");
    expect(m.seed).toBe("a".charCodeAt(0));
    expect(m.at).toEqual({ x: 0, y: 0 });
    expect(m.foundedDay).toBe(1);
  });

  it("ITEM CONSERVATION: every plank that was at a homestead is at the town", () => {
    const sites = build();
    const before: Record<string, number> = {};
    for (const s of sites) {
      for (const [g, n] of Object.entries(s.stock)) before[g] = (before[g] ?? 0) + n;
      for (const [g, n] of Object.entries(s.deltas.stock)) before[g] = (before[g] ?? 0) + n;
    }
    const m = mergeSites(sites);
    const after: Record<string, number> = { ...m.deltas.stock };
    for (const [g, n] of Object.entries(m.stock)) after[g] = (after[g] ?? 0) + n;
    expect(after).toEqual(before);
    expect(before.wood).toBe(21);
    expect(before.stone).toBe(9);
  });

  it("standing buildings are ANNEXED: translated, on GROUND, records intact", () => {
    const m = mergeSites(build());
    const rows = m.deltas.founded();
    expect(rows).toHaveLength(3);
    expect(m.buildings).toBe(3);
    // The eldest keeps its ordinal AND its lot; the absorbed stand on ground.
    expect(rows[0]!.ord).toBe(0);
    expect(rows[0]!.slot).toBe(0);
    expect(rows.slice(1).every(r => r.slot === -1)).toBe(true);
    // Ordinals are renumbered past the head's high-water mark, never reused.
    expect(new Set(rows.map(r => r.ord)).size).toBe(3);
    expect(Math.min(...rows.slice(1).map(r => r.ord))).toBeGreaterThan(0);
    // Translated into the town frame: b's house sits 140 m east.
    const bRow = rows.find(r => Math.abs(r.dx - 134) < 1e-9);
    expect(bRow).toBeTruthy();
    // The construction record travels (registerFoundedPlanetSite's law).
    expect(rows.every(r => r.completed)).toBe(true);
  });

  it("LANES become the spine, and a laneless homestead gets its connector", () => {
    const m = mergeSites(build());
    const spines = m.deltas.seeds().filter(s => s.kind === "spine");
    // b recorded `door → a`; c recorded nothing and is joined to the nearest
    // ground already on the spine, so the seed set is CONNECTED.
    expect(spines).toHaveLength(2);
    const lanes = siteLanes(m);
    expect(lanes).toHaveLength(2);
    for (const lane of lanes) {
      expect(lane).toHaveLength(2);
      const len = Math.hypot(lane[1]!.x - lane[0]!.x, lane[1]!.y - lane[0]!.y);
      expect(len).toBeGreaterThan(12);
    }
  });

  it("a cluster of one is the identity", () => {
    const one = build()[0]!;
    expect(mergeSites([one])).toBe(one);
  });

  it("is deterministic, and independent of the order the host held them", () => {
    const a = mergeSites(build());
    const rev = build().reverse();
    const b = mergeSites(rev);
    expect(JSON.stringify(b.deltas.toJSON())).toBe(JSON.stringify(a.deltas.toJSON()));
  });

  it("annexed ground becomes OBSTACLES the street tree bends around", () => {
    const m = mergeSites(build());
    const rects = siteObstacles(m);
    expect(rects).toHaveLength(2); // the two annexed; the head keeps its lot
    expect(groundObstacles(m.deltas)).toEqual(rects);

    const seeds = m.deltas.seeds().slice().sort((x, y) => x.ord - y.ord)
      .map(({ ord: _o, ...s }) => s as GrowSeed);
    const net = growStreets(m.seed, m.key, 120, { seeds, obstacles: rects });
    let inside = 0;
    for (const st of net.streets) {
      for (const p of st.pts) {
        for (const r of rects) {
          if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) inside++;
        }
      }
    }
    expect(inside).toBe(0);
    // …and the tree still grew a real town around them (obstacles bend the
    // lanes, they do not strangle the town).
    expect(net.slots.length).toBeGreaterThan(100);
    const free = growStreets(m.seed, m.key, 120, { seeds });
    expect(net.slots.length).toBeGreaterThan(free.slots.length * 0.8);
  });

  it("⚖️ two farmsteads CLOSER than a street gap are one yard, not a lane", () => {
    // MEASURED while building this: at 60 m apart with 12×10 houses, the
    // clear ground between them is narrower than `streetMinGap` + two
    // `lotClear`s, and a seed laid there strangles the tree (123 slots → 1).
    // `trimLane` refuses those, which is the honest answer — the town grows
    // from the seeds that ARE open ground, and the tight pair reads as one
    // homestead with an outbuilding.
    const tight = [
      raise(mkSite("a", 0, 0, 1)),
      raise(mkSite("b", 22, 0, 2, { network: [at(0, 0)] })),
      raise(mkSite("c", 200, 0, 3, { network: [at(0, 0)] })),
    ];
    const m = mergeSites(tight);
    const lanes = siteLanes(m);
    expect(lanes).toHaveLength(1); // only a→c survives the trim
    expect(Math.hypot(lanes[0]![1]!.x - lanes[0]![0]!.x, lanes[0]![1]!.y - lanes[0]![0]!.y))
      .toBeGreaterThan(100);
  });
});

// ───────────── 🔴 3.2's other half: the civic set is HISTORY

const DOC: EconomyDoc = {
  stockpiles: [{ key: "granary", max: 400, construction: true }],
  commodities: [
    {
      key: "food", scalarMax: 200, perPersonDaily: 0.001,
      transport: { drift: "granary", driftRequiresConstruction: true },
      street: {
        capDays: 3, shopSec: 18, cartRations: 25, unit: "rations", producers: ["farm"], market: true,
        stockColor: "#e0b25c", boxLabel: "Pantry", errandName: "shopping",
      },
    },
  ],
  buildings: [
    {
      key: "farm", countScalar: "farms", cap: { by: "farmland", rate: 1 / 60 },
      processes: [
        { id: "farm", input: "farmland", output: "grain_out", efficiency: 0.08, capacityRate: 5 },
        { id: "mill", input: "grain_out", output: "food_out", efficiency: 1 },
      ],
      vars: [{ name: "grain_out", max: 200 }],
      construction: { tier: "base", costs: [{ stockpile: "granary", amount: 20 }] },
      sells: ["food"], leansToward: "fertility", mapCap: 8, district: "farm",
      style: { color: "#7d9c53", w: 18, h: 12 }, vignette: { w: 5, h: 4 },
      glyph: "🌾", title: "🌾 Farmstead", info: ["{farms} farms."],
    },
  ],
};
const ECO = compileEconomy([DOC], { construction: true });

const townAt = (pop: number) => {
  const town = createTownWorld({
    economy: ECO, charter: { farmland: 420, ore_access: 0 },
    startPop: pop, seedScalars: { farms: 1 }, key: "haywick",
  });
  town.step(250);
  return town;
};

describe("🔴 founded service points are HISTORY, not a re-derivation", () => {
  const key = (s: { kind: string; slot: number }): string => `${s.kind}:${s.slot}`;

  it("a regrown town keeps its founded service points POSITIONALLY", () => {
    const small = townPlan(townAt(90), ECO, "haywick", 12, 0, undefined, [], undefined, undefined, DOLLHOUSE_SCALE);
    const history = small.services ?? [];
    expect(history.length).toBeGreaterThan(2);

    const grown = townAt(320);
    const rederived = townPlan(grown, ECO, "haywick", 12, 0, undefined, [], undefined, undefined, DOLLHOUSE_SCALE);
    const remembered = townPlan(
      grown, ECO, "haywick", 12, 0, undefined, [], undefined, undefined, DOLLHOUSE_SCALE, history,
    );

    const kept = (plan: typeof rederived): number => {
      const have = new Set((plan.services ?? []).map(key));
      return history.filter(h => have.has(key(h))).length;
    };
    // THE PIN: with the record, every point the small town founded is still
    // there, on its own slot. (Without it, survival is only what the argmin
    // happens to reproduce — measured and reported in the ledger.)
    expect(kept(remembered)).toBe(history.length);
    expect(kept(remembered)).toBeGreaterThanOrEqual(kept(rederived));
    // The set only ever GROWS: history first, then what it still leaves
    // unserved.
    expect((remembered.services ?? []).length).toBeGreaterThanOrEqual(history.length);
    expect((remembered.services ?? []).slice(0, history.filter(h => h.kind === "stall").length)
      .every(s => s.kind === "stall")).toBe(true);
  });

  it("honouring history is self-limiting — it never founds the same point twice", () => {
    for (const pop of [90, 200, 400]) {
      const town = townAt(pop);
      const first = townPlan(town, ECO, "haywick", 12, 0, undefined, [], undefined, undefined, DOLLHOUSE_SCALE);
      const again = townPlan(
        town, ECO, "haywick", 12, 0, undefined, [], undefined, undefined, DOLLHOUSE_SCALE,
        first.services ?? [],
      );
      const ids = (again.services ?? []).map(key);
      // No point is founded twice…
      expect(new Set(ids).size).toBe(ids.length);
      // …and every recorded one is still standing, on its own slot.
      const have = new Set(ids);
      expect((first.services ?? []).every(s => have.has(key(s)))).toBe(true);
      expect(ids.length).toBeGreaterThanOrEqual((first.services ?? []).length);
    }
  }, 60_000);

  it("⚖️ and re-feeding is NOT the identity, which is the honest shape", () => {
    // Worth pinning because it looks like a bug. The pass is INCREMENTAL: a
    // household is priced against the sources standing when its turn comes,
    // so a run that starts with every recorded point already a source has
    // strictly better information than the run that founded them one by one.
    // The RECORD is exact (above); the tail it still appends is a fresh
    // answer to a town that is genuinely better served than it was.
    const town = townAt(400);
    const first = townPlan(town, ECO, "haywick", 12, 0, undefined, [], undefined, undefined, DOLLHOUSE_SCALE);
    const again = townPlan(
      town, ECO, "haywick", 12, 0, undefined, [], undefined, undefined, DOLLHOUSE_SCALE,
      first.services ?? [],
    );
    expect((again.services ?? []).length).not.toBe((first.services ?? []).length);
  }, 60_000);

  it("an empty record is byte-identical to the legacy re-derivation", () => {
    const town = townAt(200);
    const a = townPlan(town, ECO, "haywick", 12, 0, undefined, [], undefined, undefined, DOLLHOUSE_SCALE);
    const b = townPlan(town, ECO, "haywick", 12, 0, undefined, [], undefined, undefined, DOLLHOUSE_SCALE, []);
    expect(JSON.stringify(b.houses)).toBe(JSON.stringify(a.houses));
    expect(JSON.stringify(b.works)).toBe(JSON.stringify(a.works));
    expect(JSON.stringify(b.wells)).toBe(JSON.stringify(a.wells));
  });

  it("the overlay round-trips the record", () => {
    const d = createTownDeltas();
    d.addService({ kind: "stall", slot: 12 });
    d.addService({ kind: "well", slot: 40 });
    const back = createTownDeltas(d.toJSON());
    expect(back.services()).toEqual([
      { ord: 0, kind: "stall", slot: 12 },
      { ord: 1, kind: "well", slot: 40 },
    ]);
    // APPEND-ONLY: ordinals are monotone and never reused.
    expect(back.addService({ kind: "well", slot: 7 }).ord).toBe(2);
  });
});
