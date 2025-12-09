/**
 * Student Progress Service
 * server/services/studentProgressService.ts
 * 
 * Business logic for student progress tracking (IEP/Tala)
 */

import { studentProgressRepository } from "../repositories/studentProgressRepository";
import { studentService } from "./studentService";
import {
  type StudentPhase,
  type InsertStudentPhase,
  type UpdateStudentPhase,
  type StudentGoal,
  type InsertStudentGoal,
  type UpdateStudentGoal,
  type StudentProgressEntry,
  type InsertProgressEntry,
  type StudentComplianceItem,
  type InsertComplianceItem,
  type StudentServiceRecommendation,
  type InsertServiceRecommendation,
  type SystemType,
  type StudentWithProgress,
  type OverviewStats,
} from "@shared/schema";

export class StudentProgressService {
  // ==========================================================================
  // PHASE MANAGEMENT
  // ==========================================================================

  /**
   * Initialize phases for a new student based on their system type
   */
  async initializeStudentPhases(
    studentId: string, 
    systemType: SystemType
  ): Promise<StudentPhase[]> {
    // Check if phases already exist
    const existingPhases = await studentProgressRepository.getPhasesByStudentId(studentId);
    if (existingPhases.length > 0) {
      return existingPhases;
    }

    return await studentProgressRepository.createDefaultPhases(studentId, systemType);
  }

  /**
   * Get all phases for a student
   */
  async getPhases(studentId: string): Promise<StudentPhase[]> {
    return await studentProgressRepository.getPhasesByStudentId(studentId);
  }

  /**
   * Get current active phase for a student
   */
  async getCurrentPhase(studentId: string): Promise<StudentPhase | undefined> {
    const phases = await this.getPhases(studentId);
    return phases.find(p => p.status === 'in-progress');
  }

  /**
   * Update a phase
   */
  async updatePhase(
    phaseId: string, 
    updates: UpdateStudentPhase
  ): Promise<StudentPhase | undefined> {
    return await studentProgressRepository.updatePhase(phaseId, updates);
  }

  /**
   * Advance to the next phase
   */
  async advanceToNextPhase(studentId: string): Promise<StudentPhase | undefined> {
    const currentPhase = await this.getCurrentPhase(studentId);
    if (!currentPhase) {
      return undefined;
    }
    return await studentProgressRepository.advancePhase(studentId, currentPhase.id);
  }

  /**
   * Calculate overall progress for a student based on phase completion
   */
  async calculateOverallProgress(studentId: string): Promise<number> {
    const phases = await this.getPhases(studentId);
    if (phases.length === 0) return 0;

    const completedCount = phases.filter(p => p.status === 'completed').length;
    const inProgressBonus = phases.some(p => p.status === 'in-progress') ? 0.5 : 0;
    
    return Math.round(((completedCount + inProgressBonus) / phases.length) * 100);
  }

  // ==========================================================================
  // GOAL MANAGEMENT
  // ==========================================================================

  /**
   * Create a new goal for a student
   */
  async createGoal(data: InsertStudentGoal): Promise<StudentGoal> {
    return await studentProgressRepository.createGoal(data);
  }

  /**
   * Get all goals for a student
   */
  async getGoals(studentId: string): Promise<StudentGoal[]> {
    return await studentProgressRepository.getGoalsByStudentId(studentId);
  }

  /**
   * Get goals for a specific phase
   */
  async getGoalsByPhase(phaseId: string): Promise<StudentGoal[]> {
    return await studentProgressRepository.getGoalsByPhaseId(phaseId);
  }

  /**
   * Update a goal
   */
  async updateGoal(
    goalId: string, 
    updates: UpdateStudentGoal
  ): Promise<StudentGoal | undefined> {
    return await studentProgressRepository.updateGoal(goalId, updates);
  }

  /**
   * Delete a goal
   */
  async deleteGoal(goalId: string): Promise<boolean> {
    return await studentProgressRepository.deleteGoal(goalId);
  }

