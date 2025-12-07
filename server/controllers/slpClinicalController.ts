import type { Request, Response } from "express";
import { interpretationRepository } from "../repositories";
import { stringify } from "csv-stringify";

export class SlpClinicalController {
  /**
   * GET /api/slp/clinical-log
   * Get clinical data log with filtering
   */
  async getClinicalLog(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { aacUserId, startDate, endDate } = req.query;

      const filters: {
        userId?: string;
        aacUserId?: string;
        startDate?: Date;
        endDate?: Date;
      } = {
        userId: currentUser.id,
      };

      if (aacUserId && typeof aacUserId === "string") {
        filters.aacUserId = aacUserId;
      }

      if (startDate && typeof startDate === "string") {
        filters.startDate = new Date(startDate);
      }

      if (endDate && typeof endDate === "string") {
        filters.endDate = new Date(endDate);
      }

      const data = await interpretationRepository.getClinicalData(filters);

      res.json({
        success: true,
        data,
      });
    } catch (error: any) {
      console.error("Clinical data fetch error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch clinical data",
      });
    }
  }

  /**
   * GET /api/slp/clinical-metrics
   * Get clinical metrics with aggregation
   */
  async getClinicalMetrics(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { aacUserId, startDate, endDate } = req.query;

      const filters: {
        userId?: string;
        aacUserId?: string;
        startDate?: Date;
        endDate?: Date;
      } = {
        userId: currentUser.id,
      };

      if (aacUserId && typeof aacUserId === "string") {
        filters.aacUserId = aacUserId;
      }

      if (startDate && typeof startDate === "string") {
        filters.startDate = new Date(startDate);
      }

      if (endDate && typeof endDate === "string") {
        filters.endDate = new Date(endDate);
      }

      const metrics = await interpretationRepository.getClinicalMetrics(filters);

      res.json({
        success: true,
        metrics,
      });
    } catch (error: any) {
      console.error("Clinical metrics fetch error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch clinical metrics",
      });
    }
  }

  /**
   * GET /api/slp/export-csv
   * Export clinical data as CSV
   */
  async exportCsv(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { aacUserId, startDate, endDate } = req.query;

      const filters: {
        userId?: string;
        aacUserId?: string;
        startDate?: Date;
        endDate?: Date;
      } = {
        userId: currentUser.id,
      };

      if (aacUserId && typeof aacUserId === "string") {
        filters.aacUserId = aacUserId;
      }

      if (startDate && typeof startDate === "string") {
        filters.startDate = new Date(startDate);
      }

      if (endDate && typeof endDate === "string") {
        filters.endDate = new Date(endDate);
      }

      const data = await interpretationRepository.getClinicalData(filters);

      // Format data for CSV export
      const csvData = data.map((row) => ({
        "Interpretation ID": row.id,
        Date: row.createdAt.toISOString(),
        "AAC User ID": row.aacUserId || "N/A",
        "AAC User Alias": row.aacUserAlias || "N/A",
        "Original Input": row.originalInput,
        "Interpreted Meaning": row.interpretedMeaning,
        "Input Type": row.inputType,
        "Confidence Score": row.confidence,
        WPM: row.aacUserWPM || "N/A",
        "Caregiver Feedback": row.caregiverFeedback || "No feedback",
        "Schedule Activity": row.scheduleActivity || "N/A",
        Language: row.language,
        Context: row.context || "N/A",
        "Suggested Response": row.suggestedResponse,
      }));

      // Set up CSV headers
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="clinical-data-${Date.now()}.csv"`
      );

      // Create CSV stringifier and stream to response
      const stringifier = stringify(csvData, {
        header: true,
        columns: [
          "Interpretation ID",
          "Date",
          "AAC User ID",
          "AAC User Alias",
          "Original Input",
          "Interpreted Meaning",
          "Input Type",
          "Confidence Score",
          "WPM",
          "Caregiver Feedback",
          "Schedule Activity",
          "Language",
          "Context",
          "Suggested Response",
        ],
      });

      stringifier.pipe(res);
      stringifier.write(csvData);
      stringifier.end();
    } catch (error: any) {
      console.error("CSV export error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to export clinical data",
      });
    }
  }
}

export const slpClinicalController = new SlpClinicalController();
