/**
 * Unit tests for the conversation-stall accumulator.
 *
 * The decisive case is the real sequence from `server/agent-flow-debug.log`
 * (2026-08-19): a board naming a day and a game → the user presses [MORE] →
 * the rebuild comes back as four subjectless speech acts. Seeds are due on
 * the rebuild AFTER that, and not before.
 */

import { describe, it, expect } from "@jest/globals";
import { scoreBoardContent } from "../services/dual-agent/board-content-signal.js";
import {
  initialStallState,
  noteBoardBuilt,
  noteMorePress,
  noteButtonPress,
  noteExternalTopic,
  noteSeedsSpent,
  isStalling,
  STALL_SCORE_MAX,
} from "../services/dual-agent/conversation-stall.js";

const stallBoard = () => scoreBoardContent([
  { label: "New topic", glyph: "talk+something+else" },
  { label: "Ask question", glyph: "ask+question" },
  { label: "Tell you", glyph: "tell+you" },
]);

const goodBoard = () => scoreBoardContent([
  { label: "My day", glyph: "i_me+talk+day" },
  { label: "Play a game", glyph: "i_me+play+toy" },
]);

const otherGoodBoard = () => scoreBoardContent([
  { label: "Frogs", glyph: "frog" },
  { label: "Rain", glyph: "rain" },
]);

describe("conversation-stall", () => {
  it("stays quiet while boards keep naming new things", () => {
    let s = initialStallState();
    s = noteBoardBuilt(s, goodBoard()).state;
    s = noteBoardBuilt(s, otherGoodBoard()).state;
    expect(isStalling(s)).toBe(false);
  });

  it("reproduces the logged sequence: good board → More → contentless board", () => {
    let s = initialStallState();
    s = noteBoardBuilt(s, goodBoard()).state;
    expect(isStalling(s)).toBe(false);

    s = noteMorePress(s).state;
    expect(isStalling(s)).toBe(false); // one signal is not a stall

    const built = noteBoardBuilt(s, stallBoard());
    s = built.state;
    expect(isStalling(s)).toBe(true);
    expect(built.reason).toMatch(/named nothing/);
  });

  it("reaches the threshold on two contentless boards alone", () => {
    let s = initialStallState();
    s = noteBoardBuilt(s, stallBoard()).state;
    s = noteBoardBuilt(s, stallBoard()).state;
    expect(isStalling(s)).toBe(true);
  });

  it("counts a rebuild that recycles the previous board's referents", () => {
    let s = initialStallState();
    s = noteBoardBuilt(s, goodBoard()).state;
    const again = noteBoardBuilt(s, goodBoard());
    expect(again.reason).toMatch(/recycled/);
    expect(again.state.score).toBeGreaterThan(s.score);
  });

  it("cools off when the user presses a button that names something", () => {
    let s = initialStallState();
    s = noteMorePress(s).state;
    s = noteBoardBuilt(s, stallBoard()).state;
    expect(isStalling(s)).toBe(true);

    const board = goodBoard();
    const pressed = board.buttons.find((b) => b.hasPayload)!;
    s = noteButtonPress(s, pressed);
    expect(isStalling(s)).toBe(false);
  });

  it("does not cool off on a press that names nothing", () => {
    let s = initialStallState();
    s = noteMorePress(s).state;
    s = noteBoardBuilt(s, stallBoard()).state;
    const before = s.score;
    s = noteButtonPress(s, stallBoard().buttons[0]);
    expect(s.score).toBe(before);
  });

  it("stands down entirely when a real topic arrives from outside", () => {
    let s = initialStallState();
    s = noteMorePress(s).state;
    s = noteBoardBuilt(s, stallBoard()).state;
    s = noteExternalTopic(s, ["grandma"]);
    expect(isStalling(s)).toBe(false);
    expect(s.seenHeads).toContain("grandma");
  });

  it("resets once seeds are handed over, so one stall spends one seed", () => {
    let s = initialStallState();
    s = noteMorePress(s).state;
    s = noteBoardBuilt(s, stallBoard()).state;
    expect(isStalling(s)).toBe(true);

    s = noteSeedsSpent(s);
    expect(isStalling(s)).toBe(false);
    expect(s.seedInjections).toBe(1);
  });

  it("caps the score so a long dry patch cannot bank an unbounded debt", () => {
    let s = initialStallState();
    for (let i = 0; i < 20; i++) s = noteMorePress(s).state;
    expect(s.score).toBe(STALL_SCORE_MAX);
  });

  it("remembers referents the session has already surfaced", () => {
    let s = initialStallState();
    s = noteBoardBuilt(s, goodBoard()).state;
    s = noteBoardBuilt(s, otherGoodBoard()).state;
    expect(s.seenHeads).toEqual(expect.arrayContaining(["day", "toy", "frog", "rain"]));
  });

  it("ignores an empty board", () => {
    let s = initialStallState();
    const r = noteBoardBuilt(s, scoreBoardContent([]));
    expect(r.state).toBe(s);
    expect(r.reason).toBeNull();
  });
});
