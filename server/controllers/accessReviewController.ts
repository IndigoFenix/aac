// server/controllers/accessReviewController.ts
// AKIM §2.8: the human-facing half of "revoke access when it is no longer
// needed, and review it periodically".
//
// Three handlers, one idea: an access review is only real if (a) someone can
// SEE who still has access and how stale it is, (b) they can act on it without
// a DBA, and (c) the review itself leaves a trace. Before this, the dormant
// list did not exist and the only way to disable a user account was raw SQL.
//
// Reading a review is itself logged as a `view`, so "we review access
// quarterly" is a claim the activity log can settle.

import type { Request, Response, NextFunction } from "express";
import { userRepository } from "../repositories/userRepository";
import { adminUserRepository } from "../repositories/adminUserRepository";
import { instituteRepository } from "../repositories/instituteRepository";
import { activityLogService } from "../services/activityLogService";
import { deleteUserSessions } from "../services/sessionInvalidation";
import {
  DORMANT_AFTER_DAYS,
  autoDeactivateAfterDays,
  classifyAccount,
  idleDays,
} from "../services/access-review-policy";

/** Cutoff for "has not been seen since" — the review-list SQL boundary. */
function dormancyCutoff(now: Date): Date {
  return new Date(now.getTime() - DORMANT_AFTER_DAYS * 24 * 60 * 60 * 1000);
}

export class AccessReviewController {
  /**
   * GET /api/institutes/:id/access-review
   *
   * The institute's own membership review: who is a member, what they can
   * reach, and when they were last seen. Gated on institute ADMIN — the same
   * check `updateMember` / `removeMember` make, because this list exists to
   * drive those two actions.
   */
  async getInstituteReview(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const instituteId = req.params.id;

      const isAdmin = await instituteRepository.isUserAdminOfInstitute(
        instituteId,
        currentUser.id,
      );
      if (!isAdmin) {
        res.status(403).json({
          success: false,
          message: "Only institute admins can run an access review",
        });
        return;
      }

      const now = new Date();
      const members = await instituteRepository.getInstituteMembers(instituteId);
      const reach = await userRepository.countActiveStudentLinks(
        members.map((m) => m.user.id),
      );

      // Evidence that the review happened, not just that it was possible.
      activityLogService.log({
        instituteId,
        userId: currentUser.id,
        eventType: "view",
        subjectType1: "institute",
        subjectId1: instituteId,
        details: { route: "institute.access-review", memberCount: members.length },
      });

      res.json({
        success: true,
        dormantAfterDays: DORMANT_AFTER_DAYS,
        autoDeactivateAfterDays: autoDeactivateAfterDays(),
        members: members.map(({ user, membership }) => ({
          userId: user.id,
          email: user.email,
          fullName: user.fullName,
          role: membership.role,
          isAdmin: membership.isAdmin,
          lastActiveAt: user.lastActiveAt,
          idleDays: idleDays(user, now),
          classification: classifyAccount(user, now),
          reachableStudents: reach[user.id] ?? 0,
        })),
      });
    } catch (error: any) {
      console.error("Error building institute access review:", error);
      res.status(500).json({ success: false, message: "Failed to build access review" });
    }
  }

  /**
   * GET /api/admin/access-review
   *
   * The global dormant list — users and backoffice admins together, because
   * §2.8 covers both and a review that omits the widest-privileged table is
   * not a review.
   */
  async getGlobalReview(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const now = new Date();
      const cutoff = dormancyCutoff(now);

      const [candidates, admins] = await Promise.all([
        userRepository.listInactiveSince(cutoff),
        adminUserRepository.list(),
      ]);

      const dormantUsers = candidates
        .map((user) => ({
          userId: user.id,
          email: user.email,
          fullName: user.fullName,
          isAdmin: user.isAdmin,
          isSystemAdmin: user.isSystemAdmin,
          lastActiveAt: user.lastActiveAt,
          idleDays: idleDays(user, now),
          classification: classifyAccount(user, now),
        }))
        .filter((r) => r.classification === "dormant" || r.classification === "never_used");

      const dormantAdmins = admins
        .map((admin) => ({
          adminId: admin.id,
          email: admin.email,
          role: admin.role,
          lastActiveAt: admin.lastActiveAt,
          idleDays: idleDays(admin, now),
          classification: classifyAccount(admin, now),
        }))
        .filter((r) => r.classification === "dormant" || r.classification === "never_used");

      activityLogService.log({
        userId: currentUser?.id ?? null,
        eventType: "view",
        subjectType1: "user",
        details: {
          route: "admin.access-review",
          dormantUsers: dormantUsers.length,
          dormantAdmins: dormantAdmins.length,
        },
      });

      res.json({
        success: true,
        dormantAfterDays: DORMANT_AFTER_DAYS,
        autoDeactivateAfterDays: autoDeactivateAfterDays(),
        users: dormantUsers,
        admins: dormantAdmins,
      });
    } catch (error: any) {
      console.error("Error building global access review:", error);
      res.status(500).json({ success: false, message: "Failed to build access review" });
    }
  }

  /**
   * PATCH /api/admin/users/:id  { isActive: boolean }
   *
   * The off switch. `users.is_active` was readable by every auth door
   * (canAuthenticate) but writable by nothing — the only way to disable an
   * account was a hand-run UPDATE.
   *
   * Registered AHEAD of the general admin user update, and forwards anything
   * that is not an `isActive` change to it via `next()`. Deactivation is not
   * an ordinary field write: it also has to evict live sessions and record the
   * before/after, and a generic profile-update path does neither.
   */
  async setUserActive(req: Request, res: Response, next: NextFunction): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.isActive !== "boolean") {
      // Not ours — let the general profile update handle it.
      return next();
    }

    try {
      const isActive = body.isActive;
      const targetId = req.params.id;
      const currentUser = req.user as any;

      const otherKeys = Object.keys(body).filter((k) => k !== "isActive");
      if (otherKeys.length > 0) {
        res.status(400).json({
          success: false,
          message:
            "Change isActive on its own — an account status change evicts sessions and is audited separately",
          fields: otherKeys,
        });
        return;
      }

      // Self-lockout guard. An admin identity shares its id with its `users`
      // shell row (adminAuthService.ensureAdminShellUser), so this also stops a
      // backoffice admin disabling their own shell.
      if (targetId === currentUser?.id) {
        res.status(400).json({
          success: false,
          message: "You cannot change your own account status",
        });
        return;
      }

      const target = await userRepository.getUser(targetId);
      if (!target) {
        res.status(404).json({ success: false, message: "User not found" });
        return;
      }

      const from = target.isActive !== false;
      if (from === isActive) {
        // Idempotent no-op: nothing changed, so nothing is audited.
        res.json({ success: true, changed: false, isActive, sessionsEvicted: 0 });
        return;
      }

      await userRepository.updateUser(targetId, { isActive } as any);

      // Deactivation only counts as revocation if the sessions already issued
      // stop working. deserializeUser would reject them on the next request
      // anyway; this closes the live sockets too and does not wait for one.
      const sessionsEvicted = isActive ? 0 : await deleteUserSessions(targetId);

      activityLogService.log({
        userId: currentUser?.id ?? null,
        eventType: "update",
        subjectType1: "user",
        subjectId1: targetId,
        details: { isActive: { from, to: isActive } },
      });

      res.json({ success: true, changed: true, isActive, sessionsEvicted });
    } catch (error: any) {
      console.error("Error updating user active status:", error);
      res.status(500).json({ success: false, message: "Failed to update account status" });
    }
  }
}

export const accessReviewController = new AccessReviewController();
