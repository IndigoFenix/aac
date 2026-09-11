// MEANS-ENDS — the schema vocabulary and its three validators
// (`shared/world-engine/kernel/means-ends.ts`; emergent-plans-round.md D1/D4).
//
// Four properties are load-bearing and each gets its own block:
//
//   ① `validateOperators` NEVER THROWS — it REPORTS. A cyclic schema is a
//      finding, not an explosion, because this is the function a boot or a test
//      asks "is my schema sane?".
//   ② `depthOf` is TOPOLOGICAL DISTANCE FROM THE ROOT, deepest route wins —
//      that is what "most downstream link" means to a cascade decider.
//   ③ `frontier` is the doc's §1 rule in one line (effect missing, needs met),
//      ordered ROOT-NEAREST FIRST with ties in SCHEMA ORDER — FIRST-WINS, the
//      property the contribute cascade's seat proof depends on.
//   ④ THE DEPTH CAP THROWS. §5's "bounded" invariant had no implementation at
//      all before this module (Scout C: no maxDepth constant exists anywhere
//      under shared/world-engine); a recursive schema is a bug and must never
//      come back as a silently truncated plan.
//
// Pure — no DB, no host, no world. `npm run test:engine`.

import { describe, it, expect } from "@jest/globals";
import {
  depthOf,
  frontier,
  validateOperators,
  MAX_MEANS_ENDS_DEPTH,
  type Operator,
} from "@shared/world-engine/kernel/means-ends.js";
import { OPERATOR_GRAPH } from "@shared/world-engine/interaction/behavior/action-planner.js";

// ═══════════════════════════════════════════════════════════════════════════
// The toy schema — a THREE-RUNG chain with one OR-pair and one diamond, so the
// tie-break and the deepest-route rule both have something to say.
// ═══════════════════════════════════════════════════════════════════════════
//
//   cook  achieves fed     needs [held, hot]
//   grab  achieves held    needs [beside]
//   walk  achieves beside  needs []
//   fire  achieves hot     needs [held]          ← the diamond: `held` twice,
//   buy   achieves held    needs []                at depth 1 and at depth 3

type K = "fed" | "held" | "beside" | "hot";
type L = "cook" | "grab" | "walk" | "fire" | "buy";

const TOY: readonly Operator<K, L>[] = [
  { link: "cook", achieves: "fed", needs: ["held", "hot"] },
  { link: "grab", achieves: "held", needs: ["beside"] },
  { link: "walk", achieves: "beside", needs: [] },
  { link: "fire", achieves: "hot", needs: ["held"] },
  { link: "buy", achieves: "held", needs: [] },
];

describe("① validateOperators — the three structural questions, and it never throws", () => {
  it("an acyclic schema reports acyclic, its longest chain in ROWS, and nothing unreachable", () => {
    const r = validateOperators(TOY);
    expect(r.acyclic).toBe(true);
    // cook → fire → grab → walk is four rows deep (the diamond's long side).
    expect(r.longestPath).toBe(4);
    expect(r.unreachable).toEqual([]);
  });

  it("a kind nobody achieves is reported UNREACHABLE — a schema's primitive facts", () => {
    // `seat` is the shape a cascade row's non-producible precondition has.
    const withSeat: readonly Operator<"built" | "staged" | "seat", "build" | "haul">[] = [
      { link: "build", achieves: "built", needs: ["staged", "seat"] },
      { link: "haul", achieves: "staged", needs: [] },
    ];
    const r = validateOperators(withSeat);
    expect(r.acyclic).toBe(true);
    expect(r.unreachable).toEqual(["seat"]);
  });

  it("a CYCLE comes back reported, not thrown (and the longest SIMPLE chain with it)", () => {
    const cyclic: readonly Operator<"a" | "b", "toA" | "toB">[] = [
      { link: "toA", achieves: "a", needs: ["b"] },
      { link: "toB", achieves: "b", needs: ["a"] },
    ];
    let r: ReturnType<typeof validateOperators<"a" | "b", "toA" | "toB">> | undefined;
    expect(() => {
      r = validateOperators(cyclic);
    }).not.toThrow();
    expect(r!.acyclic).toBe(false);
    expect(r!.longestPath).toBe(2); // a → b, and the repeat stops there
  });

  it("a SELF-NEEDING row is a cycle of one", () => {
    const self: readonly Operator<"x", "loop">[] = [{ link: "loop", achieves: "x", needs: ["x"] }];
    expect(validateOperators(self).acyclic).toBe(false);
  });

  it("an EMPTY schema is vacuously fine", () => {
    expect(validateOperators([])).toEqual({ acyclic: true, longestPath: 0, unreachable: [] });
  });
});

