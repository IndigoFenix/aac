/**
 * reports-memory-schema.ts
 * 
 * Memory field schema and database operations for medical, functional, and educational reports.
 * Used by progress-mode-integration.ts when reports are enabled.
 * 
 * FIXES APPLIED:
 * 1. Context_Reports has `opened: true` so it loads automatically during initialization
 * 2. Write operations validate fields and map common AI mistakes (e.g., "condition" -> "primaryDiagnosis")
 * 3. Write operations have upsert semantics (create if not exists)
 * 4. Parent Context_Reports has a read operation that loads all children at once
 */

import { eq, and, or, desc } from "drizzle-orm";
import { db } from "../../db";
import {
  medicalRecords,
  functionalReports,
  educationalReports,
  type MedicalRecord,
  type FunctionalReport,
  type EducationalReport,
  type InsertMedicalRecord,
  type InsertFunctionalReport,
  type InsertEducationalReport,
  type AgentMemoryField,
} from "@shared/schema";

import {
  type AgentMemoryFieldWithDB,
  type AgentMemoryFieldObjectWithDB,
  type AgentMemoryFieldArrayWithDB,
  type MemoryDBOperations,
  type DBOperationContext,
  type PaginationParams,
  type ListResult,
} from "../chat/memory-db-bridge";

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

// ============================================================================
// FIELD VALIDATION AND MAPPING
// ============================================================================

/**
 * Valid fields for medical records (excluding auto-managed fields)
 */
const MEDICAL_RECORD_FIELDS = new Set([
  'id', 'status',
  'birthDate', 'primaryDiagnosis', 'primaryDiagnosisCode',
  'coMorbidities', 'secondaryDiagnoses',
  'alertsAllergies', 'alertsSeizures', 'alertsCardiac',
  'medications', 'medicalEquipment',
]);

/**
 * Field mappings for common AI mistakes (medical records)
 * Maps incorrect field names to correct schema field names
 */
const MEDICAL_FIELD_MAPPINGS: Record<string, string> = {
  // Diagnosis-related
  'condition': 'primaryDiagnosis',
  'diagnosis': 'primaryDiagnosis',
  'mainDiagnosis': 'primaryDiagnosis',
  'primaryCondition': 'primaryDiagnosis',
  'medicalCondition': 'primaryDiagnosis',
  'icdCode': 'primaryDiagnosisCode',
  'diagnosisCode': 'primaryDiagnosisCode',
  
  // Co-morbidities
  'comorbidities': 'coMorbidities',
  'comorbitities': 'coMorbidities', // Common typo
  'otherConditions': 'coMorbidities',
  
  // Alerts
  'allergies': 'alertsAllergies',
  'allergy': 'alertsAllergies',
  'seizures': 'alertsSeizures',
  'seizure': 'alertsSeizures',
  'seizureAlerts': 'alertsSeizures',
  'cardiac': 'alertsCardiac',
  'cardiacAlerts': 'alertsCardiac',
  'heartCondition': 'alertsCardiac',
  
  // Medications
  'meds': 'medications',
  'medication': 'medications',
  'drugs': 'medications',
  'prescriptions': 'medications',
  
  // Equipment
  'equipment': 'medicalEquipment',
  'devices': 'medicalEquipment',
  'medicalDevices': 'medicalEquipment',
  
  // Secondary
  'diagnoses': 'secondaryDiagnoses',
  'otherDiagnoses': 'secondaryDiagnoses',
};

/**
 * Valid fields for functional reports
 */
const FUNCTIONAL_REPORT_FIELDS = new Set([
  'id', 'status',
  'mobilityStatus', 'adlStatus', 'sensoryProfile', 'safetyRisks',
]);

/**
 * Field mappings for common AI mistakes (functional reports)
 */
const FUNCTIONAL_FIELD_MAPPINGS: Record<string, string> = {
  'mobility': 'mobilityStatus',
  'physicalStatus': 'mobilityStatus',
  'motorSkills': 'mobilityStatus',
  'adl': 'adlStatus',
  'dailyLiving': 'adlStatus',
  'activitiesOfDailyLiving': 'adlStatus',
  'sensory': 'sensoryProfile',
  'sensoryNeeds': 'sensoryProfile',
  'sensoryProcessing': 'sensoryProfile',
  'safety': 'safetyRisks',
  'risks': 'safetyRisks',
  'safetyConsiderations': 'safetyRisks',
  'safetyConcerns': 'safetyRisks',
};

/**
 * Valid fields for educational reports
 */
