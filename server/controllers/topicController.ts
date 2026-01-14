// server/controllers/topicController.ts
// HTTP handlers for topic/library management

import type { Request, Response } from "express";
import { topicService } from "../services/topicService";
import { insertTopicSchema, updateTopicSchema } from "@shared/schema";

export class TopicController {
  /**
   * GET /api/admin/topics
   * Get topics by parent ID (admin only)
   * Query params: parentId (optional, null for root)
   */
  async getTopics(req: Request, res: Response): Promise<void> {
    try {
      const parentId = req.query.parentId as string | undefined;
      const result = await topicService.getTopicsByParentId(parentId ?? null);

      if (!result.success) {
        res.status(500).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        topics: result.topics,
      });
    } catch (error: any) {
      console.error("Error fetching topics:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch topics",
      });
    }
  }

  /**
   * GET /api/admin/topics/:id
   * Get a specific topic with children and path (admin only)
   */
  async getTopic(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await topicService.getTopicWithDetails(id);

      if (!result.success) {
        res.status(404).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        topic: result.topic,
        path: result.path,
      });
    } catch (error: any) {
      console.error("Error fetching topic:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch topic",
      });
    }
  }

  /**
   * POST /api/admin/topics
   * Create a new topic (admin only)
   */
  async createTopic(req: Request, res: Response): Promise<void> {
    try {
      // Validate input
      const parseResult = insertTopicSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          message: "Invalid topic data",
          errors: parseResult.error.errors,
        });
        return;
      }

      const result = await topicService.createTopic(parseResult.data);

      if (!result.success) {
        res.status(400).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        message: "Topic created successfully",
        topic: result.topic,
      });
    } catch (error: any) {
      console.error("Error creating topic:", error);
      res.status(500).json({
        success: false,
        message: "Failed to create topic",
      });
    }
  }

  /**
   * PATCH /api/admin/topics/:id
   * Update a topic (admin only)
   */
  async updateTopic(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Validate input
      const parseResult = updateTopicSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          message: "Invalid topic data",
          errors: parseResult.error.errors,
        });
        return;
      }

      const result = await topicService.updateTopic(id, parseResult.data);

      if (!result.success) {
        res.status(result.error === "Topic not found" ? 404 : 400).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        message: "Topic updated successfully",
        topic: result.topic,
      });
    } catch (error: any) {
      console.error("Error updating topic:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update topic",
      });
    }
  }

  /**
   * DELETE /api/admin/topics/:id
   * Delete a topic (admin only)
   * Query params: cascade (optional, if true deletes children too)
   */
  async deleteTopic(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const cascade = req.query.cascade === 'true';

      const result = await topicService.deleteTopic(id, cascade);

      if (!result.success) {
        res.status(result.error === "Topic not found" ? 404 : 400).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        message: "Topic deleted successfully",
      });
    } catch (error: any) {
      console.error("Error deleting topic:", error);
      res.status(500).json({
        success: false,
        message: "Failed to delete topic",
      });
    }
  }

  // ==================== User/AI endpoints (active topics only) ====================

  /**
   * GET /api/topics
   * Get active root topics (for AI/user view)
   * Query params: parentId (optional)
   */
  async getActiveTopics(req: Request, res: Response): Promise<void> {
    try {
      const parentId = req.query.parentId as string | undefined;
      const result = await topicService.getActiveTopicsByParentId(parentId ?? null);

      if (!result.success) {
        res.status(500).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        topics: result.topics,
      });
    } catch (error: any) {
      console.error("Error fetching active topics:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch topics",
      });
    }
  }

  /**
   * GET /api/topics/:id
   * Get an active topic with children (for AI/user view)
   */
  async getActiveTopic(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await topicService.getActiveTopicById(id);

      if (!result.success) {
        res.status(404).json({
          success: false,
          message: result.error,
        });
        return;
      }

      res.json({
        success: true,
        topic: result.topic,
        path: result.path,
      });
    } catch (error: any) {
      console.error("Error fetching topic:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch topic",
      });
    }
  }
}

export const topicController = new TopicController();
