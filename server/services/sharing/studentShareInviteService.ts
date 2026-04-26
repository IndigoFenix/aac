// server/services/sharing/studentShareInviteService.ts
//
// Three-party (or two-party, when source institute is absent) consent
// state-machine for cross-institute student-record sharing. See
// `planning-docs/cross-institute-sharing-plan.md` for the architecture.
//
// State diagram:
//
//   pending_guardian ──guardian approve──▶ pending_target ──redeem──▶ pending_target_confirm
//          │                                      │                              │
//          ├─decline──▶ declined                  ├─decline──▶ declined          ├─accept──▶ accepted
//          │                                      │                              ├─decline──▶ declined
//          └──code expires──▶ expired ◀───────────┴──────code expires────────────┘
//                                                                                 │
//                                                                          revoke ▼
//                                                                              revoked
//
// Role-collapse: when createdByUserId === guardianUserId, the guardian step
// auto-fires inline with a separate `share_guardian_approved` audit entry.

import { db } from "../../db";
import { eq, and, inArray, type AnyColumn } from "drizzle-orm";
import {
  studentShareInvites,
  medicalRecords,
  functionalReports,
  educationalReports,
  incidents,
  students,
  type StudentShareInvite,
  type ShareInviteBundle,
  type ShareableObjectType,
  type SharePermission,
  type ObjectShare,
  type StandingShare,
} from "@shared/schema";
import {
  shareInviteRepository,
  type CreateInviteInput,
} from "../../repositories/shareInviteRepository";
import { instituteRepository } from "../../repositories/instituteRepository";
import { activityLogService } from "../activityLogService";

// ============================================================================
// Public errors — the controller layer maps these to HTTP responses.
// ============================================================================

export class ShareInviteError extends Error {
  constructor(
    message: string,
    readonly code: ShareInviteErrorCode,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ShareInviteError";
  }
}

export type ShareInviteErrorCode =
  | "not_found"
  | "invalid_state"
  | "permission_denied"
  | "code_expired"
  | "share_expired"
  | "validation"
  | "sensitive_unacknowledged";

// ============================================================================
// Inputs
// ============================================================================

/** Source-side input. Some fields are optional and inferred. */
export interface CreateInviteRequest {
  /** Student whose data is being shared. */
  studentId: string;
  /**
   * Owning institute of the objects being shared. Null when sharing
   * student-owned data (e.g., AAC-generated incidents with no institute_id),
   * which collapses to a two-party flow.
   */
  sourceInstituteId: string | null;
  /** User initiating the share — clinician at source institute, OR guardian. */
  createdByUserId: string;
  /** The user whose consent stands in for the student. */
  guardianUserId: string;
  /** What's being granted. */
  bundle: ShareInviteBundle;
  /** Optional message from source/guardian to target. */
  message?: string | null;
  /**
   * Lifetime of the redemption code (NOT the share itself). Hours, not days —
   * if the target institute hasn't redeemed within this window, the code rots.
   */
  codeTtlHours?: number;
  /**
   * Lifetime of the resulting per-object shares. Null = indefinite. Standing
   * shares always require an expiry (enforced separately on the bundle).
   */
  shareExpiresAt?: Date | null;
}

const DEFAULT_CODE_TTL_HOURS = 72;

/** How far into the future a standing-share renewal extends `shareExpiresAt`.
 *  1 year matches the "renewable annually" framing in the architecture doc. */
const STANDING_SHARE_RENEWAL_MS = 365 * 24 * 60 * 60 * 1000;

// ============================================================================
// Service
// ============================================================================

class StudentShareInviteService {
  // ==================== createInvite ====================

