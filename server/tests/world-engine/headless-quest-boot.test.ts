// THE HEADLESS BOOT — `bootTextQuest` over the REAL shipped dollhouse document
// (games/dollhouse/src/game.spec.json), with no GL, no DOM and no canvas.
//
// text-mode.md law ⑥: bypass the pixels, never the sim. So the assertions are
// about the SIMULATION reaching the states a GL run reaches — the town builds,
// its residents get bodies, the focused household's interior is the one on
// show, the presenter is pushed, and a look/speak/press flows through the real
// player-action path.
//
// ── COST, AND WHY THE ARC IS SHORT (measured 2026-08-05, Node 22 / Windows) ──
// The headless frame is NOT free, and the cost is the SIM, not this layer:
//
//   plain Node (tsx)                    under jest (ESM VM, ~2× slower)
//   boot .......................  6.5 s   ..........................  11.5 s
//   first 20 frames (11 → 54 bodies)   25 s   ..........................  55 s
//   steady state, 54 bodies ....  0.45 s/frame  ..............  ~1.2 s/frame
//
// With `globalThis.__perfProbes = true`, a steady frame reads
//   [frame-phase] ~220ms — tick:2 npc:4 sim:214 render:0
//   [sim-blocks]  needsBlock ≫ n.economy > stream > s.frame ≫ everything else
// i.e. `render` — this entire text view — is 0-2 ms, and the town's live-needs /
// economy block plus the resident streamer are the whole cost, in code a GL run
// runs identically (perf-probes.ts documents the same standing hunt). NOT a
// headless pathology, so the fix is not in this layer.
//
// Consequently these tests walk a few SIM SECONDS, not the minute the brief
// first budgeted, and step at `dt = 1/20` — the world-host's own clamp ceiling
// (`Math.min(0.05, …)`) — which buys 3× the sim per frame. Every fact under
// test (reveal set, embodiment, presenter pushes) is dt-independent. Long-arc
// exploration belongs in the tsx CLI harness (`npm run world:text`), which pays
// none of the jest VM tax.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest } from "@shared/world-engine/headless/text-quest.js";
import { inFocusFrame, revealedInteriors } from "@shared/world-engine/render3d.js";
import { PLAYER_ID } from "@shared/world-engine/solver/space3d.js";

const specPath = join(process.cwd(), "games", "dollhouse", "src", "game.spec.json");
const doc = JSON.parse(readFileSync(specPath, "utf8"));

const DT = 1 / 20;

