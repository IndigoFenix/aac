// STEP ④, PASS 4 — ⑤ DEFER: PARKED GOALS REPLACE THE FAILURE COOLDOWNS
// (planning-docs/games/scope-behaviors.md §2.5 DEFER, §4.3, §7 step 5).
//
// The chapter's indictment of what stood here, verbatim: "five body-rung
// cooldowns that are deferral-shaped amnesia (`NEED_PURSUIT_RETRY_S`,
// `SHOP_RETRY_COOLDOWN_S`…): 'this plan failed, don't reconsider' — a
// plan-quality memory with a stopwatch where a price should be." And the
// verdict: "A failed plan doesn't set a cooldown — it prices at ∞ and loses the
// argmax until the world changes; the wake condition is what 'the world
// changed' means."
//
// Two of those cooldowns are gone. What this file pins:
//
//  ① `decideNeeds`' park seat — REAL CODE (needs.ts `NeedDecideOpts.parked`):
//     a parked row is never resolved (its ctx is not even asked for) and still
//     surfaces as the blocked want, so adoption and the beg bubble see exactly
//     what the cooldowns used to strand.
//  ② the wake predicate — two epochs, a DERIVED due time, and a `staleAt`
//     backstop derived from the row's own fill clock. Mirrored from quest-host
//     (`parkNeed`/`needParked`), the convention `need-costs-and-claims.test.ts`
//     established for host closures.
//  ③ the shelf's derived wake — the market is a closed form over the town
//     clock, so "when will there be something there" is answered by the SAME
//     formula, once, at park time. Not a retry timer.
//
// No DOM / GL / session / DB.
import { describe, expect, it } from "@jest/globals";
import {
  decideNeeds,
  hungerTemplate,
  provisionTemplate,
  tidyTemplate,
  type NeedCtx,
  type NeedTemplate,
} from "@shared/world-engine/interaction/behavior/needs.js";
import { NEED_FILL_S } from "@shared/world-engine/scale.js";

const P = (id: string) => ({ kind: "named" as const, id });

// ═══ ① THE PARK SEAT IN decideNeeds (real code) ═══════════════════════════

describe("⑤ DEFER — a parked row is skipped BEFORE it is resolved", () => {
  const hunger = hungerTemplate("food", 1 / NEED_FILL_S.hunger);
  const tidy = tidyTemplate();
  const ROWS: NeedTemplate[] = [hunger, tidy];

  /** A house with food in the chest and one toy on the floor: hunger can eat
   *  and tidy can sweep, so BOTH rows are actionable and hunger (5) wins. */
  const ctxOf = (tpl: NeedTemplate): NeedCtx => ({
    meter: tpl.key === "hunger:food" ? 1 : 0,
    carried: 0,
    room: 4,
    sources: [],
    stations: [{ id: "furn_0_table", place: P("furn_0_table"), kind: "table", waiting: 0, d: 1 }],
    containers:
      tpl.key === "hunger:food"
        ? { home: { id: "chest", place: P("chest"), units: 3, free: 3, d: 2 } }
        : { storage: { id: "box", place: P("box"), units: 0, room: 9, d: 2 } },
    ...(tpl.key === "tidy" ? { loose: [{ id: "toy", place: P("toy"), units: 1, d: 1 }] } : {}),
  });

  it("no park, no change: the shipped decision, row for row", () => {
    expect(decideNeeds(ROWS, ctxOf)).toMatchObject({ tpl: { key: "hunger:food" } });
  });

  it("🚨 THE PARKED ROW'S CTX IS NEVER ASKED FOR — the whole saving", () => {
    // The point of parking one level up from `intentCost` is that the ctx is
    // the expensive half: a market read, a container sweep, a loose-prop scan.
    // A park that still resolved the row to price it at ∞ would have bought
    // nothing at all.
    const asked: string[] = [];
    decideNeeds(
      ROWS,
      (tpl) => {
        asked.push(tpl.key);
        return ctxOf(tpl);
      },
      { parked: (tpl) => tpl.key === "hunger:food" },
    );
    expect(asked).toEqual(["tidy"]);
  });

  it("the row beneath it acts instead — a park never freezes the body", () => {
    expect(decideNeeds(ROWS, ctxOf, { parked: (tpl) => tpl.key === "hunger:food" })).toMatchObject({
      tpl: { key: "tidy" },
      intent: { kind: "take" },
    });
  });

  it("⚠️ …and the parked want STILL SURFACES as blocked (adoption keeps seeing it)", () => {
    // The one thing the deleted cooldowns did do right: a hungry body whose
    // market vanished decided BLOCKED, which is what a housemate's adoption row
    // reads. Dropping a parked row silently would have made a parked hunger
    // invisible to the only body that could fix it.
    const d = decideNeeds(ROWS, ctxOf, { parked: (tpl) => tpl.key === "hunger:food" });
    expect(d?.blocked).toMatchObject({ tpl: { key: "hunger:food" }, intent: { kind: "blocked" } });
  });

  it("everything parked ⇒ the blocked want IS the decision (the genuinely stuck body)", () => {
    const d = decideNeeds(ROWS, ctxOf, { parked: () => true });
    expect(d).toMatchObject({ tpl: { key: "hunger:food" }, intent: { kind: "blocked" } });
    expect(d?.blocked?.tpl.key).toBe("hunger:food");
  });

  it("a park is not a priority: the TOP parked want surfaces, not the first", () => {
    const d = decideNeeds([tidy, hunger], ctxOf, { parked: () => true });
    expect(d?.blocked?.tpl.key).toBe("hunger:food"); // 5 beats 1.2
  });
});

