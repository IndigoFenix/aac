import { programRepository } from "../repositories";
import { studentRepository } from "../repositories";
import type { AccessCtx } from "./sharing/visibility";
import {
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
  type ProgramContact,
  type InsertProgramContact,
  type UpdateProgramContact,
  type StudentContact,
  type Meeting,
  type InsertMeeting,
  type UpdateMeeting,
  type ConsentForm,
  type InsertConsentForm,
  type UpdateConsentForm,
  type ProgramWithDetails,
  type StudentWithProgramSummary,
  type GoalWithContext,
  type OverviewStats,
  type ProgramFramework,
  type UserGoal,
  type InsertUserGoal,
  type UpdateUserGoal,
  type UserObjective,
  type InsertUserObjective,
  type UpdateUserObjective,
} from "@shared/schema";

export class ProgramService {
  // ==========================================================================
  // PROGRAM OPERATIONS
  // ==========================================================================

  /**
   * Create a new program for a student
   */
  async createProgram(insert: InsertProgram): Promise<Program> {
    // Set default due date based on framework
    if (!insert.dueDate && insert.framework === "tala") {
      // TALA deadline is November 15th of the school year
      const now = new Date();
      const year = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
      insert.dueDate = `${year}-11-15`;
    }

    return programRepository.createProgram(insert);
  }

  /**
   * Create a program with initial profile domains
   */
  async createProgramWithProfile(
    insert: InsertProgram,
    createDefaultDomains: boolean = true
  ): Promise<{ program: Program; domains: ProfileDomain[] }> {
    const program = await this.createProgram(insert);
    const domains: ProfileDomain[] = [];

    if (createDefaultDomains) {
      // Create default domains based on framework
      const defaultDomainTypes = [
        "cognitive_academic",
        "communication_language",
        "social_emotional_behavioral",
        "motor_sensory",
        "life_skills_preparation",
      ];

      for (let i = 0; i < defaultDomainTypes.length; i++) {
        const domain = await programRepository.createProfileDomain({
          programId: program.id,
          domainType: defaultDomainTypes[i] as any,
          sortOrder: i,
        });
        domains.push(domain);
      }
    }

    return { program, domains };
  }

  /**
   * Get a program by ID. Pass `ctx` to filter through cross-institute visibility.
   */
  async getProgramById(id: string, ctx?: AccessCtx): Promise<Program | undefined> {
    return programRepository.getProgramById(id, ctx);
  }

  /**
   * Get programs for a student. Pass `ctx` to filter through cross-institute visibility.
   */
  async getProgramsByStudentId(studentId: string, ctx?: AccessCtx): Promise<Program[]> {
    return programRepository.getProgramsByStudentId(studentId, ctx);
  }

  /**
   * Get the current active program for a student. Pass `ctx` to filter through
   * cross-institute visibility.
   */
  async getCurrentProgram(studentId: string, ctx?: AccessCtx): Promise<Program | undefined> {
    return programRepository.getCurrentProgram(studentId, ctx);
  }

  /**
   * Get full program with all details. Pass `ctx` to filter through cross-institute visibility.
   */
  async getProgramWithDetails(programId: string, ctx?: AccessCtx): Promise<ProgramWithDetails | undefined> {
    return programRepository.getProgramWithDetails(programId, ctx);
  }

  /**
   * Update a program
   */
  async updateProgram(id: string, updates: UpdateProgram): Promise<Program | undefined> {
    return programRepository.updateProgram(id, updates);
  }

  /**
   * Activate a program (set status to active)
   */
  async activateProgram(id: string): Promise<Program | undefined> {
    return programRepository.updateProgram(id, { status: "active" });
  }

  /**
   * Archive a program
   */
  async archiveProgram(id: string): Promise<Program | undefined> {
    return programRepository.updateProgram(id, { status: "archived" });
  }

  /**
   * Delete a program
   */
  async deleteProgram(id: string): Promise<boolean> {
    return programRepository.deleteProgram(id);
  }

  /**
   * Verify user has access to a program
   */
  async verifyProgramAccess(
    programId: string,
    userId: string
  ): Promise<{ hasAccess: boolean; program?: Program }> {
    const program = await programRepository.getProgramById(programId);
    if (!program) {
      return { hasAccess: false };
    }

    // Check if user has access to the student
    const { hasAccess } = await studentRepository.userHasAccessToStudent(
      userId,
      program.studentId
    );

    return { hasAccess, program };
  }

