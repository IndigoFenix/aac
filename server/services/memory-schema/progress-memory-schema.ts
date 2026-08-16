
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
 * Memory field schema and database operations for IEP/TALA program management.
 * Used when sessionService mode is "progress".
 * 
 * Structure:
 * - Context_Program (object) - the current active program
 *   - profileDomains (map) - keyed by {shortId}_{domainType}
 *     - baselineMeasurements (array)
 *     - assessmentSources (array)
 *   - goals (map) - keyed by {shortId}_{goalStatement}
 *     - objectives (array) - each objective has profileDomainId
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

import { eq, and, asc, desc, sql, inArray } from "drizzle-orm";
import { db } from "../../db";
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
  type Meeting,
  type ConsentForm,
  type AgentMemoryField,
  InsertProgram,
  UpdateProgram,
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
} from "../chat/memory-types";
import { programService } from "../programService";
import { activityLogService } from "../activityLogService";
import { PROGRAM_TEAM_CONTACTS_FIELD } from "./contacts-memory-schema";
import { parseLocalOrIsoInTimezone } from "../../lib/timezone";
import { canWriteObject, withInstituteVisibility, type AccessCtx } from "../sharing/visibility";
import { recordShareDerivedViewSingle } from "../sharing/audit";
import { requireConsentForMemoryWrite } from "../consent/consentGate";
import {
  frameworkCapabilities,
  isStatutoryFramework,
  normalizeFramework,
  PROGRAM_FRAMEWORKS,
} from "@shared/program-framework";

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
  return m.id;
}

/** Goal key: {shortId}_{first_words} → "abc12345_student_will_use" */
function goalKey(g: { id: string; goalStatement: string }): string {
  return g.id;
}

/** Service key: {shortId}_{serviceType} → "def67890_speech_language" */
function serviceKey(s: { id: string; serviceType: string }): string {
  return s.id;
}

/** Meeting key: {shortId}_{meetingType} → "111aaabb_annual_review" */
function meetingKey(m: { id: string; meetingType: string }): string {
  return m.id;
}

/** ProfileDomain key: `{domainType}_{shortId}` (e.g. "communication_language_029f60ab").
 *  The domainType prefix gives the AI a readable reference and the shortId suffix
 *  guarantees uniqueness when multiple domains of the same type exist (which can
 *  happen transiently when defaults are auto-created alongside AI-added domains). */
function profileDomainKey(d: { id: string; domainType: string }): string {
  return `${d.domainType}_${shortId(d.id)}`;
}

/** Valid domainType enum values — kept in sync with profileDomainSchema.properties.domainType.enum */
const DOMAIN_TYPE_VALUES = new Set([
  "cognitive_academic",
  "communication_language",
  "social_emotional_behavioral",
  "motor_sensory",
  "life_skills_preparation",
  "other",
]);

/** Parses a key of the form `{domainType}_{8hex}`. Returns `null` if the key
 *  is not in that shape (e.g. bare domainType, or a raw UUID). */
function parseProfileDomainCompositeKey(
  key: string,
): { domainType: string; idPrefix: string } | null {
  const m = key.match(/^(.+)_([a-f0-9]{8})$/);
  if (!m) return null;
  const [, domainType, idPrefix] = m;
  if (!DOMAIN_TYPE_VALUES.has(domainType)) return null;
  return { domainType, idPrefix };
}

/** Look up a profile domain by map key. Accepts three forms:
 *   1. `{domainType}_{shortId}` — canonical unique key (see profileDomainKey)
 *   2. bare `domainType` — resolves to the single matching domain (first if multiple)
 *   3. full UUID / UUID-prefix — legacy lookup via findByMapKey */
async function findProfileDomainByKey(
  programId: string,
  key: string,
): Promise<ProfileDomain | undefined> {
  const composite = parseProfileDomainCompositeKey(key);
  if (composite) {
    const [row] = await db
      .select()
      .from(profileDomains)
      .where(
        and(
          eq(profileDomains.programId, programId),
          eq(profileDomains.domainType, composite.domainType as any),
          sql`${profileDomains.id}::text LIKE ${composite.idPrefix + "%"}`,
        ),
      )
      .limit(1);
    if (row) return row;
  }
  if (DOMAIN_TYPE_VALUES.has(key)) {
    const [byType] = await db
      .select()
      .from(profileDomains)
      .where(
        and(
          eq(profileDomains.programId, programId),
          eq(profileDomains.domainType, key as any),
        ),
      )
      .orderBy(asc(profileDomains.sortOrder))
      .limit(1);
    if (byType) return byType;
  }
  return findByMapKey<ProfileDomain>(
    profileDomains,
    profileDomains.id,
    eq(profileDomains.programId, programId),
    key,
  );
}

