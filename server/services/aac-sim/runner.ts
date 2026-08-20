/**
 * runner.ts — THE LOOP (harness design ⑦).
 *
 * boot → project → ask the child → act → settle → project → …
 * until the child is done, gives up, or runs out of presses.
 *
 * TWO RULES CARRY THE MEASUREMENT.
 *
 * ⓵ SETTLE BEFORE READING. The first reply is not the last: the Speaker can
 *   finish talking while the Board Manager is still rebuilding. The first real
 *   run read at the first message and showed a board with seven empty cells —
 *   which looked exactly like a serious finding and was not one. So a turn ends
 *   when the traffic goes QUIET, not when the first envelope lands.
 *
 * ⓶ EVERY PRESS COUNTS, including the local ones. A page link sends nothing to
 *   the server but still costs the child a press, and reachability is the whole
 *   measurement (law ⑥).
 */

import type { ChildProfile } from "@shared/aac/sim-profiles";
import { landedCell, simRandom } from "@shared/aac/sim-profiles";
import type { User } from "@shared/schema";
import { bootSimSession } from "./boot.js";
import { SimClientModel } from "./client-model.js";
import { projectQuickRow, projectView, readLabel, renderView, type ProjectedCell } from "./project.js";
import {
  createSimBuilder,
  projectBuilder,
  renderBuilder,
  pressBuilderCell,
  pressBuilderGroup,
  pressBuilderMore,
  pressBuilderPlay,
  pressBuilderTab,
  pressBuilderUndo,
} from "./builder.js";
import type { TextBuilder } from "@shared/world-engine/interaction/text/index.js";
import { pressBoardButton, pressContextButton, pressOverlayOption, pressQuickAction } from "./act.js";
import { childTurn, type ChildAction } from "./child.js";
import { NO_TRACE, type SimTrace } from "./trace.js";
import { endSimSession } from "./teardown.js";
import type { ClientMessage } from "../dual-agent/live-relay.js";

/**
 * SOMEONE ELSE IN THE ROOM.
 *
 * Presence is not a flag the harness can assert — the session has to PERCEIVE
 * a person. It does so the way the real device does: heard speech arrives as
 * `speech_text`, the Observer attributes it, and the verbal-ability gate rules
 * the student out (a nonverbal child cannot have said a full sentence), so what
 * is left is somebody else. That is why `lines` is not optional decoration: a
 * bystander who never speaks is a bystander the session does not know about.
 *
 * It matters because the RIGHT answer to "I want a cup of water" changes with
 * it: ask the adult when one is there, say you cannot when one is not.
 */
export interface Bystander {
  /** Who they are, for the transcript and the report. */
  name: string;
  /** Spoken BEFORE the child's first press, to establish presence. */
  opener: string;
  /** Further lines, keyed to the press count at which they are said. */
  lines?: { afterPress: number; says: string }[];
}

export interface Scenario {
  id: string;
  /** What the child is trying to communicate. Never shown to the AAC. */
  intent: string;
  /** Give up after this many presses — a stuck child must not run forever. */
  maxPresses: number;
  /** A person in the room, or absent. See `Bystander`. */
  bystander?: Bystander;
  /** Did the system say what the child meant? Read over everything it spoke. */
  succeeded(transcript: RunTranscript): boolean;
}

export interface RunTurn {
  n: number;
  screen: string[];
  action: ChildAction;
  /** What the press actually did, in the harness's words. */
  outcome: string;
  /** True when the press never reached the server. */
  local: boolean;
  /** The cell the child AIMED at, and the one they HIT — different on a miss. */
  aimed?: number;
  landed?: number;
  latencyMs: number;
}

export interface RunTranscript {
  scenario: string;
  profile: string;
  studentId: string;
  sessionId: string;
  intent: string;
  turns: RunTurn[];
  /** Everything the child heard, in order. */
  heard: { source: string; text: string; at: number }[];
  counters: {
    presses: number;
    localPresses: number;
    misselects: number;
    deadEnds: number;
    stuckTurns: number;
    /** Board deliveries that landed while the child was still waiting — a
     *  self-correction counts here, and so does a legitimate second rebuild.
     *  Not scored, but on the record: "the board rebuilt 3× before you looked"
     *  is worth knowing either way. */
    boardRebuilds: number;
  };
  /** Who else was in the room, if anyone. Changes what a correct answer IS. */
  bystander: string | null;
  outcome: "done" | "stuck" | "exhausted" | "aborted";
  /** Why the run is void. Present only when `outcome` is "aborted". */
  abortReason?: string;
  childUsage: { promptTokens: number; completionTokens: number };
  wallMs: number;
}

