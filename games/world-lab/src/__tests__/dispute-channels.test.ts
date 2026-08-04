/**
 * The nations-P4 ship gate: the DISPUTE MACHINE — the conquest block
 * generalized into channel-parametric conflict
 * (planning-docs/games/world-engine/nations-and-empires.md §5/§6/P4).
 *
 * The dual gate:
 *   1. WAR ENABLED — the legacy `coupling.conquest` sugar and the
 *      dispute machine's war channel are BYTE-IDENTICAL (same events,
 *      same days, same populations), and the grand-dream imperial-cycle
 *      acceptance passes unchanged (its own suite).
 *   2. VIOLENCE TABOO'D — the same imperial cycle (fusion → fission →
 *      fusion → rest) still runs, resolving through NONVIOLENT channels
 *      only: prestige defection merges, the seeded dissent secedes, and
 *      not one person dies.
 * Plus one pin per new channel: blockade capitulation, union merge,
 * arbitration award — all writing through the same sanctioned ops.
 */

import { describe, it, expect } from "vitest";
import { bootDual, channelTaboos, type DualSpec, type DualCoupling } from "@shared/world-engine/kernel/civ/dual";
import type { WorldSpec } from "@shared/world-engine/kernel/cells/spec";
import { resolveWorldCulture } from "@shared/world-engine/culture";
import { bootCiv } from "../civ-boot";

/** Two civs sharing a border — the grand-dream empire arc's shape: Aurelia
 *  (two towns, 30k) vs the fort (12k) whose people carry a dormant pride.
 *  A conquest/defection flips the fort INTO the big civ; the pride is then
 *  a coherent one-site dissent and the breakaway secedes it back out;
 *  the second flip ends the cycle. */
function empireNodes(fortPop = 12_000): Pick<DualSpec, "nodes" | "edges"> {
  return {
    nodes: [
      { key: "acap", name: "A-Capital", pop: 20_000, site: { startpop: [{ size: 1, apply: ["member_a"] }] } },
      { key: "aburg", name: "A-Burg", pop: 10_000, site: { startpop: [{ size: 1, apply: ["member_a"] }] } },
      { key: "bfort", name: "B-Fort", pop: fortPop, site: { startpop: [{ size: 1, apply: ["member_b", "b_pride"] }] } },
    ],
    edges: [
      { a: "acap", b: "aburg" },
      { a: "aburg", b: "bfort" }, // the border
    ],
  };
}

const EMPIRE_SETTLEMENT: WorldSpec = {
  id: "empire",
  entity: {
    id: "town",
    vars: [{ name: "population", min: 0, max: 1_000_000, initial: 0 }],
    rules: [],
  },
  edge: { vars: [{ name: "hostility", min: 0, max: 1, initial: 0 }] },
};

const EMPIRE_COMPOSITION: Record<string, unknown> = {
  name: "Empire",
  start_age: 0, use_date: false,
  phase: [{ key: "spread", name: "Spread" }],
  trait: [
    { key: "member_a", name: "Aurelia", color: "90,120,220,1", hereditary: true },
    { key: "member_b", name: "Borvia", color: "220,120,90,1", hereditary: true },
    { key: "member_c", name: "Free Fort", color: "190,90,220,1", hereditary: true },
    { key: "b_pride", name: "Fort Pride", color: "240,150,40,1", hereditary: true },
  ],
  vector: [{ key: "v1", name: "Contact" }],
  breakaway: [{
    key: "fort_rises", dissent: "b_pride", from: "member_a", to: "member_c",
    threshold: 0.15, coherence: 0.5,
  }],
};

const EMPIRE_CIVS = [
  { trait: "member_a", name: "Aurelia", color: "#5a78dc" },
  { trait: "member_b", name: "Borvia", color: "#dc785a" },
  { trait: "member_c", name: "Free Fort", color: "#be5adc" },
];

const WAR = {
  strengthScalars: [{ scalar: "population", weight: 1 }],
  ratio: 1.5,
  siegeDays: 8,
  casualties: 0.05,
  villagePop: 1_000,
  failedSiegeCooling: 0.3,
  skirmish: 0.002,
};

function empireSpec(coupling: Partial<DualCoupling>): DualSpec {
  return {
    ...empireNodes(),
    settlement: EMPIRE_SETTLEMENT,
    composition: EMPIRE_COMPOSITION,
    coupling: {
      populationScalar: "population",
      civs: EMPIRE_CIVS,
      breakawayHostility: { attr: "hostility", amount: 0.25 },
      ...coupling,
    },
  };
}