// ═══ ② THE WAKE — quest-host's parkNeed/needParked, mirrored ══════════════

describe("⑤ DEFER — the wake is a CONDITION, never a clock", () => {
  /** quest-host `NeedPark`, mirrored. */
  interface Park {
    scope: "row" | "pursuit";
    props: number;
    stock: number;
    dueAt: number;
    staleAt: number;
    why: string;
  }
  /** The bits of QuestSession a park reads. */
  interface Sess {
    townClock: number;
    needsPropsEpoch: number;
    needsStockEpoch: number;
    needParks: Map<string, Park>;
  }
  const sess = (): Sess => ({ townClock: 0, needsPropsEpoch: 0, needsStockEpoch: 0, needParks: new Map() });

  /** quest-host `needClockKeyOf` + `needFillS`, mirrored: the backstop horizon
   *  is the ROW'S OWN fill clock — derived per row, never a literal. */
  const staleHorizonOf = (tplKey: string): number => {
    switch (tplKey.split(":")[0]) {
      case "hunger": return NEED_FILL_S.hunger;
      case "thirst": return NEED_FILL_S.thirst;
      case "hygiene": return NEED_FILL_S.hygiene;
      default: return NEED_FILL_S.hunger; // the anchor, for rows with no clock
    }
  };

  /** quest-host `parkNeed`, mirrored. */
  const parkNeed = (
    s: Sess,
    cid: string,
    tplKey: string,
    o: { scope: Park["scope"]; why: string; dueAt?: number },
  ): void => {
    s.needParks.set(`${o.scope}|${cid}|${tplKey}`, {
      scope: o.scope,
      props: s.needsPropsEpoch,
      stock: s.needsStockEpoch,
      dueAt: o.dueAt ?? 0,
      staleAt: s.townClock + staleHorizonOf(tplKey),
      why: o.why,
    });
  };

  /** quest-host `needParked`, mirrored — including the CONSUME on wake. */
  const needParked = (s: Sess, cid: string, tplKey: string, scope: Park["scope"]): boolean => {
    const key = `${scope}|${cid}|${tplKey}`;
    const p = s.needParks.get(key);
    if (!p) return false;
    const woke =
      p.props !== s.needsPropsEpoch ||
      p.stock !== s.needsStockEpoch ||
      (p.dueAt > 0 && s.townClock >= p.dueAt) ||
      s.townClock >= p.staleAt;
    if (!woke) return true;
    s.needParks.delete(key);
    return false;
  };

  const ME = "resident_0_0";

  it("parked stays parked while NOTHING moves — no clock enters it at all", () => {
    const s = sess();
    parkNeed(s, ME, "hunger:food", { scope: "row", why: "the shelf was bare" });
    expect(needParked(s, ME, "hunger:food", "row")).toBe(true);
    s.townClock += NEED_FILL_S.hunger - 1; // time alone changes nothing…
    expect(needParked(s, ME, "hunger:food", "row")).toBe(true);
  });

  it("🚨 A CONTAINER GAINING UNITS WAKES IT — 'the world changed', made literal", () => {
    const s = sess();
    parkNeed(s, ME, "hunger:food", { scope: "row", why: "the shelf was bare" });
    expect(needParked(s, ME, "hunger:food", "row")).toBe(true);
    s.needsStockEpoch++; // a housemate banked a haul in the chest
    expect(needParked(s, ME, "hunger:food", "row")).toBe(false);
  });

  it("…and so does a loose prop landing (the epoch the dormancy gate already rode)", () => {
    const s = sess();
    parkNeed(s, ME, "tidy", { scope: "row", why: "nothing could be lifted" });
    s.needsPropsEpoch++;
    expect(needParked(s, ME, "tidy", "row")).toBe(false);
  });

  it("THE WAKE CONSUMES THE PARK — a woken row re-decides at full price, once", () => {
    const s = sess();
    parkNeed(s, ME, "hunger:food", { scope: "row", why: "the shelf was bare" });
    s.needsStockEpoch++;
    expect(needParked(s, ME, "hunger:food", "row")).toBe(false);
    expect(s.needParks.size).toBe(0);
    // …and nothing re-arms it: only a fresh FAILURE parks again.
    expect(needParked(s, ME, "hunger:food", "row")).toBe(false);
  });

  it("the DERIVED wake fires at its own moment, and not before", () => {
    const s = sess();
    parkNeed(s, ME, "hunger:food", { scope: "row", why: "the shelf was bare", dueAt: 60 });
    s.townClock = 59.9;
    expect(needParked(s, ME, "hunger:food", "row")).toBe(true);
    s.townClock = 60;
    expect(needParked(s, ME, "hunger:food", "row")).toBe(false);
  });

  it("⚠️ THE BACKSTOP: a park expires on the ROW'S OWN fill clock, never a literal", () => {
    const s = sess();
    parkNeed(s, ME, "hunger:food", { scope: "row", why: "the shelf was bare" });
    parkNeed(s, ME, "hygiene", { scope: "row", why: "no tub" });
    // Two rows, two horizons, and the ratio is the two drives' own clocks —
    // which is the whole difference between "derived" and "a number somebody
    // chose". A hunger may be ignored for a hunger's worth of seconds.
    expect(s.needParks.get(`row|${ME}|hunger:food`)!.staleAt).toBe(NEED_FILL_S.hunger);
    expect(s.needParks.get(`row|${ME}|hygiene`)!.staleAt).toBe(NEED_FILL_S.hygiene);
    s.townClock = NEED_FILL_S.hunger;
    expect(needParked(s, ME, "hunger:food", "row")).toBe(false); // stale — re-decide
    expect(needParked(s, ME, "hygiene", "row")).toBe(true); // its own clock is longer
  });

  it("the two SCOPES are separate goals: a parked route leaves the row alone", () => {
    // A pursuit that could not be finished parks the ROUTE — the legacy walker
    // (which can still shop and draw water) keeps the motive. Parking the whole
    // row for that would silence the engine that might have served it.
    const s = sess();
    parkNeed(s, ME, "hunger:food", { scope: "pursuit", why: "the plan could not be finished" });
    expect(needParked(s, ME, "hunger:food", "pursuit")).toBe(true);
    expect(needParked(s, ME, "hunger:food", "row")).toBe(false);
  });

  it("parks are PER BODY — one shopper's wasted walk never parks its housemate", () => {
    const s = sess();
    parkNeed(s, ME, "provision:food", { scope: "row", why: "the shelf was bare" });
    expect(needParked(s, ME, "provision:food", "row")).toBe(true);
    expect(needParked(s, "resident_0_1", "provision:food", "row")).toBe(false);
  });

  it("re-parking an already-parked goal RESTARTS the wait (the plan failed again)", () => {
    const s = sess();
    parkNeed(s, ME, "hunger:food", { scope: "row", why: "the shelf was bare" });
    s.townClock = 100;
    parkNeed(s, ME, "hunger:food", { scope: "row", why: "the shelf was bare" });
    expect(s.needParks.get(`row|${ME}|hunger:food`)!.staleAt).toBe(100 + NEED_FILL_S.hunger);
    expect(s.needParks.size).toBe(1);
  });

  it("DETERMINISM: the town clock and the epochs are the only inputs", () => {
    const a = sess();
    const b = sess();
    for (const s of [a, b]) {
      s.townClock = 42;
      parkNeed(s, ME, "provision:food", { scope: "row", why: "the shelf was bare", dueAt: 300 });
      s.townClock = 200;
    }
    expect(needParked(a, ME, "provision:food", "row")).toBe(needParked(b, ME, "provision:food", "row"));
    expect([...a.needParks.values()]).toEqual([...b.needParks.values()]);
  });
});

