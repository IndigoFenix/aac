// THE UNFORK — a household shops where the GOODS CLOCK sends it
// (stocking-offload-and-carry.md §1.2)
//
// The user's law, verbatim: *"the logic determining household member shopping
// trips should be the same as the logic determining shop stocking, or handling
// city or country imports."*
//
// The fork this file closes: the goods clock routes every house to its OWN
// nearest source (`TownGoods.sourceOf(house)`, by street), while the LIVE needs
// loop held exactly ONE `store:<good>` object for the whole town, seeded at
// `sourceOf(plan.houses[0])`. Measured at seed 12, focus house 99: its own food
// source is 65 m from its door and the reference house's market is 147 m
// (clothing: 102 m vs 315 m) — so the family walked 2.3×/3.3× further than its
// own catchment on every trip, and the return leg outlived the street day.
//
// What this file pins:
//  ① THE RULE, pure (`goodSourceEndpointId`, kernel/town/transfer.ts): a
//     SHELVED source is a market shelf `store:<good>:<srcIdx>` — the transfer
//     ledger's own spelling, which `parseScopeId` has always wanted; an
//     unshelved PRODUCER GATE sells from the pile that already stands there
//     (`produce:<good>:<work>`); the seller-less hall keeps an EMPTY shelf and
//     never an absent one.
//  ② THE UNFORK, live on the real dollhouse: a non-reference house's ctx names
//     ITS OWN endpoint at ITS OWN distance, and the reference house's row is
//     byte-for-byte what it was.
//  ③ THE ENDPOINTS AGREE with the seeding — every source of every good resolves
//     to an endpoint that actually exists in the world.
//  ④ CLAIMS ARE PER-ENDPOINT: a housemate speaking for units at one quarter's
//     stall no longer dries out another quarter's.
//  ⑤ WHERE-IS still resolves, and the market bags now lie at every stall.
//  ⑥ The probe is a PURE READ (the stock audit is byte-identical across it).
//  ⑦ ⚖️ TWO PLACEMENT LAWS MAY NOT BE MIXED (the clothing-shopper flood): a
//     street good sold only at a PRODUCTION-CAPPED gate is placed by a
//     population fraction, blind to distance, while the market channel places
//     on the SERVICE RADIUS. Mixed, the second law wins silently — clothing's
//     539 m mean walk against food's 96 m radius made a 693 s round trip, and
//     the good-blind street-body budget let it crowd the staple off the street
//     (32 clothing walkers embodied against 9 for food). Clothing now joins the
//     market channel; the invariant and the occupancy pin below are what catch
//     the next one.
//
// ✅ F4 LANDED (2026-08-09) — clothing demand re-grounded on
// `REAL_CLOTHING_DAYS = 180 ÷ metabolism`, and the street layer's
// `perCapitaDaily` food-normalized (clothing 1 → 1/180). Every cadence number
// moved (period 15.2 → 54.6 street days, boxCap 100 → 2, walker demand 6.15 →
// 1.71) and NOT ONE PIN HERE MOVED WITH THEM — which is what the structure-and-
// orderings discipline above was for. The anchor itself is pinned in
// symbol-game-store.test.ts; nothing below pins an absolute cadence number.
//
// Pure logic + one headless boot — no DOM / GL / DB.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import {
  goodSourceEndpointId,
  produceEndpointId,
  shelfEndpointId,
  type GoodSourceBook,
} from "@shared/world-engine/kernel/town/transfer.js";
import { parseScopeId } from "@shared/world-engine/kernel/town/scope.js";
import { ERRAND_WALK, streetServiceWarnings, type TownGoods } from "@shared/world-engine/kernel/town/goods.js";
import type { TownHouse } from "@shared/world-engine/kernel/town/plan.js";
import { serviceRadiusM } from "@shared/world-engine/scale.js";

// ─────────────────────────────────────────────────────────────────────────
// ① THE RULE — pure, and stubbable without a town
// ─────────────────────────────────────────────────────────────────────────