  // ==========================================================================
  // PROFILE DOMAIN OPERATIONS
  // ==========================================================================

  async createProfileDomain(insert: InsertProfileDomain): Promise<ProfileDomain> {
    return programRepository.createProfileDomain(insert);
  }

  async getProfileDomainById(id: string): Promise<ProfileDomain | undefined> {
    return programRepository.getProfileDomainById(id);
  }

  async getProfileDomainsByProgramId(programId: string): Promise<ProfileDomain[]> {
    return programRepository.getProfileDomainsByProgramId(programId);
  }

  async updateProfileDomain(id: string, updates: UpdateProfileDomain): Promise<ProfileDomain | undefined> {
    return programRepository.updateProfileDomain(id, updates);
  }

  async deleteProfileDomain(id: string): Promise<boolean> {
    return programRepository.deleteProfileDomain(id);
  }

  // ==========================================================================
  // BASELINE MEASUREMENT OPERATIONS
  // ==========================================================================

  async createBaselineMeasurement(insert: InsertBaselineMeasurement): Promise<BaselineMeasurement> {
    return programRepository.createBaselineMeasurement(insert);
  }

  async getBaselineMeasurementsByDomainId(domainId: string): Promise<BaselineMeasurement[]> {
    return programRepository.getBaselineMeasurementsByDomainId(domainId);
  }

  async deleteBaselineMeasurement(id: string): Promise<boolean> {
    return programRepository.deleteBaselineMeasurement(id);
  }

  // ==========================================================================
  // ASSESSMENT SOURCE OPERATIONS
  // ==========================================================================

  async createAssessmentSource(insert: InsertAssessmentSource): Promise<AssessmentSource> {
    return programRepository.createAssessmentSource(insert);
  }

  async getAssessmentSourcesByDomainId(domainId: string): Promise<AssessmentSource[]> {
    return programRepository.getAssessmentSourcesByDomainId(domainId);
  }

  async deleteAssessmentSource(id: string): Promise<boolean> {
    return programRepository.deleteAssessmentSource(id);
  }

  // ==========================================================================
  // GOAL OPERATIONS
  // ==========================================================================

  async createGoal(insert: InsertGoal): Promise<Goal> {
    return programRepository.createGoal(insert);
  }

  async getGoalById(id: string): Promise<Goal | undefined> {
    return programRepository.getGoalById(id);
  }

  async getGoalsByProgramId(programId: string): Promise<Goal[]> {
    return programRepository.getGoalsByProgramId(programId);
  }

  /**
   * Get goals that have objectives in a specific domain
   * (Goals are now linked to domains through their objectives)
   */
  async getGoalsByDomainId(domainId: string): Promise<Goal[]> {
    return programRepository.getGoalsByDomainId(domainId);
  }

  /**
   * Get domains associated with a goal through its objectives
   */
  async getDomainsForGoal(goalId: string): Promise<ProfileDomain[]> {
    return programRepository.getDomainsForGoal(goalId);
  }

  async getGoalWithContext(goalId: string): Promise<GoalWithContext | undefined> {
    return programRepository.getGoalWithContext(goalId);
  }

  async updateGoal(id: string, updates: UpdateGoal): Promise<Goal | undefined> {
    return programRepository.updateGoal(id, updates);
  }

  async deleteGoal(id: string): Promise<boolean> {
    return programRepository.deleteGoal(id);
  }

  /**
   * Mark a goal as achieved
   */
  async achieveGoal(id: string): Promise<Goal | undefined> {
    return programRepository.updateGoal(id, { status: "achieved", progress: 100 });
  }

  /**
   * Update goal progress
   */
  async updateGoalProgress(id: string, progress: number): Promise<Goal | undefined> {
    const clampedProgress = Math.max(0, Math.min(100, progress));
    const status = clampedProgress >= 100 ? "achieved" : "active";
    return programRepository.updateGoal(id, { 
      progress: clampedProgress,
      status,
      achievedDate: clampedProgress >= 100 ? new Date().toISOString().split('T')[0] : undefined
    });
  }

  /**
   * Generate a SMART goal statement from components
   */
  generateSmartGoalStatement(components: {
    targetBehavior: string;
    context: string;
    criteria: string;
    measurementMethod: string;
    targetDate: string;
  }): string {
    return `By ${components.targetDate}, the student will ${components.targetBehavior} ${components.context}, achieving ${components.criteria} as measured by ${components.measurementMethod}.`;
  }

