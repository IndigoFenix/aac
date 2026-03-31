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

  // ---- Queries ----

  /**
   * Get events in a date range where the user, their students, their institutes,
   * or their classrooms are attendees.
   */
  async getEventsForAttendees(
    attendeeKeys: { type: string; id: string }[],
    startDate: Date,
    endDate: Date,
  ): Promise<(CalendarEvent & { attendees: CalendarEventAttendee[] })[]> {
    if (attendeeKeys.length === 0) return [];

    // Step 1: find event IDs that match any attendee key
    const conditions = attendeeKeys.map((k) =>
      and(
        eq(calendarEventAttendees.attendeeType, k.type as any),
        eq(calendarEventAttendees.attendeeId, k.id),
      ),
    );

    const matchingAttendees = await db
      .select({ eventId: calendarEventAttendees.eventId })
      .from(calendarEventAttendees)
      .where(or(...conditions));

    const eventIds = [...new Set(matchingAttendees.map((a) => a.eventId))];
    if (eventIds.length === 0) return [];

    // Step 2: load events in the date range
    // An event is relevant if:
    //   - It's a one-off event within the range, OR
    //   - It's a recurring event whose start is before the range end
    //     and whose repeatEndDate (or infinity) is after the range start
    const events = await db
      .select()
      .from(calendarEvents)
      .where(
        and(
          inArray(calendarEvents.id, eventIds),
          or(
            // Non-repeating: event overlaps [startDate, endDate]
            and(
              eq(calendarEvents.repeatType, "none"),
              lte(calendarEvents.startTime, endDate),
              gte(calendarEvents.endTime, startDate),
            ),
            // Repeating: event starts before range end, recurrence hasn't ended before range start
            and(
              // Any recurring type
              or(
                eq(calendarEvents.repeatType, "daily"),
                eq(calendarEvents.repeatType, "weekly"),
                eq(calendarEvents.repeatType, "monthly_date"),
                eq(calendarEvents.repeatType, "monthly_weekday"),
              ),
              lte(calendarEvents.startTime, endDate),
              or(
                // no end date — infinite recurrence
                eq(calendarEvents.repeatEndDate, null as any),
                gte(calendarEvents.repeatEndDate, startDate),
              ),
            ),
          ),
        ),
      )
      .orderBy(calendarEvents.startTime);

    if (events.length === 0) return [];

    // Step 3: load all attendees for those events
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
