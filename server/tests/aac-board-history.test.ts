import { describe, it, expect } from "@jest/globals";
import {
  boardKeys,
  isAdditiveRebuild,
  emptyBoardHistory,
  currentBoard,
  canGoBack,
  canGoForward,
  goBack,
  goForward,
  receiveBoard,
  BOARD_HISTORY_LIMIT,
  type BoardHistory,
} from "@shared/aac/board-history";
import type { ParsedBoardData } from "@shared/schema";

/** A board carrying the given sentences. Ids are deliberately randomised to
 *  prove identity does NOT come from `id`. */
let idSeq = 0;
const board = (sentences: string[], name = "b"): ParsedBoardData =>
  ({
    name,
    grid: { rows: 2, cols: 4 },
    pages: [
      {
        id: "p1",
        name: "Page 1",
        buttons: sentences.map((s, i) => ({
          id: `btn-${++idSeq}`,
          row: Math.floor(i / 4),
          col: i % 4,
          label: s,
          sentence: s,
        })),
      },
    ],
  }) as unknown as ParsedBoardData;

const twoPageBoard = (a: string[], b: string[]): ParsedBoardData =>
  ({
    name: "b",
    grid: { rows: 2, cols: 4 },
    pages: [
      { id: "p1", name: "1", buttons: a.map((s, i) => ({ id: `x-${++idSeq}`, row: 0, col: i, label: s, sentence: s })) },
      { id: "p2", name: "2", buttons: b.map((s, i) => ({ id: `y-${++idSeq}`, row: 0, col: i, label: s, sentence: s })) },
    ],
  }) as unknown as ParsedBoardData;

/** The sentences on whatever board is currently displayed. */
const shown = (h: BoardHistory) => [...boardKeys(currentBoard(h))].sort();

describe("boardKeys", () => {
  it("identifies buttons by utterance, not by id", () => {
    // The Board Manager mints fresh ids every rebuild; identity by id would
    // make every board look new and defeat the additive rule entirely.
    expect(boardKeys(board(["yes", "no"]))).toEqual(new Set(["yes", "no"]));
    expect(boardKeys(board(["yes", "no"]))).toEqual(boardKeys(board(["yes", "no"])));
  });

  it("flattens pages — the student sees one surface", () => {
    expect(boardKeys(twoPageBoard(["a"], ["b"]))).toEqual(new Set(["a", "b"]));
  });

  it("survives an empty or missing board", () => {
    expect(boardKeys(null).size).toBe(0);
    expect(boardKeys(board([])).size).toBe(0);
  });
});

describe("isAdditiveRebuild", () => {
  it("is true when buttons are added and none removed", () => {
    expect(isAdditiveRebuild(board(["a", "b"]), board(["a", "b", "c"]))).toBe(true);
  });

  it("is true for an identical rebuild", () => {
    expect(isAdditiveRebuild(board(["a", "b"]), board(["a", "b"]))).toBe(true);
  });

  it("is FALSE the moment anything is removed", () => {
    expect(isAdditiveRebuild(board(["a", "b"]), board(["a", "c"]))).toBe(false);
    expect(isAdditiveRebuild(board(["a", "b"]), board(["a"]))).toBe(false);
  });

  it("ignores which page a button sits on", () => {
    expect(isAdditiveRebuild(board(["a", "b"]), twoPageBoard(["a"], ["b", "c"]))).toBe(true);
  });
});

describe("receiveBoard — running (not paused)", () => {
  it("shows the first board immediately", () => {
    const h = receiveBoard(emptyBoardHistory(), board(["a"]));
    expect(shown(h)).toEqual(["a"]);
    expect(canGoBack(h)).toBe(false);
    expect(canGoForward(h)).toBe(false);
  });

  it("replaces in place when the AI merely adds buttons", () => {
    // The behaviour that makes Back usable: without it, "more options" buries
    // the board the student came from under near-duplicates.
    let h = receiveBoard(emptyBoardHistory(), board(["a"]));
    h = receiveBoard(h, board(["a", "b"]));
    h = receiveBoard(h, board(["a", "b", "c"]));
    expect(shown(h)).toEqual(["a", "b", "c"]);
    expect(h.entries).toHaveLength(1);
    expect(canGoBack(h)).toBe(false);
  });

  it("adds an entry and advances when the topic changes", () => {
    let h = receiveBoard(emptyBoardHistory(), board(["a"]));
    h = receiveBoard(h, board(["x"]));
    expect(shown(h)).toEqual(["x"]);
    expect(canGoBack(h)).toBe(true);
    expect(canGoForward(h)).toBe(false);
  });
});

