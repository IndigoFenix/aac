// server/controllers/venueMenuController.ts
//
// Endpoints for Location Menus: capturing a menu from the camera, and the
// caretaker review surface that gates it.
//
// Access rules, and why they differ per route:
//   - Menus are NON-PHI public facts, so reading one needs only auth.
//   - Capturing and reviewing are done FOR a student, so both check
//     verifyStudentAccess — the review decision is recorded against a child.
//   - `reviewedByUserId` is never accepted from a body; the repository stamps
//     it from the session. Who approved a menu is an audit fact.
//
// See planning-docs/aac-restaurant-menus.md §4.2, §4.8.

import type { Request, Response } from "express";
import { z } from "zod";
import { studentService } from "../services/studentService";
import { venueRepository } from "../repositories/venueRepository";
import { menuCaptureService } from "../services/venue-menus/menu-capture-service";
import { MAX_FRAMES } from "../services/venue-menus/camera-extraction";
import { resolveVenueMenuSettings, needsReview } from "@shared/venue-menus";

/** A base64 JPEG, with or without its data-URL prefix. */
const frameSchema = z.string().min(1);

const captureSchema = z.object({
  studentId: z.string().min(1),
  venueId: z.string().min(1),
  frames: z.array(frameSchema).min(1).max(MAX_FRAMES),
  expectedLanguage: z.string().max(16).optional(),
});

const reviewSchema = z.object({
  studentId: z.string().min(1),
  status: z.enum(["approved", "rejected"]),
});

/** The caretaker's corrections. Only the fields a human may legitimately fix. */
const editSchema = z.object({
  studentId: z.string().min(1),
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        price: z.number().optional(),
        priceText: z.string().optional(),
        category: z.string().optional(),
        kind: z.enum(["food", "drink", "condiment", "notice", "unknown"]),
        imageKey: z.string().optional(),
        translatedName: z.string().optional(),
      }),
    )
    .max(400),
});

