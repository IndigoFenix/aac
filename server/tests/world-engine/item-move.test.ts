// THE ITEM LEDGER (kernel/town/item-move.ts) — conservation as a hard invariant.
//
// The rule under test (user law, 2026-07-28): "Items should not just disappear,
// and it shouldn't be possible for them to get duplicated either. We need a
// defined, atomic function for every kind of item movement."
//
// So every case here asks the same question twice: did the operation do what it
// said, AND is the total number of units in the world unchanged? A move that
// half-happens is the specific failure that wedged the craft pipeline in the
// live game, so partial outcomes are treated as bugs, not as degraded success.
//
// Pure — no world, no DB, no THREE.

import { describe, it, expect } from "@jest/globals";
import {
  auditDelta,
  auditStacks,
  craftItems,
  moveItems,
  type ItemLocation,
  type ResolveLocation,
} from "@shared/world-engine/kernel/town/item-move.js";
import type { StockEndpoint } from "@shared/world-engine/kernel/town/transfer.js";

/** A tiny world of named stacks, standing in for the host's real maps. */
function makeWorld(init: Record<string, Record<string, number>>, caps: Record<string, number> = {}) {
  const stacks: Record<string, Record<string, number>> = {};
  for (const [id, s] of Object.entries(init)) stacks[id] = { ...s };
  const idOf = (loc: ItemLocation): string =>
    loc.kind === "container" ? loc.id
      : loc.kind === "hands" ? `hands:${loc.cid}`
      : loc.kind === "inventory" ? `bag:${loc.cid}`
      : `ground:${loc.x},${loc.y}`;
  const resolve: ResolveLocation = (loc) => {
    const id = idOf(loc);
    if (!(id in stacks)) return null;
    const ep: StockEndpoint = { id, kind: loc.kind, stack: stacks[id]! };
    if (caps[id] !== undefined) ep.capacity = caps[id];
    return ep;
  };
  const endpoints = () => Object.entries(stacks).map(([id, stack]) => ({ id, kind: "x", stack }));
  const audit = () => auditStacks(endpoints());
  return { stacks, resolve, audit };
}

const BOX: ItemLocation = { kind: "container", id: "box" };
const CHEST: ItemLocation = { kind: "container", id: "chest" };
const HANDS: ItemLocation = { kind: "hands", cid: "mara" };

