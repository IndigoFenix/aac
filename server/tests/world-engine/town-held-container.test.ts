// THE THING IN THE HANDS — three live-observed defects, pinned.
//
// User report (2026-08-02, verbatim):
//   ① "When I instructed someone to pick up a basket, they seemed unable to put
//      it down, and this also seemed to block them from eating or drinking.
//      They did go out shopping but the basket was empty when they returned."
//   ② "Someone took multiple drinks of water from the barrel before eventually
//      stopping, but the water didn't get depleted normally."
//   ③ "I think 'put down whatever you're holding' should be treated as a need —
//      just one that is weaker than most other needs, so it only happens if
//      they aren't doing anything with the item they are using."
//
// ①+② turned out to be ONE FAULT LINE with two faces, and both faces are here:
//
//   THE HELD BAG IS IN NO CARRY VIEW. `bodyCarryView` reports what a bag
//   CONTAINS and never the bag — "it is the shelf, not the goods"
//   (scope-shape.ts), which is right for an inventory strip and fatal for a
//   put-down. `ctx.carried` was 0 for every row, `takeUnitsFromBody` refuses
//   the hands instance when it is a bag, `bagHolding` looks for the bag's own
//   glyph INSIDE it, and `bankCarried` folds the same empty view — so a basket
//   that reached a pair of hands could not be released by ANY path in the
//   engine. Answered by `relieveTemplate` (the ③ directive) plus an explicit
//   bag arm on the drop effect.
//
//   THE WITHDRAW BAILED ON A FULL HAND. The `stock:` pick asked `npcCarrying`,
//   so a body holding its own basket — precisely a body that CAN take
//   something — drew nothing, while the plan re-issued the same withdraw every
//   tick up to COMMAND_ACT_CAP. Five visible reaches into the barrel, one
//   (or zero) units gone: report ②, exactly. Answered by asking `stackRoom`
//   instead and drawing through the one door.
//
// The host closures involved are bound to a live 3D session, so they are
// MIRRORED here exactly as quest-host writes them — the convention
// `town-body-carry.test.ts` uses for the two carry doors and
// `need-costs-and-claims.test.ts` for the claim ledger. Everything that can be
// the REAL rule is the real rule: the templates, the walker, the price
// arithmetic, `livesOnTheFloor`, the ladder, `activeBag`/`stackRoom`.
//
// No DOM / GL / session / DB.
import { describe, expect, it } from "@jest/globals";
import {
  NEED_PRESSURE_S,
  decideNeed,
  decideNeeds,
  funTemplate,
  hungerTemplate,
  provisionTemplate,
  relieveTemplate,
  rowValueS,
  thirstTemplate,
  tidyTemplate,
  unloadTemplate,
  type NeedCtx,
  type NeedPrice,
  type NeedTemplate,
} from "@shared/world-engine/interaction/behavior/needs.js";
import {
  designatedContainerId,
  livesOnTheFloor,
} from "@shared/world-engine/kernel/town/container-home.js";
import { PORTABLE_CONTAINERS, containerDefOfGlyph } from "@shared/world-engine/kernel/town/containers.js";
import {
  activeBag,
  bodyCarryView,
  handsFree,
  stackRoom,
  type BagRef,
  type BodyCarry,
} from "@shared/world-engine/kernel/town/scope-shape.js";
import { isLargeGlyph, totalStackUnits } from "@shared/world-engine/kernel/town/goods-kinds.js";
import { NEED_FILL_S } from "@shared/world-engine/scale.js";

const CID = "resident_0_1";
const HOUSE = 0;
const BASKET = "small:basket1";
const BARREL = "furn_0_barrel";
const CHEST = "furn_0_chest_food";
const BOX = "furn_0_box_1";
const TABLE = "furn_0_table";
const BARREL_CAP = 6; // quest-host `BARREL_CAP`
const BARREL_REFILL_BELOW = 2; // quest-host `BARREL_REFILL_BELOW`
const TIDY_GRACE_S = 45; // quest-host `TIDY_GRACE_S`
const BOX_ACT_DWELL_S = 1.1;

// ── The world the host reads, mirrored ────────────────────────────────────

interface Bench {
  /** `session.containerStock` — the only place stacks live. */
  stock: Map<string, Record<string, number>>;
  /** `session.smallProps` — every prop the game minted, with the `at` stamp
   *  that paces the grace period. */
  props: Map<string, { glyph: string; at: number }>;
  /** The ONE object in the hands (world `ObjectState.carriedBy`), per body. */
  hands: Map<string, string>;
  /** `session.wornBags`. */
  worn: Map<string, { objId: string; glyph: string }>;
  /** `session.townClock`. */
  clock: number;
}

function bench(): Bench {
  return { stock: new Map(), props: new Map(), hands: new Map(), worn: new Map(), clock: 1000 };
}

function addProp(b: Bench, objId: string, glyph: string): void {
  b.props.set(objId, { glyph, at: b.clock });
  if (containerDefOfGlyph(glyph)) b.stock.set(objId, b.stock.get(objId) ?? {});
}

