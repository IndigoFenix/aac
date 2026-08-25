/**
 * ⚖️ THE ONE FOLD, F1 (planning-docs/games/world-engine/fold-round.md) —
 * `kernel/town/fold.ts`'s envelope + dispatch + generic accounting +
 * conservation harness, exercised through the wild codec (`wild-area.ts`,
 * the first kind registered).
 *
 * These pins mirror `wilderness-offload.test.ts`'s own conservation tests
 * ("FOLD conserves every unit" / "EXPAND conserves every unit" / "a whole
 * CYCLE conserves") through the NEW generic dispatch, plus F-④'s minimal v1
 * seat: condense/expand of an unregistered kind refuses, by name.
 *
 * No DOM / GL / session — pure kernel + the wild codec's own module.
 */
import { describe, expect, it } from "@jest/globals";
import {
  condense,
  expand,
  foldDrift,
  foldedStock,
  isFoldRefusal,
  withFoldConservation,
  FOLD_BLOCKERS_SHOWN,
  type FoldBooks,
  type FoldCommitment,
  type FoldRecord,
} from "@shared/world-engine/kernel/town/fold.js";
import { auditScopeTree, wildAreaId } from "@shared/world-engine/kernel/town/scope.js";
import { type StockEndpoint } from "@shared/world-engine/kernel/town/transfer.js";
import {
  wildAreaStock,
  type WildAreaRecord,
  type WildFoldCtx,
} from "@shared/world-engine/interaction/quest/wild-area.js";
import {
  buildWilderness,
  wildFeatureContainerId,
  type WildernessFeature,
} from "@shared/world-engine/interaction/quest/wilderness.js";
import {
  cohortEndpointId,
  cohortRowOf,
  demoteHousehold,
  promoteHousehold,
  type CohortFoldCtx,
  type CohortHouse,
  type CohortRow,
} from "@shared/world-engine/kernel/town/population.js";
import {
  condenseTown,
  stockAbstractPartner,
  stubPartnerSignals,
  townRecordSignals,
  type BarterSignals,
  type PartnerGeography,
  type TownFoldCtx,
  type TownRecord,
} from "@shared/world-engine/kernel/town/barter.js";
import {
  createTransferLedger,
  gatherTransferCommitments,
  townEndpointId,
  type TransferLedger,
} from "@shared/world-engine/kernel/town/transfer.js";
import {
  consumeFoldedReservation,
  createReservationLedger,
  gatherReservationCommitments,
  releaseFoldedReservations,
  releaseReservationCommitments,
  repostReservationCommitments,
  type ReservationLedger,
} from "@shared/world-engine/kernel/town/reservations.js";
import {
  createTaskPool,
  gatherTaskCommitments,
  type TaskPool,
} from "@shared/world-engine/interaction/behavior/task-pool.js";
import type { GoalSpec } from "@shared/world-engine/interaction/behavior/rules.js";

const AREA = { x: 0, y: 0, w: 240, h: 240 };

const sumStocks = (features: readonly WildernessFeature[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const f of features) {
    for (const [g, n] of Object.entries(f.stock)) if (n > 0) out[g] = (out[g] ?? 0) + n;
  }
  return out;
};

const content = buildWilderness({
  seed: 11,
  side: 240,
  mix: [
    { species: "oak", count: 8 },
    { species: "rock", count: 4 },
    { species: "apple_tree", count: 2 },
  ],
});

describe("F1 — condense/expand dispatch through the wild codec", () => {
  it("🚨 CONDENSE conserves every unit — the dispatch, not just the direct call", () => {
    const ctx: WildFoldCtx = { now: 0, features: content.features, area: AREA, seed: 11 };
    const rec = condense<WildAreaRecord>(wildAreaId("home"), ctx);
    expect(isFoldRefusal(rec)).toBe(false);
    if (isFoldRefusal(rec)) throw rec; // narrows for TS below
    expect(rec.kind).toBe("wild");
    expect(rec.id).toBe(wildAreaId("home"));
    expect(rec.at).toBe(0);
    expect(rec.commitments).toEqual([]); // F-④'s seat — no books on this ctx, so nothing rides (F4)
    expect(wildAreaStock(rec.payload)).toEqual(sumStocks(content.features));
  });

  it("🚨 EXPAND conserves every unit — and the placer hook is how a caller gets the features back", () => {
    const condenseCtx: WildFoldCtx = { now: 0, features: content.features, area: AREA, seed: 11 };
    const rec = condense<WildAreaRecord>(wildAreaId("home"), condenseCtx);
    if (isFoldRefusal(rec)) throw rec;
    const placed: WildernessFeature[] = [];
    const expandCtx: WildFoldCtx = { now: 0, area: AREA, seed: 11, place: (f) => placed.push(f) };
    const ids = expand<WildAreaRecord>(rec, expandCtx);
    if (isFoldRefusal(ids)) throw ids;
    expect(ids.length).toBe(content.features.length);
    expect(placed.length).toBe(content.features.length);
    expect(sumStocks(placed)).toEqual(wildAreaStock(rec.payload));
  });

  it("🚨 a whole CYCLE conserves through the dispatch (condense ∘ expand ∘ condense ∘ expand)", () => {
    const condenseCtx1: WildFoldCtx = { now: 0, features: content.features, area: AREA, seed: 11 };
    const rec1 = condense<WildAreaRecord>(wildAreaId("home"), condenseCtx1);
    if (isFoldRefusal(rec1)) throw rec1;
    const once: WildernessFeature[] = [];
    const expandCtx1: WildFoldCtx = { now: 0, area: AREA, seed: 11, place: (f) => once.push(f) };
    const ids1 = expand<WildAreaRecord>(rec1, expandCtx1);
    if (isFoldRefusal(ids1)) throw ids1;

    const condenseCtx2: WildFoldCtx = { now: 0, features: once, area: AREA, seed: 11, prev: null };
    const rec2 = condense<WildAreaRecord>(wildAreaId("home"), condenseCtx2);
    if (isFoldRefusal(rec2)) throw rec2;
    const twice: WildernessFeature[] = [];
    const expandCtx2: WildFoldCtx = { now: 0, area: AREA, seed: 11, place: (f) => twice.push(f) };
    const ids2 = expand<WildAreaRecord>(rec2, expandCtx2);
    if (isFoldRefusal(ids2)) throw ids2;

    expect(sumStocks(twice)).toEqual(sumStocks(content.features));
  });

  it("`foldedStock` sums a registered kind's payloads generically (the audit hand-add's replacement)", () => {
    const ctx: WildFoldCtx = { now: 0, features: content.features, area: AREA, seed: 11 };
    const rec = condense<WildAreaRecord>(wildAreaId("home"), ctx);
    if (isFoldRefusal(rec)) throw rec;
    expect(foldedStock("wild", [rec.payload])).toEqual(sumStocks(content.features));
    // An unregistered kind answers the empty stock, not a crash — a session
    // that has never folded a kind at all still gets a well-formed zero.
    expect(foldedStock("building", [])).toEqual({});
  });

  it("⚖️ F-② — THE CONSERVATION HARNESS: audits a real condense/expand through `auditScopeTree`", () => {
    // A tiny live tree — the wild features, each as an ordinary container
    // endpoint (exactly how `scopeTreeOf` would see them while standing).
    const ep = (id: string, stack: Record<string, number>): StockEndpoint => ({
      id, kind: "container", stack, owner: null,
    });
    let live = new Map(content.features.map((f) => [wildFeatureContainerId(f), { ...f.stock }]));
    let folded: FoldRecord<WildAreaRecord> | null = null;
    const audit = () => {
      const treeInput = {
        ids: () => [...live.keys()],
        endpointOf: (id: string) => (live.has(id) ? ep(id, live.get(id)!) : null),
      };
      const totals = auditScopeTree(treeInput);
      if (folded) {
        for (const [g, n] of Object.entries(foldedStock("wild", [folded.payload]))) {
          totals[g] = (totals[g] ?? 0) + n;
        }
      }
      return totals;
    };

    // CONDENSE: the live stacks empty out, the record appears — must balance.
    withFoldConservation(audit, () => {
      const ctx: WildFoldCtx = {
        now: 0,
        features: content.features,
        liveStock: (id) => live.get(id),
        area: AREA,
        seed: 11,
      };
      const rec = condense<WildAreaRecord>(wildAreaId("home"), ctx);
      if (isFoldRefusal(rec)) throw rec;
      folded = rec;
      live = new Map(); // the trees are not standing any more
    }, "condense(wild:area:home)");

    // EXPAND: the record clears, the live stacks reappear — must balance too.
    withFoldConservation(audit, () => {
      const rec = folded!;
      const ctx: WildFoldCtx = {
        now: 0, area: AREA, seed: 11,
        place: (f) => live.set(wildFeatureContainerId(f), { ...f.stock }),
      };
      const ids = expand<WildAreaRecord>(rec, ctx);
      if (isFoldRefusal(ids)) throw ids;
      folded = null;
    }, "expand(wild:area:home)");

    expect([...live.values()].reduce((tot, s) => {
      for (const [g, n] of Object.entries(s)) if (n > 0) tot[g] = (tot[g] ?? 0) + n;
      return tot;
    }, {} as Record<string, number>)).toEqual(sumStocks(content.features));
  });

  it("`withFoldConservation` throws — loudly — on a drift a codec should never produce", () => {
    const leakyAudit = () => {
      let calls = 0;
      return () => (calls++ === 0 ? { wood: 4 } : { wood: 3 }); // loses one unit
    };
    expect(() => withFoldConservation(leakyAudit(), () => undefined, "a leaky fold")).toThrow(/did not conserve/);
    expect(() => withFoldConservation(leakyAudit(), () => undefined)).toThrow(/wood: Δ-1/);
  });

  it("`foldDrift` is the raw diff `withFoldConservation` throws over", () => {
    expect(foldDrift({ wood: 4, stone: 1 }, { wood: 4, stone: 1 })).toEqual({});
    expect(foldDrift({ wood: 4 }, { wood: 6, apple: 2 })).toEqual({ wood: 2, apple: 2 });
  });
});

