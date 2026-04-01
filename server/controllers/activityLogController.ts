import type { Request, Response } from "express";
import { activityLogService, type ActivityLogFilters } from "../services/activityLogService";
import type { ActivityEventType, ActivitySubjectType } from "@shared/schema";

class ActivityLogController {
  async getLogs(req: Request, res: Response): Promise<void> {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 25, 1), 100);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

      const filters: ActivityLogFilters = {
        limit,
        offset,
        instituteId: req.query.instituteId as string | undefined,
        userId: req.query.userId as string | undefined,
        eventType: req.query.eventType as ActivityEventType | undefined,
        subjectType: req.query.subjectType as ActivitySubjectType | undefined,
        startDate: req.query.startDate as string | undefined,
        endDate: req.query.endDate as string | undefined,
      };

      if (req.query.isAiInitiated === "true") {
        filters.isAiInitiated = true;
      } else if (req.query.isAiInitiated === "false") {
        filters.isAiInitiated = false;
      }

      const { data, total } = await activityLogService.query(filters);

      res.json({
        success: true,
        data,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + limit < total,
        },
      });
    } catch (error: any) {
      console.error("Error fetching activity logs:", error);
      res.status(500).json({ success: false, message: "Failed to fetch activity logs" });
    }
  }
}

export const activityLogController = new ActivityLogController();
