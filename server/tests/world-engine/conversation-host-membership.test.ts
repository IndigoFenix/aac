// MEMBERSHIP IN THE HOST (multi-entity-conversations.md §4.6) — the laws the
// quest host's conversation book now obeys.
//
// WHY THIS IS A MIRROR TEST. `quest-host.ts` cannot be value-imported here: its
// import chain reaches JSX, which this jest project does not compile. So each
// law below is pinned by re-stating the host's OWN expression — copied, not
// paraphrased — and driving it through the very modules the host drives
// (`conversation.ts`, `player-identity.ts`, `selectAct`, `net.ts`). A change to
// the host that breaks one of these laws will not fail this file by itself; a
// change that makes the mirrored expression WRONG will, and that is the part
// worth pinning. Every mirror below is labelled with the host function it
// copies, so the two can be diffed by eye.
//
// The bug this phase exists to kill: `closeCreatureConvo` used to delete the
// shared record whenever ANY device closed its view, so one player walking away
// wiped the conversation out from under everyone else in it.
//
// DB-free / GL-free — runs in `npm run test:engine`.

import { describe, it, expect } from "@jest/globals";
import {
  conversationIdle,
  createConversation,
  joinConversation,
  leaveConversation,
  memberOf,
  recordUtterance,
  DEFAULT_IDLE_TTL,
  type ConversationState,
} from "@shared/world-engine/interaction/dialogue/conversation.js";
import {
  isPlayerCid,
  peerIdOf,
  playerCidOf,
  LOCAL_PLAYER_CID,
} from "@shared/world-engine/interaction/quest/player-identity.js";
import {
  createCreatureWorld,
  projectDialogue,
  selectAct,
  type DeviceBoardState,
  type DialogueAct,
  type ProjectionOpts,
  type SyntaxLevel,
} from "@shared/world-engine/interaction/index.js";
import {
  attentionBonusOf,
  attentivenessAny,
  engagementToward,
  type AuthorAttention,
  type AuthorDraws,
  type SparkDraw,
} from "@shared/world-engine/interaction/behavior/spark-attention.js";
import { applyInbound, convoMessage, type ConvoShared } from "@shared/world-engine/net.js";
import { createWorldState } from "@shared/world-engine/engine.js";
import type { WorldSpec } from "@shared/world-engine/types.js";

// ---------------------------------------------------------------------------
// The cast: one creature, the local author, and one remote peer.
// ---------------------------------------------------------------------------

const NPC = "resident_0_1";
const ANN = LOCAL_PLAYER_CID; // this device's author
const BEN_PEER = "person-ben"; // Ben's NETWORK id
const BEN = playerCidOf(BEN_PEER, "person-ann"); // …and his author cid
const sym = (id: string) => id.replace(/_\d+$/, "");

/** `ConvoView` (quest-host): ONE DEVICE's view of one conversation.
 *  ⑩ split `cid` (the creature the board FACES) from `convoId` (the record it is
 *  a view OF). They are the same string for every player-opened conversation —
 *  which is every conversation in this file — and stop being one the moment a
 *  player joins an ambient circle (`conversation-groups.test.ts` covers that). */
interface ConvoView {
  cid: string;
  convoId: string;
  ui: DeviceBoardState;
  acts: DialogueAct[];
}

/**
 * A stand-in for the host's conversation book, holding ONLY the state the host
 * holds: the shared records, this device's single view, and (⑧) the index that
 * makes "one conversation per creature, anywhere" checkable.
 *
 * ⑧ made the book ID-KEYED — `conversations`, not `convosByCreature` — so an
 * ambient circle nobody opened has a home too. A PLAYER-opened record keeps
 * `id === nodeId`, which is why every lookup below reads exactly as it did.
 */
class HostMirror {
  // NO `turn` counter: §4.7 records utterances, so the seeded stream keys on
  // `convo.nextSeq` and the host's stand-in counter is gone (see `convoRng`).
  readonly conversations = new Map<string, { id: string; nodeId: string; convo: ConversationState; group?: object }>();
  /** MIRROR of `convoOfCreature` — cid → the conversation it is in. */
  readonly convoOfCreature = new Map<string, string>();
  convoView: ConvoView | null = null;
  turnScratch: ConvoView | null = null;
  taskClock = 0;
  level: SyntaxLevel = "b";

