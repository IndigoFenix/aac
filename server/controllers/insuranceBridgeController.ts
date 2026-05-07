import type { Request, Response } from "express";
import { getRtmRollup } from "../services/insurance/rtmRollupService";
import {
  recordHeartbeat,
  closeOpenInterval,
} from "../services/insurance/clinicianActivityService";
import { getClinicianTimeRollup } from "../services/insurance/clinicianTimeRollupService";
import { searchIcdCodes } from "../services/insurance/icd10Service";
import {
  createLmnDraft,
  getLmn,
  listLmnsForStudent,
  listLmnsForInstitute,
  updateLmnSections,
  finalizeLmn,
  type LmnSections,
} from "../services/insurance/lmnService";
import { instituteService } from "../services/instituteService";
import { activityLogService } from "../services/activityLogService";
import { instituteRepository } from "../repositories/instituteRepository";
import { licenseService } from "../services/licenseService";

class InsuranceBridgeController {
  /**
   * GET /api/insurance/rtm?instituteId=...&period=YYYY-MM
   *
   * Returns per-student RTM totals for a billing period. Threshold-free —
   * the client maps daysActive onto a billing code per the institute's
   * billingRegime. Gated on the institute's `insuranceBridgeEnabled`
   * permission and on the requesting user being a member of the institute.
   */
  async getRtm(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Unauthorized" });
        return;
      }