describe("F1 — F-④'s minimal v1 seat: an unregistered kind refuses, by name", () => {
  it("condense of a kind with no codec names that kind", () => {
    const result = condense("h_3", { now: 0 }); // a `building` scope id
    expect(isFoldRefusal(result)).toBe(true);
    if (!isFoldRefusal(result)) throw new Error("expected a refusal");
    expect(result.kind).toBe("building");
    expect(result.id).toBe("h_3");
    expect(result.blockers).toEqual([]);
    expect(result.note).toMatch(/building/);
  });

  // 🚨 MOVED PIN (F3). This used to fold a `town` ghost — F3 registers the
  // TOWN codec, so `town` is a claimed kind now and no longer answers the
  // generic "no codec" refusal. Re-aimed at `building`, the kind F2's landing
  // note already recorded as correctly unclaimed (and the kind the condense
  // half of this pair, above, has always used).
  it("expand of a kind with no codec names that kind too", () => {
    const ghost: FoldRecord<unknown> = {
      kind: "building", id: "h_3", at: 0, payload: {}, commitments: [],
    };
    const result = expand(ghost, { now: 0 });
    expect(isFoldRefusal(result)).toBe(true);
    if (!isFoldRefusal(result)) throw new Error("expected a refusal");
    expect(result.kind).toBe("building");
    expect(result.note).toMatch(/building/);
  });

  it("registered kinds (wild) never refuse for lack of a codec — only their own reasons", () => {
    // A `wild` id that is not the AREA form (a standing single tree) is not
    // what this codec folds — it refuses from INSIDE the codec, with its own
    // note, not the generic "no codec" one.
    const ctx: WildFoldCtx = { now: 0, area: AREA, seed: 11 };
    const result = condense("wild:oak_3", ctx);
    expect(isFoldRefusal(result)).toBe(true);
    if (!isFoldRefusal(result)) throw new Error("expected a refusal");
    expect(result.kind).toBe("wild");
    expect(result.note).toMatch(/wild-area/);
  });
});

/**
 * ⚖️ F2 (fold-round.md) — `population.ts`'s cohort codec, the SECOND kind
 * registered. Same three-shape pins F1 pinned for wild (condense/expand/
 * cycle conservation through the generic dispatch), modeled directly on
 * `town-cohorts.test.ts`'s own "totals are conserved across repeated
 * demote/promote cycles" — routed through `condense`/`expand` instead of
 * calling `demoteHousehold`/`promoteHousehold` directly, to prove the
 * dispatch reproduces the direct call byte for byte.
 *
 * 🚨 UNLIKE WILD, a cohort's fold does not move material — the pool's stack
 * is district property that promotion never returns (population.ts's own
 * doc, `promoteHousehold`). So "conserves every unit" here means: condense
 * merges exactly what was handed in, and expand hands back exactly the
 * SOULS that were folded in (never the stack) — see the EXPAND pin below.
 */
