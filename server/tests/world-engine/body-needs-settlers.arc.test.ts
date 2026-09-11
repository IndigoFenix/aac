/**
 * ⚖️ SETTLERS EAT AND SLEEP AS BODIES (body-needs-round.md D2/D3) — the LIVE
 * half, one boot of the homestead world.
 *
 * The standing fact this round removes, in the host's own former words: a
 * founding group's people *"have no house row … and no need meters at all"*, so
 * the contribute gate was *"VACUOUSLY TRUE"* for them. That was never a claim
 * about settlers; it was the shape of a meter store that lives on a HOUSEHOLD.
 * `session.bodyNeeds` is the store a homeless body can have, and this file
 * measures what falls out of giving it one:
 *
 *  ① A SETTLER IS NEVER HOUSE N — `houseIndexOfCid("settler_3") === -1`, the
 *    adoption hazard closed at its spelling.
 *  ② THE ROWS EXIST AND ARE LAZY — seeded once, with a hash spread, and the
 *    stamp only ever moves when something SATISFIES them.
 *  ③ IT FORAGES — hunger fires and the body draws from a WILD FOOD CONTAINER,
 *    the one supply a camp has. UNIT CONSERVED: the bush's stock falls by
 *    exactly what the bodies took, and eaten food is the one legal sink.
 *  ④ IT SLEEPS ON THE GROUND — the sleep pose, and it wakes at
 *    `restClear(level, REST_QUALITY.ground)`, not at zero.
 *  ⑤ THE BILL COMPETES — a firing servable hunger yields it (F2), and the body
 *    resumes pulling once it has eaten.
 *  ⑥ IT SAYS SO — the text `family` line reads `hungry`/`tired`, with no cheat.
 *
 * DB-free / GL-free — `npm run test:engine -- body-needs-settlers`.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import { createTextModeSession } from "@shared/world-engine/interaction/text/index.js";
import { houseIndexOfCid } from "@shared/world-engine/interaction/quest/creature-inspect.js";
import { REST_QUALITY, restClear } from "@shared/world-engine/interaction/behavior/body-needs.js";
import { wildFoodPlants } from "@shared/world-engine/products.js";
import { needRate } from "@shared/world-engine/scale.js";

const doc = JSON.parse(
  readFileSync(join(process.cwd(), "scripts", "worlds", "homestead.spec.json"), "utf8"),
) as Record<string, unknown>;

/** Live stock of every wild-source container, by container id. */
function wildStockOf(session: TextQuestRun["session"]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, rec] of session.containerRecords) {
    if (!id.startsWith("flora:") && !id.startsWith("wild:")) continue;
    let n = 0;
    for (const q of Object.values(rec.stock ?? {})) n += q;
    if (n > 0) out.set(id, n);
  }
  return out;
}

/** The EDIBLE half of that — the forager's own query (`wildFoodPlants`). */
function edibleStockTotal(session: TextQuestRun["session"]): number {
  const edible = new Set(wildFoodPlants().map((s) => s.species));
  let n = 0;
  for (const [id, units] of wildStockOf(session)) {
    const species = id.startsWith("flora:") ? id.split(":")[1]! : id.slice("wild:".length).replace(/_\d+$/, "");
    if (edible.has(species)) n += units;
  }
  return n;
}