const EDUCATIONAL_REPORT_FIELDS = new Set([
  'id', 'status',
  'communicationMode', 'receptiveLanguage', 'assistiveTechnologyUsed',
  'reinforcers', 'preferredActivities', 'behavioralStrategies',
]);

/**
 * Field mappings for common AI mistakes (educational reports)
 */
const EDUCATIONAL_FIELD_MAPPINGS: Record<string, string> = {
  'communication': 'communicationMode',
  'communicationModes': 'communicationMode',
  'commMode': 'communicationMode',
  'language': 'receptiveLanguage',
  'receptive': 'receptiveLanguage',
  'languageAbilities': 'receptiveLanguage',
  'technology': 'assistiveTechnologyUsed',
  'assistiveTechnology': 'assistiveTechnologyUsed',
  'at': 'assistiveTechnologyUsed',
  'devices': 'assistiveTechnologyUsed',
  'rewards': 'reinforcers',
  'motivators': 'reinforcers',
  'preferredRewards': 'reinforcers',
  'activities': 'preferredActivities',
  'interests': 'preferredActivities',
  'favoriteActivities': 'preferredActivities',
  'behavior': 'behavioralStrategies',
  'strategies': 'behavioralStrategies',
  'behaviorStrategies': 'behavioralStrategies',
  'behavioralSupports': 'behavioralStrategies',
};

/**
 * Array fields that should wrap single values
 */
const ARRAY_FIELDS = new Set([
  'coMorbidities', 'secondaryDiagnoses', 
  'alertsAllergies', 'alertsSeizures', 'alertsCardiac',
  'medications', 'medicalEquipment',
  'mobilityStatus', 'adlStatus', 'sensoryProfile', 'safetyRisks',
  'communicationMode', 'receptiveLanguage', 'assistiveTechnologyUsed',
  'reinforcers', 'preferredActivities', 'behavioralStrategies',
]);

/**
 * Sanitize incoming value by:
 * 1. Mapping field names to correct schema names
 * 2. Filtering out invalid fields
 * 3. Wrapping single values in arrays for array fields
 */
function sanitizeValue(
  value: Record<string, any>,
  validFields: Set<string>,
  mappings: Record<string, string>
): Record<string, any> {
  const result: Record<string, any> = {};
  
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined) continue;
    
    // Check if field needs mapping (case-insensitive)
    const lowerKey = key.toLowerCase();
    const mappedKey = mappings[lowerKey] || mappings[key] || key;
    
    // Only include valid fields
    if (validFields.has(mappedKey)) {
      // If it's an array field and value is not an array, wrap it
      if (ARRAY_FIELDS.has(mappedKey)) {
        if (val !== null && !Array.isArray(val)) {
          result[mappedKey] = [val];
        } else {
          result[mappedKey] = val;
        }
      } else {
        result[mappedKey] = val;
      }
    } else {
      console.log(`[sanitizeValue] Filtered out invalid field: ${key} (mapped to: ${mappedKey})`);
    }
  }
  
  console.log(`[sanitizeValue] Input:`, value);
  console.log(`[sanitizeValue] Output:`, result);
  
  return result;
}

// ============================================================================
// DATABASE OPERATIONS - MEDICAL RECORDS
// ============================================================================

/**
 * Get current medical record for student
 */
async function getCurrentMedicalRecord(
  studentId: string,
  instituteId?: string
): Promise<MedicalRecord | undefined> {
  const whereClause = instituteId
    ? and(
        eq(medicalRecords.studentId, studentId),
        eq(medicalRecords.instituteId, instituteId),
        or(
          eq(medicalRecords.status, "draft"),
          eq(medicalRecords.status, "pending_review")
        )
      )
    : and(
        eq(medicalRecords.studentId, studentId),
        or(
          eq(medicalRecords.status, "draft"),
          eq(medicalRecords.status, "pending_review")
        )
      );

  const [record] = await db
    .select()
    .from(medicalRecords)
    .where(whereClause)
    .orderBy(desc(medicalRecords.createdAt))
    .limit(1);

  return record;
}

/**
 * Medical record read operation
 */
const medicalRecordReadOp = async (ctx: DBOperationContext) => {
  const studentId = ctx.all.studentId;
  const instituteId = ctx.all.instituteId;
  
  if (!studentId) throw new Error("studentId required for medical record query");

  console.log(`[medicalRecordReadOp] Loading for studentId: ${studentId}, instituteId: ${instituteId}`);
  const record = await getCurrentMedicalRecord(studentId, instituteId);
  console.log(`[medicalRecordReadOp] Found:`, record ? `id=${record.id}` : 'null');
  
  return record;
};

