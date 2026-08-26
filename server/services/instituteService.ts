// server/services/instituteService.ts
// Business logic for institute management - WITH EMAIL INTEGRATION
// This file shows the changes needed to integrate email sending

import { instituteRepository } from "../repositories";
import { userRepository } from "../repositories";
import { studentRepository } from "../repositories";
import { emailService } from "./emailService";
import {
  type Institute,
  type InsertInstitute,
  type UpdateInstitute,
  type InstituteUser,
  type InstituteInvite,
  type User,
  type InstituteStudent,
  type Student,
  GradeEnum,
} from "@shared/schema";

export class InstituteService {
  // ==================== Institute Operations ====================

  /**
   * Create a new institute with the creator as admin
   */
  async createInstitute(
    data: InsertInstitute,
    creatorUserId: string
  ): Promise<{ institute: Institute; membership: InstituteUser }> {
    const { institute, link } = await instituteRepository.createInstituteWithAdmin(
      data,
      creatorUserId
    );
    return { institute, membership: link };
  }

  /**
   * Get institute by ID
   */
  async getInstituteById(instituteId: string): Promise<Institute | undefined> {
    return instituteRepository.getInstituteById(instituteId);
  }

  /**
   * Get all institutes for a user
   */
  async getUserInstitutes(userId: string): Promise<Institute[]> {
    return instituteRepository.getInstitutesByUserId(userId);
  }

  /**
   * Get institutes with membership details
   */
  async getUserInstitutesWithMembership(
    userId: string
  ): Promise<{ institute: Institute; membership: InstituteUser }[]> {
    return instituteRepository.getInstitutesWithMembershipByUserId(userId);
  }

  /**
   * Update an institute (requires admin access)
   */
  async updateInstitute(
    instituteId: string,
    updates: UpdateInstitute,
    requestingUserId: string
  ): Promise<{ success: boolean; institute?: Institute; error?: string }> {
    // Verify admin access
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      instituteId,
      requestingUserId
    );
    if (!isAdmin) {
      return { success: false, error: "Only admins can update institute details" };
    }

    const institute = await instituteRepository.updateInstitute(instituteId, updates);
    if (!institute) {
      return { success: false, error: "Institute not found" };
    }

