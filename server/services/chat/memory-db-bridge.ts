/**
 * memory-db-bridge.ts
 * 
 * Database integration layer for the Hello-Computer memory system.
 * Provides a generic, modular interface for connecting memory fields to database operations.
 * 
 * Key concepts:
 * - MemoryDBOperations: CRUD functions attached to memory field definitions
 * - DBOperationContext: Context that flows through nested structures (e.g., studentId)
 * - MemoryLoadState: Tracks what's been loaded from DB vs. needs refreshing
 * - populateMemoryFromDB: Loads visible data based on schema and memoryState
 * - processMemoryToolWithDB: Wraps the existing processMemoryToolResponse with DB sync
 */

import {
  // Core types
  MemoryType,
  MemoryAction,
  
  // Field schemas (with DB operations)
  AgentMemoryFieldWithDB,
  AgentMemoryFieldBaseWithDB,
  AgentMemoryFieldObjectWithDB,
  AgentMemoryFieldArrayWithDB,
  AgentMemoryFieldMapWithDB,
  AgentMemoryFieldTopicWithDB,
  
  // Base field schemas (for compatibility)
  AgentMemoryField,
  AgentMemoryFieldObject,
  AgentMemoryFieldArray,
  AgentMemoryFieldMap,
  AgentMemoryFieldTopic,
  
  // Topic tree
  TopicNode,
  TopicTree,
  
  // Tool input/output
  MemoryToolInput,
  MemoryOperationResult,
  
  // State
  MemoryState,
  MemoryLoadState,
  
  // DB operation types
  DBOperationContext,
  MemoryDBOperations,
  PaginationParams,
  ListResult,
  DbOperationResult,
  SchemaResolution,
  MemoryToolBatchInput,
} from './memory-types';

import {
  normalizePath,
  splitPath,
  joinPath,
  escapeToken,
  unescapeToken,
  getParentPath,
  getLastToken,
  appendToPath,
  hasWildcard,
  getWildcardBasePath,
  getPathDepth,
  sortPathsByDepthAsc,
  isArrayIndex,
  parseArrayIndex,
} from './path-utils';

import { resolveDisplayKeyPath } from './memory-system';

const isProduction = process.env.NODE_ENV === 'production';
const hideLogs = isProduction; // Set to true to hide logs in production

/**
 * Creates a new DBOperationContext.
 */
export function createDBContext(
  base: Record<string, any>,
  inherited: Record<string, any> = {},
  path: string = '',
  currentKey?: string | number
): DBOperationContext {
  const pathTokens = path ? path.split('/').filter(Boolean) : [];
  return {
    base,
    inherited,
    get all() {
      return { ...this.base, ...this.inherited };
    },
    path,
    pathTokens,
    currentKey
  };
}

/**
 * Extends context with additional inherited values (used when traversing into children).
 */
export function extendContext(
  ctx: DBOperationContext,
  additionalInherited: Record<string, any>,
  newPath: string,
  newKey?: string | number
): DBOperationContext {
  return createDBContext(
    ctx.base,
    { ...ctx.inherited, ...additionalInherited },
    newPath,
    newKey
  );
}

/**
 * Merges inherited context (parent IDs) into a value for add/insert operations.
 * This automatically includes parent identifiers (like goalId, studentId) when
 * adding child records, so the AI doesn't need to specify them explicitly.
 * 
 * @param value The value being added
 * @param context The operation context with inherited parent info
 * @returns Value with inherited context merged in (inherited values won't override explicit ones)
 */
export function mergeInheritedContext(
  value: any,
  context: DBOperationContext
): any {
  // Only merge for object values
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  
  // Merge inherited context, but let explicit values in the original value take precedence
  // This means if AI explicitly sets goalId, it won't be overwritten
  return { ...context.inherited, ...value };
}

// ──────────────────────────────────────────────────────────────────────────────
// Memory Load State (tracks what's loaded from DB)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Creates a new MemoryLoadState.
 */
export function createMemoryLoadState(): MemoryLoadState {
  return {
    loaded: new Set(),
    stale: new Set(),
    loadedAt: new Map(),
    totals: new Map(),
    cachedValues: new Map()
  };
}

/**
 * Marks a path as loaded and optionally caches the value.
 */
export function markLoaded(state: MemoryLoadState, path: string, total?: number, value?: any): void {
  const normalized = normalizePath(path);
  state.loaded.add(normalized);
  state.stale.delete(normalized);
  state.loadedAt.set(normalized, Date.now());
  if (total !== undefined) {
    state.totals.set(normalized, total);
  }
  if (value !== undefined) {
    state.cachedValues.set(normalized, value);
  }
}

/**
 * Marks a path (and optionally its descendants) as stale.
 */
export function markStale(state: MemoryLoadState, path: string, includeDescendants: boolean = false): void {
  const normalized = normalizePath(path);
  state.stale.add(normalized);

  if (includeDescendants) {
    for (const loaded of state.loaded) {
      if (loaded.startsWith(normalized + '/')) {
        state.stale.add(loaded);
      }
    }
  }
}

/**
 * Gets a cached value for a path if available.
 */
export function getCachedValue(state: MemoryLoadState, path: string): any | undefined {
  const normalized = normalizePath(path);
  return state.cachedValues.get(normalized);
}

/**
 * Updates the cached value for a path.
 */
export function updateCachedValue(state: MemoryLoadState, path: string, value: any): void {
  const normalized = normalizePath(path);
  if (state.cachedValues.has(normalized)) {
    state.cachedValues.set(normalized, value);
  }
}

/**
 * Syncs cached values from memory values for all loaded paths.
 * Call this after modifications to ensure cache stays in sync.
 */
export function syncCachedValues(state: MemoryLoadState, memoryValues: any): void {
  for (const path of state.cachedValues.keys()) {
    const tokens = splitPath(path);
    const value = getValueAtPath(memoryValues, tokens);
    if (value !== undefined) {
      state.cachedValues.set(path, value);
    }
  }
}

/**
 * Checks if a path needs loading (not loaded, stale, or cache expired).
 * @param state - The memory load state
 * @param path - The path to check
 * @param memoryValues - Optional: pass memoryValues to verify data exists
 * @param cacheTTL - Optional: cache time-to-live in milliseconds for this field
 */
export function needsLoading(
  state: MemoryLoadState,
  path: string,
  memoryValues?: any,
  cacheTTL?: number
): boolean {
  const normalized = normalizePath(path);

  // If marked stale, needs loading
  if (state.stale.has(normalized)) {
    return true;
  }

  // If not loaded yet, needs loading
  if (!state.loaded.has(normalized)) {
    return true;
  }

  // Check if cache has expired based on cacheTTL
  if (cacheTTL !== undefined && cacheTTL > 0) {
    const loadedAt = state.loadedAt.get(normalized);
    if (loadedAt !== undefined) {
      const elapsed = Date.now() - loadedAt;
      if (elapsed > cacheTTL) {
        // Cache expired, mark as stale and needs loading
        state.stale.add(normalized);
        return true;
      }
    }
  }

  // Even if marked as loaded, if value is undefined, reload it
  if (memoryValues !== undefined) {
    const tokens = splitPath(normalized);
    const value = getValueAtPath(memoryValues, tokens);
    if (value === undefined) {
      // Path was marked loaded but data is missing - need to reload
      state.loaded.delete(normalized);  // Clear stale marker
      return true;
    }
  }

  return false;
}

