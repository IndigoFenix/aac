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

import type { MemoryState } from "@shared/schema";

// ──────────────────────────────────────────────────────────────────────────────
// Type Imports (copied from memory-system.ts for standalone compilation)
// ──────────────────────────────────────────────────────────────────────────────

export type MemoryPrimitiveType = 'string' | 'number' | 'integer' | 'boolean' | 'null';
export type MemoryCompositeType = 'object' | 'array' | 'map' | 'topic';
export type MemoryType = MemoryPrimitiveType | MemoryCompositeType;

// ──────────────────────────────────────────────────────────────────────────────
// Database Operation Context
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Context passed to all database operations.
 * Allows operations to be scoped to the correct data (e.g., agent instance, user, parent records).
 */
export interface DBOperationContext {
  /**
   * Base context provided at initialization.
   * Typically includes agentInstanceId, userId, or other top-level identifiers.
   */
  base: Record<string, any>;

  /**
   * Context inherited from parent items during traversal.
   * For example, when operating on `/students/0/goals`, this would include
   * the studentId extracted from the student at index 0.
   */
  inherited: Record<string, any>;

  /**
   * Combined context (base + inherited) for convenience.
   */
  get all(): Record<string, any>;

  /**
   * The full path being operated on (e.g., "/students/0/goals").
   */
  path: string;

  /**
   * Path split into tokens (e.g., ["students", "0", "goals"]).
   */
  pathTokens: string[];

  /**
   * The key/index of the current item within its parent container.
   * For `/students/0`, this would be "0".
   * For `/contacts/john`, this would be "john".
   */
  currentKey?: string | number;
}

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

// ──────────────────────────────────────────────────────────────────────────────
// Database Operations Interface
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Pagination parameters for list operations.
 */
export interface PaginationParams {
  offset: number;
  limit: number;
}

/**
 * Result from a list operation.
 */
export interface ListResult<T = any> {
  /** Items in the current page */
  items: T[];
  /** Total count of all items (for pagination UI) */
  total: number;
  /** 
   * For maps/topics: keys corresponding to each item.
   * For arrays: this can be omitted (indices are implicit from offset).
   */
  keys?: string[];
}

/**
 * Database operations that can be attached to a memory field.
 * All operations are optional - only implement what makes sense for each field.
 * 
 * @template T The type of data stored in this field
 */
export interface MemoryDBOperations<T = any> {
  /**
   * Read a single value.
   * Used for primitives and object fields (non-container types).
   * 
   * @example
   * // For a "profile" object field:
   * read: async (ctx) => {
   *   return db.query.profiles.findFirst({
   *     where: eq(profiles.agentInstanceId, ctx.all.agentInstanceId)
   *   });
   * }
   */
  read?: (ctx: DBOperationContext) => Promise<T | undefined>;

  /**
   * Write a single value.
   * Used for set/upsert on primitives and objects.
   * 
   * @example
   * // For a "profile" object field:
   * write: async (ctx, value) => {
   *   await db.insert(profiles)
   *     .values({ ...value, agentInstanceId: ctx.all.agentInstanceId })
   *     .onConflictDoUpdate({ target: profiles.agentInstanceId, set: value });
   * }
   */
  write?: (ctx: DBOperationContext, value: T) => Promise<void>;

  /**
   * List items in a container (array, map, topic) with pagination.
   * 
   * @example
   * // For a "students" array field:
   * list: async (ctx, { offset, limit }) => {
   *   const items = await db.query.students.findMany({
   *     where: eq(students.agentInstanceId, ctx.all.agentInstanceId),
   *     offset,
   *     limit,
   *     orderBy: students.createdAt
   *   });
   *   const [{ count }] = await db.select({ count: sql`count(*)` })
   *     .from(students)
   *     .where(eq(students.agentInstanceId, ctx.all.agentInstanceId));
   *   return { items, total: Number(count) };
   * }
   */
  list?: (ctx: DBOperationContext, pagination: PaginationParams) => Promise<ListResult<T>>;

