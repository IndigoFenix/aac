/**
 * progress-memory-schema.ts
 * 
 * Memory field schema and database operations for IEP/TALA program management.
 * Used when sessionService mode is "progress".
 * 
 * This file defines:
 * 1. Memory field definitions for the program structure
 * 2. Database operations using programRepository
 * 3. System prompt for the progress tracking AI
 * 
 * Structure:
 * - Context_Program (object) - the current active program
 *   - profileDomains (map) - keyed by {shortId}_{domainType}
 *     - baselineMeasurements (array)
 *     - assessmentSources (array)
 *   - goals (map) - keyed by {shortId}_{goalStatement}
 *     - objectives (array)
 *     - dataPoints (array)
 *   - services (map) - keyed by {shortId}_{serviceType}
 *     - accommodations (array)
 *   - teamMembers (map) - keyed by {shortId}_{name}
 *   - meetings (map) - keyed by {shortId}_{meetingType}
 *   - consentForms (map) - keyed by {shortId}_{consentType}
 *   - progressReports (map) - keyed by {shortId}_{date}
 *     - entries (array)
 *   - transitionPlan (object)
 *     - goals (array)
 */

import { eq, and, asc, desc, sql } from "drizzle-orm";
import { db } from "../db";
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
  type Program,
  type ProfileDomain,
  type BaselineMeasurement,
  type AssessmentSource,
  type Goal,
  type Objective,
  type Service,
  type Accommodation,
  type ProgressReport,
  type GoalProgressEntry,
  type DataPoint,
  type TransitionPlan,
  type TransitionGoal,
  type TeamMember,
  type Meeting,
  type ConsentForm,
  type AgentMemoryField,
} from "@shared/schema";

import {
  type AgentMemoryFieldWithDB,
  type AgentMemoryFieldObjectWithDB,
  type AgentMemoryFieldArrayWithDB,
  type AgentMemoryFieldMapWithDB,
  type MemoryDBOperations,
  type DBOperationContext,
  type PaginationParams,
  type ListResult,
} from "./chat/memory-db-bridge";

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Transform database record to memory value, removing internal fields
 */
function toMemoryValue<T extends Record<string, any>>(
  record: T,
  excludeFields: string[] = ["createdAt", "updatedAt"]
): Omit<T, "createdAt" | "updatedAt"> {
  const result = { ...record };
  for (const field of excludeFields) {
    delete (result as any)[field];
  }
  return result;
}

/**
 * Get count for pagination
 */