export interface RunOptions {
  scenario: Scenario;
  profile: ChildProfile;
  studentId: string;
  user: User;
  /** Translator for the quick row's i18n keys. Required for a real run. */
  t: (key: string) => string;
  /** Seed for the input-noise model, so a run replays. */
  seed?: number;
  /** How long to let traffic settle before reading a surface. */
  settleMs?: number;
  /** Hard ceiling on the whole run. */
  budgetMs?: number;
  onLine?: (line: string) => void;
  /** Debug sidecar. Records everything the transcript deliberately omits. */
  trace?: SimTrace;
}

/**
 * Wait until the child's screen has stopped changing.
 *
 * THE CONDITION IS THE ONE THE STUDENT CAN SEE. The AAC shows a board loading
 * bar driven by `processing{activity:"board"}` (home.tsx ~:2592), and the child
 * waits while it is up. So the harness waits on exactly that, through
 * `model.boardVisiblyBusy()` — including the client's own 500 ms fade, which is
 * what makes a Board Manager self-correction read as one unbroken bar rather
 * than two. The Coordinator queues a corrective retry when a rebuild comes back
 * empty or invalid (`queueBoardMgrEmptyResponseRetry`, agent-coordinator
 * ~:10533); a child watching that sees the bar stay lit, and now so does this.
 *
 * NO ARBITRARY GRACE WINDOW. An earlier version waited a fixed 6 s after
 * everything looked quiet and treated any late arrival as a correction to
 * absorb. That was both slow and WRONG in one direction: a board that arrives
 * after the bar has gone out is a board that changed under the child, which is
 * a real finding and must not be silently swallowed.
 *
 * Board deliveries seen while waiting are still counted — "the board rebuilt
 * three times before you looked" is worth knowing even when it is legitimate.
 */
export async function settle(
  session: { socket: { outbox: unknown[] } },
  model: SimClientModel,
  settleMs: number,
  cursor: { applied: number },
  opts: { trace?: SimTrace; phase?: string } = {},
): Promise<number> {
  const trace = opts.trace ?? NO_TRACE;
  const until = Date.now() + settleMs;
  let rebuilds = 0;
  let quietRounds = 0;

  const drain = () => {
    const now = session.socket.outbox.length;
    if (now <= cursor.applied) return false;
    const batch = session.socket.outbox.slice(cursor.applied) as { type?: string }[];
    rebuilds += batch.filter((m) => m.type === "board" || m.type === "set_board").length;
    model.applyAll(batch as never[]);
    cursor.applied = now;
    // The RAW server traffic — what the child is not allowed to see, and the
    // first thing anyone debugging this will want.
    trace.record("recv", { phase: opts.phase, messages: batch });
    return true;
  };

  const stillWorking = () => {
    const b = model.status().busy;
    return b.speaker || b.interpret || model.boardVisiblyBusy();
  };

  while (Date.now() < until) {
    quietRounds = drain() ? 0 : quietRounds + 1;
    if (!stillWorking() && quietRounds >= 2) {
      trace.record("settle", { phase: opts.phase, rebuilds, outbox: session.socket.outbox.length });
      return rebuilds;
    }
    // Poll faster than the fade, or the window is missed between samples.
    await new Promise((r) => setTimeout(r, 400));
  }

  drain();
  trace.record("settle", {
    phase: opts.phase,
    rebuilds,
    timedOut: true,
    busy: model.status().busy,
  });
  return rebuilds;
}

