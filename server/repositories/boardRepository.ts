import {
  boards,
  type Board,
  type InsertBoard,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, or, isNull } from "drizzle-orm";

type BoardWithOptionalIrData = Omit<Board, 'irData'> & { irData?: Board['irData'] };

export class BoardRepository {
  // Board CRUD operations
  async createBoard(board: InsertBoard): Promise<Board> {
    const [newBoard] = await db.insert(boards).values(board).returning();
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
      createdAt: boards.createdAt,
      updatedAt: boards.updatedAt,
      loadedAt: boards.loadedAt,
    }).from(boards).where(eq(boards.userId, userId));
  }

  async getStudentBoards(userId: string, studentId: string): Promise<Board[]> {
    // Get boards that are either assigned to this student or have no student assigned (shared boards)
    return await db.select()
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
  }

  async getStudentBoardsMetadata(userId: string, studentId: string): Promise<BoardWithOptionalIrData[]> {
    // Like getStudentBoards but without irData (for dropdown lists)
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
    return await db.select()
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
  }

  async getBoard(id: string): Promise<Board | undefined> {
    const [board] = await db.select().from(boards).where(eq(boards.id, id));
    return board || undefined;
  }

  async updateBoard(
    id: string,
    data: Partial<InsertBoard>
  ): Promise<Board | undefined> {
    const [board] = await db
      .update(boards)
      .set(data)
      .where(eq(boards.id, id))
      .returning();
    return board || undefined;
  }

  async deleteBoard(id: string): Promise<void> {
    await db.delete(boards).where(eq(boards.id, id));
  }
}

export const boardRepository = new BoardRepository();
