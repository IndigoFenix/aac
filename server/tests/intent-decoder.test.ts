// Tests for the gaze INTENT DECODER — the engine that decides whether a
// student is READING a button or CHOOSING it. Pure-logic, no DOM.
//
// The problem it exists to solve: with plain dwell, looking at a button long
// enough to work out what it means selects it. These tests pin the two
// behaviours that make the difference — scanning must never fire, and a
// genuine settle must fire promptly — plus the two accessibility guarantees
// (the adaptive threshold and the fallback floor) that keep the board usable
// for a student who cannot produce a textbook-clean fixation.

import { describe, it, expect } from "@jest/globals";
import { IntentDecoder, INTENT_DEFAULTS, type IntentZone } from "@shared/intent-decoder.js";

const DWELL_MS = 2000; // charge time is chargeScale (0.7) × this = 1400ms
// Every time-like constant is derived from the dwell setting, so read them off
// a decoder rather than hard-coding what they happen to work out to.
const TIMINGS = new IntentDecoder<string>({ dwellTimeMs: DWELL_MS }).timings;
const STEP = 33; // ~30Hz, a typical tracker rate
const CENTER = { x: 500, y: 400 };

/**
 * Synthetic gaze. `spread` is the peak-to-peak travel in px: a few px is a
 * fixation with tracker jitter, a couple of hundred is a gaze sweeping across
 * the button. The 250ms period is shorter than the dispersion window, so a
 * scanning gaze always presents its full extent to the decoder.
 */
function gazeAt(t: number, spread: number, center = CENTER) {
  return {
    x: center.x + (spread / 2) * Math.sin(t / 40),
    y: center.y + (spread / 6) * Math.cos(t / 55),
  };
}

interface DriveOpts {
  target: string | null;
  zone: IntentZone;
  spread: number;
  center?: { x: number; y: number };
  /** Freeze the "last fresh sample" clock to simulate a lost tracker. */
  lastSampleAt?: (t: number) => number;
  /** Stop feeding samples (but keep ticking) — used for cursor-mode checks. */
  feed?: boolean;
}

/** Drive the decoder from `startAt` for `durationMs`; returns every tick. */
function collect(
  dec: IntentDecoder<string>,
  opts: DriveOpts,
  startAt: number,
  durationMs: number,
) {
  const out: ReturnType<IntentDecoder<string>["update"]>[] = [];
  for (let t = startAt; t <= startAt + durationMs; t += STEP) {
    const p = gazeAt(t, opts.spread, opts.center);
    if (opts.feed !== false) dec.addSample(p.x, p.y, t);
    const r = dec.update(opts.target, opts.zone, p, t, opts.lastSampleAt ? opts.lastSampleAt(t) : t);
    out.push(r);
    if (r.fired) break;
  }
  return out;
}

/** Drive the decoder from `startAt` for `durationMs`; returns the last result. */
function drive(dec: IntentDecoder<string>, opts: DriveOpts, startAt: number, durationMs: number) {
  const all = collect(dec, opts, startAt, durationMs);
  return all[all.length - 1];
}

const STILL = 6; // a held fixation, with realistic tracker noise
const SCANNING = 220; // a gaze sweeping across the button, reading it
// Dispersion is measured over a trailing window, so after the gaze changes
// character the decoder is still looking at the old samples for this long.
const FLUSH = INTENT_DEFAULTS.dispersionWindowMs + STEP;

function decoder(tuning?: Partial<typeof INTENT_DEFAULTS>) {
  return new IntentDecoder<string>({ dwellTimeMs: DWELL_MS, tuning });
}

