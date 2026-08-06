// server/services/dual-agent/speech-board-trigger.ts
//
// WHEN SPOKEN WORDS MOVE THE BOARD.
//
// A press has always driven the Board Manager. Speech did not: a transcript
// aimed at the AI went to the Speaker alone, so the only agent that can change
// the surface — load a pre-built board, offer an app — never heard the ask. In
// session 7f5fccb5 the student said "לוח לבניה" ("a board for building"); the
// Board Manager's whole view of that turn was the Speaker's paraphrase, tagged
// [AI to USER], which reads as "build replies" and not as a request. No board
// opened, and the same words had to be pressed out on buttons minutes later.
//
// Two decisions live here, kept out of AgentCoordinator so they can be tested
// without its import graph (same reasoning as game-options.ts):
//   1. WHOSE speech moves the board.
//   2. What the Speaker's reply carries with it when it supersedes that turn.

import type { AgentEvent, TranscribedEvent } from "./agent-events";
import { isUserTarget } from "./speech-party";

/** The fields of a transcript this decision reads. Structural so callers can
 *  pass a full TranscribedEvent (or a test fixture) without ceremony. */
export interface SpokenTurn {
  speaker: string;
  /** Set by the Coordinator's attribution trust gate — the words are ambient
   *  hearsay, not an attributable turn. */
  attributionDemotion?: TranscribedEvent["attributionDemotion"];
}

/**
 * Does this DEVICE-targeted speech deserve a Board Manager invocation?
 *
 * Only the STUDENT's own voice: their speech is a turn exactly like a press, so
 * the board should answer it. A third party addressing the AI (`[Mom to AI]`)
 * is not the user's turn — the AI's reply is what the user may want to respond
 * to, and that already drives a rebuild. A demoted attribution is not anyone's
 * turn at all.
 */
export function userSpeechDrivesBoard(
  turn: SpokenTurn,
  ...studentNames: (string | undefined)[]
): boolean {
  if (turn.attributionDemotion) return false;
  return isUserTarget(turn.speaker, ...studentNames);
}

/**
 * The triggers for the invocation fired by the Speaker's reply, given whatever
 * deferred trigger that reply just superseded.
 *
 * A superseded USER-SPEECH turn RIDES ALONG rather than being dropped: the
 * user's own words are the only place a spoken request exists, and both events
 * reach the model in ONE invocation, so carrying it costs nothing. Anything
 * else (a press, nothing at all) leaves just the speech — a press is the
 * board's own last action and is already visible in <recent_events>.
 */
export function speakerReplyTriggers(
  deferred: AgentEvent | null,
  speech: AgentEvent,
): AgentEvent[] {
  return deferred && deferred.type === "transcribed" ? [deferred, speech] : [speech];
}
