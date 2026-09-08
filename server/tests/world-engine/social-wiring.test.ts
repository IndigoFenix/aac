/**
 * ⚖️ THE POLITICS SUBSTRATE, WIRED INTO THE HOST (interpersonal-politics.md
 * S-3/S-4/S-7) — the LIVE half of builder S3. ONE boot, no cheats.
 *
 * S1 landed the pure substrate and its own note says the honest thing about it:
 * *"Nothing calls any of this yet."* This file measures what changed when
 * something did:
 *
 *  ① THE ROWS ARE OPT-IN. `bodyNeedTemplates` returns the social third only
 *    when asked, and the host asks only under `bodyNeedsOn` — which is why the
 *    dollhouse bench is byte-identical. Pinned on the pure function (cheap) and
 *    proved at play level by the bench itself, not by a second town boot: a
 *    value-import of quest-host already pays a heavy per-worker transform tax
 *    and a second city build is the most expensive thing this folder can do.
 *
 *  ② A SETTLER CAN ACTUALLY REACH A PARTNER. Before this round `bodyNeedCtx`
 *    had no social station arm at all — a settler's social row resolved an
 *    EMPTY list and BLOCKED, every time, forever. The pin is the `converse`
 *    pursuit: a decided social row that names another body.
 *
 *  ③ THE ARRIVAL IS AN ACT, NOT A HARD-CODED WARMTH. Under the capability the
 *    arrival routes through `applySocialEvent`, so the edge it writes is the
 *    pure module's ±0.03 — never the dollhouse arm's 0.05/0.02. That difference
 *    IS the wiring: no other path in the engine writes a 0.03 affinity edge.
 *
 *  ④ AND IT IS DIRECTED. Two entries, not one symmetric write — which is the
 *    whole reason `nudgeDirected` exists beside `warmRelations`, because an
 *    order, a yield and a refusal all land on ONE side.
 *
 * DB-free / GL-free — `npm run test:engine -- social`.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import { bodyNeedTemplates } from "@shared/world-engine/interaction/behavior/body-needs.js";
import {
  STANDING_DEFER_AT,
  WITNESS_CAP,
  orderOutcomeParties,
  orderWindowOutcome,
} from "@shared/world-engine/interaction/behavior/social-acts.js";
import {
  DEFAULT_RELATION,
  compliance,
  deference,
} from "@shared/world-engine/interaction/behavior/relations.js";
import { VOLUNTEER_COMPLIANCE } from "@shared/world-engine/interaction/behavior/task-pool.js";
import { sliceOutcome } from "@shared/world-engine/kernel/town/pull-labor.js";
import { NEED_PURSUIT_MOTIVES } from "@shared/world-engine/interaction/behavior/need-goals.js";
import { NEED_FILL_DAYS, DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";
import { makePersonality } from "@shared/world-engine/interaction/behavior/personality.js";

const homestead = JSON.parse(
  readFileSync(join(process.cwd(), "scripts", "worlds", "homestead.spec.json"), "utf8"),
) as Record<string, unknown>;

type Sess = {
  bodyNeeds: Map<string, Map<string, { level: number; at: number }>>;
  relations: Map<string, { affinity: number; trust: number; authority: number; fear: number }>;
  pursuits: Map<string, { source: string; tplKey?: string; goal: { kind: string; target?: string } }>;
  needStep: Map<string, { tplKey: string; kind: string; objId?: string }>;
};

describe("THE SOCIAL THIRD IS A SHAPE, NOT A SPECIAL CASE", () => {
  it("standing and security have their own entries in the ONE pacing table, behind loneliness", () => {
    // The rates are DATA (scale.ts), never a constant in the host — and their
    // ORDER is the design: company is the daily want, being looked up to and
    // feeling safe are the slower ones underneath it.
    expect(NEED_FILL_DAYS.standing).toBe(1.5);
    expect(NEED_FILL_DAYS.security).toBe(2);
    expect(NEED_FILL_DAYS.social).toBeLessThan(NEED_FILL_DAYS.standing);
    expect(NEED_FILL_DAYS.standing).toBeLessThan(NEED_FILL_DAYS.security);
  });

  it("both rows ride the unified pursuit, exactly as `social` does", () => {
    // 🚨 THE SILENT-FAILURE PIN. `needPursuitGoals` returns [] for a motive not
    // in this set, and the caller then falls through to a legacy walker that has
    // no arm for a social row — so a missing entry here is a want that DECIDES
    // and then does nothing at all, with no error anywhere.
    expect(NEED_PURSUIT_MOTIVES.has("social")).toBe(true);
    expect(NEED_PURSUIT_MOTIVES.has("standing")).toBe(true);
    expect(NEED_PURSUIT_MOTIVES.has("security")).toBe(true);
  });

  it("① the rows are OPT-IN — a caller that does not ask gets exactly what it always got", () => {
    // The dollhouse never asks (`bodyNeedsOn` is false there), which is the
    // whole content of the bench guarantee. Pinned here on the pure function so
    // a future caller cannot turn the third on by accident.
    const off = bodyNeedTemplates(DOLLHOUSE_SCALE, { pullOn: true }).map((t) => t.key);
    expect(off).not.toContain("standing");
    expect(off).not.toContain("security");
    expect(off).not.toContain("social");
    const on = bodyNeedTemplates(DOLLHOUSE_SCALE, {
      pullOn: true,
      social: true,
      personality: makePersonality({}),
    }).map((t) => t.key);
    expect(on).toContain("social");
    expect(on).toContain("standing");
    expect(on).toContain("security");
    // …and the rows the body-needs round already gave a homeless body are
    // untouched by the opt-in: one behaviour model, a rung is a flag.
    for (const k of off) expect(on).toContain(k);
  });

  it("the witness cap and the standing bar are shape constants, not tuning", () => {
    expect(WITNESS_CAP).toBe(6);
    expect(STANDING_DEFER_AT).toBeGreaterThan(0);
    expect(STANDING_DEFER_AT).toBeLessThan(1);
  });
});

describe("BOOT — a homestead settler: the rows, a partner, and an `attend`", () => {
  let run: TextQuestRun;
  const sess = () => run.session as unknown as Sess;

  /** Row keys every settler carried after the first decide. */
  const rowKeys = new Set<string>();
  /** Social-family pursuits seen installed, as `${tplKey}→${goal.kind}`. */
  const socialPursuits = new Set<string>();
  /** Every social trip's named partner, as `${seeker}>${partner}`. */
  const conversePartners = new Set<string>();
  /** Peer affinity edges at the end of the window. */
  const peers = new Map<string, number>();

  beforeAll(() => {
    run = bootTextQuest({ world: homestead, seed: 11, dt: 0.5 });
    run.advance(20); // 10 s — the first decide, which is what seeds the rows
    for (const rows of sess().bodyNeeds.values()) for (const k of rows.keys()) rowKeys.add(k);

    // The social clock is 192 s at this scale, so 700 s crosses it several times
    // over. Watched frame by frame: a pursuit install and a credit are each ONE
    // write, and a sampled advance steps straight over both.
    for (let i = 0; i < 1400; i++) {
      run.stepFrame();
      const s = sess();
      for (const [cid, pur] of s.pursuits) {
        const key = pur.tplKey ?? "";
        if (key !== "social" && key !== "standing" && key !== "security") continue;
        socialPursuits.add(`${key}→${pur.goal.kind}`);
        if (pur.goal.kind === "converse" && pur.goal.target) conversePartners.add(`${cid}>${pur.goal.target}`);
      }
      for (const [cid, step] of s.needStep) {
        if (step.kind !== "socialize") continue;
        socialPursuits.add(`${step.tplKey}→needStep`);
        if (step.objId) conversePartners.add(`${cid}>${step.objId}`);
      }
    }
    for (const [key, rel] of sess().relations) {
      const [a, b] = key.split("|");
      if (!a || !b || a.startsWith("player") || b.startsWith("player")) continue;
      if (rel.affinity !== 0) peers.set(key, rel.affinity);
    }
  });

  it("every settler carries the social third, alongside the rows it already had", () => {
    expect(rowKeys.has("social")).toBe(true);
    expect(rowKeys.has("standing")).toBe(true);
    expect(rowKeys.has("security")).toBe(true);
    expect(rowKeys.has("hunger:food")).toBe(true);
    expect(rowKeys.has("energy")).toBe(true);
  });

  it("② a social row REACHES a partner — the station arm that did not exist", () => {
    // 🚨 The regression this pins: with no social arm in `bodyNeedCtx` the
    // decide returned `blocked` forever and this set stayed EMPTY.
    expect(conversePartners.size).toBeGreaterThan(0);
    for (const pair of conversePartners) {
      const [seeker, partner] = pair.split(">");
      expect(partner).toBeTruthy();
      expect(partner).not.toBe(seeker);
      expect(partner!.startsWith("player")).toBe(false);
    }
    // …and it rides `converse` (or the legacy socialize step), never a goal
    // invented for this row.
    for (const seen of socialPursuits) {
      expect(seen.endsWith("→converse") || seen.endsWith("→needStep")).toBe(true);
    }
  });

  it("③ the arrival went through the PURE module — a 0.03 edge, never 0.05", () => {
    // `attend`'s table says mutual affinity +0.03. The dollhouse arm's
    // hard-coded warmth is 0.05/0.02 and is unreachable under the capability, so
    // an edge that is not a whole number of 0.03s would mean the gate leaked.
    expect(peers.size).toBeGreaterThan(0);
    let sawUnit = false;
    for (const v of peers.values()) {
      const n = v / 0.03;
      expect(Math.abs(n - Math.round(n))).toBeLessThan(1e-6);
      if (Math.round(n) >= 1) sawUnit = true;
    }
    expect(sawUnit).toBe(true);
  });

  it("④ an `attend` is MUTUAL and DIRECTED — both rows exist, and separately", () => {
    let pairsBothWays = 0;
    for (const key of peers.keys()) {
      const [a, b] = key.split("|");
      if (peers.has(`${b}|${a}`)) pairsBothWays++;
    }
    expect(pairsBothWays).toBeGreaterThan(0);
  });
});

