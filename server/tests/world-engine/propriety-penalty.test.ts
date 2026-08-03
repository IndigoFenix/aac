// ⚖️ PROPRIETY — "seen, and mildly avoided" (planning-docs/games/
// scope-behaviors.md §2.2 SOURCE, §3.1 the calibration).
//
// THE DECISION THIS PASS IMPLEMENTS, verbatim (user, 2026-08-03):
//
//   "It shouldn't be invisible to them, but they should have a reduced
//    tendency to use them. For now, a constant reduction in priority will do;
//    we'll expand on this once we get into more detailed private property and
//    personality rules."
//
// "Them" is the set of food stores a household has that are not larders: a
// basket somebody set down with an apple still in it, the pet's bowl, a box
// that is somebody's own. Pass 4 made all three ENUMERABLE and then pinned the
// gap — the food templates had no branch that could reach any of them — as a
// decision left to the user. Two things land here:
//
//   ① THE BRANCHES. hunger / thirst / provision gained `storage` + `loose`,
//      and they sit LAST in template order, so the FLAG-OFF path carries the
//      direction by first-match alone: pantry, then stall, then whatever the
//      house happens to have standing about.
//   ② THE PENALTY. `PROPRIETY_PENALTY_S = 40` — one full rung of the priority
//      ladder (`NEED_PRESSURE_S`), ≈ 64 m of extra walking at the villager
//      gait — charged in `acquireFrom`'s per-candidate net to candidates the
//      deciding ROW has no business treating as a larder.
//
// PROPER-NESS IS PER-ROW, and the pet's bowl is the case that proves it: the
// same dish is proper to the animal whose row eats at `bowl` and improper to
// the resident whose row eats at `table`. Nothing anywhere says "bowl".
//
// `properDrawFor` is a host closure bound to a live session, so it is MIRRORED
// here exactly as quest-host writes it — the convention
// `need-costs-and-claims.test.ts` established for the claim helpers. The
// decider under it (`decideNeed`/`acquireFrom`) and the templates are the real
// thing, so a change to either breaks this file rather than sliding past it.
//
// No DOM / GL / session / DB.
import { describe, expect, it } from "@jest/globals";
import {
  cookTemplate,
  decideNeed,
  dressTemplate,
  funTemplate,
  hungerTemplate,
  laundryTemplate,
  NEED_PRESSURE_S,
  PROPRIETY_PENALTY_S,
  provisionTemplate,
  stowTemplate,
  thirstTemplate,
  tidyTemplate,
  type AcquireSpec,
  type NeedCtx,
  type NeedPrice,
  type NeedTemplate,
  type SatisfySpec,
} from "@shared/world-engine/interaction/behavior/needs.js";
import { creatureScope, houseScope, mayUse } from "@shared/world-engine/interaction/behavior/ownership.js";
import { NEED_FILL_S } from "@shared/world-engine/scale.js";

// ── The shipped constants, as the host spends them ────────────────────────
const WALK_MPS = 1.6; // ERRAND_WALK_MPS, the villager pace
const BOX_S = 1.1; // BOX_ACT_DWELL_S — the reach into a box
const SHOP_S = 18; // SHOP_SEC — the beat at a stall

const P = (id: string) => ({ kind: "named" as const, id });
const ON = { costSelection: true };
const OFF = { costSelection: false };

const HOUSE = 0;
const ME = "resident_0_0";
const MATE = "resident_0_1";
const PET = "pet_0_0";
const PANTRY = "furn_0_chest_food";
const BARREL = "furn_0_barrel";
const TABLE = "furn_0_table";
const BOWL = "furn_0_bowl";
const BIN = "furn_0_bin";
const MY_BOX = "furn_0_box_0";
const MATE_BOX = "furn_0_box_1";
const JOINT_BOX = "furn_0_box_joint";
const BASKET = "small:basket_0";
const STORE = "store:food";

/** The price board a resident's hunger ctx carries (quest-host `needPriceOf`):
 *  one ration is worth one hunger service (5 × NEED_PRESSURE_S = 200 s). */
