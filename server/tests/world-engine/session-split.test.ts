// SESSION SPLIT/MERGE — pure clustering/election/diffing core for
// proximity-based multiplayer session topology. DB-free: every case here is
// a direct computation over
// shared/world-engine/interaction/quest/session-split.ts, no quest-host, no
// fixtures, no I/O.

import { describe, it, expect } from "@jest/globals";
import {
  SESSION_SPLIT_FRAC,
  SESSION_MERGE_FRAC,
  sessionThresholds,
  sessionAuthority,
  clusterMembers,
  diffAssignments,
  greatCircleDistanceM,
  type MemberLoc,
  type SessionAssignment,
} from "@shared/world-engine/interaction/quest/session-split.js";

// All-on-one-great-circle helper: dirAt(theta) sweeps the equator of a
// radius-1 sphere, so with radiusM=1, greatCircleDistanceM(1, dirAt(a),
// dirAt(b)) === |a-b| exactly (for |a-b| in [0, π]) — lets tests target
// specific distances by construction instead of by trial and error.
function dirAt(theta: number): [number, number, number] {
  return [Math.cos(theta), Math.sin(theta), 0];
}

function loc(id: string, theta: number, e = 0): MemberLoc {
  return { id, d: dirAt(theta), e };
}

// Test-local thresholds distinct from the real wild-chunk fractions — chosen
// so distances-by-theta land cleanly inside/outside each band.
const R = 1;
const MERGE = 0.2;
const SPLIT = 0.45;
const OPTS = { radiusM: R, splitM: SPLIT, mergeM: MERGE };

describe("sessionThresholds", () => {
  it("derives split/merge distances from the exported fracs", () => {
    const { splitM, mergeM } = sessionThresholds(320);
    expect(splitM).toBeCloseTo(320 * SESSION_SPLIT_FRAC, 10);
    expect(mergeM).toBeCloseTo(320 * SESSION_MERGE_FRAC, 10);
    // Sanity on the literal law values requested by spec (320 is world-lab's
    // WILD_SIDE — asserted here without importing across the games/ boundary).
    expect(splitM).toBeCloseTo(144, 10);
    expect(mergeM).toBeCloseTo(64, 10);
  });
});

describe("great-circle sanity", () => {
  it("antipodal points are ~ pi * radius apart", () => {
    expect(greatCircleDistanceM(1000, [1, 0, 0], [-1, 0, 0])).toBeCloseTo(Math.PI * 1000, 6);
  });
  it("identical directions are 0 apart", () => {
    expect(greatCircleDistanceM(1000, [1, 0, 0], [1, 0, 0])).toBe(0);
  });
});

describe("hysteresis edge rule", () => {
  it("stays together in the sticky band, splits past splitM, and only re-merges at <= mergeM", () => {
    // Step 1: close together (< mergeM) — merge unconditionally.
    const step1 = clusterMembers([loc("a", 0), loc("b", 0.1)], null, OPTS);
    expect(step1.sessions).toHaveLength(1);
    expect(step1.sessions[0].members).toEqual(["a", "b"]);
    const sessionId = step1.sessions[0].id;

    // Step 2: drift to 0.3 — inside (mergeM, splitM]. Same prev session ⇒ stays together.
    const step2 = clusterMembers([loc("a", 0), loc("b", 0.3)], step1, OPTS);
    expect(step2.sessions).toHaveLength(1);
    expect(step2.sessions[0].id).toBe(sessionId);
    expect(step2.sessions[0].members).toEqual(["a", "b"]);

    // Step 3: drift past splitM (0.5) — splits.
    const step3 = clusterMembers([loc("a", 0), loc("b", 0.5)], step2, OPTS);
    expect(step3.sessions).toHaveLength(2);
    expect(step3.sessions.map((s) => s.members)).toEqual([["a"], ["b"]]);

    // Step 4: back to 0.3 (inside the sticky band) — now DIFFERENT prev
    // sessions, so the edge does NOT reappear: stays split.
    const step4 = clusterMembers([loc("a", 0), loc("b", 0.3)], step3, OPTS);
    expect(step4.sessions).toHaveLength(2);
    expect(step4.sessions.map((s) => s.members)).toEqual([["a"], ["b"]]);

    // Step 5: close the rest of the way to <= mergeM (0.15) — merges again.
    const step5 = clusterMembers([loc("a", 0), loc("b", 0.15)], step4, OPTS);
    expect(step5.sessions).toHaveLength(1);
    expect(step5.sessions[0].members).toEqual(["a", "b"]);
  });
});

