/**
 * Cross-institute sharing visibility helper.
 *
 * Central choke point for all PHI reads. Every repository method that returns
 * institute-scoped data must route through one of these helpers — without it,
 * the family-access scoping bug recurs across every endpoint.
 *
 * See planning-docs/cross-institute-sharing-plan.md for the full model.
 */

import { and, eq, gt, isNotNull, isNull, inArray, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  aacSettings,
  instituteStudents,
  objectShares,
  programs,
  standingShares,
  userStudents,
  type ShareableObjectType,
} from "@shared/schema";
import { db } from "../../db";

/**
 * The access principal for a given query. Determines which visibility rule applies.
 *
 * - `institute` — clinician acting in a specific institute context. Filters by
 *   institute ownership + per-object shares + standing shares.
 * - `student` — AAC client / student principal. Sees all data for the student
 *   regardless of institute. Bound to authenticated student session, NOT to
 *   client app — a clinician authenticated to the AAC client does NOT inherit
 *   this principal.
 * - `admin` — system admin bypass (audit/support access).
 */
export type AccessCtx =
  | { kind: "institute"; instituteId: string; userId: string }
  | { kind: "student"; studentId: string }
  | { kind: "admin" };

/**
 * Reusable predicate: a share row is currently active (not revoked, not expired).
 * For per-object shares, share_expires_at may be null (indefinite); for standing
 * shares it must be set.
 */
function activeShare(
  revokedAtCol: AnyColumn,
  shareExpiresAtCol: AnyColumn,
  expiresRequired: boolean,
): SQL {
  const notRevoked = isNull(revokedAtCol);
  const notExpired = expiresRequired
    ? gt(shareExpiresAtCol, sql`NOW()`)
    : or(isNull(shareExpiresAtCol), gt(shareExpiresAtCol, sql`NOW()`));
  return and(notRevoked, notExpired)!;
}

/**
 * Returns the set of object IDs of a given type that are visible to the
 * institute principal via per-object share. Used as a subquery.
 */
function visibleObjectIdsViaObjectShares(
  instituteId: string,
  objectType: ShareableObjectType,
) {
  return db
    .select({ id: objectShares.objectId })
    .from(objectShares)
    .where(
      and(
        eq(objectShares.objectType, objectType),
        eq(objectShares.targetInstituteId, instituteId),
        activeShare(objectShares.revokedAt, objectShares.shareExpiresAt, false),
      ),
    );
}

/**
 * Returns the set of student IDs whose objects of a given type are visible
 * to the institute principal via standing share. Used as a subquery.
 */
function visibleStudentIdsViaStandingShares(
  instituteId: string,
  objectType: ShareableObjectType,
) {
  return db
    .select({ studentId: standingShares.studentId })
    .from(standingShares)
    .where(
      and(
        eq(standingShares.targetInstituteId, instituteId),
        sql`${objectType}::shareable_object_type = ANY(${standingShares.objectTypes})`,
        activeShare(standingShares.revokedAt, standingShares.shareExpiresAt, true),
      ),
    );
}

/**
 * Subquery: student ids the user is DIRECTLY linked to (owner / caregiver /
 * therapist / teacher via userStudents). Used to grant access to *personal*
 * (null-institute) PHI — objects that belong to the student rather than to any
 * institute — independent of which institute the session is scoped to.
 */
function userLinkedStudentIds(userId: string) {
  return db
    .select({ studentId: userStudents.studentId })
    .from(userStudents)
    .where(and(eq(userStudents.userId, userId), eq(userStudents.isActive, true)));
}

