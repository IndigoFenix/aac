// server/services/processorDisclosure.ts
//
// AKIM §18.5 (accounting of disclosures) / §14 (cross-border transfer evidence).
//
// Every time PHI leaves this system for an external processor — a transcript to
// Anthropic, audio/video frames to Gemini Live, a sentence to ElevenLabs or
// Google TTS, a recording to a speech-to-text service — an `activity_logs` row
// of event type `processor_disclosure` is written. `activityLogService.query({
// subjectId, eventType: "processor_disclosure" })` then answers "everything
// that was disclosed about student X, to whom, when" — that query IS the §18.5
// report; there is no separate endpoint.
//
// ---------------------------------------------------------------------------
// Why this file exists rather than one choke point
// ---------------------------------------------------------------------------
// There is no single egress function. Five families send PHI out:
//   1. structured HTTP completions  (providers/*-structured.ts)
//   2. streaming/complete chat      (providers/*-chat.ts)
//   3. Gemini Live WebSocket        (dual-agent/gemini-live-provider.ts)
//   4. the raw Anthropic SDK        (deepAnalysisService.ts)
//   5. TTS / STT                    (voice/tts-facade.ts, voice/*-stt-*.ts)
// and NONE of their request DTOs carries a student or session id. So the ids
// travel out-of-band: an AsyncLocalStorage context entered at the session
// boundary (`runWithDisclosureContext`), plus an explicit `context` argument
// wherever the ids are local and the async chain is not (the Live provider's
// SDK callbacks, the TTS facade's callers).
//
// ---------------------------------------------------------------------------
// Coalescing semantics (exact)
// ---------------------------------------------------------------------------
// A live session sends ~10 video frames a second. One row per frame is not an
// audit trail, it is a denial-of-service on the audit table. So:
//
//   key = `${studentId ?? "unknown"}|${sessionId ?? "-"}|${processor}|${useCase}|${channel}`
//
//   • The FIRST send for a key writes a row IMMEDIATELY, `details.count = 1`,
//     and opens a 5-minute window. A disclosure is therefore never invisible
//     while it is happening — latency to the audit log is one insert.
//   • Every further send inside that window increments an in-memory counter
//     and writes nothing.
//   • The first send AFTER the window has elapsed flushes the accumulated
//     counter as ONE row (`details.count = N, details.coalesced = true`),
//     then opens a new window with its own immediate `count: 1` row.
//     `N` counts the sends AFTER the window-opening row, so the two rows sum
//     to the true number of sends in the window.
//   • Each call also sweeps OTHER expired keys, so a session that goes quiet
//     while the process stays busy still gets its tail flushed.
//   • `flushDisclosures()` flushes everything unconditionally (shutdown, tests).
//
// The only thing a fully idle process can lose is the *count* of a trailing
// burst — never the fact of the disclosure, which the window-opening row
// already recorded.
//
// ---------------------------------------------------------------------------
// Fail loud
// ---------------------------------------------------------------------------
// A send with no context attached is a COVERAGE GAP in this file's wiring, and
// the one thing it must not do is vanish. It writes the row anyway, with
// `subjectId1: null` and `details.contextMissing: true`, and prints
// PROCESSOR_DISCLOSURE_CONTEXT_MISSING to stderr once per process per
// (processor, channel) so a CloudWatch metric filter can alarm on it. The gap
// then shows up in the log instead of in an audit.

import { AsyncLocalStorage } from "node:async_hooks";
import type { UseCaseKey } from "@shared/llm-options";
import type { ActivitySubjectType } from "@shared/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An external data processor that receives PHI. */
export type DisclosureProcessor = "anthropic" | "google" | "elevenlabs" | "openai";

/** The transport family the disclosure travelled on. */
export type DisclosureChannel = "structured" | "chat" | "live" | "tts" | "stt";

export interface DisclosureContext {
  studentId: string | null;
  sessionId?: string | null;
  userId?: string | null;
  instituteId?: string | null;
  /** A `UseCaseKey` where one exists; a free string for paths with no LLM
   *  use-case of their own (e.g. "tts", "caption_ideas"). */
  useCase: UseCaseKey | string;
}

export interface RecordDisclosureOptions {
  processor: DisclosureProcessor;
  channel: DisclosureChannel;
  model?: string;
  /** Google/Anthropic only: which billing + residency path the call took. */
  endpoint?: "vertex" | "api";
  /** Explicit ids. WINS over the ambient AsyncLocalStorage context. */
  context?: DisclosureContext;
}

/** The shape handed to the sink — a subset of `ActivityLogEntry`. */
export interface DisclosureLogEntry {
  instituteId: string | null;
  userId: string | null;
  eventType: "processor_disclosure";
  subjectType1: ActivitySubjectType;
  subjectId1: string | null;
  subjectType2: ActivitySubjectType | null;
  subjectId2: string | null;
  details: Record<string, unknown>;
  isAiInitiated: true;
}

