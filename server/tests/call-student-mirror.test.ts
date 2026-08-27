import { describe, it, expect } from "@jest/globals";
/**
 * What the clinician's split view is allowed to believe about the student's
 * screen. Every rule here exists because the mirror had already been wrong
 * about one of them: it streamed the board while the student was in the
 * sentence builder, and it had no way to say which surface it was showing.
 *
 * Pure by construction — `SentenceConstructorBoard` is 3000 lines of eyegaze
 * React and none of it decides what a mirrored cell means.
 */

import {
  formatBuilderTarget,
  parseBuilderTarget,
  serializeBuilderMirror,
  type BuilderTarget,
  type BuilderMirrorCell,
} from "@shared/call/builder-mirror";
import { parseCallDataMessage } from "@shared/call/call-data-messages";
import {
  clampCameraShare,
  defaultCameraShare,
  MAX_CAMERA_SHARE,
  MIN_CAMERA_SHARE,
} from "@shared/call/student-view";
import { BUILDER_GRID_CELLS } from "@shared/aac-builder-paging";

const ALL_TARGETS: BuilderTarget[] = [
  { kind: "word", key: "apple" },
  { kind: "engineWord", key: "bess" },
  { kind: "tab", tab: "who" },
  { kind: "engineTab", tab: "do" },
  { kind: "chip", chip: "people" },
  { kind: "engineChip", chip: "animals" },
  { kind: "page", dir: "back" },
  { kind: "page", dir: "more" },
  { kind: "slot", index: 0 },
  { kind: "slot", index: 3 },
  { kind: "play" },
  { kind: "backspace" },
  { kind: "clear" },
];

const cells = (n: number): BuilderMirrorCell[] =>
  Array.from({ length: n }, (_, i) => ({ key: `w${i}`, label: `W${i}` }));

describe("builder targets", () => {
  it("round-trips every target through a button id", () => {
    for (const target of ALL_TARGETS) {
      expect(parseBuilderTarget(formatBuilderTarget(target))).toEqual(target);
    }
  });

  it("keeps a colon INSIDE a key — a person word is `face:<id>`", () => {
    // Splitting on every colon would truncate exactly the buttons a clinician
    // most wants to press (the people in the student's life).
    const target: BuilderTarget = { kind: "word", key: "face:abc-123" };
    const id = formatBuilderTarget(target);
    expect(parseBuilderTarget(id)).toEqual(target);
  });

  it("does not claim ordinary board buttons", () => {
    for (const id of ["btn-1", "", "speak", "bx", "board:bx:w:apple"]) {
      expect(parseBuilderTarget(id)).toBeNull();
    }
    expect(parseBuilderTarget(undefined)).toBeNull();
    expect(parseBuilderTarget(null)).toBeNull();
  });

  it("fails closed on malformed targets rather than pressing something adjacent", () => {
    for (const id of ["bx:w:", "bx:slot:x", "bx:slot:-1", "bx:page:sideways", "bx:nope:1"]) {
      expect(parseBuilderTarget(id)).toBeNull();
    }
  });
});