export async function runScenario(opts: RunOptions): Promise<RunTranscript> {
  const {
    scenario,
    profile,
    studentId,
    user,
    t,
    seed = 1,
    settleMs = 9000,
    budgetMs = 600_000,
    onLine = () => {},
    trace = NO_TRACE,
  } = opts;

  const rand = simRandom(seed);
  const startedAt = Date.now();
  /** How much of the cumulative outbox the model has already folded in. */
  const cursor = { applied: 0 };
  trace.record("run", { scenario: scenario.id, profile: profile.id, studentId, seed, intent: scenario.intent });
  const session = await bootSimSession({
    studentId,
    user,
    timezone: "Asia/Jerusalem",
    // The bystander's speech arrives over `speech_text`, which the server
    // refuses unless the client advertises it.
    clientStt: !!scenario.bystander,
  });
  const model = new SimClientModel();
  trace.record("boot", { sessionId: session.sessionId, initialized: session.initialized });

  const transcript: RunTranscript = {
    scenario: scenario.id,
    profile: profile.id,
    studentId,
    sessionId: session.sessionId,
    intent: scenario.intent,
    bystander: scenario.bystander?.name ?? null,
    turns: [],
    heard: [],
    counters: { presses: 0, localPresses: 0, misselects: 0, deadEnds: 0, stuckTurns: 0, boardRebuilds: 0 },
    outcome: "exhausted",
    childUsage: { promptTokens: 0, completionTokens: 0 },
    wallMs: 0,
  };

  try {
    // Let startup finish before the child looks: the first board arrives after
    // the session plan runs, which is model work, not instant.
    transcript.counters.boardRebuilds += await settle(session, model, Math.max(settleMs, 20_000), cursor, { trace, phase: "startup" });

    // ESTABLISH PRESENCE FIRST. The person has to be heard before the child
    // asks for anything, or the session has no reason to believe anyone is
    // there and "ask an adult" is not an answer available to it.
    if (scenario.bystander) {
      const line = { type: "speech_text", text: scenario.bystander.opener } as ClientMessage;
      trace.record("sent", { message: line, bystander: scenario.bystander.name });
      session.socket.deliver(line);
      onLine(`ROOM   ${scenario.bystander.name}: "${scenario.bystander.opener}"`);
      transcript.counters.boardRebuilds += await settle(session, model, settleMs, cursor, {
        trace,
        phase: "bystander",
      });
    }

    const history: { action: ChildAction }[] = [];
    /** Created lazily when the child opens the builder, dropped when it closes.
     *  A fresh one per opening: the real overlay starts empty each time. */
    let builder: TextBuilder | null = null;

    while (transcript.counters.presses < scenario.maxPresses) {
      if (Date.now() - startedAt > budgetMs) {
        transcript.outcome = "aborted";
        onLine("ABORT  run budget exhausted");
        break;
      }

      // WHICH SURFACE THE CHILD IS LOOKING AT. The builder is an overlay over
      // the board area, and the AAC leaves the quick row visible and live
      // beneath it — so the builder screen is builder cells PLUS that row, and
      // the board underneath is not pressable while it is up.
      const builderOpen = model.status().builderOpen;
      if (builderOpen && !builder) builder = createSimBuilder({ locale: "en" });
      if (!builderOpen && builder) builder = null;

      let cells: ProjectedCell[];
      let screen: string[];
      let view: ReturnType<typeof projectView> | null = null;

      if (builder) {
        const b = projectBuilder(builder, {
          readLabel: (l) => readLabel(l, profile.perception),
          startAt: 1,
        });
        const quick = projectQuickRow(model, { t, startAt: b.nextN });
        cells = [...b.cells, ...quick];
        screen = [
          ...renderBuilder(b),
          ...quick.map(
            (q) =>
              `QUICK  ${String(q.n).padStart(2)}  "${q.label}"${q.picture ? `  pic ${q.picture}` : ""}${q.disabled ? "  (dimmed)" : ""}`,
          ),
        ];
      } else {
        view = projectView(model, { profile: profile.perception, t });
        cells = view.cells;
        screen = renderView(view);
      }
      for (const l of screen) onLine(l);
      trace.record("screen", {
        turn: transcript.turns.length + 1,
        surface: builder ? "builder" : "board",
        screen,
        status: model.status(),
      });

      const turnStart = Date.now();
      const { action, usage, malformed, raw } = await childTurn({
        profile,
        intent: scenario.intent,
        screen,
        history,
        pressesSoFar: transcript.counters.presses,
      });
      transcript.childUsage.promptTokens += usage.promptTokens;
      transcript.childUsage.completionTokens += usage.completionTokens;
      history.push({ action });
      trace.record("child", { turn: transcript.turns.length + 1, action, usage, malformed: !!malformed });
      // The exact bytes the model returned. Kept even on success: "the child
      // did something odd" is answered by looking at what it actually said.
      if (raw) trace.record("child-raw", { raw });

      // A HARNESS FAILURE IS NOT A FINDING. If the child model did not answer
      // usably, the run is void — scoring it would have the judge write a
      // damning report about a device that never got the chance to fail.
      if (malformed) {
        transcript.outcome = "aborted";
        transcript.abortReason = `child model returned an unusable action: ${raw ?? "(empty)"}`;
        onLine(`ABORT  ${transcript.abortReason}`);
        break;
      }

      onLine(`CHILD  ${action.kind}${action.n != null ? ` ${action.n}` : ""} — ${action.why}`);
      if (action.note) onLine(`NOTE   ${action.note}`);

      if (action.kind === "done" || action.kind === "stuck") {
        transcript.outcome = action.kind === "done" ? "done" : "stuck";
        if (action.kind === "stuck") transcript.counters.stuckTurns++;
        transcript.turns.push({
          n: transcript.turns.length + 1,
          screen,
          action,
          outcome: action.kind === "done" ? "said what they meant" : "gave up",
          local: true,
          latencyMs: Date.now() - turnStart,
        });
        break;
      }

      if (action.kind === "wait") {
        transcript.counters.boardRebuilds += await settle(session, model, settleMs, cursor, { trace, phase: "wait" });
        transcript.turns.push({
          n: transcript.turns.length + 1,
          screen,
          action,
          outcome: "waited",
          local: true,
          latencyMs: Date.now() - turnStart,
        });
        continue;
      }

      // ── a press ──────────────────────────────────────────────────────────
      const aimed = action.n!;
      const aimedCell = cells.find((c) => c.n === aimed);
      if (!aimedCell) {
        // The child named a number that is not on the screen. Recorded as a
        // dead end rather than retried: a child who cannot tell what is
        // pressable IS the finding.
        transcript.counters.deadEnds++;
        transcript.turns.push({
          n: transcript.turns.length + 1,
          screen,
          action,
          outcome: `pressed ${aimed}, which is not on this screen`,
          local: true,
          aimed,
          latencyMs: Date.now() - turnStart,
        });
        continue;
      }

      // MIS-SELECT applies only to the BOARD, where cells are a grid a gaze can
      // slip across. The quick row is a fixed, learned strip; modelling slips
      // there would invent a failure the device does not really have.
      let cell = aimedCell;
      if (cell.where === "board" && view) {
        const boardCells = cells.filter((c) => c.where === "board");
        const idx = boardCells.indexOf(cell);
        const hitIdx = landedCell(idx, view.grid, profile, rand);
        if (hitIdx !== idx && boardCells[hitIdx]) {
          transcript.counters.misselects++;
          cell = boardCells[hitIdx];
        }
      }

      const result = builder ? actBuilder(builder, model, cells, cell) : act(model, view!, cell);
      transcript.counters.presses++;
      if (result.local) transcript.counters.localPresses++;

      trace.record("act", { aimed, landed: cell.n, where: cell.where, note: result.note, local: result.local });
      if (result.message) {
        trace.record("sent", { message: result.message });
        session.socket.deliver(result.message);
        const rebuilt = await settle(session, model, settleMs, cursor, { trace, phase: "press" });
        transcript.counters.boardRebuilds += rebuilt;
        if (rebuilt > 1) {
          onLine(`REBLD  the board rebuilt ${rebuilt}× while the child waited`);
        }
      }

      onLine(`DID    ${result.note}`);

      // Scripted follow-ups, so a scenario can have the adult answer.
      for (const l of scenario.bystander?.lines ?? []) {
        if (l.afterPress !== transcript.counters.presses) continue;
        const msg = { type: "speech_text", text: l.says } as ClientMessage;
        trace.record("sent", { message: msg, bystander: scenario.bystander?.name });
        session.socket.deliver(msg);
        onLine(`ROOM   ${scenario.bystander?.name}: "${l.says}"`);
        transcript.counters.boardRebuilds += await settle(session, model, settleMs, cursor, {
          trace,
          phase: "bystander",
        });
      }
      transcript.turns.push({
        n: transcript.turns.length + 1,
        screen,
        action,
        outcome: result.note,
        local: result.local,
        aimed,
        landed: cell.n,
        latencyMs: Date.now() - turnStart,
      });
    }
  } catch (err) {
    trace.record("error", { message: (err as Error)?.message, stack: (err as Error)?.stack });
    throw err;
  } finally {
    transcript.heard = model.heard.map((h) => ({ source: h.source, text: h.text, at: h.at }));
    transcript.wallMs = Date.now() - startedAt;
    // Close and WAIT. Leaving here without the finalization landing is what
    // left earlier runs abandoned for the sweeper to reap 35 minutes later.
    const ended = await endSimSession(session, { onLine });
    trace.record("note", { teardown: ended });
  }

  return transcript;
}