describe("F2 — condense/expand dispatch through the cohort codec", () => {
  const DISTRICT = 3;
  const ID = cohortEndpointId(DISTRICT);
  const households: CohortFoldCtx["households"] = [
    { house: { index: 7, members: 5 }, carried: { food: 2, "wood.wet": 1 }, wellbeing: 0.6 },
    { house: { index: 9, members: 4 }, carried: { food: 1 }, wellbeing: 0.4 },
  ];

  /** The direct-call reference: what `demoteHousehold` itself produces for
   *  the same two households, on a fresh `rows` array — the shape the
   *  dispatch pins below must reproduce exactly. */
  const directRow = (): CohortRow => {
    const rows: CohortRow[] = [];
    for (const h of households!) demoteHousehold(rows, DISTRICT, h.house, h.carried, h.wellbeing, 0);
    return cohortRowOf(rows, DISTRICT)!;
  };

  it("🚨 CONDENSE conserves every unit — the dispatch matches the direct call, byte for byte", () => {
    const ctx: CohortFoldCtx = { now: 0, households };
    const rec = condense<CohortRow>(ID, ctx);
    expect(isFoldRefusal(rec)).toBe(false);
    if (isFoldRefusal(rec)) throw rec; // narrows for TS below
    expect(rec.kind).toBe("district");
    expect(rec.id).toBe(ID);
    expect(rec.at).toBe(0);
    expect(rec.commitments).toEqual([]); // F-④'s seat — no books on this ctx, so nothing rides (F4)
    expect(rec.payload).toEqual(directRow());
    expect(rec.payload.pop).toBe(9);
    expect(rec.payload.stack).toEqual({ food: 3, "wood.wet": 1 });
  });

  it("🚨 EXPAND returns exactly the folded households — the stack stays behind (district property)", () => {
    const ctx: CohortFoldCtx = { now: 0, households };
    const rec = condense<CohortRow>(ID, ctx);
    if (isFoldRefusal(rec)) throw rec;
    const placed: { district: number; house: CohortHouse }[] = [];
    const ids = expand<CohortRow>(rec, { now: 0, place: (district, house) => placed.push({ district, house }) });
    if (isFoldRefusal(ids)) throw ids;
    expect(ids.sort()).toEqual(["h_7", "h_9"]);
    expect(placed.sort((a, b) => a.house.index - b.house.index)).toEqual([
      { district: DISTRICT, house: { index: 7, members: 5 } },
      { district: DISTRICT, house: { index: 9, members: 4 } },
    ]);
    // The record itself is untouched — expand reads a CLONE, exactly as
    // wild's does not mutate the `WildAreaRecord` it is handed.
    expect(rec.payload.stack).toEqual({ food: 3, "wood.wet": 1 });
    expect(rec.payload.pop).toBe(9);
  });

  it("🚨 a whole CYCLE conserves through the dispatch — matches population.ts's own repeated demote/promote pin", () => {
    // The direct-call reference this dispatch cycle must reproduce
    // (town-cohorts.test.ts "totals are conserved across repeated
    // demote/promote cycles"), but through condense/expand instead of
    // calling demoteHousehold/promoteHousehold directly.
    const directRows: CohortRow[] = [];
    demoteHousehold(directRows, DISTRICT, { index: 0, members: 5 }, { food: 4 }, 0.7);
    for (let cycle = 0; cycle < 3; cycle++) {
      promoteHousehold(directRows, 0);
      demoteHousehold(directRows, DISTRICT, { index: 0, members: 5 }, {}, 0.7);
    }
    const directTotal = cohortRowOf(directRows, DISTRICT)!;

    // The SAME arc through the generic dispatch: condense the household in,
    // expand it back out — repeat. `expand` is PURE (it reads a clone, never
    // the record itself), so — exactly like `unfoldWildArea` deleting
    // `session.wildAreas.get(key)` after a successful expand — a host stays
    // in sync by applying `promoteHousehold` itself to what `expand` named,
    // which is what computes the next cycle's `prev` here.
    let rec = condense<CohortRow>(ID, {
      now: 0,
      households: [{ house: { index: 0, members: 5 }, carried: { food: 4 }, wellbeing: 0.7 }],
    });
    if (isFoldRefusal(rec)) throw rec;
    for (let cycle = 0; cycle < 3; cycle++) {
      const ids = expand<CohortRow>(rec, { now: 0 });
      if (isFoldRefusal(ids)) throw ids;
      expect(ids).toEqual(["h_0"]);
      const drained: CohortRow[] = [JSON.parse(JSON.stringify(rec.payload)) as CohortRow];
      promoteHousehold(drained, 0);
      rec = condense<CohortRow>(ID, {
        now: 0,
        prev: cohortRowOf(drained, DISTRICT) ?? null,
        households: [{ house: { index: 0, members: 5 }, carried: {}, wellbeing: 0.7 }],
      });
      if (isFoldRefusal(rec)) throw rec;
    }
    expect(rec.payload.pop).toBe(directTotal.pop);
    expect(rec.payload.stack).toEqual(directTotal.stack);
  });

  it("`foldedStock` sums a registered kind's payloads generically", () => {
    const ctx: CohortFoldCtx = { now: 0, households };
    const rec = condense<CohortRow>(ID, ctx);
    if (isFoldRefusal(rec)) throw rec;
    expect(foldedStock("district", [rec.payload])).toEqual({ food: 3, "wood.wet": 1 });
  });

  it("an empty condense (no households, no prior pool) folds to a dormant row", () => {
    const rec = condense<CohortRow>(cohortEndpointId(-1), { now: 0 });
    if (isFoldRefusal(rec)) throw rec;
    expect(rec.payload.pop).toBe(0);
    expect(rec.payload.stack).toEqual({});
    expect(rec.payload.houses).toEqual([]);
  });

  it("the codec's own kind guard refuses a non-district id (unreachable via the dispatcher, exercised directly — same category as wild's own ref.kind check)", async () => {
    const { COHORT_CODEC } = await import("@shared/world-engine/kernel/town/population.js");
    const result = COHORT_CODEC.condense("h_3", { now: 0 });
    expect(isFoldRefusal(result)).toBe(true);
    if (!isFoldRefusal(result)) throw new Error("expected a refusal");
    expect(result.kind).toBe("district");
    expect(result.note).toMatch(/cohort\/district/);
  });
});

/**
 * ⚖️ F3 (fold-round.md) — `barter.ts`'s TOWN codec, the THIRD kind registered
 * and the one law F-⑤ is about: *"a stub is a never-expanded town"*. The same
 * three shapes F1/F2 pinned (condense / expand / cycle through the generic
 * dispatch), plus the two contracts F3 adds:
 *
 *   • ⚖️ F-③ THE INTEGRAL AT THE FOLD — `condense`'s `floors` mint IS
 *     `stockAbstractPartner`, byte for byte, into the SAME live shelf object
 *     (the one `TownDeltas.partnerStock` persists and the `town:<key>`
 *     endpoint aliases).
 *   • ⚖️ F-⑤ ONE SHORTAGE READING — `townRecordSignals` off the record
 *     reproduces the pre-F3 host construction EXACTLY for a never-expanded
 *     town, and answers with the BOOKS for a town that has run. The
 *     bit-identity comparison below is the ⑧ pattern: the old reading
 *     reimplemented verbatim, asserted `toBe`-equal to the new one across a
 *     fixture grid.
 *
 * 🚨 NOT AN AUDIT HAND-ADD. Unlike wild (whose folded areas are invisible to
 * the tree), a condensed town's shelf is ALWAYS a live StockEndpoint, so
 * `foldedStock("town", …)` must never be added to a session audit — the
 * `stockOf` pin below is the codec's contract, not a session's.
 */