  /**
   * Get a single item from a container by key/index.
   * 
   * @example
   * // For array by index (assuming ordered by some field):
   * get: async (ctx, index) => {
   *   const items = await db.query.students.findMany({
   *     where: eq(students.agentInstanceId, ctx.all.agentInstanceId),
   *     offset: Number(index),
   *     limit: 1
   *   });
   *   return items[0];
   * }
   * 
   * // For map by key:
   * get: async (ctx, key) => {
   *   return db.query.contacts.findFirst({
   *     where: and(
   *       eq(contacts.agentInstanceId, ctx.all.agentInstanceId),
   *       eq(contacts.key, key)
   *     )
   *   });
   * }
   */
  get?: (ctx: DBOperationContext, key: string | number) => Promise<T | undefined>;

  /**
   * Add an item to a container.
   * Returns the created item (potentially with generated ID, timestamps, etc.).
   * 
   * @example
   * // For arrays:
   * add: async (ctx, value, options) => {
   *   const [created] = await db.insert(students)
   *     .values({ ...value, agentInstanceId: ctx.all.agentInstanceId })
   *     .returning();
   *   return created;
   * }
   * 
   * // For nested arrays (e.g., goals inside a student):
   * add: async (ctx, value, options) => {
   *   const [created] = await db.insert(goals)
   *     .values({ ...value, studentId: ctx.all.studentId })
   *     .returning();
   *   return created;
   * }
   */
  add?: (ctx: DBOperationContext, value: T, options?: { key?: string; index?: number }) => Promise<T>;

  /**
   * Insert an item at a specific index (for arrays only).
   * If not implemented, falls back to add().
   */
  insert?: (ctx: DBOperationContext, value: T, index: number) => Promise<T>;

  /**
   * Update an existing item in a container.
   * 
   * @example
   * update: async (ctx, key, value) => {
   *   const [updated] = await db.update(students)
   *     .set(value)
   *     .where(and(
   *       eq(students.agentInstanceId, ctx.all.agentInstanceId),
   *       eq(students.id, key)
   *     ))
   *     .returning();
   *   return updated;
   * }
   */
  update?: (ctx: DBOperationContext, key: string | number, value: Partial<T>) => Promise<T>;

  /**
   * Upsert (update or insert) an item.
   * For containers: updates if key exists, creates if not.
   * For non-containers: same as write().
   */
  upsert?: (ctx: DBOperationContext, value: T, key?: string | number) => Promise<T>;

  /**
   * Delete an item from a container.
   */
  delete?: (ctx: DBOperationContext, key: string | number) => Promise<void>;

  /**
   * Rename a key (for maps and topics only).
   */
  rename?: (ctx: DBOperationContext, oldKey: string, newKey: string) => Promise<void>;

  /**
   * Clear all items from a container.
   */
  clear?: (ctx: DBOperationContext) => Promise<void>;

  /**
   * Extract context values from a loaded item.
   * Called when traversing into a child field - allows parent's DB ID to flow to child queries.
   * 
   * @example
   * // When a student is loaded with { id: 'db-123', name: 'John' }:
   * extractChildContext: (value, key) => ({ studentId: value.id })
   * 
   * // This means when accessing /students/0/goals, the goals query
   * // will have ctx.inherited.studentId = 'db-123'
   */
  extractChildContext?: (value: T, key?: string | number) => Record<string, any>;

  /**
   * Transform data from database format to memory format.
   * Called after reading from DB, before storing in memoryValues.
   * Returns any JSON-serializable value that matches the memory field schema.
   * 
   * @example
   * // Strip internal fields, rename columns, etc.
   * fromDB: (dbRow) => ({
   *   name: dbRow.full_name,
   *   email: dbRow.email_address
   * })
   */
  fromDB?: (dbValue: T) => any;

