import {
  customSymbols,
  userSymbolAssociations,
  studentSymbolAssociations,
  instituteSymbolAssociations,
  instituteStudents,
  type CustomSymbol,
  type InsertCustomSymbol,
  type UpdateCustomSymbol,
  type UserSymbolAssociation,
  type InsertUserSymbolAssociation,
  type UpdateUserSymbolAssociation,
  type StudentSymbolAssociation,
  type InsertStudentSymbolAssociation,
  type UpdateStudentSymbolAssociation,
  type InstituteSymbolAssociation,
  type InsertInstituteSymbolAssociation,
  type UpdateInstituteSymbolAssociation,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, or, ilike, sql, desc } from "drizzle-orm";

/** Resolved symbol with key/description priority applied */
export interface ResolvedSymbol {
  id: string;
  key: string | null;
  description: string | null;
  s3Key: string;
  source: "student" | "institute" | "public";
}

class CustomSymbolRepository {
  // ==================== Symbol CRUD ====================

  async createSymbol(data: InsertCustomSymbol): Promise<CustomSymbol> {
    const [symbol] = await db.insert(customSymbols).values(data).returning();
    return symbol;
  }

  async getSymbol(id: string): Promise<CustomSymbol | undefined> {
    const [symbol] = await db.select().from(customSymbols).where(eq(customSymbols.id, id));
    return symbol;
  }

  async updateSymbol(id: string, data: UpdateCustomSymbol): Promise<CustomSymbol | undefined> {
    const [symbol] = await db.update(customSymbols).set({ ...data, updatedAt: new Date() }).where(eq(customSymbols.id, id)).returning();
    return symbol;
  }

  async deleteSymbol(id: string): Promise<boolean> {
    const result = await db.delete(customSymbols).where(eq(customSymbols.id, id)).returning();
    return result.length > 0;
  }

  // ==================== User Association CRUD ====================

  async createUserAssociation(data: InsertUserSymbolAssociation): Promise<UserSymbolAssociation> {
    const [assoc] = await db.insert(userSymbolAssociations).values(data).returning();
    return assoc;
  }

  async getUserAssociation(id: string): Promise<UserSymbolAssociation | undefined> {
    const [assoc] = await db.select().from(userSymbolAssociations).where(eq(userSymbolAssociations.id, id));
    return assoc;
  }

  async updateUserAssociation(id: string, data: UpdateUserSymbolAssociation): Promise<UserSymbolAssociation | undefined> {
    const [assoc] = await db.update(userSymbolAssociations).set({ ...data, updatedAt: new Date() }).where(eq(userSymbolAssociations.id, id)).returning();
    return assoc;
  }

  async deleteUserAssociation(id: string): Promise<boolean> {
    const result = await db.delete(userSymbolAssociations).where(eq(userSymbolAssociations.id, id)).returning();
    return result.length > 0;
  }

  // ==================== Student Association CRUD ====================

  async createStudentAssociation(data: InsertStudentSymbolAssociation): Promise<StudentSymbolAssociation> {
    const [assoc] = await db.insert(studentSymbolAssociations).values(data).returning();
    return assoc;
  }

  async getStudentAssociation(id: string): Promise<StudentSymbolAssociation | undefined> {
    const [assoc] = await db.select().from(studentSymbolAssociations).where(eq(studentSymbolAssociations.id, id));
    return assoc;
  }

  async updateStudentAssociation(id: string, data: UpdateStudentSymbolAssociation): Promise<StudentSymbolAssociation | undefined> {
    const [assoc] = await db.update(studentSymbolAssociations).set({ ...data, updatedAt: new Date() }).where(eq(studentSymbolAssociations.id, id)).returning();
    return assoc;
  }

  async deleteStudentAssociation(id: string): Promise<boolean> {
    const result = await db.delete(studentSymbolAssociations).where(eq(studentSymbolAssociations.id, id)).returning();
    return result.length > 0;
  }

