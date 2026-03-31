import {
  boards,
  type Board,
  type InsertBoard,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, or, isNull } from "drizzle-orm";
import {
  hydrateRecords,
  extractSensitiveFields,
  persistExtracted,
  deleteExternalData,
  resolveEntityRef,
} from "../external-storage";

type BoardWithOptionalIrData = Omit<Board, 'irData'> & { irData?: Board['irData'] };

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
      createdAt: boards.createdAt,
      updatedAt: boards.updatedAt,
      loadedAt: boards.loadedAt,
    }).from(boards).where(eq(boards.userId, userId));
  }

  async getStudentBoards(userId: string, studentId: string): Promise<Board[]> {
    const rows = await db.select()
      .from(boards)
      .where(
        and(
          eq(boards.userId, userId),
          or(
            eq(boards.studentId, studentId),
            isNull(boards.studentId)
          )
        )
      );
    return hydrateRecords("boards", rows, { type: "student", id: studentId });
  }

  async getStudentBoardsMetadata(userId: string, studentId: string): Promise<BoardWithOptionalIrData[]> {
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
      createdAt: boards.createdAt,
      updatedAt: boards.updatedAt,
      loadedAt: boards.loadedAt,
    }).from(boards).where(
      and(
        eq(boards.userId, userId),
        or(
          eq(boards.studentId, studentId),
          isNull(boards.studentId)
        )
      )
    );
  }

  async getAutoSelectableBoards(userId: string, studentId: string): Promise<Board[]> {
    const rows = await db.select()
      .from(boards)
      .where(
        and(
          eq(boards.userId, userId),
          eq(boards.automaticSelection, true),
          or(
            eq(boards.studentId, studentId),
            isNull(boards.studentId)
          )
        )
      );
    return hydrateRecords("boards", rows, { type: "student", id: studentId });
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