  // ==========================================================================
  // OBJECTIVE OPERATIONS
  // ==========================================================================

  async createObjective(insert: InsertObjective): Promise<Objective> {
    return programRepository.createObjective(insert);
  }

  async getObjectiveById(id: string): Promise<Objective | undefined> {
    return programRepository.getObjectiveById(id);
  }

  async getObjectivesByGoalId(goalId: string): Promise<Objective[]> {
    return programRepository.getObjectivesByGoalId(goalId);
  }

  /**
   * Get objectives for a specific domain
   */
  async getObjectivesByDomainId(domainId: string): Promise<Objective[]> {
    return programRepository.getObjectivesByDomainId(domainId);
  }

  async updateObjective(id: string, updates: UpdateObjective): Promise<Objective | undefined> {
    return programRepository.updateObjective(id, updates);
  }

  async deleteObjective(id: string): Promise<boolean> {
    return programRepository.deleteObjective(id);
  }

  /**
   * Update objective progress
   */
  async updateObjectiveProgress(id: string, progress: number): Promise<Objective | undefined> {
    const clampedProgress = Math.max(0, Math.min(100, progress));
    const status = clampedProgress >= 100 ? "achieved" :
                   clampedProgress > 0 ? "active" : "draft";
    return programRepository.updateObjective(id, { 
      progress: clampedProgress,
      status,
      achievedDate: clampedProgress >= 100 ? new Date().toISOString().split('T')[0] : undefined
    });
  }

  /**
   * Recalculate goal progress based on its objectives' progress
   */
  async recalculateGoalProgress(goalId: string): Promise<Goal | undefined> {
    const goalObjectives = await programRepository.getObjectivesByGoalId(goalId);
    
    if (goalObjectives.length === 0) {
      return programRepository.getGoalById(goalId);
    }
    
    const totalProgress = goalObjectives.reduce((sum, obj) => sum + (obj.progress ?? 0), 0);
    const averageProgress = Math.round(totalProgress / goalObjectives.length);
    
    return this.updateGoalProgress(goalId, averageProgress);
  }

  // ==========================================================================
  // SERVICE OPERATIONS
  // ==========================================================================

  async createService(insert: InsertService): Promise<Service> {
    return programRepository.createService(insert);
  }

  async getServiceById(id: string): Promise<Service | undefined> {
    return programRepository.getServiceById(id);
  }

  async getServicesByProgramId(programId: string): Promise<Service[]> {
    return programRepository.getServicesByProgramId(programId);
  }

  async updateService(id: string, updates: UpdateService): Promise<Service | undefined> {
    return programRepository.updateService(id, updates);
  }

  async deleteService(id: string): Promise<boolean> {
    return programRepository.deleteService(id);
  }

  async linkServiceToGoal(serviceId: string, goalId: string): Promise<void> {
    return programRepository.linkServiceToGoal(serviceId, goalId);
  }

  async unlinkServiceFromGoal(serviceId: string, goalId: string): Promise<void> {
    return programRepository.unlinkServiceFromGoal(serviceId, goalId);
  }

  // Service ↔ Users

  async getServiceUsers(serviceId: string) {
    return programRepository.getServiceUsers(serviceId);
  }

  async linkUserToService(serviceId: string, userId: string) {
    return programRepository.linkUserToService(serviceId, userId);
  }

  async unlinkUserFromService(serviceId: string, userId: string): Promise<void> {
    return programRepository.unlinkUserFromService(serviceId, userId);
  }

  // ==========================================================================
  // ACCOMMODATION OPERATIONS
  // ==========================================================================

  async createAccommodation(insert: InsertAccommodation): Promise<Accommodation> {
    return programRepository.createAccommodation(insert);
  }

  async getAccommodationsByServiceId(serviceId: string): Promise<Accommodation[]> {
    return programRepository.getAccommodationsByServiceId(serviceId);
  }

  async getAccommodationsByProgramId(programId: string): Promise<Accommodation[]> {
    return programRepository.getAccommodationsByProgramId(programId);
  }

  async updateAccommodation(id: string, updates: UpdateAccommodation): Promise<Accommodation | undefined> {
    return programRepository.updateAccommodation(id, updates);
  }

