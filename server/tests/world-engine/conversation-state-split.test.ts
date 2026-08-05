// THE STATE SPLIT — the dialogue layer honoring who owns which fact.
//
// The old `ConversationMemo` bundled four fields into one object handed from
// caller to caller, and every multi-party bug in the conversation layer came out
// of that bundle: one player's open pick-list was the same object as another's,
// a price quoted to one asker was the same field the next asker read, and a need
// coaxed out by small talk was private to whoever happened to hold the memo.
// They now split three ways (multi-entity-conversations.md §3a):
//
//   • `DialogueCtx.ui`   — THIS DEVICE's board navigation. Never shared.
//   • `convo.revealed`   — said out loud, so everyone present heard it (law 4).
//   • `convo.pairs`      — quoted to a SPECIFIC asker (§6: a quote to Ann is not
//                          honored for Ben).
//
// These tests pin the split at the seam where it can actually be violated: two
// devices in ONE conversation. Pure — no host, no DB, no GL.

import { describe, it, expect } from "@jest/globals";
import {
  createCreatureWorld,
  projectDialogue,
  selectAct,
  type DeviceBoardState,
  type DialogueAct,
  type ProjectionOpts,
} from "@shared/world-engine/interaction/index.js";
import {
  createConversation,
  joinConversation,
  pairMemo,
  type ConversationState,
} from "@shared/world-engine/interaction/dialogue/conversation.js";

const sym = (id: string) => id.replace(/_\d+$/, ""); // "cookie_1" → "cookie"

/** Ann and Ben, both talking to one shopkeeper. */
const ANN = "player";
const BEN = "player:ben";
const NPC = "npc";

function twoPlayerConvo(): ConversationState {
  const c = createConversation(NPC, 0);
  joinConversation(c, NPC, 0, "b");
  joinConversation(c, ANN, 0, "b");
  joinConversation(c, BEN, 0, "b");
  return c;
}

// ---------------------------------------------------------------------------
// ui — per device
// ---------------------------------------------------------------------------

describe("board navigation is PER DEVICE — two boards, one conversation", () => {
  // Seven places to ask about: a page holds 5 (maxActs 8 − more/back/confused),
  // so there is a page 0 and a page 1 to sit on independently.
  const subjects = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, glyph: "home" }));
  const opts: ProjectionOpts = { symbolOf: sym, askDirections: subjects };
  const world = () => createCreatureWorld([{ id: ANN }, { id: BEN }, { id: NPC }], []);
  const open: DialogueAct = { kind: "directions-menu", glyph: "place#question" };
  const more: DialogueAct = { kind: "more", glyph: "more" };

  it("two devices page the same menu independently — neither clobbers the other", () => {
    const w = world();
    const convo = twoPlayerConvo();
    // Each device holds its OWN board state; both turns land in the SAME
    // conversation.
    let annUi: DeviceBoardState = {};
    let benUi: DeviceBoardState = {};

    annUi = selectAct(w, NPC, ANN, open, "b", opts, { convo, ui: annUi }).ui ?? annUi;
    benUi = selectAct(w, NPC, BEN, open, "b", opts, { convo, ui: benUi }).ui ?? benUi;
    // Ann turns her page. Ben does not.
    annUi = selectAct(w, NPC, ANN, more, "b", opts, { convo, ui: annUi }).ui ?? annUi;

    expect(annUi.list).toEqual({ menu: "where-is", page: 1 });
    expect(benUi.list).toEqual({ menu: "where-is", page: 0 });

    // And the BOARDS differ accordingly: Ann sees the 2 leftovers, Ben the first 5.
    const picks = (ui: DeviceBoardState) =>
      projectDialogue(w, NPC, ANN, "b", opts, { convo, ui }).acts.filter((a) => a.kind === "directions-pick");
    expect(picks(annUi)).toHaveLength(2);
    expect(picks(benUi)).toHaveLength(5);
  });

  it("navigation NEVER touches the shared record — it is not the conversation's business", () => {
    const w = world();
    const convo = twoPlayerConvo();
    const opened = selectAct(w, NPC, ANN, open, "b", opts, { convo, ui: {} });
    selectAct(w, NPC, ANN, more, "b", opts, { convo, ui: opened.ui });
    // No revealed need, no quote, no stray pair rows: paging said nothing.
    expect(convo.revealed).toEqual({});
    expect(convo.pairs).toEqual({});
  });

  it("an act that moves no menu returns no ui, so the device's board stays put", () => {
    const w = world();
    const convo = twoPlayerConvo();
    const opened = selectAct(w, NPC, ANN, open, "b", opts, { convo, ui: {} });
    const chatted = selectAct(w, NPC, ANN, { kind: "how-are-you", glyph: "hi" }, "b", opts, {
      convo,
      ui: opened.ui,
    });
    expect(chatted.ui).toBeUndefined(); // absent = unchanged, never "reset"
  });
});

// ---------------------------------------------------------------------------
// pairs — per asker
// ---------------------------------------------------------------------------