/**
 * Medical record write operation with upsert semantics and field validation.
 * Returns the saved record so in-memory state can be updated with actual DB values.
 */
const medicalRecordWriteOp = async (ctx: DBOperationContext, value: any): Promise<MedicalRecord | undefined> => {
  const studentId = ctx.all.studentId;
  const userId = ctx.all.userId;
  const instituteId = ctx.all.instituteId;
  
  if (!studentId) throw new Error("studentId required for medical record write");

  console.log(`[medicalRecordWriteOp] Writing for studentId: ${studentId}`);
  console.log(`[medicalRecordWriteOp] Raw value:`, value);

  // Sanitize the incoming value
  const sanitizedValue = sanitizeValue(value, MEDICAL_RECORD_FIELDS, MEDICAL_FIELD_MAPPINGS);
  
  if (Object.keys(sanitizedValue).length === 0) {
    console.log(`[medicalRecordWriteOp] No valid fields to save after sanitization`);
    return undefined;
  }
  
  // Check if we have an existing record
  const existing = await getCurrentMedicalRecord(studentId, instituteId);
  
  if (existing) {
    console.log(`[medicalRecordWriteOp] Updating existing record: ${existing.id}`);
    
    // Update existing record - merge with new values
    if (existing.status === "final" || existing.status === "superseded") {
      throw new Error("Cannot update a finalized or superseded record. Create a new revision instead.");
    }
    
    // Merge new values with existing, excluding id and relationship fields
    const updateData: Record<string, any> = { updatedAt: new Date() };
    for (const [key, val] of Object.entries(sanitizedValue)) {
      if (val !== undefined && key !== 'id') {
        // For array fields, merge with existing
        if (ARRAY_FIELDS.has(key) && Array.isArray(val) && Array.isArray(existing[key as keyof MedicalRecord])) {
          const existingArray = existing[key as keyof MedicalRecord] as string[];
          const newItems = val.filter((item: string) => !existingArray.includes(item));
          updateData[key] = [...existingArray, ...newItems];
        } else {
          updateData[key] = val;
        }
      }
    }
    
    console.log(`[medicalRecordWriteOp] Update data:`, updateData);
    
    await db
      .update(medicalRecords)
      .set(updateData)
      .where(eq(medicalRecords.id, existing.id));
      
    // Return the updated record
    const [updated] = await db
      .select()
      .from(medicalRecords)
      .where(eq(medicalRecords.id, existing.id));
      
    console.log(`[medicalRecordWriteOp] Updated record:`, updated);
    return updated;
  } else {
    console.log(`[medicalRecordWriteOp] Creating new record`);
    
    // Create new record
    const insertData: InsertMedicalRecord = {
      studentId,
      userId: userId || null,
      instituteId: instituteId || null,
      status: "draft",
      // Set defaults for array fields
      coMorbidities: [],
      secondaryDiagnoses: [],
      alertsAllergies: [],
      alertsSeizures: [],
      alertsCardiac: [],
      medications: [],
      medicalEquipment: [],
      // Override with sanitized values
      ...sanitizedValue,
    };
    
    console.log(`[medicalRecordWriteOp] Insert data:`, insertData);
    
    const [inserted] = await db
      .insert(medicalRecords)
      .values(insertData)
      .returning();
      
    console.log(`[medicalRecordWriteOp] Inserted record:`, inserted);
    return inserted;
  }
};

/**
 * Create medical record operations with optional readonly mode
 */
function createMedicalRecordOps(readonly: boolean = false): MemoryDBOperations<MedicalRecord> {
  const ops: MemoryDBOperations<MedicalRecord> = {
    read: medicalRecordReadOp,
    fromDB: (record) => toMemoryValue(record),
    extractChildContext: (value) => ({
      medicalRecordId: value?.id,
    }),
    getDBKey: (value) => value.id,
  };

  if (!readonly) {
    ops.write = medicalRecordWriteOp;
  }

  return ops;
}

/**
 * Archived medical records list operation (always read-only)
 */
