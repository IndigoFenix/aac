// The §4b generosity gate WIRED into the dialogue request path (selectAct), requests
// by resource TYPE (§2b transfer(type) under WANT), the provides(place,type) provision
// fact, and the where-is unification (§2b query(type) fallback chain: instance →
// provider → don't-know). Pure — safe in the default `npm test`.

import { describe, it, expect } from "@jest/globals";
import {
  createCreatureWorld,
  knownProvider,
  learnProvides,
  providesKey,
  seeItem,
} from "@shared/world-engine/interaction/behavior/creatures.js";
import { makeRelation } from "@shared/world-engine/interaction/behavior/relations.js";
import { personalityFromPreset } from "@shared/world-engine/interaction/behavior/personality.js";
import { selectAct, type ProjectionOpts } from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";
import { askWhereType, intentToAct } from "@shared/world-engine/interaction/dialogue/creature-converse.js";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";

const opts = (world: ReturnType<typeof createCreatureWorld>): ProjectionOpts => ({
  symbolOf: (id) => world.items[id]?.kind ?? id,
});

describe("the request path runs the generosity gate (§4b wired)", () => {
  it("a covering DEBT still accepts (the requestItem foundation is untouched)", () => {
    const w = createCreatureWorld(
      [{ id: "owner", debts: { me: 5 } }, { id: "me" }],
      [{ id: "sock1", ownerId: "owner", kind: "sock" }],
    );
    const res = selectAct(w, "owner", "me", { kind: "request", itemId: "sock1", glyph: "" }, "b", opts(w));
    expect(res.responseGlyph).toBe("yes");
    expect(w.items.sock1!.pendingTransferTo).toBe("me");
  });

  it("a WARM owner gifts a LIKED asker outright (affinity give, no debt)", () => {
    const w = createCreatureWorld([{ id: "owner" }, { id: "me" }], [{ id: "sock1", ownerId: "owner", kind: "sock" }]);
    const o: ProjectionOpts = {
      ...opts(w),
      relationOf: () => makeRelation({ affinity: 0.8 }),
      personalityOf: () => personalityFromPreset("companion"),
    };
    const res = selectAct(w, "owner", "me", { kind: "request", itemId: "sock1", glyph: "" }, "b", o);
    expect(res.responseGlyph).toBe("yes");
    expect(w.items.sock1!.pendingTransferTo).toBe("me");
  });

  it("a NEUTRAL STRANGER is refused honestly — give.not, never a false have.not", () => {
    const w = createCreatureWorld([{ id: "owner" }, { id: "me" }], [{ id: "sock1", ownerId: "owner", kind: "sock" }]);
    const res = selectAct(w, "owner", "me", { kind: "request", itemId: "sock1", glyph: "" }, "b", opts(w));
    expect(res.responseGlyph).toContain("give.not");
    expect(w.items.sock1!.pendingTransferTo).toBeNull();
    expect(w.items.sock1!.ownerId).toBe("owner");
  });

  it("a BOUND keepsake still answers 'my X' (regression)", () => {
    const w = createCreatureWorld(
      [{ id: "owner" }, { id: "me" }],
      [{ id: "sock1", ownerId: "owner", kind: "sock", bound: true }],
    );
    const res = selectAct(w, "owner", "me", { kind: "request", itemId: "sock1", glyph: "" }, "b", opts(w));
    expect(res.responseGlyph).toContain(".my");
  });

  it("an owner that NEEDS the asked thing states its want (the price counter), never grants", () => {
    const w = createCreatureWorld(
      [{ id: "owner", needs: [{ itemId: "sock1", value: 3, target: { category: "clothes" } }] }, { id: "me" }],
      [{ id: "sock1", ownerId: "owner", kind: "sock", category: "clothes" }],
    );
    const res = selectAct(w, "owner", "me", { kind: "request", itemId: "sock1", glyph: "" }, "b", opts(w));
    expect(res.memo.statedPrice).toBeDefined();
    expect(w.items.sock1!.pendingTransferTo).toBeNull();
  });

  it("COMMERCE beats charity: a vendor with an open need TRADES its spare, not gifts it", () => {
    // Owner has 2 apples (a genuine spare) but also wants a sock — the stated price
    // (trade counter) wins over the surplus gift, keeping stock a lesson.
    const w = createCreatureWorld(
      [{ id: "owner", needs: [{ itemId: "sock1", value: 3 }] }, { id: "me" }],
      [
        { id: "apple1", ownerId: "owner", kind: "apple", category: "food" },
        { id: "apple2", ownerId: "owner", kind: "apple", category: "food" },
        { id: "sock1", ownerId: "me", kind: "sock" },
      ],
    );
    const res = selectAct(w, "owner", "me", { kind: "request", itemId: "apple1", glyph: "" }, "b", opts(w));
    expect(res.memo.statedPrice).toEqual({ kind: "need", itemId: "sock1" });
    expect(w.items.apple1!.pendingTransferTo).toBeNull();
  });

  it("with NOTHING to ask in return, a SPARE is simply given (surplus)", () => {
    const w = createCreatureWorld(
      [{ id: "owner" }, { id: "me" }],
      [
        { id: "apple1", ownerId: "owner", kind: "apple", category: "food" },
        { id: "apple2", ownerId: "owner", kind: "apple", category: "food" },
      ],
    );
    const res = selectAct(w, "owner", "me", { kind: "request", itemId: "apple1", glyph: "" }, "b", opts(w));
    expect(res.responseGlyph).toBe("yes");
    expect(w.items.apple1!.pendingTransferTo).toBe("me");
  });

  it("an unwilling owner that KNOWS a provider REDIRECTS instead of a bare no", () => {
    const w = createCreatureWorld([{ id: "owner" }, { id: "me" }], [{ id: "apple1", ownerId: "owner", kind: "apple", category: "food" }]);
    learnProvides(w, "owner", "food", "buy:good:food");
    const res = selectAct(w, "owner", "me", { kind: "request", itemId: "apple1", glyph: "" }, "b", opts(w));
    expect(res.askedDirections).toBe("buy:good:food");
    expect(w.items.apple1!.ownerId).toBe("owner");
  });
});

