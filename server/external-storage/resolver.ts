/**
 * External Storage System — Backend Resolver
 *
 * Resolves which StorageBackend an entity should use based on its
 * `externalStorage` column value. Caches the mapping to avoid
 * repeated DB lookups.
 */

import type { EntityRef } from "./types";
import { getBackend } from "./backends";
import { db } from "../db";
import { users, students, institutes } from "@shared/schema";
import { eq } from "drizzle-orm";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface ResolverCacheEntry {
  backendName: string | null;
  expiresAt: number;
}

const resolverCache = new Map<string, ResolverCacheEntry>();

function cacheKey(ref: EntityRef): string {
  return `${ref.type}:${ref.id}`;
}

/**
 * Look up the externalStorage column for an entity.
 */
async function lookupExternalStorage(ref: EntityRef): Promise<string | null> {
  switch (ref.type) {
    case "user": {
      const [row] = await db
        .select({ externalStorage: users.externalStorage })
        .from(users)
        .where(eq(users.id, ref.id));
      return row?.externalStorage ?? null;
    }
    case "student": {
      const [row] = await db
        .select({ externalStorage: students.externalStorage })
        .from(students)
        .where(eq(students.id, ref.id));
      return row?.externalStorage ?? null;
    }
    case "institute": {
      const [row] = await db
        .select({ externalStorage: institutes.externalStorage })
        .from(institutes)
        .where(eq(institutes.id, ref.id));
      return row?.externalStorage ?? null;
    }
    default:
      return null;
  }
}

/**
 * Resolve the storage backend for a given entity.
 * Returns localBackend when externalStorage is null.
 */
export async function resolveBackend(ref: EntityRef) {
  const key = cacheKey(ref);
  const cached = resolverCache.get(key);

  if (cached && Date.now() < cached.expiresAt) {
    return getBackend(cached.backendName);
  }

  const backendName = await lookupExternalStorage(ref);

  resolverCache.set(key, {
    backendName,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return getBackend(backendName);
}

/**
 * Invalidate the resolver cache for an entity.
 * Call this when an entity's externalStorage column is updated.
 */
export function invalidateResolverCache(ref: EntityRef): void {
  resolverCache.delete(cacheKey(ref));
}

/**
 * Quick check: returns true if the entity definitely uses local storage
 * (i.e., no DB lookup needed — the entity is not in the resolver cache
 * with a non-null backend). When uncertain, returns false.
 */
export function isDefinitelyLocal(ref: EntityRef): boolean {
  const key = cacheKey(ref);
  const cached = resolverCache.get(key);
  if (!cached || Date.now() >= cached.expiresAt) return false;
  return !cached.backendName;
}