/** quest-host `bagRefOf` — the alias law: the SAME map the registry holds. */
function bagRefOf(b: Bench, objId: string, glyph: string): BagRef | null {
  const def = containerDefOfGlyph(glyph);
  if (!def?.hold) return null;
  let stock = b.stock.get(objId);
  if (!stock) {
    stock = {};
    b.stock.set(objId, stock);
  }
  return { objId, glyph, stock, capacity: def.capacity };
}

/** quest-host `bodyCarryOf`. */
function carryOf(b: Bench, cid: string): BodyCarry {
  const carry: BodyCarry = { inHand: null, worn: null };
  const w = b.worn.get(cid);
  if (w) carry.worn = bagRefOf(b, w.objId, w.glyph);
  const objId = b.hands.get(cid);
  const rec = objId ? b.props.get(objId) : undefined;
  if (objId && rec) {
    const bag = bagRefOf(b, objId, rec.glyph);
    carry.inHand = { objId, glyph: rec.glyph, ...(bag ? { bag } : {}) };
  }
  return carry;
}

/** quest-host `takeIntoHands({kind:"object"})` — and the `at` re-stamp that
 *  makes a fresh hold a fresh event (the command's grace). */
function takeIntoHands(b: Bench, cid: string, objId: string): boolean {
  if (b.hands.has(cid)) return false;
  const rec = b.props.get(objId);
  if (!rec) return false;
  b.hands.set(cid, objId);
  rec.at = b.clock;
  return true;
}

/** quest-host `setDownFromHands({kind:"ground"})` — the prop goes on being the
 *  item it is, under the SAME object id, so a bag's stock is never orphaned. */
function setDownFromHands(b: Bench, cid: string): string | null {
  const objId = b.hands.get(cid);
  if (!objId) return null;
  b.hands.delete(cid);
  return objId;
}

/** quest-host `giveUnitsToBody` — the active bag, else ONE instance in free
 *  hands. Returns what actually moved. */
function giveUnitsToBody(b: Bench, cid: string, glyph: string, n: number): number {
  if (n <= 0) return 0;
  const carry = carryOf(b, cid);
  const bag = activeBag(carry);
  if (bag) {
    const take = Math.min(n, stackRoom(carry));
    if (take <= 0) return 0;
    bag.stock[glyph] = (bag.stock[glyph] ?? 0) + take;
    return take;
  }
  if (!handsFree(carry)) return 0;
  const objId = `small:mint_${b.props.size}_${glyph}`;
  addProp(b, objId, glyph);
  b.hands.set(cid, objId);
  return 1;
}

/** quest-host `takeUnitsFromBody` — hands instance first (never a bag: a bag
 *  is not a unit), then the active bag, then the other one. */
function takeUnitsFromBody(b: Bench, cid: string, glyph: string, n: number): number {
  if (n <= 0) return 0;
  let left = n;
  const carry = carryOf(b, cid);
  if (carry.inHand && !carry.inHand.bag && carry.inHand.glyph === glyph) {
    b.props.delete(carry.inHand.objId);
    b.hands.delete(cid);
    left--;
  }
  for (const bag of [activeBag(carry), carry.inHand?.bag ? carry.worn : null]) {
    if (!bag) continue;
    while (left > 0 && (bag.stock[glyph] ?? 0) > 0) {
      bag.stock[glyph]! -= 1;
      if (bag.stock[glyph]! <= 0) delete bag.stock[glyph];
      left--;
    }
  }
  return n - left;
}

/** THE PROVISIONED HEADS of this house — food, water, clothing, treats. Their
 *  own rows walk them, so neither the tidy chore nor the put-down row touches
 *  them (quest-host `provisionedHeads`, narrowed to what these cases use). */
const PROVISIONED = new Set(["water", "apple", "bread", "shirt"]);

/** THE HOUSE'S BOXES AND WHAT THEY HOLD — `containerUnitCap`, narrowed: the
 *  food chest is sized by the good's `boxCap`, a member's box is uncapped. */
const CHEST_CAP = 6;
function boxRoom(b: Bench, id: string): number {
  if (id !== CHEST) return Infinity; // uncapped — always somewhere to put it
  return CHEST_CAP - totalStackUnits(b.stock.get(id) ?? {});
}

/** quest-host `bagUnitsHaveAnOutlet`, mirrored — the question that replaced
 *  "is the bag empty" (pass 3). A held bag is IN USE only while something in it
 *  has somewhere ACTIONABLE to be: ① a FIRING row on this body that will use it
 *  up, or ② a destination with room. If neither, holding it buys nothing, so it
 *  is idle and goes down WHOLE — contents and all. */