describe("requests by resource TYPE (§2b transfer(type) under WANT)", () => {
  it("'i_me want food' maps to a TYPE request when the listener holds no 'food' kind", () => {
    const w = createCreatureWorld(
      [{ id: "me" }, { id: "owner" }],
      [{ id: "apple1", ownerId: "owner", kind: "apple", category: "food" }],
    );
    const act = intentToAct(parseSentence("i_me + want + food"), w, "me", "owner", opts(w))!;
    expect(act.kind).toBe("request");
    expect(act.itemId).toBeUndefined();
    expect(act.target).toEqual({ category: "food" });
  });

  it("the type resolves against the owner's OWN items — a spare instance is granted", () => {
    const w = createCreatureWorld(
      [{ id: "owner" }, { id: "me" }],
      [
        { id: "apple1", ownerId: "owner", kind: "apple", category: "food" },
        { id: "apple2", ownerId: "owner", kind: "apple", category: "food" },
      ],
    );
    const res = selectAct(w, "owner", "me", { kind: "request", target: { category: "food" }, glyph: "" }, "b", opts(w));
    expect(res.responseGlyph).toBe("yes");
    expect(w.items.apple1!.pendingTransferTo).toBe("me");
  });

  it("owner has NONE but knows a provider → redirect ('buy it at the market')", () => {
    const w = createCreatureWorld([{ id: "owner" }, { id: "me" }], []);
    learnProvides(w, "owner", "food", "buy:good:food");
    const act = intentToAct(parseSentence("i_me + want + food"), w, "me", "owner", opts(w))!;
    expect(act.target).toEqual({ category: "food" }); // the provider fact makes 'food' a known sort
    const res = selectAct(w, "owner", "me", act, "b", opts(w));
    expect(res.askedDirections).toBe("buy:good:food");
  });

  it("owner has NONE and knows no provider → the honest have-not", () => {
    const w = createCreatureWorld(
      [{ id: "owner" }, { id: "me" }],
      [{ id: "apple1", kind: "apple", category: "food" }], // loose, unowned — just makes 'food' a sort
    );
    const res = selectAct(w, "owner", "me", { kind: "request", target: { category: "food" }, glyph: "" }, "b", opts(w));
    expect(res.responseGlyph).toContain("have.not");
    expect(res.responseGlyph).toContain("food");
  });
});

