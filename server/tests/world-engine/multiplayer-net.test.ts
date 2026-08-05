// MULTIPLAYER WIRE LAYER (owner-authoritative worlds) — the pieces the quest
// host and the platform relay agree on:
//   • the rare `claim` message (net.ts): a peer's spark→body ride, tracked in
//     WorldState.peerClaims, released with body:null, and TOLERANT of unknown
//     message kinds (peers run vendored engine snapshots of different ages);
//   • parseWorldCommand: the reliable-relay command envelope (speak/claim/act),
//     tolerant of malformed and future-versioned payloads;
//   • peer-colors: ONE FNV-1a hue family for every identity tint (2D disc, 3D
//     capsule, remote spark, video-tile border) — colorHexForId is pure and
//     import-free so clients can tint tiles without pulling three;
//   • resolveAddressee (quest-host): an explicitly relayed target PREEMPTS the
//     whole local addressee stack — the owner obeys the SENDER's resolution.
//
// DB-free / GL-free — runs in `npm run test:engine`.

import { describe, it, expect } from "@jest/globals";
import { createWorldState } from "@shared/world-engine/engine.js";
import {
  applyInbound,
  claimMessage,
  convoMessage,
  parseWorldCommand,
  sayMessage,
  type ConvoShared,
  type WorldNetMessage,
} from "@shared/world-engine/net.js";
import { parsePlayerAction, PLAYER_ACTION_KINDS } from "@shared/world-engine/player-action.js";
import { colorHexForId, peerHueForId } from "@shared/world-engine/peer-colors.js";
import { resolveAddressee } from "@shared/world-engine/interaction/quest/addressee.js";
import { parseSentence } from "@shared/world-engine/interaction/intent/parse-intent.js";
import { compileIntent, defaultBinder } from "@shared/world-engine/interaction/intent/intent-compile.js";
import type { WorldSpec } from "@shared/world-engine/types.js";

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

describe("claim messages — spark→body rides on the wire", () => {
  it("a claim records peer→body in state.peerClaims; body:null releases it", () => {
    const state = createWorldState(spec, "me");
    expect(state.peerClaims).toBeUndefined(); // absent until the first claim

    applyInbound(state, claimMessage("peer-a", "resident_3_1"));
    expect(state.peerClaims).toEqual({ "peer-a": "resident_3_1" });

    // A re-claim (new body) replaces; a second peer coexists.
    applyInbound(state, claimMessage("peer-a", "resident_3_0"));
    applyInbound(state, claimMessage("peer-b", "npc_bear"));
    expect(state.peerClaims).toEqual({ "peer-a": "resident_3_0", "peer-b": "npc_bear" });

    // Release drops only that peer's row.
    applyInbound(state, claimMessage("peer-a", null));
    expect(state.peerClaims).toEqual({ "peer-b": "npc_bear" });

    // Rebroadcast idempotence (the ~5 s late-joiner re-announce).
    applyInbound(state, claimMessage("peer-b", "npc_bear"));
    expect(state.peerClaims).toEqual({ "peer-b": "npc_bear" });
  });

  it("claimMessage builds the exact wire shape", () => {
    expect(claimMessage("p", "body1")).toEqual({ t: "claim", id: "p", body: "body1" });
    expect(claimMessage("p", null)).toEqual({ t: "claim", id: "p", body: null });
  });

  it("an UNKNOWN message kind is silently ignored (version skew across vendored snapshots)", () => {
    const state = createWorldState(spec, "me");
    const before = JSON.stringify(state.avatars);
    // A future peer's message our snapshot has never heard of.
    const alien = { t: "teleport", id: "peer-x", x: 1, y: 2 } as unknown as WorldNetMessage;
    expect(() => applyInbound(state, alien)).not.toThrow();
    expect(JSON.stringify(state.avatars)).toBe(before);
    expect(state.peerClaims).toBeUndefined();
    expect(state.convoSync).toBeUndefined();
  });

  it("say still lands as avatar speech beside claims (the follower's NPC bubbles)", () => {
    const state = createWorldState(spec, "me");
    state.avatars["npc_bear"] = { id: "npc_bear", x: 1, y: 1, fx: 1, fy: 0, vx: 0, vy: 0, floor: 0 };
    applyInbound(state, sayMessage("npc_bear", "hello", "hi"));
    expect(state.bubbles["speech:npc_bear"]?.text).toBe("hello");
  });

  // A player's OWN utterance rides the very same message (quest-host relays it
  // over the speaker's avatar), so the builder's shape is load-bearing on both
  // sides: a glyph-less line must not carry an empty `glyph` key.
  it("sayMessage builds the exact wire shape, with and without a glyph", () => {
    expect(sayMessage("p", "I want the apple.", "want + apple"))
      .toEqual({ t: "say", id: "p", text: "I want the apple.", glyph: "want + apple" });
    expect(sayMessage("p", "hello")).toEqual({ t: "say", id: "p", text: "hello" });
  });
});