const archivedMedicalRecordsListOp = async (
  ctx: DBOperationContext,
  { offset, limit }: PaginationParams
): Promise<ListResult<MedicalRecord>> => {
  const studentId = ctx.all.studentId;
  const instituteId = ctx.all.instituteId;
  
  if (!studentId) throw new Error("studentId required for archived medical records query");

  const whereClause = instituteId
    ? and(
        eq(medicalRecords.studentId, studentId),
        eq(medicalRecords.instituteId, instituteId),
        or(
          eq(medicalRecords.status, "final"),
          eq(medicalRecords.status, "superseded")
        )
      )
    : and(
        eq(medicalRecords.studentId, studentId),
        or(
          eq(medicalRecords.status, "final"),
          eq(medicalRecords.status, "superseded")
        )
      );

  const items = await db
    .select()
    .from(medicalRecords)
    .where(whereClause)
    .orderBy(desc(medicalRecords.finalizedAt))
    .offset(offset)
    .limit(limit);

  const allItems = await db
    .select()
    .from(medicalRecords)
    .where(whereClause);

  return { items, total: allItems.length };
};

const archivedMedicalRecordsOps: MemoryDBOperations<MedicalRecord> = {
  list: archivedMedicalRecordsListOp,
  fromDB: (record) => toMemoryValue(record),
  getDBKey: (value) => value.id,
};

// ============================================================================
// DATABASE OPERATIONS - FUNCTIONAL REPORTS
// ============================================================================

/**
 * Get current functional report for student
 */
async function getCurrentFunctionalReport(studentId: string): Promise<FunctionalReport | undefined> {
  const [report] = await db
    .select()
    .from(functionalReports)
    .where(
      and(
        eq(functionalReports.studentId, studentId),
        or(
          eq(functionalReports.status, "draft"),
          eq(functionalReports.status, "pending_review")
        )
      )
    )
    .orderBy(desc(functionalReports.createdAt))
    .limit(1);

  return report;
}

/**
 * Functional report read operation
 */
const functionalReportReadOp = async (ctx: DBOperationContext) => {
  const studentId = ctx.all.studentId;
  if (!studentId) throw new Error("studentId required for functional report query");

  console.log(`[functionalReportReadOp] Loading for studentId: ${studentId}`);
  const report = await getCurrentFunctionalReport(studentId);
  console.log(`[functionalReportReadOp] Found:`, report ? `id=${report.id}` : 'null');
  
  return report;
};

/**
 * Functional report write operation with upsert semantics and field validation.
 * Returns the saved record so in-memory state can be updated with actual DB values.
 */
const functionalReportWriteOp = async (ctx: DBOperationContext, value: any): Promise<FunctionalReport | undefined> => {
  const studentId = ctx.all.studentId;
  const userId = ctx.all.userId;
  const instituteId = ctx.all.instituteId;
  const programId = ctx.all.programId;
  
  if (!studentId) throw new Error("studentId required for functional report write");

  console.log(`[functionalReportWriteOp] Writing for studentId: ${studentId}`);
  console.log(`[functionalReportWriteOp] Raw value:`, value);

  // Sanitize the incoming value
  const sanitizedValue = sanitizeValue(value, FUNCTIONAL_REPORT_FIELDS, FUNCTIONAL_FIELD_MAPPINGS);
  
  if (Object.keys(sanitizedValue).length === 0) {
    console.log(`[functionalReportWriteOp] No valid fields to save after sanitization`);
    return undefined;
  }
  
  // Check if we have an existing report
  const existing = await getCurrentFunctionalReport(studentId);
  
  if (existing) {
    console.log(`[functionalReportWriteOp] Updating existing report: ${existing.id}`);
    
    if (existing.status === "final" || existing.status === "superseded") {
      throw new Error("Cannot update a finalized or superseded report. Create a new revision instead.");
    }
    
    const updateData: Record<string, any> = { updatedAt: new Date() };
    for (const [key, val] of Object.entries(sanitizedValue)) {
      if (val !== undefined && key !== 'id') {
        if (ARRAY_FIELDS.has(key) && Array.isArray(val) && Array.isArray(existing[key as keyof FunctionalReport])) {
          const existingArray = existing[key as keyof FunctionalReport] as string[];
          const newItems = val.filter((item: string) => !existingArray.includes(item));
          updateData[key] = [...existingArray, ...newItems];
        } else {
          updateData[key] = val;
        }
      }
    }
    
    await db
      .update(functionalReports)
      .set(updateData)
      .where(eq(functionalReports.id, existing.id));
      
    const [updated] = await db
      .select()
      .from(functionalReports)
      .where(eq(functionalReports.id, existing.id));
    return updated;
  } else {
    console.log(`[functionalReportWriteOp] Creating new report`);
    
    const insertData: InsertFunctionalReport = {
      studentId,
      userId: userId || null,
      instituteId: instituteId || null,
      programId: programId || null,
      status: "draft",
      mobilityStatus: [],
      adlStatus: [],
      sensoryProfile: [],
      safetyRisks: [],
      ...sanitizedValue,
    };
    
    const [inserted] = await db
      .insert(functionalReports)
      .values(insertData)
      .returning();
      
    return inserted;
  }
};

