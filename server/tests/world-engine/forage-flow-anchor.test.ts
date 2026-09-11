// FORAGE FLOW — DENSITY × YIELD AT A CONSTANT PER-HECTARE FLOW
// (plant-growth-render-round.md PART 6, 2026-09-08.)
//
// USER RULING (2026-09-08): *"per-hectare FLOW stays anchored to reality ÷ the
// dial"* — how thickly the forage layer stands and how fast one plant bears may
// move freely against each other, as long as their PRODUCT lands on the anchor.
// This suite is that product, plus the two seats the round had to move to make
// it true: the conversion dial (which reaches the FLOW and must not reach the
// STOCK) and the folded record's ripening law (which must bear at the same
// per-plant rate a loaded feature does).
//
// 🚨 WHY A SUITE AND NOT A COMMENT. Every number here is one half of a pair —
// a density beside a cadence, a real day beside a dial. Either half alone reads
// like a balance knob somebody is free to turn, and the round it replaced was
// exactly that: `forageBase`'s counts and `regrowDays`' playable values,
// multiplying out to 0.346 rations/ha/day that nobody had ever computed.

import { describe, it, expect } from "@jest/globals";
import {
  RATION_KCAL,
  REAL_FORAGE_CAPTURE_FRACTION,
  REAL_FORAGE_HA_PER_PERSON,
  forageHaPerPerson,
  forageRationsPerHaDaily,
  DOLLHOUSE_SCALE,
  REAL_SCALE,
  type WorldScale,
} from "@shared/world-engine/scale.js";
import {
  itemsPerBearing,
  rationsPerBearing,
} from "@shared/world-engine/planet/packing.js";
import {
  FORAGE_UNDERSTORY,
  SCATTER_BIOSPHERE,
  DEFAULT_BIOSPHERE,
  standDensityPerHa,
} from "@shared/world-engine/planet/ecology.js";
import {
  buildWilderness,
  dueHarvestRegrowth,
  wildRegrowPeriodS,
  wildRegrowPeriodOf,
  type WildernessFeature,
} from "@shared/world-engine/interaction/quest/wilderness.js";
import { ripenWildArea, type WildAreaRecord } from "@shared/world-engine/interaction/quest/wild-area.js";
import { harvestProductsOf, naturalSourceOf } from "@shared/world-engine/products.js";
import {
  PLANET_CELL_ECO,
  planetCellWildMix,
} from "@shared/world-engine/headless/text-quest.js";

/** The shipped GL preset's dial (`frontier-planet` runs the street clock). */
const GL_DIAL = 7.5;
const DAY_S = 240;

/**
 * Rations one hectare of THIS cell bears per day, from the two halves the
 * round owns: the standing density × what one plant of that species bears in
 * one cadence. Dial-free — the dial is applied by the caller, exactly as
 * `wildRegrowPeriodS` applies it at the point of use.
 *
 * 🌿 RE-DERIVED (resource-packing round). Both halves moved to a real
 * foundation and the anchor did not: the density is now PACKED
 * (`planet/packing.ts` — crown/root geometry against the cell's light, water
 * and nutrient budgets) instead of authored on four `FORAGE_UNDERSTORY` rows,
 * and a bearing is now the plant's own production
 * (`rationsPerBearing` — yield class × crown area × the cadence's share of the
 * year × the forager's capture fraction) instead of one flat unit. Expand it
 * and it is `perHa × crownArea × yield × capture ÷ (365 × RATION_KCAL)`: the
 * cadence CANCELS, which is the whole point — this is a per-hectare FLOW and
 * it cannot be moved by re-timing a plant.
 */
function measuredRationsPerHaDaily(eco: Readonly<Record<string, number>>): number {
  let rations = 0;
  for (const line of planetCellWildMix(11)) {
    const src = naturalSourceOf(line.species);
    if (!src) continue;
    for (const p of harvestProductsOf(line.species)) {
      if (p.use !== "food") continue;
      const perHa = line.perHa ?? 0;
      rations += (perHa * rationsPerBearing(src, p)) / (p.regrowDays ?? 1);
    }
  }
  // `eco` is what `planetCellWildMix` already read; naming it keeps the caller
  // honest about which cell this number belongs to.
  expect(Object.keys(eco).length).toBeGreaterThan(0);
  return rations;
}

