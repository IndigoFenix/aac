import type { Request, Response } from "express";
import { studentService } from "../services";
import { instituteRepository } from "../repositories";
import { activityLogService } from "../services/activityLogService";

export class StudentController {
  /**
   * GET /api/students?instituteId=...
   * Get students visible to the current user within the selected institute.
   * If no instituteId is provided, returns an empty list.
   */
  async getStudents(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const instituteId = req.query.instituteId as string | undefined;

      if (!instituteId) {
        res.json({ success: true, students: [] });
        return;
      }

      // Get students scoped to the selected institute
      const studentsWithLinks = await studentService.getStudentsForUserInInstitute(
        currentUser.id,
        instituteId
      );

      // Transform to include calculated age and role
      const students = studentsWithLinks.map(({ student, link }) => ({
        ...student,
        age: studentService.calculateAge(student.birthDate),
        role: link?.role ?? null,
        linkId: link?.id ?? null,
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
   * Create a new student. Requires instituteIds (array) — the student will be
   * auto-enrolled in those institutes. Users with no institute cannot create students.
   */
  async createStudent(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { instituteIds, ...studentBody } = req.body;

      if (!studentBody.firstName && !studentBody.name) {
        res
          .status(400)
          .json({ success: false, message: "First name is required" });
        return;
      }

      // Require at least one institute
      if (!Array.isArray(instituteIds) || instituteIds.length === 0) {
        res.status(400).json({
          success: false,
          message: "At least one institute is required to create a student",
          code: "INSTITUTE_REQUIRED",
        });
        return;
      }

      // Verify the user is a member of every specified institute
      for (const instId of instituteIds) {
        const isMember = await instituteRepository.isUserMemberOfInstitute(instId, currentUser.id);
        if (!isMember) {
          res.status(403).json({
            success: false,
            message: "You must be a member of all specified institutes",
          });
          return;
        }
      }

      // Check maxStudents license limit (per-institute)
      const { licenseService } = await import("../services/licenseService");
      const check = await licenseService.checkMaxStudents(instituteIds[0], currentUser.isSystemAdmin);
      if (!check.allowed) {
        res.status(403).json({
          success: false,
          message: check.reason,
          code: "STUDENT_LIMIT_REACHED",
        });
        return;
      }

      const student = await studentService.createStudent(
        { ...studentBody, isActive: true },
        currentUser.id,
        "owner" // Creating user becomes the owner
      );

      // Auto-enroll in all specified institutes
      await Promise.all(
        instituteIds.map((instId: string) =>
          instituteRepository.assignStudentToInstitute(instId, student.id)
        )
      );

      res.json({
        success: true,
        message: "student created successfully",
        student: {
          ...student,
          age: studentService.calculateAge(student.birthDate),
        },
      });

      activityLogService.log({
        instituteId: instituteIds[0],
        userId: currentUser.id,
        eventType: "create",
        subjectType1: "student",
        subjectId1: student.id,
        details: { name: studentBody.firstName || studentBody.name },
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
   * Update a student (handles both student fields and AAC settings)
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

        activityLogService.log({
          userId: currentUser.id,
          eventType: "update",
          subjectType1: "student",
          subjectId1: studentId,
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

        activityLogService.log({
          userId: currentUser.id,
          eventType: "delete",
          subjectType1: "student",
          subjectId1: studentId,
        });
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
      const { targetUserId, role, instituteId } = req.body;

      if (!targetUserId) {
        res.status(400).json({ success: false, message: "Target user ID is required" });
        return;
      }

      // Authorization: student owner OR institute admin (school/clinic)
      const { hasAccess, link: currentLink } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      const isOwner = hasAccess && currentLink?.role === "owner";
      let isInstituteAdmin = false;

      if (!isOwner && instituteId) {
        const institute = await instituteRepository.getInstituteById(instituteId);
        if (institute && (institute.type === 'school' || institute.type === 'clinic')) {
          isInstituteAdmin = await instituteRepository.isUserAdminOfInstitute(instituteId, currentUser.id);
          // Also verify the target user is a member of the same institute
          if (isInstituteAdmin) {
            const targetIsMember = await instituteRepository.isUserMemberOfInstitute(instituteId, targetUserId);
            if (!targetIsMember) {
              res.status(400).json({ success: false, message: "Target user is not a member of this institute" });
              return;
            }
          }
        }
      }

      if (!isOwner && !isInstituteAdmin) {
        res.status(403).json({ success: false, message: "Only student owners or institute admins can link users" });
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

      activityLogService.log({
        instituteId: instituteId ?? null,
        userId: currentUser.id,
        eventType: "link",
        subjectType1: "student",
        subjectId1: studentId,
        subjectType2: "user",
        subjectId2: targetUserId,
        details: { role: role || "caregiver" },
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
      const instituteId = req.query.instituteId as string | undefined;

      // Authorization: student owner OR institute admin (school/clinic)
      const { hasAccess, link: currentLink } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      const isOwner = hasAccess && currentLink?.role === "owner";
      let isInstituteAdmin = false;

      if (!isOwner && instituteId) {
        const institute = await instituteRepository.getInstituteById(instituteId);
        if (institute && (institute.type === 'school' || institute.type === 'clinic')) {
          isInstituteAdmin = await instituteRepository.isUserAdminOfInstitute(instituteId, currentUser.id);
        }
      }

      if (!isOwner && !isInstituteAdmin) {
        res.status(403).json({ success: false, message: "Only student owners or institute admins can unlink users" });
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

        activityLogService.log({
          instituteId: instituteId ?? null,
          userId: currentUser.id,
          eventType: "unlink",
          subjectType1: "student",
          subjectId1: studentId,
          subjectType2: "user",
          subjectId2: targetUserId,
        });
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