describe("IntentDecoder — reading vs. choosing", () => {
  it("fires when the gaze settles in the core", () => {
    const dec = decoder();
    const r = drive(dec, { target: "a", zone: "core", spread: STILL }, 0, 3000);
    expect(r.fired).toBe("a");
  });

  it("never fires while the gaze is scanning the button, however long", () => {
    const dec = decoder();
    const r = drive(dec, { target: "a", zone: "ink", spread: SCANNING }, 0, 3000);
    expect(r.fired).toBeNull();
    expect(r.state).toBe("scanning");
  });

  it("reports scanning, then settling, then charging as the gaze stills", () => {
    const dec = decoder();
    const scanning = drive(dec, { target: "a", zone: "core", spread: SCANNING }, 0, 1000);
    expect(scanning.state).toBe("scanning");
    expect(scanning.progress).toBe(0);

    // The gaze stills, but the trailing window still holds the saccades.
    const t0 = 1050;
    const flushed = drive(dec, { target: "a", zone: "core", spread: STILL }, t0, FLUSH);
    // Stillness has to be earned: qualifyCoreMs of it before anything charges.
    expect(flushed.state).toBe("settling");
    expect(flushed.progress).toBe(0);

    const charging = drive(
      dec,
      { target: "a", zone: "core", spread: STILL },
      t0 + FLUSH + STEP,
      TIMINGS.qualifyCoreMs + 200,
    );
    expect(charging.state).toBe("charging");
    expect(charging.progress).toBeGreaterThan(0);
  });

  it("reading the label then settling on it still selects, just slower than the core", () => {
    const core = decoder();
    const coreResult = drive(core, { target: "a", zone: "core", spread: STILL }, 0, 5000);
    const ink = decoder();
    const inkResult = drive(ink, { target: "a", zone: "ink", spread: STILL }, 0, 5000);

    expect(coreResult.fired).toBe("a");
    expect(inkResult.fired).toBe("a");
    // Same gaze, slower zone — the label must not be as quick to fire as the icon.
    const coreTicks = ticksToFire(() => decoder(), "core");
    const inkTicks = ticksToFire(() => decoder(), "ink");
    expect(inkTicks).toBeGreaterThan(coreTicks);
  });

  it("never charges in the rest zone — the board's padding and gutters stay safe", () => {
    const dec = decoder();
    const r = drive(dec, { target: "a", zone: "rest", spread: STILL }, 0, 8000);
    expect(r.fired).toBeNull();
    expect(r.progress).toBe(0);
  });
});

/** How many ticks a perfectly still gaze needs to fire in `zone`. */
function ticksToFire(make: () => IntentDecoder<string>, zone: IntentZone): number {
  const dec = make();
  let ticks = 0;
  for (let t = 0; t < 20000; t += STEP) {
    const p = gazeAt(t, STILL);
    dec.addSample(p.x, p.y, t);
    ticks++;
    if (dec.update("a", zone, p, t, t).fired) return ticks;
  }
  return Infinity;
}

describe("IntentDecoder — losing and regaining the fixation", () => {
  it("holds progress through the pause window, then drains at a growing rate", () => {
    const dec = decoder();
    const filled = drive(dec, { target: "a", zone: "core", spread: STILL }, 0, 600).progress;
    expect(filled).toBeGreaterThan(0.2);

    // Gaze breaks up (back to reading) — nothing is lost during the grace period.
    const paused = drive(dec, { target: "a", zone: "core", spread: SCANNING }, 650, TIMINGS.pauseMs - 100);
    expect(paused.progress).toBeCloseTo(filled, 3);
    expect(paused.draining).toBe(false);

    const early = drive(dec, { target: "a", zone: "core", spread: SCANNING }, 1050, 500);
    expect(early.draining).toBe(true);
    const firstLoss = paused.progress - early.progress;

    const later = drive(dec, { target: "a", zone: "core", spread: SCANNING }, 1600, 500);
    const secondLoss = early.progress - later.progress;
    expect(firstLoss).toBeGreaterThan(0);
    expect(secondLoss).toBeGreaterThan(firstLoss);
  });

  it("resumes from the drained level rather than restarting", () => {
    const dec = decoder();
    drive(dec, { target: "a", zone: "core", spread: STILL }, 0, 600);
    const drained = drive(dec, { target: "a", zone: "core", spread: SCANNING }, 650, 900).progress;
    expect(drained).toBeGreaterThan(0);

    // Settling again drains a little more while the window flushes, then picks
    // up from wherever it bottomed out — the point is that it never resets.
    const ticks = collect(dec, { target: "a", zone: "core", spread: STILL }, 1600, 1200);
    const floor = Math.min(...ticks.map((r) => r.progress));
    expect(floor).toBeGreaterThan(0);
    expect(ticks[ticks.length - 1].progress).toBeGreaterThan(floor);
  });
});