  /**
   * Generate a SMART goal statement from goal data
   */
  generateSmartGoalStatement(
    studentName: string,
    goal: StudentGoal
  ): string {
    const targetDate = goal.targetDate 
      ? new Date(goal.targetDate).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : 'the end of the year';
    
    const conditions = goal.conditions || 'in a structured setting';
    const targetBehavior = goal.targetBehavior || goal.title;
    const criteria = goal.criteriaPercentage 
      ? `${goal.criteriaPercentage}% accuracy`
      : 'mastery criteria';
    const measurementMethod = goal.measurementMethod || 'data collection';

    return `By ${targetDate}, given ${conditions}, ${studentName} will ${targetBehavior} with ${criteria} as measured by ${measurementMethod}.`;
  }

  // ==========================================================================
  // PROGRESS TRACKING
  // ==========================================================================

  /**
   * Record a progress entry
   */
  async recordProgress(data: InsertProgressEntry): Promise<StudentProgressEntry> {
    return await studentProgressRepository.createProgressEntry(data);
  }

  /**
   * Get progress history for a student
   */
  async getProgressHistory(
    studentId: string, 
    limit = 50
  ): Promise<StudentProgressEntry[]> {
    return await studentProgressRepository.getProgressEntriesByStudentId(studentId, limit);
  }

  /**
   * Get progress entries for a specific goal
   */
  async getGoalProgress(goalId: string): Promise<StudentProgressEntry[]> {
    return await studentProgressRepository.getProgressEntriesByGoalId(goalId);
  }

  // ==========================================================================
  // COMPLIANCE MANAGEMENT
  // ==========================================================================

  /**
   * Initialize compliance checklist for a student
   */
  async initializeComplianceChecklist(
    studentId: string, 
    phaseId?: string
  ): Promise<StudentComplianceItem[]> {
    const existing = await studentProgressRepository.getComplianceItemsByStudentId(studentId);
    if (existing.length > 0) {
      return existing;
    }
    return await studentProgressRepository.createDefaultComplianceItems(studentId, phaseId);
  }

  /**
   * Get compliance items for a student
   */
  async getComplianceItems(studentId: string): Promise<StudentComplianceItem[]> {
    return await studentProgressRepository.getComplianceItemsByStudentId(studentId);
  }

  /**
   * Update a compliance item
   */
  async updateComplianceItem(
    itemId: string, 
    isCompleted: boolean,
    userId?: string
  ): Promise<StudentComplianceItem | undefined> {
    return await studentProgressRepository.updateComplianceItem(itemId, isCompleted, userId);
  }

  /**
   * Calculate compliance percentage
   */
  async calculateCompliancePercentage(studentId: string): Promise<number> {
    const items = await this.getComplianceItems(studentId);
    if (items.length === 0) return 100;
    
    const completed = items.filter(i => i.isCompleted).length;
    return Math.round((completed / items.length) * 100);
  }

  // ==========================================================================
  // SERVICE RECOMMENDATIONS
  // ==========================================================================

  /**
   * Add a service recommendation
   */
  async addServiceRecommendation(
    data: InsertServiceRecommendation
  ): Promise<StudentServiceRecommendation> {
    return await studentProgressRepository.createServiceRecommendation(data);
  }

  /**
   * Get service recommendations for a student
   */
  async getServiceRecommendations(
    studentId: string
  ): Promise<StudentServiceRecommendation[]> {
    return await studentProgressRepository.getServiceRecommendationsByStudentId(studentId);
  }

  /**
   * Update a service recommendation
   */
  async updateServiceRecommendation(
    id: string, 
    updates: Partial<InsertServiceRecommendation>
  ): Promise<StudentServiceRecommendation | undefined> {
    return await studentProgressRepository.updateServiceRecommendation(id, updates);
  }

  /**
   * Remove a service recommendation
   */
  async removeServiceRecommendation(id: string): Promise<boolean> {
    return await studentProgressRepository.deleteServiceRecommendation(id);
  }

  /**
   * Format service recommendation for display
   */
  formatServiceRecommendation(rec: StudentServiceRecommendation): string {
    const frequencyText = rec.frequencyCount > 1 
      ? `${rec.frequencyCount}x ${rec.frequency}`
      : rec.frequency;
    return `${rec.serviceName} (${rec.serviceType}): ${rec.durationMinutes} min / ${frequencyText}`;
  }

  // ==========================================================================
  // OVERVIEW & DASHBOARD
  // ==========================================================================

  /**
   * Get overview statistics
   */
  async getOverviewStats(userId: string): Promise<OverviewStats> {
    return await studentProgressRepository.getOverviewStats(userId);
  }