/**
 * ⚖️ M1 AT THE SLICE (round-lead ruling on P-S3-1) — the two pure halves of the
 * decision the pursuit-death seat makes. Kept pure ON PURPOSE: the play-level
 * proof is a 1210 s homestead arc (25 `order-done`, 18 `order-failed`, the
 * player's authority moving 0.80 → 1.00 with settler_3 and back to 0.66 with
 * settler_0), which is a transcript measurement and not something a jest boot
 * should pay for a second time.
 */
describe("M1 AT THE SLICE — a spoken slice's outcome, and whose it is", () => {
  const haul = { siteId: "o:3", agreementId: "ag1", units: 4 } as const;
  const chop = { siteId: "fell:7", objId: "tree_2" } as const;
  // ⚠️ A DWELL SLICE CARRIES NONE OF THE THREE FIELDS `sliceOutcome` READS —
  // no chop object, no units, no agreement — which is exactly what makes the
  // SITE the only thing left to ask. Spelled as the empty bill it is: the
  // `{ siteId }` this used to be was a weak-type error (`siteId` is not in the
  // `Pick`), invisible to `npm run check`, which does not typecheck tests.
  const dwell: Parameters<typeof sliceOutcome>[0] = {};

  it("a DELIVERED haul is `order-done`; a released one is `order-failed`", () => {
    expect(sliceOutcome(haul, { agreementDone: true })).toBe("order-done");
    expect(sliceOutcome(haul, { agreementDone: false })).toBe("order-failed");
  });

  it("a DWELL reads the site — banked labour is done, a site that stopped is not", () => {
    expect(sliceOutcome(dwell, { siteLanded: true })).toBe("order-done");
    expect(sliceOutcome(dwell, { siteLanded: false })).toBe("order-failed");
  });

  it("🚨 UNKNOWABLE NEVER PRICES ANYBODY — a chop, and a bench with no order row", () => {
    // The chop's mark retires whether the tree came down or could not be cut at
    // all, and a craft bench stops offering work when its raw runs out exactly
    // as it does when the batch is milled. M1 is evidence, so it says nothing.
    expect(sliceOutcome(chop, { agreementDone: true })).toBeNull();
    expect(sliceOutcome(chop, { siteLanded: true })).toBeNull();
    expect(sliceOutcome(dwell, { siteLanded: null })).toBeNull();
    expect(sliceOutcome(dwell, {})).toBeNull();
  });

  it("🚨 THE BRANCH ORDER IS `contributeStillWorking`'s — chop, then agreement, then site", () => {
    // A lot-clearing chop CARRIES an agreement it never began (the bookkeeper's
    // liveness sweep needs it). Asking the agreement first would fail that row
    // and charge the author for a tree that fell perfectly well.
    expect(sliceOutcome({ ...chop, agreementId: "ag9" }, { agreementDone: false })).toBeNull();
  });

  it("a SPOKEN slice names its two parties — actor did it, author asked for it", () => {
    expect(orderOutcomeParties({ issuer: "player", claimedBy: "settler_1", spoken: true }, true)).toEqual({
      actor: "settler_1",
      author: "player",
    });
  });

  it("🚨 AN UNSPOKEN ROW IS NOBODY'S ORDER — every civic sweep posts as the local player", () => {
    expect(orderOutcomeParties({ issuer: "player", claimedBy: "settler_1", spoken: false }, true)).toBeNull();
    expect(orderOutcomeParties({ issuer: "player", claimedBy: "settler_1" }, true)).toBeNull();
  });

  /**
   * ⚖️ P-6 — THE FOUR CONSTRUCTION SEATS. A spoken BUILD order does not retire
   * in the host's pool sweep (it skips `build`/`buildwork` on purpose: "these
   * complete off REAL construction state, never off the walk"), so M1's door is
   * injected into the construction director and called at the completion —
   * `commitFoundedOrder` for the finished founding, the cancel path for a
   * called-off one, the housekeeping sweep for a worked-through bill.
   *
   * 🚨 WHY THIS IS PURE AND NOT A BOOT. The seat needs a spoken `build` order to
   * be CLAIMED, MATERIALS STAGED and the walls FINISHED. The shipped homestead
   * fixture this file already boots never stages at all (measured over 1210 s:
   * `transcripts/pol1-l2-homestead.txt`, "the only site line is `SITE 2
   * thing(s) being built.`"), and the world that does finish a house takes
   * 1287.5 s of sim to do it (`pol-final-mill.txt`) — three sim-days of frames
   * for one assertion. What is pinnable without paying that is the ROW the seat
   * hands `orderOutcomeParties`, spelled exactly as the claim seat builds it.
   */
  it("a BUILD row from the pool claim seat names its parties — M1's construction door", () => {
    // quest-host's `{kind:"build"}` claim arm: `b.spoken = true` ("an untargeted
    // order is still the player's"), the issuer is whoever spoke the sentence,
    // the claimant is the winner `chooseClaimant` picked.
    expect(
      orderOutcomeParties({ id: "t7", issuer: "player", claimedBy: "settler_2", spoken: true }, true),
    ).toEqual({ actor: "settler_2", author: "player" });
    // …and the AMBIENT `buildwork` slot beside it stays silent: the construction
    // sweep posts it with no `spoken` stamp, so a civic lot the town thought of
    // can never earn the player authority however many hands work it.
    expect(orderOutcomeParties({ id: "t8", issuer: "player", claimedBy: "settler_2" }, true)).toBeNull();
  });

  it("🚨 SELF-ISSUED EARNS NOTHING, and neither does an issuer that is not a person", () => {
    expect(orderOutcomeParties({ issuer: "settler_1", claimedBy: "settler_1", spoken: true }, true)).toBeNull();
    expect(orderOutcomeParties({ issuer: "world", claimedBy: "settler_1", spoken: true }, true)).toBeNull();
    expect(orderOutcomeParties({ issuer: "o:3", claimedBy: "settler_1", spoken: true }, false)).toBeNull();
    expect(orderOutcomeParties({ issuer: "player", claimedBy: null, spoken: true }, true)).toBeNull();
  });
});

