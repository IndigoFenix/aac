import {
  boards,
  packageAssignments,
  packageBoards,
  packages,
  type Board,
  type InsertBoard,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, isNull, asc, inArray } from "drizzle-orm";
import {
  hydrateRecords,
  extractSensitiveFields,
  persistExtracted,
  deleteExternalData,
  resolveEntityRef,
} from "../external-storage";

type BoardWithOptionalIrData = Omit<Board, 'irData'> & { irData?: Board['irData'] };

/** A board reached through a package, carrying what the key builder needs. */
export type PackageSourcedBoard = Board & {
  packageId: string;
  packageName: string;
  /** Membership-level auto-load. Effective auto-load also needs board.automaticSelection. */
  packageAutoLoad: boolean;
};

export class BoardRepository {
  // Board CRUD operations
  async createBoard(board: InsertBoard): Promise<Board> {
    const [newBoard] = await db.insert(boards).values(board).returning();
    const ref = resolveEntityRef("boards", newBoard as Record<string, unknown>);
    if (ref) {
      const ext = await extractSensitiveFields("boards", newBoard.id, newBoard as Record<string, unknown>, ref);
      if (ext.isExternal) {
        const nullSet: Record<string, null> = {};
        for (const key of ext.externalWrites.keys()) {
          const field = key.split("/").pop()!;
          nullSet[field] = null;
        }
        await db.update(boards).set(nullSet).where(eq(boards.id, newBoard.id));
        await persistExtracted(ref, ext.externalWrites);
        return ext.completeData as Board;
      }
    }
    return newBoard;
  }

  async getUserBoards(userId: string): Promise<BoardWithOptionalIrData[]> {
    return await db.select({
      id: boards.id,
      userId: boards.userId,
      studentId: boards.studentId,
      name: boards.name,
      description: boards.description,
      imageUrl: boards.imageUrl,
      language: boards.language,
      automaticSelection: boards.automaticSelection,
      automaticSelectionHint: boards.automaticSelectionHint,
      restSpace: boards.restSpace,
      isGenerated: boards.isGenerated,
      scope: boards.scope,
      instituteId: boards.instituteId,
      createdAt: boards.createdAt,
      updatedAt: boards.updatedAt,
      loadedAt: boards.loadedAt,
    }).from(boards).where(eq(boards.userId, userId));
  }

  /**
   * A student's own boards, WHOEVER authored them.
   *
   * Scoping is by student, not by author: two clinicians treating the same
   * child, an institute admin, and a customer-support agent must all see the
   * same board list, exactly as they do for AAC settings and sessions. The
   * caller proves it may act for this student before calling — see the
   * `verifyStudentAccess` gate in BoardController.getStudentBoards.
   *
   * `scope='student'` ONLY, and `studentId` must MATCH. A package board also
   * has `studentId IS NULL`, so a null-matching arm here would hand every
   * package board to every student; package boards reach a student
   * exclusively through packageAssignments. An ordinary board with a null
   * studentId is its author's personal draft and belongs to no student at
   * all — see getUnassignedBoards.
   */
  async getStudentBoardsMetadata(studentId: string): Promise<BoardWithOptionalIrData[]> {
    // Metadata queries skip irData (the sensitive field) — no hydration needed
    return await db.select({
      id: boards.id,
      userId: boards.userId,
      studentId: boards.studentId,
      name: boards.name,
      description: boards.description,
      imageUrl: boards.imageUrl,
      language: boards.language,
      automaticSelection: boards.automaticSelection,
      automaticSelectionHint: boards.automaticSelectionHint,
      restSpace: boards.restSpace,
      isGenerated: boards.isGenerated,
      scope: boards.scope,
      instituteId: boards.instituteId,
      createdAt: boards.createdAt,
      updatedAt: boards.updatedAt,
      loadedAt: boards.loadedAt,
    }).from(boards).where(
      and(
        eq(boards.scope, "student"),
        eq(boards.studentId, studentId),
      )
    );
  }

  /**
   * The caller's own boards that are attached to NO student — drafts saved
   * with no student loaded in the panel.
   *
   * These are author-scoped on purpose: an unattached board has no student
   * whose access could authorise anyone else to read it, so its author is the
   * only principal there is. They are listed separately from a student's
   * boards so the picker can offer to attach one, instead of quietly showing
   * them under every student the author opens.
   */
  async getUnassignedBoards(userId: string): Promise<BoardWithOptionalIrData[]> {
    return await db.select({
      id: boards.id,
      userId: boards.userId,
      studentId: boards.studentId,
      name: boards.name,
      description: boards.description,
      imageUrl: boards.imageUrl,
      language: boards.language,
      automaticSelection: boards.automaticSelection,
      automaticSelectionHint: boards.automaticSelectionHint,
      restSpace: boards.restSpace,
      isGenerated: boards.isGenerated,
      scope: boards.scope,
      instituteId: boards.instituteId,
      createdAt: boards.createdAt,
      updatedAt: boards.updatedAt,
      loadedAt: boards.loadedAt,
    }).from(boards).where(
      and(
        eq(boards.userId, userId),
        eq(boards.scope, "student"),
        isNull(boards.studentId),
      )
    );
  }

  /**
   * Everything the student's board PICKER should show: their own boards plus
   * every board in every attached package — auto-loading or not.
   *
   * The picker and the AI see deliberately different sets. `autoLoad=false`
   * hides a board from the AI (it never enters the prompt) but keeps it here,
   * because browsing is the student's own business.
   */
  async getStudentPickerBoards(
    studentId: string,
  ): Promise<Array<BoardWithOptionalIrData & { packageName?: string }>> {
    const [own, fromPackages] = await Promise.all([
      this.getStudentBoardsMetadata(studentId),
      this.getPackageBoardsForStudent(studentId),
    ]);
    const ownIds = new Set(own.map((b) => b.id));
    const packaged = fromPackages
      .filter((b) => !ownIds.has(b.id))
      .map(({ irData: _irData, packageId: _packageId, packageAutoLoad: _autoLoad, ...rest }) => rest);
    return [...own, ...packaged];
  }

