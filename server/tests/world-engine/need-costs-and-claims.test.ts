// STEP ④ AT THE BODY RUNG — "costs in the planner" (planning-docs/games/world-engine/
// scope-behaviors.md §2.6 CLAIM, §2.3 PREFER, §3 the currency, §5 seats 1–2).
//
// Two things land in this pass and both are pinned here:
//
//  ① CLAIM DOWN — the town's `reservations.ts` ledger, applied to bodies. The
//     gap it closes, verbatim from the chapter: "two housemates both read 3
//     apples in the chest and the loser finds out at arrival." Holder id is
//     `need:<cid>`, ONE per body, mirroring "one errand per body".
//  ② intentCost — `value − cost` seated in the two body-rung deciders. Flag
//     OFF (`costSelection: false`) is the shipped behaviour byte for byte; flag
//     ON is the arithmetic. Every case below pins BOTH, because the flag is a
//     kill-switch and a kill-switch nobody tests is a kill-switch that doesn't
//     work.
//
// The claim helpers are host closures bound to a live session, so they are
// MIRRORED here exactly as quest-host writes them — the same convention
// `town-body-carry.test.ts` uses for the two carry doors and
// `town-errand-walk.test.ts` for the errand router. The LEDGER underneath them
// is the real kernel one, so a change to the reservation law breaks this file
// rather than sliding past it.
//
// No DOM / GL / session / DB.
import { describe, expect, it } from "@jest/globals";
import {
  BANK_PRIORITY,
  NEED_COST_SELECTION,
  NEED_PRESSURE_S,
  decideNeed,
  decideNeeds,
  energyTemplate,
  hungerTemplate,
  intentCost,
  provisionTemplate,
  urgencyOf,
  wasteTemplate,
  type NeedCtx,
  type NeedPrice,
  type NeedTemplate,
  type StationCandidate,
  type StockCandidate,
} from "@shared/world-engine/interaction/behavior/needs.js";
import {
  createReservationLedger,
  freeUnitsOver,
  type ReservationLedger,
} from "@shared/world-engine/kernel/town/reservations.js";
import { costTotalS } from "@shared/world-engine/kernel/town/scope-shape.js";
import { NEED_FILL_S } from "@shared/world-engine/scale.js";

// ── The world the ctx is resolved from ────────────────────────────────────

const P = (id: string) => ({ kind: "named" as const, id });
const WALK_MPS = 1.6; // ERRAND_WALK_MPS, the shipped villager pace
const BOX_S = 1.1; // BOX_ACT_DWELL_S — the beat at the box
const SHOP_S = 18; // SHOP_SEC — the beat at the stall

/** The price board a resident's ctx carries (quest-host `needPriceOf`). */
const price = (over: Partial<NeedPrice> = {}): NeedPrice => ({
  walkMps: WALK_MPS,
  fillS: NEED_FILL_S.hunger,
  unitValueS: 5 * NEED_PRESSURE_S, // one ration = one hunger service
  shortage: 1,
  handsS: { container: BOX_S, source: SHOP_S, loose: BOX_S, satisfy: 2 },
  ...over,
});

const empty: NeedCtx = { meter: 0, carried: 0, containers: {}, sources: [], stations: [] };
const ON = { costSelection: true };
const OFF = { costSelection: false };

// ── ① CLAIM DOWN — the host's four claim closures, mirrored ───────────────

interface Claims {
  ledger: ReservationLedger;
  /** quest-host `reserveNeedUnits` — one holder per body, so a fresh claim
   *  drops the last one. Wells and loose props are never spoken for. */
  reserve(cid: string, endpoint: string, goodKey: string, qty: number): void;
  /** quest-host `releaseNeedUnits`. */
  release(cid: string): void;
  /** quest-host `freeNeedUnits` — never subtracts the asker's own claim. */
  free(cid: string, endpoint: string, goodKey: string, units: number): number;
  /** quest-host `sweepNeedClaims` — a holder that is no longer live loses it. */
  sweep(live: ReadonlySet<string>): void;
  rows(): number;
}

