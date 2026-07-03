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

  it("clearAll drops every active cue and cancels timers (teardown / reset)", () => {
    jest.useFakeTimers();
    try {
      const emitted: ProcessingMessage[] = [];
      const pi = new ProcessingIndicators({ emit: (m) => emitted.push(m) });

      pi.markSpeakerBusy();
      pi.set("board", true);
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
});