describe("serializeBuilderMirror", () => {
  it("lays a short list out in reading order with no paging controls", () => {
    const snap = serializeBuilderMirror({ cells: cells(5) });
    const buttons = snap.board.pages[0].buttons;
    expect(buttons).toHaveLength(5);
    expect(buttons.map((b) => b.id)).toEqual([
      "bx:w:w0", "bx:w:w1", "bx:w:w2", "bx:w:w3", "bx:w:w4",
    ]);
    expect(buttons.map((b) => [b.row, b.col])).toEqual([
      [0, 0], [0, 1], [0, 2], [0, 3], [0, 4],
    ]);
  });

  it("never exceeds the student's own fixed grid", () => {
    // The builder's grid is a fixed template; a 19th button would reflow the
    // student's screen, and a mirror that reflowed differently would be showing
    // a board nobody is looking at.
    const snap = serializeBuilderMirror({ cells: cells(40) });
    expect(snap.board.pages[0].buttons).toHaveLength(BUILDER_GRID_CELLS);
    expect(snap.board.grid).toEqual({ rows: 2, cols: 9 });
  });

  it("BRACKETS the words with the paging controls when the list overflows", () => {
    const snap = serializeBuilderMirror({ cells: cells(40), paging: true });
    const buttons = snap.board.pages[0].buttons;
    expect(buttons).toHaveLength(BUILDER_GRID_CELLS);
    // Fixed positions, the two ENDS of the list (user, 2026-08-27): Back in the
    // FIRST cell, More in the last. The student's controls do not move as the
    // word list changes, so a clinician's do not either — and they must sit
    // where the student's sit or the mirror is showing a board nobody has.
    const back = buttons[0]!;
    const more = buttons[buttons.length - 1]!;
    expect(parseBuilderTarget(back.id)).toEqual({ kind: "page", dir: "back" });
    expect(parseBuilderTarget(more.id)).toEqual({ kind: "page", dir: "more" });
    expect([back.row, back.col]).toEqual([0, 0]);
    expect([more.row, more.col]).toEqual([1, 8]);
    // The words fill everything between, in reading order and with no gap.
    const words = buttons.filter((b) => b.id.startsWith("bx:w:"));
    expect(words).toHaveLength(BUILDER_GRID_CELLS - 2);
    expect([words[0]!.row, words[0]!.col]).toEqual([0, 1]);
    expect([words[words.length - 1]!.row, words[words.length - 1]!.col]).toEqual([1, 7]);
  });

  it("draws the button's RESULT, so an alias shows what it inserts", () => {
    // `tomorrow` composes `day.next`; the student's own cell previews the
    // composed glyph, so the mirror must too.
    const snap = serializeBuilderMirror({
      cells: [{ key: "tomorrow", label: "Tomorrow", glyph: "day.next" }],
    });
    expect(snap.board.pages[0].buttons[0].glyph).toBe("day.next");
  });

  it("falls back to the key when a cell carries no glyph", () => {
    const snap = serializeBuilderMirror({ cells: [{ key: "apple", label: "Apple" }] });
    expect(snap.board.pages[0].buttons[0].glyph).toBe("apple");
  });

  it("routes engine-surfaced words to the engine press handler", () => {
    const snap = serializeBuilderMirror({ cells: [{ key: "bess", label: "Bess" }], engine: true });
    expect(parseBuilderTarget(snap.board.pages[0].buttons[0].id)).toEqual({
      kind: "engineWord",
      key: "bess",
    });
  });

  it("marks the active tab and chip — the student's current context", () => {
    const snap = serializeBuilderMirror({
      cells: [],
      tabs: [
        { id: "who", label: "Who", active: true },
        { id: "do", label: "Do" },
      ],
      chips: [
        { id: "people", label: "People" },
        { id: "photos", label: "Photos", active: true },
      ],
    });
    expect(snap.contextButtons[0].color).toBeTruthy();
    expect(snap.contextButtons[1].color).toBeUndefined();
    expect(snap.chips.map((c) => c.active)).toEqual([undefined, true]);
    expect(snap.contextButtons.map((b) => b.id)).toEqual(["bx:tab:who", "bx:tab:do"]);
  });

  it("shows the composed sentence, and only live controls beside it", () => {
    const empty = serializeBuilderMirror({ cells: [], slots: [] });
    // Nothing to say yet: mirroring a dead Play invites a press and reads as a
    // broken link when nothing happens.
    expect(empty.strip).toEqual([]);

    const built = serializeBuilderMirror({ cells: [], slots: ["i_me", "want", "water"] });
    expect(built.strip.filter((s) => s.kind === "slot").map((s) => s.glyph)).toEqual([
      "i_me", "want", "water",
    ]);
    const controls = built.strip.filter((s) => s.kind === "control").map((s) => s.id);
    expect(controls).toEqual(["bx:bksp", "bx:play"]);
  });

  it("offers clear instead of backspace once a slot is selected", () => {
    // The student's own builder shows one or the other in the same spot; the
    // two never coexist there and must not here.
    const snap = serializeBuilderMirror({ cells: [], slots: ["i_me", "want"], activeSlot: 0 });
    const controls = snap.strip.filter((s) => s.kind === "control").map((s) => s.id);
    expect(controls).toEqual(["bx:clear", "bx:play"]);
    expect(snap.strip[0].active).toBe(true);
    expect(snap.strip[1].active).toBe(false);
  });
});

describe("parseCallDataMessage", () => {
  const mirror = (extra: Record<string, unknown>) =>
    parseCallDataMessage({ k: "board-mirror", board: { pages: [] }, at: 1, ...extra });

  it("carries the new surface fields through", () => {
    const m = mirror({
      surface: "builder",
      title: "Sentence builder",
      strip: [{ id: "bx:slot:0", kind: "slot", glyph: "i_me" }],
      chips: [{ id: "bx:chip:people", label: "People" }],
      hud: [{ id: "pocket", items: [{ id: "egg", label: "Egg", count: 3 }] }],
    });
    expect(m).toMatchObject({
      k: "board-mirror",
      surface: "builder",
      title: "Sentence builder",
    });
    expect((m as any).strip).toHaveLength(1);
    expect((m as any).chips).toHaveLength(1);
    expect((m as any).hud).toHaveLength(1);
  });

  it("drops a surface it does not know instead of trusting the wire", () => {
    expect((mirror({ surface: "spaceship" }) as any).surface).toBeUndefined();
    expect((mirror({ strip: "not-an-array" }) as any).strip).toBeUndefined();
  });

  it("still accepts a mirror from an AAC build that predates all of this", () => {
    const m = mirror({});
    expect(m).toMatchObject({ k: "board-mirror", mode: "board" });
    expect((m as any).surface).toBeUndefined();
  });

  it("accepts a well-formed facilitator-builder press", () => {
    const m = parseCallDataMessage({
      k: "facilitator-builder",
      target: { kind: "word", key: "water" },
      at: 7,
    });
    expect(m).toEqual({ k: "facilitator-builder", target: { kind: "word", key: "water" }, at: 7 });
  });

  it("rejects a facilitator-builder whose target is junk", () => {
    for (const target of [undefined, null, "water", { kind: "detonate" }, { kind: "slot", index: -1 }]) {
      expect(parseCallDataMessage({ k: "facilitator-builder", target, at: 1 })).toBeNull();
    }
  });
});

describe("split ratios", () => {
  it("splits a board evenly and shrinks the camera in a game", () => {
    expect(defaultCameraShare("board")).toBe(0.5);
    expect(defaultCameraShare("builder")).toBe(0.5);
    expect(defaultCameraShare("game")).toBeLessThan(defaultCameraShare("board"));
    expect(defaultCameraShare("screen")).toBeLessThan(defaultCameraShare("board"));
  });

  it("treats an unknown surface as a plain board", () => {
    expect(defaultCameraShare(undefined)).toBe(0.5);
  });

  it("never lets a drag close either pane", () => {
    expect(clampCameraShare(0)).toBe(MIN_CAMERA_SHARE);
    expect(clampCameraShare(1)).toBe(MAX_CAMERA_SHARE);
    expect(clampCameraShare(NaN)).toBe(0.5);
    expect(clampCameraShare(0.4)).toBe(0.4);
  });
});
