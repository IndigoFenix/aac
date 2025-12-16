import {
  programs,
  profileDomains,
  baselineMeasurements,
  assessmentSources,
  goals,
  objectives,
  services,
  serviceGoals,
  accommodations,
  progressReports,
  goalProgressEntries,
  dataPoints,
  transitionPlans,
  transitionGoals,
  teamMembers,
  meetings,
  consentForms,
  students,
  type Program,
  type InsertProgram,
  type UpdateProgram,
  type ProfileDomain,
  type InsertProfileDomain,
  type UpdateProfileDomain,
  type BaselineMeasurement,
  type InsertBaselineMeasurement,
  type AssessmentSource,
  type InsertAssessmentSource,
  type Goal,
  type InsertGoal,
  type UpdateGoal,
  type Objective,
  type InsertObjective,
  type UpdateObjective,
  type Service,
  type InsertService,
  type UpdateService,
  type Accommodation,
  type InsertAccommodation,
  type UpdateAccommodation,
  type ProgressReport,
  type InsertProgressReport,
  type UpdateProgressReport,
  type GoalProgressEntry,
  type InsertGoalProgressEntry,
  type DataPoint,
  type InsertDataPoint,
  type TransitionPlan,
  type InsertTransitionPlan,
  type UpdateTransitionPlan,
  type TransitionGoal,
  type InsertTransitionGoal,
  type UpdateTransitionGoal,
  type TeamMember,
  type InsertTeamMember,
  type UpdateTeamMember,
  type Meeting,
  type InsertMeeting,
  type UpdateMeeting,
  type ConsentForm,
  type InsertConsentForm,
  type UpdateConsentForm,
  type ProgramWithDetails,
  type StudentWithProgramSummary,
  type GoalWithContext,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc, asc, sql, inArray, isNull, count } from "drizzle-orm";

export class ProgramRepository {
  // ==========================================================================
  // PROGRAM OPERATIONS
  // ==========================================================================

  /**
   * Create a new program
   */
  async createProgram(insert: InsertProgram): Promise<Program> {
    const [program] = await db
      .insert(programs)
      .values(insert)
      .returning();
    return program;
  }

  /**
   * Get a program by ID
   */
  async getProgramById(id: string): Promise<Program | undefined> {
    const [program] = await db
      .select()
      .from(programs)
      .where(eq(programs.id, id));
    return program || undefined;
  }

  /**
   * Get all programs for a student
   */
  async getProgramsByStudentId(studentId: string): Promise<Program[]> {
    return await db
      .select()
      .from(programs)
      .where(eq(programs.studentId, studentId))
      .orderBy(desc(programs.createdAt));
  }

  /**
   * Get the current/working program for a student.
   * Returns active programs first, then drafts. Excludes archived programs.
   * This allows users to work with draft programs before activation.
   */
  async getCurrentProgram(studentId: string): Promise<Program | undefined> {
    // First try to get an active program
    const [activeProgram] = await db
      .select()
      .from(programs)
      .where(
        and(
          eq(programs.studentId, studentId),
          eq(programs.status, "active")
        )
      )
      .orderBy(desc(programs.createdAt))
      .limit(1);
    
    if (activeProgram) {
      return activeProgram;
    }

    // If no active program, get the most recent draft
    const [draftProgram] = await db
      .select()
      .from(programs)
      .where(
        and(
          eq(programs.studentId, studentId),
          eq(programs.status, "draft")
        )
      )
      .orderBy(desc(programs.createdAt))
      .limit(1);
    
    return draftProgram || undefined;
  }

