/**
 * Regression test for the custom board editor's "auto-select hint isn't saving"
 * bug. The POST /api/boards handler used to parse the body with a schema that
 * omitted automaticSelection / automaticSelectionHint, so newly created boards
 * silently dropped the hint (it survived in client memory until a reload, then
 * vanished). These tests pin that the create path now forwards both fields, and
 * that the update path keeps forwarding them.
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";

// Mock the repository the controller imports from "../repositories".
const createBoard = jest.fn(async (board: any) => ({ id: "new-board-id", ...board }));
const getBoard = jest.fn(async (_id: string) => ({ id: "existing-id", userId: "user-1" }));
const updateBoard = jest.fn(async (_id: string, data: any) => ({ id: "existing-id", ...data }));

jest.unstable_mockModule("../repositories", () => ({
  boardRepository: { createBoard, getBoard, updateBoard },
}));

// activityLogService is fire-and-forget; stub it so nothing touches the DB.
jest.unstable_mockModule("../services/activityLogService", () => ({
  activityLogService: { log: jest.fn() },
}));

jest.unstable_mockModule("../services/analyticsService", () => ({
  analyticsService: { trackEvent: jest.fn() },
}));

const { boardController } = await import("../controllers/boardController");

function mockRes() {
  const res: any = {};
  res.statusCode = 200;
  res.body = undefined;
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((payload: any) => {
    res.body = payload;
    return res;
  });
  return res;
}

const baseUser = { id: "user-1" };

describe("BoardController auto-select persistence", () => {
  beforeEach(() => {
    createBoard.mockClear();
    getBoard.mockClear();
    updateBoard.mockClear();
  });

  it("forwards automaticSelection + hint when creating a new board (POST)", async () => {
    const req: any = {
      user: baseUser,
      body: {
        name: "Mealtime",
        irData: { name: "Mealtime", grid: { rows: 2, cols: 2 }, pages: [] },
        automaticSelection: true,
        automaticSelectionHint: "During mealtimes",
      },
    };
    const res = mockRes();

    await boardController.saveBoard(req, res);

    expect(res.statusCode).toBe(201);
    expect(createBoard).toHaveBeenCalledTimes(1);
    const arg = createBoard.mock.calls[0][0] as any;
    expect(arg.automaticSelection).toBe(true);
    expect(arg.automaticSelectionHint).toBe("During mealtimes");
  });

  it("omits auto-select keys when not provided (so DB defaults apply)", async () => {
    const req: any = {
      user: baseUser,
      body: {
        name: "Plain",
        irData: { name: "Plain", grid: { rows: 2, cols: 2 }, pages: [] },
      },
    };
    const res = mockRes();

    await boardController.saveBoard(req, res);

    expect(res.statusCode).toBe(201);
    const arg = createBoard.mock.calls[0][0] as any;
    expect("automaticSelection" in arg).toBe(false);
    expect("automaticSelectionHint" in arg).toBe(false);
  });

  it("forwards automaticSelectionHint when updating an existing board (PATCH)", async () => {
    const req: any = {
      user: baseUser,
      params: { id: "existing-id" },
      body: { automaticSelectionHint: "When the bus arrives", automaticSelection: true },
    };
    const res = mockRes();

    await boardController.updateBoard(req, res);

    expect(updateBoard).toHaveBeenCalledTimes(1);
    const [, data] = updateBoard.mock.calls[0] as any;
    expect(data.automaticSelectionHint).toBe("When the bus arrives");
    expect(data.automaticSelection).toBe(true);
  });
});
