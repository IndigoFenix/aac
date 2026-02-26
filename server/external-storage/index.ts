/**
 * External Storage System — Public API
 *
 * Sensitive fields can be transparently stored in external backends
 * (e.g., an institution's own API) rather than in our database.
 *
 * When `externalStorage` is null (the default), all behavior is
 * identical to today — zero overhead. The LocalBackend short-circuits
 * before any external calls are made.
 *
 * Usage in repositories:
 *
 *   // Read: hydrate after DB select
 *   const rows = await db.select().from(table).where(...);
 *   return hydrateRecords('table_name', rows);
 *
 *   // Write: extract before DB update, persist after
 *   const ext = await extractSensitiveFields('table_name', id, data, ref);
 *   await db.update(table).set(ext.dbData).where(...);
 *   if (ext.isExternal) await persistExtracted(ref, ext.externalWrites);
 *
 *   // Delete: clean up external data after DB delete
 *   await deleteExternalData('table_name', id, ref);
 */

// Types
export type {
  EntityRef,
  EntityType,
  StorageBackend,
  StorageKey,
  TableTierConfig,
  ExtractionResult,
} from "./types";

// Core helpers (used by repositories)
export {
  hydrateRecords,
  extractSensitiveFields,
  persistExtracted,
  deleteExternalData,
  resolveEntityRef,
} from "./helpers";

// Registry (for inspection / testing)
export {
  SENSITIVE_FIELDS,
  OWNERSHIP_MAP,
  getAllSensitiveFields,
  buildStorageKey,
  getAllStorageKeys,
} from "./registry";

// Resolver
export { resolveBackend, invalidateResolverCache } from "./resolver";

// Cache
export { externalStorageCache } from "./cache";

// Backends
export { localBackend } from "./backends/local-backend";
export { getBackend } from "./backends";
