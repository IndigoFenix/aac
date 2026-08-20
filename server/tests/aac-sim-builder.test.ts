/**
 * The sentence-builder surface, projected (harness design ④).
 *
 * The measurement this exists to protect: "reached in N presses across M
 * screens". That number is only about the CHILD's board if the driver asks the
 * surfacer for the same budget the board asks for, and pages it the same way.
 * Text mode's own defaults differ on both counts, so these tests pin the seam.
 */

import { describe, it, expect } from "@jest/globals";
import {
  AAC_BUILDER_CAPACITY,
  aacBuilderPager,
  createSimBuilder,
  pressBuilderCell,
  pressBuilderMore,
  pressBuilderPlay,
  pressBuilderTab,
  pressBuilderUndo,
  projectBuilder,
  renderBuilder,
} from "../services/aac-sim/builder.js";
import { BUILDER_GRID_CELLS, BUILDER_ITEMS_WITH_MORE } from "@shared/aac-builder-paging.js";

const words = (b: ReturnType<typeof createSimBuilder>) =>
  projectBuilder(b).cells.map((c) => c.label);

describe("it drives the CHILD's board, not text mode's", () => {
  it("asks the surfacer for the AAC's capacity", () => {
    // The board's own budget (three grid pages). A smaller one ranks a
    // different set of words into reach and changes every press count.
    expect(AAC_BUILDER_CAPACITY).toBe(54);
  });

  it("pages the WORD GRID at the AAC's grid, not the surfacer's default", () => {
    // Only the word cells are the grid; tabs, chips and controls sit around it.
    const words = projectBuilder(createSimBuilder()).cells.filter((c) => c.where === "board");
    expect(words.length).toBeLessThanOrEqual(BUILDER_GRID_CELLS);
    expect(words.length).toBeGreaterThanOrEqual(BUILDER_ITEMS_WITH_MORE);
  });

  it("makes every builder surface pressable — tabs, chips and controls (law ③)", () => {
    const cells = projectBuilder(createSimBuilder()).cells;
    const kinds = new Set(cells.map((c) => c.where));
    expect(kinds).toContain("board");
    expect(kinds).toContain("tab");
    expect(kinds).toContain("control");
    // Numbered in one unbroken sequence, so `press 22` is unambiguous.
    expect(cells.map((c) => c.n)).toEqual(cells.map((_, i) => i + 1));
    // Play must be reachable, or a composed sentence can never be sent.
    expect(cells.some((c) => c.where === "control" && c.label === "PLAY")).toBe(true);
  });

  it("CYCLES on More rather than refusing — the control must never go dead", () => {
    const b = createSimBuilder();
    for (let i = 0; i < 10; i++) {
      expect(pressBuilderMore(b).message).toBeNull();
    }
    // Still showing a full screen after cycling right past the end.
    expect(projectBuilder(b).cells.length).toBeGreaterThan(0);
  });

  it("reports no page TOTAL, because a cycling pager has no last page", () => {
    const view = projectBuilder(createSimBuilder());
    expect(view.page).toBe(1);
    expect(view as unknown as { pages?: number }).not.toHaveProperty("pages");
  });

  it("the pager itself keeps every page full", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ key: `w${i}`, label: `w${i}` }));
    const p = aacBuilderPager(items as never, 1);
    expect(p.items).toHaveLength(BUILDER_ITEMS_WITH_MORE);
    expect(p.pages).toBeNull();
  });
});

