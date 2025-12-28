import type { Request, Response } from "express";
import { recordsService } from "../services/recordsService";
import { studentService } from "../services";

/**
 * RecordsController
 * 
 * Handles API endpoints for sensitive student records.
 * All endpoints require authentication and verify access to the student.
 */
export class RecordsController {
  // ===========================================
  // Medical Records
  // ===========================================

  /**
   * GET /api/students/:studentId/medical-record
   */
  async getMedicalRecord(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;

      // Verify access to student
      const { hasAccess } = await studentService.verifyStudentAccess(
        studentId,
        currentUser.id
      );
      if (!hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied to this student",
        });
        return;
      }

      const ctx = recordsService.buildSecurityContext(
        currentUser.id,
        currentUser.role,
        currentUser.instituteId
      );

      const record = await recordsService.getMedicalRecord(studentId, ctx);

      res.json({
        success: true,
        record,
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
   * POST /api/students/:studentId/medical-record
   */
  async createMedicalRecord(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;

      const { hasAccess } = await studentService.verifyStudentAccess(
        studentId,
        currentUser.id
      );
      if (!hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied to this student",
        });
        return;
      }

      const ctx = recordsService.buildSecurityContext(
        currentUser.id,
        currentUser.role,
        currentUser.instituteId
      );

      const record = await recordsService.createMedicalRecord(
        { ...req.body, studentId },
        ctx
      );

      res.json({
        success: true,
        message: "Medical record created successfully",
        record,
      });
    } catch (error: any) {
      console.error("Error creating medical record:", error);
      res.status(error.message.includes("permission") ? 403 : 500).json({
        success: false,
        message: error.message || "Failed to create medical record",
      });
    }
  }

  /**
   * PATCH /api/medical-records/:id
   */
  async updateMedicalRecord(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const ctx = recordsService.buildSecurityContext(
        currentUser.id,
        currentUser.role,
        currentUser.instituteId
      );

      const record = await recordsService.updateMedicalRecord(id, req.body, ctx);

      if (!record) {
        res.status(404).json({
          success: false,
          message: "Medical record not found",
        });
        return;
      }

      res.json({
        success: true,
        message: "Medical record updated successfully",
        record,
      });
    } catch (error: any) {
      console.error("Error updating medical record:", error);
      res.status(error.message.includes("permission") ? 403 : 500).json({
        success: false,
        message: error.message || "Failed to update medical record",
      });
    }
  }

  /**
   * DELETE /api/medical-records/:id
   */
  async deleteMedicalRecord(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const ctx = recordsService.buildSecurityContext(
        currentUser.id,
        currentUser.role,
        currentUser.instituteId
      );

      const deleted = await recordsService.deleteMedicalRecord(id, ctx);

      if (!deleted) {
        res.status(404).json({
          success: false,
          message: "Medical record not found",
        });
        return;
      }

      res.json({
        success: true,
        message: "Medical record deleted successfully",
      });
    } catch (error: any) {
      console.error("Error deleting medical record:", error);
      res.status(error.message.includes("admin") ? 403 : 500).json({
        success: false,
        message: error.message || "Failed to delete medical record",
      });
    }
  }

  // ===========================================
  // Functional Reports
  // ===========================================

  /**
   * GET /api/students/:studentId/functional-reports
   */
  async getFunctionalReports(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;
      const { limit, offset, reportType } = req.query;

      const { hasAccess } = await studentService.verifyStudentAccess(
        studentId,
        currentUser.id
      );
      if (!hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied to this student",
        });
        return;
      }

      const ctx = recordsService.buildSecurityContext(
        currentUser.id,
        currentUser.role,
        currentUser.instituteId
      );

      const reports = await recordsService.getFunctionalReports(studentId, ctx, {
        limit: limit ? parseInt(limit as string) : undefined,
        offset: offset ? parseInt(offset as string) : undefined,
        reportType: reportType as string | undefined,
      });

      res.json({
        success: true,
        reports,
      });
    } catch (error: any) {
      console.error("Error fetching functional reports:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch functional reports",
      });
    }
  }

  /**
   * GET /api/functional-reports/:id
   */
  async getFunctionalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const ctx = recordsService.buildSecurityContext(
        currentUser.id,
        currentUser.role,
        currentUser.instituteId
      );

      const report = await recordsService.getFunctionalReportById(id, ctx);

      if (!report) {
        res.status(404).json({
          success: false,
          message: "Functional report not found",
        });
        return;
      }

      res.json({
        success: true,
        report,
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
   * POST /api/students/:studentId/functional-reports
   */
  async createFunctionalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;

      const { hasAccess } = await studentService.verifyStudentAccess(
        studentId,
        currentUser.id
      );
      if (!hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied to this student",
        });
        return;
      }

      const ctx = recordsService.buildSecurityContext(
        currentUser.id,
        currentUser.role,
        currentUser.instituteId
      );

      const report = await recordsService.createFunctionalReport(
        { ...req.body, studentId },
        ctx
      );

      res.json({
        success: true,
        message: "Functional report created successfully",
        report,
      });
    } catch (error: any) {
      console.error("Error creating functional report:", error);
      res.status(error.message.includes("permission") ? 403 : 500).json({
        success: false,
        message: error.message || "Failed to create functional report",
      });
    }
  }

  /**
   * PATCH /api/functional-reports/:id
   */
  async updateFunctionalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const ctx = recordsService.buildSecurityContext(
        currentUser.id,
        currentUser.role,
        currentUser.instituteId
      );

      const report = await recordsService.updateFunctionalReport(id, req.body, ctx);

      if (!report) {
        res.status(404).json({
          success: false,
          message: "Functional report not found",
        });
        return;
      }

      res.json({
        success: true,
        message: "Functional report updated successfully",
        report,
      });
    } catch (error: any) {
      console.error("Error updating functional report:", error);
      res.status(error.message.includes("permission") || error.message.includes("author") ? 403 : 500).json({
        success: false,
        message: error.message || "Failed to update functional report",
      });
    }
  }

  /**
   * POST /api/functional-reports/:id/submit
   */
  async submitFunctionalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const ctx = recordsService.buildSecurityContext(
        currentUser.id,
        currentUser.role,
        currentUser.instituteId
      );

      const report = await recordsService.submitFunctionalReportForReview(id, ctx);

      if (!report) {
        res.status(404).json({
          success: false,
          message: "Functional report not found",
        });
        return;
      }

      res.json({
        success: true,
        message: "Functional report submitted for review",
        report,
      });
    } catch (error: any) {
      console.error("Error submitting functional report:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to submit functional report",
      });
    }
  }

  /**
   * POST /api/functional-reports/:id/finalize
   */
  async finalizeFunctionalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const ctx = recordsService.buildSecurityContext(
        currentUser.id,
        currentUser.role,
        currentUser.instituteId
      );

      const report = await recordsService.finalizeFunctionalReport(id, ctx);

      if (!report) {
        res.status(404).json({
          success: false,
          message: "Functional report not found",
        });
        return;
      }

      res.json({
        success: true,
        message: "Functional report finalized",
        report,
      });
    } catch (error: any) {
      console.error("Error finalizing functional report:", error);
      res.status(error.message.includes("permission") ? 403 : 500).json({
        success: false,
        message: error.message || "Failed to finalize functional report",
      });
    }
  }

  /**
   * DELETE /api/functional-reports/:id
   */
  async deleteFunctionalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const ctx = recordsService.buildSecurityContext(
        currentUser.id,
        currentUser.role,
        currentUser.instituteId
      );

      const deleted = await recordsService.deleteFunctionalReport(id, ctx);

      if (!deleted) {
        res.status(404).json({
          success: false,
          message: "Functional report not found",
        });
        return;
      }

      res.json({
        success: true,
        message: "Functional report deleted successfully",
      });
    } catch (error: any) {
      console.error("Error deleting functional report:", error);
      res.status(error.message.includes("draft") ? 400 : 500).json({
        success: false,
        message: error.message || "Failed to delete functional report",
      });
    }
  }

  // ===========================================
  // Educational Reports
  // ===========================================

  /**
   * GET /api/students/:studentId/educational-reports
   */
  async getEducationalReports(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;
      const { limit, offset, reportType, academicYear } = req.query;

      const { hasAccess } = await studentService.verifyStudentAccess(
        studentId,
        currentUser.id
      );
      if (!hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied to this student",
        });
        return;
      }

      const ctx = recordsService.buildSecurityContext(
        currentUser.id,
        currentUser.role,
        currentUser.instituteId
      );

      const reports = await recordsService.getEducationalReports(studentId, ctx, {
        limit: limit ? parseInt(limit as string) : undefined,
        offset: offset ? parseInt(offset as string) : undefined,
        reportType: reportType as string | undefined,
        academicYear: academicYear as string | undefined,
      });

      res.json({
        success: true,
        reports,
      });
    } catch (error: any) {
      console.error("Error fetching educational reports:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch educational reports",
      });
    }
  }

  /**
   * GET /api/educational-reports/:id
   */
  async getEducationalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const ctx = recordsService.buildSecurityContext(
        currentUser.id,
        currentUser.role,
        currentUser.instituteId
      );

      const report = await recordsService.getEducationalReportById(id, ctx);

      if (!report) {
        res.status(404).json({
          success: false,
          message: "Educational report not found",
        });
        return;
      }

      res.json({
        success: true,
        report,
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
   * POST /api/students/:studentId/educational-reports
   */
  async createEducationalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { studentId } = req.params;

      const { hasAccess } = await studentService.verifyStudentAccess(
        studentId,
        currentUser.id
      );
      if (!hasAccess) {
        res.status(403).json({
          success: false,
          message: "Access denied to this student",
        });
        return;
      }

      const ctx = recordsService.buildSecurityContext(
        currentUser.id,
        currentUser.role,
        currentUser.instituteId
      );

      const report = await recordsService.createEducationalReport(
        { ...req.body, studentId },
        ctx
      );

      res.json({
        success: true,
        message: "Educational report created successfully",
        report,
      });
    } catch (error: any) {
      console.error("Error creating educational report:", error);
      res.status(error.message.includes("permission") ? 403 : 500).json({
        success: false,
        message: error.message || "Failed to create educational report",
      });
    }
  }

  /**
   * PATCH /api/educational-reports/:id
   */
  async updateEducationalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const ctx = recordsService.buildSecurityContext(
        currentUser.id,
        currentUser.role,
        currentUser.instituteId
      );

      const report = await recordsService.updateEducationalReport(id, req.body, ctx);

      if (!report) {
        res.status(404).json({
          success: false,
          message: "Educational report not found",
        });
        return;
      }

      res.json({
        success: true,
        message: "Educational report updated successfully",
        report,
      });
    } catch (error: any) {
      console.error("Error updating educational report:", error);
      res.status(error.message.includes("permission") || error.message.includes("author") ? 403 : 500).json({
        success: false,
        message: error.message || "Failed to update educational report",
      });
    }
  }

  /**
   * POST /api/educational-reports/:id/share
   */
  async shareEducationalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const ctx = recordsService.buildSecurityContext(
        currentUser.id,
        currentUser.role,
        currentUser.instituteId
      );

      const report = await recordsService.shareEducationalReportWithGuardians(id, ctx);

      if (!report) {
        res.status(404).json({
          success: false,
          message: "Educational report not found",
        });
        return;
      }

      res.json({
        success: true,
        message: "Educational report shared with guardians",
        report,
      });
    } catch (error: any) {
      console.error("Error sharing educational report:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to share educational report",
      });
    }
  }

  /**
   * POST /api/educational-reports/:id/acknowledge
   */
  async acknowledgeEducationalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const ctx = recordsService.buildSecurityContext(
        currentUser.id,
        currentUser.role,
        currentUser.instituteId
      );

      const report = await recordsService.acknowledgeEducationalReport(id, ctx);

      if (!report) {
        res.status(404).json({
          success: false,
          message: "Educational report not found",
        });
        return;
      }

      res.json({
        success: true,
        message: "Educational report acknowledged",
        report,
      });
    } catch (error: any) {
      console.error("Error acknowledging educational report:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to acknowledge educational report",
      });
    }
  }

  /**
   * POST /api/educational-reports/:id/finalize
   */
  async finalizeEducationalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const ctx = recordsService.buildSecurityContext(
        currentUser.id,
        currentUser.role,
        currentUser.instituteId
      );

      const report = await recordsService.finalizeEducationalReport(id, ctx);

      if (!report) {
        res.status(404).json({
          success: false,
          message: "Educational report not found",
        });
        return;
      }

      res.json({
        success: true,
        message: "Educational report finalized",
        report,
      });
    } catch (error: any) {
      console.error("Error finalizing educational report:", error);
      res.status(error.message.includes("permission") ? 403 : 500).json({
        success: false,
        message: error.message || "Failed to finalize educational report",
      });
    }
  }

  /**
   * DELETE /api/educational-reports/:id
   */
  async deleteEducationalReport(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { id } = req.params;

      const ctx = recordsService.buildSecurityContext(
        currentUser.id,
        currentUser.role,
        currentUser.instituteId
      );

      const deleted = await recordsService.deleteEducationalReport(id, ctx);

      if (!deleted) {
        res.status(404).json({
          success: false,
          message: "Educational report not found",
        });
        return;
      }

      res.json({
        success: true,
        message: "Educational report deleted successfully",
      });
    } catch (error: any) {
      console.error("Error deleting educational report:", error);
      res.status(error.message.includes("draft") ? 400 : 500).json({
        success: false,
        message: error.message || "Failed to delete educational report",
      });
    }
  }
}

export const recordsController = new RecordsController();