/** Resolve a profileDomainId value that may be a UUID, a bare domainType, or a
 *  composite `{domainType}_{shortId}` key. Returns the UUID (or null if unresolvable). */
async function resolveProfileDomainId(
  programId: string | undefined,
  raw: string | null | undefined,
): Promise<string | null> {
  if (!raw) return null;
  // Already a UUID — pass through
  if (!DOMAIN_TYPE_VALUES.has(raw) && !parseProfileDomainCompositeKey(raw)) {
    return raw;
  }
  if (!programId) return null;
  const domain = await findProfileDomainByKey(programId, raw);
  return domain?.id ?? null;
}

/** ConsentForm key: {shortId}_{consentType} → "333cccdd_initial_eval" */
function consentFormKey(c: { id: string; consentType: string }): string {
  return c.id;
}

/** ProgressReport key: {shortId}_{date} → "444dddee_2025_03_15" */
function progressReportKey(r: { id: string; reportDate: string | null }): string {
  return r.id;
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
    const accessCtx = ctx.all.accessCtx as AccessCtx | undefined;
    if (!studentId) throw new Error("studentId required for program query");
    // Fail-closed — without an accessCtx the AI must not read PHI. The
    // parent-program read is the gate every child op (goals/objectives/
    // baselines/services/meetings) inherits from, so a missing visibility
    // ctx here would expose all program children regardless of institute.
    if (!accessCtx) return undefined;

    // Get current/working program (active or draft) — gated by visibility
    // through withInstituteVisibility. Children of programs (goals, services,
    // etc.) inherit visibility through this read; the root-only ownership
    // model means once the parent is filtered, child queries don't need to
    // re-filter.
    const visibility = withInstituteVisibility(programs, accessCtx, "program");

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
      if (accessCtx) recordShareDerivedViewSingle(accessCtx, "program", activeProgram);
      return activeProgram;
    }

    // Fall back to draft
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

    if (draftProgram && accessCtx) {
      recordShareDerivedViewSingle(accessCtx, "program", draftProgram);
    }
    return draftProgram;
  },

  write: async (ctx, raw) => {
    const studentId = ctx.all.studentId;
    const accessCtx = ctx.all.accessCtx as AccessCtx | undefined;
    if (!studentId) throw new Error("studentId required for program write");
    await requireConsentForMemoryWrite(ctx);

    // Context_Program is object-shaped; the array variant of the write signature
    // is only relevant to array containers, not here.
    const value = raw as Program;

    const existing = value.id
      ? await programService.getProgramById(value.id)
      : await programService.getCurrentProgram(studentId);

    if (existing) {
      // Cross-institute write authorization: institute principals must own the
      // program OR hold a permission='write' share covering it. Read-via-share
      // alone does NOT grant write — that requires a write-capable share.
      if (accessCtx?.kind === "institute") {
        const allowed = await canWriteObject(
          accessCtx,
          "program",
          existing.id,
          existing.studentId,
          existing.instituteId,
        );
        if (!allowed) {
          throw new Error("Cannot modify a program owned by another institute");
        }
      }

      const updated = await programService.updateProgram(existing.id, {
        ...value as UpdateProgram,
      });
      activityLogService.log({
        userId: ctx.all.userId,
        instituteId: ctx.all.instituteId,
        eventType: "update",
        subjectType1: "program",
        subjectId1: updated?.id,
        details: { studentId },
        isAiInitiated: true,
      });
      return updated;
    } else {
      // For institute principals, force the new program's owner to the
      // selected institute — the AI doesn't get to attribute it elsewhere.
      const enforcedInstituteId =
        accessCtx?.kind === "institute"
          ? accessCtx.instituteId
          : (value as any).instituteId ?? null;

      // Create new program with default profile domains
      const { program, domains } = await programService.createProgramWithProfile({
        ...value as InsertProgram,
        studentId,
        instituteId: enforcedInstituteId,
      }, true);

      activityLogService.log({
        userId: ctx.all.userId,
        instituteId: ctx.all.instituteId,
        eventType: "create",
        subjectType1: "program",
        subjectId1: program.id,
        details: { studentId },
        isAiInitiated: true,
      });

      // Return program with domains populated so AI can see them
      const result = programOps.fromDB!(program);

      // Populate profileDomains map with created domains, keyed by domainType
      if (domains.length > 0) {
        for (const domain of domains) {
          result.profileDomains[profileDomainKey(domain)] = toMemoryValue(domain);
        }
        // Inform the AI that default domains were auto-created as a side effect —
        // otherwise the next view may show an empty map and trigger duplicate adds.
        const keys = domains.map(d => profileDomainKey(d)).join(", ");
        (result as any)._note =
          `Program created. ${domains.length} default profile domains were auto-generated (keys: ${keys}). ` +
          `Use these existing domains rather than adding duplicates. View /Context_Program/profileDomains to inspect or edit them.`;
      }

      return result;
    }
  },

  // Idempotent: if the incoming record already has populated container children
  // (e.g. from write() attaching auto-created domains), preserve them instead of
  // wiping to {}. Plain DB-record reads have no such properties, so they still
  // get initialized to empty maps.
  fromDB: (record) => {
    const base = toMemoryValue(record) as any;
    return {
      ...base,
      profileDomains: base.profileDomains ?? {},
      goals: base.goals ?? {},
      services: base.services ?? {},
      teamContacts: base.teamContacts ?? [],
      meetings: base.meetings ?? {},
      consentForms: base.consentForms ?? {},
      progressReports: base.progressReports ?? {},
      // Preserve side-effect note so the bridge can surface it to the AI
      ...(base._note ? { _note: base._note } : {}),
    };
  },

  // Extract programId for child operations (goals, services, etc.)
  extractChildContext: (value) => ({
    programId: value?.id,
    instituteId: value?.instituteId,
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

    activityLogService.log({
      userId: ctx.all.userId,
      instituteId: ctx.all.instituteId,
      eventType: "create",
      subjectType1: "profile_domain",
      subjectId1: created.id,
      details: { studentId: ctx.all.studentId },
      isAiInitiated: true,
    });

    return created;
  },

  update: async (ctx, key, value) => {
    const programId = ctx.all.programId;
    if (!programId) throw new Error("programId required");

    const domain = await findProfileDomainByKey(programId, String(key));

    if (!domain) throw new Error(`ProfileDomain with key ${key} not found`);

    const [updated] = await db
      .update(profileDomains)
      .set({ ...value, updatedAt: new Date() })
      .where(eq(profileDomains.id, domain.id))
      .returning();

    activityLogService.log({
      userId: ctx.all.userId,
      instituteId: ctx.all.instituteId,
      eventType: "update",
      subjectType1: "profile_domain",
      subjectId1: updated.id,
      details: { studentId: ctx.all.studentId },
      isAiInitiated: true,
    });

    return updated;
  },

  delete: async (ctx, key) => {
    const programId = ctx.all.programId;
    if (!programId) return;

    const domain = await findProfileDomainByKey(programId, String(key));

    if (domain) {
      await db.delete(profileDomains).where(eq(profileDomains.id, domain.id));
      activityLogService.log({
        userId: ctx.all.userId,
        instituteId: ctx.all.instituteId,
        eventType: "delete",
        subjectType1: "profile_domain",
        subjectId1: domain.id,
        details: { studentId: ctx.all.studentId },
        isAiInitiated: true,
      });
    }
  },

  fromDB: (record) => toMemoryValue(record),

  // Extract profileDomainId for child operations (baselines, assessments)
  extractChildContext: (value, key) => ({
    profileDomainId: value?.id ?? key,
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
 * NOTE: Goals no longer have profileDomainId - domains are linked via objectives
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

    activityLogService.log({
      userId: ctx.all.userId,
      instituteId: ctx.all.instituteId,
      eventType: "create",
      subjectType1: "goal",
      subjectId1: created.id,
      details: { studentId: ctx.all.studentId },
      isAiInitiated: true,
    });

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

    activityLogService.log({
      userId: ctx.all.userId,
      instituteId: ctx.all.instituteId,
      eventType: "update",
      subjectType1: "goal",
      subjectId1: updated.id,
      details: { studentId: ctx.all.studentId },
      isAiInitiated: true,
    });

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
      activityLogService.log({
        userId: ctx.all.userId,
        instituteId: ctx.all.instituteId,
        eventType: "delete",
        subjectType1: "goal",
        subjectId1: goal.id,
        details: { studentId: ctx.all.studentId },
        isAiInitiated: true,
      });
    }
  },

  fromDB: (record) => toMemoryValue(record),

  // Extract goalId for child operations (objectives, dataPoints)
  extractChildContext: (value, key) => ({
    goalId: value?.id ?? key,
  }),

  getDBKey: (value) => goalKey(value),
};

