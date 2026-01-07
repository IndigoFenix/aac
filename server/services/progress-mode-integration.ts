/**
 * progress-mode-integration.ts
 * 
 * UNIFIED Integration layer for progress mode in sessionService.
 * Includes both IEP/TALA program data AND student reports (medical, functional, educational).
 * 
 * This file provides:
 * 1. ProgressModeManager - manages program AND reports data lifecycle
 * 2. Permission-based access control for each report type
 * 3. Integration with the memory-db-bridge system
 * 4. Helper functions for sessionService
 * 
 * MIGRATION NOTE: This replaces both the old progress-mode-integration.ts and 
 * reports-mode-integration.ts. The reports functionality is now integrated into
 * progress mode with permission-based access control.
 */

import { eq, and, desc, or } from "drizzle-orm";
import { db } from "../db";
import {
  programs,
  students,
  medicalRecords,
  functionalReports,
  educationalReports,
  type Program,
  type Student,
  type MedicalRecord,
  type FunctionalReport,
  type EducationalReport,
  type AgentMemoryField,
} from "@shared/schema";

import {
  type AgentMemoryFieldWithDB,
  type AgentMemoryFieldObjectWithDB,
  type MemoryLoadState,
  type DBOperationContext,
  createMemoryLoadState,
  populateMemoryFromDB,
  processMemoryToolWithDB,
  createDBContext,
} from "./chat/memory-db-bridge";

import {
  PROGRESS_PROGRAM_FIELD,
  PROGRESS_SYSTEM_PROMPT,
  getProgressMemoryFields as getBaseProgressMemoryFields,
} from "./progress-memory-schema";

import {
  createMedicalRecordField,
  createFunctionalReportField,
  createEducationalReportField,
  createArchivedMedicalRecordsField,
  createArchivedFunctionalReportsField,
  createArchivedEducationalReportsField,
  REPORTS_SYSTEM_PROMPT,
} from "./reports-memory-schema";

// Re-export for convenience
export { PROGRESS_PROGRAM_FIELD, PROGRESS_SYSTEM_PROMPT };

// ============================================================================
// PERMISSION TYPES
// ============================================================================

/**
 * Permission level for a report type
 * - hidden: Not shown to AI at all (field not included in memory schema)
 * - readonly: AI can view but not modify (write operations disabled)
 * - editable: AI can view and modify
 */
export type ReportPermission = 'hidden' | 'readonly' | 'editable';

/**
 * Permissions for all report types
 */
export interface ReportPermissions {
  medical: ReportPermission;
  functional: ReportPermission;
  educational: ReportPermission;
}

/**
 * Default permissions - all hidden (safest default)
 * Override these based on user's hasMedicalRights / hasEducationalRights
 */
export const DEFAULT_REPORT_PERMISSIONS: ReportPermissions = {
  medical: 'hidden',
  functional: 'hidden',
  educational: 'hidden',
};

/**
 * Helper to determine report permissions based on user rights
 * This can be used in sessionService to convert user rights to permissions
 */
export function getReportPermissionsFromRights(
  hasMedicalRights: boolean = false,
  hasEducationalRights: boolean = false,
  canEdit: boolean = true // Set to false to make all visible reports read-only
): ReportPermissions {
  return {
    medical: hasMedicalRights ? (canEdit ? 'editable' : 'readonly') : 'hidden',
    functional: hasEducationalRights ? (canEdit ? 'editable' : 'readonly') : 'hidden',
    educational: hasEducationalRights ? (canEdit ? 'editable' : 'readonly') : 'hidden',
  };
}

// ============================================================================
// PROGRESS MODE MANAGER
// ============================================================================

export interface ProgressModeContext {
  studentId: string;
  userId?: string;
  programId?: string; // Optional - if not provided, will load current program
  instituteId?: string; // Optional - for filtering medical records by hospital
  reportPermissions?: ReportPermissions; // Optional - defaults to all hidden
}

export interface ProgressModeState {
  student: Student | null;
  program: Program | null;
  // Reports state
  medicalRecord: MedicalRecord | null;
  functionalReport: FunctionalReport | null;
  educationalReport: EducationalReport | null;
  // Memory state
  loadState: MemoryLoadState;
  baseContext: Record<string, any>;
  reportPermissions: ReportPermissions;
}

/**
 * Manages the progress mode lifecycle for a chat session.
 * Handles loading program data AND reports, syncing changes, and managing state.
 */
export class ProgressModeManager {
  private state: ProgressModeState;
  private memoryFields: AgentMemoryFieldWithDB[];

