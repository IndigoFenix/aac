// server/services/packages/packageLinks.ts
//
// Every create/delete of a package LINK — a student assignment or a user grant —
// must go through this module. Two reasons:
//
//  1. `packages.linkCount` is a denormalised refcount, adjusted in the SAME
//     transaction as the link row. A raw insert/delete elsewhere desynchronises
//     it silently.
//  2. A deleted package is ORPHANED, not removed: it survives while anything
//     still links to it, so deleting a package never yanks content out from
//     under a student mid-session. The decrement path is what eventually
//     collects it.
//
// The load-bearing caller is `studentErasureService` — erasing a student drops
// their assignments, which may be the last links holding an orphan alive. A raw
// DELETE there leaks the row permanently.
//
// See planning-docs/aac-packages-plan.md §1.5.

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { packageAssignments, packageGrants, packages } from "@shared/schema";
import { db, type Executor } from "../../db";

export type { Executor };

// ---------------------------------------------------------------------------
// Refcount primitives
// ---------------------------------------------------------------------------

/**
 * `link_count = link_count + 1`, evaluated by Postgres under the row lock — so
 * concurrent attach/detach on a popular package is safe without an advisory
 * lock or SELECT ... FOR UPDATE.
 */
async function incrementLinkCount(x: Executor, packageId: string): Promise<void> {
  await x
    .update(packages)
    .set({ linkCount: sql`${packages.linkCount} + 1` })
    .where(eq(packages.id, packageId));
}

/**
 * Decrement, then collect the package if it is an orphan with nothing left
 * pointing at it. Clamped at zero so drift can never drive the counter negative.
 */
async function decrementLinkCount(x: Executor, packageId: string): Promise<void> {
  await x
    .update(packages)
    .set({ linkCount: sql`GREATEST(${packages.linkCount} - 1, 0)` })
    .where(eq(packages.id, packageId));
  await collectIfOrphaned(x, packageId);
}

/**
 * Hard-delete an orphaned package once nothing links to it.
 *
 * Deliberately verifies with real COUNTs rather than trusting `linkCount`. The
 * counter is a cheap trigger; the delete is authoritative. That asymmetry means
 * counter drift can only ever strand a dead row (untidy) and never remove a
 * package a student is still using (harmful).
 *
 * Live packages are never collected — only ones already soft-deleted.
 */
export async function collectIfOrphaned(x: Executor, packageId: string): Promise<boolean> {
  const [pkg] = await x
    .select({ deletedAt: packages.deletedAt })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);
  if (!pkg || pkg.deletedAt === null) return false;

  const [{ n: assignments }] = await x
    .select({ n: sql<number>`count(*)::int` })
    .from(packageAssignments)
    .where(eq(packageAssignments.packageId, packageId));
  if (assignments > 0) return false;

  const [{ n: grants }] = await x
    .select({ n: sql<number>`count(*)::int` })
    .from(packageGrants)
    .where(eq(packageGrants.packageId, packageId));
  if (grants > 0) return false;

  // packageBoards / packageGrants cascade via FK; packageAssignments is a
  // cross-schema link with no FK, and we just proved there are none.
  await x.delete(packages).where(eq(packages.id, packageId));
  return true;
}

// ---------------------------------------------------------------------------
// Student assignments
// ---------------------------------------------------------------------------

export interface AttachInput {
  packageId: string;
  studentId: string;
  /** Owner of the assignment row, for cross-institute visibility filtering. */
  instituteId?: string | null;
  assignedByUserId?: string | null;
}

/**
 * Attach a package to a student. Idempotent: re-attaching an existing pair is a
 * no-op and does NOT double-count.
 *
 * Callers are responsible for the permission check (`resolvePackagePermission`)
 * and for refusing frozen packages — this module owns bookkeeping, not policy.
 */
export async function attachPackageToStudent(input: AttachInput, x?: Executor): Promise<void> {
  const run = async (tx: Executor) => {
    const inserted = await tx
      .insert(packageAssignments)
      .values({
        packageId: input.packageId,
        studentId: input.studentId,
        instituteId: input.instituteId ?? null,
        assignedByUserId: input.assignedByUserId ?? null,
      })
      .onConflictDoNothing({
        target: [packageAssignments.packageId, packageAssignments.studentId],
      })
      .returning({ id: packageAssignments.id });
    if (inserted.length > 0) await incrementLinkCount(tx, input.packageId);
  };
  return x ? run(x) : db.transaction(run);
}

/** Detach a package from a student. No-op when the pair does not exist. */
export async function detachPackageFromStudent(
  packageId: string,
  studentId: string,
  x?: Executor,
): Promise<void> {
  const run = async (tx: Executor) => {
    const removed = await tx
      .delete(packageAssignments)
      .where(
        and(
          eq(packageAssignments.packageId, packageId),
          eq(packageAssignments.studentId, studentId),
        ),
      )
      .returning({ id: packageAssignments.id });
    if (removed.length > 0) await decrementLinkCount(tx, packageId);
  };
  return x ? run(x) : db.transaction(run);
}

/**
 * Drop every package assignment for a student and decrement each package.
 *
 * This is the erasure entry point. `studentErasureService` runs inside its own
 * transaction, so it MUST pass its `tx` — the whole cascade has to commit or
 * roll back as one.
 */