/**
 * Create functional report operations with optional readonly mode
 */
function createFunctionalReportOps(readonly: boolean = false): MemoryDBOperations<FunctionalReport> {
  const ops: MemoryDBOperations<FunctionalReport> = {
    read: functionalReportReadOp,
    fromDB: (record) => toMemoryValue(record),
    extractChildContext: (value) => ({
      functionalReportId: value?.id,
    }),
    getDBKey: (value) => value.id,
  };

  if (!readonly) {
    ops.write = functionalReportWriteOp;
  }

  return ops;
}

/**
 * Archived functional reports list operation (always read-only)
 */
const archivedFunctionalReportsListOp = async (
  ctx: DBOperationContext,
  { offset, limit }: PaginationParams
): Promise<ListResult<FunctionalReport>> => {
  const studentId = ctx.all.studentId;
  if (!studentId) throw new Error("studentId required for archived functional reports query");

  const whereClause = and(
    eq(functionalReports.studentId, studentId),
    or(
      eq(functionalReports.status, "final"),
      eq(functionalReports.status, "superseded")
    )
  );

  const items = await db
    .select()
    .from(functionalReports)
    .where(whereClause)
    .orderBy(desc(functionalReports.finalizedAt))
    .offset(offset)
    .limit(limit);

  const allItems = await db
    .select()
    .from(functionalReports)
    .where(whereClause);

  return { items, total: allItems.length };
};

const archivedFunctionalReportsOps: MemoryDBOperations<FunctionalReport> = {
  list: archivedFunctionalReportsListOp,
  fromDB: (record) => toMemoryValue(record),
  getDBKey: (value) => value.id,
};

// ============================================================================
// DATABASE OPERATIONS - EDUCATIONAL REPORTS
// ============================================================================

/**
 * Get current educational report for student
 */
async function getCurrentEducationalReport(studentId: string): Promise<EducationalReport | undefined> {
  const [report] = await db
    .select()
    .from(educationalReports)
    .where(
      and(
        eq(educationalReports.studentId, studentId),
        or(
          eq(educationalReports.status, "draft"),
          eq(educationalReports.status, "pending_review")
        )
      )
    )
    .orderBy(desc(educationalReports.createdAt))
    .limit(1);

  return report;
}

/**
 * Educational report read operation
 */
const educationalReportReadOp = async (ctx: DBOperationContext) => {
  const studentId = ctx.all.studentId;
  if (!studentId) throw new Error("studentId required for educational report query");

  console.log(`[educationalReportReadOp] Loading for studentId: ${studentId}`);
  const report = await getCurrentEducationalReport(studentId);
  console.log(`[educationalReportReadOp] Found:`, report ? `id=${report.id}` : 'null');
  
  return report;
};

/**
 * Educational report write operation with upsert semantics and field validation.
 * Returns the saved record so in-memory state can be updated with actual DB values.
 */
const educationalReportWriteOp = async (ctx: DBOperationContext, value: any): Promise<EducationalReport | undefined> => {
  const studentId = ctx.all.studentId;
  const userId = ctx.all.userId;
  const instituteId = ctx.all.instituteId;
  const programId = ctx.all.programId;
  
  if (!studentId) throw new Error("studentId required for educational report write");

  console.log(`[educationalReportWriteOp] Writing for studentId: ${studentId}`);
  console.log(`[educationalReportWriteOp] Raw value:`, value);

  // Sanitize the incoming value
  const sanitizedValue = sanitizeValue(value, EDUCATIONAL_REPORT_FIELDS, EDUCATIONAL_FIELD_MAPPINGS);
  
  if (Object.keys(sanitizedValue).length === 0) {
    console.log(`[educationalReportWriteOp] No valid fields to save after sanitization`);
    return undefined;
  }
  
  // Check if we have an existing report
  const existing = await getCurrentEducationalReport(studentId);
  
  if (existing) {
    console.log(`[educationalReportWriteOp] Updating existing report: ${existing.id}`);
    
    if (existing.status === "final" || existing.status === "superseded") {
      throw new Error("Cannot update a finalized or superseded report. Create a new revision instead.");
    }
    
    const updateData: Record<string, any> = { updatedAt: new Date() };
    for (const [key, val] of Object.entries(sanitizedValue)) {
      if (val !== undefined && key !== 'id') {
        if (ARRAY_FIELDS.has(key) && Array.isArray(val) && Array.isArray(existing[key as keyof EducationalReport])) {
          const existingArray = existing[key as keyof EducationalReport] as string[];
          const newItems = val.filter((item: string) => !existingArray.includes(item));
          updateData[key] = [...existingArray, ...newItems];
        } else {
          updateData[key] = val;
        }
      }
    }
    
    await db
      .update(educationalReports)
      .set(updateData)
      .where(eq(educationalReports.id, existing.id));
      
    const [updated] = await db
      .select()
      .from(educationalReports)
      .where(eq(educationalReports.id, existing.id));
    return updated;
  } else {
    console.log(`[educationalReportWriteOp] Creating new report`);
    
    const insertData: InsertEducationalReport = {
      studentId,
      userId: userId || null,
      instituteId: instituteId || null,
      programId: programId || null,
      status: "draft",
      communicationMode: [],
      receptiveLanguage: [],
      assistiveTechnologyUsed: [],
      reinforcers: [],
      preferredActivities: [],
      behavioralStrategies: [],
      ...sanitizedValue,
    };
    
    const [inserted] = await db
      .insert(educationalReports)
      .values(insertData)
      .returning();
      
    return inserted;
  }
};

