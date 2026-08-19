/**
 * Slot placement and patching. The behaviour under test is positional: an
 * eye-gaze student aims at a CELL, so what matters is that arriving and
 * departing buttons never make the ones already on screen move.
 */

import type { BoardButton } from "@shared/schema";
import {
  applyBoardPatch,
  applySymbolUpdate,
  BLANK_SLOT,
  layoutSlots,
  resolveFades,
  type SlotState,
} from "./board-slots";

const stableIds = (i: number) => `patch-${i}`;

/** A button with NO position, like an AI-generated one. Pass row/col explicitly
 *  to model a board authored in the clinician editor. */
function btn(label: string, extra: Partial<BoardButton> = {}): BoardButton {
  return { id: `id-${label}`, label, spokenText: label, ...extra } as BoardButton;
}

/** Compact view of a slot list for readable assertions. */
const shape = (slots: SlotState[]) =>
  slots.map((s) =>
    s.type === "blank" ? "-" : s.type === "fading" ? `~${s.button.label}${s.replaceWith ? `>${s.replaceWith.label}` : ""}` : s.button.label,
  );

describe("layoutSlots", () => {
  it("fills in reading order when no button declares a position", () => {
    const slots = layoutSlots([btn("a"), btn("b")], { rows: 2, cols: 2 });
    expect(shape(slots)).toEqual(["a", "b", "-", "-"]);
  });

  it("honours row/col when the board carries positions", () => {
    const slots = layoutSlots(
      [btn("x", { row: 1, col: 1 }), btn("y", { row: 0, col: 1 })],
      { rows: 2, cols: 2 },
    );
    expect(shape(slots)).toEqual(["-", "y", "-", "x"]);
  });

  it("keeps the grid the budget — extra buttons do not overflow it", () => {
    const slots = layoutSlots([btn("a"), btn("b"), btn("c")], { rows: 1, cols: 2 });
    expect(slots).toHaveLength(2);
    expect(shape(slots)).toEqual(["a", "b"]);
  });

  it("treats a board as positioned if ANY button declares a position", () => {
    // The un-positioned one is dropped rather than scattered into a cell some
    // other button laid claim to.
    const slots = layoutSlots([btn("placed", { row: 0, col: 1 }), btn("loose")], { rows: 1, cols: 2 });
    expect(shape(slots)).toEqual(["-", "placed"]);
  });

  it("gives an empty page all blanks", () => {
    expect(layoutSlots([], { rows: 1, cols: 3 })).toEqual([BLANK_SLOT, BLANK_SLOT, BLANK_SLOT]);
  });
});

