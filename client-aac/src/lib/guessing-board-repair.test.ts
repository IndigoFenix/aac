// Unit tests for the Word Finder board repair.
//
// The shape under test is the 2026-08-27 stall: the narrowing engine offered
// `suggestion:actions.who:{alone,with_others,together}` and BoardManager
// returned their HEBREW labels as plain buttons, so the press routed as an
// ordinary utterance and never reached the engine.

import {
  repairGuessingButtons,
  repairGuessingBoard,
  localizeSuggestionButtons,
} from "./guessing-board-repair";

const WHO_KEYS = [
  "suggestion:actions.who:alone",
  "suggestion:actions.who:with_others",
  "suggestion:actions.who:together",
];

/** Stand-in for the AAC's t(): Hebrew for the `who` cluster, key-passthrough
 *  otherwise — exactly what the real t() does for a missing key. */
const heT = (key: string): string =>
  ({
    "guessing.who.alone": "לבד",
    "guessing.who.with_others": "עם אחרים",
    "guessing.who.together": "ביחד",
  } as Record<string, string>)[key] ?? key;

const enT = (key: string): string => key; // every lookup misses → English fallback

describe("repairGuessingButtons", () => {
  it("re-tags a hand-authored localized label as its offered suggestion key", () => {
    const out = repairGuessingButtons(
      [{ label: "לבד", glyph: "person.one" }],
      WHO_KEYS,
      heT,
    );
    expect(out).toHaveLength(1);
    expect(out[0].buttonType).toBe("suggestion");
    expect(out[0].suggestionKey).toBe("suggestion:actions.who:alone");
    // The model's own artwork survives — the child may already be aiming at it.
    expect(out[0].glyph).toBe("person.one");
  });

  it("matches the English label and the raw value too", () => {
    expect(
      repairGuessingButtons([{ label: "By myself" }], WHO_KEYS, enT)[0].suggestionKey,
    ).toBe("suggestion:actions.who:alone");
    expect(
      repairGuessingButtons([{ label: "with_others" }], WHO_KEYS, enT)[0].suggestionKey,
    ).toBe("suggestion:actions.who:with_others");
  });

  it("ignores case, padding and trailing punctuation", () => {
    expect(
      repairGuessingButtons([{ label: "  By  Myself? " }], WHO_KEYS, enT)[0].suggestionKey,
    ).toBe("suggestion:actions.who:alone");
  });

  it("leaves a genuine AI guess alone", () => {
    const out = repairGuessingButtons([{ label: "לרוץ" }], WHO_KEYS, heT);
    expect(out[0].buttonType).toBeUndefined();
    expect(out[0].suggestionKey).toBeUndefined();
  });

  it("never matches a raw i18n key when the translation is missing", () => {
    // t() returns the key itself on a miss; indexing that would make a button
    // literally labelled "guessing.who.alone" resolve.
    const out = repairGuessingButtons([{ label: "guessing.who.alone" }], WHO_KEYS, enT);
    expect(out[0].suggestionKey).toBeUndefined();
  });

  it("only considers the CURRENT question's keys", () => {
    // "Fast" belongs to actions.pace, which is no longer being asked.
    const out = repairGuessingButtons([{ label: "Fast" }], WHO_KEYS, enT);
    expect(out[0].suggestionKey).toBeUndefined();
  });

  it("collapses the duplicate the server backstop leaves behind", () => {
    // The backstop injects the real key; BoardManager's hand-authored copy of
    // the same word is still on the board. One word, one button.
    const out = repairGuessingButtons(
      [
        { label: "לבד", glyph: "person.one" },
        { label: "ביחד" },
        { label: "לבד", buttonType: "suggestion", suggestionKey: "suggestion:actions.who:alone", glyph: "🧍" },
      ],
      WHO_KEYS,
      heT,
    );
    expect(out).toHaveLength(2);
    const alone = out.filter((b) => b.suggestionKey === "suggestion:actions.who:alone");
    expect(alone).toHaveLength(1);
    // The canonical server-expanded button wins regardless of board order —
    // it carries the registry icon and the suggestion colour.
    expect(alone[0].glyph).toBe("🧍");
  });

  it("is a no-op with no offered keys (not narrowing, or ready for guesses)", () => {
    const buttons = [{ label: "לבד" }];
    expect(repairGuessingButtons(buttons, [], heT)).toBe(buttons);
  });
});

describe("repairGuessingBoard", () => {
  const board = {
    grid: { rows: 2, cols: 4 },
    currentPageId: "p1",
    pages: [{ id: "p1", name: "Main", buttons: [{ label: "לבד" }, { label: "לרוץ" }] }],
  };

  it("repairs every page and leaves the board IR otherwise intact", () => {
    const out = repairGuessingBoard(board, WHO_KEYS, heT);
    expect(out.grid).toEqual({ rows: 2, cols: 4 });
    expect(out.currentPageId).toBe("p1");
    expect(out.pages[0].buttons[0].suggestionKey).toBe("suggestion:actions.who:alone");
    expect(out.pages[0].buttons[1].suggestionKey).toBeUndefined();
  });

  it("returns the same object when nothing needed repair", () => {
    expect(repairGuessingBoard(board, [], heT)).toBe(board);
    expect(repairGuessingBoard(null, WHO_KEYS, heT)).toBe(null);
  });
});

describe("localizeSuggestionButtons", () => {
  // The server expands registry buttons with the English `labelEn`. AppMiniBoard
  // (the strip beside an open app) renders `label` straight through and
  // localizes nothing, so English leaked onto a Hebrew board — and was SPOKEN,
  // since its click handler says `spokenText || label`.
  it("swaps the server's English label for the translation, and moves spokenText with it", () => {
    const out = localizeSuggestionButtons(
      [{ label: "By myself", spokenText: "By myself", buttonType: "suggestion", suggestionKey: "suggestion:actions.who:alone" }],
      heT,
    );
    expect(out[0].label).toBe("לבד");
    expect(out[0].spokenText).toBe("לבד");
  });

  it("keeps the English label when the locale has no translation", () => {
    const buttons = [{ label: "By myself", buttonType: "suggestion", suggestionKey: "suggestion:actions.who:alone" }];
    const out = localizeSuggestionButtons(buttons, enT);
    expect(out[0].label).toBe("By myself");
    expect(out).toBe(buttons); // untouched — same reference
  });

  it("leaves non-suggestion buttons alone", () => {
    const buttons = [{ label: "By myself" }];
    expect(localizeSuggestionButtons(buttons, heT)).toBe(buttons);
  });

  it("runs even when no narrowing question is live", () => {
    // offeredKeys is empty between questions / once ready for guesses, but a
    // suggestion button already on the board still needs its translation.
    const out = repairGuessingButtons(
      [{ label: "By myself", buttonType: "suggestion", suggestionKey: "suggestion:actions.who:alone" }],
      [],
      heT,
    );
    expect(out[0].label).toBe("לבד");
  });

  it("localizes the survivor after a de-dup", () => {
    const out = repairGuessingButtons(
      [
        { label: "לבד" },
        { label: "By myself", buttonType: "suggestion", suggestionKey: "suggestion:actions.who:alone" },
      ],
      WHO_KEYS,
      heT,
    );
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("לבד");
  });
});
