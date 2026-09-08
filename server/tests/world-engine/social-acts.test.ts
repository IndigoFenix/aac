// `applySocialEvent` — the act vocabulary of interpersonal politics
// (politics-substrate-round.md S-4; influence-and-authority.md M2).
//
// The module is PURE (no session, no world, no RNG), so this suite is the whole
// specification of what a social event DOES: which directed edges move, which
// beliefs get published, whose needs got met. Pure logic — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  applySocialEvent,
  STANDING_DEFER_AT,
  WITNESS_CAP,
  WITNESS_FRACTION,
  type SocialAct,
  type SocialActKind,
  type SocialOutcome,
} from "@shared/world-engine/interaction/behavior/social-acts.js";
import {
  DEFAULT_RELATION,
  deference,
  makeRelation,
  type Relation,
} from "@shared/world-engine/interaction/behavior/relations.js";
import {
  NEUTRAL_PERSONALITY,
  personalityFromPreset,
} from "@shared/world-engine/interaction/behavior/personality.js";

// A mid-range book: no axis sits at a bound, so every nudge's delta shows up at
// its nominal size instead of being silently eaten by the clamp.
const MID: Relation = makeRelation({ affinity: 0.2, trust: 0.5, authority: 0.4, fear: 0.2 });
const flat = (rel: Relation = MID) => () => rel;

const act = (over: Partial<SocialAct> & { kind: SocialActKind }): SocialAct => ({
  actor: "ann",
  addressee: "ben",
  witnesses: [],
  ...over,
});

/** The one directed edge observer→subject, or undefined. */
function edge(out: SocialOutcome, observer: string, subject: string): Partial<Relation> | undefined {
  const hits = out.nudges.filter((n) => n.observer === observer && n.subject === subject);
  expect(hits.length).toBeLessThanOrEqual(1); // one edge per pair per act
  return hits[0]?.delta;
}

const AXES = ["affinity", "trust", "authority", "fear"] as const;
const biggest = (deltas: Array<Partial<Relation> | undefined>): number =>
  Math.max(0, ...deltas.flatMap((d) => (d ? AXES.map((a) => Math.abs(d[a] ?? 0)) : [0])));

// ---------------------------------------------------------------------------
// ① THE TABLE — one case per kind
// ---------------------------------------------------------------------------