describe("② depthOf — topological distance from the ROOT, deepest route wins", () => {
  it("the toy schema's links rank by how far downstream of `fed` they sit", () => {
    // `held` is needed BOTH by `cook` (depth 1) and by `fire` (depth 2), so it
    // is depth 2 and everything under it shifts with it: "most downstream" is
    // the longest way the goal can need you, not the shortest.
    expect(depthOf(TOY, "fed")).toEqual({ cook: 0, fire: 1, grab: 2, buy: 2, walk: 3 });
  });

  it("a link OUTSIDE the root's tree is absent, never zero", () => {
    const ops: readonly Operator<K | "sung", L | "sing">[] = [
      ...(TOY as readonly Operator<K | "sung", L | "sing">[]),
      { link: "sing", achieves: "sung", needs: [] },
    ];
    const d = depthOf(ops, "fed");
    expect("sing" in d).toBe(false);
    expect(d.cook).toBe(0);
  });

  it("TWO ROWS, ONE LINK ⇒ the DEEPEST of them (a rank still means most-downstream)", () => {
    // The cascade's two `fell` provenances are one link reached two ways.
    const two: readonly Operator<"built" | "staged" | "raw", "build" | "haul" | "fell">[] = [
      { link: "build", achieves: "built", needs: ["staged"] },
      { link: "haul", achieves: "staged", needs: ["raw"] },
      { link: "fell", achieves: "staged", needs: [] }, // shallow provenance
      { link: "fell", achieves: "raw", needs: [] }, // deep provenance
    ];
    expect(depthOf(two, "built")).toEqual({ build: 0, haul: 1, fell: 2 });
  });
});

describe("③ frontier — effect missing, needs met; root-nearest first, ties FIRST-WINS", () => {
  const nothing = () => false;

  it("with nothing true, only the LEAVES can act — and the schema order breaks the tie", () => {
    // `walk` (depth 3) and `buy` (depth 2) both have empty needs. Root-nearest
    // is `buy`; schema order never gets a say here because the depths differ.
    expect(frontier(TOY, "fed", nothing)).toEqual(["buy", "walk"]);
  });

  it("a satisfied precondition opens the rung above it, and the deeper rung retires", () => {
    // Standing beside the thing: `walk`'s effect now HOLDS (so it drops out) and
    // `grab` becomes available beside `buy`.
    const holds = (k: K) => k === "beside";
    expect(frontier(TOY, "fed", holds)).toEqual(["grab", "buy"]);
  });

  it("TIES ARE FIRST-WINS — same depth, schema order decides", () => {
    // `grab` and `buy` are both depth 2 and both available; `grab` is the
    // earlier ROW, so it leads. Reversing the rows reverses the answer, which
    // is the property a decider reading `[0]` depends on.
    const holds = (k: K) => k === "beside";
    expect(frontier(TOY, "fed", holds)[0]).toBe("grab");
    const swapped = [TOY[4]!, TOY[0]!, TOY[1]!, TOY[2]!, TOY[3]!] as readonly Operator<K, L>[];
    expect(frontier(swapped, "fed", holds)[0]).toBe("buy");
  });

  it("when everything holds the frontier is EMPTY — there is nothing left to do", () => {
    expect(frontier(TOY, "fed", () => true)).toEqual([]);
  });

  it("`holds` is asked at most ONCE per kind (an expensive world read is one lookup)", () => {
    const asked: string[] = [];
    frontier(TOY, "fed", (k) => {
      asked.push(k);
      return false;
    });
    expect(asked.length).toBe(new Set(asked).size);
  });
});