  /**
   * Get phase distribution for charts
   */
  async getPhaseDistribution(): Promise<Array<{ phaseName: string; count: number; color: string }>> {
    const distribution = await studentProgressRepository.getPhaseDistribution();
    
    const colors = [
      'hsl(var(--chart-1))',
      'hsl(var(--chart-2))',
      'hsl(var(--chart-3))',
      'hsl(var(--chart-4))',
      'hsl(var(--chart-5))',
    ];

    return distribution.map((item, index) => ({
      ...item,
      color: colors[index % colors.length],
    }));
  }

  /**
   * Get students with upcoming deadlines
   */
  async getStudentsWithUpcomingDeadlines(
    userId: string, 
    daysAhead = 7
  ): Promise<Array<{ studentId: string; dueDate: string; phaseName: string }>> {
    return await studentProgressRepository.getStudentsWithUpcomingDeadlines(userId, daysAhead);
  }

  // ==========================================================================
  // FULL STUDENT DATA
  // ==========================================================================

  /**
   * Get complete student progress data
   */
  async getFullStudentProgress(studentId: string): Promise<{
    phases: StudentPhase[];
    goals: StudentGoal[];
    complianceItems: StudentComplianceItem[];
    serviceRecommendations: StudentServiceRecommendation[];
    recentProgress: StudentProgressEntry[];
    overallProgress: number;
    compliancePercentage: number;
  }> {
    const data = await studentProgressRepository.getFullStudentProgress(studentId);
    const overallProgress = await this.calculateOverallProgress(studentId);
    const compliancePercentage = await this.calculateCompliancePercentage(studentId);

    return {
      ...data,
      overallProgress,
      compliancePercentage,
    };
  }

  /**
   * Get student with progress summary for list view
   */
  async getStudentWithProgressSummary(studentId: string): Promise<StudentWithProgress | null> {
    const student = await studentService.getStudentById(studentId);
    if (!student) return null;

    const phases = await this.getPhases(studentId);
    const goals = await this.getGoals(studentId);
    const overallProgress = await this.calculateOverallProgress(studentId);
    const currentPhase = phases.find(p => p.status === 'in-progress');

    return {
      id: student.id,
      name: student.name,
      idNumber: (student as any).idNumber,
      school: (student as any).school,
      grade: (student as any).grade,
      diagnosis: (student as any).diagnosis,
      systemType: ((student as any).systemType || 'tala') as SystemType,
      country: (student as any).country,
      overallProgress,
      nextDeadline: currentPhase?.dueDate || undefined,
      currentPhase: currentPhase?.phaseId,
      phases,
      goals,
    };
  }

  // ==========================================================================
  // BASELINE DATA (for IEP)
  // ==========================================================================

  /**
   * Get baseline metrics for a student
   */
  async getBaselineMetrics(studentId: string): Promise<{
    mlu: number | null;
    communicationRate: number | null;
    intelligibility: number | null;
    additionalMetrics: Record<string, any>;
  }> {
    // Get the most recent progress entry with metrics
    const entries = await this.getProgressHistory(studentId, 10);
    const entryWithMetrics = entries.find(e => e.metrics && Object.keys(e.metrics as object).length > 0);

    if (!entryWithMetrics || !entryWithMetrics.metrics) {
      return {
        mlu: null,
        communicationRate: null,
        intelligibility: null,
        additionalMetrics: {},
      };
    }

    const metrics = entryWithMetrics.metrics as Record<string, any>;
    
    return {
      mlu: metrics.mlu || null,
      communicationRate: metrics.communicationRate || null,
      intelligibility: metrics.intelligibility || null,
      additionalMetrics: metrics,
    };
  }

  /**
   * Record baseline metrics
   */
  async recordBaselineMetrics(
    studentId: string,
    metrics: {
      mlu?: number;
      communicationRate?: number;
      intelligibility?: number;
      [key: string]: any;
    },
    recordedBy: string
  ): Promise<StudentProgressEntry> {
    return await this.recordProgress({
      studentId,
      entryType: 'assessment',
      title: 'Baseline Assessment',
      content: 'Initial baseline metrics recorded',
      metrics,
      recordedBy,
    });
  }
}

export const studentProgressService = new StudentProgressService();