function bagUnitsHaveAnOutlet(
  b: Bench,
  bag: Readonly<Record<string, number>>,
  opts?: { firingFor?: ReadonlySet<string> },
): boolean {
  for (const [glyph, n] of Object.entries(bag)) {
    if (n <= 0) continue;
    if (opts?.firingFor?.has(glyph)) return true; // ① a row that consumes it
    const box = designatedContainerId(glyph, HOUSE, {
      provisionedHeads: PROVISIONED,
      selfId: CID,
      exists: (id) => b.stock.has(id),
    });
    if (b.stock.has(box) && boxRoom(b, box) > 0) return true; // ② room for it
  }
  return false;
}

/** quest-host `heldIdleObject` — the whole of "only if they aren't doing
 *  anything with the item they are using". */
function heldIdleObject(
  b: Bench,
  cid: string,
  opts?: { inUse?: ReadonlySet<string>; firingFor?: ReadonlySet<string> },
): { objId: string; glyph: string; bag: boolean } | null {
  const carry = carryOf(b, cid);
  const held = carry.inHand;
  if (!held) return null;
  const rec = b.props.get(held.objId);
  if (b.clock - (rec?.at ?? 0) < TIDY_GRACE_S) return null;
  if (opts?.inUse?.has(held.glyph)) return null;
  if (PROVISIONED.has(held.glyph)) return null;
  if (held.bag && bagUnitsHaveAnOutlet(b, held.bag.stock, opts)) return null;
  return { objId: held.objId, glyph: held.glyph, bag: !!held.bag };
}

/** THE `stock:` WITHDRAW as quest-host now writes it: `stackRoom` decides
 *  whether there is room (a bag counts!), the body is asked BEFORE the box is
 *  debited, and the unit lands wherever the body's own carry puts it.
 *  Returns the units drawn (0 = refused, and the shelf keeps them). */
function stockPick(b: Bench, cid: string, boxId: string, glyph: string): number {
  const carry = carryOf(b, cid);
  if (stackRoom(carry) <= 0) return 0;
  const stock = b.stock.get(boxId) ?? {};
  if ((stock[glyph] ?? 0) <= 0) return 0;
  const got = giveUnitsToBody(b, cid, glyph, 1);
  if (got < 1) return 0;
  stock[glyph]! -= 1;
  if (stock[glyph]! <= 0) delete stock[glyph];
  b.stock.set(boxId, stock);
  return got;
}

/** THE OLD WITHDRAW, kept as an executable footnote: it asked whether the
 *  hands held anything at all. */
function stockPickLegacy(b: Bench, cid: string, boxId: string, glyph: string): number {
  if (b.hands.has(cid)) return 0; // ← `npcCarrying(npcId)`
  return stockPick(b, cid, boxId, glyph);
}

/** THE LOOSE-PROP LIFT as quest-host now writes it: with the hands occupied but
 *  a bag on the body, a SMALL thing merges into the bag (the needs walker's own
 *  `small:` take, which the pursuit path used to disagree with). A container or
 *  anything furniture-sized still rides the hands only. */
function loosePick(b: Bench, cid: string, objId: string): number {
  const rec = b.props.get(objId);
  if (!rec) return 0;
  const carry = carryOf(b, cid);
  const handsOnly = isLargeGlyph(rec.glyph) || !!containerDefOfGlyph(rec.glyph)?.hold;
  if (b.hands.has(cid)) {
    if (handsOnly || !activeBag(carry)) return 0;
    if (giveUnitsToBody(b, cid, rec.glyph, 1) < 1) return 0;
    b.props.delete(objId); // take-first, remove-second
    return 1;
  }
  return takeIntoHands(b, cid, objId) ? 1 : 0;
}

/** …and the guard it replaces. */
function loosePickLegacy(b: Bench, cid: string, objId: string): number {
  if (b.hands.has(cid)) return 0; // ← `npcCarrying(npcId)`
  return loosePick(b, cid, objId);
}

/** quest-host's consume effect: the hand first, then a unit WAITING at the
 *  station. Returns what was eaten, or null — and null now means the meter
 *  does NOT clear (no unit, no meal). */
function consumeEffect(b: Bench, cid: string, glyph: string, stationId?: string): string | null {
  if (takeUnitsFromBody(b, cid, glyph, 1) > 0) return glyph;
  if (stationId) {
    const stock = b.stock.get(stationId) ?? {};
    if ((stock[glyph] ?? 0) > 0) {
      stock[glyph]! -= 1;
      if (stock[glyph]! <= 0) delete stock[glyph];
      b.stock.set(stationId, stock);
      return glyph;
    }
  }
  return null;
}

/** quest-host's drop effect, bag arm included: a portable container in the
 *  hands is in no carry view, so it leaves through the one door explicitly —
 *  and it leaves WHOLE. The step's unit budget (`dropHere` names the ONE object
 *  in the hands, so it is 1) is spent by the bag itself, which is why the stack
 *  loop below never runs and nothing is tipped out of it on the way down: the
 *  water-in-the-barrel law. */