describe("① the anchor — one real figure, divided by the dial", () => {
  it("is a REAL_ constant in the F4 pattern, inside the ethnographic range", () => {
    // 10–100 ha a head is the field range for temperate foragers; the shipped
    // value sits at the productive-woodland end and is a USER CALL.
    expect(REAL_FORAGE_HA_PER_PERSON).toBeGreaterThanOrEqual(10);
    expect(REAL_FORAGE_HA_PER_PERSON).toBeLessThanOrEqual(100);
    expect(REAL_FORAGE_HA_PER_PERSON).toBe(30);
  });

  it("…and so are the two constants the packed derivation added", () => {
    // A ration is one person-day: the ordinary adult reference intake, which
    // is what makes a kcal figure on a plant row commensurable with the
    // economy's own unit.
    expect(RATION_KCAL).toBe(2000);
    // 🚫 NOT A SECOND DIAL. `REAL_FORAGE_HA_PER_PERSON` is a CAPTURE figure
    // and a plant row states GROSS production; this is the bridge, and it is
    // pinned INSIDE the 0.2–0.5 field range for wild-plant capture rather than
    // being free to absorb whatever the rest of the arithmetic needs.
    expect(REAL_FORAGE_CAPTURE_FRACTION).toBeGreaterThanOrEqual(0.2);
    expect(REAL_FORAGE_CAPTURE_FRACTION).toBeLessThanOrEqual(0.5);
    expect(REAL_FORAGE_CAPTURE_FRACTION).toBeCloseTo(0.41225, 9);
  });

  it("divides by the conversion dial, divisor-first — `farmAcresPerPerson`'s twin", () => {
    expect(forageHaPerPerson()).toBe(REAL_FORAGE_HA_PER_PERSON);          // default 1 = reality
    expect(forageHaPerPerson(GL_DIAL)).toBeCloseTo(4, 9);                  // 30 / 7.5
    // …and the flow is its reciprocal, never a second number.
    const glScale: WorldScale = { ...DOLLHOUSE_SCALE, resourceCompression: GL_DIAL };
    expect(forageRationsPerHaDaily(REAL_SCALE)).toBeCloseTo(1 / 30, 9);
    expect(forageRationsPerHaDaily(glScale)).toBeCloseTo(0.25, 9);
  });
});

describe("② density × yield lands ON the anchor — the whole point of the round", () => {
  it("the shipped forest cell bears the anchor's flow, within 5 %", () => {
    const measured = measuredRationsPerHaDaily(PLANET_CELL_ECO);
    const target = forageRationsPerHaDaily(REAL_SCALE); // 1/30, dial-free
    expect(measured / target).toBeGreaterThan(0.95);
    expect(measured / target).toBeLessThan(1.05);
    // …and the compressed world the player actually plays lands on 0.25.
    const glScale: WorldScale = { ...DOLLHOUSE_SCALE, resourceCompression: GL_DIAL };
    expect(measured * GL_DIAL).toBeCloseTo(forageRationsPerHaDaily(glScale), 2);
  });

  it("🚨 MOVE ONE HALF AND THE PIN BREAKS — which is the invariant", () => {
    // Stated as an executable claim rather than a comment: the anchor binds the
    // PRODUCT, so halving a density without touching its cadence must fall out
    // of the band above. (This is the failure mode the round exists to make
    // loud — `forageBase`'s counts and `regrowDays`' playable values drifted
    // apart for a year with nothing to notice.)
    let halved = 0;
    for (const line of planetCellWildMix(11)) {
      const src = naturalSourceOf(line.species);
      if (!src) continue;
      for (const p of harvestProductsOf(line.species)) {
        if (p.use !== "food") continue;
        halved += ((line.perHa ?? 0) / 2) * (rationsPerBearing(src, p) / (p.regrowDays ?? 1));
      }
    }
    expect(halved / forageRationsPerHaDaily(REAL_SCALE)).toBeLessThan(0.95);
  });

  it("the understory rides a BAKED canopy field and never joins the bake", () => {
    // The rows are read by MODEL and scaled by `abundance[key]`, so two rows
    // may share a key; putting them in `DEFAULT_BIOSPHERE` instead would
    // renumber every planet's `fields.biome` and hand `ecoAbundanceAt` keys no
    // serialized substrate carries.
    expect(DEFAULT_BIOSPHERE).toHaveLength(3);
    expect(SCATTER_BIOSPHERE.slice(0, 3)).toEqual(DEFAULT_BIOSPHERE);
    for (const row of FORAGE_UNDERSTORY) {
      expect(["tree", "grass"]).toContain(row.key);      // a baked field
      expect(DEFAULT_BIOSPHERE.some((s) => s.key === row.key)).toBe(true);
      expect(row.model).toBeTruthy();
      expect(row.standPerHa).toBeGreaterThan(0);
      expect(naturalSourceOf(row.model!)).toBeTruthy();  // a real catalogue row
    }
    // 🌿 …AND `standPerHa` IS NOW THE LEGACY ARM, said out loud (the
    // resource-packing round). The rows keep the field — deleting it would
    // answer 0 for exactly the callers that still need a number, and would
    // drop the understory out of the "lines the density law claims" set the
    // scatter derives from these rows — but on a REAL cell (climate AND eco)
    // `packStands` is the only authority, so the two must DISAGREE. If they
    // ever agreed again, someone has quietly re-authored a packed density.
    const packedCarrot = planetCellWildMix(11).find((e) => e.species === "carrot_plant")!.perHa!;
    // No understory row ever claimed the carrot, so the legacy law's honest
    // answer for it is 0 — and the packed cell stands 13 patches a hectare.
    expect(standDensityPerHa("carrot_plant", PLANET_CELL_ECO, SCATTER_BIOSPHERE)).toBe(0);
    expect(packedCarrot).toBeGreaterThan(1);
    // A thicker wood carries a thicker hedge — linear in the canopy, off ONE law.
    expect(standDensityPerHa("bush", { tree: 0 }, SCATTER_BIOSPHERE)).toBe(0);
    expect(standDensityPerHa("bush", { tree: 1 }, SCATTER_BIOSPHERE)).toBe(
      FORAGE_UNDERSTORY.find((r) => r.model === "bush")!.standPerHa,
    );
    // …and `oak` still resolves to TREE, not to an understory row.
    expect(standDensityPerHa("oak", { tree: 1 }, SCATTER_BIOSPHERE)).toBe(
      DEFAULT_BIOSPHERE.find((s) => s.model === "oak")!.standPerHa,
    );
  });
});