const price = (over: Partial<NeedPrice> = {}): NeedPrice => ({
  walkMps: WALK_MPS,
  fillS: NEED_FILL_S.hunger,
  unitValueS: 5 * NEED_PRESSURE_S,
  shortage: 1,
  handsS: { container: BOX_S, source: SHOP_S, loose: BOX_S, satisfy: 2 },
  ...over,
});

const hunger = (at: readonly string[] = ["table"]) => hungerTemplate("food", 1 / NEED_FILL_S.hunger, at);
const provision = () => provisionTemplate("food", 5, 6);

/** A hungry body with nothing in hand and one free hand. */
const hungryCtx = (over: Partial<NeedCtx> = {}): NeedCtx => ({
  meter: 1,
  carried: 0,
  room: 1,
  containers: {},
  sources: [],
  stations: [],
  price: price(),
  ...over,
});

const box = (id: string, units: number, d: number, improper?: boolean) => ({
  id,
  place: P(id),
  units,
  free: units,
  d,
  ...(improper ? { improper: true } : {}),
});

/** The branch shape of a template, as a readable list. */
const branches = (tpl: NeedTemplate): string[] =>
  tpl.acquire.map((a: AcquireSpec) => (a.kind === "container" ? `container:${a.role}` : a.kind));

// ═══ ① THE BRANCHES, AND WHERE THEY SIT ═══════════════════════════════════

describe("① the makeshift branches — added, and added LAST", () => {
  it("hunger / thirst / provision reach the expanded enumeration", () => {
    expect(branches(hunger())).toEqual(["container:home", "source", "container:storage", "loose"]);
    expect(branches(thirstTemplate(0.01))).toEqual([
      "container:home",
      "source",
      "container:storage",
      "loose",
    ]);
    // A provision row has no `home` BRANCH — home is where it PUTS things.
    expect(branches(provision())).toEqual(["source", "container:storage", "loose"]);
  });

  it("🚨 ORDER IS THE UNPRICED PATH'S WHOLE VOICE: the larder and the stall come first", () => {
    // Flag OFF there is no arithmetic to express "a reduced tendency" in, so
    // the direction is carried by first-match alone. Anything that lets a
    // makeshift branch drift above `home`/`source` silently reverts the
    // decision on the kill-switch path, where nobody would notice.
    for (const tpl of [hunger(), thirstTemplate(0.01), provision()]) {
      const b = branches(tpl);
      const makeshift = Math.min(
        ...["container:storage", "loose"].map((k) => (b.indexOf(k) < 0 ? b.length : b.indexOf(k))),
      );
      const proper = Math.max(
        ...["container:home", "source"].map((k) => b.indexOf(k)),
      );
      expect(makeshift).toBeGreaterThan(proper);
    }
  });

  it("…and the rows deliberately LEFT ALONE keep their shape", () => {
    // The sweep's answer, pinned so a later pass has to argue with it rather
    // than drift into it. `dress` is the direction's own example of nonsense
    // (a change of clothes has no business in the pet's dish); `cook` and
    // `stow` are fed by the rows above them one rung later — provision drains
    // the basket into the larder and the pot draws from the larder, which is
    // the proper-source flow the penalty exists to encourage; `laundry`/`fun`/
    // `tidy` already live on the floor and are not stores at all.
    expect(branches(dressTemplate(0.01))).toEqual(["container:home", "source"]);
    expect(branches(cookTemplate("food", "meal", 2))).toEqual(["container:home", "source"]);
    expect(branches(stowTemplate("clothing", 8))).toEqual(["loose"]);
    expect(branches(laundryTemplate())).toEqual(["loose"]);
    expect(branches(tidyTemplate())).toEqual(["loose"]);
    expect(branches(funTemplate(0.01))).toEqual(["loose", "container:storage"]);
  });
});

// ═══ ② THE CONSTANT, AND WHAT IT BUYS ═════════════════════════════════════

