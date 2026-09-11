// server/repositories/instituteRepository.ts
// Repository for institute management operations

import { getActiveSupportInstituteId } from "../services/customerSupportService";
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
import { hydrateRecords } from "../external-storage";

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
   * Get all institutes a user belongs to.
   * In customer support mode, returns only the support institute.
   */
  async getInstitutesByUserId(userId: string): Promise<Institute[]> {
    // In support mode, only return the support institute
    const supportId = getActiveSupportInstituteId();
    if (supportId) {
      const inst = await this.getInstituteById(supportId);
      return inst ? [inst] : [];
    }

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
   * Get institutes with user's membership details.
   *
   * ⚠️ A LIST, not a predicate. "May this user act in institute X" is
   * {@link isUserMemberOfInstitute}; do NOT answer it with `.some(i => i.id === x)`
   * over this or {@link getInstitutesByUserId} — that was two of the six
   * implementations the 2026-09-10 audit counted, and one of them had acquired
   * a `|| user.isAdmin` platform-flag bypass (finding F9).
   *
   * Note the two lists differ on support mode by design:
   * `getInstitutesByUserId` REPLACES the list with the support institute (that
   * is what scopes a support session's UI), while this one always reports the
   * user's real memberships — the AI's institute-ref resolver needs the names
   * the user actually has.
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
    isAdmin: boolean = false,
    userType?: string
  ): Promise<InstituteUser> {
    // Check if membership already exists
    const existing = await this.getInstituteUserLink(instituteId, userId);

    if (existing) {
      // Reactivate if inactive
      if (!existing.isActive) {
        const [updated] = await db
          .update(instituteUsers)
          .set({ isActive: true, role, isAdmin, ...(userType ? { userType } : {}), updatedAt: new Date() })
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
        ...(userType ? { userType } : {}),
        isActive: true,
      })
      .returning();
    return link;
  }

  /**
   * Get the link between a user and an institute — ACTIVE OR NOT.
   *
   * ⚠️ This is a row accessor, not an authorization predicate. Removal from an
   * institute is a SOFT delete (`removeUserFromInstitute` → `isActive: false`),
   * so `!!getInstituteUserLink(...)` admits terminated staff. That was audit
   * finding C9 (2026-09-10): `locationService` and `calendarService` used the
   * row raw as a boolean and a removed member kept read/write on the
   * institute's locations and edit/delete on its calendar events, contradicting
   * SECURITY_ARCHITECTURE §5.6.
   *
   * To ask "may this user act here", use {@link isUserMemberOfInstitute} /
   * {@link isUserAdminOfInstitute}. To ask "does this OTHER person hold a real
   * membership row" (grantee checks, roster display), use
   * {@link getActiveMembership}, which is deliberately support-blind.
   */
  async getInstituteUserLink(
    instituteId: string,
    userId: string
  ): Promise<InstituteUser | undefined> {
    // A nullish id must never widen the query — see `isSupportSessionFor`.
    if (!instituteId || !userId) return undefined;
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
   * The ACTIVE membership row, or undefined.
   *
   * The third-party membership question — "does this user hold a live
   * `institute_users` row in this institute" — as opposed to the caller
   * authorization question the two predicates below answer. It is deliberately
   * blind to customer-support mode: a support session is break-glass over an
   * INSTITUTE, and must not make an arbitrary *other* user look like a member
   * (e.g. `packageController.addGrant`, where a grant must land on a real
   * member, or the AI's roster reads).
   */
  async getActiveMembership(
    instituteId: string,
    userId: string
  ): Promise<InstituteUser | undefined> {
    const link = await this.getInstituteUserLink(instituteId, userId);
    return link && link.isActive ? link : undefined;
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

  // ==================== The institute authorization predicate pair ====================
  //
  // `isUserMemberOfInstitute` and `isUserAdminOfInstitute` are THE answer to
  // "may this user act in this institute". Everything else that used to answer
  // it — a raw `getInstituteUserLink` truthiness test, a
  // `getInstitutesByUserId().some(...)` scan, `instituteService.verifyMembership`
  // reading the row itself — now routes through this pair (2026-09-10
  // authorization structural pass, phase 1). Both check `isActive`; both are
  // customer-support aware; both are nullish-safe.

  /**
   * Is there an ACTIVE customer-support session over exactly this institute?
   *
   * 🚨 This guard is the reason the check lives in a named helper rather than
   * inline. `getActiveSupportInstituteId()` returns `undefined` outside a
   * support session, so the naive form —
   * `if (getActiveSupportInstituteId() === instituteId) return true` — is
   * `undefined === undefined`, i.e. **true**, for any caller that passes a
   * nullish institute id. That is precisely how the 2026-04 consent escalation
   * worked (SECURITY_ARCHITECTURE §2.4): `PUT /api/consent/students/:id/authority`
   * handed `undefined` to `isUserAdminOfInstitute` and every authenticated
   * caller received institute-admin rights.
   *
   * The audit (finding F12) checked all call sites and found none that can pass
   * `undefined` today — but every one of them was safe only by an ad-hoc
   * truthiness guard somewhere up the stack, while the signature says
   * `instituteId: string`, so `tsc` had no reason to object and the first caller
   * to forward an optional property re-arms it. Making it structurally
   * impossible is therefore the fix, not auditing callers again.
   */
  private isSupportSessionFor(instituteId: string): boolean {
    if (!instituteId) return false;
    const supportId = getActiveSupportInstituteId();
    return !!supportId && supportId === instituteId;
  }

  /** Public form of {@link isSupportSessionFor} — see `instituteService.verifyMembership`. */
  isCustomerSupportSessionFor(instituteId: string): boolean {
    return this.isSupportSessionFor(instituteId);
  }

  /**
   * Check if user is admin of an institute.
   * Returns true automatically if the user is in customer support mode for this institute.
   * A nullish institute or user id is ALWAYS false, support session or not.
   */
  async isUserAdminOfInstitute(
    instituteId: string,
    userId: string
  ): Promise<boolean> {
    if (!instituteId || !userId) return false;
    // Customer support agents are always admin of their support institute
    if (this.isSupportSessionFor(instituteId)) return true;
    const link = await this.getActiveMembership(instituteId, userId);
    return !!(link && link.isAdmin);
  }

  /**
   * Check if user is member of an institute.
   * Returns true automatically if the user is in customer support mode for this institute.
   * A nullish institute or user id is ALWAYS false, support session or not.
   */
  async isUserMemberOfInstitute(
    instituteId: string,
    userId: string
  ): Promise<boolean> {
    if (!instituteId || !userId) return false;
    // Customer support agents are always members of their support institute
    if (this.isSupportSessionFor(instituteId)) return true;
    return !!(await this.getActiveMembership(instituteId, userId));
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
    userId: string,
    userType?: string
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
      invite.grantAdmin,
      userType
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

    // Hydrate student data
    const studentRows = results.map(r => r.student);
    const hydrated = await hydrateRecords("students", studentRows);
    return results.map((r, i) => ({ ...r, student: hydrated[i] }));
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

  /**
   * Get all active institutes (for admin use)
   */
  async getAllActiveInstitutes(): Promise<Institute[]> {
    return await db
      .select()
      .from(institutes)
      .where(eq(institutes.isActive, true))
      .orderBy(institutes.name);
  }

  /**
   * Get institute IDs for a user (lightweight version for filtering)
   */
  async getInstituteIdsByUserId(userId: string): Promise<string[]> {
    const results = await db
      .select({ id: institutes.id })
      .from(instituteUsers)
      .innerJoin(institutes, eq(instituteUsers.instituteId, institutes.id))
      .where(
        and(
          eq(instituteUsers.userId, userId),
          eq(instituteUsers.isActive, true),
          eq(institutes.isActive, true)
        )
      );
    return results.map((r) => r.id);
  }
}

export const instituteRepository = new InstituteRepository();