/**
 * Create educational report operations with optional readonly mode
 */
function createEducationalReportOps(readonly: boolean = false): MemoryDBOperations<EducationalReport> {
  const ops: MemoryDBOperations<EducationalReport> = {
    read: educationalReportReadOp,
    fromDB: (record) => toMemoryValue(record),
    extractChildContext: (value) => ({
      educationalReportId: value?.id,
    }),
    getDBKey: (value) => value.id,
  };

  if (!readonly) {
    ops.write = educationalReportWriteOp;
  }

  return ops;
}

/**
 * Archived educational reports list operation (always read-only)
 */
const archivedEducationalReportsListOp = async (
  ctx: DBOperationContext,
  { offset, limit }: PaginationParams
): Promise<ListResult<EducationalReport>> => {
  const studentId = ctx.all.studentId;
  if (!studentId) throw new Error("studentId required for archived educational reports query");

  const whereClause = and(
    eq(educationalReports.studentId, studentId),
    or(
      eq(educationalReports.status, "final"),
      eq(educationalReports.status, "superseded")
    )
  );

  const items = await db
    .select()
    .from(educationalReports)
    .where(whereClause)
    .orderBy(desc(educationalReports.finalizedAt))
    .offset(offset)
    .limit(limit);

  const allItems = await db
    .select()
    .from(educationalReports)
    .where(whereClause);

  return { items, total: allItems.length };
};

const archivedEducationalReportsOps: MemoryDBOperations<EducationalReport> = {
  list: archivedEducationalReportsListOp,
  fromDB: (record) => toMemoryValue(record),
  getDBKey: (value) => value.id,
};

// ============================================================================
// PARENT CONTEXT_REPORTS OPERATIONS
// ============================================================================

/**
 * Read operation for the parent Context_Reports object.
 * This loads all current reports at once when the parent becomes visible.
 */
const reportsContextReadOp = async (ctx: DBOperationContext) => {
  const studentId = ctx.all.studentId;
  const instituteId = ctx.all.instituteId;
  
  if (!studentId) throw new Error("studentId required for reports context read");

  console.log(`[reportsContextReadOp] Loading all reports for studentId: ${studentId}`);

  // Load all current reports in parallel
  const [medicalRecord, functionalReport, educationalReport] = await Promise.all([
    getCurrentMedicalRecord(studentId, instituteId),
    getCurrentFunctionalReport(studentId),
    getCurrentEducationalReport(studentId),
  ]);

  console.log(`[reportsContextReadOp] Found: medical=${medicalRecord?.id ?? 'null'}, functional=${functionalReport?.id ?? 'null'}, educational=${educationalReport?.id ?? 'null'}`);

  // Return structured object with current reports
  const result: Record<string, any> = {};
  
  if (medicalRecord) {
    result.medicalRecord = toMemoryValue(medicalRecord);
  }
  if (functionalReport) {
    result.functionalReport = toMemoryValue(functionalReport);
  }
  if (educationalReport) {
    result.educationalReport = toMemoryValue(educationalReport);
  }

  return result;
};

/**
 * Operations for the parent Context_Reports object
 */
const reportsContextOps: MemoryDBOperations<any> = {
  read: reportsContextReadOp,
  // No write at parent level - writes go through children
};

// ============================================================================
// FIELD FACTORY FUNCTIONS
// ============================================================================

/**
 * Create a medical record field with optional readonly mode
 */