/**
 * Clears loading state for a path and its descendants.
 */
export function clearLoadState(state: MemoryLoadState, path: string): void {
  const normalized = normalizePath(path);
  state.loaded.delete(normalized);
  state.stale.delete(normalized);
  state.loadedAt.delete(normalized);
  state.totals.delete(normalized);
  state.cachedValues.delete(normalized);

  // Also clear descendants
  for (const p of [...state.loaded, ...state.stale, ...state.cachedValues.keys()]) {
    if (p.startsWith(normalized + '/')) {
      state.loaded.delete(p);
      state.stale.delete(p);
      state.loadedAt.delete(p);
      state.totals.delete(p);
      state.cachedValues.delete(p);
    }
  }
}

const ROOT = '';

// ──────────────────────────────────────────────────────────────────────────────
// Schema Navigation
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Finds a top-level field by ID.
 */
function findFieldById(
  fields: AgentMemoryFieldWithDB[],
  id: string
): AgentMemoryFieldWithDB | undefined {
  return fields.find(f => f.id === id);
}

/**
 * Resolves a path to its schema definition and builds the operation context.
 * 
 * @param fields The memory field definitions
 * @param memoryValues The current memory values (needed to extract context from parent items)
 * @param path The path to resolve
 * @param baseContext The base context (agentInstanceId, userId, etc.)
 */
export function resolveSchemaWithContext(
  fields: AgentMemoryFieldWithDB[],
  memoryValues: any,
  path: string,
  baseContext: Record<string, any>
): SchemaResolution {
  const tokens = splitPath(path);
  let ctx = createDBContext(baseContext, {}, ROOT);
  
  if (tokens.length === 0) {
    return {
      context: ctx,
      tokensConsumed: []
    };
  }

  const fieldId = tokens[0];
  const rootField = findFieldById(fields, fieldId);
  
  if (!rootField) {
    return {
      context: ctx,
      tokensConsumed: [],
      error: `Unknown top-level field '${fieldId}'.`
    };
  }

  ctx = extendContext(ctx, {}, '/' + escapeToken(fieldId));

  if (!hideLogs) console.log('Resolving path:', path, 'Tokens:', tokens, 'ctx', ctx);
  
  if (tokens.length === 1) {
    return {
      schema: rootField,
      dbOps: rootField.db,
      context: ctx,
      tokensConsumed: [fieldId]
    };
  }

  // Traverse the rest of the path
  let current: AgentMemoryFieldWithDB = rootField;
  let currentValue: any = memoryValues?.[fieldId];
  let consumedTokens: string[] = [fieldId];
  
  // Track the most recent container (array/map) with db.update ops
  let parentContainerDbOps: MemoryDBOperations | undefined;
  let parentContainerKey: string | number | undefined;
  let parentContainerPath: string | undefined;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    const currentPath = joinPath(consumedTokens);
    const nextPath = joinPath([...consumedTokens, token]);

    // Extract context from current value if available
    // IMPORTANT: Skip maps and arrays here - they handle extraction AFTER retrieving the specific item
    // For maps/arrays, currentValue is the container (the whole map/array), not a specific item,
    // so extractChildContext would receive the wrong value
    if (currentValue !== undefined && current.db?.extractChildContext && current.type !== 'map' && current.type !== 'array') {
      const extractedCtx = current.db.extractChildContext(currentValue, consumedTokens[consumedTokens.length - 1]);
      if (!hideLogs) console.log('Extracted context at', currentPath, ':', extractedCtx);
      if (extractedCtx) {
        ctx = extendContext(ctx, extractedCtx, nextPath, token);
      }
    } else {
      ctx = extendContext(ctx, {}, nextPath, token);
    }

    if (!hideLogs) console.log('At token:', token, 'Current type:', current.type, 'ctx:', ctx);

    consumedTokens.push(token);

    if (current.type === 'object') {
      const objSchema = current as AgentMemoryFieldObjectWithDB;
      
      // FIX: Track this object as the parent container if it has write ops
      // This allows setting properties inside objects like medicalRecord that have db.write
      if (objSchema.db?.write) {
        parentContainerDbOps = objSchema.db;
        parentContainerKey = undefined; // Not a map/array key - property name extracted from path
        parentContainerPath = currentPath;
      }
      
      const propSchema = objSchema.properties?.[token];
      
      if (!propSchema && !objSchema.additionalProperties) {
        return {
          context: ctx,
          tokensConsumed: consumedTokens,
          error: `Property '${token}' not allowed in object.`,
          parentContainerDbOps,
          parentContainerKey,
          parentContainerPath
        };
      }

      if (propSchema) {
        current = propSchema;
        currentValue = currentValue?.[token];
      } else {
        // additionalProperties - treat as generic
        return {
          schema: undefined,
          dbOps: undefined,
          context: ctx,
          tokensConsumed: consumedTokens,
          parentSchema: objSchema,
          parentContainerDbOps,
          parentContainerKey,
          parentContainerPath
        };
      }
    } else if (current.type === 'array') {
      const arrSchema = current as AgentMemoryFieldArrayWithDB;
      const index = parseInt(token, 10);
      
      if (isNaN(index)) {
        return {
          context: ctx,
          tokensConsumed: consumedTokens,
          error: `Expected array index, got '${token}'.`,
          parentContainerDbOps,
          parentContainerKey,
          parentContainerPath
        };
      }

      // Track this array as the parent container if it has mutation ops
      if (arrSchema.db?.update || arrSchema.db?.delete || arrSchema.db?.add) {
        parentContainerDbOps = arrSchema.db;
        parentContainerKey = index;
        parentContainerPath = currentPath;
      }

      current = arrSchema.items;
      currentValue = Array.isArray(currentValue) ? currentValue[index] : undefined;
      
      // Extract context from the array item
      if (currentValue !== undefined && arrSchema.db?.extractChildContext) {
        const itemCtx = arrSchema.db.extractChildContext(currentValue, index);
        if (itemCtx) {
          ctx = extendContext(ctx, itemCtx, nextPath, index);
        }
      }
    } else if (current.type === 'map') {
      const mapSchema = current as AgentMemoryFieldMapWithDB;
      
      // Track this map as the parent container if it has mutation ops
      if (mapSchema.db?.update || mapSchema.db?.delete || mapSchema.db?.add) {
        parentContainerDbOps = mapSchema.db;
        parentContainerKey = token;
        parentContainerPath = currentPath;
      }
      
      current = mapSchema.values;
      currentValue = currentValue?.[token];
      
      // Extract context from the map value
      // IMPORTANT: Call even if value is undefined - extractChildContext can use the key as fallback
      // This handles cases where the item exists in DB but isn't loaded into memory yet
      if (mapSchema.db?.extractChildContext) {
        const valCtx = mapSchema.db.extractChildContext(currentValue, token);
        if (valCtx) {
          ctx = extendContext(ctx, valCtx, nextPath, token);
        }
      }
    } else if (current.type === 'topic') {
      // Topics have a special structure - the remaining path is node navigation
      // For now, topics don't have nested schema
      return {
        schema: current,
        dbOps: current.db,
        context: ctx,
        tokensConsumed: consumedTokens,
        parentContainerDbOps,
        parentContainerKey,
        parentContainerPath
      };
    } else {
      // Primitive type - can't traverse further
      return {
        context: ctx,
        tokensConsumed: consumedTokens.slice(0, -1),
        error: `Cannot traverse into primitive at '${currentPath}'.`,
        parentContainerDbOps,
        parentContainerKey,
        parentContainerPath
      };
    }
  }

  return {
    schema: current,
    dbOps: current.db,
    context: ctx,
    tokensConsumed: consumedTokens,
    parentSchema: consumedTokens.length > 1 ? findFieldById(fields, consumedTokens[0]) : undefined,
    parentContainerDbOps,
    parentContainerKey,
    parentContainerPath
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Visibility Checking
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Determines if a path should be visible based on memoryState and schema defaults.
 */
export function isPathVisible(
  fields: AgentMemoryFieldWithDB[],
  memoryState: MemoryState | undefined,
  path: string
): boolean {
  const p = normalizePath(path);
  const state = memoryState ?? { visible: [], page: {} };
  
  // Explicit visibility in state
  if (state.visible.includes(p)) return true;
  
  // Check schema defaults
  const tokens = splitPath(p);
  if (tokens.length === 0) return true; // root is always visible
  
  // Top-level field with opened: true
  const rootField = findFieldById(fields, tokens[0]);
  if (!rootField) return false;
  
  if (tokens.length === 1) {
    return rootField.opened === true;
  }
  
  // For nested paths, check if parent is visible and this schema has opened: true
  // This is a simplified check - the full implementation would need to walk the schema
  const parentPath = joinPath(tokens.slice(0, -1));
  if (!isPathVisible(fields, memoryState, parentPath)) return false;
  
  // Walk schema to check nested opened flags
  let current: AgentMemoryFieldWithDB = rootField;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    
    if (current.type === 'object') {
      const propSchema = (current as AgentMemoryFieldObjectWithDB).properties?.[token];
      if (!propSchema) return false;
      current = propSchema;
    } else if (current.type === 'array') {
      current = (current as AgentMemoryFieldArrayWithDB).items;
    } else if (current.type === 'map') {
      current = (current as AgentMemoryFieldMapWithDB).values;
    } else {
      break;
    }
  }
  
  return (current as AgentMemoryFieldBaseWithDB).opened === true;
}

