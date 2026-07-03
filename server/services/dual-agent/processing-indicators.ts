// server/services/dual-agent/processing-indicators.ts
//
// Pure state machine for the AAC "backend is busy" indicators. The Coordinator
// owns three busy signals the child is waiting on — the Speaker composing a
// reply, the Board Manager rebuilding, and a composed sentence being
// interpreted into speech — and mirrors each to the client via `processing`
// WS envelopes so the UI can show a subtle ambient cue.
//
// Extracted from AgentCoordinator so the emit/dedup + backstop-timer logic can
// be unit-tested without dragging in the Coordinator's heavy import graph
// (live providers, DB repos, social-bot TSX). The Coordinator constructs one of
// these with `emit = (msg) => this.send(msg)` and delegates.
//
// Two invariants:
//   1. Dedup — only emit when an activity's state actually flips, so the client
//      never sees a redundant true→true / false→false (e.g. a Board Manager
//      rebuild chain that re-invokes stays one continuous "busy").
//   2. Backstop — Speaker and interpret each arm an auto-clear timer so an
//      indicator never sticks if the agent ends its turn without a terminal
//      event (a silent turn without stay_silent, an error, a dropped socket).

import type { ProcessingActivity } from "./live-relay";

export interface ProcessingMessage {
  type: "processing";
  activity: ProcessingActivity;
  active: boolean;
}

export interface ProcessingIndicatorsOptions {
  /** Emit a wire message. Called only when an activity's state actually flips. */
  emit: (msg: ProcessingMessage) => void;
  /** Backstop after which a stuck Speaker cue auto-clears. Default 25s. */
  speakerTimeoutMs?: number;
  /** Backstop after which a stuck interpret cue auto-clears. Default 15s. */
  interpretTimeoutMs?: number;
}

const DEFAULT_SPEAKER_TIMEOUT_MS = 25_000;
const DEFAULT_INTERPRET_TIMEOUT_MS = 15_000;

export class ProcessingIndicators {
  private state: Record<ProcessingActivity, boolean> = { speaker: false, board: false, interpret: false };
  private speakerTimer: ReturnType<typeof setTimeout> | null = null;
  private interpretTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly emit: (msg: ProcessingMessage) => void;
  private readonly speakerTimeoutMs: number;
  private readonly interpretTimeoutMs: number;

  constructor(opts: ProcessingIndicatorsOptions) {
    this.emit = opts.emit;
    this.speakerTimeoutMs = opts.speakerTimeoutMs ?? DEFAULT_SPEAKER_TIMEOUT_MS;
    this.interpretTimeoutMs = opts.interpretTimeoutMs ?? DEFAULT_INTERPRET_TIMEOUT_MS;
  }

  /** Current busy flag for an activity (for callers that gate on it). */
  isActive(activity: ProcessingActivity): boolean {
    return this.state[activity];
  }

  /** Set an activity's busy state, emitting only on a real change. */
  set(activity: ProcessingActivity, active: boolean): void {
    if (this.state[activity] === active) return;
    this.state[activity] = active;
    this.emit({ type: "processing", activity, active });
  }

  /** Speaker turn started — light the cue and (re)arm its backstop. */
  markSpeakerBusy(): void {
    this.set("speaker", true);
    if (this.speakerTimer) clearTimeout(this.speakerTimer);
    this.speakerTimer = setTimeout(() => {
      this.speakerTimer = null;
      this.set("speaker", false);
    }, this.speakerTimeoutMs);
  }

  /** Speaker turn resolved (spoke / stayed silent / leaked a thought). */
  clearSpeakerBusy(): void {
    if (this.speakerTimer) { clearTimeout(this.speakerTimer); this.speakerTimer = null; }
    this.set("speaker", false);
  }

  /** A composed sentence started being interpreted — light + arm backstop. */
  markInterpretBusy(): void {
    this.set("interpret", true);
    if (this.interpretTimer) clearTimeout(this.interpretTimer);
    this.interpretTimer = setTimeout(() => {
      this.interpretTimer = null;
      this.set("interpret", false);
    }, this.interpretTimeoutMs);
  }

  /** Interpretation resolved (voiced, or rejected / produced nothing). */
  clearInterpretBusy(): void {
    if (this.interpretTimer) { clearTimeout(this.interpretTimer); this.interpretTimer = null; }
    this.set("interpret", false);
  }

  /** Clear every cue + cancel timers (session reset / teardown / fatal error). */
  clearAll(): void {
    if (this.speakerTimer) { clearTimeout(this.speakerTimer); this.speakerTimer = null; }
    if (this.interpretTimer) { clearTimeout(this.interpretTimer); this.interpretTimer = null; }
    this.set("speaker", false);
    this.set("board", false);
    this.set("interpret", false);
  }
}
