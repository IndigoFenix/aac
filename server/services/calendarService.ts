// server/services/calendarService.ts
// Business logic for calendar events

import { calendarRepository } from "../repositories/calendarRepository";
import { instituteRepository } from "../repositories";
import type {
  CalendarEvent,
  InsertCalendarEvent,
  UpdateCalendarEvent,
  CalendarEventAttendee,
} from "@shared/schema";

class CalendarService {
  /**
   * Create a new event. The creator is always added as an attendee.
   */
  async createEvent(
    data: InsertCalendarEvent,
    userId: string,
    additionalAttendees?: { attendeeType: "user" | "student" | "classroom" | "institute"; attendeeId: string }[],
  ): Promise<CalendarEvent & { attendees: CalendarEventAttendee[] }> {
    const event = await calendarRepository.createEvent(data, userId);

    // Auto-add the creator as an attendee
    const allAttendees: CalendarEventAttendee[] = [];
    allAttendees.push(await calendarRepository.addAttendee({
      eventId: event.id,
      attendeeType: "user",
      attendeeId: userId,
    }));

    // Add any additional attendees
    if (additionalAttendees) {
      for (const att of additionalAttendees) {
        allAttendees.push(await calendarRepository.addAttendee({
          eventId: event.id,
          attendeeType: att.attendeeType,
          attendeeId: att.attendeeId,
        }));
      }
    }

    return { ...event, attendees: allAttendees };
  }

  async getEvent(eventId: string, userId: string) {
    const event = await calendarRepository.getEventById(eventId);
    if (!event) return undefined;

    const attendees = await calendarRepository.getAttendeesByEventId(eventId);

    // Verify the user can see this event
    const attendeeKeys = await this.getUserAttendeeKeys(userId);
    const canSee = attendees.some((att) =>
      attendeeKeys.some((k) => k.type === att.attendeeType && k.id === att.attendeeId),
    );

    if (!canSee) return undefined;

    return { ...event, attendees };
  }

  async updateEvent(eventId: string, updates: UpdateCalendarEvent, userId: string) {
    // Verify ownership or access
    const event = await calendarRepository.getEventById(eventId);
    if (!event) return undefined;

    const attendees = await calendarRepository.getAttendeesByEventId(eventId);
    const attendeeKeys = await this.getUserAttendeeKeys(userId);
    const canAccess = attendees.some((att) =>
      attendeeKeys.some((k) => k.type === att.attendeeType && k.id === att.attendeeId),
    );
    if (!canAccess) return undefined;

    return calendarRepository.updateEvent(eventId, updates);
  }

  async deleteEvent(eventId: string, userId: string): Promise<boolean> {
    const event = await calendarRepository.getEventById(eventId);
    if (!event) return false;

    // Only creator can delete
    if (event.createdByUserId !== userId) return false;

    return calendarRepository.deleteEvent(eventId);
  }

  async addAttendee(
    eventId: string,
    attendeeType: "user" | "student" | "classroom" | "institute",
    attendeeId: string,
    userId: string,
  ): Promise<CalendarEventAttendee | undefined> {
    // Verify the user has access to this event
    const event = await this.getEvent(eventId, userId);
    if (!event) return undefined;

    return calendarRepository.addAttendee({ eventId, attendeeType, attendeeId });
  }

  async removeAttendee(
    eventId: string,
    attendeeType: string,
    attendeeId: string,
    userId: string,
  ): Promise<boolean> {
    const event = await this.getEvent(eventId, userId);
    if (!event) return false;

    return calendarRepository.removeAttendee(eventId, attendeeType, attendeeId);
  }

  /**
   * Sync attendees for an event: add missing, remove extra.
   * The creator (user) attendee is always preserved.
   */
  async syncAttendees(
    eventId: string,
    desired: { attendeeType: "user" | "student" | "classroom" | "institute"; attendeeId: string }[],
    userId: string,
  ): Promise<void> {
    const event = await calendarRepository.getEventById(eventId);
    if (!event) return;

    const existing = await calendarRepository.getAttendeesByEventId(eventId);

    // Always keep the creator as attendee
    const desiredWithCreator = [
      ...desired,
      { attendeeType: "user" as const, attendeeId: event.createdByUserId },
    ];

    // Remove attendees that are not in desired list
    for (const att of existing) {
      const shouldKeep = desiredWithCreator.some(
        (d) => d.attendeeType === att.attendeeType && d.attendeeId === att.attendeeId,
      );
      if (!shouldKeep) {
        await calendarRepository.removeAttendee(eventId, att.attendeeType, att.attendeeId);
      }
    }

    // Add attendees that are not yet present
    for (const d of desiredWithCreator) {
      const alreadyExists = existing.some(
        (att) => att.attendeeType === d.attendeeType && att.attendeeId === d.attendeeId,
      );
      if (!alreadyExists) {
        await calendarRepository.addAttendee({ eventId, attendeeType: d.attendeeType, attendeeId: d.attendeeId });
      }
    }
  }

  /**
   * Get events visible to a user within a date range.
   */
  async getEventsForUser(
    userId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<(CalendarEvent & { attendees: CalendarEventAttendee[] })[]> {
    const attendeeKeys = await this.getUserAttendeeKeys(userId);
    return calendarRepository.getEventsForAttendees(attendeeKeys, startDate, endDate);
  }

  /**
   * Get events happening within a timeframe for AI prompt context.
   * Returns a simplified list suitable for embedding in a prompt.
   */
  async getUpcomingEventsForPrompt(
    userId: string,
    hoursAhead: number = 24,
    hoursBehind: number = 2,
  ): Promise<{ title: string; start: string; end: string; allDay: boolean }[]> {
    const now = new Date();
    const startDate = new Date(now.getTime() - hoursBehind * 60 * 60 * 1000);
    const endDate = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

    const events = await this.getEventsForUser(userId, startDate, endDate);

    return events.map((e) => ({
      title: e.title,
      start: e.startTime.toISOString(),
      end: e.endTime.toISOString(),
      allDay: e.allDay,
    }));
  }

  /**
   * Build the list of attendee keys that a user is connected to:
   * - The user themselves
   * - Students linked to the user
   * - Institutes the user belongs to
   * - Classrooms the user belongs to
   */
  private async getUserAttendeeKeys(userId: string): Promise<{ type: string; id: string }[]> {
    const keys: { type: string; id: string }[] = [{ type: "user", id: userId }];

    // Lazy imports to avoid circular dependencies
    const { studentRepository } = await import("../repositories");
    const { classroomRepository } = await import("../repositories");

    // Students
    const students = await studentRepository.getStudentsByUserId(userId);
    for (const s of students) {
      keys.push({ type: "student", id: s.id });
    }

    // Institutes
    const institutes = await instituteRepository.getInstitutesByUserId(userId);
    for (const inst of institutes) {
      keys.push({ type: "institute", id: inst.id });
    }

    // Classrooms
    const classrooms = await classroomRepository.getClassroomsByUserId(userId);
    for (const cr of classrooms) {
      keys.push({ type: "classroom", id: cr.classroom.id });
    }

    return keys;
  }
}

export const calendarService = new CalendarService();