/**
 * ⚖️ L-2 — THE GATE IS THE BOND, and the arithmetic it is made of. `bondStrength`
 * is a host closure (it has to be: `playerGroup` and `relationToward` both live
 * there), so what is pinned here is the pure half it delegates to — the numbers
 * that decide whether a spoken order lands at all.
 */
describe("L-2 — WHO MAY GIVE AN ORDER", () => {
  /** quest-host ~:1027, the household bond `relationToward` falls back to. */
  const FAMILY = { affinity: 0.5, trust: 0.8, authority: 0.8, fear: 0 } as const;
  const mood = makePersonality({});

  it("a STRANGER is under the bar — the spirit gets no special case either", () => {
    // 🚨 THE MEASURED CONSEQUENCE, and the reason the homestead arc lands zero
    // settler→settler orders: every settler pair on a founding world sits at
    // DEFAULT_RELATION, so a settler asking a settler is asking a stranger.
    expect(deference(DEFAULT_RELATION, mood, { certainty: 0 })).toBeLessThan(VOLUNTEER_COMPLIANCE);
    expect(compliance(DEFAULT_RELATION, mood)).toBeLessThan(VOLUNTEER_COMPLIANCE);
  });

  it("a HOUSEHOLD bond clears it — which is why the player's own crew obeys", () => {
    expect(deference(FAMILY, mood, { certainty: 0 })).toBeGreaterThanOrEqual(VOLUNTEER_COMPLIANCE);
  });

  it("`certainty` is the ONE thing the host answers, and it only bites on fear", () => {
    // `witnessedBy` feeds this: not how frightening you are (that is `fear`),
    // but whether you would SEE the refusal.
    const afraid = { affinity: 0, trust: 0.3, authority: 0, fear: 0.9 };
    expect(deference(afraid, mood, { certainty: 0 })).toBeCloseTo(compliance(afraid, mood), 12);
    expect(deference(afraid, mood, { certainty: 1 })).toBeGreaterThan(VOLUNTEER_COMPLIANCE);
    // 🚨 THE IDENTITY GUARD the bench rests on: fear 0 ⇒ certainty cannot move
    // a number, whatever the host answers.
    for (const certainty of [0, 1]) {
      expect(deference(DEFAULT_RELATION, mood, { certainty })).toBeCloseTo(compliance(DEFAULT_RELATION, mood), 12);
      expect(deference(FAMILY, mood, { certainty })).toBeCloseTo(compliance(FAMILY, mood), 12);
    }
  });
});