  /** MIRROR of `conversationOf(cid)` — the index first, the id-keyed map behind. */
  conversationOf(cid: string) {
    const id = this.convoOfCreature.get(cid);
    return (id !== undefined ? this.conversations.get(id) : undefined) ?? this.conversations.get(cid);
  }

  /** MIRROR of `seatMember(c, cid, tick, level)` — the ONE door into a roster. */
  seatMember(c: { id: string; convo: ConversationState }, cid: string) {
    const prior = this.convoOfCreature.get(cid);
    if (prior !== undefined && prior !== c.id) {
      const old = this.conversations.get(prior);
      if (old) leaveConversation(old.convo, cid);
    }
    this.convoOfCreature.set(cid, c.id);
    return joinConversation(c.convo, cid, this.taskClock, this.level);
  }

  /** MIRROR of `unseatMember(c, cid)`. */
  unseatMember(c: { id: string; convo: ConversationState }, cid: string) {
    leaveConversation(c.convo, cid);
    if (this.convoOfCreature.get(cid) === c.id) this.convoOfCreature.delete(cid);
  }

  /** MIRROR of `dropConversation(c)`. */
  dropConversation(c: { id: string; convo: ConversationState }) {
    for (const m of c.convo.members) {
      if (this.convoOfCreature.get(m.id) === c.id) this.convoOfCreature.delete(m.id);
    }
    this.conversations.delete(c.id);
  }

  /** MIRROR of `conversationWith(nodeId, memberCid)`. */
  conversationWith(nodeId: string, memberCid: string = LOCAL_PLAYER_CID) {
    let c = this.conversations.get(nodeId);
    if (!c) {
      const shared = createConversation(nodeId, this.taskClock);
      c = { id: nodeId, nodeId, convo: shared };
      this.conversations.set(nodeId, c);
      this.seatMember(c, nodeId);
    }
    this.seatMember(c, memberCid);
    return c;
  }

  /** MIRROR of `openCreatureConvo` (the view half). */
  open(nodeId: string) {
    const c = this.conversationWith(nodeId, LOCAL_PLAYER_CID);
    this.convoView = { cid: nodeId, convoId: c.id, ui: {}, acts: [] };
    return c;
  }

  /** MIRROR of `conversationSpent(c, tick)` — the delete predicate.
   *  ⑧: an ambient CIRCLE steps out of it entirely (`if (c.group) return false`)
   *  — an all-NPC roster is the normal state of one, and it ends by its own
   *  dynamics rather than by this. */
  spent(c: { convo: ConversationState; group?: object }, tick = this.taskClock): boolean {
    if (c.group) return false;
    return !c.convo.members.some((m) => isPlayerCid(m.id)) || conversationIdle(c.convo, tick);
  }

  /** MIRROR of `sweepConversation(c)` — ⑩ keys the open-board guard on the
   *  RECORD, because a joined circle's record is not keyed by any creature. */
  sweep(c: { id: string; nodeId: string; convo: ConversationState; group?: object }): boolean {
    if (this.convoView?.convoId === c.id) return false;
    if (!this.spent(c)) return false;
    this.dropConversation(c);
    return true;
  }

  /** MIRROR of `departConversation(c, memberCid)`. */
  depart(c: { id: string; nodeId: string; convo: ConversationState; group?: object }, memberCid: string) {
    this.unseatMember(c, memberCid);
    if (memberCid === LOCAL_PLAYER_CID && this.convoView?.convoId === c.id) this.convoView = null;
    this.sweep(c);
  }

  /** MIRROR of `turnViewOf(memberCid, c)` — ⑩ takes the RECORD and resolves the
   *  faced creature from it (`facedBy`), which for a player-opened record is its
   *  own `nodeId`. */
  turnViewOf(memberCid: string, c: { id: string; nodeId: string }): ConvoView {
    if (memberCid === LOCAL_PLAYER_CID && this.convoView?.convoId === c.id) return this.convoView;
    if (this.turnScratch?.convoId !== c.id || this.turnScratch.cid !== c.nodeId) {
      this.turnScratch = { cid: c.nodeId, convoId: c.id, ui: {}, acts: [] };
    }
    return this.turnScratch;
  }