export function createMedicalRecordField(readonly: boolean = false): AgentMemoryFieldObjectWithDB {
  const accessNote = readonly ? " (read-only)" : "";
  return {
    id: "medicalRecord",
    type: "object",
    title: "Medical Record" + accessNote,
    description: `Current medical record for the student${accessNote}. Contains diagnoses, allergies, medications, and medical alerts.`,
    opened: false,
    properties: {
      id: { id: "id", type: "string" },
      status: {
        id: "status",
        type: "string",
        enum: ["draft", "pending_review", "final", "superseded"],
        description: "Report status - only draft and pending_review can be edited",
      },
      primaryDiagnosis: { id: "primaryDiagnosis", type: "string", description: "Primary medical diagnosis" },
      primaryDiagnosisCode: { id: "primaryDiagnosisCode", type: "string", description: "ICD code for primary diagnosis" },
      coMorbidities: {
        id: "coMorbidities",
        type: "array",
        items: { id: "item", type: "string" },
        description: "List of co-morbid conditions",
      },
      secondaryDiagnoses: {
        id: "secondaryDiagnoses",
        type: "array",
        items: { id: "item", type: "string" },
        description: "Secondary diagnoses",
      },
      alertsAllergies: {
        id: "alertsAllergies",
        type: "array",
        items: { id: "item", type: "string" },
        description: "Allergies and alerts",
      },
      alertsSeizures: {
        id: "alertsSeizures",
        type: "array",
        items: { id: "item", type: "string" },
        description: "Seizure-related alerts",
      },
      alertsCardiac: {
        id: "alertsCardiac",
        type: "array",
        items: { id: "item", type: "string" },
        description: "Cardiac-related alerts",
      },
      medications: {
        id: "medications",
        type: "array",
        items: { id: "item", type: "string" },
        description: "Current medications",
      },
      medicalEquipment: {
        id: "medicalEquipment",
        type: "array",
        items: { id: "item", type: "string" },
        description: "Required medical equipment",
      },
    },
    db: createMedicalRecordOps(readonly),
  };
}

/**
 * Create an archived medical records field (always read-only)
 */
export function createArchivedMedicalRecordsField(): AgentMemoryFieldArrayWithDB {
  return {
    id: "archivedMedicalRecords",
    type: "array",
    title: "Archived Medical Records",
    description: "Previously finalized medical records (read-only). View these to see historical medical information.",
    opened: false,
    items: createMedicalRecordField(true),
    db: archivedMedicalRecordsOps,
  };
}

/**
 * Create a functional report field with optional readonly mode
 */
export function createFunctionalReportField(readonly: boolean = false): AgentMemoryFieldObjectWithDB {
  const accessNote = readonly ? " (read-only)" : "";
  return {
    id: "functionalReport",
    type: "object",
    title: "Functional Report" + accessNote,
    description: `Current functional report for the student${accessNote}. Contains mobility, ADL status, sensory profile, and safety risks.`,
    opened: false,
    properties: {
      id: { id: "id", type: "string" },
      status: {
        id: "status",
        type: "string",
        enum: ["draft", "pending_review", "final", "superseded"],
      },
      mobilityStatus: {
        id: "mobilityStatus",
        type: "array",
        items: { id: "item", type: "string" },
        description: "Mobility and physical status",
      },
      adlStatus: {
        id: "adlStatus",
        type: "array",
        items: { id: "item", type: "string" },
        description: "Activities of Daily Living (ADL) status",
      },
      sensoryProfile: {
        id: "sensoryProfile",
        type: "array",
        items: { id: "item", type: "string" },
        description: "Sensory processing profile",
      },
      safetyRisks: {
        id: "safetyRisks",
        type: "array",
        items: { id: "item", type: "string" },
        description: "Safety risks and concerns",
      },
    },
    db: createFunctionalReportOps(readonly),
  };
}

/**
 * Create an archived functional reports field (always read-only)
 */
export function createArchivedFunctionalReportsField(): AgentMemoryFieldArrayWithDB {
  return {
    id: "archivedFunctionalReports",
    type: "array",
    title: "Archived Functional Reports",
    description: "Previously finalized functional reports (read-only).",
    opened: false,
    items: createFunctionalReportField(true),
    db: archivedFunctionalReportsOps,
  };
}

/**
 * Create an educational report field with optional readonly mode
 */