describe("② the exchange rate — one rung, ≈64 m", () => {
  it("is exactly ONE PRIORITY POINT — the direction's 'constant reduction in priority'", () => {
    expect(PROPRIETY_PENALTY_S).toBe(NEED_PRESSURE_S);
  });

  it("…which is ~64 m of walking at the villager gait", () => {
    expect(PROPRIETY_PENALTY_S * WALK_MPS).toBe(64);
  });
});

// ═══ ③ WHAT IS PROPER — the host rule, mirrored ═══════════════════════════

/** quest-host `properDrawFor`, mirrored. THREE ways to be proper:
 *  ① the row's own larder (its `home` container), ② a container among the
 *  row's own satisfy stations (`satisfy.at` — the family's table, the pet's
 *  bowl), ③ a container this body itself owns. Everything else that survived
 *  `mayUse` is improper. */
function properDrawFor(
  owners: ReadonlyMap<string, string | null>,
  cid: string,
  houseIndex: number,
  tpl: NeedTemplate,
  homeId: string,
  boxId: string,
): boolean {
  if (boxId === homeId) return true;
  const satisfy: SatisfySpec = tpl.satisfy;
  const at =
    satisfy.kind === "consume" || satisfy.kind === "rest" || satisfy.kind === "transform"
      ? (satisfy.at ?? [])
      : [];
  for (const kind of at) if (boxId === `furn_${houseIndex}_${kind}`) return true;
  return owners.get(boxId) === creatureScope(cid);
}

/** The shipped seeding (`containerOwner`): communal furniture belongs to the
 *  HOUSEHOLD tier, personal boxes to their member, the shared basket to the
 *  house that owns the floor it stands on. */
const OWNERS = new Map<string, string | null>([
  [PANTRY, houseScope(HOUSE)],
  [BARREL, houseScope(HOUSE)],
  [TABLE, houseScope(HOUSE)],
  [BOWL, houseScope(HOUSE)],
  [BIN, houseScope(HOUSE)],
  [MY_BOX, creatureScope(ME)],
  [MATE_BOX, creatureScope(MATE)],
  [JOINT_BOX, `${creatureScope(ME)}|${creatureScope(MATE)}`],
  [BASKET, houseScope(HOUSE)],
  [STORE, null],
]);

const properForMe = (tpl: NeedTemplate, homeId: string, boxId: string) =>
  properDrawFor(OWNERS, ME, HOUSE, tpl, homeId, boxId);