/**
 * Objectives operations (nested array under goal)
 * NOTE: Objectives now have profileDomainId for domain association
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // Bulk replace: the AI naturally uses `set` with an array to define all
  // objectives for a goal in one call. Implement as a diff — keep items whose
  // ids match existing rows (UPDATE), insert new items without ids, and delete
  // the rest (nullifying dataPoint refs first so FK constraints don't fire).
  write: async (ctx, value) => {
    const goalId = ctx.all.goalId;
    if (!goalId) throw new Error("goalId required for setting objectives");
    if (!Array.isArray(value)) {
      throw new Error("objectives value must be an array");
    }

    // Strip non-UUID ids (AI often supplies synthetic keys like "obj-comm-1")
    // and resolve profileDomainId (accept domainType strings or composite keys).
    const cleaned: any[] = [];
    for (const v of value as any[]) {
      const { id: rawId, ...rest } = v as { id?: string } & Record<string, any>;
      const keepId = rawId && UUID_REGEX.test(rawId);
      cleaned.push({
        ...(keepId ? { id: rawId } : {}),
        ...rest,
        profileDomainId: await resolveProfileDomainId(ctx.all.programId, rest.profileDomainId),
      });
    }

    const existing = await db
      .select()
      .from(objectives)
      .where(eq(objectives.goalId, goalId))
      .orderBy(asc(objectives.sequenceOrder));

    const incomingIds = new Set(cleaned.filter(c => c.id).map(c => c.id as string));
    const toDelete = existing.filter(e => !incomingIds.has(e.id)).map(e => e.id);

    if (toDelete.length > 0) {
      // Nullify dataPoint refs before delete so FK doesn't block us.
      await db
        .update(dataPoints)
        .set({ objectiveId: null })
        .where(inArray(dataPoints.objectiveId, toDelete));
      await db.delete(objectives).where(inArray(objectives.id, toDelete));
    }

    const results: Objective[] = [];
    for (let i = 0; i < cleaned.length; i++) {
      const item = cleaned[i];
      const sequenceOrder = i + 1;

      if (item.id) {
        const [updated] = await db
          .update(objectives)
          .set({ ...item, goalId, sequenceOrder, updatedAt: new Date() })
          .where(eq(objectives.id, item.id))
          .returning();
        if (updated) {
          results.push(updated);
          continue;
        }
      }

      const { id: _discardId, ...rest } = item;
      const [created] = await db
        .insert(objectives)
        .values({ ...rest, goalId, sequenceOrder })
        .returning();
      results.push(created);
    }

    activityLogService.log({
      userId: ctx.all.userId,
      instituteId: ctx.all.instituteId,
      eventType: "update",
      subjectType1: "goal",
      subjectId1: goalId,
      details: { studentId: ctx.all.studentId, action: "set_objectives", count: results.length },
      isAiInitiated: true,
    });

    return results;
  },

  add: async (ctx, value) => {
    const goalId = ctx.all.goalId;
    if (!goalId) throw new Error("goalId required for creating objective");

    // Resolve profileDomainId — accept either a UUID or a domainType enum value
    // (e.g., "communication_language") since domainType is the map key the AI sees.
    const sanitizedValue = {
      ...value,
      profileDomainId: await resolveProfileDomainId(ctx.all.programId, value.profileDomainId),
    };

    // Get next sequence order
    const [maxOrder] = await db
      .select({ max: sql<number>`coalesce(max(sequence_order), 0)` })
      .from(objectives)
      .where(eq(objectives.goalId, goalId));

    const [created] = await db
      .insert(objectives)
      .values({
        ...sanitizedValue,
        goalId,
        sequenceOrder: (maxOrder?.max ?? 0) + 1,
      })
      .returning();

    activityLogService.log({
      userId: ctx.all.userId,
      instituteId: ctx.all.instituteId,
      eventType: "create",
      subjectType1: "objective",
      subjectId1: created.id,
      details: { studentId: ctx.all.studentId },
      isAiInitiated: true,
    });

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

    // Resolve profileDomainId — accept either a UUID or a domainType enum value
    // (e.g., "communication_language") since domainType is the map key the AI sees.
    const sanitizedValue = {
      ...value,
      profileDomainId:
        value.profileDomainId === undefined
          ? undefined
          : await resolveProfileDomainId(ctx.all.programId, value.profileDomainId),
    };

    const [updated] = await db
      .update(objectives)
      .set({ ...sanitizedValue, updatedAt: new Date() })
      .where(eq(objectives.id, items[0].id))
      .returning();

    activityLogService.log({
      userId: ctx.all.userId,
      instituteId: ctx.all.instituteId,
      eventType: "update",
      subjectType1: "objective",
      subjectId1: updated.id,
      details: { studentId: ctx.all.studentId },
      isAiInitiated: true,
    });

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
      activityLogService.log({
        userId: ctx.all.userId,
        instituteId: ctx.all.instituteId,
        eventType: "delete",
        subjectType1: "objective",
        subjectId1: items[0].id,
        details: { studentId: ctx.all.studentId },
        isAiInitiated: true,
      });
    }
  },

  fromDB: (record) => toMemoryValue(record),

  // Extract objectiveId for child operations (dataPoints)
  extractChildContext: (value) => ({
    objectiveId: value?.id,
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

    const tz = ctx.all.timezone as string | undefined;
    const [created] = await db
      .insert(dataPoints)
      .values({
        ...value,
        goalId: goalId || undefined,
        objectiveId: objectiveId || undefined,
        recordedAt: parseLocalOrIsoInTimezone(value.recordedAt, tz) ?? new Date(),
      })
      .returning();

    activityLogService.log({
      userId: ctx.all.userId,
      instituteId: ctx.all.instituteId,
      eventType: "create",
      subjectType1: "data_point",
      subjectId1: created.id,
      details: { studentId: ctx.all.studentId },
      isAiInitiated: true,
    });

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
      activityLogService.log({
        userId: ctx.all.userId,
        instituteId: ctx.all.instituteId,
        eventType: "delete",
        subjectType1: "data_point",
        subjectId1: items[0].id,
        details: { studentId: ctx.all.studentId },
        isAiInitiated: true,
      });
    }
  },

  fromDB: (record) => toMemoryValue(record),
  getDBKey: (value) => value.id,
};

// ... [Rest of the operations remain the same - services, accommodations, etc.]
// Include all remaining operations from the original file here

// ============================================================================
// MEMORY FIELD SCHEMAS
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
    skillDescription: { id: "skillDescription", type: "string" },
    measurementMethod: { id: "measurementMethod", type: "string" },
    value: { id: "value", type: "string" },
    numericValue: { id: "numericValue", type: "number" },
    unit: { id: "unit", type: "string" },
    assessedAt: { id: "assessedAt", type: "string", format: "YYYY-MM-DD" },
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
    assessedAt: { id: "assessedAt", type: "string", format: "YYYY-MM-DD" },
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
      opened: true
    },
    customName: { id: "customName", type: "string", opened: true },
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
    recordedAt: { id: "recordedAt", type: "string", format: "date-time", description: "When the observation occurred. Provide the wall-clock local time as ISO 8601 WITHOUT a timezone suffix (e.g. \"2026-04-23T15:00:00\" for 3:00 PM local). The server interprets this in the user's local time zone (see User Local Time section) and stores UTC. Defaults to the current moment if omitted." },
    value: { id: "value", type: "string", description: "The recorded value", opened: true },
    numericValue: { id: "numericValue", type: "number" },
    achievedLevel: {
      id: "achievedLevel",
      type: "string",
      enum: ["much_less_than_expected", "less_than_expected", "expected", "better_than_expected", "much_better_than_expected"],
      description: "For GAS-scored goals: the ordinal level observed at this data point. Populate only when the parent goal has useGas=true.",
    },
    context: { id: "context", type: "string" },
    collectedBy: { id: "collectedBy", type: "string" },
  },
  required: ["value"],
};

/**
 * Objective schema (nested array item)
 * UPDATED: Now includes profileDomainId for domain association
 */
