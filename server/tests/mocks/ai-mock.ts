/**
 * Mock AI Chat Handler for Testing
 *
 * Simulates AI processing of memory modification operations without calling
 * the actual LLM. Focuses on testing the memory operation formatting and
 * database visibility, not text parsing.
 */

import { mockDb, type MockDatabase } from './db-mock.js';

/**
 * Memory operation types supported by the AI
 */
export type MemoryAction =
  | 'view'
  | 'hide'
  | 'set'
  | 'upsert'
  | 'add'
  | 'insert'
  | 'delete'
  | 'clear'
  | 'rename';

/**
 * Memory operation input from AI
 */
export interface MemoryToolInput {
  action: MemoryAction;
  path?: string;
  paths?: string[];
  value?: any;
  index?: number;
  key?: string;
  newKey?: string;
  page?: { offset?: number; limit?: number };
  openChildren?: boolean;
}

/**
 * Result from a memory operation
 */
export interface MemoryOperationResult {
  target: string;
  action: MemoryAction;
  ok: boolean;
  message?: string;
  newPath?: string;
  mutatedPaths?: string[];
  dbSynced?: boolean;
}

/**
 * Test context with user and student info
 */
export interface TestContext {
  userId: string;
  studentId: string;
  programId?: string;
  instituteId?: string;
}

/**
 * In-memory values storage (simulates memoryValues from chat-handler)
 */
export type MemoryValues = Record<string, any>;

/**
 * Mock AI Chat Handler
 *
 * Processes memory tool operations directly against the mock database,
 * simulating what happens when the AI uses the manageMemory tool.
 */
export class MockAIChatHandler {
  private context: TestContext;
  private memoryValues: MemoryValues;
  private db: MockDatabase;

  constructor(context: TestContext, db: MockDatabase = mockDb) {
    this.context = context;
    this.db = db;
    this.memoryValues = {};
  }

  /**
   * Get current memory values
   */
  getMemoryValues(): MemoryValues {
    return { ...this.memoryValues };
  }

  /**
   * Get the test context
   */
  getContext(): TestContext {
    return { ...this.context };
  }

  /**
   * Set a specific memory value directly (for testing setup)
   */
  setMemoryValue(path: string, value: any): void {
    const tokens = this.parsePath(path);
    if (tokens.length === 0) return;

    let current = this.memoryValues;
    for (let i = 0; i < tokens.length - 1; i++) {
      const token = tokens[i];
      if (current[token] === undefined) {
        current[token] = {};
      }
      current = current[token];
    }
    current[tokens[tokens.length - 1]] = value;
  }

  /**
   * Get a specific memory value
   */
  getMemoryValue(path: string): any {
    const tokens = this.parsePath(path);
    if (tokens.length === 0) return this.memoryValues;

    let current = this.memoryValues;
    for (const token of tokens) {
      if (current === undefined || current === null) return undefined;
      current = current[token];
    }
    return current;
  }

  /**
   * Parse a path string into tokens
   */
  private parsePath(path: string): string[] {
    if (!path || path === '/') return [];
    const p = path.startsWith('/') ? path.slice(1) : path;
    return p.split('/').filter(Boolean);
  }

  /**
   * Execute a single memory operation
   */
  async executeOperation(op: MemoryToolInput): Promise<MemoryOperationResult> {
    const { action, path, value, key, index, newKey } = op;
    const target = path || '/';

    try {
      switch (action) {
        case 'view':
          return this.handleView(op);
        case 'hide':
          return this.handleHide(op);
        case 'set':
          return await this.handleSet(path!, value);
        case 'upsert':
          return await this.handleUpsert(path!, value, key);
        case 'add':
          return await this.handleAdd(path!, value, key);
        case 'insert':
          return await this.handleInsert(path!, value, index!);
        case 'delete':
          return await this.handleDelete(path!);
        case 'clear':
          return await this.handleClear(path!);
        case 'rename':
          return await this.handleRename(path!, newKey!);
        default:
          return {
            target,
            action,
            ok: false,
            message: `Unknown action: ${action}`,
          };
      }
    } catch (err: any) {
      return {
        target,
        action,
        ok: false,
        message: err.message || 'Unknown error',
      };
    }
  }

  /**
   * Execute a batch of memory operations
   */
  async executeBatch(ops: MemoryToolInput[]): Promise<MemoryOperationResult[]> {
    const results: MemoryOperationResult[] = [];
    for (const op of ops) {
      results.push(await this.executeOperation(op));
    }
    return results;
  }