describe("where-is unification (§2b query(type): instance → provider → don't-know)", () => {
  it("'where food' maps to a TYPE where-is when no instance of the kind exists", () => {
    const w = createCreatureWorld(
      [{ id: "me" }, { id: "bear" }],
      [{ id: "apple1", ownerId: "fox", kind: "apple", category: "food" }],
    );
    const act = intentToAct(parseSentence("where + food"), w, "me", "bear", opts(w))!;
    expect(act.kind).toBe("where-is");
    expect(act.itemId).toBeUndefined();
    expect(act.target).toEqual({ category: "food" });
  });

  it("a KNOWN matching instance answers with its location clue", () => {
    const w = createCreatureWorld(
      [{ id: "bear" }, { id: "me" }],
      [{ id: "apple1", ownerId: "fox", kind: "apple", category: "food" }],
    );
    seeItem(w, "bear", "apple1", { kind: "held", by: "fox" });
    const res = selectAct(w, "bear", "me", { kind: "where-is", target: { category: "food" }, glyph: "" }, "c", opts(w));
    expect(res.responseGlyph).toContain("have");
    expect(res.responseGlyph).toContain("apple");
  });

  it("no instance but a PROVIDES fact → directions to the source", () => {
    const w = createCreatureWorld([{ id: "bear" }, { id: "me" }], []);
    learnProvides(w, "bear", "food", "buy:good:food");
    const res = selectAct(w, "bear", "me", { kind: "where-is", target: { category: "food" }, glyph: "" }, "b", opts(w));
    expect(res.askedDirections).toBe("buy:good:food");
  });

  it("neither → the honest not-knowing", () => {
    const w = createCreatureWorld([{ id: "bear" }, { id: "me" }], []);
    const res = selectAct(w, "bear", "me", { kind: "where-is", target: { category: "food" }, glyph: "" }, "b", opts(w));
    expect(res.responseGlyph).toContain("think.not");
  });

  it("askWhereType SPREADS the provision fact — asking teaches the source (gossip)", () => {
    const w = createCreatureWorld([{ id: "fox" }, { id: "bear" }], []);
    learnProvides(w, "bear", "food", "buy:good:food");
    expect(knownProvider(w.creatures.fox!, ["food"])).toBeUndefined();
    const ans = askWhereType(w, "fox", "bear", { category: "food" }, "b", opts(w));
    expect(ans.askedDirections).toBe("buy:good:food");
    expect(ans.learned).toBe(true);
    expect(knownProvider(w.creatures.fox!, ["food"])).toBe("buy:good:food"); // fox can now redirect others
    // Asking again teaches nothing new (monotone).
    expect(askWhereType(w, "fox", "bear", { category: "food" }, "b", opts(w)).learned).toBe(false);
  });
});

describe("provides — one monotone fact channel", () => {
  it("learning the same provider twice is a no-op; a NEW place is news", () => {
    const w = createCreatureWorld([{ id: "res" }], []);
    expect(learnProvides(w, "res", "food", "buy:good:food")).toHaveLength(1);
    expect(learnProvides(w, "res", "food", "buy:good:food")).toHaveLength(0);
    expect(learnProvides(w, "res", "food", "buy:good:fish")).toHaveLength(1);
    expect(w.creatures.res!.knowledge[providesKey("food")]).toEqual({ kind: "provided", place: "buy:good:fish" });
  });

  it("provider lookup prefers the want's KIND key over its CATEGORY key", () => {
    const w = createCreatureWorld([{ id: "res" }], []);
    learnProvides(w, "res", "food", "buy:good:food");
    learnProvides(w, "res", "apple", "buy:good:apple");
    expect(knownProvider(w.creatures.res!, ["apple", "food"])).toBe("buy:good:apple");
    expect(knownProvider(w.creatures.res!, [undefined, "food"])).toBe("buy:good:food");
  });
});