/** Does the user hold an active direct link to the student? */
async function userHasActiveStudentLink(userId: string, studentId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: userStudents.id })
    .from(userStudents)
    .where(
      and(
        eq(userStudents.userId, userId),
        eq(userStudents.studentId, studentId),
        eq(userStudents.isActive, true),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Build a Drizzle WHERE condition that limits a root PHI table read to only
 * rows visible under the given access context.
 *
 * Use directly in `.where()` on root tables (programs, medical_records, etc.).
 * For child tables that inherit ownership through a parent, use
 * {@link withInheritedVisibility} instead.
 *
 * @param table - the table being queried; must expose `instituteId`, `studentId`, and `id` columns
 * @param ctx - the access principal
 * @param objectType - the shareable type, used to scope per-object/standing share lookups
 *
 * @example
 *   await db.select().from(programs).where(
 *     and(
 *       eq(programs.studentId, studentId),
 *       withInstituteVisibility(programs, ctx, 'program'),
 *     ),
 *   );
 */
export function withInstituteVisibility(
  table: { id: PgColumn; instituteId: PgColumn; studentId: PgColumn },
  ctx: AccessCtx,
  objectType: ShareableObjectType,
): SQL {
  if (ctx.kind === "admin") {
    return sql`TRUE`;
  }
  if (ctx.kind === "student") {
    return eq(table.studentId, ctx.studentId);
  }
  // institute principal
  return or(
    eq(table.instituteId, ctx.instituteId),
    // Personal (null-institute) PHI belongs to the student directly — visible to
    // the student's own linked users (owner/caregiver/etc.), independent of the
    // session's selected institute. Such objects can't be cross-institute shared
    // (no owning institute), so the direct link is the only sensible gate.
    and(isNull(table.instituteId), inArray(table.studentId, userLinkedStudentIds(ctx.userId))),
    inArray(table.id, visibleObjectIdsViaObjectShares(ctx.instituteId, objectType)),
    inArray(table.studentId, visibleStudentIdsViaStandingShares(ctx.instituteId, objectType)),
  )!;
}

/**
 * Build a Drizzle WHERE condition for a child table that inherits ownership
 * through a parent root PHI table (root-only ownership model).
 *
 * @param childForeignKey - the column on the child table referencing the root
 * @param root - the root table descriptor
 * @param ctx - the access principal
 * @param rootObjectType - the shareable type of the *root*, not the child
 *
 * @example
 *   // Goals inherit visibility from their parent program.
 *   await db.select().from(goals).where(
 *     withInheritedVisibility(goals.programId, programs, ctx, 'program'),
 *   );
 */
export function withInheritedVisibility(
  childForeignKey: AnyColumn,
  root: { id: PgColumn; instituteId: PgColumn; studentId: PgColumn },
  ctx: AccessCtx,
  rootObjectType: ShareableObjectType,
): SQL {
  return inArray(
    childForeignKey,
    db
      .select({ id: root.id })
      .from(root as any)
      .where(withInstituteVisibility(root, ctx, rootObjectType)),
  );
}

/**
 * Subquery factory: ids of programs visible to the given access context.
 * Convenience wrapper used by deep-child queries that chain through programs
 * (e.g. `baselineMeasurements` → `profileDomains` → `programs`).
 *
 * @example
 *   inArray(profileDomains.programId, visibleProgramIds(ctx))
 */
export function visibleProgramIds(ctx: AccessCtx) {
  return db
    .select({ id: programs.id })
    .from(programs)
    .where(withInstituteVisibility(programs, ctx, "program"));
}

/**
 * Imperative single-object access check. Use from controller/service code when
 * you already have an object loaded (or its id) and want a yes/no answer rather
 * than building it into a query WHERE clause.
 *
 * For list reads, prefer {@link withInstituteVisibility} so the filter happens
 * in the database rather than after fetching all rows.
 *
 * @param requirePermission - if `'write'`, only shares with `permission='write'`
 *   count; ownership and admin/student principals still pass. If omitted (or
 *   `'read'`), any share is sufficient. Use this for the write-path lift —
 *   `canAccessObject(ctx, type, id, sid, owner, 'write')` returns `true` when
 *   the institute principal owns the object OR has a write-capable share.
 */
export async function canAccessObject(
  ctx: AccessCtx,
  objectType: ShareableObjectType,
  objectId: string,
  studentId: string,
  ownerInstituteId: string | null,
  requirePermission: "read" | "write" = "read",
): Promise<boolean> {
  if (ctx.kind === "admin") return true;
  if (ctx.kind === "student") return ctx.studentId === studentId;

  // institute principal
  if (ownerInstituteId === ctx.instituteId) return true;

  // Personal (null-institute) object: governed by the user's direct link to the
  // student, not by institute ownership/shares. This is what lets a clinician who
  // OWNS a student (personal caseload, no enrollment) edit that student's program
  // even while a different institute is selected for the session.
  if (ownerInstituteId === null) {
    return userHasActiveStudentLink(ctx.userId, studentId);
  }

  const permissionGate =
    requirePermission === "write"
      ? eq(objectShares.permission, "write")
      : sql`TRUE`;

  // per-object share?
  const [objShare] = await db
    .select({ id: objectShares.id })
    .from(objectShares)
    .where(
      and(
        eq(objectShares.objectType, objectType),
        eq(objectShares.objectId, objectId),
        eq(objectShares.targetInstituteId, ctx.instituteId),
        activeShare(objectShares.revokedAt, objectShares.shareExpiresAt, false),
        permissionGate,
      ),
    )
    .limit(1);
  if (objShare) return true;

  // standing share?
  const standingPermissionGate =
    requirePermission === "write"
      ? eq(standingShares.permission, "write")
      : sql`TRUE`;
  const [stShare] = await db
    .select({ id: standingShares.id })
    .from(standingShares)
    .where(
      and(
        eq(standingShares.studentId, studentId),
        eq(standingShares.targetInstituteId, ctx.instituteId),
        sql`${objectType}::shareable_object_type = ANY(${standingShares.objectTypes})`,
        activeShare(standingShares.revokedAt, standingShares.shareExpiresAt, true),
        standingPermissionGate,
      ),
    )
    .limit(1);
  return Boolean(stShare);
}

/**
 * Convenience: write-permission check. Equivalent to
 * `canAccessObject(ctx, type, id, sid, owner, 'write')`. Returns true when:
 *   - admin or matching student principal,
 *   - institute principal AND (owns the object OR has a write-capable share).
 *
 * Use this in controllers and AI memory-schema write paths to lift the
 * blanket "must own to write" rejection when a write share covers the object.
 */
export async function canWriteObject(
  ctx: AccessCtx,
  objectType: ShareableObjectType,
  objectId: string,
  studentId: string,
  ownerInstituteId: string | null,
): Promise<boolean> {
  return canAccessObject(ctx, objectType, objectId, studentId, ownerInstituteId, "write");
}

/**
 * Boolean: does the access context have `monitor_note` access for `studentId`?
 *
 * `monitor_note` is the share type that governs the AAC-observed dataset:
 *   - the student's `chatMemory` (Student_People / Student_Interests / etc.,
 *     populated by the AAC monitor agent during sessions), and
 *   - incidents recorded by the AAC (institute_id null — see
 *     {@link withIncidentVisibility}).
 *
 * There is no dedicated table backing `monitor_note`; it labels a category of
 * AAC-observed data exposed to the clinician AI.
 *
 * Used at session boundary in `sessionService.getMessageManager` to decide
 * whether to expose `Student_*` chat-memory fields to the clinician AI. AAC
 * mode never calls this (student principal always sees its own data).
 *
 * Pass conditions:
 *   - `admin` / `student` principals always pass.
 *   - `institute` principal whose institute owns the student passes by default.
 *     The student/family can opt out by setting
 *     `aacSettings.shareMonitorNotesWithInstitute` to false, in which case
 *     even the owning institute needs an explicit standing share.
 *   - Otherwise, an active `monitor_note` standing share targeting the
 *     institute is required (the cross-institute path).
 */
export type MonitorNotesAccess =
  | { allowed: false }
  | { allowed: true; via: "admin" | "student" | "ownership" | "share" };

export async function canAccessMonitorNotes(
  ctx: AccessCtx,
  studentId: string,
): Promise<MonitorNotesAccess> {
  if (ctx.kind === "admin") return { allowed: true, via: "admin" };
  if (ctx.kind === "student") {
    return ctx.studentId === studentId
      ? { allowed: true, via: "student" }
      : { allowed: false };
  }
  // institute principal — owning-institute auto-pass when not opted out
  const [link] = await db
    .select({ id: instituteStudents.id })
    .from(instituteStudents)
    .where(
      and(
        eq(instituteStudents.instituteId, ctx.instituteId),
        eq(instituteStudents.studentId, studentId),
        eq(instituteStudents.isActive, true),
      ),
    )
    .limit(1);
  if (link) {
    const [settings] = await db
      .select({ shareMonitorNotesWithInstitute: aacSettings.shareMonitorNotesWithInstitute })
      .from(aacSettings)
      .where(eq(aacSettings.studentId, studentId))
      .limit(1);
    // Default true (matches column default) — missing row counts as opted in.
    if (!settings || settings.shareMonitorNotesWithInstitute) {
      return { allowed: true, via: "ownership" };
    }
  }
  // Cross-institute path (or owning institute that opted out): standing share.
  const [row] = await db
    .select({ id: standingShares.id })
    .from(standingShares)
    .where(
      and(
        eq(standingShares.studentId, studentId),
        eq(standingShares.targetInstituteId, ctx.instituteId),
        sql`'monitor_note'::shareable_object_type = ANY(${standingShares.objectTypes})`,
        activeShare(standingShares.revokedAt, standingShares.shareExpiresAt, true),
      ),
    )
    .limit(1);
  return row ? { allowed: true, via: "share" } : { allowed: false };
}

/**
 * Visibility predicate for the `incidents` table that bridges the clinician/AAC
 * recording split.
 *
 * Incidents are mixed-origin:
 *   - Clinician-recorded → `institute_id` set; governed by the standard
 *     `incident` rules (ownership + per-object share + `incident` standing share).
 *   - AAC-recorded → `institute_id` null; part of the AAC-observed stream and
 *     governed by `monitor_note` access, NOT `incident`. An `incident` standing
 *     share does not expose AAC-recorded rows; only a `monitor_note` share does.
 *
 * Use this INSTEAD OF `withInstituteVisibility(incidents, ctx, 'incident')` —
 * the helper handles both governance routes in one predicate.
 */
export function withIncidentVisibility(
  table: { id: PgColumn; instituteId: PgColumn; studentId: PgColumn },
  ctx: AccessCtx,
): SQL {
  if (ctx.kind === "admin") return sql`TRUE`;
  if (ctx.kind === "student") return eq(table.studentId, ctx.studentId);
  // institute principal
  return or(
    // Owned by this institute (institute_id non-null + matches).
    eq(table.instituteId, ctx.instituteId),
    // Per-object share covers individual incidents regardless of origin.
    inArray(table.id, visibleObjectIdsViaObjectShares(ctx.instituteId, "incident")),
    // `incident` standing share covers ONLY clinician-recorded incidents.
    and(
      isNotNull(table.instituteId),
      inArray(table.studentId, visibleStudentIdsViaStandingShares(ctx.instituteId, "incident")),
    ),
    // `monitor_note` standing share covers ONLY AAC-recorded incidents.
    and(
      isNull(table.instituteId),
      inArray(table.studentId, visibleStudentIdsViaStandingShares(ctx.instituteId, "monitor_note")),
    ),
  )!;
}
