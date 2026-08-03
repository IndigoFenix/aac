import type { Request, Response } from "express";
import { userService } from "../services";

export class ProfileController {
  async uploadImage(
    req: Request & { file?: Express.Multer.File },
    res: Response
  ): Promise<void> {
    try {
      const currentUser = req.user as any;

      if (!req.file) {
        res.status(400).json({
          success: false,
          message: "No image file provided",
        });
        return;
      }

      // Convert buffer to base64 for storage
      const base64Image = req.file.buffer.toString("base64");
      const mimeType = req.file.mimetype;
      const imageUrl = `data:${mimeType};base64,${base64Image}`;

      const updatedUser = await userService.updateProfileImage(
        currentUser.id,
        imageUrl
      );

      if (!updatedUser) {
        res.status(500).json({
          success: false,
          message: "Failed to update profile image",
        });
        return;
      }

      // Update session user data
      (req.user as any).profileImageUrl = imageUrl;

      res.json({
        success: true,
        message: "Profile image uploaded successfully",
        imageUrl: imageUrl,
      });
    } catch (error: any) {
      console.error("Profile image upload error:", error);
      res.status(500).json({
        success: false,
        message: "Profile image upload failed",
      });
    }
  }

  async updateProfile(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { firstName, lastName } = req.body;

      if (!firstName || firstName.trim() === "") {
        res.status(400).json({
          success: false,
          message: "First name is required",
        });
        return;
      }

      const updatedUser = await userService.updateUserProfile(
        currentUser.id,
        firstName,
        lastName
      );

      if (!updatedUser) {
        res.status(500).json({
          success: false,
          message: "Failed to update profile",
        });
        return;
      }

      // Update session user data
      Object.assign(req.user as any, {
        firstName: updatedUser.firstName,
        lastName: updatedUser.lastName,
        fullName: updatedUser.fullName,
      });

      res.json({
        success: true,
        message: "Profile updated successfully",
        user: {
          firstName: updatedUser.firstName,
          lastName: updatedUser.lastName,
          fullName: updatedUser.fullName,
        },
      });
    } catch (error: any) {
      console.error("Profile update error:", error);
      res.status(500).json({
        success: false,
        message: "Profile update failed",
      });
    }
  }

  /**
   * PATCH /api/profile/slp-mode — read/write the caller's own SLP MODE flag.
   *
   * SLP MODE is the one AAC behavior scoped to the LOGGED-IN USER rather than
   * a student (a speech-language pathologist running a session WITH them), so
   * it deliberately does NOT ride on `PATCH /api/students/:id` and is NOT in
   * `AAC_SETTINGS_FIELDS`.
   *
   * Authorization: the target is ALWAYS `req.user.id`. There is no id in the
   * request body and none is read — a user can only ever flip their own flag.
   */
  async updateSlpMode(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const { slpMode } = req.body ?? {};

      if (typeof slpMode !== "boolean") {
        res.status(400).json({
          success: false,
          message: "slpMode must be a boolean",
        });
        return;
      }

      // Admin pseudo-identities live in admin_users and have no slp_mode
      // column; writing would target a non-existent users row.
      if (currentUser?._identityKind === "admin") {
        res.status(403).json({
          success: false,
          message: "SLP mode is not available for admin accounts",
        });
        return;
      }

      const updatedUser = await userService.updateSlpMode(currentUser.id, slpMode);

      if (!updatedUser) {
        res.status(500).json({
          success: false,
          message: "Failed to update SLP mode",
        });
        return;
      }

      // Keep the in-memory session identity in step so anything reading
      // `req.user` later in this request/session sees the new value.
      (req.user as any).slpMode = updatedUser.slpMode;

      res.json({
        success: true,
        slpMode: updatedUser.slpMode === true,
      });
    } catch (error: any) {
      console.error("SLP mode update error:", error);
      res.status(500).json({
        success: false,
        message: "SLP mode update failed",
      });
    }
  }
}

export const profileController = new ProfileController();