  // ==================== Institute Association CRUD ====================

  async createInstituteAssociation(data: InsertInstituteSymbolAssociation): Promise<InstituteSymbolAssociation> {
    const [assoc] = await db.insert(instituteSymbolAssociations).values(data).returning();
    return assoc;
  }

  async getInstituteAssociation(id: string): Promise<InstituteSymbolAssociation | undefined> {
    const [assoc] = await db.select().from(instituteSymbolAssociations).where(eq(instituteSymbolAssociations.id, id));
    return assoc;
  }

  async updateInstituteAssociation(id: string, data: UpdateInstituteSymbolAssociation): Promise<InstituteSymbolAssociation | undefined> {
    const [assoc] = await db.update(instituteSymbolAssociations).set({ ...data, updatedAt: new Date() }).where(eq(instituteSymbolAssociations.id, id)).returning();
    return assoc;
  }

  async deleteInstituteAssociation(id: string): Promise<boolean> {
    const result = await db.delete(instituteSymbolAssociations).where(eq(instituteSymbolAssociations.id, id)).returning();
    return result.length > 0;
  }

  // ==================== Queries ====================

  async getSymbolsByUser(userId: string): Promise<(CustomSymbol & { assocKey?: string | null; assocDescription?: string | null; assocId: string })[]> {
    const rows = await db
      .select({
        symbol: customSymbols,
        assocKey: userSymbolAssociations.key,
        assocDescription: userSymbolAssociations.description,
        assocId: userSymbolAssociations.id,
      })
      .from(userSymbolAssociations)
      .innerJoin(customSymbols, eq(userSymbolAssociations.symbolId, customSymbols.id))
      .where(eq(userSymbolAssociations.userId, userId))
      .orderBy(desc(userSymbolAssociations.createdAt));
    return rows.map(r => ({ ...r.symbol, assocKey: r.assocKey, assocDescription: r.assocDescription, assocId: r.assocId }));
  }

  async getSymbolsByStudent(studentId: string): Promise<(CustomSymbol & { assocKey?: string | null; assocDescription?: string | null; assocId: string })[]> {
    const rows = await db
      .select({
        symbol: customSymbols,
        assocKey: studentSymbolAssociations.key,
        assocDescription: studentSymbolAssociations.description,
        assocId: studentSymbolAssociations.id,
      })
      .from(studentSymbolAssociations)
      .innerJoin(customSymbols, eq(studentSymbolAssociations.symbolId, customSymbols.id))
      .where(eq(studentSymbolAssociations.studentId, studentId))
      .orderBy(desc(studentSymbolAssociations.createdAt));
    return rows.map(r => ({ ...r.symbol, assocKey: r.assocKey, assocDescription: r.assocDescription, assocId: r.assocId }));
  }

  async getSymbolsByInstitute(instituteId: string): Promise<(CustomSymbol & { assocKey?: string | null; assocDescription?: string | null; assocId: string })[]> {
    const rows = await db
      .select({
        symbol: customSymbols,
        assocKey: instituteSymbolAssociations.key,
        assocDescription: instituteSymbolAssociations.description,
        assocId: instituteSymbolAssociations.id,
      })
      .from(instituteSymbolAssociations)
      .innerJoin(customSymbols, eq(instituteSymbolAssociations.symbolId, customSymbols.id))
      .where(eq(instituteSymbolAssociations.instituteId, instituteId))
      .orderBy(desc(instituteSymbolAssociations.createdAt));
    return rows.map(r => ({ ...r.symbol, assocKey: r.assocKey, assocDescription: r.assocDescription, assocId: r.assocId }));
  }