export async function deleteStudentPackageLinks(studentId: string, x?: Executor): Promise<void> {
  const run = async (tx: Executor) => {
    const removed = await tx
      .delete(packageAssignments)
      .where(eq(packageAssignments.studentId, studentId))
      .returning({ packageId: packageAssignments.packageId });
    for (const row of removed) {
      await decrementLinkCount(tx, row.packageId);
    }
  };
  return x ? run(x) : db.transaction(run);
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export interface GrantInput {
  packageId: string;
  granteeUserId: string;
  permission: "use" | "edit";
  grantedByUserId?: string | null;
}

/**
 * Grant a user access to a package. Grants count toward `linkCount` on purpose:
 * an `edit` grant is effectively co-ownership, so a granted package survives its
 * original owner deleting it.
 *
 * Re-granting an existing pair updates the permission without double-counting.
 */
export async function addPackageGrant(input: GrantInput, x?: Executor): Promise<void> {
  const run = async (tx: Executor) => {
    const inserted = await tx
      .insert(packageGrants)
      .values({
        packageId: input.packageId,
        granteeUserId: input.granteeUserId,
        permission: input.permission,
        grantedByUserId: input.grantedByUserId ?? null,
      })
      .onConflictDoUpdate({
        target: [packageGrants.packageId, packageGrants.granteeUserId],
        set: { permission: input.permission },
      })
      // An upsert always returns a row, so the row itself can't tell us whether
      // it was new. `xmax = 0` is Postgres's standard tell: zero on a fresh
      // INSERT, non-zero on the UPDATE branch. Evaluated inside the statement,
      // so it stays correct when two grants of the same pair race.
      .returning({ isNew: sql<boolean>`(xmax = 0)` });
    if (inserted[0]?.isNew) await incrementLinkCount(tx, input.packageId);
  };
  return x ? run(x) : db.transaction(run);
}

/** Revoke a grant. No-op when it does not exist. */
export async function removePackageGrant(
  packageId: string,
  granteeUserId: string,
  x?: Executor,
): Promise<void> {
  const run = async (tx: Executor) => {
    const removed = await tx
      .delete(packageGrants)
      .where(
        and(eq(packageGrants.packageId, packageId), eq(packageGrants.granteeUserId, granteeUserId)),
      )
      .returning({ id: packageGrants.id });
    if (removed.length > 0) await decrementLinkCount(tx, packageId);
  };
  return x ? run(x) : db.transaction(run);
}

// ---------------------------------------------------------------------------
// Package deletion
// ---------------------------------------------------------------------------

/**
 * Delete a package. Removes it outright when nothing links to it; otherwise
 * ORPHANS it — `deletedAt` set, owner nulled, row retained so attached students
 * keep working. An orphan is frozen (see packageAccess.isFrozen) and is
 * collected by the last detach.
 *
 * Returns what actually happened, so callers can word the UI honestly.
 */
export async function deletePackage(
  packageId: string,
  x?: Executor,
): Promise<"deleted" | "orphaned" | "missing"> {
  const run = async (tx: Executor): Promise<"deleted" | "orphaned" | "missing"> => {
    const [pkg] = await tx
      .select({ id: packages.id })
      .from(packages)
      .where(eq(packages.id, packageId))
      .limit(1);
    if (!pkg) return "missing";

    // Orphan first so collectIfOrphaned (which only touches soft-deleted rows)
    // can do the real check and remove it if nothing links.
    await tx
      .update(packages)
      .set({ deletedAt: new Date(), instituteId: null, updatedAt: new Date() })
      .where(eq(packages.id, packageId));

    return (await collectIfOrphaned(tx, packageId)) ? "deleted" : "orphaned";
  };
  return x ? run(x) : db.transaction(run);
}

// ---------------------------------------------------------------------------
// Backstop
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  checked: number;
  corrected: Array<{ packageId: string; was: number; now: number }>;
  collected: string[];
}

/**
 * Nightly safety net: recompute every `linkCount` from the real tables and
 * collect any orphan that should already be gone.
 *
 * This is a backstop, not part of the design — the live paths above keep the
 * counter correct. Drift can only ever leave a dead row alive, so this is
 * tidiness rather than safety.
 */
export async function reconcilePackageLinkCounts(): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, corrected: [], collected: [] };

  const rows = await db
    .select({ id: packages.id, linkCount: packages.linkCount, deletedAt: packages.deletedAt })
    .from(packages);

  for (const row of rows) {
    result.checked++;
    const [{ n: assignments }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(packageAssignments)
      .where(eq(packageAssignments.packageId, row.id));
    const [{ n: grants }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(packageGrants)
      .where(eq(packageGrants.packageId, row.id));

    const actual = assignments + grants;
    if (actual !== row.linkCount) {
      await db.update(packages).set({ linkCount: actual }).where(eq(packages.id, row.id));
      result.corrected.push({ packageId: row.id, was: row.linkCount, now: actual });
    }
    if (row.deletedAt !== null && actual === 0) {
      if (await collectIfOrphaned(db, row.id)) result.collected.push(row.id);
    }
  }

  if (result.corrected.length > 0 || result.collected.length > 0) {
    console.warn(
      `[packageLinks] reconcile: ${result.corrected.length} counter(s) corrected, ` +
        `${result.collected.length} orphan(s) collected out of ${result.checked} package(s)`,
    );
  }
  return result;
}

/** Orphaned packages still awaiting collection — for admin/ops visibility. */
export async function listOrphanedPackages() {
  return db
    .select({
      id: packages.id,
      name: packages.name,
      linkCount: packages.linkCount,
      deletedAt: packages.deletedAt,
    })
    .from(packages)
    .where(isNotNull(packages.deletedAt));
}
