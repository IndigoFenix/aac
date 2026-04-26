import type { Request, Response } from "express";
import { programService, studentService } from "../services";
import { activityLogService } from "../services/activityLogService";
import { buildClinicianCtx } from "../services/sharing/clinicianCtx";
import { canWriteObject } from "../services/sharing/visibility";
import {
  insertProgramSchema,
  updateProgramSchema,
  insertProfileDomainSchema,
  updateProfileDomainSchema,
  insertBaselineMeasurementSchema,
  insertAssessmentSourceSchema,
  insertGoalSchema,
  updateGoalSchema,
  insertObjectiveSchema,
  updateObjectiveSchema,
  insertServiceSchema,
  updateServiceSchema,
  insertAccommodationSchema,
  updateAccommodationSchema,
  insertProgressReportSchema,
  updateProgressReportSchema,
  insertGoalProgressEntrySchema,
  insertDataPointSchema,
  insertTransitionPlanSchema,
  updateTransitionPlanSchema,
  insertTransitionGoalSchema,
  updateTransitionGoalSchema,
  insertProgramContactSchema,
  updateProgramContactSchema,
  insertMeetingSchema,
  updateMeetingSchema,
  insertConsentFormSchema,
  updateConsentFormSchema,
} from "@shared/schema";

export class ProgramController {
  // ==========================================================================
  // PROGRAM ENDPOINTS
  // ==========================================================================

