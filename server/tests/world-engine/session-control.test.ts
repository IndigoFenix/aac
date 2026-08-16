// SESSION-CONTROL ENVELOPES (generic engine session-split wiring) — two
// pieces:
//
//  1. parseSessionControl (shared/world-engine/interaction/quest/session-control.ts):
//     the reliable-pipe sibling of parseWorldCommand, discriminated on `sc`
//     rather than `kind` (PlayerAction) or `t` (WorldNetMessage) so all three
//     parsers are mutually null-safe by construction — pinned below.
//  2. the `loc` loose-mesh presence beacon (net.ts): a peer's planet-frame
//     direction/elevation, tracked in WorldState.peerLocs, same tolerance
//     discipline as the `spark` message it sits beside (spark-wire.test.ts).
//
// DB-free / GL-free — runs in `npm run test:engine`.

import { describe, it, expect } from "@jest/globals";
import {
  parseSessionControl,
  assignControl,
  anchorControl,
  handoverControl,
  type SessionAnchor,
} from "@shared/world-engine/interaction/quest/session-control.js";
import { createWorldState } from "@shared/world-engine/engine.js";
import { applyInbound, locMessage, type WorldNetMessage } from "@shared/world-engine/net.js";
import type { WorldSpec } from "@shared/world-engine/types.js";

const anchorA: SessionAnchor = { d: [1, 0, 0], e: 12 };
const anchorB: SessionAnchor = { d: [0, 1, 0], e: -3 };

describe("parseSessionControl — round-trips its own builders", () => {
  it("assign", () => {
    const sessions = [
      { id: "s1", members: ["a", "b"], authority: "a", anchor: anchorA },
      { id: "s2", members: ["c"], authority: "c", anchor: anchorB },
    ];
    const msg = assignControl(7, sessions);
    expect(msg).toEqual({ sc: "assign", epoch: 7, sessions });
    expect(parseSessionControl(msg)).toEqual(msg);
  });

  it("anchor", () => {
    const msg = anchorControl("s1", 3, anchorA);
    expect(msg).toEqual({ sc: "anchor", sessionId: "s1", epoch: 3, loc: anchorA });
    expect(parseSessionControl(msg)).toEqual(msg);
  });

  it("handover", () => {
    const payload = { wildRecords: [], avatars: [{ peerId: "b", loc: anchorB, stacks: [] }] };
    const msg = handoverControl("s1", "a", "b", payload);
    expect(msg).toEqual({ sc: "handover", sessionId: "s1", from: "a", to: "b", payload });
    expect(parseSessionControl(msg)).toEqual(msg);
  });
});

describe("parseSessionControl — mutual null-safety with the other two wire parsers", () => {
  it("returns null on a PlayerAction-shaped payload (discriminates on `kind`, not `sc`)", () => {
    expect(parseSessionControl({ kind: "speak", sentence: "hello" })).toBeNull();
    expect(parseSessionControl({ kind: "board", optionId: "opt1" })).toBeNull();
  });

  it("returns null on a WorldNetMessage-shaped payload (discriminates on `t`, not `sc`)", () => {
    expect(
      parseSessionControl({ t: "avatar", id: "p1", x: 0, y: 0, fx: 1, fy: 0, vx: 0, vy: 0 }),
    ).toBeNull();
    expect(parseSessionControl({ t: "spark", id: "p1", x: 0, y: 0 })).toBeNull();
  });
});

describe("parseSessionControl — foreign / malformed shapes, never throws", () => {
  const bad: unknown[] = [
    null,
    undefined,
    "a string",
    42,
    true,
    {},
    { sc: "bogus" },
    { sc: "assign", epoch: 1, sessions: "not-an-array" }, // non-array sessions
    {
      sc: "assign",
      epoch: 1,
      sessions: [{ id: "s1", members: ["a"], anchor: { d: [1, 0, 0], e: 0 } }], // missing authority
    },
    {
      sc: "assign",
      epoch: 1,
      sessions: [{ id: "s1", members: ["a"], authority: "a", anchor: { d: [NaN, 0, 0], e: 0 } }], // non-finite anchor.d
    },
    {
      sc: "assign",
      epoch: 1,
      sessions: [{ id: "s1", members: ["a"], authority: "a", anchor: { d: [1, 0, 0], e: Infinity } }], // non-finite anchor.e
    },
    {
      sc: "assign",
      epoch: 1,
      sessions: [{ id: "s1", members: ["a", 5], authority: "a", anchor: { d: [1, 0, 0], e: 0 } }], // non-string member
    },
    { sc: "anchor", sessionId: "s1", epoch: 1, loc: { d: [1, 0], e: 0 } }, // short d
    { sc: "anchor", sessionId: "s1", epoch: "1", loc: { d: [1, 0, 0], e: 0 } }, // epoch not a number
    { sc: "handover", sessionId: "s1", from: "a" }, // missing to
    { sc: "handover", sessionId: "", from: "a", to: "b", payload: null }, // empty sessionId
  ];

  it.each(bad.map((v, i) => [i, v] as const))("case %i is rejected without throwing", (_i, v) => {
    expect(() => parseSessionControl(v)).not.toThrow();
    expect(parseSessionControl(v)).toBeNull();
  });
});