describe("order-independence", () => {
  it("gives a JSON-identical result for any permutation of the same input set", () => {
    const members = [loc("a", 0), loc("b", 0.05), loc("c", 0.5), loc("d", 0.55), loc("e", 1.2)];
    const [a, b, c, d, e] = members;
    const permutations: MemberLoc[][] = [
      [a, b, c, d, e],
      [e, d, c, b, a],
      [c, e, a, d, b],
      [b, a, d, c, e],
    ];
    const results = permutations.map((p) => clusterMembers(p, null, OPTS));
    const expected = results[0];
    // Sanity: this input actually forms more than one component (a trivial
    // single-session result wouldn't exercise ordering of components/pairs).
    expect(expected.sessions).toHaveLength(3);
    for (const r of results.slice(1)) {
      expect(JSON.stringify(r)).toBe(JSON.stringify(expected));
    }
  });
});

describe("session-id continuity", () => {
  it("a 3/1 split: the 3-side inherits the old id, the 1-side mints; merging back inherits the larger side's id", () => {
    // All four close together — one session.
    const gathered = clusterMembers(
      [loc("a", 0), loc("b", 0.05), loc("c", 0.08), loc("d", 0.1)],
      null,
      OPTS,
    );
    expect(gathered.sessions).toHaveLength(1);
    const originalId = gathered.sessions[0].id;
    expect(originalId).toBe(`ss:a@0`);

    // d walks far off; a,b,c stay close together regardless of history
    // (dist <= mergeM is unconditional).
    const split = clusterMembers(
      [loc("a", 0), loc("b", 0.05), loc("c", 0.08), loc("d", 1.0)],
      gathered,
      OPTS,
    );
    expect(split.epoch).toBe(gathered.epoch + 1);
    const bySize = [...split.sessions].sort((x, y) => y.members.length - x.members.length);
    expect(bySize[0].members).toEqual(["a", "b", "c"]);
    expect(bySize[0].id).toBe(originalId); // 3-side inherits
    expect(bySize[1].members).toEqual(["d"]);
    expect(bySize[1].id).not.toBe(originalId); // 1-side mints a fresh id
    expect(bySize[1].id).toBe(`ss:d@${split.epoch}`);

    // d comes back — everyone within mergeM again.
    const remerged = clusterMembers(
      [loc("a", 0), loc("b", 0.05), loc("c", 0.08), loc("d", 0.1)],
      split,
      OPTS,
    );
    expect(remerged.sessions).toHaveLength(1);
    expect(remerged.sessions[0].members).toEqual(["a", "b", "c", "d"]);
    // Inherits the larger (3-member) side's id, not the singleton's.
    expect(remerged.sessions[0].id).toBe(originalId);
  });

  it("mint collision guard: a singleton re-minting off the old lowest-member id never collides with the surviving inheritor", () => {
    const prev: SessionAssignment = {
      epoch: 0,
      sessions: [
        {
          id: "ss:a@0",
          members: ["a", "b", "c"],
          authority: "a",
          anchor: { d: [1, 0, 0], e: 0 },
        },
      ],
    };
    // a walks off alone; b and c stay close together (bigger overlap wins
    // the inherited id outright — no tie here).
    const next = clusterMembers([loc("a", 1.0), loc("b", 0), loc("c", 0.05)], prev, OPTS);
    expect(next.sessions).toHaveLength(2);
    const survivor = next.sessions.find((s) => s.members.includes("b"))!;
    const lone = next.sessions.find((s) => s.members.length === 1)!;
    expect(survivor.members).toEqual(["b", "c"]);
    expect(survivor.id).toBe("ss:a@0"); // the surviving pair inherits the old id verbatim
    expect(lone.members).toEqual(["a"]);
    // The lone "a" mints ss:a@<epoch> — same lowest-member prefix as the old
    // id, but distinguished by the new epoch, so it never collides with the
    // id the survivor just inherited.
    expect(lone.id).toBe(`ss:a@${next.epoch}`);
    expect(lone.id).not.toBe(survivor.id);
    expect(next.epoch).toBe(1);
  });
});