function claims(): Claims {
  const ledger = createReservationLedger();
  const holder = (cid: string) => `need:${cid}`;
  return {
    ledger,
    reserve(cid, endpoint, goodKey, qty) {
      ledger.release(holder(cid));
      if (!goodKey || qty <= 0) return;
      // quest-host `isWellId` — "well" or "well_<n>".
      if (endpoint === "well" || /^well_\d+$/.test(endpoint) || endpoint.startsWith("small:")) return;
      ledger.reserve(holder(cid), endpoint, goodKey, qty);
    },
    release: (cid) => ledger.release(holder(cid)),
    free: (cid, endpoint, goodKey, units) =>
      freeUnitsOver(units, ledger, endpoint, goodKey, holder(cid)),
    sweep(live) {
      for (const row of ledger.toJSON().rows) {
        if (!row.holder.startsWith("need:")) continue;
        if (live.has(row.holder.slice(5))) continue;
        ledger.release(row.holder);
      }
    },
    rows: () => ledger.toJSON().rows.length,
  };
}

/** The household haul row: fill the shared crate from the shared chest. Its
 *  acquire branch is a CONTAINER, which is the branch the arrival race lived
 *  in — two bodies reading the same chest. */
const haul: NeedTemplate = {
  key: "haul:food",
  item: { category: "food" },
  drive: { kind: "stock", container: "dest", below: 6 },
  satisfy: { kind: "deposit", container: "dest", upTo: 6 },
  acquire: [{ kind: "container", role: "home" }],
  priority: 3,
};

describe("① CLAIM DOWN — unit reservations for bodies", () => {
  const CHEST = "furn_0_chest_food";
  /** What `residentNeedCtx` builds for one body: REAL units for the drive's
   *  floor, FREE units for the acquire branch. */
  const ctxOf = (c: Claims, cid: string, chestUnits: number): NeedCtx => ({
    ...empty,
    room: 8, // a basket — the trip is worth sizing
    containers: {
      home: {
        id: CHEST,
        place: P(CHEST),
        units: chestUnits,
        free: c.free(cid, CHEST, "food", chestUnits),
        d: 3,
      },
      dest: { id: "crate", place: P("crate"), units: 0, room: 6, d: 4 },
    },
    price: price({ shortage: 1 }),
  });

  it("two housemates, one chest of 3: the FIRST speaks for all three, the SECOND sees none", () => {
    const c = claims();
    // Ada decides first (the sorted member order is the claim order) and
    // commits — reserve fires at the same moment `claimErrand` does, on ACT.
    const ada = decideNeed(haul, ctxOf(c, "resident_0_0", 3), ON);
    expect(ada).toEqual({
      kind: "take",
      from: expect.objectContaining({ id: CHEST, units: 3, free: 3 }),
      units: 3,
    });
    c.reserve("resident_0_0", CHEST, "food", 3);

    // Bo resolves its ctx a beat later. The chest still HOLDS three — the
    // drive's floor must keep reading the real count — but none are free.
    const boCtx = ctxOf(c, "resident_0_1", 3);
    expect(boCtx.containers.home!.units).toBe(3); // the shelf is unchanged…
    expect(boCtx.containers.home!.free).toBe(0); // …and entirely spoken for
    // THE RACE CLASS IS DEAD: Bo never walks to an empty promise. The want is
    // real, so it surfaces (blocked) instead of being silently idle.
    expect(decideNeed(haul, boCtx, ON)).toEqual({ kind: "blocked" });
  });

  it("a body never hides stock from ITSELF — its own claim is not subtracted", () => {
    const c = claims();
    c.reserve("resident_0_0", CHEST, "food", 3);
    const mine = ctxOf(c, "resident_0_0", 3);
    expect(mine.containers.home!.free).toBe(3);
    // …so re-deciding mid-walk still routes to the box it is walking toward,
    // rather than blocking on its own reservation (that would be a spin).
    expect(decideNeed(haul, mine, ON)).toMatchObject({ kind: "take", units: 3 });
  });

  it("CONSUME at arrival by what actually left, release the rest", () => {
    const c = claims();
    c.reserve("resident_0_0", CHEST, "food", 3);
    // The take-first-account-second loop moved 2 of the 3 (the bag filled).
    c.ledger.consume("need:resident_0_0", CHEST, "food", 2);
    expect(c.ledger.reservedUnits(CHEST, "food")).toBe(1);
    c.release("resident_0_0"); // …and the remainder goes back to the housemates
    expect(c.rows()).toBe(0);
  });

  it("claims never leak: commit → re-decide → clear → demote all end empty", () => {
    const c = claims();
    const cid = "resident_0_0";
    // COMMIT.
    c.reserve(cid, CHEST, "food", 3);
    expect(c.rows()).toBe(1);
    // RE-DECIDE onto a different endpoint — one holder per body, so the old
    // claim goes rather than accumulating (the "wandered off still holding the
    // pantry shut" leak).
    c.reserve(cid, "store:food", "food", 2);
    expect(c.rows()).toBe(1);
    expect(c.ledger.reservedUnits(CHEST, "food")).toBe(0);
    expect(c.ledger.reservedUnits("store:food", "food")).toBe(2);
    // RE-DECIDE onto something that is not a take at all (a nap).
    c.release(cid);
    expect(c.rows()).toBe(0);
    // CLEAR the step (recruited, commanded, evicted — `clearNeedStep`).
    c.reserve(cid, CHEST, "food", 3);
    c.release(cid);
    expect(c.rows()).toBe(0);
    // DEMOTE / eviction with nothing routing it: the stale-claim GC.
    c.reserve(cid, CHEST, "food", 3);
    c.sweep(new Set(["resident_0_1"]));
    expect(c.rows()).toBe(0);
    // …and a body that IS still live keeps what it spoke for.
    c.reserve(cid, CHEST, "food", 3);
    c.sweep(new Set([cid]));
    expect(c.rows()).toBe(1);
  });

  it("the bottomless and the whole: a well and a loose prop are never reserved", () => {
    const c = claims();
    c.reserve("resident_0_0", "well_3", "water", 4);
    expect(c.rows()).toBe(0);
    c.reserve("resident_0_0", "small:teddy", "", 1);
    expect(c.rows()).toBe(0);
  });
});