describe("F3 — condense/expand dispatch through the town codec", () => {
  const KEY = "away:12";
  const ID = townEndpointId(KEY);
  const GEO: PartnerGeography = { node: "surplus", farmland: 240 };

  /** A never-expanded town's record, over a given shelf. */
  const freshRecord = (stack: Record<string, number> = {}, geo: PartnerGeography | null = null) =>
    condenseTown({ key: KEY, stack, geo, at: null, distanceM: null });

  it("🚨 CONDENSE of a never-expanded town: the shelf is the payload, and `floors` is the only thing that mints", () => {
    const shelf: Record<string, number> = { food: 2 };
    const rec = condense<TownRecord>(ID, {
      now: 30,
      prev: freshRecord(shelf, GEO),
      floors: { food: 9, wood: 3 },
    } satisfies TownFoldCtx);
    expect(isFoldRefusal(rec)).toBe(false);
    if (isFoldRefusal(rec)) throw rec; // narrows for TS below
    expect(rec.kind).toBe("town");
    expect(rec.id).toBe(ID);
    expect(rec.at).toBe(30);
    expect(rec.commitments).toEqual([]); // F-④'s seat — no books on this ctx, so nothing rides (F4)
    expect(rec.payload.key).toBe(KEY);
    expect(rec.payload.geo).toEqual(GEO); // `prev` carries the closed form forward
    expect(rec.payload.shortages).toBeNull(); // never expanded ⇒ no books to carry
    // ⚖️ F-③: topped UP to each floor, never beyond and never down.
    expect(rec.payload.stack).toEqual({ food: 9, wood: 3 });
    // …and IN PLACE: the payload IS the live shelf, not a copy of it.
    expect(rec.payload.stack).toBe(shelf);
  });

  it("🚨 the mint IS `stockAbstractPartner` — byte for byte against the direct call, and it reports what it added", () => {
    const viaFold: Record<string, number> = { food: 4, wood: 1 };
    const direct: Record<string, number> = { food: 4, wood: 1 };
    const minted: Array<[string, number]> = [];
    condenseTown({
      key: KEY,
      stack: viaFold,
      floors: { food: 9, wood: 3, stone: 2 },
      minted: (good, units) => minted.push([good, units]),
    });
    // The pre-F3 host line, verbatim: one `stockAbstractPartner` per good.
    const directMints: Array<[string, number]> = [];
    for (const [good, floor] of Object.entries({ food: 9, wood: 3, stone: 2 })) {
      const n = stockAbstractPartner(direct, good, floor);
      if (n > 0) directMints.push([good, n]);
    }
    expect(viaFold).toEqual(direct);
    expect(minted).toEqual(directMints);
    expect(minted).toEqual([["food", 5], ["wood", 2], ["stone", 2]]);
    // A shelf already at/above the floor mints NOTHING — the epoch bump the
    // host hangs off this must not fire on every due row (§2.5.1).
    const quiet: Array<[string, number]> = [];
    condenseTown({ key: KEY, stack: viaFold, floors: { food: 9 }, minted: (g, n) => quiet.push([g, n]) });
    expect(quiet).toEqual([]);
    expect(stockAbstractPartner({ ...viaFold }, "food", 9)).toBe(0);
  });

  it("🚨 EXPAND hands the shelf back and names the town — and a whole CYCLE conserves", () => {
    const shelf = { food: 9, wood: 3 };
    const rec = condense<TownRecord>(ID, { now: 0, prev: freshRecord(shelf) } satisfies TownFoldCtx);
    if (isFoldRefusal(rec)) throw rec;
    const placed: Array<{ key: string; stack: Record<string, number> }> = [];
    const ids = expand<TownRecord>(rec, { now: 0, place: (key, stack) => placed.push({ key, stack }) });
    if (isFoldRefusal(ids)) throw ids;
    expect(ids).toEqual([ID]);
    expect(placed).toEqual([{ key: KEY, stack: shelf }]);
    // ⚖️ F-① nothing evaporates: what the placer got is exactly what the record
    // held, and re-condensing it (no floors ⇒ no mint) is the same shelf again.
    const again = condense<TownRecord>(ID, { now: 0, stack: placed[0]!.stack } satisfies TownFoldCtx);
    if (isFoldRefusal(again)) throw again;
    expect(again.payload.stack).toEqual(shelf);
    expect(foldedStock("town", [again.payload])).toEqual(shelf);
  });

  it("`foldedStock` sums a registered kind's payloads generically (zeroes dropped, as every codec's `stockOf` does)", () => {
    const rec = condense<TownRecord>(ID, { now: 0, stack: { food: 9, wood: 0 } } satisfies TownFoldCtx);
    if (isFoldRefusal(rec)) throw rec;
    expect(foldedStock("town", [rec.payload])).toEqual({ food: 9 });
  });

  it("🚨 F-⑤ BIT-IDENTITY — the record's shortage reading IS the pre-F3 stub construction, exactly", () => {
    // THE OLD READING, REIMPLEMENTED VERBATIM: the two closures
    // `tradePartnersOf` built for a stub before F3 (`signals` at today,
    // `signalsAtDay` at any day).
    const preF3 = (key: string, day: number, geo: PartnerGeography | null) => ({
      signals: stubPartnerSignals(key, Math.floor(day), geo) as BarterSignals,
      signalsAtDay: (d: number) => stubPartnerSignals(key, Math.floor(d), geo),
    });
    const keys = ["away:12", "city:14", "hamlet-1", "away:oakford"];
    const geos: Array<PartnerGeography | null> = [
      null,
      { node: "extraction", ore: 80 },
      { node: "surplus", farmland: 240 },
      { farmland: 0 },
    ];
    const goods = ["food", "wood", "stone", "cookie", "metal"];
    const days = [0, 0.4, 1, 3.75, 6, 9, 12, 15, 16, 40.2];
    let compared = 0;
    for (const key of keys) {
      for (const geo of geos) {
        const rec = condenseTown({ key, stack: {}, geo });
        for (const day of days) {
          const old = preF3(key, day, geo);
          const now = townRecordSignals(rec, day);
          for (const good of goods) {
            // `toBe`, not `toBeCloseTo`: the same IEEE-754 double, or the fork
            // did not dissolve.
            expect(now.shortage(good)).toBe(old.signals.shortage(good));
            expect(townRecordSignals(rec, day + 5).shortage(good)).toBe(
              old.signalsAtDay(day + 5).shortage(good),
            );
            compared += 2;
          }
        }
      }
    }
    expect(compared).toBe(keys.length * geos.length * days.length * goods.length * 2);
  });

  it("⚖️ F-③ — a town that HAS run folds with its BOOKS' reading, never a hash", () => {
    const books: Record<string, number> = { food: 0.8, wood: 0.1 };
    const rec = condenseTown({
      key: KEY,
      stack: { food: 3 },
      goods: ["food", "wood"],
      shortageOf: (good) => books[good] ?? 0,
    });
    expect(rec.shortages).toEqual({ food: 0.8, wood: 0.1 });
    const read = townRecordSignals(rec, 7);
    expect(read.shortage("food")).toBe(0.8);
    expect(read.shortage("wood")).toBe(0.1);
    // A good the books had no fill for reads 0 — exactly what a books read of
    // an unlisted good answers, and NOT the closed form's hash.
    expect(read.shortage("stone")).toBe(0);
    expect(read.shortage("stone")).not.toBe(stubPartnerSignals(KEY, 7, null).shortage("stone"));
    // …and the reading does not drift with the day: a snapshot is a snapshot.
    expect(townRecordSignals(rec, 99).shortage("food")).toBe(0.8);
  });

  it("the codec refuses what is not a partner town, by name — our own root, our own yard, another kind", async () => {
    const { TOWN_CODEC } = await import("@shared/world-engine/kernel/town/barter.js");
    const local = condense("town", { now: 0 }); // TOWN_SCOPE — the town we ARE
    expect(isFoldRefusal(local)).toBe(true);
    if (!isFoldRefusal(local)) throw new Error("expected a refusal");
    expect(local.kind).toBe("town");
    expect(local.blockers).toEqual(["local"]);
    const yard = condense("town:yard", { now: 0 });
    if (!isFoldRefusal(yard)) throw new Error("expected a refusal");
    expect(yard.blockers).toEqual(["yard"]);
    expect(yard.note).toMatch(/yard/);
    // Unreachable through the dispatcher (which routes by kind), exercised
    // directly — the same category as wild's and cohort's own kind guards.
    const wrong = TOWN_CODEC.condense("h_3", { now: 0 });
    if (!isFoldRefusal(wrong)) throw new Error("expected a refusal");
    expect(wrong.note).toMatch(/not a town id/);
  });
});

/**
 * ⚖️ F4 (fold-round.md) — THE COMMITMENT INTERFACE, law F-④: *"PROMISES
 * SURVIVE OR THE FOLD REFUSES."* v1's honest floor, and the forcing round for
 * scope-unification.md's worklist ① (the three forward books — TaskPool books
 * HANDS, TransferLedger books LEGS, ReservationLedger books STOCK — read
 * through ONE `FoldCommitment` shape, with no base class over their
 * internals):
 *
 *   · HANDS and LEGS in flight ⇒ `condense` REFUSES, blockers named and
 *     capped exactly as the clock-warp's law-③ refusal caps its bodies.
 *   · STOCK ⇒ FOLDS THROUGH: the rows move onto `record.commitments`, leave
 *     the live ledger, and come back verbatim at `expand` — `reservedUnits`
 *     before == after across a full cycle.
 *   · A holder may still consume/release its promise MID-FOLD, against the
 *     record (the reservation book is pure bookkeeping, so the arithmetic is
 *     the same one the ledger would have run).
 *
 * The subject is the TOWN codec (F3's kind) because that is where the one
 * LIVE `condense` call site lives — quest-host's `mintCondensedShelf` — and
 * the last pins below are that call site's exact ctx, proving F4 added no
 * refusal to it.
 */
