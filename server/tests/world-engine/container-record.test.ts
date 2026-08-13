// THE CONTAINER RECORD — invariant pins (worklist ⑤ — one container record,
// kernel/town/containers.ts).
//
// `QuestSession` used to carry FIVE independently-keyed Maps for one concept
// (`containers`, `containerStock`, `containerOwner`, `smallProps`,
// `wornBags`); a container that was also lying loose (a dropped basket)
// needed a row in four of them, kept in lock-step by hand at every call
// site. This pins the ONE record's own invariants — the equivalences the
// migration leans on, and the two places the old five stores could
// legitimately disagree with each other (which the record must still be
// able to represent honestly).
//
// Pure unit tests over a bare `ContainerRegistry` — no world, no session,
// no boot. No DOM / GL / DB.

import { describe, it, expect } from "@jest/globals";
import {
  recordOf,
  isContainerId,
  registerContainer,
  setContainerOwner,
  setContainerStock,
  ensureContainerStock,
  containerEntries,
  containerIds,
  stockedEntries,
  stockedIds,
  hasStock,
  registeredContainerCount,
  stockedCount,
  deleteContainerRecord,
  isLooseProp,
  loosePropOf,
  setLooseProp,
  clearLooseProp,
  looseEntries,
  looseIds,
  looseCount,
  wornBagOf,
  type ContainerRegistry,
} from "@shared/world-engine/kernel/town/containers.js";

const registry = (): ContainerRegistry => ({
  containerRecords: new Map(),
  wornBagIndex: new Map(),
});

describe("registerContainer / isContainerId — the old `containers`+`containerOwner`", () => {
  it("a fresh id becomes a container with the given relation and owner", () => {
    const r = registry();
    registerContainer(r, "furn_0_table", "on", "house:0");
    expect(isContainerId(r, "furn_0_table")).toBe(true);
    const rec = r.containerRecords.get("furn_0_table")!;
    expect(rec.relation).toBe("on");
    expect(rec.owner).toBe("house:0");
    expect(rec.mount).toBe("standing"); // no world instance — the default
  });

  it("🚨 an id nobody registered answers isContainerId FALSE, exactly like the old `containers.has` miss", () => {
    const r = registry();
    expect(isContainerId(r, "nowhere")).toBe(false);
    expect(r.containerRecords.has("nowhere")).toBe(false); // no ghost row from a bare read
  });

  it("owner can stand ALONE on an otherwise-bare row — a bed is not a container but still has one", () => {
    const r = registry();
    setContainerOwner(r, "furn_0_bed_0", "resident_0_0|resident_0_1");
    expect(isContainerId(r, "furn_0_bed_0")).toBe(false); // no relation ⇒ not a container
    expect(r.containerRecords.get("furn_0_bed_0")!.owner).toBe("resident_0_0|resident_0_1");
  });

  it("re-registering an EXISTING loose+container row updates relation/owner but never touches mount/glyph", () => {
    const r = registry();
    setLooseProp(r, "small:basket1", { entityId: "e1", glyph: "basket", at: 10 });
    registerContainer(r, "small:basket1", "in", "creature:resident_0_0", { apple: 2 });
    const rec = r.containerRecords.get("small:basket1")!;
    expect(rec.mount).toBe("loose"); // untouched
    expect(rec.glyph).toBe("basket"); // untouched
    expect(rec.entityId).toBe("e1"); // untouched
    expect(rec.relation).toBe("in");
    expect(rec.owner).toBe("creature:resident_0_0");
    expect(rec.stock).toEqual({ apple: 2 });
  });
});

