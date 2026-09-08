// THE REGARD FOLD at the pure layer (politics-substrate round, F-1) — what a
// four-axis directed relation book BECOMES when its household demotes to a
// statistic, and what comes back out when the statistic becomes people again.
//
// The load-bearing sentence is the ROUND-TRIP LAW: folding what the unfold
// produced must give back the prior it was produced from. The field is the
// memory, and people do not flicker — determinism is a pin, not a hope.
//
// A `RegardPrior` is NOT a reputation score: it is a folded prior on a scope,
// held only while that scope is a statistic. Nothing here reads one per
// creature and nothing stores one on a body.
//
// No DOM / GL / host.

import { describe, it, expect } from "@jest/globals";
import {
  DEFAULT_RELATION,
  makeRelation,
  type Relation,
} from "@shared/world-engine/interaction/behavior/relations.js";
import {
  PIN_EPS,
  REGARD_BAND,
  foldRegard,
  regardDeviation,
  unfoldRegard,
  type RegardPrior,
} from "@shared/world-engine/kernel/town/regard-prior.js";

const rel = (
  affinity: number,
  trust: number,
  authority: number,
  fear: number,
): Relation => makeRelation({ affinity, trust, authority, fear });

/** The fold form written out independently of the module, so the pins measure
 *  the implementation rather than quoting it. */
const formOf = (r: Relation): number =>
  0.5 * r.affinity + (0.25 * (r.trust - 0.3)) / 0.7 + 0.25 * r.authority - 0.5 * r.fear;

const GRID_REGARDS = [-1, -0.5, 0, 0.3, 0.6, 1] as const;
const ROUTES = ["prestige", "dominance"] as const;
const inBand = (regard: number, route: RegardPrior["route"]): boolean => {
  const [lo, hi] = REGARD_BAND[route];
  return regard >= lo && regard <= hi;
};

// ---------------------------------------------------------------------------