describe("④ the depth cap THROWS — a recursive schema is a bug, never a truncated plan", () => {
  it("MAX_MEANS_ENDS_DEPTH is 6 and is the default bound", () => {
    expect(MAX_MEANS_ENDS_DEPTH).toBe(6);
  });

  it("a cyclic schema throws out of depthOf rather than looping forever", () => {
    const cyclic: readonly Operator<"a" | "b", "toA" | "toB">[] = [
      { link: "toA", achieves: "a", needs: ["b"] },
      { link: "toB", achieves: "b", needs: ["a"] },
    ];
    expect(() => depthOf(cyclic, "a")).toThrow(/maxDepth/);
    expect(() => frontier(cyclic, "a", () => false)).toThrow(/maxDepth/);
  });

  it("a straight chain LONGER than the cap throws, and one AT the cap does not", () => {
    // n+1 kinds, k0 ← k1 ← … ← kn: the deepest kind sits at depth n.
    const chain = (n: number): readonly Operator<string, string>[] =>
      Array.from({ length: n }, (_, i) => ({ link: `l${i}`, achieves: `k${i}`, needs: [`k${i + 1}`] }));
    expect(() => depthOf(chain(MAX_MEANS_ENDS_DEPTH), "k0")).not.toThrow();
    expect(() => depthOf(chain(MAX_MEANS_ENDS_DEPTH + 1), "k0")).toThrow(/maxDepth/);
  });

  it("an explicit smaller maxDepth bites first", () => {
    expect(() => depthOf(TOY, "fed", { maxDepth: 2 })).toThrow(/maxDepth 2/);
    expect(() => depthOf(TOY, "fed", { maxDepth: 3 })).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE SHIPPED T1 SCHEMA — the planner's own arms, as data (D3/D4)
// ═══════════════════════════════════════════════════════════════════════════

describe("OPERATOR_GRAPH — the planner's schema is acyclic and exactly 3 rows deep", () => {
  it("validateOperators proves what the module header has only ever asserted", () => {
    const r = validateOperators(OPERATOR_GRAPH);
    expect(r.acyclic).toBe(true);
    // `in|possessed|consumed|facet|worn|colored → holding → near` — the header's
    // "depth ≤ 3", measured instead of claimed (action-planner.ts:16-17).
    expect(r.longestPath).toBe(3);
    // Every predicate any arm regresses has an arm of its own; nothing dangles.
    expect(r.unreachable).toEqual([]);
  });

  it("ONE ROW PER PREDICATE KIND — the switch is closed and so is the table", () => {
    const kinds = OPERATOR_GRAPH.map((o) => o.achieves);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds.length).toBe(20);
  });

  it("only `holding` and `near` are ever regressed into — the whole chain, in one line", () => {
    const needed = new Set(OPERATOR_GRAPH.flatMap((o) => [...o.needs]));
    expect([...needed].sort()).toEqual(["holding", "near"]);
  });

  it("the item family's frontier from `consumed` is the walk, then the pick, then the eat", () => {
    // Nothing true: only the leaves can act, and `near` is the nearest of them.
    // …and `moveTo` appears ONCE, not twice: it is the link of both the `at`
    // and the `near` arm, and only `near` is in a consume's tree.
    expect(frontier(OPERATOR_GRAPH, "consumed", () => false)).toEqual(["moveTo"]);
    // Beside it: the pick opens. Holding it: only the eat is left.
    expect(frontier(OPERATOR_GRAPH, "consumed", (k) => k === "near")).toEqual(["pick"]);
    expect(frontier(OPERATOR_GRAPH, "consumed", (k) => k === "near" || k === "holding")).toEqual(["eat"]);
  });
});
