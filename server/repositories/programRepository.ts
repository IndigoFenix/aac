import {
  programs,
  profileDomains,
  baselineMeasurements,
  assessmentSources,
  goals,
  objectives,
  services,
  serviceGoals,
  serviceUsers,
  accommodations,
  progressReports,
  goalProgressEntries,
  dataPoints,
  transitionPlans,
  transitionGoals,
  programContacts,
  studentContacts,
  meetings,
  consentForms,
  students,
  userGoals,
  userObjectives,
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
  type ServiceUser,
  type InsertServiceUser,
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
  type UserGoal,
  type InsertUserGoal,
  type UpdateUserGoal,
  type UserObjective,
  type InsertUserObjective,
  type UpdateUserObjective,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc, asc, sql, inArray, isNull, count } from "drizzle-orm";
import {
  hydrateRecords,
  extractSensitiveFields,
  persistExtracted,
  deleteExternalData,
  type EntityRef,
} from "../external-storage";
import {
  withInstituteVisibility,
  withInheritedVisibility,
  visibleProgramIds,
  type AccessCtx,
} from "../services/sharing/visibility";
import {
  recordShareDerivedView,
  recordShareDerivedViewSingle,
} from "../services/sharing/audit";

export class ProgramRepository {
  private studentRef(studentId: string): EntityRef {
    return { type: "student", id: studentId };
  }

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