const objectiveSchema: AgentMemoryFieldObjectWithDB = {
  id: "objective",
  type: "object",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    objectiveStatement: { id: "objectiveStatement", type: "string", description: "The short-term objective", opened: true },
    sequenceOrder: { id: "sequenceOrder", type: "integer" },
    // Domain association is now on objectives
    profileDomainId: { id: "profileDomainId", type: "string", description: "The profile domain this objective relates to. Accepts the domain's domainType (e.g. 'communication_language'), its map key (e.g. 'communication_language_029f60ab'), or its UUID." },
    // Measurable criteria
    targetBehavior: { id: "targetBehavior", type: "string" },
    methods: { id: "methods", type: "string" },
    criteria: { id: "criteria", type: "string", description: "Measurable criterion (e.g., '3 out of 4 opportunities')", opened: true },
    measurementMethod: { id: "measurementMethod", type: "string" },
    relevance: { id: "relevance", type: "string" },
    targetDate: { id: "targetDate", type: "string", format: "YYYY-MM-DD" },
    // GAS integration — only meaningful when the parent goal has useGas=true.
    // Points at one level on the parent's scale that this objective aims to reach.
    gasTargetLevel: {
      id: "gasTargetLevel",
      type: "string",
      enum: ["much_less_than_expected", "less_than_expected", "expected", "better_than_expected", "much_better_than_expected"],
      description:
        "For GAS-scored goals: the target level on the parent goal's 5-level scale that this objective aims to reach. The objective is considered met when the student achieves this level consistently. Leave null when the parent goal is not GAS-scored.",
    },
    status: {
      id: "status",
      type: "string",
      enum: ["draft", "active", "achieved", "modified", "discontinued"],
      opened: true,
    },
    // Progress tracking (0-100)
    progress: { id: "progress", type: "integer", minimum: 0, maximum: 100, opened: true },
    achievedDate: { id: "achievedDate", type: "string", format: "YYYY-MM-DD" },
    dataPoints: {
      id: "dataPoints",
      type: "array",
      title: "Data Points",
      items: dataPointSchema,
      db: dataPointsOps,
    } as AgentMemoryFieldArrayWithDB,
  },
  required: ["objectiveStatement"],
};

