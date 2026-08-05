// The conversation as an ENTITY: roster, lifecycle and the per-pair memos.
// Pure — no world, no host, no clock. See
// planning-docs/games/world-engine/multi-entity-conversations.md §3a.

import { describe, it, expect } from "@jest/globals";
import {
  createConversation,
  joinConversation,
  leaveConversation,
  memberOf,
  conversationIdle,
  recordUtterance,
  markRevealed,
  pairMemo,
  pairKey,
  DEFAULT_IDLE_TTL,
  DEFAULT_ENGAGEMENT,
  HISTORY_CAP,
  type ConversationState,
} from "@shared/world-engine/interaction/dialogue/conversation.js";
import type { DialogueAct } from "@shared/world-engine/interaction/dialogue/creature-dialogue.js";

const act = (over: Partial<DialogueAct> = {}): DialogueAct => ({ kind: "how-are-you", glyph: "hi", ...over });

const ids = (c: ConversationState) => c.members.map((m) => m.id);

describe("createConversation — an empty floor", () => {
  it("starts with no members, no history and the clock at the birth tick", () => {
    const c = createConversation("convo1", 100);
    expect(c).toMatchObject({
      id: "convo1",
      members: [],
      history: [],
      context: {},
      revealed: {},
      pairs: {},
      lastActivityTick: 100,
      nextSeq: 0,
    });
  });
});

describe("joinConversation — idempotent by law", () => {
  it("adds a member with its own level and the default engagement", () => {
    const c = createConversation("c", 0);
    const m = joinConversation(c, "ann", 5, "c");
    expect(m).toMatchObject({ id: "ann", joinedTick: 5, level: "c", engagement: DEFAULT_ENGAGEMENT });
    expect(m.lastSpokeTick).toBeUndefined();
    expect(memberOf(c, "ann")).toBe(m);
  });

  it("honors an explicit engagement", () => {
    const c = createConversation("c", 0);
    expect(joinConversation(c, "ann", 0, "a", { engagement: 0.25 }).engagement).toBe(0.25);
  });

  // THE WORLD HOLDS EVERY RUNG AT ONCE: two members of one conversation keep
  // their own syntax tiers. A conversation-wide level would demote one of them.
  it("keeps a per-member level — members do not share a rung", () => {
    const c = createConversation("c", 0);
    joinConversation(c, "ann", 0, "a");
    joinConversation(c, "ben", 1, "c");
    expect(memberOf(c, "ann")!.level).toBe("a");
    expect(memberOf(c, "ben")!.level).toBe("c");
  });

  // A rejoin arrives from three uncoordinated places (dwell, mesh message,
  // formation tick). It must never demote a student mid-conversation.
  it("re-joining returns the EXISTING member and never resets its level", () => {
    const c = createConversation("c", 0);
    const first = joinConversation(c, "ann", 5, "c", { engagement: 0.8 });
    const again = joinConversation(c, "ann", 40, "a", { engagement: 0.1 });
    expect(again).toBe(first);
    expect(again).toMatchObject({ joinedTick: 5, level: "c", engagement: 0.8 });
    expect(c.members).toHaveLength(1);
  });

  it("re-joining never resets shared state", () => {
    const c = createConversation("c", 0);
    joinConversation(c, "ann", 0, "b");
    recordUtterance(c, { tick: 3, speakerId: "ann", act: act({ kind: "request", itemId: "cookie1" }) });
    markRevealed(c, "ben");
    pairMemo(c, "ann", "ben").statedPrice = { kind: "need", itemId: "sock1" };

    joinConversation(c, "ann", 9, "a");

    expect(c.history).toHaveLength(1);
    expect(c.context.lastMentionedItem).toBe("cookie1");
    expect(c.revealed.ben).toBe(true);
    expect(c.pairs[pairKey("ann", "ben")]!.statedPrice).toEqual({ kind: "need", itemId: "sock1" });
    expect(c.nextSeq).toBe(1);
  });
});