describe("bootTextQuest — the dollhouse, headless", () => {
  it("builds the town, embodies the focused household, and answers a spoken line", () => {
    const run = bootTextQuest({ world: doc, dt: DT });
    try {
      // ── AT BOOT ──────────────────────────────────────────────────────────
      expect(run.session.town).not.toBeNull(); // a LIVING town, not a bare quest world
      expect(run.session.dollhouse).not.toBeNull(); // …opened at a focused house
      expect(run.frameDt).toBeCloseTo(DT, 9);
      expect(run.seed).toBe(doc.game.world.seed);
      const bodiesAtBoot = Object.keys(run.state.avatars).length;
      expect(run.state.avatars[PLAYER_ID]).toBeDefined(); // the spirit's parked stand-in

      // A projection TAPS the presenter, it never replaces it.
      const boards: string[] = [];
      const toasts: string[] = [];
      run.addPresenterTap({
        board: (v) => boards.push(v.kind),
        toast: (t) => toasts.push(t),
      });

      run.advance(20); // one sim second

      // ── ① THE STREAMER STOOD BODIES UP ───────────────────────────────────
      const bodies = Object.keys(run.state.avatars).length;
      expect(bodies).toBeGreaterThan(bodiesAtBoot);

      // ── ② THE FOCUS HOUSE'S OWN RESIDENTS ARE AMONG THEM ─────────────────
      // Interior embodiment is gated on the reveal set, so the household of the
      // house the camera frames must be real bodies, not abstracted residents.
      const housePrefix = `resident_${run.session.dollhouse}_`;
      const household = Object.keys(run.state.avatars).filter((id) => id.startsWith(housePrefix));
      expect(household.length).toBeGreaterThan(0);

      // ── ③ THE REVEAL SET IS THE GL RULE, ONE FRAME BEHIND ────────────────
      const town = run.session.town!;
      const house = town.plan.houses.find((h) => h.index === run.session.dollhouse)!;
      const frame = {
        x: house.dx + town.stage.center.x,
        y: house.dy + town.stage.center.y,
        w: house.w,
        h: house.h,
      };
      const revealed = run.view.revealedBuildings();
      expect(revealed.size).toBeGreaterThan(0);
      // The view's set is LAST render's; `view.render` is the final act of the
      // host's frame, so nothing has moved since — recomputing must reproduce it.
      const expected = revealedInteriors(run.state, PLAYER_ID, {
        interiorReveal: true,
        spirit: true,
        spiritFrame: frame,
      });
      expect([...revealed].sort()).toEqual([...expected].sort());
      // …and every revealed room belongs to the FOCUSED lot (the town around it
      // keeps its walls — the whole point of the dollhouse narrowing).
      const byId = new Map((run.state.spec.buildings ?? []).map((b) => [b.id, b.footprint]));
      for (const id of revealed) expect(inFocusFrame(byId.get(id)!, frame)).toBe(true);

      // ── ④ THE CLOCK RAN AND THE PRESENTER WAS PUSHED ─────────────────────
      expect(run.session.townClock).toBeGreaterThan(0);
      const log = run.presenterLog();
      expect(log.sessions).toBe(1);
      expect(log.objectives).toBeGreaterThan(0);

      // ── ⑤ A LOOK IS A REAL GAZE (identity screen map: a point IS the pixel) ─
      const me = run.state.avatars[PLAYER_ID]!;
      const near = Object.values(run.state.avatars)
        .filter((a) => a.id !== PLAYER_ID)
        .map((a) => ({ a, d: Math.hypot(a.x - me.x, a.y - me.y) }))
        .sort((p, q) => p.d - q.d)[0];
      expect(near).toBeDefined();
      expect(() => run.look(near!.a.x, near!.a.y)).not.toThrow();
      run.advance(5);
      expect(() => run.clearLook()).not.toThrow();

      // ── ⑥ A SPOKEN SENTENCE FLOWS (the real player-action path) ──────────
      const answered = boards.length + toasts.length;
      expect(() => run.speak("hello")).not.toThrow();
      run.advance(20);
      // The engine answered — a feedback toast, or a conversation board. This is
      // also the law-③ check that the presenter is genuinely pushed: a session
      // that showed a student nothing at all is a dead one.
      expect(boards.length + toasts.length).toBeGreaterThan(answered);
      expect(boards.length + toasts.length).toBeGreaterThan(0);

      // ── ⑦ A BOARD OPTION CAN BE PRESSED ──────────────────────────────────
      const open = run.presenterLog().board;
      expect(() => run.select(open?.options[0]?.id ?? "nothing-here")).not.toThrow();
      run.advance(5);
    } finally {
      run.dispose();
    }
  }, 600_000);

  it("the TOWN camera reveals more than the dollhouse camera does", () => {
    const dollhouse = bootTextQuest({ world: doc, dt: DT, camera: { kind: "dollhouse" } });
    const town = bootTextQuest({ world: doc, dt: DT, camera: { kind: "town" } });
    try {
      // Three frames is enough: the reveal is computed in render() and read back
      // on the next frame (the documented one-frame lag).
      dollhouse.advance(3);
      town.advance(3);
      const a = dollhouse.view.revealedBuildings().size;
      const b = town.view.revealedBuildings().size;
      expect(a).toBeGreaterThan(0);
      expect(b).toBeGreaterThan(a); // frameless spirit = the whole accessible town
    } finally {
      dollhouse.dispose();
      town.dispose();
    }
  }, 600_000);
});
