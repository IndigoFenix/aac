/**
 * ⚖️ SETTLER GRADUATION — THE PURE ARITHMETIC (body-needs-round.md D6).
 *
 * The host half of the handover (banking carried stock, handing body meters
 * into `needMeters`, re-keying relations, retiring `npc_settler_<i>`) is a live
 * play-level behaviour and is verified where long play arcs belong — text mode,
 * `transcripts/bn-grad-post.txt`. What is pinned HERE is the part that is
 * arithmetic, and every law of it that a host bug could quietly break:
 *
 *  ① THE MAP IS SORTED, CONTIGUOUS AND NUMERIC. A household's member slots run
 *    `0 … n−1` with no gaps (`familyExcludedMembers` excludes the TAIL and the
 *    resident streamer walks `m ∈ [0, HOUSEHOLD)`), and `settler_10` must not
 *    land between `settler_1` and `settler_2` the way a lexical sort puts it.
 *  ② `n ≤ HOUSEHOLD`. `SETTLER_MAX` is 8 and a house holds 5; the ninth camper
 *    must not be minted as `resident_<h>_5`, a cid nothing ever visits.
 *  ③ THE ID SHAPES ARE THE ONES EVERY CONSUMER PARSES — verified against the
 *    REAL `houseIndexOfCid`, the function `needMeters` keys, the streamer and
 *    `construction-director` all read a cid through.
 *  ④ CONSERVATION IS A MEASUREMENT, signed: minted is positive, lost negative.
 *
 * PURE / DB-free / GL-free — `npm run test:engine -- graduation`.
 */
import { describe, it, expect } from "@jest/globals";
import {
  conservationBreach,
  graduationPlan,
  graduationSouls,
  meterKeyOf,
  residentCidFor,
  settlerOrdinalOf,
} from "@shared/world-engine/interaction/quest/graduation.js";
import { houseIndexOfCid } from "@shared/world-engine/interaction/quest/creature-inspect.js";
import { HOUSEHOLD } from "@shared/world-engine/kernel/town/stations.js";

const settlers = (n: number): string[] => Array.from({ length: n }, (_, i) => `settler_${i}`);

describe("settler ordinals — the ONE id shape", () => {
  it("reads `settler_<i>` and nothing else", () => {
    expect(settlerOrdinalOf("settler_0")).toBe(0);
    expect(settlerOrdinalOf("settler_7")).toBe(7);
    expect(settlerOrdinalOf("settler_12")).toBe(12);
  });

  it("refuses every id that is NOT a settler — a resident above all", () => {
    for (const cid of [
      "resident_3_1",
      "pet_0_0",
      "settler_",
      "settler_x",
      "settler_-1",
      "settler_0_1",
      "npc_settler_0", // the BODY id, not the creature id
      "",
    ]) {
      expect(settlerOrdinalOf(cid)).toBeNull();
    }
  });
});

describe("graduationPlan — who becomes whom", () => {
  it("maps the founding group in order, into contiguous member slots from 0", () => {
    const plan = graduationPlan(settlers(5), 3);
    expect(plan).toEqual([
      { from: "settler_0", to: "resident_3_0", member: 0 },
      { from: "settler_1", to: "resident_3_1", member: 1 },
      { from: "settler_2", to: "resident_3_2", member: 2 },
      { from: "settler_3", to: "resident_3_3", member: 3 },
      { from: "settler_4", to: "resident_3_4", member: 4 },
    ]);
  });

  it("SORTS NUMERICALLY — `settler_10` is not a sibling of `settler_1` (R-A7)", () => {
    const plan = graduationPlan(["settler_10", "settler_2", "settler_1"], 0);
    expect(plan.map((s) => s.from)).toEqual(["settler_1", "settler_2", "settler_10"]);
    // …and the SLOTS are still 0,1,2 — position, never the settler's ordinal.
    expect(plan.map((s) => s.to)).toEqual(["resident_0_0", "resident_0_1", "resident_0_2"]);
  });

  it("is deterministic under a shuffled input — the multiplayer law", () => {
    const a = graduationPlan(["settler_4", "settler_0", "settler_3", "settler_1", "settler_2"], 7);
    const b = graduationPlan(settlers(5), 7);
    expect(a).toEqual(b);
  });

  it("never mints past HOUSEHOLD — eight campers, five souls (law ②)", () => {
    const plan = graduationPlan(settlers(8), 2);
    expect(plan).toHaveLength(HOUSEHOLD);
    expect(plan.every((s) => s.member < HOUSEHOLD)).toBe(true);
    expect(plan.map((s) => s.to)).not.toContain(`resident_2_${HOUSEHOLD}`);
  });

  it("drops non-settler ids and duplicates rather than mapping them", () => {
    const plan = graduationPlan(
      ["settler_0", "resident_1_1", "settler_0", "pet_0_0", "settler_1"],
      4,
    );
    expect(plan.map((s) => s.from)).toEqual(["settler_0", "settler_1"]);
  });

  it("REFUSES a house it cannot name — no house, nowhere conserving to put anything", () => {
    expect(graduationPlan(settlers(5), -1)).toEqual([]);
    expect(graduationPlan(settlers(5), 1.5)).toEqual([]);
    expect(graduationPlan(settlers(5), Number.NaN)).toEqual([]);
    expect(graduationPlan([], 0)).toEqual([]);
  });

  it("house 0 is a real house — the falsy-index trap", () => {
    expect(graduationPlan(["settler_0"], 0)).toEqual([
      { from: "settler_0", to: "resident_0_0", member: 0 },
    ]);
  });
});