describe("moveItems — the one atomic move", () => {
  it("moves what was asked, and the world total is unchanged", () => {
    const w = makeWorld({ box: { wood: 5 }, chest: {} });
    const before = w.audit();
    const r = moveItems(w.resolve, BOX, CHEST, { wood: 2 });
    expect(r.ok).toBe(true);
    expect(r.moved).toEqual({ wood: 2 });
    expect(w.stacks.box).toEqual({ wood: 3 });
    expect(w.stacks.chest).toEqual({ wood: 2 });
    expect(auditDelta(before, w.audit())).toEqual({}); // conservation
  });

  it("a SHORT source moves nothing at all — never a half-move", () => {
    const w = makeWorld({ box: { wood: 1 }, chest: {} });
    const before = w.audit();
    const r = moveItems(w.resolve, BOX, CHEST, { wood: 3 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("short");
    expect(r.missing).toEqual({ wood: 2 });
    // THE POINT: the one unit it did have stayed put. A partial move is how a
    // caller comes to believe it has materials it does not have.
    expect(w.stacks.box).toEqual({ wood: 1 });
    expect(w.stacks.chest).toEqual({});
    expect(auditDelta(before, w.audit())).toEqual({});
  });

  it("a destination at CAPACITY rolls the whole move back", () => {
    const w = makeWorld({ box: { wood: 4 }, chest: { stone: 1 } }, { chest: 2 });
    const before = w.audit();
    const r = moveItems(w.resolve, BOX, CHEST, { wood: 3 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("refused");
    expect(w.stacks.box).toEqual({ wood: 4 }); // fully restored
    expect(w.stacks.chest).toEqual({ stone: 1 }); // untouched
    expect(auditDelta(before, w.audit())).toEqual({});
  });

  it("an unresolvable endpoint touches nothing", () => {
    const w = makeWorld({ box: { wood: 2 } });
    const before = w.audit();
    const missingDest = moveItems(w.resolve, BOX, CHEST, { wood: 1 });
    expect(missingDest).toMatchObject({ ok: false, reason: "no-dest" });
    const missingSrc = moveItems(w.resolve, CHEST, BOX, { wood: 1 });
    expect(missingSrc).toMatchObject({ ok: false, reason: "no-source" });
    expect(w.stacks.box).toEqual({ wood: 2 });
    expect(auditDelta(before, w.audit())).toEqual({});
  });

  it("a move onto ITSELF is a no-op, not a round trip", () => {
    const w = makeWorld({ box: { wood: 2 } });
    const r = moveItems(w.resolve, BOX, { kind: "container", id: "box" }, { wood: 2 });
    expect(r.ok).toBe(true);
    expect(w.stacks.box).toEqual({ wood: 2 });
  });

  it("hands are a location like any other — the haul's load and unload", () => {
    // This is the shape that replaces the old `agr.carried` limbo: goods leave
    // the source INTO A CREATURE, and land from the creature into the
    // destination. At no point are they nowhere.
    const w = makeWorld({ yard: { wood: 10 }, cupboard: {}, "hands:mara": {} });
    const YARD: ItemLocation = { kind: "container", id: "yard" };
    const CUP: ItemLocation = { kind: "container", id: "cupboard" };
    const before = w.audit();

    expect(moveItems(w.resolve, YARD, HANDS, { wood: 1 }).ok).toBe(true);
    expect(w.stacks["hands:mara"]).toEqual({ wood: 1 });
    expect(auditDelta(before, w.audit())).toEqual({});

    // …and if the errand DIES here, the wood is still on Mara. It is not gone.
    expect(auditStacks([w.resolve(HANDS)])).toEqual({ wood: 1 });

    expect(moveItems(w.resolve, HANDS, CUP, { wood: 1 }).ok).toBe(true);
    expect(w.stacks["hands:mara"]).toEqual({});
    expect(w.stacks.cupboard).toEqual({ wood: 1 });
    expect(auditDelta(before, w.audit())).toEqual({});
  });

  it("conservation holds across a long random sequence of moves", () => {
    const w = makeWorld({
      a: { wood: 7, stone: 3 }, b: { wood: 2 }, c: {}, "hands:mara": {}, "bag:mara": {},
    });
    const before = w.audit();
    const places: ItemLocation[] = [
      { kind: "container", id: "a" }, { kind: "container", id: "b" },
      { kind: "container", id: "c" }, { kind: "hands", cid: "mara" },
      { kind: "inventory", cid: "mara" },
    ];
    // Deterministic pseudo-random walk (no Math.random — reproducible failures).
    let seed = 12345;
    const next = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let i = 0; i < 400; i++) {
      const from = places[next(places.length)]!;
      const to = places[next(places.length)]!;
      const glyph = next(2) ? "wood" : "stone";
      moveItems(w.resolve, from, to, { [glyph]: 1 + next(3) });
      // The invariant must hold after EVERY step, not just at the end.
      expect(auditDelta(before, w.audit())).toEqual({});
    }
  });
});

describe("craftItems — inputs and output in one transaction", () => {
  it("consumes the bill and produces the product together", () => {
    const w = makeWorld({ box: { wood: 3 } });
    const r = craftItems(w.resolve, BOX, { wood: 1 }, "blocks.material_wood");
    expect(r.ok).toBe(true);
    expect(w.stacks.box).toEqual({ wood: 2, "blocks.material_wood": 1 });
  });

  it("a short bill consumes NOTHING — never eats materials and produce nothing", () => {
    const w = makeWorld({ box: { wood: 0, stone: 5 } });
    const before = w.audit();
    const r = craftItems(w.resolve, BOX, { wood: 2 }, "blocks.material_wood");
    expect(r).toMatchObject({ ok: false, reason: "short" });
    expect(w.stacks.box["blocks.material_wood"]).toBeUndefined();
    expect(auditDelta(before, w.audit())).toEqual({});
  });

  it("no room for the product puts every ingredient back", () => {
    // A full spot: the craft cannot land, so it must not have happened.
    const w = makeWorld({ box: { wood: 2 } }, { box: 2 });
    const r = craftItems(w.resolve, BOX, { wood: 2 }, "blocks.material_wood", 3);
    expect(r).toMatchObject({ ok: false, reason: "refused" });
    expect(w.stacks.box).toEqual({ wood: 2 });
  });

  it("an unresolvable spot is a clean refusal", () => {
    const w = makeWorld({ box: { wood: 2 } });
    expect(craftItems(w.resolve, CHEST, { wood: 1 }, "x")).toMatchObject({
      ok: false, reason: "no-source",
    });
  });
});

describe("auditStacks / auditDelta — the conservation ratchet", () => {
  it("totals by HEAD, so a facet change is not read as a leak", () => {
    const w = makeWorld({ box: { "shirt.color_red": 2, "shirt.color_red.dirty": 1 } });
    expect(w.audit()).toEqual({ shirt: 3 });
  });

  it("names exactly what appeared or vanished", () => {
    const before = { wood: 5, stone: 2 };
    const after = { wood: 4, stone: 2, cloth: 1 };
    expect(auditDelta(before, after)).toEqual({ wood: -1, cloth: 1 });
  });
});
