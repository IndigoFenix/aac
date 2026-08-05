/**
 * THE SCOPE NODE (kernel/town/scope.ts) — step ① of scope-unification.md.
 *
 * The law under test: a body, a chest, a building, a district and a town are
 * ONE SHAPE, and a scope's inventory is the sum of its containers rather than a
 * field on the scope. Step ① builds only the grammar and the tree; it moves no
 * behaviour, so the sharpest tests here are the ones that pin exactly that —
 * that every id already in the wild keeps meaning what it meant.
 *
 * No DOM / GL / session.
 */
import { describe, it, expect } from "@jest/globals";
import {
  auditScopeTree,
  descendantScopeIds,
  isTownYard,
  itemLocationOf,
  ownerScopeOf,
  parseScopeId,
  scopeIdOf,
  scopeParentOf,
  scopeStock,
  scopeStockIndex,
  scopeUnits,
  walkScopeTree,
  SITE_STOCK_ID,
  TOWN_YARD_ID,
  type ScopeId,
  type ScopeRef,
} from "@shared/world-engine/kernel/town/scope.js";
import { TOWN_SCOPE } from "@shared/world-engine/interaction/behavior/ownership.js";
import { cohortEndpointId } from "@shared/world-engine/kernel/town/population.js";
import {
  depotEndpointId,
  produceEndpointId,
  shelfEndpointId,
  townEndpointId,
  type StockEndpoint,
} from "@shared/world-engine/kernel/town/transfer.js";

/** Every id spelling the game can actually produce, from the printers that
 *  produce them wherever one exists. */
const WILD_IDS: ScopeId[] = [
  TOWN_SCOPE,
  TOWN_YARD_ID,
  SITE_STOCK_ID,
  "pocket:resident_3_1",
  "pocket:player",
  cohortEndpointId(-1),
  cohortEndpointId(4),
  townEndpointId("oakford"),
  depotEndpointId("oakford"),
  produceEndpointId("food", 2),
  shelfEndpointId("wood", 0),
  "orderpile:7",
  "sitepile:2",
  "annexpile:5",
  "bfurn:h_3",
  "h_0",
  "w_12",
  "furn_3_chest_food",
  "furn_0_cupboard",
  "small:e_1729",
  "ws_oak_44",
];

describe("the id grammar — every endpoint id already in the wild", () => {
  it("ROUND-TRIPS, which is what makes the parse safe on persisted agreements", () => {
    // Transfer agreements save `from`/`to` as these strings and a live haul
    // outlives any refactor. If the round trip ever breaks, an in-flight
    // shipment loses its destination.
    for (const id of WILD_IDS) {
      expect([id, scopeIdOf(parseScopeId(id))]).toEqual([id, id]);
    }
  });

  it("parses each prefix to the kind it names", () => {
    const kindOf = (id: string) => parseScopeId(id).kind;
    expect(kindOf("pocket:resident_3_1")).toBe("creature");
    expect(kindOf(cohortEndpointId(4))).toBe("district");
    expect(kindOf(townEndpointId("oakford"))).toBe("town");
    expect(kindOf(TOWN_SCOPE)).toBe("town");
    expect(kindOf(depotEndpointId("oakford"))).toBe("depot");
    expect(kindOf(produceEndpointId("food", 2))).toBe("produce");
    expect(kindOf(shelfEndpointId("wood", 0))).toBe("shelf");
    expect(kindOf("orderpile:7")).toBe("orderPile");
    expect(kindOf("sitepile:2")).toBe("sitePile");
    expect(kindOf("annexpile:5")).toBe("annexPile");
    expect(kindOf("bfurn:h_3")).toBe("buildingFurnPile");
    expect(kindOf(SITE_STOCK_ID)).toBe("siteStock");
    expect(kindOf("h_0")).toBe("building");
    expect(kindOf("w_12")).toBe("building");
  });

  it("is TOTAL — an unknown id is a container, which is what it always was", () => {
    // The fallback is not a failure mode: an unrecognised endpoint has always
    // been looked up in the container registry, and this preserves that.
    expect(parseScopeId("furn_3_chest_food")).toEqual({ kind: "container", objectId: "furn_3_chest_food" });
    expect(parseScopeId("ws_oak_44")).toEqual({ kind: "container", objectId: "ws_oak_44" });
    expect(parseScopeId("")).toEqual({ kind: "container", objectId: "" });
  });

  it("🚨 keeps `town:yard` APART from a partner town, which share a prefix", () => {
    // Both are `town:` ids; one is our own registered container and one is a
    // foreign shelf. The parse is syntactic and the resolver keeps the
    // registry's precedence — but the yard must at least be nameable.
    expect(isTownYard(parseScopeId(TOWN_YARD_ID))).toBe(true);
    expect(isTownYard(parseScopeId(townEndpointId("oakford")))).toBe(false);
    expect(isTownYard(parseScopeId(TOWN_SCOPE))).toBe(false);
  });

  it("does not mistake a house delta key for a container", () => {
    // `h_3` is what every delta, order and furnish task calls that building;
    // giving it a second spelling would be a third name for one thing.
    expect(parseScopeId("h_3")).toEqual({ kind: "building", buildingKey: "h_3" });
    expect(parseScopeId("h_3_extra").kind).toBe("container"); // not a bare key
  });
});

