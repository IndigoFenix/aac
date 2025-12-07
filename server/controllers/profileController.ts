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
}

export const profileController = new ProfileController();
