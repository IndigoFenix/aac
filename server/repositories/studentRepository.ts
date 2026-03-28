import {
  students,
  aacSettings,
  userStudents,
  instituteStudents,
  studentClassrooms,
  classroomUsers,
  institutes,
  type Student,
  type InsertStudent,
  type UpdateStudent,
  type StudentWithAacSettings,
  type UserStudent,
  type InsertUserStudent,
  type UpdateUserStudent,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc, or, isNotNull, sql } from "drizzle-orm";
import {
  hydrateRecords,
  extractSensitiveFields,
  persistExtracted,
  deleteExternalData,
  type EntityRef,
} from "../external-storage";

export class StudentRepository {
  private ref(id: string): EntityRef {
    return { type: "student", id };
  }

  // ==================== AAC User Operations ====================

  /**
   * Create a new AAC user (without linking to any user)
   */
  async createStudent(insertStudent: InsertStudent): Promise<Student> {
    const [student] = await db
      .insert(students)
      .values(insertStudent)
      .returning();
    const ref = this.ref(student.id);
    const ext = await extractSensitiveFields("students", student.id, student as Record<string, unknown>, ref);
    if (ext.isExternal) {
      const nullSet: Record<string, null> = {};
      for (const key of ext.externalWrites.keys()) {
        const field = key.split("/").pop()!;
        nullSet[field] = null;
      }
      await db.update(students).set(nullSet).where(eq(students.id, student.id));
      await persistExtracted(ref, ext.externalWrites);
    }
    return ext.completeData as Student;
  }

  /**
   * Create an AAC user and link it to a user in a single transaction
   */
  async createStudentWithLink(
    insertStudent: InsertStudent,
    userId: string,
    role: string = "owner"
  ): Promise<{ student: Student; link: UserStudent }> {
    const result = await db.transaction(async (tx) => {
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

    // External writes happen AFTER transaction commit
    const ref = this.ref(result.student.id);
    const ext = await extractSensitiveFields("students", result.student.id, result.student as Record<string, unknown>, ref);
    if (ext.isExternal) {
      const nullSet: Record<string, null> = {};
      for (const key of ext.externalWrites.keys()) {
        const field = key.split("/").pop()!;
        nullSet[field] = null;
      }
      await db.update(students).set(nullSet).where(eq(students.id, result.student.id));
      await persistExtracted(ref, ext.externalWrites);
    }
    return { student: ext.completeData as Student, link: result.link };
  }

  /**
   * Get an AAC user by their primary key ID
   */
  async getStudentById(id: string): Promise<Student | undefined> {
    const [student] = await db
      .select()
      .from(students)
      .where(eq(students.id, id));
    if (!student) return undefined;
    const [hydrated] = await hydrateRecords("students", [student]);
    return hydrated;
  }

  /**
   * Get an AAC user with their AAC settings (LEFT JOIN)
   */
  async getStudentWithAacSettings(id: string): Promise<StudentWithAacSettings | undefined> {
    const rows = await db
      .select({ student: students, aac: aacSettings })
      .from(students)
      .leftJoin(aacSettings, eq(students.id, aacSettings.studentId))
      .where(eq(students.id, id));
    if (!rows.length) return undefined;
    const { student, aac } = rows[0];
    return { ...student, aacSettings: aac };
  }

  /**
   * Get all AAC users linked to a specific user, with AAC settings
   */
  async getStudentsWithAacSettingsByUserId(
    userId: string
  ): Promise<StudentWithAacSettings[]> {
    const results = await db
      .select({ student: students, aac: aacSettings })
      .from(userStudents)
      .innerJoin(students, eq(userStudents.studentId, students.id))
      .leftJoin(aacSettings, eq(students.id, aacSettings.studentId))
      .where(
        and(
          eq(userStudents.userId, userId),
          eq(userStudents.isActive, true),
          eq(students.isActive, true)
        )
      )
      .orderBy(desc(students.createdAt));
    return results.map((r) => ({ ...r.student, aacSettings: r.aac }));
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

    const rows = results.map((r) => r.student);
    return hydrateRecords("students", rows);
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
    const ref = this.ref(id);
    const ext = await extractSensitiveFields("students", id, updates as Record<string, unknown>, ref);
    const [updated] = await db
      .update(students)
      .set({ ...ext.dbData, updatedAt: new Date() })
      .where(eq(students.id, id))
      .returning();
    if (!updated) return undefined;
    if (ext.isExternal) await persistExtracted(ref, ext.externalWrites);
    const [hydrated] = await hydrateRecords("students", [updated]);
    return hydrated;
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
    if (updated) {
      await deleteExternalData("students", id, this.ref(id));
    }
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

  // ==================== Institute-Scoped Student Queries ====================

  /**
   * Get students visible to a user within a specific institute.
   * A student is visible if:
   *   - They are actively enrolled in the institute, AND
   *   - (They are directly assigned to the user via userStudents
   *      OR they share a classroom with the user
   *      OR the institute is a family)
   */
  async getStudentsForUserInInstitute(
    userId: string,
    instituteId: string
  ): Promise<{ student: Student; link: UserStudent | null }[]> {
    const rows = await db
      .selectDistinctOn([students.id], {
        student: students,
        link: userStudents,
        hasClassroomLink: sql<boolean>`CASE WHEN ${classroomUsers.id} IS NOT NULL THEN true ELSE false END`.as('has_classroom_link'),
        isFamily: sql<boolean>`CASE WHEN ${institutes.type} = 'family' THEN true ELSE false END`.as('is_family'),
      })
      .from(instituteStudents)
      .innerJoin(students, eq(instituteStudents.studentId, students.id))
      .innerJoin(institutes, eq(instituteStudents.instituteId, institutes.id))
      .leftJoin(
        userStudents,
        and(
          eq(userStudents.studentId, students.id),
          eq(userStudents.userId, userId),
          eq(userStudents.isActive, true)
        )
      )
      .leftJoin(
        studentClassrooms,
        and(
          eq(studentClassrooms.studentId, students.id),
          eq(studentClassrooms.isActive, true)
        )
      )
      .leftJoin(
        classroomUsers,
        and(
          eq(classroomUsers.classroomId, studentClassrooms.classroomId),
          eq(classroomUsers.userId, userId),
          eq(classroomUsers.isActive, true)
        )
      )
      .where(
        and(
          eq(instituteStudents.instituteId, instituteId),
          eq(instituteStudents.isActive, true),
          eq(students.isActive, true),
          or(
            isNotNull(userStudents.id),        // directly assigned
            isNotNull(classroomUsers.id),       // shares a classroom
            sql`${institutes.type} = 'family'`  // family institute
          )
        )
      )
      .orderBy(desc(students.createdAt));

    return rows.map((r) => ({
      student: r.student,
      link: r.link ?? null,
    }));
  }

  // ==================== Legacy Compatibility Methods ====================
  // These methods are provided for backward compatibility during migration

  /**
   * @deprecated Use getStudentById instead
   */
  async getStudentByStudentId(studentId: string): Promise<Student | undefined> {
    return this.getStudentById(studentId);
  }
}

export const studentRepository = new StudentRepository();