// ═══ ③ THE DERIVED WAKE — the shelf's own closed form ═════════════════════

describe("⑤ DEFER — 'the shelf restocked' is DERIVED, not a retry timer", () => {
  const DAY = 240; // FOOD_DAY_SEC

  /** A market shelf as goods.ts models it: stocked at dawn, drawn down across
   *  the day by the modelled shoppers, floored to whole units. Pure in `t`. */
  const shelfAt = (t: number): number => {
    const dayFrac = (((t / DAY) % 1) + 1) % 1;
    return Math.max(0, Math.floor(6 * (1 - dayFrac) - 0.2));
  };

  /** quest-host `shelfRestockAt`, mirrored: one day's horizon, 24 samples of
   *  the SAME function the decide read — evaluated once, at park time. */
  const shelfRestockAt = (now: number): number => {
    const want = shelfAt(now) + 1;
    for (let i = 1; i <= 24; i++) {
      const t = now + (DAY * i) / 24;
      if (shelfAt(t) >= want) return t;
    }
    return now + DAY;
  };

  it("🚨 a body that walked to a BARE stall waits for the CART, not for a stopwatch", () => {
    // Late in the day the shelf is empty and stays empty: no number of seconds
    // makes it worth walking back. The wake lands after the next dawn, which is
    // the only moment the world says otherwise.
    const now = DAY * 0.95;
    expect(shelfAt(now)).toBe(0);
    const wake = shelfRestockAt(now);
    expect(wake).toBeGreaterThan(DAY); // past the dawn boundary
    expect(shelfAt(wake)).toBeGreaterThan(0);
  });

  it("the flicker that caused the loop cannot re-arm the trip EARLY", () => {
    // The reported failure: the floored shelf ticks 0 → 1 → 0 as the modelled
    // shoppers draw it, so a body kept marching out and back empty-handed. The
    // property that kills it is that the wake is never EARLY — nothing sends
    // the body back while the stall is still bare.
    const now = DAY * 0.95;
    const want = shelfAt(now) + 1;
    const wake = shelfRestockAt(now);
    let truth = now;
    while (shelfAt(truth) < want) truth += 0.5; // when the shelf really turns
    expect(wake).toBeGreaterThanOrEqual(truth);
    // …and LATE only by the sampling grid, which is the documented coarseness:
    // an answer that lands a step late costs a step of waiting, never a trip.
    expect(wake - truth).toBeLessThanOrEqual(DAY / 24);
  });

  it("…and it is never a FLAT wait: the same failure at two hours waits two lengths", () => {
    // The stopwatch it replaces answered 90 s whenever it was asked. This
    // answers a distance to an event, so it shrinks as the event approaches.
    const early = shelfRestockAt(DAY * 0.55) - DAY * 0.55;
    const late = shelfRestockAt(DAY * 0.95) - DAY * 0.95;
    expect(late).toBeLessThan(early);
  });

  it("a shelf the economy has stopped supplying still bounds the wait at one day", () => {
    const dead = (_t: number) => 0;
    const restockAt = (now: number): number => {
      for (let i = 1; i <= 24; i++) {
        const t = now + (DAY * i) / 24;
        if (dead(t) >= dead(now) + 1) return t;
      }
      return now + DAY; // …and the park's own staleAt bounds it again, below
    };
    expect(restockAt(10)).toBe(10 + DAY);
  });
});

