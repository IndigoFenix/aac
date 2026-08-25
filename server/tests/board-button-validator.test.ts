/**
 * Unit tests for the board-button validator — the structural gate that
 * rebuild_board, add_buttons and add_context_button run incoming buttons
 * through before they reach the student's board. The validator drops
 * un-renderable buttons and returns AI-facing error strings so the model
 * can rebuild. These tests pin the rules that were leaking blank
 * speech-bubble buttons onto the board.
 */

import { describe, it, expect } from "@jest/globals";
import { validateBoardButtons } from "../services/dual-agent/board-button-validator";

// Mirror the shape toolArgsToButtons produces. iconRef defaults to the
// "fas fa-comment" sentinel exactly as the parser leaves it when nothing
// resolved to an emoji.
type Btn = {
  label: string;
  glyph?: string;
  glyphFallback?: string;
  imageKey?: string;
  iconRef?: string;
  symbolPath?: string;
};

describe("validateBoardButtons", () => {
  it("keeps a plain emoji-glyph button", () => {
    const { buttons, errors } = validateBoardButtons<Btn>([
      { label: "Water", glyph: "💧", iconRef: "💧" },
    ]);
    expect(buttons).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });

  it("keeps a generate: glyph WITH a valid fallback", () => {
    const { buttons, errors } = validateBoardButtons<Btn>([
      {
        label: "Mars",
        glyph: "i_me+want+generate:planet_mars",
        glyphFallback: "i_me+want+🌑",
        iconRef: "fas fa-comment",
      },
    ]);
    expect(buttons).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });

  it("rejects an imageKey glyph with no fallback (rule 1)", () => {
    const { buttons, errors } = validateBoardButtons<Btn>([
      { label: "Mars", glyph: "i_me+want+generate:planet_mars", imageKey: "planet_mars", iconRef: "fas fa-comment" },
    ]);
    expect(buttons).toHaveLength(0);
    expect(errors[0]).toMatch(/glyphFallback/i);
    expect(errors[0]).toContain("`planet_mars`");
  });

  it("rejects a generate: key inside the fallback (rule 2)", () => {
    const { buttons, errors } = validateBoardButtons<Btn>([
      {
        label: "Mars",
        glyph: "i_me+want+generate:planet_mars",
        glyphFallback: "i_me+want+generate:red_planet",
        iconRef: "fas fa-comment",
      },
    ]);
    expect(buttons).toHaveLength(0);
    expect(errors[0]).toMatch(/image generation/i);
  });

  it("rejects a non-canonical modifier (rule 3)", () => {
    const { buttons, errors } = validateBoardButtons<Btn>([
      { label: "Sad book", glyph: "📖.sad", iconRef: "📖" },
    ]);
    expect(buttons).toHaveLength(0);
    expect(errors[0]).toMatch(/non-canonical modifier/i);
  });

  it("rejects a duplicate glyph (rule 4)", () => {
    const { buttons, errors } = validateBoardButtons<Btn>([
      { label: "One", glyph: "💧", iconRef: "💧" },
      { label: "Two", glyph: "💧", iconRef: "💧" },
    ]);
    expect(buttons).toHaveLength(1);
    expect(errors[0]).toMatch(/identical to button/i);
  });

  it("rejects a button with nothing displayable — the blank speech-bubble case (rule 6)", () => {
    const { buttons, errors } = validateBoardButtons<Btn>([
      { label: "Mystery", iconRef: "fas fa-comment" },
    ]);
    expect(buttons).toHaveLength(0);
    expect(errors[0]).toMatch(/no displayable image/i);
  });

  it("rejects a bare legacy imageKey with no glyph/fallback (rule 6)", () => {
    // The legacy single-concept path: imageKey set, no glyph, iconRef never
    // resolved to an emoji so it stays the fa-comment sentinel.
    const { buttons, errors } = validateBoardButtons<Btn>([
      { label: "Thing", imageKey: "mystery_object", iconRef: "fas fa-comment" },
    ]);
    expect(buttons).toHaveLength(0);
    expect(errors[0]).toMatch(/no displayable image/i);
  });

  it("keeps an emoji-only iconRef button (no glyph) — emoji IS renderable", () => {
    const { buttons, errors } = validateBoardButtons<Btn>([
      { label: "Apple", iconRef: "🍎" },
    ]);
    expect(buttons).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });

  it("keeps a face symbolPath button even with the fa-comment sentinel iconRef", () => {
    const { buttons, errors } = validateBoardButtons<Btn>([
      { label: "Mom", symbolPath: "__FACE__:contact-123", iconRef: "fas fa-comment" },
    ]);
    expect(buttons).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });
});