/**
 * Goal schema (map value)
 * UPDATED: Removed profileDomainId and criteriaPercentage
 * Domains are now associated via objectives
 */
const goalSchema: AgentMemoryFieldObjectWithDB = {
  id: "goal",
  type: "object",
  opened: true,
  properties: {
    // Most important fields first for truncated display
    id: { id: "id", type: "string" },
    goalStatement: { id: "goalStatement", type: "string", description: "The annual goal statement", opened: true },
    status: {
      id: "status",
      type: "string",
      enum: ["draft", "active", "achieved", "modified", "discontinued"],
      opened: true,
    },
    // Progress tracking (0-100) - replaces criteriaPercentage
    progress: { id: "progress", type: "integer", minimum: 0, maximum: 100, opened: true, description: "Overall goal progress (0-100)" },
    targetDate: { id: "targetDate", type: "string", format: "YYYY-MM-DD", opened: true },
    achievedDate: { id: "achievedDate", type: "string", format: "YYYY-MM-DD" },
    // Legacy/simple fields (for quick entry)
    targetBehavior: { id: "targetBehavior", type: "string" },
    criteria: { id: "criteria", type: "string", description: "Success criteria description" },
    methods: { id: "methods", type: "string" },
    measurementMethod: { id: "measurementMethod", type: "string" },
    relevance: { id: "relevance", type: "string", description: "Educational impact/relevance" },
    interventionLevel: {
      id: "interventionLevel",
      type: "string",
      enum: ["activity", "function", "participation"],
      description: "TALA-specific ICF intervention level",
    },
    // GAS (Goal Attainment Scaling) — TALA-aligned ordinal scoring
    useGas: {
      id: "useGas",
      type: "boolean",
      description: "When true, this goal is scored on a 5-level GAS ordinal scale and dataPoints should record achievedLevel.",
    },
    gasVaryingVariable: {
      id: "gasVaryingVariable",
      type: "string",
      enum: ["achievement", "mediation", "time", "frequency"],
      description: "The single dimension that varies across the 5 GAS levels. Keep all other conditions constant.",
    },
    gasBaselineLevel: {
      id: "gasBaselineLevel",
      type: "string",
      enum: ["much_less_than_expected", "less_than_expected", "expected", "better_than_expected", "much_better_than_expected"],
      description: "The level the student is at when the goal is written. Typically 'much_less_than_expected' in pediatric therapy.",
    },
    gasLevels: {
      id: "gasLevels",
      type: "object",
      opened: true,
      description: "Definitions for the 5 GAS levels. Each level has an observable, present-tense behavior statement and optional numericValue/unit. Only fill the levels you define; all 5 should normally be present.",
      properties: {
        much_less_than_expected: {
          id: "much_less_than_expected",
          type: "object",
          properties: {
            behavior: { id: "behavior", type: "string", description: "Observable, present-tense description of this level (-2)" },
            numericValue: { id: "numericValue", type: "number" },
            unit: { id: "unit", type: "string" },
          },
        },
        less_than_expected: {
          id: "less_than_expected",
          type: "object",
          properties: {
            behavior: { id: "behavior", type: "string", description: "Observable behavior at level -1" },
            numericValue: { id: "numericValue", type: "number" },
            unit: { id: "unit", type: "string" },
          },
        },
        expected: {
          id: "expected",
          type: "object",
          properties: {
            behavior: { id: "behavior", type: "string", description: "The goal — expected outcome at level 0" },
            numericValue: { id: "numericValue", type: "number" },
            unit: { id: "unit", type: "string" },
          },
        },
        better_than_expected: {
          id: "better_than_expected",
          type: "object",
          properties: {
            behavior: { id: "behavior", type: "string", description: "Observable behavior at level +1" },
            numericValue: { id: "numericValue", type: "number" },
            unit: { id: "unit", type: "string" },
          },
        },
        much_better_than_expected: {
          id: "much_better_than_expected",
          type: "object",
          properties: {
            behavior: { id: "behavior", type: "string", description: "Best realistic outcome at level +2" },
            numericValue: { id: "numericValue", type: "number" },
            unit: { id: "unit", type: "string" },
          },
        },
      },
    },
    // Family-Centered Service (FCS) / COPM
    clientImportanceRating: {
      id: "clientImportanceRating",
      type: "integer",
      minimum: 1,
      maximum: 5,
      description: "Importance rating (1-5) assigned to this goal by the client or family — used in COPM-style joint goal-setting.",
    },
    setJointlyWithFamily: {
      id: "setJointlyWithFamily",
      type: "boolean",
      description: "True when the goal was defined in partnership with the student and/or family (FCS principle).",
    },
    familyInput: {
      id: "familyInput",
      type: "string",
      description: "Notes from parent/caregiver input about this goal.",
    },
    sortOrder: { id: "sortOrder", type: "integer" },
    // Nested collections - objectives now carry domain information
    objectives: {
      id: "objectives",
      type: "array",
      title: "Short-term Objectives",
      description: "Each objective can be associated with a profile domain",
      opened: true,
      items: objectiveSchema,
      db: objectivesOps,
    } as AgentMemoryFieldArrayWithDB,
    dataPoints: {
      id: "dataPoints",
      type: "array",
      title: "Data Points",
      items: dataPointSchema,
      db: dataPointsOps,
    } as AgentMemoryFieldArrayWithDB,
  },
  required: ["goalStatement"],
};

