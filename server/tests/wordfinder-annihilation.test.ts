// Regression tests for the Word Finder "annihilation" defect (2026-08-19
// session): while guessing was active, Gemini Flash stamped
// `button_type: "wordfinder"` onto its narrowing buttons. Each was then
// canonicalized to a bare "Find word" magnifier (discarding the button's own
// kind/dimension/value/label), and the coordinator — rightly — dropped every
// magnifier because guessing was already open. Net result: word-finder boards
// with ZERO narrowing options, three times in one session.
//
// Two independent layers now prevent it, each pinned here:
//   1. SCHEMA — while guessing is active, "wordfinder" is absent from the
//      `button_type` enum entirely (prose warnings lose to a dangling enum).
//   2. PARSER — a stray `button_type` on a button that also carries real
//      word-finder content (kind / dimension / value / suggestion: key) is
//      ignored, so the content survives even if the model emits it anyway.

import {
  buildBoardManagerTooling,
  finalizeBoardManagerToolCalls,
} from "../services/dual-agent/board-manager-agent";
import type { BoardManagerToolConfig } from "../services/dual-agent/prompts/board-manager";

const BASE_CONFIG: BoardManagerToolConfig = {
  availableBoards: [],
  hasLoadedBoard: false,
  loadedBoardKey: null,
  loadedBoardName: null,
  maxBoardItems: 12,
  language: "he",
  singleGlyphButtons: false,
  glyphInputTranslation: false,
};

/** Pull the `button_type` enum out of rebuild_board's per-button schema. */
function buttonTypeEnum(config: BoardManagerToolConfig): string[] | undefined {
  const decl = buildBoardManagerTooling(config).flatDecls.find((d) => d.name === "rebuild_board");
  const schema = decl?.parametersJsonSchema as any;
  return schema?.properties?.buttons?.items?.properties?.button_type?.enum;
}

function rebuild(buttons: unknown[]) {
  const fusionMap = buildBoardManagerTooling(BASE_CONFIG).fusionMap;
  return finalizeBoardManagerToolCalls(
    [{ name: "rebuild_board", arguments: JSON.stringify({ buttons }) }],
    fusionMap,
    undefined,
    "STOP",
  );
}

describe("button_type schema gating (layer 1)", () => {
  test("outside guessing, the enum offers both meta kinds", () => {
    expect(buttonTypeEnum(BASE_CONFIG)).toEqual(["wordfinder", "more"]);
  });

  test("while guessing is active, 'wordfinder' is not in the enum at all", () => {
    const en = buttonTypeEnum({ ...BASE_CONFIG, guessingActive: true });
    expect(en).toEqual(["more"]);
    expect(en).not.toContain("wordfinder");
  });

  test("the guessing-mode description no longer advertises the magnifier", () => {
    const decl = buildBoardManagerTooling({ ...BASE_CONFIG, guessingActive: true })
      .flatDecls.find((d) => d.name === "rebuild_board");
    const schema = decl?.parametersJsonSchema as any;
    const desc: string = schema?.properties?.buttons?.items?.properties?.button_type?.description ?? "";
    expect(desc).not.toContain('"wordfinder"');
  });
});

describe("stray button_type on a content-carrying button (layer 2)", () => {
  test("kind:narrow + button_type:'wordfinder' keeps the narrowing content", () => {
    const result = rebuild([
      { kind: "narrow", dimension: "where_found", value: "at_home", label: "בבית", speech: "בבית", button_type: "wordfinder" },
      { kind: "narrow", dimension: "where_found", value: "in_nature", label: "בטבע", speech: "בטבע", button_type: "wordfinder" },
    ]);
    const ev = result.events[0] as any;
    expect(ev.type).toBe("board_rebuilt");
    expect(ev.buttons).toHaveLength(2);
    // The old behavior collapsed both to identical "Find word" magnifiers.
    expect(ev.buttons.map((b: any) => b.label)).toEqual(["בבית", "בטבע"]);
    expect(ev.buttons.map((b: any) => b.buttonType)).toEqual(["narrow", "narrow"]);
    expect(ev.buttons.map((b: any) => b.narrowValue)).toEqual(["at_home", "in_nature"]);
    expect(ev.buttons.map((b: any) => b.narrowDimension)).toEqual(["where_found", "where_found"]);
  });

  test("a registry suggestion: key + button_type:'wordfinder' keeps the key", () => {
    const result = rebuild([
      { label: "suggestion:things.kind:animal", button_type: "wordfinder" },
      { label: "suggestion:things.kind:food", button_type: "wordfinder" },
    ]);
    const ev = result.events[0] as any;
    expect(ev.type).toBe("board_rebuilt");
    expect(ev.buttons.map((b: any) => b.label)).toEqual([
      "suggestion:things.kind:animal",
      "suggestion:things.kind:food",
    ]);
  });

  test("a BARE button_type:'wordfinder' still canonicalizes to the fixed magnifier", () => {
    const result = rebuild([
      { button_type: "wordfinder", label: "Find word" },
      { label: "כן", speech: "כן", glyph: [{ sym: "yes" }] },
      { label: "לא", speech: "לא", glyph: [{ sym: "no" }] },
    ]);
    const ev = result.events[0] as any;
    expect(ev.type).toBe("board_rebuilt");
    expect(ev.buttons[0]).toMatchObject({ label: "Find word", buttonType: "wordfinder" });
  });

  test("a bare 'more' meta button is likewise unaffected", () => {
    const result = rebuild([
      { label: "כן", speech: "כן", glyph: [{ sym: "yes" }] },
      { button_type: "more" },
    ]);
    const ev = result.events[0] as any;
    expect(ev.buttons[1]).toMatchObject({ buttonType: "more" });
  });
});
