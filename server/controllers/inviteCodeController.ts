import type { Request, Response } from "express";
import { inviteCodeService } from "../services";

export class InviteCodeController {
  async createInviteCode(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { aacUserId, redemptionLimit, expiresAt } = req.body;

      if (!aacUserId) {
        res
          .status(400)
          .json({ success: false, message: "AAC user ID is required" });
        return;
      }

      const inviteCode = await inviteCodeService.createInviteCode(
        currentUser.id,
        aacUserId,
        redemptionLimit || 1,
        expiresAt ? new Date(expiresAt) : undefined
      );

      res.json({
        success: true,
        message: "Invite code created successfully",
        inviteCode,
      });
    } catch (error: any) {
      console.error("Error creating invite code:", error);
      if (error.message === "AAC user not found or not owned by you") {
        res.status(403).json({
          success: false,
          message: error.message,
        });
        return;
      }
      res
        .status(500)
        .json({ success: false, message: "Failed to create invite code" });
    }
  }

  async getInviteCodes(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const inviteCodes = await inviteCodeService.getInviteCodesByUserId(
        currentUser.id
      );
      res.json({ success: true, inviteCodes });
    } catch (error: any) {
      console.error("Error fetching invite codes:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch invite codes" });
    }
  }

  async redeemInviteCode(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { code } = req.body;

      if (!code) {
        res
          .status(400)
          .json({ success: false, message: "Invite code is required" });
        return;
      }

      const result = await inviteCodeService.redeemInviteCode(
        code,
        currentUser.id
      );

      if (result.success) {
        res.json({
          success: true,
          message: "Invite code redeemed successfully",
          aacUser: result.aacUser,
        });
      } else {
        res.status(400).json({
          success: false,
          message: result.error,
        });
      }
    } catch (error: any) {
      console.error("Error redeeming invite code:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to redeem invite code" });
    }
  }

  async getRedemptions(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const redemptions = await inviteCodeService.getInviteCodeRedemptions(
        currentUser.id
      );
      res.json({ success: true, redemptions });
    } catch (error: any) {
      console.error("Error fetching redemptions:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch redemptions" });
    }
  }

  async deactivateInviteCode(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const inviteCodeId = req.params.id;

      const deactivated = await inviteCodeService.deactivateInviteCode(
        inviteCodeId,
        currentUser.id
      );

      if (deactivated) {
        res.json({
          success: true,
          message: "Invite code deactivated successfully",
        });
      } else {
        res.status(500).json({
          success: false,
          message: "Failed to deactivate invite code",
        });
      }
    } catch (error: any) {
      console.error("Error deactivating invite code:", error);
      if (error.message === "Invite code not found") {
        res.status(404).json({ success: false, message: error.message });
        return;
      }
      res.status(500).json({
        success: false,
        message: "Failed to deactivate invite code",
      });
    }
  }
}

export const inviteCodeController = new InviteCodeController();