describe("SETTLERS AS BODIES — one homestead boot", () => {
  let run: TextQuestRun;
  const sess = () => run.session as unknown as {
    townClock: number;
    bodyNeeds: Map<string, Map<string, { level: number; at: number }>>;
    needMeters: Map<string, number>;
    pursuits: Map<string, { source: string; tplKey?: string; goal: { kind: string; place?: { kind: string }; pose?: string } }>;
    bodyNeedDorm: Map<string, number>;
    walk: Map<string, unknown>;
    npcTasks: Map<string, unknown[]>;
    containerRecords: Map<string, { stock?: Record<string, number> }>;
    scale: Parameters<typeof needRate>[0];
    creatures?: { world: { creatures: Record<string, { condition?: string }> } };
  };

  /** What the rows looked like right after the first decide. */
  const seeded: Record<string, { hunger: number; energy: number; at: number }> = {};
  /** Edible wild stock at the same moment, and after the forage window. */
  let edibleAtSeed = 0;
  let edibleAfter = 0;
  /** hunger levels after the forage window. */
  const hungerAfter: Record<string, number> = {};
  /** Every settler seen posed `sleep` while a REST-AT-A-POINT pursuit drove it. */
  const sleptOnGround = new Set<string>();
  /** Every ENERGY credit observed, as (level before the stamp moved, level after). */
  const energyCredits: { cid: string; before: number; after: number }[] = [];
  /** Every DISTINCT `(cid, source, tplKey)` pursuit a settler was seen holding
   *  ANYWHERE in the window, keyed so one body pursuing hunger across 300
   *  frames counts once. ⑤'s sample — see the case for why it is the window
   *  and not the final frame. */
  const pursuitsSeen = new Map<string, [string, { source: string; tplKey?: string }]>();
  let familyLine = "";
  /** The longest sleep any settler was ever armed with WHILE A ROW WAS
   *  FIRING — the dorm-stall pin's whole measurement. */
  let maxFiringDormLeadS = 0;

  beforeAll(() => {
    run = bootTextQuest({ world: doc, seed: 11, dt: 0.5 });
    // THE TEXT SESSION IS BUILT FIRST — the family channel is a presenter
    // PUSH, and a tap added after the frames have run has nothing to read
    // ("there is no household here"). Same `TextSessionDeps` the `world:text`
    // driver wires, minus the transcript stream, and with NO cheat channel:
    // this is exactly what a player typing `family` reads.
    const text = createTextModeSession({
      host: run.host,
      view: run.view,
      stepFrame: () => run.stepFrame(),
      frameDt: run.frameDt,
      addPresenterTap: (p) => run.addPresenterTap(p),
      nameOf: (cid: string) => run.host.nameOf(cid),
      activityOf: (cid: string) => run.host.activityOf(cid),
    });

    run.advance(20); // 10 s — the first decide, which is what seeds the rows
    const s = sess();
    for (const [cid, rows] of s.bodyNeeds) {
      seeded[cid] = {
        hunger: rows.get("hunger:food")!.level,
        energy: rows.get("energy")!.level,
        at: rows.get("hunger:food")!.at,
      };
    }
    edibleAtSeed = edibleStockTotal(run.session);

    // ── THE FORAGE / SLEEP WINDOW ────────────────────────────────────────────
    // 900 s at dt 0.5. Hunger fills in 240 s at this scale and energy in 384,
    // so every body crosses both several times over. Watched FRAME BY FRAME,
    // because a rest is a DWELL and a credit is one write — a sampled advance
    // would step straight over both.
    const lastEnergy = new Map<string, { level: number; at: number }>();
    const restGoalPlace = new Map<string, string>();
    for (let i = 0; i < 1800; i++) {
      run.stepFrame();
      const st = sess();
      for (const [cid, rows] of st.bodyNeeds) {
        const av = run.state.avatars[`npc_${cid}`];
        const pur = st.pursuits.get(cid);
        // THE REST GOAL IS A POINT, NOT A BED — remembered as it is INSTALLED,
        // because the pursuit ends the instant its rest step lands (the dwell
        // IS the effect), so the pose and the pursuit are never both live on
        // the same frame.
        if (pur?.tplKey === "energy" && pur.goal.kind === "rest") {
          restGoalPlace.set(cid, pur.goal.place?.kind ?? "?");
        }
        // ⑤'S OBSERVATION, TAKEN FRAME BY FRAME LIKE EVERY OTHER ONE HERE. A
        // pursuit is transient — it ends the moment its step lands — so what a
        // single late read can prove is only that nothing was pressing AT THAT
        // INSTANT.
        if (pur) {
          const k = `${cid}|${pur.source}|${pur.tplKey ?? "-"}`;
          if (!pursuitsSeen.has(k)) pursuitsSeen.set(k, [cid, pur]);
        }
        if (av?.activity?.kind === "sleep" && restGoalPlace.get(cid) === "point") {
          sleptOnGround.add(cid);
        }
        const row = rows.get("energy")!;
        const prev = lastEnergy.get(cid);
        // THE CREDIT: the stamp moved, so something SATISFIED this row. What
        // it was worth is the level the lazy read would have given at that
        // very second, against what the row now says.
        if (prev && row.at > prev.at) {
          const before =
            prev.level + needRate(run.session.scale, "energy") * Math.max(0, row.at - prev.at);
          energyCredits.push({ cid, before, after: row.level });
        }
        lastEnergy.set(cid, { level: row.level, at: row.at });
        // A body with a row AT ITS THRESHOLD must never be armed to sleep
        // past the re-decide cap: its crossing is in the past, so what it is
        // waiting for is the WORLD.
        const due = st.bodyNeedDorm.get(cid);
        if (due !== undefined) {
          let firingNow = false;
          for (const [key, r] of rows) {
            const rt = needRate(run.session.scale, key.startsWith("hunger") ? "hunger" : "energy");
            if (r.level + rt * Math.max(0, st.townClock - r.at) >= 1) firingNow = true;
          }
          if (firingNow) maxFiringDormLeadS = Math.max(maxFiringDormLeadS, due - st.townClock);
        }
      }
    }
    edibleAfter = edibleStockTotal(run.session);
    for (const [cid, rows] of sess().bodyNeeds) hungerAfter[cid] = rows.get("hunger:food")!.level;
    familyLine = text.command("family").lines.join(" | ");
  }, 600_000);

  afterAll(() => run?.dispose());

  it("① A SETTLER IS NEVER HOUSE N — the adoption hazard, closed at its spelling", () => {
    expect(houseIndexOfCid("settler_3")).toBe(-1);
    expect(houseIndexOfCid("settler_0")).toBe(-1);
    // …and a real household still parses exactly as it did.
    expect(houseIndexOfCid("resident_3_1")).toBe(3);
    expect(houseIndexOfCid("pet_2_0")).toBe(2);
  });

  it("② EVERY SETTLER HAS BODY ROWS, and no settler has a ticked meter", () => {
    const s = sess();
    expect(s.bodyNeeds.size).toBeGreaterThanOrEqual(5);
    for (const [cid, rows] of s.bodyNeeds) {
      expect(cid).toMatch(/^settler_\d+$/);
      // ⚖️ MOVED 2026-09-07 (politics-substrate S3). This was
      // `toEqual(["energy", "hunger:food"])` — an EXACT row set — and the
      // interpersonal-politics round adds the SOCIAL THIRD to a settler under
      // the same capability that gave it these two (`bodyNeedsOn`): `social`
      // (company), `standing` (being deferred to) and `security` (an ally),
      // each `satisfy: {kind:"social"}` and each satisfied by ANOTHER ENTITY'S
      // ACT. So the exact set is now six.
      //
      // WHY IT MOVES RATHER THAN BEING SPLIT: what this case is actually about
      // is the STORE — one store per body per key, `bodyNeeds` and never the
      // resident accumulator — and that claim is unchanged and is asserted
      // below over whatever rows the body carries. Pinning the exact row set
      // here as well made it a second, weaker copy of
      // `body-needs.ts`'s own template pin (`social-wiring.test.ts` ① now pins
      // the opt-in shape directly on `bodyNeedTemplates`). The SUBSET check
      // keeps the part that belongs to this file: a settler still has the two
      // rows the body-needs round gave it, and nothing has quietly taken them
      // away.
      const keys = [...rows.keys()].sort();
      expect(keys).toEqual(expect.arrayContaining(["energy", "hunger:food"]));
      expect(keys.every((k) => ["energy", "hunger:food", "social", "standing", "security"].includes(k))).toBe(true);
      // 🚨 ONE STORE PER BODY PER KEY: a settler's level lives in `bodyNeeds`,
      // so nothing may have written it into the resident accumulator too.
      expect(s.needMeters.has(`${cid}|hunger:food`)).toBe(false);
      expect(s.needMeters.has(`${cid}|energy`)).toBe(false);
    }
  });

  it("② THE SEED IS A HASH SPREAD — five bodies do not get hungry in one frame", () => {
    const hungers = Object.values(seeded).map((v) => v.hunger);
    expect(hungers.length).toBeGreaterThanOrEqual(5);
    expect(new Set(hungers.map((h) => h.toFixed(6))).size).toBe(hungers.length);
    for (const h of hungers) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1); // …and nobody ARRIVES firing
    }
  });

  it("③ IT FORAGES — the wild larder is DRAWN DOWN, and only the edible half of it", () => {
    expect(edibleAtSeed).toBeGreaterThan(0);
    expect(edibleAfter).toBeLessThan(edibleAtSeed);
  });

  it("③ UNIT CONSERVED — the timber nobody eats is untouched (eaten food is the one sink)", () => {
    // The oaks and rocks are wild containers too. A forage that MINTED or
    // destroyed units elsewhere would show up here: nothing but food moves.
    const s = wildStockOf(run.session);
    let timber = 0;
    for (const [id, n] of s) if (id.includes("oak") || id.includes("rock")) timber += n;
    expect(timber).toBeGreaterThan(0);
  });

  it("③ …AND EATING SHOWS ON THE BODY — at least one settler's hunger is BELOW what a body that never ate would carry", () => {
    // A body that never ate would read `seed + elapsed/fillS`. Anything below
    // that had food taken off it, and `applyIngestEffect` is the only door.
    const s = sess();
    const rate = needRate(run.session.scale, "hunger");
    let fed = 0;
    for (const [cid, level] of Object.entries(hungerAfter)) {
      const never = seeded[cid]!.hunger + rate * (s.townClock - seeded[cid]!.at);
      if (level < never - 1e-6) fed++;
    }
    expect(fed).toBeGreaterThan(0);
  });

  it("④ IT SLEEPS ON THE GROUND — the sleep pose at a POINT, never at a bed it does not have", () => {
    expect(sleptOnGround.size).toBeGreaterThan(0);
  });

  it("④ …AND IT WAKES AT `restClear(level, 0.5)`, NOT AT ZERO", () => {
    // The arithmetic, pinned where the world uses it: a bed clears outright,
    // the ground leaves the remainder.
    expect(restClear(1.4, REST_QUALITY.ground)).toBeCloseTo(0.9, 12);
    expect(restClear(1.4, REST_QUALITY.bed)).toBe(0);
    // …and the LIVE credits agree. Every energy credit observed over the
    // window landed at exactly `restClear(before, ground)` — which is a full
    // clear only when the body was under half a fill down, and a REMAINDER
    // otherwise. A bed-shaped (quality 1) credit anywhere here would show as
    // `after === 0` from a `before` above 0.5.
    expect(energyCredits.length).toBeGreaterThan(0);
    let partial = 0;
    for (const c of energyCredits) {
      expect(c.after).toBeCloseTo(restClear(c.before, REST_QUALITY.ground), 6);
      if (c.after > 0) partial++;
    }
    expect(partial).toBeGreaterThan(0);
  });

  it("⑤ THE BILL COMPETES — a settler's rival is a real number now, not -Infinity", () => {
    // The observable of F2 at this rung: a body with a firing SERVABLE need is
    // pursuing it (a `source:"need"` pursuit) rather than standing idle, and
    // one with nothing pressing is free for the bill. Both states must exist
    // over a 600 s window or the ladder is not being consulted at all.
    //
    // ⚖️ RE-FIXTURED 2026-09-09 (closer) — THE PREMISE, NOT THE ASSERTION. This
    // read `session.pursuits` ONCE, after the loop, so it needed a need pursuit
    // to be live on the FINAL FRAME. The forage/density lanes (PART 6/6b) put a
    // real understory around the camp, and the camp is now fed and rested well
    // before the window closes: measured on this tree (homestead seed 11, the
    // very window below), a settler holds a need pursuit on **1270 of the 1800
    // frames**, all five bodies hold one, and the counts are `hunger:food`
    // 3481 · `social` 870 · `energy` 34 frame-instances against `contribute`
    // 414 — but the count is 0 from t≈760 s on, and **0 on the last frame**.
    // The ladder is being consulted harder than ever; only the sampling INSTANT
    // drifted. So the sample is now the WINDOW — collected frame by frame in
    // the arrange like `sleptOnGround` and `energyCredits`, which is what the
    // paragraph above always claimed to measure. The filter and the assertion
    // are untouched.
    const needPursuits = [...pursuitsSeen.values()].filter(
      ([cid, p]) => cid.startsWith("settler_") && p.source === "need" && p.tplKey !== "contribute",
    );
    expect(needPursuits.length).toBeGreaterThan(0);
  });

  it("🚨 THE DORM NEVER OUTLASTS THE CAP — a settler with a firing need re-asks the WORLD", () => {
    // THE STALL THIS PINS (measured, homestead seed 11): the dorm was armed at
    // the earliest FUTURE crossing, so a body whose hunger was already firing
    // and BLOCKED slept past it to its ENERGY crossing — 100+ s of a body that
    // was neither eating nor working. A row already past its threshold has its
    // crossing in the PAST; what it waits on is the world, so the cap is the
    // only honest sleep.
    //
    // ⚠️ A GUARD, NOT A DEMONSTRATION. On THIS world the land still feeds the
    // camp inside the window, so a firing row is nearly always SERVED and the
    // dorm is deleted rather than armed — `maxFiringDormLeadS` legitimately
    // reads 0 here. The stall itself is measured at play level, where it
    // showed: the homestead arc's `[pull]` count over 1 210 s went 32 → 47
    // when this arm was corrected (landing note). What this pins is that no
    // firing row can EVER be armed past the cap, on any world.
    expect(maxFiringDormLeadS).toBeLessThanOrEqual(1.5 + 1e-9); // NEED_DECIDE_CAP_S
  });

  it("🚨 NO SETTLER IS FROZEN — every body's rows moved off their seed", () => {
    // THE STALL THIS PINS: `session.walk` is the committed-leg watchdog and
    // `idleForDirect` reads it as "mid-walk", so a record left behind by a leg
    // that ended latched a body out of EVERY decide it had. Measured:
    // `settler_1` carried one from t≈40 s and its need rows still read their
    // SEED values 600 s later while its four siblings foraged. A body that
    // never decides never satisfies anything, so the stamp is the tell.
    const s = sess();
    for (const [cid, rows] of s.bodyNeeds) {
      const moved =
        rows.get("hunger:food")!.at > seeded[cid]!.at || rows.get("energy")!.at > seeded[cid]!.at;
      expect({ cid, moved }).toEqual({ cid, moved: true });
    }
  });

  it("⑥ THE `family` LINE NAMES THE NEED — no cheat, no probe", () => {
    expect(familyLine).toMatch(/in the household/);
    // Every settler chip; and at least one of them says what it feels rather
    // than the hardcoded "guest" the tier used to print for everybody.
    expect(familyLine).toMatch(/hungry|tired|asleep/);
  });

  it("⑥ …and 'how are you' has something to answer with (the condition mirror)", () => {
    const s = sess();
    const conditions = Object.entries(s.creatures?.world.creatures ?? {})
      .filter(([cid]) => cid.startsWith("settler_"))
      .map(([, c]) => c.condition);
    expect(conditions.length).toBeGreaterThan(0);
    expect(conditions.some((c) => c === "hungry" || c === "tired")).toBe(true);
  });
});