// ── ② intentCost — the comparison ─────────────────────────────────────────

describe("urgencyOf — the drive's pressure, per drive kind", () => {
  const hunger = hungerTemplate("food", 1 / NEED_FILL_S.hunger);

  it("a meter reads in cycles owed: 1 at firing, and it keeps climbing", () => {
    expect(urgencyOf(hunger, { ...empty, meter: 0.5 })).toBeCloseTo(0.5);
    expect(urgencyOf(hunger, { ...empty, meter: 1 })).toBeCloseTo(1);
    expect(urgencyOf(hunger, { ...empty, meter: 2.5 })).toBeCloseTo(2.5);
  });

  it("a stock drive reads the SHORTFALL FRACTION — one short presses gently", () => {
    const provision = provisionTemplate("food", 5, 15);
    const at = (units: number) =>
      urgencyOf(provision, { ...empty, containers: { home: { id: "p", place: P("p"), units } } });
    expect(at(0)).toBeCloseTo(1);
    expect(at(4)).toBeCloseTo(0.2);
    expect(at(5)).toBeCloseTo(0);
  });

  it("a zero-tolerance mess drive has no fraction to take — any unit is full pressure", () => {
    const tidy: NeedTemplate = {
      key: "tidy", item: {}, drive: { kind: "mess", above: 0 },
      satisfy: { kind: "deposit", container: "storage", upTo: 99 },
      acquire: [{ kind: "loose" }], priority: 1.2,
    };
    expect(urgencyOf(tidy, { ...empty })).toBe(0);
    expect(urgencyOf(tidy, { ...empty, loose: [{ id: "x", place: P("x"), units: 1 }] })).toBe(1);
    expect(urgencyOf(tidy, { ...empty, carried: 1 })).toBe(1); // carrying is a firing reason
  });
});

describe("intentCost — the journey and the hands, priced", () => {
  const hunger = hungerTemplate("food", 1 / NEED_FILL_S.hunger);

  it("a market take costs the walk plus the stall's own beat", () => {
    const store: StockCandidate = { id: "store", place: P("store"), units: 9, d: 32 };
    const ctx: NeedCtx = { ...empty, meter: 1, sources: [store], price: price() };
    const cost = intentCost(hunger, ctx, { kind: "take", from: store, units: 1 });
    expect(cost.journeyS).toBeCloseTo(32 / WALK_MPS);
    expect(cost.handsS).toBe(SHOP_S);
    // Spoilage and opportunity stay 0 this pass (chapter §3).
    expect(cost.spoilageS).toBe(0);
    expect(cost.forgoneS).toBe(0);
  });

  it("an UNPRICED ctx costs nothing at all — that is what keeps the flag honest", () => {
    const store: StockCandidate = { id: "store", place: P("store"), units: 9, d: 32 };
    const ctx: NeedCtx = { ...empty, meter: 1, sources: [store] };
    expect(costTotalS(intentCost(hunger, ctx, { kind: "take", from: store, units: 1 }))).toBe(0);
  });

  it("an UNREACHABLE candidate prices at ∞", () => {
    const far: StockCandidate = { id: "store", place: P("store"), units: 9, d: Infinity };
    const ctx: NeedCtx = { ...empty, meter: 1, sources: [far], price: price() };
    expect(costTotalS(intentCost(hunger, ctx, { kind: "take", from: far, units: 1 }))).toBe(Infinity);
  });
});

