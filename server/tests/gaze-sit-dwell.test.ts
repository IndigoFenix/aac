// Verifies the SIT/STAND behavior change: once seated, a glance away must NOT
// stand the avatar — standing takes a sustained far-gaze DWELL (standDwellMs).
// This lets a seated player look around freely (camera responds) without walking
// off. Pure gaze-interpreter math — headless.

import { describe, it, expect } from "@jest/globals";
import { createGazeInterpreter } from "@shared/world-engine/gaze-intent.js";
import { DEFAULT_GAZE_TUNABLES } from "@shared/world-engine/world-tunables.js";
import type { Vec2 } from "@shared/world-engine/types.js";

const DT = 1 / 60;
const screenToWorld = (px: number, py: number): Vec2 | null => ({ x: px / 10, y: py / 10 });
const AVATAR: Vec2 = { x: 0, y: 0 };

function run(
  interp: ReturnType<typeof createGazeInterpreter>,
  pointer: { x: number; y: number } | null,
  frames: number,
  startMs: number,
) {
  let last = interp.update({ pointer, screenToWorld, avatar: AVATAR, dt: DT, nowMs: startMs });
  for (let i = 1; i < frames; i++) {
    last = interp.update({ pointer, screenToWorld, avatar: AVATAR, dt: DT, nowMs: startMs + i * DT * 1000 });
  }
  return last;
}

describe("sitting → standing requires a dwell", () => {
  it("a brief far glance while seated does NOT stand up; a sustained dwell does", () => {
    const interp = createGazeInterpreter();
    // Sit: gaze parked ON the avatar past idleSitMs.
    const sat = run(interp, { x: 5, y: 0 }, 200, 0);
    expect(sat.sitting).toBe(true);

    const t0 = 200 * DT * 1000;
    // A BRIEF far gaze — fewer frames than standDwellMs — must stay seated.
    const briefFrames = Math.floor((DEFAULT_GAZE_TUNABLES.standDwellMs / (DT * 1000)) * 0.5);
    const brief = run(interp, { x: 100, y: 0 }, briefFrames, t0);
    expect(brief.sitting).toBe(true);
    expect(brief.aim).toBeNull(); // still frozen

    // Continue holding the far gaze well past standDwellMs → stands + moves.
    const t1 = t0 + briefFrames * DT * 1000;
    const longFrames = Math.ceil((DEFAULT_GAZE_TUNABLES.standDwellMs / (DT * 1000)) * 1.5);
    const stood = run(interp, { x: 100, y: 0 }, longFrames, t1);
    expect(stood.sitting).toBe(false);
    expect(stood.aim).not.toBeNull();
  });

  it("committedWorld stays available while seated (so the camera can track the gaze)", () => {
    const interp = createGazeInterpreter();
    const sat = run(interp, { x: 5, y: 0 }, 200, 0);
    expect(sat.sitting).toBe(true);
    // Look around (a settled near gaze) — aim frozen, but the gaze point is exposed.
    const look = run(interp, { x: 8, y: 3 }, 20, 200 * DT * 1000);
    expect(look.sitting).toBe(true);
    expect(look.aim).toBeNull();
    expect(look.committedWorld).not.toBeNull();
  });
});
