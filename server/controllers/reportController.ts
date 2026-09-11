/**
 * reportController.ts
 * 
 * Controller for medical records, functional reports, and educational reports.
 * Handles API endpoints and request/response processing.
 */

import type { Request, Response } from "express";
import { reportService } from "../services";
import { activityLogService } from "../services/activityLogService";
import { summarizeChanges, changeDetails } from "../services/activityChanges";
import { visibilityCtx } from "../services/sharing/clinicianCtx";
import { canWriteObject, type AccessCtx } from "../services/sharing/visibility";
import { requireConsentForResponse } from "../services/consent/consentGate";
import { type ShareableObjectType } from "@shared/schema";

/** `new{Record,Report}Id` in a revision's activity-log details — see ReportKind.responseKey. */
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The three report types differ ONLY in names — service methods, a couple of
 * labels, the shareable-object type, and the key each one uses in its JSON
 * response. Everything else in the 27 handlers below was the same code written
 * out three times (~1,450 lines of it), which is how the consent gate on
 * `finalize` came to live in three places instead of one.
 *
 * Collapsing them onto this table keeps the ROUTES and the RESPONSE SHAPES
 * exactly as they are — the client calls 17 distinct URLs across these types
 * and reads `record` from one and `report` from the others, so both stay
 * verbatim. What goes is the triplication, not the API.
 *
 * `responseKey` is deliberately part of the descriptor rather than normalised:
 * medical answers `{ record }` and the other two answer `{ report }`, and
 * "tidying" that would be a silent breaking change to every client call site.
 */
export interface ReportKind {
  /** Human label, lower case, for messages: "medical record". */
  label: string;
  /** Same, capitalised for the start of a sentence: "Medical record". */
  Label: string;
  /** `activity_logs.subject_type1` and the shareable-object type. */
  objectType: "medical_record" | "functional_report" | "educational_report";
  /** The key this type has always used in its JSON body. Client-visible. */
  responseKey: "record" | "report";
  /** The `reportType` string `verifyReportAccess` expects — same as this kind's own map key. */
  verifyKind: "medical" | "functional" | "educational";
  /** List for a student. Signature is uniform across all three services. */
  list: (studentId: string, ctx?: AccessCtx) => Promise<any[]>;
  /**
   * The "current" (non-archived) row for a student. Medical's service method
   * ALSO takes `instituteId` (a student may have one current record per
   * institute); functional/educational do not, so their closures ignore it.
   * That is a real service-layer asymmetry, papered over here the same way
   * `getById` already papers over the `record`/`report` key split.
   */
  getCurrent: (studentId: string, instituteId: string | undefined, ctx?: AccessCtx) => Promise<any>;
  /** Archived rows for a student. Same medical-only `instituteId` asymmetry as `getCurrent`. */
  getArchived: (studentId: string, instituteId: string | undefined, ctx?: AccessCtx) => Promise<any[]>;
  /** Normalises the service's `{ hasAccess, record }` / `{ hasAccess, report }`. */
  getById: (id: string, userId: string, ctx?: AccessCtx) => Promise<{ hasAccess: boolean; row: any }>;
  create: (data: any) => Promise<any>;
  update: (id: string, updates: any) => Promise<any>;
  finalize: (id: string) => Promise<any>;
  createRevision: (id: string, userId: string) => Promise<any>;
  remove: (id: string) => Promise<boolean>;
}

