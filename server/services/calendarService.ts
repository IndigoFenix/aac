// server/services/calendarService.ts
// Business logic for calendar events

import { calendarRepository } from "../repositories/calendarRepository";
import { instituteRepository, programRepository } from "../repositories";
import type {
  CalendarEvent,
  InsertCalendarEvent,
  UpdateCalendarEvent,
  CalendarEventAttendee,
} from "@shared/schema";

type AttendeeInput = {
  attendeeType: "user" | "student" | "classroom" | "institute";
  attendeeId: string;
};

class CalendarService {
  /**
   * Create a new event. The creator is always added as an attendee.
   * If the event is linked to a service, the service's student, all assigned
   * service users, and the provider contact's linked user (if any) are also
   * auto-added.
   */
  async createEvent(
    data: InsertCalendarEvent,
    userId: string,
    additionalAttendees?: AttendeeInput[],
  ): Promise<CalendarEvent & { attendees: CalendarEventAttendee[] }> {
    const event = await calendarRepository.createEvent(data, userId);

    // Deduplicate as we go (type+id pair)
    const addedKeys = new Set<string>();
    const allAttendees: CalendarEventAttendee[] = [];
    const addAttendee = async (att: AttendeeInput) => {
      const key = `${att.attendeeType}:${att.attendeeId}`;
      if (addedKeys.has(key)) return;
      addedKeys.add(key);
      allAttendees.push(await calendarRepository.addAttendee({
        eventId: event.id,
        attendeeType: att.attendeeType,
        attendeeId: att.attendeeId,
      }));
    };

    // Creator is always an attendee
    await addAttendee({ attendeeType: "user", attendeeId: userId });

    // Auto-populate from the linked service, if any
    if (data.serviceId) {
      await this.addServiceAttendees(data.serviceId, addAttendee);
    }

    // Any explicit additional attendees
    if (additionalAttendees) {
      for (const att of additionalAttendees) {
        await addAttendee(att);
      }
    }

    return { ...event, attendees: allAttendees };
  }

  /**
   * Populate the student, service users, and linked provider user for a service.
   */
  private async addServiceAttendees(
    serviceId: string,
    addAttendee: (att: AttendeeInput) => Promise<void>,
  ): Promise<void> {
    const service = await programRepository.getServiceById(serviceId);
    if (!service) return;
    const program = await programRepository.getProgramById(service.programId);
    if (program?.studentId) {
      await addAttendee({ attendeeType: "student", attendeeId: program.studentId });
    }
    const links = await programRepository.getServiceUsers(serviceId);
    for (const l of links) {
      await addAttendee({ attendeeType: "user", attendeeId: l.userId });
    }
    if (service.providerContactId) {
      const contact = await programRepository.getStudentContactById(service.providerContactId);
      if (contact?.linkedUserId) {
        await addAttendee({ attendeeType: "user", attendeeId: contact.linkedUserId });
      }
    }
  }

  /** List events linked to a given service (no date window). */
  async getEventsByServiceId(
    serviceId: string,
  ): Promise<(CalendarEvent & { attendees: CalendarEventAttendee[] })[]> {
    return calendarRepository.getEventsByServiceId(serviceId);
  }

  async getEvent(eventId: string, userId: string) {
    const event = await calendarRepository.getEventById(eventId);
    if (!event) return undefined;

    const canSee = await this.canUserAccessEvent(eventId, userId);
    if (!canSee) return undefined;

    const attendees = await calendarRepository.getAttendeesByEventId(eventId);
    return { ...event, attendees };
  }

  async updateEvent(eventId: string, updates: UpdateCalendarEvent, userId: string) {
    const event = await calendarRepository.getEventById(eventId);
    if (!event) return undefined;

    const canEdit = await this.canUserEditEvent(event, userId);
    if (!canEdit) return undefined;

    return calendarRepository.updateEvent(eventId, updates);
  }

