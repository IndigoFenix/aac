/**
 * External Storage System — Core Integration Functions
 *
 * These functions are called by repositories to transparently
 * hydrate (read) and extract (write) sensitive fields from/to
 * external storage backends.
 */

import type { EntityRef, ExtractionResult, StorageKey } from "./types";
import { SENSITIVE_FIELDS, OWNERSHIP_MAP, buildStorageKey, getAllStorageKeys } from "./registry";
import { externalStorageCache } from "./cache";
import { resolveBackend, isDefinitelyLocal } from "./resolver";

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 200;

// =============================================================================
// READ: Hydrate records with externally-stored fields
// =============================================================================

/**
 * Hydrate records by merging in any externally-stored sensitive fields.
 *
 * When the owning entity uses LocalBackend (the default), this is a no-op
 * and returns records unchanged — zero overhead.
 *
 * @param tableName  DB table name (snake_case)
 * @param records    Array of records from the DB
 * @param entityRefOverride  Optional override for tables that can't resolve ownership from the record
 */
export async function hydrateRecords<T extends Record<string, unknown>>(
  tableName: string,
  records: T[],
  entityRefOverride?: EntityRef,
): Promise<T[]> {
  if (records.length === 0) return records;

  const tierConfig = SENSITIVE_FIELDS[tableName];
  if (!tierConfig) return records;

  const allFields = [
    ...(tierConfig.core ?? []),
    ...(tierConfig.log ?? []),
    ...(tierConfig.biometric ?? []),
  ];
  if (allFields.length === 0) return records;

  // Resolve the entity ref from the first record (all records in a batch
  // should share the same owner for hydration purposes)
  const ref = entityRefOverride ?? resolveEntityRef(tableName, records[0]);
  if (!ref) return records; // Can't determine owner — return as-is

  // Fast path: if definitely local, skip everything
  if (isDefinitelyLocal(ref)) return records;

  const backend = await resolveBackend(ref);
  if (backend.isLocal) return records;

  // Collect all keys we need to fetch
  const keysToFetch: StorageKey[] = [];
  const keyToRecordIndex = new Map<StorageKey, { recordIdx: number; field: string }>();

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const recordId = record.id as string;
    if (!recordId) continue;

    for (const field of allFields) {
      const key = buildStorageKey(tableName, recordId, field);

      // Check cache first
      const cached = externalStorageCache.get(key);
      if (cached !== undefined) {
        (record as Record<string, unknown>)[field] = cached;
        continue;
      }

      keysToFetch.push(key);
      keyToRecordIndex.set(key, { recordIdx: i, field });
    }
  }

  if (keysToFetch.length === 0) return records;

  // Batch fetch from backend
  try {
    const fetched = await backend.getBatch(ref, keysToFetch);
    for (const [key, value] of fetched) {
      const mapping = keyToRecordIndex.get(key);
      if (!mapping) continue;

      const record = records[mapping.recordIdx];
      (record as Record<string, unknown>)[mapping.field] = value;

      // Populate cache
      externalStorageCache.set(key, value);
    }
  } catch (err) {
    console.warn(`[external-storage] hydrate failed for ${tableName}, returning DB values:`, err);
  }

  return records;
}

// =============================================================================
// WRITE: Extract sensitive fields before DB write
// =============================================================================

/**
 * Extract sensitive fields from data before writing to DB.
 *
 * When the entity uses LocalBackend, returns the data unchanged with
 * `isExternal: false` — the caller should proceed with a normal DB write.
 *
 * @param tableName  DB table name (snake_case)
 * @param recordId   The record's ID (for building storage keys)
 * @param data       The data being written (insert or update payload)
 * @param entityRef  The owning entity
 */
export async function extractSensitiveFields<T extends Record<string, unknown>>(
  tableName: string,
  recordId: string,
  data: T,
  entityRef: EntityRef,
): Promise<ExtractionResult<T>> {
  const backend = await resolveBackend(entityRef);

  if (backend.isLocal) {
    return { dbData: data, externalWrites: new Map(), completeData: data, isExternal: false };
  }

  const tierConfig = SENSITIVE_FIELDS[tableName];
  if (!tierConfig) {
    return { dbData: data, externalWrites: new Map(), completeData: data, isExternal: false };
  }

  const allFields = [
    ...(tierConfig.core ?? []),
    ...(tierConfig.log ?? []),
    ...(tierConfig.biometric ?? []),
  ];

  const dbData = { ...data };
  const externalWrites = new Map<StorageKey, unknown>();
  const completeData = { ...data };

  for (const field of allFields) {
    if (field in data && data[field] !== undefined) {
      const key = buildStorageKey(tableName, recordId, field);
      externalWrites.set(key, data[field]);
      (dbData as Record<string, unknown>)[field] = null;
    }
  }

  const isExternal = externalWrites.size > 0;
  return { dbData, externalWrites, completeData, isExternal };
}

// =============================================================================
// WRITE: Persist extracted fields to backend
// =============================================================================

/**
 * Persist extracted sensitive fields to the external backend.
 * Retries up to MAX_RETRIES times with exponential backoff on failure.
 */
export async function persistExtracted(
  entityRef: EntityRef,
  writes: Map<StorageKey, unknown>,
): Promise<void> {
  if (writes.size === 0) return;

  const backend = await resolveBackend(entityRef);
  if (backend.isLocal) return;

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await backend.putBatch(entityRef, writes);

      // Invalidate cache for written keys
      for (const key of writes.keys()) {
        externalStorageCache.delete(key);
      }
      return;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
      }
    }
  }

  console.error(
    `[external-storage] persistExtracted failed after ${MAX_RETRIES} retries for ${entityRef.type}:${entityRef.id}:`,
    lastError,
  );
  // Log the payload for debugging/recovery
  const payload: Record<string, unknown> = {};
  for (const [k, v] of writes) payload[k] = typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}...` : v;
  console.error(`[external-storage] failed payload keys:`, Object.keys(payload));
}

// =============================================================================
// DELETE: Remove all external data for a record
// =============================================================================

/**
 * Delete all externally-stored sensitive fields for a record.
 */
export async function deleteExternalData(
  tableName: string,
  recordId: string,
  entityRef: EntityRef,
): Promise<void> {
  const backend = await resolveBackend(entityRef);
  if (backend.isLocal) return;

  const keys = getAllStorageKeys(tableName, recordId);
  if (keys.length === 0) return;

  try {
    await backend.deleteBatch(entityRef, keys);
    externalStorageCache.invalidateRecord(tableName, recordId);
  } catch (err) {
    console.error(`[external-storage] deleteExternalData failed for ${tableName}/${recordId}:`, err);
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Resolve entity ref from a record using the OWNERSHIP_MAP.
 */
export function resolveEntityRef(tableName: string, record: Record<string, unknown>): EntityRef | null {
  const resolver = OWNERSHIP_MAP[tableName];
  if (!resolver) return null;
  return resolver(record);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
