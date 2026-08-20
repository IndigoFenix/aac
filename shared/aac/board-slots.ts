/**
 * board-slots.ts
 *
 * WHAT IS IN EACH CELL of the dynamic board, and how cells change when the AI
 * patches the board under the student. Pure — no React, no DOM, no timers — so
 * the rules can be tested directly instead of through a rendered component.
 *
 * The board is a fixed grid of SLOTS, not a list of buttons. That distinction
 * is the whole point: an eye-gaze student aims at a POSITION, so a button that
 * arrives must land in a free cell rather than reflowing the ones already on
 * screen, and a button that leaves must vacate its own cell rather than letting
 * everything after it shuffle up. Hence `fading` — a slot that is on its way out
 * but still occupies its position until the animation ends.
 *
 * The animation TIMER stays in the component (this module has no clock); it
 * calls `resolveFades` when the fade is done.
 *
 * Grid size is not decided here — it comes from `pageGrid` in @shared/board-grid,
 * which is the one definition every renderer and validator shares.
 */

import type { BoardButton } from "@shared/schema";

/** One cell of the grid. */
export type SlotState =
  | { type: "occupied"; button: BoardButton; anim: "stable" | "entering" }
  /** On its way out. Holds its position until the fade completes; `replaceWith`
   *  is an arriving button queued to take the cell rather than reflow others. */
  | { type: "fading"; button: BoardButton; replaceWith?: BoardButton }
  | { type: "blank" };

export const BLANK_SLOT: SlotState = { type: "blank" };

/** An entry from a `board_patch` add list. */
export interface PatchAddEntry {
  label: string;
  iconRef: string;
  symbolPath?: string;
  glyph?: string;
  sentence?: string;
}

export interface BoardPatchInput {
  add: PatchAddEntry[];
  remove: string[];
}

/** Labels compare case- and whitespace-insensitively everywhere in this module:
 *  the AI's remove list is written by a model and will not match byte-for-byte. */
function normLabel(s: string | undefined): string {
  return (s ?? "").toLowerCase().trim();
}

/** Identity for the de-duplication pass: label AND icon, because the same word
 *  with a different picture is a different button to a child who cannot read. */
function addKey(label: string, iconRef: string | undefined): string {
  return `${normLabel(label)}|${normLabel(iconRef)}`;
}

/** Mints ids for buttons that arrive by patch (they have none of their own).
 *  Injectable so tests get stable ids; production keeps the wall clock. */
export type IdFactory = (index: number) => string;

export const defaultIdFactory: IdFactory = (index) => `btn-patch-${Date.now()}-${index}`;

/** Build a BoardButton from a patch add entry. Patch buttons are always plain
 *  speak buttons — the patch channel carries no actions. */
export function makeBoardButton(
  entry: PatchAddEntry,
  index: number,
  makeId: IdFactory = defaultIdFactory,
): BoardButton {
  return {
    id: makeId(index),
    label: entry.label,
    spokenText: entry.label,
    ...(entry.sentence ? { sentence: entry.sentence } : {}),
    ...(entry.glyph ? { glyph: entry.glyph } : {}),
    row: 0,
    col: 0,
    iconRef: entry.iconRef,
    symbolPath: entry.symbolPath,
    action: { type: "speak", text: entry.label },
  } as BoardButton;
}

/**
 * Lay a page's buttons out across `rows × cols` cells.
 *
 * TWO PLACEMENT MODES, chosen by the data rather than by the caller. A board
 * authored in the clinician editor carries real row/col coordinates and must be
 * drawn exactly where it was laid out. An AI-generated board usually carries
 * none, and is filled in reading order. The rule is "does ANY button declare a
 * position" — a board where only some do still honours those, and the rest are
 * dropped rather than being scattered into cells someone else claimed.
 */