describe("composing", () => {
  it("builds a sentence a press at a time, and says what it would say", () => {
    const b = createSimBuilder();
    const first = projectBuilder(b);
    expect(first.partial).toBe("");
    expect(first.complete).toBe(false);

    // Press by NUMBER, exactly as the child does.
    const target = first.cells.find((c) => c.label === "I");
    expect(target).toBeTruthy();
    pressBuilderCell(b, target!.n);

    const after = projectBuilder(b);
    expect(after.partial).not.toBe("");
    expect(after.preview.length).toBeGreaterThan(0);
  });

  it("keeps composing LOCAL — nothing reaches the server until Play", () => {
    const b = createSimBuilder();
    const view = projectBuilder(b);
    const r = pressBuilderCell(b, view.cells[0].n);
    expect(r.message).toBeNull();
    expect(r.local).toBe(true);
  });

  it("sends the composed glyph on Play, once", () => {
    const b = createSimBuilder();
    pressBuilderCell(b, projectBuilder(b).cells[0].n);
    const played = pressBuilderPlay(b);

    expect(played.local).toBe(false);
    expect(played.message).toMatchObject({ type: "glyph_press" });
    expect(String((played.message as { glyph: string }).glyph).length).toBeGreaterThan(0);
    // Play clears the board, so a second Play has nothing to send.
    expect(pressBuilderPlay(b).message).toBeNull();
  });

  it("treats an empty Play as an error, not a silent no-op (law ⑦)", () => {
    const r = pressBuilderPlay(createSimBuilder());
    expect(r.message).toBeNull();
    expect(r.note).toMatch(/nothing composed/);
  });

  it("undo takes back the last word", () => {
    const b = createSimBuilder();
    pressBuilderCell(b, projectBuilder(b).cells[0].n);
    const composed = projectBuilder(b).partial;
    expect(composed).not.toBe("");
    pressBuilderUndo(b);
    expect(projectBuilder(b).partial).toBe("");
  });

  it("reports a press that did nothing rather than swallowing it", () => {
    const r = pressBuilderCell(createSimBuilder(), 9999);
    expect(r.message).toBeNull();
    expect(r.note).toMatch(/tried to press 9999/);
  });
});

describe("tabs and chips are part of the cost", () => {
  it("offers the engine's category tabs", () => {
    const view = projectBuilder(createSimBuilder());
    expect(view.tabs.length).toBeGreaterThan(0);
    expect(view.openTab).toBeNull(); // the ranked view is the ABSENCE of a tab
  });

  it("opening a tab changes the words on offer", () => {
    const b = createSimBuilder();
    const ranked = words(b);
    const tab = projectBuilder(b).tabs[0];
    const r = pressBuilderTab(b, tab);

    expect(r.message).toBeNull(); // a tab is a local press — but still a press
    expect(projectBuilder(b).openTab).toBe(tab);
    expect(words(b)).not.toEqual(ranked);
  });

  it("says so when a tab does not exist", () => {
    const r = pressBuilderTab(createSimBuilder(), "not-a-tab");
    expect(r.note).toMatch(/tried the not-a-tab tab/);
  });
});

describe("law ① holds here too", () => {
  it("exposes no key FIELD — presses route by number, not by key", () => {
    const b = createSimBuilder();
    pressBuilderCell(b, projectBuilder(b).cells[0].n);
    for (const cell of projectBuilder(b).cells) {
      expect(Object.keys(cell)).not.toContain("id");
      expect(Object.keys(cell)).not.toContain("key");
    }
    // NOT claimed: that the key is hidden. Where a glyph has no emoji the face
    // falls back to the key string, which a non-reading child does see — the
    // same accepted §3.2 leak the board projection makes.
  });

  it("honours the reading dial on WORD labels, and leaves controls readable", () => {
    const blind = projectBuilder(createSimBuilder(), { readLabel: () => null });
    const words = blind.cells.filter((c) => c.where === "board");
    expect(words.every((c) => c.label === null)).toBe(true);
    // …and the picture survives, which is the whole point of the dial.
    expect(words.some((c) => c.picture !== null)).toBe(true);
    // Controls are fixed chrome learned by shape and position, like the quick
    // row — a child who uses this every day still knows where Play is.
    expect(blind.cells.filter((c) => c.where === "control").every((c) => c.label !== null)).toBe(true);
  });
});

describe("rendering", () => {
  it("prints the screen as tagged lines", () => {
    const b = createSimBuilder();
    const lines = renderBuilder(projectBuilder(b));
    expect(lines[0]).toMatch(/^BUILD\s+\(empty\) · not yet sayable · page 1/);
    expect(lines.some((l) => l.startsWith("TABS"))).toBe(true);
    expect(lines.some((l) => l.startsWith("WORD"))).toBe(true);
  });

  it("shows the sentence back once something is composed", () => {
    const b = createSimBuilder();
    pressBuilderCell(b, projectBuilder(b).cells[0].n);
    const lines = renderBuilder(projectBuilder(b));
    expect(lines.some((l) => l.startsWith("SAYS"))).toBe(true);
  });
});
