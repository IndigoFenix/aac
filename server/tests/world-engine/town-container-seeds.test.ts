// THE BAGS EXIST NOW — step ③ of scope-unification.md, the SEEDING half
// (kernel/town/container-seeds.ts).
//
// Step ③ deleted the abstract inventory: a body's carry IS the containers it
// holds. It shipped without ever creating one, so every body in every game —
// the player included — was a ONE-ITEM body. The law had no furniture.
//
// WHAT IS PINNED HERE, and why each one is a bug waiting:
//
//  1. THE PLAYER STARTS EQUIPPED, exactly once. A seed that runs again on a
//     resumed session (or a handoff that restores a carry) must not put a
//     SECOND satchel on the same back — that is one bag minted into two, which
//     is the item-conservation law broken at the very first frame.
//  2. ONE BASKET PER HOUSE, owned by the HOUSE. Per-resident baskets would be a
//     five-basket household and would quietly answer step ④'s question ("does a
//     body bring a basket, or does the household have one?"). Unowned would let
//     the neighbours' walkers empty it.
//  3. SEEDED CONTAINERS ARE COUNTED ONCE by the whole-tree audit, parented to
//     the scope they stand in. An empty bag adds NO units — it is a place, not
//     a thing in a stack — and what goes into it is counted where it is.
//  4. NO BEHAVIOUR. Nothing here says a body should GO AND GET a bag. The seeds
//     answer "where are they", and step ④ prices the rest.
//
// The minting doors (`spawnLooseProp` / `donWornBag` / `restorePocket`) are host
// closures bound to a live world, so they are MIRRORED here exactly as
// quest-host writes them — the same convention `town-body-carry.test.ts` uses
// for the two carry doors. The policy they are fed (container-seeds.ts) and the
// rules they are made of (`containerDefOfGlyph`, `walkScopeTree`,
// `auditScopeTree`) are the real ones.
//
// No DOM / GL / session.
import { describe, it, expect } from "@jest/globals";
import {
  houseBagSeeds,
  marketBagSeeds,
  yardBagSeeds,
  PLAYER_BAG_GLYPH,
  type ContainerSeed,
} from "@shared/world-engine/kernel/town/container-seeds.js";
import { containerDefOfGlyph } from "@shared/world-engine/kernel/town/containers.js";
import {
  auditScopeTree,
  walkScopeTree,
  type ScopeId,
} from "@shared/world-engine/kernel/town/scope.js";
import {
  creatureScope,
  houseScope,
  TOWN_SCOPE,
  type OwnerScope,
} from "@shared/world-engine/interaction/behavior/ownership.js";
import { bodyCarryView, type BagRef, type BodyCarry } from "@shared/world-engine/kernel/town/scope-shape.js";
import type { StockEndpoint } from "@shared/world-engine/kernel/town/transfer.js";

const PLAYER = "player"; // PLAYER_CREATURE_ID
const LIVING = { x: 10, y: 20, w: 6, h: 5 };
const MARKET = { x: 0, y: 0 };
const YARD = { x: 40, y: 40 };

// ── ① The policy itself ───────────────────────────────────────────────────