describe("sessionAuthority", () => {
  it("elects the lexicographically smallest id by default", () => {
    expect(sessionAuthority(["c", "a", "b"])).toBe("a");
  });
  it("prefers platformOwner when it is a member", () => {
    expect(sessionAuthority(["c", "a", "b"], { platformOwner: "b" })).toBe("b");
  });
  it("falls back to lowest id when platformOwner is not a member", () => {
    expect(sessionAuthority(["c", "a", "b"], { platformOwner: "z" })).toBe("a");
  });
  it("throws on an empty member list", () => {
    expect(() => sessionAuthority([])).toThrow();
  });

  it("a departed authority hands off to the next-lowest surviving member (integration w/ clusterMembers + diffAssignments)", () => {
    const prev: SessionAssignment = {
      epoch: 0,
      sessions: [
        {
          id: "ss:a@0",
          members: ["a", "b", "c"],
          authority: "a",
          anchor: { d: [1, 0, 0], e: 0 },
        },
      ],
    };
    // a is gone entirely (not in locs) — b and c remain close together.
    const next = clusterMembers([loc("b", 0), loc("c", 0.05)], prev, OPTS);
    expect(next.sessions).toHaveLength(1);
    expect(next.sessions[0].id).toBe("ss:a@0"); // id persists (2/2 overlap, only candidate)
    expect(next.sessions[0].authority).toBe("b"); // next-lowest surviving member
    expect(next.sessions[0].members).toEqual(["b", "c"]);

    // The anchor also legitimately shifts (a's departure moves the real
    // centroid) — pull the computed value off `next` rather than hardcoding
    // floats, since this assignment came from the real clusterMembers math
    // rather than a hand-built fixture.
    const decisions = diffAssignments(prev, next);
    expect(decisions).toEqual([
      { type: "authority-change", sessionId: "ss:a@0", from: "a", to: "b" },
      { type: "anchor", sessionId: "ss:a@0", anchor: next.sessions[0].anchor },
    ]);
  });
});

describe("no-churn idempotence", () => {
  it("returns the same epoch when nothing changed between calls", () => {
    const locs = [loc("a", 0), loc("b", 0.05), loc("c", 0.08)];
    const first = clusterMembers(locs, null, OPTS);
    expect(first.epoch).toBe(0);
    const second = clusterMembers(locs, first, OPTS);
    // Chosen "unchanged" definition (documented in the module): identical
    // id/members/authority sets ⇒ epoch is reused (anchors are recomputed
    // fresh but not part of the churn comparison).
    expect(second.epoch).toBe(first.epoch);
    expect(second.sessions).toEqual(first.sessions);
    const third = clusterMembers(locs, second, OPTS);
    expect(third.epoch).toBe(first.epoch);
  });
});

