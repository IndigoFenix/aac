// Verifies the AAC "backend is busy" processing indicators — the state machine
// behind the `processing` WS envelopes that drive the client's subtle ambient
// cues (Speaker composing a reply, Board Manager rebuilding, a composed
// sentence being interpreted into speech).
//
// The Coordinator used to track this busy state internally but never told the
// client. The logic lives in ProcessingIndicators (extracted from
// AgentCoordinator so it's testable without the Coordinator's heavy import
// graph — live providers, DB repos, social-bot TSX). The Coordinator wires it
// with `emit = (msg) => this.send(msg)`; here we capture emits into an array.
//
// Invariants pinned: (1) dedup — only emit on a real flip; (2) backstop timers
// so a cue never sticks if the agent ends its turn without a terminal event.

import { jest } from "@jest/globals";
import { ProcessingIndicators, type ProcessingMessage } from "../services/dual-agent/processing-indicators";

function make() {
  const emitted: ProcessingMessage[] = [];
  const pi = new ProcessingIndicators({ emit: (m) => emitted.push(m) });
  const lastFor = (activity: string): boolean | undefined => {
    const forActivity = emitted.filter((m) => m.activity === activity);
    return forActivity.length ? forActivity[forActivity.length - 1].active : undefined;
  };
  return { pi, emitted, lastFor };
}

