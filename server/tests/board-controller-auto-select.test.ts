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

// `packageRepository` is imported by the controller for the package-board read
// guard (canReadPackageBoard) and the write guard (canWritePackageBoard). Both
// consult the packages a board belongs to, so the mock drives those tests.
const listPackagesForBoard = jest.fn(async (_boardId: string) => [] as any[]);

jest.unstable_mockModule("../repositories", () => ({
  boardRepository: { createBoard, getBoard, updateBoard },
  packageRepository: { listPackagesForBoard },
}));

// Institute membership is what authorises creating a board and editing an
// institute's unattached content.
const isUserMemberOfInstitute = jest.fn(async (_instituteId: string, _userId: string) => true);
jest.unstable_mockModule("../repositories/instituteRepository", () => ({
  instituteRepository: { isUserMemberOfInstitute },
}));

// Only the library endpoint reads students; these tests never reach it, but the
// import has to resolve.
jest.unstable_mockModule("../repositories/studentRepository", () => ({
  studentRepository: {
    getStudentById: jest.fn(async () => undefined),
    getStudentsForUserInInstitute: jest.fn(async () => [] as any[]),
  },
}));

jest.unstable_mockModule("../services/studentService", () => ({
  studentService: { verifyStudentAccess: jest.fn(async () => ({ hasAccess: false })) },
}));

jest.unstable_mockModule("../services/sharing/clinicianCtx", () => ({
  buildClinicianCtx: jest.fn(async () => undefined),
}));

const canEditPackage = jest.fn(async (_ctx: any, _packageId: string) => false);
const resolvePackagePermission = jest.fn(async (_ctx: any, _packageId: string) => "none" as string);
jest.unstable_mockModule("../services/packages/packageAccess", () => ({
  resolvePackagePermission,
  canEditPackage,
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
    listPackagesForBoard.mockClear();
    canEditPackage.mockClear();
    isUserMemberOfInstitute.mockClear();
    getBoard.mockImplementation(async (_id: string) => ({ id: "existing-id", userId: "user-1" }) as any);
    isUserMemberOfInstitute.mockImplementation(async () => true);
  });

  it("forwards automaticSelection + hint when creating a new board (POST)", async () => {
    const req: any = {
      user: baseUser,
      body: {
        name: "Mealtime",
        instituteId: "inst-1",
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
        instituteId: "inst-1",
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

/**
 * Every board belongs to a {{student}} or to an institute. A board with
 * neither has no owner at all: nobody but its author could ever see it, and it
 * could never be added to a package.
 */
describe("BoardController board ownership on create", () => {
  beforeEach(() => {
    createBoard.mockClear();
    isUserMemberOfInstitute.mockClear();
    isUserMemberOfInstitute.mockImplementation(async () => true);
  });

  it("REFUSES a board with no institute", async () => {
    const req: any = {
      user: baseUser,
      body: { name: "Ownerless", irData: { grid: { rows: 2, cols: 2 }, pages: [] } },
    };
    const res = mockRes();

    await boardController.saveBoard(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("error:INSTITUTE_REQUIRED");
    expect(createBoard).not.toHaveBeenCalled();
  });

  it("REFUSES an institute the caller is not a member of", async () => {
    isUserMemberOfInstitute.mockImplementation(async () => false);
    const req: any = {
      user: baseUser,
      body: {
        name: "Someone else's",
        instituteId: "inst-other",
        irData: { grid: { rows: 2, cols: 2 }, pages: [] },
      },
    };
    const res = mockRes();

    await boardController.saveBoard(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe("error:INSTITUTE_ACCESS_DENIED");
    expect(createBoard).not.toHaveBeenCalled();
  });

  it("stamps the institute on the stored board", async () => {
    const req: any = {
      user: baseUser,
      body: {
        name: "Ours",
        instituteId: "inst-1",
        irData: { grid: { rows: 2, cols: 2 }, pages: [] },
      },
    };
    const res = mockRes();

    await boardController.saveBoard(req, res);

    expect(res.statusCode).toBe(201);
    expect((createBoard.mock.calls[0][0] as any).instituteId).toBe("inst-1");
  });
});

/**
 * Package boards are shared content. `use` on a package must never let you
 * rewrite what other institutes have attached — that is what
 * defaultMemberPermission is for, and what "publicly usable is never publicly
 * editable" means. `edit` on any package holding the board does allow it.
 */
describe("BoardController package-board write guard", () => {
  const packageBoard = {
    id: "pkg-board",
    userId: "someone-else",
    studentId: null,
    scope: "package",
    instituteId: "inst-1",
  };

  beforeEach(() => {
    updateBoard.mockClear();
    listPackagesForBoard.mockClear();
    canEditPackage.mockClear();
    isUserMemberOfInstitute.mockImplementation(async () => true);
    resolvePackagePermission.mockImplementation(async () => "none");
    getBoard.mockImplementation(async () => packageBoard as any);
  });

  it("REFUSES a board in a package the caller may only use", async () => {
    listPackagesForBoard.mockImplementation(async () => [{ id: "pkg-1" }] as any[]);
    canEditPackage.mockImplementation(async () => false);
    // Readable (they hold `use`), just not writable — so the refusal names the
    // reason instead of pretending the board is not there.
    resolvePackagePermission.mockImplementation(async () => "use");

    const req: any = { user: baseUser, params: { id: "pkg-board" }, body: { name: "Rewritten" }, query: {} };
    const res = mockRes();

    await boardController.updateBoard(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe("error:BOARD_READ_ONLY");
    expect(updateBoard).not.toHaveBeenCalled();
  });

  it("ALLOWS a board in a package the caller may edit", async () => {
    listPackagesForBoard.mockImplementation(async () => [{ id: "pkg-1" }] as any[]);
    canEditPackage.mockImplementation(async () => true);

    const req: any = { user: baseUser, params: { id: "pkg-board" }, body: { name: "Rewritten" }, query: {} };
    const res = mockRes();

    await boardController.updateBoard(req, res);

    expect(updateBoard).toHaveBeenCalledTimes(1);
  });

  it("ALLOWS institute content that no package holds any more", async () => {
    // Removing a board from its last package leaves institute-owned content
    // with no membership row to consult — the institute's members own it.
    listPackagesForBoard.mockImplementation(async () => [] as any[]);
    canEditPackage.mockImplementation(async () => false);

    const req: any = { user: baseUser, params: { id: "pkg-board" }, body: { name: "Rewritten" }, query: {} };
    const res = mockRes();

    await boardController.updateBoard(req, res);

    expect(updateBoard).toHaveBeenCalledTimes(1);
  });

  it("REFUSES that same orphaned content to a non-member", async () => {
    listPackagesForBoard.mockImplementation(async () => [] as any[]);
    canEditPackage.mockImplementation(async () => false);
    isUserMemberOfInstitute.mockImplementation(async () => false);

    const req: any = { user: baseUser, params: { id: "pkg-board" }, body: { name: "Rewritten" }, query: {} };
    const res = mockRes();

    await boardController.updateBoard(req, res);

    // Not readable either (no student, not the author, no package access), so
    // it stays a 404 rather than confirming the row exists.
    expect(res.statusCode).toBe(404);
    expect(updateBoard).not.toHaveBeenCalled();
  });
});