describe("F4 — F-④: promises survive or the fold refuses", () => {
  const KEY = "away:12";
  const ID = townEndpointId(KEY);
  const YARD = "town:yard";
  const FETCH_WOOD: GoalSpec = { kind: "fetch", item: { match: { kind: "wood" } } };
  const FOCUS = { x: 0, y: 0, radius: 10 };

  /** The ctx seam a host composes from the three books' own gather functions
   *  — the composition `fold.ts` deliberately does NOT own (it never imports
   *  a book; it reads `FoldCommitment.book` and nothing else). */
  const booksOf = (b: {
    tasks?: TaskPool;
    transfers?: TransferLedger;
    stock?: ReservationLedger;
  }): FoldBooks => ({
    gather: (scope) => [
      ...(b.tasks ? gatherTaskCommitments(b.tasks, scope) : []),
      ...(b.transfers ? gatherTransferCommitments(b.transfers, scope) : []),
      ...(b.stock ? gatherReservationCommitments(b.stock, scope) : []),
    ],
    ...(b.stock
      ? {
          release: (cs: readonly FoldCommitment[]) => {
            releaseReservationCommitments(b.stock!, cs);
          },
          repost: (cs: readonly FoldCommitment[]) => {
            repostReservationCommitments(b.stock!, cs);
          },
        }
      : {}),
  });

  const townCtx = (over: Partial<TownFoldCtx> = {}): TownFoldCtx =>
    ({ now: 0, endpoints: [ID], ...over }) as TownFoldCtx;

  // ── HANDS ────────────────────────────────────────────────────────────────

  it("🚨 HANDS IN FLIGHT — condense refuses, naming the task, and the codec never ran", () => {
    const tasks = createTaskPool();
    const t = tasks.post({
      goal: FETCH_WOOD, issuer: ID, focus: FOCUS, now: 0, sourceGlyph: "get + wood",
    });
    const shelf: Record<string, number> = { food: 2 };
    const out = condense<TownRecord>(
      ID,
      townCtx({ stack: shelf, floors: { food: 9 }, books: booksOf({ tasks }) }),
    );
    expect(isFoldRefusal(out)).toBe(true);
    if (!isFoldRefusal(out)) throw new Error("expected a refusal");
    expect(out.kind).toBe("town");
    expect(out.id).toBe(ID);
    expect(out.blockers).toEqual([t.id]);
    expect(out.blocked).toBe(1);
    expect(out.note).toMatch(/task/);
    expect(out.note).toContain(t.id);
    // 🚨 THE GUARD IS PRE-DISPATCH. `condense` of a town MUTATES (F-③'s mint
    // tops the live shelf up to `floors`), so a refused fold must not have
    // half-happened: the shelf is exactly what it was.
    expect(shelf).toEqual({ food: 2 });
  });

  it("an OPEN task blocks as surely as a claimed one — a promise nobody took is still owed", () => {
    const tasks = createTaskPool();
    const open = tasks.post({ goal: FETCH_WOOD, issuer: ID, focus: FOCUS, now: 0 });
    const claimed = tasks.post({ goal: FETCH_WOOD, issuer: ID, focus: FOCUS, now: 0 });
    tasks.claim(claimed.id, "wolf_1");
    const out = condense<TownRecord>(ID, townCtx({ stack: {}, books: booksOf({ tasks }) }));
    if (!isFoldRefusal(out)) throw new Error("expected a refusal");
    // open rows first, then claimed — the gather's documented order.
    expect(out.blockers).toEqual([open.id, claimed.id]);
    // …and a task that is DONE or EXPIRED is history: it blocks nothing.
    tasks.complete(claimed.id);
    tasks.expire(1e9);
    const clear = condense<TownRecord>(ID, townCtx({ stack: {}, books: booksOf({ tasks }) }));
    if (isFoldRefusal(clear)) throw clear;
    expect(clear.commitments).toEqual([]);
  });

  it("the hands gather matches a task held BY the scope, not only one issued against it", () => {
    const tasks = createTaskPool();
    const mine = tasks.post({ goal: FETCH_WOOD, issuer: "__player__", focus: FOCUS, now: 0 });
    tasks.claim(mine.id, "wolf_1");
    const later = tasks.post({ goal: FETCH_WOOD, issuer: "__player__", focus: FOCUS, now: 0 });
    expect(gatherTaskCommitments(tasks, { id: "wolf_1", endpoints: [] })).toEqual([
      { book: "task", id: mine.id, holder: "wolf_1", against: "__player__", payload: { status: "claimed" } },
    ]);
    // An unclaimed task's holder is its ISSUER — nobody has taken it, so the
    // issuer still carries it. Order: open rows, then claimed.
    expect(
      gatherTaskCommitments(tasks, { id: "__player__", endpoints: [] }).map((c) => [c.id, c.holder]),
    ).toEqual([
      [later.id, "__player__"],
      [mine.id, "wolf_1"],
    ]);
  });

  // ── LEGS ─────────────────────────────────────────────────────────────────

  it("🚨 LEGS IN FLIGHT — condense refuses, naming the transfer that touches the scope", () => {
    // 🚨 MOVED PIN (F5). This used to post a STANDING SCHEDULED row to the
    // partner's shelf, with the seam it exposed recorded right here: quest-host
    // posts barter rows whose far endpoint IS `town:<partnerKey>` and a standing
    // one sits `pending` between legs forever, so wiring the books into
    // `mintCondensedShelf` as F4 shipped would have refused every partner with a
    // trade order. F5 ANSWERED IT — that row is now SERVICED by the condensed
    // form (the split, pinned in the F5 describe at the bottom of this file) and
    // no longer blocks. Re-aimed at the leg that still does and always will: a
    // `haul` — a body's job, waiting for hands, which no record stands in for.
    // F4's law is unchanged for it, blockers, cap and note included.
    const transfers = createTransferLedger();
    const a = transfers.post({
      from: YARD, to: ID, goods: { wood: 3 }, issuer: "__player__",
      mode: "haul", now: 0,
    });
    const out = condense<TownRecord>(ID, townCtx({ stack: {}, books: booksOf({ transfers }) }));
    if (!isFoldRefusal(out)) throw new Error("expected a refusal");
    expect(out.blockers).toEqual([a.id]);
    expect(out.blocked).toBe(1);
    expect(out.note).toMatch(/transfer/);
    // …and a TERMINAL row blocks nothing — history is not a promise.
    transfers.complete(a.id);
    const clear = condense<TownRecord>(ID, townCtx({ stack: {}, books: booksOf({ transfers }) }));
    if (isFoldRefusal(clear)) throw clear;
    expect(clear.commitments).toEqual([]);
  });

  it("the legs gather names the touched endpoint as `against`, and the executor as `holder`", () => {
    const transfers = createTransferLedger();
    const out = transfers.post({
      from: ID, to: YARD, goods: { food: 2 }, issuer: "__player__", mode: "haul", now: 0,
    });
    transfers.begin(out.id, "wolf_1");
    transfers.post({ from: YARD, to: "h_3", goods: { food: 1 }, issuer: "__player__", mode: "haul", now: 0 });
    expect(gatherTransferCommitments(transfers, { id: ID, endpoints: [] })).toEqual([
      { book: "transfer", id: out.id, holder: "wolf_1", against: ID, payload: { status: "moving", mode: "haul" } },
    ]);
  });

  it("blockers are CAPPED at FOLD_BLOCKERS_SHOWN, with the true count in `blocked` (the warp's own shape)", () => {
    const tasks = createTaskPool();
    const posted = Array.from({ length: FOLD_BLOCKERS_SHOWN + 2 }, () =>
      tasks.post({ goal: FETCH_WOOD, issuer: ID, focus: FOCUS, now: 0 }),
    );
    const out = condense<TownRecord>(ID, townCtx({ stack: {}, books: booksOf({ tasks }) }));
    if (!isFoldRefusal(out)) throw new Error("expected a refusal");
    expect(out.blockers).toHaveLength(FOLD_BLOCKERS_SHOWN);
    expect(out.blockers).toEqual(posted.slice(0, FOLD_BLOCKERS_SHOWN).map((t) => t.id));
    expect(out.blocked).toBe(posted.length);
    expect(out.note).toMatch(/and 2 more/);
  });

  // ── STOCK: the one that rides ────────────────────────────────────────────

  it("🚨 STOCK FOLDS THROUGH — the rows ride the record, and `reservedUnits` conserves across a whole cycle", () => {
    const stock = createReservationLedger();
    stock.reserve("agr_7", ID, "wood", 3);
    stock.reserve("need:cid_2", ID, "food", 2);
    stock.reserve("agr_9", YARD, "wood", 5); // ANOTHER scope's promise
    const before = {
      wood: stock.reservedUnits(ID, "wood"),
      food: stock.reservedUnits(ID, "food"),
      elsewhere: stock.reservedUnits(YARD, "wood"),
    };
    expect(before).toEqual({ wood: 3, food: 2, elsewhere: 5 });

    const books = booksOf({ stock });
    const rec = condense<TownRecord>(ID, townCtx({ stack: { food: 9 }, books }));
    if (isFoldRefusal(rec)) throw rec;
    // The promises RODE — and only this scope's.
    expect(rec.commitments).toEqual([
      { book: "reservation", id: "res_0", holder: "agr_7", against: ID, payload: { glyph: "wood", qty: 3 } },
      { book: "reservation", id: "res_1", holder: "need:cid_2", against: ID, payload: { glyph: "food", qty: 2 } },
    ]);
    // …and LEFT the live book, or they would be double-booked.
    expect(stock.reservedUnits(ID, "wood")).toBe(0);
    expect(stock.reservedUnits(ID, "food")).toBe(0);
    expect(stock.reservedUnits(YARD, "wood")).toBe(before.elsewhere); // surgical
    // ⚖️ NO WAKE: a fold frees nothing for anybody else's job, so the town's
    // release signal must not tick (`release(holder)` would have ticked it).
    expect(stock.releaseEpoch()).toBe(0);

    const ids = expand<TownRecord>(rec, { now: 0, books } satisfies TownFoldCtx);
    if (isFoldRefusal(ids)) throw ids;
    expect(ids).toEqual([ID]);
    // 🚨 CONSERVATION: before == after, per endpoint and per head.
    expect(stock.reservedUnits(ID, "wood")).toBe(before.wood);
    expect(stock.reservedUnits(ID, "food")).toBe(before.food);
    expect(stock.reservedUnits(YARD, "wood")).toBe(before.elsewhere);
    // Verbatim in everything a caller reads off a row (holder/endpoint/glyph/
    // qty); the row ID is re-minted, which is the section header's disclosure.
    expect(stock.holderRows("agr_7")).toEqual([
      { id: expect.any(String), holder: "agr_7", endpoint: ID, glyph: "wood", qty: 3 },
    ]);
  });

  it("a folded holder that already speaks for the same head MERGES on re-post, exactly as `reserve` would", () => {
    const stock = createReservationLedger();
    stock.reserve("agr_7", ID, "wood", 3);
    const books = booksOf({ stock });
    const rec = condense<TownRecord>(ID, townCtx({ stack: {}, books }));
    if (isFoldRefusal(rec)) throw rec;
    stock.reserve("agr_7", ID, "wood", 1); // spoken for again while folded
    const ids = expand<TownRecord>(rec, { now: 0, books } satisfies TownFoldCtx);
    if (isFoldRefusal(ids)) throw ids;
    expect(stock.holderRows("agr_7")).toHaveLength(1);
    expect(stock.reservedUnits(ID, "wood")).toBe(4);
  });

  it("expand REFUSES to drop folded commitments when this ctx has no book to re-post them to", () => {
    const stock = createReservationLedger();
    stock.reserve("agr_7", ID, "wood", 3);
    const rec = condense<TownRecord>(ID, townCtx({ stack: {}, books: booksOf({ stock }) }));
    if (isFoldRefusal(rec)) throw rec;
    const out = expand<TownRecord>(rec, { now: 0 } satisfies TownFoldCtx);
    expect(isFoldRefusal(out)).toBe(true);
    if (!isFoldRefusal(out)) throw new Error("expected a refusal");
    expect(out.blockers).toEqual(["res_0"]);
    expect(out.blocked).toBe(1);
    expect(out.note).toMatch(/never dropped/);
    // The record still holds them — a refusal changes nothing.
    expect(rec.commitments).toHaveLength(1);
  });

  // ── consume / release AGAINST a condensed scope ───────────────────────────

  it("🚨 the holder may still CONSUME its folded reservation — record-backed, the same arithmetic the ledger runs", () => {
    const stock = createReservationLedger();
    stock.reserve("agr_7", ID, "wood", 3);
    stock.reserve("need:cid_2", ID, "food", 2);
    const books = booksOf({ stock });
    const rec = condense<TownRecord>(ID, townCtx({ stack: {}, books }));
    if (isFoldRefusal(rec)) throw rec;

    // THE BIT-IDENTITY CHECK: a live ledger holding the same row, consumed the
    // same way, answers the same numbers — which is why this is record-backed
    // arithmetic and not a refusal (`consume` never touches a stack, so there
    // is no folded quantity to consult and no fiction to invent).
    const live = createReservationLedger();
    live.reserve("agr_7", ID, "wood", 3);
    expect(consumeFoldedReservation(rec, "agr_7", ID, "wood", 1)).toBe(live.consume("agr_7", ID, "wood", 1));
    expect(rec.commitments[0]!.payload).toEqual({ glyph: "wood", qty: 2 });
    // Over-consume CLAMPS and the commitment vanishes at 0, exactly as a row does.
    expect(consumeFoldedReservation(rec, "agr_7", ID, "wood", 9)).toBe(live.consume("agr_7", ID, "wood", 9));
    expect(rec.commitments.map((c) => c.id)).toEqual(["res_1"]);
    // A facted glyph pays toward its HEAD — the ledger's own convention.
    expect(consumeFoldedReservation(rec, "need:cid_2", ID, "food.stale", 1)).toBe(1);
    // Nothing spoken for ⇒ 0, the same honest answer the live ledger gives —
    // findable and named, never a throw and never a silent drop.
    expect(consumeFoldedReservation(rec, "nobody", ID, "wood", 1)).toBe(0);

    // …and expand re-posts only what is LEFT: consumption survived the fold.
    const ids = expand<TownRecord>(rec, { now: 0, books } satisfies TownFoldCtx);
    if (isFoldRefusal(ids)) throw ids;
    expect(stock.reservedUnits(ID, "wood")).toBe(0);
    expect(stock.reservedUnits(ID, "food")).toBe(1);
  });

  it("🚨 the holder may still RELEASE mid-fold — or a cancelled order would ride out of the fold as a lie", () => {
    const stock = createReservationLedger();
    stock.reserve("agr_7", ID, "wood", 3);
    stock.reserve("agr_7", ID, "food", 1);
    stock.reserve("need:cid_2", ID, "food", 2);
    const books = booksOf({ stock });
    const rec = condense<TownRecord>(ID, townCtx({ stack: {}, books }));
    if (isFoldRefusal(rec)) throw rec;
    expect(releaseFoldedReservations(rec, "agr_7")).toBe(4); // every head it spoke for
    expect(releaseFoldedReservations(rec, "agr_7")).toBe(0); // no residue
    expect(rec.commitments.map((c) => c.holder)).toEqual(["need:cid_2"]);
    const ids = expand<TownRecord>(rec, { now: 0, books } satisfies TownFoldCtx);
    if (isFoldRefusal(ids)) throw ids;
    expect(stock.reservedUnits(ID, "wood")).toBe(0);
    expect(stock.reservedUnits(ID, "food")).toBe(2);
    expect(stock.holderRows("agr_7")).toEqual([]);
  });

  it("the stock gather finds a row against a non-endpoint id, and one held BY the scope", () => {
    const stock = createReservationLedger();
    stock.reserve("basket_4", "bench_1", "@tool", 1); // a TOOL CLAIM rides the same rows
    expect(gatherReservationCommitments(stock, { id: "bench_1", endpoints: [] })).toEqual([
      { book: "reservation", id: "res_0", holder: "basket_4", against: "bench_1", payload: { glyph: "@tool", qty: 1 } },
    ]);
    // …and by HOLDER, the rarer half of "held BY it or AGAINST it".
    expect(
      gatherReservationCommitments(stock, { id: "basket_4", endpoints: [] }).map((c) => c.id),
    ).toEqual(["res_0"]);
  });

  // ── the live call site ───────────────────────────────────────────────────

  it("🚨 F3's MINT PATH is untouched — a never-run town condenses commitment-free, and cannot refuse", () => {
    // THE LIVE CTX, verbatim from quest-host's `mintCondensedShelf`: `now`,
    // `prev`, `floors`, an optional `minted` — and NO `books`/`endpoints`,
    // because that call site has no seam to reach them through. With no books
    // the guard has nothing to ask, so F4 cannot have added a refusal to it.
    const shelf: Record<string, number> = { food: 2 };
    const prev = condenseTown({ key: KEY, stack: shelf, geo: null, at: null, distanceM: null });
    const rec = condense<TownRecord>(ID, { now: 30, prev, floors: { food: 9 } } satisfies TownFoldCtx);
    if (isFoldRefusal(rec)) throw rec;
    expect(rec.commitments).toEqual([]);
    expect(rec.payload.stack).toEqual({ food: 9 }); // F-③'s mint, as before
    expect(rec.payload.stack).toBe(shelf);

    // And WITH the books wired: a never-run town has nothing booked against it
    // BY CONSTRUCTION — nobody has hauled to, claimed against or reserved on a
    // shelf that has never been touched — so the answer is the same record.
    const empty = booksOf({
      tasks: createTaskPool(),
      transfers: createTransferLedger(),
      stock: createReservationLedger(),
    });
    const shelf2: Record<string, number> = { food: 2 };
    const wired = condense<TownRecord>(
      ID,
      { now: 30, endpoints: [ID], stack: shelf2, floors: { food: 9 }, books: empty } satisfies TownFoldCtx,
    );
    if (isFoldRefusal(wired)) throw wired;
    expect(wired.commitments).toEqual([]);
    expect(wired.payload.stack).toEqual({ food: 9 });
  });

  it("no books on the ctx ⇒ the guard is inert for every kind — F1/F2's own pins, restated as the compat law", () => {
    const wild = condense<WildAreaRecord>(wildAreaId("home"), {
      now: 0, features: content.features, area: AREA, seed: 11,
    } satisfies WildFoldCtx);
    if (isFoldRefusal(wild)) throw wild;
    expect(wild.commitments).toEqual([]);
    const cohort = condense<CohortRow>(cohortEndpointId(3), { now: 0 } satisfies CohortFoldCtx);
    if (isFoldRefusal(cohort)) throw cohort;
    expect(cohort.commitments).toEqual([]);
  });
});