describe("what the world starts with", () => {
  it("THE PLAYER'S BAG IS WORN — the hands must stay free", () => {
    // A basket would cost the player the hand the whole game is played with:
    // arming a glyph and picking a quest item up both need it.
    expect(containerDefOfGlyph(PLAYER_BAG_GLYPH)?.hold).toBe("wear");
  });

  it("every seed names a REAL portable container", () => {
    const all = [
      ...houseBagSeeds(0, LIVING),
      ...marketBagSeeds(MARKET),
      ...yardBagSeeds(YARD),
      { glyph: PLAYER_BAG_GLYPH, at: MARKET, owner: null } as ContainerSeed,
    ];
    for (const s of all) {
      expect([s.glyph, !!containerDefOfGlyph(s.glyph)?.hold]).toEqual([s.glyph, true]);
    }
  });

  it("ONE basket per house, and it belongs to the HOUSE", () => {
    const seeds = houseBagSeeds(3, LIVING);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.glyph).toBe("basket");
    // Not `creature:resident_3_0` — a shared household tool. Not null either,
    // or the neighbours' walkers would list it as free to empty.
    expect(seeds[0]!.owner).toBe(houseScope(3));
  });

  it("the household basket stands INSIDE the living room, not through a wall", () => {
    const { at } = houseBagSeeds(0, LIVING)[0]!;
    expect(at.x).toBeGreaterThan(LIVING.x);
    expect(at.x).toBeLessThan(LIVING.x + LIVING.w);
    expect(at.y).toBeGreaterThan(LIVING.y);
    expect(at.y).toBeLessThan(LIVING.y + LIVING.h);
  });

  it("the market offers baskets AND satchels, unowned — stock, not property", () => {
    const seeds = marketBagSeeds(MARKET);
    const glyphs = seeds.map((s) => s.glyph).sort();
    expect(glyphs).toEqual(["basket", "basket", "satchel", "satchel"]);
    // Unowned is the ownership.ts answer for "free for the taking" — the same
    // answer the loose fruit already scattered at the stalls gives. Both kinds,
    // because the basket/satchel choice is the interesting one.
    expect(seeds.every((s) => s.owner === null)).toBe(true);
  });

  it("the builder's yard gets ONE basket, communal at the TOWN tier", () => {
    // Its own seed, not part of the market's: the yard exists on an age-0
    // homestead that has no market at all, and that is the settlement most in
    // need of something to haul with.
    expect(yardBagSeeds(YARD)).toEqual([
      { glyph: "basket", at: expect.any(Object), owner: TOWN_SCOPE },
    ]);
  });

  it("no two seeds are minted on the same spot", () => {
    const spots = [
      ...houseBagSeeds(0, LIVING),
      ...marketBagSeeds(MARKET),
      ...yardBagSeeds(YARD),
    ].map((s) => `${s.at.x},${s.at.y}`);
    expect(new Set(spots).size).toBe(spots.length);
  });
});

// ── The world, mirroring quest-host's minting doors ───────────────────────
//
// `stock` is the SAME map the container registry holds — the alias law. The
// whole point of a seeded container is that writing to it writes to the world.

interface Bench {
  /** `session.containers` — registration is what makes a stack reachable. */
  registered: Map<string, "in" | "on">;
  /** `session.containerStock`. */
  stock: Map<string, Record<string, number>>;
  /** `session.containerOwner`. */
  owner: Map<string, OwnerScope | null>;
  /** `session.smallProps` — every loose prop, objId → glyph. */
  props: Map<string, string>;
  /** `session.wornBags`. */
  worn: Map<string, { objId: string; glyph: string }>;
  /** The ONE object in the hands (world `ObjectState.carriedBy`), per body. */
  hands: Map<string, { objId: string; glyph: string }>;
  /** The building a loose prop stands in — the bench's `buildingAt`. */
  standsIn: Map<string, ScopeId>;
  serial: number;
}

function bench(): Bench {
  return {
    registered: new Map(),
    stock: new Map(),
    owner: new Map(),
    props: new Map(),
    worn: new Map(),
    hands: new Map(),
    standsIn: new Map(),
    serial: 0,
  };
}

/** quest-host `spawnLooseProp` — a fresh prop, registered as a container the
 *  moment it exists (a container is a container wherever it is, step ②). */
function spawnLooseProp(b: Bench, glyph: string, building?: ScopeId): string {
  const objId = `small:e${++b.serial}`;
  b.props.set(objId, glyph);
  const def = containerDefOfGlyph(glyph);
  if (def) b.registered.set(objId, def.relation);
  if (building) b.standsIn.set(objId, building);
  return objId;
}

/** quest-host `seedContainerProp` — mint the seed and record whose it is. */
function seedContainerProp(b: Bench, seed: ContainerSeed, building?: ScopeId): string {
  const objId = spawnLooseProp(b, seed.glyph, building);
  b.owner.set(objId, seed.owner);
  return objId;
}

/** quest-host `donWornBag` — the prop LEAVES the world while worn; its id, its
 *  registration and its stock stay exactly where they were. */