  /**
   * Load data for a specific feature context (simulates initial data loading)
   */
  async loadContext(feature: 'program' | 'reports' | 'institutes'): Promise<void> {
    switch (feature) {
      case 'program':
        this.loadProgramData();
        break;
      case 'reports':
        this.loadReportsData();
        break;
      case 'institutes':
        this.loadInstitutesData();
        break;
    }
  }

  // ============================================================================
  // Operation Handlers
  // ============================================================================

  private handleView(op: MemoryToolInput): MemoryOperationResult {
    const paths = op.paths || (op.path ? [op.path] : []);

    for (const path of paths) {
      this.loadDataForPath(path);
    }

    return {
      target: paths.join(', ') || '/',
      action: 'view',
      ok: true,
      message: `Viewing ${paths.length} path(s)`,
    };
  }

  private handleHide(op: MemoryToolInput): MemoryOperationResult {
    const paths = op.paths || (op.path ? [op.path] : []);

    return {
      target: paths.join(', ') || '/',
      action: 'hide',
      ok: true,
      message: `Hidden ${paths.length} path(s)`,
    };
  }

  private async handleSet(path: string, value: any): Promise<MemoryOperationResult> {
    const tokens = this.parsePath(path);

    if (tokens.length === 0) {
      return { target: path, action: 'set', ok: false, message: 'Cannot set root' };
    }

    // Set in memory values
    this.setMemoryValue(path, value);

    // Persist to mock DB based on path
    await this.persistToDb(path, value);

    return {
      target: path,
      action: 'set',
      ok: true,
      dbSynced: true,
      mutatedPaths: [path],
    };
  }

  private async handleUpsert(path: string, value: any, key?: string): Promise<MemoryOperationResult> {
    return this.handleSet(path, value);
  }

  private async handleAdd(path: string, value: any, key?: string): Promise<MemoryOperationResult> {
    const tokens = this.parsePath(path);

    if (tokens.length === 0) {
      return { target: path, action: 'add', ok: false, message: 'Cannot add to root' };
    }

    // Get or create the array/map at the path
    let container = this.getMemoryValue(path);

    if (container === undefined) {
      container = [];
      this.setMemoryValue(path, container);
    }

    // Generate an ID for the new item (only for objects, not primitives)
    const id = globalThis.testUtils.generateUUID();
    const itemWithId = typeof value === 'object' && value !== null ? { id, ...value } : value;

    if (Array.isArray(container)) {
      container.push(itemWithId);
    } else if (typeof container === 'object') {
      const itemKey = key || id;
      container[itemKey] = itemWithId;
    }

    // Persist to mock DB (pass the original value, not the one with id added to memory)
    await this.persistAddToDb(path, value);

    return {
      target: path,
      action: 'add',
      ok: true,
      dbSynced: true,
      mutatedPaths: [path],
      newPath: `${path}/${Array.isArray(container) ? container.length - 1 : (key || id)}`,
    };
  }

  private async handleInsert(path: string, value: any, index: number): Promise<MemoryOperationResult> {
    const tokens = this.parsePath(path);

    if (tokens.length === 0) {
      return { target: path, action: 'insert', ok: false, message: 'Cannot insert at root' };
    }

    const container = this.getMemoryValue(path);

    if (!Array.isArray(container)) {
      return { target: path, action: 'insert', ok: false, message: 'Can only insert into arrays' };
    }

    const id = globalThis.testUtils.generateUUID();
    const itemWithId = { id, ...value };
    container.splice(index, 0, itemWithId);

    await this.persistAddToDb(path, itemWithId);

    return {
      target: path,
      action: 'insert',
      ok: true,
      dbSynced: true,
      mutatedPaths: [path],
      newPath: `${path}/${index}`,
    };
  }

  private async handleDelete(path: string): Promise<MemoryOperationResult> {
    const tokens = this.parsePath(path);

    if (tokens.length === 0) {
      return { target: path, action: 'delete', ok: false, message: 'Cannot delete root' };
    }

    const parentPath = '/' + tokens.slice(0, -1).join('/');
    const lastToken = tokens[tokens.length - 1];
    const parent = this.getMemoryValue(parentPath);

    if (parent === undefined) {
      return { target: path, action: 'delete', ok: false, message: 'Parent not found' };
    }

    if (Array.isArray(parent)) {
      const index = parseInt(lastToken, 10);
      if (!isNaN(index) && index >= 0 && index < parent.length) {
        const deleted = parent[index];
        parent.splice(index, 1);
        await this.persistDeleteFromDb(path, deleted);
      }
    } else if (typeof parent === 'object') {
      const deleted = parent[lastToken];
      delete parent[lastToken];
      await this.persistDeleteFromDb(path, deleted);
    }

    return {
      target: path,
      action: 'delete',
      ok: true,
      dbSynced: true,
      mutatedPaths: [path, parentPath],
    };
  }

