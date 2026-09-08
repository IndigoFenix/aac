// THE `regard` FACT (politics-substrate-round.md S-2; interpersonal-politics.md
// §2e, M3) — how one creature regards another, as a thing that can be SEEN, TOLD
// and REPEATED. Reputation is these facts plus the directed book; there is no
// `reputation: number` anywhere, and this suite is where that stays true.
//
// Pure logic — no DB / LLM / GL / host.

import { describe, it, expect } from "@jest/globals";
import {
  createCreatureWorld,
  type CreatureWorld,
} from "@shared/world-engine/interaction/behavior/creatures.js";
import {
  factKey,
  knowsFact,
  perceiveFact,
  priorFromRegard,
  regardFacts,
  regardSentimentOf,
  REGARD_TELL_AT,
  tellFact,
  type Fact,
  type RegardFact,
} from "@shared/world-engine/interaction/behavior/facts.js";
import {
  DEFAULT_RELATION,
  makeRelation,
} from "@shared/world-engine/interaction/behavior/relations.js";

function makeWorld(): CreatureWorld {
  return createCreatureWorld(
    [{ id: "mara" }, { id: "orrin" }, { id: "pip" }, { id: "player" }],
    [{ id: "ball_1", kind: "ball", category: "toy" }],
  );
}

const regard = (observer: string, subject: string, sentiment: RegardFact["sentiment"]): RegardFact => ({
  kind: "regard",
  observer,
  subject,
  sentiment,
});

// ---------------------------------------------------------------------------
// ① The key
// ---------------------------------------------------------------------------

describe("factKey — one belief per OBSERVER/SUBJECT pair", () => {
  it("is `regard:<observer>:<subject>`", () => {
    expect(factKey(regard("mara", "pip", "like"))).toBe("regard:mara:pip");
  });

  it("keys two observers of the SAME subject apart (a shared key would erase one)", () => {
    expect(factKey(regard("mara", "pip", "like"))).not.toBe(factKey(regard("orrin", "pip", "fear")));
  });

  it("is DIRECTED — what Mara thinks of Pip is not what Pip thinks of Mara", () => {
    expect(factKey(regard("mara", "pip", "like"))).not.toBe(factKey(regard("pip", "mara", "like")));
  });
});

// ---------------------------------------------------------------------------
// ② The channel — perceive = tell, latest wins
// ---------------------------------------------------------------------------

describe("perceiveFact / tellFact carry a regard with no change to the channel", () => {
  it("writes the belief and fires fact-learned once", () => {
    const w = makeWorld();
    const f = regard("mara", "pip", "like");
    expect(perceiveFact(w, "orrin", f)).toEqual([{ type: "fact-learned", creatureId: "orrin", fact: f }]);
    expect(perceiveFact(w, "orrin", f)).toEqual([]); // nothing new
  });

  it("a NEWER sentiment about the same pair REPLACES the old belief (latest wins)", () => {
    const w = makeWorld();
    perceiveFact(w, "orrin", regard("mara", "pip", "like"));
    const ev = perceiveFact(w, "orrin", regard("mara", "pip", "dislike"));
    expect(ev).toHaveLength(1);
    expect(regardFacts(w, "orrin")).toEqual([regard("mara", "pip", "dislike")]);
  });

  it("being TOLD writes exactly what SEEING would (the one channel)", () => {
    const w = makeWorld();
    const f = regard("mara", "pip", "respect");
    tellFact(w, "player", f);
    expect(knowsFact(w, "player", { kind: "regard", subject: "pip" })).toEqual(f);
  });
});

// ---------------------------------------------------------------------------
// ③ The query
// ---------------------------------------------------------------------------