describe("dispute machine: war channel parity (P4 gate, half 1)", () => {
  it("legacy coupling.conquest and dispute.war produce byte-identical worlds", async () => {
    const capture = async (spec: DualSpec): Promise<string> => {
      const dw = await bootDual(spec, 1453, bootCiv);
      const { stepped, skipped } = await dw.advanceDays(200);
      return JSON.stringify([
        stepped, skipped, dw.isResting(), dw.totalPop(), dw.vitalLedger(),
        dw.conquests(), dw.breakaways(), dw.tombstones(),
        dw.sites().map(s => [s.key, dw.settlementPop(s.key)]),
        dw.civs().map(c => [c.trait, c.pop, c.capital]),
      ]);
    };
    const legacy = await capture(empireSpec({
      conquest: { hostilityAttr: "hostility", ...WAR },
    }));
    const viaDispute = await capture(empireSpec({
      dispute: { hostilityAttr: "hostility", war: WAR },
    }));
    expect(viaDispute).toBe(legacy);

    // And the cycle actually ran: two wars around one secession.
    const [, , resting, , , wars, breaks] =
      JSON.parse(legacy) as [number, number, boolean, number, unknown, unknown[], unknown[]];
    expect(resting).toBe(true);
    expect(wars.length).toBe(2);
    expect(breaks.length).toBe(1);
  });

  it("war resolutions also land on the all-channel resolutions() ledger", async () => {
    const dw = await bootDual(empireSpec({
      dispute: { hostilityAttr: "hostility", war: WAR },
    }), 1453, bootCiv);
    await dw.advanceDays(60);
    const wars = dw.conquests();
    expect(wars.length).toBeGreaterThan(0);
    const rows = dw.resolutions();
    expect(rows.filter(r => r.channel === "war").map(r => ({ ...r, channel: undefined }))).toEqual(
      wars.map(w => ({ ...w, channel: undefined })),
    );
  });
});

describe("dispute machine: the violence taboo (P4 gate, half 2)", () => {
  /** War configured but TABOO'D (the §6 gate — culture absolutes project
   *  to channel taboos); prestige carries the fusion instead. */
  const tabooSpec = (): DualSpec => empireSpec({
    dispute: {
      hostilityAttr: "hostility",
      taboos: channelTaboos(resolveWorldCulture({ absolutes: ["fight"] }).absolutes),
      war: WAR, // configured — the taboo alone must disarm it
      prestige: {
        scalars: [{ scalar: "population", weight: 1 }],
        ratio: 1.5,
        defectDays: 8,
      },
    },
  });

  it("culture absolutes map to channel taboos", () => {
    expect(channelTaboos(new Set(["fight"]))).toEqual(["war"]);
    expect(channelTaboos(new Set(["lie"]))).toEqual([]);
    expect(channelTaboos([])).toEqual([]);
  });

  it("fusion, fission, fusion — and not one person dies", async () => {
    const dw = await bootDual(tabooSpec(), 1453, bootCiv);
    const start = dw.totalPop();

    await dw.advanceDays(60);

    // No war anywhere: no sieges resolved, no skirmish attrition, no
    // casualties — the ledger never moved.
    expect(dw.conquests().length).toBe(0);
    expect(dw.vitalLedger()).toEqual({ births: 0, deaths: 0 });
    expect(dw.totalPop()).toBe(start);
    expect(dw.tombstones().length).toBe(0);

    // The SAME imperial cycle, through prestige: two defections of the
    // fort with the pride's secession between them.
    const flips = dw.resolutions();
    expect(flips.length).toBe(2);
    expect(flips.every(r =>
      r.channel === "prestige" && r.mode === "political" &&
      r.loser === "bfort" && r.civ === "member_a" && r.casualties === 0,
    )).toBe(true);
    expect(dw.breakaways().length).toBe(1);
    expect(dw.breakaways()[0].key).toBe("fort_rises");
    expect(flips[0].day).toBeLessThanOrEqual(dw.breakaways()[0].day);
    expect(flips[1].day).toBeGreaterThan(dw.breakaways()[0].day);

    // The empire holds, and the layers agree.
    expect(dw.civOf("bfort")?.trait).toBe("member_a");
    expect(dw.civs().find(c => c.trait === "member_a")?.pop).toBe(dw.totalPop());
    for (const s of dw.sites()) {
      expect(dw.settlementPop(s.key)).toBe(s.pops.reduce((a, p) => a + p.pop, 0));
    }

    // Rest after the last border dissolves — the taboo'd world still
    // proves its fixed point and jumps.
    const { skipped } = await dw.advanceDays(300);
    expect(skipped).toBeGreaterThan(0);
    expect(dw.isResting()).toBe(true);
  });

  it("the nonviolent imperial cycle is deterministic", async () => {
    const capture = async (): Promise<string> => {
      const dw = await bootDual(tabooSpec(), 1455, bootCiv);
      const { stepped, skipped } = await dw.advanceDays(200);
      return JSON.stringify([
        stepped, skipped, dw.isResting(), dw.totalPop(), dw.vitalLedger(),
        dw.resolutions(), dw.breakaways(),
        dw.sites().map(s => [s.key, dw.settlementPop(s.key)]),
        dw.civs().map(c => [c.trait, c.pop, c.capital]),
      ]);
    };
    const a = await capture();
    expect(await capture()).toBe(a);
  });
});