      const instituteId = (req.query.instituteId as string | undefined) ?? "";
      const period = (req.query.period as string | undefined) ?? "";
      if (!instituteId) {
        res.status(400).json({ success: false, message: "instituteId is required" });
        return;
      }
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
        res.status(400).json({ success: false, message: "period must be YYYY-MM" });
        return;
      }

      const isMember = await instituteRepository.isUserMemberOfInstitute(instituteId, userId);
      if (!isMember) {
        res.status(403).json({ success: false, message: "Not a member of this institute" });
        return;
      }

      const { permissions } = await licenseService.getInstituteLicenseInfo(instituteId);
      if (!permissions.insuranceBridgeEnabled) {
        res.status(403).json({
          success: false,
          message: "Insurance Bridge is not enabled for this institute's license",
        });
        return;
      }

      const rollup = await getRtmRollup({ instituteId, period });
      res.json({
        success: true,
        rollup,
        billingRegime: permissions.billingRegime,
      });
    } catch (error: any) {
      console.error("[InsuranceBridgeController] getRtm error:", error);
      res.status(500).json({ success: false, message: "Failed to compute RTM rollup" });
    }
  }

  /**
   * GET /api/insurance/clinician-time?instituteId=...&period=YYYY-MM
   *
   * Per-student review-time totals for the period. Threshold-free; client
   * regime layer maps `totalMinutes` to a CPT code (98979 / 98980 in us_cpt).
   * `hadInteractive` is exposed so the UI can explain why a code is blocked.
   */
  async getClinicianTime(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Unauthorized" });
        return;
      }

      const instituteId = (req.query.instituteId as string | undefined) ?? "";
      const period = (req.query.period as string | undefined) ?? "";
      if (!instituteId) {
        res.status(400).json({ success: false, message: "instituteId is required" });
        return;
      }
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
        res.status(400).json({ success: false, message: "period must be YYYY-MM" });
        return;
      }

      const isMember = await instituteRepository.isUserMemberOfInstitute(instituteId, userId);
      if (!isMember) {
        res.status(403).json({ success: false, message: "Not a member of this institute" });
        return;
      }

      const { permissions } = await licenseService.getInstituteLicenseInfo(instituteId);
      if (!permissions.insuranceBridgeEnabled) {
        res.status(403).json({
          success: false,
          message: "Insurance Bridge is not enabled for this institute's license",
        });
        return;
      }

      const rollup = await getClinicianTimeRollup({ instituteId, period });
      res.json({
        success: true,
        rollup,
        billingRegime: permissions.billingRegime,
      });
    } catch (error: any) {
      console.error("[InsuranceBridgeController] getClinicianTime error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to compute clinician time rollup",
      });
    }
  }

  /**
   * GET /api/insurance/lmn?instituteId=...&studentId=...
   *
   * Lists LMNs in the given institute. When `studentId` is supplied, scopes
   * to that student; otherwise returns every LMN belonging to the institute
   * (used by the billing summary). Member + insuranceBridgeEnabled gate;
   * per-student calls additionally require enrollment in the institute (the
   * v1 owning-institute-only constraint).
   */
  async listLmns(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Unauthorized" });
        return;
      }
      const instituteId = (req.query.instituteId as string | undefined) ?? "";
      const studentId = (req.query.studentId as string | undefined) || null;
      if (!instituteId) {
        res.status(400).json({ success: false, message: "instituteId is required" });
        return;
      }

      const isMember = await instituteRepository.isUserMemberOfInstitute(instituteId, userId);
      if (!isMember) {
        res.status(403).json({ success: false, message: "Not a member of this institute" });
        return;
      }
      const { permissions } = await licenseService.getInstituteLicenseInfo(instituteId);
      if (!permissions.insuranceBridgeEnabled) {
        res.status(403).json({
          success: false,
          message: "Insurance Bridge is not enabled for this institute's license",
        });
        return;
      }

      let lmns;
      if (studentId) {
        const enrolled = await instituteService.isStudentInInstitute(instituteId, studentId);
        if (!enrolled) {
          res.status(403).json({
            success: false,
            message: "Student is not enrolled in this institute",
          });
          return;
        }
        lmns = await listLmnsForStudent(studentId, instituteId);
      } else {
        lmns = await listLmnsForInstitute(instituteId);
      }
      res.json({ success: true, lmns });
    } catch (error: any) {
      console.error("[InsuranceBridgeController] listLmns error:", error);
      res.status(500).json({ success: false, message: "Failed to list LMNs" });
    }
  }

  /**
   * GET /api/insurance/lmn/:id
   * Read a single LMN. Same gating as listLmns.
   */
  async getLmn(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Unauthorized" });
        return;
      }
      const lmn = await getLmn(req.params.id);
      if (!lmn) {
        res.status(404).json({ success: false, message: "LMN not found" });
        return;
      }
      const gate = await this.lmnGate(userId, lmn.instituteId ?? "", lmn.studentId);
      if (!gate.ok) {
        res.status(gate.status).json({ success: false, message: gate.message });
        return;
      }
      res.json({ success: true, lmn });
    } catch (error: any) {
      console.error("[InsuranceBridgeController] getLmn error:", error);
      res.status(500).json({ success: false, message: "Failed to read LMN" });
    }
  }

  /**
   * POST /api/insurance/lmn
   * Body: { instituteId, studentId, windowDays? }
   *
   * Create a new LMN draft, snapshotting student + medical record + goals +
   * utterance metrics into editable sections.
   */
  async createLmn(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Unauthorized" });
        return;
      }
      const { instituteId, studentId, windowDays } = req.body ?? {};
      if (!instituteId || !studentId) {
        res.status(400).json({ success: false, message: "instituteId and studentId are required" });
        return;
      }
      const gate = await this.lmnGate(userId, instituteId, studentId);
      if (!gate.ok) {
        res.status(gate.status).json({ success: false, message: gate.message });
        return;
      }

      const lmn = await createLmnDraft({
        studentId,
        instituteId,
        userId,
        windowDays: typeof windowDays === "number" ? windowDays : undefined,
      });
      activityLogService.log({
        userId,
        instituteId,
        eventType: "lmn_generated",
        subjectType1: "student",
        subjectId1: studentId,
        details: { lmnId: lmn.id },
      });
      res.json({ success: true, lmn });
    } catch (error: any) {
      console.error("[InsuranceBridgeController] createLmn error:", error);
      res.status(500).json({ success: false, message: error.message ?? "Failed to create LMN" });
    }
  }

  /**
   * PATCH /api/insurance/lmn/:id
   * Body: { sections }
   * Edit the draft. Rejects when the LMN is finalized.
   */
  async updateLmn(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Unauthorized" });
        return;
      }
      const existing = await getLmn(req.params.id);
      if (!existing) {
        res.status(404).json({ success: false, message: "LMN not found" });
        return;
      }
      const gate = await this.lmnGate(userId, existing.instituteId ?? "", existing.studentId);
      if (!gate.ok) {
        res.status(gate.status).json({ success: false, message: gate.message });
        return;
      }
      const sections = req.body?.sections as LmnSections | undefined;
      if (!sections) {
        res.status(400).json({ success: false, message: "sections is required" });
        return;
      }
      const updated = await updateLmnSections(req.params.id, sections);
      res.json({ success: true, lmn: updated });
    } catch (error: any) {
      const status = /finalized/i.test(error.message ?? "") ? 409 : 500;
      res.status(status).json({ success: false, message: error.message ?? "Failed to update LMN" });
    }
  }

  /**
   * POST /api/insurance/lmn/:id/finalize
   * Body: { signatureName, signatureLicense?, signatureCredentials? }
   * Lock the LMN and stamp the signature placeholder fields.
   */
  async finalizeLmn(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Unauthorized" });
        return;
      }
      const existing = await getLmn(req.params.id);
      if (!existing) {
        res.status(404).json({ success: false, message: "LMN not found" });
        return;
      }
      const gate = await this.lmnGate(userId, existing.instituteId ?? "", existing.studentId);
      if (!gate.ok) {
        res.status(gate.status).json({ success: false, message: gate.message });
        return;
      }
      const signatureName = (req.body?.signatureName as string | undefined)?.trim();
      if (!signatureName) {
        res.status(400).json({ success: false, message: "signatureName is required" });
        return;
      }
      const updated = await finalizeLmn(req.params.id, {
        signatureName,
        signatureLicense: (req.body?.signatureLicense as string | undefined)?.trim() || null,
        signatureCredentials: (req.body?.signatureCredentials as string | undefined)?.trim() || null,
      });
      activityLogService.log({
        userId,
        instituteId: existing.instituteId,
        eventType: "lmn_finalized",
        subjectType1: "student",
        subjectId1: existing.studentId,
        details: { lmnId: updated.id },
      });
      res.json({ success: true, lmn: updated });
    } catch (error: any) {
      console.error("[InsuranceBridgeController] finalizeLmn error:", error);
      res.status(500).json({ success: false, message: error.message ?? "Failed to finalize LMN" });
    }
  }

  /**
   * Shared gate for LMN endpoints: authenticated, member of institute,
   * institute has insurance bridge enabled, and the student is enrolled in
   * this institute (v1 owning-institute-only constraint).
   */
  private async lmnGate(
    userId: string,
    instituteId: string,
    studentId: string,
  ): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
    if (!instituteId || !studentId) {
      return { ok: false, status: 400, message: "instituteId and studentId are required" };
    }
    const isMember = await instituteRepository.isUserMemberOfInstitute(instituteId, userId);
    if (!isMember) {
      return { ok: false, status: 403, message: "Not a member of this institute" };
    }
    const { permissions } = await licenseService.getInstituteLicenseInfo(instituteId);
    if (!permissions.insuranceBridgeEnabled) {
      return { ok: false, status: 403, message: "Insurance Bridge is not enabled for this institute's license" };
    }
    const enrolled = await instituteService.isStudentInInstitute(instituteId, studentId);
    if (!enrolled) {
      return { ok: false, status: 403, message: "Student is not enrolled in this institute" };
    }
    return { ok: true };
  }

  /**
   * GET /api/insurance/icd10?q=...&regime=us_cpt&limit=25
   *
   * Curated ICD-10 search for the picker. Auth-only (every authenticated user
   * may search the curated list — there's nothing PHI-bearing about the
   * dataset itself); regime filter narrows to codes flagged for that market.
   */
  async searchIcd(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Unauthorized" });
        return;
      }
      const q = (req.query.q as string | undefined) ?? "";
      const regime = (req.query.regime as string | undefined) || undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const codes = searchIcdCodes({ q, regime, limit });
      res.json({ success: true, codes });
    } catch (error: any) {
      console.error("[InsuranceBridgeController] searchIcd error:", error);
      res.status(500).json({ success: false, message: "ICD search failed" });
    }
  }

  /**
   * POST /api/insurance/activity/heartbeat
   * Body: { studentId?: string | null, instituteId?: string | null }
   *
   * Records an activity heartbeat for the authenticated user. Called every
   * ~15s by the client while the clinician is interacting. The server
   * extends the open interval or rolls a new one based on idle gap and
   * context change. No permission gate — heartbeats are universal; the
   * Insurance Bridge module is what consumes them.
   */
  async heartbeat(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Unauthorized" });
        return;
      }
      let studentId = ((req.body?.studentId as string | undefined) ?? null) || null;
      let instituteId = ((req.body?.instituteId as string | undefined) ?? null) || null;

      // Validate user-claimed scopes. We don't reject mismatches loudly —
      // dropping the bad scope and recording a context-less heartbeat is
      // graceful for legitimate clients that race a context switch, and
      // prevents cross-institute review-time spikes from a malicious member.
      if (instituteId) {
        const isMember = await instituteRepository.isUserMemberOfInstitute(instituteId, userId);
        if (!isMember) {
          instituteId = null;
          studentId = null;
        } else if (studentId) {
          const enrolled = await instituteService.isStudentInInstitute(instituteId, studentId);
          if (!enrolled) studentId = null;
        }
      } else if (studentId) {
        // studentId without an institute scope can't be authorized.
        studentId = null;
      }

      const intervalId = await recordHeartbeat({ userId, studentId, instituteId });
      res.json({ success: true, intervalId });
    } catch (error: any) {
      console.error("[InsuranceBridgeController] heartbeat error:", error);
      res.status(500).json({ success: false, message: "Failed to record heartbeat" });
    }
  }

  /**
   * POST /api/insurance/activity/close
   * Body: { tabClosed?: boolean }
   *
   * Closes the authenticated user's currently-open interval. Called via
   * `navigator.sendBeacon` from `pagehide`/`beforeunload`.
   */
  async closeActivity(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ success: false, message: "Unauthorized" });
        return;
      }
      const tabClosed = req.body?.tabClosed === true;
      await closeOpenInterval(userId, tabClosed);
      res.json({ success: true });
    } catch (error: any) {
      console.error("[InsuranceBridgeController] closeActivity error:", error);
      res.status(500).json({ success: false, message: "Failed to close activity" });
    }
  }
}

export const insuranceBridgeController = new InsuranceBridgeController();
