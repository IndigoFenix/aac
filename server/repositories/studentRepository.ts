import {
  students,
  userStudents,
  type Student,
  type InsertStudent,
  type UpdateStudent,
  type UserStudent,
  type InsertUserStudent,
  type UpdateUserStudent,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc } from "drizzle-orm";

export class StudentRepository {
  // ==================== AAC User Operations ====================

  /**
   * Create a new AAC user (without linking to any user)
   */
  async createStudent(insertStudent: InsertStudent): Promise<Student> {
    const [student] = await db
      .insert(students)
      .values(insertStudent)
      .returning();
    return student;
  }

  /**
   * Create an AAC user and link it to a user in a single transaction
   */
  async createStudentWithLink(
    insertStudent: InsertStudent,
    userId: string,
    role: string = "owner"
  ): Promise<{ student: Student; link: UserStudent }> {
    return await db.transaction(async (tx) => {
      // Create the AAC user
      const [student] = await tx
        .insert(students)
        .values(insertStudent)
        .returning();

      // Create the link
      const [link] = await tx
        .insert(userStudents)
        .values({
          userId,
          studentId: student.id,
          role,
          isActive: true,
        })
        .returning();

      return { student, link };
    });
  }

  /**
   * Get an AAC user by their primary key ID
   */
  async getStudentById(id: string): Promise<Student | undefined> {
    const [student] = await db
      .select()
      .from(students)
      .where(eq(students.id, id));
    return student || undefined;
  }

  /**
   * Get all AAC users linked to a specific user
   */
  async getStudentsByUserId(userId: string): Promise<Student[]> {
    const results = await db
      .select({
        student: students,
      })
      .from(userStudents)
      .innerJoin(students, eq(userStudents.studentId, students.id))
      .where(
        and(
          eq(userStudents.userId, userId),
          eq(userStudents.isActive, true),
          eq(students.isActive, true)
        )
      )
      .orderBy(desc(students.createdAt));

    return results.map((r) => r.student);
  }

  /**
   * Get all AAC users linked to a specific user with link details
   */
  async getStudentsWithLinksByUserId(
    userId: string
  ): Promise<{ student: Student; link: UserStudent }[]> {
    const results = await db
      .select({
        student: students,
        link: userStudents,
      })
      .from(userStudents)
      .innerJoin(students, eq(userStudents.studentId, students.id))
      .where(
        and(
          eq(userStudents.userId, userId),
          eq(userStudents.isActive, true),
          eq(students.isActive, true)
        )
      )
      .orderBy(desc(students.createdAt));

    return results;
  }

  /**
   * Update an AAC user
   */
  async updateStudent(id: string, updates: UpdateStudent): Promise<Student | undefined> {
    const [updated] = await db
      .update(students)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(students.id, id))
      .returning();
    return updated || undefined;
  }

  /**
   * Soft delete an AAC user (sets isActive to false)
   */
  async deleteStudent(id: string): Promise<boolean> {
    const [updated] = await db
      .update(students)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(students.id, id))
      .returning();
    return !!updated;
  }

  // ==================== User-AAC User Link Operations ====================

  /**
   * Create a link between a user and an AAC user
   */
  async createUserStudentLink(link: InsertUserStudent): Promise<UserStudent> {
    const [created] = await db
      .insert(userStudents)
      .values(link)
      .returning();
    return created;
  }

  /**
   * Get a specific link by user ID and AAC user ID
   */
  async getUserStudentLink(
    userId: string,
    studentId: string
  ): Promise<UserStudent | undefined> {
    const [link] = await db
      .select()
      .from(userStudents)
      .where(
        and(
          eq(userStudents.userId, userId),
          eq(userStudents.studentId, studentId)
        )
      );
    return link || undefined;
  }

  /**
   * Get all users linked to an AAC user
   */
  async getUsersByStudentId(studentId: string): Promise<UserStudent[]> {
    return await db
      .select()
      .from(userStudents)
      .where(
        and(
          eq(userStudents.studentId, studentId),
          eq(userStudents.isActive, true)
        )
      );
  }

  /**
   * Update a user-AAC user link
   */
  async updateUserStudentLink(
    id: string,
    updates: UpdateUserStudent
  ): Promise<UserStudent | undefined> {
    const [updated] = await db
      .update(userStudents)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(userStudents.id, id))
      .returning();
    return updated || undefined;
  }

  /**
   * Deactivate a link between a user and an AAC user
   */
  async deactivateUserStudentLink(
    userId: string,
    studentId: string
  ): Promise<boolean> {
    const [updated] = await db
      .update(userStudents)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(userStudents.userId, userId),
          eq(userStudents.studentId, studentId)
        )
      )
      .returning();
    return !!updated;
  }

  /**
   * Check if a user has access to an AAC user
   */
  async userHasAccessToStudent(
    userId: string,
    studentId: string
  ): Promise<{ hasAccess: boolean; link?: UserStudent }> {
    const [link] = await db
      .select()
      .from(userStudents)
      .where(
        and(
          eq(userStudents.userId, userId),
          eq(userStudents.studentId, studentId),
          eq(userStudents.isActive, true)
        )
      );
    return { hasAccess: !!link, link: link || undefined };
  }

  // ==================== Legacy Compatibility Methods ====================
  // These methods are provided for backward compatibility during migration

  /**
   * @deprecated Use getStudentById instead
   */
  async getStudentByStudentId(studentId: string): Promise<Student | undefined> {
    // During migration period, this might still be called with old studentId values
    // First try to find by id (new system)
    const byId = await this.getStudentById(studentId);
    if (byId) return byId;
    
    // Fallback: the studentId might actually be an id
    return undefined;
  }
}

export const studentRepository = new StudentRepository();