describe("back / forward", () => {
  const threeBoards = () => {
    let h = receiveBoard(emptyBoardHistory(), board(["one"]));
    h = receiveBoard(h, board(["two"]));
    h = receiveBoard(h, board(["three"]));
    return h;
  };

  it("walks back one board per press, then stops", () => {
    let h = threeBoards();
    h = goBack(h);
    expect(shown(h)).toEqual(["two"]);
    h = goBack(h);
    expect(shown(h)).toEqual(["one"]);
    expect(canGoBack(h)).toBe(false);
    expect(goBack(h)).toBe(h); // no-op at the start, same object
  });

  it("forward becomes available only after going back", () => {
    let h = threeBoards();
    expect(canGoForward(h)).toBe(false);
    h = goBack(h);
    expect(canGoForward(h)).toBe(true);
    h = goForward(h);
    expect(shown(h)).toEqual(["three"]);
    expect(canGoForward(h)).toBe(false);
    expect(goForward(h)).toBe(h); // no-op at the end
  });

  it("a new board while rewound clears everything ahead", () => {
    // Browser semantics: navigating from a rewound position drops the future.
    let h = threeBoards();
    h = goBack(h);          // on "two", "three" is ahead
    h = receiveBoard(h, board(["fresh"]));
    expect(shown(h)).toEqual(["fresh"]);
    expect(canGoForward(h)).toBe(false);
    h = goBack(h);
    expect(shown(h)).toEqual(["two"]); // "three" is gone
  });
});

describe("receiveBoard — PAUSED", () => {
  it("stores the board without displaying it, and offers Forward", () => {
    let h = receiveBoard(emptyBoardHistory(), board(["current"]));
    h = receiveBoard(h, board(["incoming"]), { paused: true });
    expect(shown(h)).toEqual(["current"]); // screen did NOT change
    expect(canGoForward(h)).toBe(true);
    expect(shown(goForward(h))).toEqual(["incoming"]);
  });

  it("holds still even for an ADDITIVE rebuild", () => {
    // Paused means the screen does not change — not "changes less". A board
    // that quietly grew three buttons has still changed under a student who
    // asked it to hold still.
    let h = receiveBoard(emptyBoardHistory(), board(["a"]));
    h = receiveBoard(h, board(["a", "b"]), { paused: true });
    expect(shown(h)).toEqual(["a"]);
    expect(canGoForward(h)).toBe(true);
  });

  it("clears anything already ahead when a newer board arrives", () => {
    let h = receiveBoard(emptyBoardHistory(), board(["current"]));
    h = receiveBoard(h, board(["stale"]), { paused: true });
    h = receiveBoard(h, board(["newest"]), { paused: true });
    expect(shown(h)).toEqual(["current"]);
    // Only ONE board waits ahead — the newest. The stale one is gone.
    const fwd = goForward(h);
    expect(shown(fwd)).toEqual(["newest"]);
    expect(canGoForward(fwd)).toBe(false);
  });

  it("still shows the very first board, so pausing early isn't a blank screen", () => {
    const h = receiveBoard(emptyBoardHistory(), board(["first"]), { paused: true });
    expect(shown(h)).toEqual(["first"]);
  });

  it("resuming does not retroactively display what arrived while paused", () => {
    // Unpausing is not a navigation. The stored board is reached by Forward.
    let h = receiveBoard(emptyBoardHistory(), board(["current"]));
    h = receiveBoard(h, board(["waiting"]), { paused: true });
    expect(shown(h)).toEqual(["current"]);
    h = receiveBoard(h, board(["after-resume"]), { paused: false });
    expect(shown(h)).toEqual(["after-resume"]);
  });
});

describe("the cap", () => {
  it("keeps the total bounded, dropping the OLDEST", () => {
    let h = receiveBoard(emptyBoardHistory(), board(["seed"]));
    for (let i = 0; i < BOARD_HISTORY_LIMIT + 4; i++) {
      h = receiveBoard(h, board([`topic-${i}`]));
    }
    expect(h.entries.length).toBeLessThanOrEqual(BOARD_HISTORY_LIMIT);
    expect(h.entries.some((e) => boardKeys(e).has("seed"))).toBe(false);
    expect(shown(h)).toEqual([`topic-${BOARD_HISTORY_LIMIT + 3}`]);
  });

  it("never drops a board waiting AHEAD of the student", () => {
    // Boards stored while paused are the one thing worth keeping — the student
    // has not seen them yet.
    let h = receiveBoard(emptyBoardHistory(), board(["start"]));
    for (let i = 0; i < BOARD_HISTORY_LIMIT + 4; i++) {
      h = receiveBoard(h, board([`t-${i}`]));
    }
    h = goBack(h);
    const ahead = h.entries.length - 1 - h.index;
    h = receiveBoard(h, board(["pending"]), { paused: true });
    expect(shown(h)).not.toEqual(["pending"]);
    expect(canGoForward(h)).toBe(true);
    expect(shown(goForward(h))).toEqual(["pending"]);
    expect(ahead).toBeGreaterThanOrEqual(0);
  });

  it("does not mutate the history it is given", () => {
    const h = receiveBoard(emptyBoardHistory(), board(["a"]));
    const before = h.entries.length;
    receiveBoard(h, board(["x"]));
    expect(h.entries).toHaveLength(before);
    expect(h.index).toBe(0);
  });
});
