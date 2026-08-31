/**
 * trace.ts — THE DEBUG SIDECAR.
 *
 * The transcript records what the CHILD experienced; law ① keeps everything else
 * out of it on purpose. That makes a transcript useless the moment the question
 * becomes "why did the harness do that?" — the answer is always in the material
 * the child was never shown: the raw server traffic, the exact bytes the child
 * model returned, what the settle loop decided and why.
 *
 * So the trace is a SEPARATE FILE with the opposite rule: it holds everything.
 * Same split the world-engine text mode uses (transcript + `.cheats.log`), and
 * for the same reason — mixing them would either blind the debugger or corrupt
 * the measurement.
 *
 * JSONL, appended in order, one event per line: greppable, streamable, and it
 * survives a crash mid-run (which is exactly when it is wanted). Nothing here is
 * ever read back by the harness — a trace that fed anything would be a back
 * channel around the projection.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileDebugLogEnabled, safeAppend } from "../file-debug-log";

export type TraceKind =
  | "run"          // run metadata, first line
  | "boot"         // session opened
  | "recv"         // a batch of server messages the model folded in
  | "sent"         // a ClientMessage the harness delivered
  | "screen"       // the rendered view the child was shown
  | "child"        // the child's decision
  | "child-raw"    // the exact payload the child model returned
  | "settle"       // what the settle loop concluded
  | "act"          // what a press resolved to
  | "judge"        // the judge's report
  | "judge-raw"    // the exact payload the judge returned
  | "note"         // harness commentary
  | "error";

export interface TraceEvent {
  /** ms since the trace opened. */
  t: number;
  kind: TraceKind;
  [k: string]: unknown;
}

export class SimTrace {
  private readonly startedAt = Date.now();
  private readonly events: TraceEvent[] = [];
  private file: string | null = null;

  /** Stream to disk as well as buffering, so a crash still leaves the trail.
   *
   *  Only `scripts/aac-sim-play.ts` calls this — the server-side runner takes
   *  `NO_TRACE` or a file-less SimTrace, so nothing on a request path writes
   *  here. The guard makes that a GUARANTEE rather than a fact about the
   *  current call graph: under a read-only root filesystem (ECS,
   *  var.ecs_readonly_root_fs) the mkdir/write below would throw, and the
   *  trace holds the child model's raw payloads. In-memory buffering and
   *  tail() keep working; only the disk stream is refused. */
  openFile(path: string): void {
    if (!fileDebugLogEnabled()) {
      console.warn("[aac-sim] trace file refused: file debug logging is off (production or NODE_ENV=test)");
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "", "utf-8");
    this.file = path;
  }

  record(kind: TraceKind, data: Record<string, unknown> = {}): void {
    const ev: TraceEvent = { t: Date.now() - this.startedAt, kind, ...data };
    this.events.push(ev);
    if (this.file) {
      // safeAppend cannot throw: a trace that cannot write must never take
      // the run down with it.
      safeAppend(this.file, JSON.stringify(ev) + "\n");
    }
  }

  /** Everything captured, for a caller that wants it in memory. */
  all(): readonly TraceEvent[] {
    return this.events;
  }

  /**
   * A short human-readable tail, for printing when a run fails. Deliberately
   * the LAST events rather than a summary — when something has gone wrong the
   * last few things that happened are the useful ones.
   */
  tail(n = 25): string[] {
    return this.events.slice(-n).map((e) => {
      const { t, kind, ...rest } = e;
      const body = JSON.stringify(rest);
      return `${String(t).padStart(7)}ms ${kind.padEnd(9)} ${body.length > 300 ? body.slice(0, 300) + "…" : body}`;
    });
  }
}

/** A no-op trace, so callers never have to branch on whether tracing is on. */
export const NO_TRACE: SimTrace = new (class extends SimTrace {
  record(): void {
    /* discard */
  }
})();
