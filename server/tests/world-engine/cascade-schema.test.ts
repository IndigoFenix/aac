// THE CONTRIBUTE CASCADE, DERIVED — `CASCADE_SCHEMA` and the rank read off it
// (`shared/world-engine/kernel/town/pull-labor.ts`; emergent-plans-round.md
// D3/D8 and the lead's erratum E-7).
//
// WHAT CHANGED, IN ONE SENTENCE: `build → haul → refine → fell` used to be a
// literal table in the reader —
//
//     contribute.ts:456   const LINK_RANK = { build: 0, haul: 1, refine: 2, fell: 3 }
//
// — a CLAIM about a chain that was written down somewhere else. It is now what
// seven `Operator` rows imply. So the pins here are about the SCHEMA, not about
// a number: that the rows form an acyclic chain, that its primitive facts are
// exactly the three the world supplies, that the depths come out as E-7 says,
// that the fold onto the four spoken links SORTS the way the literal did, and
// that a fifth link is added by a DATA ROW and nothing else.
//
//   ① the schema is sane — acyclic, three primitives, five rows deep
//   ② the per-ROW depths (E-7's material: `haul:site` 1 vs `haul:bench` 3)
//   ③ the RANK is ordinally identical to the literal it replaced
//   ④ a link added by DATA — the synthetic `mill` row
//   ⑤ the erratum: the OLD D3 sketch is CYCLIC, and a self-needing row throws
//
// Pure — no DB, no host, no boot, no world. `npm run test:engine -- cascade`.

import { describe, it, expect } from "@jest/globals";
import {
  depthOf,
  frontier,
  validateOperators,
  type Operator,
} from "@shared/world-engine/kernel/means-ends.js";
import {
  CASCADE_ROOT,
  CASCADE_SCHEMA,
  cascadeRank,
  contributeLinkOf,
  type CascadeRowLink,
  type ContributeLink,
  type StockKind,
} from "@shared/world-engine/kernel/town/pull-labor.js";

// ═══════════════════════════════════════════════════════════════════════════
// ① THE SCHEMA IS SANE
// ═══════════════════════════════════════════════════════════════════════════

