// server/repositories/instituteRepository.ts
// Repository for institute management operations

import {
  institutes,
  instituteUsers,
  instituteInvites,
  users,
  type Institute,
  type InsertInstitute,
  type UpdateInstitute,
  type InstituteUser,
  type InsertInstituteUser,
  type UpdateInstituteUser,
  type InstituteInvite,
  type InsertInstituteInvite,
  type UpdateInstituteInvite,
  type User,
  instituteStudents,
  students,
  type InstituteStudent,
  type InsertInstituteStudent,
  type UpdateInstituteStudent,
  type Student,
  GradeEnum
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc, or, sql, lt, ne } from "drizzle-orm";
import crypto from "crypto";

export class InstituteRepository {
  // ==================== Institute Operations ====================

  /**
   * Create a new institute
   */
  async createInstitute(insert: InsertInstitute): Promise<Institute> {
    const [institute] = await db
      .insert(institutes)
      .values(insert)
      .returning();
    return institute;
  }

  /**
   * Create an institute and link the creator as admin
   */
  async createInstituteWithAdmin(
    insert: InsertInstitute,
    userId: string
  ): Promise<{ institute: Institute; link: InstituteUser }> {
    return await db.transaction(async (tx) => {
      // Create the institute
      const [institute] = await tx
        .insert(institutes)
        .values(insert)
        .returning();

      // Link the creator as admin
      const [link] = await tx
        .insert(instituteUsers)
        .values({
          instituteId: institute.id,
          userId,
          isAdmin: true,
          role: "admin",
          isActive: true,
        })
        .returning();

      return { institute, link };
    });
  }

  /**
   * Get an institute by ID
   */
  async getInstituteById(id: string): Promise<Institute | undefined> {
    const [institute] = await db
      .select()
      .from(institutes)
      .where(eq(institutes.id, id));
    return institute || undefined;
  }

  /**
   * Get all institutes a user belongs to
   */
  async getInstitutesByUserId(userId: string): Promise<Institute[]> {
    const results = await db
      .select({ institute: institutes })
      .from(instituteUsers)
      .innerJoin(institutes, eq(instituteUsers.instituteId, institutes.id))
      .where(
        and(
          eq(instituteUsers.userId, userId),
          eq(instituteUsers.isActive, true),
          eq(institutes.isActive, true)
        )
      )
      .orderBy(desc(institutes.createdAt));

    return results.map((r) => r.institute);
  }

  /**
   * Get institutes with user's membership details
   */
  async getInstitutesWithMembershipByUserId(
    userId: string
  ): Promise<{ institute: Institute; membership: InstituteUser }[]> {
    const results = await db
      .select({
        institute: institutes,
        membership: instituteUsers,
      })
      .from(instituteUsers)
      .innerJoin(institutes, eq(instituteUsers.instituteId, institutes.id))
      .where(
        and(
          eq(instituteUsers.userId, userId),
          eq(instituteUsers.isActive, true),
          eq(institutes.isActive, true)
        )
      )
      .orderBy(desc(institutes.createdAt));

    return results;
  }

