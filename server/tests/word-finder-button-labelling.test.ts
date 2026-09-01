// The Word Finder ENTRY button, when the AI names it.
//
// It used to be one fixed thing: a magnifying glass captioned "Find word",
// with the AI's label, glyph and speech discarded on the way through
// `buildSpecialButton`. A magnifier is a learned metaphor — to a child who has
// not been taught it, it is a shape — so the one affordance that could open a
// search was the one button on the board that never said what it was for.
//
// It can now carry the AI's own wording and symbol: "something else", "I'm
// afraid of…", whatever fits the moment. Two things do NOT vary, and both are
// pinned below:
//
//   - the PURPLE fill, which is what remains to tell a child that this press
//     opens a search instead of speaking a sentence. It now outranks an
//     AI-supplied `color`, so a model that paints its buttons cannot spend it.
//   - `sentence: "wordfinder"`. The press is a mode change, and voicing the
//     label would have the device announce "I'm afraid of…" on the child's
//     behalf before she has said what of.
//
// A labelled entry may also SEED the search — `suggestion:<dim>:<value>`, the
// same key grammar the narrowing buttons already use — so "I'm afraid of…"
// opens on the fear question rather than the generic category menu.
//
// Prod 2026-08-30: a child pressed "I'm still scared" twenty-six times in
// ninety minutes. The Word Finder could have asked her what of; nothing on the
// board looked like it would.

import {
  buildBoardManagerTooling,
  finalizeBoardManagerToolCalls,
} from "../services/dual-agent/board-manager-agent";
import type { BoardManagerToolConfig } from "../services/dual-agent/prompts/board-manager";
import { resolveButtonColorToken, SPECIAL_BUTTON_COLORS } from "@shared/button-color";

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

function rebuild(buttons: unknown[]) {
  const fusionMap = buildBoardManagerTooling(BASE_CONFIG).fusionMap;
  return finalizeBoardManagerToolCalls(
    [{ name: "rebuild_board", arguments: JSON.stringify({ buttons }) }],
    fusionMap,
    undefined,
    undefined,
    "STOP",
  );
}

/** Two filler buttons so a rebuild isn't downgraded to add_board_button. */
const FILLER = [
  { speech: "אני עייפה", label: "עייפה", glyph: [{ sym: "tired" }] },
  { speech: "אני רוצה אמא", label: "אמא", glyph: [{ sym: "mother" }] },
];

const buttonsOf = (result: ReturnType<typeof rebuild>) =>
  (result.events[0] as any).buttons as any[];

describe("a Word Finder entry the AI named", () => {
  test("keeps its label and its symbol instead of collapsing to a magnifier", () => {
    const btns = buttonsOf(rebuild([
      ...FILLER,
      { button_type: "wordfinder", speech: "", label: "אני מפחדת מ...", glyph: [{ sym: "afraid" }] },
    ]));
    const wf = btns.find((b) => b.buttonType === "wordfinder");
    expect(wf).toBeDefined();
    expect(wf.label).toBe("אני מפחדת מ...");
    expect(wf.glyph).toBeTruthy();
    expect(wf.label).not.toBe("Find word");
  });

  test("never voices that label — the press is a mode change, not a sentence", () => {
    const btns = buttonsOf(rebuild([
      ...FILLER,
      { button_type: "wordfinder", speech: "אני מפחדת מהחושך", label: "אני מפחדת מ...", glyph: [{ sym: "afraid" }] },
    ]));
    const wf = btns.find((b) => b.buttonType === "wordfinder");
    // The AI's `speech` is discarded outright: finishing the child's sentence
    // for her is the one thing this button must not do.
    expect(wf.sentence).toBe("wordfinder");
    expect(wf.sentence).not.toContain("החושך");
  });

  test("a BARE entry still falls back to the canonical magnifier", () => {
    const btns = buttonsOf(rebuild([...FILLER, { button_type: "wordfinder" }]));
    const wf = btns.find((b) => b.buttonType === "wordfinder");
    expect(wf.label).toBe("Find word");
    expect(wf.glyphFallback).toBe("🔍");
  });
});