  /**
   * Update a program
   */
  async updateProgram(id: string, updates: UpdateProgram): Promise<Program | undefined> {
    const [updated] = await db
      .update(programs)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(programs.id, id))
      .returning();
    return updated || undefined;
  }

  /**
   * Delete a program and all related data
   */
  async deleteProgram(id: string): Promise<boolean> {
    // This would cascade delete related entities in a real implementation
    // For now, just delete the program itself
    const result = await db
      .delete(programs)
      .where(eq(programs.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get full program with all related details
   */
  async getProgramWithDetails(programId: string): Promise<ProgramWithDetails | undefined> {
    const program = await this.getProgramById(programId);
    if (!program) return undefined;

    const [student] = await db
      .select()
      .from(students)
      .where(eq(students.id, program.studentId));
    
    if (!student) return undefined;

    // Fetch all related data
    const domains = await this.getProfileDomainsByProgramId(programId);
    const domainsWithData = await Promise.all(
      domains.map(async (domain) => ({
        ...domain,
        baselineMeasurements: await this.getBaselineMeasurementsByDomainId(domain.id),
        assessmentSources: await this.getAssessmentSourcesByDomainId(domain.id),
      }))
    );

    const programGoals = await this.getGoalsByProgramId(programId);
    const goalsWithData = await Promise.all(
      programGoals.map(async (goal) => ({
        ...goal,
        objectives: await this.getObjectivesByGoalId(goal.id),
        dataPoints: await this.getDataPointsByGoalId(goal.id),
      }))
    );

    const programServices = await this.getServicesByProgramId(programId);
    const servicesWithData = await Promise.all(
      programServices.map(async (service) => {
        const serviceGoalLinks = await db
          .select()
          .from(serviceGoals)
          .where(eq(serviceGoals.serviceId, service.id));
        return {
          ...service,
          accommodations: await this.getAccommodationsByServiceId(service.id),
          linkedGoalIds: serviceGoalLinks.map(sg => sg.goalId),
        };
      })
    );

    const reports = await this.getProgressReportsByProgramId(programId);
    const reportsWithEntries = await Promise.all(
      reports.map(async (report) => ({
        ...report,
        entries: await this.getGoalProgressEntriesByReportId(report.id),
      }))
    );

    const transition = await this.getTransitionPlanByProgramId(programId);
    const transitionWithGoals = transition
      ? {
          ...transition,
          goals: await this.getTransitionGoalsByPlanId(transition.id),
        }
      : undefined;

    return {
      program,
      student,
      profileDomains: domainsWithData,
      goals: goalsWithData,
      services: servicesWithData,
      progressReports: reportsWithEntries,
      transitionPlan: transitionWithGoals,
      teamMembers: await this.getTeamMembersByProgramId(programId),
      meetings: await this.getMeetingsByProgramId(programId),
      consentForms: await this.getConsentFormsByProgramId(programId),
    };
  }

  // ==========================================================================
  // PROFILE DOMAIN OPERATIONS
  // ==========================================================================

  async createProfileDomain(insert: InsertProfileDomain): Promise<ProfileDomain> {
    const [domain] = await db
      .insert(profileDomains)
      .values(insert)
      .returning();
    return domain;
  }

  async getProfileDomainById(id: string): Promise<ProfileDomain | undefined> {
    const [domain] = await db
      .select()
      .from(profileDomains)
      .where(eq(profileDomains.id, id));
    return domain || undefined;
  }

  async getProfileDomainsByProgramId(programId: string): Promise<ProfileDomain[]> {
    return await db
      .select()
      .from(profileDomains)
      .where(eq(profileDomains.programId, programId))
      .orderBy(asc(profileDomains.sortOrder));
  }

  async updateProfileDomain(id: string, updates: UpdateProfileDomain): Promise<ProfileDomain | undefined> {
    const [updated] = await db
      .update(profileDomains)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(profileDomains.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteProfileDomain(id: string): Promise<boolean> {
    const result = await db
      .delete(profileDomains)
      .where(eq(profileDomains.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // BASELINE MEASUREMENT OPERATIONS
  // ==========================================================================

  async createBaselineMeasurement(insert: InsertBaselineMeasurement): Promise<BaselineMeasurement> {
    const [measurement] = await db
      .insert(baselineMeasurements)
      .values(insert)
      .returning();
    return measurement;
  }

  async getBaselineMeasurementsByDomainId(domainId: string): Promise<BaselineMeasurement[]> {
    return await db
      .select()
      .from(baselineMeasurements)
      .where(eq(baselineMeasurements.profileDomainId, domainId));
  }

  async deleteBaselineMeasurement(id: string): Promise<boolean> {
    const result = await db
      .delete(baselineMeasurements)
      .where(eq(baselineMeasurements.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // ASSESSMENT SOURCE OPERATIONS
  // ==========================================================================

  async createAssessmentSource(insert: InsertAssessmentSource): Promise<AssessmentSource> {
    const [source] = await db
      .insert(assessmentSources)
      .values(insert)
      .returning();
    return source;
  }

  async getAssessmentSourcesByDomainId(domainId: string): Promise<AssessmentSource[]> {
    return await db
      .select()
      .from(assessmentSources)
      .where(eq(assessmentSources.profileDomainId, domainId));
  }

  async deleteAssessmentSource(id: string): Promise<boolean> {
    const result = await db
      .delete(assessmentSources)
      .where(eq(assessmentSources.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // GOAL OPERATIONS
  // ==========================================================================

  async createGoal(insert: InsertGoal): Promise<Goal> {
    const [goal] = await db
      .insert(goals)
      .values(insert)
      .returning();
    return goal;
  }

  async getGoalById(id: string): Promise<Goal | undefined> {
    const [goal] = await db
      .select()
      .from(goals)
      .where(eq(goals.id, id));
    return goal || undefined;
  }

  async getGoalsByProgramId(programId: string): Promise<Goal[]> {
    return await db
      .select()
      .from(goals)
      .where(eq(goals.programId, programId))
      .orderBy(asc(goals.sortOrder));
  }

  async getGoalsByDomainId(domainId: string): Promise<Goal[]> {
    return await db
      .select()
      .from(goals)
      .where(eq(goals.profileDomainId, domainId))
      .orderBy(asc(goals.sortOrder));
  }

  async getGoalWithContext(goalId: string): Promise<GoalWithContext | undefined> {
    const goal = await this.getGoalById(goalId);
    if (!goal) return undefined;

    const goalObjectives = await this.getObjectivesByGoalId(goalId);
    const goalDataPoints = await this.getDataPointsByGoalId(goalId);
    const latestProgress = await this.getLatestGoalProgressEntryByGoalId(goalId);

    return {
      goal,
      domainName: "", // Placeholder - would require join with profileDomains
      latestProgress,
      objectives: goalObjectives,
      dataPoints: goalDataPoints,
    };
  }

  async updateGoal(id: string, updates: UpdateGoal): Promise<Goal | undefined> {
    const [updated] = await db
      .update(goals)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(goals.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteGoal(id: string): Promise<boolean> {
    const result = await db
      .delete(goals)
      .where(eq(goals.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // OBJECTIVE OPERATIONS
  // ==========================================================================

  async createObjective(insert: InsertObjective): Promise<Objective> {
    const [objective] = await db
      .insert(objectives)
      .values(insert)
      .returning();
    return objective;
  }

  async getObjectiveById(id: string): Promise<Objective | undefined> {
    const [objective] = await db
      .select()
      .from(objectives)
      .where(eq(objectives.id, id));
    return objective || undefined;
  }

  async getObjectivesByGoalId(goalId: string): Promise<Objective[]> {
    return await db
      .select()
      .from(objectives)
      .where(eq(objectives.goalId, goalId))
      .orderBy(asc(objectives.sequenceOrder));
  }

  async updateObjective(id: string, updates: UpdateObjective): Promise<Objective | undefined> {
    const [updated] = await db
      .update(objectives)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(objectives.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteObjective(id: string): Promise<boolean> {
    const result = await db
      .delete(objectives)
      .where(eq(objectives.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // SERVICE OPERATIONS
  // ==========================================================================

  async createService(insert: InsertService): Promise<Service> {
    const [service] = await db
      .insert(services)
      .values(insert)
      .returning();
    return service;
  }

  async getServiceById(id: string): Promise<Service | undefined> {
    const [service] = await db
      .select()
      .from(services)
      .where(eq(services.id, id));
    return service || undefined;
  }

  async getServicesByProgramId(programId: string): Promise<Service[]> {
    return await db
      .select()
      .from(services)
      .where(eq(services.programId, programId));
  }

  async updateService(id: string, updates: UpdateService): Promise<Service | undefined> {
    const [updated] = await db
      .update(services)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(services.id, id))
      .returning();
    return updated || undefined;
  }

  async linkServiceToGoal(serviceId: string, goalId: string): Promise<void> {
    await db
      .insert(serviceGoals)
      .values({ serviceId, goalId });
  }

  async unlinkServiceFromGoal(serviceId: string, goalId: string): Promise<void> {
    await db
      .delete(serviceGoals)
      .where(
        and(
          eq(serviceGoals.serviceId, serviceId),
          eq(serviceGoals.goalId, goalId)
        )
      );
  }

  async deleteService(id: string): Promise<boolean> {
    const result = await db
      .delete(services)
      .where(eq(services.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // ACCOMMODATION OPERATIONS
  // ==========================================================================

  async createAccommodation(insert: InsertAccommodation): Promise<Accommodation> {
    const [accommodation] = await db
      .insert(accommodations)
      .values(insert)
      .returning();
    return accommodation;
  }

  async getAccommodationById(id: string): Promise<Accommodation | undefined> {
    const [accommodation] = await db
      .select()
      .from(accommodations)
      .where(eq(accommodations.id, id));
    return accommodation || undefined;
  }

  async getAccommodationsByServiceId(serviceId: string): Promise<Accommodation[]> {
    return await db
      .select()
      .from(accommodations)
      .where(eq(accommodations.serviceId, serviceId));
  }

  async getAccommodationsByProgramId(programId: string): Promise<Accommodation[]> {
    return await db
      .select()
      .from(accommodations)
      .where(eq(accommodations.programId, programId));
  }

  async updateAccommodation(id: string, updates: UpdateAccommodation): Promise<Accommodation | undefined> {
    const [updated] = await db
      .update(accommodations)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(accommodations.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteAccommodation(id: string): Promise<boolean> {
    const result = await db
      .delete(accommodations)
      .where(eq(accommodations.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // DATA POINT OPERATIONS
  // ==========================================================================

  async createDataPoint(insert: InsertDataPoint): Promise<DataPoint> {
    const [dataPoint] = await db
      .insert(dataPoints)
      .values(insert)
      .returning();
    return dataPoint;
  }

  async getDataPointById(id: string): Promise<DataPoint | undefined> {
    const [dataPoint] = await db
      .select()
      .from(dataPoints)
      .where(eq(dataPoints.id, id));
    return dataPoint || undefined;
  }

  async getDataPointsByGoalId(goalId: string): Promise<DataPoint[]> {
    return await db
      .select()
      .from(dataPoints)
      .where(eq(dataPoints.goalId, goalId))
      .orderBy(desc(dataPoints.recordedAt));
  }

  async getDataPointsByObjectiveId(objectiveId: string): Promise<DataPoint[]> {
    return await db
      .select()
      .from(dataPoints)
      .where(eq(dataPoints.objectiveId, objectiveId))
      .orderBy(desc(dataPoints.recordedAt));
  }

  async deleteDataPoint(id: string): Promise<boolean> {
    const result = await db
      .delete(dataPoints)
      .where(eq(dataPoints.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // PROGRESS REPORT OPERATIONS
  // ==========================================================================

  async createProgressReport(insert: InsertProgressReport): Promise<ProgressReport> {
    const [report] = await db
      .insert(progressReports)
      .values(insert)
      .returning();
    return report;
  }

  async getProgressReportById(id: string): Promise<ProgressReport | undefined> {
    const [report] = await db
      .select()
      .from(progressReports)
      .where(eq(progressReports.id, id));
    return report || undefined;
  }

  async getProgressReportsByProgramId(programId: string): Promise<ProgressReport[]> {
    return await db
      .select()
      .from(progressReports)
      .where(eq(progressReports.programId, programId))
      .orderBy(desc(progressReports.reportDate));
  }

  async updateProgressReport(id: string, updates: UpdateProgressReport): Promise<ProgressReport | undefined> {
    const [updated] = await db
      .update(progressReports)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(progressReports.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteProgressReport(id: string): Promise<boolean> {
    const result = await db
      .delete(progressReports)
      .where(eq(progressReports.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // GOAL PROGRESS ENTRY OPERATIONS
  // ==========================================================================

  async createGoalProgressEntry(insert: InsertGoalProgressEntry): Promise<GoalProgressEntry> {
    const [entry] = await db
      .insert(goalProgressEntries)
      .values(insert)
      .returning();
    return entry;
  }

  async getGoalProgressEntriesByReportId(reportId: string): Promise<GoalProgressEntry[]> {
    return await db
      .select()
      .from(goalProgressEntries)
      .where(eq(goalProgressEntries.progressReportId, reportId));
  }

  async getGoalProgressEntriesByGoalId(goalId: string): Promise<GoalProgressEntry[]> {
    return await db
      .select()
      .from(goalProgressEntries)
      .where(eq(goalProgressEntries.goalId, goalId));
  }

  async getLatestGoalProgressEntryByGoalId(goalId: string): Promise<GoalProgressEntry | undefined> {
    const [entry] = await db
      .select()
      .from(goalProgressEntries)
      .where(eq(goalProgressEntries.goalId, goalId))
      .orderBy(desc(goalProgressEntries.createdAt))
      .limit(1);
    return entry || undefined;
  }

  // ==========================================================================
  // TRANSITION PLAN OPERATIONS
  // ==========================================================================

  async createTransitionPlan(insert: InsertTransitionPlan): Promise<TransitionPlan> {
    const [plan] = await db
      .insert(transitionPlans)
      .values(insert)
      .returning();
    return plan;
  }

  async getTransitionPlanById(id: string): Promise<TransitionPlan | undefined> {
    const [plan] = await db
      .select()
      .from(transitionPlans)
      .where(eq(transitionPlans.id, id));
    return plan || undefined;
  }

  async getTransitionPlanByProgramId(programId: string): Promise<TransitionPlan | undefined> {
    const [plan] = await db
      .select()
      .from(transitionPlans)
      .where(eq(transitionPlans.programId, programId));
    return plan || undefined;
  }

  async updateTransitionPlan(id: string, updates: UpdateTransitionPlan): Promise<TransitionPlan | undefined> {
    const [updated] = await db
      .update(transitionPlans)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(transitionPlans.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteTransitionPlan(id: string): Promise<boolean> {
    const result = await db
      .delete(transitionPlans)
      .where(eq(transitionPlans.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // TRANSITION GOAL OPERATIONS
  // ==========================================================================

  async createTransitionGoal(insert: InsertTransitionGoal): Promise<TransitionGoal> {
    const [goal] = await db
      .insert(transitionGoals)
      .values(insert)
      .returning();
    return goal;
  }

  async getTransitionGoalsByPlanId(planId: string): Promise<TransitionGoal[]> {
    return await db
      .select()
      .from(transitionGoals)
      .where(eq(transitionGoals.transitionPlanId, planId));
  }

  async updateTransitionGoal(id: string, updates: UpdateTransitionGoal): Promise<TransitionGoal | undefined> {
    const [updated] = await db
      .update(transitionGoals)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(transitionGoals.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteTransitionGoal(id: string): Promise<boolean> {
    const result = await db
      .delete(transitionGoals)
      .where(eq(transitionGoals.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // TEAM MEMBER OPERATIONS
  // ==========================================================================

  async createTeamMember(insert: InsertTeamMember): Promise<TeamMember> {
    const [member] = await db
      .insert(teamMembers)
      .values(insert)
      .returning();
    return member;
  }

  async getTeamMemberById(id: string): Promise<TeamMember | undefined> {
    const [member] = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.id, id));
    return member || undefined;
  }

  async getTeamMembersByProgramId(programId: string): Promise<TeamMember[]> {
    return await db
      .select()
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.programId, programId),
          eq(teamMembers.isActive, true)
        )
      );
  }

  async updateTeamMember(id: string, updates: UpdateTeamMember): Promise<TeamMember | undefined> {
    const [updated] = await db
      .update(teamMembers)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(teamMembers.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteTeamMember(id: string): Promise<boolean> {
    // Soft delete by setting isActive to false
    const [updated] = await db
      .update(teamMembers)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(teamMembers.id, id))
      .returning();
    return !!updated;
  }

  // ==========================================================================
  // MEETING OPERATIONS
  // ==========================================================================

  async createMeeting(insert: InsertMeeting): Promise<Meeting> {
    const [meeting] = await db
      .insert(meetings)
      .values(insert)
      .returning();
    return meeting;
  }

  async getMeetingById(id: string): Promise<Meeting | undefined> {
    const [meeting] = await db
      .select()
      .from(meetings)
      .where(eq(meetings.id, id));
    return meeting || undefined;
  }

  async getMeetingsByProgramId(programId: string): Promise<Meeting[]> {
    return await db
      .select()
      .from(meetings)
      .where(eq(meetings.programId, programId))
      .orderBy(desc(meetings.scheduledDate));
  }

  async updateMeeting(id: string, updates: UpdateMeeting): Promise<Meeting | undefined> {
    const [updated] = await db
      .update(meetings)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(meetings.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteMeeting(id: string): Promise<boolean> {
    const result = await db
      .delete(meetings)
      .where(eq(meetings.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // CONSENT FORM OPERATIONS
  // ==========================================================================

  async createConsentForm(insert: InsertConsentForm): Promise<ConsentForm> {
    const [form] = await db
      .insert(consentForms)
      .values(insert)
      .returning();
    return form;
  }

  async getConsentFormById(id: string): Promise<ConsentForm | undefined> {
    const [form] = await db
      .select()
      .from(consentForms)
      .where(eq(consentForms.id, id));
    return form || undefined;
  }

  async getConsentFormsByProgramId(programId: string): Promise<ConsentForm[]> {
    return await db
      .select()
      .from(consentForms)
      .where(eq(consentForms.programId, programId));
  }

  async updateConsentForm(id: string, updates: UpdateConsentForm): Promise<ConsentForm | undefined> {
    const [updated] = await db
      .update(consentForms)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(consentForms.id, id))
      .returning();
    return updated || undefined;
  }

  async deleteConsentForm(id: string): Promise<boolean> {
    const result = await db
      .delete(consentForms)
      .where(eq(consentForms.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // AGGREGATE QUERIES
  // ==========================================================================

  /**
   * Calculate overall progress for a program based on goal statuses
   */
  async calculateProgramProgress(programId: string): Promise<number> {
    const programGoals = await this.getGoalsByProgramId(programId);
    if (programGoals.length === 0) return 0;

    const completedGoals = programGoals.filter(g => g.status === "achieved").length;
    return Math.round((completedGoals / programGoals.length) * 100);
  }

  /**
   * Get programs with upcoming deadlines
   */
  async getProgramsWithUpcomingDeadlines(daysAhead: number = 30): Promise<Program[]> {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + daysAhead);

    return await db
      .select()
      .from(programs)
      .where(
        and(
          eq(programs.status, "active"),
          sql`${programs.dueDate} <= ${futureDate.toISOString().split("T")[0]}`,
          sql`${programs.dueDate} >= CURRENT_DATE`
        )
      )
      .orderBy(asc(programs.dueDate));
  }

  /**
   * Get count of goals by status for a program
   */
  async getGoalStatusCounts(programId: string): Promise<Record<string, number>> {
    const result = await db
      .select({
        status: goals.status,
        count: count(),
      })
      .from(goals)
      .where(eq(goals.programId, programId))
      .groupBy(goals.status);

    return result.reduce((acc, row) => {
      acc[row.status] = row.count;
      return acc;
    }, {} as Record<string, number>);
  }
}

export const programRepository = new ProgramRepository();