describe("the id shapes every consumer parses (law ③)", () => {
  it("`houseIndexOfCid(to)` is the house the plan was made for", () => {
    for (const houseIndex of [0, 1, 3, 12, 137]) {
      for (const step of graduationPlan(settlers(5), houseIndex)) {
        expect(houseIndexOfCid(step.to)).toBe(houseIndex);
      }
    }
  });

  it("…and `houseIndexOfCid(from)` is −1: a settler is NEVER house N", () => {
    for (const step of graduationPlan(settlers(5), 3)) {
      expect(houseIndexOfCid(step.from)).toBe(-1);
    }
  });

  it("`residentCidFor` and the plan agree on the spelling", () => {
    const plan = graduationPlan(settlers(3), 9);
    expect(plan.map((s) => s.to)).toEqual(plan.map((s) => residentCidFor(9, s.member)));
  });

  it("the meter key is `<cid>|<tplKey>` — what `needMeters` is keyed by", () => {
    expect(meterKeyOf("resident_3_0", "hunger:food")).toBe("resident_3_0|hunger:food");
    // The graduation writes the RESIDENT's key, never the settler's.
    const [step] = graduationPlan(["settler_0"], 3);
    expect(meterKeyOf(step!.to, "energy")).toBe("resident_3_0|energy");
  });
});

describe("graduationSouls — the census the town counts ONCE", () => {
  it("is the group, capped by what a house holds", () => {
    expect(graduationSouls(settlers(0))).toBe(0);
    expect(graduationSouls(settlers(2))).toBe(2);
    expect(graduationSouls(settlers(5))).toBe(HOUSEHOLD);
    expect(graduationSouls(settlers(8))).toBe(HOUSEHOLD);
  });

  it("counts distinct settlers only — a repeated id is one mouth", () => {
    expect(graduationSouls(["settler_0", "settler_0", "settler_1", "resident_2_2"])).toBe(2);
  });

  it("agrees with the plan's length — the census and the handover cannot drift", () => {
    for (const n of [0, 1, 3, 5, 8]) {
      expect(graduationPlan(settlers(n), 1)).toHaveLength(graduationSouls(settlers(n)));
    }
  });
});

describe("conservationBreach — ITEM CONSERVATION as a number (law ④)", () => {
  it("is ZERO when every banked unit arrived in a box", () => {
    expect(conservationBreach({ banked: 7, chestBefore: 12, chestAfter: 19 })).toBe(0);
    expect(conservationBreach({ banked: 0, chestBefore: 0, chestAfter: 0 })).toBe(0);
  });

  it("is POSITIVE when units were minted (the sawtooth reseeding over a real stack)", () => {
    expect(conservationBreach({ banked: 2, chestBefore: 0, chestAfter: 5 })).toBe(3);
  });

  it("is NEGATIVE when units were lost (a bag left on a retired body)", () => {
    expect(conservationBreach({ banked: 4, chestBefore: 10, chestAfter: 11 })).toBe(-3);
  });
});