  constructor(
    private context: ProgressModeContext,
    masterMemoryFields: AgentMemoryFieldWithDB[] = [],
    existingLoadState?: MemoryLoadState
  ) {
    const permissions = context.reportPermissions ?? DEFAULT_REPORT_PERMISSIONS;
    
    // Build memory fields based on permissions
    this.memoryFields = this.buildMemoryFields(masterMemoryFields, permissions);
    
    this.state = {
      student: null,
      program: null,
      medicalRecord: null,
      functionalReport: null,
      educationalReport: null,
      loadState: existingLoadState ?? createMemoryLoadState(),
      baseContext: {
        studentId: context.studentId,
        userId: context.userId,
        instituteId: context.instituteId,
      },
      reportPermissions: permissions,
    };
  }

  /**
   * Build memory fields based on permissions
   * Combines base progress fields with permission-aware report fields
   */
  private buildMemoryFields(
    masterMemoryFields: AgentMemoryFieldWithDB[],
    permissions: ReportPermissions
  ): AgentMemoryFieldWithDB[] {
    // Start with base progress fields (master fields + Context_Program)
    const fields = getBaseProgressMemoryFields(masterMemoryFields);

    // Build reports context field with permission-aware sub-fields
    const reportsProperties: Record<string, AgentMemoryFieldWithDB> = {};

    // Medical records
    if (permissions.medical !== 'hidden') {
      const isReadonly = permissions.medical === 'readonly';
      reportsProperties.medicalRecord = createMedicalRecordField(isReadonly);
      reportsProperties.archivedMedicalRecords = createArchivedMedicalRecordsField();
    }

    // Functional reports
    if (permissions.functional !== 'hidden') {
      const isReadonly = permissions.functional === 'readonly';
      reportsProperties.functionalReport = createFunctionalReportField(isReadonly);
      reportsProperties.archivedFunctionalReports = createArchivedFunctionalReportsField();
    }

    // Educational reports
    if (permissions.educational !== 'hidden') {
      const isReadonly = permissions.educational === 'readonly';
      reportsProperties.educationalReport = createEducationalReportField(isReadonly);
      reportsProperties.archivedEducationalReports = createArchivedEducationalReportsField();
    }

    // Only add reports context if at least one report type is visible
    if (Object.keys(reportsProperties).length > 0) {
      const reportsContextField: AgentMemoryFieldObjectWithDB = {
        id: "Context_Reports",
        type: "object",
        title: "Student Reports",
        description: this.buildReportsDescription(permissions),
        opened: true, // Auto-load reports when visible
        properties: reportsProperties,
        // Parent read operation loads all children
        db: {
          read: async (ctx) => {
            const studentId = ctx.all.studentId;
            const instituteId = ctx.all.instituteId;
            if (!studentId) return {};
            
            const result: Record<string, any> = {};
            
            // Load reports based on permissions
            if (permissions.medical !== 'hidden') {
              const record = await this.loadMedicalRecord(studentId, instituteId);
              if (record) result.medicalRecord = record;
            }
            if (permissions.functional !== 'hidden') {
              const report = await this.loadFunctionalReport(studentId);
              if (report) result.functionalReport = report;
            }
            if (permissions.educational !== 'hidden') {
              const report = await this.loadEducationalReport(studentId);
              if (report) result.educationalReport = report;
            }
            
            return result;
          }
        }
      };
      fields.push(reportsContextField);
    }

    return fields;
  }

  /**
   * Build a description for the reports context based on permissions
   */
  private buildReportsDescription(permissions: ReportPermissions): string {
    const parts: string[] = [];
    
    if (permissions.medical === 'editable') {
      parts.push("Medical records (editable)");
    } else if (permissions.medical === 'readonly') {
      parts.push("Medical records (read-only)");
    }

    if (permissions.functional === 'editable') {
      parts.push("Functional reports (editable)");
    } else if (permissions.functional === 'readonly') {
      parts.push("Functional reports (read-only)");
    }

    if (permissions.educational === 'editable') {
      parts.push("Educational reports (editable)");
    } else if (permissions.educational === 'readonly') {
      parts.push("Educational reports (read-only)");
    }

    if (parts.length === 0) {
      return "No reports available.";
    }

    return `Available reports: ${parts.join(", ")}.`;
  }