describe("🚨 STOCK IS DELIBERATELY LAZY — registerContainer never defaults it to {}", () => {
  it("a container registered with no stock argument has NO containerStock row at all", () => {
    const r = registry();
    registerContainer(r, "furn_0_cupboard", "in", "house:0"); // no stock given
    expect(isContainerId(r, "furn_0_cupboard")).toBe(true); // IS a container
    expect(hasStock(r, "furn_0_cupboard")).toBe(false); // but has never been stocked
    expect([...stockedIds(r)]).not.toContain("furn_0_cupboard");
    expect([...containerIds(r)]).toContain("furn_0_cupboard");
  });

  it("ensureContainerStock is the ONE lazy door — creates {} on first touch, same object every time after (the alias law)", () => {
    const r = registry();
    registerContainer(r, "furn_0_cupboard", "in", "house:0");
    expect(hasStock(r, "furn_0_cupboard")).toBe(false);
    const stock1 = ensureContainerStock(r, "furn_0_cupboard");
    expect(stock1).toEqual({});
    expect(hasStock(r, "furn_0_cupboard")).toBe(true);
    stock1.apple = 3;
    const stock2 = ensureContainerStock(r, "furn_0_cupboard");
    expect(stock2).toBe(stock1); // SAME object — never a copy
    expect(stock2.apple).toBe(3);
  });

  it("registeredContainerCount and stockedCount are DIFFERENT counts, on purpose", () => {
    const r = registry();
    registerContainer(r, "furn_0_cupboard", "in", null); // registered, never stocked
    registerContainer(r, "furn_0_barrel", "in", null, { water: 4 }); // registered AND stocked
    expect(registeredContainerCount(r)).toBe(2);
    expect(stockedCount(r)).toBe(1);
  });

  it("setContainerStock / ensureContainerStock never retroactively add a `relation` — a bare stock-only row is possible and honest", () => {
    const r = registry();
    setContainerStock(r, "orphan_stock_id", { wood: 1 });
    expect(hasStock(r, "orphan_stock_id")).toBe(true);
    expect(isContainerId(r, "orphan_stock_id")).toBe(false); // no relation was ever given
  });
});

describe("containerEntries / stockedEntries — two different iterations, never conflated", () => {
  it("containerEntries yields every registered container, stocked or not", () => {
    const r = registry();
    registerContainer(r, "a", "in", null);
    registerContainer(r, "b", "in", null, { wood: 1 });
    expect([...containerEntries(r)].map(([id]) => id).sort()).toEqual(["a", "b"]);
  });

  it("stockedEntries yields ONLY rows with a stock — the set containerEntries's `stock` field may be undefined for", () => {
    const r = registry();
    registerContainer(r, "a", "in", null);
    registerContainer(r, "b", "in", null, { wood: 1 });
    expect([...stockedEntries(r)].map(([id]) => id)).toEqual(["b"]);
    for (const [, rec] of containerEntries(r)) {
      // every containerEntries row is either stocked or explicitly undefined —
      // never a thrown accessor, so callers can always ask `rec.stock`.
      expect(rec.stock === undefined || typeof rec.stock === "object").toBe(true);
    }
  });
});

describe("deleteContainerRecord — the full old containers+containerStock+containerOwner delete-together", () => {
  it("wipes relation, owner AND stock in one call — nothing survives under the same id", () => {
    const r = registry();
    registerContainer(r, "furn_0_barrel", "in", "house:0", { water: 4 });
    deleteContainerRecord(r, "furn_0_barrel");
    expect(r.containerRecords.has("furn_0_barrel")).toBe(false);
    expect(isContainerId(r, "furn_0_barrel")).toBe(false);
    expect(hasStock(r, "furn_0_barrel")).toBe(false);
  });
});

describe("setLooseProp / isLooseProp / loosePropOf — the old `smallProps`, mount-gated", () => {
  it("a fresh id becomes mount:\"loose\" with its glyph/entityId/at", () => {
    const r = registry();
    setLooseProp(r, "small:apple1", { entityId: "e2", glyph: "apple", at: 42 });
    expect(isLooseProp(r, "small:apple1")).toBe(true);
    expect(loosePropOf(r, "small:apple1")).toMatchObject({ glyph: "apple", entityId: "e2", at: 42 });
  });

  it("🚨 a STANDING container is NOT a loose prop — mount-gated, not a bare map hit", () => {
    const r = registry();
    registerContainer(r, "furn_0_table", "on", null);
    expect(isLooseProp(r, "furn_0_table")).toBe(false);
    expect(loosePropOf(r, "furn_0_table")).toBeUndefined();
  });

  it("looseEntries / looseIds / looseCount see ONLY mount:\"loose\" rows, never standing or worn ones", () => {
    const r = registry();
    setLooseProp(r, "small:apple1", { entityId: "e2", glyph: "apple" });
    registerContainer(r, "furn_0_table", "on", null); // standing — must not leak in
    r.containerRecords.set("small:worn1", { mount: "worn", glyph: "satchel", wearer: "resident_0_0" }); // worn — must not leak in
    expect([...looseIds(r)]).toEqual(["small:apple1"]);
    expect(looseCount(r)).toBe(1);
    expect([...looseEntries(r)].map(([id]) => id)).toEqual(["small:apple1"]);
  });
});

