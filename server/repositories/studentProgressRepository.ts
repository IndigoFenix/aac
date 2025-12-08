/**
 * Student Progress Repository
 * server/repositories/studentProgressRepository.ts
 * 
 * Handles all database operations for student progress tracking (IEP/Tala)
 */

import {
  studentPhases,
  studentGoals,
  studentProgressEntries,
  studentComplianceItems,
  studentServiceRecommendations,
  aacUsers,
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
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc, asc, sql, gte, lte, count, isNull, inArray } from "drizzle-orm";

export class StudentProgressRepository {
  // ==========================================================================
  // PHASE OPERATIONS
  // ==========================================================================

  async createPhase(data: InsertStudentPhase): Promise<StudentPhase> {
    const [phase] = await db.insert(studentPhases).values(data).returning();
    return phase;
  }

  async createDefaultPhases(aacUserId: string, systemType: 'tala' | 'us_iep'): Promise<StudentPhase[]> {
    const defaultPhases = systemType === 'tala' 
      ? [
          { phaseId: 'p1', phaseName: 'Initial Assessment', phaseOrder: 1 },
          { phaseId: 'p2', phaseName: 'Goal Development', phaseOrder: 2 },
          { phaseId: 'p3', phaseName: 'Committee Approval', phaseOrder: 3 },
          { phaseId: 'p4', phaseName: 'Implementation & Monitoring', phaseOrder: 4 },
        ]
      : [
          { phaseId: 'eval', phaseName: 'Evaluation', phaseOrder: 1 },
          { phaseId: 'eligibility', phaseName: 'Eligibility Determination', phaseOrder: 2 },
          { phaseId: 'iep_dev', phaseName: 'IEP Development', phaseOrder: 3 },
          { phaseId: 'placement', phaseName: 'Placement Decision', phaseOrder: 4 },
          { phaseId: 'implementation', phaseName: 'Implementation', phaseOrder: 5 },
          { phaseId: 'review', phaseName: 'Annual Review', phaseOrder: 6 },
        ];

    const phases: StudentPhase[] = [];
    for (const p of defaultPhases) {
      const [phase] = await db.insert(studentPhases).values({
        aacUserId,
        phaseId: p.phaseId,
        phaseName: p.phaseName,
        phaseOrder: p.phaseOrder,
        status: p.phaseOrder === 1 ? 'in-progress' : 'pending',
      }).returning();
      phases.push(phase);
    }
    return phases;
  }

  async getPhasesByAacUserId(aacUserId: string): Promise<StudentPhase[]> {
    return await db
      .select()
      .from(studentPhases)
      .where(eq(studentPhases.aacUserId, aacUserId))
      .orderBy(asc(studentPhases.phaseOrder));
  }

  async getPhaseById(id: string): Promise<StudentPhase | undefined> {
    const [phase] = await db
      .select()
      .from(studentPhases)
      .where(eq(studentPhases.id, id));
    return phase;
  }