  /**
   * Create a share invite. Validates source-side permission, checks for
   * sensitive-flag acknowledgment, persists, fires audit log. When the source
   * admin IS the guardian, auto-approves and emits a separate audit entry.
   *
   * Returns the plaintext code (only chance to display it — the DB stores
   * only the hash).
   */
  async createInvite(
    req: CreateInviteRequest,
  ): Promise<{ invite: StudentShareInvite; code: string }> {
    // ── Permission: source institute admin OR guardian (when source is null)
    if (req.sourceInstituteId) {
      const isAdmin = await instituteRepository.isUserAdminOfInstitute(
        req.sourceInstituteId,
        req.createdByUserId,
      );
      if (!isAdmin) {
        throw new ShareInviteError(
          "Only institute admins can share institute-owned records",
          "permission_denied",
        );
      }
    } else if (req.createdByUserId !== req.guardianUserId) {
      // Student-owned data: only the guardian themselves can initiate.
      throw new ShareInviteError(
        "Student-owned data can only be shared by the guardian",
        "permission_denied",
      );
    }

    // ── Validate bundle shape
    this.validateBundle(req.bundle);

    // ── Sensitive-flag gate: hydrate is_sensitive on the bundle, refuse to
    //    proceed if any item is sensitive and the source admin didn't ack.
    const enrichedBundle = await this.enrichBundleWithSensitivity(req.bundle);
    const sensitiveCount = enrichedBundle.objects.filter((o) => o.isSensitive).length;
    if (sensitiveCount > 0 && !enrichedBundle.sensitiveAcknowledged) {
      throw new ShareInviteError(
        "Bundle contains items flagged sensitive — explicit acknowledgment required",
        "sensitive_unacknowledged",
        {
          sensitiveObjectIds: enrichedBundle.objects
            .filter((o) => o.isSensitive)
            .map((o) => ({ type: o.type, id: o.id })),
        },
      );
    }

    // ── Persist
    const codeTtl = req.codeTtlHours ?? DEFAULT_CODE_TTL_HOURS;
    const codeExpiresAt = new Date(Date.now() + codeTtl * 60 * 60 * 1000);
    const dbInput: CreateInviteInput = {
      studentId: req.studentId,
      sourceInstituteId: req.sourceInstituteId,
      createdByUserId: req.createdByUserId,
      guardianUserId: req.guardianUserId,
      message: req.message ?? null,
      bundle: enrichedBundle,
      shareExpiresAt: req.shareExpiresAt ?? null,
      codeExpiresAt,
    };
    const { invite, code } = await shareInviteRepository.createInvite(dbInput);

    activityLogService.log({
      instituteId: req.sourceInstituteId,
      userId: req.createdByUserId,
      eventType: "share_invite_created",
      subjectType1: "student",
      subjectId1: req.studentId,
      subjectType2: "share_invite",
      subjectId2: invite.id,
      details: {
        sourceInstituteId: req.sourceInstituteId,
        objectCount: enrichedBundle.objects.length,
        standingTypeCount: enrichedBundle.standingTypes.length,
        sensitiveCount,
        codeExpiresAt: codeExpiresAt.toISOString(),
      },
    });

    // ── Role-collapse: source admin == guardian → auto-approve.
    let resolved: StudentShareInvite = invite;
    if (req.createdByUserId === req.guardianUserId) {
      resolved = await this.approveByGuardian(invite.id, req.guardianUserId, {
        autoApproved: true,
      });
    }

    return { invite: resolved, code };
  }

  // ==================== approveByGuardian ====================

  async approveByGuardian(
    inviteId: string,
    guardianUserId: string,
    opts: { autoApproved?: boolean } = {},
  ): Promise<StudentShareInvite> {
    const invite = await this.requireInvite(inviteId);
    if (invite.guardianUserId !== guardianUserId) {
      throw new ShareInviteError(
        "Only the named guardian can approve this invite",
        "permission_denied",
      );
    }
    this.assertCodeNotExpired(invite);

    const now = new Date();
    const updated = await shareInviteRepository.transitionStatus(
      inviteId,
      "pending_guardian",
      {
        status: "pending_target",
        guardianApprovedAt: now,
      },
    );
    if (!updated) {
      throw new ShareInviteError(
        `Invite ${inviteId} is not in pending_guardian state`,
        "invalid_state",
      );
    }

    activityLogService.log({
      instituteId: invite.sourceInstituteId,
      userId: guardianUserId,
      eventType: "share_guardian_approved",
      subjectType1: "student",
      subjectId1: invite.studentId,
      subjectType2: "share_invite",
      subjectId2: inviteId,
      details: { autoApproved: !!opts.autoApproved },
    });

    return updated;
  }

  // ==================== redeem ====================

