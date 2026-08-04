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
  parseWorldCommand,
  sayMessage,
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
  });

  it("say still lands as avatar speech beside claims (the follower's NPC bubbles)", () => {
    const state = createWorldState(spec, "me");
    state.avatars["npc_bear"] = { id: "npc_bear", x: 1, y: 1, fx: 1, fy: 0, vx: 0, vy: 0, floor: 0 };
    applyInbound(state, sayMessage("npc_bear", "hello", "hi"));
    expect(state.bubbles["speech:npc_bear"]?.text).toBe("hello");
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