describe("a stated price is quoted to ONE asker (§6)", () => {
  // `announce: "after"` keeps the shopkeeper's own want off the greeting, so the
  // ONLY thing that can put "want + apple" on a board is a quote made to THAT
  // asker — the discriminator the per-pair law needs.
  const opts: ProjectionOpts = { symbolOf: sym, announce: "after" as const };
  /** A shopkeeper holding a cookie and wanting an apple — asking for the cookie
   *  gets the trade counter, not a gift. */
  function shopWorld() {
    const w = createCreatureWorld(
      [
        { id: ANN },
        { id: BEN },
        { id: NPC, needs: [{ itemId: "apple_1", value: 3 }] },
      ],
      [
        { id: "cookie_1", ownerId: NPC, displayed: true },
        { id: "apple_1", ownerId: ANN },
      ],
    );
    return w;
  }
  const ask: DialogueAct = { kind: "request", itemId: "cookie_1", glyph: "" };

  it("the quote lands on the ASKER's row, not on the conversation at large", () => {
    const w = shopWorld();
    const convo = twoPlayerConvo();
    selectAct(w, NPC, ANN, ask, "b", opts, { convo });

    expect(pairMemo(convo, NPC, ANN).statedPrice).toEqual({ kind: "need", itemId: "apple_1" });
    expect(convo.pairs[`${NPC}>${BEN}`]).toBeUndefined(); // Ben was never quoted
  });

  it("Ben's board does NOT honor the price quoted to Ann", () => {
    const w = shopWorld();
    const convo = twoPlayerConvo();
    selectAct(w, NPC, ANN, ask, "b", opts, { convo });

    // Ann is being asked for the apple; Ben is greeted like anyone else.
    expect(projectDialogue(w, NPC, ANN, "b", opts, { convo }).lineGlyph).toBe("want + apple");
    expect(projectDialogue(w, NPC, BEN, "b", opts, { convo }).lineGlyph).toBe("want + thing#question");
  });

  it("paying clears only the payer's quote", () => {
    const w = shopWorld();
    const convo = twoPlayerConvo();
    selectAct(w, NPC, ANN, ask, "b", opts, { convo });
    selectAct(w, NPC, BEN, ask, "b", opts, { convo });
    expect(pairMemo(convo, NPC, BEN).statedPrice).toBeDefined();

    const paid = selectAct(w, NPC, ANN, { kind: "offer", itemId: "apple_1", glyph: "" }, "b", opts, { convo });
    expect(paid.responseGlyph).toBe("thank_you");
    expect(pairMemo(convo, NPC, ANN).statedPrice).toBeUndefined();
    expect(pairMemo(convo, NPC, BEN).statedPrice).toBeDefined(); // Ben still owes
  });

  it("with NO conversation the quote is stateless — the ambient-chatter mode", () => {
    const w = shopWorld();
    // Exactly what a fresh `{}` memo used to do: the price is stated and then
    // forgotten, so the next projection greets from scratch.
    const res = selectAct(w, NPC, ANN, ask, "b", opts);
    expect(res.events).toEqual([]);
    expect(projectDialogue(w, NPC, ANN, "b", opts).lineGlyph).toBe("want + thing#question");
  });
});

// ---------------------------------------------------------------------------
// revealed — heard by everyone
// ---------------------------------------------------------------------------

describe("a need said ALOUD is revealed to every member (law 4)", () => {
  const opts: ProjectionOpts = { symbolOf: sym, announce: "after" as const };
  const world = () =>
    createCreatureWorld(
      [{ id: ANN }, { id: BEN }, { id: NPC, needs: [{ itemId: "cookie_1", value: 3 }] }],
      [{ id: "cookie_1", ownerId: ANN }],
    );
  const smallTalk: DialogueAct = { kind: "how-are-you", glyph: "hi" };

  it("Ann's small talk opens the need on BEN's board too", () => {
    const w = world();
    const convo = twoPlayerConvo();
    // Hidden from both to start with — an "after" announcer greets neutrally.
    expect(projectDialogue(w, NPC, ANN, "b", opts, { convo }).lineGlyph).toBe("hi");
    expect(projectDialogue(w, NPC, BEN, "b", opts, { convo }).lineGlyph).toBe("hi");

    selectAct(w, NPC, ANN, smallTalk, "b", opts, { convo });

    expect(convo.revealed[NPC]).toBe(true);
    // Ann is HOLDING the cookie, so her board reads as the hand-over ask; Ben
    // is not, so his reads as the plain want. Different phrasings of the SAME
    // now-visible need — which is the point: it is visible to both.
    expect(projectDialogue(w, NPC, ANN, "b", opts, { convo }).lineGlyph).toBe("give + cookie");
    // THE PAYOFF: Ben does not have to ask again — he was standing right there.
    expect(projectDialogue(w, NPC, BEN, "b", opts, { convo }).lineGlyph).toBe("want + cookie");
  });

  it("a member who joins LATER inherits it — the conversation holds it, not the asker", () => {
    const w = world();
    const convo = createConversation(NPC, 0);
    joinConversation(convo, NPC, 0, "b");
    joinConversation(convo, ANN, 0, "b");
    selectAct(w, NPC, ANN, smallTalk, "b", opts, { convo });

    joinConversation(convo, BEN, 5, "b"); // walks up after the fact
    expect(projectDialogue(w, NPC, BEN, "b", opts, { convo }).lineGlyph).toBe("want + cookie");
  });

  it("with NO conversation the reveal dies with the call (stateless, as `{}` was)", () => {
    const w = world();
    const spoken = selectAct(w, NPC, ANN, smallTalk, "b", opts);
    expect(spoken.responseGlyph).toBe("want + cookie"); // it DID answer aloud
    expect(projectDialogue(w, NPC, ANN, "b", opts).lineGlyph).toBe("hi"); // …and nobody kept it
  });
});
