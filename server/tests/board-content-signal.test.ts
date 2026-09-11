/**
 * Unit tests for the board CONTENT PAYLOAD signal.
 *
 * The anchor case is the real board logged in
 * `server/agent-flow-debug.log` (2026-08-19), built after a [MORE] press:
 * four buttons, every one a speech act with no subject. That board is what
 * this module exists to recognize, and the board built two turns earlier on
 * the same session — which DID name things — is what it must not flag.
 */

import { describe, it, expect } from "@jest/globals";
import {
  scoreBoardContent,
  scoreButtonContent,
  CONTENTLESS_RATIO,
  type ScorableButton,
} from "../services/dual-agent/board-content-signal.js";

/** The logged stall board, glyphs verbatim. */
const LOGGED_STALL_BOARD: ScorableButton[] = [
  { label: "New topic", glyph: "talk+something+else" },
  { label: "Ask question", glyph: "ask+question" },
  { label: "Tell you", glyph: "tell+you" },
  { label: "Do fun thing", glyph: "do+🤗.good" },
];

/** The board built moments earlier in the same session. */
const LOGGED_GOOD_BOARD: ScorableButton[] = [
  { label: "What to do?", glyph: "what+do" },
  { label: "My day", glyph: "i_me+talk+day" },
  { label: "Play a game", glyph: "i_me+play+toy" },
];

describe("scoreButtonContent", () => {
  it("finds no referent in a bare speech act", () => {
    expect(scoreButtonContent({ label: "Ask question", glyph: "ask+question" }))
      .toMatchObject({ hasPayload: false, heads: [] });
  });

  it("counts a real noun as a referent", () => {
    const v = scoreButtonContent({ label: "Apple", glyph: "i_me+want+apple" });
    expect(v.hasPayload).toBe(true);
    expect(v.heads).toContain("apple");
  });

  it("counts a time word — 'my day' is a topic, 'something' is not", () => {
    expect(scoreButtonContent({ glyph: "i_me+talk+day" }).hasPayload).toBe(true);
    expect(scoreButtonContent({ glyph: "i_me+talk+something" }).hasPayload).toBe(false);
  });

  it("does not count the participants as referents", () => {
    expect(scoreButtonContent({ glyph: "i_me+tell+you" }).hasPayload).toBe(false);
  });

  it("counts an emoji that resolves to a registry item", () => {
    // The feelings board is emoji-only; those are real answers.
    expect(scoreButtonContent({ label: "Happy", glyph: "😀" }).hasPayload).toBe(true);
  });

  it("counts a bracketed on-demand image key but not a bare unknown word", () => {
    expect(scoreButtonContent({ glyph: "i_me+like+[volcano]" }).hasPayload).toBe(true);
    // `else` / `question` / `about` are exactly the bare unknowns the logged
    // stall board used.
    expect(scoreButtonContent({ glyph: "talk+about" }).hasPayload).toBe(false);
  });

  it("falls back to glyphFallback when the glyph resolves to nothing", () => {
    const v = scoreButtonContent({
      label: "Volcano",
      glyph: "[volcano_erupting_at_night]",
      glyphFallback: "🌋",
    });
    expect(v.hasPayload).toBe(true);
  });

  it("counts a payload riding inside a composable host", () => {
    const v = scoreButtonContent({ glyph: "house(apple)" });
    expect(v.hasPayload).toBe(true);
  });
});

describe("scoreBoardContent", () => {
  it("flags the logged stall board as contentless", () => {
    const signal = scoreBoardContent(LOGGED_STALL_BOARD);
    expect(signal.contentless).toBe(true);
    expect(signal.ratio).toBeLessThanOrEqual(CONTENTLESS_RATIO);
  });

  it("does not flag the board that named a day and a game", () => {
    const signal = scoreBoardContent(LOGGED_GOOD_BOARD);
    expect(signal.contentless).toBe(false);
    expect(signal.heads).toEqual(expect.arrayContaining(["day", "toy"]));
  });

  it("excludes navigation chrome from the ratio", () => {
    // Two real buttons plus a More tile: the More tile must not drag the
    // board toward "contentless".
    const signal = scoreBoardContent([
      { label: "Frogs", glyph: "frog" },
      { label: "Rain", glyph: "rain" },
      { label: "More", buttonType: "more", glyph: "" },
    ]);
    expect(signal.total).toBe(2);
    expect(signal.contentless).toBe(false);
  });

  it("treats an empty board as no evidence either way", () => {
    const signal = scoreBoardContent([]);
    expect(signal.contentless).toBe(false);
    expect(signal.total).toBe(0);
  });

  it("reports which buttons named nothing, for the flow log", () => {
    const signal = scoreBoardContent(LOGGED_STALL_BOARD);
    const empty = signal.buttons.filter((b) => !b.hasPayload).map((b) => b.label);
    expect(empty).toEqual(expect.arrayContaining(["New topic", "Ask question", "Tell you"]));
  });
});
