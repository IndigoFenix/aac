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
    expect(errors[0]).toMatch(/no fallback/i);
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