  async deleteAccommodation(id: string): Promise<boolean> {
    return programRepository.deleteAccommodation(id);
  }

  // ==========================================================================
  // PROGRESS REPORT OPERATIONS
  // ==========================================================================

  async createProgressReport(insert: InsertProgressReport): Promise<ProgressReport> {
    return programRepository.createProgressReport(insert);
  }

  async getProgressReportById(id: string): Promise<ProgressReport | undefined> {
    return programRepository.getProgressReportById(id);
  }

  async getProgressReportsByProgramId(programId: string): Promise<ProgressReport[]> {
    return programRepository.getProgressReportsByProgramId(programId);
  }

  async updateProgressReport(id: string, updates: UpdateProgressReport): Promise<ProgressReport | undefined> {
    return programRepository.updateProgressReport(id, updates);
  }

  async deleteProgressReport(id: string): Promise<boolean> {
    return programRepository.deleteProgressReport(id);
  }

  // ==========================================================================
  // GOAL PROGRESS ENTRY OPERATIONS
  // ==========================================================================

  async createGoalProgressEntry(insert: InsertGoalProgressEntry): Promise<GoalProgressEntry> {
    return programRepository.createGoalProgressEntry(insert);
  }

  async getGoalProgressEntriesByReportId(reportId: string): Promise<GoalProgressEntry[]> {
    return programRepository.getGoalProgressEntriesByReportId(reportId);
  }

  async getGoalProgressEntriesByGoalId(goalId: string): Promise<GoalProgressEntry[]> {
    return programRepository.getGoalProgressEntriesByGoalId(goalId);
  }

  // ==========================================================================
  // DATA POINT OPERATIONS
  // ==========================================================================

  async createDataPoint(insert: InsertDataPoint): Promise<DataPoint> {
    return programRepository.createDataPoint(insert);
  }

  async getDataPointsByGoalId(goalId: string): Promise<DataPoint[]> {
    return programRepository.getDataPointsByGoalId(goalId);
  }

  async getDataPointsByObjectiveId(objectiveId: string): Promise<DataPoint[]> {
    return programRepository.getDataPointsByObjectiveId(objectiveId);
  }

  async deleteDataPoint(id: string): Promise<boolean> {
    return programRepository.deleteDataPoint(id);
  }

  // ==========================================================================
  // TRANSITION PLAN OPERATIONS
  // ==========================================================================

  async createTransitionPlan(insert: InsertTransitionPlan): Promise<TransitionPlan> {
    return programRepository.createTransitionPlan(insert);
  }

  async getTransitionPlanById(id: string): Promise<TransitionPlan | undefined> {
    return programRepository.getTransitionPlanById(id);
  }

  async getTransitionPlanByProgramId(programId: string): Promise<TransitionPlan | undefined> {
    return programRepository.getTransitionPlanByProgramId(programId);
  }

  async updateTransitionPlan(id: string, updates: UpdateTransitionPlan): Promise<TransitionPlan | undefined> {
    return programRepository.updateTransitionPlan(id, updates);
  }

  async deleteTransitionPlan(id: string): Promise<boolean> {
    return programRepository.deleteTransitionPlan(id);
  }

  // ==========================================================================
  // TRANSITION GOAL OPERATIONS
  // ==========================================================================

  async createTransitionGoal(insert: InsertTransitionGoal): Promise<TransitionGoal> {
    return programRepository.createTransitionGoal(insert);
  }

  async getTransitionGoalsByPlanId(planId: string): Promise<TransitionGoal[]> {
    return programRepository.getTransitionGoalsByPlanId(planId);
  }

  async updateTransitionGoal(id: string, updates: UpdateTransitionGoal): Promise<TransitionGoal | undefined> {
    return programRepository.updateTransitionGoal(id, updates);
  }

  async deleteTransitionGoal(id: string): Promise<boolean> {
    return programRepository.deleteTransitionGoal(id);
  }

  // ==========================================================================
  // TEAM MEMBER OPERATIONS
  // ==========================================================================

  // ------------------------------------------------------------------
  // Program team (contacts junction)
  // ------------------------------------------------------------------

  async addTeamContact(insert: InsertProgramContact): Promise<ProgramContact> {
    return programRepository.addProgramContact(insert);
  }

  async getTeamContactById(id: string): Promise<ProgramContact | undefined> {
    return programRepository.getProgramContactById(id);
  }

