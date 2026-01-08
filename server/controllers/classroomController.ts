// server/controllers/classroomController.ts
// HTTP handlers for classroom management

import type { Request, Response } from "express";
import { classroomService } from "../services/classroomService";
import { insertClassroomSchema } from "@shared/schema";

export class ClassroomController {
  // ==================== Classroom CRUD ====================

  /**
   * GET /api/institutes/:instituteId/classrooms
   * Get all classrooms for an institute
   */
  async getClassrooms(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { instituteId } = req.params;

      const result = await classroomService.getInstituteClassrooms(
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
        classrooms: result.classrooms,
      });
    } catch (error: any) {
      console.error("Error fetching classrooms:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch classrooms",
      });
    }
  }

  /**
   * GET /api/classrooms/:classroomId
   * Get a specific classroom with full details
   */
  async getClassroom(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { classroomId } = req.params;

      const result = await classroomService.getClassroomWithDetails(
        classroomId,
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
        ...result.data,
      });
    } catch (error: any) {
      console.error("Error fetching classroom:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch classroom",
      });
    }
  }

  /**
   * POST /api/institutes/:instituteId/classrooms
   * Create a new classroom
   */
  async createClassroom(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { instituteId } = req.params;

      // Validate input
      const parseResult = insertClassroomSchema.safeParse({
        ...req.body,
        instituteId,
      });
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          message: "Invalid classroom data",
          errors: parseResult.error.errors,
        });
        return;
      }

      const result = await classroomService.createClassroom(
        parseResult.data,
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
        message: "Classroom created successfully",
        classroom: result.classroom,
      });
    } catch (error: any) {
      console.error("Error creating classroom:", error);
      res.status(500).json({
        success: false,
        message: "Failed to create classroom",
      });
    }
  }

  /**
   * PATCH /api/classrooms/:classroomId
   * Update a classroom
   */
  async updateClassroom(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { classroomId } = req.params;

      const result = await classroomService.updateClassroom(
        classroomId,
        req.body,
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
        message: "Classroom updated successfully",
        classroom: result.classroom,
      });
    } catch (error: any) {
      console.error("Error updating classroom:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update classroom",
      });
    }
  }

  /**
   * DELETE /api/classrooms/:classroomId
   * Delete a classroom
   */
  async deleteClassroom(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { classroomId } = req.params;

      const result = await classroomService.deleteClassroom(
        classroomId,
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
        message: "Classroom deleted successfully",
      });
    } catch (error: any) {
      console.error("Error deleting classroom:", error);
      res.status(500).json({
        success: false,
        message: "Failed to delete classroom",
      });
    }
  }

  // ==================== Classroom Members ====================

  /**
   * GET /api/classrooms/:classroomId/members
   * Get all members of a classroom
   */
  async getMembers(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { classroomId } = req.params;

      const result = await classroomService.getClassroomMembers(
        classroomId,
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
          isPrimary: membership.isPrimary,
          membershipId: membership.id,
          assignedAt: membership.createdAt,
        })),
      });
    } catch (error: any) {
      console.error("Error fetching classroom members:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch classroom members",
      });
    }
  }

  /**
   * POST /api/classrooms/:classroomId/members
   * Add a member to a classroom
   */
  async addMember(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { classroomId } = req.params;
      const { userId, role, isPrimary } = req.body;

      if (!userId) {
        res.status(400).json({
          success: false,
          message: "User ID is required",
        });
        return;
      }

      const result = await classroomService.addUserToClassroom(
        classroomId,
        userId,
        role || "teacher",
        currentUser.id,
        isPrimary || false
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
        message: "Member added to classroom",
        membership: result.membership,
      });
    } catch (error: any) {
      console.error("Error adding classroom member:", error);
      res.status(500).json({
        success: false,
        message: "Failed to add member to classroom",
      });
    }
  }

  /**
   * PATCH /api/classrooms/:classroomId/members/:userId
   * Update a classroom member
   */
  async updateMember(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { classroomId, userId } = req.params;
      const { role, isPrimary } = req.body;

      const result = await classroomService.updateClassroomMember(
        classroomId,
        userId,
        { role, isPrimary },
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
      console.error("Error updating classroom member:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update member",
      });
    }
  }

  /**
   * DELETE /api/classrooms/:classroomId/members/:userId
   * Remove a member from a classroom
   */
  async removeMember(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { classroomId, userId } = req.params;

      const result = await classroomService.removeUserFromClassroom(
        classroomId,
        userId,
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
        message: "Member removed from classroom",
      });
    } catch (error: any) {
      console.error("Error removing classroom member:", error);
      res.status(500).json({
        success: false,
        message: "Failed to remove member",
      });
    }
  }

  // ==================== Classroom Students ====================

  /**
   * GET /api/classrooms/:classroomId/students
   * Get all students in a classroom
   */
  async getStudents(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { classroomId } = req.params;

      const result = await classroomService.getClassroomStudents(
        classroomId,
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
          isPrimary: enrollment.isPrimary,
          enrollmentDate: enrollment.enrollmentDate,
          notes: enrollment.notes,
          enrollmentId: enrollment.id,
        })),
      });
    } catch (error: any) {
      console.error("Error fetching classroom students:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch classroom students",
      });
    }
  }

  /**
   * POST /api/classrooms/:classroomId/students
   * Add a student to a classroom
   */
  async addStudent(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { classroomId } = req.params;
      const { studentId, isPrimary, enrollmentDate, notes } = req.body;

      if (!studentId) {
        res.status(400).json({
          success: false,
          message: "Student ID is required",
        });
        return;
      }

      const result = await classroomService.addStudentToClassroom(
        studentId,
        classroomId,
        currentUser.id,
        { isPrimary, enrollmentDate, notes }
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
        message: "Student added to classroom",
        enrollment: result.enrollment,
      });
    } catch (error: any) {
      console.error("Error adding student to classroom:", error);
      res.status(500).json({
        success: false,
        message: "Failed to add student to classroom",
      });
    }
  }

  /**
   * PATCH /api/classrooms/:classroomId/students/:studentId
   * Update a student's enrollment in a classroom
   */
  async updateStudent(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { classroomId, studentId } = req.params;
      const { isPrimary, notes } = req.body;

      const result = await classroomService.updateStudentEnrollment(
        studentId,
        classroomId,
        { isPrimary, notes },
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
   * DELETE /api/classrooms/:classroomId/students/:studentId
   * Remove a student from a classroom
   */
  async removeStudent(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { classroomId, studentId } = req.params;

      const result = await classroomService.removeStudentFromClassroom(
        studentId,
        classroomId,
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
        message: "Student removed from classroom",
      });
    } catch (error: any) {
      console.error("Error removing student from classroom:", error);
      res.status(500).json({
        success: false,
        message: "Failed to remove student from classroom",
      });
    }
  }

  // ==================== User's Classrooms ====================

  /**
   * GET /api/users/me/classrooms
   * Get all classrooms the current user is assigned to
   */
  async getMyClassrooms(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { instituteId } = req.query;

      const classrooms = await classroomService.getUserClassrooms(
        currentUser.id,
        instituteId as string | undefined
      );

      res.json({
        success: true,
        classrooms: classrooms.map(({ classroom, membership }) => ({
          ...classroom,
          role: membership.role,
          isPrimary: membership.isPrimary,
          membershipId: membership.id,
        })),
      });
    } catch (error: any) {
      console.error("Error fetching user classrooms:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch classrooms",
      });
    }
  }
}

export const classroomController = new ClassroomController();