function dropEffect(b: Bench, cid: string, tplKey: string, units = 1): number {
  let dropped = 0;
  const onMe = bodyCarryView(carryOf(b, cid)); // read BEFORE the bag arm, as the host reads it
  if (carryOf(b, cid).inHand?.bag && tplKey === "relieve") {
    if (setDownFromHands(b, cid)) dropped++;
  }
  for (const glyph of Object.keys(onMe)) {
    while (dropped < units) {
      if (takeUnitsFromBody(b, cid, glyph, 1) < 1) break;
      dropped++;
    }
  }
  return dropped;
}

// ── The ctx a resident's put-down row is resolved from ────────────────────

const price = (over: Partial<NeedPrice> = {}): NeedPrice => ({
  walkMps: 1.6,
  fillS: NEED_FILL_S.hunger,
  unitValueS: 5 * NEED_PRESSURE_S,
  shortage: 1,
  handsS: { container: BOX_ACT_DWELL_S, source: 18, loose: BOX_ACT_DWELL_S, satisfy: BOX_ACT_DWELL_S },
  ...over,
});

/** quest-host `residentNeedCtx`, the two arms this pass added: the row's
 *  `carried` is the IDLE HELD OBJECT, and its storage role is the item's
 *  designated container UNLESS the item lives on the floor. */
function relieveCtx(
  b: Bench,
  cid: string,
  opts?: { inUse?: ReadonlySet<string>; firingFor?: ReadonlySet<string> },
): NeedCtx {
  const idle = heldIdleObject(b, cid, opts);
  const containers: NeedCtx["containers"] = {};
  if (idle && !livesOnTheFloor(idle.glyph)) {
    const tid = designatedContainerId(idle.glyph, HOUSE, {
      provisionedHeads: PROVISIONED,
      selfId: cid,
      exists: (id) => b.stock.has(id),
    });
    containers.storage = { id: tid, place: { kind: "named", id: tid }, units: 0, d: 2 };
  }
  return {
    carried: idle ? 1 : 0,
    containers,
    sources: [],
    stations: [],
    // `unitValueSOf` finds nothing that CONSUMES this row's (absent) category,
    // so the row's own weight is what a put-down is worth.
    price: price({ unitValueS: relieveTemplate().priority * NEED_PRESSURE_S, shortage: 1 }),
  };
}

// ═══ ① THE COMMANDED BASKET, END TO END ═══════════════════════════════════