describe("③ proper / improper, decided per ROW", () => {
  it("PROPER: the row's own larder, its own place at the table, and its own box", () => {
    expect(properForMe(hunger(), PANTRY, PANTRY)).toBe(true); // ① the larder
    expect(properForMe(hunger(), PANTRY, TABLE)).toBe(true); // ② where I eat
    expect(properForMe(hunger(), PANTRY, MY_BOX)).toBe(true); // ③ mine
    expect(properForMe(thirstTemplate(0.01), BARREL, BARREL)).toBe(true);
  });

  it("IMPROPER: the floor basket, the bin, the cupboard, a box a housemate co-owns", () => {
    expect(properForMe(hunger(), PANTRY, BASKET)).toBe(false);
    expect(properForMe(hunger(), PANTRY, BIN)).toBe(false);
    expect(properForMe(hunger(), PANTRY, BOWL)).toBe(false);
    // A JOINTLY owned box admits me (mayUse passes on a `|`-joined owner) and
    // is still not MINE — which is exactly the shape the penalty is for.
    expect(mayUse(ME, HOUSE, OWNERS.get(JOINT_BOX))).toBe(true);
    expect(properForMe(hunger(), PANTRY, JOINT_BOX)).toBe(false);
  });

  it("🚨 THE HOUSEHOLD'S OWN SHARED BASKET IS IMPROPER — it is a TOOL, not a larder", () => {
    // Seeded to the HOUSE, standing at its seed spot in the living room, and
    // every member may use it. None of that makes it a pantry: the household
    // keeps its food in the chest, and a bag left standing is where food
    // happens to be, not where it lives.
    expect(mayUse(ME, HOUSE, OWNERS.get(BASKET))).toBe(true);
    expect(properForMe(hunger(), PANTRY, BASKET)).toBe(false);
  });

  it("🚨 THE PET'S BOWL FALLS OUT OF THE RULE — no clause anywhere says 'bowl'", () => {
    // ONE dish, TWO rows, opposite answers, and the only thing that differs is
    // the row's own `satisfy.at`. A pet's hunger eats at its bowl, so the bowl
    // is where its meal is SUPPOSED to come from; a resident's eats at the
    // table, so reaching into the dog's dinner is makeshift.
    expect(properDrawFor(OWNERS, PET, HOUSE, hunger(["bowl"]), PANTRY, BOWL)).toBe(true);
    expect(properDrawFor(OWNERS, ME, HOUSE, hunger(["table"]), PANTRY, BOWL)).toBe(false);
    // …and symmetrically, the family's table is the pet's makeshift.
    expect(properDrawFor(OWNERS, PET, HOUSE, hunger(["bowl"]), PANTRY, TABLE)).toBe(false);
    expect(properDrawFor(OWNERS, ME, HOUSE, hunger(["table"]), PANTRY, TABLE)).toBe(true);
  });

  it("⚠️ PERMISSION IS ASKED FIRST AND SEPARATELY — a housemate's private box never gets priced", () => {
    // `mayUse` refuses it before the ctx lists it, so no arithmetic here can
    // put it back. The penalty prices the PERMITTED-but-makeshift; it is not a
    // softer version of the ownership gate.
    expect(mayUse(ME, HOUSE, OWNERS.get(MATE_BOX))).toBe(false);
    expect(mayUse(ME, HOUSE, OWNERS.get(BASKET))).toBe(true);
  });
});

// ═══ ④ THE PRICED PATH — a preference, not a wall ═════════════════════════