  /** MIRROR of `levelOf(c, memberCid)`. */
  levelOf(c: { convo: ConversationState }, memberCid: string): SyntaxLevel {
    return memberOf(c.convo, memberCid)?.level ?? this.level;
  }

  /** MIRROR of `syncConvoMembers(c, turn)` — which messages go out to whom. */
  syncMessages(c: { nodeId: string; convo: ConversationState }, seq: number, turn?: { memberCid: string; ui?: DeviceBoardState }) {
    // ⑩ keys each message on the creature THAT MEMBER faces (`facedBy`); for a
    // player-opened record that is `c.nodeId`, byte-identical to ⑥.
    const shared: ConvoShared = { revealed: { ...c.convo.revealed }, pairs: { ...c.convo.pairs } };
    const out = [];
    for (const m of c.convo.members) {
      const peer = peerIdOf(m.id);
      if (!peer) continue;
      out.push(
        convoMessage(c.nodeId, peer, m.level, shared, {
          ...(turn?.memberCid === m.id && turn.ui ? { ui: turn.ui } : {}),
          seq,
        }),
      );
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// LAW 1 — a member leaving never destroys what the others are using
// ---------------------------------------------------------------------------

describe("leaving a conversation never deletes the shared record (the close bug)", () => {
  const shopWorld = () =>
    createCreatureWorld(
      [{ id: ANN }, { id: BEN }, { id: NPC, needs: [{ itemId: "cookie_1", value: 3 }] }],
      [{ id: "cookie_1", ownerId: ANN }],
    );
  const opts: ProjectionOpts = { symbolOf: sym, announce: "after" as const };
  const smallTalk: DialogueAct = { kind: "how-are-you", glyph: "hi" };

  it("Ann closing her board leaves BEN's conversation — roster, reveals and all — intact", () => {
    const h = new HostMirror();
    const w = shopWorld();
    const c = h.open(NPC);
    h.conversationWith(NPC, BEN); // Ben joins from the wire

    // Ann's small talk coaxes the need out — heard by everyone present (law 4).
    selectAct(w, NPC, ANN, smallTalk, "b", opts, { convo: c.convo, ui: h.convoView!.ui });
    expect(c.convo.revealed[NPC]).toBe(true);

    // …and now Ann presses BACK.
    h.depart(c, ANN);

    // The record is STILL THERE. This is the whole phase in one assertion.
    expect(h.conversations.get(NPC)).toBe(c);
    expect(h.convoView).toBeNull(); // only her VIEW closed
    expect(c.convo.members.map((m) => m.id)).toEqual([NPC, BEN].sort());
    // Ben does not have to ask again — he was standing right there.
    expect(projectDialogue(w, NPC, BEN, "b", opts, { convo: c.convo }).lineGlyph).toBe("want + cookie");
  });

  it("a quote to the LEAVER dies with them; a quote to whoever stays does not", () => {
    const h = new HostMirror();
    const c = h.open(NPC);
    h.conversationWith(NPC, BEN);
    c.convo.pairs[`${NPC}>${ANN}`] = { statedPrice: { kind: "need", itemId: "apple_1" } };
    c.convo.pairs[`${NPC}>${BEN}`] = { statedPrice: { kind: "need", itemId: "apple_1" } };

    h.depart(c, ANN);

    expect(c.convo.pairs[`${NPC}>${ANN}`]).toBeUndefined();
    expect(c.convo.pairs[`${NPC}>${BEN}`]).toBeDefined();
    expect(c.convo.history).toEqual([]); // …and nothing shared was touched
    expect(c.convo.revealed).toEqual({});
  });

  it("the LAST player out takes the record with them", () => {
    const h = new HostMirror();
    const c = h.open(NPC);
    h.conversationWith(NPC, BEN);

    h.depart(c, ANN);
    expect(h.conversations.has(NPC)).toBe(true); // Ben is still in it

    h.depart(c, BEN);
    expect(h.conversations.has(NPC)).toBe(false); // …and now nobody is
  });
});

// ---------------------------------------------------------------------------
// The sweep predicate
// ---------------------------------------------------------------------------

describe("conversationSpent — is there still anybody in this room?", () => {
  it("a roster with NO author is spent; the creature alone is not company", () => {
    const h = new HostMirror();
    const c = h.conversationWith(NPC, ANN);
    expect(h.spent(c)).toBe(false);
    leaveConversation(c.convo, ANN);
    // The creature is STILL a member of its own conversation — "members is
    // empty" would never fire, which is why the test is `isPlayerCid`.
    expect(c.convo.members.map((m) => m.id)).toEqual([NPC]);
    expect(h.spent(c)).toBe(true);
  });

  it("a REMOTE author keeps it alive exactly as the local one does", () => {
    const h = new HostMirror();
    const c = h.conversationWith(NPC, BEN);
    leaveConversation(c.convo, ANN); // never joined; a no-op
    expect(c.convo.members.some((m) => isPlayerCid(m.id))).toBe(true);
    expect(h.spent(c)).toBe(false);
  });

  it("SILENCE is the second door: a full roster still expires on the idle clock", () => {
    const h = new HostMirror();
    const c = h.conversationWith(NPC, ANN);
    expect(h.spent(c, DEFAULT_IDLE_TTL - 1)).toBe(false);
    expect(h.spent(c, DEFAULT_IDLE_TTL)).toBe(true); // the boundary tick counts
    // …and a turn restarts it. §4.7: the clock moves because somebody SPOKE —
    // `recordUtterance` owns it, not a host that remembered to bump it by hand.
    recordUtterance(c.convo, {
      tick: DEFAULT_IDLE_TTL,
      speakerId: ANN,
      addresseeIds: [NPC],
      act: { kind: "how-are-you", glyph: "hi" },
    });
    expect(c.convo.lastActivityTick).toBe(DEFAULT_IDLE_TTL);
    expect(h.spent(c, DEFAULT_IDLE_TTL)).toBe(false);
  });

  it("the sweep NEVER pulls a record out from under an open board", () => {
    const h = new HostMirror();
    const c = h.open(NPC);
    h.taskClock = DEFAULT_IDLE_TTL * 10; // long past idle
    expect(h.spent(c)).toBe(true);
    expect(h.sweep(c)).toBe(false); // …but this device is looking at it
    expect(h.conversations.has(NPC)).toBe(true);
    h.convoView = null;
    expect(h.sweep(c)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LAW 2 — the world holds every rung at once
// ---------------------------------------------------------------------------

describe("per-member syntax level — one student's confusion is not the other's", () => {
  /** MIRROR of `runCreatureAct`'s `confused` arm. */
  const confused = (c: { convo: ConversationState }, speakerCid: string) => {
    const me = memberOf(c.convo, speakerCid);
    if (me) me.level = me.level === "c" ? "b" : "a";
  };

  it("A's confused-drop leaves B's rung exactly where it was", () => {
    const h = new HostMirror();
    h.level = "c";
    const c = h.open(NPC);
    h.conversationWith(NPC, BEN);
    expect(h.levelOf(c, ANN)).toBe("c");
    expect(h.levelOf(c, BEN)).toBe("c");

    confused(c, ANN);
    expect(h.levelOf(c, ANN)).toBe("b");
    expect(h.levelOf(c, BEN)).toBe("c"); // 🚨 the whole point

    confused(c, ANN);
    expect(h.levelOf(c, ANN)).toBe("a"); // b → a, the floor
    confused(c, ANN);
    expect(h.levelOf(c, ANN)).toBe("a");
    expect(h.levelOf(c, BEN)).toBe("c");
  });

  it("…and the BOARDS differ accordingly — the same creature, two phrasings", () => {
    const h = new HostMirror();
    h.level = "c";
    const c = h.open(NPC);
    h.conversationWith(NPC, BEN);
    confused(c, ANN);
    confused(c, ANN); // Ann is down to one-word

    const w = createCreatureWorld(
      [{ id: ANN }, { id: BEN }, { id: NPC, needs: [{ itemId: "cookie_1", value: 3 }] }],
      [{ id: "cookie_1", ownerId: NPC }],
    );
    const opts: ProjectionOpts = { symbolOf: sym };
    const forAnn = projectDialogue(w, NPC, ANN, h.levelOf(c, ANN), opts, { convo: c.convo });
    const forBen = projectDialogue(w, NPC, BEN, h.levelOf(c, BEN), opts, { convo: c.convo });
    expect(forAnn.lineGlyph.split(" + ")).toHaveLength(1); // level a: one word
    expect(forBen.lineGlyph.split(" + ").length).toBeGreaterThan(1);
  });

  it("a REJOIN never demotes a member back to the game's default rung", () => {
    const h = new HostMirror();
    h.level = "c";
    const c = h.open(NPC);
    confused(c, ANN);
    h.conversationWith(NPC, ANN); // she re-opens the board
    expect(h.levelOf(c, ANN)).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// The scratch-ui law
// ---------------------------------------------------------------------------

describe("a peer's turn never moves this device's board", () => {
  // Seven places to ask about: a page holds 5, so there is a page 0 and a page 1.
  const subjects = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, glyph: "home" }));
  const opts: ProjectionOpts = { symbolOf: sym, askDirections: subjects };
  const world = () => createCreatureWorld([{ id: ANN }, { id: BEN }, { id: NPC }], []);
  const openMenu: DialogueAct = { kind: "directions-menu", glyph: "place#question" };
  const more: DialogueAct = { kind: "more", glyph: "more" };

  /** MIRROR of `runCreatureAct`'s ui handling: pick the view, run, write back. */
  const runTurn = (h: HostMirror, w: ReturnType<typeof world>, c: { nodeId: string; convo: ConversationState }, act: DialogueAct, speakerCid: string) => {
    const view = h.turnViewOf(speakerCid, c);
    const res = selectAct(w, c.nodeId, speakerCid, act, h.levelOf(c, speakerCid), opts, {
      convo: c.convo,
      ui: view.ui,
    });
    if (res.ui) view.ui = res.ui;
    return res;
  };

  it("the ui transition of a REMOTE turn lands on a scratch, never on the local view", () => {
    const h = new HostMirror();
    const w = world();
    const c = h.open(NPC);
    h.conversationWith(NPC, BEN);

    // Ann opens the where-is list on HER board.
    runTurn(h, w, c, openMenu, ANN);
    expect(h.convoView!.ui.list).toEqual({ menu: "where-is", page: 0 });

    // Ben, on another device, opens his and pages it. Twice.
    runTurn(h, w, c, openMenu, BEN);
    runTurn(h, w, c, more, BEN);
    expect(h.turnScratch!.ui.list).toEqual({ menu: "where-is", page: 1 });

    // 🚨 Ann's board did not move under her thumb.
    expect(h.convoView!.ui.list).toEqual({ menu: "where-is", page: 0 });
  });

  it("the scratch is thrown away between turns, so nothing accumulates in it", () => {
    const h = new HostMirror();
    const w = world();
    const c = h.open(NPC);
    runTurn(h, w, c, openMenu, BEN);
    h.turnScratch = null; // withConversationTurn's finally
    const view = h.turnViewOf(BEN, { id: NPC, nodeId: NPC });
    expect(view.ui).toEqual({});
    expect(view).not.toBe(h.convoView);
  });

  it("the LOCAL author speaking to somebody whose board is NOT up also writes to scratch", () => {
    const h = new HostMirror();
    const w = world();
    h.open("resident_9_9"); // Ann's board is on somebody else
    const c = h.conversationWith(NPC, ANN); // …and she calls across the room
    runTurn(h, w, c, openMenu, ANN);
    expect(h.convoView!.ui).toEqual({}); // the open board never moved
    expect(h.turnScratch!.cid).toBe(NPC);
  });

  it("a turn taken HERE, in the conversation on THIS screen, does move this board", () => {
    const h = new HostMirror();
    const w = world();
    const c = h.open(NPC);
    expect(h.turnViewOf(ANN, { id: NPC, nodeId: NPC })).toBe(h.convoView);
    runTurn(h, w, c, openMenu, ANN);
    expect(h.convoView!.ui.list).toEqual({ menu: "where-is", page: 0 });
    expect(h.turnScratch).toBeNull(); // no scratch was ever needed
  });
});

// ---------------------------------------------------------------------------
// Lazy join
// ---------------------------------------------------------------------------

describe("a turn is proof of membership — the unannounced speaker is seated", () => {
  /** MIRROR of `withConversationTurn(nodeId, speakerCid, run)`'s join half. */
  const takeTurn = (h: HostMirror, nodeId: string, speakerCid: string) =>
    h.conversationWith(nodeId, speakerCid);

  it("a relayed turn from a client that never sent a join still gets a roster row", () => {
    const h = new HostMirror();
    h.taskClock = 12;
    const c = takeTurn(h, NPC, BEN); // no `convo` join ever arrived
    expect(memberOf(c.convo, BEN)).toMatchObject({ id: BEN, joinedTick: 12, level: "b" });
  });

  it("the announced case costs nothing — joining is idempotent and never resets a rung", () => {
    const h = new HostMirror();
    const c = h.conversationWith(NPC, BEN); // the `convo` join arrived
    memberOf(c.convo, BEN)!.level = "a"; // …then Ben pressed "I don't understand"
    h.taskClock = 40;
    takeTurn(h, NPC, BEN); // …and then took a turn
    expect(memberOf(c.convo, BEN)).toMatchObject({ joinedTick: 0, level: "a" });
    expect(c.convo.members).toHaveLength(2);
  });

  it("joins ride the SIM clock, and the roster stays in (joinedTick, id) order", () => {
    const h = new HostMirror();
    h.taskClock = 5;
    const c = h.conversationWith(NPC, ANN);
    h.taskClock = 9;
    h.conversationWith(NPC, BEN);
    // Same tick ⇒ the `id` tiebreak decides ("player" < "resident_0_1"), which
    // is what makes the order identical on every device and every replay.
    expect(c.convo.members.map((m) => [m.id, m.joinedTick])).toEqual([
      [ANN, 5],
      [NPC, 5],
      [BEN, 9],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Owner → follower, end to end over the real wire
// ---------------------------------------------------------------------------

const spec: WorldSpec = {
  engine: "world",
  engineVersion: 1,
  meta: { title: "t", locale: "en", theme: "t" },
  manifold: { kind: "flat", width: 40, height: 40 },
  terrain: { kind: "flat" },
  spawns: [{ id: "s", x: 5, y: 5 }],
  objects: [],
  multiplayer: { maxPlayers: 4, authority: "distributed" },
  content: { kind: "sandbox" },
};

describe("owner → follower sync — one message per REMOTE member", () => {
  it("the local author and the creature get nothing; every peer gets its OWN rung", () => {
    const h = new HostMirror();
    const c = h.open(NPC);
    h.conversationWith(NPC, BEN);
    const cara = playerCidOf("person-cara", "person-ann");
    h.conversationWith(NPC, cara);
    memberOf(c.convo, BEN)!.level = "a";
    memberOf(c.convo, cara)!.level = "c";
    c.convo.revealed[NPC] = true;

    const msgs = h.syncMessages(c, 3);
    expect(msgs).toEqual([
      { t: "convo", cid: NPC, member: "person-ben", level: "a", shared: { revealed: { [NPC]: true }, pairs: {} }, seq: 3 },
      { t: "convo", cid: NPC, member: "person-cara", level: "c", shared: { revealed: { [NPC]: true }, pairs: {} }, seq: 3 },
    ]);
  });

  it("only the member whose TURN it was is handed the board transition back", () => {
    const h = new HostMirror();
    const c = h.conversationWith(NPC, BEN);
    const cara = playerCidOf("person-cara", "person-ann");
    h.conversationWith(NPC, cara);

    const ui: DeviceBoardState = { list: { menu: "where-is", page: 1 } };
    const msgs = h.syncMessages(c, 1, { memberCid: BEN, ui });
    const byMember = Object.fromEntries(msgs.map((m) => [(m as { member: string }).member, m]));
    expect(byMember["person-ben"]).toHaveProperty("ui", ui);
    expect(byMember["person-cara"]).not.toHaveProperty("ui");
  });

  it("the shared half is a SNAPSHOT — a later turn cannot rewrite a sent message", () => {
    const h = new HostMirror();
    const c = h.conversationWith(NPC, BEN);
    const [msg] = h.syncMessages(c, 1);
    c.convo.revealed[NPC] = true; // the next turn, before the send flushes
    expect((msg as { shared: ConvoShared }).shared.revealed).toEqual({});
  });

  // The follower half: what lands in WorldState, and what the host reads back
  // out of it (stepFollowerConvoSync).
  it("what the owner sends is what the follower's row holds, keyed by ITS wire id", () => {
    const h = new HostMirror();
    const c = h.conversationWith(NPC, BEN);
    memberOf(c.convo, BEN)!.level = "a";
    c.convo.pairs[`${NPC}>${BEN}`] = { statedPrice: { kind: "need", itemId: "apple_1" } };

    const state = createWorldState(spec, BEN_PEER);
    for (const m of h.syncMessages(c, 4, { memberCid: BEN, ui: { tradeMenu: true } })) {
      applyInbound(state, m);
    }
    const mine = state.convoSync![BEN_PEER]!;
    expect(mine).toEqual({
      cid: NPC,
      level: "a",
      shared: { revealed: {}, pairs: { [`${NPC}>${BEN}`]: { statedPrice: { kind: "need", itemId: "apple_1" } } } },
      ui: { tradeMenu: true },
      seq: 4,
    });

    // MIRROR of `stepFollowerConvoSync`: newness, then merge into the mirror.
    const f = new HostMirror();
    const view = f.open(NPC);
    const seen = new Map<string, number>();
    const apply = () => {
      if (mine.cid !== f.convoView!.cid) return false;
      if (mine.seq <= (seen.get(mine.cid) ?? -1)) return false;
      seen.set(mine.cid, mine.seq);
      const me = memberOf(view.convo, LOCAL_PLAYER_CID);
      if (me) me.level = mine.level;
      Object.assign(view.convo.revealed, mine.shared.revealed);
      Object.assign(view.convo.pairs, mine.shared.pairs);
      if (mine.ui) f.convoView!.ui = mine.ui;
      return true;
    };
    expect(apply()).toBe(true);
    expect(f.levelOf(view, LOCAL_PLAYER_CID)).toBe("a");
    expect(view.convo.pairs[`${NPC}>${BEN}`]).toBeDefined();
    expect(f.convoView!.ui).toEqual({ tradeMenu: true });
    expect(apply()).toBe(false); // …and the same sync is never applied twice
  });

  it("a merge never un-hears something the follower already knew", () => {
    const c = createConversation(NPC, 0);
    joinConversation(c, NPC, 0, "b");
    c.revealed["npc_bear"] = true; // heard from a `say` that beat the sync here
    Object.assign(c.revealed, { [NPC]: true });
    expect(c.revealed).toEqual({ npc_bear: true, [NPC]: true });
  });
});

// ---------------------------------------------------------------------------
// ⑩ — THE ATTENTION STORE, PER AUTHOR
//
// `session.sparkDraw` / `sparkFocus` / `sparkEngageHold` were three singletons,
// which was the `PLAYER_CREATURE_ID` bug wearing a different hat: whichever
// device hovered last owned everybody's attention. The rows are keyed by AUTHOR
// now, and the host's own read/write sites are mirrored below — the pure
// functions themselves are pinned in `spark-attention.test.ts`.
// ---------------------------------------------------------------------------

/** A stand-in for the three session maps and the host functions that touch them. */
class AttentionMirror {
  readonly sparkDraws: AuthorDraws = new Map();
  readonly sparkAttention: AuthorAttention = new Map();
  readonly sparkEngageHold = new Map<string, number>();
  townClock = 0;
  /** cid → the roster it is in, so `authorEngagement` can consult it. */
  rosters = new Map<string, readonly { id: string; engagement: number }[]>();

  /** MIRROR of `engageCreature(session, cid, holdS, authorCid)`. */
  engageCreature(cid: string, holdS: number, authorCid = LOCAL_PLAYER_CID) {
    this.sparkAttention.set(authorCid, { cid, strength: 1 });
    this.sparkEngageHold.set(authorCid, this.townClock + holdS);
  }

  /** MIRROR of `authorOf(opts)` — the relayed speaker, else this device. */
  authorOf(speakerCid?: string) {
    return speakerCid ?? LOCAL_PLAYER_CID;
  }

  /** MIRROR of `applyPlayerAction`'s `attendCreature` arm → `attendTo` →
   *  `performAttentionInteract` → `engageCreature`, with the author threaded. */
  attendCreature(by: string, speakerCid?: string) {
    this.engageCreature(by, 4, this.authorOf(speakerCid));
  }

  /** MIRROR of `stepSparkAttention`'s draw half — the LOCAL row, always. */
  hoverObject(motive: SparkDraw["motive"], objId: string) {
    this.sparkDraws.set(LOCAL_PLAYER_CID, { motive, x: 0, y: 0, objId, strength: 1 });
  }

  /** MIRROR of `authorEngagement(session, authorCid, cid)`. */
  authorEngagement(authorCid: string, cid: string) {
    return engagementToward(this.rosters.get(authorCid), this.sparkAttention, authorCid, cid);
  }

  /** MIRROR of the need loop's DORMANCY read (`stepNeeds`) — the `*Any` side,
   *  because the question is about the CREATURE, not about one author's gaze. */
  mayStayDormant(cid: string) {
    return this.sparkDraws.size === 0 && attentivenessAny(this.sparkAttention, cid) <= 0;
  }

  /** MIRROR of `stepSparkDirect`'s bonus — one author's draw with the SAME
   *  author's engagement, never a crossed pair. */
  bonusFor(authorCid: string, cid: string, tplKey: string) {
    return attentionBonusOf(this.sparkDraws, this.sparkAttention, authorCid, cid, tplKey);
  }
}

describe("⑩ per-author attention — a peer's gaze gates a peer's creature", () => {
  const MARA = "resident_0_0";
  const BRAM = "resident_0_2";

  it("a RELAYED attend writes the SENDER's row and leaves the owner's alone", () => {
    const a = new AttentionMirror();
    a.attendCreature(MARA); // Ann, on this device
    a.attendCreature(BRAM, BEN); // …and Ben's relayed instruction
    expect(a.sparkAttention.get(ANN)).toEqual({ cid: MARA, strength: 1 });
    expect(a.sparkAttention.get(BEN)).toEqual({ cid: BRAM, strength: 1 });
    // 🚨 The singleton would have left ONE row here, and Ann's engaged creature
    // would have vanished under Ben's instruction.
    expect(a.sparkAttention.size).toBe(2);
    expect(a.sparkEngageHold.get(ANN)).toBe(a.sparkEngageHold.get(BEN));
  });

  it("engagement answers PER AUTHOR — Ben's hold on Bram says nothing about Ann's", () => {
    const a = new AttentionMirror();
    a.attendCreature(BRAM, BEN);
    expect(a.authorEngagement(BEN, BRAM)).toBe(1);
    expect(a.authorEngagement(ANN, BRAM)).toBe(0); // the no-ambient-response law
    expect(a.authorEngagement(BEN, MARA)).toBe(0);
  });

  it("🚨 THE PAIRING LAW: Ann's engagement never pairs with a draw that isn't hers", () => {
    const a = new AttentionMirror();
    a.attendCreature(MARA); // Ann engages Mara
    a.sparkDraws.set(BEN, { motive: "hunger", x: 0, y: 0, objId: "bread_1", strength: 1 });
    // Ben looked at the bread. Reading his draw against Ann's engagement would
    // send MARA to eat — an instruction neither child gave.
    expect(a.bonusFor(ANN, MARA, "hunger:food")).toBe(0); // Ann pointed at nothing
    expect(a.bonusFor(BEN, MARA, "hunger:food")).toBe(0); // Ben engaged nobody
    a.hoverObject("hunger", "bread_1"); // …and now Ann does point at it
    expect(a.bonusFor(ANN, MARA, "hunger:food")).toBeGreaterThan(0);
  });

  it("the NEED LOOP asks about the creature, so ANY author's engagement wakes it", () => {
    const a = new AttentionMirror();
    expect(a.mayStayDormant(BRAM)).toBe(true);
    a.attendCreature(BRAM, BEN); // a peer's instruction, on the owner's sim
    expect(a.mayStayDormant(BRAM)).toBe(false); // 🚨 it responds, on the owner's machine
    expect(a.mayStayDormant(MARA)).toBe(true); // …and nobody else was woken
  });

  it("ROSTER-IS-ENGAGEMENT: a fellow member answers from the circle, not the hover", () => {
    // The bug this replaces: a listener grew less answerable the longer the
    // conversation ran, because the only evidence of attention was a fading hover.
    const a = new AttentionMirror();
    a.rosters.set(ANN, [
      { id: ANN, engagement: 1 },
      { id: MARA, engagement: 1 },
    ]);
    expect(a.sparkAttention.has(ANN)).toBe(false); // no hover at all
    expect(a.authorEngagement(ANN, MARA)).toBe(1); // …and Mara is still listening
    expect(a.authorEngagement(ANN, BRAM)).toBe(0); // an outsider is not
  });
});