describe("the commanded basket — picked up, shopped with, and PUT DOWN", () => {
  function houseWithBasket(): Bench {
    const b = bench();
    addProp(b, BASKET, "basket");
    b.stock.set(CHEST, { apple: 0 });
    b.stock.set(BOX, {});
    return b;
  }

  it("a commanded pickup makes the basket the body's ACTIVE BAG", () => {
    const b = houseWithBasket();
    expect(takeIntoHands(b, CID, BASKET)).toBe(true);
    const carry = carryOf(b, CID);
    expect(activeBag(carry)?.objId).toBe(BASKET);
    expect(stackRoom(carry)).toBe(PORTABLE_CONTAINERS.basket.capacity);
    // …and THE REASON NOTHING COULD SEE IT: the bag is not a row in any carry
    // view. Every other need row counts through this map, which is why the
    // put-down row had to be given its own subject.
    expect(bodyCarryView(carry)).toEqual({});
  });

  it("🚨 the withdraw a full hand used to refuse now draws INTO the bag", () => {
    const b = houseWithBasket();
    b.stock.set(CHEST, { apple: 4 });
    takeIntoHands(b, CID, BASKET);
    // The shipped guard: hands full ⇒ nothing moves, and the plan that issued
    // it re-issues forever (the five reaches into the barrel).
    expect(stockPickLegacy(b, CID, CHEST, "apple")).toBe(0);
    expect(b.stock.get(CHEST)).toEqual({ apple: 4 });
    // The fix: `stackRoom` answers, and the unit lands in the basket.
    expect(stockPick(b, CID, CHEST, "apple")).toBe(1);
    expect(b.stock.get(CHEST)).toEqual({ apple: 3 });
    expect(bodyCarryView(carryOf(b, CID))).toEqual({ apple: 1 });
  });

  it("🚨 the market's loose fruit goes INTO the basket, not into a refusal", () => {
    // The other face of the empty-basket report: a body whose hands hold its
    // own basket could not lift anything the pursuit planned for, so every
    // trip achieved nothing and parted with "can't finish".
    const b = houseWithBasket();
    addProp(b, "small:apple7", "apple");
    takeIntoHands(b, CID, BASKET);
    expect(loosePickLegacy(b, CID, "small:apple7")).toBe(0);
    expect(b.props.has("small:apple7")).toBe(true);
    expect(loosePick(b, CID, "small:apple7")).toBe(1);
    expect(bodyCarryView(carryOf(b, CID))).toEqual({ apple: 1 });
    expect(b.props.has("small:apple7")).toBe(false); // one place per unit
  });

  it("a SECOND container is still hands-only — a scope may not become a unit", () => {
    const b = houseWithBasket();
    addProp(b, "small:basket2", "basket");
    takeIntoHands(b, CID, BASKET);
    expect(loosePick(b, CID, "small:basket2")).toBe(0);
    expect(b.props.has("small:basket2")).toBe(true);
    expect(b.stock.get(BASKET)).toEqual({});
  });

  it("the shopping trip FILLS it — and the row stands down while it is loaded", () => {
    const b = houseWithBasket();
    takeIntoHands(b, CID, BASKET);
    expect(giveUnitsToBody(b, CID, "apple", 6)).toBe(6);
    expect(bodyCarryView(carryOf(b, CID))).toEqual({ apple: 6 });
    b.clock += TIDY_GRACE_S * 2;
    // A LOADED bag is a bag in use — the apples have an EMPTY chest to go into,
    // so the goods' own deposit rows will empty it and only then is there an
    // idle basket to put down. (Pass 3: what makes it "in use" is that outlet,
    // not the mere fact of not being empty — see the deadlock block below.)
    expect(boxRoom(b, CHEST)).toBeGreaterThan(0);
    expect(heldIdleObject(b, CID)).toBeNull();
    expect(decideNeed(relieveTemplate(), relieveCtx(b, CID))).toEqual({ kind: "idle" });
  });

  it("PUTS IT DOWN once it is idle — on the floor, never into a box", () => {
    const b = houseWithBasket();
    takeIntoHands(b, CID, BASKET);
    b.clock += TIDY_GRACE_S + 1;

    const tpl = relieveTemplate();
    const ctx = relieveCtx(b, CID);
    expect(ctx.carried).toBe(1);
    // NO STORAGE ROLE: a basket has no box (container-home.ts rung 0), so the
    // row's `orDrop` is its only answer — which is the point. An empty basket
    // filed into a chest is legal and useless.
    expect(ctx.containers.storage).toBeUndefined();
    const intent = decideNeed(tpl, ctx);
    expect(intent).toEqual({ kind: "dropHere", units: 1 });

    expect(dropEffect(b, CID, tpl.key)).toBe(1);
    expect(b.hands.has(CID)).toBe(false);
    // It is a loose prop again, under the SAME object id — so its stock map
    // (empty here, goods if it had any) is never orphaned.
    expect(b.props.has(BASKET)).toBe(true);
    expect(b.stock.has(BASKET)).toBe(true);
    // …and the row goes quiet.
    expect(relieveCtx(b, CID).carried).toBe(0);
  });

  it("NEVER A STATUE: without the row, nothing in the engine could release it", () => {
    // The executable footnote for report ①. Both unit doors refuse a held bag
    // — correctly, because a bag is not a unit — so a body whose only put-away
    // rows work in units holds the basket for the rest of the session.
    const b = houseWithBasket();
    takeIntoHands(b, CID, BASKET);
    expect(takeUnitsFromBody(b, CID, "basket", 1)).toBe(0);
    expect(bodyCarryView(carryOf(b, CID))).toEqual({});
    // `unload`'s own count (carriedClutter over that view) is therefore zero:
    // the highest-priority put-away row on the body never even fires.
    const unloadCtx: NeedCtx = { carried: 0, containers: {}, sources: [], stations: [] };
    expect(decideNeed(unloadTemplate(), unloadCtx)).toEqual({ kind: "idle" });
    // The put-down row is the only thing that sees it.
    b.clock += TIDY_GRACE_S + 1;
    expect(decideNeed(relieveTemplate(), relieveCtx(b, CID)).kind).toBe("dropHere");
  });

  it("🚨 no pick-up/put-down loop: the tidy chore leaves a floor basket alone", () => {
    // tidy (1.2) outranks the put-down row (0.8), so a chore that could sweep
    // a basket back off the floor would spin against it forever. `livesOnTheFloor`
    // is the one rule both sides consult.
    expect(livesOnTheFloor("basket")).toBe(true);
    expect(livesOnTheFloor("satchel")).toBe(true);
    expect(livesOnTheFloor("teddy")).toBe(false);
    expect(livesOnTheFloor("apple")).toBe(false);
    const b = houseWithBasket();
    const looseForTidy = [...b.props].filter(([, rec]) => !livesOnTheFloor(rec.glyph));
    expect(looseForTidy).toEqual([]);
    expect(decideNeed(tidyTemplate(), { carried: 0, containers: {}, sources: [], stations: [], loose: [] }))
      .toEqual({ kind: "idle" });
  });

  it("an ORDINARY held thing still goes to its designated container", () => {
    const b = houseWithBasket();
    addProp(b, "small:teddy", "teddy");
    takeIntoHands(b, CID, "small:teddy");
    b.clock += TIDY_GRACE_S + 1;
    const ctx = relieveCtx(b, CID);
    // The ladder answers for anything that isn't a container: the stower's own
    // box (rung 5).
    expect(ctx.containers.storage?.id).toBe(BOX);
    expect(decideNeed(relieveTemplate(), ctx)).toEqual({
      kind: "deposit",
      into: ctx.containers.storage,
      units: 1,
    });
  });
});