describe("④ priced: the makeshift store is seen, and mildly avoided", () => {
  it("EMPTY PANTRY: the hungry body eats out of the floor basket", () => {
    // The pantry is listed and reachable — it is simply BARE, which is an
    // offer of nothing. The basket is the only stock in the world, so the
    // penalty has nothing to lose to and the body goes to it.
    const intent = decideNeed(
      hunger(),
      hungryCtx({
        containers: { home: { id: PANTRY, place: P(PANTRY), units: 0, free: 0, room: 6, d: 3 } },
        loose: [box(BASKET, 1, 2, true)],
      }),
      ON,
    );
    expect(intent).toMatchObject({ kind: "take", from: { id: BASKET }, units: 1 });
  });

  it("EMPTY PANTRY: …and out of a box a housemate co-owns, on the same rule", () => {
    const intent = decideNeed(
      hunger(),
      hungryCtx({
        containers: {
          home: { id: PANTRY, place: P(PANTRY), units: 0, free: 0, room: 6, d: 3 },
          storage: box(JOINT_BOX, 2, 2, true),
        },
      }),
      ON,
    );
    expect(intent).toMatchObject({ kind: "take", from: { id: JOINT_BOX }, units: 1 });
  });

  it("STOCKED PANTRY: the proper source wins even though the basket is nearer", () => {
    // Basket at arm's length (2 m), pantry across the house (40 m). The
    // basket's whole geometric advantage is 38 m ≈ 24 s, which one rung
    // outbids — so the body walks past the apple at its feet.
    const intent = decideNeed(
      hunger(),
      hungryCtx({
        containers: { home: box(PANTRY, 4, 40) },
        loose: [box(BASKET, 1, 2, true)],
      }),
      ON,
    );
    expect(intent).toMatchObject({ kind: "take", from: { id: PANTRY } });
  });

  it("🚨 …UP TO THE EXCHANGE RATE, and no further: past ~64 m the basket wins", () => {
    // The crossover, derived rather than guessed: both draws move one unit, so
    // the values cancel exactly and the whole comparison is
    //   d(pantry)/walk  vs  d(basket)/walk + PROPRIETY_PENALTY_S
    // ⇒ the pantry wins while it is less than PROPRIETY_PENALTY_S × walk = 64 m
    // further than the basket. This is the direction as a distance.
    const crossoverM = PROPRIETY_PENALTY_S * WALK_MPS;
    const near = decideNeed(
      hunger(),
      hungryCtx({ containers: { home: box(PANTRY, 4, 2 + crossoverM - 1) }, loose: [box(BASKET, 1, 2, true)] }),
      ON,
    );
    expect(near).toMatchObject({ kind: "take", from: { id: PANTRY } });
    const far = decideNeed(
      hunger(),
      hungryCtx({ containers: { home: box(PANTRY, 4, 2 + crossoverM + 1) }, loose: [box(BASKET, 1, 2, true)] }),
      ON,
    );
    expect(far).toMatchObject({ kind: "take", from: { id: BASKET } });
  });

  it("🚨 A PREFERENCE, NEVER A WALL: the only offer in the world is still taken", () => {
    // Nothing may DROP OUT for being improper. A body with one makeshift store
    // and nothing else must eat, not block — "it shouldn't be invisible to
    // them" is the half of the direction a filter would have broken.
    expect(decideNeed(hunger(), hungryCtx({ loose: [box(BASKET, 1, 2, true)] }), ON)).toMatchObject({
      kind: "take",
      from: { id: BASKET },
    });
    // …and it stays taken however far away it is: the penalty is a constant,
    // so it can shift a choice but never veto the last option standing.
    expect(decideNeed(hunger(), hungryCtx({ loose: [box(BASKET, 1, 500, true)] }), ON)).toMatchObject({
      kind: "take",
      from: { id: BASKET },
    });
  });

  it("PUBLIC SOURCES ARE NEVER IMPROPER — the stall and the well are what they are for", () => {
    // A market at 30 m against a basket at 2 m: the stall carries no penalty
    // and its 18 s dwell is the only thing it pays extra, so it wins the same
    // comparison the pantry wins.
    const intent = decideNeed(
      hunger(),
      hungryCtx({
        sources: [box(STORE, 6, 30)],
        loose: [box(BASKET, 1, 2, true)],
      }),
      ON,
    );
    expect(intent).toMatchObject({ kind: "take", from: { id: STORE } });
  });

  it("ONE DISH, TWO ROWS: the pet draws from its bowl, the resident walks to the chest", () => {
    // THE SAME GEOMETRY BOTH TIMES — bowl at 1 m, chest at 50 m — and the same
    // stock in both. The only difference in the world is WHO is deciding, and
    // the flag on the bowl is not authored: it is `properDrawFor`'s answer for
    // that body's own row, exactly as the host computes it.
    const geometry = (cid: string, tpl: NeedTemplate): NeedCtx =>
      hungryCtx({
        containers: {
          home: box(PANTRY, 4, 50),
          storage: box(BOWL, 1, 1, !properDrawFor(OWNERS, cid, HOUSE, tpl, PANTRY, BOWL)),
        },
      });
    const petRow = hunger(["bowl"]);
    const myRow = hunger(["table"]);
    expect(decideNeed(petRow, geometry(PET, petRow), ON)).toMatchObject({ kind: "take", from: { id: BOWL } });
    expect(decideNeed(myRow, geometry(ME, myRow), ON)).toMatchObject({ kind: "take", from: { id: PANTRY } });
  });

  it("UNPRICED ⇒ UNCHARGED: a ctx with no price board scores propriety at zero", () => {
    // The byte-identical property every step-④ term keeps. A headless probe
    // compares value only, so the flag on and off must land on the same pick —
    // the first offer in template order.
    const bare: NeedCtx = {
      meter: 1,
      carried: 0,
      room: 1,
      containers: { storage: box(BIN, 1, 90, true) },
      sources: [],
      stations: [],
      loose: [box(BASKET, 1, 2, true)],
    };
    // The storage branch comes before `loose` in template order, and with
    // every term at zero the argmax keeps the first maximum.
    expect(decideNeed(hunger(), bare, ON)).toMatchObject({ kind: "take", from: { id: BIN } });
    expect(decideNeed(hunger(), bare, OFF)).toMatchObject({ kind: "take", from: { id: BIN } });
  });
});