/**
 * Gets all paths that should be visible (from schema defaults and memoryState).
 */
export function getVisiblePaths(
  fields: AgentMemoryFieldWithDB[],
  memoryState: MemoryState | undefined
): string[] {
  const visible: string[] = [];
  const state = memoryState ?? { visible: [], page: {} };
  
  // Add explicitly visible paths
  visible.push(...state.visible.map(normalizePath));
  
  // Add schema-default opened paths
  for (const field of fields) {
    if (field.opened) {
      const path = '/' + escapeToken(field.id);
      if (!visible.includes(path)) {
        visible.push(path);
      }
    }
  }
  
  return visible;
}

// ──────────────────────────────────────────────────────────────────────────────
// Data Population from Database
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Options for populating memory from the database.
 */
export interface PopulateOptions {
  /** Base context (agentInstanceId, userId, etc.) */
  baseContext: Record<string, any>;
  /** Default page size for containers */
  defaultLimit?: number;
  /** Force refresh even if already loaded */
  forceRefresh?: boolean;
}

/**
 * Result of populating memory from the database.
 */
export interface PopulateResult {
  /** Updated memory values */
  memoryValues: any;
  /** Updated load state */
  loadState: MemoryLoadState;
  /** Paths that were loaded */
  loadedPaths: string[];
  /** Errors encountered during loading */
  errors: Array<{ path: string; error: string }>;
}

/**
 * Populates memory values from the database based on visibility rules.
 * Only loads data that should be visible and hasn't been loaded yet.
 * 
 * @param fields Memory field definitions (with DB operations)
 * @param memoryValues Current memory values (will be mutated)
 * @param memoryState Current memory state (visibility, pagination)
 * @param loadState Current load state (tracks what's loaded)
 * @param options Population options
 */
export async function populateMemoryFromDB(
  fields: AgentMemoryFieldWithDB[],
  memoryValues: any,
  memoryState: MemoryState | undefined,
  loadState: MemoryLoadState,
  options: PopulateOptions
): Promise<PopulateResult> {
  const values = memoryValues ?? {};
  const state = memoryState ?? { visible: [], page: {} };
  const defaultLimit = options.defaultLimit ?? 50;
  const loadedPaths: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  // Get all visible paths
  const visiblePaths = getVisiblePaths(fields, memoryState);
  const sortedPaths = sortPathsByDepthAsc(visiblePaths);
  
  for (const path of sortedPaths) {
    try {
      // Resolve schema first to get cacheTTL
      const resolution = resolveSchemaWithContext(fields, values, path, options.baseContext);

      if (resolution.error) {
        errors.push({ path, error: resolution.error });
        continue;
      }

      if (!resolution.schema || !resolution.dbOps) {
        // No schema or DB ops - skip (in-memory only)
        continue;
      }

      const cacheTTL = resolution.schema?.cacheTTL;
      const shouldLoad = options.forceRefresh || needsLoading(loadState, path, values, cacheTTL);

      if (!shouldLoad) continue;

      const { schema, dbOps, context } = resolution;
      const tokens = splitPath(path);

      // Load based on field type
      if (schema.type === 'array' || schema.type === 'map' || schema.type === 'topic') {
        // Container type - prefer list, fall back to read
        if (dbOps.list) {
          const page = state.page[path] ?? { offset: 0, limit: defaultLimit };
          const result = await dbOps.list(context, page);

          // Transform items if needed
          const items = dbOps.fromDB
            ? result.items.map(item => dbOps.fromDB!(item))
            : result.items;

          // Set the value at the path and cache it
          if (schema.type === 'array') {
            setValueAtPath(values, tokens, items);
            markLoaded(loadState, path, result.total, items);
          } else if (schema.type === 'map' || schema.type === 'topic') {
            // For maps/topics, convert array to object using keys
            const obj: Record<string, any> = {};
            if (result.keys) {
              result.keys.forEach((key, i) => {
                obj[key] = items[i];
              });
            } else {
              // Assume items have a 'key' property
              items.forEach((item: any) => {
                if (item.key) {
                  const { key, ...rest } = item;
                  obj[key] = rest;
                }
              });
            }
            // Use merge to preserve any child data that was already loaded
            setValueAtPath(values, tokens, obj, { merge: true });
            markLoaded(loadState, path, result.total, obj);
          }
          loadedPaths.push(path);
        } else if (dbOps.read) {
          // Fallback: arrays/maps that store data as a single value (e.g., chatMemory JSON fields)
          // These have read/write but not list, so load the whole value at once
          const result = await dbOps.read(context);
          if (result !== undefined) {
            const value = dbOps.fromDB ? dbOps.fromDB(result) : result;
            setValueAtPath(values, tokens, value);
            const total = Array.isArray(value) ? value.length : undefined;
            markLoaded(loadState, path, total, value);
          } else {
            // Field exists but has no data yet — initialize to empty
            const emptyValue = schema.type === 'array' ? [] : {};
            setValueAtPath(values, tokens, emptyValue);
            markLoaded(loadState, path, 0, emptyValue);
          }
          loadedPaths.push(path);
        }
      } else if (schema.type === 'object') {
        // Object type - use read operation
        if (dbOps.read) {
          const result = await dbOps.read(context);
          if (result !== undefined) {
            const value = dbOps.fromDB ? dbOps.fromDB(result) : result;
            // Use merge to preserve any child data that was already loaded
            setValueAtPath(values, tokens, value, { merge: true });
            markLoaded(loadState, path, undefined, value);
          } else {
            markLoaded(loadState, path);
          }
          loadedPaths.push(path);
        }
      } else {
        // Primitive type - use read operation
        if (dbOps.read) {
          const result = await dbOps.read(context);
          if (result !== undefined) {
            const value = dbOps.fromDB ? dbOps.fromDB(result) : result;
            setValueAtPath(values, tokens, value);
            markLoaded(loadState, path, undefined, value);
          } else {
            markLoaded(loadState, path);
          }
          loadedPaths.push(path);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ path, error: message });
    }
  }

  return {
    memoryValues: values,
    loadState,
    loadedPaths,
    errors
  };
}

