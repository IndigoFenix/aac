// SPOKEN WORDS MOVING THE BOARD.
//
// Session 7f5fccb5 (2026-08-06): the student said "לוח לבניה" ("a board for
// building"). The Observer routed it DEVICE-targeted, the Speaker answered
// "לוח לבנייה! מעולה. מה נוסיף היום?" — and the Board Manager was invoked with
// that paraphrase ALONE, tagged [AI to USER]. Speech aimed at the AI never
// reached the one agent that can change the surface, so an explicit request for
// a pre-built board could not be honored by anyone. The board finally switched
// four minutes later, off a button press.
//
// Two decisions pinned here (the Coordinator wires both):
//   1. WHOSE speech schedules a Board Manager invocation.
//   2. That the Speaker's reply CARRIES that turn instead of dropping it — the
//      reply is the newer beat, but the request lives only in the user's words.
//
// DB-free (belongs in test:unit): the module under test is pure.

import { describe, it, expect } from "@jest/globals";
import {
  userSpeechDrivesBoard,
  speakerReplyTriggers,
} from "../services/dual-agent/speech-board-trigger";
import type { AgentEvent } from "../services/dual-agent/agent-events";

const STUDENT_FULL = "Daniel Nadel";
const STUDENT_SHORT = "Daniel";

const transcript = (over: Partial<AgentEvent & { text: string }> = {}): AgentEvent =>
  ({
    type: "transcribed",
    source: "observer",
    timestamp: 1,
    text: "לוח לבניה",
    speaker: STUDENT_SHORT,
    target: "DEVICE",
    targetIsUser: false,
    confidence: "medium",
    ...over,
  }) as AgentEvent;

const aiSpeech = (): AgentEvent =>
  ({
    type: "speech_text_finalized",
    source: "speaker",
    timestamp: 2,
    transcript: "לוח לבנייה! מעולה. מה נוסיף היום?",
  }) as AgentEvent;

describe("whose speech drives a board rebuild", () => {
  it("the student's own words do — the case that started this", () => {
    expect(userSpeechDrivesBoard({ speaker: STUDENT_SHORT }, STUDENT_FULL, STUDENT_SHORT)).toBe(true);
  });

  // The Observer routinely writes the FULL name where the session cached only
  // the first (speech-party's token matching) — that must not decide it.
  it("matches the student by full name too", () => {
    expect(userSpeechDrivesBoard({ speaker: STUDENT_FULL }, STUDENT_FULL, STUDENT_SHORT)).toBe(true);
  });

  it("the literal USER token counts as the student", () => {
    expect(userSpeechDrivesBoard({ speaker: "USER" }, STUDENT_FULL, STUDENT_SHORT)).toBe(true);
  });

  // Mom asking the AI something is not the student's turn. The AI's reply is
  // what the student may want to answer, and that already rebuilds.
  it("a third party talking to the AI does not", () => {
    expect(userSpeechDrivesBoard({ speaker: "Mom" }, STUDENT_FULL, STUDENT_SHORT)).toBe(false);
    expect(userSpeechDrivesBoard({ speaker: "UNKNOWN" }, STUDENT_FULL, STUDENT_SHORT)).toBe(false);
  });

  // The trust gate already demoted these to hearsay — they render without a
  // "<speaker> to <target>" shape precisely so nothing treats them as a turn.
  it("demoted attributions never move the board", () => {
    expect(
      userSpeechDrivesBoard(
        { speaker: STUDENT_SHORT, attributionDemotion: "unverified_student_speech" },
        STUDENT_FULL,
        STUDENT_SHORT,
      ),
    ).toBe(false);
    expect(
      userSpeechDrivesBoard(
        { speaker: STUDENT_SHORT, attributionDemotion: "impossible_speech" },
        STUDENT_FULL,
        STUDENT_SHORT,
      ),
    ).toBe(false);
  });
});

describe("what the Speaker's reply carries with it", () => {
  it("carries the superseded user-speech turn alongside the reply, in order", () => {
    const spoken = transcript();
    const reply = aiSpeech();
    expect(speakerReplyTriggers(spoken, reply)).toEqual([spoken, reply]);
  });

  it("is just the reply when nothing was deferred", () => {
    const reply = aiSpeech();
    expect(speakerReplyTriggers(null, reply)).toEqual([reply]);
  });

  // A press is the board's own last action and already shows up in
  // <recent_events>; re-triggering on it would blur the follow-up/reply split
  // the Board Manager's <when_to_act> draws.
  it("drops a superseded press — only speech rides along", () => {
    const press = {
      type: "button_pressed",
      source: "client",
      timestamp: 1,
      label: "כן",
      sentence: "כן",
    } as AgentEvent;
    const reply = aiSpeech();
    expect(speakerReplyTriggers(press, reply)).toEqual([reply]);
  });
});