  async getPublicSymbols(limit = 50, offset = 0): Promise<CustomSymbol[]> {
    return db.select().from(customSymbols)
      .where(and(eq(customSymbols.isPublic, true), eq(customSymbols.isApproved, true)))
      .orderBy(desc(customSymbols.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async searchSymbols(query: string, limit = 20): Promise<CustomSymbol[]> {
    const pattern = `%${query}%`;
    return db.select().from(customSymbols)
      .where(
        and(
          eq(customSymbols.isApproved, true),
          or(
            ilike(customSymbols.key, pattern),
            ilike(customSymbols.description, pattern),
          ),
        ),
      )
      .orderBy(desc(customSymbols.createdAt))
      .limit(limit);
  }

  async countAllAssociationsForSymbol(symbolId: string): Promise<number> {
    const [userCount] = await db.select({ count: sql<number>`count(*)` }).from(userSymbolAssociations).where(eq(userSymbolAssociations.symbolId, symbolId));
    const [studentCount] = await db.select({ count: sql<number>`count(*)` }).from(studentSymbolAssociations).where(eq(studentSymbolAssociations.symbolId, symbolId));
    const [instituteCount] = await db.select({ count: sql<number>`count(*)` }).from(instituteSymbolAssociations).where(eq(instituteSymbolAssociations.symbolId, symbolId));
    return Number(userCount.count) + Number(studentCount.count) + Number(instituteCount.count);
  }

  /**
   * Get all symbols available to a student (student associations + institute associations + public).
   * Returns resolved symbols with key/description priority: student > institute > public.
   */
  async getAvailableSymbolsForStudent(studentId: string): Promise<ResolvedSymbol[]> {
    const seen = new Set<string>();
    const result: ResolvedSymbol[] = [];

    // 1. Student-specific associations (highest priority)
    const studentRows = await db
      .select({
        id: customSymbols.id,
        s3Key: customSymbols.s3Key,
        symbolKey: customSymbols.key,
        symbolDescription: customSymbols.description,
        assocKey: studentSymbolAssociations.key,
        assocDescription: studentSymbolAssociations.description,
        isApproved: studentSymbolAssociations.isApproved,
      })
      .from(studentSymbolAssociations)
      .innerJoin(customSymbols, eq(studentSymbolAssociations.symbolId, customSymbols.id))
      .where(and(
        eq(studentSymbolAssociations.studentId, studentId),
        eq(studentSymbolAssociations.isApproved, true),
      ));

    for (const row of studentRows) {
      seen.add(row.id);
      result.push({
        id: row.id,
        key: row.assocKey || row.symbolKey,
        description: row.assocDescription || row.symbolDescription,
        s3Key: row.s3Key,
        source: "student",
      });
    }

    // 2. Institute associations (via instituteStudents join)
    const instituteRows = await db
      .select({
        id: customSymbols.id,
        s3Key: customSymbols.s3Key,
        symbolKey: customSymbols.key,
        symbolDescription: customSymbols.description,
        assocKey: instituteSymbolAssociations.key,
        assocDescription: instituteSymbolAssociations.description,
      })
      .from(instituteStudents)
      .innerJoin(instituteSymbolAssociations, eq(instituteStudents.instituteId, instituteSymbolAssociations.instituteId))
      .innerJoin(customSymbols, eq(instituteSymbolAssociations.symbolId, customSymbols.id))
      .where(and(
        eq(instituteStudents.studentId, studentId),
        eq(instituteStudents.isActive, true),
        eq(instituteSymbolAssociations.isApproved, true),
      ));

    for (const row of instituteRows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      result.push({
        id: row.id,
        key: row.assocKey || row.symbolKey,
        description: row.assocDescription || row.symbolDescription,
        s3Key: row.s3Key,
        source: "institute",
      });
    }

    // 3. Public symbols (lowest priority)
    const publicRows = await db
      .select()
      .from(customSymbols)
      .where(and(eq(customSymbols.isPublic, true), eq(customSymbols.isApproved, true)));

    for (const row of publicRows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      result.push({
        id: row.id,
        key: row.key,
        description: row.description,
        s3Key: row.s3Key,
        source: "public",
      });
    }

    return result;
  }
}

export const customSymbolRepository = new CustomSymbolRepository();