  // Helper methods to load reports
  private async loadMedicalRecord(studentId: string, instituteId?: string): Promise<MedicalRecord | null> {
    const whereClause = instituteId
      ? and(
          eq(medicalRecords.studentId, studentId),
          eq(medicalRecords.instituteId, instituteId),
          or(eq(medicalRecords.status, "draft"), eq(medicalRecords.status, "pending_review"))
        )
      : and(
          eq(medicalRecords.studentId, studentId),
          or(eq(medicalRecords.status, "draft"), eq(medicalRecords.status, "pending_review"))
        );

    const [record] = await db
      .select()
      .from(medicalRecords)
      .where(whereClause)
      .orderBy(desc(medicalRecords.createdAt))
      .limit(1);

    return record || null;
  }

  private async loadFunctionalReport(studentId: string): Promise<FunctionalReport | null> {
    const [report] = await db
      .select()
      .from(functionalReports)
      .where(
        and(
          eq(functionalReports.studentId, studentId),
          or(eq(functionalReports.status, "draft"), eq(functionalReports.status, "pending_review"))
        )
      )
      .orderBy(desc(functionalReports.createdAt))
      .limit(1);

    return report || null;
  }

  private async loadEducationalReport(studentId: string): Promise<EducationalReport | null> {
    const [report] = await db
      .select()
      .from(educationalReports)
      .where(
        and(
          eq(educationalReports.studentId, studentId),
          or(eq(educationalReports.status, "draft"), eq(educationalReports.status, "pending_review"))
        )
      )
      .orderBy(desc(educationalReports.createdAt))
      .limit(1);

    return report || null;
  }

  /**
   * Initialize the manager by loading student, program, and reports data.
   * Call this before using the manager.
   */
  async initialize(): Promise<{
    student: Student | null;
    program: Program | null;
    medicalRecord: MedicalRecord | null;
    functionalReport: FunctionalReport | null;
    educationalReport: EducationalReport | null;
  }> {
    // Load student
    const [student] = await db
      .select()
      .from(students)
      .where(eq(students.id, this.context.studentId));

    this.state.student = student || null;

    if (!student) {
      console.warn(`[ProgressModeManager] Student ${this.context.studentId} not found`);
      return {
        student: null,
        program: null,
        medicalRecord: null,
        functionalReport: null,
        educationalReport: null,
      };
    }

    // Load current program
    let program: Program | undefined;

    if (this.context.programId) {
      const [p] = await db
        .select()
        .from(programs)
        .where(eq(programs.id, this.context.programId));
      program = p;
    } else {
      const [activeProgram] = await db
        .select()
        .from(programs)
        .where(
          and(
            eq(programs.studentId, this.context.studentId),
            eq(programs.status, "active")
          )
        )
        .orderBy(desc(programs.createdAt))
        .limit(1);

      if (activeProgram) {
        program = activeProgram;
      } else {
        const [draftProgram] = await db
          .select()
          .from(programs)
          .where(
            and(
              eq(programs.studentId, this.context.studentId),
              eq(programs.status, "draft")
            )
          )
          .orderBy(desc(programs.createdAt))
          .limit(1);
        program = draftProgram;
      }
    }

    this.state.program = program || null;

    if (program) {
      this.state.baseContext.programId = program.id;
    }

    // Load reports based on permissions
    await this.loadReports();

    return {
      student: this.state.student,
      program: this.state.program,
      medicalRecord: this.state.medicalRecord,
      functionalReport: this.state.functionalReport,
      educationalReport: this.state.educationalReport,
    };
  }

  /**
   * Load reports based on permissions
   */
  private async loadReports(): Promise<void> {
    const permissions = this.state.reportPermissions;
    const studentId = this.context.studentId;
    const instituteId = this.context.instituteId;

    if (permissions.medical !== 'hidden') {
      this.state.medicalRecord = await this.loadMedicalRecord(studentId, instituteId);
    }

    if (permissions.functional !== 'hidden') {
      this.state.functionalReport = await this.loadFunctionalReport(studentId);
    }

    if (permissions.educational !== 'hidden') {
      this.state.educationalReport = await this.loadEducationalReport(studentId);
    }
  }

  /**
   * Get the memory fields for this mode.
   */
  getMemoryFields(): AgentMemoryFieldWithDB[] {
    return this.memoryFields;
  }

  /**
   * Get the base context for database operations.
   */
  getBaseContext(): Record<string, any> {
    return this.state.baseContext;
  }

  /**
   * Get the current load state.
   */
  getLoadState(): MemoryLoadState {
    return this.state.loadState;
  }

  /**
   * Get report permissions
   */
  getReportPermissions(): ReportPermissions {
    return this.state.reportPermissions;
  }

