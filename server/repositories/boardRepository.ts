import {
  boards,
  packageAssignments,
  packageBoards,
  packages,
  type Board,
  type InsertBoard,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, isNull, asc, inArray, notExists, or, sql } from "drizzle-orm";
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

/**
 * Every board column EXCEPT `irData`.
 *
 * irData is the sensitive field (external storage extracts it), so a list query
 * that never selects it needs no hydration round-trip. Same set the package
 * repository selects — keep them in step.
 */
const BOARD_METADATA = {
  id: boards.id,
  userId: boards.userId,
  studentId: boards.studentId,
  name: boards.name,
  description: boards.description,
  imageUrl: boards.imageUrl,
  language: boards.language,
  automaticSelection: boards.automaticSelection,
  automaticSelectionHint: boards.automaticSelectionHint,
  isGenerated: boards.isGenerated,
  scope: boards.scope,
  instituteId: boards.instituteId,
  createdAt: boards.createdAt,
  updatedAt: boards.updatedAt,
  loadedAt: boards.loadedAt,
} as const;

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
   * The direct boards of SEVERAL students at once, for the picker's
   * "one section per {{student}}" view. Same rule as
   * {@link getStudentBoardsMetadata}, batched: `scope='student'` and an exact
   * studentId match, so package boards (which have a null studentId) cannot
   * leak into anyone's section.
   *
   * The caller proves access to every id it passes — this is a bulk read for a
   * list the caller already resolved, not an access gate of its own.
   */
  async getBoardsForStudents(studentIds: string[]): Promise<BoardWithOptionalIrData[]> {
    if (studentIds.length === 0) return [];
    return await db.select(BOARD_METADATA).from(boards).where(
      and(
        eq(boards.scope, "student"),
        inArray(boards.studentId, studentIds),
      ),
    ).orderBy(asc(boards.name));
  }

  /**
   * Boards owned by an institute that belong to NO student and NO package —
   * the picker's "Not assigned" section.
   *
   * Three shapes land here, and all three are genuinely unattached:
   *   - a student-scoped draft stamped with this institute: what every board
   *     saved with no {{student}} open now becomes
   *   - a package-scoped board of this institute that no package contains any
   *     more (removing a board from its last package must not make it
   *     unreachable — it is still the institute's content)
   *   - a legacy draft from before boards carried an institute (null
   *     instituteId), listed for its AUTHOR only: there is no institute on the
   *     row to authorise anyone else. The next save stamps it.
   */
  async getInstituteUnassignedBoards(
    instituteId: string,
    userId: string,
  ): Promise<BoardWithOptionalIrData[]> {
    const inNoPackage = notExists(
      db.select({ one: sql`1` })
        .from(packageBoards)
        .where(eq(packageBoards.boardId, boards.id)),
    );

    return await db.select(BOARD_METADATA).from(boards).where(
      and(
        isNull(boards.studentId),
        or(
          and(
            eq(boards.scope, "student"),
            or(
              eq(boards.instituteId, instituteId),
              and(isNull(boards.instituteId), eq(boards.userId, userId)),
            ),
          ),
          and(
            eq(boards.scope, "package"),
            eq(boards.instituteId, instituteId),
            inNoPackage,
          ),
        ),
      ),
    ).orderBy(asc(boards.name));
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
   *
   * Ordered by name then id because `buildBoardKeys` assigns collision
   * suffixes (`_2`, `_3`) in INPUT order: without a deterministic sort,
   * Postgres row order decides which board is `x_2` and which is `x_3`, and it
   * can differ between two loads of the same session. Latin names collide
   * rarely enough that this never showed; names in one script that the old
   * ASCII-only `slug` erased collided EVERY time, so the mapping churned. The
   * id tiebreaker covers duplicate names (and non-deterministic collations).
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
      )
      .orderBy(asc(boards.name), asc(boards.id));
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
      .orderBy(asc(packages.name), asc(packageBoards.sortOrder), asc(boards.name), asc(boards.id));

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