describe("the seed — where the search starts", () => {
  test("carries a valid suggestion key onto the button", () => {
    const btns = buttonsOf(rebuild([
      ...FILLER,
      {
        button_type: "wordfinder", speech: "", label: "אני מפחדת מ...",
        glyph: [{ sym: "afraid" }], seed: "suggestion:feelings.named:afraid",
      },
    ]));
    const wf = btns.find((b) => b.buttonType === "wordfinder");
    expect(wf.guessingSeed).toBe("suggestion:feelings.named:afraid");
  });

  test("drops a seed that isn't a real key rather than passing it on", () => {
    // A bad seed would open the search somewhere the child never asked to go,
    // which is worse than the generic opening menu.
    for (const seed of ["afraid", "suggestion:not_a_dimension:afraid", "suggestion:feelings.named:not_a_value", ""]) {
      const btns = buttonsOf(rebuild([
        ...FILLER,
        { button_type: "wordfinder", speech: "", label: "מה שאני מחפשת", glyph: [{ sym: "afraid" }], seed },
      ]));
      const wf = btns.find((b) => b.buttonType === "wordfinder");
      expect({ seed, carried: wf.guessingSeed }).toEqual({ seed, carried: undefined });
    }
  });

  test("a top-level category is a valid seed too", () => {
    const btns = buttonsOf(rebuild([
      ...FILLER,
      { button_type: "wordfinder", speech: "", label: "משהו אחר", glyph: [{ sym: "thing" }], seed: "suggestion:category:things" },
    ]));
    const wf = btns.find((b) => b.buttonType === "wordfinder");
    expect(wf.guessingSeed).toBe("suggestion:category:things");
  });
});

describe("purple is the invariant", () => {
  test("a Word Finder button is purple even when the AI asks for another colour", () => {
    expect(resolveButtonColorToken({ buttonType: "wordfinder", color: "green" }))
      .toBe(SPECIAL_BUTTON_COLORS.wordfinder);
  });

  test("…and MORE is NOT given the same treatment", () => {
    // `more` keeps its fixed caption and reload symbol whatever the AI sends,
    // so its colour carries no load that an override could destroy. Only the
    // Word Finder's does, because only its face varies. Pinned the other way
    // by board-more-button.test.ts since before this.
    expect(resolveButtonColorToken({ buttonType: "more", color: "#123456" })).toBe("#123456");
    expect(resolveButtonColorToken({ buttonType: "more" })).toBe(SPECIAL_BUTTON_COLORS.more);
  });

  test("…and a yes/no glyph or a bid role can't repaint it either", () => {
    // Both of those outrank a plain button's default fill; neither outranks
    // "this button opens a search".
    expect(resolveButtonColorToken({ buttonType: "wordfinder", glyph: "yes", role: "bid" }))
      .toBe(SPECIAL_BUTTON_COLORS.wordfinder);
  });

  test("an ordinary button still honours the colour it was given", () => {
    expect(resolveButtonColorToken({ color: "green" })).toBe("green");
  });
});

describe("the content-carrying guard still holds", () => {
  test("a narrowing button stamped 'wordfinder' keeps being a narrowing button", () => {
    // Layer 2 of the 2026-08-19 annihilation fix: a `button_type` on a button
    // that also carries real word-finder content is model noise. Labelling
    // wordfinder entries must not have widened that hole — a `label` is now
    // meaningful, so this is the case that could have regressed.
    const btns = buttonsOf(rebuild([
      { kind: "narrow", dimension: "where_found", value: "at_home", label: "בבית", speech: "בבית", button_type: "wordfinder" },
      { kind: "narrow", dimension: "where_found", value: "in_nature", label: "בטבע", speech: "בטבע", button_type: "wordfinder" },
    ]));
    expect(btns.map((b) => b.buttonType)).toEqual(["narrow", "narrow"]);
    expect(btns.map((b) => b.label)).toEqual(["בבית", "בטבע"]);
  });

  test("a registry suggestion: key stamped 'wordfinder' keeps the key", () => {
    const btns = buttonsOf(rebuild([
      { label: "suggestion:things.kind:animal", button_type: "wordfinder" },
      { label: "suggestion:things.kind:food", button_type: "wordfinder" },
    ]));
    expect(btns.every((b) => b.buttonType !== "wordfinder")).toBe(true);
  });
});

describe("the tool schema tells the model all of this", () => {
  const schemaOf = (config: BoardManagerToolConfig) => {
    const decl = buildBoardManagerTooling(config).flatDecls.find((d) => d.name === "rebuild_board");
    return (decl?.parametersJsonSchema as any)?.properties?.buttons?.items?.properties;
  };

  test("declares `seed`, and only while a Word Finder entry is legal", () => {
    expect(schemaOf(BASE_CONFIG).seed).toBeDefined();
    // Guessing already open ⇒ no wordfinder entry ⇒ nothing to seed.
    expect(schemaOf({ ...BASE_CONFIG, guessingActive: true }).seed).toBeUndefined();
  });

  test("no longer claims the label and glyph are ignored for every meta kind", () => {
    const props = schemaOf(BASE_CONFIG);
    expect(props.label.description).toContain("wordfinder");
    expect(props.glyph.description).toContain("wordfinder");
    // `speech` genuinely IS ignored for both — a meta press voices nothing.
    expect(props.speech.description).toContain("Ignored when");
  });
});