// The owner holds the conversation; a follower's board is a VIEW of it, and
// without this message that view froze the moment it opened. Per member, not
// per conversation: two students in one conversation keep their own syntax
// tiers (the world holds every rung at once).
describe("convo messages — owner→follower conversation sync", () => {
  /** The SHARED half of a conversation — what crosses the wire. Board
   *  navigation (`DeviceBoardState`) deliberately has no wire shape at all. */
  const shared = (
    revealed: Record<string, true> = {},
    pairs: ConvoShared["pairs"] = {},
  ): ConvoShared => ({ revealed, pairs });

  it("convoMessage builds the exact wire shape", () => {
    expect(convoMessage("resident_0_1", "peer-a", "b", shared({ npc_bear: true }))).toEqual({
      t: "convo",
      cid: "resident_0_1",
      member: "peer-a",
      level: "b",
      shared: { revealed: { npc_bear: true }, pairs: {} },
      seq: 0,
    });
  });

  // BOARD NAVIGATION crosses only for the member whose OWN turn produced it —
  // the owner ran that turn, so it is the only device that knows what the press
  // did to the board. It is never copied to the other members.
  it("carries an optional ui transition and the conversation's monotone seq", () => {
    expect(
      convoMessage("resident_0_1", "peer-a", "b", shared(), {
        ui: { list: { menu: "where-is", page: 1 } },
        seq: 7,
      }),
    ).toEqual({
      t: "convo",
      cid: "resident_0_1",
      member: "peer-a",
      level: "b",
      shared: { revealed: {}, pairs: {} },
      ui: { list: { menu: "where-is", page: 1 } },
      seq: 7,
    });
    // No transition = the board stays where it is; the key is left off entirely
    // rather than sent as an empty object nobody can tell from "reset it".
    expect(convoMessage("c1", "peer-a", "b", shared(), { seq: 2 })).not.toHaveProperty("ui");
  });

  // ⑫④ — WHOM THAT MEMBER IS TALKING TO. The durable answer the LOOK channel
  // buys (conversation-in-motion.md law ②) crossing the wire, so a follower's
  // own `ConvoMember.addressing` stops being an optimistic guess about its own
  // player and becomes the owner's answer.
  it("carries the member's ADDRESSEE, and leaves the key off when there is none", () => {
    expect(
      convoMessage("resident_0_1", "peer-a", "b", shared(), { addressing: "resident_0_2", seq: 3 }),
    ).toEqual({
      t: "convo",
      cid: "resident_0_1",
      member: "peer-a",
      level: "b",
      shared: { revealed: {}, pairs: {} },
      addressing: "resident_0_2",
      seq: 3,
    });
    // 🚨 NO KEY *IS* THE FLOOR — not "unchanged". That is what lets the owner
    // pass a live read (`addressingOf`, which answers undefined for a departed
    // target) unconditionally: the next sync is the clearing, and no second
    // "your address is over" message shape has to exist.
    expect(convoMessage("c1", "peer-a", "b", shared(), { seq: 2 })).not.toHaveProperty("addressing");
    expect(convoMessage("c1", "peer-a", "b", shared(), { addressing: "", seq: 2 })).not.toHaveProperty("addressing");
  });

  it("records the latest state per MEMBER; members coexist and don't overwrite", () => {
    const state = createWorldState(spec, "me");
    expect(state.convoSync).toBeUndefined(); // absent until the first sync

    applyInbound(state, convoMessage("resident_0_1", "peer-a", "a", shared(), { seq: 1 }));
    applyInbound(
      state,
      convoMessage("resident_0_1", "peer-b", "c", shared({ resident_0_1: true }), { seq: 1 }),
    );
    expect(state.convoSync).toEqual({
      "peer-a": { cid: "resident_0_1", level: "a", shared: { revealed: {}, pairs: {} }, seq: 1 },
      "peer-b": {
        cid: "resident_0_1",
        level: "c",
        shared: { revealed: { resident_0_1: true }, pairs: {} },
        seq: 1,
      },
    });

    // Latest wins for that member only — a level bump, a fresh quote, a move to
    // another creature's conversation (which resets to that conversation's own
    // counter, so a LOWER seq under a different cid still wins).
    const quoted = shared({}, { "resident_0_1>peer-a": { statedPrice: { kind: "need", itemId: "cookie1" } } });
    applyInbound(state, convoMessage("resident_0_1", "peer-a", "b", quoted, { seq: 2 }));
    applyInbound(state, convoMessage("npc_bear", "peer-b", "c", shared(), { seq: 0 }));
    expect(state.convoSync).toEqual({
      "peer-a": { cid: "resident_0_1", level: "b", shared: quoted, seq: 2 },
      "peer-b": { cid: "npc_bear", level: "c", shared: { revealed: {}, pairs: {} }, seq: 0 },
    });
  });

  // The mesh reorders. "Latest" has to mean the highest seq and not the last
  // packet through the door, or a straggler rewinds a board the owner has
  // already moved on from.
  it("a STRAGGLER never rewinds a member's row; a repeat is harmless", () => {
    const state = createWorldState(spec, "me");
    applyInbound(state, convoMessage("c1", "peer-a", "b", shared(), { seq: 5 }));
    applyInbound(state, convoMessage("c1", "peer-a", "a", shared({ c1: true }), { seq: 3 }));
    expect(state.convoSync!["peer-a"]).toEqual({
      cid: "c1",
      level: "b",
      shared: { revealed: {}, pairs: {} },
      seq: 5,
    });
    // Same seq = the same state said twice (the send is fire-and-forget).
    applyInbound(state, convoMessage("c1", "peer-a", "b", shared(), { seq: 5 }));
    expect(state.convoSync!["peer-a"]!.seq).toBe(5);
    // A NEW turn lands.
    applyInbound(state, convoMessage("c1", "peer-a", "c", shared(), { seq: 6 }));
    expect(state.convoSync!["peer-a"]!.level).toBe("c");
  });

  it("drops a malformed sync rather than half-applying it", () => {
    const state = createWorldState(spec, "me");
    applyInbound(state, convoMessage("resident_0_1", "peer-a", "b", shared()));
    const good = {
      "peer-a": { cid: "resident_0_1", level: "b", shared: { revealed: {}, pairs: {} }, seq: 0 },
    };
    const ok = { revealed: {}, pairs: {} };

    for (const bad of [
      { t: "convo", member: "peer-a", level: "b", shared: ok }, // no creature
      { t: "convo", cid: "", member: "peer-a", level: "b", shared: ok },
      { t: "convo", cid: "c1", level: "b", shared: ok }, // nobody it belongs to
      { t: "convo", cid: "c1", member: "", level: "b", shared: ok },
      { t: "convo", cid: "c1", member: "peer-b", level: "d", shared: ok }, // not a rung
      { t: "convo", cid: "c1", member: "peer-b", level: 2, shared: ok },
      { t: "convo", cid: "c1", member: "peer-b", level: "b" }, // no shared state
      { t: "convo", cid: "c1", member: "peer-b", level: "b", shared: "{}" },
      // HALF a shared record is the dangerous one: a missing `pairs` would land
      // as a conversation whose first price lookup throws.
      { t: "convo", cid: "c1", member: "peer-b", level: "b", shared: { revealed: {} } },
      { t: "convo", cid: "c1", member: "peer-b", level: "b", shared: { pairs: {} } },
    ]) {
      expect(() => applyInbound(state, bad as unknown as WorldNetMessage)).not.toThrow();
    }
    expect(state.convoSync).toEqual(good); // nothing added, nothing corrupted
  });

  // `ui` and `seq` are both NEWER than the message itself, so an owner one
  // version behind sends neither. Rejecting the sync over them would freeze
  // exactly the board this message exists to un-freeze.
  it("a missing seq reads as 0 rather than dropping the sync", () => {
    const state = createWorldState(spec, "me");
    const noSeq = { t: "convo", cid: "c1", member: "peer-a", level: "b", shared: { revealed: {}, pairs: {} } };
    applyInbound(state, noSeq as unknown as WorldNetMessage);
    expect(state.convoSync!["peer-a"]).toEqual({
      cid: "c1",
      level: "b",
      shared: { revealed: {}, pairs: {} },
      seq: 0,
    });
  });

  it("a garbled ui costs the UI and nothing else — the level and the shared state still land", () => {
    const state = createWorldState(spec, "me");
    const send = (ui: unknown, seq: number) =>
      applyInbound(
        state,
        { ...(convoMessage("c1", "peer-a", "c", shared({ c1: true }), { seq }) as object), ui } as WorldNetMessage,
      );

    let seq = 0;
    for (const ui of [
      7,
      "list",
      null,
      {}, // nothing in it = no transition
      { tradeMenu: "yes" }, // not the flag it claims to be
      { list: { menu: "where-is" } }, // half a list: a menu nobody can page
      { list: { page: 1 } },
      { list: { menu: "", page: 1 } },
      { list: { menu: "where-is", page: "1" } },
      { list: { menu: "where-is", page: NaN } },
    ]) {
      send(ui, ++seq);
      expect(state.convoSync!["peer-a"]).toEqual({
        cid: "c1",
        level: "c",
        shared: { revealed: { c1: true }, pairs: {} },
        seq,
      });
    }

    // …and a well-formed one is kept, field for field.
    send({ tradeMenu: true, list: { menu: "where-is", page: 2 } }, ++seq);
    expect(state.convoSync!["peer-a"]!.ui).toEqual({ tradeMenu: true, list: { menu: "where-is", page: 2 } });
  });

  // ⑫④ — the same discipline `ui` gets, for the same reason: `addressing` is
  // NEWER than the message, so an owner one version behind sends none, and
  // rejecting the sync over it would freeze the board this message un-freezes.
  it("stores the ADDRESSEE on the member's row, and a later sync without one CLEARS it", () => {
    const state = createWorldState(spec, "me");
    applyInbound(state, convoMessage("c1", "peer-a", "b", shared(), { addressing: "resident_0_2", seq: 1 }));
    expect(state.convoSync!["peer-a"]).toEqual({
      cid: "c1",
      level: "b",
      shared: { revealed: {}, pairs: {} },
      addressing: "resident_0_2",
      seq: 1,
    });
    // The address died on the owner (they looked elsewhere, or walked off, or
    // the target left the circle). The row must not keep pointing at them.
    applyInbound(state, convoMessage("c1", "peer-a", "b", shared(), { seq: 2 }));
    expect(state.convoSync!["peer-a"]).not.toHaveProperty("addressing");
  });

  it("a garbled addressee costs the ADDRESS and nothing else — the rest still lands", () => {
    const state = createWorldState(spec, "me");
    const send = (addressing: unknown, seq: number) =>
      applyInbound(
        state,
        { ...(convoMessage("c1", "peer-a", "b", shared(), { seq }) as object), addressing } as WorldNetMessage,
      );

    let seq = 0;
    for (const addressing of [7, "", null, {}, ["resident_0_2"], true]) {
      send(addressing, ++seq);
      // The sync landed; only the address was dropped, and "no address" is a
      // state a follower can honestly render (the line goes to the floor).
      expect(state.convoSync!["peer-a"]).toEqual({
        cid: "c1",
        level: "b",
        shared: { revealed: {}, pairs: {} },
        seq,
      });
    }
    send("resident_0_2", ++seq);
    expect(state.convoSync!["peer-a"]!.addressing).toBe("resident_0_2");
  });

  it("a sync with NO addressing field is never rejected — validConvo does not ask", () => {
    // An older owner sends `{cid, member, level, shared}` and nothing else. That
    // message must still un-freeze the board.
    const state = createWorldState(spec, "me");
    const old = { t: "convo", cid: "c1", member: "peer-a", level: "c", shared: { revealed: {}, pairs: {} } };
    applyInbound(state, old as unknown as WorldNetMessage);
    expect(state.convoSync!["peer-a"]).toEqual({
      cid: "c1",
      level: "c",
      shared: { revealed: {}, pairs: {} },
      seq: 0,
    });
  });

  it("an OLD snapshot ignores it entirely — the drop-safety both channels rely on", () => {
    // What the previous engine version's applyInbound does with `convo`: its
    // switch has no arm, so it falls through to `default: break`. Stand in for
    // that with a kind THIS version doesn't know either — same code path.
    const state = createWorldState(spec, "me");
    const future = { t: "convo-roster", cid: "c1", members: ["a"] } as unknown as WorldNetMessage;
    expect(() => applyInbound(state, future)).not.toThrow();
    expect(state.convoSync).toBeUndefined();
  });
});

