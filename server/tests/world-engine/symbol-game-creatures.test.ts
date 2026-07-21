// Need-based creature rules + dialogue projection tests
// (planning-docs/symbol-learning-game/creature-needs.md, puzzle-mode scope).
//
// The §8 archetypes must EMERGE from the rules — giver, rental (lend) vendor,
// exchange vendor — and the doc's invariants must hold: retention (bound items
// never re-granted), debt conservation (give/take round-trips are neutral),
// monotone knowledge, and menus that always match what the player can see.
//
// Pure logic — no DB / LLM / GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import {
  claimItem,
  concludeTransfer,
  createCreatureWorld,
  giveItem,
  knownHoldings,
  putDownItem,
  requestItem,
  seeItem,
  valueTo,
  projectDialogue,
  selectAct,
  type ConversationMemo,
  type CreatureWorld,
} from "@shared/world-engine/interaction/index.js";

const PLAYER = "player";
const sym = (id: string) => id.replace(/_\d+$/, ""); // "cookie_1" → "cookie"
const OPTS = { symbolOf: sym };

describe("creature rules — invariants", () => {
  function giverWorld(): CreatureWorld {
    return createCreatureWorld(
      [
        { id: PLAYER },
        { id: "bear", needs: [{ itemId: "cookie_1", value: 3 }] },
      ],
      [{ id: "cookie_1", ownerId: PLAYER }],
    );
  }

  it("fulfilling a need binds the item and creates the debt (retention)", () => {
    const world = giverWorld();
    const res = giveItem(world, PLAYER, "bear", "cookie_1");
    expect(res.accepted).toBe(true);
    expect(res.events.some((e) => e.type === "need-fulfilled")).toBe(true);
    expect(world.creatures.bear!.debts[PLAYER]).toBe(3);
    expect(world.items.cookie_1!.bound).toBe(true);
    // The debt covers the value, but bound items are NEVER granted back.
    expect(requestItem(world, PLAYER, "bear", "cookie_1")).toEqual({ kind: "decline" });
  });

  it("a creature politely declines items it neither likes nor needs", () => {
    const world = createCreatureWorld(
      [{ id: PLAYER }, { id: "bear" }],
      [{ id: "sock_1", ownerId: PLAYER }],
    );
    const res = giveItem(world, PLAYER, "bear", "sock_1");
    expect(res.accepted).toBe(false);
    expect(world.items.sock_1!.ownerId).toBe(PLAYER);
  });

  it("give/take round-trips are debt-neutral (conservation)", () => {
    const world = createCreatureWorld(
      [{ id: PLAYER }, { id: "rabbit", likes: ["ball_1"], debts: { [PLAYER]: 1 } }],
      [{ id: "ball_1", ownerId: "rabbit", displayed: true }],
    );
    seeItem(world, PLAYER, "ball_1", { kind: "held", by: "rabbit" });
    // Borrow (settles the debt), return (recreates it) — twice; no inflation.
    for (let i = 0; i < 2; i++) {
      const out = requestItem(world, PLAYER, "rabbit", "ball_1");
      expect(out.kind).toBe("accept"); // agreement — ownership moves on TAKE
      concludeTransfer(world, PLAYER, "ball_1");
      expect(world.creatures.rabbit!.debts[PLAYER]).toBe(0);
      const back = giveItem(world, PLAYER, "rabbit", "ball_1");
      expect(back.accepted).toBe(true);
      expect(world.creatures.rabbit!.debts[PLAYER]).toBe(1);
    }
  });

  it("provenance: taking a put-down wanted item counts as a gift from the placer", () => {
    const world = createCreatureWorld(
      [{ id: PLAYER }, { id: "frog", needs: [{ itemId: "apple_1", value: 2 }] }],
      [{ id: "apple_1", ownerId: PLAYER }],
    );
    putDownItem(world, PLAYER, "apple_1");
    expect(world.items.apple_1!.ownerId).toBeNull();
    const res = claimItem(world, "frog", "apple_1");
    expect(res.accepted).toBe(true);
    expect(world.creatures.frog!.debts[PLAYER]).toBe(2);
    expect(world.items.apple_1!.bound).toBe(true);
  });
});