describe("member order is deterministic — (joinedTick, id)", () => {
  it("sorts out-of-order joins by tick", () => {
    const c = createConversation("c", 0);
    joinConversation(c, "ann", 30, "a");
    joinConversation(c, "ben", 10, "a");
    joinConversation(c, "cal", 20, "a");
    expect(ids(c)).toEqual(["ben", "cal", "ann"]);
  });

  // Two devices can deliver joins in different orders on the SAME tick; the id
  // tiebreak is what makes that unobservable.
  it("breaks a same-tick tie by id, whatever order the joins arrive in", () => {
    const forward = createConversation("c", 0);
    joinConversation(forward, "ann", 7, "a");
    joinConversation(forward, "ben", 7, "a");
    joinConversation(forward, "cal", 7, "a");

    const backward = createConversation("c", 0);
    joinConversation(backward, "cal", 7, "a");
    joinConversation(backward, "ben", 7, "a");
    joinConversation(backward, "ann", 7, "a");

    expect(ids(forward)).toEqual(["ann", "ben", "cal"]);
    expect(ids(backward)).toEqual(ids(forward));
  });

  it("a later joiner lands at the end, a back-dated one in the middle", () => {
    const c = createConversation("c", 0);
    joinConversation(c, "ann", 0, "a");
    joinConversation(c, "cal", 20, "a");
    joinConversation(c, "zed", 50, "a");
    joinConversation(c, "ben", 10, "a");
    expect(ids(c)).toEqual(["ann", "ben", "cal", "zed"]);
  });
});

describe("leaveConversation — never destroys what others are using", () => {
  const populated = (): ConversationState => {
    const c = createConversation("c", 0);
    joinConversation(c, "ann", 0, "a");
    joinConversation(c, "ben", 1, "b");
    joinConversation(c, "cal", 2, "c");
    recordUtterance(c, { tick: 4, speakerId: "ann", act: act({ kind: "request", itemId: "cookie1" }) });
    markRevealed(c, "ben");
    pairMemo(c, "ann", "ben").statedPrice = { kind: "need", itemId: "sock1" };
    pairMemo(c, "ben", "ann").statedPrice = { kind: "return", itemId: "hat1" };
    pairMemo(c, "ben", "cal").statedPrice = { kind: "need", itemId: "pot1" };
    return c;
  };

  it("removes the member and keeps the rest of the roster ordered", () => {
    const c = populated();
    leaveConversation(c, "ben");
    expect(ids(c)).toEqual(["ann", "cal"]);
    expect(memberOf(c, "ben")).toBeUndefined();
  });

  it("drops every pair memo INVOLVING the leaver, on either side", () => {
    const c = populated();
    leaveConversation(c, "ann");
    expect(Object.keys(c.pairs)).toEqual([pairKey("ben", "cal")]);
  });

  // The bug this whole entity exists to kill: one device closing its view used
  // to delete the shared record out from under everybody else.
  it("keeps history, context and revealed — they belong to the conversation", () => {
    const c = populated();
    leaveConversation(c, "ann");
    expect(c.history).toHaveLength(1);
    expect(c.history[0]!.speakerId).toBe("ann");
    expect(c.context.lastMentionedItem).toBe("cookie1");
    expect(c.revealed.ben).toBe(true);
    expect(c.nextSeq).toBe(1);
  });

  it("a leaver's own reveal survives them (everyone present heard it)", () => {
    const c = populated();
    markRevealed(c, "ann");
    leaveConversation(c, "ann");
    expect(c.revealed.ann).toBe(true);
  });

  // Leaving is not talking. A conversation abandoned by everyone must idle out
  // from when it went QUIET, not be kept alive by its own dissolution.
  it("does not bump lastActivityTick", () => {
    const c = populated();
    leaveConversation(c, "ann");
    expect(c.lastActivityTick).toBe(4);
  });

  it("leaving twice, or leaving when never joined, is a no-op", () => {
    const c = populated();
    leaveConversation(c, "ben");
    expect(() => leaveConversation(c, "ben")).not.toThrow();
    expect(() => leaveConversation(c, "nobody")).not.toThrow();
    expect(ids(c)).toEqual(["ann", "cal"]);
  });
});