/** A goods book with three source shapes: a shelved market, an unshelved
 *  producer gate, and an unshelved non-producer (the hall of a seller-less
 *  town). Structural, exactly as the rule's parameter is declared. */
const book = (): GoodSourceBook => ({
  good: { key: "food", shelved: ["market"] },
  sources: [
    { kind: "market", work: 1 },
    { kind: "farm", work: 4 },
    { kind: "hall", work: 9 },
    { kind: "farm" }, // a gate with no plan work at all
  ],
  producerWorks: () => [4, 5, 6],
});

describe("goodSourceEndpointId — ONE rule, read by the seeding and the shopper", () => {
  it("gives a SHELVED source the transfer ledger's own shelf id", () => {
    expect(goodSourceEndpointId(book(), 0)).toBe(shelfEndpointId("food", 0));
    expect(goodSourceEndpointId(book(), 0)).toBe("store:food:0");
  });

  it("sends an unshelved PRODUCER GATE to the pile that already stands there", () => {
    // "A producer selling from the field needs no second box at its doorstep."
    expect(goodSourceEndpointId(book(), 1)).toBe(produceEndpointId("food", 4));
    expect(goodSourceEndpointId(book(), 1)).toBe("produce:food:4");
  });

  it("keeps an EMPTY shelf, never an ABSENT one, for a seller-less town's hall", () => {
    // §2.5 DEFER's distinction: a body must be able to tell "the market is
    // empty" from "there is no market", and only a listed endpoint can say so.
    expect(goodSourceEndpointId(book(), 2)).toBe("store:food:2");
    expect(goodSourceEndpointId(book(), 3)).toBe("store:food:3"); // no work ⇒ no pile
  });

  it("is null only for an index that names no source", () => {
    expect(goodSourceEndpointId(book(), 9)).toBeNull();
    expect(goodSourceEndpointId(book(), -1)).toBeNull();
  });

  it("mints ids the ONE scope grammar parses — which `store:<good>` never was", () => {
    expect(parseScopeId(goodSourceEndpointId(book(), 0)!)).toEqual({
      kind: "shelf",
      goodKey: "food",
      srcIdx: 0,
    });
    expect(parseScopeId(goodSourceEndpointId(book(), 1)!)).toEqual({
      kind: "produce",
      goodKey: "food",
      workIdx: 4,
    });
    // The shape this pass retired: it fell through to "some container".
    expect(parseScopeId("store:food")).toEqual({ kind: "container", objectId: "store:food" });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ⑦ THE SERVICE-RADIUS INVARIANT, pure — and NOT VACUOUS
// ─────────────────────────────────────────────────────────────────────────

/** A street good whose households all walk `metres` one way. Only the two
 *  fields the invariant reads are real. */
const walkerGood = (key: string, sellers: string[], metres: number): TownGoods =>
  ({
    good: { key, sellers },
    cycle: () => ({ period: 600, walk: metres / ERRAND_WALK, trip: 0, offset: 0 }),
  }) as unknown as TownGoods;
const HOUSES_3 = [{}, {}, {}] as unknown as TownHouse[];

describe("streetServiceWarnings — two placement laws may not be mixed", () => {
  it("NAMES a good whose households out-walk the radius its stalls would be founded on", () => {
    const [line, ...rest] = streetServiceWarnings([walkerGood("clothing", ["tailor"], 539)], HOUSES_3, 96);
    expect(rest).toHaveLength(0);
    expect(line).toContain("clothing");
    expect(line).toContain("539 m");
    expect(line).toContain("96 m");
    expect(line).toContain("tailor");
  });

  it("is SILENT for a good on the market channel — its sellers ARE placed on the radius", () => {
    // The exemption is by construction, not by distance: a market-channel good
    // is sited BY the radius, so measuring it against the radius is circular.
    expect(streetServiceWarnings([walkerGood("clothing", ["market", "tailor"], 539)], HOUSES_3, 96)).toEqual([]);
  });

  it("is SILENT inside the radius, and says nothing at all with no houses or no radius", () => {
    expect(streetServiceWarnings([walkerGood("food", ["farm"], 70)], HOUSES_3, 96)).toEqual([]);
    expect(streetServiceWarnings([walkerGood("clothing", ["tailor"], 539)], [], 96)).toEqual([]);
    expect(streetServiceWarnings([walkerGood("clothing", ["tailor"], 539)], HOUSES_3, 0)).toEqual([]);
  });

  it("REPORTS, never throws — an incoherent town is legal and merely said out loud", () => {
    expect(() => streetServiceWarnings([walkerGood("clothing", [], 5_000)], HOUSES_3, 96)).not.toThrow();
    expect(streetServiceWarnings([walkerGood("clothing", [], 5_000)], HOUSES_3, 96)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ②–⑦ LIVE, on the real shipped dollhouse at the diagnosed seed
// ─────────────────────────────────────────────────────────────────────────

const specPath = join(process.cwd(), "games", "dollhouse", "src", "game.spec.json");
const doc = JSON.parse(readFileSync(specPath, "utf8"));
const SEED = 12; // the seed §1.1 measured the fork on

describe("the live needs ctx, on the real dollhouse (seed 12)", () => {
  let run: TextQuestRun;
  let focus: number;
  /** The reference house's endpoints — where the ONE old stall per good stood
   *  (house 0's own binding, which is what the single store object was seeded
   *  at). CLOTHING'S MOVED with the placement fix: its source list used to be
   *  the two tailors alone, so house 0 bound to tailor #0 at `:0`; now the
   *  radius's market stalls sell clothing too and the list is `plan.works`
   *  order — market(w1), tailor(w11), tailor(w12), then the 13 neighbourhood
   *  markets — so house 0 binds to the stall at `:3`, which is nearer than
   *  either tailor. The `srcIdx` re-order is the whole point of the fix, not a
   *  side effect: 2 sources became 16. */
  const REF_FOOD = "store:food:8";
  const REF_CLOTHING = "store:clothing:3";

  beforeAll(() => {
    run = bootTextQuest({ world: doc, seed: SEED, dt: 1 / 20 });
    focus = run.session.dollhouse!;
    run.advanceS(15); // let the watched family embody, so the rows carry metres
  });
  afterAll(() => run.dispose());

  const host = () => run.host as unknown as {
    needSourceProbe(cid: string, goodKey: string): { id: string; units: number; free?: number; d?: number } | undefined;
    sourceProbe(cid: string, target: { category?: string; kind?: string }): unknown;
    stockAudit(): Record<string, number>;
  };
  const distFrom = (cid: string, objId: string): number => {
    const body = run.state.avatars[cid]!;
    const o = run.state.objects[objId]!;
    return Math.hypot(o.x - body.x, o.y - body.y);
  };

  it("② names the FOCUS household's own food source — its farm gate, not the reference market", () => {
    const p = host().needSourceProbe(`resident_${focus}_0`, "food")!;
    expect(p).toBeDefined();
    // Seed 12's house 99 binds to source #7, an unshelved FARM GATE, so its
    // endpoint is that farm's own pile — the economy's stock where the economy
    // put it. (The old code could only ever name the reference market.)
    expect(p.id).toBe("produce:food:8");
    expect(p.id).not.toBe(REF_FOOD);
    expect(run.state.objects[p.id]).toBeDefined();
  });

  it("② …at ITS OWN distance: the metres on the row are its gate's, and they beat the reference market's", () => {
    const cid = `resident_${focus}_0`;
    const p = host().needSourceProbe(cid, "food")!;
    expect(p.d).toBeDefined();
    expect(p.d).toBeCloseTo(distFrom(cid, p.id), 3); // the row's metres ARE this body's
    // The measured fork: 65 m of its own against 147 m of the reference house's.
    expect(p.d!).toBeLessThan(distFrom(cid, REF_FOOD) * 0.75);
  });

  it("② the same for CLOTHING — its own quarter's stall, not the far one", () => {
    const cid = `resident_${focus}_1`;
    const p = host().needSourceProbe(cid, "clothing")!;
    // Was `store:clothing:1` (tailor #0) when the two tailors were the only
    // sellers in town; with clothing on the market channel this household
    // binds to the neighbourhood stall the service radius already founded for
    // it. The endpoint is still ITS OWN — that is what ② pins — and the id
    // moved only because the source list grew from 2 to 16.
    expect(p.id).toBe("store:clothing:5");
    expect(p.id).not.toBe(REF_CLOTHING);
    // The MARGIN shrank on purpose: it used to be 102 m against the reference
    // house's 315 m (a third of the way), because the whole town shared two
    // tailors and the fork sent this household to the wrong one. With stalls
    // on the service radius NEITHER household walks across town, so the pin is
    // the fact the fork was about — its own is nearer — not the old ratio.
    expect(p.d!).toBeLessThan(distFrom(cid, REF_CLOTHING));
    // …and it is a MARKET stall, not a production-capped gate — the structural
    // half of the claim, which survives any renumbering.
    const src = run.session.town!.stage.goods.find((g) => g.good.key === "clothing")!.sources[5]!;
    expect(src.kind).toBe("market");
  });

  it("② THE REFERENCE HOUSE binds to its own nearest source, as it always did", () => {
    expect(host().needSourceProbe("resident_0_0", "food")?.id).toBe(REF_FOOD);
    expect(host().needSourceProbe("resident_0_0", "clothing")?.id).toBe(REF_CLOTHING);
  });

  it("② every member of the household is sent to the SAME endpoint (the house binds, not the body)", () => {
    const ids = [0, 1, 2].map((m) => host().needSourceProbe(`resident_${focus}_${m}`, "food")?.id);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe("produce:food:8");
  });

  it("② a WELL is untouched — water was never routed through a stall", () => {
    const p = host().needSourceProbe(`resident_${focus}_0`, "water")!;
    expect(p.id.startsWith("well")).toBe(true);
    expect(p.units).toBe(99);
  });

  it("③ EVERY source of every good resolves to an endpoint that exists in the world", () => {
    const goods = run.session.town!.stage.goods;
    let shelves = 0;
    let piles = 0;
    for (const g of goods) {
      g.sources.forEach((_src, si) => {
        const id = goodSourceEndpointId(g, si);
        expect(id).not.toBeNull();
        expect(run.state.objects[id!]).toBeDefined();
        if (id!.startsWith("store:")) shelves++;
        else piles++;
      });
    }
    // Seed 12: 14 shelved food markets, then 14 clothing shelves (the same 14
    // stalls, now selling clothing too) + the 2 tailors; 7 farm gates shop off
    // their own produce piles. The town had TWO stalls before the unfork, and
    // 14 + 2 before clothing joined the market channel — every stall the
    // service radius founded now carries both goods, which is the placement
    // fix expressed as objects.
    expect(shelves).toBe(30);
    expect(piles).toBe(7);
    expect(run.session.marketStore.size).toBe(shelves);
  });

  it("③ every registered stall spells itself in the ONE scope grammar, at a SHELVED source", () => {
    const goods = run.session.town!.stage.goods;
    for (const [objId, key] of run.session.marketStore) {
      const ref = parseScopeId(objId);
      expect(ref.kind).toBe("shelf");
      if (ref.kind !== "shelf") continue;
      expect(ref.goodKey).toBe(key);
      const g = goods.find((x) => x.good.key === key)!;
      const src = g.sources[ref.srcIdx]!;
      expect(src).toBeDefined();
      // …either a shelf the dawn cart stocks, or the seller-less fall-through.
      expect(g.good.shelved.includes(src.kind) || !g.producerWorks().includes(src.work ?? -1)).toBe(true);
    }
  });

  it("④ CLAIMS ARE PER-ENDPOINT: the reference market's claims do not dry the family's gate", () => {
    const cid = `resident_${focus}_0`;
    const before = host().needSourceProbe(cid, "food")!;
    expect(before.free).toBe(before.units);
    // A stranger speaks for everything on the REFERENCE market's shelf…
    run.session.needClaims.reserve("need:resident_0_0", REF_FOOD, "food", 99);
    expect(host().needSourceProbe(cid, "food")!.free).toBe(before.free);
    // …and the same claim on THIS household's own endpoint is felt at once.
    run.session.needClaims.reserve("need:resident_0_0", before.id, "food", 99);
    expect(host().needSourceProbe(cid, "food")!.free).toBe(0);
    run.session.needClaims.release("need:resident_0_0");
    expect(host().needSourceProbe(cid, "food")!.free).toBe(before.free);
  });

  it("⑤ WHERE-IS still resolves a source answer for the good", () => {
    // The subject SHAPE is unchanged (`buy:good:<key>` is a category subject for
    // the whole town), so the dialogue layer keeps its answer; only the geometry
    // is now re-aimed per answerer.
    expect(run.session.placeFacts.has("buy:good:food")).toBe(true);
    expect(run.session.placeFacts.has("buy:good:clothing")).toBe(true);
    const ans = host().sourceProbe(`resident_${focus}_0`, { category: "food" });
    expect(ans).toBeDefined();
  });

  it("⑤ the market's BAG SUPPLY lies at every stall, not only the reference one", () => {
    const props = [...run.session.smallProps.entries()].filter(([, r]) =>
      r.glyph === "basket" || r.glyph === "satchel",
    );
    const nearAStall = (objId: string): number => {
      const s = run.state.objects[objId]!;
      return props.filter(([pid]) => {
        const o = run.state.objects[pid];
        return !!o && Math.hypot(o.x - s.x, o.y - s.y) <= 6;
      }).length;
    };
    // A stall that is NOT the reference house's still has bags on offer.
    const other = [...run.session.marketStore.keys()].find((id) => id !== REF_FOOD && id.startsWith("store:food:"))!;
    expect(nearAStall(other)).toBeGreaterThan(0);
    expect(nearAStall(REF_FOOD)).toBeGreaterThan(0);
  });

  // ───────────────────────────────────────────────────────────────────────
  // ⑦ THE STREET'S OCCUPANCY — the assertion the flood needed
  // ───────────────────────────────────────────────────────────────────────

  /** Households simultaneously out on a trip for this good, from the clock's
   *  own closed form: Σ over houses of trip ÷ period. This is the WALKER
   *  DEMAND the street-body budget has to pay for — and the budget is
   *  good-blind, so a good that demands more than the staple takes the
   *  staple's bodies. Deliberately a RATIO instrument: F4's demand re-grounding
   *  moved every absolute here (clothing 6.15 → 1.71 against food's 39.74), and
   *  none of them are pinned. */
  const occupancyOf = (key: string): number => {
    const g = run.session.town!.stage.goods.find((x) => x.good.key === key)!;
    let occ = 0;
    for (const h of run.session.town!.plan.houses) {
      const c = g.cycle(h);
      occ += c.trip / c.period;
    }
    return occ;
  };
  const meanTripOf = (key: string): number => {
    const g = run.session.town!.stage.goods.find((x) => x.good.key === key)!;
    const houses = run.session.town!.plan.houses;
    return houses.reduce((s, h) => s + g.cycle(h).trip, 0) / houses.length;
  };

  it("⑦ NO STREET GOOD OUT-CROWDS THE STAPLE: every good's walker demand ≤ food's", () => {
    const staple = occupancyOf("food");
    expect(staple).toBeGreaterThan(0);
    for (const g of run.session.town!.stage.goods) {
      if (g.good.key === "food") continue;
      expect(occupancyOf(g.good.key)).toBeLessThanOrEqual(staple);
    }
  });

  it("⑦ …AND THE WALK IS THE SAME TOWN'S WALK — no good's mean trip runs away from food's", () => {
    // THE PIN THAT ACTUALLY CATCHES THE FLOOD. Occupancy alone very nearly
    // missed it: before the fix clothing's demand was 38.4 walkers against
    // food's 39.7 — a hair UNDER the staple, and still half the street, because
    // a good bought 6.8× less often was making a 6.5× longer trip. The
    // frequency term is the good's own business (F4 duly cut it another 3.6×);
    // the TRIP is geometry, and geometry is what two mixed placement laws break
    // — F4 left the mean clothing trip at 111.6 s against food's 106.1 s, i.e.
    // exactly where F3 put it, because demand cannot move a walk.
    const staple = meanTripOf("food");
    for (const g of run.session.town!.stage.goods) {
      if (g.good.key === "food") continue;
      expect(meanTripOf(g.good.key)).toBeLessThan(staple * 2);
    }
  });

  it("⑦ A SLOW GOOD'S STALL IS STILL SHOPPABLE — the display never falls below one unit", () => {
    // F4's second degeneracy (goods.ts `stockOf`). The shelf sawtooth is "a
    // day's draw in at dawn, drunk down by the modelled shoppers", which is the
    // staple's truth and a fiction for a good bought twice a year: clothing's
    // stall draws 0.35 outfits a day, so `Math.floor` read 0 to every shopper
    // for ~86% of the day while the town's 16 stalls between them supplied 3×
    // what it wanted. The floor is one whole unit — you cannot rack a third of
    // a coat. Pinned as the CLAIM (every stall with a catchment can be shopped
    // right now), never as a stock level.
    for (const g of run.session.town!.stage.goods) {
      for (const src of g.sources) {
        if (!g.good.shelved.includes(src.kind) || src.depot) continue;
        if (!(g.stallDaily(src) > 0)) continue; // a stall no household binds to
        for (let i = 0; i < 12; i++) {
          const t = run.session.townClock + (run.session.scale.dayLengthS * i) / 12;
          expect(Math.floor(g.stockOf(src, t))).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it("⑦ …and the STAPLE's shelf is untouched by that floor — it never came near it", () => {
    // The floor is `Math.max`, so it is a no-op wherever the sawtooth already
    // clears one unit. Food's leanest seed-12 stall draws 15 rations a day and
    // sits at 3 even at dusk, so the staple's every reading is the sawtooth's
    // own — which is what keeps the shipped town byte-identical for food.
    const food = run.session.town!.stage.goods.find((g) => g.good.key === "food")!;
    for (const src of food.sources) {
      if (!food.good.shelved.includes(src.kind)) continue;
      const daily = food.stallDaily(src);
      if (!(daily > 0)) continue;
      expect(daily * 0.2).toBeGreaterThan(1); // the dusk trough clears the floor
    }
  });

  it("⑦ the SERVICE-RADIUS INVARIANT is silent for the shipped town", () => {
    // The sentence-maker itself (goods.ts, the scaleWarnings doctrine) — and
    // the proof it is not vacuous is in its own unit test.
    expect(
      streetServiceWarnings(
        run.session.town!.stage.goods,
        run.session.town!.plan.houses,
        serviceRadiusM(run.session.scale, "hunger"),
      ),
    ).toEqual([]);
  });

  it("⑥ the probe is a PURE READ — the stock audit is byte-identical across a full pass", () => {
    const before = JSON.stringify(host().stockAudit());
    for (const m of [0, 1, 2]) {
      for (const key of ["food", "clothing", "water"]) {
        host().needSourceProbe(`resident_${focus}_${m}`, key);
      }
    }
    expect(JSON.stringify(host().stockAudit())).toBe(before);
  });
});
