/**
 * The projection and action layer (harness design ④).
 *
 * These are the tests that keep the harness honest. They assert the three laws
 * directly, because each is a thing a careless change would silently break:
 *   ① nothing perceivable-only-to-the-server reaches the child
 *   ② labels arrive byte-for-byte
 *   ③ every pressable surface is reachable, and a press becomes a REAL message
 */

import { describe, it, expect } from "@jest/globals";
import type { ParsedBoardData } from "@shared/schema";
import { SimClientModel } from "../services/aac-sim/client-model.js";
import {
  FLUENT_READER,
  pictureOf,
  projectView,
  readLabel,
  renderView,
  type PerceptionProfile,
} from "../services/aac-sim/project.js";
import { pressBoardButton, pressQuickAction } from "../services/aac-sim/act.js";

const board = (buttons: Record<string, unknown>[]): ParsedBoardData =>
  ({
    name: "Talk",
    grid: { rows: 1, cols: 4 },
    pages: [{ id: "p1", name: "Main", buttons }],
  }) as ParsedBoardData;

/** A model with one board already delivered. */
function withBoard(buttons: Record<string, unknown>[]): SimClientModel {
  const m = new SimClientModel();
  m.apply({ type: "board", data: board(buttons) });
  return m;
}

const boardCells = (m: SimClientModel, profile?: PerceptionProfile) =>
  projectView(m, { profile }).cells.filter((c) => c.where === "board");

describe("law ① — only what is perceivable from the glass", () => {
  it("never leaks spokenText, ids, buttonType or glyph keys", () => {
    const m = withBoard([
      {
        id: "btn-secret-id",
        label: "juice",
        spokenText: "I would like some apple juice please",
        buttonType: "suggestion",
        glyph: "juice.cold",
        iconRef: "🧃",
      },
    ]);
    const serialized = JSON.stringify(projectView(m));

    expect(serialized).not.toContain("btn-secret-id");
    expect(serialized).not.toContain("I would like some apple juice");
    expect(serialized).not.toContain("suggestion");
    expect(serialized).not.toContain("juice.cold");
    // What SHOULD be there:
    expect(serialized).toContain("juice");
    expect(serialized).toContain("🧃");
  });

  it("keeps colour out entirely for a child who does not use it", () => {
    const m = withBoard([{ label: "stop", color: "#ff0000", iconRef: "🛑" }]);
    const [cell] = boardCells(m, { reading: "fluent", colourSalience: false });
    expect(cell.colour).toBeUndefined();
    const [withColour] = boardCells(m, FLUENT_READER);
    expect(withColour.colour).toBe("#ff0000");
  });
});

describe("law ② — the face is copied, never composed", () => {
  it("passes an untranslated raw key straight through", () => {
    // The exact failure this guards: a Hebrew board rendering `aac.glyph.apple`
    // because nobody translated the key. The child must see the breakage.
    const m = withBoard([{ label: "aac.glyph.apple", iconRef: "🍎" }]);
    expect(boardCells(m)[0].label).toBe("aac.glyph.apple");
  });

  it("does not tidy case, spacing or punctuation", () => {
    const m = withBoard([{ label: "  i WANT   more!!  ", iconRef: "➕" }]);
    expect(boardCells(m)[0].label).toBe("  i WANT   more!!  ");
  });
});

describe("law ③ — every surface is pressable", () => {
  it("numbers board, context and quick-row cells in one sequence", () => {
    const m = withBoard([{ label: "hi", iconRef: "👋" }]);
    m.apply({ type: "context_button_add", data: { label: "the dog", iconRef: "🐕" } });

    const view = projectView(m);
    const numbers = view.cells.map((c) => c.n);
    expect(numbers).toEqual([...Array(numbers.length)].map((_, i) => i + 1));

    const surfaces = new Set(view.cells.map((c) => c.where));
    expect(surfaces).toContain("board");
    expect(surfaces).toContain("context");
    expect(surfaces).toContain("quick");
  });

  it("numbers EMPTY cells too — a gaze user aims at positions", () => {
    const m = withBoard([{ label: "hi", iconRef: "👋" }]);
    // 1x4 grid, one button ⇒ three blanks, all numbered and reported.
    expect(boardCells(m)).toHaveLength(4);
    expect(projectView(m).emptyCount).toBe(3);
  });

  it("replaces the board with an overlay, because the board is not pressable then", () => {
    const m = withBoard([{ label: "hi", iconRef: "👋" }]);
    m.apply({
      type: "binary_choice",
      data: { options: [{ label: "yes" }, { label: "no" }], escapeKind: "maybe" },
    });
    const view = projectView(m);
    expect(view.surface).toBe("overlay");
    expect(view.cells.some((c) => c.where === "board")).toBe(false);
    // The escape is a real option, not a hidden one.
    expect(view.cells.filter((c) => c.where === "overlay")).toHaveLength(3);
  });
});