describe("parseSessionControl — version-skew tolerance", () => {
  it("an assign with extra unknown fields (top-level and per-session) still parses, extras dropped", () => {
    const raw = {
      sc: "assign",
      epoch: 5,
      futureTopLevelField: "ignore me",
      sessions: [
        {
          id: "s1",
          members: ["a", "b"],
          authority: "a",
          anchor: anchorA,
          futureRowField: { nested: true },
        },
      ],
    };
    expect(parseSessionControl(raw)).toEqual({
      sc: "assign",
      epoch: 5,
      sessions: [{ id: "s1", members: ["a", "b"], authority: "a", anchor: anchorA }],
    });
  });

  it("an anchor envelope with extra unknown fields still parses, extras dropped", () => {
    const raw = { sc: "anchor", sessionId: "s1", epoch: 2, loc: anchorB, futureField: 99 };
    expect(parseSessionControl(raw)).toEqual({ sc: "anchor", sessionId: "s1", epoch: 2, loc: anchorB });
  });
});

// ---------------------------------------------------------------------------
// `loc` presence beacon (net.ts) — same discipline as `spark` (spark-wire.test.ts)
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

describe("loc messages — a peer's planet-frame presence on the wire", () => {
  it("locMessage builds the exact wire shape", () => {
    expect(locMessage("peer-a", [0, 0, 1], 12.5)).toEqual({
      t: "loc",
      id: "peer-a",
      d: [0, 0, 1],
      e: 12.5,
    });
  });

  it("peerLocs starts undefined and is lazily created on the first message", () => {
    const state = createWorldState(spec, "me");
    expect(state.peerLocs).toBeUndefined();

    applyInbound(state, locMessage("peer-a", [1, 0, 0], 3));
    expect(state.peerLocs).toEqual({ "peer-a": { d: [1, 0, 0], e: 3 } });
  });

  it("records the latest presence per peer; a second message overwrites (latest-wins)", () => {
    const state = createWorldState(spec, "me");
    applyInbound(state, locMessage("peer-a", [1, 0, 0], 3));
    applyInbound(state, locMessage("peer-b", [0, 1, 0], 6));
    expect(state.peerLocs).toEqual({
      "peer-a": { d: [1, 0, 0], e: 3 },
      "peer-b": { d: [0, 1, 0], e: 6 },
    });

    // Latest wins for that peer only; the other peer's row is untouched.
    applyInbound(state, locMessage("peer-a", [0, 0, 1], 9));
    expect(state.peerLocs).toEqual({
      "peer-a": { d: [0, 0, 1], e: 9 },
      "peer-b": { d: [0, 1, 0], e: 6 },
    });
  });

  it("drops a malformed loc (bad d length/NaN e/empty id) rather than mutating state, and never throws", () => {
    const state = createWorldState(spec, "me");
    for (const bad of [
      { t: "loc", id: "peer-a" }, // no d, no e
      { t: "loc", id: "peer-a", d: [1, 0], e: 1 }, // d too short
      { t: "loc", id: "peer-a", d: [1, 0, 0, 0], e: 1 }, // d too long
      { t: "loc", id: "peer-a", d: "not-an-array", e: 1 }, // d not an array
      { t: "loc", id: "peer-a", d: [1, "x", 0], e: 1 }, // non-number entry
      { t: "loc", id: "peer-a", d: [1, NaN, 0], e: 1 }, // NaN entry
      { t: "loc", id: "peer-a", d: [1, Infinity, 0], e: 1 }, // non-finite entry
      { t: "loc", id: "peer-a", d: [1, 0, 0], e: NaN },
      { t: "loc", id: "peer-a", d: [1, 0, 0], e: Infinity },
      { t: "loc", id: "peer-a", d: [1, 0, 0] }, // no e
      { t: "loc", id: "", d: [1, 0, 0], e: 1 }, // no sender
      { t: "loc", d: [1, 0, 0], e: 1 }, // nobody sent it
    ]) {
      expect(() => applyInbound(state, bad as unknown as WorldNetMessage)).not.toThrow();
    }
    expect(state.peerLocs).toBeUndefined(); // nothing added, nothing corrupted
  });

  // VERSION-SKEW TOLERANCE, pinned (regression alongside spark-wire.test.ts):
  // applyInbound's switch falls through to `default: break` for a kind this
  // build has never heard of — no crash, no partial state.
  it("a fully foreign message kind is silently ignored, never a throw", () => {
    const state = createWorldState(spec, "me");
    const before = JSON.stringify(state.avatars);
    const alien = { t: "no-such-kind", id: "peer-x", d: [1, 0, 0], e: 1 } as unknown as WorldNetMessage;
    expect(() => applyInbound(state, alien)).not.toThrow();
    expect(JSON.stringify(state.avatars)).toBe(before);
    expect(state.peerLocs).toBeUndefined();
  });
});
