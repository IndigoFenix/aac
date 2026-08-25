// BAND-SETTLEMENT ROUND (band-settlement-round.md) — the deterministic half.
//
// ⚖️ B-① ONE COLLECTIVE: a band is a herd of people; the codec is written
// once, species-generic, and `band:<cell>` is a scope kind like any other.
// ⚖️ B-② FORMATION IS CONDENSE, DISPERSAL IS EXPAND: gather/disperse are the
// codec halves, joining the wild-area exact-conservation family — stock
// conserved, counts conserved beside it, second cycle a fixed point.
// ⚖️ B-③ NOTHING EVAPORATES AT A SETTLE: `settleBand` carries the store out,
// and `settledTownStack` is the F-③ units bridge (rations → trade-rung
// units; the staple's valueDensity ≡ 1 makes it the IDENTITY — pinned here
// for the first time, because a settling band is the first place a banked
// ration count crosses onto a stack).
//
// The LIVE arm (a real foundTri arc: band banks, settles, the city record
// holds the store) is band-settlement-live.test.ts — a separate file so the
// fake composition boot it needs stays out of these pure pins.

import { describe, it, expect } from "@jest/globals";
import {
  createGrid, totalField, type SystemSpec,
} from "@shared/world-engine/kernel/cells/index.js";
import {
  gatherBand, settleBand, settledTownStack, bandScopeIdOf, bandCounts,
  BAND_CODEC, type Band, type BandFoldCtx, type BandRecord, type WildSpecies,
} from "@shared/world-engine/kernel/civ/bands.js";
import {
  condense, expand, isFoldRefusal, type FoldRecord,
} from "@shared/world-engine/kernel/town/fold.js";
import {
  BAND_PREFIX, bandScopeId, parseScopeId, scopeIdOf, scopeReceivesGoods, scopeParentOf,
} from "@shared/world-engine/kernel/town/scope.js";
import { condenseTown } from "@shared/world-engine/kernel/town/barter.js";

const COLS = 16;
const ROWS = 12;
const at = (x: number, y: number): number => y * COLS + x;

const twoWilds: SystemSpec = {
  id: "band-settle-test",
  name: "Band settle test",
  vars: [
    { name: "forage", min: 0, max: 31, initial: 0, init: "flat", int: true },
    { name: "gob", min: 0, max: 31, initial: 0, init: "flat", int: true },
  ],
  rules: [],
};

const HUMANS: WildSpecies[] = [{ key: "human", field: "forage" }];
const BOTH: WildSpecies[] = [{ key: "human", field: "forage" }, { key: "gob", field: "gob" }];
const site = (x: number, y: number) => ({ x, y, cell: at(x, y), density: 0, score: 0 });

const seedBox = (grid: ReturnType<typeof createGrid>): void => {
  for (let y = 5; y <= 7; y++) for (let x = 5; x <= 7; x++) {
    grid.fields.forage[at(x, y)] = 3;
    grid.fields.gob[at(x, y)] = 2;
  }
};

const fieldSnapshot = (grid: ReturnType<typeof createGrid>): number[][] =>
  [Array.from(grid.fields.forage), Array.from(grid.fields.gob)];

const ctxOf = (grid: ReturnType<typeof createGrid>, wilds: WildSpecies[], extra: Partial<BandFoldCtx> = {}): BandFoldCtx =>
  ({ now: 0, grid, wilds, radius: 2, ...extra });

describe("the grammar — band:<key> is a scope kind (B-①)", () => {
  it("parses, prints, and round-trips", () => {
    const ref = parseScopeId("band:102");
    expect(ref).toEqual({ kind: "band", key: "102" });
    expect(scopeIdOf(ref)).toBe("band:102");
    expect(bandScopeId("102")).toBe(`${BAND_PREFIX}102`);
  });

  it("a band RECEIVES goods (it banks a store — Gate A's whole subject)", () => {
    expect(scopeReceivesGoods(parseScopeId("band:7"))).toBe(true);
  });

  it("hangs off the region — the same honest null a partner town answers", () => {
    expect(scopeParentOf(parseScopeId("band:7"), {})).toBeNull();
  });

  it("a band's id is its cell — identity is where it stands", () => {
    const band: Band = { cell: 42, mix: { human: 3 }, size: 3, store: 0, mode: "forager" };
    expect(bandScopeIdOf(band)).toBe("band:42");
  });
});