export type DisclosureSink = (entry: DisclosureLogEntry) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stable stderr marker for a send with no student context. Metric-filter on it. */
export const PROCESSOR_DISCLOSURE_CONTEXT_MISSING =
  "[ProcessorDisclosure] PROCESSOR_DISCLOSURE_CONTEXT_MISSING";

/** One row per key per five minutes. Mirrors the PHI read audit's window. */
export const DISCLOSURE_WINDOW_MS = 5 * 60 * 1000;

/** Bound on the live-window map so a leak cannot grow without limit. */
const MAX_WINDOWS = 5000;

/**
 * Use cases that carry no PHI and must NOT be logged.
 *
 *  • `crm_chat` — the marketing-site assistant: anonymous visitors, no
 *    student, no record.
 *  • `aac_sim` — the offline evaluation harness (services/aac-sim). Its
 *    "child" is SYNTHETIC: a generated persona in a script, not a person, and
 *    no row in `students` backs it. Logging its traffic would file fabricated
 *    disclosures against a subject that does not exist, which is worse for an
 *    §18.5 report than filing none.
 *
 * Both are listed EXPLICITLY, and both are DECLARED by the code that runs
 * them, rather than being skipped for lack of a context. That distinction is
 * the whole safety property here: a genuine PHI path that merely forgot to
 * attach its ids still fails loud (`contextMissing`) instead of passing for a
 * non-PHI one.
 *
 * Adding a use case here asserts that no personal data reaches the processor
 * on that route. It is a claim about the data, not a way to quiet the log.
 */
const NON_PHI_USE_CASES = new Set<string>(["crm_chat", "aac_sim"]);

/** LLM provider key → the legal entity that receives the data. */
const PROVIDER_TO_PROCESSOR: Record<string, DisclosureProcessor> = {
  claude: "anthropic",
  anthropic: "anthropic",
  gemini: "google",
  google: "google",
  openai: "openai",
};

/**
 * Map an internal provider key (`claude` | `gemini` | `openai`) to the
 * processor name used in the disclosure log. Unknown keys fall back to
 * "openai" only if they literally are openai; otherwise they throw, because a
 * new provider silently logging as an existing one is worse than a crash in a
 * code path that is exercised on every call.
 */
