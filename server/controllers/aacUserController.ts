import type { Request, Response } from "express";
import { aacUserService } from "../services";
import {
  insertAacUserScheduleSchema,
  updateAacUserScheduleSchema,
} from "@shared/schema";

export class AacUserController {
  /**
   * GET /api/aac-users
   * Get all AAC users for the current user
   */
  async getAacUsers(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      console.log("Getting AAC users for user ID:", currentUser.id);
      
      // Get AAC users with their link information
      const aacUsersWithLinks = await aacUserService.getAacUsersWithLinksByUserId(currentUser.id);
      
      // Transform to include calculated age and role
      const aacUsers = aacUsersWithLinks.map(({ aacUser, link }) => ({
        ...aacUser,
        age: aacUserService.calculateAge(aacUser.birthDate),
        role: link.role,
        linkId: link.id,
      }));
      
      res.json({ success: true, aacUsers });
    } catch (error: any) {
      console.error("Error fetching AAC users:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch AAC users" });
    }
  }

  async getAacUserById(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const aacUserId = req.params.id;

      // Verify access
      const { hasAccess, link } = await aacUserService.verifyAacUserAccess(aacUserId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      const aacUser = await aacUserService.getAacUserById(aacUserId);
      if (aacUser) {
        res.json({
          success: true,
          aacUser: {
            ...aacUser,
            age: aacUserService.calculateAge(aacUser.birthDate),
          },
        });
      } else {
        res.status(404).json({ success: false, message: "AAC user not found" });
      }
    } catch (error: any) {
      console.error("Error fetching AAC user:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch AAC user" });
    }
  }

  /**
   * POST /api/aac-users
   * Create a new AAC user
   */
  async createAacUser(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { name, gender, birthDate, disabilityOrSyndrome, backgroundContext } = req.body;

      if (!name) {
        res
          .status(400)
          .json({ success: false, message: "Name is required" });
        return;
      }

      const aacUser = await aacUserService.createAacUser(
        currentUser.id,
        name,
        gender,
        birthDate,
        disabilityOrSyndrome,
        backgroundContext,
        "owner" // Creating user becomes the owner
      );

      res.json({
        success: true,
        message: "AAC user created successfully",
        aacUser: {
          ...aacUser,
          age: aacUserService.calculateAge(aacUser.birthDate),
        },
      });
    } catch (error: any) {
      console.error("Error creating AAC user:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to create AAC user" });
    }
  }

  /**
   * PATCH /api/aac-users/:id
   * Update an AAC user
   */
  async updateAacUser(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const aacUserId = req.params.id;
      const { name, gender, birthDate, disabilityOrSyndrome, backgroundContext } = req.body;

      // Verify access
      const { hasAccess } = await aacUserService.verifyAacUserAccess(aacUserId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (gender !== undefined) updates.gender = gender;
      if (birthDate !== undefined) updates.birthDate = birthDate;
      if (disabilityOrSyndrome !== undefined) updates.disabilityOrSyndrome = disabilityOrSyndrome;
      if (backgroundContext !== undefined) updates.backgroundContext = backgroundContext;

      const updatedAacUser = await aacUserService.updateAacUser(aacUserId, updates);
      
      if (updatedAacUser) {
        res.json({
          success: true,
          message: "AAC user updated successfully",
          aacUser: {
            ...updatedAacUser,
            age: aacUserService.calculateAge(updatedAacUser.birthDate),
          },
        });
      } else {
        res.status(404).json({ success: false, message: "AAC user not found" });
      }
    } catch (error: any) {
      console.error("Error updating AAC user:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to update AAC user" });
    }
  }

  /**
   * DELETE /api/aac-users/:id
   * Delete an AAC user (soft delete)
   */
  async deleteAacUser(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const aacUserId = req.params.id;
      
      // Verify access (only owners should be able to delete)
      const { hasAccess, link } = await aacUserService.verifyAacUserAccess(aacUserId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      if (link?.role !== "owner") {
        res.status(403).json({ success: false, message: "Only owners can delete an AAC user" });
        return;
      }

      const deleted = await aacUserService.deleteAacUser(aacUserId);
      
      if (deleted) {
        res.json({ success: true, message: "AAC user deleted successfully" });
      } else {
        res.status(404).json({ success: false, message: "AAC user not found" });
      }
    } catch (error: any) {
      console.error("Error deleting AAC user:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to delete AAC user" });
    }
  }

  // ==================== Link Management Routes ====================

  /**
   * POST /api/aac-users/:id/link
   * Link another user to an AAC user
   */
  async linkUser(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const aacUserId = req.params.id;
      const { targetUserId, role } = req.body;

      if (!targetUserId) {
        res.status(400).json({ success: false, message: "Target user ID is required" });
        return;
      }

      // Verify the current user has access to this AAC user
      const { hasAccess, link: currentLink } = await aacUserService.verifyAacUserAccess(aacUserId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      // Only owners can link other users
      if (currentLink?.role !== "owner") {
        res.status(403).json({ success: false, message: "Only owners can link other users" });
        return;
      }

      const link = await aacUserService.linkUserToAacUser(
        targetUserId,
        aacUserId,
        role || "caregiver"
      );

      res.json({
        success: true,
        message: "User linked successfully",
        link,
      });
    } catch (error: any) {
      console.error("Error linking user:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to link user" });
    }
  }

  /**
   * DELETE /api/aac-users/:id/link/:userId
   * Remove a user's link to an AAC user
   */
  async unlinkUser(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const aacUserId = req.params.id;
      const targetUserId = req.params.userId;

      // Verify the current user has access and is an owner
      const { hasAccess, link: currentLink } = await aacUserService.verifyAacUserAccess(aacUserId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      if (currentLink?.role !== "owner") {
        res.status(403).json({ success: false, message: "Only owners can unlink users" });
        return;
      }

      // Cannot unlink the owner
      const targetLink = await aacUserService.getUserAacUserLink(targetUserId, aacUserId);
      if (targetLink?.role === "owner") {
        res.status(400).json({ success: false, message: "Cannot unlink the owner" });
        return;
      }

      const unlinked = await aacUserService.unlinkUserFromAacUser(targetUserId, aacUserId);

      if (unlinked) {
        res.json({ success: true, message: "User unlinked successfully" });
      } else {
        res.status(404).json({ success: false, message: "Link not found" });
      }
    } catch (error: any) {
      console.error("Error unlinking user:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to unlink user" });
    }
  }

  /**
   * GET /api/aac-users/:id/links
   * Get all users linked to an AAC user
   */
  async getLinkedUsers(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const aacUserId = req.params.id;

      // Verify access
      const { hasAccess } = await aacUserService.verifyAacUserAccess(aacUserId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      const links = await aacUserService.getUsersLinkedToAacUser(aacUserId);

      res.json({ success: true, links });
    } catch (error: any) {
      console.error("Error fetching linked users:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch linked users" });
    }
  }

  // ==================== Schedule Routes ====================

  /**
   * GET /api/aac-users/:aacUserId/schedules
   * Get all schedules for an AAC user
   */
  async getSchedules(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { aacUserId } = req.params;

      // Verify access
      const { hasAccess } = await aacUserService.verifyAacUserAccess(aacUserId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      const schedules = await aacUserService.getSchedulesByAacUserId(aacUserId);
      res.json({ success: true, schedules });
    } catch (error: any) {
      console.error("Error fetching schedules:", error);
      res.status(500).json({ success: false, message: "Failed to fetch schedules" });
    }
  }

  /**
   * POST /api/aac-users/:aacUserId/schedules
   * Create a schedule entry for an AAC user
   */
  async createSchedule(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { aacUserId } = req.params;

      // Verify access
      const { hasAccess } = await aacUserService.verifyAacUserAccess(aacUserId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      const validatedData = insertAacUserScheduleSchema.parse({
        ...req.body,
        aacUserId,
      });
      const schedule = await aacUserService.createScheduleEntry(validatedData);
      res.json({
        success: true,
        message: "Schedule entry created successfully",
        schedule,
      });
    } catch (error: any) {
      console.error("Error creating schedule:", error);
      if (error.name === "ZodError") {
        res.status(400).json({
          success: false,
          message: "Invalid schedule data",
          errors: error.errors,
        });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to create schedule entry" });
    }
  }

  /**
   * PATCH /api/schedules/:id
   * Update a schedule entry
   */
  async updateSchedule(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const scheduleId = req.params.id;

      // Get the schedule to verify access
      const schedule = await aacUserService.getScheduleEntry(scheduleId);
      if (!schedule) {
        res.status(404).json({ success: false, message: "Schedule entry not found" });
        return;
      }

      // Verify access to the AAC user
      const { hasAccess } = await aacUserService.verifyAacUserAccess(schedule.aacUserId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      const validatedData = updateAacUserScheduleSchema.parse(req.body);
      const updated = await aacUserService.updateScheduleEntry(scheduleId, validatedData);
      
      if (updated) {
        res.json({
          success: true,
          message: "Schedule entry updated successfully",
          schedule: updated,
        });
      } else {
        res.status(404).json({ success: false, message: "Schedule entry not found" });
      }
    } catch (error: any) {
      console.error("Error updating schedule:", error);
      if (error.name === "ZodError") {
        res.status(400).json({
          success: false,
          message: "Invalid schedule data",
          errors: error.errors,
        });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to update schedule entry" });
    }
  }

  /**
   * DELETE /api/schedules/:id
   * Delete a schedule entry
   */
  async deleteSchedule(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const scheduleId = req.params.id;

      // Get the schedule to verify access
      const schedule = await aacUserService.getScheduleEntry(scheduleId);
      if (!schedule) {
        res.status(404).json({ success: false, message: "Schedule entry not found" });
        return;
      }

      // Verify access to the AAC user
      const { hasAccess } = await aacUserService.verifyAacUserAccess(schedule.aacUserId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      const deleted = await aacUserService.deleteScheduleEntry(scheduleId);
      
      if (deleted) {
        res.json({ success: true, message: "Schedule entry deleted successfully" });
      } else {
        res.status(404).json({ success: false, message: "Schedule entry not found" });
      }
    } catch (error: any) {
      console.error("Error deleting schedule:", error);
      res.status(500).json({ success: false, message: "Failed to delete schedule entry" });
    }
  }

  /**
   * GET /api/aac-users/:aacUserId/schedule-context
   * Get the current schedule context for an AAC user
   */
  async getScheduleContext(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { aacUserId } = req.params;

      // Verify access
      const { hasAccess } = await aacUserService.verifyAacUserAccess(aacUserId, currentUser.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "Access denied to this AAC user" });
        return;
      }

      const timestamp = req.query.timestamp
        ? new Date(req.query.timestamp as string)
        : new Date();
      const context = await aacUserService.getCurrentScheduleContext(aacUserId, timestamp);
      res.json({ success: true, context });
    } catch (error: any) {
      console.error("Error fetching schedule context:", error);
      res.status(500).json({ success: false, message: "Failed to fetch schedule context" });
    }
  }
}

export const aacUserController = new AacUserController();