describe("⚖️ B-③ — the settle carries the store out, and the bridge inverts", () => {
  it("settleBand returns the banked store beside the crowd", () => {
    const band: Band = { cell: 5, mix: { human: 9 }, size: 9, store: 123.5, mode: "forager" };
    expect(settleBand(band)).toEqual({ total: 9, mix: { human: 9 }, store: 123.5 });
  });

  it("🚨 THE STAPLE IDENTITY, pinned for the first time: valueDensity 1 ⇒ rations ARE units", () => {
    expect(settledTownStack(240, "food", { valueDensity: 1 })).toEqual({ food: 240 });
  });

  it("the general formula: units = rations / valueDensity, exactly invertible", () => {
    const stack = settledTownStack(240, "cloth", { valueDensity: 4 });
    expect(stack).toEqual({ cloth: 60 });
    expect(stack.cloth * 4).toBe(240); // the inverse — nothing rounds
  });

  it("an empty store mints an empty shelf, not a zero row", () => {
    expect(settledTownStack(0, "food", { valueDensity: 1 })).toEqual({});
    expect(settledTownStack(-1, "food", { valueDensity: 1 })).toEqual({});
  });

  it("the mint composition tri.ts uses: condenseTown over the settled stack", () => {
    const rec = condenseTown({ key: "band_town_0", stack: settledTownStack(88, "food", { valueDensity: 1 }) });
    expect(rec.key).toBe("band_town_0");
    expect(rec.stack).toEqual({ food: 88 });
    expect(rec.geo).toBeNull();
    expect(rec.at).toBeNull();
    expect(rec.distanceM).toBeNull();
    expect(rec.shortages).toBeNull(); // a never-run town — F-⑤'s subject
  });
});

describe("⚖️ B-② — the codec through the generic dispatch", () => {
  it("condense IS the gather: the crowd leaves the field into the record", () => {
    const grid = createGrid(twoWilds, COLS, ROWS);
    seedBox(grid);
    const before = totalField(grid, "forage") + totalField(grid, "gob");

    const rec = condense(bandScopeId(String(at(6, 6))), ctxOf(grid, BOTH));
    expect(isFoldRefusal(rec)).toBe(false);
    const r = rec as FoldRecord<BandRecord>;
    expect(r.kind).toBe("band");
    expect(bandCounts(r.payload)).toEqual({ human: 27, gob: 18 });
    expect(r.payload.band.store).toBe(0);
    expect(r.payload.good).toBe("food");
    expect(r.payload.valueDensity).toBe(1);
    expect(totalField(grid, "forage") + totalField(grid, "gob")).toBe(before - 45);
  });

  it("expand IS the dispersal: everyone back, and the answer is the honest empty (a dissolution into fields)", () => {
    const grid = createGrid(twoWilds, COLS, ROWS);
    seedBox(grid);
    const forage0 = totalField(grid, "forage");
    const gob0 = totalField(grid, "gob");

    const rec = condense(bandScopeId(String(at(6, 6))), ctxOf(grid, BOTH)) as FoldRecord<BandRecord>;
    const back = expand(rec, ctxOf(grid, BOTH));
    expect(isFoldRefusal(back)).toBe(false);
    expect(back).toEqual([]);
    expect(totalField(grid, "forage")).toBe(forage0);
    expect(totalField(grid, "gob")).toBe(gob0);
    expect(rec.payload.band.size).toBe(0);
  });

  it("🚨 the family's fixed point: an UNCAPPED second cycle is byte-identical, fields included", () => {
    const grid = createGrid(twoWilds, COLS, ROWS);
    seedBox(grid);
    const id = bandScopeId(String(at(6, 6)));

    const rec1 = condense(id, ctxOf(grid, BOTH)) as FoldRecord<BandRecord>;
    // Counts read BEFORE the dispersal: the payload ALIASES the band (the
    // record IS the entity), so expand zeroes the record's own mix too.
    const counts1 = bandCounts(rec1.payload);
    expand(rec1, ctxOf(grid, BOTH));
    const once = fieldSnapshot(grid);

    const rec2 = condense(id, ctxOf(grid, BOTH)) as FoldRecord<BandRecord>;
    expect(bandCounts(rec2.payload)).toEqual(counts1);
    expand(rec2, ctxOf(grid, BOTH));
    expect(fieldSnapshot(grid)).toEqual(once);
  });

  it("a CAPPED cycle: the mix is a fixed point (sums drive largest-remainder, and sums conserve)", () => {
    // Honest limit, stated: capped dispersal is headroom-greedy, so the
    // FIELD's exact distribution is not pinned byte-wise here (unlike wild,
    // whose expand re-derives placement from a seed). The record is.
    const grid = createGrid(twoWilds, COLS, ROWS);
    seedBox(grid);
    const id = bandScopeId(String(at(6, 6)));
    const capped = (g: ReturnType<typeof createGrid>) => ctxOf(g, BOTH, { maxHarvest: 9 });

    const rec1 = condense(id, capped(grid)) as FoldRecord<BandRecord>;
    const counts1 = bandCounts(rec1.payload);
    expect(counts1.human + counts1.gob).toBe(9);
    expand(rec1, capped(grid));
    const total1 = totalField(grid, "forage") + totalField(grid, "gob");

    const rec2 = condense(id, capped(grid)) as FoldRecord<BandRecord>;
    expect(bandCounts(rec2.payload)).toEqual(counts1);
    expand(rec2, capped(grid));
    expect(totalField(grid, "forage") + totalField(grid, "gob")).toBe(total1);
  });

  it("stockOf answers the store in UNITS under its good — the audit's stock half", () => {
    const band: Band = { cell: 1, mix: { human: 4 }, size: 4, store: 8, mode: "forager" };
    expect(BAND_CODEC.stockOf({ band, good: "food", valueDensity: 1 })).toEqual({ food: 8 });
    expect(BAND_CODEC.stockOf({ band, good: "cloth", valueDensity: 4 })).toEqual({ cloth: 2 });
    expect(BAND_CODEC.stockOf({ band: { ...band, store: 0 }, good: "food", valueDensity: 1 })).toEqual({});
  });
});