// ═══ ⑤ THE UNPRICED PATH — branch order carries the direction ═════════════

describe("⑤ flag OFF: pantry, then stall, then the makeshift store", () => {
  /** Everything at once: a stocked pantry, a stocked stall, a box and a
   *  basket. First-match in template order is the whole rule. */
  const everything = (over: Partial<NeedCtx> = {}): NeedCtx =>
    hungryCtx({
      containers: { home: box(PANTRY, 4, 40), storage: box(BIN, 3, 1, true) },
      sources: [box(STORE, 6, 30)],
      loose: [box(BASKET, 2, 1, true)],
      ...over,
    });

  it("the larder first, however far it is", () => {
    expect(decideNeed(hunger(), everything(), OFF)).toMatchObject({ kind: "take", from: { id: PANTRY } });
  });

  it("the stall when the larder is bare", () => {
    const intent = decideNeed(
      hunger(),
      everything({ containers: { home: box(PANTRY, 0, 40), storage: box(BIN, 3, 1, true) } }),
      OFF,
    );
    expect(intent).toMatchObject({ kind: "take", from: { id: STORE } });
  });

  it("🚨 the makeshift store ONLY when both are empty", () => {
    const intent = decideNeed(
      hunger(),
      everything({
        containers: { home: box(PANTRY, 0, 40), storage: box(BIN, 3, 1, true) },
        sources: [box(STORE, 0, 30)],
      }),
      OFF,
    );
    expect(intent).toMatchObject({ kind: "take", from: { id: BIN } });
  });

  it("…and the floor last of all", () => {
    const intent = decideNeed(
      hunger(),
      everything({
        containers: { home: box(PANTRY, 0, 40) },
        sources: [box(STORE, 0, 30)],
      }),
      OFF,
    );
    expect(intent).toMatchObject({ kind: "take", from: { id: BASKET } });
  });
});

// ═══ ⑥ THE TOOL GETS EMPTIED INTO THE LARDER ═════════════════════════════

describe("⑥ provision drains the floor basket into the pantry", () => {
  /** The restock row's ctx: the pantry is 6 short, the body has a bag. */
  const restockCtx = (over: Partial<NeedCtx> = {}): NeedCtx => ({
    carried: 0,
    room: 8,
    containers: { home: { id: PANTRY, place: P(PANTRY), units: 0, free: 0, room: 6, d: 3 } },
    sources: [],
    stations: [],
    price: price(),
    ...over,
  });

  it("🚨 THE DRAIN: with no stall to beat it, the whole basket goes home", () => {
    const intent = decideNeed(provision(), restockCtx({ loose: [box(BASKET, 3, 2, true)] }), ON);
    expect(intent).toMatchObject({ kind: "take", from: { id: BASKET }, units: 3 });
  });

  it("…and the very next decide banks it in the pantry — ONE WAY, never back", () => {
    // A floor container is a source of opportunity and never a destination:
    // `designatedContainerFor` names furniture homes only, so what comes out of
    // the basket goes into the chest and the loop has no return leg.
    expect(
      decideNeed(provision(), restockCtx({ carried: 3, loose: [box(BASKET, 0, 2, true)] }), ON),
    ).toMatchObject({ kind: "deposit", into: { id: PANTRY }, units: 3 });
  });

  it("A BARE-HANDED body drains the basket unless the stall is within ~39 m", () => {
    // No bag ⇒ ONE unit either way, so the values cancel exactly and the whole
    // comparison is the basket's 1.1 s reach + the 40 s rung against the
    // stall's 18 s dwell + its walk. The stall's dwell advantage is
    // 40 + 1.1 − 18 = 23.1 s ⇒ 36.96 m, plus the basket's own 2 m: the
    // crossover is a stall ~39 m out.
    const crossoverM = (PROPRIETY_PENALTY_S + BOX_S - SHOP_S) * WALK_MPS + 2;
    expect(Math.round(crossoverM)).toBe(39);
    const bare = (storeD: number) =>
      decideNeed(
        provision(),
        restockCtx({ room: 1, sources: [box(STORE, 6, storeD)], loose: [box(BASKET, 3, 2, true)] }),
        ON,
      );
    expect(bare(crossoverM + 1)).toMatchObject({ kind: "take", from: { id: BASKET }, units: 1 });
    expect(bare(crossoverM - 1)).toMatchObject({ kind: "take", from: { id: STORE }, units: 1 });
  });

  it("…but a RESTOCK-SIZED trip still goes to the stall: more units outbid one rung", () => {
    // With a bag, the stall offers six units against the basket's three, and
    // three extra rations are worth far more than 40 s of walking. The proper
    // source is preferred not because it is proper but because it is BETTER —
    // which is what makes the penalty a nudge rather than the decision.
    const intent = decideNeed(
      provision(),
      restockCtx({ sources: [box(STORE, 6, 30)], loose: [box(BASKET, 3, 2, true)] }),
      ON,
    );
    expect(intent).toMatchObject({ kind: "take", from: { id: STORE } });
  });
});

