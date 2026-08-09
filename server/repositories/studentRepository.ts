import {
  students,
  aacSettings,
  userStudents,
  instituteStudents,
  studentClassrooms,
  classroomUsers,
  institutes,
  instituteUsers,
  users,
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
import { mergeBudgetState, type BudgetState, type BudgetWindow } from "@shared/aac/budget-meter";
import { instituteRepository } from "./instituteRepository";
import { personRepository } from "./personRepository";
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
    // Provision the person row up front (the chat/call membership identity).
    void personRepository.getOrCreateForStudent(student.id).catch(() => {});
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

    // Provision the person row up front (the chat/call membership identity).
    void personRepository.getOrCreateForStudent(result.student.id).catch(() => {});

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
   * The persisted multi-window budget-meter state, read fresh from the DB.
   * Coordinators MUST load through this rather than a cached student snapshot:
   * a reconnect-resume's cached row predates the session's own spend, and
   * seeding the meter from it reset the budget to ~full on every re-init.
   */
  async getBudgetMeters(studentId: string): Promise<BudgetState | null> {
    const [row] = await db
      .select({ budgetMeters: students.budgetMeters })
      .from(students)
      .where(eq(students.id, studentId));
    return (row?.budgetMeters as BudgetState | null) ?? null;
  }

  /**
   * Persist the multi-window budget-meter state (leaky-bucket {drain,asOf} per
   * window). MERGES with the stored row under a row lock — per window the
   * higher regen-normalized drain wins — instead of overwriting, so a save
   * from a stale base (reconnect-resumed coordinator, late teardown flush,
   * concurrent session) can never erase drain accumulated by another writer.
   * Best-effort: a failure is logged but never breaks the live session — the
   * in-memory meter keeps governing; only cross-session continuity is at
   * risk. Not sensitive, so it bypasses the external-storage extraction path.
   * See planning-docs/aac-budget-tiers-spec.md §7.
   */
  async updateBudgetMeters(
    studentId: string,
    state: BudgetState,
    windows: BudgetWindow[],
  ): Promise<void> {
    try {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ budgetMeters: students.budgetMeters })
          .from(students)
          .where(eq(students.id, studentId))
          .for("update");
        const merged = mergeBudgetState(
          row?.budgetMeters as BudgetState | null,
          state,
          windows,
          Date.now(),
        );
        await tx.update(students).set({ budgetMeters: merged }).where(eq(students.id, studentId));
      });
    } catch (err) {
      console.error(`[StudentRepository] updateBudgetMeters(${studentId}) failed:`, err);
    }
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
   * Get all active AAC users enrolled in a given institute, with AAC settings.
   * Admin-only view (Licenses → students budget management) — no per-user
   * visibility joins. Student rows are hydrated so externalized name fields
   * are populated for display.
   */
  async getStudentsWithAacSettingsByInstituteId(
    instituteId: string
  ): Promise<StudentWithAacSettings[]> {
    const rows = await db
      .selectDistinctOn([students.id], { student: students, aac: aacSettings })
      .from(instituteStudents)
      .innerJoin(students, eq(instituteStudents.studentId, students.id))
      .leftJoin(aacSettings, eq(students.id, aacSettings.studentId))
      .where(
        and(
          eq(instituteStudents.instituteId, instituteId),
          eq(instituteStudents.isActive, true),
          eq(students.isActive, true)
        )
      )
      .orderBy(students.id, desc(students.createdAt));

    const hydrated = await hydrateRecords(
      "students",
      rows.map((r) => r.student)
    );
    return hydrated.map((student, i) => ({
      ...student,
      aacSettings: rows[i].aac,
    }));
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
   *      OR the institute is a family
   *      OR the user is an admin of the institute — including customer support)
   */
  async getStudentsForUserInInstitute(
    userId: string,
    instituteId: string
  ): Promise<{ student: Student; link: UserStudent | null }[]> {
    // Check admin status upfront (accounts for customer support via AsyncLocalStorage)
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(instituteId, userId);

    // Admins see all students in the institute — simpler query, no visibility joins needed
    if (isAdmin) {
      const rows = await db
        .selectDistinctOn([students.id], {
          student: students,
          link: userStudents,
        })
        .from(instituteStudents)
        .innerJoin(students, eq(instituteStudents.studentId, students.id))
        .leftJoin(
          userStudents,
          and(
            eq(userStudents.studentId, students.id),
            eq(userStudents.userId, userId),
            eq(userStudents.isActive, true)
          )
        )
        .where(
          and(
            eq(instituteStudents.instituteId, instituteId),
            eq(instituteStudents.isActive, true),
            eq(students.isActive, true)
          )
        )
        .orderBy(students.id, desc(students.createdAt));

      return rows.map((r) => ({ student: r.student, link: r.link ?? null }));
    }

    // Non-admins: check direct assignment, shared classroom, or family institute
    const rows = await db
      .selectDistinctOn([students.id], {
        student: students,
        link: userStudents,
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
      .orderBy(students.id, desc(students.createdAt));

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

  /**
   * Get all users who share at least one active institute with the given student.
   * Used to populate the "assign users" picker on services — any such user is a
   * valid candidate to be on a student's service team.
   */
  async getUsersSharingInstituteWithStudent(studentId: string): Promise<{
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    fullName: string | null;
    profileImageUrl: string | null;
    biometricDataId: string | null;
  }[]> {
    const rows = await db
      .selectDistinctOn([users.id], {
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        fullName: users.fullName,
        profileImageUrl: users.profileImageUrl,
        biometricDataId: users.biometricDataId,
      })
      .from(instituteStudents)
      .innerJoin(
        instituteUsers,
        and(
          eq(instituteUsers.instituteId, instituteStudents.instituteId),
          eq(instituteUsers.isActive, true)
        )
      )
      .innerJoin(users, eq(users.id, instituteUsers.userId))
      .where(
        and(
          eq(instituteStudents.studentId, studentId),
          eq(instituteStudents.isActive, true)
        )
      );
    return rows;
  }
}

export const studentRepository = new StudentRepository();