describe("dispute machine: blockade (channel 2)", () => {
  /** Two matched towns — war would stalemate; the thinner pantry
   *  capitulates instead. `goods` is a plain stock scalar: the blockade
   *  drains BOTH sides (the blockader loses the trade too). */
  const blockadeSpec = (): DualSpec => ({
    nodes: [
      { key: "aport", name: "A-Port", pop: 20_000, scalars: { goods: 300 }, site: { startpop: [{ size: 1, apply: ["member_a"] }] } },
      { key: "btown", name: "B-Town", pop: 18_000, scalars: { goods: 60 }, site: { startpop: [{ size: 1, apply: ["member_b"] }] } },
    ],
    edges: [{ a: "aport", b: "btown" }],
    settlement: {
      id: "embargo",
      entity: {
        id: "town",
        vars: [
          { name: "population", min: 0, max: 1_000_000, initial: 0 },
          { name: "goods", min: 0, max: 100_000, initial: 0 },
        ],
        rules: [],
      },
      edge: { vars: [{ name: "hostility", min: 0, max: 1, initial: 0 }] },
    },
    composition: {
      name: "Embargo", start_age: 0, use_date: false,
      phase: [{ key: "spread", name: "Spread" }],
      trait: [
        { key: "member_a", name: "Aland", color: "90,120,220,1", hereditary: true },
        { key: "member_b", name: "Bland", color: "220,120,90,1", hereditary: true },
      ],
      vector: [{ key: "v1", name: "Contact" }],
    },
    coupling: {
      populationScalar: "population",
      civs: [
        { trait: "member_a", name: "Aland", color: "#5a78dc" },
        { trait: "member_b", name: "Bland", color: "#dc785a" },
      ],
      breakawayHostility: { attr: "hostility", amount: 0.25 },
      dispute: {
        hostilityAttr: "hostility",
        blockade: { stockScalar: "goods", drain: 5, shortageAt: 20, capitulationDays: 6 },
      },
    },
  });

  it("sustained one-sided shortage capitulates — terms, not casualties", async () => {
    const dw = await bootDual(blockadeSpec(), 77, bootCiv);
    const start = dw.totalPop();
    await dw.advanceDays(40);

    const rows = dw.resolutions();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      channel: "blockade", mode: "political",
      loser: "btown", winner: "aport", civ: "member_a", casualties: 0,
    });
    // Both sides paid stocks; nobody paid lives.
    expect(dw.settlementScalar("aport", "goods")).toBeLessThan(300);
    expect(dw.settlementScalar("btown", "goods")).toBe(0);
    expect(dw.vitalLedger()).toEqual({ births: 0, deaths: 0 });
    expect(dw.totalPop()).toBe(start);
    expect(dw.civOf("btown")?.trait).toBe("member_a");

    // One crown left — the embargo world rests.
    const { skipped } = await dw.advanceDays(300);
    expect(skipped).toBeGreaterThan(0);
    expect(dw.isResting()).toBe(true);
  });
});