function donWornBag(b: Bench, cid: string, objId: string): boolean {
  if (b.worn.has(cid)) return false;
  const glyph = b.props.get(objId) ?? b.worn.get(cid)?.glyph;
  const def = glyph ? containerDefOfGlyph(glyph) : null;
  if (!glyph || def?.hold !== "wear") return false;
  if (!b.stock.has(objId)) b.stock.set(objId, {});
  b.registered.set(objId, def.relation);
  b.owner.set(objId, creatureScope(cid));
  b.props.delete(objId);
  b.standsIn.delete(objId);
  b.worn.set(cid, { objId, glyph });
  return true;
}

/** quest-host `seedPlayerBag` — the guard is BEFORE the mint, so a second run
 *  never leaves a spare satchel at the player's feet. */
function seedPlayerBag(b: Bench, cid = PLAYER): void {
  if (b.worn.has(cid)) return;
  donWornBag(b, cid, spawnLooseProp(b, PLAYER_BAG_GLYPH));
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

/** quest-host `pocketSnapshot` — the goods PLUS each bag as one unit of its
 *  own glyph, so the bags travel with the body across a host handoff. */
function pocketSnapshot(b: Bench, cid: string): Record<string, number> {
  const carry = carryOf(b, cid);
  const out: Record<string, number> = { ...bodyCarryView(carry) };
  for (const bag of [carry.inHand?.bag ?? null, carry.worn]) {
    if (bag) out[bag.glyph] = (out[bag.glyph] ?? 0) + 1;
  }
  return out;
}

/** quest-host `restorePocket` — CLEAR the body's carry (registrations and all),
 *  then rebuild containers-first from the snapshot. */
function restorePocket(b: Bench, cid: string, stacks: Record<string, number>): void {
  const old = carryOf(b, cid);
  if (old.inHand) b.hands.delete(cid);
  for (const bag of [old.inHand?.bag ?? null, old.worn]) {
    if (!bag) continue;
    b.stock.delete(bag.objId);
    b.registered.delete(bag.objId);
    b.owner.delete(bag.objId);
    b.props.delete(bag.objId);
  }
  b.worn.delete(cid);
  const goods: [string, number][] = [];
  for (const [g, n] of Object.entries(stacks)) {
    if (n <= 0) continue;
    const def = containerDefOfGlyph(g);
    if (!def?.hold) {
      goods.push([g, n]);
      continue;
    }
    for (let k = 0; k < n; k++) {
      const objId = spawnLooseProp(b, g);
      if (def.hold === "wear" && !b.worn.has(cid)) donWornBag(b, cid, objId);
      else if (!b.hands.has(cid)) b.hands.set(cid, { objId, glyph: g });
    }
  }
  for (const [g, n] of goods) {
    const bag = carryOf(b, cid).worn;
    if (bag) bag.stock[g] = (bag.stock[g] ?? 0) + n;
  }
}

// ── The scope tree, mirroring quest-host's `scopeTreeOf` ──────────────────

function treeOf(b: Bench) {
  return {
    ids: (): ScopeId[] => {
      const out = new Set<ScopeId>([TOWN_SCOPE, "h_0", `pocket:${PLAYER}`]);
      for (const id of b.registered.keys()) out.add(id);
      for (const id of b.stock.keys()) out.add(id);
      for (const cid of b.worn.keys()) out.add(`pocket:${cid}`);
      for (const [cid, h] of b.hands) if (b.registered.has(h.objId)) out.add(`pocket:${cid}`);
      return [...out];
    },
    // A BODY IS A STACKLESS PARENT NODE — its containers carry the goods.
    endpointOf: (id: string): StockEndpoint | null => {
      if (id.startsWith("pocket:")) return null;
      const stack = b.stock.get(id);
      return stack ? { id, kind: "container", stack, owner: b.owner.get(id) ?? null } : null;
    },
    houseOfCreature: () => null,
    buildingOfContainer: (objectId: string): ScopeId | null => {
      for (const [cid, w] of b.worn) if (w.objId === objectId) return `pocket:${cid}`;
      for (const [cid, h] of b.hands) if (h.objId === objectId) return `pocket:${cid}`;
      // Null = "not standing in a building I can name" — the same answer
      // `buildingAt` gives for open ground, which lets scope.ts fall through to
      // a chest's own `furn_<hi>_` id and then to the town.
      return b.standsIn.get(objectId) ?? null;
    },
    townId: () => TOWN_SCOPE,
  };
}

/** Every registered container of `glyph` the bench holds — the count that must
 *  never drift from the number of times a seed ran. */
function containersOf(b: Bench, glyph: string): string[] {
  const out: string[] = [];
  for (const id of b.registered.keys()) {
    const g = b.props.get(id) ?? [...b.worn.values()].find((w) => w.objId === id)?.glyph;
    if (g === glyph) out.push(id);
  }
  return out;
}

// ── ② The player's satchel, minted exactly once ───────────────────────────

describe("the player starts wearing a satchel", () => {
  it("one worn bag, registered, with a live stack and the player's own name on it", () => {
    const b = bench();
    seedPlayerBag(b);

    const worn = b.worn.get(PLAYER)!;
    expect(worn.glyph).toBe(PLAYER_BAG_GLYPH);
    expect(b.registered.has(worn.objId)).toBe(true);
    // A PERSONAL BAG IS NOT THE HOUSEHOLD PANTRY: the private-property gate
    // keeps housemates out of it exactly as it keeps them out of a member's box.
    expect(b.owner.get(worn.objId)).toBe(creatureScope(PLAYER));
    // The stack is real from the first write — the alias law.
    expect(b.stock.get(worn.objId)).toEqual({});
    // …and NO prop is left lying in the world: a worn bag has no world object.
    expect(b.props.size).toBe(0);
  });

  it("the hands stay FREE — the whole reason it is a satchel", () => {
    const b = bench();
    seedPlayerBag(b);
    expect(carryOf(b, PLAYER).inHand).toBeNull();
    // …and it can hold something, which a one-item body never could.
    const bag = carryOf(b, PLAYER).worn!;
    bag.stock.apple = 3;
    expect(bodyCarryView(carryOf(b, PLAYER))).toEqual({ apple: 3 });
  });

  it("🚨 SEEDING TWICE MINTS ONE BAG — a resumed session gains nothing", () => {
    const b = bench();
    seedPlayerBag(b);
    const first = b.worn.get(PLAYER)!.objId;
    seedPlayerBag(b);
    seedPlayerBag(b);

    expect(b.worn.get(PLAYER)!.objId).toBe(first);
    expect(containersOf(b, PLAYER_BAG_GLYPH)).toEqual([first]);
    // The guard runs BEFORE the mint — no spare satchel on the floor.
    expect(b.props.size).toBe(0);
  });

  it("🚨 A HANDOFF RESTORES ONE SATCHEL, NOT TWO — bag and contents both", () => {
    const b = bench();
    seedPlayerBag(b);
    carryOf(b, PLAYER).worn!.stock.bread = 2;

    // The sending host's snapshot lists the bag as one unit of its own glyph.
    const snap = pocketSnapshot(b, PLAYER);
    expect(snap).toEqual({ bread: 2, satchel: 1 });

    // The receiving host has ALREADY seeded a satchel of its own (start() runs
    // before the handoff) — this is the exact frame a second bag appears in.
    const rx = bench();
    seedPlayerBag(rx);
    restorePocket(rx, PLAYER, snap);

    expect(containersOf(rx, PLAYER_BAG_GLYPH)).toHaveLength(1);
    expect(bodyCarryView(carryOf(rx, PLAYER))).toEqual({ bread: 2 });
    // No orphan registration keyed by the bag that was cleared away.
    expect(rx.registered.size).toBe(1);
    expect(rx.stock.size).toBe(1);
  });

  it("contributes NO units of its own to the audit — a bag is a place", () => {
    const b = bench();
    seedPlayerBag(b);
    expect(auditScopeTree(treeOf(b))).toEqual({});
  });

  it("hangs off the PLAYER's body in the tree, and the body carries no stack", () => {
    const b = bench();
    seedPlayerBag(b);
    const by = new Map(walkScopeTree(treeOf(b)).map((n) => [n.id, n]));
    expect(by.get(b.worn.get(PLAYER)!.objId)!.parent).toBe(`pocket:${PLAYER}`);
    expect(by.get(`pocket:${PLAYER}`)!.endpoint).toBeNull();
  });
});

// ── ③ The household basket ────────────────────────────────────────────────

describe("each house holds ONE basket", () => {
  /** The house-furnishing moment: the goods chest, then the seeded basket. */
  function furnishedHouse(): Bench {
    const b = bench();
    b.registered.set("furn_0_chest_food", "in");
    b.stock.set("furn_0_chest_food", { apple: 4 });
    b.owner.set("furn_0_chest_food", houseScope(0));
    for (const seed of houseBagSeeds(0, LIVING)) seedContainerProp(b, seed, "h_0");
    return b;
  }

  it("a materialized house has exactly one basket prop, registered, house-owned", () => {
    const b = furnishedHouse();
    const baskets = containersOf(b, "basket");
    expect(baskets).toHaveLength(1);
    expect(b.registered.get(baskets[0]!)).toBe("in");
    expect(b.owner.get(baskets[0]!)).toBe(houseScope(0));
  });

  it("it hangs off the HOUSE it stands in, beside the goods chest", () => {
    const b = furnishedHouse();
    const by = new Map(walkScopeTree(treeOf(b)).map((n) => [n.id, n]));
    expect(by.get(containersOf(b, "basket")[0]!)!.parent).toBe("h_0");
    expect(by.get("furn_0_chest_food")!.parent).toBe("h_0");
  });

  it("🚨 THE AUDIT COUNTS THE SEEDS ONCE — an empty basket adds nothing", () => {
    const b = furnishedHouse();
    expect(auditScopeTree(treeOf(b))).toEqual({ apple: 4 });

    // …and what goes INTO it is counted where it is, exactly once.
    const basket = containersOf(b, "basket")[0]!;
    b.stock.set(basket, { apple: 2 });
    expect(auditScopeTree(treeOf(b))).toEqual({ apple: 6 });
  });

  it("furnishing runs ONCE per house — a second pass would be a second basket", () => {
    // The seeding hangs off the same once-per-session moment the chests do, so
    // the count is the guard: two calls means two baskets, which is why the
    // call site must never be reachable twice.
    const b = furnishedHouse();
    expect(containersOf(b, "basket")).toHaveLength(1);
    for (const seed of houseBagSeeds(0, LIVING)) seedContainerProp(b, seed, "h_0");
    expect(containersOf(b, "basket")).toHaveLength(2);
  });
});

// ── ④ The town's supply ───────────────────────────────────────────────────

describe("the market and the yard stock bags", () => {
  function stockedTown(): Bench {
    const b = bench();
    for (const seed of [...marketBagSeeds(MARKET), ...yardBagSeeds(YARD)]) {
      seedContainerProp(b, seed);
    }
    return b;
  }

  it("every seeded bag is a registered container standing in the town", () => {
    const b = stockedTown();
    const by = new Map(walkScopeTree(treeOf(b)).map((n) => [n.id, n]));
    for (const id of b.registered.keys()) expect(by.get(id)!.parent).toBe(TOWN_SCOPE);
    expect(containersOf(b, "basket")).toHaveLength(3);
    expect(containersOf(b, "satchel")).toHaveLength(2);
  });

  it("the whole tree audits to nothing — seeding bags creates no goods", () => {
    const b = stockedTown();
    seedPlayerBag(b);
    for (const seed of houseBagSeeds(0, LIVING)) seedContainerProp(b, seed, "h_0");
    expect(auditScopeTree(treeOf(b))).toEqual({});
    // Seven bags in the world — five at the market and the yard, one in the
    // house, one on the player — each a node and each counted once.
    expect(walkScopeTree(treeOf(b)).filter((n) => n.ref.kind === "container")).toHaveLength(7);
  });
});