// ═══ ①b THE LEFTOVER UNIT — THE BAG DEADLOCK, CLOSED ══════════════════════
//
// The other end of report ①, found by the step-④ pass and diagnosed there
// (plan-costs-and-bags.test.ts §⑤, verbatim): "a BAG with a leftover unit is
// invisible to every row that could put it down: `heldIdleObject` refuses a
// non-empty bag; `carriedClutter` skips provisioned heads; the goods row blocks
// on a full box. `decideNeeds` returns blocked with nothing actionable and the
// body walks on carrying."
//
// The old rule read "is the bag empty" and answered a question nobody asked.
// The real one is whether HOLDING it buys anything — has some unit in it
// somewhere actionable to be. A full chest is exactly the case where nothing
// does, and it is exactly the case the report walked into.

describe("a basket with ONE leftover unit and a FULL chest", () => {
  const MATE = "resident_0_2";
  const provision = provisionTemplate("food", 5, CHEST_CAP);

  /** A porter holding the household basket with one apple still in it, and a
   *  chest holding `chestUnits` of its six. */
  function porter(chestUnits: number): Bench {
    const b = bench();
    addProp(b, BASKET, "basket");
    b.stock.set(CHEST, chestUnits > 0 ? { apple: chestUnits } : {});
    b.stock.set(BOX, {});
    takeIntoHands(b, CID, BASKET);
    giveUnitsToBody(b, CID, "apple", 1);
    b.clock += TIDY_GRACE_S + 1;
    return b;
  }

  /** Every unit the world holds, wherever it is — the conservation audit. */
  const totalApples = (b: Bench): number =>
    [...b.stock.values()].reduce((s, st) => s + (st.apple ?? 0), 0) +
    [...b.props.values()].filter((r) => r.glyph === "apple").length;

  it("🚨 the FULL chest makes the basket IDLE — the leftover no longer pins it", () => {
    const b = porter(CHEST_CAP);
    expect(bodyCarryView(carryOf(b, CID))).toEqual({ apple: 1 });
    expect(boxRoom(b, CHEST)).toBe(0); // the apple has nowhere to be
    expect(heldIdleObject(b, CID)?.glyph).toBe("basket");
    expect(decideNeed(relieveTemplate(), relieveCtx(b, CID))).toEqual({ kind: "dropHere", units: 1 });
  });

  it("…and it goes down WHOLE, with the apple still inside — audit conserves", () => {
    const b = porter(CHEST_CAP);
    const before = totalApples(b);
    expect(dropEffect(b, CID, relieveTemplate().key)).toBe(1);
    // The bag left the hands…
    expect(b.hands.has(CID)).toBe(false);
    expect(bodyCarryView(carryOf(b, CID))).toEqual({});
    // …under its own object id, with its stock riding along. Nothing was tipped
    // out to make it light enough to put down.
    expect(b.props.has(BASKET)).toBe(true);
    expect(b.stock.get(BASKET)).toEqual({ apple: 1 });
    expect(totalApples(b)).toBe(before);
    // …and the row goes quiet: the hands are empty, so there is nothing to relieve.
    expect(decideNeed(relieveTemplate(), relieveCtx(b, CID))).toEqual({ kind: "idle" });
  });

  it("ROOM IN THE CHEST and the bag is in use again — the goods row owns it", () => {
    const b = porter(CHEST_CAP - 2);
    expect(boxRoom(b, CHEST)).toBe(2);
    expect(heldIdleObject(b, CID)).toBeNull();
    expect(decideNeed(relieveTemplate(), relieveCtx(b, CID))).toEqual({ kind: "idle" });
  });

  it("A ROW THAT WILL USE IT UP holds the bag too — the apple is lunch", () => {
    // Outlet ①: the chest is full, but something on this body is about to eat
    // what is in the basket. FIRING rows only — a hunger that has not fired yet
    // is no reason to keep hold of a bag, and a bag on the floor can always be
    // picked back up.
    const b = porter(CHEST_CAP);
    const hungry = { firingFor: new Set(["apple"]) };
    expect(heldIdleObject(b, CID, hungry)).toBeNull();
    expect(decideNeed(relieveTemplate(), relieveCtx(b, CID, hungry))).toEqual({ kind: "idle" });
  });

  it("🚨 THE WAY BACK: the floor basket is a real container scope again", () => {
    // The set-down is not a dead end and nothing goes back for it on a timer.
    // Once the chest has room, a housemate that picks the basket up sees the
    // apple in its own carry view — a bag's contents ARE the body's stack — and
    // its provision row banks it. That is the household draining the basket, by
    // the ordinary door.
    const b = porter(CHEST_CAP);
    dropEffect(b, CID, relieveTemplate().key);
    b.stock.set(CHEST, { apple: CHEST_CAP - 2 }); // two eaten while it sat there
    expect(takeIntoHands(b, MATE, BASKET)).toBe(true);
    expect(bodyCarryView(carryOf(b, MATE))).toEqual({ apple: 1 });
    const home = {
      id: CHEST,
      place: { kind: "named" as const, id: CHEST },
      units: CHEST_CAP - 2,
      room: 2,
      d: 2,
    };
    const ctx: NeedCtx = {
      carried: 1,
      containers: { home },
      sources: [],
      stations: [],
      room: PORTABLE_CONTAINERS.basket.capacity - 1,
      price: price({ shortage: 2 / CHEST_CAP }),
    };
    expect(decideNeed(provision, ctx)).toEqual({ kind: "deposit", into: home, units: 1 });
  });
});