describe("history ring — capped at HISTORY_CAP", () => {
  it("caps at 16, evicting the OLDEST and keeping the newest last", () => {
    expect(HISTORY_CAP).toBe(16);
    const c = createConversation("c", 0);
    joinConversation(c, "ann", 0, "a");
    for (let i = 0; i < HISTORY_CAP + 4; i++) {
      recordUtterance(c, { tick: i, speakerId: "ann", act: act({ itemId: `item${i}` }) });
    }
    expect(c.history).toHaveLength(HISTORY_CAP);
    // seq is NOT reset by eviction — it counts everything ever said here.
    expect(c.history[0]!.seq).toBe(4);
    expect(c.history[HISTORY_CAP - 1]!.seq).toBe(HISTORY_CAP + 3);
    expect(c.nextSeq).toBe(HISTORY_CAP + 4);
  });

  it("holds exactly the cap without evicting", () => {
    const c = createConversation("c", 0);
    for (let i = 0; i < HISTORY_CAP; i++) recordUtterance(c, { tick: i, speakerId: "ann", act: act() });
    expect(c.history).toHaveLength(HISTORY_CAP);
    expect(c.history[0]!.seq).toBe(0);
  });
});

describe("conversationIdle — the boundary", () => {
  it("is live before the ttl, expired AT it and after", () => {
    const c = createConversation("c", 100);
    expect(conversationIdle(c, 100, 30)).toBe(false);
    expect(conversationIdle(c, 129, 30)).toBe(false);
    expect(conversationIdle(c, 130, 30)).toBe(true);
    expect(conversationIdle(c, 999, 30)).toBe(true);
  });

  it("defaults to DEFAULT_IDLE_TTL", () => {
    const c = createConversation("c", 0);
    expect(conversationIdle(c, DEFAULT_IDLE_TTL - 1)).toBe(false);
    expect(conversationIdle(c, DEFAULT_IDLE_TTL)).toBe(true);
  });

  it("an utterance restarts the clock", () => {
    const c = createConversation("c", 0);
    joinConversation(c, "ann", 0, "a");
    expect(conversationIdle(c, 40)).toBe(true);
    recordUtterance(c, { tick: 39, speakerId: "ann", act: act() });
    expect(conversationIdle(c, 40)).toBe(false);
  });

  // A late-delivered peer utterance must not rewind the idle clock into the
  // past and expire a live conversation.
  it("a late-arriving older utterance never rewinds the clock", () => {
    const c = createConversation("c", 0);
    joinConversation(c, "ann", 0, "a");
    recordUtterance(c, { tick: 50, speakerId: "ann", act: act() });
    recordUtterance(c, { tick: 12, speakerId: "ann", act: act() });
    expect(c.lastActivityTick).toBe(50);
  });
});

describe("pairMemo — get-or-create, directional and isolated", () => {
  it("creates an empty memo and returns the SAME object next time", () => {
    const c = createConversation("c", 0);
    const memo = pairMemo(c, "ann", "ben");
    expect(memo).toEqual({});
    memo.statedPrice = { kind: "need", itemId: "cookie1" };
    expect(pairMemo(c, "ann", "ben")).toBe(memo);
    expect(pairMemo(c, "ann", "ben").statedPrice).toEqual({ kind: "need", itemId: "cookie1" });
  });

  // A price is quoted TO SOMEBODY. A quote to Ann is not a standing offer Ben
  // can collect on — that is how a shared price becomes a duplication exploit.
  it("a quote to one asker is invisible to another", () => {
    const c = createConversation("c", 0);
    pairMemo(c, "shop", "ann").statedPrice = { kind: "need", itemId: "cookie1" };
    expect(pairMemo(c, "shop", "ben").statedPrice).toBeUndefined();
  });

  it("is directional — owner>asker is not asker>owner", () => {
    const c = createConversation("c", 0);
    pairMemo(c, "ann", "ben").statedPrice = { kind: "need", itemId: "cookie1" };
    expect(pairMemo(c, "ben", "ann").statedPrice).toBeUndefined();
    expect(Object.keys(c.pairs).sort()).toEqual([pairKey("ann", "ben"), pairKey("ben", "ann")].sort());
  });

  it("does not require either party to be a member (the host owns admission)", () => {
    const c = createConversation("c", 0);
    expect(() => pairMemo(c, "ghost", "ann")).not.toThrow();
  });
});