  private async handleClear(path: string): Promise<MemoryOperationResult> {
    const container = this.getMemoryValue(path);

    if (container === undefined) {
      return { target: path, action: 'clear', ok: true };
    }

    if (Array.isArray(container)) {
      container.length = 0;
    } else if (typeof container === 'object') {
      for (const key of Object.keys(container)) {
        delete container[key];
      }
    }

    return {
      target: path,
      action: 'clear',
      ok: true,
      dbSynced: true,
      mutatedPaths: [path],
    };
  }

  private async handleRename(path: string, newKey: string): Promise<MemoryOperationResult> {
    const tokens = this.parsePath(path);

    if (tokens.length === 0) {
      return { target: path, action: 'rename', ok: false, message: 'Cannot rename root' };
    }

    const parentPath = '/' + tokens.slice(0, -1).join('/');
    const oldKey = tokens[tokens.length - 1];
    const parent = this.getMemoryValue(parentPath);

    if (parent === undefined || typeof parent !== 'object' || Array.isArray(parent)) {
      return { target: path, action: 'rename', ok: false, message: 'Can only rename map keys' };
    }

    if (parent[newKey] !== undefined) {
      return { target: path, action: 'rename', ok: false, message: 'New key already exists' };
    }

    parent[newKey] = parent[oldKey];
    delete parent[oldKey];

    return {
      target: path,
      action: 'rename',
      ok: true,
      newPath: `${parentPath}/${newKey}`,
      mutatedPaths: [path, `${parentPath}/${newKey}`],
    };
  }

  // ============================================================================
  // Database Loading Helpers
  // ============================================================================

  private loadDataForPath(path: string): void {
    const tokens = this.parsePath(path);

    if (tokens.length === 0) return;

    const rootField = tokens[0];

    if (rootField === 'Context_Program') {
      this.loadProgramData();
    }

    if (rootField === 'Context_Reports') {
      this.loadReportsData();
    }

    if (rootField === 'Context_Institutes') {
      this.loadInstitutesData();
    }
  }

  private loadProgramData(): void {
    const programs = this.db.getProgramsByStudentId(this.context.studentId, 'active');
    const program = programs[0];

    if (!program) {
      this.memoryValues['Context_Program'] = null;
      return;
    }

    const goals = this.db.getGoalsByProgramId(program.id).map(goal => ({
      ...goal,
      objectives: this.db.getObjectivesByGoalId(goal.id),
    }));

    const services = this.db.getServicesByProgramId(program.id);
    const teamMembers = this.db.getTeamMembersByProgramId(program.id);
    const profileDomains = this.db.getProfileDomainsByProgramId(program.id);

    // Deep clone to avoid modifying the same reference in memory and DB
    this.memoryValues['Context_Program'] = JSON.parse(JSON.stringify({
      id: program.id,
      title: program.title,
      status: program.status,
      framework: program.framework,
      goals,
      services,
      teamMembers,
      profileDomains,
    }));
  }

  private loadReportsData(): void {
    const medicalRecords = this.db.getMedicalRecordsByStudentId(
      this.context.studentId,
      ['draft', 'pending_review']
    );
    const functionalReports = this.db.getFunctionalReportsByStudentId(
      this.context.studentId,
      ['draft', 'pending_review']
    );
    const educationalReports = this.db.getEducationalReportsByStudentId(
      this.context.studentId,
      ['draft', 'pending_review']
    );

    // Deep clone to avoid modifying the same reference in memory and DB
    this.memoryValues['Context_Reports'] = {
      medicalRecord: medicalRecords[0] ? JSON.parse(JSON.stringify(medicalRecords[0])) : null,
      functionalReport: functionalReports[0] ? JSON.parse(JSON.stringify(functionalReports[0])) : null,
      educationalReport: educationalReports[0] ? JSON.parse(JSON.stringify(educationalReports[0])) : null,
    };
  }

  private loadInstitutesData(): void {
    const institutes = Array.from(this.db.institutes.values())
      .filter(i => i.isActive);

    const institutesWithClassrooms = institutes.map(inst => ({
      ...inst,
      classrooms: Array.from(this.db.classrooms.values())
        .filter(c => c.instituteId === inst.id && c.isActive),
    }));

    // Deep clone to avoid modifying the same reference in memory and DB
    this.memoryValues['Context_Institutes'] = JSON.parse(JSON.stringify({
      institutes: institutesWithClassrooms,
    }));
  }