describe("creature rules — the §8 archetypes emerge", () => {
  it("rental vendor: borrow one; the second demands the first back; return unlocks it", () => {
    const world = createCreatureWorld(
      [
        { id: PLAYER },
        { id: "rabbit", likes: ["ball_1", "train_1"], debts: { [PLAYER]: 1 } },
      ],
      [
        { id: "ball_1", ownerId: "rabbit", displayed: true },
        { id: "train_1", ownerId: "rabbit", displayed: true },
      ],
    );
    seeItem(world, PLAYER, "ball_1", { kind: "held", by: "rabbit" });
    seeItem(world, PLAYER, "train_1", { kind: "held", by: "rabbit" });

    // Borrow the ball (initial debt covers exactly one item).
    expect(requestItem(world, PLAYER, "rabbit", "ball_1").kind).toBe("accept");
    concludeTransfer(world, PLAYER, "ball_1");
    // Ask for the train — the vendor wants the ball BACK first.
    const second = requestItem(world, PLAYER, "rabbit", "train_1");
    expect(second).toEqual({ kind: "price", price: { kind: "return", itemId: "ball_1" } });
    // Return the ball → debt restored → the train grants.
    expect(giveItem(world, PLAYER, "rabbit", "ball_1").accepted).toBe(true);
    expect(requestItem(world, PLAYER, "rabbit", "train_1").kind).toBe("accept");
    concludeTransfer(world, PLAYER, "train_1");
    expect(world.items.train_1!.ownerId).toBe(PLAYER);
  });

  it("exchange vendor: request states the price (its need); paying unlocks the grant", () => {
    const world = createCreatureWorld(
      [
        { id: PLAYER },
        { id: "frog", needs: [{ itemId: "apple_1", value: 3 }] },
      ],
      [
        { id: "cookie_1", ownerId: "frog", displayed: true },
        { id: "apple_1", ownerId: PLAYER },
      ],
    );
    seeItem(world, PLAYER, "cookie_1", { kind: "held", by: "frog" });

    const ask = requestItem(world, PLAYER, "frog", "cookie_1");
    expect(ask).toEqual({ kind: "price", price: { kind: "need", itemId: "apple_1" } });
    expect(giveItem(world, PLAYER, "frog", "apple_1").accepted).toBe(true);
    expect(world.creatures.frog!.debts[PLAYER]).toBe(3);
    expect(requestItem(world, PLAYER, "frog", "cookie_1").kind).toBe("accept");
    concludeTransfer(world, PLAYER, "cookie_1");
    expect(world.items.cookie_1!.ownerId).toBe(PLAYER);
    // The pay item is bound — no getting it back.
    expect(requestItem(world, PLAYER, "frog", "apple_1")).toEqual({ kind: "decline" });
  });
});

