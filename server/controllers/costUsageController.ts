import type { Request, Response } from "express";
import { chatRepository } from "../repositories/chatRepository";

/**
 * Admin Cost & Usage dashboard data.
 *
 * Returns aggregated cost/usage analytics derived entirely from existing
 * chat_sessions data (no new tables). The client renders the charts and KPIs
 * from this single payload. Gated by the "cost-usage" admin section.
 */
class CostUsageController {
  async getAnalytics(req: Request, res: Response): Promise<void> {
    try {
      const startDate = req.query.startDate as string | undefined;
      const endDate = req.query.endDate as string | undefined;

      const result = await chatRepository.getCostUsageAnalytics({ startDate, endDate });

      res.json({
        success: true,
        points: result.points,
        kpis: result.kpis,
        categoryBreakdown: result.categoryBreakdown,
        truncated: result.truncated,
      });
    } catch (error: any) {
      console.error("Error fetching cost & usage analytics:", error);
      res.status(500).json({ success: false, message: "Failed to fetch cost & usage analytics" });
    }
  }
}

export const costUsageController = new CostUsageController();