  /**
   * Check if any reports are visible
   */
  hasVisibleReports(): boolean {
    const p = this.state.reportPermissions;
    return p.medical !== 'hidden' || p.functional !== 'hidden' || p.educational !== 'hidden';
  }

  /**
   * Populate memory values from the database based on visibility.
   */
  async populateMemory(
    memoryValues: Record<string, any>,
    memoryState: { visible: string[]; page: Record<string, any> } | undefined,
    forceRefresh: boolean = false
  ): Promise<{
    memoryValues: Record<string, any>;
    loadedPaths: string[];
    errors: Array<{ path: string; error: string }>;
  }> {
    const result = await populateMemoryFromDB(
      this.memoryFields,
      memoryValues,
      memoryState,
      this.state.loadState,
      {
        baseContext: this.state.baseContext,
        defaultLimit: 50,
        forceRefresh,
      }
    );

    return {
      memoryValues: result.memoryValues,
      loadedPaths: result.loadedPaths,
      errors: result.errors,
    };
  }

  /**
   * Process a memory tool call with database synchronization.
   */
  async processMemoryTool(
    memoryValues: Record<string, any>,
    memoryState: { visible: string[]; page: Record<string, any> } | undefined,
    input: any,
    originalProcessor: (
      fields: any[],
      values: any,
      state: any,
      input: any
    ) => { updatedMemoryValues: any; updatedMemoryState: any; results: any[] }
  ): Promise<{
    updatedMemoryValues: any;
    updatedMemoryState: any;
    results: any[];
  }> {
    const result = await processMemoryToolWithDB(
      this.memoryFields,
      memoryValues,
      memoryState,
      this.state.loadState,
      input,
      this.state.baseContext,
      originalProcessor
    );

    return {
      updatedMemoryValues: result.updatedMemoryValues,
      updatedMemoryState: result.updatedMemoryState,
      results: result.results,
    };
  }

  /**
   * Invalidate cached data for specific paths.
   */
  invalidatePaths(paths: string[]): void {
    for (const path of paths) {
      this.state.loadState.stale.add(path);
    }
  }

  /**
   * Get a summary of the current program for the AI context.
   */
  getProgramSummary(): string {
    if (!this.state.program) {
      const framework = this.state.student?.framework;
      let framworkText = '';
      if (framework === 'tala') {
        framworkText = ` using "tala" framework`;
      } else if (framework === 'us_iep') {
        framworkText = ` using "us_iep" framework`;
      } else {
        framworkText = ` after consulting with the user about the appropriate framework`;
      }
      return `No program loaded for this student. If asked to edit program info, create a new program for the current year${framworkText}.`;
    }

    const p = this.state.program;
    return `Current Program: ${p.title} (${p.framework.toUpperCase()})
Status: ${p.status}
${p.startDate ? `Start: ${p.startDate}\n` : ""}${p.endDate ? `End: ${p.endDate}\n` : ""}${p.dueDate ? `Due: ${p.dueDate}\n` : ""}`;
  }

  /**
   * Get a summary of the current reports for the AI context.
   */
  getReportsSummary(): string {
    const parts: string[] = [];
    const permissions = this.state.reportPermissions;

    if (permissions.medical !== 'hidden') {
      if (this.state.medicalRecord) {
        const m = this.state.medicalRecord;
        const accessNote = permissions.medical === 'readonly' ? ' [read-only]' : '';
        parts.push(`Medical Record: ${m.primaryDiagnosis || "No diagnosis"} (${m.status})${accessNote}`);
      } else {
        parts.push("Medical Record: None");
      }
    }

    if (permissions.functional !== 'hidden') {
      if (this.state.functionalReport) {
        const f = this.state.functionalReport;
        const accessNote = permissions.functional === 'readonly' ? ' [read-only]' : '';
        parts.push(`Functional Report: Status ${f.status}${accessNote}`);
      } else {
        parts.push("Functional Report: None");
      }
    }

    if (permissions.educational !== 'hidden') {
      if (this.state.educationalReport) {
        const e = this.state.educationalReport;
        const accessNote = permissions.educational === 'readonly' ? ' [read-only]' : '';
        parts.push(`Educational Report: Status ${e.status}${accessNote}`);
      } else {
        parts.push("Educational Report: None");
      }
    }

    if (parts.length === 0) {
      return "";
    }

    return parts.join("\n");
  }

