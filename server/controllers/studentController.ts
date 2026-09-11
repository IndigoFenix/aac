import type { Request, Response } from "express";
import { studentService } from "../services";
import {
  isUserStudentRole,
  INSTITUTE_ADMIN_GRANTABLE_ROLES,
  USER_STUDENT_ROLES,
} from "../services/studentService";
import { instituteRepository, InvalidAacSettingError } from "../repositories";
import { activityLogService } from "../services/activityLogService";
import { changeDetails, type ChangeMap } from "../services/activityChanges";

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
        debugMode: (student as any).aacSettings?.debugMode === true,
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
            debugMode: (student as any).aacSettings?.debugMode === true,
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

      // For family-institute creators, auto-create a guardian contact linked to
      // the parent. The consent wizard reads from this row to prefill the
      // identity fields the admin captured at license provisioning.
      try {
        const { autoCreateGuardianContactForFamilyAdmin } = await import(
          "../services/consent/guardianContactAutoCreate"
        );
        await autoCreateGuardianContactForFamilyAdmin({
          studentId: student.id,
          creatingUserId: currentUser.id,
          instituteIds,
        });
      } catch (err) {
        // Don't fail student creation if guardian-contact auto-create errors.
        // The parent can add themselves as a contact manually.
        console.error("Auto-create guardian contact failed:", err);
      }

      res.json({
        success: true,
        message: "student created successfully",
        student: {
          ...student,
          age: studentService.calculateAge(student.birthDate),
          debugMode: (student as any).aacSettings?.debugMode === true,
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

      let changes: ChangeMap = {};
      const updatedStudent = await studentService.updateStudent(studentId, req.body, {
        onChanges: (c) => { changes = c; },
      });

      if (updatedStudent) {
        res.json({
          success: true,
          message: "student updated successfully",
          student: {
            ...updatedStudent,
            age: studentService.calculateAge(updatedStudent.birthDate),
            debugMode: (updatedStudent as any).aacSettings?.debugMode === true,
          },
        });

        // This one endpoint covers both the student record and its AAC settings,
        // so without the diff the row can't tell a birthdate fix from an AI-name
        // change. `details` is null when the save changed nothing.
        activityLogService.log({
          userId: currentUser.id,
          eventType: "update",
          subjectType1: "student",
          subjectId1: studentId,
          details: changeDetails(changes),
        });
      } else {
        res.status(404).json({ success: false, message: "student not found" });
      }
    } catch (error: any) {
      if (error instanceof InvalidAacSettingError) {
        // A value that cannot be real (e.g. a pasted ElevenLabs key ID) —
        // rejected before it reached the database. message is "error:CODE",
        // which the client translates via errors.<CODE>.
        res.status(400).json({ success: false, error: error.message, message: error.message });
        return;
      }
      console.error("Error updating student:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to update student" });
    }
  }

  /**
   * GET /api/students/archived?instituteId=
   * Archived students for an institute — the same visibility as the roster,
   * over the inactive rows. Empty without an instituteId, like the roster.
   */
  async getArchivedStudents(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const instituteId = req.query.instituteId as string | undefined;
      if (!instituteId) {
        res.json({ success: true, students: [] });
        return;
      }
      const rows = await studentService.getArchivedStudentsForUserInInstitute(currentUser.id, instituteId);
      const students = rows.map(({ student, link }) => ({
        ...student,
        age: studentService.calculateAge(student.birthDate),
        role: link?.role ?? null,
        linkId: link?.id ?? null,
      }));
      res.json({ success: true, students });
    } catch (error: any) {
      console.error("Error fetching archived students:", error);
      res.status(500).json({ success: false, message: error.message || "Failed to fetch archived students" });
    }
  }

  /**
   * POST /api/students/:id/archive  |  POST /api/students/:id/restore
   * `isActive` only, nothing deleted. The Students panel's Archive menu item
   * was wired to nothing until 2026-09-11; the only existing endpoint (DELETE)
   * also wipes the external store, which is not an archive.
   */
  async archiveStudent(req: Request, res: Response): Promise<void> {
    await this.setArchived(req, res, true);
  }

  async restoreStudent(req: Request, res: Response): Promise<void> {
    await this.setArchived(req, res, false);
  }

  private async setArchived(req: Request, res: Response, archived: boolean): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      const allowed = await studentService.canArchiveStudent(studentId, currentUser.id);
      if (!allowed) {
        res.status(403).json({ success: false, message: "Only an owner or an institute admin can archive a student" });
        return;
      }

      const ok = archived
        ? await studentService.archiveStudent(studentId)
        : await studentService.restoreStudent(studentId);
      if (!ok) {
        res.status(404).json({ success: false, message: "student not found" });
        return;
      }

      activityLogService.log({
        userId: currentUser.id,
        eventType: "update",
        subjectType1: "student",
        subjectId1: studentId,
        details: { action: archived ? "archive" : "restore" },
      });
      res.json({ success: true, archived });
    } catch (error: any) {
      console.error(`Error ${archived ? "archiving" : "restoring"} student:`, error);
      res.status(500).json({ success: false, message: error.message || "Failed to update student" });
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
   * Link another user to an student.
   *
   * 🚨 AUTHORIZATION IS DERIVED FROM THE STUDENT, NEVER FROM THE REQUEST
   * (2026-09-10). `instituteId` may still arrive in the body — the clinician
   * client sends its selected institute — but it is IGNORED. Until this date
   * it was the authorization input: the handler proved the caller administered
   * the institute they named and that the target belonged to it, and never
   * asked whether the STUDENT was enrolled in it. Any admin of any school or
   * clinic could therefore name their own institute, their own user id and any
   * student uuid, and `role` was written through unvalidated — so the link they
   * granted themselves could be `owner`, which carries full PHI access and the
   * owner-only student delete. See `studentService.getStudentLinkAuthority`
   * and §5.5.1 of docs/SECURITY_ARCHITECTURE.md.
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

      // Authorization FIRST, and before the requested role is even looked at,
      // so a caller with no authority learns nothing about the student or the
      // role vocabulary.
      const authority = await studentService.getStudentLinkAuthority(studentId, currentUser.id);
      if (!authority) {
        res.status(403).json({ success: false, message: "Only student owners or institute admins can link users" });
        return;
      }

      const requestedRole = role ?? "caregiver";
      if (!isUserStudentRole(requestedRole)) {
        res.status(400).json({
          success: false,
          message: `Invalid role. Must be one of: ${USER_STUDENT_ROLES.join(", ")}`,
        });
        return;
      }

      // Ownership is the family's relationship to their child. An institute
      // admin may grant every other role but never this one — granting it to
      // themselves is the escalation, and granting it to a colleague is the
      // same escalation one step removed.
      if (
        authority.grant !== "owner" &&
        !INSTITUTE_ADMIN_GRANTABLE_ROLES.includes(requestedRole)
      ) {
        res.status(403).json({ success: false, message: "Only a student owner can grant the owner role" });
        return;
      }

      if (authority.grant === "institute_admin") {
        // The target must belong to the institute that justified the write —
        // the DERIVED one, which the student is provably enrolled in.
        const targetIsMember = await instituteRepository.isUserMemberOfInstitute(
          authority.instituteId,
          targetUserId,
        );
        if (!targetIsMember) {
          res.status(400).json({ success: false, message: "Target user is not a member of this institute" });
          return;
        }

        // Re-linking is an UPDATE (see linkUserToStudent), so without this an
        // admin could demote the real owner to `caregiver` and then unlink
        // them — "cannot unlink the owner" only protects a row that still says
        // owner.
        const existing = await studentService.getUserStudentLink(targetUserId, studentId);
        if (existing?.role === "owner") {
          res.status(403).json({ success: false, message: "Only a student owner can change the owner's link" });
          return;
        }
      }

      const link = await studentService.linkUserToStudent(
        targetUserId,
        studentId,
        requestedRole
      );

      res.json({
        success: true,
        message: "User linked successfully",
        link,
      });

      activityLogService.log({
        // The institute that JUSTIFIED the write, not one the caller typed.
        instituteId: authority.grant === "institute_admin" ? authority.instituteId : null,
        userId: currentUser.id,
        eventType: "link",
        subjectType1: "student",
        subjectId1: studentId,
        subjectType2: "user",
        subjectId2: targetUserId,
        details: { role: requestedRole, grant: authority.grant },
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
   * Remove a user's link to an student.
   *
   * 🚨 Same rule and same history as `linkUser` (2026-09-10): the query-string
   * `instituteId` used to be the authorization input and the student was never
   * tied to it, so any school/clinic admin could strip a student's caregivers —
   * every non-owner link, for any student in the system. Authority now comes
   * from `getStudentLinkAuthority`, which starts at the student's enrolments.
   */
  async unlinkUser(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;
      const targetUserId = req.params.userId;

      const authority = await studentService.getStudentLinkAuthority(studentId, currentUser.id);
      if (!authority) {
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
          instituteId: authority.grant === "institute_admin" ? authority.instituteId : null,
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

  /**
   * GET /api/students/:id/institute-members
   * Users who share at least one active institute with this student —
   * the pool of valid candidates for assigning service users.
   */
  async getInstituteMembers(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const members = await studentService.getUsersSharingInstituteWithStudent(studentId);
      res.json({ success: true, members });
    } catch (error: any) {
      console.error("Error fetching institute members for student:", error);
      res.status(500).json({ success: false, message: "Failed to fetch institute members" });
    }
  }
}

export const studentController = new StudentController();