describe("③ the dial reaches the FLOW and not the STOCK", () => {
  it("divides the regrow period, so a compressed world bears faster", () => {
    const berry = harvestProductsOf("bush").find((p) => p.glyph === "berry")!;
    expect(wildRegrowPeriodS(berry, DAY_S)).toBeCloseTo(berry.regrowDays! * DAY_S, 9);
    expect(wildRegrowPeriodS(berry, DAY_S, GL_DIAL)).toBeCloseTo(
      (berry.regrowDays! * DAY_S) / GL_DIAL,
      9,
    );
    // Absent / zero / negative dial ⇒ the real anchor, verbatim (the byte-
    // identical arm every no-dial world takes).
    expect(wildRegrowPeriodS(berry, DAY_S, 0)).toBe(wildRegrowPeriodS(berry, DAY_S));
    expect(wildRegrowPeriodOf("bush", "berry", DAY_S, GL_DIAL)).toBeCloseTo(
      wildRegrowPeriodS(berry, DAY_S, GL_DIAL),
      9,
    );
  });

  it("🚫 and NEVER the rolled stock — the oak's timber does not move", () => {
    // `buildWilderness` still rolls at dial 1 (`ScatterOpts.conversionDial` is
    // the inert seat). If the dial ever reached `bodyStockOf`, every oak on the
    // planet would carry 7.5× its wood through the SAME call that would have
    // put 30 berries on a waist-high bush.
    const mix = planetCellWildMix(11);
    const plain = buildWilderness({ seed: 11, side: 190, mix });
    const dialled = buildWilderness({ seed: 11, side: 190, mix, conversionDial: GL_DIAL });
    expect(dialled).toEqual(plain);
    const wood = (w: typeof plain): number =>
      w.features.reduce((a, f) => a + (f.stock.wood ?? 0), 0);
    expect(wood(dialled)).toBe(wood(plain));
    expect(wood(plain)).toBeGreaterThan(0);
  });
});