describe("🚨 A CONTAINER THAT IS ALSO LOOSE — the state four old stores needed together", () => {
  it("a dropped basket is mount:\"loose\" AND isContainerId at once, on the SAME row", () => {
    const r = registry();
    const objId = "small:basket1";
    setLooseProp(r, objId, { entityId: "e3", glyph: "basket", at: 5 });
    registerContainer(r, objId, "in", "creature:resident_0_0", { apple: 1 });
    expect(isLooseProp(r, objId)).toBe(true);
    expect(isContainerId(r, objId)).toBe(true);
    const rec = r.containerRecords.get(objId)!;
    expect(rec.stock).toEqual({ apple: 1 });
    expect(rec.glyph).toBe("basket"); // the loose half's field, still there
  });
});

describe("clearLooseProp — the old bare `smallProps.delete` (container fields untouched, bug-compatible)", () => {
  it("a PURE loose prop (never a container) disappears entirely", () => {
    const r = registry();
    setLooseProp(r, "small:apple1", { entityId: "e2", glyph: "apple" });
    clearLooseProp(r, "small:apple1");
    expect(r.containerRecords.has("small:apple1")).toBe(false);
  });

  it("🚨 a loose prop that is ALSO a container falls back to \"standing\" — relation/stock/owner SURVIVE", () => {
    // Mirrors the old removeLooseProp: it only ever cleared `smallProps`,
    // never touching `containers`/`containerStock`/`containerOwner` — so a
    // basket-shaped prop that got swept as clutter kept its container
    // registration as an orphaned (but honest) standing row.
    const r = registry();
    const objId = "small:basket1";
    setLooseProp(r, objId, { entityId: "e3", glyph: "basket", at: 5 });
    registerContainer(r, objId, "in", "creature:resident_0_0", { apple: 1 });
    clearLooseProp(r, objId);
    expect(isLooseProp(r, objId)).toBe(false);
    const rec = r.containerRecords.get(objId)!;
    expect(rec).toBeDefined();
    expect(rec.mount).toBe("standing");
    expect(rec.entityId).toBeUndefined();
    expect(rec.at).toBeUndefined();
    expect(rec.relation).toBe("in"); // container fields conserved
    expect(rec.stock).toEqual({ apple: 1 });
    expect(rec.owner).toBe("creature:resident_0_0");
  });

  it("is a no-op on an id that is not currently loose (worn or standing)", () => {
    const r = registry();
    registerContainer(r, "furn_0_table", "on", null);
    clearLooseProp(r, "furn_0_table");
    expect(isContainerId(r, "furn_0_table")).toBe(true); // untouched
  });
});

