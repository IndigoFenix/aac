// FOUNDING (city-expansion step 0): the FoundedSite record a wilderness
// "build" creates — material stock deposits, the EMPTINESS contract that
// gates abandonment cleanup, the abandonment spill, and the town-play seam
// (siteTownConfig → buildTownPlay) that plugs a site into the existing
// town/construction abstraction. Pure logic — no DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  abandonSite,
  createFoundedSite,
  depositSiteStock,
  foundSite,
  foundedSiteToJSON,
  isSiteMaterial,
  noteSiteBuilding,
  noteSiteResident,
  siteAbandonRadius,
  siteIsEmpty,
  siteTownConfig,
  SITE_ABANDON_RADIUS_M,
} from "@shared/world-engine/interaction/town/founding.js";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";

describe("foundSite", () => {
  it("founds an empty site (no buildings, no residents, no stock, fresh overlay)", () => {
    const site = foundSite({ seed: 42, at: { x: 10, y: 20 }, day: 3 });
    expect(site.buildings).toBe(0);
    expect(site.residents).toEqual([]);
    expect(site.stock).toEqual({});
    expect(site.foundedDay).toBe(3);
    expect(site.at).toEqual({ x: 10, y: 20 });
    expect(site.deltas.keys()).toEqual([]);
    expect(siteIsEmpty(site)).toBe(true);
  });

  it("derives a deterministic key from the seed (and honors an explicit one)", () => {
    expect(foundSite({ seed: 42, at: { x: 0, y: 0 } }).key).toBe(
      foundSite({ seed: 42, at: { x: 5, y: 5 } }).key,
    );
    expect(foundSite({ seed: 43, at: { x: 0, y: 0 } }).key).not.toBe(
      foundSite({ seed: 42, at: { x: 0, y: 0 } }).key,
    );
    expect(foundSite({ seed: 1, at: { x: 0, y: 0 }, key: "riverbend" }).key).toBe("riverbend");
  });
});

describe("the durable form — foundedSiteToJSON / createFoundedSite (persistence P0)", () => {
  const mutated = () => {
    const site = foundSite({ seed: 7, at: { x: 4, y: 9 }, day: 12 });
    depositSiteStock(site, { wood: 8 });
    noteSiteBuilding(site);
    noteSiteResident(site, "creature:elm");
    site.herd = { goat: { n: 3, stock: { milk: 2 } } };
    return site;
  };

  it("round-trips through JSON, restore-is-found, and the ledgers ride their own restores", () => {
    const site = mutated();
    const json = foundedSiteToJSON(site);
    // The durable form is genuinely plain: a JSON round-trip is identity.
    const wire = JSON.parse(JSON.stringify(json)) as typeof json;
    expect(wire).toEqual(json);
    const back = createFoundedSite(wire);
    expect(back.key).toBe(site.key);
    expect(back.seed).toBe(site.seed);
    expect(back.at).toEqual(site.at);
    expect(back.foundedDay).toBe(12);
    expect(back.stock).toEqual({ wood: 8 });
    expect(back.buildings).toBe(1);
    expect(back.residents).toEqual(["creature:elm"]);
    expect(back.herd).toEqual(site.herd);
    // The overlay restored through its own pair: serializing again agrees.
    expect(back.deltas.toJSON()).toEqual(site.deltas.toJSON());
  });

  it("aliases nothing, in either direction", () => {
    const site = mutated();
    const json = foundedSiteToJSON(site);
    // Mutating the live site after the copy never reaches the payload…
    depositSiteStock(site, { wood: 100 });
    site.residents.push("creature:oak");
    expect(json.stock).toEqual({ wood: 8 });
    expect(json.residents).toEqual(["creature:elm"]);
    // …and a restored site never aliases the caller's JSON.
    const back = createFoundedSite(json);
    back.stock["stone"] = 5;
    back.residents.push("creature:fir");
    back.herd!["goat"]!.stock["milk"] = 99;
    expect(json.stock["stone"]).toBeUndefined();
    expect(json.residents).toEqual(["creature:elm"]);
    expect(json.herd!["goat"]!.stock["milk"]).toBe(2);
  });
});