// ═══ ② THE BARREL — N DRINKS, N UNITS ═════════════════════════════════════

describe("the barrel is debited once per drink", () => {
  function houseWithBarrel(withBasket: boolean): Bench {
    const b = bench();
    b.stock.set(BARREL, { water: BARREL_CAP });
    b.stock.set(TABLE, {});
    if (withBasket) {
      addProp(b, BASKET, "basket");
      takeIntoHands(b, CID, BASKET);
    }
    return b;
  }

  /** One drink as the engine now runs it: withdraw at the barrel, then consume
   *  what is on the body at the table. */
  const drink = (b: Bench): string | null => {
    stockPick(b, CID, BARREL, "water");
    return consumeEffect(b, CID, "water", TABLE);
  };

  it.each([
    ["bare-handed", false],
    ["holding its own basket", true],
  ])("a body %s drinks N times and the barrel loses exactly N", (_name, withBasket) => {
    const b = houseWithBarrel(withBasket as boolean);
    for (let i = 0; i < 4; i++) expect(drink(b)).toBe("water");
    expect(b.stock.get(BARREL)).toEqual({ water: BARREL_CAP - 4 });
    // …and nothing is left riding the body: a unit is in ONE place.
    expect(bodyCarryView(carryOf(b, CID))).toEqual({});
  });

  it("🚨 THE REPORTED BUG, run: the old guard drew nothing while it reached", () => {
    const b = houseWithBarrel(true);
    // COMMAND_ACT_CAP reaches into the barrel, one per re-plan…
    for (let i = 0; i < 5; i++) expect(stockPickLegacy(b, CID, BARREL, "water")).toBe(0);
    // …and the water never moved. "Multiple drinks… the water didn't get
    // depleted normally", exactly.
    expect(b.stock.get(BARREL)).toEqual({ water: BARREL_CAP });
  });

  it("the provision:water row fires as the barrel drops past its floor", () => {
    const b = houseWithBarrel(false);
    const refill: NeedTemplate = {
      key: "provision:water",
      item: { category: "water" },
      drive: { kind: "stock", container: "home", below: BARREL_REFILL_BELOW },
      satisfy: { kind: "deposit", container: "home", upTo: BARREL_CAP },
      acquire: [{ kind: "source" }],
      priority: 3,
      exclusive: true,
    };
    const ctxAt = (units: number): NeedCtx => ({
      carried: 0,
      containers: {
        home: {
          id: BARREL,
          place: { kind: "named", id: BARREL },
          units,
          room: BARREL_CAP - units,
          d: 3,
        },
      },
      sources: [{ id: "well", place: { kind: "named", id: "well" }, units: 99, d: 20 }],
      stations: [],
      room: 1,
      claimed: "self",
    });
    // Four drinks in: still stocked, nobody is sent to the well.
    for (let i = 0; i < 4; i++) drink(b);
    expect(b.stock.get(BARREL)!.water).toBe(2);
    expect(decideNeed(refill, ctxAt(2))).toEqual({ kind: "idle" });
    // The fifth takes it under the floor, and the refill errand fires.
    drink(b);
    expect(b.stock.get(BARREL)!.water).toBe(1);
    expect(decideNeed(refill, ctxAt(1)).kind).toBe("take");
  });

  it("🚨 NO UNIT, NO MEAL: a consume that finds nothing does not satisfy", () => {
    // The other half of "the water didn't get depleted": the ingest effect
    // used to fire whether or not anything was actually consumed, so an
    // arrival with an empty hand and an empty station cleared the meter for
    // free. `consumeEffect` returning null is what now gates it.
    const b = houseWithBarrel(false);
    b.stock.set(BARREL, {});
    b.stock.set(TABLE, {});
    expect(consumeEffect(b, CID, "water", TABLE)).toBeNull();
    // A unit that IS there still reads as a real meal.
    b.stock.set(TABLE, { water: 1 });
    expect(consumeEffect(b, CID, "water", TABLE)).toBe("water");
    expect(b.stock.get(TABLE)).toEqual({});
  });
});

// ═══ ③ THE PUT-DOWN ROW IS THE WEAKEST ROW THERE IS ═══════════════════════