// ═══ WHAT A PARK IS NOT ═══════════════════════════════════════════════════

describe("⑤ DEFER — the market prices honestly the whole time", () => {
  // §4.3's other half: "the market prices low instead of vanishing from ctx".
  // The stall used to be DELETED from the ctx for 90 s, so the deciding body
  // could not tell "the market is empty" from "there is no market" — and priced
  // neither. Now an empty shelf is simply an offer of nothing, which
  // `acquireFrom` passes over on the arithmetic.
  const provision = provisionTemplate("food", 5, 6);

  const ctx = (shelfUnits: number): NeedCtx => ({
    carried: 0,
    room: 6,
    restock: 5,
    containers: { home: { id: "chest", place: P("chest"), units: 0, room: 6, d: 2 } },
    sources: [{ id: "store:food", place: P("store:food"), units: shelfUnits, free: shelfUnits, d: 40 }],
    stations: [],
  });

  it("an EMPTY but VISIBLE stall is no offer — the row blocks, nothing is hidden", () => {
    expect(decideNeeds([provision], () => ctx(0))).toMatchObject({
      tpl: { key: "provision:food" },
      intent: { kind: "blocked" },
    });
  });

  it("…and one unit on it is an offer again, on the very next decide", () => {
    expect(decideNeeds([provision], () => ctx(1))).toMatchObject({
      tpl: { key: "provision:food" },
      intent: { kind: "take", units: 1 },
    });
  });
});