export const REPORT_KINDS: Record<"medical" | "functional" | "educational", ReportKind> = {
  medical: {
    label: "medical record",
    Label: "Medical record",
    objectType: "medical_record",
    responseKey: "record",
    verifyKind: "medical",
    list: (studentId, ctx) => reportService.getMedicalRecordsByStudentId(studentId, ctx),
    getCurrent: (studentId, instituteId, ctx) =>
      reportService.getCurrentMedicalRecord(studentId, instituteId, ctx),
    getArchived: (studentId, instituteId, ctx) =>
      reportService.getArchivedMedicalRecords(studentId, instituteId, ctx),
    getById: async (id, userId, ctx) => {
      const r = await reportService.getMedicalRecordById(id, userId, ctx);
      return { hasAccess: r.hasAccess, row: (r as any).record };
    },
    create: (data) => reportService.createMedicalRecord(data),
    update: (id, updates) => reportService.updateMedicalRecord(id, updates),
    finalize: (id) => reportService.finalizeMedicalRecord(id),
    createRevision: (id, userId) => reportService.createMedicalRecordRevision(id, userId),
    remove: (id) => reportService.deleteMedicalRecord(id),
  },
  functional: {
    label: "functional report",
    Label: "Functional report",
    objectType: "functional_report",
    responseKey: "report",
    verifyKind: "functional",
    list: (studentId, ctx) => reportService.getFunctionalReportsByStudentId(studentId, ctx),
    getCurrent: (studentId, _instituteId, ctx) =>
      reportService.getCurrentFunctionalReport(studentId, ctx),
    getArchived: (studentId, _instituteId, ctx) =>
      reportService.getArchivedFunctionalReports(studentId, ctx),
    getById: async (id, userId, ctx) => {
      const r = await reportService.getFunctionalReportById(id, userId, ctx);
      return { hasAccess: r.hasAccess, row: (r as any).report };
    },
    create: (data) => reportService.createFunctionalReport(data),
    update: (id, updates) => reportService.updateFunctionalReport(id, updates),
    finalize: (id) => reportService.finalizeFunctionalReport(id),
    createRevision: (id, userId) => reportService.createFunctionalReportRevision(id, userId),
    remove: (id) => reportService.deleteFunctionalReport(id),
  },
  educational: {
    label: "educational report",
    Label: "Educational report",
    objectType: "educational_report",
    responseKey: "report",
    verifyKind: "educational",
    list: (studentId, ctx) => reportService.getEducationalReportsByStudentId(studentId, ctx),
    getCurrent: (studentId, _instituteId, ctx) =>
      reportService.getCurrentEducationalReport(studentId, ctx),
    getArchived: (studentId, _instituteId, ctx) =>
      reportService.getArchivedEducationalReports(studentId, ctx),
    getById: async (id, userId, ctx) => {
      const r = await reportService.getEducationalReportById(id, userId, ctx);
      return { hasAccess: r.hasAccess, row: (r as any).report };
    },
    create: (data) => reportService.createEducationalReport(data),
    update: (id, updates) => reportService.updateEducationalReport(id, updates),
    finalize: (id) => reportService.finalizeEducationalReport(id),
    createRevision: (id, userId) => reportService.createEducationalReportRevision(id, userId),
    remove: (id) => reportService.deleteEducationalReport(id),
  },
};

export class ReportController {
  /**
   * Cross-institute write guard. Records can be read across institutes via
   * shares; writes additionally require either ownership or a `permission='write'`
   * share covering the object. Sends 403 and returns false on rejection.
   *
   * Student principal (family-institute escalation) and admin principals always
   * pass. Institute principals pass when they own the record OR when
   * `canWriteObject` finds an active write-capable share.
   */
  private async requireOwningInstitute(
    req: Request,
    res: Response,
    record: { id: string; instituteId: string | null; studentId: string },
    subjectLabel: string,
    objectType: ShareableObjectType,
  ): Promise<boolean> {
    const ctxResult = await visibilityCtx(req, res, record.studentId);
    // Refused (the caller named an institute they are not a member of) — the
    // 403 is already sent. This gate used to read that state as `undefined` and
    // `if (!ctx) return true`, i.e. the cross-institute WRITE gate OPENED for a
    // caller asserting an institute context they did not hold.
    if (!ctxResult.ok) return false;
    const ctx = ctxResult.ctx;
    // No institute selected, or a student/admin principal: this gate does not
    // apply and the caller's own report-access check governs.
    if (!ctx || ctx.kind !== "institute") return true;

    const allowed = await canWriteObject(
      ctx,
      objectType,
      record.id,
      record.studentId,
      record.instituteId,
    );
    if (!allowed) {
      res.status(403).json({
        success: false,
        message: `Cannot modify a ${subjectLabel} owned by another institute`,
      });
      return false;
    }
    return true;
  }