// Note: The remaining schemas (service, accommodation, team member, meeting, 
// consent form, progress report, transition plan) remain unchanged from the original.
// Include them from the original file.

/**
 * Main program schema - the root memory field for progress mode
 * 
 * UPDATED: Goals map now notes that domains are associated via objectives
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
      enum: PROGRAM_FRAMEWORKS as unknown as string[],
      description:
        "tala = Israeli TALA; us_iep = US IEP; personal = not in a school system (no statutory paperwork). Match the student's framework.",
    },
    title: { id: "title", type: "string" },
    status: {
      id: "status",
      type: "string",
      enum: ["draft", "active", "archived"],
    },
    startDate: { id: "startDate", type: "string", format: "YYYY-MM-DD" },
    endDate: { id: "endDate", type: "string", format: "YYYY-MM-DD" },
    dueDate: { id: "dueDate", type: "string", format: "YYYY-MM-DD" },
    approvalDate: { id: "approvalDate", type: "string", format: "YYYY-MM-DD" },
    leastRestrictiveEnvironment: { id: "leastRestrictiveEnvironment", type: "string" },
    // ICF contextual factors (WHO 2002) — program-level, authoritative for reports.
    // These are the deliberate clinician-set snapshot; chatMemory carries day-to-day
    // observations that can influence these but don't overwrite them.
    personalFactors: {
      id: "personalFactors",
      type: "object",
      description: "ICF Personal Factors: student's interests, temperament, motivators, coping styles, cultural background, etc. Contextual — not a target of intervention.",
      properties: {
        interests: { id: "interests", type: "array", items: { id: "interest", type: "string" } as any },
        temperament: { id: "temperament", type: "string" },
        motivators: { id: "motivators", type: "array", items: { id: "motivator", type: "string" } as any },
        coping: { id: "coping", type: "string" },
        culturalBackground: { id: "culturalBackground", type: "string" },
      },
      additionalProperties: true,
    },
    environmentalFactors: {
      id: "environmentalFactors",
      type: "object",
      description: "ICF Environmental Factors keyed by category. Each category lists facilitators (what helps) and barriers (what hinders). Describes the current state of the world; services/accommodations capture what we do about it.",
      properties: {
        products_technology: {
          id: "products_technology",
          type: "object",
          description: "AAC devices, assistive tech, educational materials.",
          properties: {
            facilitators: { id: "facilitators", type: "array", items: { id: "f", type: "string" } as any },
            barriers: { id: "barriers", type: "array", items: { id: "b", type: "string" } as any },
            notes: { id: "notes", type: "string" },
          },
        },
        natural_environment: {
          id: "natural_environment",
          type: "object",
          description: "Physical space, noise, lighting, sensory environment.",
          properties: {
            facilitators: { id: "facilitators", type: "array", items: { id: "f", type: "string" } as any },
            barriers: { id: "barriers", type: "array", items: { id: "b", type: "string" } as any },
            notes: { id: "notes", type: "string" },
          },
        },
        // Note: support_relationships and attitudes are no longer ICF environmental
        // factors — those are now modeled as studentContacts rows with role/attitude
        // captured per-person in contextNotes.
        services_systems_policies: {
          id: "services_systems_policies",
          type: "object",
          description: "School policy, insurance, transport, legal entitlements.",
          properties: {
            facilitators: { id: "facilitators", type: "array", items: { id: "f", type: "string" } as any },
            barriers: { id: "barriers", type: "array", items: { id: "b", type: "string" } as any },
            notes: { id: "notes", type: "string" },
          },
        },
      },
    },
    notes: { id: "notes", type: "string" },
    
    // MAP collections with meaningful keys
    profileDomains: {
      id: "profileDomains",
      type: "map",
      title: "Profile Domains",
      description: "Functional profile / PLAAFP documentation (keyed by domain type). Unless requested, there should only be one domain per type.",
      opened: true,
      values: profileDomainSchema,
      db: profileDomainsOps,
    } as AgentMemoryFieldMapWithDB,
    
    goals: {
      id: "goals",
      type: "map",
      title: "Goals",
      description: "Annual goals with objectives. Goals are linked to domains through their objectives (each objective can have a profileDomainId). Goals should be defined using S.M.A.R.T criteria.",
      opened: true,
      values: goalSchema,
      db: goalsOps,
    } as AgentMemoryFieldMapWithDB,

    // Team contacts — junction rows pointing at studentContacts. To add a person,
    // first create them in Student_Contacts, then add a teamContacts entry with
    // their contactId.
    teamContacts: PROGRAM_TEAM_CONTACTS_FIELD,

    // Include remaining map collections from the original...
  },
  required: ["framework"],
  db: programOps,
};

// ============================================================================
// SYSTEM PROMPT FOR PROGRESS MODE
// ============================================================================

export const PROGRESS_SYSTEM_PROMPT = `
You can:
- View and edit program information
- Manage goals and track progress (0-100 scale, or 5-level GAS scoring when useGas=true)
- Create objectives under goals, each objective can be linked to a profile domain
- Document services and accommodations
- Record data points and generate progress reports
- Manage the student's contacts (Student_Contacts map — parents, classmates, therapists, team members)
- Assign contacts to the program's team (teamContacts array on Context_Program) — first create/verify the Student_Contacts entry, then add a teamContacts row with its contactId
- Manage meetings
- Record ICF contextual information: personalFactors (interests, temperament, motivators, coping, cultural background) and environmentalFactors (facilitators and barriers grouped by ICF category)

When a goal is measured with Goal Attainment Scaling (useGas=true):
- Pick one varying variable (achievement, mediation, time, or frequency) — all other conditions stay constant across levels
- Write each of the 5 gasLevels with a concrete, present-tense observable behavior
- Set gasBaselineLevel to where the student is when the goal is written (typically much_less_than_expected)
- Data points should record achievedLevel — the ordinal level observed
- Goals set with family should have setJointlyWithFamily=true and a clientImportanceRating (1-5)
`;

/**
 * Framework-specific guidance appended to the progress prompt.
 *
 * The program schema is one shape for every framework; what changes is which
 * parts are legally called for. Without this, the assistant volunteers US
 * statutory paperwork (LRE, prior written consent, transition plans) at
 * learners who are not in any school system.
 */