  // ============================================================================
  // Database Persistence Helpers
  // ============================================================================

  private async persistToDb(path: string, value: any): Promise<void> {
    const tokens = this.parsePath(path);

    if (tokens.length < 2) return;

    const rootField = tokens[0];

    if (rootField === 'Context_Program') {
      await this.persistProgramUpdate(tokens.slice(1), value);
    }

    if (rootField === 'Context_Reports') {
      await this.persistReportsUpdate(tokens.slice(1), value);
    }

    if (rootField === 'Context_Institutes') {
      await this.persistInstitutesUpdate(tokens.slice(1), value);
    }
  }

  private async persistProgramUpdate(tokens: string[], value: any): Promise<void> {
    const program = this.memoryValues['Context_Program'];
    if (!program?.id) return;

    if (tokens[0] === 'goals' && tokens.length >= 2) {
      const goalIndex = parseInt(tokens[1], 10);
      const goals = program.goals || [];
      const goal = goals[goalIndex];

      if (goal?.id && tokens.length === 3) {
        const field = tokens[2];
        const existingGoal = this.db.goals.get(goal.id);
        if (existingGoal) {
          (existingGoal as any)[field] = value;
          existingGoal.updatedAt = new Date();
        }
      }
    }

    if (tokens[0] === 'status') {
      const existingProgram = this.db.programs.get(program.id);
      if (existingProgram) {
        existingProgram.status = value;
        existingProgram.updatedAt = new Date();
      }
    }
  }

  private async persistReportsUpdate(tokens: string[], value: any): Promise<void> {
    const reports = this.memoryValues['Context_Reports'];
    if (!reports) return;

    if (tokens[0] === 'medicalRecord' && tokens.length >= 2) {
      const record = reports.medicalRecord;
      if (record?.id) {
        const existingRecord = this.db.medicalRecords.get(record.id);
        if (existingRecord) {
          const field = tokens[1];
          (existingRecord as any)[field] = value;
          existingRecord.updatedAt = new Date();
        }
      }
    }

    if (tokens[0] === 'functionalReport' && tokens.length >= 2) {
      const report = reports.functionalReport;
      if (report?.id) {
        const existingReport = this.db.functionalReports.get(report.id);
        if (existingReport) {
          const field = tokens[1];
          (existingReport as any)[field] = value;
          existingReport.updatedAt = new Date();
        }
      }
    }

    if (tokens[0] === 'educationalReport' && tokens.length >= 2) {
      const report = reports.educationalReport;
      if (report?.id) {
        const existingReport = this.db.educationalReports.get(report.id);
        if (existingReport) {
          const field = tokens[1];
          (existingReport as any)[field] = value;
          existingReport.updatedAt = new Date();
        }
      }
    }
  }

  private async persistInstitutesUpdate(tokens: string[], value: any): Promise<void> {
    if (tokens[0] === 'institutes' && tokens.length >= 2) {
      const instIndex = parseInt(tokens[1], 10);
      const institutes = this.memoryValues['Context_Institutes']?.institutes || [];
      const institute = institutes[instIndex];

      if (institute?.id && tokens.length === 3) {
        const field = tokens[2];
        const existingInst = this.db.institutes.get(institute.id);
        if (existingInst) {
          (existingInst as any)[field] = value;
          existingInst.updatedAt = new Date();
        }
      }
    }
  }

  private async persistAddToDb(path: string, value: any): Promise<void> {
    const tokens = this.parsePath(path);

    if (tokens.length < 2) return;

    const rootField = tokens[0];

    if (rootField === 'Context_Program') {
      await this.persistProgramAdd(tokens.slice(1), value);
    }

    if (rootField === 'Context_Reports') {
      await this.persistReportsAdd(tokens.slice(1), value);
    }

    if (rootField === 'Context_Institutes') {
      await this.persistInstitutesAdd(tokens.slice(1), value);
    }
  }

