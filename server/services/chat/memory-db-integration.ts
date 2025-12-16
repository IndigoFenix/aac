/**
 * memory-db-integration.ts
 * 
 * Practical integration layer for connecting the memory-db-bridge to the 
 * existing Hello-Computer chat system.
 * 
 * This module provides:
 * 1. MemoryManager class - manages memory lifecycle for a chat session
 * 2. createMemoryToolHandler - wraps the manageMemory tool with DB sync
 * 3. Helper functions for common operations
 * 
 * Usage in ChatMessageManager:
 * ```typescript
 * const memoryManager = new MemoryManager({
 *   fields: agent.memoryFields,  // with DB ops attached
 *   baseContext: { agentInstanceId: session.agentInstanceId },
 * });
 * 
 * // On session start
 * await memoryManager.initialize(existingMemoryValues, existingMemoryState);
 * 
 * // In tool registry
 * toolRegistry.register('manageMemory', memoryManager.createToolHandler());
 * ```
 */

import type { MemoryState } from "@shared/schema";
import {
  type AgentMemoryFieldWithDB,
  type MemoryLoadState,
  type DBOperationContext,
  type MemoryDBOperations,
  type PopulateResult,
  createMemoryLoadState,
  populateMemoryFromDB,
  processMemoryToolWithDB,
  resolveSchemaWithContext,
  needsLoading,
  markLoaded,
  markStale,
  clearLoadState,
} from './memory-db-bridge';

// Re-export types for convenience
export type {
  AgentMemoryFieldWithDB,
  MemoryDBOperations,
  DBOperationContext,
  MemoryLoadState,
};

// ──────────────────────────────────────────────────────────────────────────────
// Memory Manager Class
// ──────────────────────────────────────────────────────────────────────────────

export interface MemoryManagerConfig {
  /** Memory field definitions with optional DB operations */
  fields: AgentMemoryFieldWithDB[];
  
  /** Base context for database operations (agentInstanceId, userId, etc.) */
  baseContext: Record<string, any>;
  
  /** Default pagination limit */
  defaultLimit?: number;
  
  /** 
   * Original processMemoryToolResponse function from memory-system.ts.
   * If not provided, only DB operations will run (no in-memory updates).
   */
  originalProcessor?: (
    fields: any[],
    values: any,
    state: MemoryState | undefined,
    input: any
  ) => { updatedMemoryValues: any; updatedMemoryState: MemoryState; results: any[] };

  /**
   * Callback when memory values are updated.
   * Use this to persist memoryValues to your session storage.
   */
  onMemoryValuesUpdate?: (memoryValues: any) => Promise<void>;

  /**
   * Callback when memory state is updated.
   * Use this to persist memoryState (visibility, pagination) to your session storage.
   */
  onMemoryStateUpdate?: (memoryState: MemoryState) => Promise<void>;
}

/**
 * Manages memory lifecycle for a chat session.
 * Handles loading from DB, caching, and syncing operations.
 */
export class MemoryManager {
  private fields: AgentMemoryFieldWithDB[];
  private baseContext: Record<string, any>;
  private defaultLimit: number;
  private originalProcessor?: MemoryManagerConfig['originalProcessor'];
  private onMemoryValuesUpdate?: MemoryManagerConfig['onMemoryValuesUpdate'];
  private onMemoryStateUpdate?: MemoryManagerConfig['onMemoryStateUpdate'];

  // Current state
  private _memoryValues: any = {};
  private _memoryState: MemoryState = { visible: [], page: {} };
  private _loadState: MemoryLoadState;

