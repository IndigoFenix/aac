/**
 * packageRepository.ts
 *
 * Data access for content packages. Policy lives in `packageAccess`; link
 * bookkeeping lives in `packageLinks`. This layer only reads and writes rows.
 *
 * Note what is NOT here: assignment create/delete and grant create/delete go
 * through `packageLinks` so `packages.linkCount` stays honest. This repository
 * exposes the READ side of both.
 *
 * See planning-docs/aac-packages-plan.md §5.1.
 */

import {
  boards,
  packageAssignments,
  packageBoards,
  packageGrants,
  packages,
  users,
  type Board,
  type Package,
  type PackageBoard,
  type PackageGrant,
} from "@shared/schema";
import { db } from "../db";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { listUsablePackages } from "../services/packages/packageAccess";
import type { AccessCtx } from "../services/sharing/visibility";

/** Board metadata as shown inside a package editor — never includes irData. */
export type PackageBoardEntry = Omit<Board, "irData"> & {
  membershipId: string;
  autoLoad: boolean;
  sortOrder: number;
};

export type PackageGrantEntry = PackageGrant & {
  granteeEmail: string | null;
  granteeName: string | null;
};

const BOARD_METADATA = {
  id: boards.id,
  userId: boards.userId,
  studentId: boards.studentId,
  name: boards.name,
  description: boards.description,
  imageUrl: boards.imageUrl,
  language: boards.language,
  automaticSelection: boards.automaticSelection,
  automaticSelectionHint: boards.automaticSelectionHint,
  isGenerated: boards.isGenerated,
  scope: boards.scope,
  instituteId: boards.instituteId,
  createdAt: boards.createdAt,
  updatedAt: boards.updatedAt,
  loadedAt: boards.loadedAt,
} as const;

export class PackageRepository {
  // ------------------------------------------------------------------
  // Packages
  // ------------------------------------------------------------------

  async createPackage(values: typeof packages.$inferInsert): Promise<Package> {
    const [row] = await db.insert(packages).values(values).returning();
    return row;
  }

  async getPackage(id: string): Promise<Package | undefined> {
    const [row] = await db.select().from(packages).where(eq(packages.id, id));
    return row;
  }

