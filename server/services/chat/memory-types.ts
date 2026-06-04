/**
 * memory-types.ts
 * 
 * Shared type definitions for the memory system.
 * Used by both memory-system.ts and memory-db-bridge.ts
 * 
 * This file should remain platform-agnostic and contain no runtime code.
 */

// ──────────────────────────────────────────────────────────────────────────────
// Core Memory Types
// ──────────────────────────────────────────────────────────────────────────────

export type MemoryPrimitiveType = 'string' | 'number' | 'integer' | 'boolean' | 'null';
export type MemoryCompositeType = 'object' | 'array' | 'map' | 'topic';
export type MemoryType = MemoryPrimitiveType | MemoryCompositeType;

// ──────────────────────────────────────────────────────────────────────────────
// Memory Field Schema Definitions (Base - no DB operations)
// ──────────────────────────────────────────────────────────────────────────────

export interface AgentMemoryFieldBase {
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
   * Cache TTL in milliseconds. If set, the cached value will be reloaded from
   * the database after this time has elapsed. If not set, cached values are
   * used indefinitely within the session.
   */
  cacheTTL?: number;
  /**
   * When true, the field is read-only: the AI can view it but the visualization
   * will not show mutation hints and the tool handler will reject mutations.
   */
  readOnly?: boolean;
  /**
   * Declares that the field's list() operation supports string search. The
   * named sub-fields identify which columns/properties are indexed for matching.
   * Only meaningful for container fields (array/map/topic) with a db.list backend.
   * IMPORTANT: any field that sets this MUST ship with a matching GIN trigram
   * index in a migration — the validator at scripts/validate-memory-indexes.ts
   * enforces this.
   */
  searchable?: { fields: string[] };
  /**
   * Name of the underlying DB table backing this field's list() operation.
   * Used only by scripts/validate-memory-indexes.ts to verify that declared
   * `searchable` fields have matching GIN trigram / tsvector indexes.
   * Not read at runtime.
   */
  searchTable?: string;
  /**
   * Declares that the field's list() operation supports date-range filtering.
   * `field` is the name of the date column/property used as the filter axis.
   * Only meaningful for container fields with a db.list backend.
   */
  dateFilterable?: { field: string };
}