  async deleteEvent(eventId: string, userId: string): Promise<boolean> {
    const event = await calendarRepository.getEventById(eventId);
    if (!event) return false;

    const canEdit = await this.canUserEditEvent(event, userId);
    if (!canEdit) return false;

    return calendarRepository.deleteEvent(eventId);
  }

  /**
   * Edit/delete permission per plan:
   *  - Event creator: always.
   *  - Institute admin on the event's institute: for events with instituteId set.
   * No other path grants edit.
   */
  async canUserEditEvent(event: CalendarEvent, userId: string): Promise<boolean> {
    if (event.createdByUserId === userId) return true;
    if (event.instituteId) {
      const link = await instituteRepository.getInstituteUserLink(event.instituteId, userId);
      if (link?.isAdmin) return true;
    }
    return false;
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
   * Get events visible to a user within a date range, applying the plan's
   * visibility rules.
   *
   * Visibility:
   *  - Direct invitee (user attendee) — always.
   *  - Via selected student — attendee match, student-service events for their services,
   *    and FK matches on the student's institutes/classrooms (cross-institute leak is
   *    an acknowledged design choice in calendar-plan.md).
   *  - Via selected institute — event.instituteId = selected institute (if user is a
   *    member), and event.classroomId ∈ user's classrooms in that institute.
   *  - If no institute selected and no student selected, institute/classroom FK matches
   *    are skipped (per plan: "event is hidden").
   */
  async getEventsForUser(
    userId: string,
    startDate: Date,
    endDate: Date,
    opts: { selectedStudentId?: string; selectedInstituteId?: string } = {},
  ): Promise<(CalendarEvent & { attendees: CalendarEventAttendee[] })[]> {
    const criteria = await this.buildVisibilityCriteria(userId, opts);
    return calendarRepository.getVisibleEvents(criteria, startDate, endDate);
  }

  /**
   * Build the OR'd visibility criteria for a user with an optional selected
   * student / institute context. Exported via this service so AI-side loaders
   * (monitor agent, flagged events) can share the exact rules.
   */
  async buildVisibilityCriteria(
    userId: string,
    opts: { selectedStudentId?: string; selectedInstituteId?: string } = {},
  ) {
    const { selectedStudentId, selectedInstituteId } = opts;

    const { studentRepository, classroomRepository } = await import("../repositories");

    const attendees: Array<{ type: string; id: string }> = [
      { type: "user", id: userId },
    ];
    const instituteIds: string[] = [];
    const classroomIds: string[] = [];
    const serviceIds: string[] = [];

    // ── Selected institute path ──
    if (selectedInstituteId) {
      const userInstitutes = await instituteRepository.getInstitutesByUserId(userId);
      const userIsMember = userInstitutes.some((i) => i.id === selectedInstituteId);
      if (userIsMember) {
        instituteIds.push(selectedInstituteId);
        // Classrooms the user belongs to within the selected institute.
        const userClassrooms = await classroomRepository.getClassroomsByUserId(userId);
        for (const cr of userClassrooms) {
          if (cr.classroom.instituteId === selectedInstituteId) {
            classroomIds.push(cr.classroom.id);
          }
        }
      }
    }

    // ── Selected student path ──
    // Events visible to the selected student are visible to the viewer. Includes
    // direct student attendee, the student's service events, and FK matches on
    // the student's institutes/classrooms — per plan, cross-institute visibility
    // via a selected student is intentional.
    if (selectedStudentId) {
      attendees.push({ type: "student", id: selectedStudentId });

      const studentInstitutes = await instituteRepository.getInstitutesByStudentId(selectedStudentId);
      for (const row of studentInstitutes) {
        const instId = (row as any).institute?.id ?? (row as any).id;
        if (instId && !instituteIds.includes(instId)) instituteIds.push(instId);
      }

      const studentClassrooms = await classroomRepository.getClassroomsByStudentId(selectedStudentId);
      for (const cr of studentClassrooms) {
        const crId = (cr as any).classroom?.id ?? (cr as any).id;
        if (crId && !classroomIds.includes(crId)) classroomIds.push(crId);
      }

      // Student service events: include any event linked to a service in any of
      // the student's programs. Covers the case where the student was removed
      // from the attendee list but the event is still tied to their service.
      const { programRepository } = await import("../repositories");
      const programs = await programRepository.getProgramsByStudentId(selectedStudentId);
      for (const p of programs) {
        const services = await programRepository.getServicesByProgramId(p.id);
        for (const s of services) {
          if (!serviceIds.includes(s.id)) serviceIds.push(s.id);
        }
      }
    }

    return { attendees, instituteIds, classroomIds, serviceIds };
  }