describe("dialogue projection", () => {
  it("vendor menu offers requests for exactly the known/visible stock (the menu bug, fixed)", () => {
    const world = createCreatureWorld(
      [
        { id: PLAYER },
        { id: "rabbit", likes: ["ball_1", "train_1"], debts: { [PLAYER]: 1 } },
      ],
      [
        { id: "ball_1", ownerId: "rabbit", displayed: true },
        { id: "train_1", ownerId: "rabbit", displayed: true },
      ],
    );
    // Player has seen only the ball so far.
    seeItem(world, PLAYER, "ball_1", { kind: "held", by: "rabbit" });
    let proj = projectDialogue(world, "rabbit", PLAYER, "b", OPTS);
    let requests = proj.acts.filter((a) => a.kind === "request").map((a) => a.itemId);
    expect(requests).toEqual(["ball_1"]);

    // Seeing the train adds it — BOTH visible items are requestable, always.
    seeItem(world, PLAYER, "train_1", { kind: "held", by: "rabbit" });
    proj = projectDialogue(world, "rabbit", PLAYER, "b", OPTS);
    requests = proj.acts.filter((a) => a.kind === "request").map((a) => a.itemId);
    expect(requests).toEqual(["ball_1", "train_1"]);
    // The standing social acts are always on the board.
    expect(proj.acts.map((a) => a.kind)).toEqual(
      expect.arrayContaining(["how-are-you", "confused", "bye"]),
    );
  });

  it("giver line: states its want, switches to 'give me' when you hold the item", () => {
    const world = createCreatureWorld(
      [{ id: PLAYER }, { id: "bear", needs: [{ itemId: "cookie_1", value: 3 }] }],
      [{ id: "cookie_1" }],
    );
    expect(projectDialogue(world, "bear", PLAYER, "b", OPTS).lineGlyph).toBe("want + cookie");
    claimItem(world, PLAYER, "cookie_1", { takerAcceptsAnything: true });
    expect(projectDialogue(world, "bear", PLAYER, "b", OPTS).lineGlyph).toBe("give + cookie");
    // The wanted offer leads the board.
    const proj = projectDialogue(world, "bear", PLAYER, "b", OPTS);
    expect(proj.acts[0]).toMatchObject({ kind: "offer", itemId: "cookie_1" });
  });

  it("announce-after trader greets neutrally; the request elicits and pins the price", () => {
    const world = createCreatureWorld(
      [{ id: PLAYER }, { id: "frog", needs: [{ itemId: "apple_1", value: 3 }] }],
      [
        { id: "cookie_1", ownerId: "frog", displayed: true },
        { id: "apple_1", ownerId: PLAYER },
      ],
    );
    seeItem(world, PLAYER, "cookie_1", { kind: "held", by: "frog" });
    const opts = { ...OPTS, announce: "after" as const };

    let memo: ConversationMemo = {};
    expect(projectDialogue(world, "frog", PLAYER, "b", opts, memo).lineGlyph).toBe("want + thing#question");
    const req = projectDialogue(world, "frog", PLAYER, "b", opts, memo).acts.find(
      (a) => a.kind === "request",
    )!;
    memo = selectAct(world, "frog", PLAYER, req, "b", opts, memo).memo;
    expect(memo.statedPrice).toEqual({ kind: "need", itemId: "apple_1" });
    expect(projectDialogue(world, "frog", PLAYER, "b", opts, memo).lineGlyph).toBe("want + apple");

    // Pay → the trader settles its OBLIGATION unprompted: it knows the player
    // asked for the cookie, the debt now covers it, so it hands it over — no
    // second ask needed (the ask→price→pay→give loop).
    const offer = projectDialogue(world, "frog", PLAYER, "b", opts, memo).acts.find(
      (a) => a.kind === "offer" && a.itemId === "apple_1",
    )!;
    const paid = selectAct(world, "frog", PLAYER, offer, "b", opts, memo);
    expect(paid.responseGlyph).toBe("thank_you");
    memo = paid.memo;
    expect(memo.statedPrice).toBeUndefined();
    expect(
      paid.events.some((e) => e.type === "transfer-pending" && e.itemId === "cookie_1" && e.to === PLAYER),
    ).toBe(true);
    // The debt clears when the player TAKES it (concludeTransfer = the take).
    concludeTransfer(world, PLAYER, "cookie_1");
    expect(world.items.cookie_1!.ownerId).toBe(PLAYER);
    expect(world.creatures.frog!.debts[PLAYER]).toBe(2); // 3 paid − 1 item value
  });

  it("does NOT give unprompted without a recorded want (no asking, no giving)", () => {
    const world = createCreatureWorld(
      [{ id: PLAYER }, { id: "frog", needs: [{ itemId: "apple_1", value: 3 }] }],
      [
        { id: "cookie_1", ownerId: "frog", displayed: true },
        { id: "apple_1", ownerId: PLAYER },
      ],
    );
    seeItem(world, PLAYER, "cookie_1", { kind: "held", by: "frog" });
    // Pay WITHOUT ever asking for the cookie: the frog is grateful (debt) but
    // has no idea the player wants the cookie — nothing transfers.
    const proj = projectDialogue(world, "frog", PLAYER, "b", OPTS);
    const offer = proj.acts.find((a) => a.kind === "offer" && a.itemId === "apple_1")!;
    const res = selectAct(world, "frog", PLAYER, offer, "b", OPTS);
    expect(res.events.some((e) => e.type === "transfer-pending" && e.itemId === "cookie_1")).toBe(false);
    expect(world.items.cookie_1!.ownerId).toBe("frog");
    // Asking NOW grants immediately — the debt already covers it.
    const req = projectDialogue(world, "frog", PLAYER, "b", OPTS).acts.find(
      (a) => a.kind === "request" && a.itemId === "cookie_1",
    )!;
    const granted = selectAct(world, "frog", PLAYER, req, "b", OPTS);
    expect(granted.events.some((e) => e.type === "transfer-pending" && e.itemId === "cookie_1")).toBe(true);
  });

  it("bound possessions stay ASKABLE — the creature refuses with 'mine'", () => {
    const world = createCreatureWorld(
      [{ id: PLAYER }, { id: "bear", needs: [{ itemId: "cookie_1", value: 3 }] }],
      [{ id: "cookie_1", ownerId: PLAYER }],
    );
    giveItem(world, PLAYER, "bear", "cookie_1"); // fulfills + binds
    const proj = projectDialogue(world, "bear", PLAYER, "b", OPTS);
    const req = proj.acts.find((a) => a.kind === "request" && a.itemId === "cookie_1")!;
    expect(req).toBeDefined(); // asking is always possible…
    const res = selectAct(world, "bear", PLAYER, req, "b", OPTS);
    expect(res.responseGlyph).toBe("no + cookie.my"); // …but it may refuse: "no — my cookie"
    expect(world.items.cookie_1!.ownerId).toBe("bear");
  });

  it("state 1 shape: not holding the need → agree/cant/refuse/where-is, no offer", () => {
    const world = createCreatureWorld(
      [{ id: PLAYER }, { id: "bear", needs: [{ itemId: "cookie_1", value: 3 }] }],
      [{ id: "cookie_1", ownerId: PLAYER }, { id: "ball_1", ownerId: PLAYER }],
    );
    const proj = projectDialogue(world, "bear", PLAYER, "b", {
      ...OPTS,
      offerFilter: (id) => id === "ball_1", // the cookie is NOT in hand
    });
    const kinds = proj.acts.map((a) => a.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["agree", "cant", "refuse", "where-is", "confused", "bye"]),
    );
    expect(kinds).not.toContain("offer");
    // Refusing makes the bear sad; saying you can't gets a calm parting —
    // "ok" is RESERVED for confirming an accepted order (phase ①a §1).
    const refuse = proj.acts.find((a) => a.kind === "refuse")!;
    expect(selectAct(world, "bear", PLAYER, refuse, "b", OPTS).responseGlyph).toBe("i_me + sad");
    const cant = proj.acts.find((a) => a.kind === "cant")!;
    expect(selectAct(world, "bear", PLAYER, cant, "b", OPTS).responseGlyph).toBe("goodbye");
  });

  it("unwanted offers get a gentle decline, never a fail state", () => {
    // Gift offers live in STATE 2 (no visible need) per dialogue-states.md.
    const world = createCreatureWorld(
      [{ id: PLAYER }, { id: "bear" }],
      [{ id: "sock_1", ownerId: PLAYER }, { id: "cookie_1" }],
    );
    const proj = projectDialogue(world, "bear", PLAYER, "b", OPTS);
    const offer = proj.acts.find((a) => a.kind === "offer" && a.itemId === "sock_1")!;
    const res = selectAct(world, "bear", PLAYER, offer, "b", OPTS);
    expect(res.responseGlyph).toBe("want.not + sock");
    expect(world.items.sock_1!.ownerId).toBe(PLAYER);
  });
});