/**
 * Sets a value at a path in an object, creating intermediate objects/arrays as needed.
 * 
 * @param obj - The root object to modify
 * @param tokens - Path tokens (e.g., ['Context_Program', 'teamMembers'])
 * @param value - The value to set
 * @param options - Optional settings
 * @param options.merge - If true and both existing and new values are non-array objects,
 *                        merge them. Existing child data not in new value is preserved.
 */
function setValueAtPath(
  obj: any, 
  tokens: string[], 
  value: any,
  options?: { merge?: boolean }
): void {
  if (tokens.length === 0) return;
  
  let current = obj;
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i];
    const nextToken = tokens[i + 1];
    const isNextIndex = /^\d+$/.test(nextToken);
    
    if (current[token] === undefined) {
      current[token] = isNextIndex ? [] : {};
    }
    current = current[token];
  }
  
  const finalKey = tokens[tokens.length - 1];
  
  // Handle merge option for objects
  if (options?.merge) {
    const existing = current[finalKey];
    if (
      existing && 
      typeof existing === 'object' && 
      !Array.isArray(existing) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      // Merge: new value as base, preserve existing child data not in new value
      const merged = { ...value };
      for (const [key, existingVal] of Object.entries(existing)) {
        // Preserve existing nested objects/arrays that aren't in the new value
        if (merged[key] === undefined && existingVal !== undefined) {
          merged[key] = existingVal;
        }
      }
      current[finalKey] = merged;
      return;
    }
  }
  
  current[finalKey] = value;
}

/**
 * Gets a value at a path in an object.
 */
function getValueAtPath(obj: any, tokens: string[]): any {
  let current = obj;
  for (const token of tokens) {
    if (current === undefined || current === null) return undefined;
    current = current[token];
  }
  return current;
}

/**
 * Processes database operations for a memory tool action.
 * This should be called BEFORE processMemoryToolResponse to sync with DB.
 * 
 * @param fields Memory field definitions with DB operations
 * @param memoryValues Current memory values
 * @param loadState Current load state
 * @param op The operation to process
 * @param baseContext Base context for DB operations
 */