  /**
   * Update an institute
   */
  async updateInstitute(
    id: string,
    updates: UpdateInstitute
  ): Promise<Institute | undefined> {
    const [updated] = await db
      .update(institutes)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(institutes.id, id))
      .returning();
    return updated || undefined;
  }

  /**
   * Soft delete an institute
   */
  async deleteInstitute(id: string): Promise<boolean> {
    const [updated] = await db
      .update(institutes)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(institutes.id, id))
      .returning();
    return !!updated;
  }

  // ==================== Institute User (Membership) Operations ====================

  /**
   * Add a user to an institute
   */
  async addUserToInstitute(
    instituteId: string,
    userId: string,
    role: string = "staff",
    isAdmin: boolean = false
  ): Promise<InstituteUser> {
    // Check if membership already exists
    const existing = await this.getInstituteUserLink(instituteId, userId);
    
    if (existing) {
      // Reactivate if inactive
      if (!existing.isActive) {
        const [updated] = await db
          .update(instituteUsers)
          .set({ isActive: true, role, isAdmin, updatedAt: new Date() })
          .where(eq(instituteUsers.id, existing.id))
          .returning();
        return updated;
      }
      return existing;
    }

    const [link] = await db
      .insert(instituteUsers)
      .values({
        instituteId,
        userId,
        role,
        isAdmin,
        isActive: true,
      })
      .returning();
    return link;
  }

  /**
   * Get the link between a user and an institute
   */
  async getInstituteUserLink(
    instituteId: string,
    userId: string
  ): Promise<InstituteUser | undefined> {
    const [link] = await db
      .select()
      .from(instituteUsers)
      .where(
        and(
          eq(instituteUsers.instituteId, instituteId),
          eq(instituteUsers.userId, userId)
        )
      );
    return link || undefined;
  }

  /**
   * Get all members of an institute
   */
  async getInstituteMembers(
    instituteId: string
  ): Promise<{ user: User; membership: InstituteUser }[]> {
    const results = await db
      .select({
        user: users,
        membership: instituteUsers,
      })
      .from(instituteUsers)
      .innerJoin(users, eq(instituteUsers.userId, users.id))
      .where(
        and(
          eq(instituteUsers.instituteId, instituteId),
          eq(instituteUsers.isActive, true)
        )
      )
      .orderBy(desc(instituteUsers.isAdmin), users.fullName);

    return results;
  }

  /**
   * Update a user's membership in an institute
   */
  async updateInstituteUserLink(
    id: string,
    updates: UpdateInstituteUser
  ): Promise<InstituteUser | undefined> {
    const [updated] = await db
      .update(instituteUsers)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(instituteUsers.id, id))
      .returning();
    return updated || undefined;
  }

  /**
   * Update membership by institute and user IDs
   */
  async updateMembershipByIds(
    instituteId: string,
    userId: string,
    updates: UpdateInstituteUser
  ): Promise<InstituteUser | undefined> {
    const [updated] = await db
      .update(instituteUsers)
      .set({ ...updates, updatedAt: new Date() })
      .where(
        and(
          eq(instituteUsers.instituteId, instituteId),
          eq(instituteUsers.userId, userId)
        )
      )
      .returning();
    return updated || undefined;
  }

  /**
   * Remove a user from an institute (soft delete)
   */
  async removeUserFromInstitute(
    instituteId: string,
    userId: string
  ): Promise<boolean> {
    const [updated] = await db
      .update(instituteUsers)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(instituteUsers.instituteId, instituteId),
          eq(instituteUsers.userId, userId)
        )
      )
      .returning();
    return !!updated;
  }

  /**
   * Check if user is admin of an institute
   */
  async isUserAdminOfInstitute(
    instituteId: string,
    userId: string
  ): Promise<boolean> {
    const link = await this.getInstituteUserLink(instituteId, userId);
    return !!(link && link.isActive && link.isAdmin);
  }

  /**
   * Check if user is member of an institute
   */
  async isUserMemberOfInstitute(
    instituteId: string,
    userId: string
  ): Promise<boolean> {
    const link = await this.getInstituteUserLink(instituteId, userId);
    return !!(link && link.isActive);
  }

  // ==================== Invite Operations ====================

  /**
   * Generate a unique invite token
   */
  generateInviteToken(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  /**
   * Create an invite
   */
  async createInvite(
    instituteId: string,
    inviteeEmail: string,
    invitedByUserId: string,
    options: {
      role?: string;
      grantAdmin?: boolean;
      message?: string;
      expiresInDays?: number;
    } = {}
  ): Promise<InstituteInvite> {
    const {
      role = "staff",
      grantAdmin = false,
      message,
      expiresInDays = 7,
    } = options;

    // Check if invitee already has an account
    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, inviteeEmail.toLowerCase()));

    // Check for existing pending invite
    const existingInvite = await this.getPendingInviteByEmail(
      instituteId,
      inviteeEmail
    );
    if (existingInvite) {
      // Cancel the old invite
      await this.updateInvite(existingInvite.id, { status: "cancelled" });
    }

    const token = this.generateInviteToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    const [invite] = await db
      .insert(instituteInvites)
      .values({
        instituteId,
        inviteeEmail: inviteeEmail.toLowerCase(),
        inviteeUserId: existingUser?.id || null,
        invitedByUserId,
        role,
        grantAdmin,
        message,
        token,
        status: "pending",
        expiresAt,
      })
      .returning();

    return invite;
  }

  /**
   * Get an invite by token
   */
  async getInviteByToken(token: string): Promise<InstituteInvite | undefined> {
    const [invite] = await db
      .select()
      .from(instituteInvites)
      .where(eq(instituteInvites.token, token));
    return invite || undefined;
  }

  /**
   * Get an invite by ID
   */
  async getInviteById(id: string): Promise<InstituteInvite | undefined> {
    const [invite] = await db
      .select()
      .from(instituteInvites)
      .where(eq(instituteInvites.id, id));
    return invite || undefined;
  }

  /**
   * Get pending invite for an email in an institute
   */
  async getPendingInviteByEmail(
    instituteId: string,
    email: string
  ): Promise<InstituteInvite | undefined> {
    const [invite] = await db
      .select()
      .from(instituteInvites)
      .where(
        and(
          eq(instituteInvites.instituteId, instituteId),
          eq(instituteInvites.inviteeEmail, email.toLowerCase()),
          eq(instituteInvites.status, "pending")
        )
      );
    return invite || undefined;
  }

  /**
   * Get all invites for an institute
   */
  async getInstituteInvites(instituteId: string): Promise<InstituteInvite[]> {
    return await db
      .select()
      .from(instituteInvites)
      .where(eq(instituteInvites.instituteId, instituteId))
      .orderBy(desc(instituteInvites.createdAt));
  }

  /**
   * Get pending invites for a user (by email or user ID)
   */
  async getPendingInvitesForUser(
    userId: string,
    email: string
  ): Promise<
    { invite: InstituteInvite; institute: Institute; invitedBy: User | null }[]
  > {
    const results = await db
      .select({
        invite: instituteInvites,
        institute: institutes,
        invitedBy: users,
      })
      .from(instituteInvites)
      .innerJoin(institutes, eq(instituteInvites.instituteId, institutes.id))
      .leftJoin(users, eq(instituteInvites.invitedByUserId, users.id))
      .where(
        and(
          or(
            eq(instituteInvites.inviteeUserId, userId),
            eq(instituteInvites.inviteeEmail, email.toLowerCase())
          ),
          eq(instituteInvites.status, "pending"),
          sql`${instituteInvites.expiresAt} > NOW()`
        )
      )
      .orderBy(desc(instituteInvites.createdAt));

    return results;
  }

  /**
   * Update an invite
   */
  async updateInvite(
    id: string,
    updates: UpdateInstituteInvite
  ): Promise<InstituteInvite | undefined> {
    const [updated] = await db
      .update(instituteInvites)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(instituteInvites.id, id))
      .returning();
    return updated || undefined;
  }

  /**
   * Accept an invite - adds user to institute
   */
  async acceptInvite(
    inviteId: string,
    userId: string
  ): Promise<{ success: boolean; membership?: InstituteUser; error?: string }> {
    const invite = await this.getInviteById(inviteId);

    if (!invite) {
      return { success: false, error: "Invite not found" };
    }

    if (invite.status !== "pending") {
      return { success: false, error: "Invite is no longer valid" };
    }

    if (new Date() > invite.expiresAt) {
      await this.updateInvite(inviteId, { status: "expired" });
      return { success: false, error: "Invite has expired" };
    }

    // Check if user is already a member
    const existingMembership = await this.getInstituteUserLink(
      invite.instituteId,
      userId
    );
    if (existingMembership && existingMembership.isActive) {
      await this.updateInvite(inviteId, {
        status: "accepted",
        respondedAt: new Date(),
      });
      return { success: true, membership: existingMembership };
    }

    // Add user to institute
    const membership = await this.addUserToInstitute(
      invite.instituteId,
      userId,
      invite.role,
      invite.grantAdmin
    );

    // Mark invite as accepted
    await this.updateInvite(inviteId, {
      status: "accepted",
      respondedAt: new Date(),
      inviteeUserId: userId,
    });

    return { success: true, membership };
  }

  /**
   * Decline an invite
   */
  async declineInvite(inviteId: string): Promise<boolean> {
    const updated = await this.updateInvite(inviteId, {
      status: "declined",
      respondedAt: new Date(),
    });
    return !!updated;
  }

  /**
   * Cancel an invite (admin action)
   */
  async cancelInvite(inviteId: string): Promise<boolean> {
    const updated = await this.updateInvite(inviteId, {
      status: "cancelled",
    });
    return !!updated;
  }

  /**
   * Expire old pending invites (cleanup job)
   */
  async expireOldInvites(): Promise<number> {
    const result = await db
      .update(instituteInvites)
      .set({ status: "expired", updatedAt: new Date() })
      .where(
        and(
          eq(instituteInvites.status, "pending"),
          lt(instituteInvites.expiresAt, new Date())
        )
      )
      .returning();
    return result.length;
  }

  /**
   * Get invite with full details (institute and inviter info)
   */
  async getInviteWithDetails(
    token: string
  ): Promise<{
    invite: InstituteInvite;
    institute: Institute;
    invitedBy: User | null;
  } | null> {
    const [result] = await db
      .select({
        invite: instituteInvites,
        institute: institutes,
        invitedBy: users,
      })
      .from(instituteInvites)
      .innerJoin(institutes, eq(instituteInvites.instituteId, institutes.id))
      .leftJoin(users, eq(instituteInvites.invitedByUserId, users.id))
      .where(eq(instituteInvites.token, token));

    return result || null;
  }

    /**
   * Assign a student to an institute
   * For schools: automatically deactivates any existing school assignment
   */
  async assignStudentToInstitute(
    instituteId: string,
    studentId: string,
    options: {
      enrollmentDate?: string;
      idNumber?: string;
      grade?: string;
    } = {}
  ): Promise<InstituteStudent> {
    const { enrollmentDate, idNumber, grade } = options;
    
    // Check if assignment already exists
    const existing = await this.getInstituteStudentLink(instituteId, studentId);
    
    if (existing) {
      // Reactivate if inactive
      if (!existing.isActive) {
        const [updated] = await db
          .update(instituteStudents)
          .set({
            isActive: true,
            enrollmentDate: enrollmentDate || existing.enrollmentDate,
            idNumber: idNumber || existing.idNumber,
            grade: grade as GradeEnum || existing.grade,
            exitDate: null,
            exitReason: null,
            updatedAt: new Date(),
          })
          .where(eq(instituteStudents.id, existing.id))
          .returning();
        return updated;
      }
      // Update existing active assignment
      const [updated] = await db
        .update(instituteStudents)
        .set({
          enrollmentDate: enrollmentDate || existing.enrollmentDate,
          idNumber: idNumber || existing.idNumber,
          grade: grade as GradeEnum || existing.grade,
          updatedAt: new Date(),
        })
        .where(eq(instituteStudents.id, existing.id))
        .returning();
      return updated;
    }

    // Get institute type to check school constraint
    const institute = await this.getInstituteById(instituteId);
    
    // If it's a school, deactivate other school assignments
    // (This is also handled by database trigger, but we do it here for safety)
    if (institute?.type === 'school') {
      await this.deactivateStudentSchoolAssignments(studentId, instituteId);
    }

    const [link] = await db
      .insert(instituteStudents)
      .values({
        instituteId,
        studentId,
        enrollmentDate: enrollmentDate || null,
        idNumber: idNumber || null,
        grade: grade as GradeEnum || null,
        isActive: true,
      })
      .returning();
    return link;
  }

  /**
   * Deactivate all school assignments for a student except the specified one
   */
  async deactivateStudentSchoolAssignments(
    studentId: string,
    exceptInstituteId?: string
  ): Promise<number> {
    // First get all school institute IDs
    const schoolInstitutes = await db
      .select({ id: institutes.id })
      .from(institutes)
      .where(eq(institutes.type, 'school'));
    
    const schoolIds = schoolInstitutes.map(s => s.id);
    if (schoolIds.length === 0) return 0;

    // Deactivate assignments to schools
    let count = 0;
    for (const schoolId of schoolIds) {
      if (schoolId === exceptInstituteId) continue;
      
      const [updated] = await db
        .update(instituteStudents)
        .set({
          isActive: false,
          exitDate: new Date().toISOString().split('T')[0],
          exitReason: 'transferred',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(instituteStudents.studentId, studentId),
            eq(instituteStudents.instituteId, schoolId),
            eq(instituteStudents.isActive, true)
          )
        )
        .returning();
      
      if (updated) count++;
    }
    
    return count;
  }

  /**
   * Get the link between a student and an institute
   */
  async getInstituteStudentLink(
    instituteId: string,
    studentId: string
  ): Promise<InstituteStudent | undefined> {
    const [link] = await db
      .select()
      .from(instituteStudents)
      .where(
        and(
          eq(instituteStudents.instituteId, instituteId),
          eq(instituteStudents.studentId, studentId)
        )
      );
    return link || undefined;
  }

  /**
   * Get active link between a student and an institute
   */
  async getActiveInstituteStudentLink(
    instituteId: string,
    studentId: string
  ): Promise<InstituteStudent | undefined> {
    const [link] = await db
      .select()
      .from(instituteStudents)
      .where(
        and(
          eq(instituteStudents.instituteId, instituteId),
          eq(instituteStudents.studentId, studentId),
          eq(instituteStudents.isActive, true)
        )
      );
    return link || undefined;
  }

  /**
   * Get all students in an institute
   */
  async getStudentsInInstitute(
    instituteId: string
  ): Promise<{ student: Student; enrollment: InstituteStudent }[]> {
    const results = await db
      .select({
        student: students,
        enrollment: instituteStudents,
      })
      .from(instituteStudents)
      .innerJoin(students, eq(instituteStudents.studentId, students.id))
      .where(
        and(
          eq(instituteStudents.instituteId, instituteId),
          eq(instituteStudents.isActive, true),
          eq(students.isActive, true)
        )
      )
      .orderBy(students.name);

    return results;
  }

  /**
   * Get all institutes a student belongs to
   */
  async getInstitutesByStudentId(
    studentId: string
  ): Promise<{ institute: Institute; enrollment: InstituteStudent }[]> {
    const results = await db
      .select({
        institute: institutes,
        enrollment: instituteStudents,
      })
      .from(instituteStudents)
      .innerJoin(institutes, eq(instituteStudents.instituteId, institutes.id))
      .where(
        and(
          eq(instituteStudents.studentId, studentId),
          eq(instituteStudents.isActive, true),
          eq(institutes.isActive, true)
        )
      )
      .orderBy(institutes.name);

    return results;
  }

  /**
   * Get all institutes (including inactive relationships) for a student
   */
  async getAllInstitutesByStudentId(
    studentId: string
  ): Promise<{ institute: Institute; enrollment: InstituteStudent }[]> {
    const results = await db
      .select({
        institute: institutes,
        enrollment: instituteStudents,
      })
      .from(instituteStudents)
      .innerJoin(institutes, eq(instituteStudents.instituteId, institutes.id))
      .where(
        and(
          eq(instituteStudents.studentId, studentId),
          eq(institutes.isActive, true)
        )
      )
      .orderBy(desc(instituteStudents.isActive), institutes.name);

    return results;
  }

  /**
   * Get the active school for a student (should be at most one)
   */
  async getActiveSchoolForStudent(
    studentId: string
  ): Promise<{ institute: Institute; enrollment: InstituteStudent } | undefined> {
    const [result] = await db
      .select({
        institute: institutes,
        enrollment: instituteStudents,
      })
      .from(instituteStudents)
      .innerJoin(institutes, eq(instituteStudents.instituteId, institutes.id))
      .where(
        and(
          eq(instituteStudents.studentId, studentId),
          eq(instituteStudents.isActive, true),
          eq(institutes.type, 'school'),
          eq(institutes.isActive, true)
        )
      );

    return result || undefined;
  }

  /**
   * Update a student's institute assignment
   */
  async updateInstituteStudentLink(
    id: string,
    updates: UpdateInstituteStudent
  ): Promise<InstituteStudent | undefined> {
    const [updated] = await db
      .update(instituteStudents)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(instituteStudents.id, id))
      .returning();
    return updated || undefined;
  }

  /**
   * Update student institute link by IDs
   */
  async updateInstituteStudentByIds(
    instituteId: string,
    studentId: string,
    updates: UpdateInstituteStudent
  ): Promise<InstituteStudent | undefined> {
    const [updated] = await db
      .update(instituteStudents)
      .set({ ...updates, updatedAt: new Date() })
      .where(
        and(
          eq(instituteStudents.instituteId, instituteId),
          eq(instituteStudents.studentId, studentId)
        )
      )
      .returning();
    return updated || undefined;
  }

  /**
   * Remove a student from an institute (soft delete)
   */
  async removeStudentFromInstitute(
    instituteId: string,
    studentId: string,
    exitReason?: string
  ): Promise<boolean> {
    const [updated] = await db
      .update(instituteStudents)
      .set({
        isActive: false,
        exitDate: new Date().toISOString().split('T')[0],
        exitReason: exitReason || 'removed',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(instituteStudents.instituteId, instituteId),
          eq(instituteStudents.studentId, studentId)
        )
      )
      .returning();
    return !!updated;
  }

  /**
   * Check if a student is enrolled in an institute
   */
  async isStudentInInstitute(
    instituteId: string,
    studentId: string
  ): Promise<boolean> {
    const link = await this.getActiveInstituteStudentLink(instituteId, studentId);
    return !!link;
  }
}

export const instituteRepository = new InstituteRepository();
