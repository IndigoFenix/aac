// STEP ④, PASS 5 — ⑥ THE TOWN-RUNG DEFER PARKS
// (planning-docs/games/scope-behaviors.md §2.5 DEFER, §2.5.1, §7 step 6).
//
// Pass 4 shipped the park at the BODY rung and MAPPED the town's two waits
// without touching them. §2.5.1, verbatim, is the design this file pins as
// landed:
//
//  · "`reArmOneShot` (barter, `BARTER_RETRY_SEC = FOOD_DAY_SEC`) — a
//    famine-refused caravan sets `a.nextDueAt = now + one street day`. The park
//    is `{scope: "agreement", holder: a.id}`; the PREDICATE is the refusal
//    itself … The EPOCH is the partner's shelf … The DERIVED WAKE is already
//    sitting there and is the honest version of `BARTER_RETRY_SEC` … `staleAt`
//    = … exactly today's constant, demoted from mechanism to backstop."
//  · "`stepCraftJob`'s material wait — this one is NOT a failure park and must
//    not be converted into one: it is a LIVENESS TIMEOUT on hauls in flight …
//    What is park-shaped is the OTHER branch — `craftRetryAt` /
//    `SITE_HAUL_RETRY_S` … `staleAt` = the job's own expected labour time."
//
// What this file pins:
//  ① the barter park hooks in `runDueBarters` — REAL KERNEL CODE: a parked
//     one-shot is skipped BEFORE its terms are re-derived, and is not shoved a
//     flat day into the future.
//  ② the DERIVED WAKES — forward samples off the very closed form the refusal
//     read (`nextShortageBelow`, `nextBarterWillingAt`), deterministic, honest
//     about the horizon.
//  ③ the per-leg road (`legSecondsOf`): a standing route paced by its road when
//     the road outlasts the recurrence; a stub route untouched.
//  ④ the park PRIMITIVE — `parkTown`/`townParked` mirrored from quest-host (the
//     convention `defer-parks.test.ts` established for host closures): two
//     epochs per scope, a derived `dueAt`, and a `staleAt` backstop.
//  ⑤ TWIN PARITY: whatever the observed arm decides, the unobserved one decides
//     the same, because they decide through the same functions.
//
// No DOM / GL / session / DB.
import { describe, expect, it } from "@jest/globals";
import {
  BARTER_FAMINE_MAX,
  BARTER_RETRY_SEC,
  barterWillingness,
  nextBarterWillingAt,
  nextShortageBelow,
  runDueBarters,
  stockAbstractPartner,
  STUB_SEASON_DAYS,
  stubPartnerSignals,
  type BarterSignals,
} from "@shared/world-engine/kernel/town/barter.js";
import {
  createTransferLedger,
  townEndpointId,
  type PostTransferInput,
  type StockEndpoint,
  type TransferAgreement,
} from "@shared/world-engine/kernel/town/transfer.js";
import {
  createReservationLedger,
  resolveMaterials,
} from "@shared/world-engine/kernel/town/reservations.js";
import { FOOD_DAY_SEC } from "@shared/world-engine/kernel/town/goods.js";
import { DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";

const sig = (m: Record<string, number>): BarterSignals => ({ shortage: (g) => m[g] ?? 0 });
const ep = (id: string, stack: Record<string, number>): StockEndpoint => ({ id, kind: "town", stack });

function barterInput(opts: {
  give: string;
  take: string;
  giveN: number;
  partnerKey: string;
  every?: number;
  dueAt?: number;
}): PostTransferInput {
  return {
    from: "town:yard",
    to: townEndpointId(opts.partnerKey),
    goods: { [opts.give]: opts.giveN },
    issuer: "__player__",
    mode: "scheduled",
    now: 0,
    ...(opts.every !== undefined ? { every: opts.every } : {}),
    ...(opts.dueAt !== undefined ? { dueAt: opts.dueAt } : {}),
    sourceGlyph: "trade + wood",
    barter: {
      take: { [opts.take]: 0 },
      giveGood: opts.give,
      takeGood: opts.take,
      quote: { give: 1, take: 1 },
      partnerKey: opts.partnerKey,
    },
  };
}

/** A partner in FAMINE on what we want: `shortage(take) ≥ BARTER_FAMINE_MAX`
 *  refuses "wont-part", which is the exact case §2.5.1 describes. */
const FAMINE = sig({ wood: 0.9, food: 0.95 });
/** …and the same partner once its famine lifts. */
const RECOVERED = sig({ wood: 0.9, food: 0.1 });

// ═══ ① THE BARTER PARK HOOKS (real kernel code) ══════════════════════════

describe("⏸️ reArmOneShot → an agreement park", () => {
  const setup = () => {
    const ledger = createTransferLedger();
    const a = ledger.post(barterInput({ give: "wood", take: "food", giveN: 3, partnerKey: "away:7" }));
    const us = ep("town:yard", { wood: 9 });
    const them = ep(townEndpointId("away:7"), { food: 9 });
    const resolve = (id: string) => (id === us.id ? us : id === them.id ? them : null);
    return { ledger, a, us, them, resolve };
  };

  it("WITHOUT a park hook the shipped day-timer is untouched", () => {
    const { ledger, a, resolve } = setup();
    const out = runDueBarters(ledger, resolve, 0, { us: sig({}), themOf: () => FAMINE });
    expect(out[0]!.status).toBe("suspended");
    expect(out[0]!.reason).toBe("wont-part");
    expect(ledger.get(a.id)!.nextDueAt).toBe(BARTER_RETRY_SEC); // = one street day
  });

  it("🔒 WITH a park hook the host owns the wait — no flat day is invented", () => {
    const { ledger, a, resolve } = setup();
    const parked = new Set<string>();
    const whys: string[] = [];
    const out = runDueBarters(ledger, resolve, 0, {
      us: sig({}),
      themOf: () => FAMINE,
      parked: (row) => parked.has(row.id),
      park: (row, why) => {
        parked.add(row.id);
        whys.push(why);
        return true;
      },
    });
    expect(out[0]!.status).toBe("suspended");
    expect(whys).toEqual(["wont-part"]);
    // The row stays DUE (the park, not the clock, is the wait) …
    expect(ledger.get(a.id)!.nextDueAt).toBe(0);
    expect(ledger.due(0).map((r) => r.id)).toEqual([a.id]);
  });

  it("🚨 A PARKED ROW IS SKIPPED BEFORE ITS TERMS ARE RE-DERIVED", () => {
    // The body rung's law, one scope up: `decideNeeds` asks `parked(tpl)` before
    // `ctxOf(tpl)` because the ctx is the expensive half. Here the expensive
    // half is re-quoting a deal nobody will take — and a re-quote would also
    // REWRITE the row's terms, so a park that ran the work first would leave
    // the player's spoken quote drifting while nothing was happening.
    const { ledger, a, resolve } = setup();
    let signalReads = 0;
    const watched: BarterSignals = {
      shortage: (g) => {
        signalReads++;
        return FAMINE.shortage(g);
      },
    };
    const opts = {
      us: sig({}),
      themOf: () => watched,
      parked: (row: TransferAgreement) => row.id === a.id,
      park: () => true,
    };
    const out = runDueBarters(ledger, resolve, 0, opts);
    expect(out).toEqual([]); // no report at all — nothing was even asked
    expect(signalReads).toBe(0);
    expect(ledger.get(a.id)!.barter!.quote).toEqual({ give: 1, take: 1 }); // untouched
  });

  it("a woken row ships on the very next sweep, at freshly derived terms", () => {
    const { ledger, a, resolve } = setup();
    let parked = false;
    const run = (them: BarterSignals) =>
      runDueBarters(ledger, resolve, 0, {
        us: sig({ food: 0.6 }),
        themOf: () => them,
        parked: () => parked,
        park: () => ((parked = true), true),
      });
    expect(run(FAMINE)[0]!.status).toBe("suspended");
    expect(run(FAMINE)).toEqual([]); // parked: skipped
    parked = false; // …the wake fires (their shelf moved / their famine lifted)
    const out = run(RECOVERED);
    expect(out[0]!.status).toBe("resumed");
    expect(ledger.get(a.id)!.status).toBe("done");
  });

  it("STANDING routes are never parked — their own `every` IS the wait", () => {
    const ledger = createTransferLedger();
    const a = ledger.post(
      barterInput({ give: "wood", take: "food", giveN: 3, partnerKey: "away:7", every: FOOD_DAY_SEC }),
    );
    const us = ep("town:yard", { wood: 9 });
    const them = ep(townEndpointId("away:7"), { food: 9 });
    let parkCalls = 0;
    runDueBarters(ledger, (id) => (id === us.id ? us : id === them.id ? them : null), FOOD_DAY_SEC, {
      us: sig({}),
      themOf: () => FAMINE,
      parked: () => {
        throw new Error("a standing row must never be asked");
      },
      park: () => (parkCalls++, true),
    });
    expect(parkCalls).toBe(0);
    expect(ledger.get(a.id)!.nextDueAt).toBe(FOOD_DAY_SEC * 2); // advanced, as it shipped
  });

  it("OUR OWN shortfall parks too, and names itself differently", () => {
    const ledger = createTransferLedger();
    const a = ledger.post(barterInput({ give: "wood", take: "food", giveN: 3, partnerKey: "away:7" }));
    const us = ep("town:yard", {}); // the yard ran dry
    const them = ep(townEndpointId("away:7"), { food: 9 });
    const whys: string[] = [];
    const out = runDueBarters(ledger, (id) => (id === us.id ? us : id === them.id ? them : null), 0, {
      us: sig({}),
      themOf: () => sig({ wood: 0.8, food: 0.1 }), // willing
      park: (_row, why) => (whys.push(why), true),
    });
    expect(out[0]!.status).toBe("short");
    expect(whys).toEqual(["short"]);
    expect(ledger.get(a.id)!.nextDueAt).toBe(0);
  });
});

// ═══ ② THE DERIVED WAKES ══════════════════════════════════════════════════

describe("⏸️ the derived wake — the partner's own goods clock, sampled forward", () => {
  const atDay = (day: number) => stubPartnerSignals("away:7", Math.floor(day));

  it("🔒 nextShortageBelow answers off the SAME closed form the refusal read", () => {
    // `away:7` is in famine for food today (0.754 ≥ 0.7) and its triangular
    // season carries it under the line on day 9 (0.697). That is the whole
    // difference between a park and a stopwatch: BARTER_RETRY_SEC would have
    // said "one day" eight times running and been wrong every time.
    const day = nextShortageBelow(atDay, "food", BARTER_FAMINE_MAX, 0);
    expect(atDay(0).shortage("food")).toBeGreaterThanOrEqual(BARTER_FAMINE_MAX);
    expect(day).toBe(9);
    expect(atDay(day!).shortage("food")).toBeLessThan(BARTER_FAMINE_MAX);
    // …and it is the FIRST such day, not merely one of them.
    for (let d = 1; d < day!; d++) {
      expect(atDay(d).shortage("food")).toBeGreaterThanOrEqual(BARTER_FAMINE_MAX);
    }
  });

  it("the sample walks FORWARD from wherever the park is set", () => {
    expect(nextShortageBelow(atDay, "food", BARTER_FAMINE_MAX, 9)).toBe(10);
    expect(nextShortageBelow(atDay, "food", BARTER_FAMINE_MAX, 12.4)).toBe(13);
  });

  it("the horizon is ONE SEASON — the closed form's own period, not a guess", () => {
    // A threshold nothing can ever clear returns null rather than an invented
    // date; the park's `staleAt` backstop takes over from there.
    expect(nextShortageBelow(atDay, "food", 0, 0)).toBeNull();
    expect(nextShortageBelow(atDay, "food", 0, 0, 1000)).toBeNull();
    // A threshold everything clears answers tomorrow.
    expect(nextShortageBelow(atDay, "food", 2, 0)).toBe(1);
  });

  it("🔒 nextBarterWillingAt evaluates the REAL predicate, so it cannot disagree", () => {
    // "has-enough" is a two-sided inequality over two of THEIR shortages, so
    // only the predicate itself can answer when it clears. `away:3` refuses a
    // wood-for-food deal today and takes it on day 8.
    const us = sig({});
    const atDay3 = (d: number) => stubPartnerSignals("away:3", Math.floor(d));
    expect(barterWillingness("wood", "food", us, atDay3(0)).ok).toBe(false);
    const day = nextBarterWillingAt("wood", "food", us, atDay3, 0);
    expect(day).toBe(8);
    expect(barterWillingness("wood", "food", us, atDay3(day!)).ok).toBe(true);
    for (let d = 1; d < day!; d++) {
      expect(barterWillingness("wood", "food", us, atDay3(d)).ok).toBe(false);
    }
  });

  it("…and returns null where the predicate never clears inside a season", () => {
    // `away:7` wants food more than wood all season long, so no wood-for-food
    // deal ever tempts it: honest null, and the backstop carries the wait.
    expect(nextBarterWillingAt("wood", "food", sig({}), atDay, 0)).toBeNull();
    for (let d = 1; d <= STUB_SEASON_DAYS; d++) {
      expect(barterWillingness("wood", "food", sig({}), atDay(d)).ok).toBe(false);
    }
  });

  it("DETERMINISTIC — town clock in, same answer forever (no wall clock)", () => {
    const once = nextBarterWillingAt("wood", "food", sig({}), atDay, 3);
    for (let i = 0; i < 10; i++) {
      expect(nextBarterWillingAt("wood", "food", sig({}), atDay, 3)).toBe(once);
    }
  });

  it("a REAL partner has no closed form, and the host must not invent one", () => {
    // quest-host sets `signalsAtDay: null` for a cluster neighbour's live books
    // and parks with `dueAt: 0` — "the failure named no closed form", exactly
    // as a shop park does. Mirrored here as the rule it is.
    const signalsAtDay: ((day: number) => BarterSignals) | null = null;
    const dueAt = signalsAtDay ? 1 : 0;
    expect(dueAt).toBe(0);
  });
});

// ═══ ③ THE ROAD, PER LEG ══════════════════════════════════════════════════

describe("⚖️ a standing route re-derives its leg from the road, every leg", () => {
  const run = (legS: number | undefined, now: number) => {
    const ledger = createTransferLedger();
    const a = ledger.post(
      barterInput({ give: "wood", take: "food", giveN: 3, partnerKey: "p", every: FOOD_DAY_SEC, dueAt: now }),
    );
    const us = ep("town:yard", { wood: 30 });
    const them = ep(townEndpointId("p"), { food: 30 });
    runDueBarters(ledger, (id) => (id === us.id ? us : id === them.id ? them : null), now, {
      us: sig({ food: 0.6 }),
      themOf: () => sig({ wood: 0.8, food: 0.1 }),
      ...(legS !== undefined ? { legSecondsOf: () => legS } : {}),
    });
    return ledger.get(a.id)!;
  };

  it("a road SHORTER than the recurrence changes nothing (every stub route)", () => {
    expect(run(FOOD_DAY_SEC * 0.35, 0).nextDueAt).toBe(FOOD_DAY_SEC);
    expect(run(undefined, 0).nextDueAt).toBe(FOOD_DAY_SEC); // no hook at all: shipped
  });

  it("🔒 a road LONGER than the day paces the route — no daily caravan from 8 days away", () => {
    const legS = 1973.68; // a 3 km partner on the street profile
    expect(run(legS, 0).nextDueAt).toBeCloseTo(legS, 2);
    expect(run(legS, 0).nextDueAt).toBeGreaterThan(FOOD_DAY_SEC);
  });

  it("re-derived, not cached: the same row prices its road again next leg", () => {
    // The hook is called per advance, so a partner rebound to a nearer
    // neighbour (bindPartner) speeds its own route up with no new machinery.
    const ledger = createTransferLedger();
    const a = ledger.post(
      barterInput({ give: "wood", take: "food", giveN: 3, partnerKey: "p", every: FOOD_DAY_SEC, dueAt: 0 }),
    );
    const us = ep("town:yard", { wood: 30 });
    const them = ep(townEndpointId("p"), { food: 30 });
    const resolve = (id: string) => (id === us.id ? us : id === them.id ? them : null);
    let legS = 2000;
    const opts = {
      us: sig({ food: 0.6 }),
      themOf: () => sig({ wood: 0.8, food: 0.1 }),
      legSecondsOf: () => legS,
    };
    runDueBarters(ledger, resolve, 0, opts);
    expect(ledger.get(a.id)!.nextDueAt).toBe(2000);
    legS = 100; // the partner moved next door
    runDueBarters(ledger, resolve, 2000, opts);
    expect(ledger.get(a.id)!.nextDueAt).toBe(2000 + FOOD_DAY_SEC); // the recurrence again
  });
});

// ═══ ④ THE PARK PRIMITIVE (mirrored from quest-host) ═════════════════════

/** `TownPark`, `parkTown`, `townParked` — mirrored the way
 *  `defer-parks.test.ts` mirrors `parkNeed`/`needParked`: the host closures own
 *  a session, so what is pinned here is the WAKE PREDICATE, one condition at a
 *  time. */
interface Session {
  partnerStockEpoch: number;
  needsStockEpoch: number;
  releaseEpoch: number;
}
interface TownPark {
  scope: "agreement" | "job";
  partnerStock: number;
  stock: number;
  released: number;
  dueAt: number;
  staleAt: number;
  why: string;
}
function parkTown(
  s: Session,
  parks: Map<string, TownPark>,
  key: string,
  o: { scope: TownPark["scope"]; why: string; now: number; staleAfterS: number; dueAt?: number },
): void {
  parks.set(key, {
    scope: o.scope,
    partnerStock: s.partnerStockEpoch,
    stock: s.needsStockEpoch,
    released: s.releaseEpoch,
    dueAt: o.dueAt ?? 0,
    staleAt: o.now + o.staleAfterS,
    why: o.why,
  });
}
function townParked(s: Session, parks: Map<string, TownPark>, key: string, now: number): boolean {
  const p = parks.get(key);
  if (!p) return false;
  const woke =
    (p.scope === "agreement" &&
      (p.partnerStock !== s.partnerStockEpoch || p.stock !== s.needsStockEpoch)) ||
    (p.scope === "job" && (p.stock !== s.needsStockEpoch || p.released !== s.releaseEpoch)) ||
    (p.dueAt > 0 && now >= p.dueAt) ||
    now >= p.staleAt;
  if (!woke) return true;
  parks.delete(key);
  return false;
}

describe("⏸️ the town park's wake — one condition at a time", () => {
  const fresh = (): [Session, Map<string, TownPark>] => [
    { partnerStockEpoch: 0, needsStockEpoch: 0, releaseEpoch: 0 },
    new Map(),
  ];

  it("AGREEMENT: their shelf gaining units wakes it (partnerStockEpoch)", () => {
    const [s, parks] = fresh();
    parkTown(s, parks, "agreement|a1", {
      scope: "agreement",
      why: "partner refused: wont-part",
      now: 0,
      staleAfterS: BARTER_RETRY_SEC,
    });
    expect(townParked(s, parks, "agreement|a1", 10)).toBe(true);
    s.partnerStockEpoch++; // stockAbstractPartner minted / the executor unloaded
    expect(townParked(s, parks, "agreement|a1", 10)).toBe(false);
    expect(parks.size).toBe(0); // consumed on wake — retried at full price ONCE
  });

  it("AGREEMENT: OUR yard filling wakes it too — a deal has two sides", () => {
    const [s, parks] = fresh();
    parkTown(s, parks, "agreement|a1", {
      scope: "agreement", why: "short", now: 0, staleAfterS: BARTER_RETRY_SEC,
    });
    s.needsStockEpoch++;
    expect(townParked(s, parks, "agreement|a1", 10)).toBe(false);
  });

  it("AGREEMENT: a released CLAIM is not their business and does not wake it", () => {
    const [s, parks] = fresh();
    parkTown(s, parks, "agreement|a1", {
      scope: "agreement", why: "wont-part", now: 0, staleAfterS: BARTER_RETRY_SEC,
    });
    s.releaseEpoch++;
    expect(townParked(s, parks, "agreement|a1", 10)).toBe(true);
  });

  it("🔒 AGREEMENT: `staleAt` is exactly BARTER_RETRY_SEC — the constant, demoted", () => {
    const [s, parks] = fresh();
    parkTown(s, parks, "agreement|a1", {
      scope: "agreement", why: "wont-part", now: 100, staleAfterS: BARTER_RETRY_SEC,
    });
    expect(parks.get("agreement|a1")!.staleAt).toBe(100 + FOOD_DAY_SEC);
    expect(townParked(s, parks, "agreement|a1", 100 + FOOD_DAY_SEC - 1)).toBe(true);
    // The worst case IS the shipped behaviour: one street day, then re-decide.
    expect(townParked(s, parks, "agreement|a1", 100 + FOOD_DAY_SEC)).toBe(false);
  });

  it("AGREEMENT: the DERIVED wake fires before the backstop, which is the point", () => {
    const [s, parks] = fresh();
    parkTown(s, parks, "agreement|a1", {
      scope: "agreement", why: "wont-part", now: 0,
      staleAfterS: BARTER_RETRY_SEC,
      dueAt: 3 * FOOD_DAY_SEC / 8, // "their famine lifts on the third day-eighth"
    });
    expect(townParked(s, parks, "agreement|a1", 89)).toBe(true);
    expect(townParked(s, parks, "agreement|a1", 90)).toBe(false);
  });

  it("JOB: a container gaining units OR a claim being released wakes it", () => {
    for (const bump of ["stock", "release"] as const) {
      const [s, parks] = fresh();
      parkTown(s, parks, "job|3", {
        scope: "job", why: "no free source offers wood", now: 0, staleAfterS: 900,
      });
      expect(townParked(s, parks, "job|3", 10)).toBe(true);
      if (bump === "stock") s.needsStockEpoch++;
      else s.releaseEpoch++;
      expect(townParked(s, parks, "job|3", 10)).toBe(false);
    }
  });

  it("JOB: a PARTNER's shelf is not this job's business and does not wake it", () => {
    const [s, parks] = fresh();
    parkTown(s, parks, "job|3", { scope: "job", why: "no wood", now: 0, staleAfterS: 900 });
    s.partnerStockEpoch++;
    expect(townParked(s, parks, "job|3", 10)).toBe(true);
  });

  it("🔒 JOB: `staleAt` is the job's own labour time, never a literal", () => {
    // The backstop is derived per job, exactly as a need park's is derived per
    // row: a piece that takes a labour-day to make waits at most a labour-day
    // before re-asking. (Value shown for the shipped construction dial.)
    const labourS = 0.35 * DOLLHOUSE_SCALE.dayLengthS; // CRAFT_HAND_DAYS-shaped
    const [s, parks] = fresh();
    parkTown(s, parks, "job|3", { scope: "job", why: "no wood", now: 0, staleAfterS: labourS });
    expect(townParked(s, parks, "job|3", labourS - 0.001)).toBe(true);
    expect(townParked(s, parks, "job|3", labourS)).toBe(false);
  });

  it("re-parking REFRESHES — the plan failed again, so the wait starts again", () => {
    const [s, parks] = fresh();
    parkTown(s, parks, "job|3", { scope: "job", why: "no wood", now: 0, staleAfterS: 100 });
    parkTown(s, parks, "job|3", { scope: "job", why: "no wood", now: 60, staleAfterS: 100 });
    expect(parks.size).toBe(1);
    expect(townParked(s, parks, "job|3", 120)).toBe(true);
    expect(townParked(s, parks, "job|3", 160)).toBe(false);
  });
});

// ═══ ⑤ TWIN PARITY ═══════════════════════════════════════════════════════

describe("👯 the observed and unobserved economies decide identically", () => {
  it("both arms resolve through ONE function, so they cannot disagree", () => {
    // The observed arm posts hauls for the draws; the unobserved twin takes the
    // same draws instantly. The draws themselves come from `resolveMaterials`
    // over `siteMaterialSources`/`craftMaterialSources` in BOTH arms — this is
    // that shared step, asked twice against the same world.
    const sources = [
      { id: "yard", stack: { wood: 4 }, d: 30 },
      { id: "crate", stack: { wood: 3 }, d: 8 },
      { id: "chest", stack: { wood: 2 }, d: 8 },
    ];
    const observed = resolveMaterials({
      holder: "haul", costs: { wood: 6 }, sources, ledger: createReservationLedger(),
    });
    const twin = resolveMaterials({
      holder: "twin", costs: { wood: 6 }, sources, ledger: createReservationLedger(),
    });
    expect(twin.draws).toEqual(observed.draws);
    expect(twin.shortfall).toEqual(observed.shortfall);
  });

  it("a claim in either arm is visible to the other — one ledger, one truth", () => {
    const ledger = createReservationLedger();
    const sources = [{ id: "crate", stack: { wood: 3 }, d: 1 }];
    const first = resolveMaterials({ holder: "observed", costs: { wood: 3 }, sources, ledger });
    const second = resolveMaterials({ holder: "twin", costs: { wood: 3 }, sources, ledger });
    expect(first.draws).toHaveLength(1);
    expect(second.draws).toHaveLength(0);
    expect(second.shortfall).toEqual({ wood: 3 }); // honest, never a double-spend
  });

  it("both arms' deliveries are the SAME EVENT to a park (the stock epoch)", () => {
    // quest-host's walked unload and construction-director's `twinResolveHauls`
    // both bump `needsStockEpoch` at their landing; the craft twin's instant
    // draw bumps it too. Modelled here as the invariant it enforces: a job
    // parked on "no free source" wakes on a delivery, whoever made it.
    for (const arm of ["observed", "twin"] as const) {
      const s: Session = { partnerStockEpoch: 0, needsStockEpoch: 0, releaseEpoch: 0 };
      const parks = new Map<string, TownPark>();
      parkTown(s, parks, "job|1", { scope: "job", why: "no wood", now: 0, staleAfterS: 900 });
      expect(townParked(s, parks, "job|1", 1)).toBe(true);
      s.needsStockEpoch++; // the landing, whichever arm ran it
      expect(townParked(s, parks, "job|1", 1)).toBe(false);
      expect(arm).toBeTruthy();
    }
  });

  it("stockAbstractPartner reports its mint, so the epoch is an EVENT", () => {
    // Bumping unconditionally would tick on every due row and no agreement park
    // would ever hold — the same trap `releaseEpoch` avoids.
    const stack: Record<string, number> = {};
    expect(stockAbstractPartner(stack, "food", 9)).toBe(9);
    expect(stockAbstractPartner(stack, "food", 9)).toBe(0); // already full: no event
    expect(stack).toEqual({ food: 9 });
  });
});
