// server/controllers/locationController.ts
// Controller for registered GPS location endpoints.

import type { Request, Response } from "express";
import { locationService } from "../services/locationService";
import { z } from "zod";

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

const createLocationSchema = z.object({
  instituteId: z.string().min(1),
  title: z.string().min(1),
  address: z.string().optional().nullable(),
  latitude,
  longitude,
});

const updateLocationSchema = z.object({
  title: z.string().min(1).optional(),
  address: z.string().optional().nullable(),
  latitude: latitude.optional(),
  longitude: longitude.optional(),
  isActive: z.boolean().optional(),
});

const geocodeSchema = z.object({
  address: z.string().min(1),
});

class LocationController {
  async list(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const instituteId = req.query.instituteId;
      if (typeof instituteId !== "string" || !instituteId) {
        res.status(400).json({ success: false, message: "instituteId is required" });
        return;
      }
      const items = await locationService.listForInstitute(instituteId, user.id);
      if (items === null) {
        res.status(403).json({ success: false, message: "Not a member of this institute" });
        return;
      }
      res.json({ success: true, locations: items });
    } catch (error) {
      console.error("Error listing locations:", error);
      res.status(500).json({ success: false, message: "Failed to list locations" });
    }
  }

  async get(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const loc = await locationService.get(req.params.id, user.id);
      if (!loc) {
        res.status(404).json({ success: false, message: "Location not found" });
        return;
      }
      res.json({ success: true, location: loc });
    } catch (error) {
      console.error("Error fetching location:", error);
      res.status(500).json({ success: false, message: "Failed to fetch location" });
    }
  }

  async create(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const parsed = createLocationSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", errors: parsed.error.flatten() });
        return;
      }
      const created = await locationService.create(parsed.data, user.id);
      if (!created) {
        res.status(403).json({ success: false, message: "Not a member of this institute" });
        return;
      }
      res.status(201).json({ success: true, location: created });
    } catch (error) {
      console.error("Error creating location:", error);
      res.status(500).json({ success: false, message: "Failed to create location" });
    }
  }

  async update(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const parsed = updateLocationSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", errors: parsed.error.flatten() });
        return;
      }
      const updated = await locationService.update(req.params.id, parsed.data, user.id);
      if (!updated) {
        res.status(404).json({ success: false, message: "Location not found or access denied" });
        return;
      }
      res.json({ success: true, location: updated });
    } catch (error) {
      console.error("Error updating location:", error);
      res.status(500).json({ success: false, message: "Failed to update location" });
    }
  }

  async remove(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const deleted = await locationService.remove(req.params.id, user.id);
      if (!deleted) {
        res.status(404).json({ success: false, message: "Location not found or access denied" });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting location:", error);
      res.status(500).json({ success: false, message: "Failed to delete location" });
    }
  }

  async geocode(req: Request, res: Response): Promise<void> {
    try {
      const parsed = geocodeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "address is required" });
        return;
      }
      const result = await locationService.geocodeAddress(parsed.data.address);
      if (!result) {
        res.status(404).json({ success: false, message: "Could not resolve that address" });
        return;
      }
      res.json({ success: true, ...result });
    } catch (error) {
      console.error("Error geocoding address:", error);
      res.status(500).json({ success: false, message: "Failed to geocode address" });
    }
  }
}

export const locationController = new LocationController();
