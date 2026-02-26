/**
 * External Storage System — In-memory Cache (Tier 1)
 *
 * Simple TTL cache for externally-stored field values.
 * Avoids repeated backend lookups within the TTL window.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

class ExternalStorageCache {
  private store = new Map<string, CacheEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanup();
  }

  get(key: string): unknown | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.data;
  }

  set(key: string, data: unknown, ttlMs: number = DEFAULT_TTL_MS): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  /** Invalidate all cached fields for a specific record */
  invalidateRecord(tablePrefix: string, recordId: string): void {
    const prefix = `${tablePrefix}/${recordId}/`;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  /** Invalidate everything (e.g., on backend config change) */
  clear(): void {
    this.store.clear();
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store) {
        if (now > entry.expiresAt) {
          this.store.delete(key);
        }
      }
    }, CLEANUP_INTERVAL_MS);

    // Don't prevent process exit
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.store.clear();
  }
}

export const externalStorageCache = new ExternalStorageCache();