  async getTeamContactsByProgramId(
    programId: string,
  ): Promise<(ProgramContact & { contact: StudentContact })[]> {
    return programRepository.getTeamContactsByProgramId(programId);
  }

  async updateTeamContact(
    id: string,
    updates: UpdateProgramContact,
  ): Promise<ProgramContact | undefined> {
    return programRepository.updateProgramContact(id, updates);
  }

  async removeTeamContact(id: string): Promise<boolean> {
    return programRepository.removeProgramContact(id);
  }

  // ==========================================================================
  // MEETING OPERATIONS
  // ==========================================================================

  async createMeeting(insert: InsertMeeting): Promise<Meeting> {
    return programRepository.createMeeting(insert);
  }

  async getMeetingById(id: string): Promise<Meeting | undefined> {
    return programRepository.getMeetingById(id);
  }

  async getMeetingsByProgramId(programId: string): Promise<Meeting[]> {
    return programRepository.getMeetingsByProgramId(programId);
  }

  async updateMeeting(id: string, updates: UpdateMeeting): Promise<Meeting | undefined> {
    return programRepository.updateMeeting(id, updates);
  }

  async deleteMeeting(id: string): Promise<boolean> {
    return programRepository.deleteMeeting(id);
  }

  // ==========================================================================
  // CONSENT FORM OPERATIONS
  // ==========================================================================

  async createConsentForm(insert: InsertConsentForm): Promise<ConsentForm> {
    return programRepository.createConsentForm(insert);
  }

  async getConsentFormById(id: string): Promise<ConsentForm | undefined> {
    return programRepository.getConsentFormById(id);
  }

  async getConsentFormsByProgramId(programId: string): Promise<ConsentForm[]> {
    return programRepository.getConsentFormsByProgramId(programId);
  }

  async updateConsentForm(id: string, updates: UpdateConsentForm): Promise<ConsentForm | undefined> {
    return programRepository.updateConsentForm(id, updates);
  }

  async deleteConsentForm(id: string): Promise<boolean> {
    return programRepository.deleteConsentForm(id);
  }

  /**
   * Check if all required consents are in place
   */
  async checkConsentCompliance(programId: string): Promise<{
    isCompliant: boolean;
    missingConsents: string[];
    pendingConsents: string[];
  }> {
    const consents = await programRepository.getConsentFormsByProgramId(programId);
    const requiredTypes = [
      "initial_evaluation",
      "placement",
      "service_provision",
    ];

    const consentsByType = consents.reduce((acc, c) => {
      acc[c.consentType] = c;
      return acc;
    }, {} as Record<string, ConsentForm>);

    const missingConsents: string[] = [];
    const pendingConsents: string[] = [];

    for (const type of requiredTypes) {
      const consent = consentsByType[type];
      if (!consent) {
        missingConsents.push(type);
      } else if (consent.consentGiven === null) {
        pendingConsents.push(type);
      }
    }

    return {
      isCompliant: missingConsents.length === 0 && pendingConsents.length === 0,
      missingConsents,
      pendingConsents,
    };
  }

  // ==========================================================================
  // USER-GOAL OPERATIONS (Many-to-Many)
  // ==========================================================================

  async assignUserToGoal(insert: InsertUserGoal): Promise<UserGoal> {
    return programRepository.assignUserToGoal(insert);
  }

  async getUserGoalById(id: string): Promise<UserGoal | undefined> {
    return programRepository.getUserGoalById(id);
  }

  async getUserGoalsByGoalId(goalId: string): Promise<UserGoal[]> {
    return programRepository.getUserGoalsByGoalId(goalId);
  }

  async getUserGoalsByUserId(userId: string): Promise<UserGoal[]> {
    return programRepository.getUserGoalsByUserId(userId);
  }

  async getGoalsForUser(userId: string): Promise<Goal[]> {
    return programRepository.getGoalsForUser(userId);
  }

  async updateUserGoal(id: string, updates: UpdateUserGoal): Promise<UserGoal | undefined> {
    return programRepository.updateUserGoal(id, updates);
  }

  async removeUserFromGoal(userId: string, goalId: string): Promise<boolean> {
    return programRepository.removeUserFromGoal(userId, goalId);
  }

  // ==========================================================================
  // USER-OBJECTIVE OPERATIONS (Many-to-Many)
  // ==========================================================================