async function getCount(table: any, whereClause: any): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)` })
    .from(table)
    .where(whereClause);
  return Number(result?.count ?? 0);
}

// ============================================================================
// MAP KEY HELPERS
// ============================================================================

/**
 * Creates a short ID from a UUID (first 8 characters)
 */
function shortId(uuid: string | null | undefined): string {
  return uuid?.slice(0, 8) || 'unknown';
}

/**
 * Sanitizes a string for use as part of a map key.
 * Replaces spaces with underscores, removes special chars, truncates.
 */
function sanitizeForKey(str: string | null | undefined, maxLen: number = 20): string {
  if (!str) return 'unnamed';
  return str
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, maxLen)
    .replace(/_+$/, '')
    .toLowerCase() || 'unnamed';
}

/** TeamMember key: {shortId}_{name} → "ba1e0ce7_frank_smith" */
function teamMemberKey(m: { id: string; name: string }): string {
  return `${shortId(m.id)}_${sanitizeForKey(m.name)}`;
}

/** Goal key: {shortId}_{first_words} → "abc12345_student_will_use" */
function goalKey(g: { id: string; goalStatement: string }): string {
  return `${shortId(g.id)}_${sanitizeForKey(g.goalStatement, 25)}`;
}

/** Service key: {shortId}_{serviceType} → "def67890_speech_language" */
function serviceKey(s: { id: string; serviceType: string }): string {
  return `${shortId(s.id)}_${sanitizeForKey(s.serviceType)}`;
}

/** Meeting key: {shortId}_{meetingType} → "111aaabb_annual_review" */
function meetingKey(m: { id: string; meetingType: string }): string {
  return `${shortId(m.id)}_${sanitizeForKey(m.meetingType)}`;
}

/** ProfileDomain key: {shortId}_{domainType} → "222bbbcc_communication" */
function profileDomainKey(d: { id: string; domainType: string }): string {
  return `${shortId(d.id)}_${sanitizeForKey(d.domainType)}`;
}

/** ConsentForm key: {shortId}_{consentType} → "333cccdd_initial_eval" */
function consentFormKey(c: { id: string; consentType: string }): string {
  return `${shortId(c.id)}_${sanitizeForKey(c.consentType)}`;
}

/** ProgressReport key: {shortId}_{date} → "444dddee_2025_03_15" */
function progressReportKey(r: { id: string; reportDate: string | null }): string {
  const dateStr = r.reportDate?.slice(0, 10).replace(/-/g, '_') || 'undated';
  return `${shortId(r.id)}_${dateStr}`;
}

/**
 * Find item by map key (extracts short ID prefix and matches)
 */
async function findByMapKey<T extends { id: string }>(
  table: any,
  idColumn: any,
  additionalWhere: any,
  key: string
): Promise<T | undefined> {
  const idPrefix = key.split('_')[0];
  
  const items = await db
    .select()
    .from(table)
    .where(and(
      additionalWhere,
      sql`${idColumn}::text LIKE ${idPrefix + '%'}`
    ))
    .limit(1);

  return items[0] as T | undefined;
}

// ============================================================================
// DATABASE OPERATIONS
// ============================================================================

/**
 * Program operations - reads the current program for a student
 */
const programOps: MemoryDBOperations<Program> = {
  read: async (ctx) => {
    const studentId = ctx.all.studentId;
    if (!studentId) throw new Error("studentId required for program query");

    // Get current/working program (active or draft)
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

    if (activeProgram) return activeProgram;

    // Fall back to draft
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

    return draftProgram;
  },

  write: async (ctx, value) => {
    const studentId = ctx.all.studentId;
    if (!studentId) throw new Error("studentId required for program write");

    if (value.id) {
      // Update existing
      await db
        .update(programs)
        .set({ ...value, updatedAt: new Date() })
        .where(eq(programs.id, value.id));
    } else {
      // Create new
      await db.insert(programs).values({
        ...value,
        studentId,
      });
    }
  },

  fromDB: (record) => toMemoryValue(record),

  extractChildContext: (value) => ({
    programId: value.id,
  }),

  getDBKey: (value) => value.id,
};

/**
 * Profile domains operations (MAP)
 */
const profileDomainsOps: MemoryDBOperations<ProfileDomain> = {
  list: async (ctx, { offset, limit }) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required for profileDomains query");

    const items = await db
      .select()
      .from(profileDomains)
      .where(eq(profileDomains.programId, programId))
      .orderBy(asc(profileDomains.sortOrder))
      .offset(offset)
      .limit(limit);

    const total = await getCount(profileDomains, eq(profileDomains.programId, programId));

    // Generate map keys
    const keys = items.map(item => profileDomainKey(item));

    return { items, total, keys };
  },

  add: async (ctx, value) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required for creating profileDomain");

    const [created] = await db
      .insert(profileDomains)
      .values({ ...value, programId })
      .returning();

    return created;
  },

  update: async (ctx, key, value) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required");

    const domain = await findByMapKey<ProfileDomain>(
      profileDomains,
      profileDomains.id,
      eq(profileDomains.programId, programId),
      String(key)
    );
    
    if (!domain) throw new Error(`ProfileDomain with key ${key} not found`);

    const [updated] = await db
      .update(profileDomains)
      .set({ ...value, updatedAt: new Date() })
      .where(eq(profileDomains.id, domain.id))
      .returning();

    return updated;
  },

  delete: async (ctx, key) => {
    const programId = ctx.all.programId;
    if (!programId) return;

    const domain = await findByMapKey<ProfileDomain>(
      profileDomains,
      profileDomains.id,
      eq(profileDomains.programId, programId),
      String(key)
    );
    
    if (domain) {
      await db.delete(profileDomains).where(eq(profileDomains.id, domain.id));
    }
  },

  fromDB: (record) => toMemoryValue(record),

  extractChildContext: (value) => ({
    profileDomainId: value.id,
  }),

  getDBKey: (value) => profileDomainKey(value),
};

/**
 * Baseline measurements operations (nested array under profileDomain)
 */
const baselineMeasurementsOps: MemoryDBOperations<BaselineMeasurement> = {
  list: async (ctx, { offset, limit }) => {
    const profileDomainId = ctx.all.profileDomainId;
    if (!profileDomainId) throw new Error("profileDomainId required for baselineMeasurements query");

    const items = await db
      .select()
      .from(baselineMeasurements)
      .where(eq(baselineMeasurements.profileDomainId, profileDomainId))
      .offset(offset)
      .limit(limit);

    const total = await getCount(baselineMeasurements, eq(baselineMeasurements.profileDomainId, profileDomainId));

    return { items, total };
  },

  add: async (ctx, value) => {
    const profileDomainId = ctx.all.profileDomainId;
    if (!profileDomainId) throw new Error("profileDomainId required for creating baselineMeasurement");

    const [created] = await db
      .insert(baselineMeasurements)
      .values({ ...value, profileDomainId })
      .returning();

    return created;
  },

  delete: async (ctx, key) => {
    const items = await db
      .select()
      .from(baselineMeasurements)
      .where(eq(baselineMeasurements.profileDomainId, ctx.all.profileDomainId!))
      .offset(Number(key))
      .limit(1);

    if (items[0]) {
      await db.delete(baselineMeasurements).where(eq(baselineMeasurements.id, items[0].id));
    }
  },

  fromDB: (record) => toMemoryValue(record),
  getDBKey: (value) => value.id,
};

/**
 * Assessment sources operations (nested array under profileDomain)
 */
const assessmentSourcesOps: MemoryDBOperations<AssessmentSource> = {
  list: async (ctx, { offset, limit }) => {
    const profileDomainId = ctx.all.profileDomainId;
    if (!profileDomainId) throw new Error("profileDomainId required for assessmentSources query");

    const items = await db
      .select()
      .from(assessmentSources)
      .where(eq(assessmentSources.profileDomainId, profileDomainId))
      .offset(offset)
      .limit(limit);

    const total = await getCount(assessmentSources, eq(assessmentSources.profileDomainId, profileDomainId));

    return { items, total };
  },

  add: async (ctx, value) => {
    const profileDomainId = ctx.all.profileDomainId;
    if (!profileDomainId) throw new Error("profileDomainId required for creating assessmentSource");

    const [created] = await db
      .insert(assessmentSources)
      .values({ ...value, profileDomainId })
      .returning();

    return created;
  },

  delete: async (ctx, key) => {
    const items = await db
      .select()
      .from(assessmentSources)
      .where(eq(assessmentSources.profileDomainId, ctx.all.profileDomainId!))
      .offset(Number(key))
      .limit(1);

    if (items[0]) {
      await db.delete(assessmentSources).where(eq(assessmentSources.id, items[0].id));
    }
  },

  fromDB: (record) => toMemoryValue(record),
  getDBKey: (value) => value.id,
};

/**
 * Goals operations (MAP)
 */
const goalsOps: MemoryDBOperations<Goal> = {
  list: async (ctx, { offset, limit }) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required for goals query");

    const items = await db
      .select()
      .from(goals)
      .where(eq(goals.programId, programId))
      .orderBy(asc(goals.sortOrder))
      .offset(offset)
      .limit(limit);

    const total = await getCount(goals, eq(goals.programId, programId));

    // Generate map keys
    const keys = items.map(item => goalKey(item));

    return { items, total, keys };
  },

  add: async (ctx, value) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required for creating goal");

    // Get next sort order
    const [maxOrder] = await db
      .select({ max: sql<number>`coalesce(max(sort_order), -1)` })
      .from(goals)
      .where(eq(goals.programId, programId));

    const [created] = await db
      .insert(goals)
      .values({
        ...value,
        programId,
        sortOrder: (maxOrder?.max ?? -1) + 1,
      })
      .returning();

    return created;
  },

  update: async (ctx, key, value) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required");

    const goal = await findByMapKey<Goal>(
      goals,
      goals.id,
      eq(goals.programId, programId),
      String(key)
    );
    
    if (!goal) throw new Error(`Goal with key ${key} not found`);

    const [updated] = await db
      .update(goals)
      .set({ ...value, updatedAt: new Date() })
      .where(eq(goals.id, goal.id))
      .returning();

    return updated;
  },

  delete: async (ctx, key) => {
    const programId = ctx.all.programId;
    if (!programId) return;

    const goal = await findByMapKey<Goal>(
      goals,
      goals.id,
      eq(goals.programId, programId),
      String(key)
    );
    
    if (goal) {
      await db.delete(goals).where(eq(goals.id, goal.id));
    }
  },

  fromDB: (record) => toMemoryValue(record),

  extractChildContext: (value) => ({
    goalId: value.id,
  }),

  getDBKey: (value) => goalKey(value),
};

/**
 * Objectives operations (nested array under goal)
 */
const objectivesOps: MemoryDBOperations<Objective> = {
  list: async (ctx, { offset, limit }) => {
    const goalId = ctx.all.goalId;
    if (!goalId) throw new Error("goalId required for objectives query");

    const items = await db
      .select()
      .from(objectives)
      .where(eq(objectives.goalId, goalId))
      .orderBy(asc(objectives.sequenceOrder))
      .offset(offset)
      .limit(limit);

    const total = await getCount(objectives, eq(objectives.goalId, goalId));

    return { items, total };
  },

  add: async (ctx, value) => {
    const goalId = ctx.all.goalId;
    if (!goalId) throw new Error("goalId required for creating objective");

    // Get next sequence order
    const [maxOrder] = await db
      .select({ max: sql<number>`coalesce(max(sequence_order), 0)` })
      .from(objectives)
      .where(eq(objectives.goalId, goalId));

    const [created] = await db
      .insert(objectives)
      .values({
        ...value,
        goalId,
        sequenceOrder: (maxOrder?.max ?? 0) + 1,
      })
      .returning();

    return created;
  },

  update: async (ctx, key, value) => {
    const items = await db
      .select()
      .from(objectives)
      .where(eq(objectives.goalId, ctx.all.goalId!))
      .orderBy(asc(objectives.sequenceOrder))
      .offset(Number(key))
      .limit(1);

    if (!items[0]) throw new Error(`Objective at index ${key} not found`);

    const [updated] = await db
      .update(objectives)
      .set({ ...value, updatedAt: new Date() })
      .where(eq(objectives.id, items[0].id))
      .returning();

    return updated;
  },

  delete: async (ctx, key) => {
    const items = await db
      .select()
      .from(objectives)
      .where(eq(objectives.goalId, ctx.all.goalId!))
      .orderBy(asc(objectives.sequenceOrder))
      .offset(Number(key))
      .limit(1);

    if (items[0]) {
      await db.delete(objectives).where(eq(objectives.id, items[0].id));
    }
  },

  fromDB: (record) => toMemoryValue(record),

  extractChildContext: (value) => ({
    objectiveId: value.id,
  }),

  getDBKey: (value) => value.id,
};

/**
 * Data points operations (nested array under goal or objective)
 */
const dataPointsOps: MemoryDBOperations<DataPoint> = {
  list: async (ctx, { offset, limit }) => {
    const goalId = ctx.all.goalId;
    const objectiveId = ctx.all.objectiveId;

    let whereClause;
    if (objectiveId) {
      whereClause = eq(dataPoints.objectiveId, objectiveId);
    } else if (goalId) {
      whereClause = eq(dataPoints.goalId, goalId);
    } else {
      throw new Error("goalId or objectiveId required for dataPoints query");
    }

    const items = await db
      .select()
      .from(dataPoints)
      .where(whereClause)
      .orderBy(desc(dataPoints.recordedAt))
      .offset(offset)
      .limit(limit);

    const total = await getCount(dataPoints, whereClause);

    return { items, total };
  },

  add: async (ctx, value) => {
    const goalId = ctx.all.goalId;
    const objectiveId = ctx.all.objectiveId;

    if (!goalId && !objectiveId) {
      throw new Error("goalId or objectiveId required for creating dataPoint");
    }

    const [created] = await db
      .insert(dataPoints)
      .values({
        ...value,
        goalId: goalId || undefined,
        objectiveId: objectiveId || undefined,
        recordedAt: value.recordedAt || new Date(),
      })
      .returning();

    return created;
  },

  delete: async (ctx, key) => {
    const goalId = ctx.all.goalId;
    const objectiveId = ctx.all.objectiveId;

    const whereClause = objectiveId
      ? eq(dataPoints.objectiveId, objectiveId)
      : eq(dataPoints.goalId, goalId!);

    const items = await db
      .select()
      .from(dataPoints)
      .where(whereClause)
      .orderBy(desc(dataPoints.recordedAt))
      .offset(Number(key))
      .limit(1);

    if (items[0]) {
      await db.delete(dataPoints).where(eq(dataPoints.id, items[0].id));
    }
  },

  fromDB: (record) => toMemoryValue(record),
  getDBKey: (value) => value.id,
};

/**
 * Services operations (MAP)
 */
const servicesOps: MemoryDBOperations<Service> = {
  list: async (ctx, { offset, limit }) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required for services query");

    const items = await db
      .select()
      .from(services)
      .where(eq(services.programId, programId))
      .offset(offset)
      .limit(limit);

    const total = await getCount(services, eq(services.programId, programId));

    // Generate map keys
    const keys = items.map(item => serviceKey(item));

    return { items, total, keys };
  },

  add: async (ctx, value) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required for creating service");

    const [created] = await db
      .insert(services)
      .values({ ...value, programId })
      .returning();

    return created;
  },

  update: async (ctx, key, value) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required");

    const service = await findByMapKey<Service>(
      services,
      services.id,
      eq(services.programId, programId),
      String(key)
    );
    
    if (!service) throw new Error(`Service with key ${key} not found`);

    const [updated] = await db
      .update(services)
      .set({ ...value, updatedAt: new Date() })
      .where(eq(services.id, service.id))
      .returning();

    return updated;
  },

  delete: async (ctx, key) => {
    const programId = ctx.all.programId;
    if (!programId) return;

    const service = await findByMapKey<Service>(
      services,
      services.id,
      eq(services.programId, programId),
      String(key)
    );
    
    if (service) {
      await db.delete(services).where(eq(services.id, service.id));
    }
  },

  fromDB: (record) => toMemoryValue(record),

  extractChildContext: (value) => ({
    serviceId: value.id,
  }),

  getDBKey: (value) => serviceKey(value),
};

/**
 * Accommodations operations (nested array under service or program-wide)
 */
const accommodationsOps: MemoryDBOperations<Accommodation> = {
  list: async (ctx, { offset, limit }) => {
    const serviceId = ctx.all.serviceId;
    const programId = ctx.all.programId;

    const whereClause = serviceId
      ? eq(accommodations.serviceId, serviceId)
      : eq(accommodations.programId, programId!);

    const items = await db
      .select()
      .from(accommodations)
      .where(whereClause)
      .offset(offset)
      .limit(limit);

    const total = await getCount(accommodations, whereClause);

    return { items, total };
  },

  add: async (ctx, value) => {
    const serviceId = ctx.all.serviceId;
    const programId = ctx.all.programId;

    const [created] = await db
      .insert(accommodations)
      .values({
        ...value,
        serviceId: serviceId || undefined,
        programId: !serviceId ? programId : undefined,
      })
      .returning();

    return created;
  },

  update: async (ctx, key, value) => {
    const serviceId = ctx.all.serviceId;
    const programId = ctx.all.programId;

    const whereClause = serviceId
      ? eq(accommodations.serviceId, serviceId)
      : eq(accommodations.programId, programId!);

    const items = await db
      .select()
      .from(accommodations)
      .where(whereClause)
      .offset(Number(key))
      .limit(1);

    if (!items[0]) throw new Error(`Accommodation at index ${key} not found`);

    const [updated] = await db
      .update(accommodations)
      .set({ ...value, updatedAt: new Date() })
      .where(eq(accommodations.id, items[0].id))
      .returning();

    return updated;
  },

  delete: async (ctx, key) => {
    const serviceId = ctx.all.serviceId;
    const programId = ctx.all.programId;

    const whereClause = serviceId
      ? eq(accommodations.serviceId, serviceId)
      : eq(accommodations.programId, programId!);

    const items = await db
      .select()
      .from(accommodations)
      .where(whereClause)
      .offset(Number(key))
      .limit(1);

    if (items[0]) {
      await db.delete(accommodations).where(eq(accommodations.id, items[0].id));
    }
  },

  fromDB: (record) => toMemoryValue(record),
  getDBKey: (value) => value.id,
};

/**
 * Team members operations (MAP)
 */
const teamMembersOps: MemoryDBOperations<TeamMember> = {
  list: async (ctx, { offset, limit }) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required for teamMembers query");

    const items = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.programId, programId), eq(teamMembers.isActive, true)))
      .offset(offset)
      .limit(limit);

    const total = await getCount(
      teamMembers,
      and(eq(teamMembers.programId, programId), eq(teamMembers.isActive, true))
    );

    // Generate map keys
    const keys = items.map(item => teamMemberKey(item));

    return { items, total, keys };
  },

  add: async (ctx, value) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required for creating teamMember");

    const [created] = await db
      .insert(teamMembers)
      .values({ ...value, programId })
      .returning();

    return created;
  },

  update: async (ctx, key, value) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required");

    const member = await findByMapKey<TeamMember>(
      teamMembers,
      teamMembers.id,
      and(eq(teamMembers.programId, programId), eq(teamMembers.isActive, true)),
      String(key)
    );
    
    if (!member) throw new Error(`TeamMember with key ${key} not found`);

    const [updated] = await db
      .update(teamMembers)
      .set({ ...value, updatedAt: new Date() })
      .where(eq(teamMembers.id, member.id))
      .returning();

    return updated;
  },

  delete: async (ctx, key) => {
    const programId = ctx.all.programId;
    if (!programId) return;

    const member = await findByMapKey<TeamMember>(
      teamMembers,
      teamMembers.id,
      and(eq(teamMembers.programId, programId), eq(teamMembers.isActive, true)),
      String(key)
    );

    if (member) {
      // Soft delete
      await db
        .update(teamMembers)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(teamMembers.id, member.id));
    }
  },

  fromDB: (record) => toMemoryValue(record),
  getDBKey: (value) => teamMemberKey(value),
};

/**
 * Meetings operations (MAP)
 */
const meetingsOps: MemoryDBOperations<Meeting> = {
  list: async (ctx, { offset, limit }) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required for meetings query");

    const items = await db
      .select()
      .from(meetings)
      .where(eq(meetings.programId, programId))
      .orderBy(desc(meetings.scheduledDate))
      .offset(offset)
      .limit(limit);

    const total = await getCount(meetings, eq(meetings.programId, programId));

    // Generate map keys
    const keys = items.map(item => meetingKey(item));

    return { items, total, keys };
  },

  add: async (ctx, value) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required for creating meeting");

    const [created] = await db
      .insert(meetings)
      .values({ ...value, programId })
      .returning();

    return created;
  },

  update: async (ctx, key, value) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required");

    const meeting = await findByMapKey<Meeting>(
      meetings,
      meetings.id,
      eq(meetings.programId, programId),
      String(key)
    );
    
    if (!meeting) throw new Error(`Meeting with key ${key} not found`);

    const [updated] = await db
      .update(meetings)
      .set({ ...value, updatedAt: new Date() })
      .where(eq(meetings.id, meeting.id))
      .returning();

    return updated;
  },

  delete: async (ctx, key) => {
    const programId = ctx.all.programId;
    if (!programId) return;

    const meeting = await findByMapKey<Meeting>(
      meetings,
      meetings.id,
      eq(meetings.programId, programId),
      String(key)
    );

    if (meeting) {
      await db.delete(meetings).where(eq(meetings.id, meeting.id));
    }
  },

  fromDB: (record) => toMemoryValue(record),
  getDBKey: (value) => meetingKey(value),
};

/**
 * Consent forms operations (MAP)
 */
const consentFormsOps: MemoryDBOperations<ConsentForm> = {
  list: async (ctx, { offset, limit }) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required for consentForms query");

    const items = await db
      .select()
      .from(consentForms)
      .where(eq(consentForms.programId, programId))
      .offset(offset)
      .limit(limit);

    const total = await getCount(consentForms, eq(consentForms.programId, programId));

    // Generate map keys
    const keys = items.map(item => consentFormKey(item));

    return { items, total, keys };
  },

  add: async (ctx, value) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required for creating consentForm");

    const [created] = await db
      .insert(consentForms)
      .values({ ...value, programId })
      .returning();

    return created;
  },

  update: async (ctx, key, value) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required");

    const form = await findByMapKey<ConsentForm>(
      consentForms,
      consentForms.id,
      eq(consentForms.programId, programId),
      String(key)
    );
    
    if (!form) throw new Error(`ConsentForm with key ${key} not found`);

    const [updated] = await db
      .update(consentForms)
      .set({ ...value, updatedAt: new Date() })
      .where(eq(consentForms.id, form.id))
      .returning();

    return updated;
  },

  delete: async (ctx, key) => {
    const programId = ctx.all.programId;
    if (!programId) return;

    const form = await findByMapKey<ConsentForm>(
      consentForms,
      consentForms.id,
      eq(consentForms.programId, programId),
      String(key)
    );

    if (form) {
      await db.delete(consentForms).where(eq(consentForms.id, form.id));
    }
  },

  fromDB: (record) => toMemoryValue(record),
  getDBKey: (value) => consentFormKey(value),
};

/**
 * Progress reports operations (MAP)
 */
const progressReportsOps: MemoryDBOperations<ProgressReport> = {
  list: async (ctx, { offset, limit }) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required for progressReports query");

    const items = await db
      .select()
      .from(progressReports)
      .where(eq(progressReports.programId, programId))
      .orderBy(desc(progressReports.reportDate))
      .offset(offset)
      .limit(limit);

    const total = await getCount(progressReports, eq(progressReports.programId, programId));

    // Generate map keys
    const keys = items.map(item => progressReportKey(item));

    return { items, total, keys };
  },

  add: async (ctx, value) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required for creating progressReport");

    const [created] = await db
      .insert(progressReports)
      .values({ ...value, programId })
      .returning();

    return created;
  },

  update: async (ctx, key, value) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required");

    const report = await findByMapKey<ProgressReport>(
      progressReports,
      progressReports.id,
      eq(progressReports.programId, programId),
      String(key)
    );
    
    if (!report) throw new Error(`ProgressReport with key ${key} not found`);

    const [updated] = await db
      .update(progressReports)
      .set({ ...value, updatedAt: new Date() })
      .where(eq(progressReports.id, report.id))
      .returning();

    return updated;
  },

  delete: async (ctx, key) => {
    const programId = ctx.all.programId;
    if (!programId) return;

    const report = await findByMapKey<ProgressReport>(
      progressReports,
      progressReports.id,
      eq(progressReports.programId, programId),
      String(key)
    );

    if (report) {
      await db.delete(progressReports).where(eq(progressReports.id, report.id));
    }
  },

  fromDB: (record) => toMemoryValue(record),

  extractChildContext: (value) => ({
    progressReportId: value.id,
  }),

  getDBKey: (value) => progressReportKey(value),
};

/**
 * Goal progress entries operations (nested array under progressReport)
 */
const goalProgressEntriesOps: MemoryDBOperations<GoalProgressEntry> = {
  list: async (ctx, { offset, limit }) => {
    const progressReportId = ctx.all.progressReportId;
    if (!progressReportId) throw new Error("progressReportId required for goalProgressEntries query");

    const items = await db
      .select()
      .from(goalProgressEntries)
      .where(eq(goalProgressEntries.progressReportId, progressReportId))
      .offset(offset)
      .limit(limit);

    const total = await getCount(goalProgressEntries, eq(goalProgressEntries.progressReportId, progressReportId));

    return { items, total };
  },

  add: async (ctx, value) => {
    const progressReportId = ctx.all.progressReportId;
    if (!progressReportId) throw new Error("progressReportId required for creating goalProgressEntry");

    const [created] = await db
      .insert(goalProgressEntries)
      .values({ ...value, progressReportId })
      .returning();

    return created;
  },

  delete: async (ctx, key) => {
    const progressReportId = ctx.all.progressReportId;
    if (!progressReportId) return;

    const items = await db
      .select()
      .from(goalProgressEntries)
      .where(eq(goalProgressEntries.progressReportId, progressReportId))
      .offset(Number(key))
      .limit(1);

    if (items[0]) {
      await db.delete(goalProgressEntries).where(eq(goalProgressEntries.id, items[0].id));
    }
  },

  fromDB: (record) => toMemoryValue(record),
  getDBKey: (value) => value.id,
};

/**
 * Transition plan operations (one per program)
 */
const transitionPlanOps: MemoryDBOperations<TransitionPlan> = {
  read: async (ctx) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required for transitionPlan query");

    const [plan] = await db
      .select()
      .from(transitionPlans)
      .where(eq(transitionPlans.programId, programId));

    return plan;
  },

  write: async (ctx, value) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required for transitionPlan write");

    if (value.id) {
      await db
        .update(transitionPlans)
        .set({ ...value, updatedAt: new Date() })
        .where(eq(transitionPlans.id, value.id));
    } else {
      await db.insert(transitionPlans).values({ ...value, programId });
    }
  },

  fromDB: (record) => toMemoryValue(record),

  extractChildContext: (value) => ({
    transitionPlanId: value.id,
  }),

  getDBKey: (value) => value.id,
};

/**
 * Transition goals operations (nested array under transitionPlan)
 */
const transitionGoalsOps: MemoryDBOperations<TransitionGoal> = {
  list: async (ctx, { offset, limit }) => {
    const transitionPlanId = ctx.all.transitionPlanId;
    if (!transitionPlanId) throw new Error("transitionPlanId required for transitionGoals query");

    const items = await db
      .select()
      .from(transitionGoals)
      .where(eq(transitionGoals.transitionPlanId, transitionPlanId))
      .offset(offset)
      .limit(limit);

    const total = await getCount(transitionGoals, eq(transitionGoals.transitionPlanId, transitionPlanId));

    return { items, total };
  },

  add: async (ctx, value) => {
    const transitionPlanId = ctx.all.transitionPlanId;
    if (!transitionPlanId) throw new Error("transitionPlanId required for creating transitionGoal");

    const [created] = await db
      .insert(transitionGoals)
      .values({ ...value, transitionPlanId })
      .returning();

    return created;
  },

  update: async (ctx, key, value) => {
    const transitionPlanId = ctx.all.transitionPlanId;
    if (!transitionPlanId) throw new Error("transitionPlanId required");

    const items = await db
      .select()
      .from(transitionGoals)
      .where(eq(transitionGoals.transitionPlanId, transitionPlanId))
      .offset(Number(key))
      .limit(1);

    if (!items[0]) throw new Error(`TransitionGoal at index ${key} not found`);

    const [updated] = await db
      .update(transitionGoals)
      .set({ ...value, updatedAt: new Date() })
      .where(eq(transitionGoals.id, items[0].id))
      .returning();

    return updated;
  },

  delete: async (ctx, key) => {
    const transitionPlanId = ctx.all.transitionPlanId;
    if (!transitionPlanId) return;

    const items = await db
      .select()
      .from(transitionGoals)
      .where(eq(transitionGoals.transitionPlanId, transitionPlanId))
      .offset(Number(key))
      .limit(1);

    if (items[0]) {
      await db.delete(transitionGoals).where(eq(transitionGoals.id, items[0].id));
    }
  },

  fromDB: (record) => toMemoryValue(record),
  getDBKey: (value) => value.id,
};

// ============================================================================
// MEMORY FIELD SCHEMA DEFINITIONS
// ============================================================================

/**
 * Baseline measurement schema (nested array item)
 */
const baselineMeasurementSchema: AgentMemoryFieldObjectWithDB = {
  id: "baselineMeasurement",
  type: "object",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    skillDescription: { id: "skillDescription", type: "string", description: "Description of the skill being measured" },
    measurementMethod: { id: "measurementMethod", type: "string", description: "How the measurement was taken" },
    value: { id: "value", type: "string", description: "The measurement value (e.g., '10%', '3/10 trials')" },
    numericValue: { id: "numericValue", type: "number", description: "Numeric value for graphing" },
    unit: { id: "unit", type: "string", description: "Unit of measurement" },
    assessedAt: { id: "assessedAt", type: "string", format: "date" },
    assessedBy: { id: "assessedBy", type: "string" },
  },
  required: ["skillDescription", "measurementMethod", "value"],
};

/**
 * Assessment source schema (nested array item)
 */
const assessmentSourceSchema: AgentMemoryFieldObjectWithDB = {
  id: "assessmentSource",
  type: "object",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    sourceType: {
      id: "sourceType",
      type: "string",
      enum: ["standardized_test", "structured_observation", "parent_questionnaire", "teacher_input", "curriculum_based", "behavioral_records"],
    },
    instrumentName: { id: "instrumentName", type: "string", description: "Name of the assessment tool" },
    assessedAt: { id: "assessedAt", type: "string", format: "date" },
    summary: { id: "summary", type: "string" },
    resultsData: { id: "resultsData", type: "object", properties: {}, additionalProperties: true },
  },
  required: ["sourceType"],
};

/**
 * Profile domain schema (map value)
 */
const profileDomainSchema: AgentMemoryFieldObjectWithDB = {
  id: "profileDomain",
  type: "object",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    domainType: {
      id: "domainType",
      type: "string",
      enum: ["cognitive_academic", "communication_language", "social_emotional_behavioral", "motor_sensory", "life_skills_preparation", "other"],
    },
    customName: { id: "customName", type: "string" },
    strengths: { id: "strengths", type: "string", description: "Student's strengths in this domain" },
    needs: { id: "needs", type: "string", description: "Areas needing reinforcement" },
    impactStatement: { id: "impactStatement", type: "string", description: "How disability impacts education" },
    adverseEffectStatement: { id: "adverseEffectStatement", type: "string", description: "IEP-specific adverse effect" },
    sortOrder: { id: "sortOrder", type: "integer" },
    baselineMeasurements: {
      id: "baselineMeasurements",
      type: "array",
      title: "Baseline Measurements",
      opened: true,
      items: baselineMeasurementSchema,
      db: baselineMeasurementsOps,
    } as AgentMemoryFieldArrayWithDB,
    assessmentSources: {
      id: "assessmentSources",
      type: "array",
      title: "Assessment Sources",
      opened: true,
      items: assessmentSourceSchema,
      db: assessmentSourcesOps,
    } as AgentMemoryFieldArrayWithDB,
  },
  required: ["domainType"],
};

/**
 * Data point schema (nested array item)
 */
const dataPointSchema: AgentMemoryFieldObjectWithDB = {
  id: "dataPoint",
  type: "object",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    recordedAt: { id: "recordedAt", type: "string", format: "date-time" },
    value: { id: "value", type: "string", description: "The recorded value" },
    numericValue: { id: "numericValue", type: "number" },
    context: { id: "context", type: "string" },
    collectedBy: { id: "collectedBy", type: "string" },
  },
  required: ["value"],
};

/**
 * Objective schema (nested array item)
 */
const objectiveSchema: AgentMemoryFieldObjectWithDB = {
  id: "objective",
  type: "object",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    objectiveStatement: { id: "objectiveStatement", type: "string", description: "The short-term objective" },
    sequenceOrder: { id: "sequenceOrder", type: "integer" },
    criterion: { id: "criterion", type: "string", description: "Measurable criterion (e.g., '3 out of 4 opportunities')" },
    context: { id: "context", type: "string" },
    targetDate: { id: "targetDate", type: "string", format: "date" },
    status: {
      id: "status",
      type: "string",
      enum: ["not_started", "in_progress", "achieved", "modified", "discontinued"],
    },
    achievedDate: { id: "achievedDate", type: "string", format: "date" },
    dataPoints: {
      id: "dataPoints",
      type: "array",
      title: "Data Points",
      // Don't open by default - can be many data points
      items: dataPointSchema,
      db: dataPointsOps,
    } as AgentMemoryFieldArrayWithDB,
  },
  required: ["objectiveStatement"],
};

/**
 * Goal schema (map value)
 */
const goalSchema: AgentMemoryFieldObjectWithDB = {
  id: "goal",
  type: "object",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    goalStatement: { id: "goalStatement", type: "string", description: "The annual goal statement" },
    profileDomainId: { id: "profileDomainId", type: "string", description: "Link to profile domain" },
    targetBehavior: { id: "targetBehavior", type: "string" },
    criteria: { id: "criteria", type: "string", description: "Success criteria (e.g., '80% accuracy')" },
    criteriaPercentage: { id: "criteriaPercentage", type: "integer", minimum: 0, maximum: 100 },
    measurementMethod: { id: "measurementMethod", type: "string" },
    conditions: { id: "conditions", type: "string" },
    relevance: { id: "relevance", type: "string" },
    targetDate: { id: "targetDate", type: "string", format: "date" },
    interventionLevel: {
      id: "interventionLevel",
      type: "string",
      enum: ["activity", "function", "participation"],
      description: "TALA-specific ICF intervention level",
    },
    status: {
      id: "status",
      type: "string",
      enum: ["draft", "active", "achieved", "modified", "discontinued"],
    },
    progress: { id: "progress", type: "integer", minimum: 0, maximum: 100 },
    sortOrder: { id: "sortOrder", type: "integer" },
    objectives: {
      id: "objectives",
      type: "array",
      title: "Short-term Objectives",
      opened: true,
      items: objectiveSchema,
      db: objectivesOps,
    } as AgentMemoryFieldArrayWithDB,
    dataPoints: {
      id: "dataPoints",
      type: "array",
      title: "Data Points",
      // Don't open by default - can be many data points
      items: dataPointSchema,
      db: dataPointsOps,
    } as AgentMemoryFieldArrayWithDB,
  },
  required: ["goalStatement"],
};

/**
 * Accommodation schema (nested array item)
 */
const accommodationSchema: AgentMemoryFieldObjectWithDB = {
  id: "accommodation",
  type: "object",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    accommodationType: {
      id: "accommodationType",
      type: "string",
      enum: ["visual_support", "aac_device", "modified_materials", "extended_time", "simplified_language", "environmental_modification", "other"],
    },
    customTypeName: { id: "customTypeName", type: "string" },
    description: { id: "description", type: "string" },
    settings: { id: "settings", type: "array", items: { id: "setting", type: "string" } },
    isActive: { id: "isActive", type: "boolean", default: true },
  },
  required: ["accommodationType", "description"],
};

/**
 * Service schema (map value)
 */
const serviceSchema: AgentMemoryFieldObjectWithDB = {
  id: "service",
  type: "object",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    serviceType: {
      id: "serviceType",
      type: "string",
      enum: ["speech_language_therapy", "occupational_therapy", "physical_therapy", "counseling", "specialized_instruction", "consultation", "aac_support", "other"],
    },
    customServiceName: { id: "customServiceName", type: "string" },
    description: { id: "description", type: "string" },
    providerName: { id: "providerName", type: "string" },
    frequencyCount: { id: "frequencyCount", type: "integer", minimum: 1 },
    frequencyPeriod: {
      id: "frequencyPeriod",
      type: "string",
      enum: ["daily", "weekly", "monthly"],
    },
    sessionDuration: { id: "sessionDuration", type: "integer", description: "Duration in minutes" },
    setting: {
      id: "setting",
      type: "string",
      enum: ["general_education", "resource_room", "self_contained", "home", "community", "therapy_room"],
    },
    settingDescription: { id: "settingDescription", type: "string" },
    deliveryModel: {
      id: "deliveryModel",
      type: "string",
      enum: ["direct", "consultation", "collaborative", "indirect"],
    },
    startDate: { id: "startDate", type: "string", format: "date" },
    endDate: { id: "endDate", type: "string", format: "date" },
    isActive: { id: "isActive", type: "boolean", default: true },
    accommodations: {
      id: "accommodations",
      type: "array",
      title: "Service Accommodations",
      opened: true,
      items: accommodationSchema,
      db: accommodationsOps,
    } as AgentMemoryFieldArrayWithDB,
  },
  required: ["serviceType", "sessionDuration"],
};

/**
 * Team member schema (map value)
 */
const teamMemberSchema: AgentMemoryFieldObjectWithDB = {
  id: "teamMember",
  type: "object",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    name: { id: "name", type: "string" },
    role: {
      id: "role",
      type: "string",
      enum: ["parent_guardian", "student", "homeroom_teacher", "special_education_teacher", "general_education_teacher", "speech_language_pathologist", "occupational_therapist", "physical_therapist", "psychologist", "administrator", "case_manager", "external_provider", "other"],
    },
    customRole: { id: "customRole", type: "string" },
    organization: { id: "organization", type: "string" },
    contactEmail: { id: "contactEmail", type: "string", format: "email" },
    contactPhone: { id: "contactPhone", type: "string" },
    responsibilities: { id: "responsibilities", type: "array", items: { id: "responsibility", type: "string" } },
    isCoordinator: { id: "isCoordinator", type: "boolean", default: false },
    isActive: { id: "isActive", type: "boolean", default: true },
  },
  required: ["name", "role"],
};

/**
 * Meeting schema (map value)
 */
const meetingSchema: AgentMemoryFieldObjectWithDB = {
  id: "meeting",
  type: "object",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    meetingType: {
      id: "meetingType",
      type: "string",
      enum: ["initial_evaluation", "annual_review", "reevaluation", "amendment", "transition_planning", "progress_review"],
    },
    scheduledDate: { id: "scheduledDate", type: "string", format: "date-time" },
    actualDate: { id: "actualDate", type: "string", format: "date-time" },
    location: { id: "location", type: "string" },
    attendeeIds: { id: "attendeeIds", type: "array", items: { id: "attendeeId", type: "string" } },
    parentAttended: { id: "parentAttended", type: "boolean" },
    studentAttended: { id: "studentAttended", type: "boolean" },
    agenda: { id: "agenda", type: "string" },
    notes: { id: "notes", type: "string" },
    decisions: { id: "decisions", type: "array", items: { id: "decision", type: "string" } },
    parentConcerns: { id: "parentConcerns", type: "string" },
    parentPriorities: { id: "parentPriorities", type: "string" },
  },
  required: ["meetingType"],
};

/**
 * Consent form schema (map value)
 */
const consentFormSchema: AgentMemoryFieldObjectWithDB = {
  id: "consentForm",
  type: "object",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    consentType: {
      id: "consentType",
      type: "string",
      enum: ["initial_evaluation", "reevaluation", "placement", "release_of_information", "service_provision"],
    },
    requestedDate: { id: "requestedDate", type: "string", format: "date" },
    responseDate: { id: "responseDate", type: "string", format: "date" },
    consentGiven: { id: "consentGiven", type: "boolean" },
    signedBy: { id: "signedBy", type: "string" },
    notes: { id: "notes", type: "string" },
    documentUrl: { id: "documentUrl", type: "string" },
  },
  required: ["consentType"],
};

/**
 * Goal progress entry schema (nested array item)
 */
const goalProgressEntrySchema: AgentMemoryFieldObjectWithDB = {
  id: "goalProgressEntry",
  type: "object",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    goalId: { id: "goalId", type: "string" },
    currentPerformance: { id: "currentPerformance", type: "string" },
    progressStatus: {
      id: "progressStatus",
      type: "string",
      enum: ["significant_progress", "making_progress", "limited_progress", "no_progress", "regression", "goal_met"],
    },
    narrative: { id: "narrative", type: "string" },
  },
  required: ["goalId", "progressStatus"],
};

/**
 * Progress report schema (map value)
 */
const progressReportSchema: AgentMemoryFieldObjectWithDB = {
  id: "progressReport",
  type: "object",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    reportDate: { id: "reportDate", type: "string", format: "date" },
    reportingPeriod: { id: "reportingPeriod", type: "string", description: "e.g., 'Q1', 'Semester 1'" },
    overallSummary: { id: "overallSummary", type: "string" },
    recommendedChanges: { id: "recommendedChanges", type: "string" },
    sharedWithParents: { id: "sharedWithParents", type: "boolean", default: false },
    sharedDate: { id: "sharedDate", type: "string", format: "date" },
    entries: {
      id: "entries",
      type: "array",
      title: "Goal Progress Entries",
      opened: true,
      items: goalProgressEntrySchema,
      db: goalProgressEntriesOps,
    } as AgentMemoryFieldArrayWithDB,
  },
  required: ["reportDate"],
};

/**
 * Transition goal schema (nested array item)
 */
const transitionGoalSchema: AgentMemoryFieldObjectWithDB = {
  id: "transitionGoal",
  type: "object",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    area: {
      id: "area",
      type: "string",
      enum: ["education", "employment", "independent_living", "community"],
    },
    goalStatement: { id: "goalStatement", type: "string" },
    activitiesServices: { id: "activitiesServices", type: "string" },
    responsibleParty: { id: "responsibleParty", type: "string" },
    timeline: { id: "timeline", type: "string" },
    status: {
      id: "status",
      type: "string",
      enum: ["draft", "active", "achieved", "modified", "discontinued"],
    },
  },
  required: ["area", "goalStatement"],
};

/**
 * Transition plan schema (object)
 */
const transitionPlanSchema: AgentMemoryFieldObjectWithDB = {
  id: "transitionPlan",
  type: "object",
  title: "Transition Plan",
  description: "For students ages 16-21",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    postSecondaryEducation: { id: "postSecondaryEducation", type: "string" },
    employment: { id: "employment", type: "string" },
    independentLiving: { id: "independentLiving", type: "string" },
    communityParticipation: { id: "communityParticipation", type: "string" },
    transitionAssessmentSummary: { id: "transitionAssessmentSummary", type: "string" },
    agencyLinkages: {
      id: "agencyLinkages",
      type: "array",
      items: {
        id: "agencyLinkage",
        type: "object",
        properties: {
          agencyName: { id: "agencyName", type: "string" },
          contact: { id: "contact", type: "string" },
          services: { id: "services", type: "string" },
        },
      },
    },
    goals: {
      id: "goals",
      type: "array",
      title: "Transition Goals",
      opened: true,
      items: transitionGoalSchema,
      db: transitionGoalsOps,
    } as AgentMemoryFieldArrayWithDB,
  },
  db: transitionPlanOps,
};

/**
 * Main program schema - the root memory field for progress mode
 * 
 * Top-level collections are MAPS for easy identification:
 * - profileDomains: keyed by {shortId}_{domainType}
 * - goals: keyed by {shortId}_{goalStatement}
 * - services: keyed by {shortId}_{serviceType}
 * - teamMembers: keyed by {shortId}_{name}
 * - meetings: keyed by {shortId}_{meetingType}
 * - consentForms: keyed by {shortId}_{consentType}
 * - progressReports: keyed by {shortId}_{date}
 */
export const PROGRESS_PROGRAM_FIELD: AgentMemoryFieldObjectWithDB = {
  id: "Context_Program",
  type: "object",
  title: "IEP/TALA Program",
  description: "The current educational program for the student",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    framework: {
      id: "framework",
      type: "string",
      enum: ["tala", "us_iep"],
      description: "TALA (Israel) or US IEP framework",
    },
    programYear: { id: "programYear", type: "string", description: "e.g., '2024-2025'" },
    title: { id: "title", type: "string" },
    status: {
      id: "status",
      type: "string",
      enum: ["draft", "active", "archived"],
    },
    startDate: { id: "startDate", type: "string", format: "date" },
    endDate: { id: "endDate", type: "string", format: "date" },
    dueDate: { id: "dueDate", type: "string", format: "date" },
    approvalDate: { id: "approvalDate", type: "string", format: "date" },
    leastRestrictiveEnvironment: { id: "leastRestrictiveEnvironment", type: "string" },
    notes: { id: "notes", type: "string" },
    
    // MAP collections with meaningful keys
    profileDomains: {
      id: "profileDomains",
      type: "map",
      title: "Profile Domains",
      description: "Functional profile / PLAAFP documentation (keyed by domain type)",
      opened: true,
      values: profileDomainSchema,
      db: profileDomainsOps,
    } as AgentMemoryFieldMapWithDB,
    
    goals: {
      id: "goals",
      type: "map",
      title: "Goals",
      description: "Annual goals and objectives (keyed by goal statement)",
      opened: true,
      values: goalSchema,
      db: goalsOps,
    } as AgentMemoryFieldMapWithDB,
    
    services: {
      id: "services",
      type: "map",
      title: "Services",
      description: "Related services and interventions (keyed by service type)",
      opened: true,
      values: serviceSchema,
      db: servicesOps,
    } as AgentMemoryFieldMapWithDB,
    
    teamMembers: {
      id: "teamMembers",
      type: "map",
      title: "Team Members",
      description: "IEP/TALA team members (keyed by name)",
      opened: true,
      values: teamMemberSchema,
      db: teamMembersOps,
    } as AgentMemoryFieldMapWithDB,
    
    meetings: {
      id: "meetings",
      type: "map",
      title: "Meetings",
      description: "IEP/TALA meetings (keyed by meeting type)",
      opened: true,
      values: meetingSchema,
      db: meetingsOps,
    } as AgentMemoryFieldMapWithDB,
    
    consentForms: {
      id: "consentForms",
      type: "map",
      title: "Consent Forms",
      description: "Required consent documentation (keyed by consent type)",
      opened: true,
      values: consentFormSchema,
      db: consentFormsOps,
    } as AgentMemoryFieldMapWithDB,
    
    progressReports: {
      id: "progressReports",
      type: "map",
      title: "Progress Reports",
      description: "Periodic progress reports (keyed by date)",
      opened: true,
      values: progressReportSchema,
      db: progressReportsOps,
    } as AgentMemoryFieldMapWithDB,
    
    transitionPlan: transitionPlanSchema,
  },
  required: ["framework", "programYear"],
  db: programOps,
};

// ============================================================================
// SYSTEM PROMPT FOR PROGRESS MODE
// ============================================================================

export const PROGRESS_SYSTEM_PROMPT = `You are an expert IEP/TALA (Individualized Education Program / תוכנית לימודים אישית) assistant.