  async updatePhase(id: string, updates: UpdateStudentPhase): Promise<StudentPhase | undefined> {
    const [updated] = await db
      .update(studentPhases)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(studentPhases.id, id))
      .returning();
    return updated;
  }

  async advancePhase(aacUserId: string, currentPhaseId: string): Promise<StudentPhase | undefined> {
    const phases = await this.getPhasesByAacUserId(aacUserId);
    const currentIndex = phases.findIndex(p => p.id === currentPhaseId);
    
    if (currentIndex === -1 || currentIndex === phases.length - 1) {
      return undefined;
    }

    // Mark current as completed
    await this.updatePhase(currentPhaseId, { 
      status: 'completed', 
      completedAt: new Date() 
    });

    // Mark next as in-progress
    const nextPhase = phases[currentIndex + 1];
    return await this.updatePhase(nextPhase.id, { status: 'in-progress' });
  }

  async deletePhase(id: string): Promise<boolean> {
    const result = await db.delete(studentPhases).where(eq(studentPhases.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // GOAL OPERATIONS
  // ==========================================================================

  async createGoal(data: InsertStudentGoal): Promise<StudentGoal> {
    const [goal] = await db.insert(studentGoals).values(data).returning();
    return goal;
  }

  async getGoalsByAacUserId(aacUserId: string): Promise<StudentGoal[]> {
    return await db
      .select()
      .from(studentGoals)
      .where(eq(studentGoals.aacUserId, aacUserId))
      .orderBy(desc(studentGoals.createdAt));
  }

  async getGoalsByPhaseId(phaseId: string): Promise<StudentGoal[]> {
    return await db
      .select()
      .from(studentGoals)
      .where(eq(studentGoals.phaseId, phaseId))
      .orderBy(desc(studentGoals.createdAt));
  }

  async getGoalById(id: string): Promise<StudentGoal | undefined> {
    const [goal] = await db
      .select()
      .from(studentGoals)
      .where(eq(studentGoals.id, id));
    return goal;
  }

  async updateGoal(id: string, updates: UpdateStudentGoal): Promise<StudentGoal | undefined> {
    const [updated] = await db
      .update(studentGoals)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(studentGoals.id, id))
      .returning();
    return updated;
  }

  async deleteGoal(id: string): Promise<boolean> {
    const result = await db.delete(studentGoals).where(eq(studentGoals.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // PROGRESS ENTRY OPERATIONS
  // ==========================================================================

  async createProgressEntry(data: InsertProgressEntry): Promise<StudentProgressEntry> {
    const [entry] = await db.insert(studentProgressEntries).values(data).returning();
    return entry;
  }

  async getProgressEntriesByAacUserId(aacUserId: string, limit = 50): Promise<StudentProgressEntry[]> {
    return await db
      .select()
      .from(studentProgressEntries)
      .where(eq(studentProgressEntries.aacUserId, aacUserId))
      .orderBy(desc(studentProgressEntries.recordedAt))
      .limit(limit);
  }

  async getProgressEntriesByGoalId(goalId: string): Promise<StudentProgressEntry[]> {
    return await db
      .select()
      .from(studentProgressEntries)
      .where(eq(studentProgressEntries.goalId, goalId))
      .orderBy(desc(studentProgressEntries.recordedAt));
  }

  // ==========================================================================
  // COMPLIANCE OPERATIONS
  // ==========================================================================

  async createComplianceItem(data: InsertComplianceItem): Promise<StudentComplianceItem> {
    const [item] = await db.insert(studentComplianceItems).values(data).returning();
    return item;
  }

  async createDefaultComplianceItems(aacUserId: string, phaseId?: string): Promise<StudentComplianceItem[]> {
    const defaultItems = [
      { itemKey: 'baseline_data', itemLabel: 'Baseline data collected' },
      { itemKey: 'parent_input', itemLabel: 'Parent input considered' },
      { itemKey: 'gen_ed_consulted', itemLabel: 'Gen. Ed. teacher consulted' },
      { itemKey: 'lre_explanation', itemLabel: 'LRE Explanation draft' },
    ];

    const items: StudentComplianceItem[] = [];
    for (const item of defaultItems) {
      const [created] = await db.insert(studentComplianceItems).values({
        aacUserId,
        phaseId,
        itemKey: item.itemKey,
        itemLabel: item.itemLabel,
      }).returning();
      items.push(created);
    }
    return items;
  }

  async getComplianceItemsByAacUserId(aacUserId: string): Promise<StudentComplianceItem[]> {
    return await db
      .select()
      .from(studentComplianceItems)
      .where(eq(studentComplianceItems.aacUserId, aacUserId));
  }

  async updateComplianceItem(
    id: string, 
    isCompleted: boolean, 
    completedBy?: string
  ): Promise<StudentComplianceItem | undefined> {
    const [updated] = await db
      .update(studentComplianceItems)
      .set({ 
        isCompleted, 
        completedAt: isCompleted ? new Date() : null,
        completedBy: isCompleted ? completedBy : null,
        updatedAt: new Date() 
      })
      .where(eq(studentComplianceItems.id, id))
      .returning();
    return updated;
  }

  // ==========================================================================
  // SERVICE RECOMMENDATION OPERATIONS
  // ==========================================================================

  async createServiceRecommendation(data: InsertServiceRecommendation): Promise<StudentServiceRecommendation> {
    const [rec] = await db.insert(studentServiceRecommendations).values(data).returning();
    return rec;
  }

  async getServiceRecommendationsByAacUserId(aacUserId: string): Promise<StudentServiceRecommendation[]> {
    return await db
      .select()
      .from(studentServiceRecommendations)
      .where(
        and(
          eq(studentServiceRecommendations.aacUserId, aacUserId),
          eq(studentServiceRecommendations.isActive, true)
        )
      );
  }

  async updateServiceRecommendation(
    id: string, 
    updates: Partial<InsertServiceRecommendation>
  ): Promise<StudentServiceRecommendation | undefined> {
    const [updated] = await db
      .update(studentServiceRecommendations)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(studentServiceRecommendations.id, id))
      .returning();
    return updated;
  }

  async deleteServiceRecommendation(id: string): Promise<boolean> {
    const [updated] = await db
      .update(studentServiceRecommendations)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(studentServiceRecommendations.id, id))
      .returning();
    return !!updated;
  }

  // ==========================================================================
  // OVERVIEW & STATISTICS
  // ==========================================================================

  async getOverviewStats(userId: string): Promise<{
    totalStudents: number;
    activeCases: number;
    completedCases: number;
    pendingReview: number;
    upcomingDeadlines: number;
  }> {
    // This will need to be adjusted based on your actual schema
    // For now, using placeholder logic
    const [stats] = await db
      .select({
        total: count(),
      })
      .from(aacUsers)
      .where(eq(aacUsers.isActive, true));

    // Get active (in-progress) phases count
    const [activeStats] = await db
      .select({
        count: count(),
      })
      .from(studentPhases)
      .where(eq(studentPhases.status, 'in-progress'));

    // Get completed phases count
    const [completedStats] = await db
      .select({
        count: count(),
      })
      .from(studentPhases)
      .where(eq(studentPhases.status, 'completed'));

    // Get upcoming deadlines (next 7 days)
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
    
    const [upcomingStats] = await db
      .select({
        count: count(),
      })
      .from(studentPhases)
      .where(
        and(
          eq(studentPhases.status, 'in-progress'),
          lte(studentPhases.dueDate, sevenDaysFromNow.toISOString().split('T')[0])
        )
      );

    return {
      totalStudents: stats?.total || 0,
      activeCases: activeStats?.count || 0,
      completedCases: completedStats?.count || 0,
      pendingReview: 3, // Placeholder
      upcomingDeadlines: upcomingStats?.count || 0,
    };
  }

  async getPhaseDistribution(): Promise<Array<{ phaseName: string; count: number }>> {
    const results = await db
      .select({
        phaseName: studentPhases.phaseName,
        count: count(),
      })
      .from(studentPhases)
      .where(eq(studentPhases.status, 'in-progress'))
      .groupBy(studentPhases.phaseName);

    return results;
  }

  async getStudentsWithUpcomingDeadlines(
    userId: string, 
    daysAhead = 7
  ): Promise<Array<{ aacUserId: string; dueDate: string; phaseName: string }>> {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + daysAhead);

    const results = await db
      .select({
        aacUserId: studentPhases.aacUserId,
        dueDate: studentPhases.dueDate,
        phaseName: studentPhases.phaseName,
      })
      .from(studentPhases)
      .where(
        and(
          eq(studentPhases.status, 'in-progress'),
          lte(studentPhases.dueDate, futureDate.toISOString().split('T')[0])
        )
      )
      .orderBy(asc(studentPhases.dueDate));

    return results.map(r => ({
      aacUserId: r.aacUserId,
      dueDate: r.dueDate || '',
      phaseName: r.phaseName,
    }));
  }

  // ==========================================================================
  // FULL STUDENT PROGRESS DATA
  // ==========================================================================

  async getFullStudentProgress(aacUserId: string): Promise<{
    phases: StudentPhase[];
    goals: StudentGoal[];
    complianceItems: StudentComplianceItem[];
    serviceRecommendations: StudentServiceRecommendation[];
    recentProgress: StudentProgressEntry[];
  }> {
    const [phases, goals, complianceItems, serviceRecommendations, recentProgress] = await Promise.all([
      this.getPhasesByAacUserId(aacUserId),
      this.getGoalsByAacUserId(aacUserId),
      this.getComplianceItemsByAacUserId(aacUserId),
      this.getServiceRecommendationsByAacUserId(aacUserId),
      this.getProgressEntriesByAacUserId(aacUserId, 10),
    ]);

    return {
      phases,
      goals,
      complianceItems,
      serviceRecommendations,
      recentProgress,
    };
  }
}

export const studentProgressRepository = new StudentProgressRepository();