/**
 * ⚖️ F5 (fold-round.md) — F-④'s SERVICEABILITY SPLIT, and the death of F4's
 * 🔶 finding: *"partner shelf endpoints ARE the from/to of standing trade legs
 * sitting pending between caravan visits — wiring books into the mint as-is
 * would refuse every trading partner."*
 *
 * THE ANSWER, pinned in both directions: a promise the CLOSED FORM CAN KEEP
 * neither blocks the fold nor rides it — a standing scheduled leg stays in its
 * own book, because the arms that run it read that book and ship against the
 * condensed partner's shelf (quest-host `stepBarters`/`stepLedgerSweeps`: they
 * mint and execute when `p.record` is set, i.e. exactly while the partner is
 * folded, and the clock warp settles whole days of those legs with nobody
 * embodied anywhere). A promise it cannot keep — a claimed pair of hands,
 * goods already moving — refuses exactly as F4 shipped.
 */
describe("F5 — F-④'s serviceability split: promises the closed form CAN keep", () => {
  const KEY = "away:12";
  const ID = townEndpointId(KEY);
  const YARD = "town:yard";
  const FETCH_WOOD: GoalSpec = { kind: "fetch", item: { match: { kind: "wood" } } };
  const FOCUS = { x: 0, y: 0, radius: 10 };

  /** Hands + legs behind one gather, and NOTHING else: the mint's own wiring
   *  (quest-host `sessionFoldBooks`), which releases nothing because a top-up
   *  moves no scope between states. */
  const booksOf = (b: { tasks?: TaskPool; transfers?: TransferLedger }): FoldBooks => ({
    gather: (scope) => [
      ...(b.tasks ? gatherTaskCommitments(b.tasks, scope) : []),
      ...(b.transfers ? gatherTransferCommitments(b.transfers, scope) : []),
    ],
  });

  /** THE SHAPE THE FINDING NAMED: a standing route from our yard to the
   *  partner's shelf, scheduled, sitting `pending` between visits forever. */
  const standingLeg = (transfers: TransferLedger, to = ID) =>
    transfers.post({
      from: YARD, to, goods: { wood: 3 }, issuer: "__player__",
      mode: "scheduled", now: 0, every: 100,
      barter: {
        take: { food: 2 }, giveGood: "wood", takeGood: "food",
        quote: { give: 3, take: 2 }, partnerKey: KEY,
      },
    });

  it("🚨 A STANDING LEG DOES NOT BLOCK — the fold happens, the leg is SERVICED, and it never left its book", () => {
    const transfers = createTransferLedger();
    const leg = standingLeg(transfers);
    const shelf: Record<string, number> = { food: 2 };
    const rec = condense<TownRecord>(ID, {
      now: 30,
      endpoints: [ID],
      stack: shelf,
      floors: { food: 9 },
      books: booksOf({ transfers }),
    } satisfies TownFoldCtx);
    if (isFoldRefusal(rec)) throw new Error(`expected a fold, got: ${rec.note}`);
    // The promise is DISCLOSED, not carried: `commitments` is what rode away
    // (nothing did), `serviced` is what the record is now answerable for.
    expect(rec.commitments).toEqual([]);
    expect(rec.serviced?.map((c) => [c.book, c.id, c.against])).toEqual([
      ["transfer", leg.id, ID],
    ]);
    // 🚨 AND IT IS STILL IN THE LEDGER — the arms that service it read THERE.
    // A serviced row that had been "folded through" would have stopped the
    // very caravan the split exists to keep running.
    expect(transfers.active().map((a) => a.id)).toEqual([leg.id]);
    // …and the codec RAN: F-③'s mint topped the live shelf up in place.
    expect(rec.payload.stack).toEqual({ food: 9 });
    expect(rec.payload.stack).toBe(shelf);
  });

  it("🚨 …AND A CLAIMED TASK STILL REFUSES — F4's floor is intact underneath the split", () => {
    const tasks = createTaskPool();
    const transfers = createTransferLedger();
    standingLeg(transfers); // serviced — and therefore NOT among the blockers
    const t = tasks.post({ goal: FETCH_WOOD, issuer: ID, focus: FOCUS, now: 0 });
    tasks.claim(t.id, "wolf_1");
    const shelf: Record<string, number> = { food: 2 };
    const out = condense<TownRecord>(ID, {
      now: 0, endpoints: [ID], stack: shelf, floors: { food: 9 },
      books: booksOf({ tasks, transfers }),
    } satisfies TownFoldCtx);
    if (!isFoldRefusal(out)) throw new Error("expected a refusal");
    expect(out.blockers).toEqual([t.id]); // the leg is not a blocker
    expect(out.blocked).toBe(1);
    expect(out.note).toMatch(/task/);
    expect(out.note).not.toMatch(/transfer/);
    // The guard is still PRE-DISPATCH: a refused fold has not half-happened.
    expect(shelf).toEqual({ food: 2 });
  });

  it("a MOVING load refuses, and so does a leg waiting for a body to walk it", () => {
    const moving = createTransferLedger();
    const load = moving.post({
      from: ID, to: YARD, goods: { food: 2 }, issuer: "__player__", mode: "haul", now: 0,
    });
    moving.begin(load.id, "wolf_1");
    const a = condense<TownRecord>(ID, {
      now: 0, endpoints: [ID], stack: {}, books: booksOf({ transfers: moving }),
    } satisfies TownFoldCtx);
    if (!isFoldRefusal(a)) throw new Error("expected a refusal");
    expect(a.blockers).toEqual([load.id]);
    // A `haul` row nobody has begun is still a body's job, pending or not.
    const waiting = createTransferLedger();
    const owed = waiting.post({
      from: ID, to: YARD, goods: { food: 2 }, issuer: "__player__", mode: "haul", now: 0,
    });
    const b = condense<TownRecord>(ID, {
      now: 0, endpoints: [ID], stack: {}, books: booksOf({ transfers: waiting }),
    } satisfies TownFoldCtx);
    if (!isFoldRefusal(b)) throw new Error("expected a refusal");
    expect(b.blockers).toEqual([owed.id]);
  });

  it("a leg against an endpoint the scope merely ANSWERS FOR is not serviced — the record stands in for the shelf, not for what hangs off it", () => {
    // The shelf's own id is what the closed form keeps trading through; a
    // sibling endpoint the fold also answers for stops existing at the fold,
    // so a leg booked against THAT is a promise nothing is left to keep.
    const transfers = createTransferLedger();
    const leg = standingLeg(transfers, `depot:${KEY}`);
    const out = condense<TownRecord>(ID, {
      now: 0, endpoints: [ID, `depot:${KEY}`], stack: {},
      books: booksOf({ transfers }),
    } satisfies TownFoldCtx);
    if (!isFoldRefusal(out)) throw new Error("expected a refusal");
    expect(out.blockers).toEqual([leg.id]);
  });

  it("a codec with no `services` is F4 exactly — a standing leg against a cohort still refuses", () => {
    const transfers = createTransferLedger();
    const to = cohortEndpointId(3);
    const leg = transfers.post({
      from: YARD, to, goods: { food: 1 }, issuer: "__player__",
      mode: "scheduled", now: 0, every: 100,
    });
    const out = condense<CohortRow>(to, {
      now: 0, endpoints: [to], books: booksOf({ transfers }),
    } satisfies CohortFoldCtx);
    if (!isFoldRefusal(out)) throw new Error("expected a refusal");
    expect(out.blockers).toEqual([leg.id]);
    expect(out.kind).toBe("district");
  });

  it("nothing serviceable ⇒ NO `serviced` field at all — a fold with no standing legs is byte-identical to F4's record", () => {
    const rec = condense<TownRecord>(ID, {
      now: 0, endpoints: [ID], stack: { food: 1 },
      books: booksOf({ transfers: createTransferLedger() }),
    } satisfies TownFoldCtx);
    if (isFoldRefusal(rec)) throw rec;
    expect(rec.serviced).toBeUndefined();
    expect(Object.keys(rec).sort()).toEqual(["at", "commitments", "id", "kind", "payload"]);
  });

  it("🚨 THE LIVE MINT PATH, BOOKS WIRED — quest-host's own ctx, with a standing route on the books", () => {
    // THE CTX `mintCondensedShelf` NOW BUILDS, verbatim: `now`, `prev`,
    // `floors`, `books` (gather-only — a top-up moves no scope, so nothing may
    // leave a book), and no `endpoints`, because the partner's shelf id IS the
    // scope id. This is the exact call F4 could not wire.
    const transfers = createTransferLedger();
    const leg = standingLeg(transfers);
    const shelf: Record<string, number> = { food: 2 };
    const prev = condenseTown({ key: KEY, stack: shelf, geo: null, at: null, distanceM: null });
    const minted: Array<[string, number]> = [];
    const out = condense<TownRecord>(ID, {
      now: 30,
      prev,
      floors: { food: 9 },
      books: booksOf({ transfers }),
      minted: (good, units) => minted.push([good, units]),
    } satisfies TownFoldCtx);
    if (isFoldRefusal(out)) throw new Error(`the finding's failure mode is back: ${out.note}`);
    expect(minted).toEqual([["food", 7]]);
    expect(shelf).toEqual({ food: 9 });
    expect(out.serviced?.map((c) => c.id)).toEqual([leg.id]);
    expect(transfers.get(leg.id)?.status).toBe("pending"); // the caravan still has its route
  });

  it("the WILD codec services a standing draw against the AREA, and never one against a standing tree", () => {
    const transfers = createTransferLedger();
    const area = wildAreaId("home");
    const draw = transfers.post({
      from: area, to: YARD, goods: { wood: 2 }, issuer: "__player__",
      mode: "scheduled", now: 0, every: 100,
    });
    const tree = transfers.post({
      from: "wild:oak_3", to: YARD, goods: { wood: 1 }, issuer: "__player__",
      mode: "scheduled", now: 0, every: 100,
    });
    const ctx = (endpoints: string[]): WildFoldCtx => ({
      now: 0, endpoints, area: AREA, seed: 11, features: content.features,
      books: booksOf({ transfers }),
    });
    // The tree's endpoint is exactly what stops existing at this fold.
    const refused = condense<WildAreaRecord>(area, ctx([area, "wild:oak_3"]));
    if (!isFoldRefusal(refused)) throw new Error("expected a refusal");
    expect(refused.blockers).toEqual([tree.id]);
    // The AREA's own draw leg survives: the source goes on yielding into it.
    const rec = condense<WildAreaRecord>(area, ctx([area]));
    if (isFoldRefusal(rec)) throw rec;
    expect(rec.serviced?.map((c) => c.id)).toEqual([draw.id]);
    expect(wildAreaStock(rec.payload)).toEqual(sumStocks(content.features));
  });
});