describe("relieve prices at the bottom of the ladder", () => {
  const relieve = relieveTemplate();
  const dropHere = { kind: "dropHere" as const, units: 1 };

  it("sits BELOW fun — the floor of the real motives", () => {
    expect(relieve.priority).toBeLessThan(funTemplate(0.01).priority);
  });

  it("the exchange rate: one put-down is worth priority × NEED_PRESSURE_S", () => {
    const ctx = { carried: 1, containers: {}, sources: [], stations: [], price: price({
      unitValueS: relieve.priority * NEED_PRESSURE_S,
      shortage: 1,
    }) } satisfies NeedCtx;
    // 0.8 × 40 = 32 hand-seconds. That is the whole ladder position in one
    // number: it buys about half a minute of walking, and fun's own 40 beats
    // it before any rung above fun is even consulted.
    expect(rowValueS(relieve, ctx, dropHere)).toBeCloseTo(32, 6);
    expect(rowValueS(relieve, ctx, dropHere)).toBeLessThan(
      rowValueS(funTemplate(0.01), { ...ctx, meter: 1, price: price({ fillS: NEED_FILL_S.fun }) }, { kind: "restHere" }),
    );
  });

  it("LOSES to every real need that is firing", () => {
    // A body holding an idle basket that is ALSO hungry, thirsty and bored:
    // the put-down waits its turn behind all three, every time.
    const hunger = hungerTemplate("food", 0.004);
    const thirst = thirstTemplate(0.003);
    const fun = funTemplate(0.004);
    const rows: NeedTemplate[] = [hunger, thirst, fun, relieve];
    const ctxOf = (tpl: NeedTemplate): NeedCtx => {
      if (tpl.key === relieve.key) {
        return { carried: 1, containers: {}, sources: [], stations: [], price: price({
          unitValueS: relieve.priority * NEED_PRESSURE_S,
          shortage: 1,
        }) };
      }
      if (tpl.key === fun.key) {
        return {
          meter: 1,
          carried: 1,
          containers: {},
          sources: [],
          stations: [],
          price: price({ fillS: NEED_FILL_S.fun }),
        };
      }
      const cat = tpl.item.category!;
      const home = {
        id: `furn_0_${cat}`,
        place: { kind: "named" as const, id: `furn_0_${cat}` },
        units: 3,
        room: 3,
        d: 2,
      };
      return {
        meter: 1,
        carried: 0,
        containers: { home },
        sources: [],
        stations: [{ id: TABLE, place: { kind: "named", id: TABLE }, kind: "table", waiting: 0, d: 2 }],
        room: 1,
        price: price({ fillS: cat === "water" ? NEED_FILL_S.thirst : NEED_FILL_S.hunger }),
      };
    };
    expect(decideNeeds(rows, ctxOf)?.tpl.key).toBe(hunger.key);
    // Fed and watered, the toy still comes first.
    expect(decideNeeds([fun, relieve], ctxOf)?.tpl.key).toBe(fun.key);
    // Only when nothing else fires does the body tidy its own hands.
    expect(decideNeeds([relieve], ctxOf)?.tpl.key).toBe(relieve.key);
  });

  it("stands down while a live `use` row wants the held item", () => {
    const b = bench();
    addProp(b, "small:teddy", "teddy");
    takeIntoHands(b, CID, "small:teddy");
    b.clock += TIDY_GRACE_S + 1;
    // Mid-play: the fun row's meter is over its threshold and the toy matches
    // its item, so `inUseByLiveNeed` claims it and the count is zero.
    expect(heldIdleObject(b, CID, { inUse: new Set(["teddy"]) })).toBeNull();
    expect(decideNeed(relieve, relieveCtx(b, CID, { inUse: new Set(["teddy"]) }))).toEqual({ kind: "idle" });
    // Play over — the same object, and now it is clutter in a hand.
    expect(decideNeed(relieve, relieveCtx(b, CID)).kind).toBe("deposit");
  });

  it("stands down while the held thing is a PROVISIONED good", () => {
    // A meal being carried home belongs to the food rows, which walk it to the
    // pantry — the put-down must not intercept it.
    const b = bench();
    addProp(b, "small:apple", "apple");
    takeIntoHands(b, CID, "small:apple");
    b.clock += TIDY_GRACE_S + 1;
    expect(heldIdleObject(b, CID)).toBeNull();
  });

  it("respects the command's grace before undoing it", () => {
    // A commanded hold yields EVENTUALLY, never instantly: `takeIntoHands`
    // re-stamps the prop's grace clock, so the order visibly lands and the row
    // takes over only once the body is genuinely idling with it.
    const b = bench();
    addProp(b, BASKET, "basket");
    takeIntoHands(b, CID, BASKET);
    expect(heldIdleObject(b, CID)).toBeNull();
    b.clock += TIDY_GRACE_S - 1;
    expect(heldIdleObject(b, CID)).toBeNull();
    b.clock += 2;
    expect(heldIdleObject(b, CID)?.glyph).toBe("basket");
  });

  it("has NO acquire branch — it can never spin against the row that lifted", () => {
    // The livelock invariant, structural: a deposit-shaped row that sits BELOW
    // its acquirers is only safe because its hands are tied.
    expect(relieve.acquire).toEqual([]);
  });
});
