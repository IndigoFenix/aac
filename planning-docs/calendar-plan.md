# Integrated Calendar System rebuild - planning

Let's think about the calendar events system. Specifically, we need to define who each event is visible to, and when.
This is more complicated than standard calendar apps because we're not just managing one person's schedule - we also have to account for students and classrooms.

Any event can have additional users and students added to them. These users may decline the invitation.

These are the event types:
- Standard events (one-on-one meetings, group meetings between users, play dates with supervision)
    - Works like standard Google calendar events.
    - Can be created by any user.
    - User is added to the event by default when first creating it
- Student service events (therapy sessions, private tutors, and other personal meetings)
    - Associated with a service in a student's program
    - Student added by default when creating the event for convenience - they may be manually removed, because the student themselves might not actually be included (meetings between user and therapist for example)
    - Can only be created/viewed when the student is selected
- Institute events (school-wide events, holidays)
    - Associated with an institute
    - Can be created only by institute admins
- Classroom events (scheduled classes, class trips)
    - Associated with a classroom
    - Can be created by any user assigned to the classroom

Events do not need to be associated with a specific institute - they are more tied to users and students, except for classroom events.

Event Visibility

- "Visible to a user" means "can be viewed on the calendar and can be accessed by the clinician AI".
- "Visible to a student" means "visible to the AI monitor agent during AAC sessions" and "visible to the clinician AI while that student is selected".

- Events are visible to students only if one of the following is true:
  - The event is directly assigned to the student
  - The event is associated with an institute and the student is a member of that institute
  - The event is associated with a classroom and the student is a member of that classroom
- Events are visible to users only if one of the following is true:
  - The event is directly assigned to the user
  - The event is visible to the currently-selected student
  - The event is associated with an institute, the user is a member of the institute, and the institute is selected
  - The event is associated with a classroom, the user is a member of the classroom, and the class' institute is selected

Event data exposes ONLY public, surface-level info about students and users (names).

When a user can only see an event via a selected student (i.e. they are not a direct invitee and the event is not tied to an institute/classroom they belong to), the event is rendered in a reduced form: basic info only (title, time, type). The participant list — other users and students — is hidden.

The AAC AI can see all events the student takes part in, which may include events from multiple organizations, which means that a small degree of cross-institute data leakage is possible due to the AAC's notes. This risk is probably negligible.

This setup allows events from non-selected institutes to be visible if the student is assigned to them and that student is selected. Technically this allows users to see events from institutes they are not members of (example: if a clinic selects a student they will be able to see class events the student is a part of, which may be useful for analysis).

If no institute is selected and the event is not visible via a selected student, the event is hidden — even if the user is a direct invitee via an institute/classroom path.

## Invitations and RSVP

- Accept/decline marks status on the user-event association object; it does NOT change visibility.
- RSVP status changes the event's color on the calendar.
- RSVP status is rendered as a visible indicator when the event appears in AI memory.

## Edit and delete permissions

- Event creator can edit/delete their own events.
- Institute admins can edit/delete any event associated with their institute.
- No other users can edit or delete.

## Student service events

- Functionally identical to standard events, with two differences:
  1. Associated with a service in the student's program.
  2. Visible whenever that student is selected, even if the current user is not a direct invitee.

## Recurrence

- Use the existing recurrence mechanism as-is. No changes.

## Time zones

Current state is broken: event times are stored as naive PostgreSQL timestamps, the server uses its own clock to compute "today / upcoming", and neither client sends a time zone. This needs to be fixed as a prerequisite to the rest of the rebuild.

**Storage**
- All event times stored as UTC (`timestamp with time zone` or explicit UTC convention).
- No `timezone` field on students, users, institutes, or events.

**Client → server**
- Clients (clinician + AAC) resolve the current user's IANA time zone (e.g. `"America/New_York"`) and send it with every request that involves event times — queries, creates, edits.
- Server converts incoming times to UTC for storage and incoming "today / upcoming" windows to UTC ranges using the supplied zone.

**Server → client**
- Server returns UTC timestamps. Client converts to local zone on render.

**AI awareness** (important)
- The client's current time zone (and current local time) must be exposed in the system prompt / context for all three AIs: clinician AI, AAC interactive agent, and AAC monitor agent.
- Rationale: AIs create and edit events on the user's behalf, so they need to speak in and reason about the user's local time — e.g. "schedule for tomorrow at 3pm" must resolve correctly.
- For the AAC agents, "the client" is the AAC session's device; that zone flows through the live relay into agent context.

## Overlaps

- Overlapping events are allowed.
- When a user is picking a time for a new event, show a warning icon if the selected time overlaps any existing event visible to them.