// ═══ ⑦ CONSERVATION ACROSS A FLOOR-BASKET MEAL ═══════════════════════════

describe("⑦ one apple, one place — the whole meal audited", () => {
  it("🚨 nothing is minted and nothing evaporates from basket to belly", () => {
    // quest-host's take + consume effects, mirrored on their accounting alone
    // (take-first, account-second): the unit is credited to the body and
    // debited from the container it came out of — bolted down or not — and the
    // meal debits the body and credits the only sink there is.
    const basket: Record<string, number> = { apple: 1 };
    const body: Record<string, number> = {};
    let eaten = 0;
    const total = () => (basket.apple ?? 0) + (body.apple ?? 0) + eaten;
    const before = total();

    // ① the take, from the basket WHERE IT LIES (no re-pickup of the basket).
    if ((basket.apple ?? 0) > 0) {
      body.apple = (body.apple ?? 0) + 1;
      basket.apple! -= 1;
    }
    expect(total()).toBe(before);
    expect(basket.apple).toBe(0);

    // ② the meal at the table.
    if ((body.apple ?? 0) > 0) {
      body.apple! -= 1;
      eaten += 1;
    }
    expect(total()).toBe(before);
    expect(body.apple).toBe(0);
    expect(eaten).toBe(1);
  });

  it("…and the BASKET itself never moved — the draw took a unit, not the box", () => {
    // quest-host's `asContainerSource` fork, mirrored: a step that names a
    // REGISTERED container from an item-typed row means "reach into it", so
    // the loose-prop pickup arm is never entered and the basket stays standing
    // where it was. Getting this wrong is the item-conservation bug in
    // miniature — a body that walked off with the household's only bag.
    const registered = new Set([BASKET]);
    const carryKindsOfFood = ["apple", "banana"];
    const asContainerSource = (objId: string, glyph: string, goodKey: string): boolean => {
      if (!registered.has(objId)) return false;
      if (goodKey) return !carryKindsOfFood.includes(glyph);
      return false; // an UNTYPED row (relieve) means the object itself
    };
    expect(asContainerSource(BASKET, "basket", "food")).toBe(true); // draw from it
    expect(asContainerSource(BASKET, "basket", "")).toBe(false); // relieve: lift IT

    const floorProps = new Set([BASKET]);
    // the food row's take: a container source ⇒ the prop register is untouched
    if (!asContainerSource(BASKET, "basket", "food")) floorProps.delete(BASKET);
    expect([...floorProps]).toEqual([BASKET]);
  });
});
