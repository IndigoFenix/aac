// THE HONEST WALK LEG (economy-arc-opening.md batch 0, W2 + W3)
//
// `walkTo` is the ONE "steer this body to a point" primitive — needs and
// commands both run it. Two defects were diagnosed in it, and this file pins
// both on the LIVE headless host (the real quest-host, the real world-host,
// the real controller: no mock can lie about either of them).
//
//  W3 — THE BARE-CID ERRAND. `world.setNpcErrand(cid, …)` looks its id up in
//       the controller map and SILENTLY NO-OPS on a miss (world-host.ts). Every
//       creature whose body is `npc_<cid>` — everything but resident_*/pet_* —
//       therefore got a written `session.walk` record and NO ERRAND: a leg that
//       could never progress, and (before W2) never expire either.
//
//  W2 — THE LEG THAT NEVER ENDS. `walkTo` judges MOTION, never PROGRESS: once
//       the routed errand is issued nothing re-examines it, so a leg that turns
//       out to be four times its estimate simply runs for as long as the body
//       keeps shuffling. Each issued leg now carries a budget derived from the
//       polyline that was actually issued, spent by `dt` (never wall clock);
//       exhaustion cancels the leg and re-plans from where the body stands —
//       the SAME destination, so this is a re-route, not a re-aim.
//
// Headless boot only — no DOM / GL / DB. See headless-quest-boot.test.ts for
// why the arcs here are a few sim seconds rather than a minute.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";

const specPath = join(process.cwd(), "games", "dollhouse", "src", "game.spec.json");
const doc = JSON.parse(readFileSync(specPath, "utf8"));

const DT = 1 / 20;

/** A CAST CREATURE, the npc_-bodied kind: a body registered with the world host
 *  under `npc_<cid>` while the mind is known by the bare `cid`. This is the
 *  shape every wilderness creature, every quest figure and every recruited
 *  townsperson has — everything the sim carries except residents and pets. */
function standCastCreature(run: TextQuestRun, cid: string): { body: string; at: { x: number; y: number } } {
  const spark = run.state.avatars.player!;
  const at = { x: spark.x + 2, y: spark.y + 2 };
  const body = `npc_${cid}`;
  expect(
    run.host.world!.addNpc({
      id: body,
      x: at.x,
      y: at.y,
      behavior: { movement: "stationary", home: { ...at }, conversationRadius: 3 },
    }),
  ).toBe(true);
  expect(run.state.avatars[body]).toBeDefined();
  return { body, at };
}

/** Install the plain "go to that spot" pursuit the ONE driver runs — the same
 *  entry `directCreatureTo` writes for a pointed-at place. Set directly so the
 *  pin is about the WALK, not about the gaze gate in front of it. */
function orderWalkTo(run: TextQuestRun, cid: string, to: { x: number; y: number }): void {
  run.session.pursuits.set(cid, {
    source: "command",
    goal: { kind: "goTo", place: { kind: "point", x: to.x, y: to.y } },
    glyph: "here",
  } as never);
}

describe("W3 — a cast creature ordered to walk actually RECEIVES an errand", () => {
  it("an npc_-bodied creature's leg reaches its BODY, not its (bodiless) creature id", () => {
    const run = bootTextQuest({ world: doc, dt: DT });
    try {
      run.advance(6);
      const cid = "castwalker";
      const { body, at } = standCastCreature(run, cid);
      // Nothing is driving it yet, so nothing has been issued.
      expect(run.host.world!.npcErrandPath(body)).toBeNull();

      const target = { x: at.x + 14, y: at.y };
      orderWalkTo(run, cid, target);
      run.advance(2); // the pursuit driver runs each frame

      // ① THE ERRAND IS ON THE BODY. This is the assertion the bug failed: the
      //   creature id names no controller, so the issue silently evaporated.
      const path = run.host.world!.npcErrandPath(body);
      expect(path).not.toBeNull();
      expect(path!.points.length).toBeGreaterThan(0);
      // ② …and the walk record the host keeps agrees about where it is going.
      const w = run.session.walk.get(cid);
      expect(w).toBeDefined();
      expect(Math.hypot(w!.tx - target.x, w!.ty - target.y)).toBeLessThanOrEqual(0.4);
      // ③ The plain "cid" key names no controller at all — which is exactly
      //   why issuing to it was a silent no-op rather than a crash.
      expect(run.host.world!.npcErrandPath(cid)).toBeNull();
    } finally {
      run.dispose();
    }
  }, 600_000);
});