describe("ProcessingIndicators", () => {
  it("emits on a real change and dedupes repeats", () => {
    const { pi, emitted } = make();

    pi.set("board", true);
    pi.set("board", true);   // no-op (already true)
    pi.set("board", false);
    pi.set("board", false);  // no-op (already false)

    expect(emitted).toEqual([
      { type: "processing", activity: "board", active: true },
      { type: "processing", activity: "board", active: false },
    ]);
  });

  it("tracks the three activities independently", () => {
    const { pi, lastFor } = make();

    pi.set("speaker", true);
    pi.set("board", true);
    expect(lastFor("speaker")).toBe(true);
    expect(lastFor("board")).toBe(true);
    expect(pi.isActive("interpret")).toBe(false);

    pi.set("speaker", false);
    expect(lastFor("speaker")).toBe(false);
    expect(lastFor("board")).toBe(true); // board unaffected
  });

  it("markSpeakerBusy lights the cue; clearSpeakerBusy drops it", () => {
    const { pi, lastFor } = make();

    pi.markSpeakerBusy();
    expect(lastFor("speaker")).toBe(true);

    pi.clearSpeakerBusy();
    expect(lastFor("speaker")).toBe(false);
  });

  it("markInterpretBusy lights the cue; clearInterpretBusy drops it", () => {
    const { pi, lastFor } = make();

    pi.markInterpretBusy();
    expect(lastFor("interpret")).toBe(true);

    pi.clearInterpretBusy();
    expect(lastFor("interpret")).toBe(false);
  });

  it("the Speaker backstop timer clears a stuck cue after the timeout", () => {
    jest.useFakeTimers();
    try {
      const emitted: ProcessingMessage[] = [];
      const pi = new ProcessingIndicators({ emit: (m) => emitted.push(m), speakerTimeoutMs: 25_000 });

      pi.markSpeakerBusy();
      expect(emitted.at(-1)).toEqual({ type: "processing", activity: "speaker", active: true });

      // Model never emitted a terminal event — the backstop fires.
      jest.advanceTimersByTime(25_000);
      expect(emitted.at(-1)).toEqual({ type: "processing", activity: "speaker", active: false });
    } finally {
      jest.useRealTimers();
    }
  });

  it("the interpret backstop timer clears a stuck cue after the timeout", () => {
    jest.useFakeTimers();
    try {
      const emitted: ProcessingMessage[] = [];
      const pi = new ProcessingIndicators({ emit: (m) => emitted.push(m), interpretTimeoutMs: 15_000 });

      pi.markInterpretBusy();
      jest.advanceTimersByTime(15_000);
      expect(emitted.at(-1)).toEqual({ type: "processing", activity: "interpret", active: false });
    } finally {
      jest.useRealTimers();
    }
  });

  it("a resolved turn cancels the backstop (no late spurious clear)", () => {
    jest.useFakeTimers();
    try {
      const emitted: ProcessingMessage[] = [];
      const pi = new ProcessingIndicators({ emit: (m) => emitted.push(m), speakerTimeoutMs: 25_000 });

      pi.markSpeakerBusy();     // true
      pi.clearSpeakerBusy();    // false (turn resolved normally)
      const countAfterClear = emitted.length;

      // The armed timer must have been cancelled — no extra emit fires.
      jest.advanceTimersByTime(60_000);
      expect(emitted.length).toBe(countAfterClear);
    } finally {
      jest.useRealTimers();
    }
  });

  // The "board" cue is the one that had NO backstop until 2026-08-25. The
  // Coordinator lights it at Board Manager invoke start and clears it in exactly
  // one branch of one `finally`, so a rebuild chain that ended anywhere else —
  // a re-entry hitting the `resting` gate, a teardown, an enterSleep that keeps
  // the socket open — left the child watching a loading bar with nothing alive
  // that could ever take it down. The client is a pure mirror with no timeout of
  // its own, so the stuck bar outlived the failure that caused it.
  describe("the board cue", () => {
    it("auto-clears if the rebuild chain never reports a terminal event", () => {
      jest.useFakeTimers();
      try {
        const emitted: ProcessingMessage[] = [];
        const pi = new ProcessingIndicators({ emit: (m) => emitted.push(m), boardTimeoutMs: 45_000 });

        pi.markBoardBusy();
        expect(pi.isActive("board")).toBe(true);

        // Nothing else happens — the chain died silently.
        jest.advanceTimersByTime(45_000);
        expect(pi.isActive("board")).toBe(false);
        expect(emitted.at(-1)).toEqual({ type: "processing", activity: "board", active: false });
      } finally {
        jest.useRealTimers();
      }
    });

    it("re-arms on each link of a chain, so a long rebuild is never cut short", () => {
      jest.useFakeTimers();
      try {
        const pi = new ProcessingIndicators({ emit: () => {}, boardTimeoutMs: 45_000 });

        pi.markBoardBusy();
        // A retry / queued-trigger re-invocation lands well into the window.
        jest.advanceTimersByTime(40_000);
        pi.markBoardBusy();
        // The ORIGINAL deadline passes; the cue must still be up because the
        // chain is demonstrably still working.
        jest.advanceTimersByTime(10_000);
        expect(pi.isActive("board")).toBe(true);

        // The re-armed deadline then applies from the later mark.
        jest.advanceTimersByTime(35_000);
        expect(pi.isActive("board")).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it("a delivered board cancels the backstop (no late spurious clear)", () => {
      jest.useFakeTimers();
      try {
        const emitted: ProcessingMessage[] = [];
        const pi = new ProcessingIndicators({ emit: (m) => emitted.push(m), boardTimeoutMs: 45_000 });

        pi.markBoardBusy();
        pi.clearBoardBusy();
        const countAfterClear = emitted.length;

        jest.advanceTimersByTime(120_000);
        expect(emitted.length).toBe(countAfterClear);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it("clearAll drops every active cue and cancels timers (teardown / reset)", () => {
    jest.useFakeTimers();
    try {
      const emitted: ProcessingMessage[] = [];
      const pi = new ProcessingIndicators({ emit: (m) => emitted.push(m) });

      pi.markSpeakerBusy();
      pi.markBoardBusy();   // mark, not set — so clearAll's timer cancellation is actually exercised
      pi.markInterpretBusy();

      pi.clearAll();
      const lastFor = (a: string) => { const f = emitted.filter((m) => m.activity === a); return f.at(-1)?.active; };
      expect(lastFor("speaker")).toBe(false);
      expect(lastFor("board")).toBe(false);
      expect(lastFor("interpret")).toBe(false);

      // Timers were cancelled — advancing produces no further emits.
      const count = emitted.length;
      jest.advanceTimersByTime(60_000);
      expect(emitted.length).toBe(count);
    } finally {
      jest.useRealTimers();
    }
  });
  // The "app" cue is the one that covers a DELIBERATE silence rather than a
  // background task. The Speaker cannot speak while `open_app`'s
  // functionResponse is being held (Gemini Live blocks generation for the whole
  // hold — measured 2026-08-24), so if this cue fails to appear, a press is
  // followed by ~2s of nothing at all and reads as a dead button.
  describe("app-open cue", () => {
    it("lights on markAppBusy and clears on clearAppBusy", () => {
      const { pi, lastFor } = make();
      pi.markAppBusy();
      expect(lastFor("app")).toBe(true);
      pi.clearAppBusy();
      expect(lastFor("app")).toBe(false);
    });

    it("auto-clears on its backstop so it can never outlive the open", () => {
      jest.useFakeTimers();
      try {
        const { pi, lastFor } = make();
        pi.markAppBusy();
        expect(lastFor("app")).toBe(true);
        jest.advanceTimersByTime(10_000);
        expect(lastFor("app")).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it("clears BEFORE the Speaker's own backstop would", () => {
      // The cue brackets one routeAppOpen, whose slowest leg is a single
      // startup-resolver call. A cue still burning after the ack has been
      // force-answered tells the child to keep waiting for a screen that is
      // never coming.
      jest.useFakeTimers();
      try {
        const { pi, lastFor } = make();
        pi.markAppBusy();
        jest.advanceTimersByTime(25_000);
        expect(lastFor("app")).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it("clearAppBusy cancels the backstop — no late emit after a fast open", () => {
      jest.useFakeTimers();
      try {
        const emitted: ProcessingMessage[] = [];
        const pi = new ProcessingIndicators({ emit: (m) => emitted.push(m) });
        pi.markAppBusy();
        pi.clearAppBusy();
        const count = emitted.length;
        jest.advanceTimersByTime(60_000);
        expect(emitted.length).toBe(count);
      } finally {
        jest.useRealTimers();
      }
    });

    it("clearAll drops the app cue too", () => {
      jest.useFakeTimers();
      try {
        const emitted: ProcessingMessage[] = [];
        const pi = new ProcessingIndicators({ emit: (m) => emitted.push(m) });
        pi.markAppBusy();
        pi.clearAll();
        expect(emitted.filter((m) => m.activity === "app").at(-1)?.active).toBe(false);
        const count = emitted.length;
        jest.advanceTimersByTime(60_000);
        expect(emitted.length).toBe(count);
      } finally {
        jest.useRealTimers();
      }
    });

    it("is independent of the other three cues", () => {
      const { pi, lastFor } = make();
      pi.markAppBusy();
      pi.markSpeakerBusy();
      pi.clearSpeakerBusy();
      expect(lastFor("app")).toBe(true);   // still opening
      expect(lastFor("speaker")).toBe(false);
      pi.clearAll();   // don't leave the backstop timer live for jest
    });
  });
});