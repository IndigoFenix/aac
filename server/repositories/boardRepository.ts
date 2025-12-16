import {
  boards,
  type Board,
  type InsertBoard,
} from "@shared/schema";
import { db } from "../db";
import { eq } from "drizzle-orm";

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
      name: boards.name,
      imageUrl: boards.imageUrl,
      description: boards.description,
      createdAt: boards.createdAt,
      updatedAt: boards.updatedAt,
      loadedAt: boards.loadedAt,
    }).from(boards).where(eq(boards.userId, userId));
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