export async function processDBOperation(
  fields: AgentMemoryFieldWithDB[],
  memoryValues: any,
  loadState: MemoryLoadState,
  op: MemoryToolInput,
  baseContext: Record<string, any>
): Promise<DbOperationResult> {
  const { action, path, value, key, newKey, index } = op;
  
  // View/hide operations don't need DB sync
  if (action === 'view' || action === 'hide') {
    return { shouldUpdateMemory: true };
  }

  if (!path) {
    return { error: 'Path required for mutation operations', shouldUpdateMemory: false };
  }

  if (!hideLogs) console.log(`[processDBOperation] Action: ${action}, Path: ${path}`);
  if (!hideLogs) console.log(`[processDBOperation] Initial baseContext:`, baseContext);

  const resolution = resolveSchemaWithContext(fields, memoryValues, path, baseContext);
  
  if (resolution.error) {
    return { error: resolution.error, shouldUpdateMemory: false };
  }

  const { schema, dbOps, context, parentContainerDbOps, parentContainerKey, parentContainerPath } = resolution;

  // If no DB operations defined at the target path, check if we can use parent container operations
  if (!dbOps) {
    // For 'set' action on an OBJECT property, try to use parent container's update OR write operation
    // IMPORTANT: Do NOT use this for array items — writing {"3": value} to an array field corrupts the data.
    // Array items should use the parent's write with the full array, not a partial object.
    const parentIsArray = parentContainerPath && resolveSchemaWithContext(fields, memoryValues, parentContainerPath, baseContext).schema?.type === 'array';
    if (action === 'set' && parentContainerDbOps && parentContainerPath && !parentIsArray) {
      try {
        // Extract the property name being set (last token in the path)
        const tokens = splitPath(path);
        const propertyName = tokens[tokens.length - 1];
        
        // Option 1: Parent has update op (for maps/arrays with specific key)
        if (parentContainerDbOps.update && parentContainerKey !== undefined) {
          const partialUpdate = { [propertyName]: value };
          await parentContainerDbOps.update(context, parentContainerKey, partialUpdate);
          markLoaded(loadState, parentContainerPath);
          return { dbResult: value, shouldUpdateMemory: true, dbSynced: true };
        }
        
        // Option 2: Parent has write op
        if (parentContainerDbOps.write) {
          if (!hideLogs) console.log(`[processDBOperation] Using parent object write at ${parentContainerPath}`);
          if (!hideLogs) console.log(`[processDBOperation] Property: ${propertyName}, Value:`, value);

          const parentTokens = splitPath(parentContainerPath);
          const targetTokens = splitPath(path);
          const depthFromParent = targetTokens.length - parentTokens.length;

          // Only use parent operations if target is 1-2 levels deep
          if (depthFromParent > 2) {
            console.warn(
              `[processDBOperation] SAFETY: Target path "${path}" is ${depthFromParent} levels ` +
              `deep from parent "${parentContainerPath}". Not using parent operations.`
            );
            return { shouldUpdateMemory: true, dbSynced: false };
          }

          // Read FULL current parent value from DB to avoid losing sibling properties
          let currentParentValue: any = {};
          if (parentContainerDbOps.read) {
            const dbParent = await parentContainerDbOps.read(context);
            if (dbParent && typeof dbParent === 'object') {
              currentParentValue = parentContainerDbOps.fromDB ? parentContainerDbOps.fromDB(dbParent) : dbParent;
            }
          }
          if (!currentParentValue || Object.keys(currentParentValue).length === 0) {
            currentParentValue = getValueAtPath(memoryValues, parentTokens) || {};
          }
          const parentExists = currentParentValue && Object.keys(currentParentValue).length > 0;

          // Merge property into the full parent object to preserve sibling properties
          const fullUpdate = { ...currentParentValue, [propertyName]: value };
          const writeResult = await parentContainerDbOps.write(context, fullUpdate);

          markLoaded(loadState, parentContainerPath);

          if (writeResult !== undefined) {
            const transformedResult = parentContainerDbOps.fromDB
              ? parentContainerDbOps.fromDB(writeResult)
              : writeResult;

            if (!parentExists) {
              // CREATE case: Parent didn't exist, apply full object to parent path
              if (!hideLogs) console.log(`[processDBOperation] Parent created, applying to ${parentContainerPath}`);
              return {
                dbResult: transformedResult,
                targetPath: parentContainerPath,
                shouldUpdateMemory: true,
                dbSynced: true
              };
            } else {
              // UPDATE case: Parent existed, just return the property value
              if (!hideLogs) console.log(`[processDBOperation] Parent updated, property value applied`);
              return {
                dbResult: undefined,  // Let in-memory handle it
                shouldUpdateMemory: true,
                dbSynced: true
              };
            }
          }

          // No result from write, let in-memory handle it
          return { shouldUpdateMemory: true, dbSynced: true };
        }
      } catch (err: any) {
        console.error('[processDBOperation] Parent container write/update failed:', err);
        return { error: err.message || 'DB write failed', shouldUpdateMemory: false, dbSynced: false };
      }
    }

    // For 'set' action on an array ITEM, read the full array, update the index, write back
    if (action === 'set' && parentIsArray && parentContainerDbOps?.write && parentContainerPath) {
      try {
        const itemIndex = parentContainerKey;
        if (typeof itemIndex !== 'number' || itemIndex < 0) {
          return { shouldUpdateMemory: true, dbSynced: false, error: `Invalid array index for set: ${itemIndex}` };
        }

        // Read current array from DB
        let currentArray: any[];
        if (parentContainerDbOps.read) {
          const dbValue = await parentContainerDbOps.read(context);
          currentArray = Array.isArray(dbValue) ? [...dbValue] : [];
        } else {
          // Fall back to in-memory value
          const parentTokens = splitPath(parentContainerPath);
          const memValue = getValueAtPath(memoryValues, parentTokens);
          currentArray = Array.isArray(memValue) ? [...memValue] : [];
        }

        if (itemIndex >= currentArray.length) {
          return { shouldUpdateMemory: true, dbSynced: false, error: `Array index ${itemIndex} out of bounds (length: ${currentArray.length})` };
        }

        // Update the specific index and write the full array back
        currentArray[itemIndex] = value;
        await parentContainerDbOps.write(context, currentArray);
        markLoaded(loadState, parentContainerPath);
        return { dbResult: value, shouldUpdateMemory: true, dbSynced: true };
      } catch (err: any) {
        console.error('[processDBOperation] Array item set failed:', err);
        return { error: err.message || 'DB set on array item failed', shouldUpdateMemory: false, dbSynced: false };
      }
    }

    // For 'add' action on an array property inside an object with write ops
    if (action === 'add' && parentContainerDbOps?.write && parentContainerPath) {
      try {
        const tokens = splitPath(path);
        const propertyName = tokens[tokens.length - 1];
        const parentTokens = splitPath(parentContainerPath);
        const targetTokens = splitPath(path);
        const depthFromParent = targetTokens.length - parentTokens.length;

        if (depthFromParent > 2) {
          console.warn(
            `[processDBOperation] SAFETY: Target path "${path}" is ${depthFromParent} levels ` +
            `deep from parent "${parentContainerPath}". Not using parent operations.`
          );
          return { shouldUpdateMemory: true, dbSynced: false };
        }

        // Read current parent value from in-memory (preferred) or DB
        let currentParentValue: any = getValueAtPath(memoryValues, parentTokens) || {};
        if (Object.keys(currentParentValue).length === 0 && parentContainerDbOps.read) {
          const dbParent = await parentContainerDbOps.read(context);
          if (dbParent && typeof dbParent === 'object') {
            currentParentValue = parentContainerDbOps.fromDB ? parentContainerDbOps.fromDB(dbParent) : dbParent;
          }
        }

        const currentArray = Array.isArray(currentParentValue[propertyName]) ? currentParentValue[propertyName] : [];
        const updatedArray = [...currentArray, value];
        // Merge with full parent to preserve sibling properties (RewardPreferences, AvoidTopics, etc.)
        const fullUpdate = { ...currentParentValue, [propertyName]: updatedArray };

        if (!hideLogs) console.log(`[processDBOperation] Using parent object write for 'add' at ${parentContainerPath}`);
        if (!hideLogs) console.log(`[processDBOperation] Array property: ${propertyName}, Adding:`, value);

        await parentContainerDbOps.write(context, fullUpdate);
        markLoaded(loadState, parentContainerPath);

        // Always return just the added value — the in-memory processor handles the array add.
        // Never return the full parent object as dbResult, since post-processing for 'add'
        // would try to set it as the last array element (corrupting the array).
        return { dbResult: value, shouldUpdateMemory: true, dbSynced: true };
      } catch (err: any) {
        console.error('[processDBOperation] Parent container add failed:', err);
        return { error: err.message || 'DB add failed', shouldUpdateMemory: false, dbSynced: false };
      }
    }
    
    // For 'delete' action, try to use parent container's delete operation
    // SAFETY: Only use parent delete if target is IMMEDIATE child of parent container
    if (action === 'delete' && parentContainerDbOps?.delete && parentContainerKey !== undefined && parentContainerPath) {
      // Calculate depth from parent container to target path
      const parentTokens = splitPath(parentContainerPath);
      const targetTokens = splitPath(path);
      const depthFromParent = targetTokens.length - parentTokens.length;
      
      // Only allow parent delete if target is exactly 1 level deeper (immediate child)
      if (depthFromParent === 1) {
        try {
          await parentContainerDbOps.delete(context, parentContainerKey);
          
          clearLoadState(loadState, parentContainerPath);
          
          return { shouldUpdateMemory: true, dbSynced: true };
        } catch (err: any) {
          console.error('[processDBOperation] Parent container delete failed:', err);
          return { error: err.message || 'DB delete failed', shouldUpdateMemory: false, dbSynced: false };
        }
      } else {
        // Target is too deeply nested - log warning and DON'T use parent delete
        console.warn(
          `[processDBOperation] SAFETY: Prevented parent container delete. ` +
          `Target path "${path}" is ${depthFromParent} levels deep from parent "${parentContainerPath}". ` +
          `Parent delete would operate at the wrong level.`
        );
      }
    }
    
    // No db ops and no appropriate parent operation available
    // Check if the root field has any db ops at all — if not, this is a purely
    // in-memory field (e.g. Context_Board) and mutations should succeed silently
    const rootFieldId = splitPath(path)[0];
    const rootField = rootFieldId ? findFieldById(fields, rootFieldId) : undefined;
    if (!rootField?.db) {
      // Purely in-memory field — let the memory system handle it, no error
      return { shouldUpdateMemory: true };
    }

    // Root field HAS db ops but this specific path doesn't — report error
    if (action === 'delete' || action === 'add' || action === 'set') {
      return {
        shouldUpdateMemory: true,
        dbSynced: false, // Explicitly false - operation was NOT persisted to DB
        error: `No database operation configured for '${action}' at path '${path}'. Changes are in-memory only.`
      };
    }
    
    // For other actions, just let in-memory system handle it
    return { shouldUpdateMemory: true };
  }

  try {
    let dbResult: any;
    // Track whether a DB operation was actually executed (some ops like clear/delete don't produce a dbResult)
    let dbExecuted = false;

    switch (action) {
      case 'set':
        if (dbOps.write) {
          const dbValue = dbOps.toDB ? dbOps.toDB(value) : value;
          const writeResult = await dbOps.write(context, dbValue);

          // If write returned a value, use it (transformed by fromDB if available)
          // Otherwise fall back to original value
          if (writeResult !== undefined) {
            dbResult = dbOps.fromDB ? dbOps.fromDB(writeResult) : writeResult;
          } else {
            dbResult = value;
          }
          markLoaded(loadState, path);
          dbExecuted = true;
        }
        break;

        case 'upsert':
          if (dbOps.upsert) {
            // Explicit upsert operation
            const valueWithContext = mergeInheritedContext(value, context);
            const dbValue = dbOps.toDB ? dbOps.toDB(valueWithContext) : valueWithContext;
            dbResult = await dbOps.upsert(context, dbValue, key ?? index);
            if (dbOps.fromDB) dbResult = dbOps.fromDB(dbResult);
            markLoaded(loadState, path);
            dbExecuted = true;
          } else if (dbOps.update && (key !== undefined || index !== undefined)) {
            // UPDATE existing item (has key or index)
            const keyOrIndex = key ?? index;
            const valueWithContext = mergeInheritedContext(value, context);
            const dbValue = dbOps.toDB ? dbOps.toDB(valueWithContext) : valueWithContext;
            dbResult = await dbOps.update(context, keyOrIndex!, dbValue);
            if (dbOps.fromDB) dbResult = dbOps.fromDB(dbResult);
            markLoaded(loadState, path);
            dbExecuted = true;
          } else if (dbOps.write) {
            // Fallback to write (for objects without key)
            const valueWithContext = mergeInheritedContext(value, context);
            const dbValue = dbOps.toDB ? dbOps.toDB(valueWithContext) : valueWithContext;
            const writeResult = await dbOps.write(context, dbValue);
            if (writeResult !== undefined) {
              dbResult = dbOps.fromDB ? dbOps.fromDB(writeResult) : writeResult;
            } else {
              dbResult = value;
            }
            markLoaded(loadState, path);
            dbExecuted = true;
          }
          break;

      case 'add':
        if (dbOps.add) {
          // Merge inherited context (parent IDs like goalId, studentId) into the value
          // This allows AI to add child records without explicitly specifying parent IDs
          const valueWithContext = mergeInheritedContext(value, context);
          const dbValue = dbOps.toDB ? dbOps.toDB(valueWithContext) : valueWithContext;
          dbResult = await dbOps.add(context, dbValue, { key, index });
          if (dbOps.fromDB) dbResult = dbOps.fromDB(dbResult);
          // Invalidate the container's total count
          markStale(loadState, path, false);
          dbExecuted = true;
        }
        break;

      case 'insert':
        if (dbOps.insert && index !== undefined) {
          const valueWithContext = mergeInheritedContext(value, context);
          const dbValue = dbOps.toDB ? dbOps.toDB(valueWithContext) : valueWithContext;
          dbResult = await dbOps.insert(context, dbValue, index);
          if (dbOps.fromDB) dbResult = dbOps.fromDB(dbResult);
          markStale(loadState, path, false);
          dbExecuted = true;
        } else if (dbOps.add) {
          const valueWithContext = mergeInheritedContext(value, context);
          const dbValue = dbOps.toDB ? dbOps.toDB(valueWithContext) : valueWithContext;
          dbResult = await dbOps.add(context, dbValue, { index });
          if (dbOps.fromDB) dbResult = dbOps.fromDB(dbResult);
          markStale(loadState, path, false);
          dbExecuted = true;
        }
        break;

      case 'delete':
        if (dbOps.delete) {
          // Need to figure out what to delete - get the key from the path or value
          const tokens = splitPath(path);
          const keyToDelete = context.currentKey ?? tokens[tokens.length - 1];
          await dbOps.delete(context, keyToDelete);
          clearLoadState(loadState, path);
          dbExecuted = true;
        }
        break;

      case 'clear':
        if (dbOps.clear) {
          await dbOps.clear(context);
          clearLoadState(loadState, path);
          dbExecuted = true;
        }
        break;

      case 'rename':
        if (dbOps.rename && newKey) {
          const tokens = splitPath(path);
          const oldKey = tokens[tokens.length - 1];
          await dbOps.rename(context, oldKey, newKey);
          // Update load state for the renamed path
          clearLoadState(loadState, path);
          dbExecuted = true;
        }
        break;
    }

    // dbSynced is true when ANY DB operation was executed (not just ones that return a value)
    return { dbResult, shouldUpdateMemory: true, dbSynced: dbExecuted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Database error: ${message}`, shouldUpdateMemory: false, dbSynced: false };
  }
}

/**
 * Processes a batch of memory operations with database sync.
 * 
 * This function:
 * 1. Processes DB operations for each mutation
 * 2. Calls the original processMemoryToolResponse for in-memory updates
 * 3. Handles loading data for view operations
 * 
 * @param fields Memory field definitions with DB operations
 * @param memoryValues Current memory values (will be mutated)
 * @param memoryState Current memory state
 * @param loadState Current load state
 * @param input Tool input (single op or batch)
 * @param baseContext Base context for DB operations
 * @param originalProcessor The original processMemoryToolResponse function
 */
export async function processMemoryToolWithDB(
  fields: AgentMemoryFieldWithDB[],
  memoryValues: any,
  memoryState: MemoryState | undefined,
  loadState: MemoryLoadState,
  input: MemoryToolInput | MemoryToolBatchInput,
  baseContext: Record<string, any>,
  originalProcessor: (
    fields: any[],
    values: any,
    state: MemoryState | undefined,
    input: any
  ) => { updatedMemoryValues: any; updatedMemoryState: MemoryState; results: MemoryOperationResult[] }
): Promise<{
  updatedMemoryValues: any;
  updatedMemoryState: MemoryState;
  updatedLoadState: MemoryLoadState;
  results: MemoryOperationResult[];
}> {
  // Normalize to batch
  const ops: MemoryToolInput[] = 'ops' in input
    ? input.ops
    : 'operations' in input
      ? input.operations
      : [input as MemoryToolInput];

  // Resolve display-key aliases (e.g., "My School" → actual UUID) before DB ops
  for (const op of ops) {
    if (op.path) op.path = resolveDisplayKeyPath(fields as AgentMemoryField[], memoryValues, op.path);
    if (op.paths) op.paths = op.paths.map((p: string) => resolveDisplayKeyPath(fields as AgentMemoryField[], memoryValues, p));
  }

  const dbResults: Map<number, DbOperationResult> = new Map();

  // Process DB operations first for mutations
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    
    if (op.action !== 'view' && op.action !== 'hide') {
      const result = await processDBOperation(
        fields,
        memoryValues,
        loadState,
        op,
        baseContext
      );
      // Only track DB results when the field actually has DB ops.
      // In-memory-only fields (e.g. Context_Board) return just { shouldUpdateMemory: true }
      // with no dbSynced/error — leaving them out of dbResults lets the memory-system
      // result drive ok/message (line ~1473: dbResult === undefined path).
      if (result.dbSynced !== undefined || result.error) {
        dbResults.set(i, result);
      }
    }
  }

  // Process in-memory updates using original processor
  const memResult = originalProcessor(fields as any[], memoryValues, memoryState, input);

  // Apply DB results to memory values
  // This ensures in-memory values match what was actually saved to DB (including generated IDs)
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const dbOpResult = dbResults.get(i);
    
    if (!dbOpResult?.dbSynced || dbOpResult.dbResult === undefined || !op.path) {
      continue;
    }

    const dbValue = dbOpResult.dbResult;
    const action = op.action;

    // For set/upsert: apply to the exact path (or targetPath for parent creates)
    // Note: 'upsert' is the AI's action for both create and update of items
    if (action === 'set' || action === 'upsert') {
      // For upsert with key/index, the path is the container - need to target the specific item
      let targetPath = dbOpResult.targetPath || op.path;
      
      if (action === 'upsert' && (op.key !== undefined || op.index !== undefined)) {
        // Upsert on a container item - target the specific entry
        const itemKey = op.key ?? op.index;
        targetPath = `${op.path}/${itemKey}`;
      }
      
      const shouldApply = targetPath !== op.path || 
        JSON.stringify(op.value) !== JSON.stringify(dbValue);
      
      if (shouldApply) {
        if (!hideLogs) console.log(`[processMemoryToolWithDB] Applying DB result to path ${targetPath}`);
        const tokens = splitPath(targetPath);
        setValueAtPath(memResult.updatedMemoryValues, tokens, dbValue, { merge: action === 'upsert' });
      }
      continue;
    }

    // For add/insert: update the newly added item with DB result
    if (action === 'add' || action === 'insert') {
      const containerTokens = splitPath(op.path);
      const container = getValueAtPath(memResult.updatedMemoryValues, containerTokens);
      
      if (!container) {
        if (!hideLogs) console.log(`[processMemoryToolWithDB] Container not found at ${op.path}, skipping`);
        continue;
      }

      // Handle arrays
      if (Array.isArray(container)) {
        const targetIndex = op.index ?? (container.length - 1);
        if (targetIndex >= 0 && targetIndex < container.length) {
          container[targetIndex] = dbValue;
          if (!hideLogs) console.log(`[processMemoryToolWithDB] Updated array[${targetIndex}] at ${op.path} with DB result`);
        }
        continue;
      }

      // Handle maps/objects
      if (typeof container === 'object') {
        // Determine the correct key for this entry
        // Priority: 1) DB-generated key via getDBKey, 2) op.key from AI
        const resolution = resolveSchemaWithContext(fields, memResult.updatedMemoryValues, op.path, baseContext);
        const dbKey = resolution.dbOps?.getDBKey?.(dbValue);
        const originalKey = op.key;
        
        if (dbKey && originalKey && dbKey !== originalKey) {
          // Key changed (e.g., temp key → ID-based key)
          // Remove old entry, add at correct key
          delete container[originalKey];
          container[dbKey] = dbValue;
          if (!hideLogs) console.log(`[processMemoryToolWithDB] Moved map entry '${originalKey}' → '${dbKey}' with DB result`);
        } else {
          // Use whichever key we have
          const finalKey = dbKey || originalKey;
          if (finalKey) {
            container[finalKey] = dbValue;
            if (!hideLogs) console.log(`[processMemoryToolWithDB] Updated map['${finalKey}'] at ${op.path} with DB result`);
          }
        }
      }
    }
  }

  // For view operations, load data from DB if needed
  const viewedPathsThisBatch = new Set<string>();
  for (const op of ops) {
    if (op.action === 'view') {
      const paths = op.paths ?? (op.path ? [op.path] : []);
      
      for (const rawPath of paths) {
        const containerPath = rawPath.replace(/\/\*$/, '');
        
        // ADD: Skip duplicates
        if (viewedPathsThisBatch.has(containerPath)) {
          if (!hideLogs) console.log(`[processMemoryToolWithDB] Skipping duplicate view: ${containerPath}`);
          continue;
        }
        viewedPathsThisBatch.add(containerPath);
        
        if (needsLoading(loadState, containerPath)) {
          // Resolve the CONTAINER path, not the wildcard path
          const resolution = resolveSchemaWithContext(
            fields,
            memResult.updatedMemoryValues,
            containerPath,  // ← Use container path, not rawPath
            baseContext
          );

          if (resolution.dbOps?.list || resolution.dbOps?.read) {
            try {
              await populateMemoryFromDB(
                fields,
                memResult.updatedMemoryValues,
                memResult.updatedMemoryState,
                loadState,
                {
                  baseContext,
                  defaultLimit: op.page?.limit ?? 50,
                  forceRefresh: false
                }
              );
            } catch (err) {
              console.error(`Failed to load data for path ${containerPath}:`, err);
            }
          }
        }
      }
    }
  }

  // Enhance results with simplified status (no separate dbSynced field)
  // - For mutations with DB ops: ok = true only if DB succeeded, ok = false with error message if DB failed
  // - For view/hide operations: ok from memory system (no DB involvement)
  // - For mutations without DB ops: ok from memory system
  const enhancedResults = memResult.results.map((result, i) => {
    // For view/hide with wildcards, results may be more than ops
    // Find the original op that generated this result by matching target paths
    let opIndex = i;
    let op = ops[i];
    
    // If no direct match, try to find the op that owns this result
    if (!op && result.target) {
      opIndex = ops.findIndex(o => {
        if (!o) return false;
        const paths = o.paths ?? (o.path ? [o.path] : []);
        return paths.some(p => {
          // Check if result.target matches or is a child of this op's path
          const basePath = p.replace(/\/\*$/, '');
          return result.target === p || 
                result.target === basePath || 
                result.target.startsWith(basePath + '/');
        });
      });
      op = ops[opIndex] ?? ops[0]; // Fall back to first op if no match
    }
    
    const dbResult = dbResults.get(opIndex);
    
    // Determine ok status and message based on operation type and DB result
    let ok: boolean;
    let message: string | undefined;
    
    if (op.action === 'view' || op.action === 'hide') {
      // View/hide operations don't involve DB writes - use memory system result
      ok = result.ok;
      message = result.message;
    } else if (dbResult === undefined) {
      // No DB operation was attempted (field has no DB ops) - use memory system result
      ok = result.ok;
      message = result.message;
    } else if (dbResult.error) {
      // DB operation failed - this is a failure
      ok = false;
      message = dbResult.error;
    } else if (dbResult.dbSynced === true) {
      // DB operation succeeded
      ok = true;
      message = undefined;
    } else {
      // DB operation was attempted but dbSynced is false/undefined - treat as failure
      ok = false;
      message = dbResult.error || 'Database operation did not complete successfully';
    }

    // Include actual key for add operations
    let actualKey: string | undefined;
    if (dbResult?.dbResult && op.path && (op.action === 'add' || op.action === 'insert')) {
      const resolution = resolveSchemaWithContext(fields, memResult.updatedMemoryValues, op.path, baseContext);
      if (resolution.dbOps?.getDBKey) {
        actualKey = String(resolution.dbOps.getDBKey(dbResult.dbResult));
      }
    }

    // Add summary for view operations
    let summary: string | undefined;
    if (op.action === 'view' && op.path) {
      const containerPath = op.path.replace(/\/\*$/, '');
      const tokens = splitPath(containerPath);
      const viewedValue = getValueAtPath(memResult.updatedMemoryValues, tokens);
      
      if (viewedValue === undefined || viewedValue === null) {
        summary = 'Path not found or not loaded';
      } else if (Array.isArray(viewedValue)) {
        summary = viewedValue.length === 0 
          ? 'Empty array (0 items)' 
          : `Array with ${viewedValue.length} item(s)`;
      } else if (typeof viewedValue === 'object') {
        const keys = Object.keys(viewedValue);
        if (keys.length === 0) {
          summary = 'Empty (0 items)';
        } else if (keys.length <= 5) {
          summary = `${keys.length} item(s): ${keys.join(', ')}`;
        } else {
          summary = `${keys.length} item(s): ${keys.slice(0, 5).join(', ')}...`;
        }
      } else {
        summary = `Value: ${String(viewedValue).slice(0, 50)}`;
      }
    }
    
    // Mark stale if DB succeeded but memory failed (edge case recovery)
    if (dbResult?.dbSynced === true && !result.ok && op.path) {
      const parentPath = op.path.split('/').slice(0, -1).join('/');
      if (parentPath) {
        markStale(loadState, parentPath, false);
      }
    }
    
    // Return result WITHOUT dbSynced field - success/failure is conveyed via ok/message
    return {
      target: result.target,
      action: result.action,
      ok,
      message,
      newPath: result.newPath,
      mutatedPaths: result.mutatedPaths,
      actualKey,
      summary,
    };
  });

  // Sync cached values with updated memory values
  syncCachedValues(loadState, memResult.updatedMemoryValues);

  return {
    updatedMemoryValues: memResult.updatedMemoryValues,
    updatedMemoryState: memResult.updatedMemoryState,
    updatedLoadState: loadState,
    results: enhancedResults
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Drizzle ORM Helpers (Optional - for convenience)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for generating DB operations from a Drizzle table.
 */
export interface DrizzleTableConfig<TTable = any> {
  /** The Drizzle table object */
  table: TTable;
  
  /** Database instance (for queries) */
  db: any;
  
  /** Column to use as the primary key */
  primaryKey: string;
  
  /** 
   * Function to build the WHERE clause for data isolation.
   * Receives the operation context and should return a Drizzle where condition.
   * 
   * @example
   * buildWhere: (ctx) => eq(table.agentInstanceId, ctx.all.agentInstanceId)
   */
  buildWhere: (ctx: DBOperationContext) => any;
  
  /**
   * Column to use for ordering (for arrays).
   * Determines the index order of items.
   */
  orderBy?: string;
  
  /**
   * Column mapping from memory field names to database column names.
   * If not provided, assumes 1:1 mapping.
   */
  columnMap?: Record<string, string>;
  
  /**
   * Columns to exclude from memory values.
   * Useful for internal fields like createdAt, updatedAt, etc.
   */
  excludeColumns?: string[];
  
  /**
   * Key column for map-type fields.
   * The value of this column becomes the map key.
   */
  keyColumn?: string;

  /**
   * Context extraction configuration.
   * Maps database columns to context keys for child queries.
   * 
   * @example
   * contextExtraction: { studentId: 'id' }
   * // When a row is loaded with id='abc', children will have ctx.inherited.studentId = 'abc'
   */
  contextExtraction?: Record<string, string>;
}

/**
 * Generates MemoryDBOperations from a Drizzle table configuration.
 * This is a convenience helper - you can also write custom operations.
 * 
 * @example
 * const studentOps = createDrizzleOperations({
 *   table: students,
 *   db: db,
 *   primaryKey: 'id',
 *   buildWhere: (ctx) => eq(students.agentInstanceId, ctx.all.agentInstanceId),
 *   orderBy: 'createdAt',
 *   excludeColumns: ['createdAt', 'updatedAt'],
 *   contextExtraction: { studentId: 'id' }
 * });
 */
export function createDrizzleOperations<T = any>(
  config: DrizzleTableConfig
): MemoryDBOperations<T> {
  const {
    table,
    db,
    primaryKey,
    buildWhere,
    orderBy,
    columnMap = {},
    excludeColumns = [],
    keyColumn,
    contextExtraction = {}
  } = config;

  // Helper to transform DB row to memory value
  const fromDB = (row: any): T => {
    if (!row) return row;
    const result: any = {};
    for (const [key, value] of Object.entries(row)) {
      if (excludeColumns.includes(key)) continue;
      // Reverse column mapping
      const memKey = Object.entries(columnMap).find(([_, dbCol]) => dbCol === key)?.[0] ?? key;
      result[memKey] = value;
    }
    return result as T;
  };

  // Helper to transform memory value to DB row
  const toDB = (value: T): any => {
    if (!value) return value;
    const result: any = {};
    for (const [key, val] of Object.entries(value as any)) {
      const dbKey = columnMap[key] ?? key;
      result[dbKey] = val;
    }
    return result;
  };

  return {
    fromDB,
    toDB,

    read: async (ctx) => {
      // This is a placeholder - actual Drizzle query would be:
      // return db.query[tableName].findFirst({ where: buildWhere(ctx) });
      throw new Error('Drizzle operations require actual db instance. Implement read() for your specific table.');
    },

    write: async (ctx, value) => {
      // Placeholder for upsert logic
      throw new Error('Drizzle operations require actual db instance. Implement write() for your specific table.');
    },

    list: async (ctx, { offset, limit }) => {
      // Placeholder - would use db.query with offset/limit
      throw new Error('Drizzle operations require actual db instance. Implement list() for your specific table.');
    },

    get: async (ctx, key) => {
      // Placeholder
      throw new Error('Drizzle operations require actual db instance. Implement get() for your specific table.');
    },

    add: async (ctx, value, options) => {
      // Placeholder
      throw new Error('Drizzle operations require actual db instance. Implement add() for your specific table.');
    },

    update: async (ctx, key, value) => {
      // Placeholder
      throw new Error('Drizzle operations require actual db instance. Implement update() for your specific table.');
    },

    delete: async (ctx, key) => {
      // Placeholder
      throw new Error('Drizzle operations require actual db instance. Implement delete() for your specific table.');
    },

    clear: async (ctx) => {
      // Placeholder
      throw new Error('Drizzle operations require actual db instance. Implement clear() for your specific table.');
    },

    extractChildContext: (value, key) => {
      if (!value) return {};
      const result: Record<string, any> = {};
      for (const [ctxKey, dbCol] of Object.entries(contextExtraction)) {
        result[ctxKey] = (value as any)[dbCol];
      }
      return result;
    },

    getDBKey: (value) => {
      return (value as any)?.[primaryKey];
    }
  };
}

/**
 * Convert MemoryLoadState to a JSON-serializable format for storage.
 */
export function serializeLoadState(loadState: MemoryLoadState): {
  loaded: string[];
  stale: string[];
  loadedAt: Record<string, number>;
  totals: Record<string, number>;
  cachedValues: Record<string, any>;
} {
  return {
    loaded: Array.from(loadState.loaded),
    stale: Array.from(loadState.stale),
    loadedAt: Object.fromEntries(loadState.loadedAt),
    totals: Object.fromEntries(loadState.totals),
    cachedValues: Object.fromEntries(loadState.cachedValues),
  };
}

/**
 * Convert stored load state back to MemoryLoadState.
 */
export function deserializeLoadState(stored: {
  loaded?: string[];
  stale?: string[];
  loadedAt?: Record<string, number>;
  totals?: Record<string, number>;
  cachedValues?: Record<string, any>;
}): MemoryLoadState {
  return {
    loaded: new Set(stored.loaded ?? []),
    stale: new Set(stored.stale ?? []),
    loadedAt: new Map(Object.entries(stored.loadedAt ?? {})),
    totals: new Map(Object.entries(stored.totals ?? {})),
    cachedValues: new Map(Object.entries(stored.cachedValues ?? {})),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Export Types for External Use
// ──────────────────────────────────────────────────────────────────────────────

export type {
  MemoryState
};