export function layoutSlots(
  buttons: BoardButton[],
  grid: { rows: number; cols: number },
): SlotState[] {
  const total = grid.rows * grid.cols;
  const hasPositions = buttons.length > 0 && buttons.some((b) => b.row != null && b.col != null);

  return Array.from({ length: total }, (_, i): SlotState => {
    if (hasPositions) {
      const row = Math.floor(i / grid.cols);
      const col = i % grid.cols;
      const button = buttons.find((b) => b.row === row && b.col === col);
      if (button) return { type: "occupied", button, anim: "entering" };
    } else if (i < buttons.length) {
      return { type: "occupied", button: buttons[i], anim: "entering" };
    }
    return BLANK_SLOT;
  });
}

/**
 * Apply an incremental `board_patch` (the AI adding/removing a few buttons
 * without rebuilding the board).
 *
 * Order matters, and each step exists for a reason:
 *
 *  1. Mark removals as `fading`. They keep their cells for now.
 *  2. De-duplicate the adds against what is STILL on the board. Computed after
 *     step 1 on purpose: a button that is fading out has left, so re-adding it
 *     in the same patch is legitimate and must not be swallowed.
 *  3. Fill genuinely blank cells first — an arriving button should take empty
 *     space before it takes a dying button's place.
 *  4. Queue whatever is left onto fading cells, one each. Those appear when the
 *     fade completes (`resolveFades`), so the cell is reused without any button
 *     on screen moving.
 *
 * Adds beyond the available cells are dropped: the grid is the budget.
 */
export function applyBoardPatch(
  slots: SlotState[],
  patch: BoardPatchInput,
  makeId: IdFactory = defaultIdFactory,
): SlotState[] {
  const { add, remove } = patch;
  if (add.length === 0 && remove.length === 0) return slots;

  const removeLower = new Set(remove.map(normLabel));
  const next = [...slots];

  // 1 — removals begin fading, holding their cells.
  for (let i = 0; i < next.length; i++) {
    const slot = next[i];
    if (slot.type === "occupied" && removeLower.has(normLabel(slot.button.label))) {
      next[i] = { type: "fading", button: slot.button };
    }
  }

  // 2 — drop adds that are already on the board (label AND icon).
  const existing = new Set(
    next
      .filter((s): s is Extract<SlotState, { type: "occupied" }> => s.type === "occupied")
      .map((s) => addKey(s.button.label, s.button.iconRef)),
  );
  const dedupedAdd = add.filter((btn) => !existing.has(addKey(btn.label, btn.iconRef)));

  // 3 — blank cells first.
  let addIndex = 0;
  for (let i = 0; i < next.length && addIndex < dedupedAdd.length; i++) {
    if (next[i].type === "blank") {
      next[i] = { type: "occupied", button: makeBoardButton(dedupedAdd[addIndex], addIndex, makeId), anim: "entering" };
      addIndex++;
    }
  }

  // 4 — then queue onto cells that are being vacated.
  for (let i = 0; i < next.length && addIndex < dedupedAdd.length; i++) {
    const slot = next[i];
    if (slot.type === "fading" && !slot.replaceWith) {
      next[i] = {
        type: "fading",
        button: slot.button,
        replaceWith: makeBoardButton(dedupedAdd[addIndex], addIndex, makeId),
      };
      addIndex++;
    }
  }

  return next;
}

/** The fade finished: queued buttons take their cells, the rest go blank.
 *  Called by the component's timer — this module keeps no clock. */
export function resolveFades(slots: SlotState[]): SlotState[] {
  return slots.map((s): SlotState => {
    if (s.type !== "fading") return s;
    if (s.replaceWith) return { type: "occupied", button: s.replaceWith, anim: "entering" };
    return BLANK_SLOT;
  });
}

/**
 * An auto-generated symbol finished rendering — swap it onto every cell showing
 * that label. Matches by label because that is the only handle the generation
 * pipeline carries back; fading cells are updated too, since one may be queued
 * to return via `replaceWith`.
 */
export function applySymbolUpdate(
  slots: SlotState[],
  update: { buttonLabel: string; symbolPath: string },
): SlotState[] {
  return slots.map((slot) => {
    if (slot.type !== "occupied" && slot.type !== "fading") return slot;
    if (slot.button.label.toLowerCase() !== update.buttonLabel.toLowerCase()) return slot;
    return { ...slot, button: { ...slot.button, symbolPath: update.symbolPath } };
  });
}