describe("knowsFact / regardFacts — the regard query arm", () => {
  function stocked(): CreatureWorld {
    const w = makeWorld();
    perceiveFact(w, "player", regard("mara", "pip", "like"));
    perceiveFact(w, "player", regard("orrin", "pip", "fear"));
    perceiveFact(w, "player", regard("mara", "orrin", "respect"));
    return w;
  }

  it("by SUBJECT", () => {
    expect(regardFacts(stocked(), "player", { subject: "pip" }).map((f) => f.observer).sort()).toEqual([
      "mara",
      "orrin",
    ]);
  });

  it("by OBSERVER", () => {
    expect(regardFacts(stocked(), "player", { observer: "mara" }).map((f) => f.subject).sort()).toEqual([
      "orrin",
      "pip",
    ]);
  });

  it("by SENTIMENT — 'who leader?' is `{ sentiment: \"respect\" }`", () => {
    const hit = knowsFact(stocked(), "player", { kind: "regard", sentiment: "respect" });
    expect(hit).toEqual(regard("mara", "orrin", "respect"));
  });

  it("fields AND together, and a miss is an honest null", () => {
    const w = stocked();
    expect(regardFacts(w, "player", { subject: "pip", sentiment: "fear" })).toEqual([
      regard("orrin", "pip", "fear"),
    ]);
    expect(knowsFact(w, "player", { kind: "regard", subject: "pip", sentiment: "respect" })).toBeNull();
    expect(knowsFact(w, "player", { kind: "regard", subject: "nobody" })).toBeNull();
  });

  it("a creature that was told nothing knows nothing — no truth shortcut here", () => {
    // Unlike `condition`/`itemState`, a body's OWN attitude is NOT in this
    // store: it lives in the host's relation book. Answering from thin air here
    // would be the engine inventing an opinion.
    const w = stocked();
    expect(knowsFact(w, "mara", { kind: "regard", subject: "pip" })).toBeNull();
    expect(regardFacts(w, "mara")).toEqual([]);
  });

  it("is deterministic across insertion orders (sorted keys)", () => {
    const a = makeWorld();
    const b = makeWorld();
    const fs: Fact[] = [
      regard("mara", "pip", "like"),
      regard("orrin", "pip", "fear"),
      regard("mara", "orrin", "respect"),
    ];
    for (const f of fs) perceiveFact(a, "player", f);
    for (const f of [...fs].reverse()) perceiveFact(b, "player", f);
    expect(regardFacts(a, "player")).toEqual(regardFacts(b, "player"));
  });
});

// ---------------------------------------------------------------------------
// ④ regardSentimentOf — naming a relation in one word
// ---------------------------------------------------------------------------

describe("regardSentimentOf — what is worth saying about a relation", () => {
  it("says NOTHING about an ordinary relation (the channel is quiet by default)", () => {
    expect(regardSentimentOf(DEFAULT_RELATION)).toBeNull();
    expect(regardSentimentOf(makeRelation({ affinity: 0.29, authority: 0.29, fear: 0.29 }))).toBeNull();
  });

  it("REGARD_TELL_AT is the bar on every axis, inclusive", () => {
    expect(REGARD_TELL_AT).toBe(0.3);
    expect(regardSentimentOf(makeRelation({ affinity: REGARD_TELL_AT }))).toBe("like");
    expect(regardSentimentOf(makeRelation({ affinity: -REGARD_TELL_AT }))).toBe("dislike");
    expect(regardSentimentOf(makeRelation({ authority: REGARD_TELL_AT }))).toBe("respect");
    expect(regardSentimentOf(makeRelation({ fear: REGARD_TELL_AT }))).toBe("fear");
  });

  it("orders by NEWSWORTHINESS: fear → respect → like → dislike", () => {
    const all = makeRelation({ affinity: 1, authority: 1, fear: 1 });
    expect(regardSentimentOf(all)).toBe("fear");
    expect(regardSentimentOf(makeRelation({ affinity: 1, authority: 1 }))).toBe("respect");
    expect(regardSentimentOf(makeRelation({ affinity: 1 }))).toBe("like");
    expect(regardSentimentOf(makeRelation({ affinity: -1 }))).toBe("dislike");
  });
});

// ---------------------------------------------------------------------------
// ⑤ priorFromRegard — M3, and the hearsay law
// ---------------------------------------------------------------------------