describe("containment — the ladder ownership.ts already declared, given to inventory", () => {
  const ctx = {
    houseOfCreature: (cid: string) => (cid.startsWith("resident_") ? Number(cid.split("_")[1]) : null),
    buildingOfContainer: (objectId: string) => (objectId === "small:e_1" ? "h_5" : null),
    buildingOfOrder: (ord: number) => (ord === 7 ? "h_2" : null),
    townId: () => TOWN_SCOPE,
  };
  const parentOf = (id: string) => scopeParentOf(parseScopeId(id), ctx);

  it("a body belongs to its household, and a stray to the town", () => {
    expect(parentOf("pocket:resident_3_1")).toBe("h_3");
    expect(parentOf("pocket:player")).toBe(TOWN_SCOPE);
  });

  it("a container belongs to the building it stands in", () => {
    expect(parentOf("small:e_1")).toBe("h_5"); // the host placed it
    expect(parentOf("furn_3_chest_food")).toBe("h_3"); // …else its own id says
    expect(parentOf("ws_oak_44")).toBe(TOWN_SCOPE); // a wild source on open ground
  });

  it("buildings and districts hang off the town; the town hangs off nothing yet", () => {
    expect(parentOf("h_0")).toBe(TOWN_SCOPE);
    expect(parentOf(cohortEndpointId(2))).toBe(TOWN_SCOPE);
    expect(parentOf(TOWN_YARD_ID)).toBe(TOWN_SCOPE);
    expect(parentOf(TOWN_SCOPE)).toBeNull();
  });

  it("A PARTNER TOWN IS OUTSIDE OUR TREE — which is why shipments are scheduled", () => {
    // Not a failure: a partner has no `at`, cannot be walked to, and its parent
    // is the region tier we do not model. The null is the honest answer.
    expect(parentOf(townEndpointId("oakford"))).toBeNull();
  });

  it("an order's pile belongs to the building it grows — and a FOUNDING has none", () => {
    expect(parentOf("orderpile:7")).toBe("h_2");
    expect(parentOf("orderpile:9")).toBe(TOWN_SCOPE); // a new lot, on the town's ground
    expect(parentOf("bfurn:h_3")).toBe("h_3");
  });

  it("speaks the same ladder as mayUse, in the same strings", () => {
    expect(ownerScopeOf(parseScopeId("pocket:resident_3_1"), ctx)).toBe("house:3");
    expect(ownerScopeOf(parseScopeId("furn_3_chest_food"), ctx)).toBe("house:3");
    expect(ownerScopeOf(parseScopeId("h_0"), ctx)).toBe(TOWN_SCOPE);
  });

  it("survives a session with no town at all (a founded site)", () => {
    const bare = { townId: () => null };
    expect(scopeParentOf(parseScopeId("furn_3_chest_food"), bare)).toBe("h_3");
    expect(scopeParentOf(parseScopeId("h_0"), bare)).toBeNull();
    expect(scopeParentOf(parseScopeId(SITE_STOCK_ID), bare)).toBeNull();
  });
});