    return { success: true, institute };
  }

  /**
   * Delete an institute (requires admin access)
   */
  async deleteInstitute(
    instituteId: string,
    requestingUserId: string
  ): Promise<{ success: boolean; error?: string }> {
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      instituteId,
      requestingUserId
    );
    if (!isAdmin) {
      return { success: false, error: "Only admins can delete an institute" };
    }

    const deleted = await instituteRepository.deleteInstitute(instituteId);
    return { success: deleted, error: deleted ? undefined : "Failed to delete institute" };
  }

  // ==================== Member Operations ====================

  /**
   * Get all members of an institute
   */
  async getInstituteMembers(
    instituteId: string,
    requestingUserId: string
  ): Promise<{ success: boolean; members?: { user: User; membership: InstituteUser }[]; error?: string }> {
    // Verify membership
    const isMember = await instituteRepository.isUserMemberOfInstitute(
      instituteId,
      requestingUserId
    );
    if (!isMember) {
      return { success: false, error: "You are not a member of this institute" };
    }

    const members = await instituteRepository.getInstituteMembers(instituteId);
    return { success: true, members };
  }

  /**
   * Update a member's role or admin status
   */
  async updateMember(
    instituteId: string,
    targetUserId: string,
    updates: { role?: string; isAdmin?: boolean },
    requestingUserId: string
  ): Promise<{ success: boolean; membership?: InstituteUser; error?: string }> {
    // Verify admin access
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      instituteId,
      requestingUserId
    );
    if (!isAdmin) {
      return { success: false, error: "Only admins can update member roles" };
    }

    // Prevent self-demotion from admin (must have at least one admin)
    if (targetUserId === requestingUserId && updates.isAdmin === false) {
      const members = await instituteRepository.getInstituteMembers(instituteId);
      const adminCount = members.filter((m) => m.membership.isAdmin).length;
      if (adminCount <= 1) {
        return { success: false, error: "Cannot remove the last admin" };
      }
    }

    const membership = await instituteRepository.updateMembershipByIds(
      instituteId,
      targetUserId,
      updates
    );
    if (!membership) {
      return { success: false, error: "Member not found" };
    }

    return { success: true, membership };
  }

  /**
   * Remove a member from an institute
   */
  async removeMember(
    instituteId: string,
    targetUserId: string,
    requestingUserId: string
  ): Promise<{ success: boolean; error?: string }> {
    // Verify admin access
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      instituteId,
      requestingUserId
    );
    if (!isAdmin) {
      return { success: false, error: "Only admins can remove members" };
    }

    // Prevent self-removal if last admin
    if (targetUserId === requestingUserId) {
      const members = await instituteRepository.getInstituteMembers(instituteId);
      const adminCount = members.filter((m) => m.membership.isAdmin).length;
      if (adminCount <= 1) {
        return { success: false, error: "Cannot remove the last admin" };
      }
    }

    const removed = await instituteRepository.removeUserFromInstitute(
      instituteId,
      targetUserId
    );
    if (removed) {
      // Termination must end access NOW, not when the cookie expires (up to
      // 30 days): evict every live session the removed member holds. They
      // re-authenticate; the removed institute is simply no longer theirs.
      const { deleteUserSessions } = await import("./sessionInvalidation");
      await deleteUserSessions(targetUserId);
    }
    return { success: removed, error: removed ? undefined : "Failed to remove member" };
  }

  /**
   * Leave an institute (self-removal)
   */
  async leaveInstitute(
    instituteId: string,
    userId: string
  ): Promise<{ success: boolean; error?: string }> {
    // Check if user is the last admin
    const membership = await instituteRepository.getInstituteUserLink(
      instituteId,
      userId
    );
    if (!membership) {
      return { success: false, error: "You are not a member of this institute" };
    }

    if (membership.isAdmin) {
      const members = await instituteRepository.getInstituteMembers(instituteId);
      const adminCount = members.filter((m) => m.membership.isAdmin).length;
      if (adminCount <= 1) {
        return {
          success: false,
          error: "You are the last admin. Please assign another admin before leaving.",
        };
      }
    }

    const removed = await instituteRepository.removeUserFromInstitute(
      instituteId,
      userId
    );
    return { success: removed, error: removed ? undefined : "Failed to leave institute" };
  }

  // ==================== Invite Operations ====================

  /**
   * Send an invite to join an institute
   * NOW WITH EMAIL NOTIFICATION
   */
  async sendInvite(
    instituteId: string,
    inviteeEmail: string,
    invitedByUserId: string,
    options: {
      role?: string;
      grantAdmin?: boolean;
      message?: string;
    } = {},
    baseUrl: string = "https://aivota.ai" // Pass this from the controller
  ): Promise<{ success: boolean; invite?: InstituteInvite; error?: string }> {
    // Verify admin access
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      instituteId,
      invitedByUserId
    );
    if (!isAdmin) {
      return { success: false, error: "Only admins can send invites" };
    }

    // Check if user is already a member
    const existingUser = await userRepository.getUserByEmail(inviteeEmail);
    if (existingUser) {
      const isMember = await instituteRepository.isUserMemberOfInstitute(
        instituteId,
        existingUser.id
      );
      if (isMember) {
        return { success: false, error: "This user is already a member of the institute" };
      }
    }

    const invite = await instituteRepository.createInvite(
      instituteId,
      inviteeEmail,
      invitedByUserId,
      options
    );

    // ========== EMAIL INTEGRATION ==========
    // Send invite email notification
    try {
      const institute = await instituteRepository.getInstituteById(instituteId);
      const inviter = await userRepository.getUser(invitedByUserId);

      if (institute) {
        const inviteLink = this.getInviteLink(invite.token, baseUrl);
        
        const emailResult = await emailService.sendInstituteInvite({
          inviteeEmail: invite.inviteeEmail,
          instituteName: institute.name,
          instituteType: institute.type,
          inviterName: inviter?.fullName || inviter?.firstName || undefined,
          role: invite.role,
          isAdmin: invite.grantAdmin,
          message: invite.message || undefined,
          inviteLink,
          expiresAt: invite.expiresAt,
          language: institute.language || undefined,
        });

        if (!emailResult.success) {
          console.warn(`Failed to send invite email to ${inviteeEmail}:`, emailResult.error);
          // Note: We don't fail the invite if email fails - invite is still valid
        }
      }
    } catch (emailError) {
      console.error("Error sending invite email:", emailError);
      // Don't fail the invite creation if email fails
    }
    // ========== END EMAIL INTEGRATION ==========

    return { success: true, invite };
  }

  /**
   * Get all invites for an institute (admin only)
   */
  async getInstituteInvites(
    instituteId: string,
    requestingUserId: string
  ): Promise<{ success: boolean; invites?: InstituteInvite[]; error?: string }> {
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      instituteId,
      requestingUserId
    );
    if (!isAdmin) {
      return { success: false, error: "Only admins can view invites" };
    }

    const invites = await instituteRepository.getInstituteInvites(instituteId);
    return { success: true, invites };
  }

  /**
   * Get pending invites for a user
   */
  async getUserPendingInvites(
    userId: string,
    email: string
  ): Promise<
    { invite: InstituteInvite; institute: Institute; invitedBy: User | null }[]
  > {
    return instituteRepository.getPendingInvitesForUser(userId, email);
  }

  /**
   * Get invite details by token (for invite signup page)
   */
  async getInviteByToken(
    token: string
  ): Promise<{
    success: boolean;
    invite?: InstituteInvite;
    institute?: Institute;
    invitedBy?: User | null;
    error?: string;
  }> {
    const result = await instituteRepository.getInviteWithDetails(token);
    
    if (!result) {
      return { success: false, error: "Invite not found" };
    }

    if (result.invite.status !== "pending") {
      return { success: false, error: "This invite is no longer valid" };
    }

    if (new Date() > result.invite.expiresAt) {
      return { success: false, error: "This invite has expired" };
    }

    return {
      success: true,
      invite: result.invite,
      institute: result.institute,
      invitedBy: result.invitedBy,
    };
  }

  /**
   * Accept an invite
   */
  async acceptInvite(
    inviteId: string,
    userId: string,
    userType?: string
  ): Promise<{ success: boolean; membership?: InstituteUser; error?: string }> {
    return instituteRepository.acceptInvite(inviteId, userId, userType);
  }

  /**
   * Accept an invite by token (for new users signing up via invite)
   */
  async acceptInviteByToken(
    token: string,
    userId: string,
    userType?: string
  ): Promise<{ success: boolean; membership?: InstituteUser; institute?: Institute; error?: string }> {
    const invite = await instituteRepository.getInviteByToken(token);

    if (!invite) {
      return { success: false, error: "Invite not found" };
    }

    const result = await instituteRepository.acceptInvite(invite.id, userId, userType);
    
    if (result.success) {
      const institute = await instituteRepository.getInstituteById(invite.instituteId);
      return { ...result, institute };
    }

    return result;
  }

  /**
   * Decline an invite
   */
  async declineInvite(
    inviteId: string,
    userId: string
  ): Promise<{ success: boolean; error?: string }> {
    const invite = await instituteRepository.getInviteById(inviteId);
    
    if (!invite) {
      return { success: false, error: "Invite not found" };
    }

    // Verify the user is the invitee
    if (invite.inviteeUserId !== userId && invite.inviteeEmail !== (await userRepository.getUser(userId))?.email) {
      return { success: false, error: "You cannot decline this invite" };
    }

    const declined = await instituteRepository.declineInvite(inviteId);
    return { success: declined, error: declined ? undefined : "Failed to decline invite" };
  }

  /**
   * Cancel an invite (admin action)
   */
  async cancelInvite(
    inviteId: string,
    requestingUserId: string
  ): Promise<{ success: boolean; error?: string }> {
    const invite = await instituteRepository.getInviteById(inviteId);
    
    if (!invite) {
      return { success: false, error: "Invite not found" };
    }

    // Verify admin access
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      invite.instituteId,
      requestingUserId
    );
    if (!isAdmin) {
      return { success: false, error: "Only admins can cancel invites" };
    }

    const cancelled = await instituteRepository.cancelInvite(inviteId);
    return { success: cancelled, error: cancelled ? undefined : "Failed to cancel invite" };
  }

  /**
   * Resend an invite (creates a new one with fresh token)
   * NOW WITH EMAIL NOTIFICATION
   */
  async resendInvite(
    inviteId: string,
    requestingUserId: string,
    baseUrl: string = "https://aivota.ai"
  ): Promise<{ success: boolean; invite?: InstituteInvite; error?: string }> {
    const oldInvite = await instituteRepository.getInviteById(inviteId);
    
    if (!oldInvite) {
      return { success: false, error: "Invite not found" };
    }

    // Verify admin access
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      oldInvite.instituteId,
      requestingUserId
    );
    if (!isAdmin) {
      return { success: false, error: "Only admins can resend invites" };
    }

    // Create a new invite (this will cancel the old one)
    const invite = await instituteRepository.createInvite(
      oldInvite.instituteId,
      oldInvite.inviteeEmail,
      requestingUserId,
      {
        role: oldInvite.role,
        grantAdmin: oldInvite.grantAdmin,
        message: oldInvite.message || undefined,
      }
    );

    // ========== EMAIL INTEGRATION ==========
    // Send invite email notification
    try {
      const institute = await instituteRepository.getInstituteById(oldInvite.instituteId);
      const inviter = await userRepository.getUser(requestingUserId);

      if (institute) {
        const inviteLink = this.getInviteLink(invite.token, baseUrl);
        
        const emailResult = await emailService.sendInstituteInvite({
          inviteeEmail: invite.inviteeEmail,
          instituteName: institute.name,
          instituteType: institute.type,
          inviterName: inviter?.fullName || inviter?.firstName || undefined,
          role: invite.role,
          isAdmin: invite.grantAdmin,
          message: invite.message || undefined,
          inviteLink,
          expiresAt: invite.expiresAt,
          language: institute.language || undefined,
        });

        if (!emailResult.success) {
          console.warn(`Failed to send invite email to ${invite.inviteeEmail}:`, emailResult.error);
        }
      }
    } catch (emailError) {
      console.error("Error sending invite email:", emailError);
    }
    // ========== END EMAIL INTEGRATION ==========

    return { success: true, invite };
  }

  // ==================== Utility Methods ====================

  /**
   * Check if user has access to institute
   */
  async verifyMembership(
    instituteId: string,
    userId: string
  ): Promise<{ isMember: boolean; isAdmin: boolean; membership?: InstituteUser }> {
    const membership = await instituteRepository.getInstituteUserLink(
      instituteId,
      userId
    );

    if (!membership || !membership.isActive) {
      return { isMember: false, isAdmin: false };
    }

    return {
      isMember: true,
      isAdmin: membership.isAdmin,
      membership,
    };
  }

  /**
   * Generate invite link
   */
  getInviteLink(token: string, baseUrl: string = ""): string {
    return `${baseUrl}/invite/${token}`;
  }

  /**
   * Resolve student access for an error-bearing caller, distinguishing
   * "no such student" from "exists but you lack access". The old code returned
   * "You do not have access to this student" for BOTH, which was misleading —
   * e.g. when an AI referenced a stale/placeholder id that doesn't resolve to
   * any student, the message implied a permissions problem rather than a bad id.
   * (UUID keyspace isn't enumerable, so distinguishing the two leaks nothing useful.)
   */
  private async checkStudentAccess(
    requestingUserId: string,
    studentId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const access = await studentRepository.userHasAccessToStudent(requestingUserId, studentId);
    if (access.hasAccess) return { ok: true };
    const exists = await studentRepository.getStudentById(studentId);
    return {
      ok: false,
      error: exists
        ? "You do not have access to this student"
        : `No student found with id "${studentId}"`,
    };
  }

  /**
   * Assign a student to an institute
   * For schools: automatically handles the "one active school" rule
   */
  async assignStudentToInstitute(
    instituteId: string,
    studentId: string,
    requestingUserId: string,
    options: {
      enrollmentDate?: string;
      idNumber?: string;
      grade?: string;
    } = {}
  ): Promise<{ success: boolean; enrollment?: InstituteStudent; error?: string }> {
    // Verify the institute exists
    const institute = await instituteRepository.getInstituteById(instituteId);
    if (!institute) {
      return { success: false, error: "Institute not found" };
    }

    // Verify the requesting user is a member of this institute
    const isMember = await instituteRepository.isUserMemberOfInstitute(
      instituteId,
      requestingUserId
    );
    if (!isMember) {
      return { success: false, error: "You must be a member of this institute to assign students" };
    }

    // Verify the student exists and the user has access
    const access = await this.checkStudentAccess(requestingUserId, studentId);
    if (!access.ok) {
      console.log(`assignStudentToInstitute: ${access.error} (user ${requestingUserId}, student ${studentId})`);
      return { success: false, error: access.error };
    }

    // For schools, check if student already has an active school
    if (institute.type === 'school') {
      const currentSchool = await instituteRepository.getActiveSchoolForStudent(studentId);
      if (currentSchool && currentSchool.institute.id !== instituteId) {
        // Student is already in another school - this will be deactivated automatically
        console.log(`Student ${studentId} transferring from ${currentSchool.institute.name} to ${institute.name}`);
      }
    }

    const enrollment = await instituteRepository.assignStudentToInstitute(
      instituteId,
      studentId,
      options
    );

    return { success: true, enrollment };
  }

  /**
   * Get all students in an institute
   */
  async getInstituteStudents(
    instituteId: string,
    requestingUserId: string
  ): Promise<{ success: boolean; students?: { student: Student; enrollment: InstituteStudent }[]; error?: string }> {
    // Verify membership
    const isMember = await instituteRepository.isUserMemberOfInstitute(
      instituteId,
      requestingUserId
    );
    if (!isMember) {
      return { success: false, error: "You are not a member of this institute" };
    }

    const students = await instituteRepository.getStudentsInInstitute(instituteId);
    return { success: true, students };
  }

  /**
   * Get all institutes a student belongs to
   */
  async getStudentInstitutes(
    studentId: string,
    requestingUserId: string
  ): Promise<{ success: boolean; institutes?: { institute: Institute; enrollment: InstituteStudent }[]; error?: string }> {
    // Verify the user has access to this student
    const access = await this.checkStudentAccess(requestingUserId, studentId);
    if (!access.ok) {
      return { success: false, error: access.error };
    }

    const institutes = await instituteRepository.getInstitutesByStudentId(studentId);
    return { success: true, institutes };
  }

  /**
   * Update a student's institute enrollment
   */
  async updateStudentEnrollment(
    instituteId: string,
    studentId: string,
    updates: {
      // null is a real value here, not a placeholder for "unset": the panel
      // sends it to CLEAR the field. undefined means "leave alone" (drizzle's
      // .set() skips it), which is why the two can't be collapsed.
      idNumber?: string | null;
      grade?: GradeEnum | null;
    },
    requestingUserId: string
  ): Promise<{ success: boolean; enrollment?: InstituteStudent; error?: string }> {
    // Verify membership
    const isMember = await instituteRepository.isUserMemberOfInstitute(
      instituteId,
      requestingUserId
    );
    if (!isMember) {
      return { success: false, error: "You are not a member of this institute" };
    }

    const enrollment = await instituteRepository.updateInstituteStudentByIds(
      instituteId,
      studentId,
      updates
    );
    if (!enrollment) {
      return { success: false, error: "Student is not enrolled in this institute" };
    }

    return { success: true, enrollment };
  }

  /**
   * Remove a student from an institute
   */
  async removeStudentFromInstitute(
    instituteId: string,
    studentId: string,
    requestingUserId: string,
    exitReason?: string
  ): Promise<{ success: boolean; error?: string }> {
    // Verify admin access or student ownership. Admins can remove any enrolled
    // student; otherwise the caller needs access to the student (and we surface
    // a "no such student" error when the id doesn't resolve at all).
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      instituteId,
      requestingUserId
    );
    if (!isAdmin) {
      const access = await this.checkStudentAccess(requestingUserId, studentId);
      if (!access.ok) {
        return { success: false, error: access.error };
      }
    }

    const removed = await instituteRepository.removeStudentFromInstitute(
      instituteId,
      studentId,
      exitReason
    );

    return { success: removed, error: removed ? undefined : "Failed to remove student" };
  }

  /**
   * Get the active school for a student
   */
  async getActiveSchoolForStudent(
    studentId: string,
    requestingUserId: string
  ): Promise<{ success: boolean; school?: { institute: Institute; enrollment: InstituteStudent }; error?: string }> {
    // Verify the user has access to this student
    const access = await this.checkStudentAccess(requestingUserId, studentId);
    if (!access.ok) {
      return { success: false, error: access.error };
    }

    const school = await instituteRepository.getActiveSchoolForStudent(studentId);
    return { success: true, school };
  }

  /**
   * Check if a student is enrolled in an institute
   */
  async isStudentInInstitute(
    instituteId: string,
    studentId: string
  ): Promise<boolean> {
    return instituteRepository.isStudentInInstitute(instituteId, studentId);
  }
}

export const instituteService = new InstituteService();