describe("SEAT 2 — acquireFrom: pantry 1 vs market 50 becomes arithmetic", () => {
  const hunger = hungerTemplate("food", 1 / NEED_FILL_S.hunger);
  /** A hungry body with a BASKET (room 8), a nearly-bare pantry three metres
   *  away and a market sixty metres off. `restock` is the household's own
   *  shortfall — quest-host resolves it to the home box's remaining room. */
  const shopping = (pantryUnits: number, pantryRoom: number): NeedCtx => ({
    ...empty,
    meter: 1,
    room: 8,
    restock: pantryRoom,
    containers: {
      home: { id: "pantry", place: P("pantry"), units: pantryUnits, room: pantryRoom, d: 3 },
    },
    sources: [{ id: "store:food", place: P("store:food"), units: 50, d: 60 }],
    price: price({ shortage: pantryRoom / (pantryUnits + pantryRoom) }),
  });

  it("household five short: the MARKET wins despite the walk", () => {
    const pick = decideNeed(hunger, shopping(1, 5), ON);
    expect(pick).toMatchObject({ kind: "take", units: 5 });
    expect((pick as { from: StockCandidate }).from.id).toBe("store:food");
  });

  it("household one short: the walk is not worth it — the PANTRY wins", () => {
    const pick = decideNeed(hunger, shopping(5, 1), ON);
    expect(pick).toMatchObject({ kind: "take", units: 1 });
    expect((pick as { from: StockCandidate }).from.id).toBe("pantry");
  });

  it("flag OFF: first-non-empty, so the one-unit pantry ALWAYS wins (the surveyed bug)", () => {
    for (const ctx of [shopping(1, 5), shopping(5, 1)]) {
      const pick = decideNeed(hunger, ctx, OFF);
      expect((pick as { from: StockCandidate }).from.id).toBe("pantry");
    }
  });

  it("an UNREACHABLE market loses on price alone — no cooldown, no vanishing shelf", () => {
    // The chapter's §4.3 indictment: `SHOP_RETRY_COOLDOWN_S` existed because a
    // bad trip had no way to lose the comparison. Here it simply prices at ∞
    // while staying fully visible in the ctx. (The constant itself is gone as
    // of pass 4 — an empty shelf PARKS the row on the shelf restocking instead
    // of hiding the stall; see `defer-parks.test.ts`.)
    const ctx = shopping(1, 5);
    ctx.sources = [{ id: "store:food", place: P("store:food"), units: 50, d: Infinity }];
    const pick = decideNeed(hunger, ctx, ON);
    expect((pick as { from: StockCandidate }).from.id).toBe("pantry");
    expect(ctx.sources).toHaveLength(1); // still offered, just not worth it
  });

  it("the pick is DETERMINISTIC — same inputs, same choice, no clock, no RNG", () => {
    const a = decideNeed(hunger, shopping(1, 5), ON);
    const b = decideNeed(hunger, shopping(1, 5), ON);
    expect(a).toEqual(b);
  });
});

