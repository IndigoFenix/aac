/**
 * reportController.ts
 * 
 * Controller for medical records, functional reports, and educational reports.
 * Handles API endpoints and request/response processing.
 */

import type { Request, Response } from "express";
import { reportService } from "../services";
import { activityLogService } from "../services/activityLogService";
import { buildClinicianCtx } from "../services/sharing/clinicianCtx";
import { canWriteObject } from "../services/sharing/visibility";
import { requireConsentForResponse } from "../services/consent/consentGate";
import {
  type InsertMedicalRecord,
  type UpdateMedicalRecord,
  type InsertFunctionalReport,
  type UpdateFunctionalReport,
  type InsertEducationalReport,
  type UpdateEducationalReport,
  type ShareableObjectType,
} from "@shared/schema";

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
    const ctx = await buildClinicianCtx(req, record.studentId);
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
  // MEDICAL RECORD ENDPOINTS
  // ==========================================================================

  /**
   * GET /api/students/:studentId/reports/medical
   * Get all medical records for a student
   */
  async getMedicalRecords(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;
      const instituteId = req.query.instituteId as string | undefined;

      const access = await reportService.verifyReportAccess(
        studentId,
        currentUser.id,
        "medical",
        instituteId
      );

      if (!access.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied to medical records",
        });
        return;
      }

      const ctx = await buildClinicianCtx(req, studentId);
      const records = await reportService.getMedicalRecordsByStudentId(studentId, ctx);
      res.json({ success: true, records });
    } catch (error: any) {
      console.error("Error fetching medical records:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch medical records",
      });
    }
  }

  /**
   * GET /api/students/:studentId/reports/medical/current
   * Get the current medical record for a student
   */
  async getCurrentMedicalRecord(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;
      const instituteId = req.query.instituteId as string | undefined;

      const access = await reportService.verifyReportAccess(
        studentId,
        currentUser.id,
        "medical",
        instituteId
      );

      if (!access.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied to medical records",
        });
        return;
      }

      const ctx = await buildClinicianCtx(req, studentId);
      const record = await reportService.getCurrentMedicalRecord(
        studentId,
        instituteId as string | undefined,
        ctx,
      );

      if (!record) {
        res.status(404).json({
          success: false,
          message: "No current medical record found",
        });
        return;
      }

      res.json({ success: true, record });
    } catch (error: any) {
      console.error("Error fetching current medical record:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch medical record",
      });
    }
  }

  /**
   * GET /api/students/:studentId/reports/medical/archived
   * Get archived medical records for a student
   */
  async getArchivedMedicalRecords(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;
      const instituteId = req.query.instituteId as string | undefined;

      const access = await reportService.verifyReportAccess(
        studentId,
        currentUser.id,
        "medical",
        instituteId
      );

      if (!access.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied to medical records",
        });
        return;
      }

      const ctx = await buildClinicianCtx(req, studentId);
      const records = await reportService.getArchivedMedicalRecords(
        studentId,
        instituteId as string | undefined,
        ctx,
      );

      res.json({ success: true, records });
    } catch (error: any) {
      console.error("Error fetching archived medical records:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch archived medical records",
      });
    }
  }

  /**
   * GET /api/medical-records/:id
   * Get a specific medical record by ID
   */
  async getMedicalRecordById(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      // Two-step: resolve studentId via no-ctx fetch so family-institute
      // escalation can fire on the second pass with the proper ctx.
      const baseline = await reportService.getMedicalRecordById(id, currentUser.id);
      if (!baseline.record) {
        res.status(baseline.hasAccess ? 404 : 403).json({
          success: false,
          message: baseline.hasAccess ? "Medical record not found" : "Access denied",
        });
        return;
      }

      const ctx = await buildClinicianCtx(req, baseline.record.studentId);
      const result = ctx
        ? await reportService.getMedicalRecordById(id, currentUser.id, ctx)
        : baseline;

      if (!result.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied",
        });
        return;
      }

      if (!result.record) {
        res.status(404).json({
          success: false,
          message: "Medical record not found",
        });
        return;
      }

      res.json({ success: true, record: result.record });
      activityLogService.log({
        instituteId: (result.record as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "view",
        subjectType1: "medical_record",
        subjectId1: id,
      });
    } catch (error: any) {
      console.error("Error fetching medical record:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch medical record",
      });
    }
  }

  /**
   * POST /api/students/:studentId/reports/medical
   * Create a new medical record
   */
  async createMedicalRecord(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;
      const instituteId = req.query.instituteId as string | undefined;

      const access = await reportService.verifyReportAccess(
        studentId,
        currentUser.id,
        "medical",
        instituteId
      );

      if (!access.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied to create medical records",
        });
        return;
      }

      // Force new-record ownership to the caller's selected institute. For
      // student-principal callers (family-institute escalation), keep whatever
      // the body specified — they may legitimately create records owned by
      // their family institute or null.
      const ctx = await buildClinicianCtx(req, studentId);
      const ownedInstituteId =
        ctx?.kind === "institute" ? ctx.instituteId : (req.body.instituteId ?? null);

      const data: InsertMedicalRecord = {
        ...req.body,
        studentId,
        userId: currentUser.id,
        status: "draft",
        instituteId: ownedInstituteId,
      };

      const record = await reportService.createMedicalRecord(data);
      res.json({
        success: true,
        message: "Medical record created successfully",
        record,
      });
      activityLogService.log({
        instituteId: ownedInstituteId,
        userId: currentUser.id,
        eventType: "create",
        subjectType1: "medical_record",
        subjectId1: (record as any).id ?? null,
      });
    } catch (error: any) {
      console.error("Error creating medical record:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to create medical record",
      });
    }
  }

  /**
   * PATCH /api/medical-records/:id
   * Update a medical record
   */
  async updateMedicalRecord(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const result = await reportService.getMedicalRecordById(id, currentUser.id);

      if (!result.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied",
        });
        return;
      }

      if (!result.record) {
        res.status(404).json({
          success: false,
          message: "Medical record not found",
        });
        return;
      }

      if (!(await this.requireOwningInstitute(req, res, result.record, "medical record", "medical_record"))) {
        return;
      }

      const updates: UpdateMedicalRecord = req.body;
      const updated = await reportService.updateMedicalRecord(id, updates);

      if (!updated) {
        res.status(400).json({
          success: false,
          message: "Failed to update medical record",
        });
        return;
      }

      res.json({
        success: true,
        message: "Medical record updated successfully",
        record: updated,
      });
      activityLogService.log({
        instituteId: (updated as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "update",
        subjectType1: "medical_record",
        subjectId1: id,
      });
    } catch (error: any) {
      console.error("Error updating medical record:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to update medical record",
      });
    }
  }

  /**
   * POST /api/medical-records/:id/finalize
   * Finalize a medical record
   */
  async finalizeMedicalRecord(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const result = await reportService.getMedicalRecordById(id, currentUser.id);

      if (!result.hasAccess || !result.record) {
        res.status(403).json({
          success: false,
          message: "Access denied or record not found",
        });
        return;
      }

      if (!(await this.requireOwningInstitute(req, res, result.record, "medical record", "medical_record"))) {
        return;
      }

      if (!(await requireConsentForResponse(req, res, (result.record as any).studentId))) {
        return;
      }

      const finalized = await reportService.finalizeMedicalRecord(id);

      res.json({
        success: true,
        message: "Medical record finalized successfully",
        record: finalized,
      });
      activityLogService.log({
        instituteId: (finalized as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "finalize",
        subjectType1: "medical_record",
        subjectId1: id,
      });
    } catch (error: any) {
      console.error("Error finalizing medical record:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to finalize medical record",
      });
    }
  }

  /**
   * POST /api/medical-records/:id/revision
   * Create a new revision from a finalized medical record
   */
  async createMedicalRecordRevision(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const result = await reportService.getMedicalRecordById(id, currentUser.id);

      if (!result.hasAccess || !result.record) {
        res.status(403).json({
          success: false,
          message: "Access denied or record not found",
        });
        return;
      }

      if (!(await this.requireOwningInstitute(req, res, result.record, "medical record", "medical_record"))) {
        return;
      }

      const newRecord = await reportService.createMedicalRecordRevision(
        id,
        currentUser.id
      );

      res.json({
        success: true,
        message: "Medical record revision created successfully",
        record: newRecord,
      });
      activityLogService.log({
        instituteId: (newRecord as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "revision",
        subjectType1: "medical_record",
        subjectId1: id,
        details: { newRecordId: (newRecord as any).id ?? null },
      });
    } catch (error: any) {
      console.error("Error creating medical record revision:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to create revision",
      });
    }
  }

  /**
   * DELETE /api/medical-records/:id
   * Delete a draft medical record
   */
  async deleteMedicalRecord(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const result = await reportService.getMedicalRecordById(id, currentUser.id);

      if (!result.hasAccess || !result.record) {
        res.status(403).json({
          success: false,
          message: "Access denied or record not found",
        });
        return;
      }

      if (!(await this.requireOwningInstitute(req, res, result.record, "medical record", "medical_record"))) {
        return;
      }

      const deleted = await reportService.deleteMedicalRecord(id);

      if (!deleted) {
        res.status(400).json({
          success: false,
          message: "Only draft records can be deleted",
        });
        return;
      }

      res.json({
        success: true,
        message: "Medical record deleted successfully",
      });
      activityLogService.log({
        instituteId: (result.record as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "delete",
        subjectType1: "medical_record",
        subjectId1: id,
      });
    } catch (error: any) {
      console.error("Error deleting medical record:", error);
      res.status(500).json({
        success: false,
        message: "Failed to delete medical record",
      });
    }
  }

  // ==========================================================================
  // FUNCTIONAL REPORT ENDPOINTS
  // ==========================================================================

  /**
   * GET /api/students/:studentId/reports/functional
   * Get all functional reports for a student
   */
  async getFunctionalReports(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;
      const instituteId = req.query.instituteId as string | undefined;

      const access = await reportService.verifyReportAccess(
        studentId,
        currentUser.id,
        "functional",
        instituteId
      );

      if (!access.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied to functional reports",
        });
        return;
      }

      const ctx = await buildClinicianCtx(req, studentId);
      const reports = await reportService.getFunctionalReportsByStudentId(studentId, ctx);
      res.json({ success: true, reports });
    } catch (error: any) {
      console.error("Error fetching functional reports:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch functional reports",
      });
    }
  }

  /**
   * GET /api/students/:studentId/reports/functional/current
   * Get the current functional report for a student
   */
  async getCurrentFunctionalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;
      const instituteId = req.query.instituteId as string | undefined;

      const access = await reportService.verifyReportAccess(
        studentId,
        currentUser.id,
        "functional",
        instituteId
      );

      if (!access.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied to functional reports",
        });
        return;
      }

      const ctx = await buildClinicianCtx(req, studentId);
      const report = await reportService.getCurrentFunctionalReport(studentId, ctx);

      if (!report) {
        res.status(404).json({
          success: false,
          message: "No current functional report found",
        });
        return;
      }

      res.json({ success: true, report });
    } catch (error: any) {
      console.error("Error fetching current functional report:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch functional report",
      });
    }
  }

  /**
   * GET /api/students/:studentId/reports/functional/archived
   * Get archived functional reports for a student
   */
  async getArchivedFunctionalReports(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;
      const instituteId = req.query.instituteId as string | undefined;

      const access = await reportService.verifyReportAccess(
        studentId,
        currentUser.id,
        "functional",
        instituteId
      );

      if (!access.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied to functional reports",
        });
        return;
      }

      const ctx = await buildClinicianCtx(req, studentId);
      const reports = await reportService.getArchivedFunctionalReports(studentId, ctx);
      res.json({ success: true, reports });
    } catch (error: any) {
      console.error("Error fetching archived functional reports:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch archived functional reports",
      });
    }
  }

  /**
   * GET /api/functional-reports/:id
   * Get a specific functional report by ID
   */
  async getFunctionalReportById(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const baseline = await reportService.getFunctionalReportById(id, currentUser.id);
      if (!baseline.report) {
        res.status(baseline.hasAccess ? 404 : 403).json({
          success: false,
          message: baseline.hasAccess ? "Functional report not found" : "Access denied",
        });
        return;
      }

      const ctx = await buildClinicianCtx(req, baseline.report.studentId);
      const result = ctx
        ? await reportService.getFunctionalReportById(id, currentUser.id, ctx)
        : baseline;

      if (!result.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied",
        });
        return;
      }

      if (!result.report) {
        res.status(404).json({
          success: false,
          message: "Functional report not found",
        });
        return;
      }

      res.json({ success: true, report: result.report });
      activityLogService.log({
        instituteId: (result.report as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "view",
        subjectType1: "functional_report",
        subjectId1: id,
      });
    } catch (error: any) {
      console.error("Error fetching functional report:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch functional report",
      });
    }
  }

  /**
   * POST /api/students/:studentId/reports/functional
   * Create a new functional report
   */
  async createFunctionalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;
      const instituteId = req.query.instituteId as string | undefined;

      const access = await reportService.verifyReportAccess(
        studentId,
        currentUser.id,
        "functional",
        instituteId
      );

      if (!access.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied to create functional reports",
        });
        return;
      }

      const ctx = await buildClinicianCtx(req, studentId);
      const ownedInstituteId =
        ctx?.kind === "institute" ? ctx.instituteId : (req.body.instituteId ?? null);

      const data: InsertFunctionalReport = {
        ...req.body,
        studentId,
        userId: currentUser.id,
        status: "draft",
        instituteId: ownedInstituteId,
      };

      const report = await reportService.createFunctionalReport(data);
      res.json({
        success: true,
        message: "Functional report created successfully",
        report,
      });
      activityLogService.log({
        instituteId: ownedInstituteId,
        userId: currentUser.id,
        eventType: "create",
        subjectType1: "functional_report",
        subjectId1: (report as any).id ?? null,
      });
    } catch (error: any) {
      console.error("Error creating functional report:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to create functional report",
      });
    }
  }

  /**
   * PATCH /api/functional-reports/:id
   * Update a functional report
   */
  async updateFunctionalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const result = await reportService.getFunctionalReportById(id, currentUser.id);

      if (!result.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied",
        });
        return;
      }

      if (!result.report) {
        res.status(404).json({
          success: false,
          message: "Functional report not found",
        });
        return;
      }

      if (!(await this.requireOwningInstitute(req, res, result.report, "functional report", "functional_report"))) {
        return;
      }

      const updates: UpdateFunctionalReport = req.body;
      const updated = await reportService.updateFunctionalReport(id, updates);

      if (!updated) {
        res.status(400).json({
          success: false,
          message: "Failed to update functional report",
        });
        return;
      }

      res.json({
        success: true,
        message: "Functional report updated successfully",
        report: updated,
      });
      activityLogService.log({
        instituteId: (updated as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "update",
        subjectType1: "functional_report",
        subjectId1: id,
      });
    } catch (error: any) {
      console.error("Error updating functional report:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to update functional report",
      });
    }
  }

  /**
   * POST /api/functional-reports/:id/finalize
   * Finalize a functional report
   */
  async finalizeFunctionalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const result = await reportService.getFunctionalReportById(id, currentUser.id);

      if (!result.hasAccess || !result.report) {
        res.status(403).json({
          success: false,
          message: "Access denied or report not found",
        });
        return;
      }

      if (!(await this.requireOwningInstitute(req, res, result.report, "functional report", "functional_report"))) {
        return;
      }

      if (!(await requireConsentForResponse(req, res, (result.report as any).studentId))) {
        return;
      }

      const finalized = await reportService.finalizeFunctionalReport(id);

      res.json({
        success: true,
        message: "Functional report finalized successfully",
        report: finalized,
      });
      activityLogService.log({
        instituteId: (finalized as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "finalize",
        subjectType1: "functional_report",
        subjectId1: id,
      });
    } catch (error: any) {
      console.error("Error finalizing functional report:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to finalize functional report",
      });
    }
  }

  /**
   * POST /api/functional-reports/:id/revision
   * Create a new revision from a finalized functional report
   */
  async createFunctionalReportRevision(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const result = await reportService.getFunctionalReportById(id, currentUser.id);

      if (!result.hasAccess || !result.report) {
        res.status(403).json({
          success: false,
          message: "Access denied or report not found",
        });
        return;
      }

      if (!(await this.requireOwningInstitute(req, res, result.report, "functional report", "functional_report"))) {
        return;
      }

      const newReport = await reportService.createFunctionalReportRevision(
        id,
        currentUser.id
      );

      res.json({
        success: true,
        message: "Functional report revision created successfully",
        report: newReport,
      });
      activityLogService.log({
        instituteId: (newReport as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "revision",
        subjectType1: "functional_report",
        subjectId1: id,
        details: { newReportId: (newReport as any).id ?? null },
      });
    } catch (error: any) {
      console.error("Error creating functional report revision:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to create revision",
      });
    }
  }

  /**
   * DELETE /api/functional-reports/:id
   * Delete a draft functional report
   */
  async deleteFunctionalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const result = await reportService.getFunctionalReportById(id, currentUser.id);

      if (!result.hasAccess || !result.report) {
        res.status(403).json({
          success: false,
          message: "Access denied or report not found",
        });
        return;
      }

      if (!(await this.requireOwningInstitute(req, res, result.report, "functional report", "functional_report"))) {
        return;
      }

      const deleted = await reportService.deleteFunctionalReport(id);

      if (!deleted) {
        res.status(400).json({
          success: false,
          message: "Only draft reports can be deleted",
        });
        return;
      }

      res.json({
        success: true,
        message: "Functional report deleted successfully",
      });
      activityLogService.log({
        instituteId: (result.report as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "delete",
        subjectType1: "functional_report",
        subjectId1: id,
      });
    } catch (error: any) {
      console.error("Error deleting functional report:", error);
      res.status(500).json({
        success: false,
        message: "Failed to delete functional report",
      });
    }
  }

  // ==========================================================================
  // EDUCATIONAL REPORT ENDPOINTS
  // ==========================================================================

  /**
   * GET /api/students/:studentId/reports/educational
   * Get all educational reports for a student
   */
  async getEducationalReports(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;
      const instituteId = req.query.instituteId as string | undefined;

      const access = await reportService.verifyReportAccess(
        studentId,
        currentUser.id,
        "educational",
        instituteId
      );

      if (!access.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied to educational reports",
        });
        return;
      }

      const ctx = await buildClinicianCtx(req, studentId);
      const reports = await reportService.getEducationalReportsByStudentId(studentId, ctx);
      res.json({ success: true, reports });
    } catch (error: any) {
      console.error("Error fetching educational reports:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch educational reports",
      });
    }
  }

  /**
   * GET /api/students/:studentId/reports/educational/current
   * Get the current educational report for a student
   */
  async getCurrentEducationalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;
      const instituteId = req.query.instituteId as string | undefined;

      const access = await reportService.verifyReportAccess(
        studentId,
        currentUser.id,
        "educational",
        instituteId
      );

      if (!access.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied to educational reports",
        });
        return;
      }

      const ctx = await buildClinicianCtx(req, studentId);
      const report = await reportService.getCurrentEducationalReport(studentId, ctx);

      if (!report) {
        res.status(404).json({
          success: false,
          message: "No current educational report found",
        });
        return;
      }

      res.json({ success: true, report });
    } catch (error: any) {
      console.error("Error fetching current educational report:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch educational report",
      });
    }
  }

  /**
   * GET /api/students/:studentId/reports/educational/archived
   * Get archived educational reports for a student
   */
  async getArchivedEducationalReports(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;
      const instituteId = req.query.instituteId as string | undefined;

      const access = await reportService.verifyReportAccess(
        studentId,
        currentUser.id,
        "educational",
        instituteId
      );

      if (!access.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied to educational reports",
        });
        return;
      }

      const ctx = await buildClinicianCtx(req, studentId);
      const reports = await reportService.getArchivedEducationalReports(studentId, ctx);
      res.json({ success: true, reports });
    } catch (error: any) {
      console.error("Error fetching archived educational reports:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch archived educational reports",
      });
    }
  }

  /**
   * GET /api/educational-reports/:id
   * Get a specific educational report by ID
   */
  async getEducationalReportById(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const baseline = await reportService.getEducationalReportById(id, currentUser.id);
      if (!baseline.report) {
        res.status(baseline.hasAccess ? 404 : 403).json({
          success: false,
          message: baseline.hasAccess ? "Educational report not found" : "Access denied",
        });
        return;
      }

      const ctx = await buildClinicianCtx(req, baseline.report.studentId);
      const result = ctx
        ? await reportService.getEducationalReportById(id, currentUser.id, ctx)
        : baseline;

      if (!result.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied",
        });
        return;
      }

      if (!result.report) {
        res.status(404).json({
          success: false,
          message: "Educational report not found",
        });
        return;
      }

      res.json({ success: true, report: result.report });
      activityLogService.log({
        instituteId: (result.report as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "view",
        subjectType1: "educational_report",
        subjectId1: id,
      });
    } catch (error: any) {
      console.error("Error fetching educational report:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch educational report",
      });
    }
  }

  /**
   * POST /api/students/:studentId/reports/educational
   * Create a new educational report
   */
  async createEducationalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;
      const instituteId = req.query.instituteId as string | undefined;

      const access = await reportService.verifyReportAccess(
        studentId,
        currentUser.id,
        "educational",
        instituteId
      );

      if (!access.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied to create educational reports",
        });
        return;
      }

      const ctx = await buildClinicianCtx(req, studentId);
      const ownedInstituteId =
        ctx?.kind === "institute" ? ctx.instituteId : (req.body.instituteId ?? null);

      const data: InsertEducationalReport = {
        ...req.body,
        studentId,
        userId: currentUser.id,
        status: "draft",
        instituteId: ownedInstituteId,
      };

      const report = await reportService.createEducationalReport(data);
      res.json({
        success: true,
        message: "Educational report created successfully",
        report,
      });
      activityLogService.log({
        instituteId: ownedInstituteId,
        userId: currentUser.id,
        eventType: "create",
        subjectType1: "educational_report",
        subjectId1: (report as any).id ?? null,
      });
    } catch (error: any) {
      console.error("Error creating educational report:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to create educational report",
      });
    }
  }

  /**
   * PATCH /api/educational-reports/:id
   * Update an educational report
   */
  async updateEducationalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const result = await reportService.getEducationalReportById(id, currentUser.id);

      if (!result.hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied",
        });
        return;
      }

      if (!result.report) {
        res.status(404).json({
          success: false,
          message: "Educational report not found",
        });
        return;
      }

      if (!(await this.requireOwningInstitute(req, res, result.report, "educational report", "educational_report"))) {
        return;
      }

      const updates: UpdateEducationalReport = req.body;
      const updated = await reportService.updateEducationalReport(id, updates);

      if (!updated) {
        res.status(400).json({
          success: false,
          message: "Failed to update educational report",
        });
        return;
      }

      res.json({
        success: true,
        message: "Educational report updated successfully",
        report: updated,
      });
      activityLogService.log({
        instituteId: (updated as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "update",
        subjectType1: "educational_report",
        subjectId1: id,
      });
    } catch (error: any) {
      console.error("Error updating educational report:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to update educational report",
      });
    }
  }

  /**
   * POST /api/educational-reports/:id/finalize
   * Finalize an educational report
   */
  async finalizeEducationalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const result = await reportService.getEducationalReportById(id, currentUser.id);

      if (!result.hasAccess || !result.report) {
        res.status(403).json({
          success: false,
          message: "Access denied or report not found",
        });
        return;
      }

      if (!(await this.requireOwningInstitute(req, res, result.report, "educational report", "educational_report"))) {
        return;
      }

      if (!(await requireConsentForResponse(req, res, (result.report as any).studentId))) {
        return;
      }

      const finalized = await reportService.finalizeEducationalReport(id);

      res.json({
        success: true,
        message: "Educational report finalized successfully",
        report: finalized,
      });
      activityLogService.log({
        instituteId: (finalized as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "finalize",
        subjectType1: "educational_report",
        subjectId1: id,
      });
    } catch (error: any) {
      console.error("Error finalizing educational report:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to finalize educational report",
      });
    }
  }

  /**
   * POST /api/educational-reports/:id/revision
   * Create a new revision from a finalized educational report
   */
  async createEducationalReportRevision(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const result = await reportService.getEducationalReportById(id, currentUser.id);

      if (!result.hasAccess || !result.report) {
        res.status(403).json({
          success: false,
          message: "Access denied or report not found",
        });
        return;
      }

      if (!(await this.requireOwningInstitute(req, res, result.report, "educational report", "educational_report"))) {
        return;
      }

      const newReport = await reportService.createEducationalReportRevision(
        id,
        currentUser.id
      );

      res.json({
        success: true,
        message: "Educational report revision created successfully",
        report: newReport,
      });
      activityLogService.log({
        instituteId: (newReport as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "revision",
        subjectType1: "educational_report",
        subjectId1: id,
        details: { newReportId: (newReport as any).id ?? null },
      });
    } catch (error: any) {
      console.error("Error creating educational report revision:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to create revision",
      });
    }
  }

  /**
   * DELETE /api/educational-reports/:id
   * Delete a draft educational report
   */
  async deleteEducationalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const result = await reportService.getEducationalReportById(id, currentUser.id);

      if (!result.hasAccess || !result.report) {
        res.status(403).json({
          success: false,
          message: "Access denied or report not found",
        });
        return;
      }

      if (!(await this.requireOwningInstitute(req, res, result.report, "educational report", "educational_report"))) {
        return;
      }

      const deleted = await reportService.deleteEducationalReport(id);

      if (!deleted) {
        res.status(400).json({
          success: false,
          message: "Only draft reports can be deleted",
        });
        return;
      }

      res.json({
        success: true,
        message: "Educational report deleted successfully",
      });
      activityLogService.log({
        instituteId: (result.report as any).instituteId ?? null,
        userId: currentUser.id,
        eventType: "delete",
        subjectType1: "educational_report",
        subjectId1: id,
      });
    } catch (error: any) {
      console.error("Error deleting educational report:", error);
      res.status(500).json({
        success: false,
        message: "Failed to delete educational report",
      });
    }
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
      const ctx = await buildClinicianCtx(req, studentId);
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

      const ctx = await buildClinicianCtx(req, studentId);
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
