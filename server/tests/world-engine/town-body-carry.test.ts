// A BODY IS THE SAME SHAPE AS A STRUCTURE — step ③ of scope-unification.md,
// the pass that DELETED the abstract inventory (`session.needCarried`, the
// `session.pocket` getter, `INVENTORY_SLOTS`).
//
// User law (2026-08-02): "Creatures no longer have abstract inventory. Instead,
// creatures can carry or be equipped with containers (baskets being the
// prototype for a carried container, satchels for an equipped one) and those
// containers can contain items, which the creature can access."
//
// WHAT IS PINNED HERE, and why each one is a bug waiting:
//
//  1. 🚨 NO DOUBLE COUNT. A body is now a STACKLESS PARENT NODE (the `building`
//     precedent): `stockEndpointOf("pocket:<cid>")` returns null, and the goods
//     live on the containers hanging off it. If the body ALSO aliased its
//     active bag — the obvious "keep the old endpoint working" shortcut — every
//     unit on every body would be counted twice by `auditScopeTree`, and the
//     conservation probe that guards `condense`/`expand` would be lying.
//  2. REFUSAL CONSERVES (decision 7). A give that finds no room takes NOTHING
//     and says so; the caller decrements its source by the RETURN VALUE, never
//     by what it asked for.
//  3. NO BAG → SINGLE-UNIT TRIPS (decision 3). The whole point of the law: a
//     body that came to market without a basket carries one thing home, and
//     that is the decision step ④ will price.
//  4. DEMOTE'S FOLD IS ORDERED (decision 8 + containers.ts `mayDissolveToStack`):
//     a bag's contents bank FIRST, and only the emptied bag condenses into a
//     unit of its own glyph. A basket condensed with apples in it takes its
//     stock map's key out of the world and orphans them — the water-in-the-
//     barrel bug at the population tier.
//
// The two doors (`giveUnitsToBody` / `takeUnitsFromBody`) are host closures
// bound to a live world, so they are MIRRORED here exactly as quest-host writes
// them — the same convention `town-errand-walk.test.ts` uses for the errand
// router. The rules they are made of (`stackRoom`, `activeBag`, `bodyCarryView`,
// `mayDissolveToStack`) are the real kernel ones, so a change to the law breaks
// this file rather than sliding past it.
//
// No DOM / GL / session.
import { describe, it, expect } from "@jest/globals";
import {
  activeBag,
  bodyCarryView,
  handsFree,
  stackRoom,
  type BagRef,
  type BodyCarry,
} from "@shared/world-engine/kernel/town/scope-shape.js";
import {
  containerDefOfGlyph,
  mayDissolveToStack,
  PORTABLE_CONTAINERS,
} from "@shared/world-engine/kernel/town/containers.js";
import {
  auditScopeTree,
  walkScopeTree,
  type ScopeId,
} from "@shared/world-engine/kernel/town/scope.js";
import { TOWN_SCOPE } from "@shared/world-engine/interaction/behavior/ownership.js";
import type { StockEndpoint } from "@shared/world-engine/kernel/town/transfer.js";

// ── The body model, mirroring quest-host's `bodyCarryOf` ──────────────────
//
// `stock` is the SAME map the container registry holds — the alias law. A copy
// here would make every assertion below meaningless in exactly the way the real
// bug is meaningless: units written to the body vanish from the container.

const CID = "resident_0_1";

interface Bench {
  /** `session.containerStock` — the only place stacks live. */
  stock: Map<string, Record<string, number>>;
  /** `session.containers` — registration, which is what makes a stack reachable. */
  registered: Set<string>;
  /** `session.wornBags` — cid → the equipped container. */
  worn: Map<string, { objId: string; glyph: string }>;
  /** The ONE object in the hands (world `ObjectState.carriedBy`), per body. */
  hands: Map<string, { objId: string; glyph: string }>;
}

function bench(): Bench {
  return { stock: new Map(), registered: new Set(), worn: new Map(), hands: new Map() };
}

/** quest-host `stackTake` — one off a stack map, key deleted at zero. */
function drain(stack: Record<string, number>, glyph: string, n: number): void {
  for (let k = 0; k < n; k++) {
    if (!stack[glyph]) return;
    stack[glyph] -= 1;
    if (stack[glyph]! <= 0) delete stack[glyph];
  }
}

/** Register a container object and give it a live stack — `spawnLooseProp` +
 *  `bagRefOf`'s ensure-the-alias-is-real step, in one. */
function makeContainer(b: Bench, objId: string, glyph: string, contents: Record<string, number> = {}): void {
  b.registered.add(objId);
  b.stock.set(objId, contents);
}

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
  const h = b.hands.get(cid);
  if (h) {
    const bag = bagRefOf(b, h.objId, h.glyph);
    carry.inHand = { objId: h.objId, glyph: h.glyph, ...(bag ? { bag } : {}) };
  }
  return carry;
}

