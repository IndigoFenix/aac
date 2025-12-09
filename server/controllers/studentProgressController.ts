/**
 * Student Progress Controller
 * server/controllers/studentProgressController.ts
 * 
 * API endpoints for student progress tracking (IEP/Tala)
 */

import type { Request, Response } from "express";
import { studentProgressService } from "../services/studentProgressService";
import { studentService } from "../services/studentService";
import {
  insertStudentPhaseSchema,
  updateStudentPhaseSchema,
  insertStudentGoalSchema,
  updateStudentGoalSchema,
  insertProgressEntrySchema,
  insertComplianceItemSchema,
  insertServiceRecommendationSchema,
} from "@shared/schema";

export class StudentProgressController {
  // ==========================================================================
  // OVERVIEW & DASHBOARD
  // ==========================================================================

  /**
   * GET /api/students/overview
   * Get dashboard overview statistics
   */
  async getOverview(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      
      const stats = await studentProgressService.getOverviewStats(currentUser.id);
      const phaseDistribution = await studentProgressService.getPhaseDistribution();
      const upcomingDeadlines = await studentProgressService.getStudentsWithUpcomingDeadlines(
        currentUser.id, 
        7
      );

      // Get AAC users to enrich deadline data
      const students = await studentService.getStudentsByUserId(currentUser.id);
      const studentMap = new Map(students.map(u => [u.id, u]));

      const enrichedDeadlines = upcomingDeadlines.map(d => ({
        ...d,
        studentName: studentMap.get(d.studentId)?.name || 'Unknown',
      }));

      res.json({
        success: true,
        stats,
        phaseDistribution,
        upcomingDeadlines: enrichedDeadlines,
      });
    } catch (error: any) {
      console.error("Error fetching overview:", error);
      res.status(500).json({ success: false, message: "Failed to fetch overview" });
    }
  }

  /**
   * GET /api/students/list
   * Get list of students with progress summaries
   */
  async getStudentsList(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      
      // Get all AAC users for this user
      const studentsWithLinks = await studentService.getStudentsWithLinksByUserId(currentUser.id);
      
      // Enrich with progress data
      const studentsWithProgress = await Promise.all(
        studentsWithLinks.map(async ({ student, link }) => {
          const progress = await studentProgressService.getFullStudentProgress(student.id);
          const currentPhase = progress.phases.find(p => p.status === 'in-progress');
          
          return {
            ...student,
            age: studentService.calculateAge(student.birthDate),
            role: link.role,
            linkId: link.id,
            progress: progress.overallProgress,
            currentPhase: currentPhase?.phaseName,
            nextDeadline: currentPhase?.dueDate,
            phaseCount: progress.phases.length,
            goalCount: progress.goals.length,
          };
        })
      );

      res.json({ success: true, students: studentsWithProgress });
    } catch (error: any) {
      console.error("Error fetching students list:", error);
      res.status(500).json({ success: false, message: "Failed to fetch students list" });
    }
  }

  // ==========================================================================
  // STUDENT PROGRESS
  // ==========================================================================

  /**
   * GET /api/students/:id/progress
   * Get full progress data for a student
   */
  async getStudentProgress(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      // Verify access
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this student" });
        return;
      }

      const student = await studentService.getStudentWithAge(studentId);
      if (!student) {
        res.status(404).json({ success: false, message: "Student not found" });
        return;
      }

      const progress = await studentProgressService.getFullStudentProgress(studentId);
      const baselineMetrics = await studentProgressService.getBaselineMetrics(studentId);

      res.json({
        success: true,
        student: student,
        progress,
        baselineMetrics,
      });
    } catch (error: any) {
      console.error("Error fetching student progress:", error);
      res.status(500).json({ success: false, message: "Failed to fetch student progress" });
    }
  }

  /**
   * POST /api/students/:id/initialize-progress
   * Initialize phases and compliance items for a new student
   */
  async initializeProgress(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;
      const { systemType = 'tala' } = req.body;

      // Verify access
      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this student" });
        return;
      }

      const phases = await studentProgressService.initializeStudentPhases(studentId, systemType);
      const complianceItems = await studentProgressService.initializeComplianceChecklist(studentId);

      res.json({
        success: true,
        message: "Progress initialized successfully",
        phases,
        complianceItems,
      });
    } catch (error: any) {
      console.error("Error initializing progress:", error);
      res.status(500).json({ success: false, message: "Failed to initialize progress" });
    }
  }

  // ==========================================================================
  // PHASE MANAGEMENT
  // ==========================================================================

  /**
   * GET /api/students/:id/phases
   * Get all phases for a student
   */
  async getPhases(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const phases = await studentProgressService.getPhases(studentId);
      res.json({ success: true, phases });
    } catch (error: any) {
      console.error("Error fetching phases:", error);
      res.status(500).json({ success: false, message: "Failed to fetch phases" });
    }
  }

  /**
   * PATCH /api/phases/:id
   * Update a phase
   */
  async updatePhase(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const phaseId = req.params.id;

      const validatedData = updateStudentPhaseSchema.parse(req.body);
      const phase = await studentProgressService.updatePhase(phaseId, validatedData);

      if (!phase) {
        res.status(404).json({ success: false, message: "Phase not found" });
        return;
      }

      res.json({ success: true, phase });
    } catch (error: any) {
      console.error("Error updating phase:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to update phase" });
    }
  }

  /**
   * POST /api/students/:id/advance-phase
   * Advance to the next phase
   */
  async advancePhase(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const nextPhase = await studentProgressService.advanceToNextPhase(studentId);
      
      if (!nextPhase) {
        res.status(400).json({ success: false, message: "Cannot advance phase - already at final phase or no active phase" });
        return;
      }

      res.json({ success: true, message: "Advanced to next phase", phase: nextPhase });
    } catch (error: any) {
      console.error("Error advancing phase:", error);
      res.status(500).json({ success: false, message: "Failed to advance phase" });
    }
  }

  // ==========================================================================
  // GOAL MANAGEMENT
  // ==========================================================================

  /**
   * GET /api/students/:id/goals
   * Get all goals for a student
   */
  async getGoals(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const goals = await studentProgressService.getGoals(studentId);
      res.json({ success: true, goals });
    } catch (error: any) {
      console.error("Error fetching goals:", error);
      res.status(500).json({ success: false, message: "Failed to fetch goals" });
    }
  }

  /**
   * POST /api/students/:id/goals
   * Create a new goal
   */
  async createGoal(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const validatedData = insertStudentGoalSchema.parse({
        ...req.body,
        studentId,
      });

      const goal = await studentProgressService.createGoal(validatedData);
      res.json({ success: true, message: "Goal created", goal });
    } catch (error: any) {
      console.error("Error creating goal:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to create goal" });
    }
  }

  /**
   * PATCH /api/goals/:id
   * Update a goal
   */
  async updateGoal(req: Request, res: Response): Promise<void> {
    try {
      const goalId = req.params.id;
      const validatedData = updateStudentGoalSchema.parse(req.body);
      
      const goal = await studentProgressService.updateGoal(goalId, validatedData);
      if (!goal) {
        res.status(404).json({ success: false, message: "Goal not found" });
        return;
      }

      res.json({ success: true, goal });
    } catch (error: any) {
      console.error("Error updating goal:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid data", errors: error.errors });
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
      const goalId = req.params.id;
      const deleted = await studentProgressService.deleteGoal(goalId);
      
      if (!deleted) {
        res.status(404).json({ success: false, message: "Goal not found" });
        return;
      }

      res.json({ success: true, message: "Goal deleted" });
    } catch (error: any) {
      console.error("Error deleting goal:", error);
      res.status(500).json({ success: false, message: "Failed to delete goal" });
    }
  }

  /**
   * POST /api/goals/:id/generate-statement
   * Generate a SMART goal statement
   */
  async generateGoalStatement(req: Request, res: Response): Promise<void> {
    try {
      const goalId = req.params.id;
      const { studentName } = req.body;

      // Get the goal
      const goals = await studentProgressService.getGoals(req.body.studentId);
      const goal = goals.find(g => g.id === goalId);

      if (!goal) {
        res.status(404).json({ success: false, message: "Goal not found" });
        return;
      }

      const statement = studentProgressService.generateSmartGoalStatement(
        studentName || 'the student',
        goal
      );

      res.json({ success: true, statement });
    } catch (error: any) {
      console.error("Error generating goal statement:", error);
      res.status(500).json({ success: false, message: "Failed to generate statement" });
    }
  }

  // ==========================================================================
  // PROGRESS ENTRIES
  // ==========================================================================

  /**
   * GET /api/students/:id/progress-entries
   * Get progress entries for a student
   */
  async getProgressEntries(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;
      const limit = parseInt(req.query.limit as string) || 50;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const entries = await studentProgressService.getProgressHistory(studentId, limit);
      res.json({ success: true, entries });
    } catch (error: any) {
      console.error("Error fetching progress entries:", error);
      res.status(500).json({ success: false, message: "Failed to fetch progress entries" });
    }
  }

  /**
   * POST /api/students/:id/progress-entries
   * Record a new progress entry
   */
  async createProgressEntry(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const validatedData = insertProgressEntrySchema.parse({
        ...req.body,
        studentId,
        recordedBy: currentUser.id,
      });

      const entry = await studentProgressService.recordProgress(validatedData);
      res.json({ success: true, message: "Progress recorded", entry });
    } catch (error: any) {
      console.error("Error creating progress entry:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to record progress" });
    }
  }

  // ==========================================================================
  // COMPLIANCE MANAGEMENT
  // ==========================================================================

  /**
   * GET /api/students/:id/compliance
   * Get compliance items for a student
   */
  async getComplianceItems(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const items = await studentProgressService.getComplianceItems(studentId);
      const percentage = await studentProgressService.calculateCompliancePercentage(studentId);

      res.json({ success: true, items, compliancePercentage: percentage });
    } catch (error: any) {
      console.error("Error fetching compliance items:", error);
      res.status(500).json({ success: false, message: "Failed to fetch compliance items" });
    }
  }

  /**
   * PATCH /api/compliance/:id
   * Update a compliance item
   */
  async updateComplianceItem(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const itemId = req.params.id;
      const { isCompleted } = req.body;

      const item = await studentProgressService.updateComplianceItem(
        itemId, 
        isCompleted, 
        currentUser.id
      );

      if (!item) {
        res.status(404).json({ success: false, message: "Compliance item not found" });
        return;
      }

      res.json({ success: true, item });
    } catch (error: any) {
      console.error("Error updating compliance item:", error);
      res.status(500).json({ success: false, message: "Failed to update compliance item" });
    }
  }

  // ==========================================================================
  // SERVICE RECOMMENDATIONS
  // ==========================================================================

  /**
   * GET /api/students/:id/services
   * Get service recommendations for a student
   */
  async getServiceRecommendations(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const services = await studentProgressService.getServiceRecommendations(studentId);
      res.json({ success: true, services });
    } catch (error: any) {
      console.error("Error fetching service recommendations:", error);
      res.status(500).json({ success: false, message: "Failed to fetch services" });
    }
  }

  /**
   * POST /api/students/:id/services
   * Add a service recommendation
   */
  async createServiceRecommendation(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const validatedData = insertServiceRecommendationSchema.parse({
        ...req.body,
        studentId,
      });

      const service = await studentProgressService.addServiceRecommendation(validatedData);
      res.json({ success: true, message: "Service recommendation added", service });
    } catch (error: any) {
      console.error("Error creating service recommendation:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to add service" });
    }
  }

  async updateServiceRecommendation(req: Request, res: Response): Promise<void> {
    try {
      const serviceId = req.params.id;
      const validatedData = insertServiceRecommendationSchema.parse(req.body);

      const service = await studentProgressService.updateServiceRecommendation(
        serviceId, 
        validatedData
      );
      
      if (!service) {
        res.status(404).json({ success: false, message: "Service recommendation not found" });
        return;
      }

      res.json({ success: true, service });
    } catch (error: any) {
      console.error("Error updating service recommendation:", error);
      if (error.name === "ZodError") {
        res.status(400).json({ success: false, message: "Invalid data", errors: error.errors });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to update service" });
    }
  }

  /**
   * DELETE /api/services/:id
   * Remove a service recommendation
   */
  async deleteServiceRecommendation(req: Request, res: Response): Promise<void> {
    try {
      const serviceId = req.params.id;
      const deleted = await studentProgressService.removeServiceRecommendation(serviceId);
      
      if (!deleted) {
        res.status(404).json({ success: false, message: "Service recommendation not found" });
        return;
      }

      res.json({ success: true, message: "Service recommendation removed" });
    } catch (error: any) {
      console.error("Error deleting service recommendation:", error);
      res.status(500).json({ success: false, message: "Failed to remove service" });
    }
  }

  // ==========================================================================
  // BASELINE METRICS
  // ==========================================================================

  /**
   * GET /api/students/:id/baseline
   * Get baseline metrics for a student
   */
  async getBaselineMetrics(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const metrics = await studentProgressService.getBaselineMetrics(studentId);
      res.json({ success: true, metrics });
    } catch (error: any) {
      console.error("Error fetching baseline metrics:", error);
      res.status(500).json({ success: false, message: "Failed to fetch baseline metrics" });
    }
  }

  /**
   * POST /api/students/:id/baseline
   * Record baseline metrics
   */
  async recordBaselineMetrics(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const studentId = req.params.id;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied" });
        return;
      }

      const { metrics } = req.body;
      if (!metrics || typeof metrics !== 'object') {
        res.status(400).json({ success: false, message: "Metrics object is required" });
        return;
      }

      const entry = await studentProgressService.recordBaselineMetrics(
        studentId, 
        metrics, 
        currentUser.id
      );

      res.json({ success: true, message: "Baseline metrics recorded", entry });
    } catch (error: any) {
      console.error("Error recording baseline metrics:", error);
      res.status(500).json({ success: false, message: "Failed to record baseline metrics" });
    }
  }
}

export const studentProgressController = new StudentProgressController();