  private async persistProgramAdd(tokens: string[], value: any): Promise<void> {
    const program = this.memoryValues['Context_Program'];
    if (!program?.id) return;

    // Handle nested: goals/0/objectives (must check before generic goals)
    if (tokens[0] === 'goals' && tokens.length >= 3 && tokens[2] === 'objectives') {
      const goalIndex = parseInt(tokens[1], 10);
      const goals = program.goals || [];
      const goal = goals[goalIndex];
      if (goal?.id) {
        this.db.createObjective(goal.id, value);
      }
      return;
    }

    // Handle direct adds to top-level arrays (tokens.length === 1)
    if (tokens[0] === 'goals' && tokens.length === 1) {
      this.db.createGoal(program.id, value);
    }

    if (tokens[0] === 'services' && tokens.length === 1) {
      this.db.createService(program.id, value);
    }

    if (tokens[0] === 'teamMembers' && tokens.length === 1) {
      this.db.createTeamMember(program.id, value);
    }

    if (tokens[0] === 'profileDomains' && tokens.length === 1) {
      this.db.createProfileDomain(program.id, value);
    }
  }

  private async persistReportsAdd(tokens: string[], value: any): Promise<void> {
    const reports = this.memoryValues['Context_Reports'];

    // Handle adding to medical record arrays
    if (tokens[0] === 'medicalRecord' && tokens.length >= 2) {
      const record = reports?.medicalRecord;
      if (record?.id) {
        const field = tokens[1];
        const existingRecord = this.db.medicalRecords.get(record.id);
        if (existingRecord) {
          const arr = (existingRecord as any)[field];
          if (Array.isArray(arr)) {
            arr.push(value);
          } else {
            (existingRecord as any)[field] = [value];
          }
          existingRecord.updatedAt = new Date();
        }
      }
    }

    // Handle adding to functional report arrays
    if (tokens[0] === 'functionalReport' && tokens.length >= 2) {
      const report = reports?.functionalReport;
      if (report?.id) {
        const field = tokens[1];
        const existingReport = this.db.functionalReports.get(report.id);
        if (existingReport) {
          const arr = (existingReport as any)[field];
          if (Array.isArray(arr)) {
            arr.push(value);
          } else {
            (existingReport as any)[field] = [value];
          }
          existingReport.updatedAt = new Date();
        }
      }
    }

    // Handle adding to educational report arrays
    if (tokens[0] === 'educationalReport' && tokens.length >= 2) {
      const report = reports?.educationalReport;
      if (report?.id) {
        const field = tokens[1];
        const existingReport = this.db.educationalReports.get(report.id);
        if (existingReport) {
          const arr = (existingReport as any)[field];
          if (Array.isArray(arr)) {
            arr.push(value);
          } else {
            (existingReport as any)[field] = [value];
          }
          existingReport.updatedAt = new Date();
        }
      }
    }
  }

  private async persistInstitutesAdd(tokens: string[], value: any): Promise<void> {
    if (tokens[0] === 'institutes') {
      if (tokens.length === 1) {
        // Adding a new institute
        this.db.createInstitute(value);
      } else if (tokens.length >= 3 && tokens[2] === 'classrooms') {
        // Adding a classroom to an institute
        const instIndex = parseInt(tokens[1], 10);
        const institutes = this.memoryValues['Context_Institutes']?.institutes || [];
        const institute = institutes[instIndex];
        if (institute?.id) {
          this.db.createClassroom(institute.id, value);
        }
      }
    }
  }

  private async persistDeleteFromDb(path: string, deletedValue: any): Promise<void> {
    if (!deletedValue?.id) return;

    const tokens = this.parsePath(path);
    if (tokens.length < 2) return;

    const rootField = tokens[0];

    if (rootField === 'Context_Program') {
      if (tokens[1] === 'goals') {
        this.db.goals.delete(deletedValue.id);
        // Also delete associated objectives
        Array.from(this.db.objectives.values())
          .filter(o => o.goalId === deletedValue.id)
          .forEach(o => this.db.objectives.delete(o.id));
      }
      if (tokens[1] === 'services') {
        this.db.services.delete(deletedValue.id);
      }
      if (tokens.includes('teamMembers')) {
        // Soft delete for team members
        const tm = this.db.teamMembers.get(deletedValue.id);
        if (tm) {
          tm.isActive = false;
          tm.updatedAt = new Date();
        }
      }
      if (tokens.includes('objectives')) {
        this.db.objectives.delete(deletedValue.id);
      }
    }

    if (rootField === 'Context_Institutes') {
      if (tokens[1] === 'institutes' && tokens.length === 3) {
        this.db.institutes.delete(deletedValue.id);
      }
      if (tokens.includes('classrooms')) {
        this.db.classrooms.delete(deletedValue.id);
      }
    }
  }
}

// Factory function for creating test handlers
export function createMockAIHandler(
  context: TestContext,
  db: MockDatabase = mockDb
): MockAIChatHandler {
  return new MockAIChatHandler(context, db);
}

export { mockDb };