    const ref = this.studentRef(program.studentId);
    const ext = await extractSensitiveFields("programs", program.id, program as Record<string, unknown>, ref);
    if (ext.isExternal) {
      const nullSet: Record<string, null> = {};
      for (const key of ext.externalWrites.keys()) {
        const field = key.split("/").pop()!;
        nullSet[field] = null;
      }
      await db.update(programs).set(nullSet).where(eq(programs.id, program.id));
      await persistExtracted(ref, ext.externalWrites);
    }
    return ext.completeData as Program;
  }

  /**
   * Get a program by ID
   */
  async getProgramById(id: string, ctx?: AccessCtx): Promise<Program | undefined> {
    const where = ctx
      ? and(eq(programs.id, id), withInstituteVisibility(programs, ctx, "program"))
      : eq(programs.id, id);
    const [program] = await db
      .select()
      .from(programs)
      .where(where);
    if (!program) return undefined;
    if (ctx) recordShareDerivedViewSingle(ctx, "program", program);
    const [hydrated] = await hydrateRecords("programs", [program]);
    return hydrated;
  }

  /**
   * Get all programs for a student
   */
  async getProgramsByStudentId(studentId: string, ctx?: AccessCtx): Promise<Program[]> {
    const where = ctx
      ? and(eq(programs.studentId, studentId), withInstituteVisibility(programs, ctx, "program"))
      : eq(programs.studentId, studentId);
    const rows = await db
      .select()
      .from(programs)
      .where(where)
      .orderBy(desc(programs.createdAt));
    if (ctx) recordShareDerivedView(ctx, "program", rows);
    return hydrateRecords("programs", rows, this.studentRef(studentId));
  }

  /**
   * Get the current/working program for a student.
   * Returns active programs first, then drafts. Excludes archived programs.
   * This allows users to work with draft programs before activation.
   */
  async getCurrentProgram(studentId: string, ctx?: AccessCtx): Promise<Program | undefined> {
    const ref = this.studentRef(studentId);
    const visibility = ctx ? withInstituteVisibility(programs, ctx, "program") : undefined;

    // First try to get an active program
    const [activeProgram] = await db
      .select()
      .from(programs)
      .where(
        and(
          eq(programs.studentId, studentId),
          eq(programs.status, "active"),
          visibility,
        )
      )
      .orderBy(desc(programs.createdAt))
      .limit(1);

    if (activeProgram) {
      if (ctx) recordShareDerivedViewSingle(ctx, "program", activeProgram);
      const [hydrated] = await hydrateRecords("programs", [activeProgram], ref);
      return hydrated;
    }

    // If no active program, get the most recent draft
    const [draftProgram] = await db
      .select()
      .from(programs)
      .where(
        and(
          eq(programs.studentId, studentId),
          eq(programs.status, "draft"),
          visibility,
        )
      )
      .orderBy(desc(programs.createdAt))
      .limit(1);

    if (!draftProgram) return undefined;
    if (ctx) recordShareDerivedViewSingle(ctx, "program", draftProgram);
    const [hydrated] = await hydrateRecords("programs", [draftProgram], ref);
    return hydrated;
  }

  /**
   * Update a program
   */
  async updateProgram(id: string, updates: UpdateProgram): Promise<Program | undefined> {
    // Look up the existing record to resolve entity ref
    const existing = await this.getProgramById(id);
    if (!existing) return undefined;

    const ref = this.studentRef(existing.studentId);
    const ext = await extractSensitiveFields("programs", id, updates as Record<string, unknown>, ref);

    const [updated] = await db
      .update(programs)
      .set({ ...ext.dbData, updatedAt: new Date() })
      .where(eq(programs.id, id))
      .returning();

    if (!updated) return undefined;
    if (ext.isExternal) await persistExtracted(ref, ext.externalWrites);
    const [hydrated] = await hydrateRecords("programs", [updated], ref);
    return hydrated;
  }

  /**
   * Delete a program and all related data
   */
  async deleteProgram(id: string): Promise<boolean> {
    // Look up the record to get studentId for external cleanup
    const existing = await this.getProgramById(id);

    // This would cascade delete related entities in a real implementation
    // For now, just delete the program itself
    const result = await db
      .delete(programs)
      .where(eq(programs.id, id));

    const deleted = (result.rowCount ?? 0) > 0;
    if (deleted && existing) {
      await deleteExternalData("programs", id, this.studentRef(existing.studentId));
    }
    return deleted;
  }

  /**
   * Get full program with all related details
   */
  async getProgramWithDetails(programId: string, ctx?: AccessCtx): Promise<ProgramWithDetails | undefined> {
    const program = await this.getProgramById(programId, ctx);
    if (!program) return undefined;

    const [student] = await db
      .select()
      .from(students)
      .where(eq(students.id, program.studentId));

    if (!student) return undefined;

    // Fetch all related data — once the parent program is visible, child reads
    // also pass ctx so that any individual access-cycle (e.g. a goal moved to
    // a different program) gets re-checked at the child level too.
    const domains = await this.getProfileDomainsByProgramId(programId, ctx);
    const domainsWithData = await Promise.all(
      domains.map(async (domain) => ({
        ...domain,
        baselineMeasurements: await this.getBaselineMeasurementsByDomainId(domain.id, ctx),
        assessmentSources: await this.getAssessmentSourcesByDomainId(domain.id, ctx),
      }))
    );

    const programGoals = await this.getGoalsByProgramId(programId, ctx);
    const goalsWithData = await Promise.all(
      programGoals.map(async (goal) => {
        const goalObjectives = await this.getObjectivesByGoalId(goal.id, ctx);
        return {
          ...goal,
          objectives: goalObjectives,
          dataPoints: await this.getDataPointsByGoalId(goal.id, ctx),
          // Get domains for this goal via its objectives
          domains: await this.getDomainsForGoal(goal.id),
        };
      })
    );

    const programServices = await this.getServicesByProgramId(programId, ctx);
    const servicesWithData = await Promise.all(
      programServices.map(async (service) => {
        const serviceGoalLinks = await db
          .select()
          .from(serviceGoals)
          .where(eq(serviceGoals.serviceId, service.id));
        return {
          ...service,
          accommodations: await this.getAccommodationsByServiceId(service.id, ctx),
          linkedGoalIds: serviceGoalLinks.map(sg => sg.goalId),
        };
      })
    );

    const reports = await this.getProgressReportsByProgramId(programId, ctx);
    const reportsWithEntries = await Promise.all(
      reports.map(async (report) => ({
        ...report,
        entries: await this.getGoalProgressEntriesByReportId(report.id, ctx),
      }))
    );

    const transition = await this.getTransitionPlanByProgramId(programId, ctx);
    const transitionWithGoals = transition
      ? {
          ...transition,
          goals: await this.getTransitionGoalsByPlanId(transition.id, ctx),
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
      teamContacts: await this.getTeamContactsByProgramId(programId, ctx),
      meetings: await this.getMeetingsByProgramId(programId, ctx),
      consentForms: await this.getConsentFormsByProgramId(programId, ctx),
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

  async getProfileDomainById(id: string, ctx?: AccessCtx): Promise<ProfileDomain | undefined> {
    const where = ctx
      ? and(
          eq(profileDomains.id, id),
          inArray(profileDomains.programId, visibleProgramIds(ctx)),
        )
      : eq(profileDomains.id, id);
    const [domain] = await db
      .select()
      .from(profileDomains)
      .where(where);
    if (!domain) return undefined;
    const [hydrated] = await hydrateRecords("profile_domains", [domain]);
    return hydrated;
  }

  async getProfileDomainsByProgramId(programId: string, ctx?: AccessCtx): Promise<ProfileDomain[]> {
    const where = ctx
      ? and(
          eq(profileDomains.programId, programId),
          withInheritedVisibility(profileDomains.programId, programs, ctx, "program"),
        )
      : eq(profileDomains.programId, programId);
    const rows = await db
      .select()
      .from(profileDomains)
      .where(where)
      .orderBy(asc(profileDomains.sortOrder));
    return hydrateRecords("profile_domains", rows);
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

  async getBaselineMeasurementsByDomainId(domainId: string, ctx?: AccessCtx): Promise<BaselineMeasurement[]> {
    const where = ctx
      ? and(
          eq(baselineMeasurements.profileDomainId, domainId),
          inArray(
            baselineMeasurements.profileDomainId,
            db.select({ id: profileDomains.id }).from(profileDomains).where(
              inArray(profileDomains.programId, visibleProgramIds(ctx)),
            ),
          ),
        )
      : eq(baselineMeasurements.profileDomainId, domainId);
    const rows = await db
      .select()
      .from(baselineMeasurements)
      .where(where);
    return hydrateRecords("baseline_measurements", rows);
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

  async getAssessmentSourcesByDomainId(domainId: string, ctx?: AccessCtx): Promise<AssessmentSource[]> {
    const where = ctx
      ? and(
          eq(assessmentSources.profileDomainId, domainId),
          inArray(
            assessmentSources.profileDomainId,
            db.select({ id: profileDomains.id }).from(profileDomains).where(
              inArray(profileDomains.programId, visibleProgramIds(ctx)),
            ),
          ),
        )
      : eq(assessmentSources.profileDomainId, domainId);
    const rows = await db
      .select()
      .from(assessmentSources)
      .where(where);
    return hydrateRecords("assessment_sources", rows);
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

  async getGoalById(id: string, ctx?: AccessCtx): Promise<Goal | undefined> {
    const where = ctx
      ? and(eq(goals.id, id), withInheritedVisibility(goals.programId, programs, ctx, "program"))
      : eq(goals.id, id);
    const [goal] = await db
      .select()
      .from(goals)
      .where(where);
    if (!goal) return undefined;
    const [hydrated] = await hydrateRecords("goals", [goal]);
    return hydrated;
  }

  async getGoalsByProgramId(programId: string, ctx?: AccessCtx): Promise<Goal[]> {
    const where = ctx
      ? and(
          eq(goals.programId, programId),
          withInheritedVisibility(goals.programId, programs, ctx, "program"),
        )
      : eq(goals.programId, programId);
    const rows = await db
      .select()
      .from(goals)
      .where(where)
      .orderBy(asc(goals.sortOrder));
    return hydrateRecords("goals", rows);
  }

  /**
   * Get domains for a goal by looking at its objectives' domains
   * Since domains are now on objectives, not goals, we need to aggregate
   * the unique domains from all objectives under this goal.
   */
  async getDomainsForGoal(goalId: string): Promise<ProfileDomain[]> {
    // Get all objectives for this goal
    const goalObjectives = await this.getObjectivesByGoalId(goalId);
    
    // Get unique domain IDs from objectives
    const domainIds = [...new Set(
      goalObjectives
        .map(obj => obj.profileDomainId)
        .filter((id): id is string => id !== null && id !== undefined)
    )];
    
    if (domainIds.length === 0) {
      return [];
    }
    
    // Fetch the actual domain records
    const rows = await db
      .select()
      .from(profileDomains)
      .where(inArray(profileDomains.id, domainIds))
      .orderBy(asc(profileDomains.sortOrder));
    return hydrateRecords("profile_domains", rows);
  }

  /**
   * Get goals that have objectives in a specific domain
   * This replaces the old getGoalsByDomainId which was based on goals.profileDomainId
   */
  async getGoalsByDomainId(domainId: string, ctx?: AccessCtx): Promise<Goal[]> {
    // Find all objectives in this domain
    const domainObjectives = await db
      .select()
      .from(objectives)
      .where(eq(objectives.profileDomainId, domainId));

    // Get unique goal IDs
    const goalIds = [...new Set(domainObjectives.map(obj => obj.goalId))];

    if (goalIds.length === 0) {
      return [];
    }

    const where = ctx
      ? and(
          inArray(goals.id, goalIds),
          withInheritedVisibility(goals.programId, programs, ctx, "program"),
        )
      : inArray(goals.id, goalIds);

    // Fetch the goals
    const rows = await db
      .select()
      .from(goals)
      .where(where)
      .orderBy(asc(goals.sortOrder));
    return hydrateRecords("goals", rows);
  }

  async getGoalWithContext(goalId: string, ctx?: AccessCtx): Promise<GoalWithContext | undefined> {
    const goal = await this.getGoalById(goalId, ctx);
    if (!goal) return undefined;

    const goalObjectives = await this.getObjectivesByGoalId(goalId);
    const goalDataPoints = await this.getDataPointsByGoalId(goalId);
    const latestProgress = await this.getLatestGoalProgressEntryByGoalId(goalId);
    
    // Get domain names from objectives
    const domains = await this.getDomainsForGoal(goalId);
    const domainNames = domains.map(d => d.customName || d.domainType).join(", ");

    return {
      goal,
      domainName: domainNames,
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

  async getObjectiveById(id: string, ctx?: AccessCtx): Promise<Objective | undefined> {
    const visibleGoalIds = ctx
      ? db.select({ id: goals.id }).from(goals).where(
          withInheritedVisibility(goals.programId, programs, ctx, "program"),
        )
      : null;
    const where = visibleGoalIds
      ? and(eq(objectives.id, id), inArray(objectives.goalId, visibleGoalIds))
      : eq(objectives.id, id);
    const [objective] = await db
      .select()
      .from(objectives)
      .where(where);
    if (!objective) return undefined;
    const [hydrated] = await hydrateRecords("objectives", [objective]);
    return hydrated;
  }

  async getObjectivesByGoalId(goalId: string, ctx?: AccessCtx): Promise<Objective[]> {
    const visibleGoalIds = ctx
      ? db.select({ id: goals.id }).from(goals).where(
          withInheritedVisibility(goals.programId, programs, ctx, "program"),
        )
      : null;
    const where = visibleGoalIds
      ? and(eq(objectives.goalId, goalId), inArray(objectives.goalId, visibleGoalIds))
      : eq(objectives.goalId, goalId);
    const rows = await db
      .select()
      .from(objectives)
      .where(where)
      .orderBy(asc(objectives.sequenceOrder));
    return hydrateRecords("objectives", rows);
  }

  /**
   * Get objectives by domain ID
   */
  async getObjectivesByDomainId(domainId: string, ctx?: AccessCtx): Promise<Objective[]> {
    const visibleGoalIds = ctx
      ? db.select({ id: goals.id }).from(goals).where(
          withInheritedVisibility(goals.programId, programs, ctx, "program"),
        )
      : null;
    const where = visibleGoalIds
      ? and(eq(objectives.profileDomainId, domainId), inArray(objectives.goalId, visibleGoalIds))
      : eq(objectives.profileDomainId, domainId);
    const rows = await db
      .select()
      .from(objectives)
      .where(where)
      .orderBy(asc(objectives.sequenceOrder));
    return hydrateRecords("objectives", rows);
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

  async getServiceById(id: string, ctx?: AccessCtx): Promise<Service | undefined> {
    const where = ctx
      ? and(eq(services.id, id), withInheritedVisibility(services.programId, programs, ctx, "program"))
      : eq(services.id, id);
    const [service] = await db
      .select()
      .from(services)
      .where(where);
    if (!service) return undefined;
    const [hydrated] = await hydrateRecords("services", [service]);
    return hydrated;
  }

  async getServicesByProgramId(programId: string, ctx?: AccessCtx): Promise<Service[]> {
    const where = ctx
      ? and(
          eq(services.programId, programId),
          withInheritedVisibility(services.programId, programs, ctx, "program"),
        )
      : eq(services.programId, programId);
    const rows = await db
      .select()
      .from(services)
      .where(where);
    return hydrateRecords("services", rows);
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

  // -------- Service ↔ Users --------

  async getServiceUsers(serviceId: string): Promise<ServiceUser[]> {
    return db
      .select()
      .from(serviceUsers)
      .where(eq(serviceUsers.serviceId, serviceId));
  }

  async linkUserToService(serviceId: string, userId: string): Promise<ServiceUser> {
    // Idempotent: if already linked, return existing row
    const [existing] = await db
      .select()
      .from(serviceUsers)
      .where(
        and(eq(serviceUsers.serviceId, serviceId), eq(serviceUsers.userId, userId))
      );
    if (existing) return existing;

    const [row] = await db
      .insert(serviceUsers)
      .values({ serviceId, userId })
      .returning();
    return row;
  }

  async unlinkUserFromService(serviceId: string, userId: string): Promise<void> {
    await db
      .delete(serviceUsers)
      .where(
        and(eq(serviceUsers.serviceId, serviceId), eq(serviceUsers.userId, userId))
      );
  }

  /**
   * Look up a studentContacts row by id — used by calendarService when expanding
   * a service's providerContactId into its linked user (if any).
   */
  async getStudentContactById(contactId: string) {
    const [row] = await db
      .select()
      .from(studentContacts)
      .where(eq(studentContacts.id, contactId));
    return row;
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

  async getAccommodationsByServiceId(serviceId: string, ctx?: AccessCtx): Promise<Accommodation[]> {
    const visibleServiceIds = ctx
      ? db.select({ id: services.id }).from(services).where(
          withInheritedVisibility(services.programId, programs, ctx, "program"),
        )
      : null;
    const where = visibleServiceIds
      ? and(eq(accommodations.serviceId, serviceId), inArray(accommodations.serviceId, visibleServiceIds))
      : eq(accommodations.serviceId, serviceId);
    const rows = await db
      .select()
      .from(accommodations)
      .where(where);
    return hydrateRecords("accommodations", rows);
  }

  async getAccommodationsByProgramId(programId: string, ctx?: AccessCtx): Promise<Accommodation[]> {
    const where = ctx
      ? and(
          eq(accommodations.programId, programId),
          withInheritedVisibility(accommodations.programId, programs, ctx, "program"),
        )
      : eq(accommodations.programId, programId);
    const rows = await db
      .select()
      .from(accommodations)
      .where(where);
    return hydrateRecords("accommodations", rows);
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
  // PROGRESS REPORT OPERATIONS
  // ==========================================================================

  async createProgressReport(insert: InsertProgressReport): Promise<ProgressReport> {
    const [report] = await db
      .insert(progressReports)
      .values(insert)
      .returning();
    return report;
  }

  async getProgressReportById(id: string, ctx?: AccessCtx): Promise<ProgressReport | undefined> {
    const where = ctx
      ? and(eq(progressReports.id, id), withInheritedVisibility(progressReports.programId, programs, ctx, "program"))
      : eq(progressReports.id, id);
    const [report] = await db
      .select()
      .from(progressReports)
      .where(where);
    if (!report) return undefined;
    const [hydrated] = await hydrateRecords("progress_reports", [report]);
    return hydrated;
  }

  async getProgressReportsByProgramId(programId: string, ctx?: AccessCtx): Promise<ProgressReport[]> {
    const where = ctx
      ? and(
          eq(progressReports.programId, programId),
          withInheritedVisibility(progressReports.programId, programs, ctx, "program"),
        )
      : eq(progressReports.programId, programId);
    const rows = await db
      .select()
      .from(progressReports)
      .where(where)
      .orderBy(desc(progressReports.reportDate));
    return hydrateRecords("progress_reports", rows);
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

  async getGoalProgressEntriesByReportId(reportId: string, ctx?: AccessCtx): Promise<GoalProgressEntry[]> {
    const visibleGoalIds = ctx
      ? db.select({ id: goals.id }).from(goals).where(
          withInheritedVisibility(goals.programId, programs, ctx, "program"),
        )
      : null;
    const where = visibleGoalIds
      ? and(eq(goalProgressEntries.progressReportId, reportId), inArray(goalProgressEntries.goalId, visibleGoalIds))
      : eq(goalProgressEntries.progressReportId, reportId);
    const rows = await db
      .select()
      .from(goalProgressEntries)
      .where(where);
    return hydrateRecords("goal_progress_entries", rows);
  }

  async getGoalProgressEntriesByGoalId(goalId: string, ctx?: AccessCtx): Promise<GoalProgressEntry[]> {
    const visibleGoalIds = ctx
      ? db.select({ id: goals.id }).from(goals).where(
          withInheritedVisibility(goals.programId, programs, ctx, "program"),
        )
      : null;
    const where = visibleGoalIds
      ? and(eq(goalProgressEntries.goalId, goalId), inArray(goalProgressEntries.goalId, visibleGoalIds))
      : eq(goalProgressEntries.goalId, goalId);
    const rows = await db
      .select()
      .from(goalProgressEntries)
      .where(where)
      .orderBy(desc(goalProgressEntries.createdAt));
    return hydrateRecords("goal_progress_entries", rows);
  }

  async getLatestGoalProgressEntryByGoalId(goalId: string, ctx?: AccessCtx): Promise<GoalProgressEntry | undefined> {
    const visibleGoalIds = ctx
      ? db.select({ id: goals.id }).from(goals).where(
          withInheritedVisibility(goals.programId, programs, ctx, "program"),
        )
      : null;
    const where = visibleGoalIds
      ? and(eq(goalProgressEntries.goalId, goalId), inArray(goalProgressEntries.goalId, visibleGoalIds))
      : eq(goalProgressEntries.goalId, goalId);
    const [entry] = await db
      .select()
      .from(goalProgressEntries)
      .where(where)
      .orderBy(desc(goalProgressEntries.createdAt))
      .limit(1);
    if (!entry) return undefined;
    const [hydrated] = await hydrateRecords("goal_progress_entries", [entry]);
    return hydrated;
  }

  // ==========================================================================
  // DATA POINT OPERATIONS
  // ==========================================================================

  async createDataPoint(insert: InsertDataPoint): Promise<DataPoint> {
    const [point] = await db
      .insert(dataPoints)
      .values(insert)
      .returning();
    return point;
  }

  async getDataPointsByGoalId(goalId: string, ctx?: AccessCtx): Promise<DataPoint[]> {
    const visibleGoalIds = ctx
      ? db.select({ id: goals.id }).from(goals).where(
          withInheritedVisibility(goals.programId, programs, ctx, "program"),
        )
      : null;
    const where = visibleGoalIds
      ? and(eq(dataPoints.goalId, goalId), inArray(dataPoints.goalId, visibleGoalIds))
      : eq(dataPoints.goalId, goalId);
    const rows = await db
      .select()
      .from(dataPoints)
      .where(where)
      .orderBy(desc(dataPoints.recordedAt));
    return hydrateRecords("data_points", rows);
  }

  async getDataPointsByObjectiveId(objectiveId: string, ctx?: AccessCtx): Promise<DataPoint[]> {
    const visibleObjectiveIds = ctx
      ? db.select({ id: objectives.id }).from(objectives).where(
          inArray(objectives.goalId,
            db.select({ id: goals.id }).from(goals).where(
              withInheritedVisibility(goals.programId, programs, ctx, "program"),
            ),
          ),
        )
      : null;
    const where = visibleObjectiveIds
      ? and(eq(dataPoints.objectiveId, objectiveId), inArray(dataPoints.objectiveId, visibleObjectiveIds))
      : eq(dataPoints.objectiveId, objectiveId);
    const rows = await db
      .select()
      .from(dataPoints)
      .where(where)
      .orderBy(desc(dataPoints.recordedAt));
    return hydrateRecords("data_points", rows);
  }

  async deleteDataPoint(id: string): Promise<boolean> {
    const result = await db
      .delete(dataPoints)
      .where(eq(dataPoints.id, id));
    return (result.rowCount ?? 0) > 0;
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

  async getTransitionPlanById(id: string, ctx?: AccessCtx): Promise<TransitionPlan | undefined> {
    const where = ctx
      ? and(eq(transitionPlans.id, id), withInheritedVisibility(transitionPlans.programId, programs, ctx, "program"))
      : eq(transitionPlans.id, id);
    const [plan] = await db
      .select()
      .from(transitionPlans)
      .where(where);
    if (!plan) return undefined;
    const [hydrated] = await hydrateRecords("transition_plans", [plan]);
    return hydrated;
  }

  async getTransitionPlanByProgramId(programId: string, ctx?: AccessCtx): Promise<TransitionPlan | undefined> {
    const where = ctx
      ? and(
          eq(transitionPlans.programId, programId),
          withInheritedVisibility(transitionPlans.programId, programs, ctx, "program"),
        )
      : eq(transitionPlans.programId, programId);
    const [plan] = await db
      .select()
      .from(transitionPlans)
      .where(where);
    if (!plan) return undefined;
    const [hydrated] = await hydrateRecords("transition_plans", [plan]);
    return hydrated;
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

  async getTransitionGoalsByPlanId(planId: string, ctx?: AccessCtx): Promise<TransitionGoal[]> {
    const visiblePlanIds = ctx
      ? db.select({ id: transitionPlans.id }).from(transitionPlans).where(
          withInheritedVisibility(transitionPlans.programId, programs, ctx, "program"),
        )
      : null;
    const where = visiblePlanIds
      ? and(eq(transitionGoals.transitionPlanId, planId), inArray(transitionGoals.transitionPlanId, visiblePlanIds))
      : eq(transitionGoals.transitionPlanId, planId);
    const rows = await db
      .select()
      .from(transitionGoals)
      .where(where);
    return hydrateRecords("transition_goals", rows);
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
  // PROGRAM CONTACT OPERATIONS (junction: program ↔ studentContacts)
  // ==========================================================================

  async addProgramContact(insert: InsertProgramContact): Promise<ProgramContact> {
    const [row] = await db.insert(programContacts).values(insert).returning();
    return row;
  }

  async getProgramContactById(id: string, ctx?: AccessCtx): Promise<ProgramContact | undefined> {
    const where = ctx
      ? and(eq(programContacts.id, id), withInheritedVisibility(programContacts.programId, programs, ctx, "program"))
      : eq(programContacts.id, id);
    const [row] = await db
      .select()
      .from(programContacts)
      .where(where);
    return row;
  }

  /** Get all program contacts for a program with their contact row joined in. */
  async getTeamContactsByProgramId(
    programId: string,
    ctx?: AccessCtx,
  ): Promise<(ProgramContact & { contact: StudentContact })[]> {
    const where = ctx
      ? and(
          eq(programContacts.programId, programId),
          eq(programContacts.isActive, true),
          withInheritedVisibility(programContacts.programId, programs, ctx, "program"),
        )
      : and(
          eq(programContacts.programId, programId),
          eq(programContacts.isActive, true),
        );
    const rows = await db
      .select({
        junction: programContacts,
        contact: studentContacts,
      })
      .from(programContacts)
      .innerJoin(studentContacts, eq(studentContacts.id, programContacts.contactId))
      .where(where);
    return rows.map((r) => ({ ...r.junction, contact: r.contact }));
  }

  async updateProgramContact(
    id: string,
    updates: UpdateProgramContact,
  ): Promise<ProgramContact | undefined> {
    const [row] = await db
      .update(programContacts)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(programContacts.id, id))
      .returning();
    return row;
  }

  async removeProgramContact(id: string): Promise<boolean> {
    const [row] = await db
      .update(programContacts)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(programContacts.id, id))
      .returning();
    return !!row;
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

  async getMeetingById(id: string, ctx?: AccessCtx): Promise<Meeting | undefined> {
    const where = ctx
      ? and(eq(meetings.id, id), withInheritedVisibility(meetings.programId, programs, ctx, "program"))
      : eq(meetings.id, id);
    const [meeting] = await db
      .select()
      .from(meetings)
      .where(where);
    if (!meeting) return undefined;
    const [hydrated] = await hydrateRecords("meetings", [meeting]);
    return hydrated;
  }

  async getMeetingsByProgramId(programId: string, ctx?: AccessCtx): Promise<Meeting[]> {
    const where = ctx
      ? and(
          eq(meetings.programId, programId),
          withInheritedVisibility(meetings.programId, programs, ctx, "program"),
        )
      : eq(meetings.programId, programId);
    const rows = await db
      .select()
      .from(meetings)
      .where(where)
      .orderBy(desc(meetings.scheduledDate));
    return hydrateRecords("meetings", rows);
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

  async getConsentFormById(id: string, ctx?: AccessCtx): Promise<ConsentForm | undefined> {
    const where = ctx
      ? and(eq(consentForms.id, id), withInheritedVisibility(consentForms.programId, programs, ctx, "program"))
      : eq(consentForms.id, id);
    const [form] = await db
      .select()
      .from(consentForms)
      .where(where);
    if (!form) return undefined;
    const [hydrated] = await hydrateRecords("consent_forms", [form]);
    return hydrated;
  }

  async getConsentFormsByProgramId(programId: string, ctx?: AccessCtx): Promise<ConsentForm[]> {
    const where = ctx
      ? and(
          eq(consentForms.programId, programId),
          withInheritedVisibility(consentForms.programId, programs, ctx, "program"),
        )
      : eq(consentForms.programId, programId);
    const rows = await db
      .select()
      .from(consentForms)
      .where(where);
    return hydrateRecords("consent_forms", rows);
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
  // USER-GOAL OPERATIONS (Many-to-Many)
  // ==========================================================================

  async assignUserToGoal(insert: InsertUserGoal): Promise<UserGoal> {
    const [userGoal] = await db
      .insert(userGoals)
      .values(insert)
      .returning();
    return userGoal;
  }

  async getUserGoalById(id: string): Promise<UserGoal | undefined> {
    const [userGoal] = await db
      .select()
      .from(userGoals)
      .where(eq(userGoals.id, id));
    if (!userGoal) return undefined;
    const [hydrated] = await hydrateRecords("user_goals", [userGoal]);
    return hydrated;
  }

  async getUserGoalsByGoalId(goalId: string): Promise<UserGoal[]> {
    const rows = await db
      .select()
      .from(userGoals)
      .where(eq(userGoals.goalId, goalId));
    return hydrateRecords("user_goals", rows);
  }

  async getUserGoalsByUserId(userId: string): Promise<UserGoal[]> {
    const rows = await db
      .select()
      .from(userGoals)
      .where(eq(userGoals.userId, userId));
    return hydrateRecords("user_goals", rows);
  }

  async getGoalsForUser(userId: string): Promise<Goal[]> {
    const userGoalLinks = await this.getUserGoalsByUserId(userId);
    const goalIds = userGoalLinks.map(ug => ug.goalId);

    if (goalIds.length === 0) return [];

    const rows = await db
      .select()
      .from(goals)
      .where(inArray(goals.id, goalIds))
      .orderBy(asc(goals.sortOrder));
    return hydrateRecords("goals", rows);
  }

  async updateUserGoal(id: string, updates: UpdateUserGoal): Promise<UserGoal | undefined> {
    const [updated] = await db
      .update(userGoals)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(userGoals.id, id))
      .returning();
    return updated || undefined;
  }

  async removeUserFromGoal(userId: string, goalId: string): Promise<boolean> {
    const result = await db
      .delete(userGoals)
      .where(
        and(
          eq(userGoals.userId, userId),
          eq(userGoals.goalId, goalId)
        )
      );
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // USER-OBJECTIVE OPERATIONS (Many-to-Many)
  // ==========================================================================

  async assignUserToObjective(insert: InsertUserObjective): Promise<UserObjective> {
    const [userObjective] = await db
      .insert(userObjectives)
      .values(insert)
      .returning();
    return userObjective;
  }

  async getUserObjectiveById(id: string): Promise<UserObjective | undefined> {
    const [userObjective] = await db
      .select()
      .from(userObjectives)
      .where(eq(userObjectives.id, id));
    if (!userObjective) return undefined;
    const [hydrated] = await hydrateRecords("user_objectives", [userObjective]);
    return hydrated;
  }

  async getUserObjectivesByObjectiveId(objectiveId: string): Promise<UserObjective[]> {
    const rows = await db
      .select()
      .from(userObjectives)
      .where(eq(userObjectives.objectiveId, objectiveId));
    return hydrateRecords("user_objectives", rows);
  }

  async getUserObjectivesByUserId(userId: string): Promise<UserObjective[]> {
    const rows = await db
      .select()
      .from(userObjectives)
      .where(eq(userObjectives.userId, userId));
    return hydrateRecords("user_objectives", rows);
  }

  async getObjectivesForUser(userId: string): Promise<Objective[]> {
    const userObjectiveLinks = await this.getUserObjectivesByUserId(userId);
    const objectiveIds = userObjectiveLinks.map(uo => uo.objectiveId);

    if (objectiveIds.length === 0) return [];

    const rows = await db
      .select()
      .from(objectives)
      .where(inArray(objectives.id, objectiveIds))
      .orderBy(asc(objectives.sequenceOrder));
    return hydrateRecords("objectives", rows);
  }

  async updateUserObjective(id: string, updates: UpdateUserObjective): Promise<UserObjective | undefined> {
    const [updated] = await db
      .update(userObjectives)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(userObjectives.id, id))
      .returning();
    return updated || undefined;
  }

  async removeUserFromObjective(userId: string, objectiveId: string): Promise<boolean> {
    const result = await db
      .delete(userObjectives)
      .where(
        and(
          eq(userObjectives.userId, userId),
          eq(userObjectives.objectiveId, objectiveId)
        )
      );
    return (result.rowCount ?? 0) > 0;
  }

  // ==========================================================================
  // AGGREGATE QUERIES
  // ==========================================================================

  /**
   * Calculate overall progress for a program based on goal progress values
   */
  async calculateProgramProgress(programId: string): Promise<number> {
    const programGoals = await this.getGoalsByProgramId(programId);
    if (programGoals.length === 0) return 0;

    // Use the progress field instead of status
    const totalProgress = programGoals.reduce((sum, g) => sum + (g.progress ?? 0), 0);
    return Math.round(totalProgress / programGoals.length);
  }

  /**
   * Get programs with upcoming deadlines
   */
  async getProgramsWithUpcomingDeadlines(daysAhead: number = 30): Promise<Program[]> {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + daysAhead);

    const rows = await db
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
    return hydrateRecords("programs", rows);
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

  /**
   * Get average progress for goals in a program
   */
  async getAverageGoalProgress(programId: string): Promise<number> {
    const [result] = await db
      .select({
        avgProgress: sql<number>`coalesce(avg(${goals.progress}), 0)`,
      })
      .from(goals)
      .where(eq(goals.programId, programId));

    return Math.round(result?.avgProgress ?? 0);
  }
}

export const programRepository = new ProgramRepository();