describe("① CASCADE_SCHEMA — acyclic, with exactly three primitive facts", () => {
  const report = validateOperators(CASCADE_SCHEMA);

  it("is ACYCLIC — the chain terminates, and that is why no runtime counter exists", () => {
    expect(report.acyclic).toBe(true);
  });

  it("its UNREACHABLE kinds are exactly the world's own three — `loose`, `seat`, `standing`", () => {
    // ⚖️ "Unreachable" here is not a defect: it is the list of facts NO LINK
    // MAKES TRUE, i.e. the schema's primitives. A tree grows, a bay is raised
    // by the director's labour arithmetic, and the world drops a loose thing —
    // none of those is a contribution a body can decide to make. Anything ELSE
    // appearing in this list would be a missing operator.
    expect(report.unreachable).toEqual(["loose", "seat", "standing"]);
  });

  it("is FIVE ROWS DEEP, as built", () => {
    // Quoted as measured, not as designed: `build → haul:site → refine →
    // haul:bench → fell` is the longest chain of rows from the root, and
    // `longestPath` counts ROWS. (D4's prose said "3 links below `built`",
    // which was the pre-erratum sketch with one `sourceFree` kind; splitting it
    // into `refinedFree`/`rawFree` is what makes the wood haul its own rung.)
    expect(report.longestPath).toBe(5);
    // …and comfortably inside the traversal cap, which is what lets `depthOf`
    // run below without a bound of its own.
    expect(report.longestPath).toBeLessThan(6);
  });

  it("every row's kinds are PREDICATES, never a good's head", () => {
    // PRIMITIVES-ONLY, asserted the only way a test can: the kind vocabulary is
    // closed and none of it names a thing. A row that said `"block"` or
    // `"wood"` would have to widen this list to pass.
    const kinds: readonly StockKind[] = [
      "built",
      "staged",
      "refinedFree",
      "stocked",
      "rawFree",
      "standing",
      "seat",
      "loose",
    ];
    for (const op of CASCADE_SCHEMA) {
      expect(kinds).toContain(op.achieves);
      for (const need of op.needs) expect(kinds).toContain(need);
    }
    expect(CASCADE_ROOT).toBe("built");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ② THE PER-ROW DEPTHS — E-7's material, pinned as data
// ═══════════════════════════════════════════════════════════════════════════

describe("② depthOf — the distance of every ROW from `built`", () => {
  it("is the E-7 table, exactly", () => {
    // 🚨 THE TWO HAULS ARE THREE RUNGS APART, and that is the whole reason the
    // rows carry distinct ids. Blocks onto the site pile sit one rung below the
    // finished house; raw timber onto the bench sits three, because two more
    // actions (refine, then the site haul) stand between it and `built`.
    expect(depthOf(CASCADE_SCHEMA, CASCADE_ROOT)).toEqual({
      build: 0,
      "haul:site": 1,
      collect: 1,
      refine: 2,
      "haul:bench": 3,
      fell: 4,
      "fell:mark": 4,
    });
  });

  it("the two FELL rows share a depth — one link, two provenances", () => {
    const d = depthOf(CASCADE_SCHEMA, CASCADE_ROOT);
    expect(d.fell).toBe(d["fell:mark"]);
  });

  it("`collect` sits beside the site haul — it fills the same pile from a primitive", () => {
    const d = depthOf(CASCADE_SCHEMA, CASCADE_ROOT);
    expect(d.collect).toBe(d["haul:site"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ THE RANK — ordinally identical to the literal it replaced
// ═══════════════════════════════════════════════════════════════════════════

describe("③ cascadeRank — the sort key, folded by MIN onto the four spoken links", () => {
  /** 🚨 THE PIN'S REASON, QUOTED: this is `contribute.ts:456` as it shipped
   *  before the derivation, and it is the ONLY thing the derived record has to
   *  agree with. The rank is used at exactly one place — the first term of
   *  `visibleBills`' comparator — so what must survive is the ORDER, not the
   *  integers. `{0,1,2,4}` and `{0,1,2,3}` are one order. */
  const OLD_LITERAL: Record<ContributeLink, number> = { build: 0, haul: 1, refine: 2, fell: 3 };
  const LINKS: readonly ContributeLink[] = ["build", "haul", "refine", "fell"];

  it("SORTS IDENTICALLY to the old literal — every pair, both directions", () => {
    const derived = cascadeRank();
    for (const a of LINKS) {
      for (const b of LINKS) {
        expect(Math.sign(derived[a] - derived[b])).toBe(Math.sign(OLD_LITERAL[a] - OLD_LITERAL[b]));
      }
    }
    // …and the same read the comparator itself performs: shuffle the four and
    // sort them by each record. Same list.
    const shuffled: ContributeLink[] = ["fell", "build", "refine", "haul"];
    const byDerived = [...shuffled].sort((x, y) => derived[x] - derived[y]);
    const byLiteral = [...shuffled].sort((x, y) => OLD_LITERAL[x] - OLD_LITERAL[y]);
    expect(byDerived).toEqual(byLiteral);
    expect(byDerived).toEqual(["build", "haul", "refine", "fell"]);
  });

  it("is the MIN over each link's rows, and `fell` therefore reads 4 where the literal said 3", () => {
    // The one place derived and literal differ, stated openly. `depthOf` folds
    // a shared link to its DEEPEST row (P's ruling), which for "haul" would
    // give 3 — the OPPOSITE of what "most downstream link the body can serve"
    // means when a body standing at the site pile is one rung from the house.
    // So the fold is MIN, here, in the file that owns the four names.
    expect(cascadeRank()).toEqual({ build: 0, haul: 1, refine: 2, fell: 4 });
    const rows = depthOf(CASCADE_SCHEMA, CASCADE_ROOT);
    expect(Math.min(rows["haul:site"], rows["haul:bench"], rows.collect)).toBe(cascadeRank().haul);
  });

  it("every ROW folds onto a spoken link, and every spoken link has a row", () => {
    const rows: readonly CascadeRowLink[] = [
      "build",
      "haul:site",
      "refine",
      "haul:bench",
      "fell",
      "fell:mark",
      "collect",
    ];
    expect(rows.map(contributeLinkOf)).toEqual([
      "build",
      "haul",
      "refine",
      "haul",
      "fell",
      "fell",
      "haul",
    ]);
    // The schema's own rows are exactly that list, in that order — the order IS
    // the FIRST-WINS tie-break every consumer honours.
    expect(CASCADE_SCHEMA.map((op) => op.link)).toEqual(rows);
    expect(new Set(rows.map(contributeLinkOf))).toEqual(new Set(LINKS));
  });

  it("is PURE — same answer every call, and no world is read", () => {
    expect(cascadeRank()).toEqual(cascadeRank());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ A LINK ADDED BY DATA — the synthetic `mill` row (D8's own proof)
// ═══════════════════════════════════════════════════════════════════════════

describe("④ a fifth link is one ROW — the synthetic `mill`", () => {
  type MillLink = CascadeRowLink | "mill";
  /** `mill achieves stocked needs [standing]` — a second way to stock a bench
   *  (cut straight into it), inserted BESIDE `haul:bench`. Nothing else edited:
   *  no reader, no decider, no rank literal. */
  const WITH_MILL: readonly Operator<StockKind, MillLink>[] = [
    ...CASCADE_SCHEMA.slice(0, 4),
    { link: "mill", achieves: "stocked", needs: ["standing"] },
    ...CASCADE_SCHEMA.slice(4),
  ];

  it("the schema stays sane with it", () => {
    const report = validateOperators(WITH_MILL);
    expect(report.acyclic).toBe(true);
    expect(report.unreachable).toEqual(["loose", "seat", "standing"]);
  });

  it("`depthOf` ADMITS IT AT 3 and moves nothing else", () => {
    const before = depthOf(CASCADE_SCHEMA, CASCADE_ROOT);
    const after = depthOf(WITH_MILL, CASCADE_ROOT);
    expect(after.mill).toBe(3);
    // ⚖️ MEASURED, NOT ASSUMED. D8 predicted the new row would "shift the
    // ranks" — that was true of the PRE-ERRATUM sketch, where nothing else
    // achieved `stocked` and `fell` therefore moved. Under E-7's split kinds
    // `haul:bench` already stands at 3, so the honest result is that the record
    // GAINS a link and every existing depth is untouched. That is the stronger
    // property anyway: a data row cannot silently re-price the shipped chain.
    for (const row of Object.keys(before) as CascadeRowLink[]) {
      expect(after[row]).toBe(before[row]);
    }
  });

  it("`frontier` PICKS IT when `stocked` is false and `standing` is true", () => {
    const holds = (k: StockKind): boolean => k === "standing";
    // The bench is empty, the trees are up: the frontier is the mill (depth 3)
    // ahead of the two fell rows (depth 4), root-nearest first.
    expect(frontier(WITH_MILL, CASCADE_ROOT, holds)).toEqual(["mill", "fell", "fell:mark"]);
    // …and without the row, the same world offers only the felling.
    expect(frontier(CASCADE_SCHEMA, CASCADE_ROOT, holds)).toEqual(["fell", "fell:mark"]);
  });

  it("the SHIPPED schema's frontier is the cascade rule itself", () => {
    // A staged site with a free seat: the only thing to do is build.
    expect(
      frontier(CASCADE_SCHEMA, CASCADE_ROOT, (k) => k === "staged" || k === "seat"),
    ).toEqual(["build"]);
    // Nothing staged, but finished material stands in reach: haul it.
    expect(
      frontier(CASCADE_SCHEMA, CASCADE_ROOT, (k) => k === "refinedFree" || k === "seat"),
    ).toEqual(["haul:site"]);
    // Nothing in reach but a stocked bench: mill it — the deeper row surfaces
    // only because the shallower one's input is missing, which is exactly how
    // "the most downstream link whose input is available" used to be spelled.
    expect(
      frontier(CASCADE_SCHEMA, CASCADE_ROOT, (k) => k === "stocked" || k === "seat"),
    ).toEqual(["refine"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ THE ERRATUM — why the ledger's first sketch could not be built
// ═══════════════════════════════════════════════════════════════════════════

describe("⑤ the erratum (E-7) — ONE `sourceFree` kind makes the real chain CYCLIC", () => {
  type OldKind = "built" | "staged" | "sourceFree" | "stocked" | "seat";
  type OldLink = "build" | "haul" | "refine" | "haul:raw";

  /** D3's T2 sketch, with the raw haul the real world also has. `haul` NEEDS
   *  `sourceFree`, `refine` ACHIEVES it from `stocked`, and the haul that fills
   *  the bench needs `sourceFree` again — a loop through three rows. */
  const D3_SKETCH: readonly Operator<OldKind, OldLink>[] = [
    { link: "build", achieves: "built", needs: ["staged", "seat"] },
    { link: "haul", achieves: "staged", needs: ["sourceFree"] },
    { link: "refine", achieves: "sourceFree", needs: ["stocked", "seat"] },
    { link: "haul:raw", achieves: "stocked", needs: ["sourceFree"] },
  ];

  it("`validateOperators` REPORTS it cyclic — it does not throw", () => {
    const report = validateOperators(D3_SKETCH);
    expect(report.acyclic).toBe(false);
    // The report is still usable: a cyclic schema's `longestPath` is its
    // longest SIMPLE chain, and its primitives still read out.
    expect(report.unreachable).toEqual(["seat"]);
  });

  it("…and `depthOf` THROWS on it, which is how the cap catches a loop", () => {
    expect(() => depthOf(D3_SKETCH, "built")).toThrow(/exceeds maxDepth/);
  });

  it("a SELF-NEEDING row throws — the degenerate case of the same bug", () => {
    const SELF: readonly Operator<"a" | "b", "x" | "y">[] = [
      { link: "x", achieves: "a", needs: ["b"] },
      { link: "y", achieves: "b", needs: ["b"] },
    ];
    expect(() => depthOf(SELF, "a")).toThrow(/means-ends/);
    expect(validateOperators(SELF).acyclic).toBe(false);
  });

  it("the SHIPPED schema does none of this — it is the erratum's fix", () => {
    expect(() => depthOf(CASCADE_SCHEMA, CASCADE_ROOT)).not.toThrow();
    expect(validateOperators(CASCADE_SCHEMA).acyclic).toBe(true);
  });
});