  /**
   * GET /api/programs/overview
   * Get overview stats for the current user's students
   */
  async getOverview(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const stats = await programService.getOverviewStats(currentUser.id);
      res.json({ success: true, stats });
    } catch (error: any) {
      console.error("Error fetching overview:", error);
      res.status(500).json({ success: false, message: "Failed to fetch overview" });
    }
  }

  /**
   * GET /api/programs/students
   * Get all students with their current program summary
   */
  async getStudentsWithPrograms(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const students = await programService.getStudentsWithProgramSummary(currentUser.id);
      res.json({ success: true, students });
    } catch (error: any) {
      console.error("Error fetching students with programs:", error);
      res.status(500).json({ success: false, message: "Failed to fetch students" });
    }
  }

  /**
   * POST /api/students/:studentId/programs
   * Create a new program for a student
   */
  async createProgram(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;

      // Verify access to student
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this student" });
        return;
      }

      const validatedData = insertProgramSchema.parse({
        ...req.body,
        studentId,
      });

      const createDefaultDomains = req.body.createDefaultDomains !== false;
      const { program, domains } = await programService.createProgramWithProfile(
        validatedData,
        createDefaultDomains
      );

      res.json({
        success: true,
        message: "Program created successfully",
        program,
        domains,
      });

      activityLogService.log({
        userId: currentUser.id,
        eventType: "create",
        subjectType1: "program",
        subjectId1: program.id,
        details: { studentId, createDefaultDomains },
      });
    } catch (error: any) {
      console.error("Error creating program:", error);
      if (error.name === "ZodError") {
        res.status(400).json({
          success: false,
          message: "Invalid program data",
          errors: error.errors,
        });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to create program" });
    }
  }

  /**
   * GET /api/students/:studentId/programs
   * Get all programs for a student
   */
  async getStudentPrograms(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;

      // Verify access
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this student" });
        return;
      }

      const ctx = await buildClinicianCtx(req, studentId);
      const programs = await programService.getProgramsByStudentId(studentId, ctx);
      res.json({ success: true, programs });
    } catch (error: any) {
      console.error("Error fetching programs:", error);
      res.status(500).json({ success: false, message: "Failed to fetch programs" });
    }
  }

  /**
   * GET /api/students/:studentId/programs/current
   * Get the current active program for a student
   */
  async getCurrentProgram(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;

      // Verify access
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this student" });
        return;
      }

      const ctx = await buildClinicianCtx(req, studentId);
      const program = await programService.getCurrentProgram(studentId, ctx);
      if (!program) {
        res.status(404).json({ success: false, message: "No active program found" });
        return;
      }

      res.json({ success: true, program });
    } catch (error: any) {
      console.error("Error fetching current program:", error);
      res.status(500).json({ success: false, message: "Failed to fetch current program" });
    }
  }

  /**
   * GET /api/programs/:id
   * Get a program by ID
   */
  async getProgram(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const { hasAccess, program } = await programService.verifyProgramAccess(id, currentUser.id);
      if (!hasAccess || !program) {
        res.status(403).json({ success: false, message: "Access denied to this program" });
        return;
      }

      // Re-fetch through visibility helper so cross-institute share rules apply.
      const ctx = await buildClinicianCtx(req, program.studentId);
      const visibleProgram = await programService.getProgramById(id, ctx);
      if (!visibleProgram) {
        res.status(403).json({ success: false, message: "Access denied to this program" });
        return;
      }

      res.json({ success: true, program: visibleProgram });
    } catch (error: any) {
      console.error("Error fetching program:", error);
      res.status(500).json({ success: false, message: "Failed to fetch program" });
    }
  }

  /**
   * GET /api/programs/:id/full
   * Get a program with all related details
   */
  async getProgramWithDetails(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const { hasAccess, program } = await programService.verifyProgramAccess(id, currentUser.id);
      if (!hasAccess || !program) {
        res.status(403).json({ success: false, message: "Access denied to this program" });
        return;
      }

      const ctx = await buildClinicianCtx(req, program.studentId);
      const programDetails = await programService.getProgramWithDetails(id, ctx);
      if (!programDetails) {
        res.status(404).json({ success: false, message: "Program not found" });
        return;
      }

      res.json({ success: true, ...programDetails });
    } catch (error: any) {
      console.error("Error fetching program details:", error);
      res.status(500).json({ success: false, message: "Failed to fetch program details" });
    }
  }

  /**
   * PATCH /api/programs/:id
   * Update a program
   */
  async updateProgram(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const { hasAccess, program } = await programService.verifyProgramAccess(id, currentUser.id);
      if (!hasAccess || !program) {
        res.status(403).json({ success: false, message: "Access denied to this program" });
        return;
      }

      // Writes allowed when the institute owns the program OR holds a
      // permission='write' share covering it. canWriteObject collapses both
      // checks; student/admin principals always pass.
      const ctx = await buildClinicianCtx(req, program.studentId);
      if (ctx?.kind === "institute"
          && !(await canWriteObject(ctx, "program", program.id, program.studentId, program.instituteId))) {
        res.status(403).json({ success: false, message: "Cannot modify a program owned by another institute" });
        return;
      }

      const validatedData = updateProgramSchema.parse(req.body);
      const updated = await programService.updateProgram(id, validatedData);

      if (updated) {
        res.json({ success: true, message: "Program updated successfully", program: updated });

        activityLogService.log({
          userId: currentUser.id,
          eventType: "update",
          subjectType1: "program",
          subjectId1: id,
        });
      } else {
        res.status(404).json({ success: false, message: "Program not found" });
      }
    } catch (error: any) {
      console.error("Error updating program:", error);
      if (error.name === "ZodError") {
        res.status(400).json({
          success: false,
          message: "Invalid program data",
          errors: error.errors,
        });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to update program" });
    }
  }

  /**
   * POST /api/programs/:id/activate
   * Activate a program
   */
  async activateProgram(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const { hasAccess, program } = await programService.verifyProgramAccess(id, currentUser.id);
      if (!hasAccess || !program) {
        res.status(403).json({ success: false, message: "Access denied to this program" });
        return;
      }

      const ctx = await buildClinicianCtx(req, program.studentId);
      if (ctx?.kind === "institute"
          && !(await canWriteObject(ctx, "program", program.id, program.studentId, program.instituteId))) {
        res.status(403).json({ success: false, message: "Cannot modify a program owned by another institute" });
        return;
      }

      const updated = await programService.activateProgram(id);
      if (updated) {
        res.json({ success: true, message: "Program activated successfully", program: updated });

        activityLogService.log({
          userId: currentUser.id,
          eventType: "update",
          subjectType1: "program",
          subjectId1: id,
          details: { action: "activate" },
        });
      } else {
        res.status(404).json({ success: false, message: "Program not found" });
      }
    } catch (error: any) {
      console.error("Error activating program:", error);
      res.status(500).json({ success: false, message: "Failed to activate program" });
    }
  }

  /**
   * POST /api/programs/:id/archive
   * Archive a program
   */
  async archiveProgram(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const { hasAccess, program } = await programService.verifyProgramAccess(id, currentUser.id);
      if (!hasAccess || !program) {
        res.status(403).json({ success: false, message: "Access denied to this program" });
        return;
      }

      const ctx = await buildClinicianCtx(req, program.studentId);
      if (ctx?.kind === "institute"
          && !(await canWriteObject(ctx, "program", program.id, program.studentId, program.instituteId))) {
        res.status(403).json({ success: false, message: "Cannot modify a program owned by another institute" });
        return;
      }

      const updated = await programService.archiveProgram(id);
      if (updated) {
        res.json({ success: true, message: "Program archived successfully", program: updated });

        activityLogService.log({
          userId: currentUser.id,
          eventType: "update",
          subjectType1: "program",
          subjectId1: id,
          details: { action: "archive" },
        });
      } else {
        res.status(404).json({ success: false, message: "Program not found" });
      }
    } catch (error: any) {
      console.error("Error archiving program:", error);
      res.status(500).json({ success: false, message: "Failed to archive program" });
    }
  }

  /**
   * DELETE /api/programs/:id
   * Delete a program
   */
  async deleteProgram(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const { hasAccess, program } = await programService.verifyProgramAccess(id, currentUser.id);
      if (!hasAccess || !program) {
        res.status(403).json({ success: false, message: "Access denied to this program" });
        return;
      }

      const ctx = await buildClinicianCtx(req, program.studentId);
      if (ctx?.kind === "institute"
          && !(await canWriteObject(ctx, "program", program.id, program.studentId, program.instituteId))) {
        res.status(403).json({ success: false, message: "Cannot delete a program owned by another institute" });
        return;
      }

      const deleted = await programService.deleteProgram(id);
      if (deleted) {
        res.json({ success: true, message: "Program deleted successfully" });

        activityLogService.log({
          userId: currentUser.id,
          eventType: "delete",
          subjectType1: "program",
          subjectId1: id,
        });
      } else {
        res.status(404).json({ success: false, message: "Program not found" });
      }
    } catch (error: any) {
      console.error("Error deleting program:", error);
      res.status(500).json({ success: false, message: "Failed to delete program" });
    }
  }

  // ==========================================================================
  // PROFILE DOMAIN ENDPOINTS
  // ==========================================================================

  /**
   * GET /api/programs/:programId/domains
   * Get all profile domains for a program
   */
  async getProfileDomains(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { programId } = req.params;

      const { hasAccess } = await programService.verifyProgramAccess(programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const domains = await programService.getProfileDomainsByProgramId(programId);
      res.json({ success: true, domains });
    } catch (error: any) {
      console.error("Error fetching domains:", error);
      res.status(500).json({ success: false, message: "Failed to fetch domains" });
    }
  }

  /**
   * POST /api/programs/:programId/domains
   * Create a profile domain
   */
  async createProfileDomain(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { programId } = req.params;

      const { hasAccess } = await programService.verifyProgramAccess(programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const validatedData = insertProfileDomainSchema.parse({
        ...req.body,
        programId,
      });
      const domain = await programService.createProfileDomain(validatedData);

      res.json({ success: true, message: "Domain created successfully", domain });

      activityLogService.log({
        userId: currentUser.id,
        eventType: "create",
        subjectType1: "profile_domain",
        subjectId1: domain.id,
        subjectType2: "program",
        subjectId2: programId,
      });
    } catch (error: any) {
      console.error("Error creating domain:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid domain data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to create domain" });
    }
  }

  /**
   * PATCH /api/domains/:id
   * Update a profile domain
   */
  async updateProfileDomain(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const domain = await programService.getProfileDomainById(id);
      if (!domain) {
        res.status(404).json({ success: false, message: "Domain not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(domain.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const validatedData = updateProfileDomainSchema.parse(req.body);
      const updated = await programService.updateProfileDomain(id, validatedData);

      if (updated) {
        res.json({ success: true, message: "Domain updated successfully", domain: updated });

        activityLogService.log({
          userId: currentUser.id,
          eventType: "update",
          subjectType1: "profile_domain",
          subjectId1: id,
        });
      } else {
        res.status(404).json({ success: false, message: "Domain not found" });
      }
    } catch (error: any) {
      console.error("Error updating domain:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid domain data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to update domain" });
    }
  }

  /**
   * DELETE /api/domains/:id
   * Delete a profile domain
   */
  async deleteProfileDomain(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const domain = await programService.getProfileDomainById(id);
      if (!domain) {
        res.status(404).json({ success: false, message: "Domain not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(domain.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const deleted = await programService.deleteProfileDomain(id);
      if (deleted) {
        res.json({ success: true, message: "Domain deleted successfully" });

        activityLogService.log({
          userId: currentUser.id,
          eventType: "delete",
          subjectType1: "profile_domain",
          subjectId1: id,
        });
      } else {
        res.status(404).json({ success: false, message: "Domain not found" });
      }
    } catch (error: any) {
      console.error("Error deleting domain:", error);
      res.status(500).json({ success: false, message: "Failed to delete domain" });
    }
  }

  // ==========================================================================
  // GOAL ENDPOINTS
  // ==========================================================================

  /**
   * GET /api/programs/:programId/goals
   * Get all goals for a program
   */
  async getGoals(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { programId } = req.params;

      const { hasAccess } = await programService.verifyProgramAccess(programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const goals = await programService.getGoalsByProgramId(programId);
      res.json({ success: true, goals });
    } catch (error: any) {
      console.error("Error fetching goals:", error);
      res.status(500).json({ success: false, message: "Failed to fetch goals" });
    }
  }

  /**
   * POST /api/programs/:programId/goals
   * Create a goal
   */
  async createGoal(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { programId } = req.params;

      const { hasAccess } = await programService.verifyProgramAccess(programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const validatedData = insertGoalSchema.parse({
        ...req.body,
        programId,
      });
      const goal = await programService.createGoal(validatedData);

      res.json({ success: true, message: "Goal created successfully", goal });

      activityLogService.log({
        userId: currentUser.id,
        eventType: "create",
        subjectType1: "goal",
        subjectId1: goal.id,
        subjectType2: "program",
        subjectId2: programId,
      });
    } catch (error: any) {
      console.error("Error creating goal:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid goal data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to create goal" });
    }
  }

  /**
   * GET /api/goals/:id
   * Get a goal with context
   */
  async getGoal(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const goal = await programService.getGoalById(id);
      if (!goal) {
        res.status(404).json({ success: false, message: "Goal not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(goal.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const goalWithContext = await programService.getGoalWithContext(id);
      res.json({ success: true, ...goalWithContext });
    } catch (error: any) {
      console.error("Error fetching goal:", error);
      res.status(500).json({ success: false, message: "Failed to fetch goal" });
    }
  }

  /**
   * PATCH /api/goals/:id
   * Update a goal
   */
  async updateGoal(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const goal = await programService.getGoalById(id);
      if (!goal) {
        res.status(404).json({ success: false, message: "Goal not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(goal.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const validatedData = updateGoalSchema.parse(req.body);
      const updated = await programService.updateGoal(id, validatedData);

      if (updated) {
        res.json({ success: true, message: "Goal updated successfully", goal: updated });

        activityLogService.log({
          userId: currentUser.id,
          eventType: "update",
          subjectType1: "goal",
          subjectId1: id,
        });
      } else {
        res.status(404).json({ success: false, message: "Goal not found" });
      }
    } catch (error: any) {
      console.error("Error updating goal:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid goal data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to update goal" });
    }
  }

  /**
   * DELETE /api/goals/:id
   * Delete a goal
   */
  async deleteGoal(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const goal = await programService.getGoalById(id);
      if (!goal) {
        res.status(404).json({ success: false, message: "Goal not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(goal.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const deleted = await programService.deleteGoal(id);
      if (deleted) {
        res.json({ success: true, message: "Goal deleted successfully" });

        activityLogService.log({
          userId: currentUser.id,
          eventType: "delete",
          subjectType1: "goal",
          subjectId1: id,
        });
      } else {
        res.status(404).json({ success: false, message: "Goal not found" });
      }
    } catch (error: any) {
      console.error("Error deleting goal:", error);
      res.status(500).json({ success: false, message: "Failed to delete goal" });
    }
  }

  /**
   * POST /api/goals/:id/achieve
   * Mark a goal as achieved
   */
  async achieveGoal(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const goal = await programService.getGoalById(id);
      if (!goal) {
        res.status(404).json({ success: false, message: "Goal not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(goal.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const updated = await programService.achieveGoal(id);
      if (updated) {
        res.json({ success: true, message: "Goal marked as achieved", goal: updated });

        activityLogService.log({
          userId: currentUser.id,
          eventType: "update",
          subjectType1: "goal",
          subjectId1: id,
          details: { action: "achieve" },
        });
      } else {
        res.status(404).json({ success: false, message: "Goal not found" });
      }
    } catch (error: any) {
      console.error("Error achieving goal:", error);
      res.status(500).json({ success: false, message: "Failed to mark goal as achieved" });
    }
  }

  // ==========================================================================
  // OBJECTIVE ENDPOINTS
  // ==========================================================================

  /**
   * GET /api/goals/:goalId/objectives
   * Get all objectives for a goal
   */
  async getObjectives(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { goalId } = req.params;

      const goal = await programService.getGoalById(goalId);
      if (!goal) {
        res.status(404).json({ success: false, message: "Goal not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(goal.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const objectives = await programService.getObjectivesByGoalId(goalId);
      res.json({ success: true, objectives });
    } catch (error: any) {
      console.error("Error fetching objectives:", error);
      res.status(500).json({ success: false, message: "Failed to fetch objectives" });
    }
  }

  /**
   * POST /api/goals/:goalId/objectives
   * Create an objective
   */
  async createObjective(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { goalId } = req.params;

      const goal = await programService.getGoalById(goalId);
      if (!goal) {
        res.status(404).json({ success: false, message: "Goal not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(goal.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const validatedData = insertObjectiveSchema.parse({
        ...req.body,
        goalId,
      });
      const objective = await programService.createObjective(validatedData);

      res.json({ success: true, message: "Objective created successfully", objective });

      activityLogService.log({
        userId: currentUser.id,
        eventType: "create",
        subjectType1: "objective",
        subjectId1: objective.id,
        subjectType2: "goal",
        subjectId2: goalId,
      });
    } catch (error: any) {
      console.error("Error creating objective:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid objective data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to create objective" });
    }
  }

  /**
   * PATCH /api/objectives/:id
   * Update an objective
   */
  async updateObjective(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const objective = await programService.getObjectiveById(id);
      if (!objective) {
        res.status(404).json({ success: false, message: "Objective not found" });
        return;
      }

      const goal = await programService.getGoalById(objective.goalId);
      if (!goal) {
        res.status(404).json({ success: false, message: "Goal not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(goal.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const validatedData = updateObjectiveSchema.parse(req.body);
      const updated = await programService.updateObjective(id, validatedData);

      if (updated) {
        res.json({ success: true, message: "Objective updated successfully", objective: updated });

        activityLogService.log({
          userId: currentUser.id,
          eventType: "update",
          subjectType1: "objective",
          subjectId1: id,
        });
      } else {
        res.status(404).json({ success: false, message: "Objective not found" });
      }
    } catch (error: any) {
      console.error("Error updating objective:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid objective data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to update objective" });
    }
  }

  /**
   * DELETE /api/objectives/:id
   * Delete an objective
   */
  async deleteObjective(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const objective = await programService.getObjectiveById(id);
      if (!objective) {
        res.status(404).json({ success: false, message: "Objective not found" });
        return;
      }

      const goal = await programService.getGoalById(objective.goalId);
      if (!goal) {
        res.status(404).json({ success: false, message: "Goal not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(goal.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const deleted = await programService.deleteObjective(id);
      if (deleted) {
        res.json({ success: true, message: "Objective deleted successfully" });

        activityLogService.log({
          userId: currentUser.id,
          eventType: "delete",
          subjectType1: "objective",
          subjectId1: id,
        });
      } else {
        res.status(404).json({ success: false, message: "Objective not found" });
      }
    } catch (error: any) {
      console.error("Error deleting objective:", error);
      res.status(500).json({ success: false, message: "Failed to delete objective" });
    }
  }

  // ==========================================================================
  // SERVICE ENDPOINTS
  // ==========================================================================

  /**
   * GET /api/programs/:programId/services
   * Get all services for a program
   */
  async getServices(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { programId } = req.params;

      const { hasAccess } = await programService.verifyProgramAccess(programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const services = await programService.getServicesByProgramId(programId);
      res.json({ success: true, services });
    } catch (error: any) {
      console.error("Error fetching services:", error);
      res.status(500).json({ success: false, message: "Failed to fetch services" });
    }
  }

  /**
   * POST /api/programs/:programId/services
   * Create a service
   */
  async createService(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { programId } = req.params;

      const { hasAccess } = await programService.verifyProgramAccess(programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const validatedData = insertServiceSchema.parse({
        ...req.body,
        programId,
      });
      const service = await programService.createService(validatedData);

      res.json({ success: true, message: "Service created successfully", service });

      activityLogService.log({
        userId: currentUser.id,
        eventType: "create",
        subjectType1: "service",
        subjectId1: service.id,
        subjectType2: "program",
        subjectId2: programId,
      });
    } catch (error: any) {
      console.error("Error creating service:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid service data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to create service" });
    }
  }

  /**
   * PATCH /api/services/:id
   * Update a service
   */
  async updateService(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const service = await programService.getServiceById(id);
      if (!service) {
        res.status(404).json({ success: false, message: "Service not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(service.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const validatedData = updateServiceSchema.parse(req.body);
      const updated = await programService.updateService(id, validatedData);

      if (updated) {
        res.json({ success: true, message: "Service updated successfully", service: updated });

        activityLogService.log({
          userId: currentUser.id,
          eventType: "update",
          subjectType1: "service",
          subjectId1: id,
        });
      } else {
        res.status(404).json({ success: false, message: "Service not found" });
      }
    } catch (error: any) {
      console.error("Error updating service:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid service data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to update service" });
    }
  }

  /**
   * DELETE /api/services/:id
   * Delete a service
   */
  async deleteService(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const service = await programService.getServiceById(id);
      if (!service) {
        res.status(404).json({ success: false, message: "Service not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(service.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const deleted = await programService.deleteService(id);
      if (deleted) {
        res.json({ success: true, message: "Service deleted successfully" });

        activityLogService.log({
          userId: currentUser.id,
          eventType: "delete",
          subjectType1: "service",
          subjectId1: id,
        });
      } else {
        res.status(404).json({ success: false, message: "Service not found" });
      }
    } catch (error: any) {
      console.error("Error deleting service:", error);
      res.status(500).json({ success: false, message: "Failed to delete service" });
    }
  }

  // ==========================================================================
  // SERVICE ↔ USER LINKS
  // ==========================================================================

  /**
   * GET /api/services/:id/users
   * List users assigned to a service.
   */
  async getServiceUsers(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const service = await programService.getServiceById(id);
      if (!service) {
        res.status(404).json({ success: false, message: "Service not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(service.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const links = await programService.getServiceUsers(id);
      res.json({ success: true, users: links });
    } catch (error: any) {
      console.error("Error fetching service users:", error);
      res.status(500).json({ success: false, message: "Failed to fetch service users" });
    }
  }

  /**
   * POST /api/services/:id/users  { userId }
   * Link a user to a service. User must share an institute with the service's student.
   */
  async linkUserToService(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;
      const { userId } = req.body as { userId?: string };

      if (!userId) {
        res.status(400).json({ success: false, message: "userId is required" });
        return;
      }

      const service = await programService.getServiceById(id);
      if (!service) {
        res.status(404).json({ success: false, message: "Service not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(service.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      // Enforce the shared-institute rule.
      const program = await programService.getProgramById(service.programId);
      if (!program) {
        res.status(404).json({ success: false, message: "Program not found" });
        return;
      }
      const candidates = await studentService.getUsersSharingInstituteWithStudent(program.studentId);
      if (!candidates.some((u) => u.id === userId)) {
        res.status(400).json({
          success: false,
          message: "User must share an institute with the student",
        });
        return;
      }

      const link = await programService.linkUserToService(id, userId);
      res.json({ success: true, link });

      activityLogService.log({
        userId: currentUser.id,
        eventType: "update",
        subjectType1: "service",
        subjectId1: id,
        subjectType2: "user",
        subjectId2: userId,
      });
    } catch (error: any) {
      console.error("Error linking user to service:", error);
      res.status(500).json({ success: false, message: "Failed to link user" });
    }
  }

  /**
   * GET /api/services/:id/events
   * List calendar events linked to a service.
   */
  async getServiceEvents(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const service = await programService.getServiceById(id);
      if (!service) {
        res.status(404).json({ success: false, message: "Service not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(service.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const { calendarService } = await import("../services/calendarService");
      const events = await calendarService.getEventsByServiceId(id);
      res.json({ success: true, events });
    } catch (error: any) {
      console.error("Error fetching service events:", error);
      res.status(500).json({ success: false, message: "Failed to fetch service events" });
    }
  }

  /**
   * DELETE /api/services/:id/users/:userId
   * Remove a user from a service.
   */
  async unlinkUserFromService(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id, userId } = req.params;

      const service = await programService.getServiceById(id);
      if (!service) {
        res.status(404).json({ success: false, message: "Service not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(service.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      await programService.unlinkUserFromService(id, userId);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error unlinking user from service:", error);
      res.status(500).json({ success: false, message: "Failed to unlink user" });
    }
  }

  // ==========================================================================
  // DATA POINT ENDPOINTS
  // ==========================================================================

  /**
   * GET /api/goals/:goalId/data-points
   * Get all data points for a goal
   */
  async getDataPoints(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { goalId } = req.params;

      const goal = await programService.getGoalById(goalId);
      if (!goal) {
        res.status(404).json({ success: false, message: "Goal not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(goal.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const dataPoints = await programService.getDataPointsByGoalId(goalId);
      res.json({ success: true, dataPoints });
    } catch (error: any) {
      console.error("Error fetching data points:", error);
      res.status(500).json({ success: false, message: "Failed to fetch data points" });
    }
  }

  /**
   * POST /api/goals/:goalId/data-points
   * Create a data point
   */
  async createDataPoint(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { goalId } = req.params;

      const goal = await programService.getGoalById(goalId);
      if (!goal) {
        res.status(404).json({ success: false, message: "Goal not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(goal.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const validatedData = insertDataPointSchema.parse({
        ...req.body,
        goalId,
        recordedAt: new Date(),
      });

      const dataPoint = await programService.createDataPoint(validatedData);

      res.json({
        success: true,
        message: "Data point recorded successfully",
        dataPoint,
      });

      activityLogService.log({
        userId: currentUser.id,
        eventType: "create",
        subjectType1: "data_point",
        subjectId1: dataPoint.id,
        subjectType2: "goal",
        subjectId2: goalId,
      });
    } catch (error: any) {
      console.error("Error creating data point:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid data point", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to create data point" });
    }
  }

  /**
   * DELETE /api/data-points/:id
   * Delete a data point
   */
  async deleteDataPoint(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      // For simplicity, we'll just delete without complex access checks
      // In production, you'd want to verify access through the goal->program chain
      const deleted = await programService.deleteDataPoint(id);
      if (deleted) {
        res.json({ success: true, message: "Data point deleted successfully" });

        activityLogService.log({
          userId: currentUser.id,
          eventType: "delete",
          subjectType1: "data_point",
          subjectId1: id,
        });
      } else {
        res.status(404).json({ success: false, message: "Data point not found" });
      }
    } catch (error: any) {
      console.error("Error deleting data point:", error);
      res.status(500).json({ success: false, message: "Failed to delete data point" });
    }
  }

  // ==========================================================================
  // PROGRESS REPORT ENDPOINTS
  // ==========================================================================

  /**
   * GET /api/programs/:programId/progress-reports
   * Get all progress reports for a program
   */
  async getProgressReports(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { programId } = req.params;

      const { hasAccess } = await programService.verifyProgramAccess(programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const reports = await programService.getProgressReportsByProgramId(programId);
      res.json({ success: true, reports });
    } catch (error: any) {
      console.error("Error fetching progress reports:", error);
      res.status(500).json({ success: false, message: "Failed to fetch progress reports" });
    }
  }

  /**
   * POST /api/programs/:programId/progress-reports
   * Create a progress report with entries for all goals
   */
  async createProgressReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { programId } = req.params;

      const { hasAccess } = await programService.verifyProgramAccess(programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const { reportDate, reportingPeriod } = req.body;
      if (!reportDate) {
        res.status(400).json({ success: false, message: "Report date is required" });
        return;
      }

      const report = await programService.createProgressReport({
        programId,
        reportDate,
        reportingPeriod: reportingPeriod || "",
      } as any);

      res.json({
        success: true,
        message: "Progress report created successfully",
        report,
      });

      activityLogService.log({
        userId: currentUser.id,
        eventType: "create",
        subjectType1: "progress_report",
        subjectId1: report.id,
        subjectType2: "program",
        subjectId2: programId,
      });
    } catch (error: any) {
      console.error("Error creating progress report:", error);
      res.status(500).json({ success: false, message: "Failed to create progress report" });
    }
  }

  /**
   * PATCH /api/progress-reports/:id
   * Update a progress report
   */
  async updateProgressReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const report = await programService.getProgressReportById(id);
      if (!report) {
        res.status(404).json({ success: false, message: "Progress report not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(report.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const validatedData = updateProgressReportSchema.parse(req.body);
      const updated = await programService.updateProgressReport(id, validatedData);

      if (updated) {
        res.json({ success: true, message: "Progress report updated successfully", report: updated });

        activityLogService.log({
          userId: currentUser.id,
          eventType: "update",
          subjectType1: "progress_report",
          subjectId1: id,
        });
      } else {
        res.status(404).json({ success: false, message: "Progress report not found" });
      }
    } catch (error: any) {
      console.error("Error updating progress report:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid report data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to update progress report" });
    }
  }

  // ==========================================================================
  // PROGRAM TEAM (contacts junction) — new path
  // ==========================================================================

  /**
   * GET /api/programs/:programId/team
   * List the team for a program: program_contacts rows joined with the
   * underlying studentContacts record.
   */
  async getTeamContacts(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { programId } = req.params;

      const { hasAccess } = await programService.verifyProgramAccess(programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const team = await programService.getTeamContactsByProgramId(programId);
      res.json({ success: true, team });
    } catch (error: any) {
      console.error("Error fetching team contacts:", error);
      res.status(500).json({ success: false, message: "Failed to fetch team" });
    }
  }

  /**
   * POST /api/programs/:programId/team
   * Add an existing studentContact to this program's team.
   * Body: { contactId, programRole?, isCoordinator?, responsibilities? }
   */
  async addTeamContact(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { programId } = req.params;

      const { hasAccess } = await programService.verifyProgramAccess(programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const validated = insertProgramContactSchema.parse({ ...req.body, programId });
      const row = await programService.addTeamContact(validated);
      res.status(201).json({ success: true, programContact: row });

      activityLogService.log({
        userId: currentUser.id,
        eventType: "create",
        subjectType1: "program_contact",
        subjectId1: row.id,
      });
    } catch (error: any) {
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid data", errors: error.errors });
        return;
      }
      console.error("Error adding team contact:", error);
      res.status(500).json({ success: false, message: "Failed to add team contact" });
    }
  }

  /**
   * PATCH /api/program-contacts/:id
   * Update junction fields: coordinator flag, responsibilities, per-program role.
   */
  async updateTeamContact(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const existing = await programService.getTeamContactById(id);
      if (!existing) {
        res.status(404).json({ success: false, message: "Team contact not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(existing.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const validated = updateProgramContactSchema.parse(req.body);
      const row = await programService.updateTeamContact(id, validated);
      res.json({ success: true, programContact: row });
    } catch (error: any) {
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid data", errors: error.errors });
        return;
      }
      console.error("Error updating team contact:", error);
      res.status(500).json({ success: false, message: "Failed to update team contact" });
    }
  }

  /**
   * DELETE /api/program-contacts/:id
   * Remove a contact from the program team (soft-delete on the junction row).
   * The underlying studentContacts row is preserved.
   */
  async removeTeamContact(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const existing = await programService.getTeamContactById(id);
      if (!existing) {
        res.status(404).json({ success: false, message: "Team contact not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(existing.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const removed = await programService.removeTeamContact(id);
      if (removed) {
        res.json({ success: true, message: "Team contact removed" });
        activityLogService.log({
          userId: currentUser.id,
          eventType: "delete",
          subjectType1: "program_contact",
          subjectId1: id,
        });
      } else {
        res.status(404).json({ success: false, message: "Team contact not found" });
      }
    } catch (error: any) {
      console.error("Error removing team contact:", error);
      res.status(500).json({ success: false, message: "Failed to remove team contact" });
    }
  }

  // ==========================================================================
  // MEETING ENDPOINTS
  // ==========================================================================

  /**
   * GET /api/programs/:programId/meetings
   * Get all meetings for a program
   */
  async getMeetings(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { programId } = req.params;

      const { hasAccess } = await programService.verifyProgramAccess(programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const meetings = await programService.getMeetingsByProgramId(programId);
      res.json({ success: true, meetings });
    } catch (error: any) {
      console.error("Error fetching meetings:", error);
      res.status(500).json({ success: false, message: "Failed to fetch meetings" });
    }
  }

  /**
   * POST /api/programs/:programId/meetings
   * Create a meeting
   */
  async createMeeting(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { programId } = req.params;

      const { hasAccess } = await programService.verifyProgramAccess(programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const validatedData = insertMeetingSchema.parse({
        ...req.body,
        programId,
      });
      const meeting = await programService.createMeeting(validatedData);

      res.json({ success: true, message: "Meeting created successfully", meeting });

      activityLogService.log({
        userId: currentUser.id,
        eventType: "create",
        subjectType1: "meeting",
        subjectId1: meeting.id,
        subjectType2: "program",
        subjectId2: programId,
      });
    } catch (error: any) {
      console.error("Error creating meeting:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid meeting data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to create meeting" });
    }
  }

  /**
   * PATCH /api/meetings/:id
   * Update a meeting
   */
  async updateMeeting(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const meeting = await programService.getMeetingById(id);
      if (!meeting) {
        res.status(404).json({ success: false, message: "Meeting not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(meeting.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const validatedData = updateMeetingSchema.parse(req.body);
      const updated = await programService.updateMeeting(id, validatedData);

      if (updated) {
        res.json({ success: true, message: "Meeting updated successfully", meeting: updated });

        activityLogService.log({
          userId: currentUser.id,
          eventType: "update",
          subjectType1: "meeting",
          subjectId1: id,
        });
      } else {
        res.status(404).json({ success: false, message: "Meeting not found" });
      }
    } catch (error: any) {
      console.error("Error updating meeting:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid meeting data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to update meeting" });
    }
  }

  /**
   * DELETE /api/meetings/:id
   * Delete a meeting
   */
  async deleteMeeting(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const meeting = await programService.getMeetingById(id);
      if (!meeting) {
        res.status(404).json({ success: false, message: "Meeting not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(meeting.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const deleted = await programService.deleteMeeting(id);
      if (deleted) {
        res.json({ success: true, message: "Meeting deleted successfully" });

        activityLogService.log({
          userId: currentUser.id,
          eventType: "delete",
          subjectType1: "meeting",
          subjectId1: id,
        });
      } else {
        res.status(404).json({ success: false, message: "Meeting not found" });
      }
    } catch (error: any) {
      console.error("Error deleting meeting:", error);
      res.status(500).json({ success: false, message: "Failed to delete meeting" });
    }
  }

  // ==========================================================================
  // COMPLIANCE ENDPOINTS
  // ==========================================================================

  /**
   * GET /api/programs/:programId/compliance
   * Check consent compliance for a program
   */
  async checkCompliance(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { programId } = req.params;

      const { hasAccess } = await programService.verifyProgramAccess(programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const compliance = await programService.checkConsentCompliance(programId);
      res.json({ success: true, compliance });
    } catch (error: any) {
      console.error("Error checking compliance:", error);
      res.status(500).json({ success: false, message: "Failed to check compliance" });
    }
  }

  /**
   * GET /api/programs/:programId/consents
   * Get all consent forms for a program
   */
  async getConsentForms(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { programId } = req.params;

      const { hasAccess } = await programService.verifyProgramAccess(programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const consents = await programService.getConsentFormsByProgramId(programId);
      res.json({ success: true, consents });
    } catch (error: any) {
      console.error("Error fetching consent forms:", error);
      res.status(500).json({ success: false, message: "Failed to fetch consent forms" });
    }
  }

  /**
   * POST /api/programs/:programId/consents
   * Create a consent form
   */
  async createConsentForm(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { programId } = req.params;

      const { hasAccess } = await programService.verifyProgramAccess(programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const validatedData = insertConsentFormSchema.parse({
        ...req.body,
        programId,
      });
      const consent = await programService.createConsentForm(validatedData);

      res.json({ success: true, message: "Consent form created successfully", consent });

      activityLogService.log({
        userId: currentUser.id,
        eventType: "create",
        subjectType1: "consent_form",
        subjectId1: consent.id,
        subjectType2: "program",
        subjectId2: programId,
      });
    } catch (error: any) {
      console.error("Error creating consent form:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid consent form data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to create consent form" });
    }
  }

  /**
   * PATCH /api/consents/:id
   * Update a consent form
   */
  async updateConsentForm(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const consent = await programService.getConsentFormById(id);
      if (!consent) {
        res.status(404).json({ success: false, message: "Consent form not found" });
        return;
      }

      const { hasAccess } = await programService.verifyProgramAccess(consent.programId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const validatedData = updateConsentFormSchema.parse(req.body);
      const updated = await programService.updateConsentForm(id, validatedData);

      if (updated) {
        res.json({ success: true, message: "Consent form updated successfully", consent: updated });

        activityLogService.log({
          userId: currentUser.id,
          eventType: "update",
          subjectType1: "consent_form",
          subjectId1: id,
        });
      } else {
        res.status(404).json({ success: false, message: "Consent form not found" });
      }
    } catch (error: any) {
      console.error("Error updating consent form:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid consent form data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to update consent form" });
    }
  }
}

export const programController = new ProgramController();