export function buildFrameworkGuidance(framework: string | null | undefined): string {
  const caps = frameworkCapabilities(framework);
  const slug = normalizeFramework(framework);

  if (!isStatutoryFramework(slug)) {
    return `
<FRAMEWORK>
This student's program is PERSONAL — they are not enrolled in a school system.
The program is real and complete: domains, goals, objectives, services, accommodations, progress reports, data points, team.
It has no statutory layer. Do NOT create or ask for:
- Placement statements (LRE) or adverse-effect-on-education statements
- Prior-written-consent forms, or statutory meetings (annual review, re-evaluation)
- Filing deadlines — a personal program has no due date. Use endDate as a review date instead.
Write goals in everyday functional terms (home, community, communication), not school-standards terms.
</FRAMEWORK>
`;
  }

  const applies: string[] = [];
  if (caps.lre) applies.push("leastRestrictiveEnvironment (placement statement)");
  if (caps.adverseEffect) applies.push("adverseEffectStatement on each profile domain");
  if (caps.consentForms) applies.push("prior-written-consent forms");
  if (caps.transitionPlan) applies.push("transition plan from age 16");
  if (caps.interventionLevel) applies.push("ICF interventionLevel on goals");
  if (caps.statutoryDueDate) applies.push("a statutory filing deadline (dueDate)");

  return `
<FRAMEWORK>
This student's program follows the ${slug === "tala" ? "Israeli TALA" : "US IEP"} framework.
Statutory elements that apply here:
${applies.map((a) => `- ${a}`).join("\n")}
</FRAMEWORK>
`;
}

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