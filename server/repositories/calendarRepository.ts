// server/repositories/calendarRepository.ts
// Repository for calendar event operations

import {
  calendarEvents,
  calendarEventAttendees,
  type CalendarEvent,
  type InsertCalendarEvent,
  type UpdateCalendarEvent,
  type CalendarEventAttendee,
  type InsertEventAttendee,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, gte, lte, or, inArray, desc } from "drizzle-orm";

/**
 * OR'd visibility criteria. An event is visible if ANY of these match.
 * The service layer builds this per the plan's visibility rules.
 */
export interface VisibilityCriteria {
  /** Attendee rows matching any of these keys (user, student, classroom, institute). */
  attendees: Array<{ type: string; id: string }>;
  /** calendar_events.institute_id ∈ this list. */
  instituteIds: string[];
  /** calendar_events.classroom_id ∈ this list. */
  classroomIds: string[];
  /** calendar_events.service_id ∈ this list. */
  serviceIds: string[];
}

export class CalendarRepository {
  async createEvent(data: InsertCalendarEvent, createdByUserId: string): Promise<CalendarEvent> {
    const [event] = await db
      .insert(calendarEvents)
      .values({
        ...data,
        createdByUserId,
        repeatDays: data.repeatDays ? (data.repeatDays as number[]) : undefined,
      })
      .returning();
    return event;
  }