  async assignUserToObjective(insert: InsertUserObjective): Promise<UserObjective> {
    return programRepository.assignUserToObjective(insert);
  }

  async getUserObjectiveById(id: string): Promise<UserObjective | undefined> {
    return programRepository.getUserObjectiveById(id);
  }

  async getUserObjectivesByObjectiveId(objectiveId: string): Promise<UserObjective[]> {
    return programRepository.getUserObjectivesByObjectiveId(objectiveId);
  }

  async getUserObjectivesByUserId(userId: string): Promise<UserObjective[]> {
    return programRepository.getUserObjectivesByUserId(userId);
  }

  async getObjectivesForUser(userId: string): Promise<Objective[]> {
    return programRepository.getObjectivesForUser(userId);
  }

  async updateUserObjective(id: string, updates: UpdateUserObjective): Promise<UserObjective | undefined> {
    return programRepository.updateUserObjective(id, updates);
  }

  async removeUserFromObjective(userId: string, objectiveId: string): Promise<boolean> {
    return programRepository.removeUserFromObjective(userId, objectiveId);
  }

  // ==========================================================================
  // AGGREGATE OPERATIONS
  // ==========================================================================

  /**
   * Get overview stats for a user's students
   */
  async getOverviewStats(userId: string): Promise<OverviewStats> {
    console.log('Get overview stats for user:', userId);
    const studentsWithLinks = await studentRepository.getStudentsWithLinksByUserId(userId);
    console.log('Found students:', studentsWithLinks.length);
    let activeCases = 0;
    let completedCases = 0;
    let pendingReview = 0;
    let upcomingDeadlines = 0;

    const today = new Date();
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(today.getDate() + 30);

    for (const { student } of studentsWithLinks) {
      console.log('Processing student:', student.id);
      const currentProgram = await programRepository.getCurrentProgram(student.id);
      console.log('Current program:', currentProgram);
      
      if (currentProgram) {
        if (currentProgram.status === "active") {
          activeCases++;
          
          if (currentProgram.dueDate) {
            const dueDate = new Date(currentProgram.dueDate);
            if (dueDate <= thirtyDaysFromNow && dueDate >= today) {
              upcomingDeadlines++;
            }
          }
        } else if (currentProgram.status === "archived") {
          completedCases++;
        } else if (currentProgram.status === "draft") {
          pendingReview++;
        }
      }
    }

    return {
      totalStudents: studentsWithLinks.length,
      activeCases,
      completedCases,
      pendingReview,
      upcomingDeadlines,
    };
  }

  /**
   * Get students with their current program summary
   */
  async getStudentsWithProgramSummary(userId: string): Promise<StudentWithProgramSummary[]> {
    const studentsWithLinks = await studentRepository.getStudentsWithLinksByUserId(userId);
    const results: StudentWithProgramSummary[] = [];

    for (const { student, link } of studentsWithLinks) {
      const currentProgram = await programRepository.getCurrentProgram(student.id);
      
      let programSummary: StudentWithProgramSummary["currentProgram"] = undefined;
      
      if (currentProgram) {
        const programGoals = await programRepository.getGoalsByProgramId(currentProgram.id);
        const completedGoals = programGoals.filter(g => g.status === "achieved").length;
        
        // Use average progress instead of just completed count
        const totalProgress = programGoals.reduce((sum, g) => sum + (g.progress ?? 0), 0);
        const overallProgress = programGoals.length > 0
          ? Math.round(totalProgress / programGoals.length)
          : 0;

        programSummary = {
          id: currentProgram.id,
          status: currentProgram.status,
          dueDate: currentProgram.dueDate || undefined,
          goalsCount: programGoals.length,
          goalsCompleted: completedGoals,
          overallProgress,
        };
      }

      results.push({
        student,
        currentProgram: programSummary,
        role: link.role || "",
      });
    }

    return results;
  }

  /**
   * Calculate program progress
   */
  async calculateProgramProgress(programId: string): Promise<number> {
    return programRepository.calculateProgramProgress(programId);
  }

  /**
   * Get goal status distribution for a program
   */
  async getGoalStatusCounts(programId: string): Promise<Record<string, number>> {
    return programRepository.getGoalStatusCounts(programId);
  }

  /**
   * Get average goal progress for a program
   */
  async getAverageGoalProgress(programId: string): Promise<number> {
    return programRepository.getAverageGoalProgress(programId);
  }
}

export const programService = new ProgramService();