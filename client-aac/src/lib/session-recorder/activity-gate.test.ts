// Clip lifecycle. Every transition here is time-driven, and the gate carries no
// clock of its own, so the whole feature's timing behavior is assertable
// without encoding a single frame.

import {
  initialGateState,
  stepGate,
  stopGate,
  type GateConfig,
  type GateState,
} from "./activity-gate";
import { CLIP_ID_PATTERN, clipIdTime, makeClipId } from "./clip-id";

const CONFIG: GateConfig = { idleTailMs: 30_000, maxClipMs: 600_000 };

/** Drive the gate over a script of `[nowMs, activity]` beats, collecting actions. */
function run(
  script: Array<[number, boolean]>,
  config: GateConfig = CONFIG,
  start: GateState = initialGateState(0),
) {
  let state = start;
  const actions: string[] = [];
  for (const [now, activity] of script) {
    const step = stepGate(state, config, now, activity);
    state = step.state;
    if (step.action.kind !== "none") actions.push(step.action.kind);
  }
  return { state, actions };
}

describe("stepGate", () => {
  it("stays shut through an idle device", () => {
    // The AAC is powered on all day. Nothing happening is the common case and
    // must not produce a single byte.
    const { actions, state } = run([
      [1_000, false], [2_000, false], [600_000, false], [3_600_000, false],
    ]);
    expect(actions).toEqual([]);
    expect(state.openedAtMs).toBeNull();
  });

  it("opens on the first interaction and reports when it was", () => {
    const step = stepGate(initialGateState(0), CONFIG, 5_000, true);
    expect(step.action).toEqual({ kind: "open", triggeredAtMs: 5_000 });
    expect(step.state.openedAtMs).toBe(5_000);
  });

  it("does not re-open a clip that is already open", () => {
    const { actions } = run([
      [1_000, true], [2_000, true], [3_000, true], [4_000, true],
    ]);
    expect(actions).toEqual(["open"]);
  });

  it("holds the clip open across pauses shorter than the idle tail", () => {
    // A child thinking for twenty seconds is still in the middle of a turn.
    const { actions } = run([
      [0, true],
      [20_000, false],
      [20_000 + 25_000, true], // 25s of quiet — under the 30s tail
      [60_000, false],
    ]);
    expect(actions).toEqual(["open"]);
  });

  it("closes once the idle tail elapses with nothing happening", () => {
    const { actions, state } = run([
      [0, true], [10_000, false], [29_999, false], [30_000, false],
    ]);
    expect(actions).toEqual(["open", "close"]);
    expect(state.openedAtMs).toBeNull();
  });

  it("names the idle close as such", () => {
    let step = stepGate(initialGateState(0), CONFIG, 0, true);
    step = stepGate(step.state, CONFIG, 30_000, false);
    expect(step.action).toEqual({ kind: "close", reason: "idle", atMs: 30_000 });
  });

  it("re-opens on the next interaction after an idle close", () => {
    const { actions } = run([
      [0, true], [30_000, false], [40_000, true], [40_500, false],
    ]);
    expect(actions).toEqual(["open", "close", "open"]);
  });

  it("rotates at the length cap while activity continues", () => {
    // An hour of play becomes editable files, not one unmanageable pair.
    const script: Array<[number, boolean]> = [];
    for (let t = 0; t <= 1_200_000; t += 10_000) script.push([t, true]);
    const { actions } = run(script);
    expect(actions).toEqual(["open", "rotate", "rotate"]);
  });

  it("restarts the length clock on rotation", () => {
    let state = stepGate(initialGateState(0), CONFIG, 0, true).state;
    const rotated = stepGate(state, CONFIG, 600_000, true);
    expect(rotated.action.kind).toBe("rotate");
    expect(rotated.state.openedAtMs).toBe(600_000);
    // Immediately after rotating, the fresh clip is nowhere near its cap.
    state = stepGate(rotated.state, CONFIG, 600_001, true).state;
    expect(stepGate(state, CONFIG, 610_000, true).action.kind).toBe("none");
  });

  it("closes rather than rotating when a clip is both over-long and idle", () => {
    // An abandoned device must never open a fresh empty clip on its way out.
    let step = stepGate(initialGateState(0), CONFIG, 0, true);
    step = stepGate(step.state, CONFIG, 700_000, false);
    expect(step.action).toEqual({ kind: "close", reason: "idle", atMs: 700_000 });
    expect(step.state.openedAtMs).toBeNull();
  });

  it("treats a fresh gate as having seen nothing, not as just-active", () => {
    // A gate built mid-session must not behave as though something happened at
    // the instant it was constructed.
    const step = stepGate(initialGateState(1_000_000), CONFIG, 1_000_000, false);
    expect(step.action.kind).toBe("none");
  });
});

describe("stopGate", () => {
  it("closes an open clip and marks why", () => {
    const opened = stepGate(initialGateState(0), CONFIG, 0, true).state;
    const step = stopGate(opened, 5_000);
    expect(step.action).toEqual({ kind: "close", reason: "stopped", atMs: 5_000 });
    expect(step.state.openedAtMs).toBeNull();
  });

  it("is a no-op when nothing is open", () => {
    expect(stopGate(initialGateState(0), 5_000).action.kind).toBe("none");
  });
});

describe("clip ids", () => {
  it("mints ids the Electron store will accept", () => {
    // The store validates against the same pattern before opening a file, so a
    // drift between the two would mean no clip could ever start.
    const id = makeClipId(new Date(2026, 7, 20, 14, 12, 33), "a4f1");
    expect(id).toBe("20260820-141233-a4f1");
    expect(CLIP_ID_PATTERN.test(id)).toBe(true);
  });

  it("pads and cleans a hostile suffix into the accepted shape", () => {
    // The id becomes a filename; nothing that could escape a path may survive.
    const id = makeClipId(new Date(2026, 0, 1, 0, 0, 0), "../X");
    expect(CLIP_ID_PATTERN.test(id)).toBe(true);
    expect(id).toBe("20260101-000000-x000");
  });

  it("sorts chronologically as plain text", () => {
    // The store's folder sweep orders clips by id alone.
    const early = makeClipId(new Date(2026, 7, 20, 9, 0, 0), "aaaa");
    const late = makeClipId(new Date(2026, 7, 20, 14, 0, 0), "0000");
    expect([late, early].sort()).toEqual([early, late]);
  });

  it("round-trips its timestamp", () => {
    const at = new Date(2026, 7, 20, 14, 12, 33);
    expect(clipIdTime(makeClipId(at, "a4f1"))).toBe(at.getTime());
  });

  it("returns null for anything that is not a clip id", () => {
    expect(clipIdTime("notes.txt")).toBeNull();
    expect(clipIdTime("")).toBeNull();
  });
});
