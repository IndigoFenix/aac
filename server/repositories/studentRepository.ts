import {
  students,
  studentSchedules,
  userStudents,
  type Student,
  type InsertStudent,
  type UpdateStudent,
  type StudentSchedule,
  type InsertStudentSchedule,
  type UpdateStudentSchedule,
  type UserStudent,
  type InsertUserStudent,
  type UpdateUserStudent,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, lte, gte, desc, sql } from "drizzle-orm";

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
  ): Promise<boolean> {
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
    return !!link;
  }

  // ==================== AAC User Schedule Operations ====================

  /**
   * Create a schedule entry for an AAC user
   */
  async createScheduleEntry(schedule: InsertStudentSchedule): Promise<StudentSchedule> {
    const [entry] = await db
      .insert(studentSchedules)
      .values(schedule)
      .returning();
    return entry;
  }

  /**
   * Get all schedules for an AAC user
   */
  async getSchedulesByStudentId(studentId: string): Promise<StudentSchedule[]> {
    return await db
      .select()
      .from(studentSchedules)
      .where(eq(studentSchedules.studentId, studentId))
      .orderBy(studentSchedules.startTime);
  }

  /**
   * Get a specific schedule entry by ID
   */
  async getScheduleEntry(id: string): Promise<StudentSchedule | undefined> {
    const [entry] = await db
      .select()
      .from(studentSchedules)
      .where(eq(studentSchedules.id, id));
    return entry || undefined;
  }

  /**
   * Update a schedule entry
   */
  async updateScheduleEntry(
    id: string,
    updates: UpdateStudentSchedule
  ): Promise<StudentSchedule | undefined> {
    const [updated] = await db
      .update(studentSchedules)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(studentSchedules.id, id))
      .returning();
    return updated || undefined;
  }

  /**
   * Delete a schedule entry
   */
  async deleteScheduleEntry(id: string): Promise<boolean> {
    const result = await db
      .delete(studentSchedules)
      .where(eq(studentSchedules.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get the current schedule context for an AAC user based on a timestamp
   */
  async getCurrentScheduleContext(
    studentId: string,
    timestamp: Date
  ): Promise<{
    activityName: string | null;
    topicTags: string[] | null;
  }> {
    const dayOfWeek = timestamp.getDay();
    const timeString = timestamp.toTimeString().substring(0, 5);

    const [schedule] = await db
      .select()
      .from(studentSchedules)
      .where(
        and(
          eq(studentSchedules.studentId, studentId),
          eq(studentSchedules.isActive, true),
          sql`${studentSchedules.dayOfWeek} = ${dayOfWeek}`,
          lte(studentSchedules.startTime, timeString),
          gte(studentSchedules.endTime, timeString)
        )
      )
      .limit(1);

    if (schedule) {
      return {
        activityName: schedule.activityName,
        topicTags: schedule.topicTags,
      };
    }

    return { activityName: null, topicTags: null };
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