  async getEventById(id: string): Promise<CalendarEvent | undefined> {
    const [event] = await db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, id));
    return event || undefined;
  }

  async updateEvent(id: string, updates: UpdateCalendarEvent): Promise<CalendarEvent | undefined> {
    const [event] = await db
      .update(calendarEvents)
      .set({
        ...updates,
        updatedAt: new Date(),
        repeatDays: updates.repeatDays ? (updates.repeatDays as number[]) : updates.repeatDays,
      })
      .where(eq(calendarEvents.id, id))
      .returning();
    return event || undefined;
  }

  async deleteEvent(id: string): Promise<boolean> {
    const [result] = await db
      .delete(calendarEvents)
      .where(eq(calendarEvents.id, id))
      .returning({ id: calendarEvents.id });
    return !!result;
  }

  // ---- Attendees ----

  async addAttendee(data: InsertEventAttendee): Promise<CalendarEventAttendee> {
    const [att] = await db
      .insert(calendarEventAttendees)
      .values(data)
      .returning();
    return att;
  }

  async removeAttendee(eventId: string, attendeeType: string, attendeeId: string): Promise<boolean> {
    const [result] = await db
      .delete(calendarEventAttendees)
      .where(
        and(
          eq(calendarEventAttendees.eventId, eventId),
          eq(calendarEventAttendees.attendeeType, attendeeType as any),
          eq(calendarEventAttendees.attendeeId, attendeeId),
        ),
      )
      .returning({ id: calendarEventAttendees.id });
    return !!result;
  }

  async getAttendeesByEventId(eventId: string): Promise<CalendarEventAttendee[]> {
    return db
      .select()
      .from(calendarEventAttendees)
      .where(eq(calendarEventAttendees.eventId, eventId));
  }

  /**
   * Update an attendee's RSVP status. Returns the updated row, or undefined if
   * no matching attendee exists.
   */
  async setAttendeeInviteStatus(
    eventId: string,
    attendeeType: "user" | "student",
    attendeeId: string,
    status: "pending" | "accepted" | "declined",
  ): Promise<CalendarEventAttendee | undefined> {
    const [row] = await db
      .update(calendarEventAttendees)
      .set({ inviteStatus: status })
      .where(
        and(
          eq(calendarEventAttendees.eventId, eventId),
          eq(calendarEventAttendees.attendeeType, attendeeType),
          eq(calendarEventAttendees.attendeeId, attendeeId),
        ),
      )
      .returning();
    return row || undefined;
  }

  async getEventsByServiceId(
    serviceId: string,
  ): Promise<(CalendarEvent & { attendees: CalendarEventAttendee[] })[]> {
    const events = await db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.serviceId, serviceId))
      .orderBy(calendarEvents.startTime);

    if (events.length === 0) return [];

    const attendees = await db
      .select()
      .from(calendarEventAttendees)
      .where(inArray(calendarEventAttendees.eventId, events.map((e) => e.id)));

    const attendeesByEvent = new Map<string, CalendarEventAttendee[]>();
    for (const att of attendees) {
      const list = attendeesByEvent.get(att.eventId) || [];
      list.push(att);
      attendeesByEvent.set(att.eventId, list);
    }

    return events.map((event) => ({
      ...event,
      attendees: attendeesByEvent.get(event.id) || [],
    }));
  }

  // ---- Queries ----

  /**
   * Get events in a date range that match any of the supplied OR'd visibility
   * criteria: attendee row match OR FK match on institute/classroom/service.
   * The service layer builds these criteria per the plan's visibility rules.
   */
  async getVisibleEvents(
    criteria: VisibilityCriteria,
    startDate: Date,
    endDate: Date,
  ): Promise<(CalendarEvent & { attendees: CalendarEventAttendee[] })[]> {
    const { attendees: attendeeKeys, instituteIds, classroomIds, serviceIds } = criteria;
    if (
      attendeeKeys.length === 0 &&
      instituteIds.length === 0 &&
      classroomIds.length === 0 &&
      serviceIds.length === 0
    ) {
      return [];
    }

    // Step 1: collect candidate event IDs from attendee matches (if any)
    let attendeeEventIds: string[] = [];
    if (attendeeKeys.length > 0) {
      const conditions = attendeeKeys.map((k) =>
        and(
          eq(calendarEventAttendees.attendeeType, k.type as any),
          eq(calendarEventAttendees.attendeeId, k.id),
        ),
      );
      const rows = await db
        .select({ eventId: calendarEventAttendees.eventId })
        .from(calendarEventAttendees)
        .where(or(...conditions));
      attendeeEventIds = [...new Set(rows.map((r) => r.eventId))];
    }

    // Step 2: build the visibility OR: id ∈ attendeeEventIds OR FK match.
    const visibilityClauses: any[] = [];
    if (attendeeEventIds.length > 0) {
      visibilityClauses.push(inArray(calendarEvents.id, attendeeEventIds));
    }
    if (instituteIds.length > 0) {
      visibilityClauses.push(inArray(calendarEvents.instituteId, instituteIds));
    }
    if (classroomIds.length > 0) {
      visibilityClauses.push(inArray(calendarEvents.classroomId, classroomIds));
    }
    if (serviceIds.length > 0) {
      visibilityClauses.push(inArray(calendarEvents.serviceId, serviceIds));
    }
    if (visibilityClauses.length === 0) return [];

    // Step 3: date-range filter — one-off overlaps, recurring starts before range end
    // and recurrence end (if any) is after range start.
    const events = await db
      .select()
      .from(calendarEvents)
      .where(
        and(
          or(...visibilityClauses),
          or(
            and(
              eq(calendarEvents.repeatType, "none"),
              lte(calendarEvents.startTime, endDate),
              gte(calendarEvents.endTime, startDate),
            ),
            and(
              or(
                eq(calendarEvents.repeatType, "daily"),
                eq(calendarEvents.repeatType, "weekly"),
                eq(calendarEvents.repeatType, "monthly_date"),
                eq(calendarEvents.repeatType, "monthly_weekday"),
              ),
              lte(calendarEvents.startTime, endDate),
              or(
                eq(calendarEvents.repeatEndDate, null as any),
                gte(calendarEvents.repeatEndDate, startDate),
              ),
            ),
          ),
        ),
      )
      .orderBy(calendarEvents.startTime);

    if (events.length === 0) return [];

    const allAttendees = await db
      .select()
      .from(calendarEventAttendees)
      .where(inArray(calendarEventAttendees.eventId, events.map((e) => e.id)));

    const attendeesByEvent = new Map<string, CalendarEventAttendee[]>();
    for (const att of allAttendees) {
      const list = attendeesByEvent.get(att.eventId) || [];
      list.push(att);
      attendeesByEvent.set(att.eventId, list);
    }

    return events.map((event) => ({
      ...event,
      attendees: attendeesByEvent.get(event.id) || [],
    }));
  }

  /** @deprecated Use getVisibleEvents. Kept for legacy callers during transition. */
  async getEventsForAttendees(
    attendeeKeys: { type: string; id: string }[],
    startDate: Date,
    endDate: Date,
  ): Promise<(CalendarEvent & { attendees: CalendarEventAttendee[] })[]> {
    return this.getVisibleEvents(
      { attendees: attendeeKeys, instituteIds: [], classroomIds: [], serviceIds: [] },
      startDate,
      endDate,
    );
  }

  /**
   * Expand recurring events into individual occurrence dates within a date range.
   * Non-repeating events are returned as-is. Recurring events generate one entry
   * per occurrence date within [rangeStart, rangeEnd].
   */
  expandRecurringEvents(
    events: CalendarEvent[],
    rangeStart: Date,
    rangeEnd: Date
  ): { event: CalendarEvent; date: Date }[] {
    const result: { event: CalendarEvent; date: Date }[] = [];

    for (const ev of events) {
      const evStart = new Date(ev.startTime);

      if (ev.repeatType === 'none') {
        result.push({ event: ev, date: evStart });
        continue;
      }

      const repeatEnd = ev.repeatEndDate ? new Date(ev.repeatEndDate) : rangeEnd;
      const limit = new Date(Math.min(repeatEnd.getTime(), rangeEnd.getTime()));

      if (ev.repeatType === 'daily') {
        const cursor = new Date(Math.max(evStart.getTime(), rangeStart.getTime()));
        cursor.setHours(evStart.getHours(), evStart.getMinutes(), 0, 0);
        while (cursor <= limit) {
          result.push({ event: ev, date: new Date(cursor) });
          cursor.setDate(cursor.getDate() + 1);
        }
      } else if (ev.repeatType === 'weekly' && ev.repeatDays) {
        const days = ev.repeatDays as number[];
        const interval = (ev as any).repeatInterval || 1;
        const cursor = new Date(Math.max(evStart.getTime(), rangeStart.getTime()));
        cursor.setHours(evStart.getHours(), evStart.getMinutes(), 0, 0);
        const evWeekStart = new Date(evStart);
        evWeekStart.setDate(evWeekStart.getDate() - evWeekStart.getDay());
        cursor.setDate(cursor.getDate() - cursor.getDay());
        if (interval > 1) {
          const weeksDiff = Math.round((cursor.getTime() - evWeekStart.getTime()) / (7 * 86400000));
          const offset = weeksDiff % interval;
          if (offset !== 0) cursor.setDate(cursor.getDate() + (interval - offset) * 7);
        }
        while (cursor <= limit) {
          for (const day of days) {
            const d = new Date(cursor);
            d.setDate(d.getDate() + day);
            if (d >= rangeStart && d <= limit && d >= evStart) {
              result.push({ event: ev, date: new Date(d) });
            }
          }
          cursor.setDate(cursor.getDate() + 7 * interval);
        }
      } else if (ev.repeatType === 'monthly_date') {
        const dayOfMonth = evStart.getDate();
        const cursor = new Date(Math.max(evStart.getTime(), rangeStart.getTime()));
        cursor.setHours(evStart.getHours(), evStart.getMinutes(), 0, 0);
        cursor.setDate(1);
        while (cursor <= limit) {
          const d = new Date(cursor);
          d.setDate(dayOfMonth);
          if (d.getMonth() === cursor.getMonth() && d >= rangeStart && d <= limit && d >= evStart) {
            result.push({ event: ev, date: new Date(d) });
          }
          cursor.setMonth(cursor.getMonth() + 1);
        }
      } else if (ev.repeatType === 'monthly_weekday') {
        const targetDay = evStart.getDay();
        const monthWeek = (ev as any).repeatMonthWeek || 1;
        const cursor = new Date(Math.max(evStart.getTime(), rangeStart.getTime()));
        cursor.setHours(evStart.getHours(), evStart.getMinutes(), 0, 0);
        cursor.setDate(1);
        while (cursor <= limit) {
          let d: Date | null = null;
          if (monthWeek === -1) {
            const lastDay = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
            lastDay.setHours(evStart.getHours(), evStart.getMinutes(), 0, 0);
            while (lastDay.getDay() !== targetDay) lastDay.setDate(lastDay.getDate() - 1);
            d = lastDay;
          } else {
            const first = new Date(cursor);
            while (first.getDay() !== targetDay) first.setDate(first.getDate() + 1);
            first.setDate(first.getDate() + (monthWeek - 1) * 7);
            first.setHours(evStart.getHours(), evStart.getMinutes(), 0, 0);
            if (first.getMonth() === cursor.getMonth()) d = first;
          }
          if (d && d >= rangeStart && d <= limit && d >= evStart) {
            result.push({ event: ev, date: new Date(d) });
          }
          cursor.setMonth(cursor.getMonth() + 1);
        }
      }
    }

    result.sort((a, b) => a.date.getTime() - b.date.getTime());
    return result;
  }
}

export const calendarRepository = new CalendarRepository();