/** Route a projected cell back to the press it stands for. */
function act(
  model: SimClientModel,
  view: ReturnType<typeof projectView>,
  cell: ProjectedCell,
) {
  const sameSurface = view.cells.filter((c) => c.where === cell.where);
  const idx = sameSurface.indexOf(cell);

  switch (cell.where) {
    case "board": {
      const slot = model.cells()[idx];
      if (!slot || slot.type === "blank") {
        return { message: null, note: "pressed an empty space", local: true };
      }
      return pressBoardButton(model, slot.button);
    }
    case "context": {
      const c = model.contextButtons()[idx];
      return c
        ? pressContextButton(model, c)
        : { message: null, note: "pressed a side button that is gone", local: true };
    }
    case "quick": {
      const q = model.quickActions()[idx];
      return q
        ? pressQuickAction(model, q.id, cell.label ?? q.id)
        : { message: null, note: "pressed a control that is gone", local: true };
    }
    case "overlay": {
      const o = model.overlay()?.options[idx];
      return o
        ? pressOverlayOption(model, String(o.label ?? ""))
        : { message: null, note: "pressed an option that is gone", local: true };
    }

    // tab / chip / control belong to the BUILDER surface and cannot appear on a
    // board screen. Reaching here means the projection and the router disagree
    // about what is on screen — say so rather than silently doing nothing.
    default:
      return {
        message: null,
        note: `pressed a ${cell.where}, which is not on the board surface`,
        local: true,
      };
  }
}

