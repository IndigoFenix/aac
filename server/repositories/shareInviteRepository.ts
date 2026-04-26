// server/repositories/shareInviteRepository.ts
//
// DB layer for the cross-institute sharing tables: studentShareInvites,
// objectShares, standingShares.
//
// Pure persistence — all state-machine validation, role-collapse, and audit
// logging lives in `server/services/sharing/studentShareInviteService.ts`.
// See `planning-docs/cross-institute-sharing-plan.md`.

import {
  studentShareInvites,
  objectShares,
  standingShares,
  type StudentShareInvite,
  type ObjectShare,
  type StandingShare,
  type ShareInviteStatus,
  type ShareInviteBundle,
  type SharePermission,
  type ShareableObjectType,
} from "@shared/schema";
import { db } from "../db";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import crypto from "crypto";

export interface CreateInviteInput {
  studentId: string;
  sourceInstituteId: string | null;
  createdByUserId: string;
  guardianUserId: string;
  message?: string | null;
  bundle: ShareInviteBundle;
  /** Per-object share expiry — copied to objectShares on accept. */
  shareExpiresAt: Date | null;
  /** Code-redemption expiry (hours, not days). */
  codeExpiresAt: Date;
}

/**
 * Code alphabet excludes `0`, `O`, `1`, `I`, `l` to keep manually-typed codes
 * unambiguous. Length 12 ⇒ ~60 bits entropy — combined with hours-long expiry
 * and audit logging on lookup, online brute-force is infeasible.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 12;

export class ShareInviteRepository {
  /** Generate a fresh share code. */
  generateCode(): string {
    const bytes = crypto.randomBytes(CODE_LENGTH);
    let out = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return out;
  }

  /** Deterministic hash for code lookup (unique-indexed in DB). */
  hashCode(code: string): string {
    return crypto.createHash("sha256").update(code).digest("hex");
  }

  // ============================================================== Invites

  async createInvite(
    input: CreateInviteInput,
  ): Promise<{ invite: StudentShareInvite; code: string }> {
    const code = this.generateCode();
    const codeHash = this.hashCode(code);

    const [invite] = await db
      .insert(studentShareInvites)
      .values({
        studentId: input.studentId,
        sourceInstituteId: input.sourceInstituteId,
        targetInstituteId: null,
        codeHash,
        createdByUserId: input.createdByUserId,
        guardianUserId: input.guardianUserId,
        message: input.message ?? null,
        pendingBundle: input.bundle,
        shareExpiresAt: input.shareExpiresAt,
        codeExpiresAt: input.codeExpiresAt,
      })
      .returning();

    return { invite, code };
  }

  async getById(id: string): Promise<StudentShareInvite | undefined> {
    const [row] = await db
      .select()
      .from(studentShareInvites)
      .where(eq(studentShareInvites.id, id));
    return row || undefined;
  }

  async getByCode(plaintext: string): Promise<StudentShareInvite | undefined> {
    const [row] = await db
      .select()
      .from(studentShareInvites)
      .where(eq(studentShareInvites.codeHash, this.hashCode(plaintext)));
    return row || undefined;
  }

  /** Conditional update — succeeds only when current status matches `from`. */
  async transitionStatus(
    id: string,
    from: ShareInviteStatus | ShareInviteStatus[],
    patch: Partial<typeof studentShareInvites.$inferInsert> & {
      status: ShareInviteStatus;
    },
  ): Promise<StudentShareInvite | undefined> {
    const fromList = Array.isArray(from) ? from : [from];
    const [row] = await db
      .update(studentShareInvites)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(studentShareInvites.id, id),
          inArray(studentShareInvites.status, fromList),
        ),
      )
      .returning();
    return row || undefined;
  }

  /** Listing for source-institute clinicians: shares originating from an institute. */
  async listBySourceInstitute(
    sourceInstituteId: string,
  ): Promise<StudentShareInvite[]> {
    return db
      .select()
      .from(studentShareInvites)
      .where(eq(studentShareInvites.sourceInstituteId, sourceInstituteId));
  }

  /** Listing for target-institute clinicians: shares accepted into the institute. */
  async listByTargetInstitute(
    targetInstituteId: string,
  ): Promise<StudentShareInvite[]> {
    return db
      .select()
      .from(studentShareInvites)
      .where(eq(studentShareInvites.targetInstituteId, targetInstituteId));
  }

  /** Guardian inbox: invites awaiting their approval. */
  async listPendingForGuardian(
    guardianUserId: string,
  ): Promise<StudentShareInvite[]> {
    return db
      .select()
      .from(studentShareInvites)
      .where(
        and(
          eq(studentShareInvites.guardianUserId, guardianUserId),
          eq(studentShareInvites.status, "pending_guardian"),
        ),
      );
  }

  /**
   * Sweep: transition any non-terminal invites whose code/share has elapsed.
   * Idempotent. Returns affected count.
   */
  async expireElapsedInvites(now: Date = new Date()): Promise<number> {
    const result = await db
      .update(studentShareInvites)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          inArray(studentShareInvites.status, [
            "pending_guardian",
            "pending_target",
            "pending_target_confirm",
          ]),
          lt(studentShareInvites.codeExpiresAt, now),
        ),
      )
      .returning({ id: studentShareInvites.id });
    return result.length;
  }

  // ============================================================== Materialization

  /**
   * Create the objectShares + standingShares rows that an accepted invite
   * promises. Called from the service layer inside the same transaction as
   * the status flip to `accepted`. Returns the created rows for logging.
   */
  async materializeBundle(
    invite: StudentShareInvite,
  ): Promise<{ objectShares: ObjectShare[]; standingShares: StandingShare[] }> {
    if (!invite.targetInstituteId) {
      throw new Error(
        `[shareInviteRepository] cannot materialize invite ${invite.id} — no targetInstituteId set`,
      );
    }
    const bundle = invite.pendingBundle;
    const out: { objectShares: ObjectShare[]; standingShares: StandingShare[] } = {
      objectShares: [],
      standingShares: [],
    };

    if (bundle.objects.length > 0) {
      const rows = bundle.objects.map((o) => ({
        objectType: o.type,
        objectId: o.id,
        studentId: invite.studentId,
        sourceInstituteId: invite.sourceInstituteId,
        targetInstituteId: invite.targetInstituteId!,
        permission: bundle.permission,
        shareInviteId: invite.id,
        shareExpiresAt: bundle.shareExpiresAt
          ? new Date(bundle.shareExpiresAt)
          : null,
      }));
      out.objectShares = await db
        .insert(objectShares)
        .values(rows)
        .returning();
    }

    if (bundle.standingTypes.length > 0) {
      if (!bundle.standingExpiresAt) {
        throw new Error(
          `[shareInviteRepository] standingExpiresAt is required when standingTypes is non-empty (invite ${invite.id})`,
        );
      }
      const [row] = await db
        .insert(standingShares)
        .values({
          studentId: invite.studentId,
          targetInstituteId: invite.targetInstituteId,
          objectTypes: bundle.standingTypes,
          permission: bundle.permission,
          shareInviteId: invite.id,
          shareExpiresAt: new Date(bundle.standingExpiresAt),
        })
        .returning();
      out.standingShares = row ? [row] : [];
    }

    return out;
  }

  /**
   * Revoke all live shares belonging to an invite. Used when the invite itself
   * is revoked post-accept.
   */
  async revokeAllForInvite(
    inviteId: string,
    revokedByUserId: string,
    now: Date = new Date(),
  ): Promise<void> {
    await Promise.all([
      db
        .update(objectShares)
        .set({ revokedAt: now, revokedByUserId })
        .where(
          and(
            eq(objectShares.shareInviteId, inviteId),
            isNull(objectShares.revokedAt),
          ),
        ),
      db
        .update(standingShares)
        .set({ revokedAt: now, revokedByUserId })
        .where(
          and(
            eq(standingShares.shareInviteId, inviteId),
            isNull(standingShares.revokedAt),
          ),
        ),
    ]);
  }

  // ============================================================== Listing live shares

  async listObjectSharesForInvite(inviteId: string): Promise<ObjectShare[]> {
    return db
      .select()
      .from(objectShares)
      .where(eq(objectShares.shareInviteId, inviteId));
  }

  async listStandingSharesForInvite(inviteId: string): Promise<StandingShare[]> {
    return db
      .select()
      .from(standingShares)
      .where(eq(standingShares.shareInviteId, inviteId));
  }

  /** Single-share revocation (granular — used to drop one object grant). */
  async revokeObjectShare(
    id: string,
    revokedByUserId: string,
    now: Date = new Date(),
  ): Promise<ObjectShare | undefined> {
    const [row] = await db
      .update(objectShares)
      .set({ revokedAt: now, revokedByUserId })
      .where(and(eq(objectShares.id, id), isNull(objectShares.revokedAt)))
      .returning();
    return row || undefined;
  }

  async revokeStandingShare(
    id: string,
    revokedByUserId: string,
    now: Date = new Date(),
  ): Promise<StandingShare | undefined> {
    const [row] = await db
      .update(standingShares)
      .set({ revokedAt: now, revokedByUserId })
      .where(and(eq(standingShares.id, id), isNull(standingShares.revokedAt)))
      .returning();
    return row || undefined;
  }

  /** Single-row lookup for the renewal flow (and any other targeted action). */
  async getStandingShareById(id: string): Promise<StandingShare | undefined> {
    const [row] = await db
      .select()
      .from(standingShares)
      .where(eq(standingShares.id, id));
    return row || undefined;
  }

  /**
   * Standing shares whose parent invite names this user as guardian. Returns
   * shares paired with their parent invite so callers can show student/scope
   * context without a second round-trip. Includes already-expired and revoked
   * shares (UI filters as needed) so the guardian can see the full history.
   */
  async listStandingSharesForGuardian(
    guardianUserId: string,
  ): Promise<{ share: StandingShare; invite: StudentShareInvite }[]> {
    const rows = await db
      .select({ share: standingShares, invite: studentShareInvites })
      .from(standingShares)
      .innerJoin(
        studentShareInvites,
        eq(standingShares.shareInviteId, studentShareInvites.id),
      )
      .where(eq(studentShareInvites.guardianUserId, guardianUserId));
    return rows;
  }

  /**
   * Extend a standing share's `shareExpiresAt`. Caller decides the new expiry
   * (typically `now + 1 year`); we don't recompute from the existing expiry so
   * sequential renewals don't compound far into the future. Refuses to update
   * a revoked share. Returns the updated row, or undefined if not found / revoked.
   */
  async extendStandingShare(
    id: string,
    newExpiresAt: Date,
  ): Promise<StandingShare | undefined> {
    const [row] = await db
      .update(standingShares)
      .set({ shareExpiresAt: newExpiresAt })
      .where(and(eq(standingShares.id, id), isNull(standingShares.revokedAt)))
      .returning();
    return row || undefined;
  }

  // ============================================================== Listings by institute
  //
  // Materialized shares (objectShares + standingShares) are persisted at accept
  // time and live independently of invite status. The Outgoing/Incoming tabs
  // need to show them alongside invites so clinicians can see "what's actively
  // shared right now" — not just "what invites exist". `objectShares` carries
  // `sourceInstituteId` directly; `standingShares` doesn't have that column,
  // so we join through the parent invite to derive source ownership.
  //
  // All four list methods return only NON-revoked rows. UI typically also
  // wants to filter expired rows out of the active view; that's done client-
  // side off `shareExpiresAt` so the server response carries the full picture.

  async listObjectSharesBySourceInstitute(sourceInstituteId: string): Promise<ObjectShare[]> {
    return db
      .select()
      .from(objectShares)
      .where(
        and(
          eq(objectShares.sourceInstituteId, sourceInstituteId),
          isNull(objectShares.revokedAt),
        ),
      );
  }

  async listObjectSharesByTargetInstitute(targetInstituteId: string): Promise<ObjectShare[]> {
    return db
      .select()
      .from(objectShares)
      .where(
        and(
          eq(objectShares.targetInstituteId, targetInstituteId),
          isNull(objectShares.revokedAt),
        ),
      );
  }

  async listStandingSharesBySourceInstitute(sourceInstituteId: string): Promise<StandingShare[]> {
    // standingShares.sourceInstituteId doesn't exist — derive via invite.
    const rows = await db
      .select({ share: standingShares })
      .from(standingShares)
      .innerJoin(
        studentShareInvites,
        eq(standingShares.shareInviteId, studentShareInvites.id),
      )
      .where(
        and(
          eq(studentShareInvites.sourceInstituteId, sourceInstituteId),
          isNull(standingShares.revokedAt),
        ),
      );
    return rows.map((r) => r.share);
  }

  async listStandingSharesByTargetInstitute(targetInstituteId: string): Promise<StandingShare[]> {
    return db
      .select()
      .from(standingShares)
      .where(
        and(
          eq(standingShares.targetInstituteId, targetInstituteId),
          isNull(standingShares.revokedAt),
        ),
      );
  }

  /**
   * Active shares (object + standing) for a single (student, target-institute)
   * pair where the guardian on the parent invite is the calling user. Drives
   * the bulk-ungrant flow: a guardian revoking all access they granted to a
   * specific recipient (e.g. when a student transfers institutes).
   */
  async listActiveSharesForGuardianAtInstitute(
    guardianUserId: string,
    studentId: string,
    targetInstituteId: string,
  ): Promise<{ objectShares: ObjectShare[]; standingShares: StandingShare[] }> {
    const [objectRows, standingRows] = await Promise.all([
      db
        .select({ share: objectShares })
        .from(objectShares)
        .innerJoin(
          studentShareInvites,
          eq(objectShares.shareInviteId, studentShareInvites.id),
        )
        .where(
          and(
            eq(objectShares.studentId, studentId),
            eq(objectShares.targetInstituteId, targetInstituteId),
            isNull(objectShares.revokedAt),
            eq(studentShareInvites.guardianUserId, guardianUserId),
          ),
        ),
      db
        .select({ share: standingShares })
        .from(standingShares)
        .innerJoin(
          studentShareInvites,
          eq(standingShares.shareInviteId, studentShareInvites.id),
        )
        .where(
          and(
            eq(standingShares.studentId, studentId),
            eq(standingShares.targetInstituteId, targetInstituteId),
            isNull(standingShares.revokedAt),
            eq(studentShareInvites.guardianUserId, guardianUserId),
          ),
        ),
    ]);
    return {
      objectShares: objectRows.map((r) => r.share),
      standingShares: standingRows.map((r) => r.share),
    };
  }
}

export const shareInviteRepository = new ShareInviteRepository();

// Re-exports kept narrow — most callers want types from @shared/schema.
export type {
  ShareInviteBundle,
  ShareInviteStatus,
  SharePermission,
  ShareableObjectType,
};
