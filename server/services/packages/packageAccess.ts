// server/services/packages/packageAccess.ts
//
// The single choke point for "who may do what with a package".
//
// Packages are CONTENT, not PHI, so they deliberately do NOT go through
// `sharing/visibility.ts` — that helper keys off `studentId`, which package
// boards do not have. Everything package-related resolves here instead, so
// there is exactly one place to get the rules wrong.
//
// See planning-docs/aac-packages-plan.md §2.

import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  instituteUsers,
  packageGrants,
  packages,
  type Package,
  type PackagePermission,
} from "@shared/schema";
import { db } from "../../db";
import type { AccessCtx } from "../sharing/visibility";

const RANK: Record<PackagePermission, number> = { none: 0, use: 1, edit: 2 };

/** Higher of two permissions. */
function best(a: PackagePermission, b: PackagePermission): PackagePermission {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Is this package publicly usable right now? Public ALSO requires approval. */
export function isPubliclyUsable(pkg: Pick<Package, "visibility" | "approvalStatus" | "deletedAt">): boolean {
  return pkg.visibility === "public" && pkg.approvalStatus === "approved" && pkg.deletedAt === null;
}

/**
 * An orphaned package (owner deleted it while links remained) is FROZEN: no
 * edits, no new links, no publish, regardless of who is asking. There is no
 * owner left to authorise a change.
 *
 * Note this is the v1 rule. If `edit` grants become true co-ownership, an
 * orphan with a live co-owner is closer to an ownership transfer than an
 * orphan, and this should soften — see plan §13.1.
 */
export function isFrozen(pkg: Pick<Package, "deletedAt">): boolean {
  return pkg.deletedAt !== null;
}

/**
 * Resolve what `ctx` may do with one package.
 *
 *   edit — institute admin of the owner, an explicit 'edit' grant, or the
 *          package's defaultMemberPermission='edit' for institute members.
 *   use  — any member of the owning institute (unless defaultMemberPermission
 *          is 'none'), an explicit 'use' grant, or an approved public package.
 *   none — everything else.
 *
 * PUBLIC VISIBILITY NEVER GRANTS EDIT. Per the brief: publicly usable, never
 * publicly editable.
 *
 * This answers "what could you do if the package were live". Callers on a
 * WRITE path must ALSO check `isFrozen()` — kept separate so read paths can
 * still resolve `use` on an orphan (attached students keep working).
 */
export async function resolvePackagePermission(
  ctx: AccessCtx,
  packageId: string,
): Promise<PackagePermission> {
  if (ctx.kind === "admin") return "edit";

  const [pkg] = await db
    .select({
      id: packages.id,
      instituteId: packages.instituteId,
      visibility: packages.visibility,
      approvalStatus: packages.approvalStatus,
      defaultMemberPermission: packages.defaultMemberPermission,
      deletedAt: packages.deletedAt,
    })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);
  if (!pkg) return "none";

  // The student principal (the AAC client) never manages packages; it only ever
  // reads content already attached to it, which the assignment row governs.
  if (ctx.kind === "student") {
    return isPubliclyUsable(pkg) || pkg.instituteId !== null ? "use" : "none";
  }

  let permission: PackagePermission = isPubliclyUsable(pkg) ? "use" : "none";

  // Membership in the owning institute.
  if (pkg.instituteId) {
    const [membership] = await db
      .select({ isAdmin: instituteUsers.isAdmin })
      .from(instituteUsers)
      .where(
        and(
          eq(instituteUsers.instituteId, pkg.instituteId),
          eq(instituteUsers.userId, ctx.userId),
          eq(instituteUsers.isActive, true),
        ),
      )
      .limit(1);
    if (membership) {
      permission = membership.isAdmin
        ? "edit"
        : best(permission, (pkg.defaultMemberPermission as PackagePermission) ?? "use");
    }
  }

  if (permission === "edit") return "edit";

  // Explicit per-user grant.
  const [grant] = await db
    .select({ permission: packageGrants.permission })
    .from(packageGrants)
    .where(
      and(eq(packageGrants.packageId, packageId), eq(packageGrants.granteeUserId, ctx.userId)),
    )
    .limit(1);
  if (grant) permission = best(permission, grant.permission as PackagePermission);

  return permission;
}

/** Convenience: may `ctx` WRITE to this package right now (permission + not frozen)? */
export async function canEditPackage(ctx: AccessCtx, packageId: string): Promise<boolean> {
  const [pkg] = await db
    .select({ deletedAt: packages.deletedAt })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);
  if (!pkg || isFrozen(pkg)) return false;
  return (await resolvePackagePermission(ctx, packageId)) === "edit";
}

/**
 * WHERE clause limiting a `packages` read to rows `ctx` may USE.
 *
 * Excludes orphans: they are still readable through an existing assignment (the
 * student keeps working), but they must not appear in pick-lists or search,
 * because they can no longer be attached to anything new.
 */
export function listUsablePackages(ctx: AccessCtx): SQL {
  const live = isNull(packages.deletedAt);

  if (ctx.kind === "admin") return live;

  const approvedPublic = and(
    eq(packages.visibility, "public"),
    eq(packages.approvalStatus, "approved"),
  )!;

  if (ctx.kind === "student") return and(live, approvedPublic)!;

  const memberInstitutes = db
    .select({ instituteId: instituteUsers.instituteId })
    .from(instituteUsers)
    .where(and(eq(instituteUsers.userId, ctx.userId), eq(instituteUsers.isActive, true)));

  const granted = db
    .select({ packageId: packageGrants.packageId })
    .from(packageGrants)
    .where(eq(packageGrants.granteeUserId, ctx.userId));

  return and(
    live,
    or(
      approvedPublic,
      and(
        inArray(packages.instituteId, memberInstitutes),
        sql`${packages.defaultMemberPermission} <> 'none'`,
      ),
      inArray(packages.id, granted),
    ),
  )!;
}
