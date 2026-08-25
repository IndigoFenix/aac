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
//   2. Backstop — EVERY activity arms an auto-clear timer so an indicator never
//      sticks if the agent ends its turn without a terminal event (a silent turn
//      without stay_silent, an error, a dropped socket).
//      🚨 `board` had no backstop until 2026-08-25, and this header used to say
//      so ("Speaker and interpret each arm a timer") as though that were fine.
//      It is not: the Coordinator lights `board` at invoke start and clears it
//      in exactly ONE branch of one `finally`, so any path that leaves the
//      rebuild chain early — a re-entry landing on the `resting` gate, a
//      teardown, an `enterSleep` that keeps the socket open — left the child
//      staring at a loading bar that never went away. The client is a pure
//      mirror with no timeout of its own, so nothing downstream could recover.

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
  /** Backstop after which a stuck app-open cue auto-clears. Default 10s. */
  appTimeoutMs?: number;
  /** Backstop after which a stuck board-rebuild cue auto-clears. Default 45s. */
  boardTimeoutMs?: number;
}

const DEFAULT_SPEAKER_TIMEOUT_MS = 25_000;
const DEFAULT_INTERPRET_TIMEOUT_MS = 15_000;
// Shorter than the others on purpose: the app cue brackets ONE routeAppOpen,
// whose slowest leg is a single startup-resolver call. If it has not settled by
// now the open is not coming, and a cue that outlives its work reads as a hang.
const DEFAULT_APP_TIMEOUT_MS = 10_000;
// The most generous of the four, because a rebuild CHAIN is legitimately long:
// one Vertex call can take ~6s, a rate-limited one burns two backoff retries
// before giving up, and a validator rejection queues a feedback retry on top of
// that — so ~28s of honest work was observed in one session. This is a
// last-resort net, not a deadline: it must not fire on a rebuild that is still
// coming, or the board would go quiet mid-think.
const DEFAULT_BOARD_TIMEOUT_MS = 45_000;

export class ProcessingIndicators {
  private state: Record<ProcessingActivity, boolean> = { speaker: false, board: false, interpret: false, app: false };
  private speakerTimer: ReturnType<typeof setTimeout> | null = null;
  private interpretTimer: ReturnType<typeof setTimeout> | null = null;
  private appTimer: ReturnType<typeof setTimeout> | null = null;
  private boardTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly emit: (msg: ProcessingMessage) => void;
  private readonly speakerTimeoutMs: number;
  private readonly interpretTimeoutMs: number;
  private readonly appTimeoutMs: number;
  private readonly boardTimeoutMs: number;

  constructor(opts: ProcessingIndicatorsOptions) {
    this.emit = opts.emit;
    this.speakerTimeoutMs = opts.speakerTimeoutMs ?? DEFAULT_SPEAKER_TIMEOUT_MS;
    this.interpretTimeoutMs = opts.interpretTimeoutMs ?? DEFAULT_INTERPRET_TIMEOUT_MS;
    this.appTimeoutMs = opts.appTimeoutMs ?? DEFAULT_APP_TIMEOUT_MS;
    this.boardTimeoutMs = opts.boardTimeoutMs ?? DEFAULT_BOARD_TIMEOUT_MS;
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

  /** An app open started resolving server-side — light + arm backstop.
   *  Unlike the other three this cue covers a KNOWN silence: the Speaker
   *  cannot talk until the open settles, so this is the only thing telling the
   *  child their press was heard. */
  markAppBusy(): void {
    this.set("app", true);
    if (this.appTimer) clearTimeout(this.appTimer);
    this.appTimer = setTimeout(() => {
      this.appTimer = null;
      this.set("app", false);
    }, this.appTimeoutMs);
  }

  /** The open settled — opened, refused, or failed. */
  clearAppBusy(): void {
    if (this.appTimer) { clearTimeout(this.appTimer); this.appTimer = null; }
    this.set("app", false);
  }

  /** A board rebuild (or rebuild CHAIN) started — light + arm the backstop.
   *  Re-arming on each link of a chain is deliberate: the chain reads as one
   *  continuous "busy" to the child, so the net should track the LAST link, not
   *  the first. */
  markBoardBusy(): void {
    this.set("board", true);
    if (this.boardTimer) clearTimeout(this.boardTimer);
    this.boardTimer = setTimeout(() => {
      this.boardTimer = null;
      this.set("board", false);
    }, this.boardTimeoutMs);
  }

  /** The rebuild chain settled — rebuilt, no_change, aborted, or failed. */
  clearBoardBusy(): void {
    if (this.boardTimer) { clearTimeout(this.boardTimer); this.boardTimer = null; }
    this.set("board", false);
  }

  /** Clear every cue + cancel timers (session reset / teardown / fatal error). */
  clearAll(): void {
    if (this.speakerTimer) { clearTimeout(this.speakerTimer); this.speakerTimer = null; }
    if (this.interpretTimer) { clearTimeout(this.interpretTimer); this.interpretTimer = null; }
    if (this.appTimer) { clearTimeout(this.appTimer); this.appTimer = null; }
    if (this.boardTimer) { clearTimeout(this.boardTimer); this.boardTimer = null; }
    this.set("speaker", false);
    this.set("board", false);
    this.set("interpret", false);
    this.set("app", false);
  }
}