  /**
   * Target-side: an admin at the would-be target institute submits the code.
   * Locks the invite to that institute and surfaces the bundle for review.
   * Acceptance is a separate explicit step (`accept`).
   */
  async redeem(
    plaintextCode: string,
    redeemedByUserId: string,
    targetInstituteId: string,
  ): Promise<StudentShareInvite> {
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      targetInstituteId,
      redeemedByUserId,
    );
    if (!isAdmin) {
      throw new ShareInviteError(
        "Only institute admins can redeem share codes",
        "permission_denied",
      );
    }

    const invite = await shareInviteRepository.getByCode(plaintextCode);
    if (!invite) {
      throw new ShareInviteError("Code not recognized", "not_found");
    }
    this.assertCodeNotExpired(invite);
    if (invite.sourceInstituteId === targetInstituteId) {
      throw new ShareInviteError(
        "Cannot redeem a share into the source institute",
        "validation",
      );
    }

    const updated = await shareInviteRepository.transitionStatus(
      invite.id,
      "pending_target",
      {
        status: "pending_target_confirm",
        targetInstituteId,
        redeemedAt: new Date(),
        redeemedByUserId,
      },
    );
    if (!updated) {
      throw new ShareInviteError(
        `Invite ${invite.id} is not in pending_target state (status: ${invite.status})`,
        "invalid_state",
      );
    }

    activityLogService.log({
      instituteId: targetInstituteId,
      userId: redeemedByUserId,
      eventType: "share_redeemed",
      subjectType1: "student",
      subjectId1: invite.studentId,
      subjectType2: "share_invite",
      subjectId2: invite.id,
      details: { targetInstituteId },
    });