describe("the tree walk", () => {
  const ep = (id: string, stack: Record<string, number>): StockEndpoint => ({
    id, kind: "container", stack, owner: null,
  });
  const stacks: Record<string, Record<string, number>> = {
    "furn_0_chest_food": { apple: 3 },
    "furn_1_barrel": { water: 2, apple: 1 },
    "pocket:resident_0_0": { wood: 4 },
    "small:e_9": { water: 1 },
  };
  const input = {
    ids: () => [TOWN_SCOPE, "h_0", "h_1", ...Object.keys(stacks)],
    endpointOf: (id: string) => (stacks[id] ? ep(id, stacks[id]!) : null),
    houseOfCreature: (cid: string) => Number(cid.split("_")[1]),
    buildingOfContainer: (objectId: string) => (objectId === "small:e_9" ? "h_1" : null),
    townId: () => TOWN_SCOPE,
  };

  it("visits PARENTS BEFORE CHILDREN — the order condense/expand will fold in", () => {
    const order = walkScopeTree(input).map((n) => n.id);
    const before = (a: string, b: string) => order.indexOf(a) < order.indexOf(b);
    expect(before(TOWN_SCOPE, "h_0")).toBe(true);
    expect(before("h_0", "furn_0_chest_food")).toBe(true);
    expect(before("h_1", "small:e_9")).toBe(true);
    expect(before("h_0", "pocket:resident_0_0")).toBe(true);
  });

  it("reports every id exactly once, and is deterministic", () => {
    const a = walkScopeTree(input).map((n) => n.id);
    expect(new Set(a).size).toBe(a.length);
    expect(a.length).toBe([...input.ids()].length);
    expect(walkScopeTree(input).map((n) => n.id)).toEqual(a);
  });

  it("a scope with no live stack is still a NODE — it just has no endpoint", () => {
    // A building holds nothing of its own; its inventory IS its containers.
    const town = walkScopeTree(input).find((n) => n.id === TOWN_SCOPE)!;
    expect(town.endpoint).toBeNull();
    expect(walkScopeTree(input).find((n) => n.id === "h_0")!.endpoint).toBeNull();
  });

  it("SUMS THE WHOLE TREE — the question nothing could ask before", () => {
    // There was no enumeration of the places an item could be, so "how many
    // apples exist in this session" had no answer. This is the probe
    // condense/expand gets checked against.
    expect(auditScopeTree(input)).toEqual({ apple: 4, water: 3, wood: 4 });
  });

  it("does not hang on a cycle", () => {
    // Defensive: a bad context could make two scopes each other's parent, and
    // an audit that never returns is worse than a wrong number.
    const cyclic = {
      ids: () => ["a", "b"],
      endpointOf: () => null,
      buildingOfContainer: (id: string) => (id === "a" ? "b" : "a"),
      townId: () => null,
    };
    expect(walkScopeTree(cyclic).map((n) => n.id).sort()).toEqual(["a", "b"]);
  });
});