  /**
   * Visibility criteria for events a single student can see. Used by the AAC
   * monitor agent and any student-centric listing. Rules per calendar-plan.md:
   *  - Directly assigned to student
   *  - Event institute = institute the student belongs to
   *  - Event classroom = classroom the student belongs to
   */
  async buildStudentVisibilityCriteria(studentId: string) {
    const { classroomRepository } = await import("../repositories");

    const attendees: Array<{ type: string; id: string }> = [
      { type: "student", id: studentId },
    ];
    const instituteIds: string[] = [];
    const classroomIds: string[] = [];
    const serviceIds: string[] = [];

    const studentInstitutes = await instituteRepository.getInstitutesByStudentId(studentId);
    for (const row of studentInstitutes) {
      const instId = (row as any).institute?.id ?? (row as any).id;
      if (instId) instituteIds.push(instId);
    }

    const studentClassrooms = await classroomRepository.getClassroomsByStudentId(studentId);
    for (const cr of studentClassrooms) {
      const crId = (cr as any).classroom?.id ?? (cr as any).id;
      if (crId) classroomIds.push(crId);
    }

    const { programRepository } = await import("../repositories");
    const programs = await programRepository.getProgramsByStudentId(studentId);
    for (const p of programs) {
      const services = await programRepository.getServicesByProgramId(p.id);
      for (const s of services) serviceIds.push(s.id);
    }

    return { attendees, instituteIds, classroomIds, serviceIds };
  }

  /**
   * Strip the participant list from events that are only visible to the user
   * via the selected-student path. Per plan: "the event is rendered in a
   * reduced form: basic info only (title, time, type). The participant list
   * — other users and students — is hidden."
   *
   * An event falls into reduced view when the user has NO direct membership
   * reason to see it (no user attendee, no institute/classroom membership, not
   * the creator) but it IS visible via selected student.
   */
  async applyReducedView(
    events: (CalendarEvent & { attendees: CalendarEventAttendee[] })[],
    userId: string,
    opts: { selectedStudentId?: string; selectedInstituteId?: string },
  ): Promise<(CalendarEvent & { attendees: CalendarEventAttendee[]; reducedView?: boolean })[]> {
    if (!opts.selectedStudentId || events.length === 0) {
      return events;
    }

    // Resolve the user's direct memberships once.
    const { classroomRepository } = await import("../repositories");
    const userInstitutes = await instituteRepository.getInstitutesByUserId(userId);
    const userInstituteIds = new Set(userInstitutes.map((i) => i.id));
    const userClassrooms = await classroomRepository.getClassroomsByUserId(userId);
    const userClassroomIds = new Set(
      userClassrooms.map((c: any) => c.classroom?.id ?? c.id).filter(Boolean) as string[],
    );

    return events.map((e) => {
      const isCreator = e.createdByUserId === userId;
      const isDirectInvitee = e.attendees.some(
        (a) => a.attendeeType === "user" && a.attendeeId === userId,
      );
      const viaInstituteMembership = !!e.instituteId && userInstituteIds.has(e.instituteId);
      const viaClassroomMembership = !!e.classroomId && userClassroomIds.has(e.classroomId);

      const hasDirectReason =
        isCreator || isDirectInvitee || viaInstituteMembership || viaClassroomMembership;

      if (hasDirectReason) return e;

      // Student-path-only: strip attendees, flag as reduced.
      return {
        ...e,
        description: null,
        attendees: [],
        reducedView: true,
      };
    });
  }

