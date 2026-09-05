import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  { kind: "guess", buttonId: "wf-3" },
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
        // The person tab's engine chips (2026-09-04): the child's own contacts
        // lead it, and [contacts] is an ENGINE group id now — the host no
        // longer pins a "photos" chip of its own.
        { id: "creatures", label: "People" },
        { id: "individuals", label: "Contacts", active: true },
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

describe("Word Finder", () => {
  const wf = [
    { id: "s1", row: 3, col: 2, label: "Food", buttonType: "suggestion", suggestionKey: "cat:food" },
    { id: "n1", row: 0, col: 0, label: "Hot", buttonType: "narrow", narrowDimension: "temp", narrowValue: "hot" },
    { id: "g1", row: 9, col: 9, label: "Juice", colSpan: 3 },
  ] as any[];

  it("shows the SAME board the student is looking at", () => {
    // The word finder's buttons are authored by the server and sent to the
    // child; the clinician gets those, not a second rendering of them. Before
    // this the mirror sent an empty grid and a badge.
    const snap = serializeBuilderMirror({ cells: [], guessButtons: wf });
    expect(snap.board.pages[0].buttons.map((b) => b.label)).toEqual(["Food", "Hot", "Juice"]);
  });

  it("re-flows four across, the way the student's own grid does", () => {
    // The student's grid is `repeat(4, …)` + gridAutoRows: it FLOWS, so the
    // buttons' authored row/col (and spans) are ignored there and must be here.
    const snap = serializeBuilderMirror({ cells: [], guessButtons: wf });
    const buttons = snap.board.pages[0].buttons;
    expect(buttons.map((b) => [b.row, b.col])).toEqual([[0, 0], [0, 1], [0, 2]]);
    expect(buttons.every((b) => b.colSpan === 1 && b.rowSpan === 1)).toBe(true);
    expect(snap.board.grid.cols).toBe(4);
  });

  it("routes a press back as a guess target carrying the button's own id", () => {
    // A word-finder button means one of three different things
    // (suggestion / narrow / free guess) and only the builder's dispatch can
    // tell them apart — so the id travels and the builder decides.
    const snap = serializeBuilderMirror({ cells: [], guessButtons: wf });
    expect(snap.board.pages[0].buttons.map((b) => parseBuilderTarget(b.id))).toEqual([
      { kind: "guess", buttonId: "s1" },
      { kind: "guess", buttonId: "n1" },
      { kind: "guess", buttonId: "g1" },
    ]);
  });

  it("keeps the chrome around it — the sentence so far is still the point", () => {
    const snap = serializeBuilderMirror({
      cells: [],
      guessButtons: wf,
      slots: ["i_me", "want"],
      tabs: [{ id: "who", label: "Who", active: true }],
    });
    expect(snap.strip.filter((x) => x.kind === "slot")).toHaveLength(2);
    expect(snap.contextButtons).toHaveLength(1);
  });
});

describe("mirrored colours", () => {
  it("never paints a fill dark enough to swallow the label", () => {
    // Every mirrored button is DARK text on the fill, exactly as
    // BoardButtonVisual paints the real board. A saturated tint here is
    // invisible text — which is how the first version rendered a whole board.
    const snap = serializeBuilderMirror({
      cells: [{ key: "bess", label: "Bess", present: true }],
      tabs: [{ id: "who", label: "Who", active: true }],
    });
    const fills = [
      snap.board.pages[0].buttons[0].color,
      snap.contextButtons[0].color,
    ];
    for (const hex of fills) {
      expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
      const n = parseInt(hex!.slice(1), 16);
      // ITU-R BT.709 luminance, the same proxy the builder's own swatches use.
      const lum = 0.2126 * ((n >> 16) & 0xff) + 0.7152 * ((n >> 8) & 0xff) + 0.0722 * (n & 0xff);
      expect(lum).toBeGreaterThan(160);
    }
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

  it("carries a refusal back to the clinician", () => {
    // `allowFacilitatorControl` is off by default, so the FIRST thing a
    // clinician who arms Interact sees is a dropped press. A refusal has to be
    // able to travel or the feature reads as a broken call.
    expect(parseCallDataMessage({ k: "facilitator-ack", ok: false, reason: "consent", at: 2 }))
      .toEqual({ k: "facilitator-ack", ok: false, reason: "consent", at: 2 });
    expect(parseCallDataMessage({ k: "facilitator-ack", ok: true, at: 2 }))
      .toEqual({ k: "facilitator-ack", ok: true, reason: undefined, at: 2 });
    // An unknown reason must not reach a `t()` lookup as a raw key.
    expect((parseCallDataMessage({ k: "facilitator-ack", ok: false, reason: "banana", at: 2 }) as any).reason)
      .toBeUndefined();
  });

  it("carries a POINT, and its release", () => {
    expect(parseCallDataMessage({ k: "board-indicate", buttonId: "btn-9", speak: true, at: 3 }))
      .toEqual({ k: "board-indicate", buttonId: "btn-9", speak: true, at: 3 });
    // Release: an explicit null, not an absent field.
    expect(parseCallDataMessage({ k: "board-indicate", buttonId: null, at: 3 }))
      .toEqual({ k: "board-indicate", buttonId: null, speak: false, at: 3 });
  });
});

/**
 * POINTING ONLY WORKS IF BOTH SIDES AGREE ON THE ID.
 *
 * A clinician's press-and-hold sends a `bx:` target; the AAC resolves it with
 * `document.querySelector('[data-mirror-id=…]')`. That lookup fails SILENTLY —
 * the button just never lights — so a pointable surface added to the mirror
 * without a matching tag on the builder is invisible until someone tries it on
 * a live call with a child.
 *
 * Asserted on the SOURCE because the repo's unit config is `testEnvironment:
 * 'node'` and declines jsdom (see call-audio-ownership.test.ts, same trade).
 */
describe("builder pointing targets are tagged on both sides", () => {
  const builder = readFileSync(
    resolve(process.cwd(), "client-aac/src/components/SentenceConstructorBoard.tsx"),
    "utf8",
  );

  // Every kind the mirror can draw as a pointable element. `slot` is absent on
  // purpose: sentence slots are drawn inside GlyphCompositor's SVG, so there is
  // no per-slot element to tag — and pointing at a word the child already
  // placed is not a "look here" anyway.
  const POINTABLE: Array<BuilderTarget["kind"]> = [
    "word", "engineWord", "guess", "tab", "engineTab", "chip", "engineChip",
    "page", "play", "backspace", "clear",
  ];

  it.each(POINTABLE)("the builder tags its %s elements with data-mirror-id", (kind) => {
    // Either inline on the element, or handed down as a `mirrorId` prop.
    expect(builder).toContain(`formatBuilderTarget({ kind: "${kind}"`);
  });

  it("routes those ids through data-mirror-id, the attribute the AAC looks up", () => {
    expect(builder).toContain("data-mirror-id");
    // The Word Finder's buttons come from a shared renderer, so their tag rides
    // the same passthrough AppMiniBoard uses.
    expect(builder).toContain('extraButtonProps={{ "data-mirror-id"');
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