  async updatePackage(id: string, values: Partial<typeof packages.$inferInsert>): Promise<Package | undefined> {
    const [row] = await db
      .update(packages)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(packages.id, id))
      .returning();
    return row;
  }

  /** Packages owned by an institute. Excludes orphans (they have no owner). */
  async listByInstitute(instituteId: string): Promise<Package[]> {
    return db
      .select()
      .from(packages)
      .where(and(eq(packages.instituteId, instituteId), isNull(packages.deletedAt)))
      .orderBy(desc(packages.updatedAt));
  }

  /**
   * Every package `ctx` may USE — owning institute ∪ granted ∪ approved-public.
   * Orphans are excluded: still readable through an existing assignment, but
   * never offered for a new one.
   */
  async listUsable(ctx: AccessCtx, extra?: SQL): Promise<Package[]> {
    const base = listUsablePackages(ctx);
    return db
      .select()
      .from(packages)
      .where(extra ? and(base, extra)! : base)
      .orderBy(desc(packages.updatedAt));
  }

  /**
   * Public discovery. APPROVED public packages only — an institute-scoped
   * package, or one still awaiting review, must never surface here.
   */
  async searchPublicPackages(opts: {
    q?: string;
    language?: string;
    limit?: number;
  }): Promise<Package[]> {
    const conditions = [
      eq(packages.visibility, "public"),
      eq(packages.approvalStatus, "approved"),
      isNull(packages.deletedAt),
    ];
    if (opts.language) conditions.push(eq(packages.language, opts.language));
    if (opts.q?.trim()) {
      const needle = `%${opts.q.trim()}%`;
      conditions.push(
        or(ilike(packages.name, needle), ilike(packages.description, needle))!,
      );
    }
    return db
      .select()
      .from(packages)
      .where(and(...conditions))
      .orderBy(desc(packages.updatedAt))
      .limit(opts.limit ?? 50);
  }

  /** The admin review queue: public packages awaiting a decision. */
  async listPendingApproval(): Promise<Package[]> {
    return db
      .select()
      .from(packages)
      .where(
        and(
          eq(packages.visibility, "public"),
          eq(packages.approvalStatus, "pending"),
          isNull(packages.deletedAt),
        ),
      )
      .orderBy(asc(packages.publishedAt));
  }

  // ------------------------------------------------------------------
  // Membership
  // ------------------------------------------------------------------

  /** Boards in a package, with their membership settings. Metadata only. */
  async listBoards(packageId: string): Promise<PackageBoardEntry[]> {
    const rows = await db
      .select({
        ...BOARD_METADATA,
        membershipId: packageBoards.id,
        autoLoad: packageBoards.autoLoad,
        sortOrder: packageBoards.sortOrder,
      })
      .from(packageBoards)
      .innerJoin(boards, eq(packageBoards.boardId, boards.id))
      .where(eq(packageBoards.packageId, packageId))
      .orderBy(asc(packageBoards.sortOrder), asc(boards.name));
    return rows as PackageBoardEntry[];
  }

  /**
   * The boards of MANY packages in one query, keyed by package id — the board
   * picker renders a section per package and would otherwise fire one query per
   * section. Packages with no boards are absent from the map.
   */
  async listBoardsForPackages(packageIds: string[]): Promise<Map<string, PackageBoardEntry[]>> {
    const out = new Map<string, PackageBoardEntry[]>();
    if (packageIds.length === 0) return out;

    const rows = await db
      .select({
        ...BOARD_METADATA,
        packageId: packageBoards.packageId,
        membershipId: packageBoards.id,
        autoLoad: packageBoards.autoLoad,
        sortOrder: packageBoards.sortOrder,
      })
      .from(packageBoards)
      .innerJoin(boards, eq(packageBoards.boardId, boards.id))
      .where(inArray(packageBoards.packageId, packageIds))
      .orderBy(asc(packageBoards.sortOrder), asc(boards.name));

    for (const { packageId, ...entry } of rows) {
      const list = out.get(packageId) ?? [];
      list.push(entry as PackageBoardEntry);
      out.set(packageId, list);
    }
    return out;
  }

  /** Just the board ids, for validation (sibling links) and key building. */
  async listBoardIds(packageId: string): Promise<string[]> {
    const rows = await db
      .select({ boardId: packageBoards.boardId })
      .from(packageBoards)
      .where(eq(packageBoards.packageId, packageId));
    return rows.map((r) => r.boardId);
  }

  async getMembership(packageId: string, boardId: string): Promise<PackageBoard | undefined> {
    const [row] = await db
      .select()
      .from(packageBoards)
      .where(and(eq(packageBoards.packageId, packageId), eq(packageBoards.boardId, boardId)));
    return row;
  }

  async addBoard(values: typeof packageBoards.$inferInsert): Promise<PackageBoard> {
    const [row] = await db
      .insert(packageBoards)
      .values(values)
      .onConflictDoNothing({ target: [packageBoards.packageId, packageBoards.boardId] })
      .returning();
    if (row) return row;
    return (await this.getMembership(values.packageId, values.boardId))!;
  }

  async updateMembership(
    packageId: string,
    boardId: string,
    values: { autoLoad?: boolean; sortOrder?: number },
  ): Promise<PackageBoard | undefined> {
    const [row] = await db
      .update(packageBoards)
      .set(values)
      .where(and(eq(packageBoards.packageId, packageId), eq(packageBoards.boardId, boardId)))
      .returning();
    return row;
  }

  async removeBoard(packageId: string, boardId: string): Promise<boolean> {
    const removed = await db
      .delete(packageBoards)
      .where(and(eq(packageBoards.packageId, packageId), eq(packageBoards.boardId, boardId)))
      .returning({ id: packageBoards.id });
    return removed.length > 0;
  }

  /** How many packages contain this board — drives the "shared board" warning in the editor. */
  async countPackagesForBoard(boardId: string): Promise<number> {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(packageBoards)
      .where(eq(packageBoards.boardId, boardId));
    return row?.n ?? 0;
  }

  /** Packages containing this board, for the editor badge and P5's strictest-visibility rule. */
  async listPackagesForBoard(boardId: string): Promise<Package[]> {
    return db
      .select({
        id: packages.id,
        instituteId: packages.instituteId,
        type: packages.type,
        name: packages.name,
        description: packages.description,
        imageUrl: packages.imageUrl,
        language: packages.language,
        visibility: packages.visibility,
        defaultMemberPermission: packages.defaultMemberPermission,
        approvalStatus: packages.approvalStatus,
        publishedAt: packages.publishedAt,
        publishedByUserId: packages.publishedByUserId,
        publishAttestation: packages.publishAttestation,
        linkCount: packages.linkCount,
        deletedAt: packages.deletedAt,
        createdByUserId: packages.createdByUserId,
        createdAt: packages.createdAt,
        updatedAt: packages.updatedAt,
      })
      .from(packageBoards)
      .innerJoin(packages, eq(packageBoards.packageId, packages.id))
      .where(eq(packageBoards.boardId, boardId));
  }

  /** Package-scoped boards owned by an institute — the "add a board" picker source. */
  async listInstitutePackageBoards(instituteId: string): Promise<Omit<Board, "irData">[]> {
    const rows = await db
      .select(BOARD_METADATA)
      .from(boards)
      .where(and(eq(boards.scope, "package"), eq(boards.instituteId, instituteId)))
      .orderBy(asc(boards.name));
    return rows as Omit<Board, "irData">[];
  }

  // ------------------------------------------------------------------
  // Student assignments (read side; writes go through packageLinks)
  // ------------------------------------------------------------------

  /** Package ids currently attached to a student. */
  async listAssignedPackageIds(studentId: string): Promise<string[]> {
    const rows = await db
      .select({ packageId: packageAssignments.packageId })
      .from(packageAssignments)
      .where(eq(packageAssignments.studentId, studentId));
    return rows.map((r) => r.packageId);
  }

  /**
   * Packages currently attached to a student, with metadata.
   *
   * Deliberately includes ORPHANED packages: deleting a package does not yank
   * it away from a student who already has it, so the attachment must keep
   * resolving. Callers that build pick-lists want {@link listUsable} instead.
   */
  async listAssignedPackages(studentId: string): Promise<Package[]> {
    const ids = await this.listAssignedPackageIds(studentId);
    if (ids.length === 0) return [];
    return db.select().from(packages).where(inArray(packages.id, ids));
  }

  /** Is this package attached to this student? */
  async isAssigned(packageId: string, studentId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: packageAssignments.id })
      .from(packageAssignments)
      .where(
        and(
          eq(packageAssignments.packageId, packageId),
          eq(packageAssignments.studentId, studentId),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  /**
   * Everything the AAC settings panel needs in one shot: the packages this
   * caller could attach, plus the ids already attached.
   *
   * The attached set can include packages the caller can no longer *use* (an
   * orphan, or one attached by a colleague before a grant was revoked). Those
   * still appear so the panel can show — and detach — them; hiding an active
   * attachment because the viewer lost access would be worse than showing it.
   */
  async getAvailablePackagesForStudent(
    studentId: string,
    ctx: AccessCtx,
  ): Promise<{ packages: Package[]; assignedIds: string[] }> {
    const [usable, assigned] = await Promise.all([
      this.listUsable(ctx),
      this.listAssignedPackages(studentId),
    ]);
    const byId = new Map(usable.map((p) => [p.id, p]));
    for (const pkg of assigned) if (!byId.has(pkg.id)) byId.set(pkg.id, pkg);
    return {
      packages: Array.from(byId.values()),
      assignedIds: assigned.map((p) => p.id),
    };
  }

  // ------------------------------------------------------------------
  // Grants (read side; writes go through packageLinks)
  // ------------------------------------------------------------------

  async listGrants(packageId: string): Promise<PackageGrantEntry[]> {
    const rows = await db
      .select({
        id: packageGrants.id,
        packageId: packageGrants.packageId,
        granteeUserId: packageGrants.granteeUserId,
        permission: packageGrants.permission,
        grantedByUserId: packageGrants.grantedByUserId,
        createdAt: packageGrants.createdAt,
        granteeEmail: users.email,
        granteeName: users.fullName,
      })
      .from(packageGrants)
      .innerJoin(users, eq(packageGrants.granteeUserId, users.id))
      .where(eq(packageGrants.packageId, packageId))
      .orderBy(asc(packageGrants.createdAt));
    return rows as PackageGrantEntry[];
  }

  async getGrantById(grantId: string): Promise<PackageGrant | undefined> {
    const [row] = await db.select().from(packageGrants).where(eq(packageGrants.id, grantId));
    return row;
  }

  // ------------------------------------------------------------------
  // Board scope transitions
  // ------------------------------------------------------------------

  /**
   * Promote an unassigned board to package scope in place.
   *
   * Only valid when `studentId IS NULL` — the CHECK constraint rejects anything
   * else, and rightly so: a board built for a student is that student's data,
   * and sharing it must be an explicit copy, never a silent re-labelling.
   */
  async promoteBoardToPackageScope(boardId: string, instituteId: string): Promise<Board | undefined> {
    const [row] = await db
      .update(boards)
      .set({ scope: "package", instituteId, updatedAt: new Date() })
      .where(and(eq(boards.id, boardId), isNull(boards.studentId)))
      .returning();
    return row;
  }

  /**
   * Take a board OFF its student and hand it to the institute as package
   * content, in place.
   *
   * The counterpart to {@link promoteBoardToPackageScope} for a board that does
   * belong to a child. It is a real loss for that child — the board leaves
   * their device — so the caller must have been told exactly that and have
   * chosen it over the copy; see `detachFromStudent` in PackageController.
   * `studentId` is nulled in the same statement that sets the scope, because
   * the CHECK constraint refuses a package board that still has a student.
   */
  async moveStudentBoardToPackageScope(
    boardId: string,
    instituteId: string,
  ): Promise<Board | undefined> {
    const [row] = await db
      .update(boards)
      .set({ studentId: null, scope: "package", instituteId, updatedAt: new Date() })
      .where(eq(boards.id, boardId))
      .returning();
    return row;
  }

  /** Copy a board's content into a new package-scoped board owned by `instituteId`. */
  async copyBoardIntoPackageScope(
    source: Board,
    instituteId: string,
    userId: string,
    name?: string,
  ): Promise<Board> {
    const [row] = await db
      .insert(boards)
      .values({
        userId,
        instituteId,
        scope: "package",
        studentId: null,
        name: name ?? source.name,
        description: source.description,
        imageUrl: source.imageUrl,
        irData: source.irData,
        language: source.language,
        automaticSelection: source.automaticSelection,
        automaticSelectionHint: source.automaticSelectionHint,
        isGenerated: false,
      })
      .returning();
    return row;
  }

  /** Boards the user could add to a package: their own, unassigned, not yet package-scoped. */
  async listPromotableBoards(userId: string): Promise<Omit<Board, "irData">[]> {
    const rows = await db
      .select(BOARD_METADATA)
      .from(boards)
      .where(and(eq(boards.userId, userId), eq(boards.scope, "student")))
      .orderBy(desc(boards.updatedAt));
    return rows as Omit<Board, "irData">[];
  }

  /** Bulk metadata fetch, used when resolving a list of ids. */
  async getBoardsMetadata(ids: string[]): Promise<Omit<Board, "irData">[]> {
    if (ids.length === 0) return [];
    const rows = await db.select(BOARD_METADATA).from(boards).where(inArray(boards.id, ids));
    return rows as Omit<Board, "irData">[];
  }
}

export const packageRepository = new PackageRepository();