describe("SEAT 1 — decideNeeds: the canonical orderings, priced", () => {
  const bed = (d: number): StationCandidate => ({ id: "bed_0", place: P("bed_0"), kind: "bed", waiting: 0, d });
  const loo = (d: number): StationCandidate => ({ id: "toilet", place: P("toilet"), kind: "toilet", waiting: 0, d });
  const energy = energyTemplate(1 / NEED_FILL_S.energy);
  const waste = wasteTemplate(1 / NEED_FILL_S.waste);
  /** The household water errand — the row `BANK_PRIORITY` was invented for. */
  const water: NeedTemplate = {
    key: "provision:water",
    item: { category: "water" },
    drive: { kind: "stock", container: "home", below: 2 },
    satisfy: { kind: "deposit", container: "home", upTo: 6 },
    acquire: [{ kind: "source" }],
    priority: 3,
  };
  /** A body walking home from the well with a bucket, and dog-tired. `carried`
   *  fires the put-it-away rule; the barrel is bone dry, so every unit counts. */
  const hauling = (tpl: NeedTemplate): NeedCtx =>
    tpl.key === "provision:water"
      ? {
          ...empty,
          carried: 1,
          containers: { home: { id: "barrel", place: P("barrel"), units: 0, room: 6, d: 6 } },
          price: price({
            fillS: NEED_FILL_S.thirst,
            // A bucket is worth what a THIRST is worth — the §3 join.
            unitValueS: 4.8 * NEED_PRESSURE_S,
            shortage: 1,
          }),
        }
      : {
          ...empty,
          meter: 1,
          stations: [tpl.key === "waste" ? loo(3) : bed(3)],
          price: price({
            fillS: tpl.key === "waste" ? NEED_FILL_S.waste : NEED_FILL_S.energy,
            handsS: { container: BOX_S, source: SHOP_S, loose: BOX_S, satisfy: tpl.key === "waste" ? 4 : 12 },
          }),
        };

  it("THE BANK ORDERING EMERGES: the half-finished haul beats the nap, priced", () => {
    const pick = decideNeeds([energy, water], hauling, ON);
    expect(pick?.tpl.key).toBe("provision:water");
    expect(pick?.intent).toMatchObject({ kind: "deposit", units: 1 });
  });

  it("…and it is the ARITHMETIC, not the boost: it beats WASTE too (4.5 > BANK_PRIORITY)", () => {
    // Flag off, `BANK_PRIORITY = 4.2` deliberately sits BELOW waste's 4.5 —
    // "the toilet doesn't wait" — so the haul loses. Flag on there is no boost
    // to sit below: one bucket into a dry barrel is worth 192 s of hand-time
    // and the walk home is four, which beats the toilet honestly.
    expect(BANK_PRIORITY).toBeLessThan(waste.priority);
    expect(decideNeeds([waste, water], hauling, OFF)?.tpl.key).toBe("waste");
    expect(decideNeeds([waste, water], hauling, ON)?.tpl.key).toBe("provision:water");
  });

  it("flag OFF the boost is what wins it — the kill-switch keeps the shipped fix", () => {
    expect(decideNeeds([energy, water], hauling, OFF)?.tpl.key).toBe("provision:water");
    // Proof it is the BOOST and not the ladder: the row's own priority loses.
    expect(water.priority).toBeLessThan(energy.priority);
  });

  it("DISTANCE NOW ENTERS SELECTION: a bed at hand beats a meal across the town", () => {
    // The survey's finding: "distance never enters selection". It does now —
    // and the body does the cheap thing first, then the meter climbs and the
    // expensive trip wins on a later decide.
    const hunger = hungerTemplate("food", 1 / NEED_FILL_S.hunger);
    const far = (tpl: NeedTemplate): NeedCtx =>
      tpl.key === "energy"
        ? { ...empty, meter: 1, stations: [bed(2)], price: price({
            fillS: NEED_FILL_S.energy,
            handsS: { container: BOX_S, source: SHOP_S, loose: BOX_S, satisfy: 12 },
          }) }
        : {
            ...empty,
            meter: 1,
            room: 1,
            sources: [{ id: "store:food", place: P("store:food"), units: 9, d: 300 }],
            price: price(),
          };
    expect(decideNeeds([hunger, energy], far, ON)?.tpl.key).toBe("energy");
    // Flag off, hunger's 5 beats energy's 4 whatever the walk costs.
    expect(decideNeeds([hunger, energy], far, OFF)?.tpl.key).toBe("hunger:food");
    // …and the errand is DEFERRED, never dropped: the nap clears its own meter,
    // and the very next decide has nothing cheap left to prefer, so the body
    // takes the long walk it just postponed. (A priced plan that loses does not
    // need a cooldown to stop churning — it needs a better alternative.)
    const rested = (tpl: NeedTemplate): NeedCtx =>
      tpl.key === "energy" ? { ...far(tpl), meter: 0 } : far(tpl);
    expect(decideNeeds([hunger, energy], rested, ON)?.tpl.key).toBe("hunger:food");
  });

  it("the CEILING is the drive's own clock — an over-urgent want never buys more", () => {
    // `driveValueS` clamps (chapter §3), so a starving body is willing to spend
    // at most ONE HUNGER CLOCK of hand-time on a meal: 240 s ≈ 355 m of walking
    // once the stall's own beat is paid. Past that it does something else and
    // comes back — which is the honest answer, not a cooldown.
    const hunger = hungerTemplate("food", 1 / NEED_FILL_S.hunger);
    const trip = (metres: number, meter: number): NeedCtx => ({
      ...empty,
      meter,
      room: 1,
      sources: [{ id: "store:food", place: P("store:food"), units: 9, d: metres }],
      price: price(),
    });
    const net = (metres: number, meter: number) => {
      const ctx = trip(metres, meter);
      const intent = decideNeed(hunger, ctx, ON);
      return NEED_FILL_S.hunger * Math.min(1, (meter * 5 * NEED_PRESSURE_S) / NEED_FILL_S.hunger)
        - costTotalS(intentCost(hunger, ctx, intent));
    };
    expect(net(100, 1)).toBeGreaterThan(0); // worth it at one cycle owed
    expect(net(300, 1)).toBeLessThan(0); // not at 300 m…
    expect(net(300, 1.5)).toBeGreaterThan(0); // …until the meter has climbed
    expect(net(600, 9)).toBeLessThan(0); // and never past the ceiling
  });

  it("an UNPRICED row set decides exactly as it always did (the flag is inert)", () => {
    // Every headless caller and every pure probe lives here: no price board,
    // so nothing separates the rows and the ladder — banking boost included —
    // is the whole answer. Flag on and flag off must agree, row for row.
    const bare = (tpl: NeedTemplate): NeedCtx =>
      tpl.key === "provision:water"
        ? { ...empty, carried: 1, containers: { home: { id: "barrel", place: P("barrel"), units: 0, room: 6 } } }
        : { ...empty, meter: 1, stations: [bed(3)] };
    expect(decideNeeds([energy, water], bare, ON)?.tpl.key).toBe(
      decideNeeds([energy, water], bare, OFF)?.tpl.key,
    );
    expect(decideNeeds([energy, water], bare, ON)?.tpl.key).toBe("provision:water");
  });

  it("THE LIVELOCK INVARIANT survives the switch: a bank never outranks its own acquirer", () => {
    // The spin the floor exists for: hunger takes a unit from the pantry, the
    // put-it-away rule fires on the carried unit, and if the bank outranked
    // hunger the unit would go straight back in the box, forever. Priced, the
    // two are worth ALMOST EXACTLY the same (one ration = one hunger service —
    // the §3 join), which is precisely when a hair of rounding would reopen it.
    const hunger = hungerTemplate("food", 1 / NEED_FILL_S.hunger);
    const provision = provisionTemplate("food", 5, 15);
    const carrying = (tpl: NeedTemplate): NeedCtx => ({
      ...empty,
      meter: 1,
      carried: 1,
      containers: { home: { id: "pantry", place: P("pantry"), units: 0, room: 15, d: 2 } },
      stations: tpl.satisfy.kind === "consume" ? [{ id: "table", place: P("table"), kind: "table", waiting: 0, d: 2 }] : [],
      price: price({ shortage: 1 }),
    });
    for (const opts of [ON, OFF]) {
      const pick = decideNeeds([provision, hunger], carrying, opts);
      expect(pick?.tpl.key).toBe("hunger:food");
    }
  });

  it("ZERO ROOM kills the phantom take — no take-shaped row can win", () => {
    // The survey's pathology, verbatim: "a body with zero room still ranks the
    // take top and walks to the source." Under the flag the take moves nothing,
    // so it is worth nothing and resolves BLOCKED — which shadows no other row.
    const hunger = hungerTemplate("food", 1 / NEED_FILL_S.hunger);
    const full = (tpl: NeedTemplate): NeedCtx =>
      tpl.key === "energy"
        ? { ...empty, meter: 1, stations: [bed(3)], price: price({ fillS: NEED_FILL_S.energy }) }
        : {
            ...empty,
            meter: 1,
            room: 0, // hands full, no bag — `stackRoom` 0
            restock: 6,
            containers: { home: { id: "pantry", place: P("pantry"), units: 9, room: 6, d: 2 } },
            sources: [{ id: "store:food", place: P("store:food"), units: 50, d: 40 }],
            price: price(),
          };
    expect(decideNeed(hunger, full(hunger), ON)).toEqual({ kind: "blocked" });
    const pick = decideNeeds([hunger, energy], full, ON);
    expect(pick?.tpl.key).toBe("energy");
    expect(pick?.blocked?.tpl.key).toBe("hunger:food"); // the want still surfaces
    // Flag off, the floor manufactures the unit and the body walks anyway.
    expect(decideNeed(hunger, full(hunger), OFF)).toMatchObject({ kind: "take", units: 1 });
  });
});

describe("the flag itself", () => {
  it("ships ON — flag-off is the kill-switch, not the default", () => {
    expect(NEED_COST_SELECTION).toBe(true);
  });
});