  /**
   * Get the student info for context.
   */
  getStudentInfo(): string {
    if (!this.state.student) {
      return "No student loaded.";
    }

    const s = this.state.student;
    return `Student: ${s.name || "Unknown"}\nGender: ${s.gender}\n${s.primaryLanguage ? `Primary Language: ${s.primaryLanguage}\n` : ""}`;
  }
}

// ============================================================================
// SESSION SERVICE INTEGRATION HELPERS
// ============================================================================

/**
 * Creates a ProgressModeManager for use in sessionService.
 * This is the main entry point for creating the unified manager.
 */
export async function createProgressModeManager(
  studentId: string,
  userId?: string,
  programId?: string,
  masterMemoryFields: AgentMemoryFieldWithDB[] = [],
  existingLoadState?: MemoryLoadState,
  instituteId?: string,
  reportPermissions?: ReportPermissions
): Promise<ProgressModeManager> {
  const manager = new ProgressModeManager(
    { studentId, userId, programId, instituteId, reportPermissions },
    masterMemoryFields,
    existingLoadState
  );
  await manager.initialize();
  return manager;
}

/**
 * Injects progress mode context into memory values.
 * Call this after building base memory values but before the AI sees them.
 */
export async function injectProgressModeContext(
  memoryValues: Record<string, any>,
  memoryState: { visible: string[]; page: Record<string, any> } | undefined,
  manager: ProgressModeManager
): Promise<Record<string, any>> {
  console.log('[injectProgressModeContext] Input memoryValues keys:', Object.keys(memoryValues));
  
  const result = await manager.populateMemory(memoryValues, memoryState);
  
  console.log('[injectProgressModeContext] Results:');
  console.log('  - loadedPaths:', result.loadedPaths);
  console.log('  - errors:', result.errors);
  console.log('  - output memoryValues keys:', Object.keys(result.memoryValues));
  
  if (result.errors.length > 0) {
    console.warn('[injectProgressModeContext] Errors loading data:', result.errors);
  }

  return result.memoryValues;
}

/**
 * Extracts program data from memory values after AI modifications.
 */
export function extractProgramFromMemoryValues(
  memoryValues: Record<string, any>
): any | undefined {
  return memoryValues["Context_Program"];
}

/**
 * Extracts reports data from memory values after AI modifications.
 */
export function extractReportsFromMemoryValues(
  memoryValues: Record<string, any>
): any | undefined {
  return memoryValues["Context_Reports"];
}

/**
 * Get the memory fields for progress mode (for use outside ProgressModeManager)
 */
export function getProgressMemoryFields(
  masterFields: AgentMemoryFieldWithDB[],
  reportPermissions?: ReportPermissions
): AgentMemoryFieldWithDB[] {
  if (!reportPermissions) {
    return getBaseProgressMemoryFields(masterFields);
  }

  const tempManager = new ProgressModeManager(
    { studentId: '', reportPermissions },
    masterFields
  );
  return tempManager.getMemoryFields();
}

// ============================================================================
// COMBINED SYSTEM PROMPT
// ============================================================================

/**
 * Build a combined system prompt based on report permissions
 */
export function buildProgressSystemPrompt(permissions: ReportPermissions = DEFAULT_REPORT_PERMISSIONS): string {
  let prompt = PROGRESS_SYSTEM_PROMPT;

  const hasVisibleReports = 
    permissions.medical !== 'hidden' ||
    permissions.functional !== 'hidden' ||
    permissions.educational !== 'hidden';

  if (hasVisibleReports) {
    prompt += `In addition to program management, you have access to student reports:\n\n`;

    if (permissions.medical !== 'hidden') {
      const access = permissions.medical === 'readonly' ? 'view' : 'view and edit';
      prompt += `- **medicalRecord** (${access})\n`;
    }

    if (permissions.functional !== 'hidden') {
      const access = permissions.functional === 'readonly' ? 'view' : 'view and edit';
      prompt += `- **functionalReport** (${access})\n`;
    }

    if (permissions.educational !== 'hidden') {
      const access = permissions.educational === 'readonly' ? 'view' : 'view and edit';
      prompt += `- **educationalReport** (${access})\n`;
    }

    prompt += `\nReports are stored in /Context_Reports.\n`;

    const readonlyTypes: string[] = [];
    if (permissions.medical === 'readonly') readonlyTypes.push('medical records');
    if (permissions.functional === 'readonly') readonlyTypes.push('functional reports');
    if (permissions.educational === 'readonly') readonlyTypes.push('educational reports');

    if (readonlyTypes.length > 0) {
      prompt += `**Note:** The following are read-only: ${readonlyTypes.join(', ')}.\n`;
    }
  }

  return prompt;
}