describe("🚨 THE WEARER INDEX ⇄ mount:\"worn\" COHERENCE (donWornBag/doffWornBag's one seam)", () => {
  /** `donWornBag`/`doffWornBag` live in quest-host.ts (they touch live world
   *  objects), so this pins the SHAPE their one seam must keep coherent —
   *  the two directions a worn container is reached by. */
  function don(r: ContainerRegistry, cid: string, objId: string, glyph: string): void {
    const rec = recordOf(r, objId);
    rec.mount = "worn";
    rec.glyph = glyph;
    rec.wearer = cid;
    rec.relation = "in";
    if (!rec.stock) rec.stock = {};
    rec.owner = `creature:${cid}`;
    delete rec.entityId;
    delete rec.at;
    r.wornBagIndex.set(cid, objId);
  }
  function doff(r: ContainerRegistry, cid: string): string | null {
    const objId = r.wornBagIndex.get(cid);
    if (!objId) return null;
    const rec = r.containerRecords.get(objId)!;
    rec.mount = "loose";
    rec.entityId = `mat_${objId}`;
    rec.at = 99;
    delete rec.wearer;
    r.wornBagIndex.delete(cid);
    return objId;
  }

  it("donning: the index points forward (cid → objId), the record points back (wearer === cid)", () => {
    const r = registry();
    don(r, "resident_0_0", "small:satchel1", "satchel");
    const objId = r.wornBagIndex.get("resident_0_0")!;
    expect(objId).toBe("small:satchel1");
    expect(r.containerRecords.get(objId)!.wearer).toBe("resident_0_0");
    expect(r.containerRecords.get(objId)!.mount).toBe("worn");
  });

  it("wornBagOf reads the SAME glyph the loose prop carried before donning — one row, both directions", () => {
    const r = registry();
    don(r, "resident_0_0", "small:satchel1", "satchel");
    expect(wornBagOf(r, "resident_0_0")).toEqual({ objId: "small:satchel1", glyph: "satchel" });
  });

  it("a worn container is NEVER also a loose prop — the two mounts are exclusive", () => {
    const r = registry();
    don(r, "resident_0_0", "small:satchel1", "satchel");
    expect(isLooseProp(r, "small:satchel1")).toBe(false);
    expect([...looseIds(r)]).not.toContain("small:satchel1");
  });

  it("a worn container STAYS a registered container (relation/stock/owner) — donning ⇄ doffing conserves the goods", () => {
    const r = registry();
    don(r, "resident_0_0", "small:satchel1", "satchel");
    ensureContainerStock(r, "small:satchel1").wood = 3;
    expect(isContainerId(r, "small:satchel1")).toBe(true);
    doff(r, "resident_0_0");
    // Doffing re-spawns the SAME id as loose — the container registration
    // (and its stock) survives the round trip untouched.
    expect(isContainerId(r, "small:satchel1")).toBe(true);
    expect(r.containerRecords.get("small:satchel1")!.stock).toEqual({ wood: 3 });
    expect(isLooseProp(r, "small:satchel1")).toBe(true);
  });

  it("doffing clears BOTH directions together — the index entry and the record's `wearer`", () => {
    const r = registry();
    don(r, "resident_0_0", "small:satchel1", "satchel");
    doff(r, "resident_0_0");
    expect(r.wornBagIndex.has("resident_0_0")).toBe(false);
    expect(r.containerRecords.get("small:satchel1")!.wearer).toBeUndefined();
    expect(r.containerRecords.get("small:satchel1")!.mount).toBe("loose");
  });

  it("wornBagOf answers undefined for a cid wearing nothing — the old `wornBags.get` miss", () => {
    const r = registry();
    expect(wornBagOf(r, "resident_0_1")).toBeUndefined();
  });

  it("🚨 NEVER TWO SOURCES OF TRUTH: every wornBagIndex entry names a row that is ACTUALLY mount:\"worn\" with a MATCHING wearer", () => {
    const r = registry();
    don(r, "resident_0_0", "small:satchel1", "satchel");
    don(r, "resident_0_1", "small:basket2", "basket");
    for (const [cid, objId] of r.wornBagIndex) {
      const rec = r.containerRecords.get(objId);
      expect(rec).toBeDefined();
      expect(rec!.mount).toBe("worn");
      expect(rec!.wearer).toBe(cid);
    }
    // …and the converse: every mount:"worn" row is named by exactly one
    // wornBagIndex entry, pointing at the SAME id.
    for (const [objId, rec] of r.containerRecords) {
      if (rec.mount !== "worn") continue;
      expect(r.wornBagIndex.get(rec.wearer!)).toBe(objId);
    }
  });
});

describe("🚨 \"held\" is deliberately not a stored mount", () => {
  it("the ContainerMount union has no representation for a body's hand — that fact lives on the world object (carriedBy), never here", () => {
    const r = registry();
    setLooseProp(r, "small:apple1", { entityId: "e2", glyph: "apple" });
    const rec = r.containerRecords.get("small:apple1")!;
    // Whether this apple is currently in a hand is NOT this record's
    // business — mount stays "loose" whether it's lying on the floor or
    // being carried; only `world.state.objects[id].carriedBy` says which.
    expect(rec.mount).toBe("loose");
  });
});
