// server/controllers/calendarController.ts
// Controller for calendar event endpoints

import type { Request, Response } from "express";
import { calendarService } from "../services/calendarService";
import { CalendarValidationError } from "../services/calendar-validation";
import { z } from "zod";

const createEventSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  startTime: z.string().transform((s) => new Date(s)),
  endTime: z.string().transform((s) => new Date(s)),
  allDay: z.boolean().optional().default(false),
  repeatType: z.enum(["none", "daily", "weekly", "monthly_date", "monthly_weekday"]).optional().default("none"),
  repeatInterval: z.number().int().min(1).max(4).optional().default(1),
  repeatDays: z.array(z.number().min(0).max(6)).optional(),
  repeatMonthWeek: z.number().int().optional(), // 1, 2, 3, or -1
  repeatEndDate: z.string().transform((s) => new Date(s)).optional(),
  serviceId: z.string().optional().nullable(),
  timezone: z.string().optional(), // IANA TZ; event times are UTC, TZ is informational
  attendees: z
    .array(
      z.object({
        attendeeType: z.enum(["user", "student", "classroom", "institute"]),
        attendeeId: z.string(),
      }),
    )
    .optional(),
  locationIds: z.array(z.string()).optional(),
});

const updateEventSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  startTime: z
    .string()
    .transform((s) => new Date(s))
    .optional(),
  endTime: z
    .string()
    .transform((s) => new Date(s))
    .optional(),
  allDay: z.boolean().optional(),
  repeatType: z.enum(["none", "daily", "weekly", "monthly_date", "monthly_weekday"]).optional(),
  repeatInterval: z.number().int().min(1).max(4).optional().nullable(),
  repeatDays: z.array(z.number().min(0).max(6)).optional().nullable(),
  repeatMonthWeek: z.number().int().optional().nullable(),
  repeatEndDate: z
    .string()
    .transform((s) => new Date(s))
    .optional()
    .nullable(),
  serviceId: z.string().optional().nullable(),
  timezone: z.string().optional(),
  attendees: z
    .array(
      z.object({
        attendeeType: z.enum(["user", "student", "classroom", "institute"]),
        attendeeId: z.string(),
      }),
    )
    .optional(),
  locationIds: z.array(z.string()).optional(),
});

const addAttendeeSchema = z.object({
  attendeeType: z.enum(["user", "student", "classroom", "institute"]),
  attendeeId: z.string(),
});

const rsvpSchema = z.object({
  status: z.enum(["pending", "accepted", "declined"]),
});

class CalendarController {
  async getEvents(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const { startDate, endDate, timezone: _tz, studentId, instituteId } = req.query;

      if (!startDate || !endDate) {
        res.status(400).json({ success: false, message: "startDate and endDate are required" });
        return;
      }

      // `timezone` is accepted for future use (e.g. derived-field formatting).
      // Event times stored/returned in UTC; client converts on render.
      const events = await calendarService.getEventsForUser(
        user.id,
        new Date(startDate as string),
        new Date(endDate as string),
        {
          selectedStudentId: typeof studentId === "string" && studentId ? studentId : undefined,
          selectedInstituteId: typeof instituteId === "string" && instituteId ? instituteId : undefined,
        },
      );

      // Build reduced views for events visible only via the selected student —
      // per plan, their participant list is hidden to avoid cross-institute leakage.
      const reduced = await calendarService.applyReducedView(events, user.id, {
        selectedStudentId: typeof studentId === "string" && studentId ? studentId : undefined,
        selectedInstituteId: typeof instituteId === "string" && instituteId ? instituteId : undefined,
      });

      res.json({ success: true, events: reduced });
    } catch (error: any) {
      console.error("Error fetching calendar events:", error);
      res.status(500).json({ success: false, message: "Failed to fetch events" });
    }
  }

  async getEvent(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const event = await calendarService.getEvent(req.params.id, user.id);

      if (!event) {
        res.status(404).json({ success: false, message: "Event not found" });
        return;
      }

      res.json({ success: true, event });
    } catch (error: any) {
      console.error("Error fetching calendar event:", error);
      res.status(500).json({ success: false, message: "Failed to fetch event" });
    }
  }

  async createEvent(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const parsed = createEventSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", errors: parsed.error.flatten() });
        return;
      }

      const { attendees, locationIds, timezone: _tz, ...eventData } = parsed.data;

      const created = await calendarService.createEvent(eventData as any, user.id, attendees, locationIds);

      res.status(201).json({ success: true, event: created });
    } catch (error: any) {
      if (error instanceof CalendarValidationError) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      console.error("Error creating calendar event:", error);
      res.status(500).json({ success: false, message: "Failed to create event" });
    }
  }

  async updateEvent(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const parsed = updateEventSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", errors: parsed.error.flatten() });
        return;
      }

      const { attendees, locationIds, timezone: _tz, ...eventData } = parsed.data;

      const updated = await calendarService.updateEvent(req.params.id, eventData as any, user.id);
      if (!updated) {
        res.status(404).json({ success: false, message: "Event not found or access denied" });
        return;
      }

      // Sync attendees if provided
      if (attendees !== undefined) {
        await calendarService.syncAttendees(req.params.id, attendees, user.id);
      }

      // Sync locations if provided (updateEvent already verified edit rights)
      if (locationIds !== undefined) {
        await calendarService.syncEventLocations(req.params.id, locationIds);
      }

      // Re-fetch with attendees
      const full = await calendarService.getEvent(req.params.id, user.id);
      res.json({ success: true, event: full });
    } catch (error: any) {
      if (error instanceof CalendarValidationError) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      res.status(500).json({ success: false, message: "Failed to update event" });
    }
  }

  async deleteEvent(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const deleted = await calendarService.deleteEvent(req.params.id, user.id);

      if (!deleted) {
        res.status(404).json({ success: false, message: "Event not found or access denied" });
        return;
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting calendar event:", error);
      res.status(500).json({ success: false, message: "Failed to delete event" });
    }
  }

  async addAttendee(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const parsed = addAttendeeSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", errors: parsed.error.flatten() });
        return;
      }

      const attendee = await calendarService.addAttendee(
        req.params.id,
        parsed.data.attendeeType,
        parsed.data.attendeeId,
        user.id,
      );

      if (!attendee) {
        res.status(404).json({ success: false, message: "Event not found or access denied" });
        return;
      }

      res.status(201).json({ success: true, attendee });
    } catch (error: any) {
      console.error("Error adding attendee:", error);
      res.status(500).json({ success: false, message: "Failed to add attendee" });
    }
  }

  async setRsvp(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const parsed = rsvpSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, message: "Invalid input", errors: parsed.error.flatten() });
        return;
      }
      const updated = await calendarService.setRsvp(req.params.id, user.id, parsed.data.status);
      if (!updated) {
        res.status(404).json({ success: false, message: "Event not found or you are not an invitee" });
        return;
      }
      res.json({ success: true, attendee: updated });
    } catch (error: any) {
      console.error("Error setting RSVP:", error);
      res.status(500).json({ success: false, message: "Failed to set RSVP" });
    }
  }

  async removeAttendee(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user as any;
      const { attendeeType, attendeeId } = req.params;

      const removed = await calendarService.removeAttendee(
        req.params.id,
        attendeeType,
        attendeeId,
        user.id,
      );

      if (!removed) {
        res.status(404).json({ success: false, message: "Attendee not found or access denied" });
        return;
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error("Error removing attendee:", error);
      res.status(500).json({ success: false, message: "Failed to remove attendee" });
    }
  }
}

export const calendarController = new CalendarController();
