/**
 * 🚨 A REPLACED ERRAND IS RETIRED, NEVER DROPPED — the ERRAND-WRITER ORPHAN
 * ROOT FIX (main's ruling 2026-09-09; pull-labor-round.md).
 *
 * THE DEFECT. `enqueueNpcErrand`'s queue is retired ONLY by its head's own
 * `onDone`/`onAbandon` — but `setNpcErrand` REPLACES a body's errand outright
 * and fires NEITHER, and a dozen seats call it directly (the pursuit's walk
 * leg, `beginAction`'s action pin, the walk home, the dwell pins, the
 * party/possession seats, the streamer's fold). A replaced head can then never
 * retire, the queue can never advance, and every reader of `npcTasks` —
 * `idleForDirect`, `ritualEligible`, the needs walker, the task pool — goes on
 * being told "somebody is spending this body" for ever. Measured on
 * `frontier-planet` seed 11 (Stage 1b, emergent-plans-round.md): `settler_0`
 * took a circle invitation at t = 854.5, an action pin replaced the
 * invitation's walk, and the body stood in camp for 1 546 s — 64 % of the run
 * — hunger climbing 3.2 → 9.6 while its four siblings foraged.
 *
 * Stage 1b landed the READER's guard (`idleForDirect`'s reap). THIS is the
 * writers' half: one door, `retireNpcErrands`, called by every seat that
 * replaces or clears a body's errands, firing each replaced errand's own
 * `onAbandon` with the leg that was IN FLIGHT.
 *
 * WHAT THIS FILE PINS:
 *   ① THE WRITER ENDS IT, AND THE READER'S BELT NEVER HAS TO. A queued errand
 *     on a body a writer takes over has its `onAbandon` fired — and the reap
 *     counter does NOT move, so it was the WRITER that ended it.
 *   ② AN EFFECT VERTEX IN FLIGHT GOES THROUGH THE HAUL DOOR. A porter carrying
 *     a load, taken over mid-trip, sets the load down where it stands and the
 *     agreement FAILS (`abandonHaul`) — exactly as a force-passed haul does.
 *     The leg reported is the one in flight, in the CALLER's own index space.
 *   ③ THE REAP FIRES ZERO TIMES ON THE ARC. `__errandStats.reaped` is the bug
 *     gauge: on a tree where every writer retires, no queue is ever orphaned,
 *     so Stage 1b's belt never has to catch one. Non-vacuous — the same run
 *     proves writers DID take bodies over with queues standing.
 *
 * DB-free / GL-free — `npm run test:engine -- errand-retire`.
 */