  constructor(config: MemoryManagerConfig) {
    this.fields = config.fields;
    this.baseContext = config.baseContext;
    this.defaultLimit = config.defaultLimit ?? 50;
    this.originalProcessor = config.originalProcessor;
    this.onMemoryValuesUpdate = config.onMemoryValuesUpdate;
    this.onMemoryStateUpdate = config.onMemoryStateUpdate;
    this._loadState = createMemoryLoadState();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Getters for current state
  // ─────────────────────────────────────────────────────────────────────────

  get memoryValues(): any {
    return this._memoryValues;
  }

  get memoryState(): MemoryState {
    return this._memoryState;
  }

  get loadState(): MemoryLoadState {
    return this._loadState;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initialize memory from existing session data and load any missing visible data from DB.
   * Call this when starting or resuming a chat session.
   * 
   * @param existingValues - memoryValues from session storage (may be partial)
   * @param existingState - memoryState from session storage (visibility, pagination)
   * @param forceRefresh - if true, reload all visible data from DB even if cached
   */
  async initialize(
    existingValues?: any,
    existingState?: MemoryState,
    forceRefresh: boolean = false
  ): Promise<PopulateResult> {
    // Start with existing data
    this._memoryValues = existingValues ?? {};
    this._memoryState = existingState ?? { visible: [], page: {} };

    // If not forcing refresh, mark existing data as loaded
    if (!forceRefresh && existingValues) {
      this.markExistingAsLoaded(existingValues);
    }

    // Load any visible data that isn't already loaded
    const result = await populateMemoryFromDB(
      this.fields,
      this._memoryValues,
      this._memoryState,
      this._loadState,
      {
        baseContext: this.baseContext,
        defaultLimit: this.defaultLimit,
        forceRefresh,
      }
    );

    this._memoryValues = result.memoryValues;

    // Notify listeners of updates
    if (result.loadedPaths.length > 0) {
      await this.notifyValuesUpdate();
    }

    return result;
  }

  /**
   * Marks paths in existing memoryValues as already loaded.
   * This prevents unnecessary DB queries for data that's already cached.
   */
  private markExistingAsLoaded(values: any, basePath: string = ''): void {
    if (!values || typeof values !== 'object') return;

    for (const key of Object.keys(values)) {
      const path = basePath ? `${basePath}/${key}` : `/${key}`;
      markLoaded(this._loadState, path);

      const value = values[key];
      if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
          // For arrays, mark each item
          value.forEach((_, i) => {
            markLoaded(this._loadState, `${path}/${i}`);
          });
        } else {
          // For objects/maps, recurse
          this.markExistingAsLoaded(value, path);
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tool Handler
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates a tool handler function for the manageMemory tool.
   * Use this in your tool registry.
   * 
   * @example
   * toolRegistry.register('manageMemory', memoryManager.createToolHandler());
   */
  createToolHandler(): (input: any) => Promise<{
    success: boolean;
    results: any[];
    memoryValues: any;
    memoryState: MemoryState;
  }> {
    return async (input: any) => {
      return this.processToolCall(input);
    };
  }

  /**
   * Process a manageMemory tool call with database synchronization.
   */
  async processToolCall(input: any): Promise<{
    success: boolean;
    results: any[];
    memoryValues: any;
    memoryState: MemoryState;
  }> {
    if (!this.originalProcessor) {
      // Without the original processor, we can only do DB operations
      // This is a fallback mode - in practice you should always provide the processor
      console.warn('MemoryManager: No originalProcessor provided, running in DB-only mode');
      return {
        success: false,
        results: [{ ok: false, message: 'Memory processor not configured' }],
        memoryValues: this._memoryValues,
        memoryState: this._memoryState,
      };
    }

    const result = await processMemoryToolWithDB(
      this.fields,
      this._memoryValues,
      this._memoryState,
      this._loadState,
      input,
      this.baseContext,
      this.originalProcessor
    );

    // Update internal state
    this._memoryValues = result.updatedMemoryValues;
    this._memoryState = result.updatedMemoryState;
    this._loadState = result.updatedLoadState;

    // Notify listeners
    await this.notifyValuesUpdate();
    await this.notifyStateUpdate();

    const success = result.results.every(r => r.ok);

    return {
      success,
      results: result.results,
      memoryValues: this._memoryValues,
      memoryState: this._memoryState,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Manual Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Manually load data for a specific path from the database.
   * Useful when you need to ensure fresh data for a specific path.
   */
  async loadPath(path: string, force: boolean = false): Promise<any> {
    if (!force && !needsLoading(this._loadState, path)) {
      // Already loaded, return cached value
      return this.getValueAtPath(path);
    }

    const resolution = resolveSchemaWithContext(
      this.fields,
      this._memoryValues,
      path,
      this.baseContext
    );

    if (resolution.error || !resolution.dbOps) {
      return undefined;
    }

    const { schema, dbOps, context } = resolution;
    
    try {
      let value: any;

      if (schema?.type === 'array' || schema?.type === 'map' || schema?.type === 'topic') {
        if (dbOps.list) {
          const page = this._memoryState.page[path] ?? { offset: 0, limit: this.defaultLimit };
          const result = await dbOps.list(context, page);
          value = dbOps.fromDB 
            ? result.items.map(item => dbOps.fromDB!(item))
            : result.items;
          markLoaded(this._loadState, path, result.total);
        }
      } else {
        if (dbOps.read) {
          const result = await dbOps.read(context);
          value = result !== undefined && dbOps.fromDB ? dbOps.fromDB(result) : result;
          markLoaded(this._loadState, path);
        }
      }

      // Update memoryValues
      if (value !== undefined) {
        this.setValueAtPath(path, value);
        await this.notifyValuesUpdate();
      }

      return value;
    } catch (err) {
      console.error(`Failed to load path ${path}:`, err);
      return undefined;
    }
  }

  /**
   * Invalidate cached data for a path, forcing it to be reloaded on next access.
   * Useful after external changes to the database.
   */
  invalidate(path: string, includeChildren: boolean = true): void {
    markStale(this._loadState, path, includeChildren);
  }

  /**
   * Invalidate all cached data.
   */
  invalidateAll(): void {
    this._loadState = createMemoryLoadState();
  }

  /**
   * Get a value from memoryValues by path.
   */
  getValueAtPath(path: string): any {
    const tokens = path.split('/').filter(Boolean);
    let current = this._memoryValues;
    
    for (const token of tokens) {
      if (current === undefined || current === null) return undefined;
      current = current[token];
    }
    
    return current;
  }

  /**
   * Set a value in memoryValues by path.
   * Does NOT sync to database - use processToolCall for that.
   */
  private setValueAtPath(path: string, value: any): void {
    const tokens = path.split('/').filter(Boolean);
    if (tokens.length === 0) return;

    let current = this._memoryValues;
    for (let i = 0; i < tokens.length - 1; i++) {
      const token = tokens[i];
      const nextToken = tokens[i + 1];
      const isNextIndex = /^\d+$/.test(nextToken);
      
      if (current[token] === undefined) {
        current[token] = isNextIndex ? [] : {};
      }
      current = current[token];
    }
    
    current[tokens[tokens.length - 1]] = value;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Context Updates
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Update the base context (e.g., when user changes).
   * This will invalidate all cached data since queries may return different results.
   */
  updateBaseContext(newContext: Record<string, any>): void {
    this.baseContext = { ...this.baseContext, ...newContext };
    this.invalidateAll();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Notification Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async notifyValuesUpdate(): Promise<void> {
    if (this.onMemoryValuesUpdate) {
      await this.onMemoryValuesUpdate(this._memoryValues);
    }
  }

  private async notifyStateUpdate(): Promise<void> {
    if (this.onMemoryStateUpdate) {
      await this.onMemoryStateUpdate(this._memoryState);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Serialization
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the current state for persistence.
   * Save this to your session storage.
   */
  getStateForPersistence(): {
    memoryValues: any;
    memoryState: MemoryState;
  } {
    return {
      memoryValues: JSON.parse(JSON.stringify(this._memoryValues)),
      memoryState: JSON.parse(JSON.stringify(this._memoryState)),
    };
  }

  /**
   * Restore state from persistence.
   */
  restoreFromPersistence(state: {
    memoryValues?: any;
    memoryState?: MemoryState;
  }): void {
    if (state.memoryValues) {
      this._memoryValues = state.memoryValues;
      this.markExistingAsLoaded(state.memoryValues);
    }
    if (state.memoryState) {
      this._memoryState = state.memoryState;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Tool Registry Integration Helper
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Creates a complete tool handler that can be added to the existing tool registry.
 * This wraps the MemoryManager for seamless integration.
 * 
 * @example
 * // In tool-router.ts or where you set up tool handlers:
 * const memoryToolHandler = createMemoryToolHandler({
 *   fields: agent.memoryFields,
 *   baseContext: { agentInstanceId },
 *   originalProcessor: processMemoryToolResponse,
 *   memoryValuesRef,
 *   memoryStateRef,
 *   onUpdateMemoryValues,
 *   onUpdateMemoryState,
 * });
 * 
 * toolRegistry.register('manageMemory', memoryToolHandler);
 */
export function createMemoryToolHandler(config: {
  fields: AgentMemoryFieldWithDB[];
  baseContext: Record<string, any>;
  originalProcessor: MemoryManagerConfig['originalProcessor'];
  
  /** Reference to current memoryValues (will be read and updated) */
  memoryValuesRef: { current: any };
  
  /** Reference to current memoryState (will be read and updated) */
  memoryStateRef: { current: MemoryState };
  
  /** Callback when memoryValues changes */
  onUpdateMemoryValues?: (values: any) => Promise<void>;
  
  /** Callback when memoryState changes */
  onUpdateMemoryState?: (state: MemoryState) => Promise<void>;
}): (input: any) => Promise<string> {
  
  // Create a persistent load state
  let loadState = createMemoryLoadState();

  return async (input: any): Promise<string> => {
    const result = await processMemoryToolWithDB(
      config.fields,
      config.memoryValuesRef.current,
      config.memoryStateRef.current,
      loadState,
      input,
      config.baseContext,
      config.originalProcessor!
    );

    // Update refs
    config.memoryValuesRef.current = result.updatedMemoryValues;
    config.memoryStateRef.current = result.updatedMemoryState;
    loadState = result.updatedLoadState;

    // Call update callbacks
    if (config.onUpdateMemoryValues) {
      await config.onUpdateMemoryValues(result.updatedMemoryValues);
    }
    if (config.onUpdateMemoryState) {
      await config.onUpdateMemoryState(result.updatedMemoryState);
    }

    // Format results for AI response
    const successCount = result.results.filter(r => r.ok).length;
    const failCount = result.results.length - successCount;

    let response = `Processed ${result.results.length} operation(s): ${successCount} succeeded`;
    if (failCount > 0) {
      response += `, ${failCount} failed`;
    }

    // Add error details if any
    const errors = result.results.filter(r => !r.ok);
    if (errors.length > 0) {
      response += '\n\nErrors:';
      for (const err of errors) {
        response += `\n- ${err.target}: ${err.message}`;
      }
    }

    return response;
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Field Builder Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Helper to attach database operations to an existing memory field definition.
 * Useful when you want to keep field definitions separate from DB operations.
 * 
 * @example
 * const studentsField = withDBOps(originalStudentsField, {
 *   list: async (ctx, page) => { ... },
 *   add: async (ctx, value) => { ... },
 *   // ...
 * });
 */
export function withDBOps<T extends { db?: MemoryDBOperations }>(
  field: T,
  dbOps: MemoryDBOperations
): T & { db: MemoryDBOperations } {
  return {
    ...field,
    db: dbOps,
  };
}

/**
 * Helper to create database operations with common patterns.
 * Reduces boilerplate for typical CRUD scenarios.
 */
export function createSimpleDBOps<T>(config: {
  /** Function to list items with pagination */
  list?: (ctx: DBOperationContext, pagination: { offset: number; limit: number }) => Promise<{ items: T[]; total: number; keys?: string[] }>;
  
  /** Function to get a single item */
  get?: (ctx: DBOperationContext, key: string | number) => Promise<T | undefined>;
  
  /** Function to create a new item */
  create?: (ctx: DBOperationContext, value: T, key?: string) => Promise<T>;
  
  /** Function to update an existing item */
  update?: (ctx: DBOperationContext, key: string | number, value: Partial<T>) => Promise<T>;
  
  /** Function to delete an item */
  remove?: (ctx: DBOperationContext, key: string | number) => Promise<void>;
  
  /** Function to clear all items */
  clear?: (ctx: DBOperationContext) => Promise<void>;
  
  /** Context key extraction from item values */
  contextExtraction?: Record<string, string>;
  
  /** Primary key field name for getDBKey */
  primaryKey?: string;
}): MemoryDBOperations<T> {
  return {
    list: config.list,
    get: config.get,
    add: config.create ? async (ctx, value, opts) => config.create!(ctx, value, opts?.key) : undefined,
    update: config.update,
    delete: config.remove,
    clear: config.clear,
    extractChildContext: config.contextExtraction 
      ? (value, key) => {
          const result: Record<string, any> = {};
          for (const [ctxKey, fieldName] of Object.entries(config.contextExtraction!)) {
            result[ctxKey] = (value as any)?.[fieldName];
          }
          return result;
        }
      : undefined,
    getDBKey: config.primaryKey 
      ? (value) => (value as any)?.[config.primaryKey!]
      : undefined,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Re-exports for convenience
// ──────────────────────────────────────────────────────────────────────────────

export {
  createMemoryLoadState,
  populateMemoryFromDB,
  processMemoryToolWithDB,
  resolveSchemaWithContext,
  needsLoading,
  markLoaded,
  markStale,
  clearLoadState,
} from './memory-db-bridge';