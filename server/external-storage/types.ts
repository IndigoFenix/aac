/**
 * External Storage System — Type Definitions
 *
 * Provides interfaces for pluggable storage backends that can store
 * sensitive fields externally (e.g., in an institution's own API).
 */

/** Entity types that can own data */
export type EntityType = 'user' | 'student' | 'institute';

/** Reference to an owning entity */
export interface EntityRef {
  type: EntityType;
  id: string;
}

/** Compound key for a stored value: "{table}/{recordId}/{field}" */
export type StorageKey = string;

/** Tier configuration for a table's sensitive fields (camelCase field names) */
export interface TableTierConfig {
  /** Core fields — always hydrated on read */
  core?: string[];
  /** Log fields — hydrated on read (lazy fetch possible in future) */
  log?: string[];
  /** Biometric fields — session-cached, hydrated on read */
  biometric?: string[];
}

/** Result of extracting sensitive fields before a DB write */
export interface ExtractionResult<T> {
  /** Data safe to write to DB (sensitive fields set to null) */
  dbData: T;
  /** Map of StorageKey → value to persist externally */
  externalWrites: Map<StorageKey, unknown>;
  /** The complete data object (with all fields intact) */
  completeData: T;
  /** Whether any fields were actually extracted */
  isExternal: boolean;
}

/**
 * Interface for a pluggable storage backend.
 * Implementations handle the actual storage of sensitive field values.
 */
export interface StorageBackend {
  /** Human-readable name of this backend */
  readonly name: string;

  /** Fast check — true for LocalBackend (no external calls needed) */
  readonly isLocal: boolean;

  /** Get a single value by key */
  get(ref: EntityRef, key: StorageKey): Promise<unknown | undefined>;

  /** Get multiple values by key (batch) */
  getBatch(ref: EntityRef, keys: StorageKey[]): Promise<Map<StorageKey, unknown>>;

  /** Put a single value */
  put(ref: EntityRef, key: StorageKey, value: unknown): Promise<void>;

  /** Put multiple values (batch) */
  putBatch(ref: EntityRef, entries: Map<StorageKey, unknown>): Promise<void>;

  /** Delete a single key */
  delete(ref: EntityRef, key: StorageKey): Promise<void>;

  /** Delete multiple keys (batch) */
  deleteBatch(ref: EntityRef, keys: StorageKey[]): Promise<void>;
}