describe("parseWorldCommand — the reliable relay envelope", () => {
  it("parses a speak command, with and without an addressee", () => {
    expect(parseWorldCommand({ kind: "speak", from: "p1", sentence: "go + home", gesture: { addressee: "resident_0_1" } }))
      .toEqual({ kind: "speak", from: "p1", sentence: "go + home", gesture: { addressee: "resident_0_1" } });
    expect(parseWorldCommand({ kind: "speak", from: "p1", sentence: "hi" }))
      .toEqual({ kind: "speak", from: "p1", sentence: "hi" });
  });

  it("parses a claim command (body string or null)", () => {
    expect(parseWorldCommand({ kind: "claim", from: "p1", body: "resident_0_0" }))
      .toEqual({ kind: "claim", from: "p1", body: "resident_0_0" });
    expect(parseWorldCommand({ kind: "claim", from: "p1", body: null }))
      .toEqual({ kind: "claim", from: "p1", body: null });
  });

  it("rejects garbage and future-versioned kinds with null, never a throw", () => {
    for (const bad of [
      null,
      undefined,
      42,
      "speak",
      {},
      { kind: "speak" }, // no from/sentence
      { kind: "speak", from: "p1" }, // no sentence
      { kind: "speak", from: "p1", sentence: "   " }, // blank sentence
      { kind: "speak", from: "", sentence: "hi" }, // empty sender
      { kind: "claim", from: "p1", body: 7 }, // wrong body type
      { kind: "dance", from: "p1" }, // unknown kind (version skew)
    ]) {
      expect(parseWorldCommand(bad)).toBeNull();
    }
  });

  it("drops a non-string addressee instead of failing the whole command", () => {
    expect(parseWorldCommand({ kind: "speak", from: "p1", sentence: "hi", gesture: { addressee: 9 } }))
      .toEqual({ kind: "speak", from: "p1", sentence: "hi" });
  });

  // A relayed command IS a PlayerAction plus who did it — one vocabulary for
  // a press, a sentence and a gaze instruction, on both sides of the wire.
  it("parses a board press, carrying the glyph that survives the trip", () => {
    expect(parseWorldCommand({ kind: "board", from: "p2", optionId: "annex:3:kitchen", glyph: "build + kitchen" }))
      .toEqual({ kind: "board", from: "p2", optionId: "annex:3:kitchen", glyph: "build + kitchen" });
    expect(parseWorldCommand({ kind: "board", from: "p2", optionId: "grow:bedroom" }))
      .toEqual({ kind: "board", from: "p2", optionId: "grow:bedroom" });
  });

  // An utterance is a glyph AND a gesture: who was addressed, the ground
  // indicated, the chest being reached into. Two players indicate different
  // things right up until the order is issued, so it travels with the order.
  it("an utterance carries the gesture that completes it", () => {
    const gesture = { addressee: "resident_0_1", place: { x: 3, y: -4.5 }, container: "obj_chest_4", spot: "lot_2" };
    expect(parseWorldCommand({ kind: "board", from: "p2", optionId: "take:apple", gesture }))
      .toEqual({ kind: "board", from: "p2", optionId: "take:apple", gesture });
    expect(parseWorldCommand({ kind: "speak", from: "p2", sentence: "you + go + there", gesture: { place: { x: 1, y: 2 } } }))
      .toEqual({ kind: "speak", from: "p2", sentence: "you + go + there", gesture: { place: { x: 1, y: 2 } } });
  });

  it("keeps the parts of a gesture that arrived intact, and drops an empty one", () => {
    // One garbled part must not cost the speaker the rest of what they meant.
    expect(parseWorldCommand({ kind: "board", from: "p2", optionId: "x", gesture: { addressee: "c1", place: { x: 1, y: "2" } } }))
      .toEqual({ kind: "board", from: "p2", optionId: "x", gesture: { addressee: "c1" } });
    // No gesture at all is left off entirely, so a plain press stays plain.
    expect(parseWorldCommand({ kind: "board", from: "p2", optionId: "x", gesture: {} }))
      .toEqual({ kind: "board", from: "p2", optionId: "x" });
    expect(parseWorldCommand({ kind: "board", from: "p2", optionId: "x", gesture: 7 }))
      .toEqual({ kind: "board", from: "p2", optionId: "x" });
  });

  // A conversation option is an INDEX into the act list the presser's own
  // device projected, and choosing one never went through the parser — so the
  // act itself has to travel, not the index and not the sentence on the button.
  it("carries the dialogue act itself, not the button that chose it", () => {
    const act = { kind: "request", glyph: "want + apple", itemId: "apple_1" };
    expect(parseWorldCommand({ kind: "converse", from: "p2", cid: "resident_0_1", act }))
      .toEqual({ kind: "converse", from: "p2", cid: "resident_0_1", act });
    for (const bad of [
      { kind: "converse", from: "p2", cid: "c1" }, // no act
      { kind: "converse", from: "p2", cid: "c1", act: {} }, // no kind or glyph
      { kind: "converse", from: "p2", cid: "c1", act: { kind: "request" } }, // nothing said
      { kind: "converse", from: "p2", cid: "c1", act: { glyph: "hi" } }, // no kind
      { kind: "converse", from: "p2", act: { kind: "bye", glyph: "bye" } }, // nobody addressed
    ]) {
      expect(parseWorldCommand(bad)).toBeNull();
    }
  });

  // Opening a conversation BOARD is local; BELONGING to the conversation is
  // not — the roster lives with the simulation, so the change is relayed.
  it("parses a conversation membership change (join / leave)", () => {
    expect(parseWorldCommand({ kind: "convo", from: "p2", cid: "resident_0_1", op: "join" }))
      .toEqual({ kind: "convo", from: "p2", cid: "resident_0_1", op: "join" });
    expect(parsePlayerAction({ kind: "convo", cid: "resident_0_1", op: "leave" }))
      .toEqual({ kind: "convo", cid: "resident_0_1", op: "leave" });
  });

  // ★ ⑫④ — THE LOOK CROSSES THE GATE. ★ The dwell `address` cell was the one of
  // its four that never produced a `PlayerAction` at all; its three neighbours
  // (`sendTo` / `attendObject` / `attendCreature`) all did. `cid` is the FELLOW
  // MEMBER being addressed — the owner resolves the conversation from the
  // speaker's own membership, which it already holds.
  it("parses the ⑫④ address — an op on `convo`, not a ninth kind", () => {
    expect(parseWorldCommand({ kind: "convo", from: "p2", cid: "resident_0_2", op: "address" }))
      .toEqual({ kind: "convo", from: "p2", cid: "resident_0_2", op: "address" });
    expect(parsePlayerAction({ kind: "convo", cid: "resident_0_2", op: "address" }))
      .toEqual({ kind: "convo", cid: "resident_0_2", op: "address" });
    // It is deliberately NOT `attendCreature`: that commands a THIRD PARTY to go
    // and attend somebody (a spark row, a body crossing the square). This
    // changes nothing but who the next sentence is said to — so the two must
    // stay distinguishable on the wire.
    expect(parsePlayerAction({ kind: "attendCreature", cid: "resident_0_1", id: "resident_0_2" }))
      .toEqual({ kind: "attendCreature", cid: "resident_0_1", id: "resident_0_2" });
  });

  it("⚠️ AN OLD OWNER DROPS THE ADDRESS WHOLE — the degradation, pinned", () => {
    // This is the same guard `op: "listen"` hits below, read from the other
    // side: an owner that predates ⑫④ has `op !== "join" && op !== "leave"` and
    // returns null, so it drops the action rather than guessing at it. The cost
    // is nil — the sentence that follows carries its own `Gesture.addressee`
    // stamped from this device's gaze, which the owner honours as an explicit
    // target. The address simply stops being DURABLE: it lasts the utterance
    // instead of lasting until the child looks elsewhere.
    const oldOwnerParse = (raw: unknown): unknown => {
      const a = raw as { kind?: unknown; cid?: unknown; op?: unknown };
      if (a.kind !== "convo") return null;
      if (typeof a.cid !== "string" || !a.cid || (a.op !== "join" && a.op !== "leave")) return null;
      return { kind: "convo", cid: a.cid, op: a.op };
    };
    expect(oldOwnerParse({ kind: "convo", cid: "resident_0_2", op: "address" })).toBeNull();
    // …and the gesture that survives it is an ordinary `speak`, unchanged.
    expect(
      parsePlayerAction({ kind: "speak", sentence: "hi", gesture: { addressee: "resident_0_2" } }),
    ).toEqual({ kind: "speak", sentence: "hi", gesture: { addressee: "resident_0_2" } });
  });

  it("drops a membership change it can't read rather than guessing the op", () => {
    for (const bad of [
      { kind: "convo", from: "p2", op: "join" }, // no conversation
      { kind: "convo", from: "p2", cid: "", op: "join" },
      { kind: "convo", from: "p2", cid: "c1" }, // nothing happened
      { kind: "convo", from: "p2", cid: "c1", op: "listen" }, // an op from a newer peer
      { kind: "convo", from: "p2", cid: "c1", op: true },
      { kind: "convo", cid: "c1", op: "join" }, // nobody sent it
    ]) {
      expect(parseWorldCommand(bad)).toBeNull();
    }
    // Version skew stays version skew: an unknown KIND is still null, so an old
    // owner drops a membership change instead of misreading it.
    expect(parsePlayerAction({ kind: "convo-roster", cid: "c1" })).toBeNull();
    expect(parsePlayerAction({ kind: "dance" })).toBeNull();
  });

  it("parses each relayed gaze instruction", () => {
    expect(parseWorldCommand({ kind: "sendTo", from: "p2", cid: "resident_0_1", x: 3, y: -4.5 }))
      .toEqual({ kind: "sendTo", from: "p2", cid: "resident_0_1", x: 3, y: -4.5 });
    expect(parseWorldCommand({ kind: "attendObject", from: "p2", cid: "resident_0_1", id: "obj_7", x: 1, y: 2 }))
      .toEqual({ kind: "attendObject", from: "p2", cid: "resident_0_1", id: "obj_7", x: 1, y: 2 });
    expect(parseWorldCommand({ kind: "attendCreature", from: "p2", cid: "resident_0_1", id: "resident_0_2" }))
      .toEqual({ kind: "attendCreature", from: "p2", cid: "resident_0_1", id: "resident_0_2" });
  });

  it("rejects a half-read instruction rather than acting on what is missing", () => {
    for (const bad of [
      { kind: "board", from: "p2" }, // no option
      { kind: "board", from: "p2", optionId: "" },
      { kind: "sendTo", from: "p2", cid: "c1" }, // no place
      { kind: "sendTo", from: "p2", cid: "c1", x: 1, y: "2" }, // place not a number
      { kind: "sendTo", from: "p2", cid: "c1", x: 1, y: NaN }, // not finite
      { kind: "sendTo", from: "p2", cid: "", x: 1, y: 2 }, // no creature
      { kind: "attendObject", from: "p2", cid: "c1", x: 1, y: 2 }, // no object
      { kind: "attendCreature", from: "p2", cid: "c1" }, // no other creature
      { kind: "shove", from: "p2", cid: "c1" }, // unknown action
      { kind: "sendTo", cid: "c1", x: 1, y: 2 }, // nobody sent it
    ]) {
      expect(parseWorldCommand(bad)).toBeNull();
    }
  });

  // The union is closed on purpose: a new way to reach the simulation is a new
  // variant, never a new path around the gate.
  it("every action kind the engine can perform round-trips through the wire", () => {
    const sample: Record<(typeof PLAYER_ACTION_KINDS)[number], unknown> = {
      speak: { kind: "speak", sentence: "go + home" },
      board: { kind: "board", optionId: "build:farm" },
      converse: { kind: "converse", cid: "c1", act: { kind: "request", glyph: "want + apple" } },
      convo: { kind: "convo", cid: "c1", op: "join" },
      sendTo: { kind: "sendTo", cid: "c1", x: 0, y: 0 },
      attendObject: { kind: "attendObject", cid: "c1", id: "o1", x: 0, y: 0 },
      attendCreature: { kind: "attendCreature", cid: "c1", id: "c2" },
      claim: { kind: "claim", body: null },
    };
    for (const kind of PLAYER_ACTION_KINDS) {
      expect(parsePlayerAction(sample[kind])).not.toBeNull();
      expect(parseWorldCommand({ ...(sample[kind] as object), from: "p2" })).toMatchObject({ kind, from: "p2" });
    }
  });
});