  /**
   * Is this board reachable by this student through an attached package?
   * Used by the read guard on `/api/boards/:id` so the AAC can fetch the IR of
   * a package board it did not author.
   */
  async isBoardInStudentPackages(boardId: string, studentId: string): Promise<boolean> {
    const [row] = await db.select({ id: packageBoards.id })
      .from(packageAssignments)
      .innerJoin(packageBoards, eq(packageBoards.packageId, packageAssignments.packageId))
      .where(
        and(
          eq(packageAssignments.studentId, studentId),
          eq(packageBoards.boardId, boardId),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  /**
   * Student-scoped like getStudentBoardsMetadata, for the same reason: the AAC
   * device runs under whichever caretaker account happens to be signed in, and
   * that account is rarely the clinician who authored the boards. Author
   * scoping here meant a board simply never auto-loaded for anyone but its
   * maker.
   *
   * See getStudentBoardsMetadata for why the scope filter and the exact
   * studentId match both matter.
   */
  async getAutoSelectableBoards(studentId: string): Promise<Board[]> {
    const rows = await db.select()
      .from(boards)
      .where(
        and(
          eq(boards.automaticSelection, true),
          eq(boards.scope, "student"),
          eq(boards.studentId, studentId),
        )
      );
    return hydrateRecords("boards", rows, { type: "student", id: studentId });
  }

  /**
   * Every board reachable through a package attached to this student.
   *
   * Deliberately NOT routed through `hydrateRecords`: package boards are
   * content, not PHI, and never live in external storage (see
   * OWNERSHIP_MAP.boards). Passing the student's entity ref here would fire a
   * pointless remote round-trip per read.
   *
   * Includes ORPHANED packages — deleting a package must not yank its boards
   * out from under a student who already has it.
   *
   * Ordered by package name then board name so `buildBoardKeys` produces stable
   * collision suffixes across session loads.
   */
  async getPackageBoardsForStudent(studentId: string): Promise<PackageSourcedBoard[]> {
    const rows = await db.select({
      board: boards,
      packageId: packages.id,
      packageName: packages.name,
      packageAutoLoad: packageBoards.autoLoad,
    })
      .from(packageAssignments)
      .innerJoin(packages, eq(packageAssignments.packageId, packages.id))
      .innerJoin(packageBoards, eq(packageBoards.packageId, packages.id))
      .innerJoin(boards, eq(packageBoards.boardId, boards.id))
      .where(eq(packageAssignments.studentId, studentId))
      .orderBy(asc(packages.name), asc(packageBoards.sortOrder), asc(boards.name));

    // A board can sit in two packages that are both attached — show it once,
    // under the first package alphabetically.
    const seen = new Set<string>();
    const out: PackageSourcedBoard[] = [];
    for (const row of rows) {
      if (seen.has(row.board.id)) continue;
      seen.add(row.board.id);
      out.push({
        ...row.board,
        packageId: row.packageId,
        packageName: row.packageName,
        packageAutoLoad: row.packageAutoLoad,
      });
    }
    return out;
  }

  /**
   * The AI-facing board set: the student's own auto-selectable boards plus the
   * auto-loading boards of every attached package.
   *
   * A package board is offered to the AI only when BOTH the membership says
   * `autoLoad` and the board itself has `automaticSelection`. Turning either
   * off keeps the board in the student's picker while hiding it from the AI.
   */
  async getAutoSelectableBoardsWithPackages(
    studentId: string,
  ): Promise<Array<Board & { packageName?: string }>> {
    const [own, fromPackages] = await Promise.all([
      this.getAutoSelectableBoards(studentId),
      this.getPackageBoardsForStudent(studentId),
    ]);

    const ownIds = new Set(own.map((b) => b.id));
    const packaged = fromPackages
      .filter((b) => b.packageAutoLoad && b.automaticSelection && !ownIds.has(b.id))
      .map((b) => ({ ...b, packageName: b.packageName }));

    return [...own, ...packaged];
  }

  async getBoard(id: string): Promise<Board | undefined> {
    const [board] = await db.select().from(boards).where(eq(boards.id, id));
    if (!board) return undefined;
    const [hydrated] = await hydrateRecords("boards", [board]);
    return hydrated;
  }

  async updateBoard(
    id: string,
    data: Partial<InsertBoard>
  ): Promise<Board | undefined> {
    const existing = await this.getBoard(id);
    if (!existing) return undefined;
    const ref = resolveEntityRef("boards", existing as Record<string, unknown>);
    if (ref) {
      const ext = await extractSensitiveFields("boards", id, data as Record<string, unknown>, ref);
      const [board] = await db.update(boards).set(ext.dbData).where(eq(boards.id, id)).returning();
      if (!board) return undefined;
      if (ext.isExternal) await persistExtracted(ref, ext.externalWrites);
      const [hydrated] = await hydrateRecords("boards", [board]);
      return hydrated;
    }
    const [board] = await db.update(boards).set(data).where(eq(boards.id, id)).returning();
    return board || undefined;
  }

  async deleteBoard(id: string): Promise<void> {
    const existing = await this.getBoard(id);
    await db.delete(boards).where(eq(boards.id, id));
    if (existing) {
      const ref = resolveEntityRef("boards", existing as Record<string, unknown>);
      if (ref) await deleteExternalData("boards", id, ref);
    }
  }
}

export const boardRepository = new BoardRepository();