describe("foldRegard — many books toward one subject become one prior", () => {
  it("an empty set has NO prior (never-met is not indifference)", () => {
    expect(foldRegard([])).toBeNull();
  });

  it("a stranger's default book folds to exactly zero regard, prestige route", () => {
    const p = foldRegard([DEFAULT_RELATION]);
    expect(p).not.toBeNull();
    expect(p!.regard).toBeCloseTo(0, 12);
    expect(p!.route).toBe("prestige");
    expect(p!.n).toBe(1);
  });

  it("is the mean of the form over the rows", () => {
    const rows = [rel(0.4, 0.8, 0.2, 0), rel(-0.2, 0.3, 0, 0.1), rel(0.9, 0.5, 0.6, 0)];
    const want = rows.reduce((s, r) => s + formOf(r), 0) / rows.length;
    expect(foldRegard(rows)!.regard).toBeCloseTo(want, 12);
  });

  it("drops non-finite rows and counts only the survivors", () => {
    const bad = { affinity: NaN, trust: 0.5, authority: 0, fear: 0 } as Relation;
    const worse = { affinity: 0.2, trust: 0.5, authority: Infinity, fear: 0 } as Relation;
    const good = rel(0.4, 0.8, 0.2, 0);
    const p = foldRegard([bad, good, worse]);
    expect(p!.n).toBe(1);
    expect(p!.regard).toBeCloseTo(formOf(good), 12);
    expect(Number.isFinite(p!.regard)).toBe(true);
    expect(foldRegard([bad, worse])).toBeNull();
  });

  it("route: fear above authority is DOMINANCE, and a tie is PRESTIGE", () => {
    expect(foldRegard([rel(0, 0.3, 0.1, 0.6)])!.route).toBe("dominance");
    expect(foldRegard([rel(0, 0.3, 0.6, 0.1)])!.route).toBe("prestige");
    expect(foldRegard([rel(0, 0.3, 0.4, 0.4)])!.route).toBe("prestige");
    expect(foldRegard([DEFAULT_RELATION, DEFAULT_RELATION])!.route).toBe("prestige");
  });

  it("route is decided on the household MEANS, not row by row", () => {
    // One terrified member, three unafraid: the household is not coerced.
    const rows = [rel(0, 0.3, 0.3, 1), rel(0, 0.3, 0.3, 0), rel(0, 0.3, 0.3, 0), rel(0, 0.3, 0.3, 0)];
    expect(foldRegard(rows)!.route).toBe("prestige");
  });

  it("clamps into −1..1", () => {
    const p = foldRegard([rel(-1, 0, 0, 1), rel(-1, 0, 0, 1)]);
    expect(p!.regard).toBeGreaterThanOrEqual(-1);
    expect(p!.regard).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------

describe("unfoldRegard — one prior becomes one member's row", () => {
  it("is byte-deterministic in (p, phi)", () => {
    const p: RegardPrior = { regard: 0.42, route: "prestige", n: 5 };
    for (const phi of [0, 0.13, 0.5, 0.87, 1]) {
      expect(unfoldRegard(p, phi)).toEqual(unfoldRegard(p, phi));
      expect(JSON.stringify(unfoldRegard(p, phi))).toBe(JSON.stringify(unfoldRegard(p, phi)));
    }
  });

  it("phi spreads AFFINITY only — trust, authority and fear are the household's", () => {
    for (const route of ROUTES) {
      // regard 0: affinity is off both rails on either route, so the whole
      // ±0.1 spread is visible rather than clipped by `makeRelation`.
      const p: RegardPrior = { regard: 0, route, n: 4 };
      const lo = unfoldRegard(p, 0);
      const mid = unfoldRegard(p, 0.5);
      const hi = unfoldRegard(p, 1);
      expect(lo.trust).toBe(mid.trust);
      expect(hi.trust).toBe(mid.trust);
      expect(lo.authority).toBe(mid.authority);
      expect(hi.authority).toBe(mid.authority);
      expect(lo.fear).toBe(mid.fear);
      expect(hi.fear).toBe(mid.fear);
      expect(hi.affinity).toBeGreaterThan(lo.affinity);
      expect(mid.affinity - lo.affinity).toBeCloseTo(0.1, 12);
      expect(hi.affinity - mid.affinity).toBeCloseTo(0.1, 12);
    }
  });

  it("…and the spread clips rather than escapes when affinity is already at the rail", () => {
    // A household that adores its subject cannot like it 1.1× more. The clip is
    // one-sided and never leaves the axis range.
    const p: RegardPrior = { regard: 1, route: "prestige", n: 4 };
    expect(unfoldRegard(p, 0.5).affinity).toBe(1);
    expect(unfoldRegard(p, 1).affinity).toBe(1);
    expect(unfoldRegard(p, 0).affinity).toBeCloseTo(0.9, 12);
  });

  it("a DOMINANCE prior is afraid and recognises nothing; a PRESTIGE one is the reverse", () => {
    for (const regard of [0.3, 0.6]) {
      const dom = unfoldRegard({ regard, route: "dominance", n: 3 }, 0.5);
      const pre = unfoldRegard({ regard, route: "prestige", n: 3 }, 0.5);
      expect(dom.fear).toBeGreaterThan(0);
      expect(pre.fear).toBe(0);
      // ⚖️ coerced compliance never earns authority.
      expect(dom.authority).toBe(0);
      expect(dom.authority).toBeLessThan(pre.authority);
    }
  });

  it("a dominance prior is afraid at EVERY reachable regard (the route survives)", () => {
    for (let r = REGARD_BAND.dominance[0]; r <= REGARD_BAND.dominance[1] + 1e-9; r += 0.05) {
      const out = unfoldRegard({ regard: r, route: "dominance", n: 2 }, 0.5);
      expect(out.fear).toBeGreaterThan(out.authority);
    }
  });

  it("a prestige prior's authority IS its positive regard, and nothing is afraid of it", () => {
    for (const regard of [0, 0.3, 0.6, 1]) {
      const out = unfoldRegard({ regard, route: "prestige", n: 2 }, 0.5);
      expect(out.authority).toBeCloseTo(regard, 12);
      expect(out.fear).toBe(0);
    }
  });

  it("survives a nonsense prior without emitting a nonsense row", () => {
    const out = unfoldRegard({ regard: NaN, route: "prestige", n: 0 }, NaN);
    for (const v of Object.values(out)) expect(Number.isFinite(v)).toBe(true);
    expect(out).toEqual(unfoldRegard({ regard: 0, route: "prestige", n: 0 }, 0.5));
  });
});

// ---------------------------------------------------------------------------

describe("THE LAW — foldRegard(unfoldRegard(p, 0.5)) reproduces p", () => {
  it("reproduces the regard within 0.05 and the route exactly, over the grid", () => {
    for (const route of ROUTES) {
      for (const regard of GRID_REGARDS) {
        if (!inBand(regard, route)) continue; // see the band pins below
        const p: RegardPrior = { regard, route, n: 4 };
        const back = foldRegard([unfoldRegard(p, 0.5)])!;
        expect(Math.abs(back.regard - regard)).toBeLessThan(0.05);
        // …and in fact to float precision: the unfold is the fold's algebraic
        // inverse on the band, not an approximation of it.
        expect(back.regard).toBeCloseTo(regard, 12);
        expect(back.route).toBe(route);
      }
    }
  });

  it("holds across the whole of both bands, not just the grid", () => {
    for (const route of ROUTES) {
      const [lo, hi] = REGARD_BAND[route];
      for (let r = lo; r <= hi + 1e-9; r += (hi - lo) / 40) {
        const p: RegardPrior = { regard: Math.min(hi, r), route, n: 3 };
        const back = foldRegard([unfoldRegard(p, 0.5)])!;
        expect(back.regard).toBeCloseTo(p.regard, 10);
        expect(back.route).toBe(route);
      }
    }
  });

  it("the phi stagger can never move a member out of its household's prior", () => {
    for (const route of ROUTES) {
      for (const regard of [-0.5, 0, 0.3, 0.6]) {
        for (const phi of [0, 0.25, 0.75, 1]) {
          const p: RegardPrior = { regard, route, n: 4 };
          const back = foldRegard([unfoldRegard(p, phi)])!;
          expect(Math.abs(back.regard - regard)).toBeLessThanOrEqual(0.05 + 1e-12);
          expect(back.route).toBe(route);
        }
      }
    }
  });

  it("a whole staggered household re-folds to its own prior", () => {
    for (const route of ROUTES) {
      const p: RegardPrior = { regard: 0.35, route, n: 5 };
      const members = [0.02, 0.31, 0.5, 0.66, 0.99].map((phi) => unfoldRegard(p, phi));
      const back = foldRegard(members)!;
      // The spread is symmetric-ish, so the household mean lands on the prior
      // far tighter than any single member could.
      expect(Math.abs(back.regard - p.regard)).toBeLessThan(0.02);
      expect(back.route).toBe(route);
      expect(back.n).toBe(5);
    }
  });
});

describe("the two corners no relation set can produce", () => {
  it("regard −1 with route prestige, and regard +1 with route dominance, are OUT OF BAND", () => {
    expect(inBand(-1, "prestige")).toBe(false);
    expect(inBand(1, "dominance")).toBe(false);
    // …and every other grid point is reachable.
    for (const route of ROUTES) {
      for (const regard of GRID_REGARDS) {
        if (regard === -1 && route === "prestige") continue;
        if (regard === 1 && route === "dominance") continue;
        expect(inBand(regard, route)).toBe(true);
      }
    }
  });

  it("foldRegard NEVER emits one — the law is total on the fold's own image", () => {
    const axis = [0, 0.2, 0.5, 0.8, 1];
    for (const a of [-1, -0.5, 0, 0.5, 1]) {
      for (const t of axis) {
        for (const u of axis) {
          for (const f of axis) {
            const p = foldRegard([rel(a, t, u, f)])!;
            const [lo, hi] = REGARD_BAND[p.route];
            expect(p.regard).toBeGreaterThanOrEqual(lo - 1e-12);
            expect(p.regard).toBeLessThanOrEqual(hi + 1e-12);
          }
        }
      }
    }
  });

  it("an out-of-band prior SATURATES at its route's edge rather than pretending", () => {
    const pre = foldRegard([unfoldRegard({ regard: -1, route: "prestige", n: 1 }, 0.5)])!;
    expect(pre.regard).toBeCloseTo(REGARD_BAND.prestige[0], 10);
    expect(pre.route).toBe("prestige");
    const dom = foldRegard([unfoldRegard({ regard: 1, route: "dominance", n: 1 }, 0.5)])!;
    expect(dom.regard).toBeCloseTo(REGARD_BAND.dominance[1], 10);
    expect(dom.route).toBe("dominance");
  });
});

// ---------------------------------------------------------------------------

describe("regardDeviation — how far a live row sits from its household's prior", () => {
  it("is zero for the projection itself, at any phi's structural axes", () => {
    const p: RegardPrior = { regard: 0.4, route: "prestige", n: 4 };
    expect(regardDeviation(unfoldRegard(p, 0.5), p)).toBeCloseTo(0, 12);
  });

  it("is the LARGEST single-axis difference", () => {
    const p: RegardPrior = { regard: 0, route: "prestige", n: 4 };
    const at = unfoldRegard(p, 0.5); // affinity 0, trust 0.3, authority 0, fear 0
    const row = rel(at.affinity + 0.1, at.trust - 0.02, at.authority + 0.37, at.fear);
    expect(regardDeviation(row, p)).toBeCloseTo(0.37, 12);
  });

  it("calls a non-finite row maximally deviant (it can never be reconstructed)", () => {
    const p: RegardPrior = { regard: 0, route: "prestige", n: 1 };
    expect(regardDeviation({ affinity: NaN, trust: 0.3, authority: 0, fear: 0 } as Relation, p)).toBe(
      Infinity,
    );
  });

  it("a household that all feels the same way about the spirit stays UNDER PIN_EPS", () => {
    // FAMILY_RELATION (quest-host's settler→spirit constant), five members.
    const family = rel(0.5, 0.8, 0.8, 0);
    const p = foldRegard([family, family, family, family, family])!;
    expect(regardDeviation(family, p)).toBeLessThan(PIN_EPS);
  });

  it("PIN_EPS is a quarter of an axis", () => {
    expect(PIN_EPS).toBe(0.25);
  });

  it("🚨 an ORDINARY book re-projects under PIN_EPS — a fold that pins everyone folds nothing", () => {
    // The books the live map actually holds: the stranger default, a warmed
    // acquaintance (`warmRelations`' symmetric affinity/trust nudges), the
    // settler→spirit constant, and a wary one on the dominance route.
    const ordinary: Relation[] = [
      DEFAULT_RELATION,
      rel(0.15, 0.36, 0, 0),
      rel(0.5, 0.8, 0.8, 0),
      rel(-0.4, 0.2, 0, 0.5),
      rel(-0.2, 0.25, 0, 0.3),
      rel(0.3, 0.5, 0.2, 0),
    ];
    for (const row of ordinary) {
      expect(regardDeviation(row, foldRegard([row])!)).toBeLessThan(PIN_EPS);
    }
  });
});