export function processorForProvider(provider: string): DisclosureProcessor {
  const mapped = PROVIDER_TO_PROCESSOR[provider];
  if (!mapped) {
    throw new Error(
      `processorForProvider: unknown LLM provider "${provider}" — add it to PROVIDER_TO_PROCESSOR before it can receive PHI.`,
    );
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// Ambient context
// ---------------------------------------------------------------------------

const disclosureStore = new AsyncLocalStorage<DisclosureContext>();

/**
 * Run `fn` with a disclosure context attached. Every provider send inside it —
 * including async work spawned from it, as long as the chain is not broken by
 * an event-emitter or SDK callback boundary — is attributed to these ids.
 *
 * Where the chain IS broken (the Live SDK's onmessage, a detached
 * `setTimeout`), pass the ids explicitly via `RecordDisclosureOptions.context`
 * instead.
 */
export function runWithDisclosureContext<T>(ctx: DisclosureContext, fn: () => T): T {
  return disclosureStore.run(ctx, fn);
}

/** The ambient disclosure context, if any. */
export function getDisclosureContext(): DisclosureContext | undefined {
  return disclosureStore.getStore();
}

// ---------------------------------------------------------------------------
// Sink (injectable — tests never touch the DB)
// ---------------------------------------------------------------------------

let sink: DisclosureSink | null = null;

/**
 * Replace the activity-log sink. Tests inject a collector; production leaves it
 * unset and gets `activityLogService.log` (imported LAZILY, so importing this
 * module in a DB-free unit test does not open a Postgres pool).
 */
export function setDisclosureSink(next: DisclosureSink | null): void {
  sink = next;
}

function emit(entry: DisclosureLogEntry): void {
  if (sink) {
    sink(entry);
    return;
  }
  // Lazy so `server/db.ts` (which throws without DATABASE_URL and opens a
  // pool) is never loaded merely by importing this module.
  void import("./activityLogService")
    .then(({ activityLogService }) => activityLogService.log(entry as any))
    .catch((err) => {
      console.error(
        `${PROCESSOR_DISCLOSURE_CONTEXT_MISSING} sink_unavailable:`,
        (err as any)?.message ?? err,
      );
    });
}

// ---------------------------------------------------------------------------
// Coalescing state
// ---------------------------------------------------------------------------

interface Window {
  windowStart: number;
  /** Sends since the window-opening row. Flushed as one row when it rolls. */
  pending: number;
  entryTemplate: DisclosureLogEntry;
}

const windows = new Map<string, Window>();

/** Test seam: a fake clock. */
let clock: () => number = () => Date.now();
export function setDisclosureClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

/** Test seam: forget every window and every once-per-process warning. */
export function resetDisclosureState(): void {
  windows.clear();
  warned.clear();
}

const warned = new Set<string>();

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

function buildEntry(
  ctx: DisclosureContext | undefined,
  opts: RecordDisclosureOptions,
  count: number,
  coalesced: boolean,
): DisclosureLogEntry {
  const sessionId = ctx?.sessionId ?? null;
  const details: Record<string, unknown> = {
    processor: opts.processor,
    useCase: ctx?.useCase ?? "unknown",
    channel: opts.channel,
    count,
  };
  if (opts.model) details.model = opts.model;
  if (opts.endpoint) details.endpoint = opts.endpoint;
  if (coalesced) details.coalesced = true;
  if (!ctx) details.contextMissing = true;

  return {
    instituteId: ctx?.instituteId ?? null,
    userId: ctx?.userId ?? null,
    eventType: "processor_disclosure",
    subjectType1: "student",
    subjectId1: ctx?.studentId ?? null,
    subjectType2: sessionId ? "chat_session" : null,
    subjectId2: sessionId ?? null,
    details,
    isAiInitiated: true,
  };
}

function flushWindow(w: Window): void {
  if (w.pending <= 0) return;
  const details = { ...w.entryTemplate.details, count: w.pending, coalesced: true };
  emit({ ...w.entryTemplate, details });
  w.pending = 0;
}

/** Flush every window whose 5 minutes have elapsed. */
function sweep(now: number): void {
  for (const [key, w] of windows) {
    if (now - w.windowStart < DISCLOSURE_WINDOW_MS) continue;
    flushWindow(w);
    windows.delete(key);
  }
  if (windows.size >= MAX_WINDOWS) {
    // A burst of distinct keys inside one window: flush and drop the oldest
    // half rather than grow forever. Insertion order is age order.
    let n = 0;
    for (const [key, w] of windows) {
      flushWindow(w);
      windows.delete(key);
      if (++n >= MAX_WINDOWS / 2) break;
    }
  }
}

/**
 * Record one PHI disclosure to an external processor.
 *
 * Cheap and synchronous: at most one activity-log insert (itself
 * fire-and-forget) per key per five minutes. Safe to call on every frame.
 */
export function recordDisclosure(opts: RecordDisclosureOptions): void {
  const ctx = opts.context ?? getDisclosureContext();

  // Anonymous marketing chat: no PHI, deliberately not logged.
  if (ctx && NON_PHI_USE_CASES.has(String(ctx.useCase))) return;

  const now = clock();
  sweep(now);

  if (!ctx) {
    const warnKey = `${opts.processor}|${opts.channel}`;
    if (!warned.has(warnKey)) {
      warned.add(warnKey);
      console.error(
        `${PROCESSOR_DISCLOSURE_CONTEXT_MISSING} processor=${opts.processor} channel=${opts.channel} model=${opts.model ?? "-"}`,
      );
    }
    // No key to coalesce on — an unattributed send is rare and must not be
    // merged with a different one. Write it straight through.
    emit(buildEntry(undefined, opts, 1, false));
    return;
  }

  const key = [
    ctx.studentId ?? "unknown",
    ctx.sessionId ?? "-",
    opts.processor,
    ctx.useCase,
    opts.channel,
  ].join("|");

  const existing = windows.get(key);
  if (existing && now - existing.windowStart < DISCLOSURE_WINDOW_MS) {
    existing.pending += 1;
    return;
  }
  // `sweep` already flushed+removed anything expired; `existing` here is a
  // fresh key.
  const entry = buildEntry(ctx, opts, 1, false);
  emit(entry);
  windows.set(key, { windowStart: now, pending: 0, entryTemplate: entry });
}

/** Flush every open window regardless of age (shutdown, tests). */
export function flushDisclosures(): void {
  for (const [key, w] of windows) {
    flushWindow(w);
    windows.delete(key);
  }
}

/** How long to let the flush's inserts land before exiting. */
const SHUTDOWN_FLUSH_GRACE_MS = 1500;

let shutdownInstalled = false;

/**
 * Flush open coalescing windows when the task is asked to stop.
 *
 * A deploy is the one predictable way to lose a trailing count: ECS sends
 * SIGTERM, the process dies, and every window still holding suppressed sends
 * takes its counter with it. Every one of those windows already wrote its
 * opening row, so no disclosure disappears — but the count would understate
 * a live session's real volume, and "how much crossed the border" is exactly
 * what §14 asks.
 *
 * The handler exits explicitly. Registering ANY SIGTERM listener cancels
 * Node's default terminate-on-signal, so a handler that only flushed would
 * turn a clean drain into a hang until the orchestrator's kill timeout. The
 * grace period exists because `activityLogService.log` is fire-and-forget:
 * the inserts are in flight when the handler returns.
 *
 * Idempotent — the two entry points (index.ts, app.prod.ts) may both call it.
 */
export function installDisclosureShutdownFlush(): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  process.on("SIGTERM", () => {
    try {
      flushDisclosures();
    } catch (err) {
      console.error(
        "[ProcessorDisclosure] shutdown flush failed:",
        (err as any)?.message ?? err,
      );
    }
    setTimeout(() => process.exit(0), SHUTDOWN_FLUSH_GRACE_MS).unref();
  });
}