/**
 * Route a press made while the SENTENCE BUILDER is open.
 *
 * Composing is local — nothing reaches the server until Play, which is the one
 * press that sends (`glyph_press`). That matters for the measurement: a sentence
 * costs N presses of which exactly one is traffic, and a harness that reported
 * a message per press would make the builder look far chattier than it is.
 *
 * The quick row is still live underneath the overlay, so its presses route the
 * normal way — including Speak, which is how the child gets back OUT.
 */
function actBuilder(
  builder: TextBuilder,
  model: SimClientModel,
  cells: ProjectedCell[],
  cell: ProjectedCell,
) {
  const sameSurface = cells.filter((c) => c.where === cell.where);
  const idx = sameSurface.indexOf(cell);

  switch (cell.where) {
    // The builder's own word grid + modifier rail. `pressBuilderCell` takes the
    // number PRINTED ON THE BUILDER, which is this cell's own `n` because the
    // builder is numbered from 1 on this screen.
    case "board":
      return pressBuilderCell(builder, cell.n);

    case "tab":
      return pressBuilderTab(builder, cell.label ?? "");

    case "chip":
      return pressBuilderGroup(builder, cell.label ?? "");

    case "control": {
      if (cell.label === "PLAY") return pressBuilderPlay(builder);
      if (cell.label === "undo") return pressBuilderUndo(builder);
      return pressBuilderMore(builder);
    }

    case "quick": {
      const q = model.quickActions()[idx];
      return q
        ? pressQuickAction(model, q.id, cell.label ?? q.id)
        : { message: null, note: "pressed a control that is gone", local: true };
    }

    default:
      return { message: null, note: "pressed something the builder does not have", local: true };
  }
}