export interface AgentMemoryFieldObject extends AgentMemoryFieldBase {
  type: 'object';
  properties: Record<string, AgentMemoryField>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface AgentMemoryFieldArray extends AgentMemoryFieldBase {
  type: 'array';
  items: AgentMemoryField;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

export interface AgentMemoryFieldMap extends AgentMemoryFieldBase {
  type: 'map';
  values: AgentMemoryField;
  /** Property name of the value object to use as display label and path alias.
   *  When set, map entries are rendered with this field's value instead of the raw key,
   *  and the AI can target entries by this value in paths. */
  displayKey?: string;
  keyPattern?: string;
  minProperties?: number;
  maxProperties?: number;
}

export interface AgentMemoryFieldTopic extends AgentMemoryFieldBase {
  type: 'topic';
  maxDepth?: number;
  maxBreadthPerNode?: number;
}

export type AgentMemoryField =
  | AgentMemoryFieldObject
  | AgentMemoryFieldArray
  | AgentMemoryFieldMap
  | AgentMemoryFieldTopic
  | (AgentMemoryFieldBase & { type: MemoryPrimitiveType });

// ──────────────────────────────────────────────────────────────────────────────
// Topic Tree Structure
// ──────────────────────────────────────────────────────────────────────────────

export interface TopicNode {
  description?: string;
  subtopics: Record<string, TopicNode>;
}

export type TopicTree = Record<string, TopicNode>;

// ──────────────────────────────────────────────────────────────────────────────
// Memory Actions and Operations
// ──────────────────────────────────────────────────────────────────────────────

export type MemoryAction =
  | 'view' | 'hide'
  | 'set' | 'upsert'
  | 'add' | 'insert'
  | 'delete' | 'clear'
  | 'rename';

export interface MemoryToolInput {
  action: MemoryAction;
  /** Single target path OR an array of paths. Exactly one of these must be provided. */
  path?: string;
  paths?: string[];
  /** Value for set/upsert/add/insert; for topics, string value here targets "description" unless a node object is supplied. */
  value?: any;
  /** For insert (array) or upsert (array), index position. 0..length */
  index?: number;
  /** For add to map/topic: new key (required). For map rename/topic rename: the new key name. */
  key?: string;
  newKey?: string;
  /** Optional pagination for view (container paths only). */
  page?: { offset?: number; limit?: number };
  /** Optional filters for view on container paths whose field declares searchable / dateFilterable. */
  filter?: ListFilters;
  /** For view: if true and path is a container (no *), also make its immediate children visible. Default true for objects; false for others. */
  openChildren?: boolean;
}

export type MemoryToolBatchInput = { ops: MemoryToolInput[] } | { operations: MemoryToolInput[] };
export type MemoryToolCallInput = MemoryToolInput | MemoryToolBatchInput;

/**
 * Result of a memory operation.
 * 
 * SIMPLIFIED: Removed dbSynced field. The response semantics are now:
 * - ok: true = operation succeeded (in-memory and database if applicable)
 * - ok: false = operation failed (with message explaining why)
 * 
 * For fields without database operations, success means in-memory success.
 * For fields with database operations, success requires both in-memory and DB success.
 */
export interface MemoryOperationResult {
  target: string;
  action: MemoryAction;
  ok: boolean;
  message?: string;
  newPath?: string;          // e.g., after rename
  mutatedPaths?: string[];   // concrete paths touched (esp. when wildcard expands)
  summary?: string;          // Summary of viewed data (for view operations)
  actualKey?: string;        // The actual key used (for add operations where key may be generated)
}

export interface MemoryToolResponseProcessed {
  updatedMemoryValues: any;
  updatedMemoryState: MemoryState;
  results: MemoryOperationResult[];
}

// ──────────────────────────────────────────────────────────────────────────────
// Memory State (visibility and pagination)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * MemoryState tracks what the AI can currently see and pagination settings.
 * This should match the definition in @shared/schema if one exists there.
 */
export interface MemoryState {
  /** Paths that are currently visible to the AI */
  visible: string[];
  /** Pagination settings per container path */
  page: Record<string, { offset: number; limit: number }>;
  /** Active list filters per container path (search + date range) */
  filters?: Record<string, ListFilters>;
  /** When true, the memory prompt is rendered once and frozen until compression */
  staticPromptMode?: boolean;
  /** Cached rendered prompt — set on first render in static mode, cleared on compression */
  _cachedPrompt?: string;
  /** Optional: cached load state for session restoration */
  loadStateCache?: {
    loaded: string[];
    stale: string[];
    loadedAt: Record<string, number>;
    totals: Record<string, number>;
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Schema Step (for path resolution)
// ──────────────────────────────────────────────────────────────────────────────

export type SchemaStep =
  | { kind: 'field'; schema: AgentMemoryField; fieldId: string }
  | { kind: 'objectProp'; schema: AgentMemoryFieldObject; propName: string; propSchema: AgentMemoryField }
  | { kind: 'arrayItem'; schema: AgentMemoryFieldArray; index: number; itemSchema: AgentMemoryField }
  | { kind: 'mapValue'; schema: AgentMemoryFieldMap; key: string; valueSchema: AgentMemoryField }
  | { kind: 'topic'; schema: AgentMemoryFieldTopic; nodePath: string[] }
  | { kind: 'topicDescription'; schema: AgentMemoryFieldTopic; nodePath: string[] }
  | { kind: 'topicSubtopics'; schema: AgentMemoryFieldTopic; nodePath: string[] };

// ──────────────────────────────────────────────────────────────────────────────
// Database Operations Interface (for memory-db-bridge)
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
  readonly all: Record<string, any>;

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
 * Pagination parameters for list operations.
 */
export interface PaginationParams {
  offset: number;
  limit: number;
}

/**
 * Filters passed to list operations on fields that declare searchable / dateFilterable.
 * Dates are ISO-8601 strings (yyyy-mm-dd or full timestamp).
 */
export interface ListFilters {
  search?: string;
  dateFrom?: string;
  dateTo?: string;
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
   */
  read?: (ctx: DBOperationContext) => Promise<T | undefined>;

  /**
   * Write a value.
   * Used for set/upsert on primitives, objects, and whole containers.
   * For array-valued fields, `value` may be T[] and the return may be T[]
   * (bulk-replace semantics — see objectivesOps.write for an example).
   * Can optionally return the written value (e.g., after sanitization/transformation).
   */
  write?: (ctx: DBOperationContext, value: T | T[]) => Promise<T | T[] | void>;

  /**
   * List items in a container (array, map, topic) with pagination.
   * Filters are only present when the field's schema declares them (searchable / dateFilterable);
   * otherwise the tool layer rejects filter input before it reaches here.
   */
  list?: (ctx: DBOperationContext, pagination: PaginationParams, filters?: ListFilters) => Promise<ListResult<T>>;

  /**
   * Get a single item from a container by key/index.
   */
  get?: (ctx: DBOperationContext, key: string | number) => Promise<T | undefined>;

  /**
   * Add an item to a container.
   * Returns the created item (potentially with generated ID, timestamps, etc.).
   */
  add?: (ctx: DBOperationContext, value: T, options?: { key?: string; index?: number }) => Promise<T>;

  /**
   * Insert an item at a specific index (for arrays only).
   * If not implemented, falls back to add().
   */
  insert?: (ctx: DBOperationContext, value: T, index: number) => Promise<T>;

  /**
   * Update an existing item in a container.
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
   */
  extractChildContext?: (value: T, key?: string | number) => Record<string, any>;

  /**
   * Transform data from database format to memory format.
   * Called after reading from DB, before storing in memoryValues.
   */
  fromDB?: (dbValue: T) => any;

  /**
   * Transform data from memory format to database format.
   * Called before writing to DB.
   */
  toDB?: (memValue: T) => any;

  /**
   * Get the database key/ID from a memory value.
   * Used to identify which DB record to update/delete.
   */
  getDBKey?: (value: T) => string | number;

  /**
   * When true, an `id` field supplied by the AI on create operations
   * (`add`/`insert`) is a *reference to an existing row* (e.g. assigning an
   * existing custom app) and must be preserved.
   *
   * When false/absent (the default), `id` is a database-generated primary key
   * (`gen_random_uuid()`), so any AI-supplied `id` is stripped on create to
   * prevent the AI from inventing primary keys. IDs are still fully visible on
   * reads so the AI can reference existing rows.
   */
  clientProvidesId?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Memory Field Types with DB Operations
// ──────────────────────────────────────────────────────────────────────────────

export interface AgentMemoryFieldBaseWithDB extends AgentMemoryFieldBase {
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
  /** Property name of the value object to use as display label and path alias.
   *  When set, map entries are rendered with this field's value instead of the raw key,
   *  and the AI can target entries by this value in paths. */
  displayKey?: string;
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
// Memory Load State (for DB bridge)
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

  /**
   * Cached values for loaded fields.
   * Key is the field path, value is the loaded data.
   * Used to avoid redundant database queries within a session.
   */
  cachedValues: Map<string, any>;
}

// ──────────────────────────────────────────────────────────────────────────────
// DB Operation Result Types (Internal - used by memory-db-bridge)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Internal result type for database operations.
 * Used by memory-db-bridge to track what happened during a DB operation.
 * 
 * Note: This is an internal type. The public MemoryOperationResult does not
 * expose dbSynced - success/failure is communicated via ok/message.
 */
export interface DbOperationResult {
  dbResult?: any;
  error?: string;
  shouldUpdateMemory: boolean;
  /** Internal flag - true if DB operation succeeded, false if failed, undefined if no DB ops */
  dbSynced?: boolean;
  /** When set, apply dbResult to this path instead of the operation path */
  targetPath?: string;
  /** Optional human-readable note describing side effects of the operation
   *  (e.g. "Auto-created default profile domains: X, Y, Z"). Surfaced to the
   *  AI as the result's `message` field when the op succeeds. */
  note?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Schema Resolution Result
// ──────────────────────────────────────────────────────────────────────────────

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
  /** The nearest parent container (array/map) that has db.update operation */
  parentContainerDbOps?: MemoryDBOperations;
  /** The key/index used to access the current item in the parent container */
  parentContainerKey?: string | number;
  /** The path to the parent container */
  parentContainerPath?: string;
}