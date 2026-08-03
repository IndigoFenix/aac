/**
 * The one rule that keeps the AI quiet during a world-engine game.
 *
 * Its counterpart is server-side: game-press.test.ts pins that a `game_press`
 * voices/logs/records the utterance and injects at most a PASSIVE Observer
 * note — it has no Speaker or Board Manager hook at all. This suite pins the
 * client half: that a press made while the game owns the screen is sent on
 * that wire in the first place.
 */

import { describe, it, expect } from "@jest/globals";
import { pressWireFor } from "./press-routing";

describe("pressWireFor", () => {
  it("is the normal conversational turn when no game is running", () => {
    expect(pressWireFor({ worldEngineGameActive: false })).toBe("button_press");
  });

  it("is a game press — no agent turn — while a world-engine game owns the screen", () => {
    expect(pressWireFor({ worldEngineGameActive: true })).toBe("game_press");
  });

  it("does not depend on which button it was: the quick Yes/No route the same way", () => {
    // Regression guard. Yes/No used to bypass the game check entirely (they
    // never touched the locked-board interception in handleBoardButtonClick),
    // so the assistant answered them mid-game.
    const inGame = ["yes", "no", "I want the ball", "Mara"].map((_) =>
      pressWireFor({ worldEngineGameActive: true }),
    );
    expect(new Set(inGame)).toEqual(new Set(["game_press"]));
  });
});