describe("applyBoardPatch", () => {
  const board = () => layoutSlots([btn("hello"), btn("more")], { rows: 1, cols: 4 });

  it("is a no-op for an empty patch", () => {
    const before = board();
    expect(applyBoardPatch(before, { add: [], remove: [] }, stableIds)).toBe(before);
  });

  it("marks a removal as fading rather than vacating the cell immediately", () => {
    const next = applyBoardPatch(board(), { add: [], remove: ["hello"] }, stableIds);
    expect(shape(next)).toEqual(["~hello", "more", "-", "-"]);
  });

  it("matches removals case- and whitespace-insensitively", () => {
    const next = applyBoardPatch(board(), { add: [], remove: ["  HELLO "] }, stableIds);
    expect(shape(next)[0]).toBe("~hello");
  });

  it("puts arrivals in blank cells before dying ones", () => {
    const next = applyBoardPatch(
      board(),
      { add: [{ label: "new", iconRef: "🆕" }], remove: ["hello"] },
      stableIds,
    );
    expect(shape(next)).toEqual(["~hello", "more", "new", "-"]);
  });

  it("queues an arrival onto a dying cell once the blanks are gone", () => {
    const full = layoutSlots([btn("a"), btn("b")], { rows: 1, cols: 2 });
    const next = applyBoardPatch(
      full,
      { add: [{ label: "c", iconRef: "🆒" }], remove: ["a"] },
      stableIds,
    );
    expect(shape(next)).toEqual(["~a>c", "b"]);
  });

  it("drops a duplicate add — same label AND same icon", () => {
    const start = layoutSlots([btn("hello", { iconRef: "👋" })], { rows: 1, cols: 3 });
    const next = applyBoardPatch(start, { add: [{ label: "hello", iconRef: "👋" }], remove: [] }, stableIds);
    expect(shape(next)).toEqual(["hello", "-", "-"]);
  });

  it("allows the same word with a DIFFERENT picture — a different button to a pre-reader", () => {
    const start = layoutSlots([btn("bat", { iconRef: "🦇" })], { rows: 1, cols: 3 });
    const next = applyBoardPatch(start, { add: [{ label: "bat", iconRef: "🏏" }], remove: [] }, stableIds);
    expect(shape(next)).toEqual(["bat", "bat", "-"]);
  });

  it("lets one patch remove a button and re-add it", () => {
    // De-duplication runs AFTER removals are marked, so the fading copy does not
    // swallow the arriving one.
    const start = layoutSlots([btn("x", { iconRef: "❌" })], { rows: 1, cols: 2 });
    const next = applyBoardPatch(
      start,
      { add: [{ label: "x", iconRef: "❌" }], remove: ["x"] },
      stableIds,
    );
    expect(shape(next)).toEqual(["~x", "x"]);
  });

  it("drops adds that do not fit — the grid is the budget", () => {
    const full = layoutSlots([btn("a"), btn("b")], { rows: 1, cols: 2 });
    const next = applyBoardPatch(
      full,
      { add: [{ label: "c", iconRef: "1" }, { label: "d", iconRef: "2" }], remove: [] },
      stableIds,
    );
    expect(shape(next)).toEqual(["a", "b"]);
  });

  it("gives patch-built buttons a speak action and their label as speech", () => {
    const next = applyBoardPatch(
      layoutSlots([], { rows: 1, cols: 1 }),
      { add: [{ label: "juice", iconRef: "🧃", sentence: "I want juice" }], remove: [] },
      stableIds,
    );
    const slot = next[0] as Extract<SlotState, { type: "occupied" }>;
    expect(slot.button.id).toBe("patch-0");
    expect(slot.button.spokenText).toBe("juice");
    expect(slot.button.sentence).toBe("I want juice");
    expect(slot.button.action).toEqual({ type: "speak", text: "juice" });
  });
});

describe("resolveFades", () => {
  it("promotes a queued button into the cell it was waiting on", () => {
    const full = layoutSlots([btn("a"), btn("b")], { rows: 1, cols: 2 });
    const patched = applyBoardPatch(full, { add: [{ label: "c", iconRef: "c" }], remove: ["a"] }, stableIds);
    expect(shape(resolveFades(patched))).toEqual(["c", "b"]);
  });

  it("blanks a fading cell with nothing queued", () => {
    const patched = applyBoardPatch(
      layoutSlots([btn("a"), btn("b")], { rows: 1, cols: 2 }),
      { add: [], remove: ["a"] },
      stableIds,
    );
    expect(shape(resolveFades(patched))).toEqual(["-", "b"]);
  });

  it("leaves settled cells alone", () => {
    const slots = layoutSlots([btn("a")], { rows: 1, cols: 2 });
    expect(shape(resolveFades(slots))).toEqual(["a", "-"]);
  });
});

describe("applySymbolUpdate", () => {
  it("swaps the generated symbol onto every cell showing that label", () => {
    const slots = layoutSlots([btn("dog"), btn("cat")], { rows: 1, cols: 2 });
    const next = applySymbolUpdate(slots, { buttonLabel: "DOG", symbolPath: "/s/dog.svg" });
    const dog = next[0] as Extract<SlotState, { type: "occupied" }>;
    const cat = next[1] as Extract<SlotState, { type: "occupied" }>;
    expect(dog.button.symbolPath).toBe("/s/dog.svg");
    expect(cat.button.symbolPath).toBeUndefined();
  });

  it("updates a fading cell too — it may be queued to return", () => {
    const patched = applyBoardPatch(
      layoutSlots([btn("dog")], { rows: 1, cols: 2 }),
      { add: [], remove: ["dog"] },
      stableIds,
    );
    const next = applySymbolUpdate(patched, { buttonLabel: "dog", symbolPath: "/s/dog.svg" });
    const slot = next[0] as Extract<SlotState, { type: "fading" }>;
    expect(slot.button.symbolPath).toBe("/s/dog.svg");
  });
});