describe("IntentDecoder — revisit memory", () => {
  it("resumes a recently-left button instead of starting from zero", () => {
    const dec = decoder();
    const before = drive(dec, { target: "a", zone: "core", spread: STILL }, 0, 700).progress;
    expect(before).toBeGreaterThan(0.2);

    // Look away to another button for a moment, then come back.
    drive(dec, { target: "b", zone: "core", spread: STILL }, 750, 300);
    const back = drive(dec, { target: "a", zone: "core", spread: STILL }, 1100, 0);

    expect(back.progress).toBeGreaterThan(0);
    expect(back.progress).toBeLessThan(before); // decayed while away
    expect(back.revisit).toBe(true);
  });

  it("remembers a button across several neighbours — scan A, B, C, come back to A", () => {
    const dec = decoder();
    const before = drive(dec, { target: "a", zone: "core", spread: STILL }, 0, 700).progress;
    expect(before).toBeGreaterThan(0.2);

    // Compare the neighbours, the way someone deciding actually does.
    drive(dec, { target: "b", zone: "core", spread: STILL }, 750, 200);
    drive(dec, { target: "c", zone: "core", spread: STILL }, 1000, 200);
    const back = drive(dec, { target: "a", zone: "core", spread: STILL }, 1250, 0);

    expect(back.progress).toBeGreaterThan(0);
    expect(back.revisit).toBe(true);
  });

  it("forgets a button left for longer than the memory window", () => {
    const dec = decoder();
    drive(dec, { target: "a", zone: "core", spread: STILL }, 0, 700);
    drive(dec, { target: null, zone: "rest", spread: STILL }, 750, TIMINGS.memoryMs + 300);
    const back = drive(dec, { target: "a", zone: "core", spread: STILL }, 3000, 0);

    expect(back.progress).toBe(0);
    expect(back.revisit).toBe(false);
  });

  it("treats a momentary hit-test blip as continuity, not a decision to return", () => {
    const dec = decoder();
    drive(dec, { target: "a", zone: "core", spread: STILL }, 0, 700);
    // One tick of nothing under the gaze — the gutter, or tracker noise.
    drive(dec, { target: null, zone: "rest", spread: STILL }, 750, 0);
    const back = drive(dec, { target: "a", zone: "core", spread: STILL }, 790, 0);

    expect(back.progress).toBeGreaterThan(0); // progress survives
    expect(back.revisit).toBe(false); // but it earns no revisit discount
  });

  it("a completed selection clears the memory — the question is settled", () => {
    const dec = decoder();
    const fired = drive(dec, { target: "a", zone: "core", spread: STILL }, 0, 5000);
    expect(fired.fired).toBe("a");

    // Re-arm by moving far away, then come back to the same button.
    drive(dec, { target: null, zone: "rest", spread: STILL, center: { x: 900, y: 400 } }, 5000, 200);
    const again = drive(dec, { target: "a", zone: "core", spread: STILL }, 5300, 0);
    expect(again.progress).toBe(0);
  });
});

describe("IntentDecoder — accessibility guarantees", () => {
  // These drive the "rest" zone: calibration watches every on-target sample,
  // but nothing charges, so the decoder can be observed learning without a
  // selection cutting the run short.
  it("adapts its stillness threshold to a student who cannot hold a tight fixation", () => {
    const jittery = decoder();
    // 100px of constant tremor: never "still" by the default 80px threshold.
    drive(jittery, { target: "a", zone: "rest", spread: 100 }, 0, 4000);
    expect(jittery.stillnessThreshold).toBeGreaterThan(INTENT_DEFAULTS.defaultDispersionPx);

    const steady = decoder();
    drive(steady, { target: "a", zone: "rest", spread: STILL }, 0, 4000);
    // A steady student gets a TIGHTER threshold, so their scanning still reads
    // as scanning rather than being swallowed by a generous default.
    expect(steady.stillnessThreshold).toBeLessThan(INTENT_DEFAULTS.defaultDispersionPx);
  });

  it("takes a beat to calibrate — the first selection uses the safe default", () => {
    const dec = decoder();
    drive(dec, { target: "a", zone: "rest", spread: STILL }, 0, 300);
    expect(dec.stillnessThreshold).toBe(INTENT_DEFAULTS.defaultDispersionPx);
  });

  it("never calibrates itself into treating a whole-button sweep as stillness", () => {
    const dec = decoder();
    // An entire session of nothing but scanning.
    drive(dec, { target: "a", zone: "rest", spread: SCANNING }, 0, 12000);
    expect(dec.stillnessThreshold).toBeLessThanOrEqual(INTENT_DEFAULTS.maxDispersionPx);
    expect(dec.stillnessThreshold).toBeLessThan(SCANNING);
  });

  it("falls back to slow dwell so a button is never un-selectable", () => {
    // A student whose gaze never qualifies: constant wide tremor, and a
    // threshold pinned low so adaptation cannot rescue them.
    const dec = decoder({ minDispersionPx: 10, maxDispersionPx: 10 });
    const r = drive(dec, { target: "a", zone: "core", spread: 200 }, 0, 20000);
    expect(r.fired).toBe("a");
  });

  it("the fallback is slower than a qualified selection, not a shortcut", () => {
    const qualified = ticksToFire(() => decoder(), "core");
    const fallbackDec = decoder({ minDispersionPx: 10, maxDispersionPx: 10 });
    let fallbackTicks = 0;
    for (let t = 0; t < 40000; t += STEP) {
      const p = gazeAt(t, 200);
      fallbackDec.addSample(p.x, p.y, t);
      fallbackTicks++;
      if (fallbackDec.update("a", "core", p, t, t).fired) break;
    }
    expect(fallbackTicks).toBeGreaterThan(qualified * 3);
  });

  it("does not let the fallback fire from the rest zone", () => {
    const dec = decoder({ minDispersionPx: 10, maxDispersionPx: 10 });
    const r = drive(dec, { target: "a", zone: "rest", spread: 200 }, 0, 20000);
    expect(r.fired).toBeNull();
  });
});

