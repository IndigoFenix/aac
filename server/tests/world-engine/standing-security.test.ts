// STANDING and SECURITY as BODY NEEDS (politics-substrate-round.md S-3;
// interpersonal-politics.md §2a, owner's ruling ①) — the two needs whose
// satisfier is another entity's ACT, on the landed need primitive with no new
// machinery: two template factories, two keys in the ONE pacing table, and a
// `value` on the partner candidates so `decideNeed`'s social arm can choose.
//
// Pure logic — no DB / LLM / GL / host.

import { describe, it, expect } from "@jest/globals";
import {
  decideNeed,
  energyTemplate,
  hungerTemplate,
  relieveTemplate,
  securityTemplate,
  socialTemplate,
  standingTemplate,
  type NeedCtx,
  type StationCandidate,
} from "@shared/world-engine/interaction/behavior/needs.js";
import { bodyNeedTemplates } from "@shared/world-engine/interaction/behavior/body-needs.js";
import { makePersonality } from "@shared/world-engine/interaction/behavior/personality.js";
import {
  DOLLHOUSE_SCALE,
  NEED_FILL_DAYS,
  NEED_FILL_S,
  needRate,
} from "@shared/world-engine/scale.js";

const RATE = 1 / 120;

const station = (id: string, value?: number): StationCandidate => ({
  id,
  place: { kind: "named", id },
  kind: "partner",
  waiting: 0,
  ...(value === undefined ? {} : { value }),
});

/** A firing social row's context — meter at the threshold, partners listed. */
function ctxWith(stations: StationCandidate[], meter = 1): NeedCtx {
  return { meter, carried: 0, containers: {}, sources: [], stations };
}

// ---------------------------------------------------------------------------
// ① THE TEMPLATES
// ---------------------------------------------------------------------------

describe("standingTemplate / securityTemplate — data rows, no new machinery", () => {
  it("name their `good` so the credit door can be told what was actually given", () => {
    expect(standingTemplate(RATE).satisfy).toEqual({ kind: "social", good: "standing" });
    expect(securityTemplate(RATE).satisfy).toEqual({ kind: "social", good: "security" });
    // …which is exactly the slot the body-needs round left for this one (D1).
    expect(socialTemplate(RATE).satisfy).toEqual({ kind: "social" });
  });

  it("are keyed `standing` / `security`, acquire nothing, and sit at the SOCIAL priority", () => {
    for (const tpl of [standingTemplate(RATE), securityTemplate(RATE)]) {
      expect(tpl.acquire).toEqual([]);
      expect(tpl.item).toEqual({});
      expect(tpl.priority).toBe(socialTemplate(RATE).priority); // 2 — the social third, not a new tier
      expect(tpl.drive).toEqual({ kind: "meter", rate: RATE, threshold: 1 });
    }
    expect(standingTemplate(RATE).key).toBe("standing");
    expect(securityTemplate(RATE).key).toBe("security");
  });
});

describe("the rates come from the ONE table (no new pacing constant)", () => {
  it("NEED_FILL_DAYS carries both, BEHIND loneliness", () => {
    expect(NEED_FILL_DAYS.standing).toBe(1.5);
    expect(NEED_FILL_DAYS.security).toBe(2);
    expect(NEED_FILL_DAYS.social).toBeLessThan(NEED_FILL_DAYS.standing);
    expect(NEED_FILL_DAYS.standing).toBeLessThan(NEED_FILL_DAYS.security);
  });

  it("the street-clock mirror is the table times the dollhouse day", () => {
    expect(NEED_FILL_S.standing).toBe(360);
    expect(NEED_FILL_S.security).toBe(480);
    expect(NEED_FILL_S.standing).toBe(NEED_FILL_DAYS.standing * DOLLHOUSE_SCALE.dayLengthS);
  });
});

// ---------------------------------------------------------------------------
// ② bodyNeedTemplates — the social third is OPT-IN
// ---------------------------------------------------------------------------