class VenueMenuController {
  /**
   * POST /api/venue-menus/capture — photograph a menu.
   *
   * The review policy is resolved SERVER-SIDE from the student's settings and
   * age (§4.8). A client does not get to say whether its own capture needs
   * review; the capture may then raise the bar further if it read badly.
   */
  async capture(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const parsed = captureSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "error:INVALID_CAPTURE_REQUEST" });
        return;
      }
      const { studentId, venueId, frames, expectedLanguage } = parsed.data;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, user.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "error:NO_STUDENT_ACCESS" });
        return;
      }

      const student = await studentService.getStudentById(studentId);
      if (!student) {
        res.status(404).json({ success: false, message: "error:STUDENT_NOT_FOUND" });
        return;
      }

      // Age comes from the student row, languageLevel and the settings object
      // from aac_settings — resolveVenueMenuSettings needs both to resolve the
      // 'auto' policies (§4.8).
      const settings = resolveVenueMenuSettings(
        student.aacSettings?.venueMenus,
        {
          birthDate: student.birthDate,
          languageLevel: student.aacSettings?.languageLevel ?? null,
        },
        new Date(),
      );

      if (!settings.enabled || !settings.sources.camera) {
        res.status(403).json({ success: false, message: "error:VENUE_MENUS_DISABLED" });
        return;
      }

      const result = await menuCaptureService.captureFromCamera({
        venueId,
        frames,
        requireReview: needsReview(settings.requireReview, "camera"),
        ...(student.primaryLanguage ? { targetLanguage: student.primaryLanguage } : {}),
        ...(expectedLanguage ? { expectedLanguage } : {}),
      });

      res.json({
        success: true,
        menuId: result.menu.id,
        status: result.status,
        // WHY review was required, if it was — so the capture screen can tell
        // the caretaker what to look at instead of just refusing to go live.
        reviewReasons: result.reviewReasons,
        itemCount: result.items.length,
        framesRead: result.framesRead,
        framesFailed: result.framesFailed,
        droppedDuplicates: result.droppedDuplicates,
        lowConfidenceCount: result.lowConfidenceCount,
        droppedByRefinement: result.droppedByRefinement,
      });
    } catch (error) {
      console.error("Error capturing venue menu:", error);
      res.status(500).json({ success: false, message: "error:MENU_CAPTURE_FAILED" });
    }
  }

  /** GET /api/venue-menus/:id — one menu, for the review screen. */
  async get(req: Request, res: Response): Promise<void> {
    try {
      const menu = await venueRepository.getMenuById(req.params.id);
      if (!menu) {
        res.status(404).json({ success: false, message: "error:MENU_NOT_FOUND" });
        return;
      }
      const venue = await venueRepository.getById(menu.venueId);
      res.json({ success: true, menu, venue: venue ?? null });
    } catch (error) {
      console.error("Error fetching venue menu:", error);
      res.status(500).json({ success: false, message: "error:MENU_FETCH_FAILED" });
    }
  }

  /**
   * GET /api/students/:studentId/venue-menus/pending — the review queue.
   *
   * Scoped through `student_venues`, so a caretaker sees only menus for venues
   * this student is linked to — never the global pending set.
   */
  async listPending(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const { studentId } = req.params;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, user.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "error:NO_STUDENT_ACCESS" });
        return;
      }

      const pending = await venueRepository.listPendingForStudent(studentId);
      res.json({ success: true, pending });
    } catch (error) {
      console.error("Error listing pending venue menus:", error);
      res.status(500).json({ success: false, message: "error:MENU_LIST_FAILED" });
    }
  }

  /** GET /api/venues/:venueId/menus — every menu for a venue, newest first. */
  async listForVenue(req: Request, res: Response): Promise<void> {
    try {
      const menus = await venueRepository.listMenus(req.params.venueId);
      res.json({ success: true, menus });
    } catch (error) {
      console.error("Error listing venue menus:", error);
      res.status(500).json({ success: false, message: "error:MENU_LIST_FAILED" });
    }
  }

  /**
   * PATCH /api/venue-menus/:id/items — the caretaker's corrections.
   *
   * Allowed BEFORE approval only. Once a menu is approved a student may already
   * be ordering from it, and silently swapping the items under them is how a
   * child ends up pressing a button that no longer means what they learned.
   * A correction after approval is a new capture.
   */
  async editItems(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const parsed = editSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "error:INVALID_MENU_ITEMS" });
        return;
      }

      const { hasAccess } = await studentService.verifyStudentAccess(parsed.data.studentId, user.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "error:NO_STUDENT_ACCESS" });
        return;
      }

      const menu = await venueRepository.getMenuById(req.params.id);
      if (!menu) {
        res.status(404).json({ success: false, message: "error:MENU_NOT_FOUND" });
        return;
      }
      if (menu.status !== "pending_review") {
        res.status(409).json({ success: false, message: "error:MENU_ALREADY_REVIEWED" });
        return;
      }

      const updated = await venueRepository.updateMenuItems(req.params.id, parsed.data.items);
      res.json({ success: true, menu: updated });
    } catch (error) {
      console.error("Error editing venue menu items:", error);
      res.status(500).json({ success: false, message: "error:MENU_EDIT_FAILED" });
    }
  }

  /** POST /api/venue-menus/:id/review — approve or reject. */
  async review(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const parsed = reviewSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "error:INVALID_REVIEW_REQUEST" });
        return;
      }

      const { hasAccess } = await studentService.verifyStudentAccess(parsed.data.studentId, user.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "error:NO_STUDENT_ACCESS" });
        return;
      }

      const menu = await venueRepository.getMenuById(req.params.id);
      if (!menu) {
        res.status(404).json({ success: false, message: "error:MENU_NOT_FOUND" });
        return;
      }
      if (menu.status !== "pending_review") {
        res.status(409).json({ success: false, message: "error:MENU_ALREADY_REVIEWED" });
        return;
      }

      const updated = await venueRepository.setMenuStatus(
        req.params.id,
        parsed.data.status,
        user.id,
      );
      res.json({ success: true, menu: updated });
    } catch (error) {
      console.error("Error reviewing venue menu:", error);
      res.status(500).json({ success: false, message: "error:MENU_REVIEW_FAILED" });
    }
  }
}

export const venueMenuController = new VenueMenuController();
