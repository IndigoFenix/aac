// DETERMINISM — text-mode.md D4: "a transcript is a pure function of (build,
// seed, command list)". Two `bootTextQuest` runs of the same document, at the
// same seed / dt / camera, advanced the same number of frames, must produce the
// same world — BYTE FOR BYTE, poses at full double precision.
//
// The three sources of nondeterminism THE BOOT is responsible for closing:
//   • the NPC RNG — `WorldHostDeps.npcRng` defaults to `Math.random`, so the
//     boot injects `mulberry32(hashSeed(seed, "npc"))`;
//   • the CLOCK — `now` is injected and hand-advanced, never `performance.now`;
//   • the CAMERA — a text camera is static, so the reveal set (and therefore
//     which residents the streamer embodies) never depends on a camera pose
//     that eased differently between runs.
//
// ══ THE RESIDUAL HOLE THIS TEST PINNED DOWN — AND STEP ⑫ CLOSED ═════════════
// With those three closed, two runs still diverged: at frame ~5-8 exactly ONE
// of 54 bodies landed ~4 cm from where the other run put it, and the drift
// spread from there. The hunt, in order:
//   • `Math.random` is called ZERO times over a boot + 8 frames (measured by
//     patching it and counting) — the engine's rng discipline is intact;
//   • freezing `performance.now` makes three consecutive runs BYTE-IDENTICAL
//     over 10 frames — so the hole was a wall-clock read;
//   • it was the town streamer's errand drain, which is time-sliced:
//
//       quest-host.ts   const _rt0 = descendNow();      // performance.now()
//                       if (_routed >= ERRAND_ROUTE_BUDGET
//                           || descendNow() - _rt0 > 5) break;
//
//     i.e. how many residents got their door-route THIS frame depended on how
//     fast the machine was for the last 5 ms. A resident whose trip starts one
//     frame later is centimetres away forever after.
//
// THE FIX (step ⑫): that slice now reads the HOST'S clock (`simNow` =
// `deps.now`, defaulting to `performance.now`) instead of an independent
// wall-clock. Under the injected manual-pump clock this boot hands in, `now()`
// is CONSTANT within a frame — the pump advances it only between frames — so
// the elapsed break can never fire and only the deterministic
// `ERRAND_ROUTE_BUDGET` count cap applies: a headless frame is ATOMIC. Under
// the default clock `simNow` IS `performance.now`, so a GL session slices
// exactly as it always did.
//
// So this asserts ONE digest, exactly, with no tolerance anywhere:
//   • WHO EXISTS (the id set — a streaming/seeding regression is a different
//     world, not a body standing 4 cm off);
//   • WHERE EVERY BODY STANDS, at full precision (`String(x)`, not rounded);
//   • the town CLOCK, and the conversation SEQ counters (the seeded per-turn
//     dialogue stream keys on those, so a divergence there is a divergence in
//     everything anyone would ever hear).
// If this ever goes red, the answer is to FIND the unseeded source — never to
// reintroduce a tolerance. It does NOT freeze `performance.now` itself: jest's
// own runner reads it, and overriding a global the harness depends on is not a
// price a suite should pay — with the drain fixed it no longer needs to.
//
// ── WHY THE ARC IS THIS LONG, AND WHY dt IS THE HOST'S CEILING ──────────────
// A headless dollhouse frame costs ~0.4-0.6 s in plain Node and ~1-2.75 s under
// jest's ESM VM (breakdown in headless-quest-boot.test.ts; it is the town's
// needs/economy sim, not this layer). The old drift appeared by frame 5-8, so
// the arc runs well past that — far enough that a re-opened hole cannot hide in
// the first few frames — and steps at `dt = 1/20`, the world-host's own clamp
// ceiling (`Math.min(0.05, …)`), which buys 3× the sim per frame. Determinism
// is a claim about "same inputs ⇒ same world"; dt is one of the inputs and does
// not have to be the 1/60 a GL run uses.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";

const specPath = join(process.cwd(), "games", "dollhouse", "src", "game.spec.json");
const doc = JSON.parse(readFileSync(specPath, "utf8"));

const DT = 1 / 20;
const FRAMES_PER_CHECK = 10;
const CHECKS = 5; // 50 frames — the old drift showed by frame 5-8

/** Full precision, no rounding: JS's shortest round-trip form of the double. A
 *  digest that rounded would be a tolerance wearing a disguise. */
const exact = (n: number): string => String(n);

/** THE WHOLE WORLD AS ONE STRING — cast, poses, clock, conversation counters.
 *  Compared byte-for-byte, so a jest failure prints the first differing line. */
function digest(run: TextQuestRun): string {
  const ids = Object.keys(run.state.avatars).sort();
  const bodies = ids.map((id) => {
    const a = run.state.avatars[id]!;
    return `  ${id} ${exact(a.x)} ${exact(a.y)} f${exact(a.floor)}`;
  });
  // The conversation book, projected (a pure read — `conversationAudit` runs no
  // sweep): every field of every row, `seq` being the counter the per-turn
  // dialogue rng keys on.
  const convos = run.host
    .conversationAudit()
    .map((c) => `  ${JSON.stringify(c)}`)
    .sort();
  return [
    `clock=${exact(run.session.townClock)}`,
    `n=${ids.length}`,
    ...bodies,
    `convos=${convos.length}`,
    ...convos,
  ].join("\n");
}

/** How many bodies a digest counted (the `n=` line). */
const bodyCount = (d: string): number => Number(/^n=(\d+)$/m.exec(d)?.[1] ?? 0);

/** Boot, advance, and digest at every checkpoint. */
function walk(): string[] {
  const run = bootTextQuest({ world: doc, seed: 4242, dt: DT, camera: { kind: "dollhouse" } });
  try {
    const out: string[] = [];
    for (let i = 0; i < CHECKS; i++) {
      run.advance(FRAMES_PER_CHECK);
      out.push(digest(run));
    }
    return out;
  } finally {
    run.dispose();
  }
}

describe("bootTextQuest determinism", () => {
  it("two runs at the same seed/dt/camera build the IDENTICAL world at every checkpoint", () => {
    const a = walk();
    const b = walk();

    // The digests must be measuring a MOVING, POPULATED world — a constant (or
    // bodiless) result would pass the comparison while proving nothing.
    expect(new Set(a).size).toBe(CHECKS);
    expect(bodyCount(a[0]!)).toBeGreaterThan(1);

    for (let i = 0; i < CHECKS; i++) {
      // EXACT. Same cast, same feet, same clock, same conversation counters —
      // no tolerance, at frame (i + 1) * FRAMES_PER_CHECK.
      expect(b[i]).toBe(a[i]);
    }
  }, 900_000);
});