describe("④ ONE regrowth law — a folded stand bears what a loaded one bears", () => {
  const bushStand = (plants: number, stock: number, cap: number, armedAt: number): WildAreaRecord => ({
    key: "tile-0-1",
    area: { x: 0, y: 0, w: 200, h: 200 },
    seed: 1,
    at: 0,
    stands: [
      {
        species: "bush",
        byClass: [plants],
        stock: { berry: stock },
        cap: { berry: cap },
        climbAt: [],
        regrowAt: { berry: [armedAt] },
      },
    ],
    draw: [],
  });

  const PER = wildRegrowPeriodOf("bush", "berry", DAY_S, GL_DIAL);

  /** What ONE bush bears in ONE cadence — fractional, off the plant's own
   *  crown and yield class (`planet/packing.ts`). */
  const BERRY_PER_BEARING = itemsPerBearing(
    naturalSourceOf("bush")!,
    harvestProductsOf("bush").find((p) => p.glyph === "berry")!,
  );

  it("🚨 the WILD arm matures ONE BEARING PER PLANT, never a jump to cap", () => {
    // THE DEFECT: a folded tile refilled every stand TO CAP on a flat one-day
    // pulse, so the eight ring-1 tiles of a founding renewed 63.6 rations/day
    // against the 10.4 their own plants could bear — walking away from a berry
    // patch made it six times more productive.
    //
    // 🌿 AND A BEARING IS THE PLANT'S OWN (the resource-packing round): a
    // waist-high bush replaces about half a berry a cadence, so thirty of them
    // put out fifteen — the POPULATION's bearing, still nothing like the cap.
    expect(BERRY_PER_BEARING).toBeGreaterThan(0);
    expect(BERRY_PER_BEARING).toBeLessThan(1);           // a bush is a small plant
    const rec = bushStand(30, 0, 300, 0);
    const ripe = ripenWildArea(rec, PER, () => PER, { perPlant: true });
    expect(ripe.stands[0]!.stock.berry).toBe(Math.floor(30 * BERRY_PER_BEARING));
    expect(ripe.stands[0]!.stock.berry).toBeLessThan(300);
    // …and the clock rolls forward from the DEADLINE, so a long absence keeps
    // its remainder instead of being rounded to `now`.
    expect(ripe.stands[0]!.regrowAt.berry).toEqual([PER]);
  });

  it("…at the SAME per-plant rate a loaded feature bears at", () => {
    // 🚨 MEASURED OVER 200 CADENCES, NOT ONE, AND THE REASON IS THE CARRY. A
    // bearing is FRACTIONAL now (a bush bears 0.53 items a cadence), so over a
    // single period the folded stand of twelve bears six and the loaded bush
    // bears NOTHING — its carry is still 0.53 — and comparing them there would
    // pin the rounding rather than the law. Run both until the carries flush
    // and the two rates are the same rate.
    const plants = 12;
    const CAD = 200;
    let rec = bushStand(plants, 0, 1e6, PER);
    for (let k = 1; k <= CAD; k++) {
      rec = ripenWildArea(rec, k * PER, () => PER, { perPlant: true });
    }
    const folded = rec.stands[0]!.stock.berry ?? 0;

    const bush: WildernessFeature = {
      id: "wild:bush_0", species: "bush", x: 0, y: 0,
      stock: { berry: 0 }, harvestCap: { berry: 1e6 }, regrowAt: { berry: PER },
    };
    let loaded = 0;
    for (let k = 1; k <= CAD; k++) {
      const due = dueHarvestRegrowth(bush, { berry: loaded }, k * PER, DAY_S, GL_DIAL);
      if (!due) continue;
      loaded += due.add.berry ?? 0;
      bush.regrowAt = due.regrowAt;
    }

    // Both arms bear the plant's own rate: 200 cadences × the population.
    expect(folded).toBe(Math.floor(CAD * plants * BERRY_PER_BEARING));
    expect(loaded).toBe(Math.floor(CAD * BERRY_PER_BEARING));
    // …and the two agree to within the flooring, which is at most one item a
    // cadence and is measured far under it (5 items over 200 cadences: the
    // folded stand floors ONE pooled total where twelve loaded bushes floor
    // twelve separate ones).
    expect(Math.abs(folded - plants * loaded)).toBeLessThanOrEqual(CAD);
    expect(folded / (plants * loaded)).toBeCloseTo(1, 1);
    // 🚫 AND NEITHER ARM MINTS OR LOSES A UNIT: every item that came out is a
    // whole item, and the total never exceeds what the bearing law allows.
    expect(Number.isInteger(folded)).toBe(true);
    expect(folded).toBeLessThanOrEqual(CAD * plants * BERRY_PER_BEARING);
    expect(loaded).toBeLessThanOrEqual(CAD * BERRY_PER_BEARING);
  });

  it("⚖️ the FIELD PULSE is the default and is untouched — a sown farm is not a wood", () => {
    // `stepFarmSource` sizes its cap from the cultivated area's DAILY yield and
    // `localYieldPerDay` reads that cap AS the per-day rate, so a farm record
    // must keep refilling to cap on its one-day pulse. Two laws, said out loud,
    // each with one caller — never one law quietly wrong for half of them.
    const rec = bushStand(30, 0, 300, 0);
    expect(ripenWildArea(rec, PER, () => PER).stands[0]!.stock.berry).toBe(300);
    expect(ripenWildArea(rec, PER, () => PER, {}).stands[0]!.stock.berry).toBe(300);
  });

  it("neither arm mints past the stand's own capacity", () => {
    const rec = bushStand(30, 0, 10, 0);
    expect(ripenWildArea(rec, PER, () => PER, { perPlant: true }).stands[0]!.stock.berry).toBe(10);
    expect(ripenWildArea(rec, PER, () => PER).stands[0]!.stock.berry).toBe(10);
  });
});