describe("the reading dial", () => {
  const label = "elephant sandwich";

  it("fluent sees it whole; none sees no label at all", () => {
    expect(readLabel(label, { reading: "fluent" })).toBe(label);
    expect(readLabel(label, { reading: "none" })).toBeNull();
  });

  it("emerging redacts per WORD, not the whole label", () => {
    // "I want the elephant" is mostly readable to a child who stalls on one word.
    const out = readLabel("I want elephant", { reading: "emerging", longWordChars: 6 });
    expect(out).toBe("I want ▮▮▮▮▮▮▮▮");
  });

  it("logographic reads only words already met", () => {
    const seen = new Set(["hello"]);
    expect(readLabel("hello", { reading: "logographic" }, seen)).toBe("hello");
    expect(readLabel("aeroplane", { reading: "logographic" }, seen)).toBeNull();
  });

  it("leaves the quick row readable — it is learned chrome, not reading", () => {
    const m = withBoard([{ label: "hi", iconRef: "👋" }]);
    const quick = projectView(m, { profile: { reading: "none" } }).cells.filter((c) => c.where === "quick");
    expect(quick.length).toBeGreaterThan(0);
    expect(quick.every((c) => c.label !== null)).toBe(true);
  });

  it("still shows the PICTURE to a non-reader — that is the whole point", () => {
    const m = withBoard([{ label: "juice", iconRef: "🧃" }]);
    const [cell] = boardCells(m, { reading: "none" });
    expect(cell.label).toBeNull();
    expect(cell.picture).toBe("🧃");
  });
});

describe("pictureOf — never derived from the label", () => {
  it("prefers an explicit emoji", () => {
    expect(pictureOf({ label: "dog", iconRef: "🐕" })).toBe("🐕");
  });

  it("resolves a single glyph key to its emoji, but never a composed one", () => {
    expect(pictureOf({ label: "x", glyph: "apple" })).toBeTruthy();
    expect(pictureOf({ label: "x", glyph: "apple.red+want" })).toBeNull();
  });

  it("falls back to the image KEY, leaking the word — accepted, per §3.2", () => {
    expect(pictureOf({ label: "washing", imageKey: "washing_hands_zzz" })).toBe("washing_hands_zzz");
  });

  it("reports an undescribed picture rather than inventing one", () => {
    expect(pictureOf({ label: "thing", symbolPath: "/api/symbols/abc.svg" })).toBe("PICTURE (undescribed)");
  });

  it("returns null when the button genuinely has no art", () => {
    expect(pictureOf({ label: "bare" })).toBeNull();
  });

  it("ignores a FontAwesome class — that is not a picture a child reads", () => {
    expect(pictureOf({ label: "x", iconRef: "fa-solid fa-star" })).toBeNull();
  });
});