  /**
   * Transform data from memory format to database format.
   * Called before writing to DB.
   * 
   * @example
   * toDB: (memValue) => ({
   *   full_name: memValue.name,
   *   email_address: memValue.email
   * })
   */
  toDB?: (memValue: T) => any;

  /**
   * Get the database key/ID from a memory value.
   * Used to identify which DB record to update/delete.
   * 
   * @example
   * getDBKey: (value) => value.id
   */
  getDBKey?: (value: T) => string | number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Extended Memory Field Types (with DB operations)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Base memory field with optional database operations.
 */
export interface AgentMemoryFieldBaseWithDB {
  id: string;
  type: MemoryType;
  title?: string;
  description?: string;
  default?: any;
  enum?: any[];
  const?: any;
  examples?: any[];
  opened?: boolean;
  
  // String constraints
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  
  // Number constraints
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;

  /**
   * Database operations for this field.
   * If not provided, the field uses in-memory storage only (original behavior).
   */
  db?: MemoryDBOperations;
}

export interface AgentMemoryFieldObjectWithDB extends AgentMemoryFieldBaseWithDB {
  type: 'object';
  properties: Record<string, AgentMemoryFieldWithDB>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface AgentMemoryFieldArrayWithDB extends AgentMemoryFieldBaseWithDB {
  type: 'array';
  items: AgentMemoryFieldWithDB;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

export interface AgentMemoryFieldMapWithDB extends AgentMemoryFieldBaseWithDB {
  type: 'map';
  values: AgentMemoryFieldWithDB;
  keyPattern?: string;
  minProperties?: number;
  maxProperties?: number;
}

export interface AgentMemoryFieldTopicWithDB extends AgentMemoryFieldBaseWithDB {
  type: 'topic';
  maxDepth?: number;
  maxBreadthPerNode?: number;
}

export type AgentMemoryFieldWithDB =
  | AgentMemoryFieldObjectWithDB
  | AgentMemoryFieldArrayWithDB
  | AgentMemoryFieldMapWithDB
  | AgentMemoryFieldTopicWithDB
  | (AgentMemoryFieldBaseWithDB & { type: MemoryPrimitiveType });

// ──────────────────────────────────────────────────────────────────────────────
// Memory Load State (tracks what's loaded from DB)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Tracks the loading state of memory fields.
 * Used to know what's already loaded vs. needs to be fetched from DB.
 */
export interface MemoryLoadState {
  /**
   * Set of paths that have been loaded from the database.
   * Paths are normalized (e.g., "/students", "/students/0/goals").
   */
  loaded: Set<string>;

  /**
   * Set of paths that need to be refreshed from the database.
   * Used when external changes may have occurred.
   */
  stale: Set<string>;

  /**
   * Timestamp of last load for each path.
   * Can be used for cache invalidation.
   */
  loadedAt: Map<string, number>;

  /**
   * Total counts for paginated containers.
   * Key is the container path, value is the total item count.
   */
  totals: Map<string, number>;
}

/**
 * Creates a new MemoryLoadState.
 */
export function createMemoryLoadState(): MemoryLoadState {
  return {
    loaded: new Set(),
    stale: new Set(),
    loadedAt: new Map(),
    totals: new Map()
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Load State Serialization (for persistence in ChatState)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * JSON-serializable version of MemoryLoadState.
 * Used for storing in ChatState between messages.
 */
export interface SerializedLoadState {
  /** Paths that have been loaded (as array for JSON compatibility) */
  loaded: string[];
  /** Paths that need refresh */
  stale: string[];
  /** Timestamp of last load for each path */
  loadedAt: Record<string, number>;
  /** Total counts for paginated containers */
  totals: Record<string, number>;
}

/**
 * Converts MemoryLoadState to a JSON-serializable format.
 * Use this before storing in ChatState.
 */
export function serializeLoadState(loadState: MemoryLoadState): SerializedLoadState {
  return {
    loaded: Array.from(loadState.loaded),
    stale: Array.from(loadState.stale),
    loadedAt: Object.fromEntries(loadState.loadedAt),
    totals: Object.fromEntries(loadState.totals),
  };
}

/**
 * Converts a serialized load state back to MemoryLoadState.
 * Use this when retrieving from ChatState.
 */
export function deserializeLoadState(stored: SerializedLoadState): MemoryLoadState {
  return {
    loaded: new Set(stored.loaded),
    stale: new Set(stored.stale),
    loadedAt: new Map(Object.entries(stored.loadedAt)),
    totals: new Map(Object.entries(stored.totals)),
  };
}

/**
 * Marks a path as loaded.
 */
export function markLoaded(state: MemoryLoadState, path: string, total?: number): void {
  const normalized = normalizePath(path);
  state.loaded.add(normalized);
  state.stale.delete(normalized);
  state.loadedAt.set(normalized, Date.now());
  if (total !== undefined) {
    state.totals.set(normalized, total);
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
 * Checks if a path needs loading (not loaded or stale).
 */
export function needsLoading(state: MemoryLoadState, path: string): boolean {
  const normalized = normalizePath(path);
  return !state.loaded.has(normalized) || state.stale.has(normalized);
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
  
  // Also clear descendants
  for (const p of [...state.loaded, ...state.stale]) {
    if (p.startsWith(normalized + '/')) {
      state.loaded.delete(p);
      state.stale.delete(p);
      state.loadedAt.delete(p);
      state.totals.delete(p);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Path Utilities
// ──────────────────────────────────────────────────────────────────────────────

const ROOT = '';

function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function normalizePath(path: string | undefined | null): string {
  if (!path) return ROOT;
  let p = path.trim();
  if (p === '' || p === '/') return ROOT;
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/+/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

function splitPath(path: string): string[] {
  const p = normalizePath(path);
  if (p === ROOT) return [];
  return p.slice(1).split('/').map(unescapeToken);
}

function joinPath(tokens: string[]): string {
  if (!tokens.length) return ROOT;
  return '/' + tokens.map(escapeToken).join('/');
}

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
 * Result of resolving a schema path.
 */
export interface SchemaResolution {
  /** The resolved schema at the target path */
  schema?: AgentMemoryFieldWithDB;
  /** Database operations at the target (may be inherited from parent) */
  dbOps?: MemoryDBOperations;
  /** Context built up by traversing parent items */
  context: DBOperationContext;
  /** Error message if resolution failed */
  error?: string;
  /** The parent schema (for container items) */
  parentSchema?: AgentMemoryFieldWithDB;
  /** Path tokens consumed */
  tokensConsumed: string[];
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

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    const currentPath = joinPath(consumedTokens);
    const nextPath = joinPath([...consumedTokens, token]);

    // Extract context from current value if available
    if (currentValue !== undefined && current.db?.extractChildContext) {
      const extractedCtx = current.db.extractChildContext(currentValue, consumedTokens[consumedTokens.length - 1]);
      if (extractedCtx) {
        ctx = extendContext(ctx, extractedCtx, nextPath, token);
      }
    } else {
      ctx = extendContext(ctx, {}, nextPath, token);
    }

    consumedTokens.push(token);

    if (current.type === 'object') {
      const objSchema = current as AgentMemoryFieldObjectWithDB;
      const propSchema = objSchema.properties?.[token];
      
      if (!propSchema && !objSchema.additionalProperties) {
        return {
          context: ctx,
          tokensConsumed: consumedTokens,
          error: `Property '${token}' not allowed in object.`
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
          parentSchema: objSchema
        };
      }
    } else if (current.type === 'array') {
      const arrSchema = current as AgentMemoryFieldArrayWithDB;
      const index = parseInt(token, 10);
      
      if (isNaN(index)) {
        return {
          context: ctx,
          tokensConsumed: consumedTokens,
          error: `Expected array index, got '${token}'.`
        };
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
      current = mapSchema.values;
      currentValue = currentValue?.[token];
      
      // Extract context from the map value
      if (currentValue !== undefined && mapSchema.db?.extractChildContext) {
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
        tokensConsumed: consumedTokens
      };
    } else {
      // Primitive type - can't traverse further
      return {
        context: ctx,
        tokensConsumed: consumedTokens.slice(0, -1),
        error: `Cannot traverse into primitive at '${currentPath}'.`
      };
    }
  }

  return {
    schema: current,
    dbOps: current.db,
    context: ctx,
    tokensConsumed: consumedTokens,
    parentSchema: consumedTokens.length > 1 ? findFieldById(fields, consumedTokens[0]) : undefined
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

  // Sort by path depth (shortest first = parents first)
  // This ensures parent objects are loaded before their children,
  // so child data isn't overwritten when parent loads later
  visiblePaths.sort((a, b) => {
    const depthA = a.split('/').filter(Boolean).length;
    const depthB = b.split('/').filter(Boolean).length;
    return depthA - depthB;
  });

  // Process each visible path
  for (const path of visiblePaths) {
    try {
      const shouldLoad = options.forceRefresh || needsLoading(loadState, path);
      
      if (!shouldLoad) continue;

      const resolution = resolveSchemaWithContext(fields, values, path, options.baseContext);
      
      if (resolution.error) {
        errors.push({ path, error: resolution.error });
        continue;
      }

      if (!resolution.schema || !resolution.dbOps) {
        // No schema or DB ops - skip (in-memory only)
        continue;
      }

      const { schema, dbOps, context } = resolution;
      const tokens = splitPath(path);

      // Load based on field type
      if (schema.type === 'array' || schema.type === 'map' || schema.type === 'topic') {
        // Container type - use list operation
        if (dbOps.list) {
          const page = state.page[path] ?? { offset: 0, limit: defaultLimit };
          const result = await dbOps.list(context, page);
          
          // Transform items if needed
          const items = dbOps.fromDB 
            ? result.items.map(item => dbOps.fromDB!(item))
            : result.items;

          // Set the value at the path
          if (schema.type === 'array') {
            setValueAtPath(values, tokens, items);
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
          }

          markLoaded(loadState, path, result.total);
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
          }
          markLoaded(loadState, path);
          loadedPaths.push(path);
        }
      } else {
        // Primitive type - use read operation
        if (dbOps.read) {
          const result = await dbOps.read(context);
          if (result !== undefined) {
            const value = dbOps.fromDB ? dbOps.fromDB(result) : result;
            setValueAtPath(values, tokens, value);
          }
          markLoaded(loadState, path);
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

// ──────────────────────────────────────────────────────────────────────────────
// Database-Aware Memory Tool Processing
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Memory action types (from memory-system.ts).
 */
export type MemoryAction =
  | 'view' | 'hide'
  | 'set' | 'upsert'
  | 'add' | 'insert'
  | 'delete' | 'clear'
  | 'rename';

/**
 * Single memory operation input.
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
 * Batch of memory operations.
 */
export type MemoryToolBatchInput = { ops: MemoryToolInput[] } | { operations: MemoryToolInput[] };

/**
 * Result of a single memory operation.
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
): Promise<{
  dbResult?: any;
  error?: string;
  shouldUpdateMemory: boolean;
}> {
  const { action, path, value, key, newKey, index } = op;
  
  // View/hide operations don't need DB sync
  if (action === 'view' || action === 'hide') {
    return { shouldUpdateMemory: true };
  }

  if (!path) {
    return { error: 'Path required for mutation operations', shouldUpdateMemory: false };
  }

  const resolution = resolveSchemaWithContext(fields, memoryValues, path, baseContext);
  
  if (resolution.error) {
    return { error: resolution.error, shouldUpdateMemory: false };
  }

  const { schema, dbOps, context } = resolution;

  // If no DB operations defined, just let the in-memory system handle it
  if (!dbOps) {
    return { shouldUpdateMemory: true };
  }

  try {
    let dbResult: any;

    switch (action) {
      case 'set':
        if (dbOps.write) {
          const dbValue = dbOps.toDB ? dbOps.toDB(value) : value;
          await dbOps.write(context, dbValue);
          dbResult = value;
          markLoaded(loadState, path);
        }
        break;

      case 'upsert':
        if (dbOps.upsert) {
          const dbValue = dbOps.toDB ? dbOps.toDB(value) : value;
          dbResult = await dbOps.upsert(context, dbValue, key ?? index);
          if (dbOps.fromDB) dbResult = dbOps.fromDB(dbResult);
          markLoaded(loadState, path);
        } else if (dbOps.write) {
          const dbValue = dbOps.toDB ? dbOps.toDB(value) : value;
          await dbOps.write(context, dbValue);
          dbResult = value;
          markLoaded(loadState, path);
        }
        break;

      case 'add':
        if (dbOps.add) {
          const dbValue = dbOps.toDB ? dbOps.toDB(value) : value;
          dbResult = await dbOps.add(context, dbValue, { key, index });
          if (dbOps.fromDB) dbResult = dbOps.fromDB(dbResult);
          // Invalidate the container's total count
          markStale(loadState, path, false);
        }
        break;

      case 'insert':
        if (dbOps.insert && index !== undefined) {
          const dbValue = dbOps.toDB ? dbOps.toDB(value) : value;
          dbResult = await dbOps.insert(context, dbValue, index);
          if (dbOps.fromDB) dbResult = dbOps.fromDB(dbResult);
          markStale(loadState, path, false);
        } else if (dbOps.add) {
          const dbValue = dbOps.toDB ? dbOps.toDB(value) : value;
          dbResult = await dbOps.add(context, dbValue, { index });
          if (dbOps.fromDB) dbResult = dbOps.fromDB(dbResult);
          markStale(loadState, path, false);
        }
        break;

      case 'delete':
        if (dbOps.delete) {
          // Need to figure out what to delete - get the key from the path or value
          const tokens = splitPath(path);
          const keyToDelete = context.currentKey ?? tokens[tokens.length - 1];
          await dbOps.delete(context, keyToDelete);
          clearLoadState(loadState, path);
        }
        break;

      case 'clear':
        if (dbOps.clear) {
          await dbOps.clear(context);
          clearLoadState(loadState, path);
        }
        break;

      case 'rename':
        if (dbOps.rename && newKey) {
          const tokens = splitPath(path);
          const oldKey = tokens[tokens.length - 1];
          await dbOps.rename(context, oldKey, newKey);
          // Update load state for the renamed path
          clearLoadState(loadState, path);
        }
        break;
    }

    return { dbResult, shouldUpdateMemory: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Database error: ${message}`, shouldUpdateMemory: false };
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

  const dbResults: Map<number, { dbResult?: any; error?: string }> = new Map();

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
      dbResults.set(i, result);
      
      // If DB operation failed, we might want to skip the in-memory update
      // For now, we still allow in-memory updates even if DB fails
    }
  }

  // Process in-memory updates using original processor
  const memResult = originalProcessor(fields as any[], memoryValues, memoryState, input);

  // Enhance results with DB sync status
  const enhancedResults = memResult.results.map((result, i) => ({
    ...result,
    dbSynced: dbResults.has(i) ? !dbResults.get(i)?.error : undefined,
    message: dbResults.get(i)?.error ?? result.message
  }));

  // For view operations, load data from DB if needed
  for (const op of ops) {
    if (op.action === 'view') {
      const paths = op.paths ?? (op.path ? [op.path] : []);
      
      for (const path of paths) {
        if (needsLoading(loadState, path)) {
          const resolution = resolveSchemaWithContext(
            fields,
            memResult.updatedMemoryValues,
            path,
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
              console.error(`Failed to load data for path ${path}:`, err);
            }
          }
        }
      }
    }
  }

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

// ──────────────────────────────────────────────────────────────────────────────
// Export Types for External Use
// ──────────────────────────────────────────────────────────────────────────────

export type {
  MemoryState
};