describe("W2 — every issued leg carries, and spends, its own budget", () => {
  it("the budget is POSITIVE, derived from the issued polyline, and spent by dt", () => {
    const run = bootTextQuest({ world: doc, dt: DT });
    try {
      run.advance(6);
      const cid = "castbudget";
      const { body, at } = standCastCreature(run, cid);
      const target = { x: at.x + 14, y: at.y };
      orderWalkTo(run, cid, target);
      run.advance(2);

      const w = run.session.walk.get(cid)!;
      expect(w).toBeDefined();
      const opening = w.legS;
      // A real budget: not zero, not infinite, and at least the straight-line
      // walking time — the polyline can only be longer than the chord.
      expect(Number.isFinite(opening)).toBe(true);
      expect(opening).toBeGreaterThan(14 / 1.6);

      // SPENT BY dt, NOT BY THE CLOCK. Ten frames of `DT` remove exactly ten
      // `DT` — the property that makes two same-seed runs identical. (Guarded
      // against a re-issue in the middle of the window, which would legitimately
      // top the budget back up: the record's identity is the tell.)
      const before = run.session.walk.get(cid)!;
      const legS0 = before.legS;
      run.advance(10);
      const after = run.session.walk.get(cid);
      if (after === before) expect(legS0 - after.legS).toBeCloseTo(10 * DT, 6);
      // …and however it went, the body is genuinely under way.
      expect(run.host.world!.npcErrandPath(body)).not.toBeNull();
    } finally {
      run.dispose();
    }
  }, 600_000);

  it("🚨 exhaustion RE-PLANS the same destination — it never re-aims, and never lingers spent", () => {
    const run = bootTextQuest({ world: doc, dt: DT });
    try {
      run.advance(6);
      const cid = "castexpire";
      const { at } = standCastCreature(run, cid);
      const target = { x: at.x + 14, y: at.y };
      orderWalkTo(run, cid, target);
      run.advance(2);

      const spent = run.session.walk.get(cid)!;
      const dest = { tx: spent.tx, ty: spent.ty };
      // Burn the leg's budget down to nothing — the "this leg has outlived its
      // own plan" state, reached here in one line instead of in 100 s of sim.
      spent.legS = DT / 2;
      run.advance(1);

      const fresh = run.session.walk.get(cid);
      // ① THE EXHAUSTED RECORD IS GONE. Nothing may keep walking on a spent
      //    leg — that is the silent-detour state the whole fix exists to end.
      expect(fresh).not.toBe(spent);
      // ② A re-plan, not a give-up: the body is still walking…
      expect(fresh).toBeDefined();
      // ③ …to the SAME PLACE. Re-aiming per tick is the oscillation the
      //    hysteresis margin forbids; only the ROUTE is allowed to change.
      expect(fresh!.tx).toBeCloseTo(dest.tx, 6);
      expect(fresh!.ty).toBeCloseTo(dest.ty, 6);
      // ④ …on a budget bought fresh from the new plan.
      expect(fresh!.legS).toBeGreaterThan(0);
    } finally {
      run.dispose();
    }
  }, 600_000);

  it("across a whole live arc no leg is ever left holding a spent budget, and the goal never drifts", () => {
    // The invariant, walked rather than asserted at a point: over a real arc of
    // sim NO walk record may ever be observed at or below zero (a record that
    // expires is replaced in the tick that notices, so this is a true
    // invariant, not a race) — and the committed destination must be the same
    // one throughout, however many times the ROUTE is re-planned underneath it.
    const run = bootTextQuest({ world: doc, dt: DT });
    try {
      run.advance(6);
      const cid = "castarc";
      const { at } = standCastCreature(run, cid);
      const target = { x: at.x + 40, y: at.y + 12 }; // a long way, past several lots
      orderWalkTo(run, cid, target);

      let observed = 0;
      let dest: { tx: number; ty: number } | null = null;
      for (let k = 0; k < 24; k++) {
        run.advance(5);
        for (const w of run.session.walk.values()) {
          observed++;
          expect(w.legS).toBeGreaterThan(0);
        }
        const mine = run.session.walk.get(cid);
        if (!mine) continue; // arrived, or the pursuit finished — both fine
        dest ??= { tx: mine.tx, ty: mine.ty };
        // The route may be re-planned; the DESTINATION may not wander.
        expect(Math.hypot(mine.tx - dest.tx, mine.ty - dest.ty)).toBeLessThanOrEqual(0.4);
      }
      expect(observed).toBeGreaterThan(0); // the arc really did walk
    } finally {
      run.dispose();
    }
  }, 600_000);
});