describe("peer-colors — one identity palette for every surface", () => {
  it("colorHexForId is a stable lowercase #rrggbb", () => {
    const c = colorHexForId("person-1234");
    expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(colorHexForId("person-1234")).toBe(c); // deterministic
    expect(colorHexForId("person-5678")).not.toBe(c); // ids differ → colours differ
  });

  it("the hex sits on the FNV-1a hue the family hashes to (same family as the renderers)", () => {
    for (const id of ["alice", "bob", "person-uuid-1", "x"]) {
      const hex = colorHexForId(id);
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      let hue = 0;
      if (d > 0) {
        if (max === r) hue = 60 * (((g - b) / d) % 6);
        else if (max === g) hue = 60 * ((b - r) / d + 2);
        else hue = 60 * ((r - g) / d + 4);
      }
      if (hue < 0) hue += 360;
      const want = peerHueForId(id);
      const diff = Math.min(Math.abs(hue - want), 360 - Math.abs(hue - want));
      expect(diff).toBeLessThan(2); // hex-rounding tolerance
    }
  });
});

describe("resolveAddressee — an explicit relayed target preempts the local stack", () => {
  const stack = {
    addressedFamily: "resident_0_0",
    gaze: "resident_0_1",
    convo: "resident_0_2",
    possessed: "resident_0_3",
    nearest: "resident_0_4",
  };

  it("the relayed target wins over EVERY local signal", () => {
    expect(resolveAddressee("npc_bear", stack)).toBe("npc_bear");
  });

  it("without an explicit target the local stack keeps its order", () => {
    expect(resolveAddressee(undefined, stack)).toBe("resident_0_0"); // chip first
    expect(resolveAddressee(undefined, { ...stack, addressedFamily: null })).toBe("resident_0_1");
    expect(resolveAddressee(undefined, { ...stack, addressedFamily: null, gaze: null })).toBe("resident_0_2");
    expect(
      resolveAddressee(undefined, { ...stack, addressedFamily: null, gaze: null, convo: null }),
    ).toBe("resident_0_3");
    expect(
      resolveAddressee(undefined, {
        addressedFamily: null,
        gaze: null,
        convo: null,
        possessed: null,
        nearest: "resident_0_4",
      }),
    ).toBe("resident_0_4");
    expect(
      resolveAddressee(undefined, {
        addressedFamily: null,
        gaze: null,
        convo: null,
        possessed: null,
        nearest: null,
      }),
    ).toBeNull();
  });

  it("the resolved target becomes the LISTENER, so a relayed command's goal lands on it", () => {
    // The exact wiring speak() applies next: binder listener = resolveAddressee(...),
    // and a bare imperative compiles to a goal for the listener.
    const target = resolveAddressee("npc_bear", stack)!;
    const c = compileIntent(parseSentence("you + go + home"), defaultBinder({ player: "child", listener: target }), {
      id: "r1",
    });
    expect(c).toMatchObject({ kind: "goal", goal: { kind: "goHome" }, actor: "npc_bear" });
  });
});