/**
 * ⚖️ L-4 — WAS THE POINT ANY GOOD? The pure edge BOTH halves of the window read
 * (`stepOpenOrders`' sweep and `closeOpenOrder`'s claim), so the two cannot
 * disagree about when an order stopped being answerable.
 */
describe("L-4 — THE WINDOW, and what closes it", () => {
  it("a claim BEFORE arrival is the strongest confirmation there is", () => {
    expect(orderWindowOutcome({}, 100, 20, "claim")).toBe("order-done");
    // …and the sweep says nothing about a body that is still walking.
    expect(orderWindowOutcome({}, 100, 20, "sweep")).toBeNull();
  });

  it("inside the window a claim COMPLETES it and the sweep leaves it open", () => {
    expect(orderWindowOutcome({ arrivedAt: 90 }, 100, 20, "claim")).toBe("order-done");
    expect(orderWindowOutcome({ arrivedAt: 90 }, 110, 20, "claim")).toBe("order-done"); // the edge itself
    expect(orderWindowOutcome({ arrivedAt: 90 }, 110, 20, "sweep")).toBeNull();
  });

  it("past the window the SWEEP fails it — pointing at an empty pile costs you", () => {
    expect(orderWindowOutcome({ arrivedAt: 90 }, 111, 20, "sweep")).toBe("order-failed");
  });

  it("🚨 A LATE CLAIM CREDITS NOBODY — obedience, not coincidence", () => {
    // The body stood there for a whole decide window and then found work of its
    // own. `null` leaves the row for the sweep to fail rather than handing the
    // leader an authority nudge for something it did not cause.
    expect(orderWindowOutcome({ arrivedAt: 90 }, 111, 20, "claim")).toBeNull();
  });
});