/**
 * LAUNCH BUTTONS are the only route the student has to whatever they open, so
 * the picture rules may take their artwork but never the button. Dropping one
 * silently removes the app from the session: an agent-flow log shows a Sandbox
 * launch button rejected for a missing glyph fallback, the retry re-authored
 * without `open` at all, and the Speaker announcing "opening Sandbox" over a
 * board that had no launcher on it.
 */
describe("validateBoardButtons — launch buttons survive the picture rules", () => {
  type LaunchBtn = Btn & { open?: { app?: string; board?: string; website?: string; home?: string } };

  it("strips the visual instead of dropping the button, and still reports the error", () => {
    const btn: LaunchBtn = {
      label: "Let's play",
      glyph: "yes+play+sandbox_game",
      iconRef: "fas fa-comment",
      open: { app: "sandbox_game" },
    };
    const { buttons, errors, violations } = validateBoardButtons<LaunchBtn>([btn]);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].open).toEqual({ app: "sandbox_game" });
    expect(buttons[0].glyph).toBeUndefined();
    // The fa-comment sentinel is cleared too, so the caller's icon refill lands.
    expect(buttons[0].iconRef).toBeUndefined();
    // The message must NAME the offending slot. Without it the model cannot
    // tell which of three slots to fix, so it retries and re-fails on the same
    // word — the loop that turned a few missing keys into 139 rejected rebuilds.
    expect(errors[0]).toMatch(/not in the registry/i);
    expect(errors[0]).toContain("`sandbox_game`");
    expect(errors[0]).not.toContain("`yes`");
    expect(errors[0]).not.toContain("`play`");
    expect(violations[0].rule).toBe("imagekey_no_fallback");
  });

  it("still drops the SAME button when it opens nothing", () => {
    const { buttons, errors } = validateBoardButtons<LaunchBtn>([
      { label: "Let's play", glyph: "yes+play+sandbox_game", iconRef: "fas fa-comment" },
    ]);
    expect(buttons).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it("rescues board / website / home targets too", () => {
    const { buttons } = validateBoardButtons<LaunchBtn>([
      { label: "Snack", glyph: "bad_key_a", open: { board: "snack" } },
      { label: "Wiki", glyph: "bad_key_b", open: { website: "https://wikipedia.org" } },
      { label: "Lights", glyph: "bad_key_c", open: { home: "lights_on" } },
    ]);
    expect(buttons.map(b => b.label)).toEqual(["Snack", "Wiki", "Lights"]);
  });

  it("rescues a non-canonical modifier and a duplicate glyph", () => {
    const { buttons, violations } = validateBoardButtons<LaunchBtn>([
      // A fallback is present, so this clears rule 1 and lands on rule 3.
      { label: "Draw", glyph: "\u{1F3A8}.funny", glyphFallback: "\u{1F3A8}", open: { app: "drawing" } },
      { label: "Bubbles A", glyph: "\u{1FAE7}", open: { app: "bubbles_game" } },
      { label: "Bubbles B", glyph: "\u{1FAE7}", open: { app: "bubbles_game" } },
    ]);
    expect(buttons.map(b => b.label)).toEqual(["Draw", "Bubbles A", "Bubbles B"]);
    expect(violations.map(v => v.rule)).toEqual(["non_canonical_modifier", "duplicate_glyph"]);
  });

  it("keeps a visual-less launch button so the caller can dress it", () => {
    const { buttons, violations } = validateBoardButtons<LaunchBtn>([
      { label: "Sandbox", iconRef: "fas fa-comment", open: { app: "sandbox_game" } },
    ]);
    expect(buttons).toHaveLength(1);
    expect(violations[0].rule).toBe("no_visual");
  });

  it("a stripped launch button does not claim a glyph signature", () => {
    // Its glyph is gone, so a LATER button may legitimately use that glyph.
    const { buttons } = validateBoardButtons<LaunchBtn>([
      { label: "Sandbox", glyph: "some_unknown_key", open: { app: "sandbox_game" } },
      { label: "Also", glyph: "some_unknown_key", glyphFallback: "\u{1F3AE}" },
    ]);
    expect(buttons.map(b => b.label)).toEqual(["Sandbox", "Also"]);
  });

  it("still drops a launch button whose LABEL shape is broken", () => {
    // Label rules aren't cosmetic — a malformed prefix means the button itself
    // is malformed, not just its picture.
    const { buttons, errors } = validateBoardButtons<LaunchBtn>([
      { label: "[NARROW:] ", glyph: "\u{1F3AE}", open: { app: "sandbox_game" } },
    ]);
    expect(buttons).toHaveLength(0);
    expect(errors[0]).toMatch(/malformed \[NARROW/i);
  });
});