  // ==========================================================================
  // GENERIC HANDLERS — one implementation per verb, parameterised by ReportKind.
  // See the ReportKind doc comment above for why responseKey stays verbatim.
  // ==========================================================================

  /** `getXs` (list) for all three report types. */
  private async getReports(req: Request, res: Response, kind: ReportKind): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;
      const instituteId = req.query.instituteId as string | undefined;

      const access = await reportService.verifyReportAccess(
        studentId,
        currentUser.id,
        kind.verifyKind,
        instituteId,
      );

      if (!access.hasAccess) {
        res.status(403).json({
          success: false,
          message: `Access denied to ${kind.label}s`,
        });
        return;
      }

      const ctxResult = await visibilityCtx(req, res, studentId);
      if (!ctxResult.ok) return;

      const ctx = ctxResult.ctx;
      const rows = await kind.list(studentId, ctx);
      res.json({ success: true, [`${kind.responseKey}s`]: rows });
    } catch (error: any) {
      console.error(`Error fetching ${kind.label}s:`, error);
      res.status(500).json({
        success: false,
        message: `Failed to fetch ${kind.label}s`,
      });
    }
  }

  /** `getCurrentX` for all three report types. */
  private async getCurrentReport(req: Request, res: Response, kind: ReportKind): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;
      const instituteId = req.query.instituteId as string | undefined;

      const access = await reportService.verifyReportAccess(
        studentId,
        currentUser.id,
        kind.verifyKind,
        instituteId,
      );

      if (!access.hasAccess) {
        res.status(403).json({
          success: false,
          message: `Access denied to ${kind.label}s`,
        });
        return;
      }

      const ctxResult = await visibilityCtx(req, res, studentId);
      if (!ctxResult.ok) return;

      const ctx = ctxResult.ctx;
      const row = await kind.getCurrent(studentId, instituteId, ctx);

      if (!row) {
        res.status(404).json({
          success: false,
          message: `No current ${kind.label} found`,
        });
        return;
      }

      res.json({ success: true, [kind.responseKey]: row });
    } catch (error: any) {
      console.error(`Error fetching current ${kind.label}:`, error);
      res.status(500).json({
        success: false,
        message: `Failed to fetch ${kind.label}`,
      });
    }
  }

  /** `getArchivedXs` for all three report types. */
  private async getArchivedReports(req: Request, res: Response, kind: ReportKind): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;
      const instituteId = req.query.instituteId as string | undefined;

      const access = await reportService.verifyReportAccess(
        studentId,
        currentUser.id,
        kind.verifyKind,
        instituteId,
      );

      if (!access.hasAccess) {
        res.status(403).json({
          success: false,
          message: `Access denied to ${kind.label}s`,
        });
        return;
      }

      const ctxResult = await visibilityCtx(req, res, studentId);
      if (!ctxResult.ok) return;

      const ctx = ctxResult.ctx;
      const rows = await kind.getArchived(studentId, instituteId, ctx);
      res.json({ success: true, [`${kind.responseKey}s`]: rows });
    } catch (error: any) {
      console.error(`Error fetching archived ${kind.label}s:`, error);
      res.status(500).json({
        success: false,
        message: `Failed to fetch archived ${kind.label}s`,
      });
    }
  }

  /**
   * `getXById` for all three report types. Two-step: resolve `studentId` via
   * a no-ctx fetch so family-institute escalation can fire on the second pass
   * with the proper ctx.
   */
  private async getReportById(req: Request, res: Response, kind: ReportKind): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const baseline = await kind.getById(id, currentUser.id);
      if (!baseline.row) {
        res.status(baseline.hasAccess ? 404 : 403).json({
          success: false,
          message: baseline.hasAccess ? `${kind.Label} not found` : "Access denied",
        });
        return;
      }

      const ctxResult = await visibilityCtx(req, res, baseline.row.studentId);
      if (!ctxResult.ok) return;

      const ctx = ctxResult.ctx;
      const result = ctx ? await kind.getById(id, currentUser.id, ctx) : baseline;

      if (!result.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied",
        });
        return;
      }

      if (!result.row) {
        res.status(404).json({
          success: false,
          message: `${kind.Label} not found`,
        });
        return;
      }

      res.json({ success: true, [kind.responseKey]: result.row });
      activityLogService.log({
        instituteId: (result.row as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "view",
        subjectType1: kind.objectType,
        // Name the student too: once the record is hard-deleted, an audit row
        // that only names the record id resolves to nothing.
        subjectType2: "student",
        subjectId1: id,
        subjectId2: (result.row as any).studentId ?? null,
      });
    } catch (error: any) {
      console.error(`Error fetching ${kind.label}:`, error);
      res.status(500).json({
        success: false,
        message: `Failed to fetch ${kind.label}`,
      });
    }
  }

  /**
   * `createX` for all three report types.
   *
   * Ownership of a new row is forced to the caller's selected institute. For
   * student-principal callers (family-institute escalation), keep whatever
   * the body specified — they may legitimately create rows owned by their
   * family institute or null.
   */
  private async createReport(req: Request, res: Response, kind: ReportKind): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;
      const instituteId = req.query.instituteId as string | undefined;

      const access = await reportService.verifyReportAccess(
        studentId,
        currentUser.id,
        kind.verifyKind,
        instituteId,
      );

      if (!access.hasAccess) {
        res.status(403).json({
          success: false,
          message: `Access denied to create ${kind.label}s`,
        });
        return;
      }

      const ctxResult = await visibilityCtx(req, res, studentId);
      if (!ctxResult.ok) return;
      const ctx = ctxResult.ctx;
      const ownedInstituteId =
        ctx?.kind === "institute" ? ctx.instituteId : (req.body.instituteId ?? null);

      const data = {
        ...req.body,
        studentId,
        userId: currentUser.id,
        status: "draft",
        instituteId: ownedInstituteId,
      };

      const row = await kind.create(data);
      res.json({
        success: true,
        message: `${kind.Label} created successfully`,
        [kind.responseKey]: row,
      });
      activityLogService.log({
        instituteId: ownedInstituteId,
        userId: currentUser.id,
        eventType: "create",
        subjectType1: kind.objectType,
        subjectId1: (row as any).id ?? null,
      });
    } catch (error: any) {
      console.error(`Error creating ${kind.label}:`, error);
      res.status(500).json({
        success: false,
        message: error.message || `Failed to create ${kind.label}`,
      });
    }
  }

  /** `updateX` for all three report types. */
  private async updateReport(req: Request, res: Response, kind: ReportKind): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const result = await kind.getById(id, currentUser.id);

      if (!result.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied",
        });
        return;
      }

      if (!result.row) {
        res.status(404).json({
          success: false,
          message: `${kind.Label} not found`,
        });
        return;
      }

      if (!(await this.requireOwningInstitute(req, res, result.row, kind.label, kind.objectType))) {
        return;
      }

      const updates = req.body;
      const updated = await kind.update(id, updates);

      if (!updated) {
        res.status(400).json({
          success: false,
          message: `Failed to update ${kind.label}`,
        });
        return;
      }

      res.json({
        success: true,
        message: `${kind.Label} updated successfully`,
        [kind.responseKey]: updated,
      });
      activityLogService.log({
        instituteId: (updated as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "update",
        subjectType1: kind.objectType,
        subjectId1: id,
        details: changeDetails(
          summarizeChanges(`${kind.objectType}s`, result.row as any, updates as any),
        ),
      });
    } catch (error: any) {
      console.error(`Error updating ${kind.label}:`, error);
      res.status(500).json({
        success: false,
        message: error.message || `Failed to update ${kind.label}`,
      });
    }
  }

  /** `createXRevision` for all three report types. */
  private async createReportRevision(req: Request, res: Response, kind: ReportKind): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const result = await kind.getById(id, currentUser.id);

      if (!result.hasAccess || !result.row) {
        res.status(403).json({
          success: false,
          message: `Access denied or ${kind.responseKey} not found`,
        });
        return;
      }

      if (!(await this.requireOwningInstitute(req, res, result.row, kind.label, kind.objectType))) {
        return;
      }

      const newRow = await kind.createRevision(id, currentUser.id);

      res.json({
        success: true,
        message: `${kind.Label} revision created successfully`,
        [kind.responseKey]: newRow,
      });
      activityLogService.log({
        instituteId: (newRow as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "revision",
        subjectType1: kind.objectType,
        subjectId1: id,
        details: { [`new${capitalize(kind.responseKey)}Id`]: (newRow as any).id ?? null },
      });
    } catch (error: any) {
      console.error(`Error creating ${kind.label} revision:`, error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to create revision",
      });
    }
  }

  /** `deleteX` (draft-only) for all three report types. */
  private async deleteReport(req: Request, res: Response, kind: ReportKind): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const result = await kind.getById(id, currentUser.id);

      if (!result.hasAccess || !result.row) {
        res.status(403).json({
          success: false,
          message: `Access denied or ${kind.responseKey} not found`,
        });
        return;
      }

      if (!(await this.requireOwningInstitute(req, res, result.row, kind.label, kind.objectType))) {
        return;
      }

      const deleted = await kind.remove(id);

      if (!deleted) {
        res.status(400).json({
          success: false,
          message: `Only draft ${kind.responseKey}s can be deleted`,
        });
        return;
      }

      res.json({
        success: true,
        message: `${kind.Label} deleted successfully`,
      });
      activityLogService.log({
        instituteId: (result.row as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "delete",
        subjectType1: kind.objectType,
        subjectId1: id,
      });
    } catch (error: any) {
      console.error(`Error deleting ${kind.label}:`, error);
      res.status(500).json({
        success: false,
        message: `Failed to delete ${kind.label}`,
      });
    }
  }

  // ==========================================================================
  // MEDICAL RECORD ENDPOINTS
  // ==========================================================================

  /**
   * GET /api/students/:studentId/reports/medical
   * Get all medical records for a student
   */
  async getMedicalRecords(req: Request, res: Response): Promise<void> {
    return this.getReports(req, res, REPORT_KINDS.medical);
  }

  /**
   * GET /api/students/:studentId/reports/medical/current
   * Get the current medical record for a student
   */
  async getCurrentMedicalRecord(req: Request, res: Response): Promise<void> {
    return this.getCurrentReport(req, res, REPORT_KINDS.medical);
  }

  /**
   * GET /api/students/:studentId/reports/medical/archived
   * Get archived medical records for a student
   */
  async getArchivedMedicalRecords(req: Request, res: Response): Promise<void> {
    return this.getArchivedReports(req, res, REPORT_KINDS.medical);
  }

  /**
   * GET /api/medical-records/:id
   * Get a specific medical record by ID
   */
  async getMedicalRecordById(req: Request, res: Response): Promise<void> {
    return this.getReportById(req, res, REPORT_KINDS.medical);
  }

  /**
   * POST /api/students/:studentId/reports/medical
   * Create a new medical record
   */
  async createMedicalRecord(req: Request, res: Response): Promise<void> {
    return this.createReport(req, res, REPORT_KINDS.medical);
  }

  /**
   * PATCH /api/medical-records/:id
   * Update a medical record
   */
  async updateMedicalRecord(req: Request, res: Response): Promise<void> {
    return this.updateReport(req, res, REPORT_KINDS.medical);
  }

  /**
   * POST /api/medical-records/:id/finalize
   * Finalize a medical record
   */
  /**
   * `finalize` for all three report types.
   *
   * This verb is why the collapse matters: it carries the cross-institute
   * ownership gate AND `requireConsentForResponse` (finalising is the
   * consent-gated transition — drafts are deliberately open, see
   * docs/student-consent-implementation.md §7.4). That pair used to be written
   * out three times, so a change to the consent rule had three places to miss.
   *
   * Every message is derived from the descriptor, so the responses stay
   * byte-identical to the three handlers this replaces — including the
   * "record" / "report" split the client depends on.
   */
  private async finalizeReport(req: Request, res: Response, kind: ReportKind): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const { hasAccess, row } = await kind.getById(id, currentUser.id);

      if (!hasAccess || !row) {
        res.status(403).json({
          success: false,
          message: `Access denied or ${kind.responseKey} not found`,
        });
        return;
      }

      if (!(await this.requireOwningInstitute(req, res, row, kind.label, kind.objectType))) {
        return;
      }

      if (!(await requireConsentForResponse(req, res, (row as any).studentId))) {
        return;
      }

      const finalized = await kind.finalize(id);

      res.json({
        success: true,
        message: `${kind.Label} finalized successfully`,
        [kind.responseKey]: finalized,
      });
      activityLogService.log({
        instituteId: (finalized as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "finalize",
        subjectType1: kind.objectType,
        subjectId1: id,
      });
    } catch (error: any) {
      console.error(`Error finalizing ${kind.label}:`, error);
      res.status(500).json({
        success: false,
        message: error.message || `Failed to finalize ${kind.label}`,
      });
    }
  }

  async finalizeMedicalRecord(req: Request, res: Response): Promise<void> {
    return this.finalizeReport(req, res, REPORT_KINDS.medical);
  }

  /**
   * POST /api/medical-records/:id/revision
   * Create a new revision from a finalized medical record
   */
  async createMedicalRecordRevision(req: Request, res: Response): Promise<void> {
    return this.createReportRevision(req, res, REPORT_KINDS.medical);
  }

  /**
   * DELETE /api/medical-records/:id
   * Delete a draft medical record
   */
  async deleteMedicalRecord(req: Request, res: Response): Promise<void> {
    return this.deleteReport(req, res, REPORT_KINDS.medical);
  }

  // ==========================================================================
  // FUNCTIONAL REPORT ENDPOINTS
  // ==========================================================================

  /**
   * GET /api/students/:studentId/reports/functional
   * Get all functional reports for a student
   */
  async getFunctionalReports(req: Request, res: Response): Promise<void> {
    return this.getReports(req, res, REPORT_KINDS.functional);
  }

  /**
   * GET /api/students/:studentId/reports/functional/current
   * Get the current functional report for a student
   */
  async getCurrentFunctionalReport(req: Request, res: Response): Promise<void> {
    return this.getCurrentReport(req, res, REPORT_KINDS.functional);
  }

  /**
   * GET /api/students/:studentId/reports/functional/archived
   * Get archived functional reports for a student
   */
  async getArchivedFunctionalReports(req: Request, res: Response): Promise<void> {
    return this.getArchivedReports(req, res, REPORT_KINDS.functional);
  }

  /**
   * GET /api/functional-reports/:id
   * Get a specific functional report by ID
   */
  async getFunctionalReportById(req: Request, res: Response): Promise<void> {
    return this.getReportById(req, res, REPORT_KINDS.functional);
  }

  /**
   * POST /api/students/:studentId/reports/functional
   * Create a new functional report
   */
  async createFunctionalReport(req: Request, res: Response): Promise<void> {
    return this.createReport(req, res, REPORT_KINDS.functional);
  }

  /**
   * PATCH /api/functional-reports/:id
   * Update a functional report
   */
  async updateFunctionalReport(req: Request, res: Response): Promise<void> {
    return this.updateReport(req, res, REPORT_KINDS.functional);
  }

  /**
   * POST /api/functional-reports/:id/finalize
   * Finalize a functional report
   */
  async finalizeFunctionalReport(req: Request, res: Response): Promise<void> {
    return this.finalizeReport(req, res, REPORT_KINDS.functional);
  }

  /**
   * POST /api/functional-reports/:id/revision
   * Create a new revision from a finalized functional report
   */
  async createFunctionalReportRevision(req: Request, res: Response): Promise<void> {
    return this.createReportRevision(req, res, REPORT_KINDS.functional);
  }

  /**
   * DELETE /api/functional-reports/:id
   * Delete a draft functional report
   */
  async deleteFunctionalReport(req: Request, res: Response): Promise<void> {
    return this.deleteReport(req, res, REPORT_KINDS.functional);
  }

  // ==========================================================================
  // EDUCATIONAL REPORT ENDPOINTS
  // ==========================================================================

  /**
   * GET /api/students/:studentId/reports/educational
   * Get all educational reports for a student
   */
  async getEducationalReports(req: Request, res: Response): Promise<void> {
    return this.getReports(req, res, REPORT_KINDS.educational);
  }

  /**
   * GET /api/students/:studentId/reports/educational/current
   * Get the current educational report for a student
   */
  async getCurrentEducationalReport(req: Request, res: Response): Promise<void> {
    return this.getCurrentReport(req, res, REPORT_KINDS.educational);
  }

  /**
   * GET /api/students/:studentId/reports/educational/archived
   * Get archived educational reports for a student
   */
  async getArchivedEducationalReports(req: Request, res: Response): Promise<void> {
    return this.getArchivedReports(req, res, REPORT_KINDS.educational);
  }

  /**
   * GET /api/educational-reports/:id
   * Get a specific educational report by ID
   */
  async getEducationalReportById(req: Request, res: Response): Promise<void> {
    return this.getReportById(req, res, REPORT_KINDS.educational);
  }

  /**
   * POST /api/students/:studentId/reports/educational
   * Create a new educational report
   */
  async createEducationalReport(req: Request, res: Response): Promise<void> {
    return this.createReport(req, res, REPORT_KINDS.educational);
  }

  /**
   * PATCH /api/educational-reports/:id
   * Update an educational report
   */
  async updateEducationalReport(req: Request, res: Response): Promise<void> {
    return this.updateReport(req, res, REPORT_KINDS.educational);
  }

  /**
   * POST /api/educational-reports/:id/finalize
   * Finalize an educational report
   */
  async finalizeEducationalReport(req: Request, res: Response): Promise<void> {
    return this.finalizeReport(req, res, REPORT_KINDS.educational);
  }

  /**
   * POST /api/educational-reports/:id/revision
   * Create a new revision from a finalized educational report
   */
  async createEducationalReportRevision(req: Request, res: Response): Promise<void> {
    return this.createReportRevision(req, res, REPORT_KINDS.educational);
  }

  /**
   * DELETE /api/educational-reports/:id
   * Delete a draft educational report
   */
  async deleteEducationalReport(req: Request, res: Response): Promise<void> {
    return this.deleteReport(req, res, REPORT_KINDS.educational);
  }

  // ==========================================================================
  // COMPOSITE ENDPOINTS
  // ==========================================================================

  /**
   * GET /api/students/:studentId/reports
   * Get all reports for a student
   */
  async getAllReports(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;

      const instituteId = req.query.instituteId as string | undefined;
      const ctxResult = await visibilityCtx(req, res, studentId);
      if (!ctxResult.ok) return;
      const ctx = ctxResult.ctx;
      const result = await reportService.getAllReportsForStudent(
        studentId,
        currentUser.id,
        instituteId,
        ctx,
      );

      res.json({
        success: true,
        ...result,
      });
    } catch (error: any) {
      console.error("Error fetching all reports:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch reports",
      });
    }
  }

  /**
   * GET /api/students/:studentId/reports/current
   * Get current (non-archived) reports for a student
   */
  async getCurrentReports(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;
      const instituteId = req.query.instituteId as string | undefined;

      const ctxResult = await visibilityCtx(req, res, studentId);

      if (!ctxResult.ok) return;

      const ctx = ctxResult.ctx;
      const result = await reportService.getCurrentReportsForStudent(
        studentId,
        currentUser.id,
        instituteId,
        ctx,
      );

      res.json({
        success: true,
        ...result,
      });
    } catch (error: any) {
      console.error("Error fetching current reports:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch current reports",
      });
    }
  }
}

export const reportController = new ReportController();