describe("bodyNeedTemplates — the social rows are opt-in, and the default is untouched", () => {
  const scale = DOLLHOUSE_SCALE;
  const today = (pullOn: boolean) => {
    const out = [hungerTemplate("food", needRate(scale, "hunger"), []), energyTemplate(needRate(scale, "energy"))];
    if (pullOn) out.push(relieveTemplate());
    return out;
  };

  it("🚨 `social` OMITTED returns EXACTLY today's rows (N1's settlers are untouched)", () => {
    expect(bodyNeedTemplates(scale, { pullOn: true })).toEqual(today(true));
    expect(bodyNeedTemplates(scale, { pullOn: false })).toEqual(today(false));
    // …and so does an explicit false.
    expect(bodyNeedTemplates(scale, { pullOn: true, social: false })).toEqual(today(true));
    // Personality and exposure alone change nothing without the opt-in.
    expect(
      bodyNeedTemplates(scale, { pullOn: true, personality: makePersonality({ assertiveness: 1 }), maxFear: 1 }),
    ).toEqual(today(true));
  });

  it("`social: true` APPENDS the three social rows, in order, after the body rows", () => {
    const rows = bodyNeedTemplates(scale, { pullOn: true, social: true });
    expect(rows.slice(0, 3)).toEqual(today(true));
    expect(rows.slice(3).map((r) => r.key)).toEqual(["social", "standing", "security"]);
  });

  it("ASSERTIVENESS scales the STANDING rate (×0.5 … ×1.5), never a second meter", () => {
    const rateOf = (key: string, opts: Parameters<typeof bodyNeedTemplates>[1]) => {
      const row = bodyNeedTemplates(scale, opts).find((r) => r.key === key)!;
      return row.drive.kind === "meter" ? row.drive.rate : 0;
    };
    const base = needRate(scale, "standing");
    expect(rateOf("standing", { pullOn: false, social: true })).toBeCloseTo(base); // neutral 0.5 ⇒ ×1
    expect(
      rateOf("standing", { pullOn: false, social: true, personality: makePersonality({ assertiveness: 0 }) }),
    ).toBeCloseTo(base * 0.5);
    expect(
      rateOf("standing", { pullOn: false, social: true, personality: makePersonality({ assertiveness: 1 }) }),
    ).toBeCloseTo(base * 1.5);
    // The SECURITY rate does not move with assertiveness…
    expect(
      rateOf("security", { pullOn: false, social: true, personality: makePersonality({ assertiveness: 1 }) }),
    ).toBeCloseTo(needRate(scale, "security") * 0.5);
  });

  it("EXPOSURE (the highest fear in the book) scales the SECURITY rate", () => {
    const rateOf = (maxFear: number | undefined) => {
      const row = bodyNeedTemplates(scale, { pullOn: false, social: true, maxFear }).find(
        (r) => r.key === "security",
      )!;
      return row.drive.kind === "meter" ? row.drive.rate : 0;
    };
    const base = needRate(scale, "security");
    expect(rateOf(undefined)).toBeCloseTo(base * 0.5); // nobody scares me
    expect(rateOf(0)).toBeCloseTo(base * 0.5);
    expect(rateOf(1)).toBeCloseTo(base * 1.5); // living next to someone I fear
    expect(rateOf(5)).toBeCloseTo(base * 1.5); // clamped, never runaway
  });
});

// ---------------------------------------------------------------------------
// ③ decideNeed's social arm — partner choice by value − cost
// ---------------------------------------------------------------------------

describe("decideNeed (social) — argmax of `value`, with a STRICT `>` tie-break", () => {
  const tpl = socialTemplate(RATE);

  it("🚨 ALL-EQUAL RETURNS `stations[0]` BY IDENTITY — the bench guarantee", () => {
    const a = station("pip");
    const b = station("orrin");
    const c = station("biscuit");
    const got = decideNeed(tpl, ctxWith([a, b, c]));
    expect(got.kind).toBe("socialize");
    expect(got.kind === "socialize" && got.station).toBe(a); // toBe: the SAME OBJECT
    // A caller that models no value at all is the dollhouse, and it must be a
    // no-op: same answer as an all-zero list.
    const zeroed = decideNeed(tpl, ctxWith([station("pip", 0), station("orrin", 0)]));
    expect(zeroed.kind === "socialize" && zeroed.station.id).toBe("pip");
  });

  it("picks the HIGHEST value, not the nearest", () => {
    const near = station("pip", 0.1);
    const far = station("orrin", 0.9);
    const got = decideNeed(tpl, ctxWith([near, far]));
    expect(got.kind === "socialize" && got.station).toBe(far);
  });

  it("a TIE at the top keeps the earlier (nearer) candidate", () => {
    const first = station("pip", 0.7);
    const second = station("orrin", 0.7);
    const got = decideNeed(tpl, ctxWith([first, second]));
    expect(got.kind === "socialize" && got.station).toBe(first);
  });

  it("an absent value reads as 0 (a valued partner beats an unmeasured one)", () => {
    const unmeasured = station("pip");
    const valued = station("orrin", 0.2);
    const got = decideNeed(tpl, ctxWith([unmeasured, valued]));
    expect(got.kind === "socialize" && got.station).toBe(valued);
    // …and a NEGATIVE value loses to an unmeasured one, as it should.
    const bad = station("cal", -0.5);
    const got2 = decideNeed(tpl, ctxWith([bad, unmeasured]));
    expect(got2.kind === "socialize" && got2.station).toBe(unmeasured);
  });

  it("alone ⇒ blocked (the want surfaces, nothing is invented)", () => {
    expect(decideNeed(tpl, ctxWith([])).kind).toBe("blocked");
  });

  it("the standing and security rows take the same arm (they ARE social rows)", () => {
    const best = station("orrin", 0.8);
    for (const t of [standingTemplate(RATE), securityTemplate(RATE)]) {
      const got = decideNeed(t, ctxWith([station("pip", 0.1), best]));
      expect(got.kind === "socialize" && got.station).toBe(best);
    }
  });

  it("a row that is not firing is idle, whatever the partners are worth", () => {
    expect(decideNeed(standingTemplate(RATE), ctxWith([station("orrin", 1)], 0)).kind).toBe("idle");
  });
});
