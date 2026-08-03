/**
 * The rule that decides whether the board starts reading itself out loud.
 *
 * Both halves of this matter equally and pull in opposite directions: firing
 * for a student who is stuck, and NEVER firing at one who isn't. A false
 * positive here is the AAC talking over a child who was reading a word, so the
 * "does not fire" cases below are load-bearing, not padding.
 */

import { describe, it, expect } from "@jest/globals";
import {
  autoScanVerdict,
  initialHuntState,
  noteHover,
  noteScanEnded,
  resetHunt,
  shouldAutoScan,
  COOLDOWN_AFTER_REJECT_MS,
  COOLDOWN_AFTER_SCAN_MS,
  MIN_DISTINCT_TARGETS,
  type HuntContext,
  type HuntState,
} from "./auto-audio-scan";

const DELAY = 15_000;

/** Everything permissive except the hunt itself, so each test varies one thing. */
function ctx(now: number, over: Partial<HuntContext> = {}): HuntContext {
  return { now, delayMs: DELAY, scanning: false, boardPresent: true, aiBusy: false, ...over };
}

/** Replay a list of [id, at] hovers onto a fresh (or given) state. */
function hover(pairs: Array<[string, number]>, from: HuntState = initialHuntState()): HuntState {
  return pairs.reduce((s, [id, at]) => noteHover(s, id, at), from);
}

/** A student sweeping the board: a new button every second. */
function sweep(fromMs: number, toMs: number, stepMs = 1000): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (let t = fromMs, i = 0; t <= toMs; t += stepMs, i++) out.push([`btn-${i % 8}`, t]);
  return out;
}

describe("auto audio scan — when it fires", () => {
  it("fires once the delay has passed and several different buttons were hunted", () => {
    const s = hover([["apple", 0], ["ball", 4000], ["drink", 9000], ["more", 14_000]]);
    expect(shouldAutoScan(s, ctx(15_000))).toBe(true);
  });

  it("keeps firing-eligible while the hunt continues past the delay", () => {
    const s = hover(sweep(0, 40_000));
    expect(shouldAutoScan(s, ctx(40_000))).toBe(true);
  });

  it("honours the configured delay rather than a hardcoded one", () => {
    const s = hover([["a", 0], ["b", 1000], ["c", 2000], ["d", 3000]]);
    // The same hunt is "too soon" at 15s and "long enough" at 5s.
    expect(shouldAutoScan(s, ctx(6000, { delayMs: 15_000 }))).toBe(false);
    expect(shouldAutoScan(s, ctx(6000, { delayMs: 5000 }))).toBe(true);
  });
});

describe("auto audio scan — when it must not fire", () => {
  it("does not fire when the gaze sat on ONE target the whole time", () => {
    // A student reading a word, or resting their gaze somewhere safe.
    let s = initialHuntState();
    for (let t = 0; t <= 60_000; t += 500) s = noteHover(s, "apple", t);
    expect(s.hovers).toHaveLength(1); // consecutive repeats collapse
    expect(autoScanVerdict(s, ctx(60_000))).toBe("not-hunting");
  });

  it("does not fire before the delay, however wide the hunt", () => {
    const s = hover(sweep(0, 14_000, 500));
    expect(autoScanVerdict(s, ctx(14_500))).toBe("too-soon");
    expect(autoScanVerdict(s, ctx(15_000))).toBe("fire");
  });

  it("does not fire on fewer than MIN_DISTINCT_TARGETS buttons", () => {
    // Ping-ponging between two candidates is deliberation, not being lost —
    // and reading the whole board out would not answer the question.
    const pairs: Array<[string, number]> = [];
    for (let t = 0; t <= 20_000; t += 1000) pairs.push([t % 2000 === 0 ? "yes" : "no", t]);
    const s = hover(pairs);
    expect(new Set(s.hovers.map((h) => h.id)).size).toBeLessThan(MIN_DISTINCT_TARGETS);
    expect(autoScanVerdict(s, ctx(20_000))).toBe("not-hunting");
  });

  it("does not fire once the student stopped moving, even after a wide sweep", () => {
    // Swept the board, then settled — they found it and are about to select it,
    // or they left. Either way the trailing window is empty.
    const s = hover(sweep(0, 5000, 500));
    expect(autoScanVerdict(s, ctx(5500))).toBe("too-soon");
    expect(autoScanVerdict(s, ctx(40_000))).toBe("not-hunting");
  });

  it("does not fire with no board on screen, mid-scan, or while the AI is busy", () => {
    const s = hover(sweep(0, 20_000));
    expect(autoScanVerdict(s, ctx(20_000, { boardPresent: false }))).toBe("no-board");
    expect(autoScanVerdict(s, ctx(20_000, { scanning: true }))).toBe("scanning");
    expect(autoScanVerdict(s, ctx(20_000, { aiBusy: true }))).toBe("ai-busy");
    expect(autoScanVerdict(s, ctx(20_000))).toBe("fire"); // …and fires once they clear
  });
});

describe("auto audio scan — a selection ends the hunt", () => {
  it("resets on a press, and the clock restarts from the next hover", () => {
    const s = hover(sweep(0, 20_000));
    expect(shouldAutoScan(s, ctx(20_000))).toBe(true);

    const after = resetHunt(s);
    expect(autoScanVerdict(after, ctx(20_000))).toBe("not-started");

    // A fresh hunt has to earn the full delay again from its own first hover.
    const restarted = hover(sweep(20_000, 30_000), after);
    expect(autoScanVerdict(restarted, ctx(30_000))).toBe("too-soon");
    expect(autoScanVerdict(restarted, ctx(35_000))).toBe("fire");
  });

  it("a board rebuild resets it the same way — the options are different now", () => {
    const s = resetHunt(hover(sweep(0, 20_000)));
    expect(shouldAutoScan(s, ctx(20_000))).toBe(false);
  });
});

describe("auto audio scan — cooldown", () => {
  it("stays quiet after a scan that finished, then allows another hunt", () => {
    const ended = noteScanEnded(hover(sweep(0, 20_000)), 20_000, false);
    const hunting = hover(sweep(20_500, 60_000), ended);

    expect(autoScanVerdict(hunting, ctx(20_000 + COOLDOWN_AFTER_SCAN_MS - 1))).toBe("cooling-down");
    expect(autoScanVerdict(hunting, ctx(20_000 + COOLDOWN_AFTER_SCAN_MS))).toBe("fire");
  });

  it("stays quiet far longer when the student STOPPED the scan", () => {
    // Reaching for the ear to shut it up is an answer. Re-asking 15s later
    // would be an interruption loop, which is worse than never offering.
    const ended = noteScanEnded(hover(sweep(0, 20_000)), 20_000, true);
    const hunting = hover(sweep(20_500, 200_000), ended);

    expect(autoScanVerdict(hunting, ctx(20_000 + COOLDOWN_AFTER_SCAN_MS + 1))).toBe("cooling-down");
    expect(autoScanVerdict(hunting, ctx(20_000 + COOLDOWN_AFTER_REJECT_MS - 1))).toBe("cooling-down");
    expect(autoScanVerdict(hunting, ctx(20_000 + COOLDOWN_AFTER_REJECT_MS))).toBe("fire");
  });

  it("clears the hunt when the scan ends, so the cooldown expiring alone fires nothing", () => {
    const ended = noteScanEnded(hover(sweep(0, 20_000)), 20_000, false);
    expect(ended.hovers).toEqual([]);
    expect(autoScanVerdict(ended, ctx(20_000 + COOLDOWN_AFTER_SCAN_MS))).toBe("not-started");
  });
});
