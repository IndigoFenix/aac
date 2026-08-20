/**
 * The board's loading bar, as the harness models it.
 *
 * The student never sees `processing{board}` — they see a bar that fades out
 * over 500ms. That fade is deliberate: it absorbs the Board Manager's
 * sub-second busy flickers so a self-correcting rebuild reads as ONE unbroken
 * "still working" (home.tsx ~:2592). The harness has to agree, or it lets the
 * simulated child react to a board the real child would still be waiting on.
 */

import { describe, it, expect } from "@jest/globals";
import { BOARD_BAR_FADE_MS, SimClientModel } from "../services/aac-sim/client-model.js";

/** A model on a clock the test drives, so no timers are involved. */
function modelAtClock() {
  let now = 0;
  const model = new SimClientModel(() => now);
  return { model, tick: (ms: number) => (now += ms), at: () => now };
}

const busy = (active: boolean) => ({ type: "processing", activity: "board", active });

describe("boardVisiblyBusy", () => {
  it("is false before anything has happened", () => {
    const { model } = modelAtClock();
    expect(model.boardVisiblyBusy()).toBe(false);
  });

  it("is true while the flag is up", () => {
    const { model } = modelAtClock();
    model.apply(busy(true));
    expect(model.boardVisiblyBusy()).toBe(true);
  });

  it("STAYS true through the fade after the flag drops", () => {
    const { model, tick } = modelAtClock();
    model.apply(busy(true));
    model.apply(busy(false));
    expect(model.boardVisiblyBusy()).toBe(true); // bar is still fading
    tick(BOARD_BAR_FADE_MS - 1);
    expect(model.boardVisiblyBusy()).toBe(true);
  });

  it("goes false once the bar has faded out", () => {
    const { model, tick } = modelAtClock();
    model.apply(busy(true));
    model.apply(busy(false));
    tick(BOARD_BAR_FADE_MS + 1);
    expect(model.boardVisiblyBusy()).toBe(false);
  });

  it("absorbs a self-correction: a flicker inside the fade never reads as idle", () => {
    // The exact shape of a corrective retry — the beat ends, the retry
    // re-invokes a moment later. A child watching sees one continuous bar.
    const { model, tick } = modelAtClock();
    model.apply(busy(true));
    model.apply(busy(false)); // failed beat
    tick(200); // well inside the fade
    expect(model.boardVisiblyBusy()).toBe(true);
    model.apply(busy(true)); // corrective retry re-lights it
    tick(5000);
    expect(model.boardVisiblyBusy()).toBe(true);
  });

  it("a LONG gap does read as idle — a board arriving after that really did change under the child", () => {
    const { model, tick } = modelAtClock();
    model.apply(busy(true));
    model.apply(busy(false));
    tick(3000);
    expect(model.boardVisiblyBusy()).toBe(false);
  });

  it("honours a caller-supplied fade window", () => {
    const { model, tick } = modelAtClock();
    model.apply(busy(true));
    model.apply(busy(false));
    tick(800);
    expect(model.boardVisiblyBusy(1000)).toBe(true);
    expect(model.boardVisiblyBusy(500)).toBe(false);
  });

  it("does not confuse the speaker cue with the board cue", () => {
    const { model } = modelAtClock();
    model.apply({ type: "processing", activity: "speaker", active: true });
    expect(model.boardVisiblyBusy()).toBe(false);
    expect(model.status().busy.speaker).toBe(true);
  });
});
