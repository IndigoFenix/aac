/**
 * The board generator's grid guard, exercised through the REAL manageMemory
 * tool the AI calls.
 *
 * The bug: asked to tidy a board, the AI would shrink the grid and leave the
 * buttons where they were. The board came back with cells missing and buttons
 * simply gone from the student's device — silently, because a memory `set` has
 * no opinion about geometry.
 *
 * The rule: an edit that leaves any button outside its page's grid is rolled
 * back whole and reported, so the AI can redo it properly. Shrinking IS allowed
 * — it just has to move or delete the casualties in the SAME call.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { defaultToolRegistry } from "../services/chat/tool-router";

// The board field the AI edits, trimmed to what the memory system needs to
// walk a `set` on /Context_Board and its sub-paths.
const BOARD_FIELD = {
  id: "Context_Board",
  type: "object",
  title: "Communication Board",
  opened: true,
  properties: {
    name: { id: "name", type: "string", title: "Board Name" },
    grid: {
      id: "grid",
      type: "object",
      title: "Default Grid Size",
      properties: {
        rows: { id: "rows", type: "integer", title: "Rows" },
        cols: { id: "cols", type: "integer", title: "Columns" },
      },
    },
    pages: {
      id: "pages",
      type: "array",
      title: "Pages",
      opened: true,
      items: {
        id: "page",
        type: "object",
        properties: {
          id: { id: "id", type: "string", title: "Page ID" },
          name: { id: "name", type: "string", title: "Page Name" },
          layout: {
            id: "layout",
            type: "object",
            title: "Page Grid Size",
            properties: {
              rows: { id: "rows", type: "integer", title: "Rows" },
              cols: { id: "cols", type: "integer", title: "Columns" },
            },
          },
          buttons: {
            id: "buttons",
            type: "array",
            title: "Buttons",
            items: {
              id: "button",
              type: "object",
              properties: {
                id: { id: "id", type: "string", title: "Button ID" },
                row: { id: "row", type: "integer", title: "Row" },
                col: { id: "col", type: "integer", title: "Column" },
                label: { id: "label", type: "string", title: "Label" },
              },
            },
          },
        },
      },
    },
  },
};

/** A 2x4 page holding seven buttons, packed from 0,0. */
const boardWithSevenButtons = () => ({
  name: "Food",
  grid: { rows: 2, cols: 4 },
  pages: [
    {
      id: "page-main",
      name: "Main",
      layout: { rows: 2, cols: 4 },
      buttons: [
        { id: "b0", row: 0, col: 0, label: "Apple" },
        { id: "b1", row: 0, col: 1, label: "Bread" },
        { id: "b2", row: 0, col: 2, label: "Water" },
        { id: "b3", row: 0, col: 3, label: "Milk" },
        { id: "b4", row: 1, col: 0, label: "More" },
        { id: "b5", row: 1, col: 1, label: "Done" },
        { id: "b6", row: 1, col: 2, label: "Help" },
      ],
    },
  ],
});

let memoryValuesRef: { current: any };
let registry: ReturnType<typeof defaultToolRegistry>;

beforeEach(() => {
  memoryValuesRef = { current: { Context_Board: boardWithSevenButtons() } };
  registry = defaultToolRegistry({
    agent: { memoryFields: [BOARD_FIELD] },
    openedTopics: [],
    memoryValuesRef,
    chatStateRef: { current: { history: [], memoryState: { visible: [] } } as any },
  });
});

const board = () => memoryValuesRef.current.Context_Board;

describe("manageMemory — board grid guard", () => {
  it("rolls back a shrink that would cut buttons off, and says which", async () => {
    const results = await registry.manageMemory({
      action: "set",
      path: "/Context_Board/pages/0/layout",
      value: { rows: 1, cols: 4 },
    } as any);

    // Nothing changed: the page still has its four columns AND two rows.
    expect(board().pages[0].layout).toEqual({ rows: 2, cols: 4 });
    expect(board().pages[0].buttons).toHaveLength(7);

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    // Names the three buttons on row 1 that the shrink would have orphaned.
    expect(results[0].message).toContain("REJECTED");
    expect(results[0].message).toContain("b4");
    expect(results[0].message).toContain("b5");
    expect(results[0].message).toContain("b6");
    expect(results[0].message).not.toContain("b0");
  });

  it("ALLOWS a shrink whose casualties are dealt with in the same call", async () => {
    // 7 buttons → 4 buttons on a 1x4 row: delete three, shrink the page. This
    // is the legal form of the same edit, and it must not be blocked.
    const trimmed = boardWithSevenButtons();
    trimmed.pages[0].layout = { rows: 1, cols: 4 };
    trimmed.pages[0].buttons = trimmed.pages[0].buttons.slice(0, 4);

    const results = await registry.manageMemory({
      action: "set",
      path: "/Context_Board",
      value: trimmed,
    } as any);

    expect(results.every((r: any) => r.ok !== false)).toBe(true);
    expect(board().pages[0].layout).toEqual({ rows: 1, cols: 4 });
    expect(board().pages[0].buttons).toHaveLength(4);
  });

  it("rejects a button MOVED outside the page it is on", async () => {
    const results = await registry.manageMemory({
      action: "set",
      path: "/Context_Board/pages/0/buttons/6",
      value: { id: "b6", row: 5, col: 0, label: "Stray" },
    } as any);

    expect(results[0].ok).toBe(false);
    expect(results[0].message).toContain("Stray");
    // Rolled back to where it was, not left hanging off the page.
    expect(board().pages[0].buttons[6]).toMatchObject({ id: "b6", row: 1, col: 2, label: "Help" });
  });

  it("rejects an eighth button added past the edge of a full page", async () => {
    // The AI adding one more button than the page has cells for — the shape
    // the fix is really about, since it is the AI that decides the geometry.
    const overfull = boardWithSevenButtons();
    overfull.pages[0].buttons.push({ id: "b7", row: 1, col: 4, label: "Stray" });

    const results = await registry.manageMemory({
      action: "set",
      path: "/Context_Board",
      value: overfull,
    } as any);

    expect(results.some((r: any) => r.ok === false)).toBe(true);
    expect(results.find((r: any) => r.ok === false)!.message).toContain("Stray");
    expect(board().pages[0].buttons).toHaveLength(7);
  });

  it("leaves a board that ARRIVED broken editable", async () => {
    // The client can hand us a board that already has an orphan. If the guard
    // blamed the AI for it, every subsequent edit would bounce and the board
    // could never be repaired.
    memoryValuesRef.current.Context_Board.pages[0].buttons.push({
      id: "orphan",
      row: 9,
      col: 9,
      label: "Orphan",
    });

    const results = await registry.manageMemory({
      action: "set",
      path: "/Context_Board/name",
      value: "Snack time",
    } as any);

    expect(results.every((r: any) => r.ok !== false)).toBe(true);
    expect(board().name).toBe("Snack time");
  });

  it("does not touch edits that leave every button in a cell", async () => {
    const results = await registry.manageMemory({
      action: "set",
      path: "/Context_Board/pages/0/buttons/0/label",
      value: "Apples",
    } as any);

    expect(results.every((r: any) => r.ok !== false)).toBe(true);
    expect(board().pages[0].buttons[0].label).toBe("Apples");
  });
});
