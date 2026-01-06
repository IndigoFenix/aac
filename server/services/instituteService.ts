// server/services/instituteService.ts
// Business logic for institute management - WITH EMAIL INTEGRATION
// This file shows the changes needed to integrate email sending

import { instituteRepository } from "../repositories";
import { userRepository } from "../repositories";
import { emailService } from "./emailService"; // ADD THIS IMPORT
import {
  type Institute,
  type InsertInstitute,
  type UpdateInstitute,
  type InstituteUser,
  type InstituteInvite,
  type User,
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
    baseUrl: string = "https://cliniaacian.com" // Pass this from the controller
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
    userId: string
  ): Promise<{ success: boolean; membership?: InstituteUser; error?: string }> {
    return instituteRepository.acceptInvite(inviteId, userId);
  }

  /**
   * Accept an invite by token (for new users signing up via invite)
   */
  async acceptInviteByToken(
    token: string,
    userId: string
  ): Promise<{ success: boolean; membership?: InstituteUser; institute?: Institute; error?: string }> {
    const invite = await instituteRepository.getInviteByToken(token);
    
    if (!invite) {
      return { success: false, error: "Invite not found" };
    }

    const result = await instituteRepository.acceptInvite(invite.id, userId);
    
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
    baseUrl: string = "https://cliniaacian.com"
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
}

export const instituteService = new InstituteService();
