import type { Request, Response } from "express";
import { studentService } from "../services";
import {
  insertStudentScheduleSchema,
  updateStudentScheduleSchema,
} from "@shared/schema";

export class StudentController {
  /**
   * GET /api/students
   * Get all AAC users for the current user
   */
  async getStudents(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      console.log("Getting AAC users for user ID:", currentUser.id);
      
      // Get AAC users with their link information
      const studentsWithLinks = await studentService.getStudentsWithLinksByUserId(currentUser.id);
      
      // Transform to include calculated age and role
      const students = studentsWithLinks.map(({ student, link }) => ({
        ...student,
        age: studentService.calculateAge(student.birthDate),
        role: link.role,
        linkId: link.id,
      }));
      
      res.json({ success: true, students });
    } catch (error: any) {
      console.error("Error fetching AAC users:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch AAC users" });
    }
  }

  async getStudentById(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      // Verify access
      const { hasAccess, link } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      const student = await studentService.getStudentById(studentId);
      if (student) {
        res.json({
          success: true,
          student: {
            ...student,
            age: studentService.calculateAge(student.birthDate),
          },
        });
      } else {
        res.status(404).json({ success: false, message: "AAC user not found" });
      }
    } catch (error: any) {
      console.error("Error fetching AAC user:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch AAC user" });
    }
  }

  /**
   * POST /api/students
   * Create a new AAC user
   */
  async createStudent(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;

      if (!req.body.name) {
        res
          .status(400)
          .json({ success: false, message: "Name is required" });
        return;
      }

      const student = await studentService.createStudent(
        { ...req.body, isActive: true },
        currentUser.id,
        "owner" // Creating user becomes the owner
      );

      res.json({
        success: true,
        message: "AAC user created successfully",
        student: {
          ...student,
          age: studentService.calculateAge(student.birthDate),
        },
      });
    } catch (error: any) {
      console.error("Error creating AAC user:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to create AAC user" });
    }
  }

  /**
   * PATCH /api/students/:id
   * Update an AAC user
   */
  async updateStudent(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      // Verify access
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      const updatedStudent = await studentService.updateStudent(studentId, req.body);
      
      if (updatedStudent) {
        res.json({
          success: true,
          message: "AAC user updated successfully",
          student: {
            ...updatedStudent,
            age: studentService.calculateAge(updatedStudent.birthDate),
          },
        });
      } else {
        res.status(404).json({ success: false, message: "AAC user not found" });
      }
    } catch (error: any) {
      console.error("Error updating AAC user:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to update AAC user" });
    }
  }

  /**
   * DELETE /api/students/:id
   * Delete an AAC user (soft delete)
   */
  async deleteStudent(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;
      
      // Verify access (only owners should be able to delete)
      const { hasAccess, link } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      if (link?.role !== "owner") {
        res.status(403).json({ success: false, message: "Only owners can delete an AAC user" });
        return;
      }

      const deleted = await studentService.deleteStudent(studentId);
      
      if (deleted) {
        res.json({ success: true, message: "AAC user deleted successfully" });
      } else {
        res.status(404).json({ success: false, message: "AAC user not found" });
      }
    } catch (error: any) {
      console.error("Error deleting AAC user:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to delete AAC user" });
    }
  }

  // ==================== Link Management Routes ====================

  /**
   * POST /api/students/:id/link
   * Link another user to an AAC user
   */
  async linkUser(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;
      const { targetUserId, role } = req.body;

      if (!targetUserId) {
        res.status(400).json({ success: false, message: "Target user ID is required" });
        return;
      }

      // Verify the current user has access to this AAC user
      const { hasAccess, link: currentLink } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      // Only owners can link other users
      if (currentLink?.role !== "owner") {
        res.status(403).json({ success: false, message: "Only owners can link other users" });
        return;
      }

      const link = await studentService.linkUserToStudent(
        targetUserId,
        studentId,
        role || "caregiver"
      );

      res.json({
        success: true,
        message: "User linked successfully",
        link,
      });
    } catch (error: any) {
      console.error("Error linking user:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to link user" });
    }
  }

  /**
   * DELETE /api/students/:id/link/:userId
   * Remove a user's link to an AAC user
   */
  async unlinkUser(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;
      const targetUserId = req.params.userId;

      // Verify the current user has access and is an owner
      const { hasAccess, link: currentLink } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      if (currentLink?.role !== "owner") {
        res.status(403).json({ success: false, message: "Only owners can unlink users" });
        return;
      }

      // Cannot unlink the owner
      const targetLink = await studentService.getUserStudentLink(targetUserId, studentId);
      if (targetLink?.role === "owner") {
        res.status(400).json({ success: false, message: "Cannot unlink the owner" });
        return;
      }

      const unlinked = await studentService.unlinkUserFromStudent(targetUserId, studentId);

      if (unlinked) {
        res.json({ success: true, message: "User unlinked successfully" });
      } else {
        res.status(404).json({ success: false, message: "Link not found" });
      }
    } catch (error: any) {
      console.error("Error unlinking user:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to unlink user" });
    }
  }

  /**
   * GET /api/students/:id/links
   * Get all users linked to an AAC user
   */
  async getLinkedUsers(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      // Verify access
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      const links = await studentService.getUsersLinkedToStudent(studentId);

      res.json({ success: true, links });
    } catch (error: any) {
      console.error("Error fetching linked users:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch linked users" });
    }
  }

  // ==================== Schedule Routes ====================

  /**
   * GET /api/students/:studentId/schedules
   * Get all schedules for an AAC user
   */
  async getSchedules(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;

      // Verify access
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      const schedules = await studentService.getSchedulesByStudentId(studentId);
      res.json({ success: true, schedules });
    } catch (error: any) {
      console.error("Error fetching schedules:", error);
      res.status(500).json({ success: false, message: "Failed to fetch schedules" });
    }
  }

  /**
   * POST /api/students/:studentId/schedules
   * Create a schedule entry for an AAC user
   */
  async createSchedule(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;

      // Verify access
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      const validatedData = insertStudentScheduleSchema.parse({
        ...req.body,
        studentId,
      });
      const schedule = await studentService.createScheduleEntry(validatedData);
      res.json({
        success: true,
        message: "Schedule entry created successfully",
        schedule,
      });
    } catch (error: any) {
      console.error("Error creating schedule:", error);
      if (error.name === "ZodError") {
        res.status(400).json({
          success: false,
          message: "Invalid schedule data",
          errors: error.errors,
        });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to create schedule entry" });
    }
  }

  /**
   * PATCH /api/schedules/:id
   * Update a schedule entry
   */
  async updateSchedule(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const scheduleId = req.params.id;

      // Get the schedule to verify access
      const schedule = await studentService.getScheduleEntry(scheduleId);
      if (!schedule) {
        res.status(404).json({ success: false, message: "Schedule entry not found" });
        return;
      }

      // Verify access to the AAC user
      const { hasAccess } = await studentService.verifyStudentAccess(schedule.studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      const validatedData = updateStudentScheduleSchema.parse(req.body);
      const updated = await studentService.updateScheduleEntry(scheduleId, validatedData);
      
      if (updated) {
        res.json({
          success: true,
          message: "Schedule entry updated successfully",
          schedule: updated,
        });
      } else {
        res.status(404).json({ success: false, message: "Schedule entry not found" });
      }
    } catch (error: any) {
      console.error("Error updating schedule:", error);
      if (error.name === "ZodError") {
        res.status(400).json({
          success: false,
          message: "Invalid schedule data",
          errors: error.errors,
        });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to update schedule entry" });
    }
  }

  /**
   * DELETE /api/schedules/:id
   * Delete a schedule entry
   */
  async deleteSchedule(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const scheduleId = req.params.id;

      // Get the schedule to verify access
      const schedule = await studentService.getScheduleEntry(scheduleId);
      if (!schedule) {
        res.status(404).json({ success: false, message: "Schedule entry not found" });
        return;
      }

      // Verify access to the AAC user
      const { hasAccess } = await studentService.verifyStudentAccess(schedule.studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      const deleted = await studentService.deleteScheduleEntry(scheduleId);
      
      if (deleted) {
        res.json({ success: true, message: "Schedule entry deleted successfully" });
      } else {
        res.status(404).json({ success: false, message: "Schedule entry not found" });
      }
    } catch (error: any) {
      console.error("Error deleting schedule:", error);
      res.status(500).json({ success: false, message: "Failed to delete schedule entry" });
    }
  }

  /**
   * GET /api/students/:studentId/schedule-context
   * Get the current schedule context for an AAC user
   */
  async getScheduleContext(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;

      // Verify access
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      const timestamp = req.query.timestamp
        ? new Date(req.query.timestamp as string)
        : new Date();
      const context = await studentService.getCurrentScheduleContext(studentId, timestamp);
      res.json({ success: true, context });
    } catch (error: any) {
      console.error("Error fetching schedule context:", error);
      res.status(500).json({ success: false, message: "Failed to fetch schedule context" });
    }
  }
}

export const studentController = new StudentController();