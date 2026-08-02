// THE TWO BUTTONS EVERY LIST NEEDS (board-chrome.ts): paging and a way back,
// solved once for every board instead of per board. These pin the rule the
// user set — a MORE button only when the list genuinely doesn't fit, and
// exactly eight items fit. Pure — no DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  BOARD_BACK_ID,
  BOARD_MORE_ID,
  BOARD_PAGE,
  boardChrome,
  boardContentKey,
} from "@shared/world-engine/interaction/quest/board-chrome.js";

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `o${i}`, label: `o${i}` }));
const ids = (o: ReturnType<typeof boardChrome>) => o.options.map((x) => x.id);

describe("paging", () => {
  it("shows a short list whole, with NO more button", () => {
    const out = boardChrome({ options: items(3) });
    expect(ids(out)).toEqual(["o0", "o1", "o2"]);
    expect(out.pages).toBe(1);
  });

  it("EXACTLY eight fits — a more button that leads nowhere is a lie", () => {
    const out = boardChrome({ options: items(BOARD_PAGE) });
    expect(out.pages).toBe(1);
    expect(ids(out)).not.toContain(BOARD_MORE_ID);
    expect(out.options).toHaveLength(BOARD_PAGE);
  });

  it("a ninth item earns the more button, and it pages", () => {
    const nine = items(9);
    const p0 = boardChrome({ options: nine, page: 0 });
    expect(p0.pages).toBe(2);
    expect(ids(p0)).toEqual([...items(BOARD_PAGE).map((o) => o.id), BOARD_MORE_ID]);
    const p1 = boardChrome({ options: nine, page: 1 });
    expect(ids(p1)).toEqual(["o8", BOARD_MORE_ID]);
  });

  it("wraps past the end rather than dead-ending", () => {
    const nine = items(9);
    expect(boardChrome({ options: nine, page: 2 }).page).toBe(0);
    expect(boardChrome({ options: nine, page: -1 }).page).toBe(1);
  });
});

describe("going back", () => {
  it("appends BACK only when there is somewhere to go", () => {
    expect(ids(boardChrome({ options: items(2) }))).not.toContain(BOARD_BACK_ID);
    expect(ids(boardChrome({ options: items(2), back: true }))).toEqual([
      "o0", "o1", BOARD_BACK_ID,
    ]);
  });

  it("puts the chrome AFTER the content, so options never move as a list grows", () => {
    const out = boardChrome({ options: items(9), page: 0, back: true });
    expect(out.options[0]!.id).toBe("o0");
    expect(ids(out).slice(-2)).toEqual([BOARD_MORE_ID, BOARD_BACK_ID]);
  });

  it("speaks the caller's translations, falling back to plain words", () => {
    const out = boardChrome({ options: items(9), back: true, moreText: "Más", backText: "Volver" });
    const more = out.options.find((o) => o.id === BOARD_MORE_ID)!;
    const back = out.options.find((o) => o.id === BOARD_BACK_ID)!;
    expect([more.label, more.spokenText]).toEqual(["Más", "Más"]);
    expect([back.label, back.spokenText]).toEqual(["Volver", "Volver"]);
    expect(boardChrome({ options: items(2), back: true }).options[2]!.label).toBe("back");
  });
});

describe("boardContentKey", () => {
  it("changes when the LIST changes, so a page never outlives its content", () => {
    expect(boardContentKey(items(3))).toBe(boardContentKey(items(3)));
    expect(boardContentKey(items(3))).not.toBe(boardContentKey(items(4)));
  });
});
