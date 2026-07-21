// The generosity gate (willingness.ts): will a creature part with an item it holds?
// One shared, pure decision — give / redirect / decline — weighted by ownership, the
// debt ledger, and who the asker is. The WANT-side mirror of compliance. Pure — safe
// in the default `npm test`.

import { describe, it, expect } from "@jest/globals";
import { createCreatureWorld } from "@shared/world-engine/interaction/behavior/creatures.js";
import { makeRelation } from "@shared/world-engine/interaction/behavior/relations.js";
import { personalityFromPreset, makePersonality } from "@shared/world-engine/interaction/behavior/personality.js";
import {
  generosity,
  hasSurplus,
  willingnessToGive,
} from "@shared/world-engine/interaction/behavior/willingness.js";

// A world where `owner` holds `apple1` (value 3), the requester is "fox".
function world(over: { bound?: boolean; value?: number; ownerNeeds?: boolean; extra?: number } = {}) {
  const items = [{ id: "apple1", ownerId: "owner", kind: "apple", category: "food" }];
  for (let i = 0; i < (over.extra ?? 0); i++) items.push({ id: `apple${i + 2}`, ownerId: "owner", kind: "apple", category: "food" });
  const w = createCreatureWorld(
    [
      { id: "owner", needs: over.ownerNeeds ? [{ itemId: "apple1", value: 3, target: { category: "food" } }] : [] },
      { id: "fox" },
    ],
    items,
  );
  const apple = w.items.apple1!;
  apple.value = over.value ?? 3;
  apple.bound = over.bound ?? false;
  return w;
}

const stranger = { relation: makeRelation({ affinity: 0, trust: 0.3, authority: 0 }), personality: makePersonality() };

describe("willingnessToGive — the generosity gate (§4b)", () => {
  it("GIVES when a covering DEBT exists (settlement is consent — the existing rule)", () => {
    const w = world();
    w.creatures.owner!.debts.fox = 5; // owes fox ≥ the apple's value (3)
    expect(willingnessToGive(w.creatures.owner!, w.items.apple1!, "fox", w, stranger)).toEqual({
      kind: "give",
      reason: "debt",
    });
  });

  it("GIVES FREELY to a liked asker when warm (affinity path, no debt)", () => {
    const w = world();
    const res = willingnessToGive(w.creatures.owner!, w.items.apple1!, "fox", w, {
      personality: personalityFromPreset("companion"), // warm
      relation: makeRelation({ affinity: 0.8 }), // a friend
    });
    expect(res).toEqual({ kind: "give", reason: "affinity" });
  });

  it("a NEUTRAL STRANGER is not gifted freely — withholds", () => {
    const w = world();
    expect(willingnessToGive(w.creatures.owner!, w.items.apple1!, "fox", w, stranger).kind).not.toBe("give");
  });

  it("GIVES from SURPLUS — owns more of the sort than it needs", () => {
    const w = world({ extra: 2 }); // owns 3 apples, needs none
    expect(willingnessToGive(w.creatures.owner!, w.items.apple1!, "fox", w, stranger)).toEqual({
      kind: "give",
      reason: "surplus",
    });
  });

  it("keeps what it NEEDS itself (no surplus, no debt) — withholds own-need", () => {
    const w = world({ ownerNeeds: true }); // its one apple satisfies its own hunger
    const res = willingnessToGive(w.creatures.owner!, w.items.apple1!, "fox", w, stranger);
    expect(res).toEqual({ kind: "decline", reason: "own-need" });
  });

  it("a BOUND keepsake is never given", () => {
    const w = world({ bound: true });
    // Even a beloved friend can't have the bound item.
    const res = willingnessToGive(w.creatures.owner!, w.items.apple1!, "fox", w, {
      personality: personalityFromPreset("companion"),
      relation: makeRelation({ affinity: 1 }),
    });
    expect(res).toEqual({ kind: "decline", reason: "bound" });
  });

  it("a withholding becomes a REDIRECT when a source is known (buy it at the market)", () => {
    const w = world();
    expect(willingnessToGive(w.creatures.owner!, w.items.apple1!, "fox", w, { ...stranger, knowsSource: true })).toEqual({
      kind: "redirect",
    });
    // Bound + a known source also redirects rather than a dead "no".
    const wb = world({ bound: true });
    expect(willingnessToGive(wb.creatures.owner!, wb.items.apple1!, "fox", wb, { knowsSource: true }).kind).toBe("redirect");
  });
});

describe("generosity + hasSurplus — the components", () => {
  it("generosity rises with warmth and affinity; a warm friend clears the free-gift bar", () => {
    const cold = generosity(makePersonality({ warmth: 0.1 }), makeRelation({ affinity: -0.5 }));
    const warm = generosity(personalityFromPreset("companion"), makeRelation({ affinity: 0.8 }));
    expect(warm).toBeGreaterThan(cold);
    expect(warm).toBeGreaterThanOrEqual(0.7);
    expect(cold).toBeLessThan(0.7);
  });

  it("hasSurplus needs a genuine SPARE — you keep at least one for yourself", () => {
    const one = world();
    expect(hasSurplus(one.creatures.owner!, one.items.apple1!, one)).toBe(false); // owns 1 → keeps it
    const needed = world({ ownerNeeds: true });
    expect(hasSurplus(needed.creatures.owner!, needed.items.apple1!, needed)).toBe(false); // owns 1, needs 1
    const spare = world({ extra: 1 });
    expect(hasSurplus(spare.creatures.owner!, spare.items.apple1!, spare)).toBe(true); // owns 2, needs 0 → 1 spare
    const plenty = world({ extra: 2, ownerNeeds: true });
    expect(hasSurplus(plenty.creatures.owner!, plenty.items.apple1!, plenty)).toBe(true); // owns 3, needs 1
  });
});