import { describe, it, expect, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import { __errandStats } from "@shared/world-engine/interaction/quest/quest-host.js";
import type { NpcErrand } from "@shared/world-engine/npc-controller.js";

const SEED = 11;
const DT = 0.5;
const DAY_S = 240;

// ⚖️ planet-boot round: THE DOCUMENT MOVED, `frontier-planet.spec.json` →
// `frontier-cell.spec.json`. What this suite needs is a founding CAMP that
// posts hauls and hands them to porters, not a planet — and the old document
// was a hand-typed town whose "planet cell" was four constants describing a
// temperate wood that exists nowhere on the world the browser bakes. The
// declared cell is GENERATED from the real one (cell 12755) and boots in
// milliseconds instead of paying the 25 s planetary bake.
const DOC = (): unknown =>
  JSON.parse(readFileSync(join(process.cwd(), "scripts", "worlds", "frontier-cell.spec.json"), "utf8"));

/** Capture `console.log` for the span of `fn` (the host speaks through it). */
function captured<T>(sink: string[], fn: () => T): T {
  const orig = console.log;
  console.log = (...parts: unknown[]) =>
    sink.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
  try {
    return fn();
  } finally {
    console.log = orig;
  }
}

const booted: TextQuestRun[] = [];
const boot = (): TextQuestRun => {
  const r = bootTextQuest({ world: DOC(), seed: SEED, dt: DT });
  booted.push(r);
  return r;
};
let live: TextQuestRun | null = null;
afterAll(() => booted.forEach((r) => r.dispose()));

describe("② a porter taken over mid-trip sets the load down — the haul door", () => {
  it("🧺 the writer's retirement runs `abandonHaul`: load down, agreement failed, leg in flight named", () => {
    const run = boot();
    const { session } = run;

    /** A settler really carrying a load for a live haul, with the trip queued. */
    const loadedPorter = (): { cid: string; agr: string } | null => {
      for (const a of session.transfers.all()) {
        if (a.status !== "moving" || !a.executor) continue;
        if (Object.values(a.carried ?? {}).reduce((n, v) => n + v, 0) <= 0) continue;
        if ((session.npcTasks.get(`npc_${a.executor}`)?.length ?? 0) === 0) continue;
        return { cid: a.executor, agr: a.id };
      }
      return null;
    };

    // THE ARC: a house wants blocks staged, so the site posts hauls and the
    // founders take them. (The same opening `carry-residuals` uses.)
    const log: string[] = [];
    let porter: { cid: string; agr: string } | null = null;
    captured(log, () => {
      let spoke = false;
      for (let i = 0; i < 600 && !porter; i++) {
        run.stepFrame();
        if (!spoke && session.townClock >= 12) {
          spoke = true;
          run.speak("build + house");
        }
        porter = loadedPorter();
      }
    });
    expect(porter).not.toBeNull(); // the premise is REAL on this arc

    const carriedBefore = Object.values(session.transfers.get(porter!.agr)?.carried ?? {}).reduce(
      (n, v) => n + v,
      0,
    );
    expect(carriedBefore).toBeGreaterThan(0);

    // …AND A WRITER TAKES THE BODY OVER: the spirit walks as it ("follow me"),
    // which is `applyPossession` — one of the seats the ruling names.
    const after: string[] = [];
    captured(after, () => {
      run.speak("you + follow + i_me", { targetId: porter!.cid });
      run.advance(4);
    });

    // THE DOOR RAN, and it named the leg IN FLIGHT — not leg 0. The index is in
    // the CALLER's own points (`enqueueNpcErrand.start` un-shifts a re-route),
    // which is what `issueTransferHaul`'s `i === 0` bag test is written against:
    // report leg 0 for a trip already carrying its load and the haul would shop
    // for another basket instead of setting the load down.
    const retired = after.find((l) => /^\[errand\] npc_\S+ — possession retired a queued errand/.test(l));
    expect(retired).toBeDefined();
    const legs = /at leg (\d+)\/(\d+)/.exec(retired!)!;
    expect(Number(legs[1])).toBeGreaterThan(0);
    expect(Number(legs[1])).toBeLessThan(Number(legs[2]));

    // …AND IT ENDED THROUGH `abandonHaul`, not by dropping the trip: the load is
    // SET DOWN where the body stands (never minted, never teleported) and the
    // agreement fails, so the bill can be re-posted to somebody who will walk it.
    const abandoned = after.find((l) => l.includes(`[haul] ${porter!.cid} ABANDONED ${porter!.agr}`));
    expect(abandoned).toBeDefined();
    expect(/set down (\d+)×/.exec(abandoned!)).not.toBeNull();
    expect(Number(/set down (\d+)×/.exec(abandoned!)![1])).toBeGreaterThan(0);
    expect(session.transfers.get(porter!.agr)?.status ?? "gone").toBe("failed");

    // 🚨 …AND THE READER'S BELT NEVER SAW IT. Before this round the queue simply
    // stayed behind, and `idleForDirect`'s reap was the only thing that would
    // ever drop it — after the body had already been latched out of every
    // decide it had.
    expect(after.some((l) => l.includes("orphaned errand queue reaped"))).toBe(false);
  }, 300_000);
});

describe("①③ the arc: writers retire, and the orphan reap never fires", () => {
  it("③ `__errandStats.reaped` is 0 over three play-days — and the run is not vacuous", () => {
    const run = (live = boot());
    const reapedAt0 = __errandStats.reaped;
    const seatsAt0 = { ...__errandStats.bySeat };
    const log: string[] = [];
    // ⚖️ THE ARRANGE IS EXPLICIT — `run.speak("build + house")`, the same
    // opening ② already gives itself — and NOT ONE ASSERTION MOVED. See the
    // note beside `took` below for what it supplies and why the fixture always
    // needed it.
    captured(log, () => {
      let spoke = false;
      const frames = Math.round((3 * DAY_S) / DT);
      for (let i = 0; i < frames; i++) {
        run.stepFrame();
        if (!spoke && run.session.townClock >= 12) {
          spoke = true;
          run.speak("build + house");
        }
      }
    });

    // 🚨 THE GAUGE. A non-zero reading is not a body saved — it is a writer seat
    // that still replaces a queue without ending it.
    expect(__errandStats.reaped - reapedAt0).toBe(0);
    expect(log.some((l) => l.includes("orphaned errand queue reaped"))).toBe(false);

    // NOT VACUOUS, twice over: writers really did take bodies over with a queue
    // standing (so the reap had something to catch and did not), and the counter
    // this file reads is the one the running host writes (a mis-resolved module
    // would read a permanent zero and pass on nothing).
    //
    // 🚨 ⚖️ planet-boot round — THE FIXTURE ALWAYS ASSUMED AN ORDER, AND NEVER
    // SAID SO. This guard went red the moment the suite moved to
    // `frontier-cell.spec.json` (the REAL founding cell 12755), and the first
    // attribution written here blamed FOOD: the cell is a 28.4 °C tropical
    // forest, the party starved, and starving bodies were held to be too busy
    // foraging for any writer seat to fire.
    //
    //   THAT WAS WRONG, and the resource-packing round disproved it by landing
    //   on this exact cell: banana 0.554 → 11.67 plants/ha with carrot at
    //   6.04/ha beside it, and the ten-day arc goes 0.64 → 13.8 rations/day,
    //   starvation 36.95/29.06 → 0.03/0 body-days, stows 3 → 45. The camp now
    //   EATS — 32 takes, no starvation lines — and `__errandStats.bySeat` is
    //   STILL `{}` before and after. Food was never the variable.
    //
    //   THE TRUE CAUSE: a WRITER SEAT ONLY FIRES UNDER AN ORDER. Every seat the
    //   counter watches — the pursuit's walk leg, `beginAction`'s action pin,
    //   the walk home, the dwell pins — belongs to work somebody ASKED for. A
    //   founding camp left entirely to itself for three days never issues one:
    //   it forages, eats, sleeps, and no errand is ever replaced, so there is
    //   nothing for the reap to have caught and this guard is vacuous by
    //   construction. The old hand-typed document happened to produce one
    //   emergently; that was a property of that draw, not of the premise.
    //
    //   So the arc is GIVEN the premise outright — `speak("build + house")`,
    //   exactly the opening ② already writes for itself — and every assertion
    //   here is untouched, `took.length > 0` included. A premise you have to
    //   wait for is not a fixture.
    //
    //   ⏱️ COST: measured **56.8 s for this test, 60.9 s for the file** on the
    //   fed cell. (The same arrange was tried once BEFORE the packing landing
    //   and abandoned at 30+ minutes — that cost was the STARVING camp, five
    //   bodies re-deciding hunger every frame while hauls queued, and it is
    //   gone with the starvation.)
    const took = Object.entries(__errandStats.bySeat).filter(
      ([k, n]) => n > (seatsAt0[k] ?? 0),
    );
    expect(took.length).toBeGreaterThan(0);

    // …and nobody ends the span holding a queue that nothing is driving — the
    // end-state witness Stage 1b wrote, now with no reap standing behind it.
    for (const cid of run.session.bodyNeeds.keys()) {
      if (!/^settler_\d+$/.test(cid)) continue;
      const queued = run.session.npcTasks.get(`npc_${cid}`)?.length ?? 0;
      if (queued > 0) {
        expect(
          run.session.pursuits.has(cid) || run.session.walk.has(cid) || run.session.needStep.has(cid),
        ).toBe(true);
      }
    }
  }, 300_000);

  it("① a writer fires the replaced errand's OWN `onAbandon` — and the reap does not move", () => {
    const run = live!;
    const { session } = run;
    // A body a PURSUIT owns: `idleForDirect` refuses it (a live pursuit is
    // checked before the queue), so the reap cannot be what ends this — only a
    // writer can, which is exactly what the pin is about.
    const victim = [...session.bodyNeeds.keys()].find(
      (c) => /^settler_\d+$/.test(c) && session.pursuits.has(c),
    );
    expect(victim).toBeDefined();
    const body = `npc_${victim}`;
    const at = session.town?.stage.center ?? { x: 0, y: 0 };

    let abandonedAt = -1;
    let fired = 0;
    const planted: NpcErrand = {
      points: [
        { x: at.x, y: at.y },
        { x: at.x + 1, y: at.y },
      ],
      onArrive: () => {},
      onAbandon: (i: number) => {
        fired++;
        abandonedAt = i;
      },
    };
    session.npcTasks.set(body, [planted]);

    const reapedAt0 = __errandStats.reaped;
    const log: string[] = [];
    captured(log, () => {
      for (let i = 0; i < 240 / DT && fired === 0; i++) run.advance(1);
    });

    expect(fired).toBe(1); // ended ONCE — the door detaches before it fires
    expect(abandonedAt).toBe(0); // nothing of this errand was ever walked
    expect(session.npcTasks.get(body)?.length ?? 0).toBe(0); // and the queue is gone
    expect(__errandStats.reaped - reapedAt0).toBe(0); // …by a WRITER, not the belt
  }, 300_000);
});