describe("depositSiteStock", () => {
  it("moves ONLY building materials out of the source stacks", () => {
    const site = foundSite({ seed: 1, at: { x: 0, y: 0 } });
    const pocket: Record<string, number> = { wood: 3, stone: 2, apple: 4, teddy: 1 };
    const moved = depositSiteStock(site, pocket);
    expect(moved).toEqual({ wood: 3, stone: 2 });
    expect(site.stock).toEqual({ wood: 3, stone: 2 });
    // The source keeps its non-materials; the materials are GONE (moved, not copied).
    expect(pocket).toEqual({ apple: 4, teddy: 1 });
  });

  it("accumulates across deposits and accepts facted material variants", () => {
    const site = foundSite({ seed: 1, at: { x: 0, y: 0 } });
    depositSiteStock(site, { wood: 2 });
    depositSiteStock(site, { wood: 1, "wood.wet": 2 });
    expect(site.stock.wood).toBe(3);
    expect(site.stock["wood.wet"]).toBe(2);
    expect(isSiteMaterial("wood.wet")).toBe(true);
    expect(isSiteMaterial("apple")).toBe(false);
  });

  it("does NOT make the site non-empty (materials never block abandonment)", () => {
    const site = foundSite({ seed: 1, at: { x: 0, y: 0 } });
    depositSiteStock(site, { wood: 5, stone: 5 });
    expect(siteIsEmpty(site)).toBe(true);
  });
});

describe("siteIsEmpty (the abandonment contract)", () => {
  it("a building makes the site non-empty", () => {
    const site = foundSite({ seed: 1, at: { x: 0, y: 0 } });
    noteSiteBuilding(site);
    expect(siteIsEmpty(site)).toBe(false);
  });

  it("a resident makes the site non-empty (idempotent add)", () => {
    const site = foundSite({ seed: 1, at: { x: 0, y: 0 } });
    noteSiteResident(site, "wild_0");
    noteSiteResident(site, "wild_0");
    expect(site.residents).toEqual(["wild_0"]);
    expect(siteIsEmpty(site)).toBe(false);
  });

  it("kept construction (a non-empty delta) makes the site non-empty; an untouched overlay does not", () => {
    const site = foundSite({ seed: 1, at: { x: 0, y: 0 } });
    // A no-op mutate leaves the building delta EMPTY — still an empty site.
    site.deltas.mutate("house:0", () => {});
    expect(siteIsEmpty(site)).toBe(true);
    // Real kept construction (a placed piece) — non-empty.
    site.deltas.mutate("house:0", (d) => {
      d.placed.push({
        id: "p1", kind: "chair", x: 1, y: 1, radius: 0.4, facing: 0, openable: false, roomId: "r0",
      });
    });
    expect(siteIsEmpty(site)).toBe(false);
  });
});

describe("abandonSite", () => {
  it("returns the stock as the spill and empties the site", () => {
    const site = foundSite({ seed: 1, at: { x: 0, y: 0 } });
    depositSiteStock(site, { wood: 4, stone: 1 });
    const spill = abandonSite(site);
    expect(spill).toEqual({ wood: 4, stone: 1 });
    expect(site.stock).toEqual({});
  });
});

describe("siteAbandonRadius", () => {
  it("caps at the constant and clamps down for small worlds", () => {
    expect(siteAbandonRadius(10_000)).toBe(SITE_ABANDON_RADIUS_M);
    expect(siteAbandonRadius(240)).toBe(108); // 240 · 0.45 < 120
    expect(siteAbandonRadius(10)).toBe(24); // floor
  });
});

describe("siteTownConfig (the town-play seam)", () => {
  it("hands the site to buildTownPlay unchanged — key, seed, and the construction overlay ride along", () => {
    const site = foundSite({ seed: 77, at: { x: 3, y: 4 }, key: "outpost" });
    site.deltas.mutate("house:0", (d) => {
      d.placed.push({
        id: "p1", kind: "chair", x: 1, y: 1, radius: 0.4, facing: 0, openable: false, roomId: "r0",
      });
    });
    const config = siteTownConfig(site);
    expect(config.key).toBe("outpost");
    expect(config.seed).toBe(77);
    expect(config.startPop).toBe(0);
    expect(config.deltas).toEqual(site.deltas.toJSON());
    // The EXISTING founding path accepts it whole: the town builds and the
    // restored overlay carries the site's construction (deltas round-trip).
    const play = buildTownPlay(config);
    expect(play.config.key).toBe("outpost");
    expect(play.deltas.get("house:0")?.placed[0]?.id).toBe("p1");
  });

  it("is deterministic: same site ⇒ identical config", () => {
    const a = siteTownConfig(foundSite({ seed: 9, at: { x: 1, y: 2 } }));
    const b = siteTownConfig(foundSite({ seed: 9, at: { x: 1, y: 2 } }));
    expect(a).toEqual(b);
  });
});