## Your Role
You help educators, therapists, and caregivers manage educational programs for students with special needs. You can:
- View and edit program information
- Manage goals, objectives, and track progress
- Document services and accommodations
- Record data points and generate progress reports
- Manage team members and meetings

## Program Structure

The program is stored at /Context_Program with this structure:
- **framework**: "tala" (Israel) or "us_iep" (US)
- **programYear**: Academic year (e.g., "2024-2025")
- **status**: "draft" | "active" | "archived"
- **profileDomains{map}**: Functional profile areas (PLAAFP), keyed by domain type
  - Each has baselineMeasurements[] and assessmentSources[]
- **goals{map}**: Annual goals, keyed by goal statement
  - Each has objectives[] and dataPoints[]
- **services{map}**: Related services, keyed by service type
  - Each has accommodations[]
- **teamMembers{map}**: Team members, keyed by name
- **meetings{map}**: Scheduled/completed meetings, keyed by type
- **consentForms{map}**: Required consents, keyed by consent type
- **progressReports{map}**: Periodic reports, keyed by date
  - Each has entries[] for goal progress
- **transitionPlan**: For students 16+ (US IEP)
  - Has goals[] for different transition areas

## Map Keys
Collections use meaningful keys like:
- teamMembers: "ba1e0ce7_frank_smith"
- goals: "abc12345_student_will_use"
- services: "def67890_speech_language"