  /** Events visible to a student within a date range. Used by AAC monitor agent. */
  async getEventsForStudent(
    studentId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<(CalendarEvent & { attendees: CalendarEventAttendee[] })[]> {
    const criteria = await this.buildStudentVisibilityCriteria(studentId);
    return calendarRepository.getVisibleEvents(criteria, startDate, endDate);
  }

  /**
   * Update the requesting user's RSVP status on an event they're invited to.
   * Returns the updated attendee row, or undefined if the user is not an
   * invitee on this event.
   */
  async setRsvp(
    eventId: string,
    userId: string,
    status: "pending" | "accepted" | "declined",
  ): Promise<CalendarEventAttendee | undefined> {
    const event = await calendarRepository.getEventById(eventId);
    if (!event) return undefined;
    return calendarRepository.setAttendeeInviteStatus(eventId, "user", userId, status);
  }

  /**
   * Broad access check for a single event. Returns true if the user could see
   * the event under ANY valid selection context (selected institute/student).
   * Used for single-event GET and as a base check before applying stricter
   * edit/delete permissions.
   */
  async canUserAccessEvent(eventId: string, userId: string): Promise<boolean> {
    const event = await calendarRepository.getEventById(eventId);
    if (!event) return false;
    if (event.createdByUserId === userId) return true;

    const { studentRepository, classroomRepository } = await import("../repositories");
    const attendees = await calendarRepository.getAttendeesByEventId(eventId);

    // 1. Direct user attendee
    if (attendees.some((a) => a.attendeeType === "user" && a.attendeeId === userId)) return true;

    // 2. Student attendee in user's students (student-path leak, per plan)
    const userStudents = await studentRepository.getStudentsByUserId(userId);
    const userStudentIds = new Set(userStudents.map((s) => s.id));
    if (attendees.some((a) => a.attendeeType === "student" && userStudentIds.has(a.attendeeId))) return true;

    // 3. Event institute FK matches a user institute
    if (event.instituteId) {
      const userInstitutes = await instituteRepository.getInstitutesByUserId(userId);
      if (userInstitutes.some((i) => i.id === event.instituteId)) return true;
    }

    // 4. Event classroom FK matches a user classroom
    if (event.classroomId) {
      const userClassrooms = await classroomRepository.getClassroomsByUserId(userId);
      if (userClassrooms.some((c: any) => (c.classroom?.id ?? c.id) === event.classroomId)) return true;
    }

    // 5. Event service FK belongs to a program of one of the user's students
    if (event.serviceId) {
      const { programRepository } = await import("../repositories");
      const service = await programRepository.getServiceById(event.serviceId);
      if (service) {
        const program = await programRepository.getProgramById(service.programId);
        if (program?.studentId && userStudentIds.has(program.studentId)) return true;
      }
    }

    return false;
  }

  /**
   * Get events happening within a timeframe for AI prompt context.
   * Returns a simplified list suitable for embedding in a prompt.
   * If a timezone is supplied, start/end are formatted in that zone; otherwise UTC.
   */
  async getUpcomingEventsForPrompt(
    userId: string,
    opts: { timezone?: string; hoursAhead?: number; hoursBehind?: number } = {},
  ): Promise<{ title: string; start: string; end: string; allDay: boolean }[]> {
    const { timezone, hoursAhead = 24, hoursBehind = 2 } = opts;
    const now = new Date();
    const startDate = new Date(now.getTime() - hoursBehind * 60 * 60 * 1000);
    const endDate = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

    const events = await this.getEventsForUser(userId, startDate, endDate);

    const fmt = (d: Date) => {
      if (!timezone) return d.toISOString();
      // en-CA locale produces ISO-like YYYY-MM-DD HH:mm:ss in the given zone
      try {
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: timezone,
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", hour12: false,
        }).formatToParts(d);
        const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
        return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} (${timezone})`;
      } catch {
        return d.toISOString();
      }
    };

    return events.map((e) => ({
      title: e.title,
      start: fmt(e.startTime),
      end: fmt(e.endTime),
      allDay: e.allDay,
    }));
  }

}

export const calendarService = new CalendarService();
