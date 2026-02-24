// server/controllers/instituteController.ts
// HTTP handlers for institute management

import type { Request, Response } from "express";
import { instituteService, userService } from "../services";
import { insertInstituteSchema } from "@shared/schema";
import { emailService } from "server/services/emailService";

export class InstituteController {
  // ==================== Institute CRUD ====================

  /**
   * GET /api/institutes
   * Get all institutes for the current user
   */
  async getInstitutes(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      
      const institutesWithMembership = await instituteService.getUserInstitutesWithMembership(
        currentUser.id
      );
      
      res.json({
        success: true,
        institutes: institutesWithMembership.map(({ institute, membership }) => ({
          ...institute,
          isAdmin: membership.isAdmin,
          role: membership.role,
          membershipId: membership.id,
        })),
      });
    } catch (error: any) {
      console.error("Error fetching institutes:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch institutes",
      });
    }
  }

  /**
   * GET /api/institutes/:id
   * Get a specific institute
   */
  async getInstitute(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const instituteId = req.params.id;

      // Verify membership
      const { isMember, isAdmin, membership } = await instituteService.verifyMembership(
        instituteId,
        currentUser.id
      );

      if (!isMember) {
        res.status(403).json({
          success: false,
          message: "You are not a member of this institute",
        });
        return;
      }

      const institute = await instituteService.getInstituteById(instituteId);
      if (!institute) {
        res.status(404).json({
          success: false,
          message: "Institute not found",
        });
        return;
      }

      res.json({
        success: true,
        institute: {
          ...institute,
          isAdmin,
          role: membership?.role,
        },
      });
    } catch (error: any) {
      console.error("Error fetching institute:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch institute",
      });
    }
  }

  /**
   * POST /api/institutes
   * Create a new institute
   */
  async createInstitute(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;

      // Validate input
      const parseResult = insertInstituteSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          message: "Invalid institute data",
          errors: parseResult.error.errors,
        });
        return;
      }

      const { institute, membership } = await instituteService.createInstitute(
        parseResult.data,
        currentUser.id
      );

      res.json({
        success: true,
        message: "Institute created successfully",
        institute: {
          ...institute,
          isAdmin: membership.isAdmin,
          role: membership.role,
        },
      });
    } catch (error: any) {
      console.error("Error creating institute:", error);
      res.status(500).json({
        success: false,
        message: "Failed to create institute",
      });
    }
  }

  /**
   * PATCH /api/institutes/:id
   * Update an institute
   */
  async updateInstitute(req: Request & { file?: Express.Multer.File }, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const instituteId = req.params.id;

      // If a logo file was uploaded, convert to base64 data URI
      const updates = { ...req.body };
      if (req.file) {
        const base64Image = req.file.buffer.toString("base64");
        const mimeType = req.file.mimetype;
        updates.logoUrl = `data:${mimeType};base64,${base64Image}`;
      }

      const result = await instituteService.updateInstitute(
        instituteId,
        updates,
        currentUser.id
      );

      if (!result.success) {
        res.status(result.error === "Only admins can update institute details" ? 403 : 404).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        message: "Institute updated successfully",
        institute: result.institute,
      });
    } catch (error: any) {
      console.error("Error updating institute:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update institute",
      });
    }
  }

  /**
   * DELETE /api/institutes/:id
   * Delete an institute
   */
  async deleteInstitute(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const instituteId = req.params.id;

      const result = await instituteService.deleteInstitute(
        instituteId,
        currentUser.id
      );

      if (!result.success) {
        res.status(403).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        message: "Institute deleted successfully",
      });
    } catch (error: any) {
      console.error("Error deleting institute:", error);
      res.status(500).json({
        success: false,
        message: "Failed to delete institute",
      });
    }
  }

  // ==================== Member Management ====================

  /**
   * GET /api/institutes/:id/members
   * Get all members of an institute
   */
  async getMembers(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const instituteId = req.params.id;

      const result = await instituteService.getInstituteMembers(
        instituteId,
        currentUser.id
      );

      if (!result.success) {
        res.status(403).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        members: result.members?.map(({ user, membership }) => ({
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          fullName: user.fullName,
          profileImageUrl: user.profileImageUrl,
          role: membership.role,
          isAdmin: membership.isAdmin,
          membershipId: membership.id,
          joinedAt: membership.createdAt,
        })),
      });
    } catch (error: any) {
      console.error("Error fetching members:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch members",
      });
    }
  }

  /**
   * PATCH /api/institutes/:id/members/:userId
   * Update a member's role or admin status
   */
  async updateMember(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id: instituteId, userId: targetUserId } = req.params;
      const { role, isAdmin } = req.body;

      const result = await instituteService.updateMember(
        instituteId,
        targetUserId,
        { role, isAdmin },
        currentUser.id
      );

      if (!result.success) {
        res.status(result.error?.includes("admin") ? 403 : 404).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        message: "Member updated successfully",
        membership: result.membership,
      });
    } catch (error: any) {
      console.error("Error updating member:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update member",
      });
    }
  }

  /**
   * DELETE /api/institutes/:id/members/:userId
   * Remove a member from an institute
   */
  async removeMember(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id: instituteId, userId: targetUserId } = req.params;

      const result = await instituteService.removeMember(
        instituteId,
        targetUserId,
        currentUser.id
      );

      if (!result.success) {
        res.status(403).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        message: "Member removed successfully",
      });
    } catch (error: any) {
      console.error("Error removing member:", error);
      res.status(500).json({
        success: false,
        message: "Failed to remove member",
      });
    }
  }

  /**
   * POST /api/institutes/:id/leave
   * Leave an institute (self-removal)
   */
  async leaveInstitute(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const instituteId = req.params.id;

      const result = await instituteService.leaveInstitute(
        instituteId,
        currentUser.id
      );

      if (!result.success) {
        res.status(400).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        message: "You have left the institute",
      });
    } catch (error: any) {
      console.error("Error leaving institute:", error);
      res.status(500).json({
        success: false,
        message: "Failed to leave institute",
      });
    }
  }

  // ==================== Invite Management ====================

  /**
   * POST /api/institutes/:id/invites
   * Send an invite to join an institute
   */
  async sendInvite(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const instituteId = req.params.id;
      const { email, role, grantAdmin, message } = req.body;
  
      if (!email || !email.trim()) {
        res.status(400).json({
          success: false,
          message: "Email is required",
        });
        return;
      }
  
      // Get base URL from request
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.headers['x-forwarded-host'] || req.get('host');
      const baseUrl = `${protocol}://${host}`;
  
      const result = await instituteService.sendInvite(
        instituteId,
        email.trim().toLowerCase(),
        currentUser.id,
        { role, grantAdmin, message },
        baseUrl // Pass baseUrl for email links
      );
  
      if (!result.success) {
        res.status(400).json({
          success: false,
          message: result.error,
        });
        return;
      }
  
      res.json({
        success: true,
        message: "Invite sent successfully",
        invite: result.invite,
        inviteLink: instituteService.getInviteLink(result.invite!.token, baseUrl),
      });
    } catch (error: any) {
      console.error("Error sending invite:", error);
      res.status(500).json({
        success: false,
        message: "Failed to send invite",
      });
    }
  }

  /**
   * GET /api/institutes/:id/invites
   * Get all invites for an institute (admin only)
   */
  async getInvites(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const instituteId = req.params.id;

      const result = await instituteService.getInstituteInvites(
        instituteId,
        currentUser.id
      );

      if (!result.success) {
        res.status(403).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        invites: result.invites,
      });
    } catch (error: any) {
      console.error("Error fetching invites:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch invites",
      });
    }
  }

  /**
   * DELETE /api/institutes/:id/invites/:inviteId
   * Cancel an invite
   */
  async cancelInvite(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { inviteId } = req.params;

      const result = await instituteService.cancelInvite(
        inviteId,
        currentUser.id
      );

      if (!result.success) {
        res.status(result.error?.includes("admin") ? 403 : 404).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        message: "Invite cancelled successfully",
      });
    } catch (error: any) {
      console.error("Error cancelling invite:", error);
      res.status(500).json({
        success: false,
        message: "Failed to cancel invite",
      });
    }
  }

  /**
   * POST /api/institutes/:id/invites/:inviteId/resend
   * Resend an invite
   */
  async resendInvite(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id: instituteId, inviteId } = req.params;
  
      // Get base URL from request
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.headers['x-forwarded-host'] || req.get('host');
      const baseUrl = `${protocol}://${host}`;
  
      const result = await instituteService.resendInvite(
        inviteId,
        currentUser.id,
        baseUrl // Pass baseUrl for email links
      );
  
      if (!result.success) {
        res.status(400).json({
          success: false,
          message: result.error,
        });
        return;
      }
  
      res.json({
        success: true,
        message: "Invite resent successfully",
        invite: result.invite,
        inviteLink: instituteService.getInviteLink(result.invite!.token, baseUrl),
      });
    } catch (error: any) {
      console.error("Error resending invite:", error);
      res.status(500).json({
        success: false,
        message: "Failed to resend invite",
      });
    }
  }

  // ==================== User Invite Responses ====================

  /**
   * GET /api/invites/pending
   * Get all pending invites for the current user
   */
  async getPendingInvites(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;

      const invites = await instituteService.getUserPendingInvites(
        currentUser.id,
        currentUser.email
      );

      res.json({
        success: true,
        invites: invites.map(({ invite, institute, invitedBy }) => ({
          id: invite.id,
          institute: {
            id: institute.id,
            name: institute.name,
            type: institute.type,
            logoUrl: institute.logoUrl,
          },
          invitedBy: invitedBy
            ? {
                id: invitedBy.id,
                fullName: invitedBy.fullName,
                email: invitedBy.email,
              }
            : null,
          role: invite.role,
          grantAdmin: invite.grantAdmin,
          message: invite.message,
          expiresAt: invite.expiresAt,
          createdAt: invite.createdAt,
        })),
      });
    } catch (error: any) {
      console.error("Error fetching pending invites:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch pending invites",
      });
    }
  }

  /**
   * POST /api/invites/:inviteId/accept
   * Accept an invite
   */
  async acceptInvite(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { inviteId } = req.params;

      const result = await instituteService.acceptInvite(
        inviteId,
        currentUser.id
      );

      if (!result.success) {
        res.status(400).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        message: "Invite accepted successfully",
        membership: result.membership,
      });
    } catch (error: any) {
      console.error("Error accepting invite:", error);
      res.status(500).json({
        success: false,
        message: "Failed to accept invite",
      });
    }
  }

  /**
   * POST /api/invites/:inviteId/decline
   * Decline an invite
   */
  async declineInvite(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { inviteId } = req.params;

      const result = await instituteService.declineInvite(
        inviteId,
        currentUser.id
      );

      if (!result.success) {
        res.status(400).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        message: "Invite declined",
      });
    } catch (error: any) {
      console.error("Error declining invite:", error);
      res.status(500).json({
        success: false,
        message: "Failed to decline invite",
      });
    }
  }

  // ==================== Public Invite Routes (for signup) ====================

  /**
   * GET /api/invites/token/:token
   * Get invite details by token (public - for invite signup page)
   */
  async getInviteByToken(req: Request, res: Response): Promise<void> {
    try {
      const { token } = req.params;

      const result = await instituteService.getInviteByToken(token);

      if (!result.success) {
        res.status(404).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        invite: {
          id: result.invite!.id,
          email: result.invite!.inviteeEmail,
          role: result.invite!.role,
          grantAdmin: result.invite!.grantAdmin,
          message: result.invite!.message,
          expiresAt: result.invite!.expiresAt,
        },
        institute: {
          id: result.institute!.id,
          name: result.institute!.name,
          type: result.institute!.type,
          logoUrl: result.institute!.logoUrl,
        },
        invitedBy: result.invitedBy
          ? {
              fullName: result.invitedBy.fullName,
            }
          : null,
      });
    } catch (error: any) {
      console.error("Error fetching invite:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch invite",
      });
    }
  }

  /**
   * POST /api/invites/token/:token/accept
   * Accept an invite by token (for users who already have an account)
   */
  async acceptInviteByToken(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { token } = req.params;

      const result = await instituteService.acceptInviteByToken(
        token,
        currentUser.id
      );

      if (!result.success) {
        res.status(400).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        message: "You have joined the institute",
        membership: result.membership,
        institute: result.institute,
      });
    } catch (error: any) {
      console.error("Error accepting invite:", error);
      res.status(500).json({
        success: false,
        message: "Failed to accept invite",
      });
    }
  }

  /**
   * POST /api/invites/token/:token/register
   * Register a new user and accept the invite
   */
  async registerWithInvite(req: Request, res: Response): Promise<void> {
    try {
      const { token } = req.params;
      const { firstName, lastName, password, userType } = req.body;
  
      // Validate invite
      const inviteResult = await instituteService.getInviteByToken(token);
      if (!inviteResult.success || !inviteResult.invite) {
        res.status(400).json({
          success: false,
          message: inviteResult.error || "Invalid invite",
        });
        return;
      }
  
      const { invite, institute } = inviteResult;
  
      // Check if user already exists
      const existingUser = await userService.getUserByEmail(invite.inviteeEmail);
      if (existingUser) {
        res.status(400).json({
          success: false,
          message: "An account with this email already exists. Please log in instead.",
        });
        return;
      }
  
      // Create the user
      const newUserResult = await userService.registerUser({
        email: invite.inviteeEmail,
        firstName,
        lastName,
        password,
        userType: userType || "Caregiver",
      });
      const newUser = newUserResult.user;
  
      // Accept the invite
      const acceptResult = await instituteService.acceptInvite(invite.id, newUser.id);
      if (!acceptResult.success) {
        res.status(400).json({
          success: false,
          message: acceptResult.error || "Failed to accept invite",
        });
        return;
      }
  
      // ========== EMAIL INTEGRATION ==========
      // Send welcome email
      try {
        await emailService.sendWelcomeEmail({
          email: newUser.email,
          firstName: newUser.firstName || firstName,
          instituteName: institute?.name,
        });
      } catch (emailError) {
        console.error("Error sending welcome email:", emailError);
        // Don't fail registration if welcome email fails
      }
      // ========== END EMAIL INTEGRATION ==========
  
      // Log them in (create session)
      req.login(newUser, (err) => {
        if (err) {
          console.error("Login after registration failed:", err);
          // Still return success since account was created
          res.json({
            success: true,
            message: "Account created successfully. Please log in.",
            user: {
              id: newUser.id,
              email: newUser.email,
              firstName: newUser.firstName,
              lastName: newUser.lastName,
            },
          });
          return;
        }
  
        res.json({
          success: true,
          message: "Welcome! Your account has been created.",
          user: {
            id: newUser.id,
            email: newUser.email,
            firstName: newUser.firstName,
            lastName: newUser.lastName,
          },
          institute: institute,
        });
      });
    } catch (error: any) {
      console.error("Error registering with invite:", error);
      res.status(500).json({
        success: false,
        message: "Registration failed",
      });
    }
  }

  /**
   * GET /api/institutes/:id/students
   * Get all students in an institute
   */
  async getStudents(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const instituteId = req.params.id;

      const result = await instituteService.getInstituteStudents(
        instituteId,
        currentUser.id
      );

      if (!result.success) {
        res.status(403).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        students: result.students?.map(({ student, enrollment }) => ({
          id: student.id,
          name: student.name,
          firstName: student.firstName,
          lastName: student.lastName,
          gender: student.gender,
          birthDate: student.birthDate,
          framework: student.framework,
          country: student.country,
          // Enrollment info
          idNumber: enrollment.idNumber,
          grade: enrollment.grade,
          enrollmentDate: enrollment.enrollmentDate,
          enrollmentId: enrollment.id,
        })),
      });
    } catch (error: any) {
      console.error("Error fetching institute students:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch students",
      });
    }
  }

  /**
   * POST /api/institutes/:id/students
   * Assign a student to an institute
   */
  async addStudent(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const instituteId = req.params.id;
      const { studentId, enrollmentDate, idNumber, grade } = req.body;

      if (!studentId) {
        res.status(400).json({
          success: false,
          message: "Student ID is required",
        });
        return;
      }

      const result = await instituteService.assignStudentToInstitute(
        instituteId,
        studentId,
        currentUser.id,
        { enrollmentDate, idNumber, grade }
      );

      if (!result.success) {
        res.status(400).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        message: "Student added to institute",
        enrollment: result.enrollment,
      });
    } catch (error: any) {
      console.error("Error adding student to institute:", error);
      res.status(500).json({
        success: false,
        message: "Failed to add student to institute",
      });
    }
  }

  /**
   * PATCH /api/institutes/:id/students/:studentId
   * Update a student's enrollment info
   */
  async updateStudent(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id: instituteId, studentId } = req.params;
      const { idNumber, grade } = req.body;

      const result = await instituteService.updateStudentEnrollment(
        instituteId,
        studentId,
        { idNumber, grade },
        currentUser.id
      );

      if (!result.success) {
        res.status(404).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        message: "Student enrollment updated",
        enrollment: result.enrollment,
      });
    } catch (error: any) {
      console.error("Error updating student enrollment:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update student enrollment",
      });
    }
  }

  /**
   * DELETE /api/institutes/:id/students/:studentId
   * Remove a student from an institute
   */
  async removeStudent(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id: instituteId, studentId } = req.params;
      const { exitReason } = req.body;

      const result = await instituteService.removeStudentFromInstitute(
        instituteId,
        studentId,
        currentUser.id,
        exitReason
      );

      if (!result.success) {
        res.status(403).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        message: "Student removed from institute",
      });
    } catch (error: any) {
      console.error("Error removing student from institute:", error);
      res.status(500).json({
        success: false,
        message: "Failed to remove student from institute",
      });
    }
  }

  // ==================== Student's Institutes Endpoint ====================
  // Add this to studentController.ts or create a new endpoint

  /**
   * GET /api/students/:studentId/institutes
   * Get all institutes a student belongs to
   */
  async getStudentInstitutes(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;

      const result = await instituteService.getStudentInstitutes(
        studentId,
        currentUser.id
      );

      if (!result.success) {
        res.status(403).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        institutes: result.institutes?.map(({ institute, enrollment }) => ({
          id: institute.id,
          name: institute.name,
          type: institute.type,
          logoUrl: institute.logoUrl,
          // Enrollment info
          idNumber: enrollment.idNumber,
          grade: enrollment.grade,
          enrollmentDate: enrollment.enrollmentDate,
          exitDate: enrollment.exitDate,
          exitReason: enrollment.exitReason,
          isActive: enrollment.isActive,
          enrollmentId: enrollment.id,
        })),
      });
    } catch (error: any) {
      console.error("Error fetching student institutes:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch institutes",
      });
    }
  }
}

export const instituteController = new InstituteController();
