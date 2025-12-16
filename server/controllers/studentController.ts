import type { Request, Response } from "express";
import { studentService } from "../services";

export class StudentController {
  /**
   * GET /api/students
   * Get all students for the current user
   */
  async getStudents(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      console.log("Getting students for user ID:", currentUser.id);
      
      // Get students with their link information
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
      console.error("Error fetching students:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch students" });
    }
  }

  async getStudentById(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      // Verify access
      const { hasAccess, link } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this student" });
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
        res.status(404).json({ success: false, message: "student not found" });
      }
    } catch (error: any) {
      console.error("Error fetching student:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch student" });
    }
  }

  /**
   * POST /api/students
   * Create a new student
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
        message: "student created successfully",
        student: {
          ...student,
          age: studentService.calculateAge(student.birthDate),
        },
      });
    } catch (error: any) {
      console.error("Error creating student:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to create student" });
    }
  }

  /**
   * PATCH /api/students/:id
   * Update an student
   */
  async updateStudent(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      // Verify access
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this student" });
        return;
      }

      const updatedStudent = await studentService.updateStudent(studentId, req.body);
      
      if (updatedStudent) {
        res.json({
          success: true,
          message: "student updated successfully",
          student: {
            ...updatedStudent,
            age: studentService.calculateAge(updatedStudent.birthDate),
          },
        });
      } else {
        res.status(404).json({ success: false, message: "student not found" });
      }
    } catch (error: any) {
      console.error("Error updating student:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to update student" });
    }
  }

  /**
   * DELETE /api/students/:id
   * Delete an student (soft delete)
   */
  async deleteStudent(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;
      
      // Verify access (only owners should be able to delete)
      const { hasAccess, link } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this student" });
        return;
      }

      if (link?.role !== "owner") {
        res.status(403).json({ success: false, message: "Only owners can delete an student" });
        return;
      }

      const deleted = await studentService.deleteStudent(studentId);
      
      if (deleted) {
        res.json({ success: true, message: "student deleted successfully" });
      } else {
        res.status(404).json({ success: false, message: "student not found" });
      }
    } catch (error: any) {
      console.error("Error deleting student:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to delete student" });
    }
  }

  // ==================== Link Management Routes ====================

  /**
   * POST /api/students/:id/link
   * Link another user to an student
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

      // Verify the current user has access to this student
      const { hasAccess, link: currentLink } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this student" });
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
   * Remove a user's link to an student
   */
  async unlinkUser(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;
      const targetUserId = req.params.userId;

      // Verify the current user has access and is an owner
      const { hasAccess, link: currentLink } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this student" });
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
   * Get all users linked to an student
   */
  async getLinkedUsers(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      // Verify access
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this student" });
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
}

export const studentController = new StudentController();