describe("⚖️ F-① at the dispersal — refusals, none of them half-happened", () => {
  it("🚨 a store-carrying record REFUSES to disperse unless the caller owns the waste", () => {
    const grid = createGrid(twoWilds, COLS, ROWS);
    seedBox(grid);
    const rec = condense(bandScopeId(String(at(6, 6))), ctxOf(grid, HUMANS)) as FoldRecord<BandRecord>;
    rec.payload.band.store = 5; // banked rations the scatter cannot keep
    const before = fieldSnapshot(grid);

    const refused = expand(rec, ctxOf(grid, HUMANS));
    expect(isFoldRefusal(refused)).toBe(true);
    if (isFoldRefusal(refused)) expect(refused.blockers).toContain("store");
    expect(fieldSnapshot(grid)).toEqual(before); // nothing half-happened
    expect(rec.payload.band.size).toBe(27); // everyone still in the band

    // The SIGNED decision: wasteStore disperses the people and the store
    // crosses into the noise floor — deliberate, in writing, once.
    const ok = expand(rec, ctxOf(grid, HUMANS, { wasteStore: true }));
    expect(isFoldRefusal(ok)).toBe(false);
    expect(rec.payload.band.size).toBe(0);
  });

  it("a full world refuses BEFORE the first person steps off", () => {
    const grid = createGrid(twoWilds, COLS, ROWS);
    seedBox(grid);
    const rec = condense(bandScopeId(String(at(6, 6))), ctxOf(grid, HUMANS)) as FoldRecord<BandRecord>;
    // Fill every forage tile to max: 27 people, zero headroom anywhere.
    grid.fields.forage.fill(31);
    const before = fieldSnapshot(grid);

    const refused = expand(rec, ctxOf(grid, HUMANS));
    expect(isFoldRefusal(refused)).toBe(true);
    if (isFoldRefusal(refused)) expect(refused.blockers).toContain("human");
    expect(fieldSnapshot(grid)).toEqual(before);
    expect(rec.payload.band.size).toBe(27);
  });

  it("a grid without the species' field cannot take them back — refused, named", () => {
    const grid = createGrid(twoWilds, COLS, ROWS);
    seedBox(grid);
    const rec = condense(bandScopeId(String(at(6, 6))), ctxOf(grid, BOTH)) as FoldRecord<BandRecord>;
    const gobless: WildSpecies[] = [{ key: "human", field: "forage" }, { key: "gob", field: "missing" }];

    const refused = expand(rec, ctxOf(grid, gobless));
    expect(isFoldRefusal(refused)).toBe(true);
    if (isFoldRefusal(refused)) expect(refused.blockers).toContain("gob");
  });

  it("condense refuses ids that name nothing: a foreign id, a cell off the grid", () => {
    const grid = createGrid(twoWilds, COLS, ROWS);
    const foreign = BAND_CODEC.condense("wild:oak_3", ctxOf(grid, HUMANS));
    expect(isFoldRefusal(foreign)).toBe(true);

    const offGrid = condense(bandScopeId("99999"), ctxOf(grid, HUMANS));
    expect(isFoldRefusal(offGrid)).toBe(true);
    if (isFoldRefusal(offGrid)) expect(offGrid.blockers).toContain("cell");

    const nonsense = condense(bandScopeId("xyz"), ctxOf(grid, HUMANS));
    expect(isFoldRefusal(nonsense)).toBe(true);
  });
});