/**
 * ⚖️ L-2 / L-3 / L-4 AT PLAY — builder L2's three call sites (`stepOpenOrders`
 * in `stepBodyNeeds`, `closeOpenOrder` in `tryContribute`, `delegateBill` at the
 * branch where a firing need beat the bill), driven end to end.
 *
 * ONE extra boot, and it buys what no pure test can: the whole loop, from a
 * settler too hungry to work, through the order, the walk, and the follower's
 * own claim at the other end.
 *
 * 🚨 THE SEEDED BOND IS THE EXPERIMENT, NOT A CHEAT. On the shipped homestead
 * every settler→settler row is `DEFAULT_RELATION`, so `bondStrength` answers
 * 0.0735 and EVERY delegation is refused — measured over a 1210 s arc
 * (`transcripts/pol1-l2-homestead.txt`: 11 `order-refused`, 0 landed, `[pull]`
 * 52, identical to the run before delegation existed). That is the design
 * working ("foreman by being right about needs, never by fiat"), and it is also
 * why the LANDING half of L-3/L-4 is unreachable on any world we ship. So this
 * boot hands ONE body the bond a leader would have earned and leaves everybody
 * else a stranger: both arms of the same gate, one town.
 */
describe("BOOT — delegation: who may point, and what a point is worth", () => {
  /** The one body the crew defers to. Everybody else stays a stranger. */
  const LEADER = "settler_0";
  /** `CONTRIBUTE_IDLE_DECIDE_S` (quest-host) — the decide window an order is
   *  answered inside, and the one delegation is rate-limited by. */
  const WINDOW_S = 20;

  type Sess2 = {
    townClock: number;
    relations: Map<string, { affinity: number; trust: number; authority: number; fear: number }>;
    pursuits: Map<string, { source: string; goal: { kind: string }; author?: string }>;
  };

  interface Seen {
    t: number;
    line: string;
    /** `cid → source|goalKind|author` for every live pursuit at that moment. */
    after: Map<string, string>;
    /** Every live bubble's composed glyph string. */
    bubbles: string[];
  }

  const ANNOUNCE = /^\[social\] order ([^\s→]+)→([^\s→]+) (.+)$/;
  const OUTCOME =
    /^\[social\] (order-done|order-failed|order-refused) ([^\s→]+)→([^\s→]+) by=(\S+) route=(\S+) wit=(\d+)$/;

  let run: TextQuestRun;
  const seen: Seen[] = [];
  /** Every order that LANDED, in the order it was given. */
  const landed: Array<{ t: number; leader: string; follower: string; at: Seen }> = [];
  /** Every social outcome line, parsed. */
  const acts: Array<{ t: number; kind: string; actor: string; author: string; wit: number; at: Seen }> = [];

  beforeAll(() => {
    run = bootTextQuest({ world: homestead, seed: 11, dt: 0.5 });
    const sess = () => run.session as unknown as Sess2;
    run.advance(10); // 5 s on their feet
    run.speak("build + house"); // the ONE bill every link below hangs off
    // The bond a leader would have earned, handed over. `relationToward(actor,
    // author)` reads `${actor}|${author}`, so these are the FOLLOWERS' rows.
    for (const s of ["settler_1", "settler_2", "settler_3", "settler_4"]) {
      sess().relations.set(`${s}|${LEADER}`, { affinity: 0.6, trust: 0.9, authority: 0.9, fear: 0 });
    }

    const real = console.log;
    const buf: string[] = [];
    console.log = ((...a: unknown[]) => {
      const s = a.map((x) => String(x)).join(" ");
      if (s.startsWith("[social]")) buf.push(s);
    }) as typeof console.log;
    try {
      for (let i = 0; i < 1200; i++) {
        buf.length = 0;
        run.stepFrame();
        if (!buf.length) continue;
        const s = sess();
        const after = new Map<string, string>();
        for (const [cid, p] of s.pursuits) after.set(cid, `${p.source}|${p.goal.kind}|${p.author ?? "-"}`);
        const bubbles = Object.values(run.state.bubbles).map((b) => b.glyph ?? "");
        for (const line of buf) seen.push({ t: s.townClock, line, after, bubbles });
      }
    } finally {
      console.log = real;
    }

    for (const e of seen) {
      const a = ANNOUNCE.exec(e.line);
      if (a) landed.push({ t: e.t, leader: a[1]!, follower: a[2]!, at: e });
      const o = OUTCOME.exec(e.line);
      if (o) acts.push({ t: e.t, kind: o[1]!, actor: o[2]!, author: o[4]!, wit: Number(o[6]), at: e });
    }
  });

  afterAll(() => run?.dispose());

  it("L-3 — the trigger FIRES: a settler that skipped work for a need points somebody at the pile", () => {
    // 🚨 The regression this pins is the one L2 inherited: the L-3/L-4 block
    // compiled, was fully commented, and had ZERO call sites. Unwire
    // `delegateBill` again and nothing below this line has anything to measure.
    expect(landed.length + acts.filter((a) => a.kind === "order-refused").length).toBeGreaterThan(0);
  });

  it("L-2 — a STRANGER refuses, out loud, in front of witnesses, and takes no work", () => {
    const refusals = acts.filter((a) => a.kind === "order-refused" && a.author !== LEADER);
    expect(refusals.length).toBeGreaterThan(0);
    for (const r of refusals) {
      // The refuser is the ACTOR; the leader is both addressee and author — it
      // is the leader's standing a refusal costs.
      expect(r.actor).not.toBe(r.author);
      expect(r.wit).toBeGreaterThan(0);
      // VOCAL, never silent: the host's own `WONT_HELP_YOU` frame, on a bubble.
      expect(r.at.bubbles.some((g) => g.includes("help.not"))).toBe(true);
      // …and NOTHING was installed. A refused order must never leave the body
      // walking somewhere it did not agree to go.
      expect(r.at.after.get(r.actor) ?? "").not.toContain(`|${r.author}`);
    }
  });

  it("L-2 — the BONDED leader's order LANDS, and the pursuit carries its author", () => {
    // Same code path, same gate, ONE relation apart: the whole content of "the
    // gate is the bond".
    expect(landed.length).toBeGreaterThan(0);
    for (const o of landed) {
      expect(o.leader).toBe(LEADER);
      expect(o.follower).not.toBe(o.leader);
      // ⚖️ L-1: a leader POINTS. What lands is `directCreatureTo`'s goTo under
      // `source:"command"` with `Pursuit.author` = the leader — never a bill and
      // never a new pursuit source.
      expect(o.at.after.get(o.follower)).toBe(`command|goTo|${o.leader}`);
    }
  });

  it("L-3 — ONE order per leader per decide window, and never over an open one", () => {
    const asks = [
      ...landed.map((o) => ({ t: o.t, leader: o.leader, follower: o.follower })),
      ...acts
        .filter((a) => a.kind === "order-refused")
        .map((a) => ({ t: a.t, leader: a.author, follower: a.actor })),
    ].sort((a, b) => a.t - b.t);
    const lastBy = new Map<string, number>();
    for (const ask of asks) {
      const prev = lastBy.get(ask.leader);
      // `lastDelegateAt` is stamped whether or not the order landed — a body
      // whose need fires every tick cannot fill the town with refusals.
      if (prev !== undefined) expect(ask.t - prev).toBeGreaterThanOrEqual(WINDOW_S);
      lastBy.set(ask.leader, ask.t);
    }
    // …and no follower is asked twice while its first order is still open.
    for (const o of landed) {
      const closed = acts.find((a) => a.kind !== "order-refused" && a.actor === o.follower && a.t >= o.t);
      const end = closed?.t ?? Number.POSITIVE_INFINITY;
      expect(landed.filter((x) => x.follower === o.follower && x.t > o.t && x.t < end)).toEqual([]);
    }
  });

  it("L-4 — a settler's point is PRICED, and the outcome names the body it pointed at", () => {
    // The seat that never existed before: an `order-done` / `order-failed`
    // whose AUTHOR is a body rather than the spirit. M1 at the delegation.
    const byLeader = acts.filter((a) => a.kind !== "order-refused" && a.author === LEADER);
    expect(byLeader.length).toBeGreaterThan(0);
    for (const a of byLeader) {
      expect(["order-done", "order-failed"]).toContain(a.kind);
      // Every priced outcome answers an order that was actually GIVEN — the
      // synthetic `order:` row is never minted for a body nobody pointed at.
      expect(landed.some((o) => o.follower === a.actor && o.leader === a.author && o.t <= a.t)).toBe(true);
    }
  });
});