    return updated;
  }

  // ==================== accept ====================

  /**
   * Target-side: confirm and materialize. Creates the objectShares and
   * standingShares rows promised by the invite's bundle.
   */
  async accept(
    inviteId: string,
    acceptedByUserId: string,
  ): Promise<{
    invite: StudentShareInvite;
    objectShares: ObjectShare[];
    standingShares: StandingShare[];
  }> {
    const invite = await this.requireInvite(inviteId);
    if (!invite.targetInstituteId) {
      throw new ShareInviteError(
        "Invite has not been redeemed yet",
        "invalid_state",
      );
    }
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      invite.targetInstituteId,
      acceptedByUserId,
    );
    if (!isAdmin) {
      throw new ShareInviteError(
        "Only target-institute admins can accept share invites",
        "permission_denied",
      );
    }

    const updated = await shareInviteRepository.transitionStatus(
      inviteId,
      "pending_target_confirm",
      {
        status: "accepted",
        acceptedAt: new Date(),
        acceptedByUserId,
      },
    );
    if (!updated) {
      throw new ShareInviteError(
        `Invite ${inviteId} is not in pending_target_confirm state`,
        "invalid_state",
      );
    }

    const materialized = await shareInviteRepository.materializeBundle(updated);

    activityLogService.log({
      instituteId: invite.targetInstituteId,
      userId: acceptedByUserId,
      eventType: "share_accepted",
      subjectType1: "student",
      subjectId1: invite.studentId,
      subjectType2: "share_invite",
      subjectId2: inviteId,
      details: {
        objectShareCount: materialized.objectShares.length,
        standingShareCount: materialized.standingShares.length,
      },
    });

    for (const ss of materialized.standingShares) {
      activityLogService.log({
        instituteId: invite.targetInstituteId,
        userId: acceptedByUserId,
        eventType: "standing_share_granted",
        subjectType1: "student",
        subjectId1: invite.studentId,
        subjectType2: "share_invite",
        subjectId2: inviteId,
        details: {
          standingShareId: ss.id,
          objectTypes: ss.objectTypes,
          shareExpiresAt: ss.shareExpiresAt?.toISOString(),
        },
      });
    }

    return { invite: updated, ...materialized };
  }

  // ==================== decline ====================

  /** Either the guardian (pre-approval) or the target (post-redeem) can decline. */
  async decline(
    inviteId: string,
    userId: string,
    by: "guardian" | "target",
  ): Promise<StudentShareInvite> {
    const invite = await this.requireInvite(inviteId);

    if (by === "guardian") {
      if (invite.guardianUserId !== userId) {
        throw new ShareInviteError(
          "Only the named guardian can decline at the guardian step",
          "permission_denied",
        );
      }
    } else {
      // target: must be admin of target institute (set at redeem time).
      if (!invite.targetInstituteId) {
        throw new ShareInviteError(
          "Invite has not been redeemed by a target institute",
          "invalid_state",
        );
      }
      const isAdmin = await instituteRepository.isUserAdminOfInstitute(
        invite.targetInstituteId,
        userId,
      );
      if (!isAdmin) {
        throw new ShareInviteError(
          "Only target-institute admins can decline post-redemption",
          "permission_denied",
        );
      }
    }

    const allowedFrom =
      by === "guardian"
        ? (["pending_guardian"] as const)
        : (["pending_target", "pending_target_confirm"] as const);
    const updated = await shareInviteRepository.transitionStatus(
      inviteId,
      allowedFrom as unknown as Parameters<
        typeof shareInviteRepository.transitionStatus
      >[1],
      { status: "declined" },
    );
    if (!updated) {
      throw new ShareInviteError(
        `Invite ${inviteId} cannot be declined from its current state`,
        "invalid_state",
      );
    }

    activityLogService.log({
      instituteId:
        by === "guardian" ? invite.sourceInstituteId : invite.targetInstituteId,
      userId,
      eventType: "share_declined",
      subjectType1: "student",
      subjectId1: invite.studentId,
      subjectType2: "share_invite",
      subjectId2: inviteId,
      details: { byRole: by },
    });

    return updated;
  }

  // ==================== revoke ====================

  /**
   * Tears down a share. Three scopes:
   *  - `invite`: revoke all live objectShares + standingShares for the invite,
   *    flip status to `revoked`. Used post-acceptance.
   *  - `object`: revoke a single object_share (granular).
   *  - `standing`: revoke a single standing_share (granular).
   *
   * Authorization: any of the three parties may revoke their own slice.
   * A source-institute admin or the guardian may revoke the entire invite;
   * the target institute may revoke its own access by accepting a new state
   * change here as well.
   */
  async revokeInvite(
    inviteId: string,
    userId: string,
  ): Promise<StudentShareInvite> {
    const invite = await this.requireInvite(inviteId);
    const allowed = await this.userMayRevoke(invite, userId);
    if (!allowed) {
      throw new ShareInviteError(
        "Only the source admin, guardian, or target admin may revoke this invite",
        "permission_denied",
      );
    }

    if (invite.status === "revoked" || invite.status === "expired") {
      return invite; // idempotent
    }

    const now = new Date();
    await shareInviteRepository.revokeAllForInvite(inviteId, userId, now);

    const [updated] = await db
      .update(studentShareInvites)
      .set({ status: "revoked", updatedAt: now })
      .where(eq(studentShareInvites.id, inviteId))
      .returning();

    activityLogService.log({
      instituteId: invite.sourceInstituteId ?? invite.targetInstituteId,
      userId,
      eventType: "share_revoked",
      subjectType1: "student",
      subjectId1: invite.studentId,
      subjectType2: "share_invite",
      subjectId2: inviteId,
      details: { scope: "invite", priorStatus: invite.status },
    });

    return updated;
  }

  async revokeObjectShare(
    objectShareId: string,
    userId: string,
  ): Promise<ObjectShare> {
    const updated = await shareInviteRepository.revokeObjectShare(
      objectShareId,
      userId,
    );
    if (!updated) {
      throw new ShareInviteError(
        "Object share not found or already revoked",
        "not_found",
      );
    }
    activityLogService.log({
      instituteId: updated.targetInstituteId,
      userId,
      eventType: "share_revoked",
      subjectType1: "student",
      subjectId1: updated.studentId,
      subjectType2: "share_invite",
      subjectId2: updated.shareInviteId,
      details: { scope: "object_share", objectShareId, objectType: updated.objectType },
    });
    return updated;
  }

  async revokeStandingShare(
    standingShareId: string,
    userId: string,
  ): Promise<StandingShare> {
    const updated = await shareInviteRepository.revokeStandingShare(
      standingShareId,
      userId,
    );
    if (!updated) {
      throw new ShareInviteError(
        "Standing share not found or already revoked",
        "not_found",
      );
    }
    activityLogService.log({
      instituteId: updated.targetInstituteId,
      userId,
      eventType: "standing_share_revoked",
      subjectType1: "student",
      subjectId1: updated.studentId,
      subjectType2: "share_invite",
      subjectId2: updated.shareInviteId,
      details: { standingShareId },
    });
    return updated;
  }

  // ==================== renewal ====================

  /**
   * Standing-share renewal: extend `shareExpiresAt` by `STANDING_SHARE_RENEWAL_MS`
   * from now. Re-confirms guardian consent on a fixed cadence, which is the
   * pattern HIPAA reviewers expect for ongoing access grants.
   *
   * Permission: only the guardian named on the parent invite. Source/target
   * admins can't renew unilaterally — the consent authority must act.
   *
   * Note: the new expiry is computed from `now`, not from the existing
   * `shareExpiresAt`. Renewing 11 months in still bumps to "1 year from today",
   * not "1 year from the old expiry" — otherwise sequential renewals could
   * compound far into the future, which defeats the purpose of an expiry.
   */
  async renewStandingShare(
    standingShareId: string,
    userId: string,
  ): Promise<StandingShare> {
    const existing = await shareInviteRepository.getStandingShareById(standingShareId);
    if (!existing) {
      throw new ShareInviteError("Standing share not found", "not_found");
    }
    if (existing.revokedAt) {
      throw new ShareInviteError(
        "Cannot renew a revoked standing share",
        "invalid_state",
      );
    }

    const invite = await shareInviteRepository.getById(existing.shareInviteId);
    if (!invite) {
      // Should never happen — invite is FK-required — but guard anyway.
      throw new ShareInviteError("Parent invite not found", "not_found");
    }
    if (invite.guardianUserId !== userId) {
      throw new ShareInviteError(
        "Only the named guardian can renew this share",
        "permission_denied",
      );
    }

    const newExpiresAt = new Date(Date.now() + STANDING_SHARE_RENEWAL_MS);
    const updated = await shareInviteRepository.extendStandingShare(
      standingShareId,
      newExpiresAt,
    );
    if (!updated) {
      // Race: revoked between fetch and update.
      throw new ShareInviteError(
        "Standing share is no longer renewable",
        "invalid_state",
      );
    }

    activityLogService.log({
      instituteId: updated.targetInstituteId,
      userId,
      eventType: "update",
      subjectType1: "standing_share",
      subjectId1: updated.id,
      subjectType2: "student",
      subjectId2: updated.studentId,
      details: {
        renewal: true,
        previousExpiresAt: existing.shareExpiresAt.toISOString(),
        newExpiresAt: newExpiresAt.toISOString(),
        shareInviteId: updated.shareInviteId,
      },
    });
    return updated;
  }

  // ==================== sweep ====================

  /** Cron-able sweep: expire invites whose redemption code has elapsed. */
  async expireElapsedInvites(): Promise<number> {
    return shareInviteRepository.expireElapsedInvites();
  }

  // ==================== read paths ====================

  async getInvite(inviteId: string): Promise<StudentShareInvite | undefined> {
    return shareInviteRepository.getById(inviteId);
  }

  async listForSourceInstitute(instituteId: string): Promise<StudentShareInvite[]> {
    return shareInviteRepository.listBySourceInstitute(instituteId);
  }

  async listForTargetInstitute(instituteId: string): Promise<StudentShareInvite[]> {
    return shareInviteRepository.listByTargetInstitute(instituteId);
  }

  async listPendingForGuardian(userId: string): Promise<StudentShareInvite[]> {
    return shareInviteRepository.listPendingForGuardian(userId);
  }

  /**
   * Standing shares whose parent invite names this user as guardian. Used by
   * the Inbox tab in `SharesPanel` so the guardian can see and renew shares
   * approaching expiry.
   */
  async listStandingSharesForGuardian(
    userId: string,
  ): Promise<{ share: StandingShare; invite: StudentShareInvite }[]> {
    return shareInviteRepository.listStandingSharesForGuardian(userId);
  }

  /**
   * "What's actively shared right now" for an institute. Used by the
   * Outgoing/Incoming tabs to show materialized object_shares + standing_shares
   * alongside invites. Only non-revoked rows; the UI filters out expired ones
   * client-side off `shareExpiresAt`.
   *
   * The response includes a `students` map (id → display name) so the panel
   * can group rows per-student without a second round-trip.
   */
  async listActiveSharesForInstitute(
    instituteId: string,
    role: "source" | "target",
  ): Promise<{
    objectShares: ObjectShare[];
    standingShares: StandingShare[];
    students: Record<string, { id: string; name: string }>;
  }> {
    const [objectSharesRows, standingSharesRows] =
      role === "source"
        ? await Promise.all([
            shareInviteRepository.listObjectSharesBySourceInstitute(instituteId),
            shareInviteRepository.listStandingSharesBySourceInstitute(instituteId),
          ])
        : await Promise.all([
            shareInviteRepository.listObjectSharesByTargetInstitute(instituteId),
            shareInviteRepository.listStandingSharesByTargetInstitute(instituteId),
          ]);

    // Resolve student labels for the union of student-ids touched.
    const studentIds = Array.from(
      new Set([
        ...objectSharesRows.map((s) => s.studentId),
        ...standingSharesRows.map((s) => s.studentId),
      ]),
    );
    const studentLabels: Record<string, { id: string; name: string }> = {};
    if (studentIds.length > 0) {
      const rows = await db
        .select({
          id: students.id,
          firstName: students.firstName,
          lastName: students.lastName,
          name: students.name,
        })
        .from(students)
        .where(inArray(students.id, studentIds));
      for (const r of rows) {
        const label = [r.firstName, r.lastName].filter(Boolean).join(" ").trim() || r.name;
        studentLabels[r.id] = { id: r.id, name: label };
      }
    }

    return {
      objectShares: objectSharesRows,
      standingShares: standingSharesRows,
      students: studentLabels,
    };
  }

  /**
   * Bulk-ungrant for guardians: revokes every active share (object + standing)
   * the calling guardian granted to a specific recipient institute for a
   * specific student, all in one action. Used when a student transfers
   * institutes and the guardian wants to wind down the previous institute's
   * access in one click instead of per-grant.
   *
   * Permission: only the guardian on the parent invite. Each individual revoke
   * fires its own audit entry (matching `revokeObjectShare` / `revokeStandingShare`)
   * so the audit trail stays per-grant — no special bulk event type. Rows
   * already revoked are silently skipped (filtered at list time).
   */
  async bulkRevokeForGuardianAtInstitute(
    userId: string,
    studentId: string,
    targetInstituteId: string,
  ): Promise<{ objectSharesRevoked: number; standingSharesRevoked: number }> {
    const { objectShares, standingShares } =
      await shareInviteRepository.listActiveSharesForGuardianAtInstitute(
        userId,
        studentId,
        targetInstituteId,
      );

    let objectSharesRevoked = 0;
    let standingSharesRevoked = 0;

    for (const os of objectShares) {
      try {
        await this.revokeObjectShare(os.id, userId);
        objectSharesRevoked++;
      } catch (err) {
        // Race with another revoke is fine — skip and continue.
        if (!(err instanceof ShareInviteError && err.code === "not_found")) throw err;
      }
    }
    for (const ss of standingShares) {
      try {
        await this.revokeStandingShare(ss.id, userId);
        standingSharesRevoked++;
      } catch (err) {
        if (!(err instanceof ShareInviteError && err.code === "not_found")) throw err;
      }
    }

    return { objectSharesRevoked, standingSharesRevoked };
  }

  // ==================== internals ====================

  private async requireInvite(inviteId: string): Promise<StudentShareInvite> {
    const invite = await shareInviteRepository.getById(inviteId);
    if (!invite) {
      throw new ShareInviteError(`Invite ${inviteId} not found`, "not_found");
    }
    return invite;
  }

  private assertCodeNotExpired(invite: StudentShareInvite): void {
    if (invite.codeExpiresAt.getTime() < Date.now()) {
      throw new ShareInviteError("Share code has expired", "code_expired");
    }
  }

  private validateBundle(bundle: ShareInviteBundle): void {
    if (bundle.objects.length === 0 && bundle.standingTypes.length === 0) {
      throw new ShareInviteError(
        "Bundle must include at least one object or standing-share type",
        "validation",
      );
    }
    if (bundle.standingTypes.length > 0 && !bundle.standingExpiresAt) {
      throw new ShareInviteError(
        "Standing-share grants require an expiry date",
        "validation",
      );
    }
  }

  /**
   * Look up `is_sensitive` per object id from the underlying tables and stamp
   * the result on the bundle. Captures the flag as-of-grant-time — it's an
   * audit fact, frozen even if the underlying object's flag is later flipped.
   */
  private async enrichBundleWithSensitivity(
    bundle: ShareInviteBundle,
  ): Promise<ShareInviteBundle> {
    if (bundle.objects.length === 0) return bundle;

    const byType = new Map<ShareableObjectType, string[]>();
    for (const o of bundle.objects) {
      const list = byType.get(o.type) ?? [];
      list.push(o.id);
      byType.set(o.type, list);
    }

    const flags = new Map<string, boolean>(); // key = `${type}:${id}` → isSensitive

    await Promise.all(
      Array.from(byType.entries()).map(async ([type, ids]) => {
        const rows = await this.fetchSensitivityRows(type, ids);
        for (const row of rows) {
          flags.set(`${type}:${row.id}`, row.isSensitive);
        }
      }),
    );

    return {
      ...bundle,
      objects: bundle.objects.map((o) => ({
        ...o,
        // If we found the row, use the live flag. If not, fall back to the
        // caller-provided flag (lets unknown types like custom_app_assignment
        // default to false without DB shape support).
        isSensitive: flags.has(`${o.type}:${o.id}`)
          ? flags.get(`${o.type}:${o.id}`)!
          : o.isSensitive,
      })),
    };
  }

  private async fetchSensitivityRows(
    type: ShareableObjectType,
    ids: string[],
  ): Promise<{ id: string; isSensitive: boolean }[]> {
    if (ids.length === 0) return [];
    switch (type) {
      case "medical_record":
        return db
          .select({ id: medicalRecords.id, isSensitive: medicalRecords.isSensitive })
          .from(medicalRecords)
          .where(eqAnyId(medicalRecords.id, ids));
      case "functional_report":
        return db
          .select({
            id: functionalReports.id,
            isSensitive: functionalReports.isSensitive,
          })
          .from(functionalReports)
          .where(eqAnyId(functionalReports.id, ids));
      case "educational_report":
        return db
          .select({
            id: educationalReports.id,
            isSensitive: educationalReports.isSensitive,
          })
          .from(educationalReports)
          .where(eqAnyId(educationalReports.id, ids));
      case "incident":
        return db
          .select({ id: incidents.id, isSensitive: incidents.isSensitive })
          .from(incidents)
          .where(eqAnyId(incidents.id, ids));
      // Programs, deep_analyses, custom_app_assignments, monitor_note: no
      // is_sensitive column. Treat as not-sensitive at the DB layer; callers
      // that want a stricter default can pass isSensitive=true on the bundle.
      default:
        return [];
    }
  }

  /**
   * Authorization for full-invite revoke. Source admin, guardian, or target
   * admin (when targetInstituteId is set) may pull the plug.
   */
  private async userMayRevoke(
    invite: StudentShareInvite,
    userId: string,
  ): Promise<boolean> {
    if (invite.guardianUserId === userId) return true;
    if (invite.sourceInstituteId) {
      if (await instituteRepository.isUserAdminOfInstitute(invite.sourceInstituteId, userId)) {
        return true;
      }
    }
    if (invite.targetInstituteId) {
      if (await instituteRepository.isUserAdminOfInstitute(invite.targetInstituteId, userId)) {
        return true;
      }
    }
    return false;
  }
}

function eqAnyId(col: AnyColumn, ids: string[]) {
  return inArray(col, ids);
}

export const studentShareInviteService = new StudentShareInviteService();

// Convenience type re-exports for controller callers.
export type {
  ShareInviteBundle,
  ShareableObjectType,
  SharePermission,
} from "@shared/schema";