export function createEducationalReportField(readonly: boolean = false): AgentMemoryFieldObjectWithDB {
  const accessNote = readonly ? " (read-only)" : "";
  return {
    id: "educationalReport",
    type: "object",
    title: "Educational Report" + accessNote,
    description: `Current educational report for the student${accessNote}. Contains communication modes, language abilities, technology used, and behavioral strategies.`,
    opened: false,
    properties: {
      id: { id: "id", type: "string" },
      status: {
        id: "status",
        type: "string",
        enum: ["draft", "pending_review", "final", "superseded"],
      },
      communicationMode: {
        id: "communicationMode",
        type: "array",
        items: { id: "item", type: "string" },
        description: "Communication modes used by the student",
      },
      receptiveLanguage: {
        id: "receptiveLanguage",
        type: "array",
        items: { id: "item", type: "string" },
        description: "Receptive language abilities",
      },
      assistiveTechnologyUsed: {
        id: "assistiveTechnologyUsed",
        type: "array",
        items: { id: "item", type: "string" },
        description: "Assistive technology in use",
      },
      reinforcers: {
        id: "reinforcers",
        type: "array",
        items: { id: "item", type: "string" },
        description: "Effective reinforcers for the student",
      },
      preferredActivities: {
        id: "preferredActivities",
        type: "array",
        items: { id: "item", type: "string" },
        description: "Preferred activities",
      },
      behavioralStrategies: {
        id: "behavioralStrategies",
        type: "array",
        items: { id: "item", type: "string" },
        description: "Effective behavioral strategies",
      },
    },
    db: createEducationalReportOps(readonly),
  };
}

/**
 * Create an archived educational reports field (always read-only)
 */
export function createArchivedEducationalReportsField(): AgentMemoryFieldArrayWithDB {
  return {
    id: "archivedEducationalReports",
    type: "array",
    title: "Archived Educational Reports",
    description: "Previously finalized educational reports (read-only).",
    opened: false,
    items: createEducationalReportField(true),
    db: archivedEducationalReportsOps,
  };
}

// ============================================================================
// MAIN REPORTS FIELD
// ============================================================================

/**
 * The main Context_Reports memory field
 * 
 * KEY: `opened: true` ensures this is loaded automatically during initialization,
 * so the AI sees the actual field names and existing data.
 */
export const REPORTS_CONTEXT_FIELD: AgentMemoryFieldObjectWithDB = {
  id: "Context_Reports",
  type: "object",
  title: "Student Reports",
  description: "Medical, functional, and educational reports for the student. Current reports can be viewed and edited. Archived reports are read-only.",
  opened: true, // AUTO-LOAD: This ensures reports are loaded during initialization
  properties: {
    medicalRecord: createMedicalRecordField(false),
    functionalReport: createFunctionalReportField(false),
    educationalReport: createEducationalReportField(false),
    archivedMedicalRecords: createArchivedMedicalRecordsField(),
    archivedFunctionalReports: createArchivedFunctionalReportsField(),
    archivedEducationalReports: createArchivedEducationalReportsField(),
  },
  db: reportsContextOps, // Parent has read operation to load all children
};

// ============================================================================
// SYSTEM PROMPTS
// ============================================================================

export const REPORTS_SYSTEM_PROMPT = `You are an expert Individualized Education Program assistant.

You help healthcare professionals, educators, and caregivers manage student reports including:
- Medical records (diagnoses, allergies, medications, alerts)
- Functional reports (mobility, ADLs, sensory profile, safety)
- Educational reports (communication, technology, behavioral strategies)

## Report Structure

Reports are stored at /Context_Reports with this structure:
- **medicalRecord** (object) - Current medical record (editable if draft/pending_review)
  - primaryDiagnosis, coMorbidities, allergies, medications, etc.
- **functionalReport** (object) - Current functional report
  - mobilityStatus, adlStatus, sensoryProfile, safetyRisks
- **educationalReport** (object) - Current educational report
  - communicationMode, receptiveLanguage, assistiveTechnology, reinforcers, behavioralStrategies
- **archivedMedicalRecords** (array) - Past medical records (read-only)
- **archivedFunctionalReports** (array) - Past functional reports (read-only)
- **archivedEducationalReports** (array) - Past educational reports (read-only)

Use the memory operations described below to interact with data related to records and reports.
`;

// ============================================================================
// LEGACY EXPORTS
// ============================================================================

export { REPORTS_CONTEXT_FIELD as REPORTS_MEMORY_FIELD };

/**
 * Get the complete memory fields for reports mode (standalone, legacy)
 */
export function getReportsMemoryFields(masterFields: AgentMemoryFieldWithDB[]): AgentMemoryFieldWithDB[] {
  return [...masterFields, REPORTS_CONTEXT_FIELD];
}