/** quest-host `giveUnitsToBody` — returns the units ACTUALLY taken. */
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
  b.hands.set(cid, { objId: `small:minted_${glyph}`, glyph });
  return 1;
}

/** quest-host `takeUnitsFromBody` — hands first, then the active bag, then the
 *  other one. Returns the units removed. */
function takeUnitsFromBody(b: Bench, cid: string, glyph: string, n: number): number {
  if (n <= 0) return 0;
  let left = n;
  const carry = carryOf(b, cid);
  if (carry.inHand && !carry.inHand.bag && carry.inHand.glyph === glyph) {
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

// ── The scope tree, mirroring quest-host's `scopeTreeOf` ──────────────────

function treeOf(b: Bench, opts?: { pocketAliasesBag?: boolean }) {
  const ids = (): ScopeId[] => {
    const out = new Set<ScopeId>([TOWN_SCOPE, "h_0"]);
    for (const id of b.registered) out.add(id);
    for (const id of b.stock.keys()) out.add(id);
    for (const cid of b.worn.keys()) out.add(`pocket:${cid}`);
    for (const [cid, h] of b.hands) if (b.registered.has(h.objId)) out.add(`pocket:${cid}`);
    return [...out];
  };
  return {
    ids,
    endpointOf: (id: string): StockEndpoint | null => {
      if (id.startsWith("pocket:")) {
        // 🚨 THE LAW: a body holds no stack of its own. The `pocketAliasesBag`
        // escape hatch exists ONLY so the double-count test can show what the
        // shortcut would have cost.
        if (!opts?.pocketAliasesBag) return null;
        const bag = activeBag(carryOf(b, id.slice(7)));
        return bag ? { id, kind: "pocket", stack: bag.stock, owner: null } : null;
      }
      const stack = b.stock.get(id);
      return stack ? { id, kind: "container", stack, owner: null } : null;
    },
    houseOfCreature: () => 0,
    buildingOfContainer: (objectId: string) => {
      for (const [cid, w] of b.worn) if (w.objId === objectId) return `pocket:${cid}`;
      for (const [cid, h] of b.hands) if (h.objId === objectId) return `pocket:${cid}`;
      return "h_0";
    },
    townId: () => TOWN_SCOPE,
  };
}

// ── ① The double-count trap ───────────────────────────────────────────────

describe("🚨 a body is a STACKLESS parent node — the double-count trap", () => {
  /** The brief's case: a satchel with two bread on the back, a basket with
   *  three apples in the hands. */
  function loadedBody(): Bench {
    const b = bench();
    makeContainer(b, "small:satchel1", "satchel", { bread: 2 });
    makeContainer(b, "small:basket1", "basket", { apple: 3 });
    b.worn.set(CID, { objId: "small:satchel1", glyph: "satchel" });
    b.hands.set(CID, { objId: "small:basket1", glyph: "basket" });
    return b;
  }

  it("audits to EXACTLY what the body has — no doubles, no leaks", () => {
    expect(auditScopeTree(treeOf(loadedBody()))).toEqual({ bread: 2, apple: 3 });
  });

  it("counts the goods once even with a chest in the same house", () => {
    const b = loadedBody();
    makeContainer(b, "furn_0_chest_food", "furn.chest", { apple: 5 });
    expect(auditScopeTree(treeOf(b))).toEqual({ bread: 2, apple: 8 });
  });

  it("SHOWS THE BUG the null endpoint prevents: aliasing the bag doubles it", () => {
    // Kept as an executable footnote. If somebody "restores" the pocket
    // endpoint for compatibility, this is the number the audit would report,
    // and every conservation probe over a body would be wrong by the size of
    // its basket.
    expect(auditScopeTree(treeOf(loadedBody(), { pocketAliasesBag: true }))).toEqual({
      bread: 2,
      apple: 6, // ← the basket, counted on the bag AND on the body
    });
  });

  it("hangs both bags off the BODY, and the body off its household", () => {
    const nodes = walkScopeTree(treeOf(loadedBody()));
    const by = new Map(nodes.map((n) => [n.id, n]));
    expect(by.get("small:basket1")!.parent).toBe(`pocket:${CID}`);
    expect(by.get("small:satchel1")!.parent).toBe(`pocket:${CID}`);
    expect(by.get(`pocket:${CID}`)!.parent).toBe("h_0");
    // …and the body itself reports NO stack: it is structure, not storage.
    expect(by.get(`pocket:${CID}`)!.endpoint).toBeNull();
  });

  it("a body with nothing on it contributes nothing at all", () => {
    const b = bench();
    makeContainer(b, "furn_0_chest_food", "furn.chest", { apple: 1 });
    expect(auditScopeTree(treeOf(b))).toEqual({ apple: 1 });
  });
});

// ── ② Refusal conserves ───────────────────────────────────────────────────

describe("refusal conserves — the give takes nothing it cannot hold", () => {
  it("a FULL bag and FULL hands take zero, and the source keeps every unit", () => {
    const b = bench();
    const CAP = PORTABLE_CONTAINERS.basket.capacity;
    makeContainer(b, "small:basket1", "basket", { apple: CAP });
    b.hands.set(CID, { objId: "small:basket1", glyph: "basket" });
    const shelf: Record<string, number> = { pear: 4 };

    // THE CALLER'S CONTRACT: decrement the source by the RETURN VALUE.
    const took = giveUnitsToBody(b, CID, "pear", 4);
    drain(shelf, "pear", took);

    expect(took).toBe(0);
    expect(shelf).toEqual({ pear: 4 }); // nothing moved, nothing vanished
    expect(bodyCarryView(carryOf(b, CID))).toEqual({ apple: CAP });
  });

  it("a PARTLY full bag takes exactly its room and leaves the rest behind", () => {
    const b = bench();
    const CAP = PORTABLE_CONTAINERS.satchel.capacity;
    makeContainer(b, "small:satchel1", "satchel", { bread: CAP - 2 });
    b.worn.set(CID, { objId: "small:satchel1", glyph: "satchel" });
    const shelf: Record<string, number> = { pear: 5 };

    const took = giveUnitsToBody(b, CID, "pear", 5);
    drain(shelf, "pear", took);

    expect(took).toBe(2);
    expect(shelf).toEqual({ pear: 3 });
    expect(bodyCarryView(carryOf(b, CID))).toEqual({ bread: CAP - 2, pear: 2 });
  });

  it("a body holding a NON-container has no room at all — hands are one thing", () => {
    const b = bench();
    b.hands.set(CID, { objId: "small:ball", glyph: "ball" });
    expect(stackRoom(carryOf(b, CID))).toBe(0);
    expect(giveUnitsToBody(b, CID, "apple", 1)).toBe(0);
  });
});

// ── ③ No bag → single-unit trips ──────────────────────────────────────────

describe("no bag → single-unit trips (the decision the law makes visible)", () => {
  it("an empty-handed body with no container takes ONE unit, as a real thing", () => {
    const b = bench();
    const shelf: Record<string, number> = { apple: 6 };

    const took = giveUnitsToBody(b, CID, "apple", 6);
    drain(shelf, "apple", took);

    expect(took).toBe(1); // ← not six: there is nowhere to put six
    expect(shelf).toEqual({ apple: 5 });
    expect(bodyCarryView(carryOf(b, CID))).toEqual({ apple: 1 });
    // The unit is a REAL object in the hands, not a tally — so the hands are
    // full and the next trip has to wait.
    expect(handsFree(carryOf(b, CID))).toBe(false);
    expect(giveUnitsToBody(b, CID, "apple", 1)).toBe(0);
  });

  it("the same body WITH a basket takes the whole armful", () => {
    const b = bench();
    makeContainer(b, "small:basket1", "basket", {});
    b.hands.set(CID, { objId: "small:basket1", glyph: "basket" });
    const shelf: Record<string, number> = { apple: 6 };

    const took = giveUnitsToBody(b, CID, "apple", 6);
    drain(shelf, "apple", took);

    expect(took).toBe(6);
    expect(shelf).toEqual({});
    expect(auditScopeTree(treeOf(b))).toEqual({ apple: 6 });
  });

  it("the hands unit comes back OUT before any bag is touched", () => {
    // The eat/deposit order: what the body is visibly holding is spent first.
    const b = bench();
    makeContainer(b, "small:satchel1", "satchel", { apple: 2 });
    b.worn.set(CID, { objId: "small:satchel1", glyph: "satchel" });
    b.hands.set(CID, { objId: "small:apple9", glyph: "apple" });
    expect(bodyCarryView(carryOf(b, CID))).toEqual({ apple: 3 });

    expect(takeUnitsFromBody(b, CID, "apple", 1)).toBe(1);
    expect(b.hands.has(CID)).toBe(false); // the held one went
    expect(b.stock.get("small:satchel1")).toEqual({ apple: 2 }); // the bag untouched
  });

  it("takes what it can and reports it — never more than the body has", () => {
    const b = bench();
    makeContainer(b, "small:satchel1", "satchel", { apple: 2 });
    b.worn.set(CID, { objId: "small:satchel1", glyph: "satchel" });
    expect(takeUnitsFromBody(b, CID, "apple", 5)).toBe(2);
    expect(auditScopeTree(treeOf(b))).toEqual({});
  });
});

// ── ④ Demote: the ordered fold ────────────────────────────────────────────

/**
 * quest-host `demoteHouse`, the per-member half: bank the containers' contents
 * into the pool, then the hands instance, then condense the EMPTIED bags.
 * Returns what the district pool receives.
 */
function demoteFold(b: Bench, cid: string): Record<string, number> {
  const pool: Record<string, number> = {};
  const bank = (g: string, n: number) => {
    if (n > 0) pool[g] = (pool[g] ?? 0) + n;
  };
  const carry = carryOf(b, cid);
  // ① the goods
  for (const bag of [carry.inHand?.bag ?? null, carry.worn]) {
    if (!bag) continue;
    for (const [g, n] of Object.entries(bag.stock)) bank(g, n);
    for (const g of Object.keys(bag.stock)) delete bag.stock[g];
  }
  // ② the hands instance (a bag included — empty now, so it stacks)
  if (carry.inHand) {
    bank(carry.inHand.glyph, 1);
    b.hands.delete(cid);
  }
  // ③ the bags, now that they hold nothing
  for (const bag of [carry.inHand?.bag ?? null, carry.worn]) {
    if (!bag) continue;
    if (!mayDissolveToStack(bag.glyph, b.stock.get(bag.objId))) continue; // stays a whole object
    if (bag !== carry.inHand?.bag) bank(bag.glyph, 1);
    b.stock.delete(bag.objId);
    b.registered.delete(bag.objId);
    if (b.worn.get(cid)?.objId === bag.objId) b.worn.delete(cid);
  }
  return pool;
}

describe("demote folds a body into a number — contents first, bag second", () => {
  it("banks the goods, THEN condenses both emptied bags", () => {
    const b = bench();
    makeContainer(b, "small:satchel1", "satchel", { bread: 2 });
    makeContainer(b, "small:basket1", "basket", { apple: 3 });
    b.worn.set(CID, { objId: "small:satchel1", glyph: "satchel" });
    b.hands.set(CID, { objId: "small:basket1", glyph: "basket" });

    const pool = demoteFold(b, CID);

    // Everything it had, plus the two containers as ordinary flat-packed units.
    expect(pool).toEqual({ bread: 2, apple: 3, basket: 1, satchel: 1 });
    // Nothing is left registered on the body — no orphan stock map keyed by an
    // object id that has stopped existing.
    expect(b.stock.has("small:basket1")).toBe(false);
    expect(b.stock.has("small:satchel1")).toBe(false);
    expect(b.worn.has(CID)).toBe(false);
    expect(b.hands.has(CID)).toBe(false);
  });

  it("🚨 ONLY AN EMPTIED bag may dissolve — the gate itself", () => {
    // The conservation law's teeth (containers.ts). A bag with anything in it
    // is a SCOPE, and a scope cannot become a number: condensing it would take
    // its stock map's key out of the world and orphan the contents.
    expect(mayDissolveToStack("satchel", { bread: 2 })).toBe(false);
    expect(mayDissolveToStack("satchel", {})).toBe(true);
    expect(mayDissolveToStack("basket", { apple: 0 })).toBe(true); // a spent tally is empty
  });

  it("🚨 THE ORDER IS LOAD-BEARING: condensing before banking cannot proceed", () => {
    // The wrong order, run for real. A fold that tried to condense the bag
    // first finds the gate shut, so the bag survives as a whole object and the
    // bread stays inside it — nothing is lost, but the household is left with a
    // container it can no longer reach, which is why the shipped fold banks ①
    // and condenses ③.
    const b = bench();
    makeContainer(b, "small:satchel1", "satchel", { bread: 2 });
    b.worn.set(CID, { objId: "small:satchel1", glyph: "satchel" });

    const pool: Record<string, number> = {};
    const carry = carryOf(b, CID);
    if (mayDissolveToStack(carry.worn!.glyph, b.stock.get(carry.worn!.objId))) {
      pool[carry.worn!.glyph] = 1;
      b.stock.delete(carry.worn!.objId);
    }
    expect(pool).toEqual({}); // the gate refused — as it must
    expect(b.stock.get("small:satchel1")).toEqual({ bread: 2 });

    // The SHIPPED order, on the same body, gets both.
    expect(demoteFold(b, CID)).toEqual({ bread: 2, satchel: 1 });
    expect(b.stock.has("small:satchel1")).toBe(false);
  });

  it("a body carrying a plain thing folds it as one unit of its glyph", () => {
    const b = bench();
    b.hands.set(CID, { objId: "small:teddy", glyph: "teddy" });
    expect(demoteFold(b, CID)).toEqual({ teddy: 1 });
  });

  it("an empty body folds to nothing", () => {
    expect(demoteFold(bench(), CID)).toEqual({});
  });
});
