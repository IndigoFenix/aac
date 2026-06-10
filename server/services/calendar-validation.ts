// server/services/calendar-validation.ts
// Date-sanity validation for calendar events.
//
// Kept separate from calendarService so unit tests can import it without
// pulling in repositories/db.

export class CalendarValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarValidationError";
  }
}

export interface EventDateFields {
  startTime?: Date | null;
  endTime?: Date | null;
  repeatType?: string | null;
  repeatEndDate?: Date | null;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Rejects impossible date combinations before they reach the DB.
 *
 * A recurring series whose repeatEndDate precedes its startTime expands to
 * zero occurrences — the row exists but the event never renders anywhere,
 * while the caller (user or AI) believes it was saved successfully.
 *
 * Error messages are single-line and surfaced verbatim to the AI as tool
 * errors (see sanitizeDbError), so they must state how to fix the input.
 */
export function validateEventDates(dates: EventDateFields): void {
  const { startTime, endTime, repeatType, repeatEndDate } = dates;

  if (startTime && endTime && endTime.getTime() < startTime.getTime()) {
    throw new CalendarValidationError(
      `endTime (${endTime.toISOString()}) is before startTime (${startTime.toISOString()}).`,
    );
  }

  if (
    repeatType &&
    repeatType !== "none" &&
    startTime &&
    repeatEndDate &&
    repeatEndDate.getTime() < startTime.getTime()
  ) {
    throw new CalendarValidationError(
      `repeatEndDate (${day(repeatEndDate)}) is before startTime (${day(startTime)}), so this recurring series would never occur. ` +
        `startTime must be the series' FIRST occurrence — if the schedule is active now, start it today, not at a future term.`,
    );
  }
}