describe("IntentDecoder — inherited safety rules", () => {
  it("suspends while the gaze signal is stale (covered camera, student left)", () => {
    const dec = new IntentDecoder<string>({ dwellTimeMs: DWELL_MS, staleGazeMs: 500 });
    // Signal freezes at t=200 — a perfectly still point that must never fire.
    const r = drive(
      dec,
      { target: "a", zone: "core", spread: STILL, lastSampleAt: (t) => Math.min(t, 200) },
      0,
      10000,
    );
    expect(r.fired).toBeNull();
    expect(r.gazeStale).toBe(true);
  });

  it("will not fire twice without genuine movement (board-rebuild regression)", () => {
    const dec = decoder();
    expect(drive(dec, { target: "a", zone: "core", spread: STILL }, 0, 5000).fired).toBe("a");

    // The board rebuilds under a stationary gaze, over and over.
    let t = 5000;
    for (let rebuild = 0; rebuild < 5; rebuild++) {
      const r = drive(dec, { target: `rebuilt-${rebuild}`, zone: "core", spread: STILL }, t, 3000);
      expect(r.fired).toBeNull();
      expect(r.hoverEnabled).toBe(false);
      t += 3000;
    }
  });

  it("re-arms after the gaze genuinely moves, and can select again", () => {
    const dec = decoder();
    expect(drive(dec, { target: "a", zone: "core", spread: STILL }, 0, 5000).fired).toBe("a");

    const elsewhere = { x: 900, y: 700 };
    const r = drive(dec, { target: "b", zone: "core", spread: STILL, center: elsewhere }, 5000, 5000);
    expect(r.fired).toBe("b");
  });
});

describe("IntentDecoder — timings follow the AAC dwell setting", () => {
  it("scales every time-like constant with the configured dwell time", () => {
    const fast = new IntentDecoder<string>({ dwellTimeMs: 800 }).timings;
    const slow = new IntentDecoder<string>({ dwellTimeMs: 5000 }).timings;

    // A student on a slow dwell gets a proportionally slower settle, pause and
    // memory — one slider moves the whole gesture coherently.
    expect(slow.chargeTimeMs).toBeGreaterThan(fast.chargeTimeMs);
    expect(slow.qualifyCoreMs).toBeGreaterThan(fast.qualifyCoreMs);
    expect(slow.qualifyInkMs).toBeGreaterThan(fast.qualifyInkMs);
    expect(slow.pauseMs).toBeGreaterThan(fast.pauseMs);
    expect(slow.memoryMs).toBeGreaterThan(fast.memoryMs);
  });

  it("keeps qualification usable at the extremes of the slider", () => {
    for (const dwellTimeMs of [300, 800, 2000, 5000, 10000]) {
      const t = new IntentDecoder<string>({ dwellTimeMs }).timings;
      // Never so short it fires on a passing saccade, never so long it eats
      // the whole budget before the timer has started.
      expect(t.qualifyCoreMs).toBeGreaterThanOrEqual(INTENT_DEFAULTS.qualifyMinMs);
      expect(t.qualifyInkMs).toBeLessThanOrEqual(INTENT_DEFAULTS.qualifyMaxMs);
      expect(t.qualifyInkMs).toBeLessThan(t.chargeTimeMs);
    }
  });

  it("still selects promptly on a fast dwell setting", () => {
    const dec = new IntentDecoder<string>({ dwellTimeMs: 800 });
    const r = drive(dec, { target: "a", zone: "core", spread: STILL }, 0, 3000);
    expect(r.fired).toBe("a");
  });
});

describe("IntentDecoder — readout", () => {
  it("reports a centroid that tracks where the gaze actually settled", () => {
    const dec = decoder();
    const spot = { x: 320, y: 210 };
    const r = drive(dec, { target: "a", zone: "core", spread: STILL, center: spot }, 0, 600);
    expect(r.centroid).not.toBeNull();
    expect(r.centroid!.x).toBeCloseTo(spot.x, -1);
    expect(r.centroid!.y).toBeCloseTo(spot.y, -1);
  });

  it("reports dispersion against the threshold, so the readout can show both", () => {
    const dec = decoder();
    const scanning = drive(dec, { target: "a", zone: "core", spread: SCANNING }, 0, 600);
    expect(scanning.dispersion).toBeGreaterThan(scanning.threshold);

    const still = drive(dec, { target: "a", zone: "core", spread: STILL }, 650, 600);
    expect(still.dispersion).toBeLessThan(still.threshold);
  });
});