## Common Operations

### View program overview:
\`\`\`
manageMemory({ ops: [{ action: "view", path: "/Context_Program" }]})
\`\`\`

### View all goals (they display automatically with details):
\`\`\`
manageMemory({ ops: [{ action: "view", path: "/Context_Program/goals" }]})
\`\`\`

### Add a new goal (key is auto-generated):
\`\`\`
manageMemory({ ops: [{ action: "add", path: "/Context_Program/goals", key: "new_goal", value: {
  goalStatement: "Student will use 2-3 word phrases to request items with 80% accuracy",
  profileDomainId: "domain-id",
  criteria: "80% accuracy",
  criteriaPercentage: 80,
  status: "draft"
}}]})
\`\`\`

### Add an objective to a goal (use the goal's map key):
\`\`\`
manageMemory({ ops: [{ action: "add", path: "/Context_Program/goals/abc12345_student_will/objectives", value: {
  objectiveStatement: "Student will use single words to request in 3 out of 4 opportunities",
  criterion: "3 out of 4 opportunities",
  status: "not_started"
}}]})
\`\`\`

### Record a data point:
\`\`\`
manageMemory({ ops: [{ action: "add", path: "/Context_Program/goals/abc12345_student_will/dataPoints", value: {
  value: "4/5 trials successful",
  numericValue: 80,
  context: "Morning circle time",
  collectedBy: "SLP"
}}]})
\`\`\`

### Update goal progress:
\`\`\`
manageMemory({ ops: [{ action: "set", path: "/Context_Program/goals/abc12345_student_will/progress", value: 75 }]})
\`\`\`

### Add a team member:
\`\`\`
manageMemory({ ops: [{ action: "add", path: "/Context_Program/teamMembers", key: "new_member", value: {
  name: "Jane Smith",
  role: "speech_language_pathologist",
  contactEmail: "jane@school.edu"
}}]})
\`\`\`

### Add a service:
\`\`\`
manageMemory({ ops: [{ action: "add", path: "/Context_Program/services", key: "new_service", value: {
  serviceType: "speech_language_therapy",
  frequencyCount: 2,
  frequencyPeriod: "weekly",
  sessionDuration: 30,
  setting: "therapy_room",
  deliveryModel: "direct"
}}]})
\`\`\`

## Best Practices

1. **SMART Goals**: Help write goals that are Specific, Measurable, Achievable, Relevant, and Time-bound
2. **Data-Driven**: Encourage regular data collection to track progress
3. **Compliance**: Ensure all required elements are documented
4. **Collaboration**: Support team communication and coordination
5. **Accessibility**: Use clear, jargon-free language when appropriate

## Framework Differences

**TALA (Israel)**:
- Uses ICF-based intervention levels (activity, function, participation)
- Due date typically November 15
- Hebrew terminology preferred

**US IEP**:
- IDEA compliance requirements
- Transition planning required at age 16
- Least Restrictive Environment (LRE) documentation
- Annual review cycle

When working with programs, always be supportive and help ensure quality documentation that serves the student's needs.`;

// ============================================================================
// EXPORTS
// ============================================================================

export { PROGRESS_PROGRAM_FIELD as PROGRESS_MEMORY_FIELD };

/**
 * Get the complete memory fields for progress mode
 * Combines master memory fields with the program field
 */
export function getProgressMemoryFields(masterFields: AgentMemoryFieldWithDB[]): AgentMemoryFieldWithDB[] {
  return [...masterFields, PROGRESS_PROGRAM_FIELD];
}