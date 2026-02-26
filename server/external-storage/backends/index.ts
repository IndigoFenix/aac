/**
 * Backend Factory — Returns the appropriate StorageBackend by name.
 */

import type { StorageBackend } from "../types";
import { localBackend } from "./local-backend";

/**
 * Get a storage backend by name.
 * Returns localBackend for null/undefined/"local".
 * Throws for unknown backend names (future backends register here).
 */
export function getBackend(name: string | null | undefined): StorageBackend {
  if (!name || name === "local") return localBackend;

  // Future backends (e.g., "metropolinet") will be registered here:
  // if (name === "metropolinet") return metropolinetBackend;

  throw new Error(`Unknown external storage backend: "${name}"`);
}
