/**
 * The MORE OPTIONS affordance — one look, two sources.
 *
 * The fixed quick-actions "More" button and any AI-authored board button with
 * `buttonType: "more"` make the SAME promise to the student ("show me other
 * things I could say"), so they share a single colour + icon constant and the
 * Board Manager is taught when to emit one. These tests pin:
 *   1. the shared constants (one definition, distinct from the rest of the
 *      quick-actions palette, reachable through `resolveButtonBackground`);
 *   2. the Board Manager prompt teaching BOTH halves — offer a "something
 *      else" button for more options, never for changing the subject;
 *   3. that a `more` button survives the validator and the board merge.
 */

import { describe, it, expect } from "@jest/globals";
import {
  MORE_OPTIONS_COLOR,
  MORE_OPTIONS_ICON,
  SPECIAL_BUTTON_COLORS,
  resolveButtonBackground,
  resolveButtonColorToken,
} from "../../shared/button-color.js";
import {
  buildBoardManagerPrompt,
  buildBoardManagerToolDeclarations,
  type BoardManagerToolConfig,
} from "../services/dual-agent/prompts/board-manager";
import { validateBoardButtons } from "../services/dual-agent/board-button-validator";
import { sameBoard, smartMergeButtons, type MergeButton } from "../services/dual-agent/board-merge";

/** Every other background in the fixed quick-actions row (QuickActions.tsx).
 *  The MORE button must not collide with any of them — its whole job is to be
 *  its own category rather than neutral chrome. */
const QUICK_ACTION_PALETTE = [
  "#D1FAE5", // yes  — green
  "#FEE2E2", // no   — red
  "#DBEAFE", // home — blue
  "#E0E7FF", // board — indigo
  "#C4B5FD", // back / guess-active — violet
  "#EDE9FE", // guess — violet
  "#FEF3C7", // speak — amber
  "#FCA5A5", // exit  — red
  "#E5E7EB", // the neutral default the MORE button used to wear
];

describe("MORE OPTIONS colour + icon constants", () => {
  it("is the single definition the special-button map points at", () => {
    expect(SPECIAL_BUTTON_COLORS.more).toBe(MORE_OPTIONS_COLOR);
  });

  it("is distinct from every other quick-action colour and from wordfinder", () => {
    for (const hex of QUICK_ACTION_PALETTE) {
      expect(MORE_OPTIONS_COLOR.toLowerCase()).not.toBe(hex.toLowerCase());
    }
    expect(MORE_OPTIONS_COLOR).not.toBe(SPECIAL_BUTTON_COLORS.wordfinder);
  });

  it("resolves for an AI button carrying buttonType 'more'", () => {
    expect(resolveButtonColorToken({ buttonType: "more" })).toBe(MORE_OPTIONS_COLOR);
    expect(resolveButtonBackground(undefined, undefined, "more")).toBe(MORE_OPTIONS_COLOR);
    // A glyph that would otherwise auto-colour still yields the meta colour.
    expect(resolveButtonBackground(undefined, "yes", "more")).toBe(MORE_OPTIONS_COLOR);
  });

  it("still lets an explicit colour win", () => {
    expect(resolveButtonBackground("#123456", undefined, "more")).toBe("#123456");
  });

  it("uses the reload symbol, not the plus sign", () => {
    expect(MORE_OPTIONS_ICON).toBe("🔄");
    expect(MORE_OPTIONS_ICON).not.toBe("➕");
  });
});

describe("Board Manager prompt — the 'something else' rule", () => {
  const { base } = buildBoardManagerPrompt({
    studentName: "Test",
    language: "en",
    muteState: "unmuted",
  });

  it("teaches the POSITIVE half: emit button_type 'more' for other options", () => {
    expect(base).toContain(`button_type: "more"`);
    expect(base).toContain("MORE OPTIONS button");
    expect(base).toMatch(/RELOAD symbol/);
  });

  it("teaches the NEGATIVE half: 'something else' never means change the subject", () => {
    expect(base).toContain(`"Something else" means MORE OPTIONS`);
    expect(base).toContain("It NEVER means");
    expect(base).toContain("change the subject");
    // The alternative affordance for a topic change is named.
    expect(base).toContain(`button_type: "wordfinder"`);
  });

  it("no longer suggests a hand-made 'something else' reply button", () => {
    // The old worked examples inside the prompt itself offered "something
    // else" as a plain utterance — exactly the shape users misread.
    expect(base).not.toContain(`"actually, something else"`);
    expect(base).not.toContain(`"I'm not hungry", "something else"`);
  });

  it("does not duplicate the WHEN guidance into the tool description", () => {
    const config: BoardManagerToolConfig = { availableBoards: [], hasLoadedBoard: false };
    const decls = buildBoardManagerToolDeclarations(config);
    const rebuild = decls[0].functionDeclarations!.find(d => d.name === "rebuild_board")!;
    const params = rebuild.parametersJsonSchema as any;
    const desc: string = params.properties.buttons.items.properties.button_type.description;
    // HOW (what the device renders) lives here...
    expect(desc).toContain("RELOAD symbol");
    expect(desc).toContain("something else");
    // ...WHEN lives in the system prompt, referenced not restated.
    expect(desc).toContain("<meta_buttons>");
    expect(desc).not.toContain("change the subject");
  });
});

describe("a 'more' button survives validation and merge", () => {
  /** The canonical fixed shape the Board Manager agent mints for
   *  `button_type: "more"` (buildSpecialButton). */
  const moreButton = {
    label: "More",
    sentence: "more",
    iconRef: "fas fa-arrows-rotate",
    glyphFallback: MORE_OPTIONS_ICON,
    buttonType: "more" as const,
  };

  it("is not dropped by validateBoardButtons", () => {
    // The coordinator routes meta buttons AROUND the validator, but the shape
    // must survive it regardless — a future path that validates them must not
    // silently eat the student's way to more options.
    const { buttons, errors } = validateBoardButtons([moreButton]);
    expect(buttons).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("keeps its buttonType through smartMergeButtons", () => {
    const prev: MergeButton[] = [
      { id: "a", label: "Yes", glyphFallback: "👍" },
      { id: "b", label: "No", glyphFallback: "👎" },
    ];
    let n = 0;
    const { merged } = smartMergeButtons(prev, [moreButton], 8, () => `new-${++n}`);
    const kept = merged.find(b => b.buttonType === "more");
    expect(kept).toBeDefined();
    expect(kept!.label).toBe("More");
  });

  it("sameBoard treats a more button as different from a wordfinder button", () => {
    const a: MergeButton[] = [{ ...moreButton }];
    const b: MergeButton[] = [{ ...moreButton, buttonType: "wordfinder" }];
    expect(sameBoard(a, a)).toBe(true);
    expect(sameBoard(a, b)).toBe(false);
  });
});