describe("priorFromRegard — what to feel about someone you have never met", () => {
  const fullTrust = () => 1;

  it("🚨 NEVER MOVES `authority` — hearsay cannot manufacture a chief (⚖️ the round's law)", () => {
    const base = makeRelation({ authority: 0.2 });
    for (const s of ["like", "dislike", "fear", "respect"] as const) {
      const out = priorFromRegard(base, [regard("mara", "pip", s)], fullTrust);
      expect(out.authority).toBe(base.authority);
    }
    // Ten voices saying it, all fully trusted, still move nothing.
    const chorus = Array.from({ length: 10 }, (_, i) => regard(`v${i}`, "pip", "respect"));
    expect(priorFromRegard(base, chorus, fullTrust).authority).toBe(base.authority);
  });

  it("respect raises TRUST, not authority — 'people follow them' is evidence about judgment", () => {
    const out = priorFromRegard(DEFAULT_RELATION, [regard("mara", "pip", "respect")], fullTrust);
    expect(out.trust).toBeCloseTo(DEFAULT_RELATION.trust + 0.15);
    expect(out.authority).toBe(0);
  });

  it("like / dislike move affinity; fear moves fear", () => {
    expect(priorFromRegard(DEFAULT_RELATION, [regard("m", "pip", "like")], fullTrust).affinity).toBeCloseTo(0.3);
    expect(priorFromRegard(DEFAULT_RELATION, [regard("m", "pip", "dislike")], fullTrust).affinity).toBeCloseTo(-0.3);
    expect(priorFromRegard(DEFAULT_RELATION, [regard("m", "pip", "fear")], fullTrust).fear).toBeCloseTo(0.2);
  });

  it("is DAMPED BY TRUST IN THE OBSERVER — a stranger's opinion is worth nothing", () => {
    const half = priorFromRegard(DEFAULT_RELATION, [regard("m", "pip", "like")], () => 0.5);
    expect(half.affinity).toBeCloseTo(0.15);
    const none = priorFromRegard(DEFAULT_RELATION, [regard("m", "pip", "like")], () => 0);
    expect(none).toEqual(DEFAULT_RELATION);
    // …and the damping is PER OBSERVER, not per fact.
    const mixed = priorFromRegard(
      DEFAULT_RELATION,
      [regard("trusted", "pip", "like"), regard("nobody", "pip", "dislike")],
      (o) => (o === "trusted" ? 1 : 0),
    );
    expect(mixed.affinity).toBeCloseTo(0.3);
  });

  it("SUMS — three warnings are worse than one", () => {
    const one = priorFromRegard(DEFAULT_RELATION, [regard("a", "pip", "fear")], fullTrust);
    const three = priorFromRegard(
      DEFAULT_RELATION,
      [regard("a", "pip", "fear"), regard("b", "pip", "fear"), regard("c", "pip", "fear")],
      fullTrust,
    );
    expect(three.fear).toBeGreaterThan(one.fear);
    expect(three.fear).toBeCloseTo(0.6);
  });

  it("CLAMPS through makeRelation — a mob cannot push an axis out of range", () => {
    const mob = Array.from({ length: 30 }, (_, i) => regard(`v${i}`, "pip", "like"));
    const out = priorFromRegard(DEFAULT_RELATION, mob, fullTrust);
    expect(out.affinity).toBe(1);
    const dread = Array.from({ length: 30 }, (_, i) => regard(`v${i}`, "pip", "fear"));
    expect(priorFromRegard(DEFAULT_RELATION, dread, fullTrust).fear).toBe(1);
    const hate = Array.from({ length: 30 }, (_, i) => regard(`v${i}`, "pip", "dislike"));
    expect(priorFromRegard(DEFAULT_RELATION, hate, fullTrust).affinity).toBe(-1);
  });

  it("no facts ⇒ the base, untouched (the ordinary case costs nothing)", () => {
    const base = makeRelation({ affinity: 0.4, trust: 0.6, authority: 0.7, fear: 0.1 });
    expect(priorFromRegard(base, [], fullTrust)).toEqual(base);
  });
});