describe("acting — a press becomes a real ClientMessage", () => {
  it("sends an utterance as button_press carrying the client's own board", () => {
    const m = withBoard([{ label: "juice", spokenText: "I want juice", iconRef: "🧃" }]);
    const r = pressBoardButton(m, { label: "juice", spokenText: "I want juice" } as never);

    expect(r.local).toBe(false);
    expect(r.message).toMatchObject({
      type: "button_press",
      buttons: ["juice"],
      sentences: { juice: "I want juice" },
    });
    // Law: the server reads the board back off the press.
    expect((r.message as { board?: unknown }).board).toBeTruthy();
  });

  it("omits `sentences` when the label already says it", () => {
    const m = withBoard([{ label: "yes" }]);
    const r = pressBoardButton(m, { label: "yes" } as never);
    expect((r.message as { sentences?: unknown }).sentences).toBeUndefined();
  });

  it("treats a page link as LOCAL — no message, but still a press", () => {
    const m = withBoard([{ label: "food", action: { type: "link", toPageId: "p1" } }]);
    const r = pressBoardButton(m, { label: "food", action: { type: "link", toPageId: "p1" } } as never);
    expect(r.message).toBeNull();
    expect(r.local).toBe(true);
  });

  it("sends [MORE] as a request, not as something the child said", () => {
    const m = withBoard([{ label: "hi" }]);
    const r = pressQuickAction(m, "more", "More");
    expect(r.message).toMatchObject({ type: "button_press", buttons: ["[MORE]"] });
  });

  it("toggles the word finder on the same button", () => {
    const m = withBoard([{ label: "hi" }]);
    expect(pressQuickAction(m, "guess", "Guess").message).toMatchObject({ type: "guessing_enter" });
    m.apply({ type: "guessing_mode", active: true });
    expect(pressQuickAction(m, "guess", "Guess").message).toMatchObject({ type: "exit_guessing" });
  });

  it("refuses to dismiss an app when none is open, rather than sending a bad message", () => {
    // `app_dismissed` requires an appId; inventing one would be a message the
    // real client never sends.
    const m = withBoard([{ label: "hi" }]);
    expect(pressQuickAction(m, "exit", "Exit").message).toBeNull();
    m.apply({ type: "app_open", data: { appId: "youtube" } });
    expect(pressQuickAction(m, "exit", "Exit").message).toMatchObject({
      type: "app_dismissed",
      appId: "youtube",
    });
  });

  it("records a dimmed Back press as a press that did nothing", () => {
    const m = withBoard([{ label: "hi" }]);
    const r = pressQuickAction(m, "boardback", "Back");
    expect(r.message).toBeNull();
    expect(r.note).toMatch(/dimmed/);
  });
});

describe("the device accumulates deltas like the real client", () => {
  it("adds patched buttons into empty cells", () => {
    const m = withBoard([{ label: "hi", iconRef: "👋" }]);
    m.apply({ type: "board_patch", data: { add: [{ label: "bye", iconRef: "👋" }], remove: [] } });
    const labels = boardCells(m).map((c) => c.label);
    expect(labels).toContain("bye");
  });

  it("holds the surface still while PAUSED — that is what pause means", () => {
    const m = withBoard([{ label: "first", iconRef: "1️⃣" }]);
    m.setPaused(true);
    m.apply({ type: "board", data: board([{ label: "second", iconRef: "2️⃣" }]) });
    expect(boardCells(m).map((c) => c.label)).toContain("first");
    expect(boardCells(m).map((c) => c.label)).not.toContain("second");
    // …and the stored board is reachable by going forward.
    expect(m.status().canGoForward).toBe(true);
  });

  it("logs what the child heard, with the AI and their own voice distinguished", () => {
    const m = withBoard([{ label: "hi" }]);
    m.apply({ type: "speak", text: "What shall we do?" });
    m.apply({ type: "utterance", text: "I want juice" });
    expect(m.heard.map((h) => h.source)).toEqual(["ai", "self"]);
  });
});

describe("rendering", () => {
  it("prints one fact per tagged line", () => {
    const m = withBoard([{ label: "juice", iconRef: "🧃" }]);
    m.apply({ type: "speak", text: "Hello!" });
    const lines = renderView(projectView(m));

    expect(lines[0]).toMatch(/^SURF\s+board · board "Talk" · page "Main" · grid 1x4$/);
    expect(lines.some((l) => l.startsWith("CELL") && l.includes('"juice"') && l.includes("🧃"))).toBe(true);
    expect(lines.some((l) => l.startsWith("HEARD") && l.includes("Hello!"))).toBe(true);
    expect(lines.some((l) => l.includes("(empty)"))).toBe(true);
  });
});