describe("diffAssignments", () => {
  it("emits boot + split-handover when a member peels into a freshly minted session", () => {
    const prev: SessionAssignment = {
      epoch: 0,
      sessions: [
        { id: "ss:a@0", members: ["a", "b", "c"], authority: "a", anchor: { d: [1, 0, 0], e: 0 } },
      ],
    };
    const next: SessionAssignment = {
      epoch: 1,
      sessions: [
        { id: "ss:a@0", members: ["a", "b"], authority: "a", anchor: { d: [1, 0, 0], e: 0 } },
        { id: "ss:c@1", members: ["c"], authority: "c", anchor: { d: [0, 1, 0], e: 0 } },
      ],
    };
    const decisions = diffAssignments(prev, next);
    expect(decisions).toEqual([
      { type: "boot", session: next.sessions[1] },
      { type: "handover", from: "a", to: "c", members: ["c"], reason: "split" },
    ]);
  });

  it("emits tear + merge-handover when a session's members fold into another surviving session", () => {
    const prev: SessionAssignment = {
      epoch: 0,
      sessions: [
        { id: "ss:a@0", members: ["a", "b"], authority: "a", anchor: { d: [1, 0, 0], e: 0 } },
        { id: "ss:c@0", members: ["c"], authority: "c", anchor: { d: [0, 1, 0], e: 0 } },
      ],
    };
    const next: SessionAssignment = {
      epoch: 1,
      sessions: [
        { id: "ss:a@0", members: ["a", "b", "c"], authority: "a", anchor: { d: [1, 0, 0], e: 0 } },
      ],
    };
    const decisions = diffAssignments(prev, next);
    expect(decisions).toEqual([
      { type: "tear", sessionId: "ss:c@0" },
      { type: "handover", from: "c", to: "a", members: ["c"], reason: "merge" },
    ]);
  });

  it("emits authority-change in isolation when only the authority differs", () => {
    const anchor = { d: [1, 0, 0] as [number, number, number], e: 0 };
    const prev: SessionAssignment = {
      epoch: 0,
      sessions: [{ id: "ss:m@0", members: ["m", "n"], authority: "m", anchor }],
    };
    const next: SessionAssignment = {
      epoch: 1,
      sessions: [{ id: "ss:m@0", members: ["m", "n"], authority: "n", anchor }],
    };
    expect(diffAssignments(prev, next)).toEqual([
      { type: "authority-change", sessionId: "ss:m@0", from: "m", to: "n" },
    ]);
  });

  it("emits anchor when a surviving session's anchor moves more than the epsilon", () => {
    const prev: SessionAssignment = {
      epoch: 0,
      sessions: [{ id: "ss:a@0", members: ["a"], authority: "a", anchor: { d: [1, 0, 0], e: 0 } }],
    };
    const next: SessionAssignment = {
      epoch: 1,
      sessions: [{ id: "ss:a@0", members: ["a"], authority: "a", anchor: { d: [0, 1, 0], e: 5 } }],
    };
    expect(diffAssignments(prev, next)).toEqual([
      { type: "anchor", sessionId: "ss:a@0", anchor: { d: [0, 1, 0], e: 5 } },
    ]);
  });

  it("does not emit anchor when the drift is at/under the epsilon", () => {
    const prev: SessionAssignment = {
      epoch: 0,
      sessions: [{ id: "ss:a@0", members: ["a"], authority: "a", anchor: { d: [1, 0, 0], e: 0 } }],
    };
    const next: SessionAssignment = {
      epoch: 1,
      sessions: [{ id: "ss:a@0", members: ["a"], authority: "a", anchor: { d: [1, 0, 0], e: 0 } }],
    };
    expect(diffAssignments(prev, next)).toEqual([]);
  });

  it("boot for a first-ever assignment (prev = null)", () => {
    const next: SessionAssignment = {
      epoch: 0,
      sessions: [{ id: "ss:a@0", members: ["a", "b"], authority: "a", anchor: { d: [1, 0, 0], e: 0 } }],
    };
    expect(diffAssignments(null, next)).toEqual([{ type: "boot", session: next.sessions[0] }]);
  });
});