describe("dispute machine: union (channel 4)", () => {
  /** A COLD border with standing affinity: both heads consent, the
   *  smaller crown joins the larger everywhere. No breakawayHostility —
   *  nothing arms the border, the affinity does the work. */
  const unionSpec = (): DualSpec => ({
    nodes: [
      { key: "roseburg", name: "Roseburg", pop: 20_000, site: { startpop: [{ size: 1, apply: ["member_a"] }] } },
      { key: "thornvale", name: "Thornvale", pop: 12_000, site: { startpop: [{ size: 1, apply: ["member_b"] }] } },
    ],
    edges: [{ a: "roseburg", b: "thornvale", attrs: { affinity: 0.8 } }],
    settlement: {
      id: "union",
      entity: {
        id: "town",
        vars: [{ name: "population", min: 0, max: 1_000_000, initial: 0 }],
        rules: [],
      },
      edge: {
        vars: [
          { name: "hostility", min: 0, max: 1, initial: 0 },
          { name: "affinity", min: 0, max: 1, initial: 0 },
        ],
      },
    },
    composition: {
      name: "Union", start_age: 0, use_date: false,
      phase: [{ key: "spread", name: "Spread" }],
      trait: [
        { key: "member_a", name: "Rose", color: "90,120,220,1", hereditary: true },
        { key: "member_b", name: "Thorn", color: "220,120,90,1", hereditary: true },
      ],
      vector: [{ key: "v1", name: "Contact" }],
    },
    coupling: {
      populationScalar: "population",
      civs: [
        { trait: "member_a", name: "Rose", color: "#5a78dc" },
        { trait: "member_b", name: "Thorn", color: "#dc785a" },
      ],
      dispute: {
        hostilityAttr: "hostility",
        union: { affinityAttr: "affinity", affinityAt: 0.5, days: 10 },
      },
    },
  });

  it("standing affinity on a cold border merges the crowns — smaller joins larger", async () => {
    const dw = await bootDual(unionSpec(), 88, bootCiv);
    const start = dw.totalPop();
    await dw.advanceDays(15);

    const rows = dw.resolutions();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      channel: "union", mode: "political",
      loser: "thornvale", winner: "roseburg", civ: "member_a", casualties: 0,
    });
    // The WHOLE holding joined: no Thorn carriers anywhere.
    expect(dw.civOf("thornvale")?.trait).toBe("member_a");
    expect(dw.civs().find(c => c.trait === "member_b")?.pop).toBe(0);
    expect(dw.civs().find(c => c.trait === "member_a")?.pop).toBe(dw.totalPop());
    expect(dw.vitalLedger()).toEqual({ births: 0, deaths: 0 });
    expect(dw.totalPop()).toBe(start);

    const { skipped } = await dw.advanceDays(200);
    expect(skipped).toBeGreaterThan(0);
    expect(dw.isResting()).toBe(true);
  });
});

describe("dispute machine: arbitration (channel 5)", () => {
  /** Two matched villages under a big crown: nobody can win, the crown
   *  keeps settling the quarrel — pressure drains, claims stand. */
  const arbitrationSpec = (): DualSpec => ({
    nodes: [
      { key: "avill", name: "A-Village", pop: 10_000, site: { startpop: [{ size: 1, apply: ["member_a"] }] } },
      { key: "bvill", name: "B-Village", pop: 10_000, site: { startpop: [{ size: 1, apply: ["member_b"] }] } },
      { key: "crown", name: "Crown-Seat", pop: 30_000, site: { startpop: [{ size: 1, apply: ["member_c"] }] } },
    ],
    edges: [{ a: "avill", b: "bvill" }],
    settlement: {
      id: "arbitration",
      entity: {
        id: "town",
        vars: [{ name: "population", min: 0, max: 1_000_000, initial: 0 }],
        rules: [],
      },
      edge: { vars: [{ name: "hostility", min: 0, max: 1, initial: 0 }] },
    },
    composition: {
      name: "Arbitration", start_age: 0, use_date: false,
      phase: [{ key: "spread", name: "Spread" }],
      trait: [
        { key: "member_a", name: "Avale", color: "90,120,220,1", hereditary: true },
        { key: "member_b", name: "Bvale", color: "220,120,90,1", hereditary: true },
        { key: "member_c", name: "Crown", color: "190,90,220,1", hereditary: true },
      ],
      vector: [{ key: "v1", name: "Contact" }],
    },
    coupling: {
      populationScalar: "population",
      civs: [
        { trait: "member_a", name: "Avale", color: "#5a78dc" },
        { trait: "member_b", name: "Bvale", color: "#dc785a" },
        { trait: "member_c", name: "Crown", color: "#be5adc" },
      ],
      breakawayHostility: { attr: "hostility", amount: 0.25 },
      dispute: {
        hostilityAttr: "hostility",
        arbitration: {
          strengthScalars: [{ scalar: "population", weight: 1 }],
          authorityRatio: 1.5,
          afterDays: 5,
        },
      },
    },
  });

  it("the crown's award drains the pressure; claims and flags stand", async () => {
    const dw = await bootDual(arbitrationSpec(), 99, bootCiv);
    const start = dw.totalPop();
    await dw.advanceDays(40);

    const awards = dw.resolutions();
    // The border re-arms after each award, so the crown keeps settling it.
    expect(awards.length).toBeGreaterThanOrEqual(2);
    expect(awards.every(r =>
      r.channel === "arbitration" && r.mode === "award" &&
      r.civ === "member_c" && r.casualties === 0,
    )).toBe(true);
    // Nobody flipped, nobody died — the award is a split, not a conquest.
    expect(dw.civOf("avill")?.trait).toBe("member_a");
    expect(dw.civOf("bvill")?.trait).toBe("member_b");
    expect(dw.conquests().length).toBe(0);
    expect(dw.vitalLedger()).toEqual({ births: 0, deaths: 0 });
    expect(dw.totalPop()).toBe(start);
    // A live, arbitrated border is never "at rest" — by design.
    expect(dw.isResting()).toBe(false);
  });
});
