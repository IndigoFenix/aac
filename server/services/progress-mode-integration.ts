/**
 * progress-mode-integration.ts
 * 
 * Integration layer for progress mode in sessionService.
 * Connects the progress memory schema with database operations.
 * 
 * This file provides:
 * 1. ProgressModeManager - manages program data lifecycle
 * 2. Integration with the memory-db-bridge system
 * 3. Helper functions for sessionService
 */

import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import {
  programs,
  students,
  type Program,
  type Student,
  type AgentMemoryField,
} from "@shared/schema";

import {
  type AgentMemoryFieldWithDB,
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
  getProgressMemoryFields,
} from "./progress-memory-schema";

// Re-export for convenience
export { PROGRESS_PROGRAM_FIELD, PROGRESS_SYSTEM_PROMPT, getProgressMemoryFields };

// ============================================================================
// PROGRESS MODE MANAGER
// ============================================================================

export interface ProgressModeContext {
  studentId: string;
  userId?: string;
  programId?: string; // Optional - if not provided, will load current program
}

export interface ProgressModeState {
  student: Student | null;
  program: Program | null;
  loadState: MemoryLoadState;
  baseContext: Record<string, any>;
}

/**
 * Manages the progress mode lifecycle for a chat session.
 * Handles loading program data, syncing changes, and managing state.
 */
export class ProgressModeManager {
  private state: ProgressModeState;
  private memoryFields: AgentMemoryFieldWithDB[];

  constructor(
    private context: ProgressModeContext,
    masterMemoryFields: AgentMemoryFieldWithDB[] = [],
    existingLoadState?: MemoryLoadState  // NEW optional parameter
  ) {
    this.memoryFields = getProgressMemoryFields(masterMemoryFields);
    this.state = {
      student: null,
      program: null,
      loadState: existingLoadState ?? createMemoryLoadState(),  // Use existing or create new
      baseContext: {
        studentId: context.studentId,
        userId: context.userId,
      },
    };
  }

  /**
   * Initialize the manager by loading student and program data.
   * Call this before using the manager.
   */
  async initialize(): Promise<{ student: Student | null; program: Program | null }> {
    // Load student
    const [student] = await db
      .select()
      .from(students)
      .where(eq(students.id, this.context.studentId));

    this.state.student = student || null;

    if (!student) {
      console.warn(`[ProgressModeManager] Student ${this.context.studentId} not found`);
      return { student: null, program: null };
    }

    // Load current program
    let program: Program | undefined;

    if (this.context.programId) {
      // Load specific program
      const [p] = await db
        .select()
        .from(programs)
        .where(eq(programs.id, this.context.programId));
      program = p;
    } else {
      // Load current/working program (active or draft)
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
        // Try draft
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

    // Update base context with program ID if found
    if (program) {
      this.state.baseContext.programId = program.id;
    }

    return { student: this.state.student, program: this.state.program };
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
      return "No program loaded for this student. You may need to create a new program.";
    }

    const p = this.state.program;
    return `Current Program: ${p.title || p.programYear} (${p.framework.toUpperCase()})
Status: ${p.status}
Year: ${p.programYear}
${p.startDate ? `Start: ${p.startDate}\n` : ""}${p.endDate ? `End: ${p.endDate}\n` : ""}${p.dueDate ? `Due: ${p.dueDate}\n` : ""}`;
  }

  /**
   * Get the student info for context.
   */
  getStudentInfo(): string {
    if (!this.state.student) {
      return "No student loaded.";
    }

    const s = this.state.student;
    return `Student: ${s.name || "Unknown"}
${s.birthDate ? `DOB: ${s.birthDate}\n` : ""}${s.diagnosis ? `Diagnosis: ${s.diagnosis}\n` : ""}${s.grade ? `Grade: ${s.grade}\n` : ""}${s.school ? `School: ${s.school}\n` : ""}`;
  }
}

// ============================================================================
// SESSION SERVICE INTEGRATION HELPERS
// ============================================================================

/**
 * Creates a ProgressModeManager for use in sessionService.
 */
export async function createProgressModeManager(
  studentId: string,
  userId?: string,
  programId?: string,
  masterMemoryFields: AgentMemoryFieldWithDB[] = [],
  existingLoadState?: MemoryLoadState  // NEW
): Promise<ProgressModeManager> {
  const manager = new ProgressModeManager(
    { studentId, userId, programId },
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
 * The data is already synced to the database, but this can be used for
 * additional processing or response formatting.
 */
export function extractProgramFromMemoryValues(
  memoryValues: Record<string, any>
): any | undefined {
  return memoryValues["Context_Program"];
}

// ============================================================================
// AGENT TEMPLATE CONFIGURATION
// ============================================================================

/**
 * Configuration for the progress mode agent template.
 * Use this to configure the agent in sessionService.
 */
export const PROGRESS_AGENT_CONFIG = {
  name: "Progress Tracking Assistant",
  corePrompt: PROGRESS_SYSTEM_PROMPT,
  greeting: `Hello! I'm here to help you manage the student's IEP/TALA program.

I can help you:
- View and edit the program, goals, and objectives
- Record data points and track progress
- Manage services and accommodations
- Document team members and meetings
- Create progress reports

What would you like to work on?`,
  intelligence: 2,
  memory: 2,
};