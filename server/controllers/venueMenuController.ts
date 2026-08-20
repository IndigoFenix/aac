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
import { venueResolutionService } from "../services/venue-menus/venue-resolution-service";
import { getStudentAllergies } from "../services/venue-menus/student-allergies";
import { webMenuService } from "../services/venue-menus/web-menu-service";
import { MAX_FRAMES } from "../services/venue-menus/camera-extraction";
import { resolveVenueMenuSettings, needsReview, isSourceEnabled } from "@shared/venue-menus";

/** A base64 JPEG, with or without its data-URL prefix. */
const frameSchema = z.string().min(1);

const captureSchema = z.object({
  studentId: z.string().min(1),
  venueId: z.string().min(1),
  frames: z.array(frameSchema).min(1).max(MAX_FRAMES),
  expectedLanguage: z.string().max(16).optional(),
});

/**
 * A GPS fix. In the BODY, never the query string — a coordinate is personal
 * data and must not land in a URL, a log line, or a referrer header.
 */
const nearbySchema = z.object({
  studentId: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** True only when a caretaker pressed "search near me" (§3, requirement 5). */
  allowOutboundSearch: z.boolean().optional(),
});

const fetchWebSchema = z.object({
  studentId: z.string().min(1),
  venueId: z.string().min(1),
});

const confirmVenueSchema = z.object({
  venueId: z.string().min(1),
  label: z.string().max(120).optional(),
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

      // A student with recorded allergies gets every menu reviewed when the
      // setting says so (§4.7) — a per-student decision, so it lives in AAC
      // settings rather than in the capture path.
      const allergies = await getStudentAllergies(studentId);

      const result = await menuCaptureService.captureFromCamera({
        venueId,
        frames,
        requireReview: needsReview(settings.requireReview, "camera", {
          hasAllergies: allergies.length > 0,
          requireReviewWithAllergies: settings.requireReviewWithAllergies,
        }),
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

  /**
   * POST /api/venue-menus/nearby — which restaurant is the student at?
   *
   * POST rather than GET because the body carries a coordinate. The outbound
   * tier runs only when `allowOutboundSearch` says a caretaker asked for it,
   * and it carries the position and NOTHING ELSE — no student id ever leaves
   * this server.
   */
  async resolveNearby(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const parsed = nearbySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "error:INVALID_LOCATION" });
        return;
      }
      const { studentId, latitude, longitude, allowOutboundSearch } = parsed.data;

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

      const settings = resolveVenueMenuSettings(
        student.aacSettings?.venueMenus,
        {
          birthDate: student.birthDate,
          languageLevel: student.aacSettings?.languageLevel ?? null,
        },
        new Date(),
      );

      if (!settings.enabled) {
        res.status(403).json({ success: false, message: "error:VENUE_MENUS_DISABLED" });
        return;
      }

      const result = await venueResolutionService.resolveNearby({
        studentId,
        gps: { latitude, longitude },
        settings,
        allowOutboundSearch: !!allowOutboundSearch,
      });

      res.json({ success: true, ...result });
    } catch (error) {
      console.error("Error resolving nearby venues:", error);
      res.status(500).json({ success: false, message: "error:VENUE_SEARCH_FAILED" });
    }
  }

  /**
   * POST /api/students/:studentId/venues — the caretaker's choice.
   *
   * This tap is what collapses the food-court case, and recording it means a
   * later visit resolves from tier 1 without asking again.
   */
  async confirmVenue(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const { studentId } = req.params;
      const parsed = confirmVenueSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "error:INVALID_VENUE_SELECTION" });
        return;
      }

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, user.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "error:NO_STUDENT_ACCESS" });
        return;
      }

      const venue = await venueRepository.getById(parsed.data.venueId);
      if (!venue) {
        res.status(404).json({ success: false, message: "error:VENUE_NOT_FOUND" });
        return;
      }

      const link = await venueResolutionService.confirmVenue(
        studentId,
        parsed.data.venueId,
        parsed.data.label,
      );
      res.json({ success: true, link, venue });
    } catch (error) {
      console.error("Error confirming venue:", error);
      res.status(500).json({ success: false, message: "error:VENUE_CONFIRM_FAILED" });
    }
  }

  /** GET /api/students/:studentId/venues — the places this student eats. */
  async listStudentVenues(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const { studentId } = req.params;

      const { hasAccess } = await studentService.verifyStudentAccess(studentId, user.id);
      if (!hasAccess) {
        res.status(403).json({ success: false, message: "error:NO_STUDENT_ACCESS" });
        return;
      }

      const links = await venueRepository.listForStudent(studentId);
      const venues = await Promise.all(links.map((link) => venueRepository.getById(link.venueId)));

      res.json({
        success: true,
        venues: links.map((link, i) => ({ link, venue: venues[i] ?? null })),
      });
    } catch (error) {
      console.error("Error listing student venues:", error);
      res.status(500).json({ success: false, message: "error:VENUE_LIST_FAILED" });
    }
  }

  /**
   * POST /api/venue-menus/fetch-web — try to find this venue's menu online.
   *
   * A caretaker action, never automatic: it costs money, it leaves the
   * building, and §4.2a puts the camera above it for trust anyway. The whole
   * point of offering it is the first visit, where there is no photograph yet.
   *
   * Every failure mode returns the same message to a caretaker, because they
   * all mean the same thing at the table: photograph the menu instead.
   */
  async fetchWebMenu(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const parsed = fetchWebSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "error:INVALID_CAPTURE_REQUEST" });
        return;
      }
      const { studentId, venueId } = parsed.data;

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

      const settings = resolveVenueMenuSettings(
        student.aacSettings?.venueMenus,
        {
          birthDate: student.birthDate,
          languageLevel: student.aacSettings?.languageLevel ?? null,
        },
        new Date(),
      );

      // The web source is OFF by default (§4.7) and the master switch outranks
      // the per-source toggle — both folded into isSourceEnabled.
      if (!isSourceEnabled(settings, "web")) {
        res.status(403).json({ success: false, message: "error:VENUE_MENUS_DISABLED" });
        return;
      }

      const allergies = await getStudentAllergies(studentId);

      const result = await webMenuService.fetchForVenue({
        venueId,
        requireReview: needsReview(settings.requireReview, "web", {
          hasAllergies: allergies.length > 0,
          requireReviewWithAllergies: settings.requireReviewWithAllergies,
        }),
        ...(student.primaryLanguage ? { targetLanguage: student.primaryLanguage } : {}),
      });

      if (!result.ok) {
        // A binding refusal is the system working. It is reported distinctly
        // from a plain miss so a caretaker learns the menu we found was for a
        // different branch, rather than assuming the restaurant has no site.
        const message =
          result.reason === "binding_refused"
            ? "error:MENU_BINDING_REFUSED"
            : result.reason === "unknown_venue"
              ? "error:VENUE_NOT_FOUND"
              : "error:WEB_MENU_UNAVAILABLE";
        res.status(result.reason === "unknown_venue" ? 404 : 422).json({
          success: false,
          message,
          reason: result.reason,
        });
        return;
      }

      res.json({
        success: true,
        menuId: result.menu.id,
        status: result.status,
        reviewReasons: result.reviewReasons,
        itemCount: result.items.length,
        sourceUrl: result.sourceUrl,
        droppedByRefinement: result.droppedByRefinement,
      });
    } catch (error) {
      console.error("Error fetching web menu:", error);
      res.status(500).json({ success: false, message: "error:WEB_MENU_UNAVAILABLE" });
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
