import type { Request, Response } from "express";
import { savedLocationRepository } from "../repositories";
import { insertSavedLocationSchema } from "@shared/schema";

export class SavedLocationController {
  async getSavedLocations(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const savedLocations = await savedLocationRepository.getUserSavedLocations(
        currentUser.id
      );
      res.json({ success: true, savedLocations });
    } catch (error: any) {
      console.error("Error fetching saved locations:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch saved locations" });
    }
  }

  async createSavedLocation(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;

      // Validate request body using Zod schema
      const validatedData = insertSavedLocationSchema.parse({
        ...req.body,
        userId: currentUser.id,
      });

      // Additional validation for GPS locations
      if (validatedData.locationType === "gps") {
        if (!validatedData.latitude || !validatedData.longitude) {
          res.status(400).json({
            success: false,
            message: "Latitude and longitude are required for GPS locations",
          });
          return;
        }

        const lat = parseFloat(validatedData.latitude.toString());
        const lng = parseFloat(validatedData.longitude.toString());

        if (lat < -90 || lat > 90) {
          res.status(400).json({
            success: false,
            message: "Latitude must be between -90 and 90 degrees",
          });
          return;
        }

        if (lng < -180 || lng > 180) {
          res.status(400).json({
            success: false,
            message: "Longitude must be between -180 and 180 degrees",
          });
          return;
        }
      }

      const savedLocation = await savedLocationRepository.createSavedLocation(
        validatedData
      );

      res.json({
        success: true,
        message: "Location saved successfully",
        savedLocation,
      });
    } catch (error: any) {
      console.error("Error creating saved location:", error);

      if (error instanceof Error && error.name === "ZodError") {
        res.status(400).json({
          success: false,
          message: "Invalid location data provided",
          details: error.message,
        });
        return;
      }

      res
        .status(500)
        .json({ success: false, message: "Failed to save location" });
    }
  }

  async deleteSavedLocation(req: Request, res: Response): Promise<void> {
    try {
      const currentUser = req.user as any;
      const locationId = req.params.id;

      if (isNaN(parseInt(locationId))) {
        res.status(400).json({
          success: false,
          message: "Invalid location ID",
        });
        return;
      }

      const deleted = await savedLocationRepository.deleteSavedLocation(
        locationId,
        currentUser.id
      );

      if (deleted) {
        res.json({ success: true, message: "Location deleted successfully" });
      } else {
        res.status(404).json({ success: false, message: "Location not found" });
      }
    } catch (error: any) {
      console.error("Error deleting saved location:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to delete location" });
    }
  }
}

export const savedLocationController = new SavedLocationController();