describe("applySocialEvent — the act table, one case per kind", () => {
  const wit = ["cal", "dee"];

  it("attend — mutual, small, and both `social` meters clear", () => {
    const out = applySocialEvent(act({ kind: "attend", witnesses: wit }), flat());
    expect(edge(out, "ann", "ben")).toEqual({ affinity: 0.03 });
    expect(edge(out, "ben", "ann")).toEqual({ affinity: 0.03 });
    expect(out.nudges).toHaveLength(2); // witnesses learn nothing from company
    expect(out.credits).toEqual([
      { cid: "ann", key: "social", levelAfter: 0 },
      { cid: "ben", key: "social", levelAfter: 0 },
    ]);
    expect(out.facts).toEqual([]);
  });

  it("thank — the thanked body gains standing, and both edges warm", () => {
    const out = applySocialEvent(act({ kind: "thank" }), flat());
    expect(edge(out, "ben", "ann")).toEqual({ affinity: 0.04 });
    expect(edge(out, "ann", "ben")).toEqual({ affinity: 0.04, trust: 0.02 });
    expect(out.credits).toEqual([{ cid: "ben", key: "standing", levelAfter: 0 }]);
  });

  it("praise — witnesses think better of the PRAISED body, on affinity only (hearsay law)", () => {
    const out = applySocialEvent(act({ kind: "praise", witnesses: wit, magnitude: 2 }), flat());
    expect(edge(out, "ben", "ann")).toEqual({ affinity: 0.1 });
    for (const w of wit) expect(edge(out, w, "ben")).toEqual({ affinity: 0.04 });
    expect(out.nudges.every((n) => n.delta.authority === undefined)).toBe(true);
    expect(out.credits).toEqual([{ cid: "ben", key: "standing", levelAfter: 0 }]);
  });

  it("insult — the target loses liking AND standing; witnesses think less of the INSULTER", () => {
    const out = applySocialEvent(act({ kind: "insult", witnesses: wit }), flat());
    expect(edge(out, "ben", "ann")).toEqual({ affinity: -0.1, trust: -0.03 });
    for (const w of wit) expect(edge(out, w, "ann")).toEqual({ affinity: -0.03 });
    // Standing LOST ⇒ the METER RISES (a delta, not a clear).
    expect(out.credits).toEqual([{ cid: "ben", key: "standing", delta: 0.3 }]);
  });

  it("threaten — fear up, liking down, and a bystander's fear is exactly WITNESS_FRACTION of it", () => {
    const out = applySocialEvent(act({ kind: "threaten", witnesses: wit }), flat());
    const party = edge(out, "ben", "ann")!;
    expect(party.fear).toBeCloseTo(0.2);
    expect(party.affinity).toBeCloseTo(-0.08);
    expect(party.authority).toBeUndefined(); // 🚨 a threat never earns authority
    for (const w of wit) expect(edge(out, w, "ann")!.fear).toBeCloseTo(WITNESS_FRACTION * (party.fear ?? 0));
  });

  it("yield (earned) — the yielder recognizes the winner, and everyone learns it", () => {
    const out = applySocialEvent(act({ kind: "yield", route: "L", witnesses: wit }), flat());
    const d = edge(out, "ann", "ben")!;
    expect(d.authority).toBeCloseTo(0.08);
    expect(d.fear).toBeUndefined();
    expect(d.affinity).toBeUndefined();
    for (const w of wit) expect(edge(out, w, "ben")).toEqual({ trust: 0.03 });
    expect(out.credits).toEqual([
      { cid: "ben", key: "standing", levelAfter: 0 },
      { cid: "ann", key: "standing", delta: 0.5 },
    ]);
  });

  it("yield (coerced) — fear, not recognition (⚖️ ruling ③)", () => {
    const out = applySocialEvent(act({ kind: "yield", route: "C", witnesses: wit }), flat());
    const d = edge(out, "ann", "ben")!;
    expect(d.authority).toBeUndefined();
    expect(d.fear).toBeCloseTo(0.08);
    expect(d.affinity).toBeCloseTo(-0.04);
    for (const w of wit) expect(edge(out, w, "ben")).toEqual({ fear: 0.03 });
  });

  it("apologize — warmth and a little trust, nothing public", () => {
    const out = applySocialEvent(act({ kind: "apologize", witnesses: wit }), flat());
    expect(out.nudges).toEqual([{ observer: "ben", subject: "ann", delta: { affinity: 0.05, trust: 0.02 } }]);
    expect(out.credits).toEqual([]);
  });

  it("side — the backed body is safer, the opposed one likes you less", () => {
    const out = applySocialEvent(act({ kind: "side", third: "cal" }), flat());
    expect(edge(out, "ben", "ann")).toEqual({ affinity: 0.06, trust: 0.03 });
    expect(edge(out, "cal", "ann")).toEqual({ affinity: -0.06 });
    expect(out.credits).toEqual([{ cid: "ben", key: "security", levelAfter: 0 }]);
  });

  it("gift / help — the ACTOR is liked, the AUTHOR is trusted (⚖️ the asymmetry law)", () => {
    for (const kind of ["gift", "help"] as const) {
      const out = applySocialEvent(act({ kind, author: "zed", witnesses: wit }), flat());
      const got = edge(out, "ben", "ann")!;
      expect(got.affinity).toBeCloseTo(0.08);
      expect(got.trust).toBeCloseTo(0.03);
      expect(edge(out, "ben", "zed")).toEqual({ trust: 0.03 });
      for (const w of wit) {
        expect(edge(out, w, "ann")).toEqual({ affinity: 0.02 });
        expect(edge(out, w, "zed")).toEqual({ trust: 0.01 });
      }
    }
  });

  it("harm — liking down, fear up, and the bystanders are afraid too", () => {
    const out = applySocialEvent(act({ kind: "harm", witnesses: wit }), flat());
    expect(edge(out, "ben", "ann")).toEqual({ affinity: -0.15, fear: 0.1 });
    for (const w of wit) expect(edge(out, w, "ann")).toEqual({ fear: 0.05, affinity: -0.05 });
  });

  it("order-done (earned) — M1: the AUTHOR gains authority from the OUTCOME", () => {
    const out = applySocialEvent(act({ kind: "order-done", author: "zed", witnesses: wit }), flat());
    const d = edge(out, "ann", "zed")!;
    expect(d.authority).toBeCloseTo(0.06);
    expect(d.trust).toBeCloseTo(0.02);
    for (const w of wit) expect(edge(out, w, "zed")).toEqual({ trust: 0.02 });
    // The ACTOR's own standing is untouched — doing as told is not a public loss.
    expect(out.credits).toEqual([]);
  });

  it("order-failed — the authority the order borrowed is taken back", () => {
    const out = applySocialEvent(act({ kind: "order-failed", author: "zed" }), flat());
    const d = edge(out, "ann", "zed")!;
    expect(d.authority).toBeCloseTo(-0.04);
    expect(d.trust).toBeCloseTo(-0.02);
  });

  it("order-refused — a PUBLIC refusal costs the author standing; a private one does not", () => {
    const seen = applySocialEvent(act({ kind: "order-refused", author: "zed", witnesses: wit }), flat());
    expect(seen.credits).toEqual([{ cid: "zed", key: "standing", delta: 0.3 }]);
    for (const w of wit) expect(edge(seen, w, "zed")).toEqual({ trust: -0.01 });
    const unseen = applySocialEvent(act({ kind: "order-refused", author: "zed" }), flat());
    expect(unseen.credits).toEqual([]);
    expect(unseen.nudges).toEqual([]);
  });

  it("request-granted / request-refused — the REQUESTER is the addressee", () => {
    const granted = applySocialEvent(act({ kind: "request-granted" }), flat());
    expect(granted.nudges).toEqual([{ observer: "ben", subject: "ann", delta: { affinity: 0.04 } }]);
    const refused = applySocialEvent(act({ kind: "request-refused", witnesses: wit }), flat());
    expect(refused.credits).toEqual([{ cid: "ben", key: "standing", delta: 0.2 }]);
    expect(applySocialEvent(act({ kind: "request-refused" }), flat()).credits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ② THE LAWS, BY CONSTRUCTION
// ---------------------------------------------------------------------------

const EVERY_KIND: SocialActKind[] = [
  "attend", "thank", "praise", "insult", "threaten", "yield", "apologize", "side",
  "gift", "help", "harm", "order-done", "order-failed", "order-refused",
  "request-granted", "request-refused",
];

describe("the laws applySocialEvent enforces by construction", () => {
  it("🚨 LAW ① NO SELF-EDGE: no emitted nudge ever has observer === subject", () => {
    for (const kind of EVERY_KIND) {
      for (const author of [undefined, "ann", "zed"]) {
        const out = applySocialEvent(
          act({ kind, author, third: "ann", witnesses: ["ann", "ben", "cal"] }),
          flat(),
        );
        for (const n of out.nudges) expect(n.observer).not.toBe(n.subject);
      }
    }
  });

  it("🚨 LAW ① SELF-AUTHORSHIP writes NO author edge (a body cannot promote itself)", () => {
    // A self-issued order earns NOTHING: the whole outcome is empty, which is
    // the difference between "I told myself to" and a leader being obeyed.
    const selfOrdered = applySocialEvent(
      act({ kind: "order-done", author: "ann", witnesses: ["cal"] }),
      flat(),
    );
    expect(selfOrdered.nudges).toEqual([]);
    // And in general: `author === actor` is EXACTLY the same event as no author
    // at all — never a self-nudge, never a second helping of credit.
    for (const kind of EVERY_KIND) {
      const selfAuthored = applySocialEvent(
        act({ kind, author: "ann", third: "cal", witnesses: ["w1", "w2"] }),
        flat(),
      );
      const unauthored = applySocialEvent(
        act({ kind, third: "cal", witnesses: ["w1", "w2"] }),
        flat(),
      );
      expect(selfAuthored).toEqual(unauthored);
    }
  });

  it("⚖️ LAW ② the ACTOR earns affinity, the AUTHOR earns trust/authority — never crossed", () => {
    const out = applySocialEvent(act({ kind: "help", author: "zed", witnesses: ["cal"] }), flat());
    expect(edge(out, "ben", "zed")!.affinity).toBeUndefined(); // the author is not LIKED for it
    expect(edge(out, "cal", "ann")!.trust).toBeUndefined(); // the actor is not TRUSTED for it
    const done = applySocialEvent(act({ kind: "order-done", author: "zed", witnesses: ["cal"] }), flat());
    expect(done.nudges.every((n) => n.subject === "zed")).toBe(true); // all credit flows to the author
  });

  it("🚨 LAW ③ an order-done by route 'C' writes NO authority anywhere", () => {
    const out = applySocialEvent(
      act({ kind: "order-done", author: "zed", route: "C", witnesses: ["cal"] }),
      flat(),
    );
    expect(out.nudges.every((n) => n.delta.authority === undefined)).toBe(true);
    expect(edge(out, "ann", "zed")).toEqual({ affinity: -0.02 });
    // …and the witnesses still saw the job get done.
    expect(edge(out, "cal", "zed")).toEqual({ trust: 0.02 });
  });

  it("⚖️ LAW ④ witnesses beyond WITNESS_CAP are dropped from the FAR end (nearest first)", () => {
    expect(WITNESS_CAP).toBe(6);
    const crowd = ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8"];
    const out = applySocialEvent(act({ kind: "praise", witnesses: crowd }), flat());
    const learned = out.nudges.filter((n) => n.observer !== "ben").map((n) => n.observer);
    expect(learned).toEqual(crowd.slice(0, WITNESS_CAP));
    // The cap is overridable per call (the host may know a tighter scope).
    const tight = applySocialEvent(act({ kind: "praise", witnesses: crowd }), flat(), { witnessCap: 2 });
    expect(tight.nudges.filter((n) => n.observer !== "ben")).toHaveLength(2);
  });

  it("⚖️ LAW ④ a bystander learns LESS than a party (WITNESS_FRACTION of the largest party edge)", () => {
    // `order-refused` is the one act with no party edge at all — a public
    // refusal's whole cost is the standing credit — so it is not in this loop.
    const parties = ["ann", "ben", "zed"];
    for (const kind of EVERY_KIND.filter((k) => k !== "order-refused" && k !== "attend")) {
      const out = applySocialEvent(
        act({ kind, author: "zed", third: "cal", witnesses: ["w1", "w2"] }),
        flat(),
      );
      const partyMax = biggest(out.nudges.filter((n) => parties.includes(n.observer)).map((n) => n.delta));
      const witMax = biggest(out.nudges.filter((n) => n.observer.startsWith("w")).map((n) => n.delta));
      expect(witMax).toBeLessThanOrEqual(WITNESS_FRACTION * partyMax + 1e-9);
    }
  });

  it("a party that is ALSO listed as a witness never collects twice", () => {
    const out = applySocialEvent(act({ kind: "praise", witnesses: ["ann", "ben", "ben", "cal"] }), flat());
    expect(out.nudges.filter((n) => n.observer === "cal")).toHaveLength(1);
    expect(out.nudges.filter((n) => n.observer === "ann")).toHaveLength(0);
    expect(out.nudges.filter((n) => n.observer === "ben")).toHaveLength(1); // the party edge only
  });

  it("attend is SYMMETRIC and moves nothing by more than ±0.03", () => {
    const out = applySocialEvent(act({ kind: "attend", witnesses: ["cal"] }), flat());
    expect(edge(out, "ann", "ben")).toEqual(edge(out, "ben", "ann"));
    expect(biggest(out.nudges.map((n) => n.delta))).toBeLessThanOrEqual(0.03);
  });

  it("is a pure function — the same act twice is the same outcome", () => {
    const a = act({ kind: "yield", route: "L", author: "zed", witnesses: ["cal", "dee"] });
    expect(applySocialEvent(a, flat())).toEqual(applySocialEvent(a, flat()));
  });

  it("a delta that CLAMPS to nothing is not emitted as a zero edge", () => {
    // Authority already 0 ⇒ order-failed's −0.04 has nowhere to go.
    const floorBook = flat(makeRelation({ authority: 0, trust: 0.5 }));
    const out = applySocialEvent(act({ kind: "order-failed", author: "zed" }), floorBook);
    expect(out.nudges[0]!.delta.authority).toBeUndefined();
    expect(out.nudges[0]!.delta.trust).toBeCloseTo(-0.02);
  });
});

// ---------------------------------------------------------------------------
// ③ FACTS — the yield publishes a regard
// ---------------------------------------------------------------------------

describe("the regard facts a yield publishes", () => {
  it("reach BOTH PARTIES and EVERY witness, and say what the route says", () => {
    const wit = ["cal", "dee"];
    const earned = applySocialEvent(act({ kind: "yield", route: "L", witnesses: wit }), flat());
    expect(earned.facts.map((f) => f.viewer)).toEqual(["ann", "ben", ...wit]);
    for (const f of earned.facts) {
      expect(f.fact).toEqual({ kind: "regard", observer: "ann", subject: "ben", sentiment: "respect" });
    }
    const coerced = applySocialEvent(act({ kind: "yield", route: "C", witnesses: wit }), flat());
    expect(coerced.facts.every((f) => f.fact.kind === "regard" && f.fact.sentiment === "fear")).toBe(true);
  });

  it("respect the witness cap", () => {
    const crowd = ["w1", "w2", "w3", "w4", "w5", "w6", "w7"];
    const out = applySocialEvent(act({ kind: "yield", witnesses: crowd }), flat());
    expect(out.facts).toHaveLength(2 + WITNESS_CAP);
  });

  it("no other act publishes a fact this round", () => {
    for (const kind of EVERY_KIND.filter((k) => k !== "yield")) {
      const out = applySocialEvent(act({ kind, author: "zed", third: "cal", witnesses: ["w1"] }), flat());
      expect(out.facts).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// ④ CREDITS — the act-by-another needs (S-3)
// ---------------------------------------------------------------------------

describe("attend's credits — a social need is met by the PARTNER's own attitude", () => {
  const seekerAttends = (partnerToSeeker: Relation): SocialOutcome =>
    applySocialEvent(act({ kind: "attend" }), (observer) =>
      observer === "ben" ? partnerToSeeker : DEFAULT_RELATION,
    );

  it("company alone clears `social` for both and NOTHING else", () => {
    const out = seekerAttends(DEFAULT_RELATION);
    expect(out.credits.map((c) => c.key)).toEqual(["social", "social"]);
  });

  it("STANDING clears only when the partner actually DEFERS (STANDING_DEFER_AT)", () => {
    expect(STANDING_DEFER_AT).toBe(0.35);
    const respectful = makeRelation({ trust: 0.9, authority: 0.9, affinity: 0 });
    expect(deference(respectful)).toBeGreaterThanOrEqual(STANDING_DEFER_AT);
    const out = seekerAttends(respectful);
    expect(out.credits).toContainEqual({ cid: "ann", key: "standing", levelAfter: 0 });
    // …and never for the partner: being talked AT is not being looked up to.
    expect(out.credits.filter((c) => c.cid === "ben" && c.key === "standing")).toEqual([]);
  });

  it("SECURITY clears only when the partner LIKES the seeker", () => {
    const ally = makeRelation({ affinity: 0.5 });
    expect(seekerAttends(ally).credits).toContainEqual({ cid: "ann", key: "security", levelAfter: 0 });
    const cool = makeRelation({ affinity: 0.29 });
    expect(seekerAttends(cool).credits.some((c) => c.key === "security")).toBe(false);
  });

  it("`opts.mood` is READ — the partner's temperament decides whether it defers", () => {
    // A relation just under the bar on its own…
    const rel = makeRelation({ trust: 0.5, authority: 0.2 });
    const hasStanding = (out: SocialOutcome) => out.credits.some((c) => c.key === "standing");
    expect(deference(rel)).toBeLessThan(STANDING_DEFER_AT);
    expect(hasStanding(applySocialEvent(act({ kind: "attend" }), flat(rel)))).toBe(false);
    // …clears it when the partner is the sort that defers to anyone.
    expect(
      hasStanding(
        applySocialEvent(act({ kind: "attend" }), flat(rel), {
          mood: () => personalityFromPreset("drone"),
        }),
      ),
    ).toBe(true);
    // The mood is asked about the PARTNER, not the seeker.
    const asked: string[] = [];
    applySocialEvent(act({ kind: "attend" }), flat(rel), {
      mood: (cid) => {
        asked.push(cid);
        return NEUTRAL_PERSONALITY;
      },
    });
    expect(asked).toEqual(["ben"]);
  });
});