describe("a scope's inventory IS the sum of its containers", () => {
  // The law's own sentence, and the question every "have we got one" gate in
  // the engine had been asking a narrower version of. The shape below is the
  // live 2026-08-05 bug in miniature: a house whose workbench is NOT in a box.
  const ep = (id: string, stack: Record<string, number>): StockEndpoint => ({
    id, kind: "container", stack, owner: null,
  });
  const stacks: Record<string, Record<string, number>> = {
    "furn_9_cupboard": { block: 4 },
    "furn_9_chest_food": { apple: 2 },
    "small:basket_1": { apple: 1 }, // a basket on the floor, with an apple IN it
    "furn_2_chest_food": { apple: 7 }, // …another household entirely
  };
  /** The census: the workbench prop lying in h_9, and one in Mara's hands. */
  const loose: Record<string, Record<string, number>> = {
    "h_9": { "furn.workbench": 1 },
    "pocket:resident_9_0": { "furn.chair": 1 },
  };
  const input = {
    ids: () => [
      TOWN_SCOPE, "h_9", "h_2",
      "pocket:resident_9_0", ...Object.keys(stacks),
    ],
    endpointOf: (id: string) => (stacks[id] ? ep(id, stacks[id]!) : null),
    looseIn: (id: string) => loose[id] ?? null,
    houseOfCreature: (cid: string) => Number(cid.split("_")[1]),
    buildingOfContainer: (objectId: string) => (objectId === "small:basket_1" ? "h_9" : null),
    townId: () => TOWN_SCOPE,
  };

  it("counts a piece LYING ON THE FLOOR as owned — the whole bug in one line", () => {
    // `furn_9_*` container stacks hold no bench. The household still has one,
    // and every gate that reads only the boxes made another (four on the
    // kitchen floor and a fifth under way, observed live 2026-08-05).
    expect(scopeUnits("h_9", "furn.workbench", input)).toBe(1);
  });

  it("counts what the people in it are holding", () => {
    // A body hangs off its household, so a chair in Mara's hands is a chair the
    // house owns — and the house is not asked to make a second one.
    expect(scopeUnits("h_9", "furn.chair", input)).toBe(1);
    expect(scopeUnits("pocket:resident_9_0", "furn.chair", input)).toBe(1);
  });

  it("sums its containers, INCLUDING a basket standing on its floor", () => {
    expect(scopeUnits("h_9", "apple", input)).toBe(3); // 2 in the pantry + 1 in the basket
    expect(scopeUnits("h_9", "block", input)).toBe(4);
  });

  it("does NOT count the neighbours — containment, not proximity", () => {
    expect(scopeUnits("h_2", "apple", input)).toBe(7);
    expect(scopeUnits("h_2", "furn.workbench", input)).toBe(0);
  });

  it("rolls all the way up: the town holds everything in it", () => {
    expect(scopeUnits(TOWN_SCOPE, "apple", input)).toBe(10);
    expect(scopeUnits(TOWN_SCOPE, "furn.workbench", input)).toBe(1);
  });

  it("🚨 counts a unit ONCE — the basket's apple is the basket's, not also the floor's", () => {
    // The census and the stacks must not overlap, or a scope's inventory
    // inflates every time somebody sets a bag down. `looseIn` reports the
    // PROP as a unit of itself; the apple inside it is the prop's stack.
    const stock = scopeStock("h_9", input);
    expect(stock["apple"]).toBe(3);
    expect(stock["furn.workbench"]).toBe(1);
  });

  it("head-matches, so a facet is still the thing it is", () => {
    const facted = {
      ...input,
      endpointOf: (id: string) =>
        id === "furn_9_cupboard" ? ep(id, { "block.material_stone": 2 }) : input.endpointOf(id),
    };
    expect(scopeUnits("h_9", "block", facted)).toBe(2);
  });

  it("the index answers every scope in ONE pass — parents included", () => {
    // 200 households asking one at a time is a walk of the whole town per
    // question per tick, which is exactly why these gates were written as id
    // regexes in the first place.
    const idx = scopeStockIndex(input);
    expect(idx.get("h_9")?.["furn.workbench"]).toBe(1);
    expect(idx.get(TOWN_SCOPE)?.["apple"]).toBe(10);
    expect(idx.get("furn_9_cupboard")?.["block"]).toBe(4);
  });

  it("descendantScopeIds is the containment closure, and excludes the root", () => {
    const kids = descendantScopeIds("h_9", input.ids(), input);
    expect(kids).toContain("furn_9_cupboard");
    expect(kids).toContain("small:basket_1");
    expect(kids).toContain("pocket:resident_9_0"); // the body is IN the household
    expect(kids).not.toContain("h_9");
    expect(kids).not.toContain("furn_2_chest_food");
  });

  it("without a census it is the STORED reading — which the reconciler needs", () => {
    // `reconcileFurnishing` is handed the loose pieces separately, as
    // `standing`; counting them in its budget too would have the household
    // install and carry the same chair.
    const boxesOnly = { ...input, looseIn: undefined };
    expect(scopeUnits("h_9", "furn.workbench", boxesOnly)).toBe(0);
    expect(scopeUnits("h_9", "apple", boxesOnly)).toBe(3);
  });

  it("terminates on a cyclic context rather than hanging", () => {
    const cyclic = {
      ids: () => ["a", "b"],
      endpointOf: () => null,
      buildingOfContainer: (id: string) => (id === "a" ? "b" : "a"),
      townId: () => null,
    };
    expect(scopeStock("a", cyclic)).toEqual({});
  });
});

describe("the bridge to the item ledger", () => {
  it("names the ItemLocation each scope is, so a walker can move items there", () => {
    expect(itemLocationOf(parseScopeId("furn_3_chest_food"))).toEqual({
      kind: "container", id: "furn_3_chest_food",
    });
    // `hands` stays the creature spelling until step ③ deletes abstract carry.
    expect(itemLocationOf(parseScopeId("pocket:mara"))).toEqual({ kind: "hands", cid: "mara" });
  });

  it("every ScopeRef variant prints and re-parses", () => {
    const refs: ScopeRef[] = [
      { kind: "creature", cid: "mara" },
      { kind: "district", district: -1 },
      { kind: "town", key: "" },
      { kind: "town", key: "oakford" },
      { kind: "depot", townKey: "oakford" },
      { kind: "produce", goodKey: "food", workIdx: 3 },
      { kind: "shelf", goodKey: "wood", srcIdx: 1 },
      { kind: "orderPile", ord: 4 },
      { kind: "sitePile", ord: 4 },
      { kind: "annexPile", ord: 4 },
      { kind: "buildingFurnPile", buildingKey: "w_2" },
      { kind: "siteStock" },
      { kind: "building", buildingKey: "h_9" },
      { kind: "container", objectId: "furn_1_bin" },
    ];
    for (const ref of refs) {
      expect([ref.kind, parseScopeId(scopeIdOf(ref))]).toEqual([ref.kind, ref]);
    }
  });
});
